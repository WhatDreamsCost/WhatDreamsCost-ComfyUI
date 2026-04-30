import folder_paths
import os
import torch
import av

def f32_pcm(wav: torch.Tensor) -> torch.Tensor:
    """Convert audio to float 32 bits PCM format."""
    if wav.dtype.is_floating_point:
        return wav
    elif wav.dtype == torch.int16:
        return wav.float() / (2 ** 15)
    elif wav.dtype == torch.int32:
        return wav.float() / (2 ** 31)
    raise ValueError(f"Unsupported wav dtype: {wav.dtype}")

def load_audio_file(filepath: str) -> tuple[torch.Tensor, int]:
    """Uses the latest ComfyUI av-based decoding for maximum compatibility."""
    with av.open(filepath) as af:
        if not af.streams.audio:
            raise ValueError("No audio stream found in the file.")

        stream = af.streams.audio[0]
        sr = stream.codec_context.sample_rate
        n_channels = stream.channels

        frames = []
        for frame in af.decode(streams=stream.index):
            buf = torch.from_numpy(frame.to_ndarray())
            if buf.shape[0] != n_channels:
                buf = buf.view(-1, n_channels).t()

            frames.append(buf)

        if not frames:
            raise ValueError("No audio frames decoded.")

        wav = torch.cat(frames, dim=1)
        wav = f32_pcm(wav)
        return wav, sr


class LoadAudioUI:
    @classmethod
    def INPUT_TYPES(s):
        try:
            files = folder_paths.get_filename_list("audio")
        except:
            files = []
        
        if not files:
            input_dir = folder_paths.get_input_directory()
            if os.path.exists(input_dir):
                all_files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
                try:
                    files = sorted(folder_paths.filter_files_content_types(all_files, ["audio", "video"]))
                except:
                    files = sorted(all_files)
        
        if not files or len(files) == 0:
            files = ["none"]

        return {
            "required": {
                "audio": (files, {"audio_upload": True}),
                "start_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "end_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
            },
            "optional": {
                "audioUI": ("AUDIO_UI",)
            }
        }

    CATEGORY = "audio"
    RETURN_TYPES = ("AUDIO", )
    FUNCTION = "load_audio"

    @classmethod
    def VALIDATE_INPUTS(cls, audio, **kwargs):
        # CRITICAL FIX: This bypasses the "Value not in list" error.
        # By returning True, we tell ComfyUI to allow the 'audio' value even if it isn't in 
        # the current dropdown list. This allows the execution to reach load_audio(),
        # where our fallback silence logic can handle the missing file gracefully.
        return True
    
    def load_audio(self, audio, start_time, end_time, **kwargs):
        # Determine the annotated file path if a file is actually selected
        # We wrap this in a try/except because get_annotated_filepath can fail if 
        # the input string is malformed or doesn't follow expected paths.
        try:
            audio_path = folder_paths.get_annotated_filepath(audio) if audio != "none" else ""
        except:
            audio_path = ""
        
        # --- FALLBACK LOGIC ---
        # If the file is 'none' or doesn't exist on disk, provide 1 second of silence
        if audio == "none" or not audio_path or not os.path.exists(audio_path):
            missing_info = audio if audio != "none" else "None selected"
            print(f"!!! [LoadAudioUI] Warning: Audio file '{missing_info}' not found. Outputting 1 second of silence.")
            
            sample_rate = 44100
            # 1 second of silence (stereo) -> shape [channels, time]
            waveform = torch.zeros((2, 44100))
        else:
            try:
                waveform, sample_rate = load_audio_file(audio_path)
            except Exception as e:
                # If decoding fails for any reason, fallback to silence rather than crashing the workflow
                print(f"!!! [LoadAudioUI] Error decoding {audio}: {e}. Falling back to silence.")
                sample_rate = 44100
                waveform = torch.zeros((2, 44100))

        # Convert seconds to frames
        start_frame = int(start_time * sample_rate)
        if end_time > 0:
            end_frame = int(end_time * sample_rate)
            # Ensure the end_frame does not exceed the actual audio length
            end_frame = min(end_frame, waveform.shape[1])
        else:
            # 0 defaults to the end of the file
            end_frame = waveform.shape[1]
            
        # Ensure start frame stays within bounds and doesn't pass the end frame
        start_frame = min(start_frame, end_frame)
        
        # Trim the waveform tensor -> shape: [channels, time]
        trimmed_waveform = waveform[:, start_frame:end_frame]
        
        # Final safety check: if trimming resulted in zero length, give it a tiny bit of padding 
        # to prevent downstream nodes from crashing on empty tensors
        if trimmed_waveform.shape[1] == 0:
            trimmed_waveform = torch.zeros((waveform.shape[0], 1))
        
        # Format for ComfyUI's standard AUDIO type: [batch, channels, time]
        audio_output = {"waveform": trimmed_waveform.unsqueeze(0), "sample_rate": sample_rate}
        
        return (audio_output, )