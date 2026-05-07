from comfy_extras.nodes_lt import get_keyframe_idxs, get_noise_mask, LTXVAddGuide
import torch
import comfy.utils
from comfy_api.latest import io

class LTXSequencer(LTXVAddGuide):
    @classmethod
    def define_schema(cls):
        inputs = [
            io.Conditioning.Input("positive", tooltip="Positive conditioning to which guide keyframe info will be added"),
            io.Conditioning.Input("negative", tooltip="Negative conditioning to which guide keyframe info will be added"),
            io.Vae.Input("vae", tooltip="Video VAE used to encode the guide images"),
            io.Latent.Input("latent", tooltip="Video latent, guides are added to the end of this latent"),
            io.Image.Input("multi_input", tooltip="Batched images from MultiImageLoader"),
        ]
        
        inputs.append(io.Int.Input("num_images", default=1, min=0, max=50, step=1, display_name="images_loaded", tooltip="Select how many index/strength widgets to configure."))
        
        # New global settings widgets
        inputs.append(io.Combo.Input("insert_mode", options=["frames", "seconds", "fractional"], default="frames", tooltip="Select the method for determining insertion points."))
        inputs.append(io.Int.Input("frame_rate", default=24, min=1, max=120, step=1, tooltip="Video FPS (used for calculating second insertions)."))

        for i in range(1, 51):  # 1 to 50 images
            inputs.extend([
                io.Int.Input(
                    f"insert_frame_{i}",
                    default=0,
                    min=-9999,
                    max=9999,
                    step=1,
                    tooltip=f"Frame insert point for image {i} (in pixel space).",
                    optional=True,
                ),
                io.Float.Input(
                    f"insert_second_{i}",
                    default=0.0,
                    min=0.0,
                    max=9999.0,
                    step=0.1,
                    tooltip=f"Second insert point for image {i}.",
                    optional=True,
                ),
                io.Float.Input(
                    f"strength_{i}", 
                    default=1.0, 
                    min=0.0, 
                    max=1.0, 
                    step=0.01, 
                    tooltip=f"Strength for image {i}.",
                    optional=True,
                ),
            ])

        for i in range(1, 51):  # Appended to preserve legacy widgets_values order.
            inputs.extend([
                io.Float.Input(
                    f"insert_fraction_{i}",
                    default=0.0,
                    min=0.0,
                    max=1.0,
                    step=0.01,
                    tooltip=f"Fractional clip position for image {i}. 0.0 is the first frame, 1.0 is the final frame.",
                    optional=True,
                ),
            ])

        return io.Schema(
            node_id="LTXSequencer",
            display_name="LTX Sequencer",
            category="LTXVCustom",
            description="Add multiple guide images at specified frame indices, seconds, or fractional clip positions with strengths. Number of widgets is dynamically configured.",
            inputs=inputs,
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Conditioning.Output(display_name="negative"),
                io.Latent.Output(display_name="latent", tooltip="Video latent with added guides"),
            ],
        )

    @classmethod
    def execute(cls, positive, negative, vae, latent, multi_input, num_images, **kwargs) -> io.NodeOutput:
        scale_factors = vae.downscale_index_formula
        
        # Clone latents to avoid overwriting previous nodes' operations
        latent_image = latent["samples"].clone()
        
        # Helper logic to fetch or generate a noise mask
        if "noise_mask" in latent:
            noise_mask = latent["noise_mask"].clone()
        else:
            batch, _, latent_frames, latent_height, latent_width = latent_image.shape
            noise_mask = torch.ones(
                (batch, 1, latent_frames, 1, 1),
                dtype=torch.float32,
                device=latent_image.device,
            )

        _, _, latent_length, latent_height, latent_width = latent_image.shape
        batch_size = multi_input.shape[0] if multi_input is not None else 0
        temporal_upscale = scale_factors[0] if scale_factors else None

        # Retrieve selected insertion settings
        insert_mode = kwargs.get("insert_mode", "frames")
        frame_rate = kwargs.get("frame_rate", 24)
        _, initial_num_keyframes = get_keyframe_idxs(positive)
        initial_latent_count = max(1, latent_length - initial_num_keyframes)
        if callable(temporal_upscale):
            video_frame_count = temporal_upscale(initial_latent_count)
        elif isinstance(temporal_upscale, (int, float)):
            video_frame_count = max(1, int((initial_latent_count - 1) * temporal_upscale + 1))
        else:
            video_frame_count = initial_latent_count
        video_frame_count = max(1, int(video_frame_count))

        # Process inputs up to num_images, extracting dynamic frame/strength values from kwargs
        for i in range(1, num_images + 1):
            # Skip if this image index exceeds the batch
            if i > batch_size:
                continue

            img = multi_input[i-1:i]  # Extract the single image frame from the batch
            if img is None:
                continue

            # Calculate the final frame index based on the chosen mode
            f_idx = None
            if insert_mode == "frames":
                f_idx = kwargs.get(f"insert_frame_{i}")
            elif insert_mode == "seconds":
                sec = kwargs.get(f"insert_second_{i}")
                if sec is not None:
                    f_idx = int(sec * frame_rate)
            elif insert_mode == "fractional":
                fraction = kwargs.get(f"insert_fraction_{i}")
                if fraction is not None:
                    fraction = max(0.0, min(float(fraction), 1.0))
                    f_idx = -1 if fraction >= 1.0 else round(fraction * (video_frame_count - 1))

            if f_idx is None:
                continue
                
            strength = kwargs.get(f"strength_{i}", 1.0)

            # Execution logic mirrored from LTXVAddGuideMulti
            image_1, t = cls.encode(vae, latent_width, latent_height, img, scale_factors)

            _, current_num_keyframes = get_keyframe_idxs(positive)
            effective_latent_length = latent_length + current_num_keyframes
            frame_idx, latent_idx = cls.get_latent_index(positive, effective_latent_length, len(image_1), f_idx, scale_factors)
            assert latent_idx + t.shape[2] <= latent_length, "Conditioning frames exceed the length of the latent sequence."

            positive, negative, latent_image, noise_mask = cls.append_keyframe(
                positive,
                negative,
                frame_idx,
                latent_image,
                noise_mask,
                t,
                strength,
                scale_factors,
            )

        return io.NodeOutput(positive, negative, {"samples": latent_image, "noise_mask": noise_mask})
