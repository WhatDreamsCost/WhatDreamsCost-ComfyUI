import torch
import torch.nn.functional as F
import numpy as np
from PIL import Image, ImageOps
import os
import folder_paths
import io
import comfy.utils

class MultiImageLoader:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image_paths": ("STRING", {"default": "", "multiline": True}),
                "width": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1}),
                "height": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1}),
                "interpolation": (["lanczos", "nearest", "bilinear", "bicubic", "area", "nearest-exact"],),
                "resize_method": (["keep proportion", "stretch", "pad", "crop"],),
                "multiple_of": ("INT", {"default": 32, "min": 0, "max": 512, "step": 1}),
                "img_compression": ("INT", {"default": 18, "min": 0, "max": 100, "step": 1}),
            },
        }

    # Added "IMAGE" at the beginning for multi_output + 50 individual outputs = 51 outputs
    RETURN_TYPES = ("IMAGE",) * 51
    RETURN_NAMES = ("multi_output",) + tuple(f"image_{i+1}" for i in range(50))
    FUNCTION = "load_images"
    CATEGORY = "image"

    def resize_image(self, image, width, height, resize_method="keep proportion", interpolation="nearest", multiple_of=0):
        MAX_RESOLUTION = 8192
        _, oh, ow, _ = image.shape
        x = y = x2 = y2 = 0
        pad_left = pad_right = pad_top = pad_bottom = 0

        if multiple_of > 1:
            width = width - (width % multiple_of)
            height = height - (height % multiple_of)

        if resize_method == 'keep proportion' or resize_method == 'pad':
            if width == 0 and oh < height:
                width = MAX_RESOLUTION
            elif width == 0 and oh >= height:
                width = ow

            if height == 0 and ow < width:
                height = MAX_RESOLUTION
            elif height == 0 and ow >= width:
                height = oh

            ratio = min(width / ow, height / oh)
            new_width = round(ow * ratio)
            new_height = round(oh * ratio)

            if resize_method == 'pad':
                pad_left = (width - new_width) // 2
                pad_right = width - new_width - pad_left
                pad_top = (height - new_height) // 2
                pad_bottom = height - new_height - pad_top

            width = new_width
            height = new_height
            
        elif resize_method == 'crop':
            width = width if width > 0 else ow
            height = height if height > 0 else oh

            ratio = max(width / ow, height / oh)
            new_width = round(ow * ratio)
            new_height = round(oh * ratio)
            x = (new_width - width) // 2
            y = (new_height - height) // 2
            x2 = x + width
            y2 = y + height
            if x2 > new_width:
                x -= (x2 - new_width)
            if x < 0:
                x = 0
            if y2 > new_height:
                y -= (y2 - new_height)
            if y < 0:
                y = 0
            width = new_width
            height = new_height
            
        else:
            width = width if width > 0 else ow
            height = height if height > 0 else oh

        # Always apply resize logic
        outputs = image.permute(0, 3, 1, 2)

        if interpolation == "lanczos":
            outputs = comfy.utils.lanczos(outputs, width, height)
        else:
            outputs = F.interpolate(outputs, size=(height, width), mode=interpolation)

        if resize_method == 'pad':
            if pad_left > 0 or pad_right > 0 or pad_top > 0 or pad_bottom > 0:
                outputs = F.pad(outputs, (pad_left, pad_right, pad_top, pad_bottom), value=0)

        outputs = outputs.permute(0, 2, 3, 1)

        if resize_method == 'crop':
            if x > 0 or y > 0 or x2 > 0 or y2 > 0:
                outputs = outputs[:, y:y2, x:x2, :]

        if multiple_of > 1 and (outputs.shape[2] % multiple_of != 0 or outputs.shape[1] % multiple_of != 0):
            width = outputs.shape[2]
            height = outputs.shape[1]
            x = (width % multiple_of) // 2
            y = (height % multiple_of) // 2
            x2 = width - ((width % multiple_of) - x)
            y2 = height - ((height % multiple_of) - y)
            outputs = outputs[:, y:y2, x:x2, :]
        
        outputs = torch.clamp(outputs, 0, 1)

        return outputs

    def load_images(self, image_paths, width, height, interpolation, resize_method, multiple_of, img_compression):
        results = []
        valid_paths = [p.strip() for p in image_paths.split("\n") if p.strip()]

        for path in valid_paths:
            try:
                # Resolve full path
                full_path = path
                if not os.path.exists(full_path):
                    full_path = os.path.join(folder_paths.get_input_directory(), path)
                    
                if not os.path.exists(full_path):
                    print(f"Warning: Image path not found: {path}")
                    continue

                # Load image
                image = Image.open(full_path)
                image = ImageOps.exif_transpose(image)
                image = image.convert("RGB")

                # Convert to Torch Tensor to prepare for Advanced Resize Logic
                image_np = np.array(image).astype(np.float32) / 255.0
                image_tensor = torch.from_numpy(image_np)[None,]

                # Apply Advanced Resize
                image_tensor = self.resize_image(image_tensor, width, height, resize_method, interpolation, multiple_of)

                # Compression (Applied after resize to accurately maintain the effect)
                if img_compression > 0:
                    img_np = (image_tensor[0].numpy() * 255).clip(0, 255).astype(np.uint8)
                    img_pil = Image.fromarray(img_np)
                    img_byte_arr = io.BytesIO()
                    img_pil.save(img_byte_arr, format="JPEG", quality=max(1, 100 - img_compression))
                    img_pil = Image.open(img_byte_arr)
                    image_tensor = torch.from_numpy(np.array(img_pil).astype(np.float32) / 255.0)[None,]

                results.append(image_tensor)
            except Exception as e:
                print(f"Error loading {path}: {e}")

        # Combine all successfully loaded images into a single batched tensor for multi_output
        if len(results) > 0:
            # Safety Check: Advanced resize methods might output differently sized tensors (e.g., 'keep proportion')
            first_shape = results[0].shape
            all_same_shape = all(r.shape == first_shape for r in results)
            
            if all_same_shape:
                multi_output = torch.cat(results, dim=0)
            else:
                print("MultiImageLoader Warning: Images have different dimensions due to resize settings. Cannot batch into multi_output. Outputting zero tensor for the batch, but individual output nodes will still work fine.")
                multi_output = torch.zeros((1, 64, 64, 3))
        else:
            # Fallback empty tensor if no valid paths
            multi_output = torch.zeros((1, 64, 64, 3))
            results = [multi_output]

        # Pad individual outputs exactly to length 50 as defined in RETURN_TYPES
        padded_results = results + [torch.zeros((1, 64, 64, 3))] * (50 - len(results))

        # Return the multi batch output first, followed by the individual padded items
        return (multi_output, *padded_results[:50])