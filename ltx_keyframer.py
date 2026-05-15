import torch
import comfy.utils
from comfy_api.latest import io

class LTXKeyframer(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        inputs = [
            io.Vae.Input("vae", tooltip="Video VAE used to encode the images"),
            io.Latent.Input("latent", tooltip="Video latent to insert images into"),
            io.Image.Input("multi_input", tooltip="Batched images from MultiImageLoader"),
        ]
        
        inputs.append(io.Int.Input("num_images", default=1, min=0, max=50, step=1, display_name="images_loaded", tooltip="Select how many index/strength widgets to configure."))

        for i in range(1, 51):  # 1 to 50 images
            inputs.extend([
                io.Int.Input(
                    f"insert_frame_{i}",
                    default=0,
                    min=-9999,
                    max=9999,
                    step=1,
                    tooltip=f"Frame insert_frame for image {i} (in pixel space).",
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
            node_id="LTXKeyframer",
            display_name="LTX Keyframer",
            category="WhatDreamsCost",
            description="Replaces video latent frames with the encoded input images. Number of widgets is dynamically configured.",
            inputs=inputs,
            outputs=[
                io.Latent.Output(display_name="latent", tooltip="The video latent with the images inserted and latent noise mask updated."),
            ],
        )

    @classmethod
    def execute(cls, vae, latent, multi_input, num_images, **kwargs) -> io.NodeOutput:

        samples = latent["samples"].clone()
        scale_factors = vae.downscale_index_formula
        _, height_scale_factor, width_scale_factor = scale_factors

        batch, _, latent_frames, latent_height, latent_width = samples.shape
        width = latent_width * width_scale_factor
        height = latent_height * height_scale_factor

        # Get existing noise mask if present, otherwise create new one
        if "noise_mask" in latent:
            conditioning_latent_frames_mask = latent["noise_mask"].clone()
        else:
            conditioning_latent_frames_mask = torch.ones(
                (batch, 1, latent_frames, 1, 1),
                dtype=torch.float32,
                device=samples.device,
            )

        batch_size = multi_input.shape[0] if multi_input is not None else 0

        # We process inputs up to num_images, extracting values from kwargs
        for i in range(1, num_images + 1):
            # Skip if this image index exceeds the batch
            if i > batch_size:
                continue

            image = multi_input[i-1:i]  # Extract the single image frame from the batch
            if image is None:
                continue

            insert_frame = kwargs.get(f"insert_frame_{i}")
            if insert_frame is None:
                continue
            strength = kwargs.get(f"strength_{i}", 1.0)

            if image.shape[1] != height or image.shape[2] != width:
                pixels = comfy.utils.common_upscale(image.movedim(-1, 1), width, height, "bilinear", "center").movedim(1, -1)
            else:
                pixels = image
            encode_pixels = pixels[:, :, :, :3]
            t = vae.encode(encode_pixels)

            # Convert pixel frame insert_frame to latent insert_frame
            time_scale_factor = scale_factors[0]

            # Handle negative indexing in pixel space
            pixel_frame_count = (latent_frames - 1) * time_scale_factor + 1
            if insert_frame < 0:
                insert_frame = pixel_frame_count + insert_frame

            # Convert to latent insert_frame
            latent_idx = insert_frame // time_scale_factor

            # Clamp to valid range
            latent_idx = max(0, min(latent_idx, latent_frames - 1))

            # Calculate end insert_frame, ensuring we don't exceed latent_frames
            end_index = min(latent_idx + t.shape[2], latent_frames)

            # Replace samples at the specified insert_frame range
            samples[:, :, latent_idx:end_index] = t[:, :, :end_index - latent_idx]

            # Update mask at the specified insert_frame range
            conditioning_latent_frames_mask[:, :, latent_idx:end_index] = 1.0 - strength

        return io.NodeOutput({"samples": samples, "noise_mask": conditioning_latent_frames_mask})