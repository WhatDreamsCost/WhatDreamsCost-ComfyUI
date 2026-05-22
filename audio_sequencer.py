import logging
import json
import base64
import io as _io
import math

import torch
import av
import os
import folder_paths
import comfy.model_management

log = logging.getLogger(__name__)


def _build_combined_audio(timeline_data_str: str, duration_frames: int, frame_rate: float) -> dict:
    """Parses timeline JSON, loads/trims audio using PyAV, and composites clips onto a
    single stereo timeline matching duration_frames at 44.1 kHz."""
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
            except Exception:
                pass

        if not buffer:
            continue

        try:
            clip_frames = []

            with av.open(buffer) as container:
                stream = container.streams.audio[0]
                resampler = av.AudioResampler(format="fltp", layout="stereo", rate=target_sr)

                for frame in container.decode(stream):
                    for resampled in resampler.resample(frame):
                        clip_frames.append(torch.from_numpy(resampled.to_ndarray()))

                for resampled in resampler.resample(None):
                    clip_frames.append(torch.from_numpy(resampled.to_ndarray()))

            if not clip_frames:
                continue

            waveform = torch.cat(clip_frames, dim=1)  # [2, clip_samples]

            trim_start_frames = float(seg.get("trimStart", 0))
            length_frames = float(seg.get("length", 1))
            start_frames = float(seg.get("start", 0))

            start_sample_src = int(trim_start_frames / frame_rate * target_sr)
            length_samples = int(length_frames / frame_rate * target_sr)
            end_sample_src = start_sample_src + length_samples

            start_sample_src = max(0, start_sample_src)
            end_sample_src = min(end_sample_src, waveform.shape[1])

            actual_length = end_sample_src - start_sample_src
            if actual_length <= 0:
                continue

            clip_waveform = waveform[:, start_sample_src:end_sample_src]

            start_sample_dst = int(start_frames / frame_rate * target_sr)
            if start_sample_dst >= out_waveform.shape[1]:
                continue

            end_sample_dst = start_sample_dst + actual_length
            if end_sample_dst > out_waveform.shape[1]:
                actual_length = out_waveform.shape[1] - start_sample_dst
                clip_waveform = clip_waveform[:, :actual_length]
                end_sample_dst = start_sample_dst + actual_length

            if actual_length <= 0:
                continue

            out_waveform[:, start_sample_dst:end_sample_dst] += clip_waveform

        except Exception as e:
            log.warning("[AudioSequencer] Error processing segment %s: %s", seg.get("fileName"), e)
            continue

    return {"waveform": out_waveform.unsqueeze(0), "sample_rate": target_sr}


class AudioSequencer:
    """Visual audio timeline — drag and drop audio clips, trim and position them, then
    combine them into a single AUDIO output for downstream nodes."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "duration_frames": ("INT", {
                    "default": 240, "min": 1, "max": 100000, "step": 1,
                    "tooltip": "Total timeline length in frames.",
                }),
                "frame_rate": ("FLOAT", {
                    "default": 24.0, "min": 1.0, "max": 240.0, "step": 1.0,
                    "tooltip": "Frames per second — controls how timeline positions map to time.",
                }),
                "timeline_data": ("STRING", {
                    "default": "",
                    "tooltip": "JSON state managed by the visual editor. Do not edit by hand.",
                }),
                "display_mode": (["seconds", "frames"], {"default": "seconds"}),
            },
            "optional": {
                "audio_vae": ("VAE", {
                    "tooltip": (
                        "Connect an LTX Audio VAE to also output an encoded audio latent. "
                        "Timeline gaps (silence) are marked mask=1.0 so LTX will inpaint them "
                        "from context. Audio-filled regions are marked mask=0.0 (keep)."
                    ),
                }),
            },
        }

    RETURN_TYPES = ("AUDIO", "LATENT")
    RETURN_NAMES = ("audio", "audio_latent")
    FUNCTION = "execute"
    CATEGORY = "WhatDreamsCost"
    DESCRIPTION = (
        "Visually sequence audio clips on a timeline. "
        "Drag audio files onto the track, position and trim them, "
        "then combine them into a single AUDIO output. "
        "Optionally connect an Audio VAE to also output a masked audio latent for LTX inpainting."
    )

    def execute(self, duration_frames, frame_rate, timeline_data, display_mode, audio_vae=None):
        audio = _build_combined_audio(timeline_data, duration_frames, frame_rate)

        # Placeholder: zero-length latent returned when no VAE is connected.
        # Downstream nodes should only be connected when audio_vae is also provided.
        audio_latent = {"samples": torch.zeros((1, 8, 0, 64), dtype=torch.float32), "type": "audio"}
        if audio_vae is not None:
            try:
                waveform = audio["waveform"]  # [1, 2, total_samples]

                if hasattr(audio_vae, "first_stage_model"):
                    latent_samples = audio_vae.encode(waveform.movedim(1, -1))
                else:
                    latent_samples = audio_vae.encode({
                        "waveform": waveform,
                        "sample_rate": audio["sample_rate"],
                    })

                if latent_samples.numel() == 0:
                    raise ValueError("Encoded audio latent is empty.")

                # Per-temporal-frame occupancy mask.
                # mask=0.0 → audio present (keep conditioning), 1.0 → silence (inpaint from context)
                waveform_2d = waveform[0]  # [2, total_samples]
                total_samples_wf = waveform_2d.shape[1]
                num_latent_t = latent_samples.shape[-2]
                audio_freq = latent_samples.shape[-1]

                t_mask = torch.ones(num_latent_t, dtype=torch.float32)
                for _i in range(num_latent_t):
                    _s = int(round(_i * total_samples_wf / num_latent_t))
                    _e = int(round((_i + 1) * total_samples_wf / num_latent_t))
                    _e = min(_e, total_samples_wf)
                    if _e > _s and waveform_2d[:, _s:_e].abs().max().item() > 1e-6:
                        t_mask[_i] = 0.0  # audio present

                noise_mask = (
                    t_mask.view(1, 1, num_latent_t, 1)
                          .expand(1, 1, num_latent_t, audio_freq)
                          .clone()
                          .to(dtype=torch.float32,
                              device=comfy.model_management.intermediate_device())
                )

                audio_latent = {
                    "samples": latent_samples,
                    "type": "audio",
                    "noise_mask": noise_mask,
                }
                _filled = int((t_mask == 0.0).sum().item())
                log.info(
                    "[AudioSequencer] Audio latent: %d/%d frames have audio (mask=0.0), "
                    "%d silent frames will be inpainted (mask=1.0).",
                    _filled, num_latent_t, num_latent_t - _filled,
                )
            except Exception as e:
                log.error("[AudioSequencer] Failed to encode audio latent: %s", e)

        return (audio, audio_latent)
