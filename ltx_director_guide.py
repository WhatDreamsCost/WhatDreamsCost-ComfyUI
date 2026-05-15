from comfy_extras.nodes_lt import LTXVAddGuide
import torch
import comfy.utils
from comfy_api.latest import io
from .ltx_director import GuideData


class LTXDirectorGuide(LTXVAddGuide):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LTXDirectorGuide",
            display_name="LTX Director Guide",
            category="WhatDreamsCost",
            description=(
                "Applies guide images from a Prompt Relay Timeline node at the frame positions "
                "and strengths defined on the timeline. Connect guide_data from the timeline node."
            ),
            inputs=[
                io.Conditioning.Input("positive", tooltip="Positive conditioning to add guide keyframe info to."),
                io.Conditioning.Input("negative", tooltip="Negative conditioning to add guide keyframe info to."),
                io.Vae.Input("vae", tooltip="Video VAE used to encode the guide images."),
                io.Latent.Input("latent", tooltip="Video latent — guides are inserted into this latent."),
                GuideData.Input("guide_data", tooltip="Guide data produced by Prompt Relay Encode (Timeline)."),
                io.Float.Input("scale_by", default=1.0, min=0.01, max=8.0, step=0.01, tooltip="Scale the latent by this factor."),
                io.Combo.Input("upscale_method", options=["nearest-exact", "bilinear", "area", "bicubic", "bislerp"], default="bicubic", tooltip="Method used to upscale/downscale the latent."),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Conditioning.Output(display_name="negative"),
                io.Latent.Output(display_name="latent", tooltip="Video latent with guide frames applied."),
            ],
        )

    @classmethod
    def execute(cls, positive, negative, vae, latent, guide_data, scale_by=1.0, upscale_method="bicubic") -> io.NodeOutput:
        scale_factors = vae.downscale_index_formula

        # Clone latents to avoid mutating upstream nodes
        latent_image = latent["samples"].clone()

        if "noise_mask" in latent:
            noise_mask = latent["noise_mask"].clone()
        else:
            batch, _, latent_frames, latent_height, latent_width = latent_image.shape
            noise_mask = torch.ones(
                (batch, 1, latent_frames, 1, 1),
                dtype=torch.float32,
                device=latent_image.device,
            )

        # Apply scale factor if not 1.0
        if scale_by != 1.0:
            B, C, F, H, W = latent_image.shape
            width = round(W * scale_by)
            height = round(H * scale_by)
            
            # Reshape to 4D for common_upscale
            latent_4d = latent_image.permute(0, 2, 1, 3, 4).reshape(B * F, C, H, W)
            latent_resized_4d = comfy.utils.common_upscale(latent_4d, width, height, upscale_method, "disabled")
            latent_image = latent_resized_4d.reshape(B, F, C, height, width).permute(0, 2, 1, 3, 4)

            # Also resize noise mask if it's not a broadcasted mask
            if noise_mask.shape[-1] > 1 or noise_mask.shape[-2] > 1:
                mask_4d = noise_mask.permute(0, 2, 1, 3, 4).reshape(B * F, 1, H, W)
                mask_resized_4d = comfy.utils.common_upscale(mask_4d, width, height, upscale_method, "disabled")
                noise_mask = mask_resized_4d.reshape(B, F, 1, height, width).permute(0, 2, 1, 3, 4)

        _, _, latent_length, latent_height, latent_width = latent_image.shape

        images = guide_data.get("images", [])
        insert_frames = guide_data.get("insert_frames", [])
        strengths = guide_data.get("strengths", [])

        for idx, img_tensor in enumerate(images):
            f_idx = insert_frames[idx] if idx < len(insert_frames) else 0
            strength = strengths[idx] if idx < len(strengths) else 1.0

            image_1, t = cls.encode(vae, latent_width, latent_height, img_tensor, scale_factors)
            frame_idx, latent_idx = cls.get_latent_index(positive, latent_length, len(image_1), f_idx, scale_factors)

            assert latent_idx + t.shape[2] <= latent_length, (
                f"Guide image {idx + 1}: conditioning frames exceed the length of the latent sequence."
            )

            positive, negative, latent_image, noise_mask = cls.append_keyframe(
                positive, negative, frame_idx, latent_image, noise_mask, t, strength, scale_factors,
            )

        return io.NodeOutput(positive, negative, {"samples": latent_image, "noise_mask": noise_mask})