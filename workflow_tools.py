import json
import time
import random


def make_global_prefix_id() -> str:
    now = time.localtime()
    stamp = f"{now.tm_year}{now.tm_mon:02d}{now.tm_mday:02d}{now.tm_hour:02d}{now.tm_min:02d}"
    return f"{stamp}{random.randint(1000, 9999)}"


DEFAULT_SS_STRUCT = {
    "schema": "ltx-director-pro.ss-struct.v1",
    "structures": {
        "story_script": {
            "type": "object",
            "properties": {
                "schema": "string",
                "workflow_id": "string",
                "global_prefix": "string",
                "created_at": "iso-datetime-string",
                "ss_struct": "object",
                "nodes": "array<node_entry>",
            },
        },
        "node_entry": {
            "type": "object",
            "properties": {
                "id": "string",
                "type": "string",
                "title": "string",
                "widgets": "object<string, value>",
            },
        },
        "timeline_data": {
            "type": "object",
            "arrays": [
                "segments",
                "audioSegments",
                "cameraSegments",
                "controlSegments",
                "promptSegments",
                "referenceImages",
                "cutSegments",
            ],
            "objects": ["meta"],
        },
    },
    "fields": [
        {
            "node_type": "ShezwMetaInfo",
            "widgets": ["global_prefix"],
        },
        {
            "node_type": "LTXDirector",
            "widgets": [
                "global_prompt",
                "duration_frames",
                "duration_seconds",
                "frame_rate",
                "timeline_data",
                "use_custom_audio",
                "local_prompts",
                "segment_lengths",
                "guide_strength",
                "custom_width",
                "custom_height",
                "resize_method",
            ],
        },
        {
            "node_type": "LoadVideoUI",
            "widgets": [
                "video",
                "start_time",
                "end_time",
                "duration",
                "start_frame",
                "end_frame",
                "duration_frames",
                "resize_method",
                "custom_width",
                "custom_height",
                "frame_rate",
                "display_mode",
                "crop_x",
                "crop_y",
                "crop_w",
                "crop_h",
            ],
        },
        {
            "node_type": "LoadAudioUI",
            "widgets": ["audio", "start_time", "end_time", "duration", "display_mode"],
        },
        {
            "node_type": "ShezwUpscaleChunker",
            "widgets": [
                "chunk_seconds",
                "segment_prefix",
                "output_prefix",
                "cleanup_wait_seconds",
                "start_segment_index",
            ],
        },
    ],
}


class ShezwGlobalPrefix:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "global_prefix": ("STRING", {"default": make_global_prefix_id()}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("global_prefix",)
    FUNCTION = "execute"
    CATEGORY = "shezw/director-pro"

    def execute(self, global_prefix=""):
        return (str(global_prefix or "").strip(),)


class ShezwMetaInfo:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "global_prefix": ("STRING", {"default": make_global_prefix_id()}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("global_prefix",)
    FUNCTION = "execute"
    CATEGORY = "shezw/director-pro"

    @classmethod
    def DEFAULT_PROPERTIES(cls, workflow_id="ltx-director-pro"):
        return {
            "workflow_id": workflow_id,
            "script_name": f"{workflow_id}-ss.json",
            "ss_struct": DEFAULT_SS_STRUCT,
            "story_script": {},
            "export_dir": "",
        }

    def execute(self, global_prefix=""):
        return (str(global_prefix or "").strip(),)


class ShezwStoryScript:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "workflow_id": ("STRING", {"default": "ltx-director-pro"}),
                "script_name": ("STRING", {"default": "story-ss.json"}),
                "ss_struct": ("STRING", {"default": json.dumps(DEFAULT_SS_STRUCT, ensure_ascii=False), "multiline": True}),
                "story_script": ("STRING", {"default": "{}", "multiline": True}),
                "export_dir": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("story_script", "ss_struct")
    FUNCTION = "execute"
    CATEGORY = "shezw/director-pro"

    def execute(self, workflow_id="", script_name="", ss_struct="{}", story_script="{}", export_dir=""):
        return (story_script, ss_struct)
