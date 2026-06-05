import logging
import json
import base64
import io as _io
import math

import numpy as np
import torch
import av
from PIL import Image

import os
import folder_paths
import comfy.model_management

from comfy_api.latest import io

from .prompt_relay import (
    get_raw_tokenizer,
    map_token_indices,
    build_segments,
    create_mask_fn,
    distribute_segment_lengths,
)

from .patches import detect_model_type, apply_patches

log = logging.getLogger(__name__)

# Custom socket type shared with LTXSequencer
GuideData = io.Custom("GUIDE_DATA")


def _load_image_tensor(seg: dict) -> torch.Tensor:
    """Decode an image from the ComfyUI input folder (if imageFile provided) or fallback to base64
    to a ComfyUI-style image tensor of shape [1, H, W, 3], float32 in [0, 1]."""
    if seg.get("imageFile"):
        file_path = os.path.join(folder_paths.get_input_directory(), seg["imageFile"])
        if os.path.exists(file_path):
            img = Image.open(file_path).convert("RGB")
            arr = np.array(img, dtype=np.float32) / 255.0
            return torch.from_numpy(arr).unsqueeze(0)

    b64_str = seg.get("imageB64", "")
    if not b64_str or b64_str.startswith("/view?"):
        return torch.zeros((1, 512, 512, 3), dtype=torch.float32)

    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]
    
    try:
        img_bytes = base64.b64decode(b64_str)
        img = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
        arr = np.array(img, dtype=np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)
    except:
        return torch.zeros((1, 512, 512, 3), dtype=torch.float32)


def _resize_image(tensor: torch.Tensor, target_w: int, target_h: int, method: str, divisible_by: int) -> torch.Tensor:
    """Resize a [1, H, W, 3] float32 tensor to target dimensions using the given method,
    then snap the final dimensions to be divisible by `divisible_by`."""
    from PIL import Image as _PilImage
    import torchvision.transforms.functional as TF

    def snap(val, div):
        return max(div, (val // div) * div)

    tw = snap(target_w, divisible_by)
    th = snap(target_h, divisible_by)

    img_np = (tensor[0].cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    pil = _PilImage.fromarray(img_np)
    src_w, src_h = pil.size

    if method == "stretch to fit":
        resized = pil.resize((tw, th), _PilImage.LANCZOS)

    elif method == "maintain aspect ratio":
        ratio = min(tw / src_w, th / src_h)
        new_w = int(src_w * ratio)
        new_h = int(src_h * ratio)
        new_w = snap(new_w, divisible_by)
        new_h = snap(new_h, divisible_by)
        resized = pil.resize((new_w, new_h), _PilImage.LANCZOS)

    elif method == "pad":
        ratio = min(tw / src_w, th / src_h)
        new_w = snap(int(src_w * ratio), divisible_by)
        new_h = snap(int(src_h * ratio), divisible_by)
        inner = pil.resize((new_w, new_h), _PilImage.LANCZOS)
        resized = _PilImage.new("RGB", (tw, th), (0, 0, 0))
        resized.paste(inner, ((tw - new_w) // 2, (th - new_h) // 2))

    elif method == "crop":
        ratio = max(tw / src_w, th / src_h)
        new_w = int(src_w * ratio)
        new_h = int(src_h * ratio)
        inner = pil.resize((new_w, new_h), _PilImage.LANCZOS)
        left = (new_w - tw) // 2
        top = (new_h - th) // 2
        resized = inner.crop((left, top, left + tw, top + th))

    else:
        resized = pil.resize((tw, th), _PilImage.LANCZOS)

    arr = np.array(resized, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _compress_image(tensor: torch.Tensor, crf: int) -> torch.Tensor:
    """Apply H.264 compression artefacts to a [1, H, W, 3] float32 tensor (ComfyUI image format).
    crf=0 means no compression. Uses PyAV to encode/decode a single frame in-memory."""
    if crf == 0:
        return tensor
    img = tensor[0]  # [H, W, 3]
    # Dimensions must be even for H.264
    h = (img.shape[0] // 2) * 2
    w = (img.shape[1] // 2) * 2
    img_np = (img[:h, :w] * 255.0).byte().cpu().numpy()  # uint8 [H, W, 3]

    try:
        buf = _io.BytesIO()
        container = av.open(buf, mode="w", format="mp4")
        stream = container.add_stream("libx264", rate=1)
        stream.width = w
        stream.height = h
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": str(crf), "preset": "ultrafast"}
        frame = av.VideoFrame.from_ndarray(img_np, format="rgb24")
        for pkt in stream.encode(frame):
            container.mux(pkt)
        for pkt in stream.encode(None):
            container.mux(pkt)
        container.close()

        buf.seek(0)
        container_r = av.open(buf, mode="r")
        decoded = None
        for frame_r in container_r.decode(video=0):
            decoded = frame_r.to_ndarray(format="rgb24")  # [H, W, 3]
            break
        container_r.close()

        if decoded is None:
            return tensor
        arr = torch.from_numpy(decoded.astype(np.float32) / 255.0).to(tensor.device, tensor.dtype)
        # Re-embed into original tensor shape (may have been cropped by even-rounding)
        out = tensor.clone()
        out[0, :h, :w] = arr
        return out
    except Exception as e:
        log.warning("[PromptRelay] img_compression encode/decode failed: %s", e)
        return tensor


def _build_combined_audio(timeline_data_str: str, duration_frames: int, frame_rate: float) -> dict:
    """Parses timeline JSON, loads/trims audio directly from memory using PyAV, 
    and aligns to a global timeline yielding ComfyUI's format.
    Output length explicitly mimics the timeline's duration_frames length."""
    target_sr = 44100
    total_samples = max(1, int(math.ceil(duration_frames / frame_rate * target_sr)))
    empty_audio = {"waveform": torch.zeros((1, 2, total_samples), dtype=torch.float32), "sample_rate": target_sr}

    if not timeline_data_str:
        return empty_audio

    try:
        data = json.loads(timeline_data_str)
        audio_segs = data.get("audioSegments", [])
    except Exception:
        return empty_audio

    if not audio_segs:
        return empty_audio

    out_waveform = torch.zeros((2, total_samples), dtype=torch.float32)

    for seg in audio_segs:
        buffer = None
        if seg.get("audioFile"):
            file_path = os.path.join(folder_paths.get_input_directory(), seg["audioFile"])
            if os.path.exists(file_path):
                with open(file_path, "rb") as f:
                    buffer = _io.BytesIO(f.read())
        
        if not buffer and seg.get("audioB64"):
            b64 = seg.get("audioB64")
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            try:
                audio_bytes = base64.b64decode(b64)
                buffer = _io.BytesIO(audio_bytes)
            except:
                pass
                
        if not buffer:
            continue

        try:
            clip_frames = []
            
            # Use PyAV to decode directly from memory buffer
            with av.open(buffer) as container:
                stream = container.streams.audio[0]
                
                # Setup resampler to ensure output is 44.1kHz, Stereo, Float32 Planar
                resampler = av.AudioResampler(
                    format='fltp',
                    layout='stereo',
                    rate=target_sr,
                )
                
                for frame in container.decode(stream):
                    for resampled_frame in resampler.resample(frame):
                        # to_ndarray() on fltp gives shape (channels, samples)
                        arr = resampled_frame.to_ndarray()
                        clip_frames.append(torch.from_numpy(arr))
                
                # Flush the resampler to get any remaining samples
                for resampled_frame in resampler.resample(None):
                    arr = resampled_frame.to_ndarray()
                    clip_frames.append(torch.from_numpy(arr))

            if not clip_frames:
                continue

            # Concatenate all frame blocks along the samples dimension (dim 1)
            waveform = torch.cat(clip_frames, dim=1) # Shape: [2, total_clip_samples]

            # Calculate interactive trim boundaries
            trim_start_frames = float(seg.get("trimStart", 0))
            length_frames = float(seg.get("length", 1))
            start_frames = float(seg.get("start", 0))

            start_sample_src = int(trim_start_frames / frame_rate * target_sr)
            length_samples = int(length_frames / frame_rate * target_sr)
            end_sample_src = start_sample_src + length_samples

            if start_sample_src < 0: start_sample_src = 0
            if end_sample_src > waveform.shape[1]:
                end_sample_src = waveform.shape[1]

            actual_length = end_sample_src - start_sample_src
            if actual_length <= 0: continue

            # Extract the correct segment of the audio
            clip_waveform = waveform[:, start_sample_src:end_sample_src]

            # Position onto the timeline
            start_sample_dst = int(start_frames / frame_rate * target_sr)
            
            if start_sample_dst >= out_waveform.shape[1]:
                continue
                
            end_sample_dst = start_sample_dst + actual_length

            # Clip any trailing overflow so we don't index past the timeline bounds
            if end_sample_dst > out_waveform.shape[1]:
                actual_length = out_waveform.shape[1] - start_sample_dst
                clip_waveform = clip_waveform[:, :actual_length]
                end_sample_dst = start_sample_dst + actual_length
                
            if actual_length <= 0:
                continue

            # Additive composite (allows clips overlapping to sum together naturally)
            out_waveform[:, start_sample_dst:end_sample_dst] += clip_waveform

        except Exception as e:
            log.warning("[PromptRelay] Audio process error for segment %s: %s", seg.get("fileName"), e)
            continue

    return {"waveform": out_waveform.unsqueeze(0), "sample_rate": target_sr}


def _convert_to_latent_lengths(pixel_lengths, temporal_stride, latent_frames):
    """Convert pixel-space segment lengths to integer latent-space lengths using the
    largest-remainder method. Targets the full `latent_frames` when the pixel sum looks
    like full coverage (within one stride of latent_frames * stride). Otherwise targets
    round(total_pixel / temporal_stride) so partial-coverage timelines stay partial.
    """
    if not pixel_lengths:
        return []
    total_pixel = sum(pixel_lengths)
    if total_pixel <= 0:
        return [1] * len(pixel_lengths)

    naive_total = max(1, round(total_pixel / temporal_stride))
    target_total = min(latent_frames, naive_total)
    # Within one frame of full → user clearly intended full coverage; pin to latent_frames.
    if target_total >= latent_frames - 1:
        target_total = latent_frames

    exact = [p * target_total / total_pixel for p in pixel_lengths]
    result = [int(e) for e in exact]
    diff = target_total - sum(result)
    if diff > 0:
        order = sorted(range(len(exact)), key=lambda i: -(exact[i] - int(exact[i])))
        for k in range(diff):
            result[order[k % len(order)]] += 1

    # Ensure every segment has ≥ 1 latent frame (steal from the largest if needed).
    for i in range(len(result)):
        if result[i] < 1:
            max_idx = max(range(len(result)), key=lambda j: result[j])
            if result[max_idx] > 1:
                result[max_idx] -= 1
                result[i] = 1

    return result


def _encode_relay(model, clip, latent, global_prompt, local_prompts, segment_lengths, epsilon):
    for name, val in (("global_prompt", global_prompt),
                      ("local_prompts", local_prompts),
                      ("segment_lengths", segment_lengths)):
        if val is None:
            raise ValueError(
                f"PromptRelay: '{name}' arrived as None. "
                "Likely causes: a stale workflow JSON saved with null, the timeline "
                "editor's web extension failing to load, or an upstream node returning None. "
                "Set the field to an empty string or fix the upstream connection."
            )

    # Split prompts but do NOT filter out empty ones yet, so we can detect them
    locals_list = [p.strip() for p in local_prompts.split("|")]
    
    # Check if any specific segment is empty
    for p in locals_list:
        if not p:
            raise ValueError("There is a segment on the timeline missing a prompt!")

    if not locals_list or (len(locals_list) == 1 and not locals_list[0]):
        raise ValueError("At least one local prompt is required.")

    arch, patch_size, temporal_stride = detect_model_type(model)

    samples = latent["samples"]
    latent_frames = samples.shape[2]
    tokens_per_frame = (samples.shape[3] // patch_size[1]) * (samples.shape[4] // patch_size[2])

    parsed_lengths = None
    if segment_lengths.strip():
        pixel_lengths = [int(float(x.strip())) for x in segment_lengths.split(",") if x.strip()]
        parsed_lengths = _convert_to_latent_lengths(pixel_lengths, temporal_stride, latent_frames)

    raw_tokenizer = get_raw_tokenizer(clip)
    full_prompt, token_ranges = map_token_indices(raw_tokenizer, global_prompt, locals_list)

    log.info("[PromptRelay] Global: tokens [0:%d] (%d tokens)", token_ranges[0][0], token_ranges[0][0])
    for i, (s, e) in enumerate(token_ranges):
        log.info("[PromptRelay] Segment %d: tokens [%d:%d] (%d tokens)", i, s, e, e - s)

    conditioning = clip.encode_from_tokens_scheduled(clip.tokenize(full_prompt))

    effective_lengths = distribute_segment_lengths(len(locals_list), latent_frames, parsed_lengths)

    log.info(
        "[PromptRelay] Latent: %d frames, %d tokens/frame, segments: %s",
        latent_frames, tokens_per_frame, effective_lengths,
    )

    q_token_idx = build_segments(token_ranges, effective_lengths, epsilon, None)
    mask_fn = create_mask_fn(q_token_idx, tokens_per_frame, latent_frames)

    patched = model.clone()
    apply_patches(patched, arch, mask_fn)

    return patched, conditioning


def _window_timeline(tdata: dict, win_start: int, win_end: int, isolate: bool = False):
    """Slice a timeline dict to the pixel-space window [win_start, win_end).

    Mirrors the JS contiguous-prompt/length packer (gaps absorbed into the
    adjacent segment, last segment padded to reach the cutoff) but applied to
    the window instead of the full duration. All emitted segment starts are
    shifted into window-local coordinates (window start -> 0).

    When `isolate=True`, any segment whose start is *before* win_start is dropped
    even if it overlaps into the window — so a clip that bleeds in from before
    the window can't sneak its guide image into the render. Use this when you
    want a clip to render as if it's the only thing on the timeline.

    Returns:
        prompts:        list[str] for the windowed segments, in order.
        lengths:        list[int] matching prompts, summing to win_end-win_start.
        img_strengths:  list[float] for non-"text" segments in the window
                        (mirrors the JS guide_strength serialisation).
        segments:       list[dict] of windowed segments (start shifted, length
                        clipped). Used to rebuild timeline_data for downstream
                        guide-image extraction.
        audio_segments: list[dict] of windowed audio segments (start shifted,
                        trimStart pushed forward by any front-clip, length
                        clipped on both ends).
    """
    segments = sorted(tdata.get("segments", []), key=lambda s: int(s.get("start", 0)))

    prompts: list = []
    lengths: list = []
    img_strengths: list = []
    out_segments: list = []

    pending_gap = 0
    cursor = win_start  # in original frame space; gaps measured against this

    for seg in segments:
        # Use round() not int() — drag-and-drop in the JS timeline can leave starts
        # as floats like 191.6 that int() would truncate to 191, which then sneaks
        # past the `seg_start >= win_end` check and bleeds one frame into the window.
        seg_start = int(round(float(seg.get("start", 0))))
        seg_len = int(round(float(seg.get("length", 0))))
        seg_end = seg_start + seg_len

        if seg_end <= win_start:
            continue
        if seg_start >= win_end:
            break
        # Isolation: drop clips that overlap into the window from before — they're
        # not "the clip this window is for".
        if isolate and seg_start < win_start:
            continue

        clipped_start = max(seg_start, win_start)
        clipped_end = min(seg_end, win_end)
        clipped_length = clipped_end - clipped_start

        if clipped_start > cursor:
            gap = clipped_start - cursor
            if lengths:
                lengths[-1] += gap
            else:
                pending_gap += gap

        lengths.append(clipped_length + pending_gap)
        prompts.append(seg.get("prompt", ""))
        pending_gap = 0
        cursor = max(cursor, seg_end)

        if seg.get("type", "image") != "text":
            img_strengths.append(float(seg.get("guideStrength", 1.0)))

        shifted = dict(seg)
        shifted["start"] = clipped_start - win_start
        shifted["length"] = clipped_length
        out_segments.append(shifted)

    clamped_cursor = min(cursor, win_end)
    if lengths and clamped_cursor < win_end:
        lengths[-1] += win_end - clamped_cursor

    # Audio segments — keep anything that intersects the window, push front-clip
    # into trimStart so we still play the correct portion of the source clip.
    # We deliberately do NOT back-clip at win_end: _build_combined_audio caps the
    # output at `total_samples` (derived from ltxv_length, which is duration_frames + 1).
    # Back-clipping here would shorten the audio by one LTXV padding frame and produce
    # ~0.04s of trailing silence that the unwindowed single-clip path doesn't have.
    out_audio: list = []
    for aseg in tdata.get("audioSegments", []):
        a_start = float(aseg.get("start", 0))
        a_len = float(aseg.get("length", 0))
        a_end = a_start + a_len
        if a_end <= win_start or a_start >= win_end:
            continue
        clip_front = max(0.0, win_start - a_start)
        new_len = a_len - clip_front
        if new_len <= 0:
            continue
        shifted = dict(aseg)
        shifted["trimStart"] = float(aseg.get("trimStart", 0)) + clip_front
        shifted["length"] = new_len
        shifted["start"] = max(0.0, a_start - win_start)
        out_audio.append(shifted)

    return prompts, lengths, img_strengths, out_segments, out_audio


class LTXDirector(io.ComfyNode):
    """WYSIWYG timeline variant — segments and lengths come from a visual editor in the node UI."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LTXDirector",
            display_name="LTX Director",
            category="WhatDreamsCost",
            description=(
                "Same as Prompt Relay Encode, but local prompts and segment lengths are edited "
                "visually as draggable blocks on a timeline. The duration_frames input only sets the "
                "timeline scale (pixel space) — actual frame count is still read from the latent."
            ),
            inputs=[
                io.Model.Input("model"),
                io.Clip.Input("clip"),
                io.Vae.Input("audio_vae", optional=True, tooltip="Optional. Connect an Audio VAE to generate audio latents."),
                io.Latent.Input("optional_latent", optional=True, tooltip="Optional. Connect a latent to override the auto-generated one."),
                io.String.Input(
                    "global_prompt", multiline=True, default="",
                    tooltip="Conditions the entire video. Anchors persistent characters, objects, and scene context.",
                ),
                io.Int.Input(
                    "duration_frames", default=120, min=1, max=10000, step=1,
                    tooltip="Total timeline length in pixel-space frames. Used by the editor for visual scale only.",
                ),
                io.Float.Input(
                    "duration_seconds", default=5, min=0.1, max=1000.0, step=0.01,
                    tooltip="Total timeline duration in seconds (computed/synced from frames).",
                ),
                io.String.Input(
                    "timeline_data", default="",
                    tooltip="JSON state of the timeline editor (auto-managed; do not edit by hand).",
                ),
                io.Boolean.Input(
                    "use_custom_audio", default=False, optional=True,
                    tooltip="Toggle between using timeline audio (ON) and generating audio from scratch (OFF).",
                ),
                io.String.Input(
                    "local_prompts", multiline=True, default="",
                    tooltip="Auto-populated from the timeline editor.",
                ),
                io.String.Input(
                    "segment_lengths", default="",
                    tooltip="Auto-populated from the timeline editor (pixel-space frame counts).",
                ),
                io.Float.Input(
                    "epsilon", default=0.001, min=0.0001, max=0.99, step=0.0001,
                    tooltip="Penalty decay parameter. Values below ~0.1 all produce sharp boundaries (paper default 0.001). For softer transitions, try 0.5 or higher.",
                ),
                io.Float.Input(
                    "frame_rate", default=24, min=1, max=240, step=1, optional=True,
                    tooltip="Frames per second — only affects how time is displayed in the timeline editor when time_units is set to 'seconds'.",
                ),
                io.Combo.Input(
                    "display_mode", options=["frames", "seconds"], default="seconds", optional=True,
                    tooltip="Display the ruler, segment ranges, length input, and total in frames or seconds. Internal storage is always pixel-space frames.",
                ),
                io.String.Input(
                    "guide_strength", default="",
                    tooltip="Auto-populated from the timeline editor (comma-separated guide strengths for image segments).",
                ),
                io.Int.Input(
                    "custom_width", default=0, min=0, max=8192, step=1, optional=True,
                    tooltip="Target output width for all image segments. Set to 0 to use the original image width.",
                ),
                io.Int.Input(
                    "custom_height", default=0, min=0, max=8192, step=1, optional=True,
                    tooltip="Target output height for all image segments. Set to 0 to use the original image height.",
                ),
                io.Combo.Input(
                    "resize_method",
                    options=["maintain aspect ratio", "stretch to fit", "pad", "crop"],
                    default="maintain aspect ratio",
                    optional=True,
                    tooltip="How to resize image segments to fit the target dimensions.",
                ),
                io.Int.Input(
                    "divisible_by", default=32, min=1, max=256, step=1, optional=True,
                    tooltip="Snap the final output image dimensions to be divisible by this number (e.g. 32 for LTX).",
                ),
                io.Int.Input(
                    "img_compression", default=18, min=0, max=100, step=1, optional=True,
                    tooltip="H.264 CRF compression to apply to each guide image. 0 = no compression, higher = more artefacts.",
                ),
                io.Int.Input(
                    "window_start_frames", default=0, min=0, max=10000, step=1, optional=True,
                    tooltip="Render only the timeline slice starting at this pixel-space frame. 0 = from the beginning. "
                            "Use this (or right-click a clip → Window) to render a sub-section and avoid running out of VRAM on long timelines.",
                ),
                io.Int.Input(
                    "window_end_frames", default=0, min=0, max=10000, step=1, optional=True,
                    tooltip="Render only the timeline slice ending at this pixel-space frame (exclusive). 0 = to the end (no windowing). "
                            "Shrinks the auto-generated latent so only the windowed frames are sampled.",
                ),
                io.Boolean.Input(
                    "isolate_clips", default=False, optional=True,
                    tooltip="When ON, the window only includes clips whose start is inside it — clips that bleed in from before "
                            "the window are dropped. Use this to render a single clip as if it were the only thing on the timeline "
                            "(prevents an adjacent clip's guide image from leaking into the render).",
                ),
                io.Boolean.Input(
                    "anchor_clip_end", default=False, optional=True,
                    tooltip="When ON, the first guide image is also inserted at the last frame of the latent. "
                            "Stops LTXV from drifting into a distorted version of the start image at the end of the clip — "
                            "the model has to interpolate between the image and itself, producing coherent motion. "
                            "Most useful in combination with isolate_clips.",
                ),
            ],
            outputs=[
                io.Model.Output(display_name="model"),
                io.Conditioning.Output(display_name="positive"),
                io.Latent.Output(display_name="video_latent", tooltip="Auto-generated LTXV empty latent (only populated when no latent is connected)."),
                io.Latent.Output(display_name="audio_latent", tooltip="Auto-generated audio latent (uses custom audio if enabled)."),
                GuideData.Output(display_name="guide_data"),
                io.Float.Output(display_name="frame_rate", tooltip="The frame rate used for the timeline."),
                io.Audio.Output(display_name="combined_audio", tooltip="Combined timeline audio layout."),
            ],
        )

    @classmethod
    def execute(cls, model, clip, global_prompt, duration_frames, duration_seconds,
                timeline_data, local_prompts, segment_lengths, guide_strength="", epsilon=1e-3,
                frame_rate=24, display_mode="seconds",
                custom_width=768, custom_height=512, resize_method="maintain aspect ratio",
                divisible_by=32, img_compression=0, audio_vae=None, optional_latent=None,
                use_custom_audio=False, window_start_frames=0, window_end_frames=0,
                isolate_clips=False, anchor_clip_end=False) -> io.NodeOutput:

        # --- Optional timeline windowing ---
        # Render only the slice [window_start_frames, window_end_frames) of the timeline.
        # This is the key to rendering long timelines without running out of VRAM: when no
        # latent is connected, duration_frames drives the auto-generated latent's temporal
        # size, so shrinking it here means only the windowed frames are ever sampled.
        # local_prompts, segment_lengths, guide_strength and timeline_data are all re-derived
        # from the windowed view, so the rest of execute() is unchanged afterwards.
        win_start = max(0, int(window_start_frames))
        win_end_raw = int(window_end_frames)
        win_end = win_end_raw if win_end_raw > 0 else duration_frames
        win_end = min(win_end, duration_frames)
        if win_end <= win_start:
            win_end = win_start + 1
        # `isolate_clips` forces windowing to run even with no explicit window, so a
        # single clip at the start of the timeline can still be rendered alone.
        windowing_active = (
            (win_start > 0)
            or (win_end_raw > 0 and win_end_raw < duration_frames)
            or bool(isolate_clips)
        )

        if windowing_active:
            if optional_latent is not None:
                # An external latent fixes the sampled frame count, so windowing the prompts
                # alone won't reduce VRAM. Warn rather than silently slice someone else's latent.
                log.warning(
                    "[PromptRelay] window active but optional_latent is connected — the latent's "
                    "frame count is fixed upstream, so windowing will NOT reduce memory. "
                    "Disconnect optional_latent to let the Director size the latent to the window."
                )

            try:
                tdata_full = json.loads(timeline_data) if timeline_data else None
            except Exception as e:
                log.warning("[PromptRelay] window: timeline_data not parseable, skipping window: %s", e)
                tdata_full = None

            if tdata_full is not None:
                (win_prompts, win_lengths, win_img_strengths,
                 win_segments, win_audio_segs) = _window_timeline(
                    tdata_full, win_start, win_end, isolate=bool(isolate_clips)
                )

                if not win_prompts:
                    raise ValueError(
                        f"LTXDirector window [{win_start}, {win_end}) contains no prompt segments. "
                        "Adjust window_start_frames / window_end_frames."
                    )

                local_prompts = " | ".join(win_prompts)
                segment_lengths = ",".join(str(int(l)) for l in win_lengths)
                guide_strength = ",".join(f"{s:.2f}" for s in win_img_strengths)

                # Re-serialize timeline_data with shifted segments/audio for downstream consumers.
                tdata_full["segments"] = win_segments
                tdata_full["audioSegments"] = win_audio_segs
                timeline_data = json.dumps(tdata_full)
                duration_frames = win_end - win_start
                log.info(
                    "[PromptRelay] window active%s: [%d, %d) -> %d frames, %d prompt segs, %d image segs, %d audio segs",
                    " (isolated)" if isolate_clips else "",
                    win_start, win_end, duration_frames, len(win_prompts),
                    sum(1 for s in win_segments if s.get("imageFile") or s.get("imageB64")),
                    len(win_audio_segs),
                )
                for i, a in enumerate(win_audio_segs):
                    log.info(
                        "[PromptRelay] window audio[%d]: start=%.2f length=%.2f trimStart=%.2f",
                        i, float(a.get("start", 0)), float(a.get("length", 0)), float(a.get("trimStart", 0)),
                    )

        # --- Build guide_data from image segments FIRST (to derive output dimensions) ---
        guide_data = {"images": [], "insert_frames": [], "strengths": [], "frame_rate": frame_rate}
        derived_w, derived_h = custom_width, custom_height
        try:
            tdata = json.loads(timeline_data) if timeline_data else {}
            img_segs = [
                s for s in tdata.get("segments", [])
                if s.get("type", "image") == "image"
                and (s.get("imageFile") or s.get("imageB64"))
                and int(s.get("start", 0)) < duration_frames  # exclude segments fully outside duration
            ]
            img_segs.sort(key=lambda s: s["start"])

            strengths = []
            if guide_strength.strip():
                strengths = [float(x.strip()) for x in guide_strength.split(",") if x.strip()]

            for idx, seg in enumerate(img_segs):
                tensor = _load_image_tensor(seg)

                # Apply resize
                src_h, src_w = tensor.shape[1], tensor.shape[2]

                def snap(val, div):
                    return max(div, (val // div) * div)

                if custom_width > 0 and custom_height > 0:
                    # Both dimensions set — apply selected resize_method (pad, crop, stretch, maintain AR)
                    tensor = _resize_image(tensor, custom_width, custom_height, resize_method, divisible_by)
                elif custom_width > 0:
                    # Width only — scale height from AR, snap both, then resize to exact dimensions
                    tgt_w = snap(custom_width, divisible_by)
                    tgt_h = snap(int(src_h * tgt_w / src_w), divisible_by)
                    tensor = _resize_image(tensor, tgt_w, tgt_h, "stretch to fit", divisible_by)
                elif custom_height > 0:
                    # Height only — scale width from AR, snap both, then resize to exact dimensions
                    tgt_h = snap(custom_height, divisible_by)
                    tgt_w = snap(int(src_w * tgt_h / src_h), divisible_by)
                    tensor = _resize_image(tensor, tgt_w, tgt_h, "stretch to fit", divisible_by)
                else:
                    # Both zero — keep original dimensions, just snap to divisible_by
                    tensor = _resize_image(tensor, src_w, src_h, "maintain aspect ratio", divisible_by)


                # Apply compression
                if img_compression > 0:
                    tensor = _compress_image(tensor, img_compression)

                # Record dimensions of the first processed image for latent generation
                if idx == 0:
                    derived_h = tensor.shape[1]
                    derived_w = tensor.shape[2]

                strength = strengths[idx] if idx < len(strengths) else 1.0
                guide_data["images"].append(tensor)
                guide_data["insert_frames"].append(int(seg["start"]))
                guide_data["strengths"].append(float(strength))
            
            # If no images were loaded from the timeline, create a dummy image at strength 0
            # to prevent artifacts in text-to-video mode.
            if not guide_data["images"]:
                w = derived_w if derived_w > 0 else 768
                h = derived_h if derived_h > 0 else 512
                w = (w // 32) * 32
                h = (h // 32) * 32
                
                dummy_image = torch.zeros((1, h, w, 3), dtype=torch.float32)
                guide_data["images"].append(dummy_image)
                guide_data["insert_frames"].append(0)
                guide_data["strengths"].append(0.0)
                
                derived_w = w
                derived_h = h
        except Exception as e:
            log.warning("[PromptRelay] Could not build guide_data: %s", e)

        # --- Auto-generate LTXV latent if none was provided ---
        ltxv_length = duration_frames + 1
        if optional_latent is None:
            latent_w = max(32, (derived_w // 32) * 32)
            latent_h = max(32, (derived_h // 32) * 32)
            # LTXV temporal: ((length - 1) // 8) + 1 latent frames; invert to get pixel frames -> length.
            # LTXDirectorGuide writes guides in-place via replace_latent_frames, so the latent doesn't
            # grow and we don't need to compensate for an appended-keyframe suffix here.
            latent_t = ((ltxv_length - 1) // 8) + 1
            samples = torch.zeros(
                [1, 128, latent_t, latent_h // 32, latent_w // 32],
                device=comfy.model_management.intermediate_device(),
            )
            latent = {"samples": samples}
            log.info(
                "[PromptRelay] Auto-generated LTXV latent: %dx%d, %d pixel frames (%d latent frames)",
                latent_w, latent_h, ltxv_length, latent_t,
            )
        else:
            latent = optional_latent

        # --- Clamp guide insert frames into the latent's safe range ---
        # LTXVAddGuide computes latent_idx = (frame_idx + 7) // 8 and asserts
        # latent_idx + t.shape[2] <= latent_length. For single-image guides
        # t.shape[2] == 1, so the largest safe frame_idx is 8 * (latent_length - 1).
        # When duration_frames is not a multiple of 8 (very common with windowing
        # or arbitrary clip boundaries), images placed in the last sub-stride
        # of pixel frames would otherwise overflow the latent.
        try:
            latent_length = int(latent["samples"].shape[2])
            max_safe_frame = max(0, 8 * (latent_length - 1))
            for i, f in enumerate(guide_data["insert_frames"]):
                if f > max_safe_frame:
                    log.info(
                        "[PromptRelay] Clamping guide image %d insert frame %d -> %d (latent_length=%d)",
                        i + 1, f, max_safe_frame, latent_length,
                    )
                    guide_data["insert_frames"][i] = max_safe_frame
        except Exception as e:
            log.warning("[PromptRelay] Could not clamp guide insert_frames: %s", e)

        # --- Anchor the clip's end with the start image ---
        # LTXV with only a frame-0 guide drifts freely toward the end of the latent,
        # often producing a distorted echo of the start image. Duplicating the first
        # guide at the last safe frame anchors both ends so the model has to interpolate
        # between the image and itself instead of inventing content.
        if anchor_clip_end and guide_data["images"]:
            try:
                end_frame = int(max_safe_frame)
                # Don't double-up if something already anchors the end (within one stride).
                already_anchored = any(
                    abs(int(f) - end_frame) < 8 for f in guide_data["insert_frames"]
                )
                if not already_anchored:
                    guide_data["images"].append(guide_data["images"][0])
                    guide_data["insert_frames"].append(end_frame)
                    guide_data["strengths"].append(float(guide_data["strengths"][0]))
                    log.info(
                        "[PromptRelay] anchor_clip_end: duplicated guide image 1 at frame %d "
                        "(latent_length=%d, strength=%.2f)",
                        end_frame, latent_length, guide_data["strengths"][-1],
                    )
                else:
                    log.info(
                        "[PromptRelay] anchor_clip_end: end frame %d already has a guide nearby, skipping.",
                        end_frame,
                    )
            except Exception as e:
                log.warning("[PromptRelay] Could not anchor clip end: %s", e)

        patched, conditioning = _encode_relay(
            model, clip, latent, global_prompt, local_prompts, segment_lengths, epsilon,
        )

        # --- Build Audio Output ---
        # Size the combined waveform by `duration_frames`, NOT `ltxv_length` (which is +1 due to
        # the LTXV pixel-frame grid). Otherwise each isolated/windowed render pulls one extra
        # source frame of audio past the clip's nominal end, and when the user concatenates
        # back-to-back clips that 1-frame overflow shows up as an overlap at adjacent boundaries
        # and as a skip when there's any small placement gap.
        audio_out = _build_combined_audio(timeline_data, duration_frames, float(frame_rate))

        # --- Audio Latent Generation ---
        audio_latent = {}
        
        if audio_vae is not None:
            # Helper to generate empty latent
            def get_empty_latent():
                # Support both raw AudioVAE objects and ComfyUI VAE wrappers.
                inner = getattr(audio_vae, "first_stage_model", audio_vae)
                z_channels = audio_vae.latent_channels
                audio_freq = inner.latent_frequency_bins
                num_audio_latents = inner.num_of_latents_from_frames(ltxv_length, float(frame_rate))
                audio_latents = torch.zeros(
                    (1, z_channels, num_audio_latents, audio_freq),
                    device=comfy.model_management.intermediate_device(),
                )
                return {"samples": audio_latents, "type": "audio"}

            if use_custom_audio:
                try:
                    if audio_out is not None:
                        # 1. Encode audio waveform into latent space
                        waveform = audio_out["waveform"]
                        if waveform.ndim == 2:
                            waveform = waveform.unsqueeze(0)
                        if waveform.ndim != 3:
                            raise ValueError(
                                f"Expected custom audio waveform with 2 or 3 dims, got shape {tuple(waveform.shape)}"
                            )

                        # Wrapped ComfyUI VAE expects (batch, samples, channels);
                        # raw AudioVAE expects a dict with waveform in (batch, channels, samples).
                        if hasattr(audio_vae, "first_stage_model"):
                            latent_samples = audio_vae.encode(waveform.movedim(1, -1))
                        else:
                            latent_samples = audio_vae.encode({
                                "waveform": waveform,
                                "sample_rate": audio_out["sample_rate"],
                            })

                        # Diagnostic: encoded latent shape vs the "ideal" empty-latent shape for
                        # ltxv_length frames. If the encoded latent has fewer T positions than the
                        # empty one would, the downstream sampler/decoder will produce shorter audio.
                        try:
                            inner = getattr(audio_vae, "first_stage_model", audio_vae)
                            ideal_T = inner.num_of_latents_from_frames(ltxv_length, float(frame_rate))
                            log.info(
                                "[PromptRelay] custom audio: waveform=%s, encoded latent=%s, "
                                "ideal latent T for %d frames = %d",
                                tuple(waveform.shape), tuple(latent_samples.shape),
                                ltxv_length, ideal_T,
                            )
                        except Exception as _:
                            log.info(
                                "[PromptRelay] custom audio: waveform=%s, encoded latent=%s",
                                tuple(waveform.shape), tuple(latent_samples.shape),
                            )
                        
                        if latent_samples.numel() == 0:
                            raise ValueError("Encoded audio latent is empty (0 elements).")
                        
                        # 2. Create solid mask with value 0.0 (0 means keep/use conditioning, 1 means generate noise)
                        mask = torch.full(
                            (1, latent_samples.shape[-2], latent_samples.shape[-1]), 
                            0.0, 
                            dtype=torch.float32, 
                            device=comfy.model_management.intermediate_device()
                        )
                        
                        # 3. Set Latent Noise Mask
                        audio_latent = {
                            "samples": latent_samples,
                            "type": "audio",
                            "noise_mask": mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1]))
                        }
                        log.info("[PromptRelay] Generated custom audio latent with noise mask (value=0.0).")
                    else:
                        raise ValueError("No audio waveform to encode.")
                except Exception as e:
                    log.error("[PromptRelay] Failed to generate custom audio latent: %s", e)
                    raise e
            else:
                # Generate empty latent
                try:
                    audio_latent = get_empty_latent()
                    log.info("[PromptRelay] Auto-generated empty audio latent.")
                except Exception as e:
                    log.error("[PromptRelay] Could not generate empty audio latent: %s", e)
                    raise e

        return io.NodeOutput(patched, conditioning, latent, audio_latent, guide_data, float(frame_rate), audio_out)


NODE_CLASS_MAPPINGS = {
    "LTXDirector": LTXDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptRelayEncodeTimeline": "Prompt Relay Encode (Timeline)",
}