import logging
import math
import types
import torch
import comfy.ldm.modules.attention

log = logging.getLogger(__name__)


def _masked_attention(q, k, v, heads, mask, transformer_options={}, **kwargs):
    # Bypass wrap_attn (sage/etc may ignore masks) by calling attention_pytorch directly.
    return comfy.ldm.modules.attention.attention_pytorch(
        q, k, v, heads, mask=mask,
        _inside_attn_wrapper=True,
        transformer_options=transformer_options,
        **kwargs,
    )


def _wan_t2v_forward(self, mask_fn, x, context, transformer_options={}, **kwargs):
    q = self.norm_q(self.q(x))
    k = self.norm_k(self.k(context))
    v = self.v(context)

    mask = mask_fn(q, k, transformer_options)
    if mask is not None:
        x = _masked_attention(q, k, v, heads=self.num_heads, mask=mask,
                              transformer_options=transformer_options)
    else:
        x = comfy.ldm.modules.attention.optimized_attention(
            q, k, v, heads=self.num_heads, transformer_options=transformer_options,
        )
    return self.o(x)


def _wan_i2v_forward(self, mask_fn, x, context, context_img_len, transformer_options={}, **kwargs):
    context_img = context[:, :context_img_len]
    context_text = context[:, context_img_len:]

    q = self.norm_q(self.q(x))

    k_img = self.norm_k_img(self.k_img(context_img))
    v_img = self.v_img(context_img)
    img_x = comfy.ldm.modules.attention.optimized_attention(
        q, k_img, v_img, heads=self.num_heads, transformer_options=transformer_options,
    )

    k = self.norm_k(self.k(context_text))
    v = self.v(context_text)

    mask = mask_fn(q, k, transformer_options)
    if mask is not None:
        x = _masked_attention(q, k, v, heads=self.num_heads, mask=mask,
                              transformer_options=transformer_options)
    else:
        x = comfy.ldm.modules.attention.optimized_attention(
            q, k, v, heads=self.num_heads, transformer_options=transformer_options,
        )

    return self.o(x + img_x)


def _ltx_forward(self, mask_fn, x, context=None, mask=None, pe=None, k_pe=None, transformer_options={}):
    from comfy.ldm.lightricks.model import apply_rotary_emb

    is_self_attn = context is None
    context = x if is_self_attn else context

    q = self.q_norm(self.to_q(x))
    k = self.k_norm(self.to_k(context))
    v = self.to_v(context)

    if pe is not None:
        q = apply_rotary_emb(q, pe)
        k = apply_rotary_emb(k, pe if k_pe is None else k_pe)

    if not is_self_attn:
        temporal_mask = mask_fn(q, k, transformer_options)
        if temporal_mask is not None:
            mask = temporal_mask if mask is None else mask + temporal_mask

    if mask is None:
        out = comfy.ldm.modules.attention.optimized_attention(
            q, k, v, self.heads, attn_precision=self.attn_precision,
            transformer_options=transformer_options,
        )
    else:
        out = _masked_attention(q, k, v, self.heads, mask=mask,
                                attn_precision=self.attn_precision,
                                transformer_options=transformer_options)

    if self.to_gate_logits is not None:
        gate_logits = self.to_gate_logits(x)
        b, t, _ = out.shape
        out = out.view(b, t, self.heads, self.dim_head)
        out = out * (2.0 * torch.sigmoid(gate_logits)).unsqueeze(-1)
        out = out.view(b, t, self.heads * self.dim_head)

    return self.to_out(out)


def _ltx_self_attn_forward(self, mask_fn, x, context=None, mask=None, pe=None, k_pe=None, transformer_options={}):
    """LTX self-attention (attn1) with optional Gaussian-falloff mask from mask_fn.

    Layer 3 of the conditioning model: keyframes that live IN the latent (replace mode)
    can have their attention reach controlled here. mask_fn returns a (1, 1, Lq, Lk)
    tensor adding log-space penalty to attention scores for queries far from any kf slot.

    Composes additively with any existing tensor mask. If an existing GuideAttentionMask
    (from append-mode guides) is present, we skip our addition — composition between
    a tensor mask and a GuideAttentionMask object isn't natively supported, and users
    shouldn't mix replace-mode and append-mode keyframes in the same pass.
    """
    from comfy.ldm.lightricks.model import (
        apply_rotary_emb,
        _attention_with_guide_mask,
        GuideAttentionMask,
    )

    if context is None:
        context = x

    q = self.q_norm(self.to_q(x))
    k = self.k_norm(self.to_k(context))
    v = self.to_v(context)

    if pe is not None:
        q = apply_rotary_emb(q, pe)
        k = apply_rotary_emb(k, pe if k_pe is None else k_pe)

    additional_mask = mask_fn(q, k, transformer_options) if mask_fn is not None else None
    if additional_mask is not None:
        if mask is None:
            mask = additional_mask
        elif isinstance(mask, GuideAttentionMask):
            # Skip composing with native guide mask — different mask types.
            pass
        else:
            mask = mask + additional_mask

    if mask is None:
        out = comfy.ldm.modules.attention.optimized_attention(
            q, k, v, self.heads, attn_precision=self.attn_precision,
            transformer_options=transformer_options,
        )
    elif isinstance(mask, GuideAttentionMask):
        out = _attention_with_guide_mask(
            q, k, v, self.heads, mask,
            attn_precision=self.attn_precision,
            transformer_options=transformer_options,
        )
    else:
        out = _masked_attention(
            q, k, v, self.heads, mask=mask,
            attn_precision=self.attn_precision,
            transformer_options=transformer_options,
        )

    if self.to_gate_logits is not None:
        gate_logits = self.to_gate_logits(x)
        b, t, _ = out.shape
        out = out.view(b, t, self.heads, self.dim_head)
        out = out * (2.0 * torch.sigmoid(gate_logits)).unsqueeze(-1)
        out = out.view(b, t, self.heads * self.dim_head)

    return self.to_out(out)


def make_kf_sigma_aware_mask_fn(kf_state):
    """Factory returning a denoise_mask_function (ComfyUI hook in KSamplerX0Inpaint) that
    adjusts the MASK at kf latent positions based on the current sampling sigma.

    THE MECHANISM (sigma-aware-MASK, not sigma-aware-latent):
    LTXAV is trained with CLEAN conditioning latents at all sampling steps — that's
    intentional (matches img2vid training). Noising the latent breaks the model. But the
    MASK that controls how much kf vs model_pred blends at each step is fair game.

    Standard behavior: at the kf position, mask = 1-strength (e.g., 0.2 for strength=0.8),
    constant across sampling steps. The kf is always 80% pinned.

    With this hook: at high sigma (early steps), the mask is raised toward `max_mask`
    (e.g., 0.7), meaning the kf is more loosely held — the model has freedom to plan a
    trajectory that doesn't yet converge on the kf. At low sigma (late steps), the mask
    returns to its base value (1-strength), and the kf locks in for pixel-exact landing.

    The kf's CLEAN latent value stays clean throughout (LTX training contract preserved).
    Only the BLEND RATIO between model prediction and kf changes per step. Net effect:
    the kf "materializes" gradually from soft suggestion → hard anchor over the sampling
    trajectory. Multi-kf scenarios get motion freedom at early steps and pixel-exact
    landing at the end.

    Identifies kf positions as those with fractional mask values (0 < mask < 1). Locked
    prior X regions (mask=0) and fully-free regions (mask=1) are untouched.

    Reads kf_state['max_mask_at_sigma1'] for the upper bound (default 0.7).
    Handles both 5D direct masks and 3D-packed masks (AV workflows).
    """

    def mask_fn(sigma, denoise_mask, extra_options=None):
        kfs = kf_state.get("kfs", [])
        if not kfs or denoise_mask is None:
            return denoise_mask

        # Get scalar sigma value
        if isinstance(sigma, torch.Tensor):
            sigma_val = float(sigma.mean().item()) if sigma.numel() > 1 else float(sigma.item())
        else:
            sigma_val = float(sigma)
        sigma_val = max(0.0, min(1.0, sigma_val))

        # max_mask at sigma=1; user/director-configurable via kf_state
        max_mask = float(kf_state.get("max_mask_at_sigma1", 0.5))

        # curve_shape: how the mask transitions from max_mask (at sigma=1) to base (at sigma=0).
        #   "sigmoid" (default): S-curve with plateaus at extremes — kf stays at max_mask for
        #     early-sampling steps, sharp transition in the middle, then sits at base for late
        #     steps. Best for smooth in-and-out around the kf because there's no continuous
        #     drift, just discrete "loose" and "locked" phases.
        #   "smoothstep": cubic Hermite smoothstep with adjustable transition width. Similar to
        #     sigmoid but EXACT 0 at sigma=0 and EXACT 1 at sigma=1.
        #   "power": old behavior — gain = sigma^lock_curve. Mask drops from start of sampling
        #     onward, no early plateau. Less smooth visual transitions but sharper lock-in.
        curve_shape = str(kf_state.get("curve_shape", "sigmoid"))
        lock_curve = float(kf_state.get("lock_curve", 2.0))
        if lock_curve <= 0:
            lock_curve = 1.0

        sigma_val_clamped = max(0.0, min(1.0, sigma_val))

        if curve_shape == "power":
            sigma_curved = sigma_val_clamped ** lock_curve
        elif curve_shape == "smoothstep":
            # Narrow the transition region by lock_curve; lock_curve=1 → smoothstep(0,1),
            # lock_curve=4 → smoothstep(0.375, 0.625), a very narrow middle transition.
            half_width = 0.5 / max(1.0, lock_curve)
            edge0 = 0.5 - half_width
            edge1 = 0.5 + half_width
            t = max(0.0, min(1.0, (sigma_val_clamped - edge0) / max(1e-6, edge1 - edge0)))
            sigma_curved = t * t * (3.0 - 2.0 * t)
        else:
            # "sigmoid" (default) — S-curve with steepness ∝ lock_curve, renormalized to span
            # exactly [0, 1] over sigma in [0, 1] (so the kf does fully lock at sigma=0).
            k = lock_curve * 3.0
            raw = 1.0 / (1.0 + math.exp(-k * (sigma_val_clamped - 0.5)))
            low = 1.0 / (1.0 + math.exp(k * 0.5))
            high = 1.0 / (1.0 + math.exp(-k * 0.5))
            sigma_curved = (raw - low) / max(1e-6, high - low)
            sigma_curved = max(0.0, min(1.0, sigma_curved))

        # Detect packed vs 5D mask. Packed has shape [B, 1, total]; 5D has [B, 1, T, H, W].
        if denoise_mask.ndim == 5:
            T = denoise_mask.shape[2]
            modified = denoise_mask.clone()
            for kf in kfs:
                try:
                    idx = int(kf.get("latent_idx", -1))
                except (TypeError, ValueError):
                    continue
                if not (0 <= idx < T):
                    continue
                slice_view = modified[:, :, idx]  # [B, 1, H, W]
                # Raise mask toward max_mask proportional to sigma. At sigma=0 → unchanged.
                # At sigma=1 → reaches max_mask (or stays at current if current > max_mask).
                target = torch.full_like(slice_view, max_mask)
                raised = slice_view + sigma_curved * (target - slice_view).clamp(min=0.0)
                # Never go below current (only raise during early steps)
                modified[:, :, idx] = torch.maximum(raised, slice_view)
            return modified

        if denoise_mask.ndim == 3:
            # Packed AV mask: [B, 1, total]. Video portion is first, layout
            # T_v * H_v * W_v elements (T outermost, then H, then W).
            video_shape = kf_state.get("video_latent_shape", None)
            if video_shape is None or len(video_shape) < 5:
                return denoise_mask  # can't compute positions
            H, W = video_shape[3], video_shape[4]
            tokens_per_frame = H * W
            video_total = video_shape[2] * tokens_per_frame
            if denoise_mask.shape[2] < video_total:
                return denoise_mask

            modified = denoise_mask.clone()
            for kf in kfs:
                try:
                    idx = int(kf.get("latent_idx", -1))
                except (TypeError, ValueError):
                    continue
                if not (0 <= idx < video_shape[2]):
                    continue
                start = idx * tokens_per_frame
                end = (idx + 1) * tokens_per_frame
                if end > modified.shape[2]:
                    continue
                slice_view = modified[:, :, start:end]
                target = torch.full_like(slice_view, max_mask)
                raised = slice_view + sigma_curved * (target - slice_view).clamp(min=0.0)
                modified[:, :, start:end] = torch.maximum(raised, slice_view)
            return modified

        # Unknown shape, return unchanged
        return denoise_mask

    return mask_fn


def make_kf_sigma_aware_inpaint_patch(kf_state):
    """Factory returning a replacement for LTXAV/LTXV.scale_latent_inpaint that does
    sigma-aware (flow-matching) noise blending at kf latent positions, while keeping the
    non-kf masked region (prior locked X) at clean latent_image (original LTXAV behavior).

    THE MECHANISM: at each sampling step, the sampler calls scale_latent_inpaint to decide
    what content goes into masked positions. Default LTXAV returns latent_image unchanged
    (a CLEAN kf at every sampling step). That's "out of distribution" — the model expects
    noisy latents everywhere at high sigma, so trajectory planning fights the clean-in-noisy
    constraint, which manifests as the wooden lead-up.

    With this patch, at each step the kf positions get blended as
        sigma * noise + (1 - sigma) * latent_image
    (the same flow-matching schedule the sampler uses for free positions). At sigma=1
    (sampling start), kf slot ≈ pure noise — matches what the model expects everywhere.
    At sigma=0 (sampling end), kf slot = latent_image — exact image landing. Smooth
    interpolation between. No out-of-distribution constraint, no skin artifacts (the noise
    is annihilated by sigma→0), no wooden lead-up (trajectory planning has no clean target
    to interpolate toward early on).

    Non-kf masked positions (prior locked X region) still get latent_image clean — preserves
    the original img2vid-style prior pinning. Only kf positions are sigma-aware.

    Closure over kf_state so LTXDirectorGuide can update the kf list at runtime.
    """

    def patched_fn(sigma, noise, latent_image, **kwargs):
        kfs = kf_state.get("kfs", [])
        if not kfs:
            return latent_image  # no kfs → default behavior (preserves prior X cleanly)

        # Safety: only apply on regular 5D video latents [B, C, T, H, W]. AV workflows
        # may pack video+audio into NestedTensor or flatten before scale_latent_inpaint;
        # in those forms shape[2] can be wildly wrong and the kf_mask allocation blows up
        # (~1TB OOM observed). Bail safely; the sigma-aware path then no-ops for AV until
        # we add proper nested-tensor unbinding.
        if not isinstance(latent_image, torch.Tensor):
            if not getattr(patched_fn, "_warned_nontensor", False):
                log.warning(
                    "[LTX kf-sigma-aware] latent_image is not a Tensor (type=%s) — likely "
                    "nested AV latent. Sigma-aware kf inpaint DISABLED for this workflow; "
                    "returning latent_image unchanged. Falls back to LTXAV default behavior.",
                    type(latent_image).__name__,
                )
                patched_fn._warned_nontensor = True
            return latent_image

        if latent_image.ndim != 5:
            if not getattr(patched_fn, "_warned_ndim", False):
                log.warning(
                    "[LTX kf-sigma-aware] latent_image has ndim=%d (expected 5: [B,C,T,H,W]) "
                    "— likely packed latent. Sigma-aware kf inpaint DISABLED for this workflow.",
                    latent_image.ndim,
                )
                patched_fn._warned_ndim = True
            return latent_image

        T = latent_image.shape[2]
        # Sanity check: real video latents have ~1–100 frames in the temporal dim.
        # If T is absurd, the latent is in some packed form we don't understand.
        if T <= 0 or T > 10_000:
            if not getattr(patched_fn, "_warned_T", False):
                log.warning(
                    "[LTX kf-sigma-aware] latent_image shape[2]=%d outside reasonable range; "
                    "shape=%s. Sigma-aware kf inpaint DISABLED.",
                    T, tuple(latent_image.shape),
                )
                patched_fn._warned_T = True
            return latent_image

        device = latent_image.device
        dtype = latent_image.dtype

        # Build kf-position mask along temporal axis
        kf_mask_t = torch.zeros(T, device=device, dtype=dtype)
        n_valid = 0
        for kf in kfs:
            try:
                idx = int(kf.get("latent_idx", -1))
            except (TypeError, ValueError):
                continue
            if 0 <= idx < T:
                kf_mask_t[idx] = 1.0
                n_valid += 1
        if n_valid == 0:
            return latent_image

        # Broadcast to [1, 1, T, 1, 1] to match latent_image / noise shape
        kf_mask = kf_mask_t.view(1, 1, T, 1, 1)

        # Reshape sigma to broadcast over [B, C, T, H, W]
        if isinstance(sigma, torch.Tensor) and sigma.ndim > 0:
            sigma_shaped = sigma.reshape([sigma.shape[0]] + [1] * (len(noise.shape) - 1))
        else:
            sigma_shaped = sigma  # scalar broadcasts naturally

        # Flow-matching noise interp: sigma=1 → pure noise, sigma=0 → clean latent_image
        noised_kf = sigma_shaped * noise + (1.0 - sigma_shaped) * latent_image

        # Kf positions → sigma-aware noised; non-kf positions → clean latent_image
        return noised_kf * kf_mask + latent_image * (1.0 - kf_mask)

    return patched_fn


def make_kf_falloff_mask_fn(kf_state, block_idx=None, total_blocks=None):
    """Factory returning a self-attn mask_fn closure over a mutable kf_state dict.

    Layer 3 (keyframe self-attn falloff) with PER-KF ASYMMETRIC GRADIENT.

    For each keyframe registered in kf_state['kfs'], computes a linear-ramp attention
    multiplier in (signed) latent-frame distance space:

        if query_frame > kf_frame:
            use reach_after as coverage
        else:
            use reach_before as coverage

        attention_scale =
            peak_strength * max(0, 1 - |distance| / coverage)   if coverage > 0
            0                                                    if coverage <= 0

    Outside the coverage zone (or with coverage=0 on that side), attention to the kf
    drops to ~0 (epsilon floor to avoid log-of-zero). Within the coverage zone, the
    scale ramps linearly from `peak_strength` at the kf down to 0 at the edge.

    `peak_strength` < 1.0 means the kf NEVER gets full unfettered attention — there's
    always some attenuation even at distance 0. This is what prevents the wooden lock
    feel when the kf is in replace mode and pinned via noise_mask=0: the model's
    trajectory planning still gets gradient-shaped influence from the kf, never a
    hard pull-to-target.

    Layer-graded gating (semantic vs pixel separation): when block_idx and total_blocks
    are provided, this closure only applies the falloff in early transformer blocks
    (block_idx < total_blocks * kf_state['semantic_reach']). Late blocks return None,
    letting the kf attend freely there so high-level semantic features propagate while
    pixel-level content stays tightly localized in the early-block attenuation.

    Expected keys in kf_state:
      - 'kfs': list[dict] of per-keyframe records:
            {
              'latent_idx': int,           # the kf's slot in the latent
              'reach_before': int,         # full-coverage latent frames BEFORE the kf
              'reach_after': int,          # full-coverage latent frames AFTER the kf
              'peak_strength': float,      # attention scale at distance 0 (default 0.9)
            }
      - 'semantic_reach': float in [0, 1], fraction of (early) blocks that apply falloff
    """
    cache = {}
    # First-call-per-block diagnostic so we know the patch fired at least once.
    diag_state = {"first_call_logged": False, "first_skip_reason_logged": False}

    def _log_skip(reason):
        # Log the FIRST early-return reason per block so we can diagnose without spam.
        if not diag_state["first_skip_reason_logged"]:
            log.info(
                "[LTX kf-falloff] Block %s/%s: mask_fn invoked but returning None — reason: %s",
                block_idx if block_idx is not None else "?",
                total_blocks if total_blocks is not None else "?",
                reason,
            )
            diag_state["first_skip_reason_logged"] = True

    def mask_fn(q, k, transformer_options):
        if not diag_state["first_call_logged"]:
            log.info(
                "[LTX kf-falloff] Block %s/%s: self-attn mask_fn FIRST CALL — Lq=%d Lk=%d",
                block_idx if block_idx is not None else "?",
                total_blocks if total_blocks is not None else "?",
                q.shape[1], k.shape[1],
            )
            diag_state["first_call_logged"] = True

        # Layer-graded gating: skip falloff in late blocks for semantic propagation
        if block_idx is not None and total_blocks is not None:
            semantic_reach = float(kf_state.get("semantic_reach", 1.0))
            semantic_reach = max(0.0, min(1.0, semantic_reach))
            threshold = int(round(total_blocks * semantic_reach))
            if block_idx >= threshold:
                _log_skip(f"block past semantic_reach threshold (sr={semantic_reach:.2f}, thr={threshold})")
                return None

        kfs = kf_state.get("kfs", [])
        if not kfs:
            _log_skip(f"kf_state['kfs'] is empty (size={len(kfs)})")
            return None

        Lq = q.shape[1]
        Lk = k.shape[1]
        if Lq != Lk:  # self-attention only
            _log_skip(f"Lq != Lk ({Lq} vs {Lk}, not self-attn)")
            return None

        # Skip the unconditional pass (no need to attenuate kfs there)
        cond_or_uncond = transformer_options.get("cond_or_uncond", [])
        if 1 in cond_or_uncond and 0 not in cond_or_uncond:
            return None  # uncond pass — silently skip, this happens every step

        # tokens_per_frame derivation, with three fallbacks (LTX's internal patchifier may have
        # spatially compressed the latent so the pre-patchify value cached in kf_state is wrong):
        #   1. If grid_sizes is in transformer_options, multiply spatial dims.
        #   2. Else, derive from Lq / total_latent_frames — invariant under spatial patchify.
        #   3. Else, use the pre-patchify tokens_per_frame from kf_state (last resort).
        grid_sizes = transformer_options.get("grid_sizes", None)
        total_latent_frames = int(kf_state.get("total_latent_frames", 0))
        tokens_per_frame = 0
        if grid_sizes is not None:
            tokens_per_frame = int(grid_sizes[1]) * int(grid_sizes[2])
        elif total_latent_frames > 0 and Lq % total_latent_frames == 0:
            tokens_per_frame = Lq // total_latent_frames
        else:
            tokens_per_frame = int(kf_state.get("tokens_per_frame", 0))

        if tokens_per_frame <= 0:
            _log_skip(f"no tokens_per_frame (grid_sizes={grid_sizes}, total_lf={total_latent_frames}, Lq={Lq})")
            return None

        latent_frames = Lq // tokens_per_frame
        if latent_frames == 0:
            _log_skip(f"latent_frames=0 (Lq={Lq}, tokens_per_frame={tokens_per_frame})")
            return None

        # Filter & normalize the kf list (drop invalid entries)
        valid_kfs = []
        dropped = []
        for kf in kfs:
            try:
                idx = int(kf["latent_idx"])
                rb = int(kf.get("reach_before", 0))
                ra = int(kf.get("reach_after", 0))
                peak = float(kf.get("peak_strength", 0.9))
            except (KeyError, TypeError, ValueError) as e:
                dropped.append(("parse_error", str(e), kf))
                continue
            if not (0 <= idx < latent_frames):
                dropped.append(("out_of_range", f"idx={idx} not in [0,{latent_frames})", kf))
                continue
            valid_kfs.append((idx, rb, ra, peak))
        if not valid_kfs:
            _log_skip(f"valid_kfs empty after filter (latent_frames={latent_frames}, dropped={dropped})")
            return None

        cache_key = (Lq, tuple(valid_kfs), q.device, q.dtype)
        cached = cache.get(cache_key, None)
        if cached is not None:
            return cached

        device = q.device
        # Floor on attention scale. Was 1e-4 (log ≈ -9.2) which creates a sharp transition
        # at the coverage boundary that can manifest as color flicker in dense-kf workflows.
        # 1e-2 (log ≈ -4.6) suppresses kf influence outside coverage while keeping the
        # in→out transition smoother in log-space.
        EPSILON = 1e-2

        # Query / key frame indices per token
        query_frames = (torch.arange(Lq, device=device, dtype=torch.float32) // tokens_per_frame)  # (Lq,)
        key_frames = (torch.arange(Lk, device=device, dtype=torch.float32) // tokens_per_frame)  # (Lk,)

        # Start with zero log-bias for all (q, k) pairs. Each kf contributes a log-bias to
        # the columns corresponding to its frame. Different kfs occupy different columns
        # (different latent frames) so the additions don't overlap.
        mask_t = torch.zeros(1, 1, Lq, Lk, device=device, dtype=torch.float32)

        for kf_idx, rb, ra, peak in valid_kfs:
            # Tokens in this kf's frame slot — only these key columns get attenuation
            kf_key_cols = (key_frames == kf_idx).float().view(1, Lk)  # (1, Lk)

            # Signed distance from each query frame to this kf
            signed_dist = query_frames - float(kf_idx)  # (Lq,)
            abs_dist = signed_dist.abs()

            # Compute attention scale per query
            # For queries AT or AFTER kf (signed_dist >= 0): use reach_after
            # For queries BEFORE kf (signed_dist < 0): use reach_before
            # If the relevant reach is 0 → scale is 0 in that direction (no influence)
            if ra > 0:
                after_scale = torch.clamp(peak * (1.0 - abs_dist / float(ra)), min=0.0)
            else:
                after_scale = torch.zeros_like(abs_dist)
            if rb > 0:
                before_scale = torch.clamp(peak * (1.0 - abs_dist / float(rb)), min=0.0)
            else:
                before_scale = torch.zeros_like(abs_dist)

            is_after = (signed_dist >= 0).float()
            scale = is_after * after_scale + (1.0 - is_after) * before_scale  # (Lq,)

            # log-space additive bias to attention scores
            log_bias = (scale + EPSILON).log()  # (Lq,)

            # Apply to mask columns where key is in this kf's frame.
            # log_bias values relative to peak: at distance 0, log(peak+eps); at coverage edge, log(eps).
            # Subtract log(1.0) implicit baseline so positive log(peak) becomes a small positive bias —
            # but since peak <= 1.0, log_bias <= 0 always (always attenuation or neutral).
            mask_t[0, 0] += log_bias.view(Lq, 1) * kf_key_cols

        log.info(
            "[LTX kf-falloff] Block %s/%s: linear-gradient mask Lq=%d, kfs=%s, nonzero=%d/%d",
            block_idx if block_idx is not None else "?",
            total_blocks if total_blocks is not None else "?",
            Lq,
            [(idx, rb, ra, round(peak, 2)) for (idx, rb, ra, peak) in valid_kfs],
            int((mask_t != 0).sum().item()), mask_t.numel(),
        )

        mask_t = mask_t.to(q.dtype)
        cache[cache_key] = mask_t
        return mask_t

    return mask_fn


def make_chain_attention_mask_fn_factory(kf_state):
    """Factory producing a per-block self-attention mask_fn for the CHAINED-EXTEND
    architecture.

    Mental model: the noise_mask already chains the latent — kfs locked at mask=0,
    free regions at mask=1, every free segment bounded by clean conditioning on either
    side. Each segment in isolation is an LTX training-distribution case (img2vid or
    start+end-anchor). The model's self-attention, however, sees the whole sequence at
    once and treats multi-kf as one OOD problem. This mask partitions self-attention
    so each free segment ATTENDS as if it were its own extend-video sub-problem.

    Behavior per (query_frame, key_frame):
      - Same segment: full attention (1.0).
      - Key is a kf (boundary token of two segments): full attention (1.0) — kfs are
        shared between adjacent segments by construction.
      - Adjacent segments (no cut between): cross_segment_floor + (1-floor) * isolation_relax.
        isolation_relax is sigma-scheduled (1.0 at high sigma → 0.0 at low sigma) so global
        context forms early and tightens to per-segment refinement late.
      - Adjacent across a HARD CUT (kf marked is_cut): cut_attention_floor. No bleed even
        early — cuts mean different scenes.
      - Non-adjacent: cross_segment_floor (constant weak global context).

    Returns a CALLABLE FACTORY taking (block_idx, total_blocks) → mask_fn (or None to
    skip patching for that block when layer-gated out).

    Expected kf_state keys:
      - 'segments': list of (left_bound, right_bound) tuples (inclusive both ends) in
        latent-frame space. Each tuple defines a half-open partition; kfs sit ON the
        boundaries so they belong to both neighbors.
      - 'kf_latent_indices': list[int] — which latent frames hold kfs.
      - 'cut_segment_boundaries': set[int] — LEFT-segment indices for boundaries that
        are hard cuts. A cut at left-seg-index i means the boundary between segments[i]
        and segments[i+1] is hard (cross-attention drops to cut_attention_floor regardless
        of sigma). Caller is responsible for translating "kf K is a cut" into the correct
        segment index.
      - 'isolation_edge0', 'isolation_edge1': smoothstep edges (defaults 0.2, 0.6).
      - 'cross_segment_floor' (default 0.05), 'cut_attention_floor' (default 0.01).
      - 'boundary_block_fraction' (default 0.5).
      - 'total_latent_frames' (int).
    """

    def factory(block_idx, total_blocks):
        cache = {}
        diag_state = {"first_call_logged": False, "first_skip_reason_logged": False}

        def _log_skip(reason):
            if not diag_state["first_skip_reason_logged"]:
                log.info(
                    "[LTX chain] Block %d/%d: mask_fn invoked but returning None — reason: %s",
                    block_idx, total_blocks, reason,
                )
                diag_state["first_skip_reason_logged"] = True

        def mask_fn(q, k, transformer_options):
            if not diag_state["first_call_logged"]:
                log.info(
                    "[LTX chain] Block %d/%d: self-attn mask_fn FIRST CALL — Lq=%d Lk=%d",
                    block_idx, total_blocks, q.shape[1], k.shape[1],
                )
                diag_state["first_call_logged"] = True

            # Layer gate: only apply in early blocks. Late blocks attend freely so
            # semantic features can propagate across segment boundaries.
            boundary_block_fraction = float(kf_state.get("boundary_block_fraction", 0.5))
            boundary_block_fraction = max(0.0, min(1.0, boundary_block_fraction))
            threshold = int(round(total_blocks * boundary_block_fraction))
            if block_idx >= threshold:
                _log_skip(f"block past boundary_block_fraction (frac={boundary_block_fraction:.2f}, thr={threshold})")
                return None

            segments = kf_state.get("segments", [])
            if not segments:
                _log_skip("segments empty")
                return None

            Lq = q.shape[1]
            Lk = k.shape[1]
            if Lq != Lk:
                _log_skip(f"Lq != Lk ({Lq} vs {Lk}, not self-attn)")
                return None

            # Skip the unconditional pass (no need to attenuate there)
            cond_or_uncond = transformer_options.get("cond_or_uncond", [])
            if 1 in cond_or_uncond and 0 not in cond_or_uncond:
                return None

            # tokens_per_frame derivation (3-tier fallback, same as existing Gaussian patch)
            grid_sizes = transformer_options.get("grid_sizes", None)
            total_latent_frames = int(kf_state.get("total_latent_frames", 0))
            tokens_per_frame = 0
            if grid_sizes is not None:
                tokens_per_frame = int(grid_sizes[1]) * int(grid_sizes[2])
            elif total_latent_frames > 0 and Lq % total_latent_frames == 0:
                tokens_per_frame = Lq // total_latent_frames
            else:
                tokens_per_frame = int(kf_state.get("tokens_per_frame", 0))

            if tokens_per_frame <= 0:
                _log_skip(f"no tokens_per_frame (grid_sizes={grid_sizes}, total_lf={total_latent_frames}, Lq={Lq})")
                return None

            latent_frames = Lq // tokens_per_frame
            if latent_frames == 0:
                _log_skip(f"latent_frames=0 (Lq={Lq}, tokens_per_frame={tokens_per_frame})")
                return None

            # Read sigma; map to isolation_relax via smoothstep(sigma, edge0, edge1).
            # edge0 < edge1; relax=0 below edge0 (tight isolation), relax=1 above edge1 (loose).
            sigmas = transformer_options.get("sigmas", None)
            if sigmas is None:
                sigma_val = 1.0  # safe default — full relaxation at first call
            else:
                try:
                    if isinstance(sigmas, torch.Tensor):
                        sigma_val = float(sigmas.mean().item()) if sigmas.numel() > 1 else float(sigmas.item())
                    else:
                        sigma_val = float(sigmas)
                except (RuntimeError, ValueError, TypeError):
                    sigma_val = 1.0
            sigma_val = max(0.0, min(1.0, sigma_val))

            edge0 = float(kf_state.get("isolation_edge0", 0.2))
            edge1 = float(kf_state.get("isolation_edge1", 0.6))
            if edge1 <= edge0:
                edge1 = edge0 + 1e-3
            tnorm = max(0.0, min(1.0, (sigma_val - edge0) / (edge1 - edge0)))
            isolation_relax = tnorm * tnorm * (3.0 - 2.0 * tnorm)  # smoothstep

            cross_floor = float(kf_state.get("cross_segment_floor", 0.05))
            cut_floor = float(kf_state.get("cut_attention_floor", 0.01))
            cross_floor = max(1e-6, min(1.0, cross_floor))
            cut_floor = max(1e-6, min(1.0, cut_floor))

            # Sigma bucket so a tiny sigma drift doesn't bust the cache every step.
            sigma_bucket = round(sigma_val * 20)

            seg_tuple = tuple((int(l), int(r)) for (l, r) in segments)
            cut_set = tuple(sorted(int(i) for i in kf_state.get("cut_segment_boundaries", set())))

            # Cache stores only the SMALL frame-resolution log-bias (latent_frames^2).
            # Token-resolution expansion via repeat_interleave is cheap (no compute, just
            # a memory layout op) and runs every call. Caching the expanded form would
            # consume gigabytes per block for long sequences (e.g. 60 latent frames * 250
            # tokens/frame = 15000 tokens → ~450MB at fp16 per cached tensor).
            frame_key = (latent_frames, seg_tuple, cut_set, sigma_bucket, q.device)
            log_bias_frame = cache.get(frame_key, None)

            if log_bias_frame is None:
                device = q.device

                # Segment-id per latent frame. Boundary kfs get the LOWER seg id; their
                # kf-key column is overridden to 1.0 below (kfs are shared boundaries).
                seg_id = [0] * latent_frames
                for s_idx, (lb, rb) in enumerate(segments):
                    for f in range(max(0, lb), min(latent_frames, rb + 1)):
                        seg_id[f] = s_idx

                n = latent_frames
                seg_q = torch.tensor(seg_id, dtype=torch.long, device=device)

                kf_indices = set(int(i) for i in kf_state.get("kf_latent_indices", []))
                kf_key_mask = torch.zeros(n, dtype=torch.bool, device=device)
                for idx in kf_indices:
                    if 0 <= idx < n:
                        kf_key_mask[idx] = True

                same_seg = (seg_q.unsqueeze(1) == seg_q.unsqueeze(0))  # (n, n)
                seg_diff = (seg_q.unsqueeze(1) - seg_q.unsqueeze(0)).abs()
                adjacent = (seg_diff == 1)

                # Hard-cut pair mask: which (q-seg, k-seg) pairs cross a cut boundary.
                cut_pair = torch.zeros(n, n, dtype=torch.bool, device=device)
                for i in cut_set:
                    qa = (seg_q == i).unsqueeze(1)
                    kb = (seg_q == (i + 1)).unsqueeze(0)
                    qc = (seg_q == (i + 1)).unsqueeze(1)
                    kd = (seg_q == i).unsqueeze(0)
                    cut_pair = cut_pair | (qa & kb) | (qc & kd)

                mult = torch.full((n, n), cross_floor, dtype=torch.float32, device=device)
                adj_no_cut = adjacent & (~cut_pair)
                adj_value = cross_floor + (1.0 - cross_floor) * isolation_relax
                mult = torch.where(adj_no_cut, torch.tensor(adj_value, device=device, dtype=mult.dtype), mult)
                mult = torch.where(adjacent & cut_pair, torch.tensor(cut_floor, device=device, dtype=mult.dtype), mult)
                mult = torch.where(same_seg, torch.tensor(1.0, device=device, dtype=mult.dtype), mult)
                kf_col_mask = kf_key_mask.unsqueeze(0).expand(n, n)
                mult = torch.where(kf_col_mask, torch.tensor(1.0, device=device, dtype=mult.dtype), mult)

                EPSILON = 1e-6
                log_bias_frame = (mult + EPSILON).log()  # (n, n), fp32
                cache[frame_key] = log_bias_frame

                log.info(
                    "[LTX chain] Block %d/%d: built frame-bias (%dx%d), sigma=%.3f, relax=%.3f, cuts=%s",
                    block_idx, total_blocks, latent_frames, latent_frames, sigma_val, isolation_relax, cut_set,
                )

            # Expand frame-resolution log-bias to token-resolution on every call.
            # tokens_per_frame can vary call-to-call (LTX's patchifier compresses spatially),
            # and the expansion is cheap.
            log_bias_tokens = log_bias_frame.repeat_interleave(tokens_per_frame, dim=0).repeat_interleave(tokens_per_frame, dim=1)
            return log_bias_tokens.view(1, 1, Lq, Lk).to(q.dtype)

        return mask_fn

    return factory


def make_chain_append_attention_mask_fn_factory(kf_state):
    """Factory for the APPEND-MODE chain attention mask.

    Mental model: kfs are extra reference tokens appended at the END of the latent stream
    (via `append_keyframe`), NOT slot replacements. The original latent stream [0..T-1] is
    fully model-generated. Appended kf tokens occupy frame positions [T..T+n_kfs-1] in the
    self-attention layout, with RoPE positions remapped via `keyframe_idxs` to the user's
    pixel targets.

    This mask partitions attention so each appended kf only strongly anchors its bordering
    segments in the original latent stream (the segments immediately before and after the
    kf's central slot). Slot-to-slot rules within the original stream are the same as in
    the replace-mode chain mask. KF tokens get full attention from the segments they bound,
    weak attention from non-bordering segments.

    Key differences from `make_chain_attention_mask_fn_factory`:
      - Total frame count = n_original + n_kfs (the latent stream grew via append).
      - The kf-key column rule changes: instead of "any kf-slot column is full attention,"
        a kf-FRAME column (frames T..T+n_kfs-1) is full attention ONLY from queries in its
        bordering segments. Other segments see the kf at cross_floor / relax / cut_floor.
      - KF-to-KF attention is full (kfs share scene context across the sequence).
      - Cuts only affect slot-to-slot adjacency, not slot-to-kf (a kf is the boundary token
        for both sides of a cut by construction).

    Expected `kf_state` keys (set by `LTXChainKeyframeAppend`):
      - 'segments': list of (start_slot, end_slot) inclusive in the ORIGINAL latent stream.
      - 'kf_segment_membership': list[list[int]] — for each kf j, segment IDs it bounds.
      - 'cut_segment_boundaries': set[int] — left-seg indices of cut boundaries.
      - 'n_original_frames': int (the latent stream length BEFORE append).
      - 'n_kfs': int.
      - 'total_latent_frames': int (n_original + n_kfs).
      - 'tokens_per_frame': int (fallback for tpf derivation).
      - 'isolation_edge0', 'isolation_edge1', 'cross_segment_floor', 'cut_attention_floor',
        'boundary_block_fraction': same semantics as replace-mode factory.
    """

    def factory(block_idx, total_blocks):
        cache = {}
        diag_state = {"first_call_logged": False, "first_skip_reason_logged": False}

        def _log_skip(reason):
            if not diag_state["first_skip_reason_logged"]:
                log.info(
                    "[LTX chain-append] Block %d/%d: mask_fn invoked but returning None — %s",
                    block_idx, total_blocks, reason,
                )
                diag_state["first_skip_reason_logged"] = True

        def mask_fn(q, k, transformer_options):
            if not diag_state["first_call_logged"]:
                log.info(
                    "[LTX chain-append] Block %d/%d: FIRST CALL — Lq=%d Lk=%d",
                    block_idx, total_blocks, q.shape[1], k.shape[1],
                )
                diag_state["first_call_logged"] = True

            boundary_block_fraction = max(0.0, min(1.0, float(kf_state.get("boundary_block_fraction", 0.5))))
            threshold = int(round(total_blocks * boundary_block_fraction))
            if block_idx >= threshold:
                _log_skip(f"past boundary_block_fraction (thr={threshold})")
                return None

            segments = kf_state.get("segments", [])
            if not segments:
                _log_skip("segments empty")
                return None

            Lq = q.shape[1]
            Lk = k.shape[1]
            if Lq != Lk:
                _log_skip(f"Lq != Lk ({Lq} vs {Lk})")
                return None

            cond_or_uncond = transformer_options.get("cond_or_uncond", [])
            if 1 in cond_or_uncond and 0 not in cond_or_uncond:
                return None

            # tokens_per_frame derivation (3-tier fallback)
            grid_sizes = transformer_options.get("grid_sizes", None)
            total_latent_frames = int(kf_state.get("total_latent_frames", 0))
            tokens_per_frame = 0
            if grid_sizes is not None:
                tokens_per_frame = int(grid_sizes[1]) * int(grid_sizes[2])
            elif total_latent_frames > 0 and Lq % total_latent_frames == 0:
                tokens_per_frame = Lq // total_latent_frames
            else:
                tokens_per_frame = int(kf_state.get("tokens_per_frame", 0))

            if tokens_per_frame <= 0:
                _log_skip(f"no tpf (grid={grid_sizes}, total={total_latent_frames}, Lq={Lq})")
                return None

            n_frames = Lq // tokens_per_frame
            n_original = int(kf_state.get("n_original_frames", 0))
            n_kfs = int(kf_state.get("n_kfs", 0))

            if n_frames != n_original + n_kfs:
                _log_skip(f"n_frames {n_frames} != n_original {n_original} + n_kfs {n_kfs}")
                return None

            # Sigma → isolation_relax (smoothstep on [edge0, edge1])
            sigmas = transformer_options.get("sigmas", None)
            try:
                if isinstance(sigmas, torch.Tensor):
                    sigma_val = float(sigmas.mean().item()) if sigmas.numel() > 1 else float(sigmas.item())
                elif sigmas is not None:
                    sigma_val = float(sigmas)
                else:
                    sigma_val = 1.0
            except (RuntimeError, ValueError, TypeError):
                sigma_val = 1.0
            sigma_val = max(0.0, min(1.0, sigma_val))

            edge0 = float(kf_state.get("isolation_edge0", 0.2))
            edge1 = float(kf_state.get("isolation_edge1", 0.6))
            if edge1 <= edge0:
                edge1 = edge0 + 1e-3
            tnorm = max(0.0, min(1.0, (sigma_val - edge0) / (edge1 - edge0)))
            isolation_relax = tnorm * tnorm * (3.0 - 2.0 * tnorm)

            cross_floor = max(1e-6, min(1.0, float(kf_state.get("cross_segment_floor", 0.05))))
            cut_floor = max(1e-6, min(1.0, float(kf_state.get("cut_attention_floor", 0.01))))

            sigma_bucket = round(sigma_val * 20)
            seg_tuple = tuple((int(l), int(r)) for (l, r) in segments)
            cut_set = tuple(sorted(int(i) for i in kf_state.get("cut_segment_boundaries", set())))
            kf_membership_list = kf_state.get("kf_segment_membership", [])
            kf_mem_tuple = tuple(tuple(sorted(int(s) for s in m)) for m in kf_membership_list)

            frame_key = (n_frames, n_original, n_kfs, seg_tuple, cut_set, kf_mem_tuple, sigma_bucket, q.device)
            log_bias_frame = cache.get(frame_key, None)

            if log_bias_frame is None:
                device = q.device

                # seg_id for original-stream slots; kf slots are flagged as -1.
                seg_id = torch.full((n_frames,), -1, dtype=torch.long, device=device)
                for s_idx, (lb, rb) in enumerate(segments):
                    for f in range(max(0, lb), min(n_original, rb + 1)):
                        seg_id[f] = s_idx

                n = n_frames

                # Multiplier matrix at frame resolution. Default everywhere = cross_floor.
                mult = torch.full((n, n), cross_floor, dtype=torch.float32, device=device)

                # ---- Original-stream slot-to-slot rules (same as replace-mode mask) ----
                orig_mask = (seg_id >= 0)
                orig_q = orig_mask.unsqueeze(1)  # (n, 1)
                orig_k = orig_mask.unsqueeze(0)  # (1, n)
                both_orig = orig_q & orig_k

                seg_q_mat = seg_id.unsqueeze(1)
                seg_k_mat = seg_id.unsqueeze(0)

                same_seg = (seg_q_mat == seg_k_mat) & both_orig
                seg_diff = (seg_q_mat - seg_k_mat).abs()
                adjacent = (seg_diff == 1) & both_orig

                cut_pair = torch.zeros(n, n, dtype=torch.bool, device=device)
                for ci in cut_set:
                    qa = (seg_id == ci).unsqueeze(1)
                    kb = (seg_id == (ci + 1)).unsqueeze(0)
                    qc = (seg_id == (ci + 1)).unsqueeze(1)
                    kd = (seg_id == ci).unsqueeze(0)
                    cut_pair = cut_pair | (qa & kb) | (qc & kd)

                adj_no_cut = adjacent & (~cut_pair)
                adj_value = cross_floor + (1.0 - cross_floor) * isolation_relax
                mult = torch.where(adj_no_cut, torch.tensor(adj_value, device=device, dtype=mult.dtype), mult)
                mult = torch.where(adjacent & cut_pair, torch.tensor(cut_floor, device=device, dtype=mult.dtype), mult)
                mult = torch.where(same_seg, torch.tensor(1.0, device=device, dtype=mult.dtype), mult)

                # ---- KF rows/columns ----
                # For each appended kf j (frame index n_original + j), compute a per-segment
                # multiplier vector and broadcast to its row/column.
                n_segs = len(segments)
                for j in range(n_kfs):
                    kf_frame = n_original + j
                    mem = set(int(s) for s in kf_membership_list[j]) if j < len(kf_membership_list) else set()
                    # Per-segment multiplier from a slot in segment s to this kf
                    seg_to_kf = torch.full((n_segs,), cross_floor, dtype=torch.float32, device=device)
                    for s in range(n_segs):
                        if s in mem:
                            seg_to_kf[s] = 1.0
                        else:
                            min_dist = min((abs(s - m) for m in mem), default=9999)
                            if min_dist == 1:
                                seg_to_kf[s] = cross_floor + (1.0 - cross_floor) * isolation_relax
                            # else: cross_floor (already set)

                    # Apply to each original-stream slot's row/column for this kf
                    for q_f in range(n_original):
                        s = int(seg_id[q_f])
                        if s >= 0:
                            v = float(seg_to_kf[s])
                            mult[q_f, kf_frame] = v
                            mult[kf_frame, q_f] = v

                # ---- KF-to-KF: full attention (kfs share scene context) ----
                if n_kfs > 0:
                    kf_block_start = n_original
                    kf_block_end = n_original + n_kfs
                    mult[kf_block_start:kf_block_end, kf_block_start:kf_block_end] = 1.0

                EPSILON = 1e-6
                log_bias_frame = (mult + EPSILON).log()
                cache[frame_key] = log_bias_frame

                log.info(
                    "[LTX chain-append] Block %d/%d: built frame-bias (%dx%d), sigma=%.3f, relax=%.3f, "
                    "n_original=%d, n_kfs=%d, cuts=%s, kf_mem=%s",
                    block_idx, total_blocks, n, n, sigma_val, isolation_relax,
                    n_original, n_kfs, cut_set, kf_mem_tuple,
                )

            log_bias_tokens = log_bias_frame.repeat_interleave(tokens_per_frame, dim=0).repeat_interleave(tokens_per_frame, dim=1)
            return log_bias_tokens.view(1, 1, Lq, Lk).to(q.dtype)

        return mask_fn

    return factory


class _CrossAttnPatch:
    """Descriptor that binds (impl, mask_fn) as a method onto a cross-attn module."""

    def __init__(self, impl, mask_fn):
        self.impl = impl
        self.mask_fn = mask_fn

    def __get__(self, obj, objtype=None):
        impl, mask_fn = self.impl, self.mask_fn

        def wrapped(self_module, *args, **kwargs):
            return impl(self_module, mask_fn, *args, **kwargs)

        return types.MethodType(wrapped, obj)


def detect_model_type(model):
    """Return (arch, patch_size, temporal_stride) for latent geometry.

    temporal_stride is the VAE's pixel→latent temporal compression factor,
    used to convert user-facing pixel frame counts to latent frames.
    """
    diff_model = model.model.diffusion_model

    if hasattr(diff_model, "patch_size") and not hasattr(diff_model, "patchifier"):
        return "wan", tuple(diff_model.patch_size), 4

    if hasattr(diff_model, "patchifier"):
        return "ltx", (1, 1, 1), int(diff_model.vae_scale_factors[0])

    raise ValueError(
        f"Unsupported model type: {type(diff_model).__name__}. "
        f"Currently supports Wan and LTX models."
    )


def _check_unpatched(model_clone, key):
    if key in getattr(model_clone, "object_patches", {}):
        raise RuntimeError(
            f"PromptRelay: cross-attention forward at '{key}' is already patched by "
            "another node (e.g. KJNodes NAG). Stacking is not supported — remove the "
            "conflicting node."
        )


def apply_patches(model_clone, arch, mask_fn=None, self_attn_mask_fn_factory=None, kf_inpaint_patch=None):
    """Apply prompt-relay cross-attn patches plus optional LTX self-attn patches and
    sigma-aware kf inpaint patches.

    `mask_fn`: optional closure for cross-attention temporal-cost (prompt-relay). Applied
        to attn2 on LTX, cross_attn on Wan. When None, no cross-attn patching is done
        (useful for nodes that only need self-attn patching, e.g. chain keyframe guide).
    `self_attn_mask_fn_factory`: optional callable `(block_idx, total_blocks) -> mask_fn`.
        If provided, each LTX transformer block's attn1 gets a per-block mask_fn from
        this factory.
    `kf_inpaint_patch`: optional callable replacing BaseModel.scale_latent_inpaint.
    """
    diffusion_model = model_clone.get_model_object("diffusion_model")

    if arch == "wan":
        if mask_fn is None:
            return  # Wan only supports cross-attn patching here; nothing to do.
        from comfy.ldm.wan.model import WanI2VCrossAttention
        for idx, block in enumerate(diffusion_model.blocks):
            key = f"diffusion_model.blocks.{idx}.cross_attn.forward"
            _check_unpatched(model_clone, key)
            cross_attn = block.cross_attn
            impl = _wan_i2v_forward if isinstance(cross_attn, WanI2VCrossAttention) else _wan_t2v_forward
            model_clone.add_object_patch(key, _CrossAttnPatch(impl, mask_fn).__get__(cross_attn, cross_attn.__class__))
        return

    if arch == "ltx":
        # Sigma-aware kf inpaint: replaces BaseModel.scale_latent_inpaint at the model root
        # (not inside diffusion_model). Done before block iteration so it's set once.
        if kf_inpaint_patch is not None:
            _check_unpatched(model_clone, "scale_latent_inpaint")
            model_clone.add_object_patch("scale_latent_inpaint", kf_inpaint_patch)
            log.info("[LTX kf-sigma-aware] patched scale_latent_inpaint for sigma-aware kf noise injection")

        blocks = diffusion_model.transformer_blocks
        total_blocks = len(blocks)
        for idx, block in enumerate(blocks):
            # Cross-attention (prompt-relay) — attn2 + audio_attn2. Skip if mask_fn is None.
            if mask_fn is not None:
                for attr in ("attn2", "audio_attn2"):
                    module = getattr(block, attr, None)
                    if module is None:
                        continue
                    key = f"diffusion_model.transformer_blocks.{idx}.{attr}.forward"
                    _check_unpatched(model_clone, key)
                    model_clone.add_object_patch(key, _CrossAttnPatch(_ltx_forward, mask_fn).__get__(module, module.__class__))

            # Self-attention — attn1, with per-block mask_fn from factory
            if self_attn_mask_fn_factory is not None:
                module = getattr(block, "attn1", None)
                if module is not None:
                    block_mask_fn = self_attn_mask_fn_factory(idx, total_blocks)
                    if block_mask_fn is not None:
                        key = f"diffusion_model.transformer_blocks.{idx}.attn1.forward"
                        _check_unpatched(model_clone, key)
                        model_clone.add_object_patch(
                            key,
                            _CrossAttnPatch(_ltx_self_attn_forward, block_mask_fn).__get__(module, module.__class__),
                        )
        return

    raise ValueError(f"Unknown model arch: {arch}")
