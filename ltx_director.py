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
        image_file = os.path.normpath(str(seg["imageFile"]))
        normalized_image_file = image_file.replace("\\", os.sep)
        for prefix in ("output" + os.sep, "input" + os.sep, "temp" + os.sep):
            if normalized_image_file.lower().startswith(prefix):
                normalized_image_file = normalized_image_file[len(prefix):]
                break
        subfolder = os.path.normpath(str(seg.get("subfolder", "") or ""))
        image_type = str(seg.get("imageType", seg.get("fileType", "input")) or "input").lower()
        base_dirs = []
        if image_type == "output":
            base_dirs.append(folder_paths.get_output_directory())
        elif image_type == "temp" and hasattr(folder_paths, "get_temp_directory"):
            base_dirs.append(folder_paths.get_temp_directory())
        else:
            base_dirs.append(folder_paths.get_input_directory())
        base_dirs.extend([folder_paths.get_input_directory(), folder_paths.get_output_directory()])
        if hasattr(folder_paths, "get_temp_directory"):
            base_dirs.append(folder_paths.get_temp_directory())

        candidates = []
        for base_dir in dict.fromkeys(base_dirs):
            if subfolder and subfolder != ".":
                candidates.append(os.path.join(base_dir, subfolder, os.path.basename(normalized_image_file)))
            candidates.append(os.path.join(base_dir, normalized_image_file))
            candidates.append(os.path.join(base_dir, image_file))

        for file_path in candidates:
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


def _frame(seg: dict) -> int:
    return max(0, int(round(float(seg.get("start", seg.get("frame", 0)) or 0))))


def _end_frame(seg: dict) -> int:
    return _frame(seg) + max(0, int(round(float(seg.get("length", 0) or 0))))


def _add_boundary(boundaries: dict, frame: int, reason: str, duration_frames: int):
    frame = max(0, min(duration_frames, int(round(frame))))
    if 0 < frame < duration_frames:
        boundaries.setdefault(frame, set()).add(reason)


def _plan_long_auto_segments(
    tdata: dict,
    duration_frames: int,
    frame_rate: float,
    max_seconds: float = 15.0,
    manual_tolerance_seconds: float = 0.25,
    auto_cut: bool = True,
):
    max_frames = max(1, int(math.floor(max_seconds * frame_rate)))
    manual_tolerance_frames = max(0, int(round(manual_tolerance_seconds * frame_rate)))
    manual_frames = [
        max(0, min(duration_frames, _frame(seg)))
        for seg in tdata.get("cutSegments", [])
    ]

    def near_manual(frame: int) -> bool:
        return any(abs(frame - cut_frame) <= manual_tolerance_frames for cut_frame in manual_frames)

    hard = {}
    for frame in manual_frames:
        _add_boundary(hard, frame, "manual_cut", duration_frames)
    if auto_cut:
        for key, prefix in (("cameraSegments", "camera"), ("controlSegments", "ic")):
            for seg in tdata.get(key, []):
                for frame, suffix in ((_frame(seg), "start"), (_end_frame(seg), "end")):
                    if not near_manual(frame):
                        _add_boundary(hard, frame, f"{prefix}_{suffix}", duration_frames)

    hard_points = [0, *sorted(hard), duration_frames]
    cuts = [(0, {"timeline_start"})]
    for left, right in zip(hard_points, hard_points[1:]):
        cursor = left
        while right - cursor > max_frames:
            limit = cursor + max_frames
            if near_manual(right) and right - limit <= manual_tolerance_frames:
                break
            cursor = limit
            cuts.append((cursor, {"max_length"}))
        if right != duration_frames:
            cuts.append((right, hard.get(right, {"hard_boundary"})))
    cuts.append((duration_frames, {"timeline_end"}))

    merged = {}
    for frame, reasons in cuts:
        merged.setdefault(frame, set()).update(reasons)
    ordered = sorted(merged)
    out = []
    for idx, (start, end) in enumerate(zip(ordered, ordered[1:])):
        if end <= start:
            continue
        out.append({
            "index": len(out),
            "start": start,
            "end": end,
            "length": end - start,
            "reasons": sorted(merged.get(start, set())) if start else ["timeline_start"],
        })
    return out


def _clip_timeline_segment(seg: dict, start: int, end: int):
    seg_start = _frame(seg)
    seg_end = _end_frame(seg)
    if seg_end <= start or seg_start >= end:
        return None
    clipped_start = max(seg_start, start)
    clipped_end = min(seg_end, end)
    new_seg = dict(seg)
    new_seg["start"] = clipped_start - start
    new_seg["length"] = max(1, clipped_end - clipped_start)
    if "frame" in new_seg:
        new_seg["frame"] = new_seg["start"]
    if new_seg.get("type") == "audio":
        new_seg["trimStart"] = max(0, int(round(float(new_seg.get("trimStart", 0) or 0))) + clipped_start - seg_start)
    return new_seg


def _clip_keyframe_segment(seg: dict, start: int, end: int, tolerance_frames: int = 0):
    seg_start = _frame(seg)
    if seg_start < start or seg_start >= end:
        return None
    new_seg = dict(seg)
    local_start = seg_start - start
    if local_start <= tolerance_frames:
        local_start = 0
    new_seg["start"] = local_start
    new_seg["frame"] = local_start
    new_seg["length"] = 1
    return new_seg


def _keyframe_starts_segment(tdata: dict, frame: int, tolerance_frames: int):
    matches = [
        seg
        for seg in tdata.get("segments", [])
        if frame <= _frame(seg) <= frame + tolerance_frames
    ]
    if not matches:
        return None
    return min(matches, key=lambda seg: _frame(seg) - frame)


def _camera_prompt(seg: dict) -> str:
    return (seg.get("prompt") or "").strip()


def _control_prompt(seg: dict) -> str:
    kind = seg.get("controlType", "control")
    strength = float(seg.get("strength", 0.75) or 0.75)
    prompt = (seg.get("prompt") or "").strip()
    return f"IC-LoRA {kind} strength {strength:.2f}{': ' + prompt if prompt else ''}"


def _compose_local_prompt_payload(tdata: dict, duration_frames: int):
    cuts = {0, duration_frames}
    for key in ("promptSegments", "cameraSegments", "controlSegments"):
        for seg in tdata.get(key, []):
            start = max(0, min(duration_frames, _frame(seg)))
            end = max(0, min(duration_frames, _end_frame(seg)))
            if end > start:
                cuts.add(start)
                cuts.add(end)

    reference_hints = []
    for ref in tdata.get("referenceImages", []):
        note = (ref.get("note") or "").strip()
        if note:
            reference_hints.append(f"Reference {ref.get('refName', '@Ref')}: {note}")

    prompts = []
    lengths = []
    ordered = sorted(cuts)
    for start, end in zip(ordered, ordered[1:]):
        parts = []
        parts.extend(
            (seg.get("prompt") or "").strip()
            for seg in tdata.get("promptSegments", [])
            if _frame(seg) < end and _end_frame(seg) > start and (seg.get("prompt") or "").strip()
        )
        parts.extend(
            f"Camera: {_camera_prompt(seg)}"
            for seg in tdata.get("cameraSegments", [])
            if _frame(seg) < end and _end_frame(seg) > start and _camera_prompt(seg)
        )
        parts.extend(
            _control_prompt(seg)
            for seg in tdata.get("controlSegments", [])
            if _frame(seg) < end and _end_frame(seg) > start
        )
        parts.extend(reference_hints)
        prompts.append(". ".join([p for p in parts if p]) or "maintain the global scene and current visual continuity")
        lengths.append(str(end - start))
    return " | ".join(prompts), ",".join(lengths)


def _apply_long_auto_direct_segment(tdata: dict, duration_frames: int, frame_rate: float):
    meta = tdata.get("meta") or {}
    if not meta.get("longAuto") or meta.get("materializedSegment"):
        return tdata, duration_frames, None, None, None

    max_seconds = float(meta.get("maxSegmentSeconds", 15.0) or 15.0)
    manual_tolerance_seconds = float(meta.get("manualCutToleranceSeconds", 0.25) or 0.25)
    keyframe_tolerance_seconds = float(meta.get("keyframeToleranceSeconds", 0.25) or 0.25)
    auto_cut = bool(meta.get("autoCut", True))
    segment_index = int(meta.get("activeSegmentIndex", 0) or 0)
    plan = _plan_long_auto_segments(tdata, duration_frames, frame_rate, max_seconds, manual_tolerance_seconds, auto_cut)
    if not plan:
        return tdata, duration_frames, None, None, None

    segment_index = max(0, min(segment_index, len(plan) - 1))
    selected = plan[segment_index]
    start, end = selected["start"], selected["end"]

    cropped = {
        "segments": [],
        "promptSegments": [],
        "referenceImages": list(tdata.get("referenceImages", [])),
        "cameraSegments": [],
        "controlSegments": [],
        "audioSegments": [],
        "cutSegments": [],
        "meta": {
            **meta,
            "materializedSegment": True,
            "sourceStartFrame": start,
            "sourceEndFrame": end,
            "sourceSegmentIndex": segment_index,
            "sourceCutReasons": selected["reasons"],
        },
    }

    for seg in tdata.get("segments", []):
        clipped = _clip_keyframe_segment(seg, start, end, max(0, int(round(keyframe_tolerance_seconds * frame_rate))))
        if clipped:
            cropped["segments"].append(clipped)

    for key in ("promptSegments", "cameraSegments", "controlSegments", "audioSegments"):
        for seg in tdata.get(key, []):
            clipped = _clip_timeline_segment(seg, start, end)
            if clipped:
                cropped[key].append(clipped)

    previous_tail = meta.get("previousTailFrame")
    keyframe_tolerance_frames = max(0, int(round(keyframe_tolerance_seconds * frame_rate)))
    if segment_index > 0 and previous_tail and not _keyframe_starts_segment(tdata, start, keyframe_tolerance_frames):
        if isinstance(previous_tail, str):
            tail_seg = {"imageFile": previous_tail, "imageType": "output"}
        elif isinstance(previous_tail, dict):
            tail_seg = dict(previous_tail)
        else:
            tail_seg = {}
        if tail_seg.get("imageFile") or tail_seg.get("imageB64"):
            tail_seg.update({
                "id": f"long-auto-tail-{segment_index:03d}",
                "type": "image",
                "start": 0,
                "frame": 0,
                "length": 1,
                "guideStrength": float(tail_seg.get("guideStrength", 1.0) or 1.0),
                "source": "previous_tail",
            })
            cropped["segments"].insert(0, tail_seg)

    for cut in tdata.get("cutSegments", []):
        frame = _frame(cut)
        if start < frame < end:
            new_cut = dict(cut)
            new_cut["start"] = frame - start
            new_cut["frame"] = frame - start
            cropped["cutSegments"].append(new_cut)

    new_duration = selected["length"]
    local_prompts, segment_lengths = _compose_local_prompt_payload(cropped, new_duration)
    log.warning(
        "[Shezw LongAuto] Direct Queue renders segment %d/%d only: frames %d-%d (%s). "
        "Use tools/long_auto_render.py for full multi-segment orchestration.",
        segment_index + 1,
        len(plan),
        start,
        end,
        ",".join(selected["reasons"]),
    )
    return cropped, new_duration, local_prompts, segment_lengths, selected


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
                    tooltip="Auto-populated from the Local Prompt track. Empty means use only global prompt conditioning.",
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
                use_custom_audio=False) -> io.NodeOutput:

        try:
            tdata_for_long_auto = json.loads(timeline_data) if timeline_data else {}
            cropped_tdata, cropped_duration, cropped_prompts, cropped_lengths, _selected_segment = _apply_long_auto_direct_segment(
                tdata_for_long_auto,
                int(duration_frames),
                float(frame_rate),
            )
            if cropped_tdata is not tdata_for_long_auto:
                timeline_data = json.dumps(cropped_tdata, ensure_ascii=False)
                duration_frames = int(cropped_duration)
                duration_seconds = float(duration_frames) / float(frame_rate)
                if cropped_prompts is not None:
                    local_prompts = cropped_prompts
                if cropped_lengths is not None:
                    segment_lengths = cropped_lengths
                guide_strength = ""
        except Exception as e:
            log.warning("[Shezw LongAuto] Could not apply direct segment crop: %s", e)

        # --- Build guide_data from keyframe segments FIRST (to derive output dimensions) ---
        guide_data = {"images": [], "insert_frames": [], "strengths": [], "frame_rate": frame_rate, "references": [], "controls": []}
        derived_w, derived_h = custom_width, custom_height
        try:
            tdata = json.loads(timeline_data) if timeline_data else {}
            keyframe_segs = [
                s for s in tdata.get("segments", [])
                if s.get("type", "image") == "image"
                and (s.get("imageFile") or s.get("imageB64"))
                and int(s.get("start", 0)) < duration_frames  # exclude segments fully outside duration
            ]
            keyframe_segs.sort(key=lambda s: s["start"])

            reference_segs = [
                s for s in tdata.get("referenceImages", [])
                if s.get("imageFile") or s.get("imageB64")
            ]
            control_segs = [
                s for s in tdata.get("controlSegments", [])
                if int(s.get("start", 0)) < duration_frames
            ]

            strengths = []
            if guide_strength.strip():
                strengths = [float(x.strip()) for x in guide_strength.split(",") if x.strip()]

            for idx, seg in enumerate(reference_segs):
                try:
                    ref_tensor = _load_image_tensor(seg)
                    guide_data["references"].append({
                        "name": seg.get("refName") or f"@Ref{idx + 1}",
                        "image": ref_tensor,
                        "imageFile": seg.get("imageFile", ""),
                        "note": seg.get("note", ""),
                    })
                except Exception as e:
                    log.warning("[PromptRelay] Could not load reference image %d: %s", idx + 1, e)

            for seg in control_segs:
                start = int(seg.get("start", 0))
                length = int(seg.get("length", 0))
                if length <= 0:
                    continue
                guide_data["controls"].append({
                    "type": seg.get("controlType", "camera_depth"),
                    "start": start,
                    "length": min(length, duration_frames - start),
                    "strength": float(seg.get("strength", 0.75)),
                    "prompt": seg.get("prompt", ""),
                })

            for idx, seg in enumerate(keyframe_segs):
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

                strength = strengths[idx] if idx < len(strengths) else float(seg.get("guideStrength", 1.0))
                guide_data["images"].append(tensor)
                guide_data["insert_frames"].append(int(seg["start"]))
                guide_data["strengths"].append(float(strength))

            # Keyframe channel is intentionally allowed to be empty. In that case no
            # guide frames are emitted to LTXDirectorGuide; only output dimensions are
            # derived from explicit custom_width/custom_height or a sane default.
            if not guide_data["images"]:
                w = derived_w if derived_w > 0 else 768
                h = derived_h if derived_h > 0 else 512
                derived_w = max(32, (w // 32) * 32)
                derived_h = max(32, (h // 32) * 32)
        except Exception as e:
            log.warning("[PromptRelay] Could not build guide_data: %s", e)

        # --- Auto-generate LTXV latent if none was provided ---
        ltxv_length = duration_frames + 1
        if optional_latent is None:
            latent_w = max(32, (derived_w // 32) * 32)
            latent_h = max(32, (derived_h // 32) * 32)
            # LTXV temporal: ((length - 1) // 8) + 1 latent frames; invert to get pixel frames -> length
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

        if local_prompts and local_prompts.strip():
            patched, conditioning = _encode_relay(
                model, clip, latent, global_prompt, local_prompts, segment_lengths, epsilon,
            )
        else:
            patched = model
            conditioning = clip.encode_from_tokens_scheduled(clip.tokenize(global_prompt or ""))
            log.info("[PromptRelay] No local prompts supplied; using global prompt conditioning without temporal Prompt Relay patches.")

        # --- Build Audio Output ---
        audio_out = _build_combined_audio(timeline_data, ltxv_length, float(frame_rate))

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
