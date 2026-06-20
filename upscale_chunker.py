class ShezwUpscaleChunker:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "chunk_seconds": ("INT", {"default": 10, "min": 3, "max": 300, "step": 1}),
                "segment_prefix": ("STRING", {"default": "video/upscale-segment"}),
                "output_prefix": ("STRING", {"default": "video/upscale-merged"}),
                "cleanup_wait_seconds": ("INT", {"default": 12, "min": 0, "max": 60, "step": 1}),
                "start_segment_index": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "execute"
    CATEGORY = "shezw/director-pro"

    def execute(self, chunk_seconds=10, segment_prefix="video/upscale-segment", output_prefix="video/upscale-merged", cleanup_wait_seconds=12, start_segment_index=0):
        # Frontend-only orchestration node. The browser extension queues the
        # actual upscale graph repeatedly with VHS_LoadVideo skip/cap updates.
        return ()
