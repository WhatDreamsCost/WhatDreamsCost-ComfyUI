"""LTXChainKeyframeAppend — pure append-mode multi-keyframe for LTX.

Kfs are encoded and added as extra reference tokens via `append_keyframe` (the same
mechanism KJNodes' LTXVAddGuideMulti uses), with `keyframe_idxs` remapping their RoPE
positions to user-specified pixel targets. The original latent stream stays fully
model-generated — no slot pinning, no convergence drift, no VAE asymmetry artifacts,
smooth prompt-driven motion.

This node was originally built with a custom chain-aware self-attention mask to handle
multi-kf interference, but in production the prior-extend workflow (extending from a
real prior video via LTXVAudioVideoMask + offsetting kfs past the prior boundary)
solves the same problem at the data level — no mask needed. The chain mask was
removed because applying it across all 48 transformer blocks per sampling step added
significant per-call cost (token-resolution mask expansion at ~2.5GB allocated per
block per step) without visibly improving output in the prior-extend workflow.

What this node still gives you over KJNodes' LTXVAddGuideMulti:
  - CSV-style multi-kf inputs (positions, strengths) — paste a list, no dynamic node
    expansion needed
  - Prior-extend diagnostic logging (detects leading mask-locked region from upstream
    LTXVAudioVideoMask and reports it)

Pair with a standard CLIP+conditioning path. The node returns MODIFIED positive/
negative (carry `keyframe_idxs` entries the model reads to remap RoPE).

The chain mask factory in patches.py is kept as dead code in case we want to A/B
re-enable it later.
"""

import logging

from comfy_extras.nodes_lt import LTXVAddGuide
import torch
from comfy_api.latest import io


log = logging.getLogger(__name__)


def _parse_csv_ints(s, fallback=None):
    if not s or not str(s).strip():
        return list(fallback) if fallback is not None else []
    out = []
    for tok in str(s).split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            out.append(int(tok))
        except ValueError:
            log.warning("[LTXChainKfAppend] could not parse int from %r — skipping", tok)
    return out


def _parse_csv_floats(s, fallback=None):
    if not s or not str(s).strip():
        return list(fallback) if fallback is not None else []
    out = []
    for tok in str(s).split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            out.append(float(tok))
        except ValueError:
            log.warning("[LTXChainKfAppend] could not parse float from %r — skipping", tok)
    return out


class LTXChainKeyframeAppend(LTXVAddGuide):
    """Append-mode multi-keyframe placement. Kfs become extra reference tokens via
    append_keyframe; the original latent stream stays model-generated. Pair with a
    prior-extend workflow (LTXVAudioVideoMask) for fluid multi-kf cinematic output.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LTXChainKeyframeAppend",
            display_name="LTX Chain Keyframe Guide (Append)",
            category="WhatDreamsCost",
            description=(
                "APPEND-MODE multi-keyframe for LTX. Kfs are added as extra reference tokens "
                "(via append_keyframe), not placed in the latent slot stream — no slot "
                "pinning means no convergence drift, no VAE asymmetry artifacts, smooth "
                "prompt-driven motion. Kf is NOT pixel-exact at the target frame — it's an "
                "attention-only reference. For cinematic multi-kf use, pair with a prior-"
                "extend workflow (LTXVAudioVideoMask): generate a few seconds of prior video, "
                "extend from it, and offset your kfs past the prior boundary. This makes LTX "
                "treat the new region as a video continuation (not an opening shot), which "
                "avoids the 'settle in / stop motion' that a near-start kf would otherwise "
                "trigger via LTX's I2V training prior."
            ),
            inputs=[
                io.Conditioning.Input("positive", tooltip="Positive conditioning. MODIFIED — keyframe_idxs entries are added per kf."),
                io.Conditioning.Input("negative", tooltip="Negative conditioning. MODIFIED — keyframe_idxs entries are added per kf."),
                io.Vae.Input("vae", tooltip="Video VAE used to encode keyframe images."),
                io.Latent.Input("latent", tooltip="Video latent. Kfs are APPENDED to the temporal dim (latent stream grows)."),
                io.Image.Input("images", tooltip="Batch of keyframe images, in order. Image i goes at frame_positions[i]."),
                io.String.Input(
                    "frame_positions", default="",
                    tooltip="Comma-separated pixel-frame positions for each kf (e.g. '0, 30, 60'). "
                            "Must have the same number of entries as images. These become the kf's "
                            "RoPE positions via keyframe_idxs — the model 'sees' each kf at this pixel slot."
                ),
                io.String.Input(
                    "strengths", default="",
                    tooltip="Optional comma-separated per-kf strengths in [0, 1]. Default 1.0 each. "
                            "Controls the appended kf token's noise_mask (mask = 1 - strength). "
                            "1.0 = kf token stays fully clean throughout sampling (strongest anchor). "
                            "Lower = the kf token itself drifts during sampling, weakening its anchor pull."
                ),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive", tooltip="Positive conditioning with keyframe_idxs entries added (per kf)."),
                io.Conditioning.Output(display_name="negative", tooltip="Negative conditioning with keyframe_idxs entries added (per kf)."),
                io.Latent.Output(display_name="latent", tooltip="Latent with kfs APPENDED to the temporal dim. Latent stream length grew by n_kfs."),
            ],
        )

    @classmethod
    def execute(
        cls,
        positive,
        negative,
        vae,
        latent,
        images,
        frame_positions,
        strengths="",
    ) -> io.NodeOutput:
        scale_factors = vae.downscale_index_formula

        positions = _parse_csv_ints(frame_positions, fallback=[])
        if len(positions) == 0:
            raise ValueError(
                "[LTXChainKfAppend] frame_positions is empty. Provide a comma-separated list "
                "of pixel-frame positions, one per keyframe image."
            )

        if images.ndim != 4:
            raise ValueError(f"[LTXChainKfAppend] expected images shape [N, H, W, 3], got {tuple(images.shape)}")
        n_images = images.shape[0]
        if n_images != len(positions):
            raise ValueError(
                f"[LTXChainKfAppend] image count {n_images} does not match frame_positions count "
                f"{len(positions)}. Provide one position per image."
            )

        parsed_strengths = _parse_csv_floats(strengths, fallback=[])
        if len(parsed_strengths) == 0:
            parsed_strengths = [1.0] * n_images
        elif len(parsed_strengths) != n_images:
            raise ValueError(
                f"[LTXChainKfAppend] strengths count {len(parsed_strengths)} does not match image "
                f"count {n_images}."
            )

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

        n_original = latent_image.shape[2]
        _, _, _, latent_height, latent_width = latent_image.shape

        # Diagnostic: detect a leading prior-locked region from the noise_mask. Not used to
        # drive any logic (no chain mask), but useful to confirm the prior-extend workflow
        # is wired correctly.
        prior_locked_t = 0
        try:
            if noise_mask.ndim == 5:
                per_frame = noise_mask[:, :, :n_original].float().mean(dim=(0, 1, 3, 4))
                for t_idx in range(per_frame.shape[0]):
                    if float(per_frame[t_idx]) < 0.05:
                        prior_locked_t += 1
                    else:
                        break
        except Exception as e:
            log.warning("[LTXChainKfAppend] could not detect prior-locked region: %s", e)
            prior_locked_t = 0

        # Place each kf via append_keyframe. Each call:
        #   - Adds a keyframe_idxs entry to positive/negative (remaps RoPE position).
        #   - Concatenates the kf's encoded latent + a (1-strength) mask slot to the
        #     temporal dim of latent_image and noise_mask.
        for i in range(n_images):
            img_tensor = images[i:i + 1]
            f_idx = int(positions[i])
            strength = float(parsed_strengths[i])

            image_1, t = cls.encode(vae, latent_width, latent_height, img_tensor, scale_factors)
            frame_idx, latent_idx = cls.get_latent_index(positive, n_original, len(image_1), f_idx, scale_factors)

            positive, negative, latent_image, noise_mask = cls.append_keyframe(
                positive, negative, frame_idx, latent_image, noise_mask, t, strength, scale_factors,
            )

            log.info(
                "[LTXChainKfAppend] kf %d: pixel=%d (snapped=%d) → central slot=%d, strength=%.2f",
                i, f_idx, frame_idx, latent_idx, strength,
            )

        log.info(
            "[LTXChainKfAppend] %d kfs appended; %d original latent frames; %d total. prior_locked_t=%d",
            n_images, n_original, latent_image.shape[2], prior_locked_t,
        )

        return io.NodeOutput(
            positive, negative, {"samples": latent_image, "noise_mask": noise_mask}
        )
