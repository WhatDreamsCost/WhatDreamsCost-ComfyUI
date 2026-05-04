import os
import torch
import numpy as np
import folder_paths
import av
from server import PromptServer
from aiohttp import web
import comfy.utils

# Custom API route to serve video files from anywhere on the user's system for the frontend preview
@PromptServer.instance.routes.get("/video_ui_custom_view")
async def custom_view(request):
    file_path = request.query.get("filename", "")
    if os.path.exists(file_path) and os.path.isfile(file_path):
        return web.FileResponse(file_path)
    return web.Response(status=404, text="File not found")

# Custom API route for Chunked Uploads to bypass the 413 Payload Too Large error
@PromptServer.instance.routes.post("/video_ui_upload_chunk")
async def upload_chunk(request):
    post = await request.post()
    file = post.get("file")
    filename = post.get("filename")
    chunk_index = int(post.get("chunk_index"))
    total_chunks = int(post.get("total_chunks"))

    upload_dir = folder_paths.get_input_directory()
    file_path = os.path.join(upload_dir, filename)

    # Append to file if it's not the first chunk, otherwise write new
    mode = "ab" if chunk_index > 0 else "wb"
    with open(file_path, mode) as f:
        f.write(file.file.read())

    if chunk_index == total_chunks - 1:
        return web.json_response({"name": filename})
    return web.json_response({"status": "ok"})


class LoadVideoUI:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "video": ("STRING", {"default": ""}),
                "start_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "end_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "duration": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "start_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "end_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "duration_frames": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),  
                "resize_method": (["maintain aspect ratio", "stretch to fit", "pad", "crop"], {"default": "maintain aspect ratio"}),                
                "custom_width": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 8, "tooltip": "Custom width. 0 means original width."}),
                "custom_height": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 8, "tooltip": "Custom height. 0 means original height."}),
                "frame_rate": ("INT", {"default": 24, "min": 1, "max": 120, "step": 1, "tooltip": "Force the video to a specific frame rate for extraction."}),
                "display_mode": (["seconds", "frames"], {"default": "seconds"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "INT")
    RETURN_NAMES = ("images", "audio", "duration", "frame_count")
    FUNCTION = "load_video"
    CATEGORY = "Custom/Video"

    def load_video(self, video, frame_rate, display_mode, start_time, end_time, duration, start_frame, end_frame, duration_frames, custom_width=0, custom_height=0, resize_method="maintain aspect ratio", **kwargs):
        if not video:
            # Return blank defaults if no video is loaded
            empty_image = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
            empty_audio = {"waveform": torch.zeros((1, 1, 44100)), "sample_rate": 44100}
            return (empty_image, empty_audio, 0.0, 0)

        # 1. Resolve path using ComfyUI standard paths or Absolute Path
        video_path = video  # Try exact/absolute path first
        if not os.path.exists(video_path):
            video_path_annotated = folder_paths.get_annotated_filepath(video)
            if os.path.exists(video_path_annotated):
                video_path = video_path_annotated
            else:
                video_path_input = os.path.join(folder_paths.get_input_directory(), video)
                if os.path.exists(video_path_input):
                    video_path = video_path_input
                else:
                    raise FileNotFoundError(f"Video file not found: {video}")

        # Open container to read streams and metadata
        container = av.open(video_path)
        
        # Determine video stream and duration
        video_stream = container.streams.video[0] if len(container.streams.video) > 0 else None
        video_duration = 0
        if video_stream and video_stream.duration and video_stream.time_base:
            video_duration = float(video_stream.duration * video_stream.time_base)

        orig_w = video_stream.codec_context.width if video_stream else 512
        orig_h = video_stream.codec_context.height if video_stream else 512

        target_w = custom_width if custom_width > 0 else orig_w
        target_h = custom_height if custom_height > 0 else orig_h
        
        target_w = target_w - (target_w % 2)
        target_h = target_h - (target_h % 2)
        
        scale_w, scale_h = target_w, target_h
        pad_left = pad_right = pad_top = pad_bottom = 0
        crop_left = crop_right = crop_top = crop_bottom = 0

        if custom_width > 0 or custom_height > 0:
            if resize_method == "maintain aspect ratio" or resize_method == "pad":
                ratio = min(target_w / orig_w, target_h / orig_h)
                scale_w = int(orig_w * ratio)
                scale_h = int(orig_h * ratio)
                scale_w = scale_w - (scale_w % 2)
                scale_h = scale_h - (scale_h % 2)
                
                if resize_method == "pad":
                    pad_x = target_w - scale_w
                    pad_y = target_h - scale_h
                    pad_left = pad_x // 2
                    pad_right = pad_x - pad_left
                    pad_top = pad_y // 2
                    pad_bottom = pad_y - pad_top
                else:
                    target_w, target_h = scale_w, scale_h

            elif resize_method == "crop":
                ratio = max(target_w / orig_w, target_h / orig_h)
                scale_w = int(orig_w * ratio)
                scale_h = int(orig_h * ratio)
                scale_w = scale_w - (scale_w % 2)
                scale_h = scale_h - (scale_h % 2)
                
                crop_x = scale_w - target_w
                crop_y = scale_h - target_h
                crop_left = crop_x // 2
                crop_right = crop_x - crop_left
                crop_top = crop_y // 2
                crop_bottom = crop_y - crop_top

            elif resize_method == "stretch to fit":
                scale_w, scale_h = target_w, target_h

        # Determine exact bounds based on frontend mode
        if display_mode == "frames":
            fr = float(frame_rate) if frame_rate > 0 else 24.0
            actual_start_time = float(start_frame) / fr
            actual_end_time = float(end_frame) / fr if (end_frame > 0 and end_frame > start_frame) else video_duration
        else:
            actual_start_time = start_time
            actual_end_time = end_time if (end_time > 0 and end_time > start_time) else video_duration

        if actual_end_time <= 0:
            actual_end_time = float('inf') # Fallback if duration is unknown

        # 2. Extract Video Frames (PyAV)
        frames = []
        image_tensor = None
        frames_loaded = 0
        
        if video_stream:
            video_stream.thread_type = "AUTO" # Enable multithreaded decoding
            
            # Efficiently seek backwards to the nearest keyframe
            if video_stream.time_base:
                seek_pts = int(actual_start_time / float(video_stream.time_base))
            else:
                seek_pts = int(actual_start_time * av.time_base)
            
            container.seek(seek_pts, stream=video_stream, backward=True)
            
            # Custom sampling to force specific framerate 
            frame_interval = 1.0 / float(frame_rate) if frame_rate > 0 else 1.0/24.0
            expected_target_time = actual_start_time
            
            # Pre-calculate expected frames
            alloc_end_time = actual_end_time if actual_end_time != float('inf') else video_duration
            expected_frames = 0
            if alloc_end_time > 0:
                duration_to_extract = alloc_end_time - actual_start_time
                if duration_to_extract > 0:
                    expected_frames = int(np.ceil(duration_to_extract / frame_interval)) + 2
                    
            pbar = comfy.utils.ProgressBar(expected_frames) if expected_frames > 0 else None

            for frame in container.decode(video_stream):
                frame_time = frame.time
                if frame_time is None:
                    frame_time = float(frame.pts * float(video_stream.time_base)) if frame.pts and video_stream.time_base else 0.0

                if frame_time < actual_start_time:
                    continue
                    
                # Add a slight buffer (interval) to ensure we evaluate the boundary correctly
                if frame_time > actual_end_time + frame_interval: 
                    break
                    
                frame_rgb = frame.reformat(width=scale_w, height=scale_h, format='rgb24').to_ndarray()
                
                if crop_left > 0 or crop_top > 0 or crop_right > 0 or crop_bottom > 0:
                    frame_rgb = frame_rgb[crop_top:scale_h-crop_bottom, crop_left:scale_w-crop_right, :]
                if pad_left > 0 or pad_top > 0 or pad_right > 0 or pad_bottom > 0:
                    frame_rgb = np.pad(frame_rgb, ((pad_top, pad_bottom), (pad_left, pad_right), (0, 0)), mode='constant', constant_values=0)
                
                # Duplicate or skip frames perfectly based on timestamps to meet forced framerate.
                # FIX: Use strictly less than (<) for actual_end_time to prevent the loop from fetching an extra +1 frame
                # at the exact boundary of the duration slice!
                while expected_target_time <= frame_time and expected_target_time < actual_end_time - 1e-5:
                    if image_tensor is None and expected_frames > 0:
                        # First frame: allocate the tensor
                        height, width = frame_rgb.shape[:2]
                        alloc_frames = expected_frames + 50 # Add generous buffer to prevent reallocation
                        try:
                            image_tensor = torch.zeros((alloc_frames, height, width, 3), dtype=torch.float32)
                        except Exception as e:
                            print(f"[LoadVideoUI] Pre-allocation failed, falling back to list: {e}")
                            expected_frames = 0 # Disable pre-allocation
                            
                    if image_tensor is not None:
                        # Check bounds (just in case)
                        if frames_loaded >= image_tensor.shape[0]:
                            # Extend tensor if we underestimated
                            extension = torch.zeros((50, image_tensor.shape[1], image_tensor.shape[2], 3), dtype=torch.float32)
                            image_tensor = torch.cat((image_tensor, extension), dim=0)
                            
                        # Insert frame with minimal memory copy directly to tensor
                        image_tensor[frames_loaded] = torch.from_numpy(frame_rgb).float().div_(255.0)
                        frames_loaded += 1
                    else:
                        # Fallback list append if pre-allocation failed
                        frames.append(frame_rgb)
                        
                    if pbar:
                        pbar.update(1)
                        
                    expected_target_time += frame_interval

        # Convert frames to ComfyUI Image standard format [N, H, W, C], float32, range 0.0-1.0
        if image_tensor is not None:
            if frames_loaded > 0:
                image_tensor = image_tensor[:frames_loaded]
            else:
                image_tensor = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
        elif len(frames) > 0:
            frames_np = np.array(frames, dtype=np.float32) / 255.0
            image_tensor = torch.from_numpy(frames_np)
        else:
            # Fallback for an empty slice
            image_tensor = torch.zeros((1, 512, 512, 3), dtype=torch.float32)

        # 3. Extract Audio (PyAV)
        audio_dict = {"waveform": torch.zeros((1, 1, 44100)), "sample_rate": 44100} # Default empty audio
        
        if len(container.streams.audio) > 0:
            try:
                audio_stream = container.streams.audio[0]
                audio_stream.thread_type = "AUTO"
                sample_rate = getattr(audio_stream, 'rate', 44100) or 44100
                
                # We must seek again on the container specifically for the audio stream
                if audio_stream.time_base:
                    seek_pts = int(actual_start_time / float(audio_stream.time_base))
                else:
                    seek_pts = int(actual_start_time * av.time_base)
                    
                container.seek(seek_pts, stream=audio_stream, backward=True)
                
                # Resample to standard float planar format (fltp)
                resampler = av.AudioResampler(format='fltp')
                
                audio_data = []
                first_frame_time = None
                
                for frame in container.decode(audio_stream):
                    frame_time = frame.time
                    if frame_time is None:
                        frame_time = float(frame.pts * float(audio_stream.time_base)) if frame.pts and audio_stream.time_base else 0.0
                        
                    # Give a small 1-second buffer to ensure we catch end frames
                    if frame_time > actual_end_time + 1.0: 
                        break
                        
                    if first_frame_time is None:
                        first_frame_time = frame_time
                        
                    resampled_frames = resampler.resample(frame)
                    for r_frame in resampled_frames:
                        audio_data.append(r_frame.to_ndarray())
                        
                if audio_data:
                    # Concatenate all frames horizontally along the sample axis
                    waveform_np = np.concatenate(audio_data, axis=1)
                    waveform = torch.from_numpy(waveform_np).float()
                    
                    if first_frame_time is None:
                        first_frame_time = 0.0
                        
                    # Calculate exact slice points to trim precisely
                    offset_sec = max(0.0, actual_start_time - first_frame_time)
                    start_sample = int(offset_sec * sample_rate)
                    
                    duration_sec_audio = actual_end_time - actual_start_time
                    end_sample = start_sample + int(duration_sec_audio * sample_rate)
                    
                    # Trim array bounds properly
                    if end_sample > start_sample:
                        waveform = waveform[:, start_sample:end_sample]
                    else:
                        waveform = waveform[:, start_sample:]
                        
                    # Expand to ComfyUI Audio standard [batch_size, channels, samples]
                    waveform = waveform.unsqueeze(0)
                    audio_dict = {"waveform": waveform, "sample_rate": sample_rate}
                    
            except Exception as e:
                # Catch gracefully without breaking the pipeline execution
                print(f"[LoadVideoUI] Audio track extraction skipped or failed: {e}")

        # Always close container to free up system memory lock
        container.close()
        
        # Output accurate final duration in seconds
        final_duration_sec = float(max(0.0, actual_end_time - actual_start_time))
        
        # Accurately output the true number of extracted frames 
        # (Using the shape of the array provides exact 1:1 parity with the timeline's math)
        frame_count = image_tensor.shape[0] if (frames_loaded > 0 or len(frames) > 0) else 0
        if frame_count == 0 and final_duration_sec > 0:
             # Fallback estimation only if PyAV completely failed to decode a valid chunk
             calc_fr = float(frame_rate) if frame_rate > 0 else 24.0
             frame_count = int(np.floor(final_duration_sec * calc_fr))

        return (image_tensor, audio_dict, final_duration_sec, frame_count)