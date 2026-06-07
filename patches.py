import logging
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


def make_kf_falloff_mask_fn(kf_state):
    """Factory returning a self-attn mask_fn closure over a mutable kf_state dict.

    Layer 3 (keyframe self-attn falloff). For each registered kf latent slot, queries
    within `kf_reach` latent frames get unattenuated attention; beyond that, a Gaussian
    penalty `(distance - kf_reach)^2 / (2 * sigma^2)` is added in log-space, sharply
    reducing the kf's influence on distant frames.

    kf_state is a mutable dict shared between LTXDirector (which creates it and wires
    this closure into the model patches) and LTXDirectorGuide (which populates it with
    the actual kf latent indices after replace_latent_frames runs). The closure reads
    kf_state at attention time, so updates from LTXDirectorGuide are visible during
    sampling without re-patching the model.

    Expected keys in kf_state:
      - 'latent_indices': list[int] of kf latent slot indices (empty → mask_fn returns None)
      - 'kf_reach': int, full-attention radius in latent frames (default 1)
      - 'sigma': float, Gaussian falloff sharpness (default 0.5)
    """
    cache = {}

    def mask_fn(q, k, transformer_options):
        indices = kf_state.get("latent_indices", [])
        if not indices:
            return None

        Lq = q.shape[1]
        Lk = k.shape[1]
        if Lq != Lk:  # self-attention only
            return None

        # Skip the unconditional pass (no need to attenuate kfs there)
        cond_or_uncond = transformer_options.get("cond_or_uncond", [])
        if 1 in cond_or_uncond and 0 not in cond_or_uncond:
            return None

        grid_sizes = transformer_options.get("grid_sizes", None)
        if grid_sizes is None:
            return None
        tokens_per_frame = int(grid_sizes[1]) * int(grid_sizes[2])
        if tokens_per_frame <= 0:
            return None

        latent_frames = Lq // tokens_per_frame
        if latent_frames == 0:
            return None

        kf_idx_tuple = tuple(int(i) for i in indices if 0 <= int(i) < latent_frames)
        if not kf_idx_tuple:
            return None

        kf_reach = int(kf_state.get("kf_reach", 1))
        sigma = float(kf_state.get("sigma", 0.5))

        cache_key = (Lq, kf_idx_tuple, kf_reach, sigma, q.device, q.dtype)
        cached = cache.get(cache_key, None)
        if cached is not None:
            return cached

        device = q.device
        query_frames = torch.arange(Lq, device=device, dtype=torch.float32) // tokens_per_frame  # (Lq,)
        key_frames = torch.arange(Lk, device=device, dtype=torch.float32) // tokens_per_frame  # (Lk,)

        mask_t = torch.zeros(1, 1, Lq, Lk, device=device, dtype=torch.float32)
        for kf_idx in kf_idx_tuple:
            kf_key_cols = (key_frames == kf_idx).float().view(1, Lk)  # (1, Lk)
            distance = (query_frames - kf_idx).abs()  # (Lq,)
            penalty = (torch.relu(distance - kf_reach) ** 2) / (2.0 * sigma * sigma)  # (Lq,)
            mask_t[0, 0] += -penalty.view(Lq, 1) * kf_key_cols

        log.info(
            "[LTX kf-falloff] Built self-attn mask Lq=%d, kf_slots=%s, reach=%d, sigma=%.2f, nonzero=%d/%d",
            Lq, list(kf_idx_tuple), kf_reach, sigma,
            int((mask_t < 0).sum().item()), mask_t.numel(),
        )

        mask_t = mask_t.to(q.dtype)
        cache[cache_key] = mask_t
        return mask_t

    return mask_fn


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


def apply_patches(model_clone, arch, mask_fn, self_attn_mask_fn=None):
    """Apply prompt-relay cross-attn patches and (optionally) the LTX self-attn falloff patch.

    `mask_fn`: closure for cross-attention temporal-cost (prompt-relay). Applied to attn2
        on LTX, cross_attn on Wan.
    `self_attn_mask_fn`: optional closure for LTX self-attention (attn1). Used for the
        keyframe falloff Layer 3. Pass `None` to skip self-attn patching entirely.
    """
    diffusion_model = model_clone.get_model_object("diffusion_model")

    if arch == "wan":
        from comfy.ldm.wan.model import WanI2VCrossAttention
        for idx, block in enumerate(diffusion_model.blocks):
            key = f"diffusion_model.blocks.{idx}.cross_attn.forward"
            _check_unpatched(model_clone, key)
            cross_attn = block.cross_attn
            impl = _wan_i2v_forward if isinstance(cross_attn, WanI2VCrossAttention) else _wan_t2v_forward
            model_clone.add_object_patch(key, _CrossAttnPatch(impl, mask_fn).__get__(cross_attn, cross_attn.__class__))
        return

    if arch == "ltx":
        for idx, block in enumerate(diffusion_model.transformer_blocks):
            # Cross-attention (prompt-relay) — attn2 + audio_attn2
            for attr in ("attn2", "audio_attn2"):
                module = getattr(block, attr, None)
                if module is None:
                    continue
                key = f"diffusion_model.transformer_blocks.{idx}.{attr}.forward"
                _check_unpatched(model_clone, key)
                model_clone.add_object_patch(key, _CrossAttnPatch(_ltx_forward, mask_fn).__get__(module, module.__class__))

            # Self-attention (kf falloff) — attn1, only if requested
            if self_attn_mask_fn is not None:
                module = getattr(block, "attn1", None)
                if module is not None:
                    key = f"diffusion_model.transformer_blocks.{idx}.attn1.forward"
                    _check_unpatched(model_clone, key)
                    model_clone.add_object_patch(
                        key,
                        _CrossAttnPatch(_ltx_self_attn_forward, self_attn_mask_fn).__get__(module, module.__class__),
                    )
        return

    raise ValueError(f"Unknown model arch: {arch}")
