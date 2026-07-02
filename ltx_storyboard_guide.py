"""LTXStoryboardGuide — re-apply guide_data keyframes to an existing latent.

Primary use case: STAGE-2 re-application. After stage-1 sampling, the validated workflow
runs `LTXVCropGuides` (strips kf metadata from positive/negative + crops kf tokens from
the latent), then `LTXVLatentUpsampler` (spatial 2× upsample). At that point the latent
has the stage-1 video content but NO kf anchors — running stage-2 sampling without
re-applying kfs lets the model drift away from the intended keyframes. This node takes
the same `guide_data` from `LTXStoryboard` and re-runs the LTXVAddGuideMulti loop
(encode → get_latent_index → append_keyframe) on the upsampled latent.

Outputs `positive`, `negative`, `latent` ready for: LTXVConcatAVLatent → LTXVConditioning
→ CFGGuider → SamplerCustomAdvanced.

This node intentionally has no per-kf reach, no chain attention mask, no falloff, no
sigma-aware scheduling — it's literally KJNodes' LTXVAddGuideMulti's body fed from a
structured dict instead of dynamic inputs.

Inherits from `LTXVAddGuide` (in comfy_extras.nodes_lt) for the `encode`,
`get_latent_index`, `append_keyframe` class methods.
"""

from __future__ import annotations

import logging

import torch

import comfy.utils
from comfy_extras.nodes_lt import LTXVAddGuide
from .ltx_storyboard import _detect_prior_latent_t
from comfy_api.latest import io


log = logging.getLogger(__name__)


GuideData = io.Custom("GUIDE_DATA")


class LTXStoryboardGuide(LTXVAddGuide):
    """Consumes guide_data from LTXStoryboard and runs the LTXVAddGuideMulti loop.

    Functionally identical to chaining `LTXVAddGuideMulti` with dynamic image+frame_idx+
    strength slots — just data-driven so the timeline editor can pack many segments
    without the user manually wiring each one.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LTXStoryboardGuide",
            display_name="LTX Storyboard Guide",
            category="WhatDreamsCost",
            description=(
                "Re-applies LTXStoryboard's keyframes to an existing latent. Intended for the "
                "STAGE-2 path after LTXVCropGuides + LTXVLatentUpsampler — re-anchors the "
                "kfs on the upsampled latent so stage-2 sampling stays locked to the timeline. "
                "For stage-1, LTXStoryboard already applies kfs internally — this node is "
                "optional and not needed there. Outputs positive/negative/latent ready for "
                "LTXVConcatAVLatent → LTXVConditioning → CFGGuider → SamplerCustomAdvanced."
            ),
            inputs=[
                io.Conditioning.Input("positive", tooltip="Relayed positive from LTXStoryboard."),
                io.Conditioning.Input("negative", tooltip="Empty-text-encoded negative from LTXStoryboard (or your own)."),
                io.Vae.Input("vae", tooltip="Video VAE — used to encode each keyframe image."),
                io.Latent.Input("latent", tooltip="The video latent (from LTXStoryboard or LTXVLatentUpsampler)."),
                GuideData.Input("guide_data", tooltip="Bundle from LTXStoryboard: images + insert_frames + strengths."),
                io.Float.Input(
                    "scale_by", default=1.0, min=0.01, max=8.0, step=0.01, optional=True,
                    tooltip="Pre-scale the latent before placing kfs (e.g. 0.5 for the validated 0.5× stage-1 pre-pass).",
                ),
                io.Combo.Input(
                    "upscale_method", options=["nearest-exact", "bilinear", "area", "bicubic", "bislerp"],
                    default="nearest-exact", optional=True,
                    tooltip="Method used when scale_by != 1.0. nearest-exact matches the validated workflow's LatentUpscaleBy.",
                ),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive", tooltip="Positive conditioning with kfs appended via keyframe_idxs."),
                io.Conditioning.Output(display_name="negative", tooltip="Negative conditioning with kfs appended."),
                io.Latent.Output(display_name="latent", tooltip="Latent with the kf token block grown on the temporal axis."),
            ],
        )

    @classmethod
    def execute(
        cls,
        positive,
        negative,
        vae,
        latent,
        guide_data,
        scale_by: float = 1.0,
        upscale_method: str = "nearest-exact",
    ) -> io.NodeOutput:
        scale_factors = vae.downscale_index_formula

        # Clone so upstream isn't mutated.
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

        # Pre-scale the latent + mask (matches the validated workflow's LatentUpscaleBy 0.5×).
        if scale_by != 1.0:
            B, C, F, H, W = latent_image.shape
            tw = round(W * scale_by)
            th = round(H * scale_by)
            latent_4d = latent_image.permute(0, 2, 1, 3, 4).reshape(B * F, C, H, W)
            latent_resized_4d = comfy.utils.common_upscale(latent_4d, tw, th, upscale_method, "disabled")
            latent_image = latent_resized_4d.reshape(B, F, C, th, tw).permute(0, 2, 1, 3, 4)

            if noise_mask.shape[-1] > 1 or noise_mask.shape[-2] > 1:
                mask_4d = noise_mask.permute(0, 2, 1, 3, 4).reshape(B * F, 1, H, W)
                # Use nearest-exact for masks so 0/1 values stay clean.
                mask_resized_4d = comfy.utils.common_upscale(mask_4d, tw, th, "nearest-exact", "disabled")
                noise_mask = mask_resized_4d.reshape(B, F, 1, th, tw).permute(0, 2, 1, 3, 4)

        _, _, latent_length, latent_height, latent_width = latent_image.shape

        # Rebuild the noise_mask for the prior region if it was stripped upstream.
        # LTXVLatentUpsampler.upsample_latent explicitly `pop`s "noise_mask" from its
        # output dict (nodes_lt_upsampler.py:69), so by the time this node runs after
        # a stage-1 sample + Separate + Crop + Upsampler chain, the prior region's
        # locked mask (mask ≤ 0.05) is gone. Without it, stage-2 sampling denoises
        # the prior frames at the schedule's denoise rate (typically 0.4) — enough
        # to visibly re-generate the prior region ("half second of re-denoised
        # extended video"). We restore it here using prior_latent_t from guide_data.
        gd_prior_t_probe = int(guide_data.get("prior_latent_t", 0) or 0)
        if gd_prior_t_probe > 0:
            mask_max = float(noise_mask.max().item()) if noise_mask.numel() > 0 else 1.0
            mask_min_at_prior = float(noise_mask[:, :, :gd_prior_t_probe].min().item()) if noise_mask.shape[2] >= gd_prior_t_probe else 1.0
            if mask_min_at_prior > 0.05:  # prior region isn't locked → rebuild
                B, _, F_lat, H_m, W_m = noise_mask.shape
                fresh_mask = torch.ones((B, 1, F_lat, H_m, W_m), dtype=noise_mask.dtype, device=noise_mask.device)
                fresh_mask[:, :, :gd_prior_t_probe] = 0.0
                noise_mask = fresh_mask
                log.info(
                    "[LTXStoryboardGuide] Restored noise_mask for stage-2 prior lock: first %d latent frames set to mask=0 (was max=%.3f, min-at-prior=%.3f — upsampler stripped it).",
                    gd_prior_t_probe, mask_max, mask_min_at_prior,
                )

        # Apply the SAME extend-mode offset that LTXStoryboard applied in stage-1.
        # PREFERRED SOURCE: `guide_data["prior_pixel_offset"]` — stamped by LTXStoryboard
        # at section 4c. This is the authoritative source because LTXVLatentUpsampler
        # explicitly drops the latent's noise_mask (nodes_lt_upsampler.py:69), so
        # auto-detecting prior_latent_t from the upsampled latent's mask returns 0
        # even when we're in an extend-mode continuation.
        # FALLBACK: detect from noise_mask (works if someone wired the Guide before
        # the upsampler, or with a non-upsampled latent that still has its mask).
        time_scale = scale_factors[0] if isinstance(scale_factors, (tuple, list)) else 8
        gd_offset = int(guide_data.get("prior_pixel_offset", 0) or 0)
        gd_prior_t = int(guide_data.get("prior_latent_t", 0) or 0)
        if gd_offset > 0:
            prior_pixel_offset = gd_offset
            prior_latent_t = gd_prior_t
            log.info(
                "[LTXStoryboardGuide] Extend mode (from guide_data): prior_latent_t=%d, applying UI→combined offset of %d pixel frames.",
                prior_latent_t, prior_pixel_offset,
            )
        else:
            prior_latent_t = _detect_prior_latent_t(noise_mask)
            prior_pixel_offset = 1 + (prior_latent_t - 1) * time_scale if prior_latent_t > 0 else 0
            if prior_pixel_offset > 0:
                log.info(
                    "[LTXStoryboardGuide] Extend mode (detected from noise_mask): prior_latent_t=%d, applying UI→combined offset of %d pixel frames.",
                    prior_latent_t, prior_pixel_offset,
                )

        images = guide_data.get("images", [])
        insert_frames = guide_data.get("insert_frames", [])
        strengths = guide_data.get("strengths", [])

        if len(images) == 0:
            log.info("[LTXStoryboardGuide] guide_data has no images; passing through unchanged.")
            return io.NodeOutput(positive, negative, {"samples": latent_image, "noise_mask": noise_mask})

        # Same "auto-clamp to latent's max valid position" logic as LTXStoryboard.
        # LTX 8k+1 pixel-frame convention can leave 1-8 UI pixels with no latent slot;
        # clamping keeps the "last frame" kf usable instead of silently skipping it.
        max_valid_combined_pixel = time_scale * (latent_length - 1)

        for i, img_tensor in enumerate(images):
            f_idx_ui = int(insert_frames[i]) if i < len(insert_frames) else 0
            f_idx = f_idx_ui + prior_pixel_offset
            strength = float(strengths[i]) if i < len(strengths) else 1.0

            clamped = False
            if f_idx > max_valid_combined_pixel:
                original_ui = f_idx_ui
                original_combined = f_idx
                f_idx = max_valid_combined_pixel
                f_idx_ui = max(0, f_idx - prior_pixel_offset)
                clamped = True

            # Mirror LTXVAddGuideMulti's loop body exactly (comfyui-kjnodes/nodes/ltxv_nodes.py:61-97).
            image_1, t = cls.encode(vae, latent_width, latent_height, img_tensor, scale_factors)
            frame_idx, latent_idx = cls.get_latent_index(positive, latent_length, len(image_1), f_idx, scale_factors)

            if latent_idx + t.shape[2] > latent_length:
                log.warning(
                    "[LTXStoryboardGuide] kf %d at UI pixel %d (combined %d) → latent_idx %d still exceeds latent_length %d after clamp attempt; skipping.",
                    i, f_idx_ui, f_idx, latent_idx, latent_length,
                )
                continue

            positive, negative, latent_image, noise_mask = cls.append_keyframe(
                positive, negative, frame_idx, latent_image, noise_mask, t, strength, scale_factors,
            )

            if clamped:
                log.warning(
                    "[LTXStoryboardGuide] kf %d: UI pixel %d (combined %d) exceeded latent capacity — CLAMPED to UI pixel %d (combined %d) → latent_idx=%d, strength=%.2f.",
                    i, original_ui, original_combined, f_idx_ui, f_idx, latent_idx, strength,
                )
            else:
                log.info(
                    "[LTXStoryboardGuide] kf %d: UI pixel=%d → combined pixel=%d (snapped=%d) → latent_idx=%d, strength=%.2f",
                    i, f_idx_ui, f_idx, frame_idx, latent_idx, strength,
                )

        return io.NodeOutput(
            positive, negative, {"samples": latent_image, "noise_mask": noise_mask},
        )
