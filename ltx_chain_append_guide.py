"""LTXChainKeyframeAppend — append-mode chain-aware multi-keyframe.

Alternative architecture to LTXChainKeyframeGuide. Both nodes share the chain-attention
idea (partition self-attention so each kf only strongly anchors its bordering segments)
but differ in WHERE the kf's latent goes:

  LTXChainKeyframeGuide   — REPLACE mode. Kf latent INSERTED into a slot in the latent
                             stream; that slot is pinned via noise_mask=0 throughout
                             sampling. Pixel-exact at the kf frame, but the model has
                             to converge surrounding free slots toward the pinned slot's
                             content → late-sampling convergence drift can appear as
                             wobble/color-shift in adjacent frames. Requires VAE
                             asymmetry fix (block-style encoding at mid positions).

  LTXChainKeyframeAppend  — APPEND mode (this node). Kf latent APPENDED as an EXTRA
                             token at the end of the latent stream, with `keyframe_idxs`
                             remapping its RoPE position to the user's pixel target.
                             The original latent stream stays fully model-generated
                             (no slot is the kf). This matches LTX's img2vid training
                             pattern (clean reference token → coherent extension), just
                             with an arbitrary RoPE position instead of forcing slot 0.
                             No slot pinning → no convergence drift. Kf is not
                             pixel-exact at the target frame — it's an attention-only
                             reference — but the model's output strongly resembles the
                             kf via natural attention coherence.

The chain attention mask applies UNIFORMLY across all transformer blocks (no early-vs-
late layer gating). The block-fraction gating was evaluated and didn't visibly improve
output quality in this mode while adding a knob to tune — removed for simplicity.

Pair with a standard CLIP+conditioning path. The node returns the MODIFIED positive/
negative (they now carry `keyframe_idxs` entries that the model reads to remap RoPE).

Like the sibling node, this is intended for standalone testing. Do NOT chain after
LTXDirector — both patch attn1 and the model patcher will collide.
"""

import logging

from comfy_extras.nodes_lt import LTXVAddGuide
import torch
import comfy.utils
from comfy_api.latest import io

from .patches import detect_model_type, apply_patches, make_chain_append_attention_mask_fn_factory


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
    """Append-mode multi-keyframe with chain-aware self-attention. Kfs are attached as
    extra reference tokens (no latent-slot pinning), and the chain mask partitions each
    kf's influence to its bordering segments. Chain mask applies to all transformer
    blocks (no layer gating).
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LTXChainKeyframeAppend",
            display_name="LTX Chain Keyframe Guide (Append)",
            category="WhatDreamsCost",
            description=(
                "APPEND-MODE chain multi-keyframe. Kfs are added as extra reference tokens "
                "(via append_keyframe), not placed in the latent slot stream — no slot "
                "pinning means no convergence drift, no VAE asymmetry artifacts, smooth "
                "motion driven by prompt+sampler. Chain attention mask partitions each kf's "
                "influence to its bordering segments so multi-kf works without each kf "
                "dominating the whole sequence. Kf is NOT pixel-exact at the target frame "
                "— it's an attention-only reference. Use STANDALONE; do not chain after "
                "LTX Director (both patch attn1)."
            ),
            inputs=[
                io.Model.Input("model", tooltip="LTX model. Will be cloned and the chain-aware attn1 patch applied."),
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
                io.String.Input(
                    "cut_indices", default="",
                    tooltip="Optional comma-separated 0-based kf indices that are HARD CUTS — scene "
                            "breaks where SLOT-TO-SLOT cross-segment attention drops to cut_attention_floor "
                            "regardless of sigma. The kf itself still anchors both sides of the cut "
                            "(it's the boundary token). Use for camera cuts within multi-kf sequences."
                ),
                io.Float.Input(
                    "isolation_edge0", default=0.2, min=0.0, max=1.0, step=0.01, optional=True,
                    tooltip="Sigma BELOW which segments are fully isolated. Default 0.2."
                ),
                io.Float.Input(
                    "isolation_edge1", default=0.6, min=0.0, max=1.0, step=0.01, optional=True,
                    tooltip="Sigma ABOVE which segments are fully connected. Must be > edge0. Default 0.6."
                ),
                io.Float.Input(
                    "cross_segment_floor", default=0.05, min=0.001, max=1.0, step=0.001, optional=True,
                    tooltip="Minimum cross-segment attention at full isolation. Default 0.05."
                ),
                io.Float.Input(
                    "cut_attention_floor", default=0.01, min=0.0001, max=1.0, step=0.0001, optional=True,
                    tooltip="Minimum attention across HARD CUTS (slot-to-slot only). Default 0.01."
                ),
            ],
            outputs=[
                io.Model.Output(display_name="model", tooltip="Model with chain-aware self-attention patch applied."),
                io.Conditioning.Output(display_name="positive", tooltip="Positive conditioning with keyframe_idxs entries added (per kf)."),
                io.Conditioning.Output(display_name="negative", tooltip="Negative conditioning with keyframe_idxs entries added (per kf)."),
                io.Latent.Output(display_name="latent", tooltip="Latent with kfs APPENDED to the temporal dim. Latent stream length grew by n_kfs."),
            ],
        )

    @classmethod
    def execute(
        cls,
        model,
        positive,
        negative,
        vae,
        latent,
        images,
        frame_positions,
        strengths="",
        cut_indices="",
        isolation_edge0=0.2,
        isolation_edge1=0.6,
        cross_segment_floor=0.05,
        cut_attention_floor=0.01,
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

        cut_kf_indices = set(_parse_csv_ints(cut_indices, fallback=[]))
        for c in cut_kf_indices:
            if not (0 <= c < n_images):
                log.warning("[LTXChainKfAppend] cut_index %d out of range [0, %d) — ignoring", c, n_images)
        cut_kf_indices = {c for c in cut_kf_indices if 0 <= c < n_images}

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

        kf_records = []
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
                "[LTXChainKfAppend] kf %d: pixel=%d (snapped=%d) → central slot=%d, strength=%.2f, is_cut=%s",
                i, f_idx, frame_idx, latent_idx, strength, i in cut_kf_indices,
            )
            kf_records.append({
                "order": i,
                "central_latent_idx": int(latent_idx),
                "is_cut": i in cut_kf_indices,
            })

        kf_records.sort(key=lambda r: r["central_latent_idx"])

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

        segments = []
        cursor = 0
        if prior_locked_t > 0:
            segments.append((0, max(0, prior_locked_t - 1)))
            cursor = prior_locked_t
        for rec in kf_records:
            cs = rec["central_latent_idx"]
            if cs < cursor:
                log.warning(
                    "[LTXChainKfAppend] kf central slot %d is before cursor %d — degenerate segment",
                    cs, cursor,
                )
            segments.append((cursor, cs))
            cursor = cs + 1
        if cursor < n_original:
            segments.append((cursor, n_original - 1))

        seg_offset = 1 if prior_locked_t > 0 else 0
        sorted_kf_membership = []
        for j in range(len(kf_records)):
            left_seg = seg_offset + j
            right_seg = seg_offset + j + 1
            mem = [left_seg]
            if right_seg < len(segments):
                mem.append(right_seg)
            sorted_kf_membership.append(mem)

        kf_segment_membership_user_order = [None] * n_images
        for sorted_idx, rec in enumerate(kf_records):
            kf_segment_membership_user_order[rec["order"]] = sorted_kf_membership[sorted_idx]

        cut_segment_boundaries = set()
        for sorted_idx, rec in enumerate(kf_records):
            if rec["is_cut"]:
                cut_segment_boundaries.add(seg_offset + sorted_idx)

        try:
            _arch, _patch_size, _ = detect_model_type(model)
        except Exception as e:
            log.warning("[LTXChainKfAppend] could not detect model type — %s. Defaulting to ltx.", e)
            _arch, _patch_size = "ltx", (1, 1, 1)

        tokens_per_frame_fallback = (latent_image.shape[3] // _patch_size[1]) * (latent_image.shape[4] // _patch_size[2])

        kf_state = {
            "segments": [(int(l), int(r)) for (l, r) in segments],
            "kf_segment_membership": kf_segment_membership_user_order,
            "cut_segment_boundaries": cut_segment_boundaries,
            "n_original_frames": int(n_original),
            "n_kfs": int(n_images),
            "total_latent_frames": int(latent_image.shape[2]),
            "tokens_per_frame": int(tokens_per_frame_fallback),
            "isolation_edge0": float(isolation_edge0),
            "isolation_edge1": float(isolation_edge1),
            "cross_segment_floor": float(cross_segment_floor),
            "cut_attention_floor": float(cut_attention_floor),
        }

        log.info(
            "[LTXChainKfAppend] %d kfs appended; %d original latent frames; %d total. "
            "segments=%s, cuts at boundaries %s, prior_locked_t=%d, kf_membership=%s",
            n_images, n_original, latent_image.shape[2], segments,
            sorted(cut_segment_boundaries), prior_locked_t, kf_segment_membership_user_order,
        )

        if _arch != "ltx":
            raise ValueError(f"[LTXChainKfAppend] LTX only. Detected arch: {_arch}")

        patched = model.clone()
        apply_patches(
            patched, "ltx",
            mask_fn=None,
            self_attn_mask_fn_factory=make_chain_append_attention_mask_fn_factory(kf_state),
        )

        return io.NodeOutput(
            patched, positive, negative, {"samples": latent_image, "noise_mask": noise_mask}
        )
