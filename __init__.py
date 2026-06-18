from .ltx_keyframer import LTXKeyframer
from .multi_image_loader import MultiImageLoader
from .ltx_sequencer import LTXSequencer
from .speech_length_calculator import SpeechLengthCalculator
from .load_audio_ui import LoadAudioUI
from .load_video_ui import LoadVideoUI
from .ltx_director import LTXDirector
from .ltx_director_guide import LTXDirectorGuide
from .shezw_iclora_params import ShezwDirectorICLoRAParams, ShezwDirectorICLoRAGuide
from .upscale_chunker import ShezwUpscaleChunker
from comfy_api.latest import ComfyExtension, io
from typing_extensions import override
from aiohttp import web
from server import PromptServer
import folder_paths
import os
import glob
import time
import shutil
import subprocess
import tempfile
import asyncio
import gc


def _safe_output_prefix(prefix: str) -> str:
    prefix = (prefix or "").replace("\\", "/").strip().strip("/")
    if not prefix or prefix.startswith("/") or ".." in prefix.split("/"):
        raise ValueError("Invalid output prefix")
    return prefix


def _safe_rel_path(path: str) -> str:
    path = (path or "").replace("\\", "/").strip().strip("/")
    if not path or path.startswith("/") or ".." in path.split("/"):
        raise ValueError("Invalid relative path")
    return path


def _base_dir_for_type(file_type: str) -> str:
    file_type = (file_type or "output").lower()
    if file_type == "input":
        return folder_paths.get_input_directory()
    if file_type == "temp" and hasattr(folder_paths, "get_temp_directory"):
        return folder_paths.get_temp_directory()
    return folder_paths.get_output_directory()


def _resolve_comfy_file(filename: str, file_type: str = "output", subfolder: str = "") -> str:
    rel = _safe_rel_path(os.path.join(subfolder or "", filename or ""))
    base = os.path.abspath(_base_dir_for_type(file_type))
    path = os.path.abspath(os.path.join(base, rel))
    if not (path == base or path.startswith(base + os.sep)):
        raise ValueError("Path escapes ComfyUI directory")
    if not os.path.isfile(path):
        raise FileNotFoundError(rel)
    return path


def _ffmpeg_exe() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:
        raise RuntimeError("ffmpeg not found. Install ffmpeg or imageio-ffmpeg.") from exc


def _unique_output_path(prefix: str, ext: str = ".mp4") -> tuple[str, str, str]:
    prefix = _safe_output_prefix(prefix)
    output_dir = folder_paths.get_output_directory()
    subfolder = os.path.dirname(prefix).replace("\\", "/")
    stem = os.path.basename(prefix)
    folder = os.path.join(output_dir, *subfolder.split("/")) if subfolder else output_dir
    os.makedirs(folder, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for i in range(1000):
        suffix = f"_{stamp}" if i == 0 else f"_{stamp}_{i:03d}"
        filename = f"{stem}{suffix}{ext}"
        path = os.path.join(folder, filename)
        if not os.path.exists(path):
            return path, filename, subfolder
    raise RuntimeError("Could not allocate output filename")


@PromptServer.instance.routes.get("/shezw/long_auto/latest_tail_frame")
async def shezw_latest_tail_frame(request):
    try:
        prefix = _safe_output_prefix(request.query.get("prefix", "video/long-auto-tail-frame"))
        since = float(request.query.get("since", "0") or 0)
        output_dir = folder_paths.get_output_directory()
        pattern = os.path.join(output_dir, *prefix.split("/")) + "*"
        candidates = [
            path
            for path in glob.glob(pattern)
            if os.path.isfile(path) and os.path.splitext(path)[1].lower() in {".png", ".jpg", ".jpeg", ".webp"}
        ]
        candidates.sort(key=os.path.getmtime, reverse=True)
        if since > 0:
            recent_candidates = [path for path in candidates if os.path.getmtime(path) >= since - 5.0]
            if recent_candidates:
                candidates = recent_candidates
            elif candidates and time.time() - os.path.getmtime(candidates[0]) <= 900:
                candidates = [candidates[0]]
            else:
                candidates = []
        if not candidates:
            return web.json_response({"found": False, "prefix": prefix})

        path = candidates[0]
        rel = os.path.relpath(path, output_dir).replace("\\", "/")
        subfolder = os.path.dirname(rel).replace("\\", "/")
        return web.json_response({
            "found": True,
            "imageFile": os.path.basename(path),
            "filename": os.path.basename(path),
            "subfolder": subfolder,
            "type": "output",
            "mtime": os.path.getmtime(path),
            "prefix": prefix,
        })
    except Exception as exc:
        return web.json_response({"found": False, "error": str(exc)}, status=400)


@PromptServer.instance.routes.get("/shezw/upscale/video_info")
async def shezw_upscale_video_info(request):
    try:
        import av

        filename = request.query.get("filename", "")
        file_type = request.query.get("type", "input")
        subfolder = request.query.get("subfolder", "")
        force_rate = float(request.query.get("force_rate", "0") or 0)
        path = _resolve_comfy_file(filename, file_type, subfolder)

        with av.open(path) as container:
            stream = container.streams.video[0] if container.streams.video else None
            if stream is None:
                raise ValueError("No video stream found")
            duration = 0.0
            if stream.duration and stream.time_base:
                duration = float(stream.duration * stream.time_base)
            elif container.duration:
                duration = float(container.duration / av.time_base)
            fps = float(stream.average_rate) if stream.average_rate else 24.0
            effective_fps = force_rate if force_rate > 0 else fps
            frame_count = int(stream.frames or 0)
            if force_rate > 0 and duration > 0:
                frame_count = max(1, int(round(duration * effective_fps)))
            if frame_count <= 0 and duration > 0:
                frame_count = max(1, int(round(duration * effective_fps)))
            if duration <= 0 and frame_count > 0 and effective_fps > 0:
                duration = frame_count / effective_fps

        return web.json_response({
            "filename": filename,
            "type": file_type,
            "subfolder": subfolder,
            "fps": effective_fps,
            "source_fps": fps,
            "frame_count": frame_count,
            "duration": duration,
        })
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/shezw/upscale/concat")
async def shezw_upscale_concat(request):
    try:
        payload = await request.json()
        videos = payload.get("videos") or []
        if not isinstance(videos, list) or not videos:
            raise ValueError("No videos provided")
        output_prefix = payload.get("output_prefix") or "video/upscale-merged"
        paths = [
            _resolve_comfy_file(item.get("filename", ""), item.get("type", "output"), item.get("subfolder", ""))
            for item in videos
            if isinstance(item, dict)
        ]
        if len(paths) != len(videos):
            raise ValueError("Invalid video item in concat list")

        output_path, filename, subfolder = _unique_output_path(output_prefix, ".mp4")
        ffmpeg = _ffmpeg_exe()
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as f:
            list_path = f.name
            for path in paths:
                escaped = path.replace("\\", "/").replace("'", "'\\''")
                f.write(f"file '{escaped}'\n")

        copy_cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", list_path, "-c", "copy", output_path]
        copy_run = subprocess.run(copy_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if copy_run.returncode != 0:
            reencode_cmd = [
                ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", list_path,
                "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", output_path,
            ]
            reencode_run = subprocess.run(reencode_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if reencode_run.returncode != 0:
                raise RuntimeError(reencode_run.stderr or copy_run.stderr or "ffmpeg concat failed")
            method = "reencode"
        else:
            method = "copy"

        try:
            os.unlink(list_path)
        except Exception:
            pass

        return web.json_response({
            "filename": filename,
            "subfolder": subfolder,
            "type": "output",
            "method": method,
            "count": len(paths),
        })
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/shezw/upscale/cleanup")
async def shezw_upscale_cleanup(request):
    try:
        payload = await request.json()
        prompt_id = payload.get("prompt_id")
        wait_seconds = max(0.0, min(60.0, float(payload.get("wait_seconds", 12) or 0)))
        unload_models = bool(payload.get("unload_models", False))

        queue = getattr(PromptServer.instance, "prompt_queue", None)
        if queue is not None:
            if prompt_id:
                try:
                    queue.delete_history_item(str(prompt_id))
                except Exception:
                    pass
            if unload_models:
                queue.set_flag("unload_models", True)
            queue.set_flag("free_memory", True)

        # Give ComfyUI's main execution loop time to consume the free_memory flag.
        # That loop owns PromptExecutor.reset(), which is what drops cached frame batches.
        if wait_seconds > 0:
            await asyncio.sleep(wait_seconds)

        gc.collect()
        cleanup_notes = []
        try:
            import comfy.model_management as model_management
            if hasattr(model_management, "soft_empty_cache"):
                model_management.soft_empty_cache()
            if unload_models and hasattr(model_management, "unload_all_models"):
                model_management.unload_all_models()
            cleanup_notes.append("comfy_model_management")
        except Exception as exc:
            cleanup_notes.append(f"comfy_cleanup_failed:{exc}")

        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                if hasattr(torch.cuda, "ipc_collect"):
                    torch.cuda.ipc_collect()
                cleanup_notes.append("torch_cuda")
        except Exception as exc:
            cleanup_notes.append(f"torch_cleanup_failed:{exc}")

        return web.json_response({
            "ok": True,
            "prompt_id": prompt_id,
            "wait_seconds": wait_seconds,
            "unload_models": unload_models,
            "notes": cleanup_notes,
        })
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)

class PromptRelay(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            LTXDirector,
            LTXDirectorGuide,
            ShezwDirectorICLoRAParams,
            ShezwDirectorICLoRAGuide
        ]

async def comfy_entrypoint() -> PromptRelay:
    return PromptRelay()
    
NODE_CLASS_MAPPINGS = {
    "LTXKeyframer": LTXKeyframer,
    "MultiImageLoader": MultiImageLoader,
    "LTXSequencer": LTXSequencer,
    "SpeechLengthCalculator": SpeechLengthCalculator,
    "LoadAudioUI": LoadAudioUI,
    "LoadVideoUI": LoadVideoUI,
    "LTXDirector": LTXDirector,
    "LTXDirectorGuide": LTXDirectorGuide,
    "ShezwDirectorICLoRAParams": ShezwDirectorICLoRAParams,
    "ShezwDirectorICLoRAGuide": ShezwDirectorICLoRAGuide,
    "ShezwUpscaleChunker": ShezwUpscaleChunker,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LTXKeyframer": "LTX Keyframer",
    "MultiImageLoader": "Multi Image Loader",
    "LTXSequencer": "LTX Sequencer",
    "SpeechLengthCalculator": "Speech Length Calculator",
    "LoadAudioUI": "Load Audio UI",
    "LoadVideoUI": "Load Video UI",
    "LTXDirector": "LTX Director",
    "LTXDirectorGuide": "LTX Director Guide",
    "ShezwDirectorICLoRAParams": "Shezw Director IC-LoRA Params",
    "ShezwDirectorICLoRAGuide": "Shezw Director IC-LoRA Guide",
    "ShezwUpscaleChunker": "Shezw Upscale Chunker",
}

WEB_DIRECTORY = "./js"

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
