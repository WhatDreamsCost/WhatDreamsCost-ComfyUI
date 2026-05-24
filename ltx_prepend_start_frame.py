import logging

import torch

log = logging.getLogger(__name__)


class LTXPrependStartFrame:
    """Encodes one or more start-frame images and prepends them to a hint latent
    with noise_mask=0 (fully locked / hard-anchored).

    The rest of the hint latent retains its original per-pixel noise_mask
    (e.g. from LTXSoftHintLatent) so the model can freely generate or
    condition those frames as intended.

    Typical wiring:
        [start image]          → ─────────────────────────────┐
        [point cloud renders]  → LTXSoftHintLatent (hint_latent) → LTXPrependStartFrame → KSampler
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
                            "Image(s) to hard-anchor at the beginning of the latent. "
                            "Typically a single frame. All provided frames are encoded "
                            "and prepended with noise_mask=0."
                        ),
                    },
                ),
                "vae": ("VAE",),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "prepend_start"
    CATEGORY = "WhatDreamsCost"

    def prepend_start(self, hint_latent, start_image, vae):
        hint_samples = hint_latent["samples"]  # [1, 128, hint_T, lat_h, lat_w]
        dev = hint_samples.device
        lat_h, lat_w = hint_samples.shape[3], hint_samples.shape[4]

        # ── 1. Encode start frame(s) ──────────────────────────────────────────────
        # vae.encode expects [N, H, W, C] float32 in [0, 1].
        pixels = start_image[:, :, :, :3]  # drop alpha if present
        start_samples = vae.encode(pixels)  # [1, 128, start_T, s_lat_h, s_lat_w]
        start_samples = start_samples.to(device=dev)
        start_T = start_samples.shape[2]
        s_lat_h, s_lat_w = start_samples.shape[3], start_samples.shape[4]

        if (s_lat_h, s_lat_w) != (lat_h, lat_w):
            log.warning(
                "[LTXPrependStartFrame] Start image encodes to latent %dx%d but hint "
                "latent is %dx%d. Resize the start image to match the point cloud "
                "render resolution before connecting.",
                s_lat_w, s_lat_h, lat_w, lat_h,
            )
            # Best-effort bilinear resize so the node doesn't hard-crash.
            import torch.nn.functional as F
            start_samples = F.interpolate(
                start_samples.view(1, -1, s_lat_h, s_lat_w),
                size=(lat_h, lat_w),
                mode="bilinear",
                align_corners=False,
            ).view(1, start_samples.shape[1], start_T, lat_h, lat_w)

        # ── 2. Build combined samples ─────────────────────────────────────────────
        combined_samples = torch.cat([start_samples, hint_samples], dim=2)

        # ── 3. Build combined noise_mask ──────────────────────────────────────────
        # Retrieve hint mask; default to all-ones (fully generate) if absent.
        if "noise_mask" in hint_latent:
            hint_mask = hint_latent["noise_mask"].to(device=dev)
        else:
            hint_T = hint_samples.shape[2]
            hint_mask = torch.ones([1, 1, hint_T, lat_h, lat_w], dtype=torch.float32, device=dev)

        # Expand broadcast dims so cat on T-dim works regardless of hint_mask shape.
        hint_mask = hint_mask.expand(-1, -1, -1, lat_h, lat_w).contiguous()

        start_mask = torch.zeros([1, 1, start_T, lat_h, lat_w], dtype=torch.float32, device=dev)

        noise_mask = torch.cat([start_mask, hint_mask], dim=2)

        log.info(
            "[LTXPrependStartFrame] Prepended %d locked start frame(s) + %d hint frames "
            "= %d total latent frames, spatial latent %dx%d.",
            start_T, hint_samples.shape[2], combined_samples.shape[2], lat_w, lat_h,
        )

        return ({"samples": combined_samples, "noise_mask": noise_mask},)
