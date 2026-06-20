import { app } from "../../scripts/app.js";

const SHEZW_IC_GUIDE_WIDGET_NAMES = [
  "latent_downscale_factor",
  "default_strength",
  "crop",
  "use_tiled_encode",
  "tile_size",
  "tile_overlap",
  "reference_strength",
  "max_references",
];

function clampNumber(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function sanitizeShezwICGuideWidgets(node) {
  const widgets = node.widgets || [];
  const get = (name) => widgets.find((w) => w.name === name);
  const values = SHEZW_IC_GUIDE_WIDGET_NAMES.map((name) => get(name)?.value);

  // Legacy workflows saved before latent_downscale_factor was inserted.
  // Old order:
  //   default_strength, crop, use_tiled_encode, tile_size, tile_overlap,
  //   reference_strength, max_references
  // New order prepends latent_downscale_factor.
  const looksLegacy =
    values.length >= 8 &&
    typeof values[1] === "string" &&
    (values[1] === "disabled" || values[1] === "center") &&
    typeof values[0] === "number" &&
    typeof values[2] === "boolean";

  let next = values.slice();
  if (looksLegacy) {
    next = [1.0, ...values.slice(0, 7)];
  }

  const normalized = {
    latent_downscale_factor: clampNumber(next[0], 1.0, 1.0, 10.0),
    default_strength: clampNumber(next[1], 0.0, 0.0, 1.0),
    crop: next[2] === "center" ? "center" : "disabled",
    use_tiled_encode: !!next[3],
    tile_size: clampNumber(next[4], 256, 64, 512),
    tile_overlap: clampNumber(next[5], 64, 16, 256),
    reference_strength: clampNumber(next[6], 0.35, 0.0, 1.0),
    max_references: clampNumber(next[7], 8, 0, 8),
  };

  normalized.tile_size = Math.round(normalized.tile_size / 32) * 32;
  normalized.tile_overlap = Math.round(normalized.tile_overlap / 16) * 16;
  normalized.tile_overlap = Math.min(normalized.tile_overlap, normalized.tile_size);
  normalized.max_references = Math.round(normalized.max_references);

  let changed = looksLegacy;
  for (const [name, value] of Object.entries(normalized)) {
    const widget = get(name);
    if (!widget) continue;
    if (widget.value !== value) {
      widget.value = value;
      changed = true;
    }
  }

  if (changed && app.graph) {
    app.graph.setDirtyCanvas(true, true);
  }
}

app.registerExtension({
  name: "Comfy.LTXDirectorGuide",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === "ShezwDirectorICLoRAGuide") {
      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const out = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
        setTimeout(() => sanitizeShezwICGuideWidgets(this), 0);
        return out;
      };

      const onConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        const out = onConfigure ? onConfigure.apply(this, arguments) : undefined;
        setTimeout(() => sanitizeShezwICGuideWidgets(this), 0);
        return out;
      };
    }
  },
});
