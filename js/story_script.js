import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function getWidget(node, name) {
  return node?.widgets?.find((w) => w.name === name);
}

function widgetValue(node, name, fallback = "") {
  const widget = getWidget(node, name);
  return widget ? widget.value : fallback;
}

function setWidgetValue(node, name, value, options = {}) {
  const widget = getWidget(node, name);
  if (!widget) return false;
  widget.value = value;
  if (!options.silent && typeof widget.callback === "function") widget.callback(value);
  return true;
}

function setWidgetLabel(node, name, label) {
  const widget = getWidget(node, name);
  if (!widget) return false;
  widget.label = label;
  return true;
}

function setNodeIOLabel(node, name, label) {
  for (const io of [...(node?.inputs || []), ...(node?.outputs || [])]) {
    if (io?.name !== name) continue;
    io.label = label;
    io.localized_name = label;
  }
}

function nodeProp(node, name, fallback = "") {
  if (node?.properties && node.properties[name] !== undefined) return node.properties[name];
  return widgetValue(node, name, fallback);
}

function setNodeProp(node, name, value) {
  if (!node) return;
  if (!node.properties) node.properties = {};
  node.properties[name] = value;
}

function parseJson(text, fallback) {
  try {
    const value = typeof text === "string" ? JSON.parse(text || "") : text;
    return value && typeof value === "object" ? value : fallback;
  } catch (_) {
    return fallback;
  }
}

const WORKFLOW_WIDGET_NAMES = {
  LTXDirector: [
    "global_prompt",
    "duration_frames",
    "duration_seconds",
    "timeline_data",
    "local_prompts",
    "segment_lengths",
    "epsilon",
    "guide_strength",
    "use_custom_audio",
    "frame_rate",
    "display_mode",
    "custom_width",
    "custom_height",
    "resize_method",
    "divisible_by",
    "img_compression",
    "metadata",
  ],
  LoadVideoUI: [
    "video",
    "start_time",
    "end_time",
    "duration",
    "start_frame",
    "end_frame",
    "duration_frames",
    "resize_method",
    "custom_width",
    "custom_height",
    "frame_rate",
    "display_mode",
    "crop_x",
    "crop_y",
    "crop_w",
    "crop_h",
  ],
  LoadAudioUI: ["audio", "start_time", "end_time", "duration", "display_mode"],
  ShezwUpscaleChunker: [
    "chunk_seconds",
    "segment_prefix",
    "output_prefix",
    "cleanup_wait_seconds",
    "start_segment_index",
  ],
  ShezwGlobalPrefix: ["global_prefix"],
  ShezwMetaInfo: ["global_prefix"],
};

const UI_LANGUAGES = {
  en: "English",
  zh: "中文",
};

const I18N = {
  en: {
    globalPrefix: "Global Prefix",
    prefixId: "Prefix-Id",
    storyScript: "Story script",
    language: "Language",
    gen: "Gen",
    apply: "Apply",
    import: "Import",
    store: "Store",
    export: "Export",
    confirm: "Confirm",
    applied: "Applied",
    importedFrom: "Imported from",
    prefixEmpty: "Prefix is empty",
    importFailed: "Import failed",
    storeFailed: "Store failed",
    exportFailed: "Export failed",
    stored: "Stored",
    exported: "Exported",
    downloaded: "Downloaded",
    updatedImportFile: "Updated import file",
  },
  zh: {
    globalPrefix: "全局前缀",
    prefixId: "前缀 ID",
    storyScript: "故事脚本",
    language: "语言",
    gen: "生成",
    apply: "应用",
    import: "导入",
    store: "存储",
    export: "导出",
    confirm: "确认",
    applied: "已应用",
    importedFrom: "导入自",
    prefixEmpty: "Prefix 为空",
    importFailed: "导入失败",
    storeFailed: "存储失败",
    exportFailed: "导出失败",
    stored: "已存储",
    exported: "已导出",
    downloaded: "已下载",
    updatedImportFile: "已更新导入文件",
  },
};

function normalizeUILanguage(value) {
  return Object.prototype.hasOwnProperty.call(UI_LANGUAGES, value) ? value : "en";
}

function getUILanguage() {
  return normalizeUILanguage(`${nodeProp(getStoryNode(), "ui_language", "en") || "en"}`.trim());
}

function t(key, fallback = key) {
  const lang = getUILanguage();
  return I18N[lang]?.[key] || I18N.en[key] || fallback;
}

function setUILanguage(lang) {
  const next = normalizeUILanguage(lang);
  const storyNode = getStoryNode();
  if (storyNode) {
    setNodeProp(storyNode, "ui_language", next);
    setWidgetValue(storyNode, "ui_language", next, { silent: true });
  }
  window.shezwCurrentUILanguage = next;
  window.dispatchEvent(new CustomEvent("shezw-ui-language-change", { detail: { language: next } }));
  app.graph?.setDirtyCanvas(true, true);
  return next;
}

window.shezwGetUILanguage = getUILanguage;
window.shezwSetUILanguage = setUILanguage;
window.shezwT = (key, fallback = key) => t(key, fallback);

function uniqueNames(names) {
  return [...new Set((names || []).filter(Boolean))];
}

function getStoryNode() {
  return (app?.graph?._nodes || []).find((node) => node.type === "ShezwMetaInfo")
    || (app?.graph?._nodes || []).find((node) => node.type === "ShezwStoryScript");
}

function getGlobalPrefix() {
  if (typeof window.shezwGetGlobalPrefix === "function") return window.shezwGetGlobalPrefix();
  const node = (app?.graph?._nodes || []).find((n) => n.type === "ShezwMetaInfo")
    || (app?.graph?._nodes || []).find((n) => n.type === "ShezwGlobalPrefix");
  return `${widgetValue(node, "global_prefix", "") || ""}`.trim();
}

let activeStoryScriptFileHandle = null;
let activeStoryScriptFileName = "";

function getAllowedStruct(storyNode) {
  const raw = nodeProp(storyNode, "ss_struct", "{}");
  const parsed = parseJson(raw, {});
  return mergeStructWithKnownWidgets(Array.isArray(parsed.fields) ? parsed : { fields: [] });
}

function mergeStructWithKnownWidgets(struct) {
  const next = {
    ...(struct || {}),
    fields: Array.isArray(struct?.fields) ? [...struct.fields] : [],
  };
  for (const [nodeType, widgets] of Object.entries(WORKFLOW_WIDGET_NAMES)) {
    const existing = next.fields.find((field) => field.node_type === nodeType && !field.node_id && !field.title);
    if (existing) {
      existing.widgets = uniqueNames([...(existing.widgets || []), ...widgets]);
    } else {
      next.fields.push({ node_type: nodeType, widgets: uniqueNames(widgets) });
    }
  }
  return next;
}

function stripStoryScriptStruct(story) {
  if (!story || typeof story !== "object") return story;
  const { ss_struct, ...clean } = story;
  return clean;
}

function getAllowedWidgets(struct, node) {
  const entries = struct.fields.filter((field) => {
    if (field.node_id !== undefined && String(field.node_id) !== String(node.id)) return false;
    if (field.node_type && field.node_type !== node.type) return false;
    if (field.title && field.title !== node.title) return false;
    return field.widgets || field.widget;
  });
  const names = new Set();
  for (const name of WORKFLOW_WIDGET_NAMES[node?.type] || []) names.add(name);
  for (const entry of entries) {
    if (entry.widget) names.add(entry.widget);
    for (const name of entry.widgets || []) names.add(name);
  }
  return names;
}

function looksLikeLongAutoWorkflow(data) {
  if (!data || !Array.isArray(data.nodes)) return false;
  const widgetValues = (node) => {
    const values = node.widgets_values || [];
    if (Array.isArray(values)) return values;
    if (values && typeof values === "object") return Object.values(values);
    return [];
  };
  const haystack = [
    data.id,
    data.name,
    data.title,
    ...(data.nodes || []).flatMap((node) => [node.type, node.title, ...widgetValues(node)]),
  ].join(" ").toLowerCase();
  return haystack.includes("long-auto")
    || haystack.includes("long_auto")
    || haystack.includes("long auto")
    || haystack.includes("long_auto_segment_template");
}

function normalizeLegacyTimelineData(value, sourceWorkflow) {
  const timeline = parseJson(value, null);
  if (!timeline || !looksLikeLongAutoWorkflow(sourceWorkflow)) return value;
  for (const key of ["segments", "audioSegments", "cameraSegments", "controlSegments", "promptSegments", "referenceImages", "cutSegments"]) {
    if (!Array.isArray(timeline[key])) timeline[key] = [];
  }
  const meta = timeline.meta && typeof timeline.meta === "object" ? timeline.meta : {};
  const { tailFramePrefix, segmentVideoPrefix, ...keptMeta } = meta;
  timeline.meta = {
    longAuto: true,
    activeSegmentIndex: 0,
    maxSegmentSeconds: 15,
    keyframeToleranceSeconds: 0.25,
    directQueueMode: "active_segment_only",
    queueAllByDefault: true,
    autoCut: true,
    manualCutToleranceSeconds: 0.25,
    ...keptMeta,
    tailFramePrefix: "video/ltx-director-pro-tail-frame",
    segmentVideoPrefix: "video/ltx-director-pro-segment",
  };
  return JSON.stringify(timeline);
}

function workflowWidgetNames(workflowNode) {
  const knownNames = WORKFLOW_WIDGET_NAMES[workflowNode.type] || [];
  if (knownNames.length) return knownNames;
  const inputNames = (workflowNode.inputs || [])
    .map((input) => input?.widget?.name)
    .filter(Boolean);
  if (inputNames.length) return inputNames;
  return [];
}

function workflowWidgetValue(workflowNode, names, index, name) {
  const values = workflowNode.widgets_values || [];
  if (Array.isArray(values)) return values[index];
  if (values && typeof values === "object") return values[name];
  return undefined;
}

function storyScriptFromLegacyWorkflow(data, storyNode) {
  if (!data || !Array.isArray(data.nodes)) return null;
  const struct = getAllowedStruct(storyNode);
  const fields = Array.isArray(struct.fields) ? struct.fields : [];
  const entries = [];
  let globalPrefix = getGlobalPrefix();

  for (const workflowNode of data.nodes) {
    const names = workflowWidgetNames(workflowNode);
    const values = workflowNode.widgets_values || [];
    const hasValues = Array.isArray(values) ? values.length > 0 : values && typeof values === "object" && Object.keys(values).length > 0;
    if (!names.length || !hasValues) continue;

    const widgets = {};
    for (const field of fields) {
      if (field.node_id !== undefined && String(field.node_id) !== String(workflowNode.id)) continue;
      if (field.node_type && field.node_type !== workflowNode.type) continue;
      if (field.title && field.title !== workflowNode.title) continue;
      const allowed = new Set(field.widgets || (field.widget ? [field.widget] : []));
      for (let index = 0; index < names.length; index += 1) {
        const name = names[index];
        if (!allowed.has(name)) continue;
        const value = workflowWidgetValue(workflowNode, names, index, name);
        if (value === undefined) continue;
        widgets[name] = name === "timeline_data"
          ? normalizeLegacyTimelineData(value, data)
          : value;
      }
    }

    if (widgets.global_prefix) globalPrefix = widgets.global_prefix;
    if (Object.keys(widgets).length) {
      entries.push({
        id: String(workflowNode.id),
        type: workflowNode.type,
        title: workflowNode.title || "",
        widgets,
      });
    }
  }

  if (!entries.length) return null;
  return {
    schema: "ltx-director-pro.story-script.v1",
    workflow_id: `${nodeProp(storyNode, "workflow_id", data.id || "ltx-director-pro") || "ltx-director-pro"}`.trim(),
    global_prefix: globalPrefix,
    created_at: new Date().toISOString(),
    imported_from_schema: data.version ? `workflow-${data.version}` : "legacy-workflow",
    nodes: entries,
  };
}

function normalizeImportedStoryScript(data, storyNode) {
  if (data?.schema === "ltx-director-pro.story-script.v1" && Array.isArray(data.nodes)) {
    return stripStoryScriptStruct(data);
  }
  return storyScriptFromLegacyWorkflow(data, storyNode);
}

function collectStoryScript(storyNode) {
  if (typeof window.shezwApplyGlobalPrefixToGraph === "function") window.shezwApplyGlobalPrefixToGraph();
  for (const node of app?.graph?._nodes || []) {
    if (node._timelineEditor && typeof node._timelineEditor.prepareStoryScriptStore === "function") {
      node._timelineEditor.prepareStoryScriptStore();
    }
  }
  const workflowId = `${nodeProp(storyNode, "workflow_id", "ltx-director-pro") || "ltx-director-pro"}`.trim();
  const struct = getAllowedStruct(storyNode);
  const nodes = [];
  for (const node of app?.graph?._nodes || []) {
    const allowed = getAllowedWidgets(struct, node);
    if (!allowed.size) continue;
    const widgets = {};
    for (const widget of node.widgets || []) {
      if (allowed.has(widget.name)) widgets[widget.name] = widget.value;
    }
    if (node._timelineEditor && typeof node._timelineEditor.getStoryScriptWidgets === "function") {
      Object.assign(widgets, node._timelineEditor.getStoryScriptWidgets());
    }
    if (Object.keys(widgets).length) {
      nodes.push({
        id: String(node.id),
        type: node.type,
        title: node.title || "",
        widgets,
      });
    }
  }
  return {
    schema: "ltx-director-pro.story-script.v1",
    workflow_id: workflowId,
    global_prefix: getGlobalPrefix(),
    created_at: new Date().toISOString(),
    nodes,
  };
}

function applyStoryScript(story, storyNode) {
  const nodeList = app?.graph?._nodes || [];
  const byId = new Map(nodeList.map((node) => [String(node.id), node]));
  for (const entry of story.nodes || []) {
    let node = byId.get(String(entry.id));
    if (!node) {
      node = nodeList.find((candidate) => candidate.type === entry.type && (!entry.title || candidate.title === entry.title));
    }
    if (!node) {
      const sameType = nodeList.filter((candidate) => candidate.type === entry.type);
      if (sameType.length === 1) [node] = sameType;
    }
    if (!node) continue;
    const changed = [];
    for (const [name, value] of Object.entries(entry.widgets || {})) {
      if (setWidgetValue(node, name, value, { silent: true })) changed.push(name);
    }
    if (node._timelineEditor && typeof node._timelineEditor.reloadFromWidgets === "function") {
      node._timelineEditor.reloadFromWidgets();
    } else {
      for (const name of changed) {
        const widget = getWidget(node, name);
        if (typeof widget?.callback === "function") widget.callback(widget.value);
      }
    }
  }
  if (story.global_prefix) {
    const prefixNode = nodeList.find((node) => node.type === "ShezwMetaInfo")
      || nodeList.find((node) => node.type === "ShezwGlobalPrefix");
    setWidgetValue(prefixNode, "global_prefix", story.global_prefix);
  }
  const storyForNode = stripStoryScriptStruct(story || {});
  setNodeProp(storyNode, "story_script", storyForNode);
  setWidgetValue(storyNode, "story_script", JSON.stringify(storyForNode, null, 2));
  if (typeof window.shezwApplyGlobalPrefixToGraph === "function") window.shezwApplyGlobalPrefixToGraph();
  app.graph?.setDirtyCanvas(true, true);
}

function storyFilename(storyNode, story) {
  const rawPrefix = `${story?.global_prefix || getGlobalPrefix() || widgetValue(storyNode, "global_prefix", "") || ""}`.trim();
  const prefix = rawPrefix
    .replace(/\.json$/i, "")
    .replace(/-ss$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix ? `${prefix}-` : ""}ltx-pro-ss.json`;
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatSavedPaths(data) {
  const paths = Array.isArray(data?.paths) ? data.paths.filter(Boolean) : [];
  if (!paths.length) return data?.filename || "-";
  return paths.join("\n");
}

async function writeStoryScriptHandle(fileHandle, story) {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(JSON.stringify(story, null, 2) + "\n");
  } finally {
    await writable.close();
  }
}

async function saveStoryScript(storyNode, exportDir = "", options = {}) {
  const story = stripStoryScriptStruct(collectStoryScript(storyNode));
  const filename = storyFilename(storyNode, story);
  setNodeProp(storyNode, "story_script", story);
  setWidgetValue(storyNode, "story_script", JSON.stringify(story, null, 2));
  if (options.fileHandle) {
    await writeStoryScriptHandle(options.fileHandle, story);
  }
  const resp = await api.fetchApi("/shezw/story_script/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename,
      export_dir: exportDir,
      story_script: story,
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) throw new Error(data.error || "Story script save failed");
  return {
    ...data,
    file_handle_name: options.fileHandle?.name || "",
  };
}

window.shezwStoreCurrentStoryScript = async function (exportDir = "") {
  const storyNode = getStoryNode();
  if (!storyNode) throw new Error("Meta Info node not found");
  return await saveStoryScript(storyNode, exportDir);
};

function hideWidget(node, name) {
  const widget = getWidget(node, name);
  if (!widget) return;
  widget.type = "hidden";
  widget.computeSize = () => [0, -4];
}

function buildMetaPanel(node) {
  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    alignItems: "stretch",
    width: "100%",
  });

  const makeButton = (label) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    Object.assign(btn.style, {
      border: "1px solid #555",
      background: "#202020",
      color: "#f2f2f2",
      borderRadius: "5px",
      padding: "6px 10px",
      cursor: "pointer",
      fontSize: "12px",
      minHeight: "30px",
      minWidth: "62px",
    });
    return btn;
  };

  const makeRow = (label) => {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      width: "100%",
    });
    const title = document.createElement("div");
    title.textContent = label;
    Object.assign(title.style, {
      color: "#ddd",
      fontSize: "12px",
      fontWeight: "600",
      minWidth: "74px",
      whiteSpace: "nowrap",
    });
    row.appendChild(title);
    return { row, title };
  };

  const prefixLine = makeRow(t("prefixId"));
  const scriptLine = makeRow(t("storyScript"));
  const languageLine = makeRow(t("language"));
  const prefixRow = prefixLine.row;
  const scriptRow = scriptLine.row;
  const languageRow = languageLine.row;
  let importedFrom = "-";
  const status = document.createElement("div");
  Object.assign(status.style, {
    width: "100%",
    color: "#aaa",
    fontSize: "12px",
    lineHeight: "16px",
    minHeight: "32px",
    whiteSpace: "pre-line",
  });
  const setStatus = (prefix) => {
    status.textContent = `${t("applied")} ${prefix || "-"}\n${t("importedFrom")} ${importedFrom}`;
  };
  setStatus(getGlobalPrefix());

  const genBtn = makeButton(t("gen"));
  const applyBtn = makeButton(t("apply"));
  const importBtn = makeButton(t("import"));
  const storeBtn = makeButton(t("store"));
  const exportBtn = makeButton(t("export"));
  const confirmLangBtn = makeButton(t("confirm"));
  const languageSelect = document.createElement("select");
  Object.assign(languageSelect.style, {
    border: "1px solid #555",
    background: "#202020",
    color: "#f2f2f2",
    borderRadius: "5px",
    padding: "6px 8px",
    cursor: "pointer",
    fontSize: "12px",
    minHeight: "30px",
    minWidth: "96px",
  });
  for (const [value, label] of Object.entries(UI_LANGUAGES)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    if (value === getUILanguage()) option.selected = true;
    languageSelect.appendChild(option);
  }
  prefixRow.append(genBtn, applyBtn);
  scriptRow.append(importBtn, storeBtn, exportBtn);
  languageRow.append(languageSelect, confirmLangBtn);
  wrap.append(prefixRow, scriptRow, languageRow, status);

  const refreshText = () => {
    setWidgetLabel(node, "global_prefix", t("globalPrefix"));
    setNodeIOLabel(node, "global_prefix", t("globalPrefix"));
    prefixLine.title.textContent = t("prefixId");
    scriptLine.title.textContent = t("storyScript");
    languageLine.title.textContent = t("language");
    genBtn.textContent = t("gen");
    applyBtn.textContent = t("apply");
    importBtn.textContent = t("import");
    storeBtn.textContent = t("store");
    exportBtn.textContent = t("export");
    confirmLangBtn.textContent = t("confirm");
    languageSelect.value = getUILanguage();
    setStatus(getGlobalPrefix());
  };

  genBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const widget = getWidget(node, "global_prefix") || node.widgets?.[0];
    if (!widget) return;
    const next = typeof window.shezwGenerateGlobalPrefixId === "function"
      ? window.shezwGenerateGlobalPrefixId()
      : `${Date.now()}`;
    widget.value = next;
    if (typeof widget.callback === "function") widget.callback(next);
    if (typeof window.shezwApplyGlobalPrefixToGraph === "function") window.shezwApplyGlobalPrefixToGraph();
    setStatus(next);
  });

  applyBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const prefix = typeof window.shezwApplyGlobalPrefixToGraph === "function"
      ? window.shezwApplyGlobalPrefixToGraph()
      : getGlobalPrefix();
    if (prefix) setStatus(prefix);
    else status.textContent = `${t("prefixEmpty")}\n${t("importedFrom")} ${importedFrom}`;
  });

  confirmLangBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setUILanguage(languageSelect.value);
    refreshText();
  });

  async function importStoryFile(file, handle = null) {
    const imported = JSON.parse(await file.text());
    const story = normalizeImportedStoryScript(imported, node);
    if (!story) throw new Error("Unsupported story script/workflow format");
    activeStoryScriptFileHandle = handle;
    activeStoryScriptFileName = file.name || handle?.name || "";
    applyStoryScript(story, node);
    importedFrom = activeStoryScriptFileName || "-";
    setStatus(getGlobalPrefix());
  }

  importBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{
            description: "Story script JSON",
            accept: { "application/json": [".json"] },
          }],
        });
        if (!handle) return;
        await importStoryFile(await handle.getFile(), handle);
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
        console.warn("[Shezw MetaInfo] File System Access import failed, using fallback input", err);
      }
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await importStoryFile(file, null);
      } catch (err) {
        console.error("[Shezw MetaInfo] import failed", err);
        status.textContent = `${t("importFailed")}: ${err.message || err}`;
      }
    });
    input.click();
  });

  storeBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    storeBtn.disabled = true;
    try {
      const data = await saveStoryScript(node, "", { fileHandle: activeStoryScriptFileHandle });
      const handleLine = data.file_handle_name ? `\n${t("updatedImportFile")} ${data.file_handle_name}` : "";
      status.textContent = `${t("applied")} ${getGlobalPrefix() || "-"}\n${t("stored")} ${formatSavedPaths(data)}${handleLine}`;
    } catch (err) {
      console.error("[Shezw MetaInfo] store failed", err);
      status.textContent = `${t("storeFailed")}: ${err.message || err}`;
    } finally {
      storeBtn.disabled = false;
    }
  });

  exportBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    exportBtn.disabled = true;
    try {
      const story = collectStoryScript(node);
      const filename = storyFilename(node, story);
      const exportDir = `${nodeProp(node, "export_dir", "") || ""}`.trim();
      if (exportDir) {
        const data = await saveStoryScript(node, exportDir);
        status.textContent = `${t("applied")} ${getGlobalPrefix() || "-"}\n${t("exported")} ${formatSavedPaths(data)}`;
      } else {
        setNodeProp(node, "story_script", story);
        setWidgetValue(node, "story_script", JSON.stringify(story, null, 2));
        downloadJson(filename, story);
        status.textContent = `${t("applied")} ${getGlobalPrefix() || "-"}\n${t("downloaded")} ${filename}`;
      }
    } catch (err) {
      console.error("[Shezw MetaInfo] export failed", err);
      status.textContent = `${t("exportFailed")}: ${err.message || err}`;
    } finally {
      exportBtn.disabled = false;
    }
  });

  window.addEventListener("shezw-ui-language-change", refreshText);
  return wrap;
}

app.registerExtension({
  name: "Shezw.StoryScript",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "ShezwStoryScript" && nodeData.name !== "ShezwMetaInfo") return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      const node = this;
      setWidgetLabel(node, "global_prefix", t("globalPrefix"));
      setNodeIOLabel(node, "global_prefix", t("globalPrefix"));
      for (const name of ["workflow_id", "script_name", "ss_struct", "story_script", "export_dir", "ui_language"]) {
        hideWidget(node, name);
      }
      const wrap = buildMetaPanel(node);

      setTimeout(() => {
        const domWidget = node.addDOMWidget("meta_info_tools", "div", wrap, { serialize: false });
        domWidget.computeSize = () => [360, 138];
        if (node.size[0] < 420) node.size[0] = 420;
        app.graph?.setDirtyCanvas(true, true);
      }, 50);
      return r;
    };
  },
});
