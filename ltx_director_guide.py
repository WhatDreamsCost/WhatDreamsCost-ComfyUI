from comfy_extras.nodes_lt import LTXVAddGuide
import torch
import comfy.utils
from comfy_api.latest import io
from .ltx_director import GuideData


class LTXDirectorGuide(LTXVAddGuide):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LTXDirectorGuide",
            display_name="LTX Director Guide",
            category="WhatDreamsCost",
            description=(
                "Applies guide images from a Prompt Relay Timeline node at the frame positions "
                "and strengths defined on the timeline. Uses LTX's replace-latent mechanism so the "
                "keyframe sits IN the latent at its target slot — neighbor frames attend to it via "
                "natural RoPE-decayed self-attention, no artificial dominance."
            ),
            inputs=[
                io.Conditioning.Input("positive", tooltip="Positive conditioning passthrough."),
                io.Conditioning.Input("negative", tooltip="Negative conditioning passthrough."),
                io.Vae.Input("vae", tooltip="Video VAE used to encode the guide images."),
                io.Latent.Input("latent", tooltip="Video latent — guides overwrite their target slot in this latent."),
                GuideData.Input("guide_data", tooltip="Guide data produced by Prompt Relay Encode (Timeline)."),
                io.Float.Input("scale_by", default=1.0, min=0.01, max=8.0, step=0.01, tooltip="Scale the latent by this factor."),
                io.Combo.Input("upscale_method", options=["nearest-exact", "bilinear", "area", "bicubic", "bislerp"], default="bicubic", tooltip="Method used to upscale/downscale the latent."),
                io.Float.Input("kf_softness", default=0.0, min=0.0, max=1.0, step=0.01, optional=True, tooltip="OPTIONAL pre-noise applied to each keyframe before it's written into the latent (variance-preserving blend with Gaussian noise). Default 0.0 = exact image at the keyframe's target frame (recommended for most workflows). Higher values give the model more freedom to interpolate — useful for second-pass refinement where the keyframe is an approximation. Note: >0.2 typically produces visible noise artifacts on faces/skin, so use sparingly."),
                io.Int.Input("kf_reach", default=1, min=0, max=99, step=1, optional=True, tooltip="Layer 3 self-attention falloff radius in LATENT frames. Within `kf_reach` latent frames of a keyframe's target slot, queries get full attention to the kf. Beyond, a Gaussian penalty rapidly attenuates the kf's influence on distant frames. Default 1 ≈ 0.3s of full influence around each kf, then sharp dropoff. Set to a high value (e.g. 99) to disable falloff (LTX's natural RoPE decay only — wooden lead-up returns). Set to 0 for the tightest possible localization."),
                io.Float.Input("kf_falloff_sigma", default=0.5, min=0.05, max=5.0, step=0.05, optional=True, tooltip="Gaussian sharpness for the keyframe attention falloff beyond `kf_reach`. Smaller = sharper dropoff. 0.5 (default) means at distance kf_reach+1 the kf's attention is reduced by exp(-2)≈0.13, at kf_reach+2 by exp(-8)≈0.0003 — essentially gone. Increase if you want a softer, longer-tailed transition."),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Conditioning.Output(display_name="negative"),
                io.Latent.Output(display_name="latent", tooltip="Video latent with keyframes written in at their target slots."),
            ],
        )

    @classmethod
    def execute(cls, positive, negative, vae, latent, guide_data, scale_by=1.0, upscale_method="bicubic", kf_softness=0.0, kf_reach=1, kf_falloff_sigma=0.5) -> io.NodeOutput:
        scale_factors = vae.downscale_index_formula

        # Clone latents to avoid mutating upstream nodes
        latent_image = latent["samples"].clone()

        if "noise_mask" in latent:
            noise_mask = latent["noise_mask"].clone()
        else:
            batch, _, latent_frames, latent_height, latent_width = latent_image.shape
            noise_mask = torch.ones(
                (batch, 1, latent_frames, 1, 1),
                dtype=torch.float32,
                device=latent_image.device,
            )

        # Apply scale factor if not 1.0 (nearest-exact for the mask to preserve 0/1 cleanly)
        if scale_by != 1.0:
            B, C, F, H, W = latent_image.shape
            width = round(W * scale_by)
            height = round(H * scale_by)

            latent_4d = latent_image.permute(0, 2, 1, 3, 4).reshape(B * F, C, H, W)
            latent_resized_4d = comfy.utils.common_upscale(latent_4d, width, height, upscale_method, "disabled")
            latent_image = latent_resized_4d.reshape(B, F, C, height, width).permute(0, 2, 1, 3, 4)

            if noise_mask.shape[-1] > 1 or noise_mask.shape[-2] > 1:
                mask_4d = noise_mask.permute(0, 2, 1, 3, 4).reshape(B * F, 1, H, W)
                mask_resized_4d = comfy.utils.common_upscale(mask_4d, width, height, "nearest-exact", "disabled")
                noise_mask = mask_resized_4d.reshape(B, F, 1, height, width).permute(0, 2, 1, 3, 4)

        _, _, latent_length, latent_height, latent_width = latent_image.shape

        images = guide_data.get("images", [])
        insert_frames = guide_data.get("insert_frames", [])
        strengths = guide_data.get("strengths", [])

        # Layer 3 (self-attn kf falloff): kf_state is a mutable dict created by LTXDirector.
        # We populate it with the latent indices of the kfs we place, plus user-tuned reach/sigma.
        # The patch's closure reads this at attention time during sampling.
        kf_state = guide_data.get("kf_state", None)
        if kf_state is not None:
            kf_state["latent_indices"] = []  # reset on each guide execution
            kf_state["kf_reach"] = int(kf_reach)
            kf_state["sigma"] = float(kf_falloff_sigma)

        for idx, img_tensor in enumerate(images):
            f_idx = insert_frames[idx] if idx < len(insert_frames) else 0
            strength = strengths[idx] if idx < len(strengths) else 1.0

            image_1, t = cls.encode(vae, latent_width, latent_height, img_tensor, scale_factors)

            frame_idx, latent_idx = cls.get_latent_index(positive, latent_length, len(image_1), f_idx, scale_factors)

            assert latent_idx + t.shape[2] <= latent_length, (
                f"Guide image {idx + 1}: conditioning frames exceed the length of the latent sequence."
            )

            # Optional pre-noise: blend the encoded keyframe with Gaussian noise (variance-preserving).
            # Default 0.0 = pristine keyframe at the target slot. Higher values give the model more
            # freedom to interpolate the keyframe — useful for second-pass refinement where the
            # keyframe is an approximation, not an exact target. Values >0.2 typically produce
            # visible noise artifacts (skin, faces) so this defaults off.
            if kf_softness > 0.0:
                noise = torch.randn_like(t)
                sqrt_keep = (1.0 - kf_softness) ** 0.5
                sqrt_noise = kf_softness ** 0.5
                t = sqrt_keep * t + sqrt_noise * noise

            # Replace mode: overwrite the latent's content at the target slot with the keyframe,
            # and set noise_mask there to 1-strength. At strength=1.0 (mask=0), the sampler pins
            # this slot to the keyframe content — exact image at exact time. Layer 3 self-attn
            # falloff (kf_reach + kf_falloff_sigma) limits how far the kf's influence reaches via
            # natural RoPE-decayed attention PLUS the Gaussian penalty we add in patches.py.
            latent_image, noise_mask = cls.replace_latent_frames(
                latent_image, noise_mask, t, latent_idx, strength,
            )

            # Register this kf's latent slot for the self-attn falloff mask
            if kf_state is not None:
                kf_state["latent_indices"].append(int(latent_idx))

        return io.NodeOutput(positive, negative, {"samples": latent_image, "noise_mask": noise_mask})
