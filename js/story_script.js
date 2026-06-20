import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function getWidget(node, name) {
  return node?.widgets?.find((w) => w.name === name);
}

function widgetValue(node, name, fallback = "") {
  const widget = getWidget(node, name);
  return widget ? widget.value : fallback;
}

function setWidgetValue(node, name, value) {
  const widget = getWidget(node, name);
  if (!widget) return false;
  widget.value = value;
  if (typeof widget.callback === "function") widget.callback(value);
  return true;
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

function getAllowedStruct(storyNode) {
  const raw = nodeProp(storyNode, "ss_struct", "{}");
  const parsed = parseJson(raw, {});
  return Array.isArray(parsed.fields) ? parsed : { fields: [] };
}

function getAllowedWidgets(struct, node) {
  const entries = struct.fields.filter((field) => {
    if (field.node_id !== undefined && String(field.node_id) !== String(node.id)) return false;
    if (field.node_type && field.node_type !== node.type) return false;
    if (field.title && field.title !== node.title) return false;
    return field.widgets || field.widget;
  });
  const names = new Set();
  for (const entry of entries) {
    if (entry.widget) names.add(entry.widget);
    for (const name of entry.widgets || []) names.add(name);
  }
  return names;
}

function collectStoryScript(storyNode) {
  if (typeof window.shezwApplyGlobalPrefixToGraph === "function") window.shezwApplyGlobalPrefixToGraph();
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
    ss_struct: struct,
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
    if (!node) continue;
    for (const [name, value] of Object.entries(entry.widgets || {})) {
      setWidgetValue(node, name, value);
    }
  }
  if (story.global_prefix) {
    const prefixNode = nodeList.find((node) => node.type === "ShezwMetaInfo")
      || nodeList.find((node) => node.type === "ShezwGlobalPrefix");
    setWidgetValue(prefixNode, "global_prefix", story.global_prefix);
  }
  setNodeProp(storyNode, "story_script", story);
  setWidgetValue(storyNode, "story_script", JSON.stringify(story, null, 2));
  if (typeof window.shezwApplyGlobalPrefixToGraph === "function") window.shezwApplyGlobalPrefixToGraph();
  app.graph?.setDirtyCanvas(true, true);
}

function storyFilename(storyNode, story) {
  const workflowId = `${nodeProp(storyNode, "workflow_id", story?.workflow_id || "story") || "story"}`.trim();
  const raw = `${nodeProp(storyNode, "script_name", "") || workflowId || story?.workflow_id || "story"}`.trim() || "story";
  if (raw.endsWith("-ss.json")) return raw;
  return `${raw.replace(/\.json$/i, "")}-ss.json`;
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

async function saveStoryScript(storyNode, exportDir = "") {
  const story = collectStoryScript(storyNode);
  const filename = storyFilename(storyNode, story);
  setNodeProp(storyNode, "story_script", story);
  setWidgetValue(storyNode, "story_script", JSON.stringify(story, null, 2));
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
  return data;
}

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
    return row;
  };

  const prefixRow = makeRow("Prefix-Id");
  const scriptRow = makeRow("Story script");
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
    status.textContent = `Applied ${prefix || "-"}\nImported from ${importedFrom}`;
  };
  setStatus(getGlobalPrefix());

  const genBtn = makeButton("Gen");
  const applyBtn = makeButton("Apply");
  const importBtn = makeButton("Import");
  const storeBtn = makeButton("Store");
  const exportBtn = makeButton("Export");
  prefixRow.append(genBtn, applyBtn);
  scriptRow.append(importBtn, storeBtn, exportBtn);
  wrap.append(prefixRow, scriptRow, status);

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
    else status.textContent = `Prefix is empty\nImported from ${importedFrom}`;
  });

  importBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const story = JSON.parse(await file.text());
        applyStoryScript(story, node);
        setNodeProp(node, "script_name", file.name);
        importedFrom = file.name;
        setStatus(getGlobalPrefix());
      } catch (err) {
        console.error("[Shezw MetaInfo] import failed", err);
        status.textContent = `Import failed: ${err.message || err}`;
      }
    });
    input.click();
  });

  storeBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    storeBtn.disabled = true;
    try {
      const data = await saveStoryScript(node, "");
      status.textContent = `Applied ${getGlobalPrefix() || "-"}\nStored ${data.filename}`;
    } catch (err) {
      console.error("[Shezw MetaInfo] store failed", err);
      status.textContent = `Store failed: ${err.message || err}`;
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
        status.textContent = `Applied ${getGlobalPrefix() || "-"}\nExported ${data.filename}`;
      } else {
        setNodeProp(node, "story_script", story);
        setWidgetValue(node, "story_script", JSON.stringify(story, null, 2));
        downloadJson(filename, story);
        status.textContent = `Applied ${getGlobalPrefix() || "-"}\nDownloaded ${filename}`;
      }
    } catch (err) {
      console.error("[Shezw MetaInfo] export failed", err);
      status.textContent = `Export failed: ${err.message || err}`;
    } finally {
      exportBtn.disabled = false;
    }
  });

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
      for (const name of ["workflow_id", "script_name", "ss_struct", "story_script", "export_dir"]) {
        hideWidget(node, name);
      }
      const wrap = buildMetaPanel(node);

      setTimeout(() => {
        const domWidget = node.addDOMWidget("meta_info_tools", "div", wrap, { serialize: false });
        domWidget.computeSize = () => [360, 102];
        if (node.size[0] < 420) node.size[0] = 420;
        app.graph?.setDirtyCanvas(true, true);
      }, 50);
      return r;
    };
  },
});
