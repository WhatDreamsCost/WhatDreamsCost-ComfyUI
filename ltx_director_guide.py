from comfy_extras.nodes_lt import LTXVAddGuide, _append_guide_attention_entry
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
                "and strengths defined on the timeline. Connect guide_data from the timeline node."
            ),
            inputs=[
                io.Conditioning.Input("positive", tooltip="Positive conditioning to add guide keyframe info to."),
                io.Conditioning.Input("negative", tooltip="Negative conditioning to add guide keyframe info to."),
                io.Vae.Input("vae", tooltip="Video VAE used to encode the guide images."),
                io.Latent.Input("latent", tooltip="Video latent — guides are inserted into this latent."),
                GuideData.Input("guide_data", tooltip="Guide data produced by Prompt Relay Encode (Timeline)."),
                io.Float.Input("scale_by", default=1.0, min=0.01, max=8.0, step=0.01, tooltip="Scale the latent by this factor."),
                io.Combo.Input("upscale_method", options=["nearest-exact", "bilinear", "area", "bicubic", "bislerp"], default="bicubic", tooltip="Method used to upscale/downscale the latent."),
                io.Float.Input("kf_softness", default=0.0, min=0.0, max=1.0, step=0.01, optional=True, tooltip="Softens every keyframe by blending its encoded latent with Gaussian noise (variance-preserving). 0.0 = exact image. 0.1-0.3 = pose anchor — neighbors see a less-specific anchor and motion can flow around it. 0.5+ = strongly softened, target frame visibly noisy. Use with strength=1.0 to get 'exact-at-time but loose neighbors' behavior."),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Conditioning.Output(display_name="negative"),
                io.Latent.Output(display_name="latent", tooltip="Video latent with guide frames applied."),
            ],
        )

    @classmethod
    def execute(cls, positive, negative, vae, latent, guide_data, scale_by=1.0, upscale_method="bicubic", kf_softness=0.0) -> io.NodeOutput:
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

        # Apply scale factor if not 1.0
        if scale_by != 1.0:
            B, C, F, H, W = latent_image.shape
            width = round(W * scale_by)
            height = round(H * scale_by)

            # Reshape to 4D for common_upscale
            latent_4d = latent_image.permute(0, 2, 1, 3, 4).reshape(B * F, C, H, W)
            latent_resized_4d = comfy.utils.common_upscale(latent_4d, width, height, upscale_method, "disabled")
            latent_image = latent_resized_4d.reshape(B, F, C, height, width).permute(0, 2, 1, 3, 4)

            # Also resize noise mask if it's not a broadcasted mask
            if noise_mask.shape[-1] > 1 or noise_mask.shape[-2] > 1:
                mask_4d = noise_mask.permute(0, 2, 1, 3, 4).reshape(B * F, 1, H, W)
                mask_resized_4d = comfy.utils.common_upscale(mask_4d, width, height, upscale_method, "disabled")
                noise_mask = mask_resized_4d.reshape(B, F, 1, height, width).permute(0, 2, 1, 3, 4)

        _, _, latent_length, latent_height, latent_width = latent_image.shape

        images = guide_data.get("images", [])
        insert_frames = guide_data.get("insert_frames", [])
        strengths = guide_data.get("strengths", [])
        # In extend mode, the first Y frame is at latent index = boundary_latent_idx. Keyframes
        # landing there have to compete with the prior at RoPE distance 1 (the last X frame),
        # which is hard-locked and has clean content. A noised kf loses that competition, so we
        # ramp kf_softness to 0 at the boundary and back up to full softness 2+ latent frames in.
        boundary_latent_idx = int(guide_data.get("boundary_latent_idx", 0))

        for idx, img_tensor in enumerate(images):
            f_idx = insert_frames[idx] if idx < len(insert_frames) else 0
            strength = strengths[idx] if idx < len(strengths) else 1.0

            image_1, t = cls.encode(vae, latent_width, latent_height, img_tensor, scale_factors)

            # Compute latent_idx BEFORE pre-noise so we can ramp softness based on its position.
            frame_idx, latent_idx = cls.get_latent_index(positive, latent_length, len(image_1), f_idx, scale_factors)

            assert latent_idx + t.shape[2] <= latent_length, (
                f"Guide image {idx + 1}: conditioning frames exceed the length of the latent sequence."
            )

            # Ramp kf_softness based on distance from the X/Y boundary in extend mode.
            # Boundary kf (latent_idx == boundary): softness=0 (pristine, max competition vs prior).
            # 1 latent frame in: softness = 0.5 * kf_softness (transition).
            # 2+ latent frames in: full kf_softness (normal pose-anchor behavior).
            # Non-extend mode (boundary_latent_idx == 0): full kf_softness everywhere.
            if boundary_latent_idx > 0 and latent_idx >= boundary_latent_idx:
                distance_from_boundary = latent_idx - boundary_latent_idx
                softness_scale = min(1.0, distance_from_boundary / 2.0)
            else:
                softness_scale = 1.0
            effective_softness = kf_softness * softness_scale

            # Pre-noise the keyframe latent (variance-preserving blend with Gaussian noise).
            # The kf token's content becomes less crisp — frames attending to it still get an
            # anchor pull, but with fuzzy content instead of a hard-edged still. variance-preserving
            # so the latent stays in-distribution for the model.
            if effective_softness > 0.0:
                noise = torch.randn_like(t)
                sqrt_keep = (1.0 - effective_softness) ** 0.5
                sqrt_noise = effective_softness ** 0.5
                t = sqrt_keep * t + sqrt_noise * noise

            positive, negative, latent_image, noise_mask = cls.append_keyframe(
                positive, negative, frame_idx, latent_image, noise_mask, t, strength, scale_factors,
            )

            # Register per-guide attention bookkeeping so `strength` controls how strongly
            # the keyframe pulls attention from other frames (not just its own self-preservation).
            pre_filter_count = t.shape[2] * t.shape[3] * t.shape[4]
            guide_latent_shape = list(t.shape[2:])
            positive, negative = _append_guide_attention_entry(
                positive, negative, pre_filter_count, guide_latent_shape, strength=strength,
            )

        return io.NodeOutput(positive, negative, {"samples": latent_image, "noise_mask": noise_mask})
