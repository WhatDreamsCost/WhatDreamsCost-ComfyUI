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
        validity_mask=None,
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
