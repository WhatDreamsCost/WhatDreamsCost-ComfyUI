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
from .workflow_tools import ShezwGlobalPrefix, ShezwMetaInfo, ShezwStoryScript
from comfy_api.latest import ComfyExtension, io
from typing_extensions import override
from aiohttp import web
from server import PromptServer
import folder_paths
import os
import glob
import time
import json
import shutil
import subprocess
import tempfile
import asyncio
import gc
import logging
import contextvars
import weakref


log = logging.getLogger(__name__)
_upscale_tracking_prompt_id = contextvars.ContextVar("shezw_upscale_tracking_prompt_id", default=None)
_tracked_upscale_tensors = []


def _safe_output_prefix(prefix: str) -> str:
    prefix = (prefix or "").replace("\\", "/").strip().strip("/")
    if not prefix or prefix.startswith("/") or ".." in prefix.split("/"):
        raise ValueError("Invalid output prefix")
    return prefix


def _safe_global_prefix(prefix: str) -> str:
    prefix = (prefix or "").replace("\\", "/").strip().strip("/")
    if not prefix or "/" in prefix or ".." in prefix:
        raise ValueError("Invalid global prefix")
    safe = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "-" for ch in prefix)
    safe = safe.strip("-._")
    if not safe:
        raise ValueError("Invalid global prefix")
    return safe[:128]


def _safe_rel_path(path: str) -> str:
    path = (path or "").replace("\\", "/").strip().strip("/")
    if not path or path.startswith("/") or ".." in path.split("/"):
        raise ValueError("Invalid relative path")
    return path


def _safe_story_filename(filename: str) -> str:
    filename = os.path.basename((filename or "").replace("\\", "/").strip())
    if not filename:
        filename = "story-ss.json"
    if not filename.endswith("-ss.json"):
        stem = filename[:-5] if filename.endswith(".json") else filename
        filename = f"{stem}-ss.json"
    return filename


def _story_scripts_dir() -> str:
    path = os.path.join(folder_paths.get_output_directory(), "story-scripts")
    os.makedirs(path, exist_ok=True)
    return path


def _resolve_export_dir(export_dir: str) -> str:
    export_dir = (export_dir or "").strip()
    if not export_dir:
        return _story_scripts_dir()
    export_dir = os.path.expanduser(export_dir)
    if not os.path.isabs(export_dir):
        export_dir = os.path.join(folder_paths.get_output_directory(), export_dir)
    os.makedirs(export_dir, exist_ok=True)
    return export_dir


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


def _empty_windows_working_set():
    if os.name != "nt":
        return "empty_working_set_skipped_non_windows"
    try:
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        psapi.EmptyWorkingSet.argtypes = [ctypes.c_void_p]
        psapi.EmptyWorkingSet.restype = ctypes.c_bool
        ctypes.set_last_error(0)
        process = kernel32.GetCurrentProcess()
        ok = psapi.EmptyWorkingSet(process)
        err = ctypes.get_last_error()
        return f"empty_working_set={'ok' if ok else 'failed'}:last_error={err}"
    except Exception as exc:
        return f"empty_working_set_failed:{exc}"


def _trim_windows_native_memory():
    if os.name != "nt":
        return ["native_trim_skipped_non_windows"]

    notes = []
    try:
        import ctypes

        for dll_name in ("ucrtbase", "msvcrt"):
            try:
                crt = ctypes.CDLL(dll_name, use_errno=True)
                heapmin = getattr(crt, "_heapmin")
                heapmin.argtypes = []
                heapmin.restype = ctypes.c_int
                ctypes.set_errno(0)
                result = heapmin()
                errno = ctypes.get_errno()
                notes.append(f"{dll_name}._heapmin={result}:errno={errno}")
            except Exception as exc:
                notes.append(f"{dll_name}._heapmin_failed:{exc}")

        try:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetProcessHeap.argtypes = []
            kernel32.GetProcessHeap.restype = ctypes.c_void_p
            kernel32.HeapCompact.argtypes = [ctypes.c_void_p, ctypes.c_uint]
            kernel32.HeapCompact.restype = ctypes.c_size_t
            ctypes.set_last_error(0)
            compacted = kernel32.HeapCompact(kernel32.GetProcessHeap(), 0)
            err = ctypes.get_last_error()
            notes.append(f"heap_compact={compacted}:last_error={err}")
        except Exception as exc:
            notes.append(f"heap_compact_failed:{exc}")

        try:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetCurrentProcess.restype = ctypes.c_void_p
            kernel32.SetProcessWorkingSetSize.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t]
            kernel32.SetProcessWorkingSetSize.restype = ctypes.c_bool
            ctypes.set_last_error(0)
            ok = kernel32.SetProcessWorkingSetSize(
                kernel32.GetCurrentProcess(),
                ctypes.c_size_t(-1).value,
                ctypes.c_size_t(-1).value,
            )
            err = ctypes.get_last_error()
            notes.append(f"set_working_set_size={'ok' if ok else 'failed'}:last_error={err}")
        except Exception as exc:
            notes.append(f"set_working_set_size_failed:{exc}")
    except Exception as exc:
        notes.append(f"native_trim_failed:{exc}")

    notes.append(_empty_windows_working_set())
    return notes


def _windows_process_memory_snapshot():
    if os.name != "nt":
        return {}
    snapshot = {}
    try:
        import ctypes

        class ProcessMemoryCountersEx(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
                ("PrivateUsage", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        psapi.GetProcessMemoryInfo.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ProcessMemoryCountersEx),
            ctypes.c_ulong,
        ]
        psapi.GetProcessMemoryInfo.restype = ctypes.c_bool
        counters = ProcessMemoryCountersEx()
        counters.cb = ctypes.sizeof(counters)
        ctypes.set_last_error(0)
        ok = psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb)
        if not ok:
            snapshot["win_mem_error"] = f"GetProcessMemoryInfo failed:{ctypes.get_last_error()}"
            return snapshot
        snapshot["win_working_set_mb"] = round(counters.WorkingSetSize / (1024 * 1024), 1)
        snapshot["win_peak_working_set_mb"] = round(counters.PeakWorkingSetSize / (1024 * 1024), 1)
        snapshot["win_pagefile_mb"] = round(counters.PagefileUsage / (1024 * 1024), 1)
        snapshot["win_peak_pagefile_mb"] = round(counters.PeakPagefileUsage / (1024 * 1024), 1)
        snapshot["win_private_mb"] = round(counters.PrivateUsage / (1024 * 1024), 1)
    except Exception as exc:
        snapshot["win_mem_error"] = str(exc)
    return snapshot


def _memory_snapshot():
    snapshot = {}
    try:
        import psutil
        process = psutil.Process(os.getpid())
        info = process.memory_info()
        snapshot["rss_mb"] = round(info.rss / (1024 * 1024), 1)
        snapshot["vms_mb"] = round(info.vms / (1024 * 1024), 1)
        try:
            full_info = process.memory_full_info()
            uss = getattr(full_info, "uss", None)
            if uss is not None:
                snapshot["uss_mb"] = round(uss / (1024 * 1024), 1)
        except Exception:
            pass
        vm = psutil.virtual_memory()
        snapshot["available_mb"] = round(vm.available / (1024 * 1024), 1)
        snapshot["system_percent"] = vm.percent
    except Exception as exc:
        snapshot["error"] = str(exc)

    snapshot.update(_windows_process_memory_snapshot())

    try:
        import comfy.model_management as model_management
        total_pinned = getattr(model_management, "TOTAL_PINNED_MEMORY", None)
        max_pinned = getattr(model_management, "MAX_PINNED_MEMORY", None)
        if total_pinned is not None:
            snapshot["comfy_pinned_mb"] = round(total_pinned / (1024 * 1024), 1)
        if max_pinned is not None:
            snapshot["comfy_max_pinned_mb"] = round(max_pinned / (1024 * 1024), 1)
    except Exception:
        pass

    try:
        import torch
        if torch.cuda.is_available():
            snapshot["cuda_allocated_mb"] = round(torch.cuda.memory_allocated() / (1024 * 1024), 1)
            snapshot["cuda_reserved_mb"] = round(torch.cuda.memory_reserved() / (1024 * 1024), 1)
    except Exception:
        pass
    return snapshot


def _format_memory_snapshot(snapshot):
    if not snapshot:
        return "unavailable"
    ordered_keys = (
        "rss_mb",
        "uss_mb",
        "vms_mb",
        "available_mb",
        "system_percent",
        "win_working_set_mb",
        "win_peak_working_set_mb",
        "win_pagefile_mb",
        "win_peak_pagefile_mb",
        "win_private_mb",
        "comfy_pinned_mb",
        "comfy_max_pinned_mb",
        "cuda_allocated_mb",
        "cuda_reserved_mb",
        "win_mem_error",
        "error",
    )
    return ",".join(f"{key}={snapshot[key]}" for key in ordered_keys if key in snapshot)


def _live_torch_tensor_snapshot(limit: int = 6):
    snapshot = {"count": 0, "total_mb": 0.0, "top": []}
    try:
        import torch
        groups = {}
        total_bytes = 0
        count = 0
        for obj in gc.get_objects():
            try:
                if not isinstance(obj, torch.Tensor):
                    continue
                size_bytes = obj.numel() * obj.element_size()
                key = (tuple(obj.shape), str(obj.dtype), str(obj.device), bool(obj.requires_grad))
            except Exception:
                continue
            count += 1
            total_bytes += size_bytes
            if key not in groups:
                groups[key] = {"count": 0, "bytes": 0}
            groups[key]["count"] += 1
            groups[key]["bytes"] += size_bytes
        top = sorted(groups.items(), key=lambda item: item[1]["bytes"], reverse=True)[:limit]
        snapshot = {
            "count": count,
            "total_mb": round(total_bytes / (1024 * 1024), 1),
            "top": [
                {
                    "shape": list(shape),
                    "dtype": dtype,
                    "device": device,
                    "requires_grad": requires_grad,
                    "count": data["count"],
                    "mb": round(data["bytes"] / (1024 * 1024), 1),
                }
                for (shape, dtype, device, requires_grad), data in top
            ],
        }
    except Exception as exc:
        snapshot["error"] = str(exc)
    return snapshot


def _format_tensor_snapshot(snapshot):
    if not snapshot:
        return "unavailable"
    top = snapshot.get("top") or []
    top_text = ";".join(
        f"shape={item.get('shape')},dtype={item.get('dtype')},device={item.get('device')},count={item.get('count')},mb={item.get('mb')}"
        for item in top
    )
    return f"count={snapshot.get('count')},total_mb={snapshot.get('total_mb')},top=[{top_text}]"


def _tensor_mb(tensor) -> float:
    try:
        return round(tensor.numel() * tensor.element_size() / (1024 * 1024), 1)
    except Exception:
        return 0.0


def _record_upscale_tensors(label: str, value, prompt_id=None):
    if prompt_id is None:
        prompt_id = _upscale_tracking_prompt_id.get()
    if not prompt_id:
        return
    try:
        import torch
    except Exception:
        return

    seen = set()

    def visit(item, path=""):
        item_id = id(item)
        if item_id in seen:
            return
        seen.add(item_id)
        try:
            if isinstance(item, torch.Tensor):
                _tracked_upscale_tensors.append({
                    "prompt_id": prompt_id,
                    "label": f"{label}{path}",
                    "ref": weakref.ref(item),
                    "shape": tuple(item.shape),
                    "dtype": str(item.dtype),
                    "device": str(item.device),
                    "mb": _tensor_mb(item),
                })
                return
        except Exception:
            return

        if isinstance(item, (list, tuple)):
            for index, child in enumerate(item):
                visit(child, f"{path}/{index}")
        elif isinstance(item, dict):
            for key, child in item.items():
                visit(child, f"{path}/{key}")

    visit(value)


def _format_referrers(obj, limit: int = 5) -> str:
    parts = []
    try:
        referrers = gc.get_referrers(obj)
    except Exception as exc:
        return f"referrers_error:{exc}"
    for referrer in referrers:
        if referrer is _tracked_upscale_tensors:
            continue
        if isinstance(referrer, dict):
            keys = []
            try:
                keys = [str(key) for key in list(referrer.keys())[:6]]
            except Exception:
                pass
            parts.append(f"dict(keys={keys})")
        elif isinstance(referrer, (list, tuple, set)):
            parts.append(f"{type(referrer).__name__}(len={len(referrer)})")
        else:
            parts.append(type(referrer).__name__)
        if len(parts) >= limit:
            break
    return "|".join(parts)


def _tracked_upscale_tensor_snapshot(prompt_id=None, limit: int = 8, include_referrers: bool = False):
    alive = []
    kept = []
    for record in _tracked_upscale_tensors:
        tensor = record["ref"]()
        if tensor is None:
            continue
        kept.append(record)
        if prompt_id is None or record.get("prompt_id") == prompt_id:
            alive.append((record, tensor))

    _tracked_upscale_tensors[:] = kept[-200:]
    alive.sort(key=lambda item: item[0].get("mb", 0), reverse=True)
    total_mb = round(sum(record.get("mb", 0) for record, _ in alive), 1)
    top = []
    for record, tensor in alive[:limit]:
        item = {
            "prompt_id": record.get("prompt_id"),
            "label": record.get("label"),
            "shape": list(record.get("shape") or ()),
            "dtype": record.get("dtype"),
            "device": record.get("device"),
            "mb": record.get("mb"),
        }
        if include_referrers:
            item["referrers"] = _format_referrers(tensor)
        top.append(item)
    return {"count": len(alive), "total_mb": total_mb, "top": top}


def _format_tracked_tensor_snapshot(snapshot):
    if not snapshot:
        return "unavailable"
    top = snapshot.get("top") or []
    top_text = ";".join(
        f"label={item.get('label')},shape={item.get('shape')},dtype={item.get('dtype')},device={item.get('device')},mb={item.get('mb')},referrers={item.get('referrers', '')}"
        for item in top
    )
    return f"count={snapshot.get('count')},total_mb={snapshot.get('total_mb')},top=[{top_text}]"


def _release_python_and_torch_memory(unload_models: bool = False):
    notes = []
    before = _memory_snapshot()
    try:
        import comfy.model_management as model_management
        if unload_models and hasattr(model_management, "unload_all_models"):
            model_management.unload_all_models()
            notes.append("unload_all_models")
        if hasattr(model_management, "cleanup_models_gc"):
            model_management.cleanup_models_gc()
            notes.append("cleanup_models_gc")
        if hasattr(model_management, "soft_empty_cache"):
            model_management.soft_empty_cache()
            notes.append("soft_empty_cache")
    except Exception as exc:
        notes.append(f"comfy_cleanup_failed:{exc}")

    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            if hasattr(torch.cuda, "ipc_collect"):
                torch.cuda.ipc_collect()
            notes.append("torch_cuda_empty_cache")
    except Exception as exc:
        notes.append(f"torch_cleanup_failed:{exc}")

    gc.collect()
    notes.extend(_trim_windows_native_memory())
    after = _memory_snapshot()
    tensors_after = _live_torch_tensor_snapshot()
    notes.append(f"mem_before[{_format_memory_snapshot(before)}]")
    notes.append(f"mem_after[{_format_memory_snapshot(after)}]")
    notes.append(f"live_tensors_after[{_format_tensor_snapshot(tensors_after)}]")
    return notes


def _install_upscale_prompt_cleanup_patch():
    try:
        import execution
    except Exception as exc:
        log.warning("[Shezw Upscale] Could not import ComfyUI execution module: %s", exc)
        return

    executor_cls = getattr(execution, "PromptExecutor", None)
    cache_set_cls = getattr(execution, "CacheSet", None)
    if executor_cls is None or cache_set_cls is None:
        return
    if getattr(executor_cls, "_shezw_upscale_cleanup_patch", False):
        return

    original_execute_async = executor_cls.execute_async
    original_get_output_data = getattr(execution, "get_output_data", None)

    if original_get_output_data is not None and not getattr(execution, "_shezw_upscale_tensor_tracking_patch", False):
        async def get_output_data_with_upscale_tracking(*args, **kwargs):
            result = await original_get_output_data(*args, **kwargs)
            prompt_id = _upscale_tracking_prompt_id.get()
            if prompt_id and isinstance(result, tuple) and len(result) > 0:
                unique_id = args[1] if len(args) > 1 else kwargs.get("unique_id", "unknown")
                obj = args[2] if len(args) > 2 else kwargs.get("obj")
                class_name = obj.__class__.__name__ if obj is not None else "unknown"
                _record_upscale_tensors(f"node={unique_id}:class={class_name}:output", result[0], prompt_id=prompt_id)
            return result

        execution.get_output_data = get_output_data_with_upscale_tracking
        execution._shezw_upscale_tensor_tracking_patch = True

    async def execute_async_with_upscale_cleanup(self, prompt, prompt_id, extra_data={}, execute_outputs=[]):
        is_upscale_chunk = isinstance(extra_data, dict) and extra_data.get("shezw_upscale_chunk")
        original_cache_type = getattr(self, "cache_type", None)
        chunk_cache_notes = []
        tracking_token = None
        if is_upscale_chunk:
            try:
                none_cache_type = getattr(execution.CacheType, "NONE")
                self.cache_type = none_cache_type
                self.caches = cache_set_cls(cache_type=none_cache_type, cache_args=self.cache_args)
                chunk_cache_notes.append("chunk_cache_type_none")
            except Exception as exc:
                chunk_cache_notes.append(f"chunk_cache_type_none_failed:{exc}")
            tracking_token = _upscale_tracking_prompt_id.set(str(prompt_id))
        try:
            return await original_execute_async(self, prompt, prompt_id, extra_data, execute_outputs)
        finally:
            if not is_upscale_chunk:
                return
            unload_models = bool(extra_data.get("shezw_unload_models_after_prompt", True))
            try:
                # This is the important part: drop the executor-owned output/object
                # caches that hold the large IMAGE tensors for this upscale chunk.
                self.cache_type = original_cache_type
                self.caches = cache_set_cls(cache_type=original_cache_type, cache_args=self.cache_args)
                notes = _release_python_and_torch_memory(unload_models=unload_models)
                tracked_tensors_after = _tracked_upscale_tensor_snapshot(str(prompt_id), include_referrers=True)
                notes.append(f"tracked_tensors_after[{_format_tracked_tensor_snapshot(tracked_tensors_after)}]")
                log.info(
                    "[Shezw Upscale] Cleared executor caches after chunk prompt %s; unload_models=%s; notes=%s",
                    prompt_id,
                    unload_models,
                    ",".join(chunk_cache_notes + notes),
                )
            except Exception as exc:
                log.warning("[Shezw Upscale] Executor cache cleanup failed after prompt %s: %s", prompt_id, exc)
            finally:
                if tracking_token is not None:
                    _upscale_tracking_prompt_id.reset(tracking_token)

    executor_cls.execute_async = execute_async_with_upscale_cleanup
    executor_cls._shezw_upscale_cleanup_patch = True
    log.info("[Shezw Upscale] Installed per-chunk executor cache cleanup patch.")


_install_upscale_prompt_cleanup_patch()


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


@PromptServer.instance.routes.get("/shezw/long_auto/prefix_outputs")
async def shezw_long_auto_prefix_outputs(request):
    try:
        global_prefix = _safe_global_prefix(request.query.get("prefix", ""))
        output_dir = os.path.abspath(folder_paths.get_output_directory())
        prefix_rel = os.path.join("video", global_prefix)
        prefix_dir = os.path.abspath(os.path.join(output_dir, prefix_rel))
        if not (prefix_dir == output_dir or prefix_dir.startswith(output_dir + os.sep)):
            raise ValueError("Prefix folder escapes output directory")

        image_exts = {".png", ".jpg", ".jpeg", ".webp"}
        video_exts = {".mp4", ".webm", ".mov", ".mkv"}

        def file_ref(path):
            rel = os.path.relpath(path, output_dir).replace("\\", "/")
            return {
                "filename": os.path.basename(path),
                "subfolder": os.path.dirname(rel).replace("\\", "/"),
                "type": "output",
                "mtime": os.path.getmtime(path),
                "size": os.path.getsize(path),
                "relpath": rel,
            }

        files = []
        if os.path.isdir(prefix_dir):
            for root, _dirs, names in os.walk(prefix_dir):
                for name in names:
                    ext = os.path.splitext(name)[1].lower()
                    if ext not in image_exts and ext not in video_exts:
                        continue
                    path = os.path.join(root, name)
                    if os.path.isfile(path):
                        files.append(file_ref(path))

        files.sort(key=lambda item: item["mtime"])
        tails = [
            item for item in files
            if os.path.splitext(item["filename"])[1].lower() in image_exts
            and (
                "tail-frame" in item["relpath"].lower()
                or "tail_frame" in item["relpath"].lower()
                or "last-frame" in item["relpath"].lower()
                or "last_frame" in item["relpath"].lower()
            )
        ]
        videos = [
            item for item in files
            if os.path.splitext(item["filename"])[1].lower() in video_exts
            and (
                "segment" in item["relpath"].lower()
                or "ltx-director-pro" in item["relpath"].lower()
                or "director-pro" in item["relpath"].lower()
            )
        ]

        return web.json_response({
            "ok": True,
            "prefix": global_prefix,
            "folder": prefix_rel.replace("\\", "/"),
            "exists": os.path.isdir(prefix_dir),
            "files": files,
            "tail_frames": tails,
            "segment_videos": videos,
        })
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


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
        memory_before = _memory_snapshot()

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
            if hasattr(model_management, "cleanup_models_gc"):
                model_management.cleanup_models_gc()
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
        cleanup_notes.extend(_trim_windows_native_memory())
        memory_after = _memory_snapshot()
        tensors_after = _live_torch_tensor_snapshot()
        tracked_tensors_after = _tracked_upscale_tensor_snapshot(str(prompt_id) if prompt_id else None, include_referrers=True)
        log.info(
            "[Shezw Upscale] Cleanup endpoint prompt=%s unload_models=%s wait=%ss notes=%s mem_before=%s mem_after=%s live_tensors_after=%s tracked_tensors_after=%s",
            prompt_id,
            unload_models,
            wait_seconds,
            ",".join(cleanup_notes),
            _format_memory_snapshot(memory_before),
            _format_memory_snapshot(memory_after),
            _format_tensor_snapshot(tensors_after),
            _format_tracked_tensor_snapshot(tracked_tensors_after),
        )

        return web.json_response({
            "ok": True,
            "prompt_id": prompt_id,
            "wait_seconds": wait_seconds,
            "unload_models": unload_models,
            "notes": cleanup_notes,
            "memory_before": memory_before,
            "memory_after": memory_after,
            "live_tensors_after": tensors_after,
            "tracked_tensors_after": tracked_tensors_after,
        })
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


@PromptServer.instance.routes.get("/shezw/story_script/list")
async def shezw_story_script_list(request):
    try:
        base = _story_scripts_dir()
        files = []
        for path in glob.glob(os.path.join(base, "*-ss.json")):
            if os.path.isfile(path):
                files.append({
                    "filename": os.path.basename(path),
                    "path": path,
                    "mtime": os.path.getmtime(path),
                    "size": os.path.getsize(path),
                })
        files.sort(key=lambda item: item["mtime"], reverse=True)
        return web.json_response({"ok": True, "files": files})
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


@PromptServer.instance.routes.get("/shezw/story_script/load")
async def shezw_story_script_load(request):
    try:
        filename = _safe_story_filename(request.query.get("filename", "story-ss.json"))
        path = os.path.join(_story_scripts_dir(), filename)
        if not os.path.isfile(path):
            raise FileNotFoundError(filename)
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return web.json_response({"ok": True, "filename": filename, "story_script": data})
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/shezw/story_script/save")
async def shezw_story_script_save(request):
    try:
        payload = await request.json()
        filename = _safe_story_filename(payload.get("filename") or payload.get("script_name") or "story-ss.json")
        story_script = payload.get("story_script")
        if isinstance(story_script, str):
            story_script = json.loads(story_script or "{}")
        if not isinstance(story_script, dict):
            raise ValueError("story_script must be an object")

        targets = []
        store_path = os.path.join(_story_scripts_dir(), filename)
        targets.append(store_path)
        if payload.get("export_dir"):
            export_path = os.path.join(_resolve_export_dir(payload.get("export_dir")), filename)
            if os.path.abspath(export_path) != os.path.abspath(store_path):
                targets.append(export_path)

        for path in targets:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(story_script, f, ensure_ascii=False, indent=2)
                f.write("\n")

        return web.json_response({
            "ok": True,
            "filename": filename,
            "paths": targets,
        })
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


@PromptServer.instance.routes.get("/shezw/upscale/find_segments")
async def shezw_upscale_find_segments(request):
    try:
        segment_prefix = _safe_output_prefix(request.query.get("segment_prefix", "video/upscale-segment"))
        count = max(0, min(100000, int(request.query.get("count", "0") or 0)))
        output_dir = folder_paths.get_output_directory()
        found = []
        missing = []
        for index in range(count):
            prefix = f"{segment_prefix}_{index:05d}"
            pattern = os.path.join(output_dir, *prefix.split("/")) + "*.mp4"
            candidates = [path for path in glob.glob(pattern) if os.path.isfile(path)]
            candidates.sort(key=lambda path: (
                0 if os.path.basename(path).lower().endswith("-audio.mp4") else 1,
                -os.path.getmtime(path),
            ))
            if not candidates:
                missing.append(index)
                continue
            path = candidates[0]
            rel = os.path.relpath(path, output_dir).replace("\\", "/")
            found.append({
                "index": index,
                "filename": os.path.basename(path),
                "subfolder": os.path.dirname(rel).replace("\\", "/"),
                "type": "output",
                "mtime": os.path.getmtime(path),
            })
        return web.json_response({
            "found": found,
            "missing": missing,
            "count": count,
            "segment_prefix": segment_prefix,
        })
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)

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
    "ShezwMetaInfo": ShezwMetaInfo,
    "ShezwGlobalPrefix": ShezwGlobalPrefix,
    "ShezwStoryScript": ShezwStoryScript,
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
    "ShezwMetaInfo": "Shezw Meta Info",
    "ShezwGlobalPrefix": "Shezw Global Prefix",
    "ShezwStoryScript": "Shezw Story Script",
}

WEB_DIRECTORY = "./js"

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
