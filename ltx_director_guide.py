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
                io.Int.Input("kf_reach", default=1, min=0, max=99, step=1, optional=True, tooltip="FALLBACK kf coverage in latent frames, used when a timeline segment has zero `length` (no painted reach handle). Default 1 latent frame ≈ 0.3s symmetric coverage. When the timeline editor provides per-kf reach handles via segment durations + anchor tick marks, those win over this global default."),
                io.Float.Input("kf_peak_strength", default=0.9, min=0.0, max=1.0, step=0.01, optional=True, tooltip="Maximum attention scale at the keyframe's target frame (the peak of the gradient). 0.9 (default) means even at the kf, attention to it is mildly attenuated — prevents the wooden 'full lock' look. 1.0 = no attenuation at the kf (RoPE attention runs at full strength, can produce locked/wooden output). Lower = always-softer kf influence. The gradient ramps linearly from this value at the kf to 0 at the edge of the kf's coverage zone (segment length on the timeline)."),
                io.Float.Input("kf_semantic_reach", default=0.5, min=0.0, max=1.0, step=0.05, optional=True, tooltip="Layer-graded falloff: fraction of EARLY transformer blocks (from input toward output) where the kf attention falloff is applied. 0.5 (default) = falloff in first half of blocks (pixel-level localization), late half attends freely (semantic content propagates). 1.0 = falloff in ALL blocks (tightest pixel-AND-semantic localization, original Layer 3 behavior). 0.0 = falloff disabled entirely (RoPE decay only, kf may dominate widely). Lower values = kf's composition/lighting/scene info influences neighbors via late blocks, but its exact pixel content stays pinned at the target frame only."),
                io.Float.Input("kf_max_mask_at_sigma1", default=0.5, min=0.0, max=1.0, step=0.05, optional=True, tooltip="Sigma-aware mask schedule: the maximum mask value at the keyframe's slot during the EARLIEST sampling steps (sigma≈1). 0.5 (default) means at step 0 the kf is 50% generated / 50% pinned. As sampling progresses, the mask returns to its base value (1-strength), locking the kf to pixel-exact at the final step. Higher (0.7-0.9) = more motion freedom early but model may invent content; lower (0.3-0.4) = tighter throughout. The kf latent stays CLEAN — only mask blend ratio varies."),
                io.Combo.Input("kf_curve_shape", options=["sigmoid", "smoothstep", "power"], default="sigmoid", optional=True, tooltip="Shape of the sigma→mask schedule. 'sigmoid' (default) — S-curve with FLAT plateaus at both extremes: kf stays at max_mask for early sampling steps, sharp middle transition, then sits at base for late steps. Best for smooth visual transitions in/out of kf. 'smoothstep' — similar S-curve but exactly 0 at sigma=0 and 1 at sigma=1 (no asymptotic ends). 'power' — older curve, no early plateau; mask drops from sampling start. Try sigmoid first if you have abrupt transitions at the kf."),
                io.Float.Input("kf_lock_curve", default=2.0, min=0.25, max=8.0, step=0.25, optional=True, tooltip="Steepness of the kf_curve_shape transition. Meaning depends on shape: For SIGMOID (default): higher = sharper S — kf stays loose longer at high sigma, then snaps to locked quickly. 2.0 = moderate S, 4.0 = steep, 8.0 = near-step-function. For SMOOTHSTEP: higher narrows the transition region around sigma=0.5. For POWER: exponent on sigma (legacy behavior). 2.0 default works for most workflows."),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Conditioning.Output(display_name="negative"),
                io.Latent.Output(display_name="latent", tooltip="Video latent with keyframes written in at their target slots."),
            ],
        )

    @classmethod
    def execute(cls, positive, negative, vae, latent, guide_data, scale_by=1.0, upscale_method="bicubic", kf_softness=0.0, kf_reach=1, kf_peak_strength=0.9, kf_semantic_reach=0.5, kf_max_mask_at_sigma1=0.5, kf_curve_shape="sigmoid", kf_lock_curve=2.0) -> io.NodeOutput:
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
        reach_before_pixels = guide_data.get("reach_before_pixels", [0] * len(images))
        reach_after_pixels = guide_data.get("reach_after_pixels", [0] * len(images))

        # Layer 3 (self-attn kf falloff): kf_state is a mutable dict created by LTXDirector.
        # We populate `kfs` (per-keyframe records) and global semantic_reach. The patch's
        # closure reads this at attention time during sampling.
        kf_state = guide_data.get("kf_state", None)
        if kf_state is not None:
            kf_state["kfs"] = []  # reset on each guide execution
            kf_state["semantic_reach"] = float(kf_semantic_reach)
            kf_state["max_mask_at_sigma1"] = float(kf_max_mask_at_sigma1)
            kf_state["curve_shape"] = str(kf_curve_shape)
            kf_state["lock_curve"] = float(kf_lock_curve)

        time_scale_factor = scale_factors[0]
        # Global fallback reach in latent frames when the timeline segment provides no duration
        fallback_reach = max(0, int(kf_reach))

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

            # Register this kf in kf_state with its per-kf reach (from timeline segment duration).
            # Pixel reach → latent reach via the VAE's temporal compression factor.
            # If the segment has zero length on either side (or both), fall back to the global
            # kf_reach so a kf without painted handles still has SOME coverage.
            if kf_state is not None:
                rb_pix = int(reach_before_pixels[idx]) if idx < len(reach_before_pixels) else 0
                ra_pix = int(reach_after_pixels[idx]) if idx < len(reach_after_pixels) else 0
                rb_lat = max(0, rb_pix // int(time_scale_factor))
                ra_lat = max(0, ra_pix // int(time_scale_factor))
                # Fallback: if both sides are zero on the timeline, use the global kf_reach symmetrically
                if rb_lat == 0 and ra_lat == 0 and fallback_reach > 0:
                    rb_lat = fallback_reach
                    ra_lat = fallback_reach
                kf_state["kfs"].append({
                    "latent_idx": int(latent_idx),
                    "reach_before": int(rb_lat),
                    "reach_after": int(ra_lat),
                    "peak_strength": float(kf_peak_strength),
                })

        return io.NodeOutput(positive, negative, {"samples": latent_image, "noise_mask": noise_mask})
