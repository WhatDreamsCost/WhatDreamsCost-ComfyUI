from .ltx_keyframer import SmartLTXKeyframer
from .multi_image_loader import SmartMultiImageLoader
from .ltx_sequencer import SmartLTXSequencer
from .speech_length_calculator import SmartSpeechLengthCalculator
from .load_audio_ui import SmartLoadAudioUI
from .load_video_ui import SmartLoadVideoUI
from .ltx_director import SmartLTXDirector
from .ltx_director_guide import SmartLTXDirectorGuide, SmartLTXDirectorCropGuides

NODE_CLASS_MAPPINGS = {
    "SmartLTXKeyframer": SmartLTXKeyframer,
    "SmartMultiImageLoader": SmartMultiImageLoader,
    "SmartLTXSequencer": SmartLTXSequencer,
    "SmartSpeechLengthCalculator": SmartSpeechLengthCalculator,
    "SmartLoadAudioUI": SmartLoadAudioUI,
    "SmartLoadVideoUI": SmartLoadVideoUI,
    "SmartLTXDirector": SmartLTXDirector,
    "SmartLTXDirectorGuide": SmartLTXDirectorGuide,
    "SmartLTXDirectorCropGuides": SmartLTXDirectorCropGuides,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SmartLTXKeyframer": "Smart LTX Keyframer",
    "SmartMultiImageLoader": "Smart Multi Image Loader",
    "SmartLTXSequencer": "Smart LTX Sequencer",
    "SmartSpeechLengthCalculator": "Smart Speech Length Calculator",
    "SmartLoadAudioUI": "Smart Load Audio UI",
    "SmartLoadVideoUI": "Smart Load Video UI",
    "SmartLTXDirector": "Smart LTX Director",
    "SmartLTXDirectorGuide": "Smart LTX Director Guide",
    "SmartLTXDirectorCropGuides": "Smart LTX Director Crop Guides",
}

WEB_DIRECTORY = "./js"