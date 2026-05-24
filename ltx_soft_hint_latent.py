import logging

import torch
import torch.nn.functional as F

log = logging.getLogger(__name__)


class LTXSoftHintLatent:
    """Encodes a sparse 3D render (RGB point cloud, depth render, etc.) into an LTX latent
    with a per-pixel soft noise mask.

    Mask logic (all values are continuous, not binary):
      - Hard-start latent frames   → mask = 0.0  (fully preserved, anchors the start)
      - Valid / covered pixels     → mask = hint_strength (soft conditioning; model can deviate)
      - Holes / uncovered pixels   → mask = hole_strength (model invents these completely)
      - Edge pixels (partial cover)→ smooth blend between the two

    Validity is derived from per-pixel luminance: pixels darker than black_threshold are
    considered holes. A short ramp above the threshold avoids hard binary boundaries from
    aliasing or soft shadows.  An explicit validity_mask input overrides this detection.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "vae": ("VAE",),
                "hint_strength": (
                    "FLOAT",
                    {
                        "default": 0.35,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": (
                            "Noise level applied to pixels covered by the point cloud. "
                            "0 = fully preserved (pure conditioning), "
                            "1 = fully regenerated. "
                            "0.2–0.4 lets the model pull from the render while still inventing."
                        ),
                    },
                ),
                "hole_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": (
                            "Noise level for pixels with no point-cloud coverage (holes). "
                            "1.0 = model invents these from scratch."
                        ),
                    },
                ),
                "hard_start_frames": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": 64,
                        "step": 1,
                        "tooltip": (
                            "Number of leading latent frames to fully preserve (mask=0.0). "
                            "Set to 1 to hard-anchor the first frame of the render."
                        ),
                    },
                ),
                "black_threshold": (
                    "FLOAT",
                    {
                        "default": 0.05,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.005,
                        "tooltip": (
                            "Luminance below this value is treated as a hole (no valid data). "
                            "Increase if your render has a bright background, or if dark point-cloud "
                            "pixels are being incorrectly classified as holes."
                        ),
                    },
                ),
                "motion_freedom": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": (
                            "Suppresses conditioning on pixels that change between frames "
                            "(high temporal variance = motion). "
                            "0 = pure spatial conditioning (current behaviour); "
                            "1 = static pixels (rocks, banks) are conditioned at hint_strength, "
                            "moving pixels (water, fire) are freed to hole_strength so the "
                            "model generates real motion. "
                            "Start at 0.6–0.8 for fluid/flowing subjects."
                        ),
                    },
                ),
            },
            "optional": {
                "validity_mask": (
                    "MASK",
                    {
                        "tooltip": (
                            "Optional explicit per-frame validity map [N, H, W] or [H, W], "
                            "values in [0, 1] where 1 = fully valid and 0 = hole. "
                            "When provided, overrides the luminance-based auto-detection."
                        ),
                    },
                ),
                "motion_mask": (
                    "MASK",
                    {
                        "tooltip": (
                            "Optional per-pixel motion map [H, W] or [N, H, W], "
                            "values in [0, 1] where 1 = region should move freely "
                            "(e.g. water, fire, cloth) and 0 = static (rock, wall). "
                            "When provided, this is used instead of auto-detecting motion "
                            "from temporal variance — required when you only have 1 input frame. "
                            "Only active when motion_freedom > 0."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "build_hint_latent"
    CATEGORY = "WhatDreamsCost"

    def build_hint_latent(
        self,
        images,
        vae,
        hint_strength: float,
        hole_strength: float,
        hard_start_frames: int,
        black_threshold: float,
        motion_freedom: float = 0.0,
        validity_mask=None,
        motion_mask=None,
    ):
        # images: [N, H, W, 3] float32, values in [0, 1], ComfyUI format
        N, H, W, _C = images.shape

        # ── 1. Encode frames to latent ────────────────────────────────────────────
        pixels = images[:, :, :, :3]  # drop alpha if present
        latent_samples = vae.encode(pixels)  # [1, 128, T, lat_h, lat_w]
        _, _, lat_T, lat_h, lat_w = latent_samples.shape
        device = latent_samples.device

        # ── 2. Validity map in pixel space ────────────────────────────────────────
        if validity_mask is not None:
            vm = validity_mask.float()
            if vm.ndim == 2:
                # [H, W] → broadcast across all frames
                vm = vm.unsqueeze(0).expand(N, -1, -1)
            elif vm.ndim == 3 and vm.shape[0] == 1 and N > 1:
                vm = vm.expand(N, -1, -1)
            validity_pixel = vm[:N].clamp(0.0, 1.0)  # [N, H, W]
            log.info("[LTXSoftHintLatent] Using explicit validity_mask.")
        else:
            # Luminance-based detection: dark → hole, bright → valid.
            # Use a soft ramp over a small band above black_threshold to avoid
            # hard aliased edges where the point cloud density is low.
            r, g, b = images[:, :, :, 0], images[:, :, :, 1], images[:, :, :, 2]
            luminance = 0.299 * r + 0.587 * g + 0.114 * b  # [N, H, W]
            band = max(black_threshold * 0.5, 0.02)
            validity_pixel = ((luminance - black_threshold) / band).clamp(0.0, 1.0)

        # ── 2b. Motion-aware validity suppression ─────────────────────────────────
        # Pixels that vary a lot across frames are motion regions (water, fire, cloth).
        # Reduce their validity so the model is freed to generate real motion there,
        # while static pixels (rocks, walls) stay conditioned at hint_strength.
        #
        # motion_pixel [N, H, W]: 0 = static, 1 = lots of motion. With motion_freedom=1,
        # a fully-moving pixel's validity → 0 → mask = hole_strength.
        if motion_freedom > 0.0:
            if motion_mask is not None:
                # Explicit mask — works with N=1 or any frame count.
                mm = motion_mask.float()
                if mm.ndim == 2:
                    mm = mm.unsqueeze(0).expand(N, -1, -1)
                elif mm.ndim == 3 and mm.shape[0] == 1 and N > 1:
                    mm = mm.expand(N, -1, -1)
                motion_pixel = mm[:N].clamp(0.0, 1.0)  # [N, H, W]
                log.info(
                    "[LTXSoftHintLatent] motion_freedom=%.2f using explicit motion_mask "
                    "(mean motion coverage %.1f%%).",
                    motion_freedom, motion_pixel.mean().item() * 100.0,
                )
                validity_pixel = (validity_pixel * (1.0 - motion_freedom * motion_pixel)).clamp(0.0, 1.0)
            elif images.shape[0] > 1:
                # Auto-detect from temporal variance across input frames.
                lum = (
                    0.299 * images[:, :, :, 0]
                    + 0.587 * images[:, :, :, 1]
                    + 0.114 * images[:, :, :, 2]
                )  # [N, H, W]
                temporal_std = lum.std(dim=0)  # [H, W]
                max_std = temporal_std.max()
                if max_std > 1e-6:
                    motion_pixel = (temporal_std / max_std).clamp(0.0, 1.0)
                    motion_pixel = motion_pixel.unsqueeze(0).expand(N, -1, -1)  # [N, H, W]
                    validity_pixel = (validity_pixel * (1.0 - motion_freedom * motion_pixel)).clamp(0.0, 1.0)
                    log.info(
                        "[LTXSoftHintLatent] motion_freedom=%.2f auto-detected from temporal "
                        "variance (mean motion coverage %.1f%%).",
                        motion_freedom, motion_pixel[0].mean().item() * 100.0,
                    )
            else:
                log.warning(
                    "[LTXSoftHintLatent] motion_freedom=%.2f has no effect: only 1 input frame "
                    "and no motion_mask connected. Connect a motion_mask to define motion regions.",
                    motion_freedom,
                )

        # ── 3. Resample validity to latent resolution ─────────────────────────────
        # [N, H, W] → [1, 1, N, H, W] → trilinear → [1, 1, lat_T, lat_h, lat_w]
        # Trilinear handles both temporal compression (N→lat_T) and spatial
        # downsampling (H×W → lat_h×lat_w) in a single pass, preserving smooth
        # gradients at point-cloud coverage boundaries.
        v5d = validity_pixel.unsqueeze(0).unsqueeze(0).to(device=device, dtype=torch.float32)
        validity_latent = F.interpolate(
            v5d,
            size=(lat_T, lat_h, lat_w),
            mode="trilinear",
            align_corners=False,
        ).clamp(0.0, 1.0)  # [1, 1, lat_T, lat_h, lat_w]

        # ── 4. Build noise_mask ───────────────────────────────────────────────────
        # Continuous blend: fully valid → hint_strength, fully invalid → hole_strength.
        # Values between 0 and 1 in the validity map produce a smooth intermediate mask,
        # which is the key advantage over binary inpainting nodes.
        noise_mask = (
            hint_strength * validity_latent
            + hole_strength * (1.0 - validity_latent)
        )  # [1, 1, lat_T, lat_h, lat_w]

        # Hard-anchor leading frames: mask=0.0 fully preserves them (typically the start frame).
        if hard_start_frames > 0:
            n_hard = min(hard_start_frames, lat_T)
            noise_mask[:, :, :n_hard] = 0.0

        # ── 5. Logging ────────────────────────────────────────────────────────────
        soft_region = noise_mask[:, :, hard_start_frames:] if hard_start_frames < lat_T else noise_mask
        mean_valid = validity_latent[:, :, hard_start_frames:].mean().item() if hard_start_frames < lat_T else validity_latent.mean().item()
        log.info(
            "[LTXSoftHintLatent] %d px frames → latent T=%d H=%d W=%d | "
            "hard anchor: %d frames | "
            "mask range: %.3f–%.3f (mean valid coverage: %.1f%%)",
            N, lat_T, lat_h, lat_w,
            min(hard_start_frames, lat_T),
            soft_region.min().item(),
            soft_region.max().item(),
            mean_valid * 100.0,
        )

        return ({"samples": latent_samples, "noise_mask": noise_mask},)
