"""LTXStoryboardGuide — drop-in replacement for KJNodes' LTXVAddGuideMulti.

Takes `guide_data` produced by `LTXStoryboard` (or any compatible upstream node) and runs
the LTXVAddGuideMulti loop:

    for each (image, frame_idx, strength) in guide_data:
        encode → get_latent_index → append_keyframe

Outputs `positive`, `negative`, `latent` ready for the standard downstream chain
(LTXVCropGuides → LTXVConcatAVLatent → SamplerCustomAdvanced).

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
                "Drop-in replacement for KJNodes' LTXVAddGuideMulti. Takes guide_data from "
                "LTXStoryboard and runs the same encode → get_latent_index → append_keyframe "
                "loop. Outputs positive/negative/latent ready for the validated downstream "
                "chain (LTXVCropGuides → LTXVConcatAVLatent → SamplerCustomAdvanced)."
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

        images = guide_data.get("images", [])
        insert_frames = guide_data.get("insert_frames", [])
        strengths = guide_data.get("strengths", [])

        if len(images) == 0:
            log.info("[LTXStoryboardGuide] guide_data has no images; passing through unchanged.")
            return io.NodeOutput(positive, negative, {"samples": latent_image, "noise_mask": noise_mask})

        for i, img_tensor in enumerate(images):
            f_idx = int(insert_frames[i]) if i < len(insert_frames) else 0
            strength = float(strengths[i]) if i < len(strengths) else 1.0

            # Mirror LTXVAddGuideMulti's loop body exactly (comfyui-kjnodes/nodes/ltxv_nodes.py:61-97).
            image_1, t = cls.encode(vae, latent_width, latent_height, img_tensor, scale_factors)
            frame_idx, latent_idx = cls.get_latent_index(positive, latent_length, len(image_1), f_idx, scale_factors)

            if latent_idx + t.shape[2] > latent_length:
                log.warning(
                    "[LTXStoryboardGuide] kf %d at pixel %d → latent_idx %d would exceed latent_length %d; skipping.",
                    i, f_idx, latent_idx, latent_length,
                )
                continue

            positive, negative, latent_image, noise_mask = cls.append_keyframe(
                positive, negative, frame_idx, latent_image, noise_mask, t, strength, scale_factors,
            )

            log.info(
                "[LTXStoryboardGuide] kf %d: pixel=%d (snapped=%d) → latent_idx=%d, strength=%.2f",
                i, f_idx, frame_idx, latent_idx, strength,
            )

        # Mirror the demo's order: re-attach frame_rate to BOTH conditionings AFTER the
        # keyframe loop, exactly as the demo chains LTXVAddGuideMulti → LTXVConditioning.
        # `conditioning_set_values` is merge-only (node_helpers.py:9 — shallow-copies the
        # metadata dict and sets the key), so this composes cleanly with the keyframe_idxs
        # the kf loop just appended.
        fr = guide_data.get("frame_rate")
        if fr is not None:
            try:
                import node_helpers
                positive = node_helpers.conditioning_set_values(positive, {"frame_rate": float(fr)})
                negative = node_helpers.conditioning_set_values(negative, {"frame_rate": float(fr)})
            except Exception as e:
                log.warning("[LTXStoryboardGuide] could not re-attach frame_rate (%s); upstream value preserved.", e)

        return io.NodeOutput(
            positive, negative, {"samples": latent_image, "noise_mask": noise_mask},
        )
