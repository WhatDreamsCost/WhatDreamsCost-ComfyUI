from .ltx_keyframer import LTXKeyframer
from .ltx_soft_hint_latent import LTXSoftHintLatent
from .ltx_prepend_start_frame import LTXPrependStartFrame
from .multi_image_loader import MultiImageLoader
from .ltx_sequencer import LTXSequencer, LTXSequencerMirror
from .speech_length_calculator import SpeechLengthCalculator
from .load_audio_ui import LoadAudioUI
from .load_video_ui import LoadVideoUI
from .ltx_director import LTXDirector
from .ltx_director_guide import LTXDirectorGuide
from .ltx_chain_guide import LTXChainKeyframeGuide
from .ltx_chain_append_guide import LTXChainKeyframeAppend
from .ltx_storyboard import LTXStoryboard
from .audio_sequencer import AudioSequencer
from comfy_api.latest import ComfyExtension, io
from typing_extensions import override

class PromptRelay(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            LTXDirector,
            LTXDirectorGuide,
            LTXChainKeyframeGuide,
            LTXChainKeyframeAppend,
            LTXStoryboard,
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
    "LTXChainKeyframeGuide": LTXChainKeyframeGuide,
    "LTXChainKeyframeAppend": LTXChainKeyframeAppend,
    "LTXStoryboard": LTXStoryboard,
    "LTXSequencerMirror": LTXSequencerMirror,
    "SpeechLengthCalculator": SpeechLengthCalculator,
    "AudioSequencer": AudioSequencer,
    "LTXSoftHintLatent": LTXSoftHintLatent,
    "LTXPrependStartFrame": LTXPrependStartFrame,
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
    "LTXChainKeyframeGuide": "LTX Chain Keyframe Guide",
    "LTXChainKeyframeAppend": "LTX Chain Keyframe Guide (Append)",
    "LTXStoryboard": "LTX Storyboard",
    "LTXSequencerMirror": "LTX Sequencer Mirror",
    "SpeechLengthCalculator": "Speech Length Calculator",
    "AudioSequencer": "Audio Sequencer",
    "LTXSoftHintLatent": "LTX Soft Hint Latent",
    "LTXPrependStartFrame": "LTX Prepend Start Frame",
}

WEB_DIRECTORY = "./js"

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']