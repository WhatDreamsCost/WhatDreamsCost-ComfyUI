import { app } from "../../scripts/app.js";

// LTX Director Guide is a pure pass-through processor node.
// All configuration (images, insert frames, strengths) comes from
// the guide_data output of Prompt Relay Encode (Timeline).
app.registerExtension({
    name: "Comfy.SmartLTXDirectorGuide",
    async nodeCreated(node) {
        if (node.comfyClass !== "SmartLTXDirectorGuide") return;

        // 1. Hook onConfigure so the widget remains standard and visible during workflow loading,
        // and only gets hidden AFTER LiteGraph and third-party extensions have finished configuring it.
        const origConfigure = node.onConfigure;
        node.onConfigure = function (info) {
            const out = origConfigure ? origConfigure.apply(this, arguments) : undefined;
            
            const w = this.widgets?.find(x => x.name === "retake_mode");
            if (w) {
                w.hidden = true;
                if (!w.options) w.options = {};
                w.options.hidden = true;
                if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
                    w.computeSize = () => [0, -4];
                    w.draw = () => { };
                }
                if (w.element) w.element.style.display = "none";
            }
            return out;
        };

        // 2. Also hide the widget for newly created nodes that are dragged onto the canvas
        // (which do not trigger onConfigure) by deferring it slightly.
        setTimeout(() => {
            const w = node.widgets?.find(x => x.name === "retake_mode");
            if (w) {
                w.hidden = true;
                if (!w.options) w.options = {};
                w.options.hidden = true;
                if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
                    w.computeSize = () => [0, -4];
                    w.draw = () => { };
                }
                if (w.element) w.element.style.display = "none";
            }
        }, 50);
    },
});