import { app } from "../../scripts/app.js";

// LTX Director Guide is a pure pass-through processor node.
// All configuration (images, insert frames, strengths) comes from
// the guide_data output of Prompt Relay Encode (Timeline).
// No dynamic widgets or sync logic needed.
app.registerExtension({
    name: "Comfy.LTXDirectorGuide",
    async nodeCreated(node) {
        if (node.comfyClass !== "LTXDirectorGuide") return;
        // Nothing to initialize — the node has no configurable widgets.
    },
});

        // Nothing to initialize — the node has no configurable widgets.
    },
});