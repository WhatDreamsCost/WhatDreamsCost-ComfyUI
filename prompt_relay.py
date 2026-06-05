import logging
import math
import torch

log = logging.getLogger(__name__)


def build_temporal_cost(q_token_idx, Lq, Lk, device, dtype, tokens_per_frame):
    """Gaussian penalty matrix [Lq, Lk] for video cross-attention (integer frame indexing)."""
    offset = torch.zeros(Lq, Lk, device=device, dtype=dtype)
    query_frames = torch.arange(Lq, device=device, dtype=torch.long) // tokens_per_frame

    for seg in q_token_idx:
        local = seg["local_token_idx"].to(device=device)
        d = (query_frames.float()[:, None] - seg["midpoint"]).abs()
        strength = seg.get("strength", 1.0)
        cost = strength * (torch.relu(d - seg["window"]) ** 2) / (2 * seg["sigma"] ** 2)
        offset[:, local] = cost.to(offset.dtype)

    return offset


def build_temporal_cost_scaled(q_token_idx, Lq, Lk, device, dtype, latent_frames):
    """Penalty matrix for queries that don't map to integer frames (e.g. LTXAV audio tokens)."""
    offset = torch.zeros(Lq, Lk, device=device, dtype=dtype)
    query_frames = torch.arange(Lq, device=device, dtype=torch.float32) * latent_frames / Lq

    for seg in q_token_idx:
        local = seg["local_token_idx"].to(device=device)
        d = (query_frames[:, None] - seg["midpoint"]).abs()
        sigma_a = seg.get("sigma_audio", seg["sigma"])
        window_a = seg.get("window_audio", seg["window"])
        strength_a = seg.get("strength_audio", 1.0)
        cost = strength_a * (torch.relu(d - window_a) ** 2) / (2 * sigma_a ** 2)
        offset[:, local] = cost.to(offset.dtype)

    return offset


def create_mask_fn(q_token_idx, fallback_tokens_per_frame, latent_frames):
    """Closure: mask_fn(q, k, transformer_options) -> additive mask or None."""
    cache = {}
    max_token_idx = max(int(seg["local_token_idx"].max().item()) for seg in q_token_idx) + 1

    def mask_fn(q, k, transformer_options):
        Lq, Lk = q.shape[1], k.shape[1]

        if Lq == Lk:
            return None

        # Only apply on conditional pass — not unconditional (negative prompt)
        cond_or_uncond = transformer_options.get("cond_or_uncond", [])
        if 1 in cond_or_uncond and 0 not in cond_or_uncond:
            return None

        grid_sizes = transformer_options.get("grid_sizes", None)
        video_tpf = int(grid_sizes[1]) * int(grid_sizes[2]) if grid_sizes is not None else fallback_tokens_per_frame
        video_lq = latent_frames * video_tpf

        # Skip cross-modal attention — text keys are padded to a fixed length ≥ max_token_idx and != video_lq
        if Lk == video_lq or Lk < max_token_idx:
            return None

        mode = "video" if Lq == video_lq else "scaled"

        key = (Lq, Lk, mode, q.device)
        if key not in cache:
            if mode == "video":
                cost = build_temporal_cost(q_token_idx, Lq, Lk, q.device, q.dtype, video_tpf)
            else:
                cost = build_temporal_cost_scaled(q_token_idx, Lq, Lk, q.device, q.dtype, latent_frames)
            log.info(
                "[PromptRelay] Built penalty matrix (%s): Lq=%d, Lk=%d, nonzero=%d/%d",
                mode, Lq, Lk, (cost > 0).sum().item(), cost.numel(),
            )
            cache[key] = -cost

        return cache[key].to(q.dtype)

    return mask_fn


def build_segments(token_ranges, segment_lengths, epsilon=1e-3, relay_options=None):
    """Per-segment metadata for the temporal penalty.

    relay_options (optional dict) overrides per-stream knobs:
        video_strength, video_window_scale,
        audio_epsilon, audio_strength, audio_window_scale
    Audio knobs only affect architectures whose cross-attention takes the scaled
    (non-integer-frame) path — currently LTX audio_attn2.
    """
    # Paper uses constant sigma = 1/ln(1/epsilon) regardless of segment length
    sigma = 1.0 / math.log(1.0 / epsilon) if 0 < epsilon < 1 else 0.1448

    opts = relay_options or {}
    v_strength = opts.get("video_strength", 1.0)
    v_window_scale = opts.get("video_window_scale", 1.0)
    a_epsilon = opts.get("audio_epsilon")
    a_strength = opts.get("audio_strength", 1.0)
    a_window_scale = opts.get("audio_window_scale", 1.0)

    if a_epsilon is not None and 0 < a_epsilon < 1:
        sigma_audio = 1.0 / math.log(1.0 / a_epsilon)
    else:
        sigma_audio = sigma

    if relay_options:
        log.info(
            "[PromptRelay] Advanced options active — video: strength=%.3f window_scale=%.3f | "
            "audio: epsilon=%s strength=%.3f window_scale=%.3f",
            v_strength, v_window_scale,
            f"{a_epsilon:.4f}" if a_epsilon is not None else "inherit",
            a_strength, a_window_scale,
        )

    q_token_idx = []
    frame_cursor = 0

    for (tok_start, tok_end), L in zip(token_ranges, segment_lengths):
        if L <= 0:
            frame_cursor += L
            continue
        midpoint = (2 * frame_cursor + L) // 2
        base_window = max(L // 2 - 2, 0)
        q_token_idx.append({
            "local_token_idx": torch.arange(tok_start, tok_end),
            "midpoint": midpoint,
            "window": max(base_window * v_window_scale, 0.0),
            "sigma": sigma,
            "strength": v_strength,
            "window_audio": max(base_window * a_window_scale, 0.0),
            "sigma_audio": sigma_audio,
            "strength_audio": a_strength,
        })
        frame_cursor += L

    return q_token_idx


def get_raw_tokenizer(clip):
    """Extract the raw SPiece/HF tokenizer from a ComfyUI CLIP object."""
    tokenizer_wrapper = clip.tokenizer
    for attr_name in dir(tokenizer_wrapper):
        if attr_name.startswith("_"):
            continue
        inner = getattr(tokenizer_wrapper, attr_name, None)
        if inner is not None and hasattr(inner, "tokenizer"):
            return inner.tokenizer

    raise RuntimeError(
        f"Could not find raw tokenizer on CLIP object. "
        f"Known attributes: {[a for a in dir(tokenizer_wrapper) if not a.startswith('_')]}"
    )


def map_token_indices(raw_tokenizer, global_prompt, local_prompts):
    """Tokenize global + space-prefixed locals; return (full_prompt, per-local token ranges).

    Uses incremental tokenization to avoid SentencePiece context-dependency issues.
    """
    prefixed_locals = [" " + lp for lp in local_prompts]
    full_prompt = global_prompt + "".join(prefixed_locals)
    has_eos = getattr(raw_tokenizer, "add_eos", False)
    eos_adj = 1 if has_eos else 0

    prev_len = len(raw_tokenizer(global_prompt)["input_ids"]) - eos_adj
    token_ranges = []
    built = global_prompt

    for plp in prefixed_locals:
        built += plp
        cur_len = len(raw_tokenizer(built)["input_ids"]) - eos_adj
        if cur_len <= prev_len:
            raise ValueError(f"Local prompt produced no tokens: '{plp.strip()}'")
        token_ranges.append((prev_len, cur_len))
        prev_len = cur_len

    return full_prompt, token_ranges


def distribute_segment_lengths(num_segments, latent_frames, specified_lengths=None):
    """Validate or auto-distribute segment frame counts, capped to fit within latent_frames."""
    if specified_lengths:
        if len(specified_lengths) != num_segments:
            raise ValueError(
                f"Number of segment_lengths ({len(specified_lengths)}) "
                f"must match number of local prompts ({num_segments})"
            )
        lengths = specified_lengths
    else:
        # ceil division — matches reference implementation
        step = -(-latent_frames // num_segments)
        lengths = [step] * num_segments

    effective = []
    cursor = 0
    for L in lengths:
        end = min(cursor + L, latent_frames)
        effective.append(max(end - cursor, 0))
        cursor = end
    return effective
