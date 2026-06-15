import os
import re
import av
import numpy as np
import folder_paths
from pathlib import Path
from PIL import Image as PILImage
from server import PromptServer
from aiohttp import web

_ALLOWED_VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
_LTX_TEMPORAL_STRIDE = 8  # LTX VAE compresses time 8× — one guide frame per latent frame


@PromptServer.instance.routes.post("/ltx_director/extract_video_frames")
async def extract_video_frames(request):
    try:
        data = await request.json()
    except Exception:
        return web.Response(status=400, text="Invalid JSON body")

    video_file = data.get("videoFile", "")
    try:
        frame_rate = max(1, int(data.get("frameRate", 24)))
    except (TypeError, ValueError):
        return web.Response(status=400, text="Invalid frameRate")

    if not video_file:
        return web.Response(status=400, text="Missing videoFile")

    # Security: resolve and confirm path stays inside input dir
    input_dir = folder_paths.get_input_directory()
    real_input_dir = os.path.realpath(input_dir)
    real_candidate = os.path.realpath(os.path.join(input_dir, video_file))

    if os.path.commonpath([real_input_dir, real_candidate]) != real_input_dir:
        return web.Response(status=400, text="Invalid path")

    if os.path.splitext(real_candidate)[1].lower() not in _ALLOWED_VIDEO_EXTS:
        return web.Response(status=403, text="File type not allowed")

    if not os.path.isfile(real_candidate):
        return web.Response(status=404, text="File not found")

    # Sanitise subfolder name from video filename stem
    stem = re.sub(r"[^\w\-.]", "_", Path(real_candidate).stem) or "video"

    out_dir = os.path.join(input_dir, stem)
    os.makedirs(out_dir, exist_ok=True)
    real_out_dir = os.path.realpath(out_dir)

    try:
        container = av.open(real_candidate)
        if not container.streams.video:
            container.close()
            return web.Response(status=422, text="No video stream found")

        video_stream = container.streams.video[0]

        # Determine duration
        duration_sec = 0.0
        if video_stream.duration and video_stream.time_base:
            duration_sec = float(video_stream.duration * video_stream.time_base)
        if duration_sec <= 0 and container.duration:
            duration_sec = float(container.duration) / 1_000_000  # AV_TIME_BASE units

        if duration_sec <= 0:
            container.close()
            return web.Response(status=422, text="Could not determine video duration")

        total_px = max(1, round(duration_sec * frame_rate))
        latent_frames = ((total_px - 1) // _LTX_TEMPORAL_STRIDE) + 1

        orig_w = video_stream.codec_context.width
        orig_h = video_stream.codec_context.height

        # Colorspace detection — mirrors load_video_ui.py to avoid color shift
        try:
            from av.video.reformatter import Colorspace, ColorRange
            src_colorspace = Colorspace.ITU709 if max(orig_w, orig_h) >= 720 else Colorspace.ITU601
            src_color_range = ColorRange.MPEG
            dst_range = ColorRange.JPEG
        except ImportError:
            src_colorspace = src_color_range = dst_range = None

        if video_stream.codec_context:
            cc = video_stream.codec_context
            c_space = getattr(cc, "colorspace", getattr(cc, "color_space", None))
            if c_space and hasattr(c_space, "name") and c_space.name != "UNSPECIFIED":
                src_colorspace = c_space
            c_range = getattr(cc, "color_range", None)
            if c_range and hasattr(c_range, "name") and c_range.name != "UNSPECIFIED":
                src_color_range = c_range

        video_stream.thread_type = "AUTO"
        frames_result = []

        for n in range(latent_frames):
            target_time = (n * _LTX_TEMPORAL_STRIDE) / float(frame_rate)
            insert_frame = n * _LTX_TEMPORAL_STRIDE

            # Seek backward to nearest keyframe before target timestamp
            if video_stream.time_base:
                seek_pts = int(target_time / float(video_stream.time_base))
            else:
                seek_pts = 0
            try:
                container.seek(seek_pts, stream=video_stream, backward=True)
            except av.AVError:
                container.seek(0, stream=video_stream, backward=True)

            # Decode forward until we reach the target time
            frame_rgb = None
            for frame in container.decode(video_stream):
                frame_time = frame.time
                if frame_time is None:
                    if frame.pts is not None and video_stream.time_base:
                        frame_time = float(frame.pts * float(video_stream.time_base))
                    else:
                        frame_time = 0.0

                if frame_time < target_time - (0.5 / frame_rate):
                    continue  # still before target — keep decoding

                try:
                    if src_colorspace is not None:
                        frame_conv = frame.reformat(
                            format="rgb24",
                            src_colorspace=src_colorspace,
                            src_color_range=src_color_range,
                            dst_color_range=dst_range,
                        )
                    else:
                        frame_conv = frame.reformat(format="rgb24")
                    frame_rgb = frame_conv.to_ndarray(format="rgb24")
                except Exception:
                    frame_rgb = frame.to_ndarray(format="rgb24")
                break

            if frame_rgb is None:
                continue

            filename = f"frame_{n:04d}.jpg"
            out_path = os.path.join(out_dir, filename)
            real_out_path = os.path.realpath(out_path)
            if os.path.commonpath([real_out_dir, real_out_path]) != real_out_dir:
                continue

            PILImage.fromarray(frame_rgb).save(out_path, "JPEG", quality=95)

            view_url = f"/view?filename={filename}&type=input&subfolder={stem}"
            frames_result.append({
                "imageFile": f"{stem}/{filename}",
                "viewUrl": view_url,
                "insertFrame": insert_frame,
            })

        container.close()

        if not frames_result:
            return web.Response(status=422, text="No frames could be extracted")

        # --- Audio extraction ---
        # Re-open the container for the audio pass so we don't have to manage
        # interleaved seek state between video and audio streams.
        audio_file_rel = None
        try:
            audio_container = av.open(real_candidate)
            if audio_container.streams.audio:
                audio_stream = audio_container.streams.audio[0]
                audio_stream.thread_type = "AUTO"
                resampler = av.AudioResampler(format="fltp", layout="stereo", rate=44100)

                chunks = []
                for frame in audio_container.decode(audio_stream):
                    for rf in resampler.resample(frame):
                        chunks.append(rf.to_ndarray())  # [2, N] float32

                # Flush resampler
                for rf in resampler.resample(None):
                    chunks.append(rf.to_ndarray())

                if chunks:
                    import numpy as _np
                    waveform = _np.concatenate(chunks, axis=1)  # [2, total_samples]

                    audio_filename = f"{stem}.wav"
                    audio_path = os.path.join(out_dir, audio_filename)
                    real_audio_path = os.path.realpath(audio_path)
                    if os.path.commonpath([real_out_dir, real_audio_path]) == real_out_dir:
                        # Write WAV with wave module (always available, no extra deps)
                        import wave as _wave
                        import struct as _struct
                        channels = waveform.shape[0]
                        total_samples = waveform.shape[1]
                        sample_rate = 44100
                        # Interleave channels and convert to int16
                        interleaved = waveform.T.reshape(-1)  # [total_samples * channels]
                        # Clamp and convert float32 → int16
                        interleaved = _np.clip(interleaved, -1.0, 1.0)
                        pcm = (interleaved * 32767).astype(_np.int16)
                        with _wave.open(audio_path, "wb") as wf:
                            wf.setnchannels(channels)
                            wf.setsampwidth(2)  # int16 = 2 bytes
                            wf.setframerate(sample_rate)
                            wf.writeframes(pcm.tobytes())

                        audio_file_rel = f"{stem}/{audio_filename}"
            audio_container.close()
        except Exception as e:
            # Audio extraction is best-effort — don't fail the whole request
            import logging as _log
            _log.getLogger(__name__).warning("[LTXDirectorVideo] Audio extraction skipped: %s", e)

        return web.json_response({
            "clipName": stem,
            "frames": frames_result,
            "totalPixelFrames": total_px,
            "audioFile": audio_file_rel,  # None if video has no audio or extraction failed
        })

    except Exception as e:
        return web.Response(status=500, text=f"Extraction failed: {e}")
