import { app } from "../../scripts/app.js";

function nowPrefixId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${Math.floor(1000 + Math.random() * 9000)}`;
}

function normalizePath(value) {
  return `${value || ""}`.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function getWidget(node, name) {
  return node?.widgets?.find((w) => w.name === name);
}

function translated(key, fallback) {
  if (typeof window.shezwT === "function") return window.shezwT(key, fallback);
  return fallback;
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

function getGlobalPrefixNode() {
  return (app?.graph?._nodes || []).find((node) => node.type === "ShezwMetaInfo")
    || (app?.graph?._nodes || []).find((node) => node.type === "ShezwGlobalPrefix");
}

function getGlobalPrefix() {
  const node = getGlobalPrefixNode();
  const widget = getWidget(node, "global_prefix") || node?.widgets?.[0];
  return normalizePath(widget?.value);
}

function prefixPath(value, globalPrefix) {
  const clean = normalizePath(value);
  if (!globalPrefix) return clean;
  const parts = clean.split("/").filter(Boolean);
  const idLike = (text) => /^\d{10,20}$/.test(text || "");

  if (parts[0] === "video") {
    if (idLike(parts[1]) || parts.length >= 3) parts.splice(1, 1, globalPrefix);
    else parts.splice(1, 0, globalPrefix);
    return parts.join("/");
  }
  if (idLike(parts[0])) parts.shift();
  return ["video", globalPrefix, ...parts].join("/");
}

export function applyGlobalPrefixToGraph() {
  const globalPrefix = getGlobalPrefix();
  if (!globalPrefix) return "";
  const prefixWidgetNames = new Set(["filename_prefix", "segment_prefix", "output_prefix"]);
  for (const node of app?.graph?._nodes || []) {
    if (node.type === "ShezwMetaInfo" || node.type === "ShezwGlobalPrefix" || node.type === "ShezwStoryScript") continue;
    for (const widget of node.widgets || []) {
      if (!prefixWidgetNames.has(widget.name)) continue;
      const nextValue = prefixPath(widget.value, globalPrefix);
      if (widget.value !== nextValue) {
        widget.value = nextValue;
        if (typeof widget.callback === "function") widget.callback(nextValue);
      }
    }
  }
  app.graph?.setDirtyCanvas(true, true);
  return globalPrefix;
}

window.shezwGetGlobalPrefix = getGlobalPrefix;
window.shezwApplyGlobalPrefixToGraph = applyGlobalPrefixToGraph;
window.shezwGenerateGlobalPrefixId = nowPrefixId;

function installQueueHook() {
  if (!app || typeof app.queuePrompt !== "function" || app.__shezwGlobalPrefixQueueHookInstalled) return;
  app.__shezwGlobalPrefixQueueHookInstalled = true;
  const originalQueuePrompt = app.queuePrompt.bind(app);
  app.queuePrompt = async function (...args) {
    applyGlobalPrefixToGraph();
    return await originalQueuePrompt(...args);
  };
}

app.registerExtension({
  name: "Shezw.GlobalPrefix",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    installQueueHook();
    if (nodeData.name !== "ShezwGlobalPrefix") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      const node = this;
      const widget = getWidget(node, "global_prefix") || node.widgets?.[0];
      setWidgetLabel(node, "global_prefix", translated("globalPrefix", "Global Prefix"));
      setNodeIOLabel(node, "global_prefix", translated("globalPrefix", "Global Prefix"));
      if (widget && !normalizePath(widget.value)) widget.value = nowPrefixId();

      const wrap = document.createElement("div");
      Object.assign(wrap.style, {
        display: "flex",
        gap: "6px",
        alignItems: "center",
        width: "100%",
      });

      const genBtn = document.createElement("button");
      genBtn.textContent = "Gen";
      const applyBtn = document.createElement("button");
      applyBtn.textContent = "Apply";
      for (const btn of [genBtn, applyBtn]) {
        Object.assign(btn.style, {
          border: "1px solid #444",
          background: "#222",
          color: "#eee",
          borderRadius: "4px",
          padding: "5px 9px",
          cursor: "pointer",
          fontSize: "11px",
        });
      }
      const refreshLabels = () => {
        setWidgetLabel(node, "global_prefix", translated("globalPrefix", "Global Prefix"));
        setNodeIOLabel(node, "global_prefix", translated("globalPrefix", "Global Prefix"));
      };
      window.addEventListener("shezw-ui-language-change", refreshLabels);
      genBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!widget) return;
        widget.value = nowPrefixId();
        if (typeof widget.callback === "function") widget.callback(widget.value);
        applyGlobalPrefixToGraph();
      });
      applyBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        applyGlobalPrefixToGraph();
      });
      wrap.appendChild(genBtn);
      wrap.appendChild(applyBtn);

      setTimeout(() => {
        const domWidget = node.addDOMWidget("prefix_tools", "div", wrap, { serialize: false });
        domWidget.computeSize = () => [220, 34];
        if (node.size[0] < 320) node.size[0] = 320;
        app.graph?.setDirtyCanvas(true, true);
      }, 50);
      return r;
    };
  },
});
