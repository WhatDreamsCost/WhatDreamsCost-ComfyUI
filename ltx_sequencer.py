from comfy_extras.nodes_lt import get_noise_mask, LTXVAddGuide
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
        inputs.append(io.Combo.Input("insert_mode", options=["frames", "seconds"], default="frames", tooltip="Select the method for determining insertion points."))
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

        return io.Schema(
            node_id="LTXSequencer",
            display_name="LTX Sequencer",
            category="WhatDreamsCost",
            description="Add multiple guide images at specified frame indices or seconds with strengths. Number of widgets is dynamically configured.",
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

        # Retrieve selected insertion settings
        insert_mode = kwargs.get("insert_mode", "frames")
        frame_rate = kwargs.get("frame_rate", 24)

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

            if f_idx is None:
                continue
                
            strength = kwargs.get(f"strength_{i}", 1.0)

            # Execution logic mirrored from LTXVAddGuideMulti
            image_1, t = cls.encode(vae, latent_width, latent_height, img, scale_factors)

            frame_idx, latent_idx = cls.get_latent_index(positive, latent_length, len(image_1), f_idx, scale_factors)
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