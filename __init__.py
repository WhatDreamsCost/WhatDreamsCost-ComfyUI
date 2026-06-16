from .ltx_keyframer import LTXKeyframer
from .multi_image_loader import MultiImageLoader
from .ltx_sequencer import LTXSequencer
from .speech_length_calculator import SpeechLengthCalculator
from .load_audio_ui import LoadAudioUI
from .load_video_ui import LoadVideoUI
from .ltx_director import LTXDirector
from .ltx_director_guide import LTXDirectorGuide
from .shezw_iclora_params import ShezwDirectorICLoRAParams, ShezwDirectorICLoRAGuide
from comfy_api.latest import ComfyExtension, io
from typing_extensions import override
from aiohttp import web
from server import PromptServer
import folder_paths
import os
import glob
import time


def _safe_output_prefix(prefix: str) -> str:
    prefix = (prefix or "").replace("\\", "/").strip().strip("/")
    if not prefix or prefix.startswith("/") or ".." in prefix.split("/"):
        raise ValueError("Invalid output prefix")
    return prefix


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
}

WEB_DIRECTORY = "./js"

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
