"""LTXChainKeyframeGuide — keyframe placement with chain-aware self-attention.

The mid-video kf should act like an end frame to what came before AND a start frame
for what comes after — the latent becomes a chain of in-distribution sub-problems
(img2vid + start+end-anchor), all in one sampling pass.

The noise_mask side is already correct (replace_latent_frames pins kfs at mask=0).
What this node adds is a custom self-attention mask that partitions attention so each
free segment ATTENDS as if it were an isolated extend-video sub-problem — bounded by
its own kfs, with sigma-scheduled relaxation for global context at high sigma and
tight per-segment refinement at low sigma. Hard cuts get no cross-segment leakage.

This node is INTENDED FOR STANDALONE TESTING. It does not patch cross-attention
(prompts) — pair with a normal CLIP+conditioning path. Do not chain after LTXDirector
in the same workflow: LTXDirector also patches attn1, and the model-patcher will
collide on the patch key.
"""

import logging
from comfy_extras.nodes_lt import LTXVAddGuide
import torch
import comfy.utils
from comfy_api.latest import io

from .patches import detect_model_type, apply_patches, make_chain_attention_mask_fn_factory


log = logging.getLogger(__name__)


def _parse_csv_ints(s, fallback=None):
    """Parse a comma-separated string of ints. Empty/missing returns fallback (default [])."""
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
            log.warning("[LTXChainKf] could not parse int from %r — skipping", tok)
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
            log.warning("[LTXChainKf] could not parse float from %r — skipping", tok)
    return out


class LTXChainKeyframeGuide(LTXVAddGuide):
    """Place keyframes in the latent AND apply chain-aware self-attention masking so the
    model perceives the sequence as N chained extend-video sub-problems instead of one
    OOD multi-anchor problem.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LTXChainKeyframeGuide",
            display_name="LTX Chain Keyframe Guide",
            category="WhatDreamsCost",
            description=(
                "Standalone multi-keyframe node with chain-aware self-attention. The mid-video kf "
                "acts as the end frame for the prior segment AND the start frame for the next. "
                "Each segment becomes an in-distribution sub-problem (img2vid or start+end-anchor) "
                "via per-segment attention partitioning. Optional hard cuts (cut_indices) disable "
                "cross-segment attention bleed for scene breaks. Use STANDALONE — do not chain "
                "after LTX Director (both patch attn1)."
            ),
            inputs=[
                io.Model.Input("model", tooltip="LTX model. Will be cloned and the chain-aware attn1 patch applied."),
                io.Conditioning.Input("positive", tooltip="Positive conditioning. Passthrough — chain attention is on self-attn only."),
                io.Conditioning.Input("negative", tooltip="Negative conditioning. Passthrough."),
                io.Vae.Input("vae", tooltip="Video VAE used to encode keyframe images."),
                io.Latent.Input("latent", tooltip="Video latent. Keyframes are placed into this latent at their target slots."),
                io.Image.Input("images", tooltip="Batch of keyframe images, in order. Image i goes at frame_positions[i]."),
                io.String.Input(
                    "frame_positions", default="",
                    tooltip="Comma-separated pixel-frame positions for each kf in the batch (e.g. '0, 30, 60'). "
                            "Must have the same number of entries as images."
                ),
                io.String.Input(
                    "strengths", default="",
                    tooltip="Optional comma-separated per-kf strengths in [0, 1]. Default 1.0 each. "
                            "Strength controls noise_mask at the kf (mask = 1 - strength). "
                            "Strength=1.0 means clean conditioning throughout sampling (LTX training contract). "
                            "Use <1.0 only for refinement passes where the kf is approximate."
                ),
                io.String.Input(
                    "cut_indices", default="",
                    tooltip="Optional comma-separated 0-based kf indices that are HARD CUTS — scene "
                            "breaks where cross-segment attention drops to cut_attention_floor "
                            "regardless of sigma. e.g. '1' means kf at index 1 is a cut. Empty = no cuts."
                ),
                io.String.Input(
                    "kf_durations", default="",
                    tooltip="Optional comma-separated per-kf duration in LATENT frames (default 1 each). "
                            "A duration N>1 means the kf occupies N consecutive latent frames — useful "
                            "for end-frame anchors where neighbor convergence-drift produces wobble. "
                            "Example '1, 3' makes the second kf lock 3 latent frames (~24 pixel frames) "
                            "to the same image, giving the model a wider 'landing zone' instead of forcing "
                            "all the convergence drift into the single-frame approach. Each multi-frame kf "
                            "extends FORWARD from its anchor position (latent_idx..latent_idx+duration-1)."
                ),
                io.Float.Input(
                    "isolation_edge0", default=0.2, min=0.0, max=1.0, step=0.01, optional=True,
                    tooltip="Sigma BELOW which segments are fully isolated (cross-segment attention = cross_segment_floor). "
                            "Lower edge of the smoothstep schedule. Default 0.2."
                ),
                io.Float.Input(
                    "isolation_edge1", default=0.6, min=0.0, max=1.0, step=0.01, optional=True,
                    tooltip="Sigma ABOVE which segments are fully connected (cross-segment attention ≈ 1.0). "
                            "Upper edge of the smoothstep schedule. Must be > edge0. Default 0.6."
                ),
                io.Float.Input(
                    "cross_segment_floor", default=0.05, min=0.001, max=1.0, step=0.001, optional=True,
                    tooltip="Minimum cross-segment attention at full isolation. Never zero — keeps weak global "
                            "context so the model knows segments belong to one piece. Default 0.05."
                ),
                io.Float.Input(
                    "cut_attention_floor", default=0.01, min=0.0001, max=1.0, step=0.0001, optional=True,
                    tooltip="Minimum attention across HARD CUTS. Lower than cross_segment_floor because cuts "
                            "mean different scenes. Default 0.01."
                ),
                io.Float.Input(
                    "boundary_block_fraction", default=0.5, min=0.0, max=1.0, step=0.05, optional=True,
                    tooltip="Fraction of EARLY transformer blocks that apply chain masking. Late blocks attend "
                            "freely so semantic features can propagate across segment boundaries (kf composition "
                            "bleeds into neighbors). Default 0.5."
                ),
                io.Float.Input(
                    "scale_by", default=1.0, min=0.01, max=8.0, step=0.01, optional=True,
                    tooltip="Scale the latent by this factor before placing keyframes."
                ),
                io.Combo.Input(
                    "upscale_method",
                    options=["nearest-exact", "bilinear", "area", "bicubic", "bislerp"],
                    default="bicubic", optional=True,
                    tooltip="Method used to scale the latent (only used if scale_by != 1.0)."
                ),
            ],
            outputs=[
                io.Model.Output(display_name="model", tooltip="Model with chain-aware self-attention patch applied."),
                io.Conditioning.Output(display_name="positive"),
                io.Conditioning.Output(display_name="negative"),
                io.Latent.Output(display_name="latent", tooltip="Latent with keyframes placed at their target slots."),
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
        kf_durations="",
        isolation_edge0=0.2,
        isolation_edge1=0.6,
        cross_segment_floor=0.05,
        cut_attention_floor=0.01,
        boundary_block_fraction=0.5,
        scale_by=1.0,
        upscale_method="bicubic",
    ) -> io.NodeOutput:
        scale_factors = vae.downscale_index_formula

        positions = _parse_csv_ints(frame_positions, fallback=[])
        if len(positions) == 0:
            raise ValueError(
                "[LTXChainKf] frame_positions is empty. Provide a comma-separated list of "
                "pixel-frame positions, one per keyframe image."
            )

        # Image batch shape is [N, H, W, 3]; split into per-image tensors
        if images.ndim != 4:
            raise ValueError(f"[LTXChainKf] expected images shape [N, H, W, 3], got {tuple(images.shape)}")
        n_images = images.shape[0]
        if n_images != len(positions):
            raise ValueError(
                f"[LTXChainKf] image count {n_images} does not match frame_positions count "
                f"{len(positions)}. Provide one position per image."
            )

        parsed_strengths = _parse_csv_floats(strengths, fallback=[])
        if len(parsed_strengths) == 0:
            parsed_strengths = [1.0] * n_images
        elif len(parsed_strengths) != n_images:
            raise ValueError(
                f"[LTXChainKf] strengths count {len(parsed_strengths)} does not match image "
                f"count {n_images}. Provide one strength per image or leave empty for 1.0."
            )

        cut_kf_indices = set(_parse_csv_ints(cut_indices, fallback=[]))
        for c in cut_kf_indices:
            if not (0 <= c < n_images):
                log.warning("[LTXChainKf] cut_index %d is out of range [0, %d) — ignoring", c, n_images)
        cut_kf_indices = {c for c in cut_kf_indices if 0 <= c < n_images}

        parsed_durations = _parse_csv_ints(kf_durations, fallback=[])
        if len(parsed_durations) == 0:
            parsed_durations = [1] * n_images
        elif len(parsed_durations) != n_images:
            raise ValueError(
                f"[LTXChainKf] kf_durations count {len(parsed_durations)} does not match image "
                f"count {n_images}. Provide one duration per image or leave empty for 1 each."
            )
        # Clamp durations to >= 1
        parsed_durations = [max(1, int(d)) for d in parsed_durations]

        # Clone latent + noise_mask
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

        # Optional scale (kept for parity with LTXDirectorGuide). nearest-exact for mask.
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

        # Place each keyframe in the latent + collect (latent_idx, is_cut) per kf.
        #
        # VAE temporal asymmetry handling:
        #   LTX's VAE is causally asymmetric — latent frame 0 = 1 pixel frame (causal first),
        #   latent frame N≥1 = an 8-pixel-frame block. A single image encoded straight
        #   produces a "causal-first" latent (right for the start frame, wrong for any mid
        #   position). Placing that causal-style latent at position N≥1 produces a small
        #   distribution mismatch in the color channels → visible color shift and ±1-frame
        #   wobble around the kf.
        #
        # Fix (mirrors LTXVAddGuide.execute lines 434-450 in comfy_extras/nodes_lt.py):
        #   For mid-position kfs, replicate the image temporally to (time_scale_factor + 1)
        #   pixel frames, then prepend ONE more duplicate so the VAE's causal-first asymmetry
        #   lands on a throwaway slot we strip off after encoding. The remaining latent
        #   represents an 8-pixel-frame block of the image — the in-distribution shape at
        #   mid positions. Start-frame kfs (latent_idx == 0) skip the trick: causal-first
        #   IS the right path there (it's exactly LTX I2V).
        time_scale_factor = int(scale_factors[0])
        kf_records = []
        for i in range(n_images):
            img_tensor = images[i:i + 1]  # [1, H, W, 3]
            f_idx = int(positions[i])
            strength = float(parsed_strengths[i])
            duration = int(parsed_durations[i])

            # First pass: figure out if this kf is at position 0 (start frame) or mid.
            # Use guide_length=1 so the snap doesn't fire yet — we just want to know the
            # target slot to pick an encoding path.
            _, initial_latent_idx = cls.get_latent_index(positive, latent_length, 1, f_idx, scale_factors)
            is_start_frame = (initial_latent_idx == 0) and duration == 1

            if is_start_frame:
                # Causal first-frame encode (LTX I2V trained path)
                image_for_encode = img_tensor
                causal_fix = True
            else:
                # Block-style encoding for D latent frames at a mid position.
                # Encoder produces ceil(pixel_frames/8) + 1-ish latent frames including the causal
                # first; we strip the causal frame. For D latent block frames, replicate to
                # (D * time_scale_factor + 1) pixel frames, then prepend 1 throwaway (total
                # D*ts + 2 → encoder snaps to D*ts + 1 → produces D+1 latent frames → strip 1 → D).
                n_pixel = duration * time_scale_factor + 1
                replicated = img_tensor.repeat(n_pixel, 1, 1, 1)
                image_for_encode = torch.cat([replicated[:1], replicated], dim=0)
                causal_fix = False

            image_1, t = cls.encode(vae, latent_width, latent_height, image_for_encode, scale_factors)

            if not causal_fix:
                t = t[:, :, 1:, :, :]
                image_1 = image_1[1:]

            assert t.shape[2] == duration, (
                f"[LTXChainKf] kf {i}: expected {duration} latent frames after encoding, got {t.shape[2]}. "
                f"Encoding shape mismatch — check time_scale_factor ({time_scale_factor})."
            )

            # Re-compute latent_idx with the actual guide length (post-strip). For mid-position
            # kfs, this snaps f_idx to the nearest valid 8k+1 pixel position (LTX VAE grid).
            frame_idx, latent_idx = cls.get_latent_index(positive, latent_length, len(image_1), f_idx, scale_factors)

            # Multi-frame kfs that would overflow the sequence: shift the block backward so it
            # ENDS at the user's intended position. The kf content still anchors that exact frame,
            # the block extends backward into earlier latent slots.
            if latent_idx + duration > latent_length:
                shifted_latent_idx = latent_length - duration
                if shifted_latent_idx < 0:
                    raise ValueError(
                        f"[LTXChainKf] kf {i} duration {duration} exceeds the entire latent length "
                        f"{latent_length}."
                    )
                log.info(
                    "[LTXChainKf] kf %d at pixel %d → latent_idx %d shifted back to %d to fit "
                    "duration %d within latent_length %d",
                    i, f_idx, latent_idx, shifted_latent_idx, duration, latent_length,
                )
                latent_idx = shifted_latent_idx

            if frame_idx != f_idx and duration == 1:
                log.info(
                    "[LTXChainKf] kf %d at pixel %d snapped to %d for VAE alignment (latent_idx=%d, encoding=%s)",
                    i, f_idx, frame_idx, latent_idx, "block" if not causal_fix else "causal",
                )
            elif duration > 1:
                log.info(
                    "[LTXChainKf] kf %d placed at latents [%d..%d] (duration=%d, pixel %d → snapped %d)",
                    i, latent_idx, latent_idx + duration - 1, duration, f_idx, frame_idx,
                )

            latent_image, noise_mask = cls.replace_latent_frames(
                latent_image, noise_mask, t, latent_idx, strength,
            )

            # Record the kf's full extent (all locked latent positions). For multi-frame kfs,
            # this is the range [latent_idx, latent_idx + duration - 1].
            kf_records.append({
                "order": i,
                "latent_idx": int(latent_idx),
                "duration": int(duration),
                "latent_end": int(latent_idx + duration - 1),
                "is_cut": i in cut_kf_indices,
            })

        # Sort kfs by latent position (for segment construction). The cut flag attaches
        # to the kf REGARDLESS of input order — cuts mark "after this kf in time, a hard
        # boundary occurs."
        kf_records.sort(key=lambda r: r["latent_idx"])

        # kf_latent_indices includes ALL locked latent positions across multi-frame kfs.
        # The chain mask treats every locked position as a "kf-key column" (full attention
        # from any query). Single-frame kfs contribute one position; D-frame kfs contribute D.
        kf_latent_indices = []
        for r in kf_records:
            for k in range(r["latent_idx"], r["latent_end"] + 1):
                kf_latent_indices.append(k)

        # Detect leading prior-locked region from noise_mask (extend-from-video case).
        # Count contiguous mask<0.05 latent frames at the front.
        prior_locked_t = 0
        try:
            if noise_mask.ndim == 5:
                # Average mask per frame (over batch, channel, h, w)
                per_frame = noise_mask.float().mean(dim=(0, 1, 3, 4))
                for t_idx in range(per_frame.shape[0]):
                    if float(per_frame[t_idx]) < 0.05:
                        prior_locked_t += 1
                    else:
                        break
        except Exception as e:
            log.warning("[LTXChainKf] could not detect prior-locked region from noise_mask: %s", e)
            prior_locked_t = 0

        # Build segments. A segment is a half-open partition of [0, latent_length) bounded by
        # kfs (or by sequence start / end / prior-locked region).
        # - If prior_locked_t > 0, segment 0 spans [0, prior_locked_t - 1] (the locked X region)
        #   and the next segment starts at the first kf or at prior_locked_t if no kf there.
        # - Each kf is the RIGHT boundary of the prior segment and the LEFT boundary of the next.
        # - Kfs are full-attention from any segment (handled separately in the mask_fn).
        segments = []  # list of (left_bound, right_bound) inclusive in latent-frame space

        cursor = 0
        if prior_locked_t > 0:
            # Prior region is its own segment (segment 0)
            segments.append((0, max(0, prior_locked_t - 1)))
            cursor = prior_locked_t
        for rec in kf_records:
            # A kf occupies [rec["latent_idx"], rec["latent_end"]] (D consecutive latents
            # for D-frame kfs, just one for D=1). The segment ending at this kf includes
            # the cursor up to the kf's LAST locked frame; the next segment starts after.
            kf_start = rec["latent_idx"]
            kf_end = rec["latent_end"]
            if kf_start < cursor:
                log.warning(
                    "[LTXChainKf] kf at latent [%d..%d] overlaps prior segment (cursor=%d) — "
                    "segment will be empty or negative", kf_start, kf_end, cursor,
                )
            segments.append((cursor, kf_end))
            cursor = kf_end + 1
        # Tail segment: from cursor to latent_length - 1
        if cursor < latent_length:
            segments.append((cursor, latent_length - 1))

        # Translate "kf K is a cut" into "segment boundary at left-seg-index B is hard."
        # In the segments list above, segment i ends at kf_latent_indices[?] depending on
        # whether there's a prior region:
        #   - prior_locked_t > 0: segments[0] = prior, segments[1+j] ends at kf order j.
        #     A cut at kf order j is between segments[1+j] and segments[2+j] → left = 1+j.
        #   - prior_locked_t == 0: segments[j] ends at kf order j.
        #     A cut at kf order j is between segments[j] and segments[j+1] → left = j.
        cut_segment_boundaries = set()
        seg_offset = 1 if prior_locked_t > 0 else 0
        for j, rec in enumerate(kf_records):
            if rec["is_cut"]:
                cut_segment_boundaries.add(seg_offset + j)

        # Tokens-per-frame fallback for self-attn (in case grid_sizes is absent at attention time)
        try:
            _arch, _patch_size, _temporal_stride = detect_model_type(model)
        except Exception as e:
            log.warning("[LTXChainKf] could not detect model type — %s. Defaulting to ltx with patch_size=1.", e)
            _arch, _patch_size, _temporal_stride = "ltx", (1, 1, 1), 8

        tokens_per_frame_fallback = (latent_image.shape[3] // _patch_size[1]) * (latent_image.shape[4] // _patch_size[2])

        kf_state = {
            "segments": [(int(l), int(r)) for (l, r) in segments],
            "kf_latent_indices": [int(i) for i in kf_latent_indices],
            "cut_segment_boundaries": cut_segment_boundaries,
            "isolation_edge0": float(isolation_edge0),
            "isolation_edge1": float(isolation_edge1),
            "cross_segment_floor": float(cross_segment_floor),
            "cut_attention_floor": float(cut_attention_floor),
            "boundary_block_fraction": float(boundary_block_fraction),
            "total_latent_frames": int(latent_image.shape[2]),
            "tokens_per_frame": int(tokens_per_frame_fallback),
            "video_latent_shape": tuple(latent_image.shape),
        }

        log.info(
            "[LTXChainKf] %d kfs at latent positions %s, %d segments %s, cuts at boundaries %s, prior_locked_t=%d",
            len(kf_records), kf_latent_indices, len(segments), segments, sorted(cut_segment_boundaries), prior_locked_t,
        )

        if _arch != "ltx":
            raise ValueError(f"[LTXChainKf] this node is LTX-only. Detected arch: {_arch}")

        patched = model.clone()
        apply_patches(
            patched, "ltx",
            mask_fn=None,  # no cross-attn patching — prompts not in scope
            self_attn_mask_fn_factory=make_chain_attention_mask_fn_factory(kf_state),
        )

        return io.NodeOutput(
            patched, positive, negative, {"samples": latent_image, "noise_mask": noise_mask}
        )
