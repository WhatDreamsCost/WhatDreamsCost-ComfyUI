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
# Style presets
# ---------------------------------------------------------------------------
# Each entry: "Preset name": "Full style instruction injected into the prompt."
# Add new presets here — the JS dropdown is populated automatically via the
# /whatdreamscost/style_presets endpoint; no JS edits needed.
#
# Style preset texts adapted from landon2022/LTX2EasyPrompt-LD
# https://github.com/landon2022/LTX2EasyPrompt-LD
# ---------------------------------------------------------------------------

_NONE_STYLE_LABEL = "None — let VLM decide"

STYLE_PRESETS: dict[str, str] = {
    _NONE_STYLE_LABEL: "",
    "Cinematic — Drama": (
        "STYLE: Cinematic drama. Intimate, character-driven. Shallow depth of field — subject sharp, "
        "world behind them soft. Colour grade: cool shadows, warm skin tones, restrained palette. "
        "Camera: medium close-ups and close-ups dominate. Moves are slow and purposeful — "
        "a slow push-in on a face, a rack focus between two people, a static hold that lets the actor breathe. "
        "Lighting: motivated practical sources — a lamp, a window, a candle. Never flat."
    ),
    "Cinematic — Epic": (
        "STYLE: Epic cinematic. Scale and environment are the protagonist. "
        "Wide establishing shots and vast compositions that make people feel small against the world. "
        "Camera: sweeping crane moves, slow lateral tracking shots, long pulls across terrain. "
        "Colour grade: rich, contrasty — deep shadows, luminous highlights. "
        "Every frame should feel like a poster. Build depth with foreground elements. "
        "Natural motion blur on all movement."
    ),
    "Cinematic — Intimate close-up": (
        "STYLE: Intimate close-up cinema. The entire world is a face, a hand, a detail. "
        "Razor-thin depth of field — one eye sharp, the other already soft. Bokeh is smooth and organic. "
        "Framing: extreme close-ups only — fill the frame with a face or a single feature. "
        "Camera: barely moves — micro drifts and imperceptible breathing movement. "
        "Colour grade: skin-tone faithful, warm and close. Lighting: one soft source, one fill, nothing else."
    ),
    "Slow-burn thriller": (
        "STYLE: Slow-burn psychological thriller. Tight framing, long held shots, shallow depth of field. "
        "Colour palette: desaturated teal and amber. Camera moves deliberately and slowly. "
        "Tension built through restraint, not action."
    ),
    "Handheld documentary": (
        "STYLE: Handheld documentary. Camera moves with the subject, never static. Slight shake on movement. "
        "Natural available light only — no studio lighting. Colour grade: flat, slightly washed. "
        "Intimate and observational — camera follows, never leads."
    ),
    "Horror — desaturated, harsh contrast": (
        "STYLE: Horror. Heavily desaturated colour, crushed blacks. Harsh top-down or under-lighting. "
        "Camera movements are slow and uneasy — never reassuring. "
        "Framing leaves negative space — empty doorways, dark corners. No warmth in the image."
    ),
    "Golden hour drama": (
        "STYLE: Golden hour drama. Warm amber and orange light from a low sun. Heavy lens flare. "
        "Soft shadows, glowing skin tones. Wide establishing shots and medium shots. "
        "Emotional, sweeping camera movement. Colour grade: warm, slightly overexposed highlights."
    ),
    "Noir — deep shadows, venetian light": (
        "STYLE: Classic noir. Low-key lighting, venetian blind shadow patterns across faces and walls. "
        "Black and white or heavily desaturated with single colour accent. "
        "Camera angles: low, Dutch tilt, shot through objects. Mood is foreboding and fatalistic."
    ),
    "High fashion editorial": (
        "STYLE: High fashion editorial. Striking, composed frames. Hard directional lighting with deep shadows. "
        "Colour palette: high contrast, often monochrome or single accent colour. "
        "Movement is deliberate and posed — model-aware. Camera movements are slow and precise. "
        "Apply the editorial aesthetic to whatever location the user specified."
    ),
    "Music video — stylised": (
        "STYLE: Music video. Rhythm-cut visual language — movement is driven by the beat. "
        "High contrast colour grade with stylised palette. "
        "Mix of tight close-ups and dramatic wide shots. Camera movement is expressive, not documentary. "
        "Film the scene the user described, through a music video camera."
    ),
    "Action blockbuster": (
        "STYLE: Action blockbuster. Fast kinetic energy. Dutch angles, crash zooms, whip pans. "
        "Colour grade: teal and orange, high contrast. "
        "Camera is never still — it moves with every impact. Slow motion inserts on key moments."
    ),
    "Sports documentary": (
        "STYLE: Sports documentary. Tracking shots following the athlete. Telephoto compression. "
        "Slow motion bursts at peak moments. Natural sound — crowd noise, impact, breathing. "
        "Colour grade: clean and neutral. Camera is athletic — it moves like it is competing too."
    ),
    "Dreamy — soft focus, slow motion": (
        "STYLE: Dreamy aesthetic. Soft focus edges with sharp centre. Pastel colour bleed. "
        "Movement is slow — the frame breathes rather than cuts. "
        "Shallow depth of field with heavy bokeh. Light sources bloom and halo."
    ),
    "Lo-fi home video — VHS": (
        "STYLE: Lo-fi home video. VHS tape aesthetic — slightly washed colour, faint scan lines, soft edges. "
        "Colour grade: faded, slightly green-shifted. Camera is handheld and casual. "
        "Intimate domestic setting implied. Imperfection is the aesthetic."
    ),
    "Hyper-real 4K — clinical sharpness": (
        "STYLE: Hyper-real 4K. Clinical sharpness — every texture, pore, and fibre rendered in full detail. "
        "Even lighting, no blown highlights, no crushed blacks. "
        "Camera movement is minimal and precise. The image is almost uncomfortably detailed."
    ),
    "Gritty realism — flat, natural light": (
        "STYLE: Gritty realism. Flat colour grade, no cinematic enhancement. Natural light only — "
        "whatever is available in the location. Camera is direct and unsentimental. "
        "No stylisation. The scene is shot as if it is actually happening."
    ),
    "POV — first person, immersive": (
        "STYLE: First-person POV. The camera IS the viewer's eyes. "
        "Frame moves as a head would — natural breathing movement, slight tilt on turns. "
        "Everything is seen, not watched. Close physical detail — hands, surfaces, faces at speaking distance."
    ),
    "Amateur — naturalistic, raw": (
        "STYLE: Amateur home video aesthetic. Slightly overexposed. Natural indoor lighting — lamps, overhead. "
        "Camera is handheld and slightly uncertain. No cinematic framing. "
        "Colour: ungraded, as-shot. The imperfection is intentional."
    ),
    "Anime — Japanese animation": (
        "STYLE: Japanese anime. Hand-drawn animation aesthetic — clean ink outlines, flat colour fills with "
        "subtle cel shading. Large expressive eyes, stylised facial features. "
        "Colour palette: vivid, high saturation with strong accent colours. "
        "Motion: fluid on key poses, held on reaction shots. "
        "Render every subject in this style regardless of what was described."
    ),
    "2D cartoon — hand-drawn": (
        "STYLE: Classic hand-drawn 2D cartoon. Expressive ink outlines with variable line weight. "
        "Flat colour fills, minimal shading, bold colour palette. "
        "Movement uses squash-and-stretch. Background art is simplified and stylised, never photorealistic. "
        "Render every subject in this style regardless of what was described."
    ),
    "3D CGI — Pixar/DreamWorks": (
        "STYLE: High-end 3D CGI animation in the style of Pixar or DreamWorks. "
        "Subsurface scattering on skin and organic surfaces. Highly detailed surface textures. "
        "Warm, soft three-point lighting with gentle shadows. "
        "Camera: smooth cinematic moves — slow push-ins, arcing lateral tracks. "
        "Colour grade: warm, slightly saturated, storybook palette. "
        "Render every subject in this style regardless of what was described."
    ),
    "Sci-fi — cinematic, practical": (
        "STYLE: Cinematic science fiction. Clean, practical-feeling environments — metal corridors, "
        "reinforced glass, industrial lighting rigs. Colour palette: cool blue-white with accent LEDs. "
        "No fantasy or magic — everything looks functional and built. "
        "Camera: wide establishing shots then close on faces or hands for intimacy. Lens flare on light sources."
    ),
    "Cyberpunk neon illustrated": (
        "STYLE: Cyberpunk illustrated. Neon-lit urban environment — magenta, cyan, electric blue, acid green. "
        "Hard rim lighting from neon signs carves subjects out of near-total darkness. "
        "Rain-slick surfaces reflect light in pools and streaks. "
        "Camera: low angles, wide lenses, dramatic fog and haze."
    ),
    "Comic book / graphic novel": (
        "STYLE: Comic book or graphic novel. Bold ink outlines, halftone dot patterns in shadow areas. "
        "Colour is flat with hard-edged shadows. Speed lines radiate from points of impact. "
        "Camera moves like a comic panel transition — hard cuts between angles, no smooth motion blur. "
        "Render every subject in this style regardless of what was described."
    ),
    "Erotic cinema — tasteful, cinematic": (
        "STYLE: Tasteful erotic cinema. Warm, intimate lighting — practical sources only. "
        "Shallow depth of field. Camera moves slowly and deliberately. "
        "Colour grade: warm skin tones, soft highlights. "
        "Sensual but not pornographic — implication over explicit detail. Slow, breathing pace. "
        "Describe only what was asked for — the style wraps it, it does not expand it."
    ),
    "Explicit — direct, anatomical": (
        "STYLE: Explicit adult content. Direct lighting — bodies clearly lit with no flattering shadow. "
        "Camera is close and functional — shows exactly what is happening without cinematic softening. "
        "No romantic framing. Blunt and specific. Anatomical language used directly. "
        "Describe only what the user requested. Do not add acts or nudity the user did not write."
    ),
    "Voyeur — handheld, observational": (
        "STYLE: Voyeuristic. The camera is a person — someone who found this moment and is trying not to be noticed. "
        "The camera bobs and drifts with the natural sway of someone standing. "
        "The motion is involuntary — slight vertical bounce, gentle lateral drift, micro-rotations. "
        "The camera NEVER repositions to get a better angle. Natural available light only — no fill, no flash. "
        "The subject is unaware. The camera does not announce itself."
    ),
    "Softcore editorial — lingerie-adjacent": (
        "STYLE: Softcore editorial. Fashion-magazine aesthetic. Clean, even lighting. "
        "Colour grade: warm neutrals and soft pastels. "
        "Camera is composed — lingerie-level sensuality, no explicit content. Movement is slow and posed. "
        "Do NOT add undressing, nudity, or intimate acts the user did not ask for."
    ),
    "Gravure Idol — Japanese glamour": (
        "STYLE: Japanese gravure idol photoshoot / glamour video. "
        "Bright, glossy, commercial magazine aesthetic. "
        "High-key natural daylight or clean studio lighting with strong rim light and soft reflector fill. "
        "Vivid yet smooth skin tones, slightly increased saturation, polished and flattering look. "
        "Posing is intentional, playful and seductive: arched back, teasing eye contact. "
        "Camera movement: slow body pan, lingering holds, slow tilt up, push-in as she makes eye contact. "
        "Mood is cute-provocative: youthful charm combined with fan-service energy."
    ),
    "Femdom — verbal domination": (
        "STYLE: Femdom verbal domination. She is the only power in the room. "
        "Camera worships her — low angle looking up, slow orbital arc, close-up on her expression of contempt. "
        "Hard directional lighting — one side of her face in clean harsh light, one in shadow. "
        "Her voice is the dominant sound — every consonant audible. "
        "FORBIDDEN: softness, uncertainty, the dominant losing composure."
    ),
    "Portrait vertical — 9:16 mobile": (
        "STYLE: Native portrait video, 9:16 aspect ratio. Optimised for mobile — TikTok, Reels, Shorts. "
        "Frame is vertical throughout. Tight head-to-torso framing. "
        "Action moves vertically in frame. Camera stays close. No wide horizontal composition."
    ),
    "Selfie — self-shot, arm's length": (
        "STYLE: Self-shot selfie video. The subject is holding the camera themselves — "
        "outstretched arm, camera facing back at them. 9:16 vertical frame. "
        "Tight head-and-shoulders framing. Camera bobs as they move, tilts when they turn their head. "
        "FORBIDDEN: tripod stillness, gimbal smoothness, rack focus, dolly, crane. "
        "Colour: clean and bright, natural available light, no cinematic grade."
    ),
    # ── Add your own presets below this line ─────────────────────────────────
}

# ---------------------------------------------------------------------------
# GGUF path helpers
# ---------------------------------------------------------------------------

def _resolve_gguf_path(local_path: str) -> tuple[str | None, bool]:
    """Returns (gguf_file, is_gguf_mode).

    is_gguf_mode is True when local_path is a .gguf file directly, or a
    directory that contains .gguf files but no config.json (i.e. not a
    HuggingFace transformers snapshot).
    """
    if not local_path:
        return None, False
    lp = local_path.strip()
    if not lp:
        return None, False
    if os.path.isfile(lp) and lp.lower().endswith(".gguf"):
        return lp, True
    if os.path.isdir(lp):
        if os.path.exists(os.path.join(lp, "config.json")):
            return None, False  # valid transformers dir — not GGUF mode
        candidates = sorted(
            [f for f in os.listdir(lp)
             if f.lower().endswith(".gguf") and "mmproj" not in f.lower()],
            key=lambda f: os.path.getsize(os.path.join(lp, f)),
            reverse=True,
        )
        if candidates:
            return os.path.join(lp, candidates[0]), True
    return None, False


def _find_mmproj(gguf_file: str, mmproj_hint: str = "") -> str | None:
    """Return mmproj path: use hint if valid, otherwise scan same directory."""
    if mmproj_hint.strip() and os.path.isfile(mmproj_hint.strip()):
        return mmproj_hint.strip()
    directory = os.path.dirname(gguf_file)
    for fname in os.listdir(directory):
        if fname.lower().endswith(".gguf") and "mmproj" in fname.lower():
            return os.path.join(directory, fname)
    return None


# ---------------------------------------------------------------------------
# GGUF model singleton
# ---------------------------------------------------------------------------

_gguf_llm = None
_gguf_llm_key: str | None = None


def _unload_gguf_model() -> None:
    global _gguf_llm, _gguf_llm_key
    if _gguf_llm is None:
        return
    _gguf_llm = None
    _gguf_llm_key = None
    gc.collect()
    log.info("[PromptWriter] GGUF model unloaded.")


def _load_gguf_model(gguf_file: str, mmproj_file: str | None):
    global _gguf_llm, _gguf_llm_key

    cache_key = f"{gguf_file}|{mmproj_file or ''}"
    if _gguf_llm_key == cache_key:
        return _gguf_llm

    _unload_gguf_model()
    _unload_vision_model()  # only one backend loaded at a time

    try:
        import comfy.model_management as mm
        mm.unload_all_models()
        mm.soft_empty_cache()
    except Exception:
        pass

    from llama_cpp import Llama

    kwargs: dict = dict(
        model_path=gguf_file,
        n_ctx=8192,
        n_gpu_layers=-1,
        verbose=False,
    )

    if mmproj_file:
        handler_cls = None
        # Try handlers in order of preference
        for cls_name in ("Qwen35ChatHandler", "Qwen2VLChatHandler", "Qwen2_5VLChatHandler"):
            try:
                from llama_cpp import llama_chat_format as _lcf
                handler_cls = getattr(_lcf, cls_name)
                log.info("[PromptWriter] Using %s for vision", cls_name)
                break
            except (ImportError, AttributeError):
                continue

        if handler_cls:
            try:
                # enable_thinking=False disables chain-of-thought (Qwen3.5 specific)
                try:
                    kwargs["chat_handler"] = handler_cls(
                        clip_model_path=mmproj_file, verbose=False, enable_thinking=False
                    )
                except TypeError:
                    kwargs["chat_handler"] = handler_cls(
                        clip_model_path=mmproj_file, verbose=False
                    )
                log.info("[PromptWriter] GGUF vision handler loaded with mmproj: %s", mmproj_file)
            except Exception as e:
                log.warning("[PromptWriter] Vision handler init failed (%s: %s) — text-only", type(e).__name__, e)
        else:
            log.warning("[PromptWriter] No VL chat handler found in llama-cpp — text-only")

    _gguf_llm = Llama(**kwargs)
    _gguf_llm_key = cache_key
    log.info("[PromptWriter] GGUF model loaded: %s", gguf_file)
    return _gguf_llm


import re as _re


def _strip_thinking(text: str) -> str:
    """Strip <think>...</think> blocks and chain-of-thought preambles.

    Strategy: after removing explicit think tags, split into paragraphs and
    return the last one that looks like plain prose (no markdown bullets or
    headers) and is at least 40 characters long.  This handles thinking models
    that dump analysis before writing the actual answer.
    """
    # 1. Remove explicit <think> blocks
    text = _re.sub(r"<think>[\s\S]*?</think>", "", text, flags=_re.DOTALL).strip()
    if not text:
        return text

    # 2. Split into blank-line-separated paragraphs
    paragraphs = [p.strip() for p in _re.split(r"\n\s*\n", text) if p.strip()]
    if not paragraphs:
        return text

    # 3. Find last paragraph that reads as plain prose
    bullet_or_header = _re.compile(r"^\s*(\d+[\.\)]|[-*#]|\*\*)", _re.MULTILINE)
    for para in reversed(paragraphs):
        # Reject if the paragraph is mostly bullets / headers / markdown bold
        non_md = _re.sub(r"\*+[^*\n]+\*+", "", para)   # strip **bold**
        non_md = _re.sub(r"^\s*[-*#\d]+[.)\s].*$", "", non_md, flags=_re.MULTILINE)
        non_md = non_md.strip()
        if len(non_md) >= 40 and not bullet_or_header.match(para):
            return para

    # 4. Hard fallback: last paragraph regardless
    return paragraphs[-1]


def _describe_image_gguf_sync(
    image_tensor: torch.Tensor,
    gguf_file: str,
    mmproj_file: str | None,
    user_text: str,
    temperature: float,
    max_tokens: int,
) -> str:
    import base64 as _b64
    import io as _sio

    llm = _load_gguf_model(gguf_file, mmproj_file)
    has_vision = mmproj_file and getattr(llm, "chat_handler", None) is not None

    # For thinking models (Qwen3, DeepSeek-R1, etc.) add /no_think system instruction
    system_msg = {"role": "system", "content": "/no_think\nOutput ONLY the scene description. No reasoning, no analysis, no preamble."}

    if has_vision:
        pil = _tensor_to_pil(image_tensor)
        buf = _sio.BytesIO()
        pil.save(buf, format="JPEG", quality=90)
        img_b64 = _b64.b64encode(buf.getvalue()).decode()
        messages = [
            system_msg,
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}},
                    {"type": "text", "text": user_text},
                ],
            },
        ]
    else:
        log.info("[PromptWriter] GGUF text-only mode (no mmproj — image not analysed)")
        # Compact prompt for text-only: avoids triggering long reasoning chains
        textonly_prompt = (
            "/no_think\n"
            "Write a cinematic scene description of 100-130 words for LTX-Video 2.3.\n"
            "Present tense. Include subjects, environment, lighting, camera angle and movement.\n"
            "Output ONLY the description, no titles, no analysis, no preamble.\n\n"
        )
        if user_text:
            # Append context/style lines from the original prompt (skip the verbose system block)
            extra = []
            for line in user_text.splitlines():
                if line.startswith("Global scene context") or line.startswith("- "):
                    extra.append(line)
            if extra:
                textonly_prompt += "\n".join(extra)
        messages = [system_msg, {"role": "user", "content": textonly_prompt}]

    response = llm.create_chat_completion(
        messages=messages,
        max_tokens=max(max_tokens, 300),
        temperature=max(temperature, 0.01),
    )
    raw = response["choices"][0]["message"]["content"].strip()
    return _strip_thinking(raw)


# ---------------------------------------------------------------------------
# Transformers model singleton (one vision model loaded at a time)
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

    # Only use local_path if it's a valid transformers snapshot directory
    if source and not (os.path.isdir(source) and os.path.exists(os.path.join(source, "config.json"))):
        source = None

    if not source:
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


_NONE_STYLE = _NONE_STYLE_LABEL  # alias for backward compat


def _build_user_text(
    global_context: str,
    style_preset: str,
    shot_angle: str,
    camera_move: str,
    style_extra: str,
    segment_hint: str = "",
) -> str:
    text = VISION_SYSTEM_PROMPT
    if global_context.strip():
        text += f"\n\nGlobal scene context provided by the director: {global_context.strip()}"
    if segment_hint.strip():
        text += f"\n\nSpecific instruction for this scene: {segment_hint.strip()}"

    # Full style preset text (from STYLE_PRESETS dict) takes priority
    preset_text = STYLE_PRESETS.get(style_preset, "")
    if preset_text:
        text += f"\n\n{preset_text}"
    elif style_preset and style_preset != _NONE_STYLE:
        # Unknown preset label — fall back to generic directive
        text += f"\n\nVisual style: {style_preset}"

    # Additional per-shot directives
    extra_lines = []
    if shot_angle and shot_angle != _NONE_STYLE:
        extra_lines.append(f"- Shot angle: {shot_angle}")
    if camera_move and camera_move != _NONE_STYLE:
        extra_lines.append(f"- Camera movement: {camera_move}")
    if style_extra.strip():
        extra_lines.append(f"- Additional: {style_extra.strip()}")
    if extra_lines:
        text += "\n\nShot directives — incorporate these:\n" + "\n".join(extra_lines)
    return text


def _describe_image_sync(
    image_tensor: torch.Tensor,
    model_id: str,
    offline_mode: bool,
    local_path: str,
    global_context: str,
    temperature: float,
    max_tokens: int,
    style_preset: str = _NONE_STYLE,
    shot_angle: str = _NONE_STYLE,
    camera_move: str = _NONE_STYLE,
    style_extra: str = "",
    mmproj_path: str = "",
    segment_hint: str = "",
) -> str:
    user_text = _build_user_text(global_context, style_preset, shot_angle, camera_move, style_extra, segment_hint)

    # --- GGUF dispatch ---
    gguf_file, is_gguf = _resolve_gguf_path(local_path)
    if is_gguf:
        if gguf_file:
            mmproj = _find_mmproj(gguf_file, mmproj_path)
            return _describe_image_gguf_sync(
                image_tensor, gguf_file, mmproj, user_text, temperature, max_tokens
            )
        log.warning("[PromptWriter] GGUF mode detected but no .gguf file found in: %s — falling back to HuggingFace", local_path)

    # --- Transformers dispatch ---
    processor, model = _load_vision_model(model_id, offline_mode, local_path)
    pil = _tensor_to_pil(image_tensor)

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
    style_preset = body.get("style_preset", _NONE_STYLE)
    shot_angle   = body.get("shot_angle",   _NONE_STYLE)
    camera_move  = body.get("camera_move",  _NONE_STYLE)
    style_extra  = body.get("style_extra",  "")
    mmproj_path  = body.get("mmproj_path",  "")

    model_id = VISION_MODELS.get(model_name, VISION_MODELS["Qwen2.5-VL-3B — Fast"])

    loop = asyncio.get_event_loop()
    prompts: list[str] = []

    for i, seg in enumerate(segments):
        tensor = _load_image_tensor_from_seg(seg)
        if tensor is None:
            # Text-only segment — keep whatever prompt it already has
            prompts.append(seg.get("prompt", ""))
            continue

        # Per-segment hint: dedicated hint field (never overwritten by generation).
        # Falls back to empty string → only global_prompt is used.
        segment_hint = seg.get("hint", "").strip()

        try:
            prompt = await loop.run_in_executor(
                _executor,
                _describe_image_sync,
                tensor, model_id, offline_mode, local_path,
                global_prompt, temperature, max_tokens,
                style_preset, shot_angle, camera_move, style_extra,
                mmproj_path, segment_hint,
            )
            prompts.append(prompt)
            log.info("[PromptWriter] Segment %d: %s…", i, prompt[:80])
        except Exception as e:
            log.error("[PromptWriter] Segment %d failed: %s", i, e)
            # Unload before returning the error too
            _unload_gguf_model()
            _unload_vision_model()
            return web.json_response({"error": str(e)}, status=500)

    # Always unload after generation to free VRAM / RAM
    _unload_gguf_model()
    _unload_vision_model()

    return web.json_response({"prompts": prompts, "model_used": model_name})


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

async def handle_style_presets(request):
    """Return the list of available style preset names (for the JS dropdown)."""
    from aiohttp import web
    return web.json_response({"presets": list(STYLE_PRESETS.keys())})


def register_routes() -> None:
    try:
        from server import PromptServer
        PromptServer.instance.routes.post(
            "/whatdreamscost/generate_prompts"
        )(handle_generate_prompts)
        PromptServer.instance.routes.get(
            "/whatdreamscost/style_presets"
        )(handle_style_presets)
        log.info("[PromptWriter] Routes registered.")
    except Exception as e:
        log.warning("[PromptWriter] Could not register routes: %s", e)
