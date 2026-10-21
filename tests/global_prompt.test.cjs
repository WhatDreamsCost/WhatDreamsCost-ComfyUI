const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const app = { registerExtension() {}, graph: {} };
const context = vm.createContext({
  window: { comfyAPI: { app: { app }, api: { api: {} } }, app },
  document: { getElementById: () => ({}) },
});
vm.runInContext(readFileSync(join(__dirname, "../js/ltx_director.js"), "utf8"), context);
const TimelineEditor = vm.runInContext("TimelineEditor", context);

function createEditor(source, stale = "STALE") {
  app.graph = { links: { 0: { origin_id: 1 } }, getNodeById: () => source };
  const editor = Object.create(TimelineEditor.prototype);
  editor.node = {
    inputs: [{ name: "global_prompt", link: source ? 0 : null }],
    widgets: [{ name: "global_prompt", value: stale }],
    properties: { global_prompt: stale },
    getInputNode: () => source,
    setDirtyCanvas() {},
  };
  editor.timeline = {
    global_prompt: stale, retake_global_prompt: "RETAKE_STALE", retakePrompt: "EDIT_REGION",
    segments: [{ id: "image", prompt: "LOCAL", type: "image" }],
    motionSegments: [{ id: "motion" }], audioSegments: [],
  };
  editor.retakeMode = false;
  editor.selectionType = "image";
  editor.selectedIndex = 0;
  for (const name of [
    "globalPromptInput", "promptInput", "promptWrapper", "segmentPromptLabel",
    "strengthRow", "strengthLabel", "strengthValue", "vidStrLabel", "vidStrValue",
    "vidAttnLabel", "vidAttnValue", "audioInfoArea", "motionInfoArea",
  ]) editor[name] = { value: stale, style: {}, readOnly: false };
  return editor;
}

function createSource(value = "SOURCE") {
  return { widgets: [{ value, callback() { assert.fail("Called upstream callback"); } }],
    onWidgetChanged() { assert.fail("Changed upstream widget"); } };
}

test("restoring two Directors cannot overwrite their shared source", () => {
  const source = createSource();
  for (const stale of ["STALE_A", "STALE_B"]) {
    const editor = createEditor(source, stale);
    editor.globalPromptInput.value = "";
    editor.updateRetakeUIState();
    assert.equal(source.widgets[0].value, "SOURCE");
    assert.equal(editor.globalPromptInput.value, "SOURCE");
    assert.equal(editor.timeline.global_prompt, "SOURCE");
    assert.equal(editor.globalPromptInput.readOnly, true);
    assert.equal(editor.promptInput.readOnly, false);
  }
});

test("connected global and IC-LoRA editors follow the source and reject local writes", () => {
  const source = createSource();
  const editor = createEditor(source);
  editor.selectionType = "motion";
  editor.updateUIFromSelection();
  assert.equal(editor.globalPromptInput.readOnly, true);
  assert.equal(editor.promptInput.readOnly, true);
  editor.syncGlobalPrompt("LOCAL_WRITE");
  assert.equal(source.widgets[0].value, "SOURCE");
  assert.equal(editor.promptInput.value, "SOURCE");
  source.widgets[0].value = "UPDATED_SOURCE";
  editor.updateGlobalPromptConnection();
  assert.equal(editor.globalPromptInput.value, "UPDATED_SOURCE");
  assert.equal(editor.promptInput.value, "UPDATED_SOURCE");
});

test("local segment and retake-region prompts stay editable", () => {
  const editor = createEditor(createSource());
  editor.selectionType = "motion";
  editor.updateUIFromSelection();
  editor.selectionType = "image";
  editor.updateUIFromSelection();
  assert.equal(editor.promptInput.readOnly, false);
  assert.equal(editor.promptInput.value, "LOCAL");
  editor.retakeMode = true;
  editor.updateRetakeUIState();
  assert.equal(editor.globalPromptInput.readOnly, true);
  assert.equal(editor.timeline.retake_global_prompt, "SOURCE");
  assert.equal(editor.promptInput.readOnly, false);
  assert.equal(editor.promptInput.value, "EDIT_REGION");
});

test("disconnecting unlocks both global editors and retains the displayed text", () => {
  const source = createSource();
  const editor = createEditor(source);
  editor.selectionType = "motion";
  editor.updateUIFromSelection();
  editor.node.inputs[0].link = null;
  editor.updateUIFromSelection();
  assert.equal(editor.globalPromptInput.readOnly, false);
  assert.equal(editor.promptInput.readOnly, false);
  assert.equal(editor.globalPromptInput.value, "SOURCE");
  editor.syncGlobalPrompt("LOCAL_EDIT");
  assert.equal(editor.node.widgets[0].value, "LOCAL_EDIT");
  assert.equal(editor.timeline.global_prompt, "LOCAL_EDIT");
  assert.equal(editor.promptInput.value, "LOCAL_EDIT");
  assert.equal(source.widgets[0].value, "SOURCE");
});

test("empty or unavailable external text never restores a stale local prompt", () => {
  for (const source of [createSource(""), { widgets: [] }, { widgets: [{ value: 123 }] }]) {
    const editor = createEditor(source);
    editor.updateUIFromSelection();
    editor.syncGlobalPrompt("IMPORTED_PROMPT");
    assert.equal(editor.globalPromptInput.readOnly, true);
    assert.equal(editor.globalPromptInput.value, "");
    assert.equal(editor.timeline.global_prompt, "");
  }
  const editor = createEditor(null);
  editor.node.inputs[0].link = 1;
  editor.updateUIFromSelection();
  assert.equal(editor.globalPromptInput.readOnly, true);
  assert.equal(editor.globalPromptInput.value, "");
});

test("unconnected normal and retake prompts restore independently", () => {
  const editor = createEditor(null, "NORMAL");
  editor.globalPromptInput.value = "";
  editor.updateRetakeUIState();
  assert.equal(editor.globalPromptInput.value, "NORMAL");
  editor.retakeMode = true;
  editor.updateRetakeUIState();
  assert.equal(editor.globalPromptInput.value, "RETAKE_STALE");
  assert.equal(editor.promptInput.value, "EDIT_REGION");
  editor.retakeMode = false;
  editor.updateRetakeUIState();
  assert.equal(editor.globalPromptInput.value, "NORMAL");
  assert.equal(editor.globalPromptInput.readOnly, false);
});
