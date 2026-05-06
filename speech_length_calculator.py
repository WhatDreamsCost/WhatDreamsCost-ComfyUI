import re
import math

class SpeechLengthCalculator:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": 'Enter your script here. "Make sure to put spoken words inside quotes!"'}),
                "fps": ("INT", {"default": 24, "min": 1, "max": 120, "step": 1}),
                "additional_time": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 0.1}),
            },
            "optional": {
                "text_input": ("STRING", {"forceInput": True}),
            }
        }

    # Added "STRING" to RETURN_TYPES
    RETURN_TYPES = ("INT", "INT", "INT", "STRING")
    # Added "text" to RETURN_NAMES
    RETURN_NAMES = ("slow_frame_count", "average_frame_count", "fast_frame_count", "text")
    FUNCTION = "calculate_speech"
    CATEGORY = "text/speech"

    def calculate_speech(self, text, fps, additional_time=0.0, text_input=None):
        # Prioritize the connected text_input if provided, otherwise fallback to the text widget
        active_text = text_input if (text_input is not None and isinstance(text_input, str) and text_input.strip() != "") else text
        
        # Regex to find words inside double quotes, single quotes, or smart quotes
        matches = re.findall(r'"([^"]*)"|\'([^\']*)\'|“([^”]*)”|‘([^’]*)’', active_text)
        
        # Extract matches, handling all possible captured groups from the regex
        quoted_text = " ".join([next((g for g in m if g), "") for m in matches])
        
        # Split by whitespace to get words and count them
        words = quoted_text.split()
        word_count = len(words)

        def calc_frames(wpm):
            if word_count == 0 and additional_time == 0:
                return 0
            minutes = word_count / wpm
            seconds = (minutes * 60) + additional_time
            return math.ceil(seconds * fps)

        slow_frames = calc_frames(100)
        avg_frames = calc_frames(130)
        fast_frames = calc_frames(160)

        # Added active_text as the 4th returned value
        return (slow_frames, avg_frames, fast_frames, active_text)