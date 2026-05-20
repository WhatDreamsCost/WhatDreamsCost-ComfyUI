import asyncio
import base64
import gc
import io as _io
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
from PIL import Image

import folder_paths

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------------

VISION_MODELS = {
    "Qwen2.5-VL-3B — Fast": "huihui-ai/Qwen2.5-VL-3B-Instruct-abliterated",
    "Qwen2.5-VL-7B — Best quality": "prithivMLmods/Qwen2.5-VL-7B-Abliterated-Caption-it",
}

VISION_SYSTEM_PROMPT = (
    "You are an expert cinematographer and prompt writer for LTX-Video 2.3, "
    "a state-of-the-art AI video generation model.\n\n"
    "Analyze the image and write a single scene description of 100-130 words "
    "optimised for video generation.\n\n"
    "Include:\n"
    "- Subjects: physical appearance, clothing, pose, expression\n"
    "- Environment: location, lighting, time of day, atmosphere, textures, dominant colours\n"
    "- Camera: angle, distance, suggested movement (e.g. slow dolly, static wide, gentle pan)\n"
    "- Motion: what is happening or about to happen in the scene\n\n"
    "Rules:\n"
    "- Write in present tense\n"
    "- Be specific, cinematic, and visually dense\n"
    "- Avoid negative phrasing — describe what IS present\n"
    "- Output ONLY the scene description. No preamble, no labels, no metadata."
)

# ---------------------------------------------------------------------------
# Model singleton (one vision model loaded at a time)
# ---------------------------------------------------------------------------

_executor = ThreadPoolExecutor(max_workers=1)
_loaded_model_id: str | None = None
_loaded_model = None
_loaded_processor = None


def _unload_vision_model() -> None:
    global _loaded_model, _loaded_model_id, _loaded_processor
    if _loaded_model is None:
        return
    try:
        for param in _loaded_model.parameters():
            param.data = torch.empty(0)
    except Exception:
        pass
    _loaded_model = None
    _loaded_processor = None
    _loaded_model_id = None
    for _ in range(3):
        gc.collect()
    if torch.cuda.is_available():
        try:
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
            torch.cuda.reset_peak_memory_stats()
        except Exception:
            pass
    log.info("[PromptWriter] Vision model unloaded and VRAM freed.")


def _load_vision_model(model_id: str, offline_mode: bool, local_path: str):
    global _loaded_model, _loaded_model_id, _loaded_processor

    if _loaded_model_id == model_id:
        return _loaded_processor, _loaded_model

    _unload_vision_model()

    try:
        import comfy.model_management as mm
        mm.unload_all_models()
        mm.soft_empty_cache()
    except Exception:
        pass

    source = local_path.strip() if local_path.strip() else None

    if not source or not os.path.exists(source):
        try:
            from huggingface_hub import snapshot_download
            source = snapshot_download(
                repo_id=model_id,
                local_files_only=offline_mode,
                ignore_patterns=["*.gguf"],
            )
        except Exception:
            source = model_id

    log.info("[PromptWriter] Loading vision model from: %s", source)

    from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor

    processor = AutoProcessor.from_pretrained(source, local_files_only=offline_mode)

    dtype = torch.bfloat16 if (torch.cuda.is_available() and torch.cuda.is_bf16_supported()) else torch.float16
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        source,
        torch_dtype=dtype,
        device_map="auto",
        trust_remote_code=True,
        local_files_only=offline_mode,
    )
    model.eval()
    model.config.use_cache = True

    _loaded_model = model
    _loaded_model_id = model_id
    _loaded_processor = processor
    log.info("[PromptWriter] Vision model loaded: %s", model_id)
    return processor, model


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------

def _tensor_to_pil(tensor: torch.Tensor) -> Image.Image:
    arr = (tensor[0].cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    return Image.fromarray(arr)


def _describe_image_sync(
    image_tensor: torch.Tensor,
    model_id: str,
    offline_mode: bool,
    local_path: str,
    global_context: str,
    temperature: float,
    max_tokens: int,
) -> str:
    processor, model = _load_vision_model(model_id, offline_mode, local_path)
    pil = _tensor_to_pil(image_tensor)

    user_text = VISION_SYSTEM_PROMPT
    if global_context.strip():
        user_text += f"\n\nGlobal scene context provided by the director: {global_context.strip()}"

    messages = [{
        "role": "user",
        "content": [
            {"type": "image", "image": pil},
            {"type": "text", "text": user_text},
        ],
    }]

    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

    # qwen_vl_utils is installed alongside Qwen2.5-VL (also used by LTX2EasyPrompt-LD)
    try:
        from qwen_vl_utils import process_vision_info
        image_inputs, video_inputs = process_vision_info(messages)
        inputs = processor(
            text=[text],
            images=image_inputs,
            videos=video_inputs,
            padding=True,
            return_tensors="pt",
        )
    except ImportError:
        # Fallback: pass PIL directly (works on newer transformers builds)
        inputs = processor(text=[text], images=[pil], padding=True, return_tensors="pt")

    inputs = inputs.to(model.device)

    with torch.no_grad():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            temperature=temperature if temperature > 0 else None,
            top_p=0.9 if temperature > 0 else None,
            do_sample=temperature > 0,
        )

    generated = output_ids[:, inputs["input_ids"].shape[1]:]
    result = processor.batch_decode(
        generated, skip_special_tokens=True, clean_up_tokenization_spaces=True
    )[0]
    return result.strip()


def _load_image_tensor_from_seg(seg: dict) -> torch.Tensor | None:
    image_file = seg.get("imageFile")
    if image_file:
        path = os.path.join(folder_paths.get_input_directory(), image_file)
        if os.path.exists(path):
            try:
                pil = Image.open(path).convert("RGB")
                arr = np.array(pil, dtype=np.float32) / 255.0
                return torch.from_numpy(arr).unsqueeze(0)
            except Exception:
                pass

    b64 = seg.get("imageB64", "")
    if b64 and not b64.startswith("/view?"):
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        try:
            img_bytes = base64.b64decode(b64)
            pil = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
            arr = np.array(pil, dtype=np.float32) / 255.0
            return torch.from_numpy(arr).unsqueeze(0)
        except Exception:
            pass

    return None


# ---------------------------------------------------------------------------
# HTTP route
# ---------------------------------------------------------------------------

async def handle_generate_prompts(request):
    from aiohttp import web

    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": f"Invalid JSON: {e}"}, status=400)

    segments     = body.get("segments", [])
    global_prompt = body.get("global_prompt", "")
    model_name   = body.get("model_name", "Qwen2.5-VL-3B — Fast")
    offline_mode = bool(body.get("offline_mode", False))
    local_path   = body.get("local_path", "")
    temperature  = float(body.get("temperature", 0.3))
    max_tokens   = int(body.get("max_tokens", 180))

    model_id = VISION_MODELS.get(model_name, VISION_MODELS["Qwen2.5-VL-3B — Fast"])

    loop = asyncio.get_event_loop()
    prompts: list[str] = []

    for i, seg in enumerate(segments):
        tensor = _load_image_tensor_from_seg(seg)
        if tensor is None:
            # Text-only segment — keep whatever prompt it already has
            prompts.append(seg.get("prompt", ""))
            continue

        try:
            prompt = await loop.run_in_executor(
                _executor,
                _describe_image_sync,
                tensor, model_id, offline_mode, local_path,
                global_prompt, temperature, max_tokens,
            )
            prompts.append(prompt)
            log.info("[PromptWriter] Segment %d: %s…", i, prompt[:80])
        except Exception as e:
            log.error("[PromptWriter] Segment %d failed: %s", i, e)
            return web.json_response({"error": str(e)}, status=500)

    return web.json_response({"prompts": prompts, "model_used": model_name})


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def register_routes() -> None:
    try:
        from server import PromptServer
        PromptServer.instance.routes.post(
            "/whatdreamscost/generate_prompts"
        )(handle_generate_prompts)
        log.info("[PromptWriter] Route registered: POST /whatdreamscost/generate_prompts")
    except Exception as e:
        log.warning("[PromptWriter] Could not register route: %s", e)
