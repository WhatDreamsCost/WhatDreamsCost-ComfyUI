"""Run with ComfyUI's Python: python tests/test_guide_attention.py (CPU only)."""
import asyncio
import importlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO.parent.parent))

from comfy.cli_args import args

args.cpu = True

import nodes
import execution
import torch
from server import PromptServer
from comfy.ldm.lightricks.model import LTXVModel
from comfy.ldm.lightricks.symmetric_patchifier import SymmetricPatchifier
from comfy_extras.nodes_lt_keyframes import (
    LTXVAddGeneratedKeyframes,
    LTXVSeparateGeneratedKeyframes,
)


def setUpModule():
    global guide_module
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    PromptServer(loop, execution.NoAssets(args))
    assert loop.run_until_complete(nodes.load_custom_node(str(REPO), module_parent="custom_nodes"))
    guide_module = importlib.import_module(nodes.NODE_CLASS_MAPPINGS["LTXDirectorGuide"].__module__)
    loop.close()


class TinyVAE:
    downscale_index_formula = (8, 32, 32)

    def encode(self, pixels):
        return torch.ones(1, 128, (pixels.shape[0] - 1) // 8 + 1,
                          pixels.shape[1] // 32, pixels.shape[2] // 32)


class TinyLTXV(LTXVModel):
    """Exercise native input processing without loading transformer weights."""
    def __init__(self):
        torch.nn.Module.__init__(self)
        self.patchifier = SymmetricPatchifier(1, start_end=True)
        self.patchify_proj = torch.nn.Identity()
        self.vae_scale_factors = TinyVAE.downscale_index_formula
        self.causal_temporal_positioning = True
        self.keyframes_abs_pos_embedding = None


class GuideAttentionTests(unittest.TestCase):
    def setUp(self):
        self.positive = [[torch.zeros(1, 1, 1), {}]]
        self.negative = [[torch.zeros(1, 1, 1), {}]]
        self.latent = {"samples": torch.zeros(1, 128, 4, 2, 2)}
        self.image = torch.ones(1, 64, 64, 3)
        self.vae = TinyVAE()

    def run_guide(self, images=None, **kwargs):
        data = {"images": images or [], "insert_frames": [0, 8], "strengths": [0.75, 1.0]}
        return guide_module.LTXDirectorGuide.execute(
            self.positive, self.negative, self.vae, self.latent, data, **kwargs)

    def assert_partition(self, positive, negative):
        for cond in (positive, negative):
            meta = cond[0][1]
            self.assertEqual(sum(e["pre_filter_count"] for e in meta["guide_attention_entries"]),
                             meta["keyframe_idxs"].shape[2])

    def test_image_then_generated_keyframes_and_crop(self):
        positive, negative, latent, _, _ = self.run_guide([self.image])
        self.assert_partition(positive, negative)
        entry = positive[0][1]["guide_attention_entries"][0]
        self.assertEqual(entry["pre_filter_count"], 4)
        self.assertEqual(entry["latent_shape"], [1, 2, 2])
        self.assertEqual(entry["strength"], 1.0)
        self.assertEqual(latent["noise_mask"][0, 0, -1, 0, 0].item(), 0.25)
        positive, negative, latent = LTXVAddGeneratedKeyframes.execute(
            positive, negative, self.vae, latent, frame_indices="16").result
        self.assert_partition(positive, negative)
        self.assertEqual([e["pre_filter_count"] for e in positive[0][1]["guide_attention_entries"]], [4, 4])
        positive, negative, latent, keyframes = LTXVSeparateGeneratedKeyframes.execute(
            positive, negative, latent).result
        self.assert_partition(positive, negative)
        self.assertEqual(keyframes["samples"].shape, (1, 128, 1, 2, 2))
        positive, negative, latent = guide_module.LTXDirectorCropGuides().execute(positive, negative, latent)
        torch.testing.assert_close(latent["samples"], self.latent["samples"])
        self.assertIsNone(positive[0][1]["guide_attention_entries"])

    def test_no_lora_uses_neutral_attention(self):
        positive, negative, _, _, _ = self.run_guide([self.image], image_attention_strength=0.2)
        self.assert_partition(positive, negative)
        self.assertEqual(positive[0][1]["guide_attention_entries"][0]["strength"], 1.0)

    def test_native_model_accepts_entries_and_reproduces_old_failure(self):
        positive, negative, latent, _, _ = self.run_guide([self.image])
        positive, negative, latent = LTXVAddGeneratedKeyframes.execute(
            positive, negative, self.vae, latent, frame_indices="16").result
        model = TinyLTXV()
        meta = positive[0][1]
        denoise_mask = latent["noise_mask"].expand_as(latent["samples"])
        tokens, _, processed = model._process_input(
            latent["samples"], meta["keyframe_idxs"], denoise_mask,
            guide_attention_entries=meta["guide_attention_entries"])
        self.assertEqual([e["surviving_count"] for e in processed["resolved_guide_entries"]], [4, 4])
        self.assertIsNone(model._build_guide_self_attention_mask(tokens, {}, processed))
        with self.assertRaisesRegex(ValueError, r"guide pre_filter_counts \(4\) != keyframe grid mask length \(8\)"):
            model._process_input(latent["samples"], meta["keyframe_idxs"], denoise_mask,
                                 guide_attention_entries=meta["guide_attention_entries"][1:])

    def test_lora_preserves_attention_strength(self):
        model = object()
        with patch.object(guide_module, "_load_lora_model_only", return_value=(model, 1.0)):
            positive, negative, _, result_model, _ = self.run_guide(
                [self.image], model=model, ic_lora_name="test.safetensors", image_attention_strength=0.35)
        self.assertIs(result_model, model)
        self.assert_partition(positive, negative)
        self.assertEqual(positive[0][1]["guide_attention_entries"][0]["strength"], 0.35)

    def test_motion_without_lora_then_generated_keyframes(self):
        motion = {"segments": [{"videoFile": "test.mp4", "start": 0, "length": 9,
                                "videoStrength": 1.0, "videoAttentionStrength": 0.3}]}
        with patch.object(guide_module, "_load_motion_video_frames", return_value=self.image.repeat(9, 1, 1, 1)):
            positive, negative, latent, _, _ = self.run_guide(motion_guide_data=motion)
        self.assert_partition(positive, negative)
        self.assertEqual(positive[0][1]["guide_attention_entries"][0]["strength"], 1.0)
        positive, negative, _ = LTXVAddGeneratedKeyframes.execute(
            positive, negative, self.vae, latent, frame_indices="16").result
        self.assert_partition(positive, negative)

    def test_motion_lora_preserves_attention_strength(self):
        model = object()
        motion = {"segments": [{"videoFile": "test.mp4", "start": 0, "length": 9,
                                "videoStrength": 1.0, "videoAttentionStrength": 0.3}]}
        with patch.object(guide_module, "_load_lora_model_only", return_value=(model, 1.0)), \
             patch.object(guide_module, "_load_motion_video_frames", return_value=self.image.repeat(9, 1, 1, 1)):
            positive, negative, _, _, _ = self.run_guide(
                motion_guide_data=motion, model=model, ic_lora_name="test.safetensors")
        self.assert_partition(positive, negative)
        self.assertEqual(positive[0][1]["guide_attention_entries"][0]["strength"], 0.3)

    def test_no_guides_does_not_create_entries(self):
        positive, negative, latent, _, _ = self.run_guide()
        self.assertNotIn("guide_attention_entries", positive[0][1])
        self.assertNotIn("guide_attention_entries", negative[0][1])
        torch.testing.assert_close(latent["samples"], self.latent["samples"])

    def test_multiple_images_preserve_entry_order(self):
        positive, negative, _, _, _ = self.run_guide([self.image, self.image])
        self.assert_partition(positive, negative)
        self.assertEqual([e["pre_filter_count"] for e in positive[0][1]["guide_attention_entries"]], [4, 4])


if __name__ == "__main__":
    unittest.main(verbosity=2)
