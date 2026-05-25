import logging

import torch

log = logging.getLogger(__name__)


class LTXPrependStartFrame:
    """Overwrites the first latent frame(s) of a hint latent with a clean start image.

    This keeps the latent T dimension unchanged (critical — prepending extra frames
    would produce a longer video and break conditioning alignment).

    The hint latent's LTXSoftHintLatent node already sets noise_mask=0 for
    hard_start_frames. This node replaces the *content* of those frames with a
    proper reference image instead of the sparse point-cloud render, so the model
    anchors to clean start-frame visuals rather than an incomplete render.

    Typical wiring:
        [start image]         → ──────────────────────────────────────┐
        [point cloud renders] → LTXSoftHintLatent (hard_start_frames=1) → LTXPrependStartFrame → KSampler
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "hint_latent": ("LATENT",),
                "start_image": (
                    "IMAGE",
                    {
                        "tooltip": (
                            "Image to encode and write into the first latent frame(s). "
                            "Should be the same resolution as the point cloud renders. "
                            "Must match the spatial dimensions of hint_latent."
                        ),
                    },
                ),
                "vae": ("VAE",),
                "num_frames": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 16,
                        "step": 1,
                        "tooltip": (
                            "How many leading latent frames to overwrite with the start image. "
                            "Should match hard_start_frames in LTXSoftHintLatent."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "write_start"
    CATEGORY = "WhatDreamsCost"

    def write_start(self, hint_latent, start_image, vae, num_frames: int):
        hint_samples = hint_latent["samples"].clone()  # [1, 128, T, lat_h, lat_w]
        dev = hint_samples.device
        T = hint_samples.shape[2]
        lat_h, lat_w = hint_samples.shape[3], hint_samples.shape[4]

        # ── 1. Encode the start image ─────────────────────────────────────────────
        pixels = start_image[:1, :, :, :3]  # take first frame, drop alpha
        start_samples = vae.encode(pixels)  # [1, 128, start_T, s_lat_h, s_lat_w]
        start_samples = start_samples.to(device=dev)
        s_lat_h, s_lat_w = start_samples.shape[3], start_samples.shape[4]

        if (s_lat_h, s_lat_w) != (lat_h, lat_w):
            log.warning(
                "[LTXPrependStartFrame] Start image encodes to latent %dx%d but hint "
                "latent is %dx%d. Resize the start image to the same resolution as the "
                "point cloud renders before connecting.",
                s_lat_w, s_lat_h, lat_w, lat_h,
            )
            import torch.nn.functional as F
            start_samples = F.interpolate(
                start_samples.squeeze(0),  # [128, start_T, s_lat_h, s_lat_w]
                size=(start_samples.shape[2], lat_h, lat_w),
                mode="trilinear",
                align_corners=False,
            ).unsqueeze(0)

        # ── 2. Overwrite the first num_frames latent frames ───────────────────────
        n = min(num_frames, T)
        # start_samples may only have 1 latent frame; repeat to fill n if needed.
        start_content = start_samples[:, :, :1, :, :].expand(-1, -1, n, -1, -1)
        hint_samples[:, :, :n, :, :] = start_content

        # ── 3. Build / update noise_mask ─────────────────────────────────────────
        if "noise_mask" in hint_latent:
            noise_mask = hint_latent["noise_mask"].clone().to(device=dev)
        else:
            noise_mask = torch.ones([1, 1, T, lat_h, lat_w], dtype=torch.float32, device=dev)

        # Expand broadcast dims so we can write spatial slices safely.
        noise_mask = noise_mask.expand(-1, -1, -1, lat_h, lat_w).contiguous()
        noise_mask[:, :, :n, :, :] = 0.0  # hard-anchor the overwritten frames

        log.info(
            "[LTXPrependStartFrame] Overwrote %d leading latent frame(s) with start image "
            "(T unchanged = %d).",
            n, T,
        )

        return ({"samples": hint_samples, "noise_mask": noise_mask},)
