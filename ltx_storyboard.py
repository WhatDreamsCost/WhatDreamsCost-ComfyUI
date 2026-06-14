"""LTXStoryboard — single-node UI orchestrator for the validated multi-kf inference workflow.

Replicates the chained behavior of:
    PromptRelayEncodeTimeline (kijai/ComfyUI-PromptRelay)
        → LTXVAddGuideMulti (comfyui-kjnodes)

Behind a single timeline-editor UI (the existing `ltx_director.js`, reused as-is).

What this node DOES:
    1. Parses timeline_data JSON from the JS editor
    2. Builds an empty (or extend-mode) LTX video latent + optional empty audio latent
    3. Calls kijai's PromptRelayEncodeTimeline directly (via Comfy's NODE_CLASS_MAPPINGS) to
       get a patched model + relayed positive conditioning
    4. Encodes an empty-text negative via CLIP (NOT ConditioningZeroOut — empty-text is the
       validated path that preserves motion)
    5. Runs LTXVAddGuideMulti's loop body inline (encode → get_latent_index → append_keyframe
       per kf) so the positive/negative get keyframe_idxs and the latent gets the kf token block
    6. Outputs everything ready for: LTXVConcatAVLatent → LTXVConditioning → CFGGuider

What this node EXPLICITLY DOES NOT DO:
    - No chain attention mask (none of the old LTXDirector attn1 patches)
    - No sigma-aware noise_mask schedule
    - No keyframe falloff / RoPE-distance attenuation
    - No internal frame_offset shift in extend mode — timeline positions are in COMBINED
      pixel coordinates (the start of the timeline IS the start of the full video, including
      any prior-locked prefix)
    - No reimplementation of the relay logic; we call kijai's class

The timeline_data JSON schema is identical to LTXDirector's; the JS UI is reused via a
one-line `nodeData.name` match in `js/ltx_director.js`.
"""

from __future__ import annotations

import json
import logging
import os

import numpy as np
import torch
from PIL import Image as _PilImage

import comfy.model_management
import comfy.utils
import folder_paths

from comfy_api.latest import io
from comfy_extras.nodes_lt import LTXVAddGuide, get_noise_mask

# Reuse the existing helpers verbatim — no copy-paste, just import.
from .ltx_director import (
    _load_image_tensor,
    _resize_image,
    _compress_image,
    _build_combined_audio,
)


log = logging.getLogger(__name__)


# Custom socket type — bundle of per-kf image+frame_idx+strength so the optional
# stage-2 LTXStoryboardGuide can re-apply the same kfs after LTXVCropGuides + upsampler.
GuideData = io.Custom("GUIDE_DATA")
# RelayOptions: kijai's globally-registered custom type. We declare it the same way kijai's
# package does so the input port accepts their PromptRelayAdvancedOptions output natively.
RelayOptions = io.Custom("RELAY_OPTIONS")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_prompt_relay_timeline_class():
    """Lookup kijai's PromptRelayEncodeTimeline via Comfy's global node registry.

    Avoids the relative-import problem of cross-package imports between custom_nodes
    folders. ComfyUI loads all custom_nodes during startup and populates
    `nodes.NODE_CLASS_MAPPINGS` — we just look up the class there at execute time.
    """
    try:
        import nodes as comfy_nodes_module
    except ImportError as e:
        raise ImportError(
            "LTXStoryboard requires ComfyUI's node registry, which should be available at "
            "runtime. This shouldn't happen in normal use."
        ) from e

    cls = getattr(comfy_nodes_module, "NODE_CLASS_MAPPINGS", {}).get("PromptRelayEncodeTimeline")
    if cls is None:
        raise ImportError(
            "LTXStoryboard requires kijai's ComfyUI-PromptRelay package "
            "(provides PromptRelayEncodeTimeline). Install it from "
            "https://github.com/kijai/ComfyUI-PromptRelay"
        )
    return cls


def _detect_prior_latent_t(noise_mask: torch.Tensor) -> int:
    """Count contiguous leading mask<=0.05 latent frames in noise_mask. Mirrors
    ltx_director.py:647-655. Used for diagnostic logging only — kfs in the prior
    region become no-ops naturally because the noise_mask there is 0.
    """
    if noise_mask is None:
        return 0
    m = noise_mask.float()
    try:
        if m.ndim == 5:
            t_mean = m[0, 0].reshape(m.shape[2], -1).mean(dim=1)
        elif m.ndim == 4:
            t_mean = m[0, 0].reshape(m.shape[2], -1).mean(dim=1)
        else:
            t_mean = m[0, 0].reshape(m.shape[2])
    except Exception:
        return 0

    prior_t = 0
    for v in t_mean:
        if float(v.item()) <= 0.05:
            prior_t += 1
        else:
            break
    return prior_t


def _build_video_latent(
    extend_from_video_latent,
    duration_frames: int,
    derived_w: int,
    derived_h: int,
    divisible_by: int,
) -> tuple[dict, int]:
    """Build the video latent dict. Returns (latent_dict, prior_latent_t).

    Modes:
      - No extend: create empty zero latent sized to duration_frames + spatial dims.
      - Extend: pass through the upstream latent UNCHANGED. We do NOT modify the noise_mask
        or apply prior_strength scaling — the upstream node (LTXVAudioVideoMask) already set
        up the mask correctly, and the user's working workflow has confirmed this.
    """
    dev = comfy.model_management.intermediate_device()

    if extend_from_video_latent is not None:
        latent = {
            "samples": extend_from_video_latent["samples"].to(device=dev),
        }
        if "noise_mask" in extend_from_video_latent:
            latent["noise_mask"] = extend_from_video_latent["noise_mask"].to(device=dev)
        prior_latent_t = _detect_prior_latent_t(latent.get("noise_mask"))
        log.info(
            "[LTXStoryboard] Extend mode: latent shape=%s, prior_latent_t=%d (frames in noise_mask<=0.05 prefix)",
            tuple(latent["samples"].shape), prior_latent_t,
        )
        return latent, prior_latent_t

    # Fresh latent path
    ltxv_length = duration_frames + 1   # LTX's 8k+1 convention; the +1 is the causal first frame
    new_latent_t = ((ltxv_length - 1) // 8) + 1

    def _snap(v, div):
        return max(div, (v // div) * div)
    latent_w = max(32, _snap(derived_w, divisible_by))
    latent_h = max(32, _snap(derived_h, divisible_by))

    samples = torch.zeros(
        [1, 128, new_latent_t, latent_h // 32, latent_w // 32],
        device=dev,
    )
    log.info(
        "[LTXStoryboard] Fresh latent: %dx%d pixels, %d pixel frames (%d latent frames)",
        latent_w, latent_h, ltxv_length, new_latent_t,
    )
    return {"samples": samples}, 0


def _encode_audio_to_latent(audio_vae, audio_dict: dict | None) -> dict | None:
    """Encode an audio waveform dict to an audio latent dict via the LTX audio VAE.

    Mirrors comfy_extras/nodes_audio.py:VAEEncodeAudio.execute() exactly — same
    resample-then-encode flow that LTXVAudioVAEEncode inherits. Used to turn the
    timeline editor's combined audio waveform into a real (non-empty) audio latent
    that drives the model's audio-conditioning path during sampling.

    Returns None if encoding fails (caller should fall back to the empty-audio path).
    """
    if audio_vae is None or audio_dict is None:
        return None
    try:
        sample_rate = audio_dict["sample_rate"]
        waveform = audio_dict["waveform"]
        vae_sample_rate = getattr(audio_vae, "audio_sample_rate", 44100)
        if vae_sample_rate != sample_rate:
            import torchaudio
            waveform = torchaudio.functional.resample(waveform, sample_rate, vae_sample_rate)
        t = audio_vae.encode(waveform.movedim(1, -1))
        return {"samples": t}
    except Exception as e:
        log.warning("[LTXStoryboard] _encode_audio_to_latent failed (%s).", e)
        return None


def _build_empty_audio_latent(audio_vae, duration_frames: int, frame_rate: float, batch_size: int = 1) -> dict | None:
    """Generate an empty audio latent matching the video duration. Produces a 4D tensor
    `[B, C, num_audio_latents, audio_freq]` matching what LTXVConcatAVLatent + LTXAV's
    process_timestep expect.

    Two paths in order of preference:
      1. Call ComfyUI's `LTXVEmptyLatentAudio.execute()` — its current signature is
         (frames_number, frame_rate, batch_size, audio_vae).
      2. Construct directly from audio_vae attributes — mirrors the body of
         LTXVEmptyLatentAudio.execute() in nodes_lt_audio.py:148-156. Used when the node
         signature drifts (it has changed before — `batch_size` was added) so we don't
         fall over on minor ComfyUI updates.

    Returns None only if audio_vae is missing or BOTH paths fail in unexpected ways
    (caller should treat None as "no audio path"; do NOT emit a sentinel 3D zero tensor
    because LTXAV's process_timestep does 4D indexing on the resulting denoise_mask).
    """
    if audio_vae is None:
        return None

    # Path 1: call the upstream node if available, with the current signature.
    try:
        import nodes as comfy_nodes_module
        cls = getattr(comfy_nodes_module, "NODE_CLASS_MAPPINGS", {}).get("LTXVEmptyLatentAudio")
        if cls is not None:
            try:
                result = cls.execute(
                    frames_number=duration_frames,
                    frame_rate=int(round(frame_rate)),
                    batch_size=batch_size,
                    audio_vae=audio_vae,
                )
                return result[0]
            except TypeError as e:
                # Signature mismatch (older or newer ComfyUI) — fall through to direct
                # construction below.
                log.info(
                    "[LTXStoryboard] LTXVEmptyLatentAudio signature didn't match (%s); "
                    "falling back to direct latent construction.", e,
                )
    except Exception as e:
        log.info("[LTXStoryboard] Could not invoke LTXVEmptyLatentAudio (%s); falling back to direct.", e)

    # Path 2: build the latent ourselves from audio_vae attributes. Mirrors
    # /weka/home-kateriw/ComfyUI/comfy_extras/nodes_lt_audio.py:148-156.
    try:
        z_channels = audio_vae.latent_channels
        first_stage = audio_vae.first_stage_model
        audio_freq = first_stage.latent_frequency_bins
        num_audio_latents = first_stage.num_of_latents_from_frames(
            duration_frames, int(round(frame_rate))
        )
        audio_latents = torch.zeros(
            (batch_size, z_channels, num_audio_latents, audio_freq),
            device=comfy.model_management.intermediate_device(),
        )
        log.info(
            "[LTXStoryboard] Built audio latent directly: shape=%s (batch=%d, channels=%d, "
            "T_lat=%d, freq=%d).",
            tuple(audio_latents.shape), batch_size, z_channels, num_audio_latents, audio_freq,
        )
        return {"samples": audio_latents}
    except AttributeError as e:
        log.warning(
            "[LTXStoryboard] audio_vae doesn't expose expected attributes for direct latent "
            "construction (%s). Returning None — wire extend_from_audio_latent OR use a "
            "compatible audio VAE.", e,
        )
        return None
    except Exception as e:
        log.warning("[LTXStoryboard] Failed to build empty audio latent: %s", e)
        return None


# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------

class LTXStoryboard(io.ComfyNode):
    """Single-node multi-kf orchestrator. Wraps PromptRelayEncodeTimeline + LTXVAddGuideMulti's
    loop body in one node so the timeline editor produces ready-to-sample conditioning + latent
    in a single hop. Wire outputs directly into LTXVConcatAVLatent → LTXVConditioning → CFGGuider.

    Reuses the existing ltx_director.js timeline editor. Functional behavior matches the
    validated demo workflow (ltx-timeline-demo/demo/server/storyboard_builder.py).
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LTXStoryboard",
            display_name="LTX Storyboard",
            category="WhatDreamsCost",
            description=(
                "Single-node multi-kf: kijai's PromptRelayEncodeTimeline + KJNodes' LTXVAddGuideMulti "
                "loop body, behind one timeline editor (image + prompt + audio tracks). Outputs a "
                "relayed model + positive/negative with keyframe_idxs applied + the latent with kf "
                "token blocks grown on the temporal axis. Wire directly into "
                "LTXVConcatAVLatent → LTXVConditioning → CFGGuider → SamplerCustomAdvanced."
            ),
            inputs=[
                io.Model.Input("model"),
                io.Clip.Input("clip"),
                io.Vae.Input("vae", tooltip="Video VAE — used to encode each keyframe image into the latent (LTXVAddGuideMulti loop body)."),
                io.Vae.Input("audio_vae", optional=True, tooltip="Optional. If provided, an empty audio latent matching duration_frames is generated."),
                io.Latent.Input(
                    "extend_from_video_latent", optional=True,
                    tooltip="Optional. Output of LTX Audio Video Mask etc. In extend mode, timeline coordinates are in COMBINED pixel space — the timeline's start IS the start of the prior region, not the start of the new region.",
                ),
                io.Latent.Input(
                    "extend_from_audio_latent", optional=True,
                    tooltip="Optional audio side of extend mode.",
                ),
                RelayOptions.Input(
                    "relay_options", optional=True,
                    tooltip="Optional PromptRelayAdvancedOptions output. Passes through to kijai's PromptRelayEncodeTimeline.",
                ),
                io.String.Input(
                    "global_prompt", multiline=True, default="",
                    tooltip="Goes into the relay's global_prompt slot. Anchors persistent characters, objects, and scene context.",
                ),
                io.Int.Input(
                    "duration_frames", default=121, min=1, max=10000, step=1,
                    tooltip="Total timeline length in pixel-space frames (combined, in extend mode).",
                ),
                io.Float.Input(
                    "duration_seconds", default=5.04, min=0.1, max=1000.0, step=0.01,
                    tooltip="UI display only — synced to duration_frames by the JS.",
                ),
                io.String.Input(
                    "timeline_data", default="",
                    tooltip="JSON state of the timeline editor (auto-managed by JS; do not edit by hand).",
                ),
                io.Boolean.Input(
                    "use_custom_audio", default=False, optional=True,
                    tooltip="If True and audio segments are present in timeline_data, build a combined audio waveform via _build_combined_audio.",
                ),
                io.String.Input(
                    "local_prompts", multiline=True, default="",
                    tooltip="Auto-populated from the JS timeline editor (pipe-separated local prompts).",
                ),
                io.String.Input(
                    "segment_lengths", default="",
                    tooltip="Auto-populated from the JS timeline editor (comma-separated pixel-space frame counts).",
                ),
                io.Float.Input(
                    "epsilon", default=0.001, min=1e-6, max=0.99, step=1e-4,
                    tooltip=(
                        "Prompt relay penalty decay (passed to PromptRelayEncodeTimeline). "
                        "0.001 is kijai's paper default — produces sharp segment boundaries. "
                        "Values below ~0.1 all produce sharp boundaries; for softer/blended "
                        "transitions between segment prompts, try 0.5 or higher."
                    ),
                ),
                io.Float.Input(
                    "frame_rate", default=24, min=1, max=240, step=1, optional=True,
                    tooltip="Frames per second for ruler display + audio latent generation.",
                ),
                io.Combo.Input(
                    "display_mode", options=["frames", "seconds"], default="seconds", optional=True,
                    tooltip="UI-only: display ruler in frames or seconds.",
                ),
                io.String.Input(
                    "guide_strength", default="",
                    tooltip="Auto-populated from the JS timeline editor (comma-separated per-segment guide strengths).",
                ),
                io.Int.Input(
                    "custom_width", default=0, min=0, max=8192, step=1, optional=True,
                    tooltip="Target output width. 0 = derive from first image.",
                ),
                io.Int.Input(
                    "custom_height", default=0, min=0, max=8192, step=1, optional=True,
                    tooltip="Target output height. 0 = derive from first image.",
                ),
                io.Combo.Input(
                    "resize_method",
                    options=["maintain aspect ratio", "stretch to fit", "pad", "crop"],
                    default="maintain aspect ratio",
                    optional=True,
                ),
                io.Int.Input(
                    "divisible_by", default=32, min=1, max=256, step=1, optional=True,
                    tooltip="Snap output dimensions to be divisible by this (LTX requires 32).",
                ),
                io.Int.Input(
                    "img_compression", default=18, min=0, max=100, step=1, optional=True,
                    tooltip="H.264 CRF applied to each guide image. 0 = no compression.",
                ),
                io.Float.Input(
                    "scale_by", default=1.0, min=0.01, max=8.0, step=0.01, optional=True,
                    tooltip="Pre-scale the latent before placing kfs (e.g. 0.5 for the validated 0.5× stage-1 pre-pass).",
                ),
                io.Combo.Input(
                    "upscale_method", options=["nearest-exact", "bilinear", "area", "bicubic", "bislerp"],
                    default="nearest-exact", optional=True,
                    tooltip="Method used when scale_by != 1.0. nearest-exact matches the validated workflow's LatentUpscaleBy.",
                ),
            ],
            outputs=[
                io.Model.Output(display_name="model", tooltip="Model with kijai's prompt-relay attn2 patch applied."),
                io.Conditioning.Output(display_name="positive", tooltip="Relayed positive conditioning with keyframe_idxs appended."),
                io.Conditioning.Output(display_name="negative", tooltip="Empty-text-encoded negative with keyframe_idxs appended (NOT ConditioningZeroOut — empty-text is the validated motion-preserving choice)."),
                io.Latent.Output(display_name="video_latent", tooltip="LTX video latent with the kf token block grown on the temporal axis. Wire directly to LTXVConcatAVLatent → LTXVConditioning → sampler."),
                io.Latent.Output(display_name="audio_latent", tooltip="Empty audio latent matching duration (only if audio_vae provided)."),
                io.Float.Output(display_name="frame_rate"),
                io.Audio.Output(display_name="combined_audio", tooltip="Combined audio waveform if use_custom_audio=True and timeline has audio segments; otherwise silence."),
                GuideData.Output(display_name="guide_data", tooltip="Bundle of per-kf image+frame_idx+strength. Wire to LTXStoryboardGuide for stage-2 re-application after LTXVCropGuides + LTXVLatentUpsampler. Stage-1 already has kfs applied internally — this is only needed for the upsampled-latent re-anchor."),
            ],
        )

    @classmethod
    def execute(
        cls,
        model,
        clip,
        vae,
        global_prompt: str,
        duration_frames: int,
        duration_seconds: float,
        timeline_data: str,
        local_prompts: str,
        segment_lengths: str,
        epsilon: float,
        guide_strength: str,
        audio_vae=None,
        extend_from_video_latent=None,
        extend_from_audio_latent=None,
        relay_options=None,
        use_custom_audio: bool = False,
        frame_rate: float = 24.0,
        display_mode: str = "seconds",
        custom_width: int = 0,
        custom_height: int = 0,
        resize_method: str = "maintain aspect ratio",
        divisible_by: int = 32,
        img_compression: int = 18,
        scale_by: float = 1.0,
        upscale_method: str = "nearest-exact",
    ) -> io.NodeOutput:
        # ---- 1. Parse timeline JSON ----
        try:
            timeline = json.loads(timeline_data) if timeline_data else {}
        except json.JSONDecodeError as e:
            log.warning("[LTXStoryboard] timeline_data JSON parse error: %s", e)
            timeline = {}

        image_segments = [s for s in timeline.get("segments", []) if s.get("type", "image") == "image"]
        audio_segments = timeline.get("audioSegments", [])

        # ---- 2. Build guide_data (images, insert_frames, strengths) ----
        # Frame positions are in COMBINED-timeline pixel coords — no offset shift.
        # `anchorOffset` (within a segment) is where the kf tick sits; default to segment center.
        guide_data = {
            "images": [],
            "insert_frames": [],
            "strengths": [],
            "reach_before_pixels": [],
            "reach_after_pixels": [],
        }

        derived_w = custom_width if custom_width > 0 else 768
        derived_h = custom_height if custom_height > 0 else 512

        # Strengths CSV (auto-populated by JS) — fall back to per-segment guideStrength field.
        try:
            csv_strengths = [float(x.strip()) for x in guide_strength.split(",") if x.strip()] if guide_strength else []
        except ValueError:
            csv_strengths = []
        strengths_fallback = [float(s.get("guideStrength", 1.0)) for s in image_segments]

        for idx, seg in enumerate(image_segments):
            try:
                tensor = _load_image_tensor(seg)
                src_h, src_w = tensor.shape[1], tensor.shape[2]

                # Resize using the same logic LTXDirector uses.
                def _snap(v, div):
                    return max(div, (v // div) * div)

                if custom_width > 0 and custom_height > 0:
                    tensor = _resize_image(tensor, custom_width, custom_height, resize_method, divisible_by)
                elif custom_width > 0:
                    tgt_w = _snap(custom_width, divisible_by)
                    tgt_h = _snap(int(src_h * tgt_w / src_w), divisible_by)
                    tensor = _resize_image(tensor, tgt_w, tgt_h, "stretch to fit", divisible_by)
                elif custom_height > 0:
                    tgt_h = _snap(custom_height, divisible_by)
                    tgt_w = _snap(int(src_w * tgt_h / src_h), divisible_by)
                    tensor = _resize_image(tensor, tgt_w, tgt_h, "stretch to fit", divisible_by)
                else:
                    tensor = _resize_image(tensor, src_w, src_h, "maintain aspect ratio", divisible_by)

                if img_compression > 0:
                    tensor = _compress_image(tensor, img_compression)

                # Track derived dims from the first image so the fresh-latent path uses them.
                if idx == 0:
                    derived_h, derived_w = tensor.shape[1], tensor.shape[2]

                # Frame position in COMBINED pixel coords. `start` is the segment's left edge
                # in pixels; `anchorOffset` is where the tick sits within the segment.
                seg_start_px = int(seg.get("start", 0))
                seg_length_px = int(seg.get("length", 0))
                anchor_offset_px = int(seg.get("anchorOffset", seg_length_px // 2))
                anchor_offset_px = max(0, min(anchor_offset_px, seg_length_px))
                anchor_pixel = seg_start_px + anchor_offset_px

                # Strength: CSV wins if provided; else fall back to per-segment guideStrength.
                strength = csv_strengths[idx] if idx < len(csv_strengths) else strengths_fallback[idx]

                guide_data["images"].append(tensor)
                guide_data["insert_frames"].append(int(anchor_pixel))
                guide_data["strengths"].append(float(strength))
                guide_data["reach_before_pixels"].append(int(anchor_offset_px))
                guide_data["reach_after_pixels"].append(int(seg_length_px - anchor_offset_px))
            except Exception as e:
                log.warning("[LTXStoryboard] could not process image segment %d: %s", idx, e)

        # ---- 3. Build video latent (and detect prior_latent_t for logging) ----
        latent, prior_latent_t = _build_video_latent(
            extend_from_video_latent=extend_from_video_latent,
            duration_frames=duration_frames,
            derived_w=derived_w,
            derived_h=derived_h,
            divisible_by=divisible_by,
        )

        # ---- 4a. Build combined audio waveform ----
        # Needed for both the `combined_audio` output AND (when use_custom_audio=True
        # with audio_vae available) for the conditioning audio latent itself.
        log.info(
            "[LTXStoryboard] AUDIO DECISION INPUTS: use_custom_audio=%s, "
            "len(audio_segments)=%d, audio_vae=%s, extend_from_audio_latent=%s",
            use_custom_audio, len(audio_segments),
            "wired" if audio_vae is not None else "MISSING",
            "wired" if extend_from_audio_latent is not None else "none",
        )
        if use_custom_audio and audio_segments:
            try:
                ltxv_length = duration_frames + 1
                combined_audio = _build_combined_audio(timeline_data or "", ltxv_length, float(frame_rate))
                wf = combined_audio.get("waveform")
                if wf is not None:
                    peak = float(wf.abs().max().item()) if wf.numel() > 0 else 0.0
                    log.info(
                        "[LTXStoryboard] combined_audio built: waveform shape=%s, sample_rate=%s, peak_abs=%.4f%s",
                        tuple(wf.shape), combined_audio.get("sample_rate"), peak,
                        " (SILENT — _build_combined_audio returned zeros)" if peak < 1e-6 else "",
                    )
            except Exception as e:
                log.warning("[LTXStoryboard] _build_combined_audio failed (%s); emitting silence.", e)
                combined_audio = _silence_audio(duration_frames, frame_rate)
        else:
            log.info(
                "[LTXStoryboard] Skipping _build_combined_audio (use_custom_audio=%s, audio_segments=%d) — emitting silence waveform.",
                use_custom_audio, len(audio_segments),
            )
            combined_audio = _silence_audio(duration_frames, frame_rate)

        # ---- 4b. Build audio latent ----
        # Priority:
        #   1. extend_from_audio_latent — upstream-provided latent (extend mode) wins.
        #   2. use_custom_audio + audio_segments + audio_vae → encode combined_audio to
        #      a REAL audio latent that drives LTX's audio-conditioning path during sampling.
        #   3. Empty audio latent matching duration (silence).
        if extend_from_audio_latent is not None:
            audio_latent = extend_from_audio_latent
            log.info("[LTXStoryboard] audio_latent path: EXTEND (using upstream extend_from_audio_latent).")
        elif use_custom_audio and audio_segments and audio_vae is not None:
            audio_latent = _encode_audio_to_latent(audio_vae, combined_audio)
            if audio_latent is not None:
                samples = audio_latent["samples"]
                peak_latent = float(samples.abs().max().item()) if samples.numel() > 0 else 0.0
                log.info(
                    "[LTXStoryboard] audio_latent path: CUSTOM-ENCODED. shape=%s, peak_abs=%.4f%s",
                    tuple(samples.shape), peak_latent,
                    " (latent looks silent — encode may have collapsed to zeros)" if peak_latent < 1e-4 else "",
                )
            else:
                log.warning("[LTXStoryboard] audio_latent path: CUSTOM ENCODE RETURNED None; falling back to empty latent.")
                audio_latent = _build_empty_audio_latent(audio_vae, duration_frames, frame_rate)
        else:
            why = []
            if not use_custom_audio: why.append("use_custom_audio=False")
            if not audio_segments: why.append("no audio segments in timeline_data")
            if audio_vae is None: why.append("audio_vae not wired")
            log.info("[LTXStoryboard] audio_latent path: EMPTY (reason: %s).", ", ".join(why))
            audio_latent = _build_empty_audio_latent(audio_vae, duration_frames, frame_rate)

        if audio_latent is None:
            # Last-resort empty 4D tensor that matches LTX's expected audio latent rank.
            # The previous (1,1,1) sentinel caused LTXAV.process_timestep to fail with
            # "too many indices for tensor of dimension 3" because that path indexes
            # audio_denoise_mask as `[:, :1, :, :1]` (4D). At minimum we need a 4D shape.
            # Using a tiny placeholder (1, 1, 1, 1) keeps the downstream LTXVConcatAVLatent
            # and process_timestep code paths from crashing when audio_vae is missing or
            # incompatible. Wire `extend_from_audio_latent` or `audio_vae` for real audio.
            log.warning(
                "[LTXStoryboard] No audio latent could be built (audio_vae missing or "
                "incompatible, and no extend_from_audio_latent provided). Emitting a tiny "
                "4D placeholder to satisfy downstream rank-checks — audio output will be silence."
            )
            audio_latent = {"samples": torch.zeros((1, 1, 1, 1), device=comfy.model_management.intermediate_device())}

        # ---- 5. Call kijai's PromptRelayEncodeTimeline ----
        # If timeline has no segments (empty editor), `local_prompts` will likely be empty
        # and the relay will raise. Fall back: use global_prompt as a single local prompt.
        relay_local_prompts = local_prompts
        relay_segment_lengths = segment_lengths
        if not relay_local_prompts.strip():
            if global_prompt.strip():
                relay_local_prompts = global_prompt
                relay_segment_lengths = str(duration_frames)
            else:
                # Nothing to relay; encode "empty" so downstream still gets a valid conditioning.
                relay_local_prompts = " "
                relay_segment_lengths = str(duration_frames)

        try:
            PromptRelayEncodeTimeline = _get_prompt_relay_timeline_class()
            relay_result = PromptRelayEncodeTimeline.execute(
                model=model,
                clip=clip,
                latent=latent,
                global_prompt=global_prompt,
                max_frames=duration_frames,
                timeline_data=timeline_data or "",
                local_prompts=relay_local_prompts,
                segment_lengths=relay_segment_lengths,
                epsilon=epsilon,
                fps=float(frame_rate),
                time_units=display_mode,
                relay_options=relay_options,
            )
            # io.NodeOutput is indexable (see comfy_api/latest/_io.py:2154)
            patched_model = relay_result[0]
            positive = relay_result[1]
        except Exception as e:
            log.error("[LTXStoryboard] PromptRelayEncodeTimeline call failed: %s", e)
            raise

        # ---- 6. Always emit an empty-text negative ----
        # This is the validated motion-preserving choice. ConditioningZeroOut LOCKS multi-kf
        # motion; an empty-text CLIPTextEncode (Gemma's "no caption" learned embedding)
        # works. See memory: reference-ltx-attention-and-conditioning :: Empty negative ≠ zeroed.
        try:
            negative = clip.encode_from_tokens_scheduled(clip.tokenize(""))
        except Exception as e:
            log.warning("[LTXStoryboard] empty-text negative encode failed (%s); using positive as negative fallback.", e)
            negative = positive

        # ---- 6b. Apply keyframes to latent (LTXVAddGuideMulti loop body) ----
        # Mirrors comfyui-kjnodes/nodes/ltxv_nodes.py:62-97 — for each kf:
        #   encode → get_latent_index → append_keyframe.
        # `scale_by` is the validated stage-1 pre-pass (e.g. 0.5×). It MUST run BEFORE
        # the kf loop, not after — `append_keyframe` writes pixel-coordinate
        # `keyframe_idxs` into conditioning metadata derived from the latent's spatial
        # dims at encode time. Scaling the latent down AFTER would leave keyframe_idxs
        # stuck at the original (larger) pixel range while the actual latent positions
        # shrink, so RoPE-position alignment breaks and the model ignores the kfs.
        # In extend mode the upstream LTXVAudioVideoMask already sets the working
        # resolution — we pass it through untouched. Wire LatentUpscaleBy downstream
        # on the video_latent output if a post-conditioning scale is wanted there.
        scale_factors = vae.downscale_index_formula
        in_extend_mode = extend_from_video_latent is not None
        if scale_by != 1.0 and not in_extend_mode:
            B, C, F, H, W = latent["samples"].shape
            tw = max(1, round(W * scale_by))
            th = max(1, round(H * scale_by))
            latent_4d = latent["samples"].permute(0, 2, 1, 3, 4).reshape(B * F, C, H, W)
            latent_resized_4d = comfy.utils.common_upscale(latent_4d, tw, th, upscale_method, "disabled")
            latent = {"samples": latent_resized_4d.reshape(B, F, C, th, tw).permute(0, 2, 1, 3, 4)}
        elif scale_by != 1.0 and in_extend_mode:
            log.info("[LTXStoryboard] Extend mode: scale_by=%.2f ignored — extend latent passes through at its native resolution. Wire LatentUpscaleBy downstream if you want a post-conditioning scale.", scale_by)

        latent_image = latent["samples"]
        noise_mask = get_noise_mask(latent)

        _, _, latent_length, latent_height, latent_width = latent_image.shape

        for i, img_tensor in enumerate(guide_data["images"]):
            f_idx = int(guide_data["insert_frames"][i])
            strength = float(guide_data["strengths"][i])

            image_1, t = LTXVAddGuide.encode(vae, latent_width, latent_height, img_tensor, scale_factors)
            frame_idx, latent_idx = LTXVAddGuide.get_latent_index(positive, latent_length, len(image_1), f_idx, scale_factors)

            if latent_idx + t.shape[2] > latent_length:
                log.warning(
                    "[LTXStoryboard] kf %d at pixel %d → latent_idx %d would exceed latent_length %d; skipping.",
                    i, f_idx, latent_idx, latent_length,
                )
                continue

            positive, negative, latent_image, noise_mask = LTXVAddGuide.append_keyframe(
                positive, negative, frame_idx, latent_image, noise_mask, t, strength, scale_factors,
            )
            log.info(
                "[LTXStoryboard] kf %d: pixel=%d (snapped=%d) → latent_idx=%d, strength=%.2f",
                i, f_idx, frame_idx, latent_idx, strength,
            )

        latent = {"samples": latent_image, "noise_mask": noise_mask}

        # ---- 7. Diagnostic log + return ----
        log.info(
            "[LTXStoryboard] done: %d kfs, prior_latent_t=%d, frame_rate=%.1f, audio=%s",
            len(guide_data["images"]), prior_latent_t, frame_rate,
            "custom" if (use_custom_audio and audio_segments) else "silence",
        )

        return io.NodeOutput(
            patched_model,
            positive,
            negative,
            latent,
            audio_latent,
            float(frame_rate),
            combined_audio,
            guide_data,
        )


def _silence_audio(duration_frames: int, frame_rate: float) -> dict:
    """Produce a silent waveform matching duration_frames @ frame_rate. Shape matches
    ComfyUI's AUDIO type: {"waveform": [B, C, samples], "sample_rate": int}.
    """
    sr = 44100
    n_samples = max(1, int(round(duration_frames / max(1.0, float(frame_rate)) * sr)))
    return {
        "waveform": torch.zeros((1, 1, n_samples), dtype=torch.float32),
        "sample_rate": sr,
    }
