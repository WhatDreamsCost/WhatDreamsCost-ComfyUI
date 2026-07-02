import { app } from "../../scripts/app.js";

// Global registry to track all LTXKeyframer nodes across all subgraphs
window._LTXKeyframerGlobalNodes = window._LTXKeyframerGlobalNodes || new Set();

// ComfyUI native trick to cleanly hide/show widgets without deleting them
function toggleWidget(widget, visible) {
    if (visible) {
        if (widget.origType !== undefined) {
            widget.type = widget.origType;
            widget.computeSize = widget.origComputeSize;
            delete widget.origType;
            delete widget.origComputeSize;
        }
    } else {
        if (widget.type !== "hidden") {
            widget.origType = widget.type;
            widget.origComputeSize = widget.computeSize;
            widget.type = "hidden";
            widget.computeSize = () => [0, -4];
        }
    }
}

// --- NEW SYNC HELPER FUNCTION ---
// Finds all other LTXKeyframer nodes globally and mirrors the value to them
function syncWidgetAcrossNodes(sourceNode, widgetName, value) {
    if (!window._LTXKeyframerGlobalNodes) return;
    
    for (const targetNode of window._LTXKeyframerGlobalNodes) {
        // Target all OTHER LTXKeyframer nodes by direct object reference
        if (targetNode !== sourceNode) {
            
            // 1. Always update the hidden properties cache so it remembers the sync 
            // even if the widget isn't currently visible (e.g. fewer images loaded right now)
            targetNode.properties[widgetName] = value;
            
            // 2. If the widget is currently visible on the UI, update it visually
            if (targetNode.widgets) {
                const targetWidget = targetNode.widgets.find(w => w.name === widgetName);
                if (targetWidget && targetWidget.value !== value) {
                    targetWidget.value = value;
                    targetNode.setDirtyCanvas(true, false);
                }
            }
        }
    }
}

app.registerExtension({
    name: "Comfy.SmartLTXKeyframer.DynamicInputs",
    async nodeCreated(node) {
        if (node.comfyClass !== "SmartLTXKeyframer") return;

        // Register this node instance globally
        window._LTXKeyframerGlobalNodes.add(node);

        node._currentImageCount = -1; // Force first update

        // Initialize persistent properties cache
        node.properties = node.properties || {};

        // Add subtle separator line above images_loaded
        node.addCustomWidget({
            name: "num_images_separator",
            type: "text",
            draw(ctx, node, widget_width, y, widget_height) {
                ctx.save();
                ctx.strokeStyle = "#444";
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(10, y + 5);
                ctx.lineTo(widget_width - 10, y + 5);
                ctx.stroke();
                ctx.restore();
            },
            computeSize(width) {
                return [width, 10];
            }
        });
        
        // Move separator before num_images
        const moveSeparator = () => {
            const idx = node.widgets.findIndex(w => w.name === "num_images");
            const sepIdx = node.widgets.findIndex(w => w.name === "num_images_separator");
            if (idx !== -1 && sepIdx !== -1) {
                const separator = node.widgets.splice(sepIdx, 1)[0];
                node.widgets.splice(idx, 0, separator);
            }
        };
        setTimeout(moveSeparator, 50); // Small delay to ensure num_images is present

        // Core update: synchronize widget visibility to match imageCount
        node._applyWidgetCount = function(count) {
            const isInitialLoad = this._currentImageCount === -1;
            
            if (this._currentImageCount === count && !isInitialLoad) return;
            this._currentImageCount = count;

            const initialWidth = this.size[0];
            const numWidget = this.widgets?.find(w => w.name === "num_images");
            if (numWidget) {
                numWidget.label = "images_loaded";
                numWidget.value = Math.max(0, Math.min(count || 0, 50));
            }

            // 1. Store current widget values in properties BEFORE removing them
            // We skip reading from `this.widgets` on the initial load because it might be scrambling.
            if (!isInitialLoad && this.widgets) {
                this.widgets.forEach(w => {
                    if (w.name.startsWith("insert_frame_") || w.name.startsWith("strength_")) {
                        this.properties[w.name] = w.value;
                    }
                });
            }

            // 2. Remove all existing dynamic insert_frame/strength/header widgets
            if (this.widgets) {
                this.widgets = this.widgets.filter(w => 
                    !w.name.startsWith("insert_frame_") && 
                    !w.name.startsWith("strength_") &&
                    !w.name.startsWith("header_")
                );
            } else {
                this.widgets = [];
            }

            // 3. Add back exactly the right amount of widgets using the cached values
            for (let i = 1; i <= count; i++) {
                // Add header/separator widget for grouping
                const headerName = `header_${i}`;
                this.addCustomWidget({
                    name: headerName,
                    type: "text",
                    value: `Image #${i}`,
                    draw(ctx, node, widget_width, y, widget_height) {
                        ctx.save();
                        const margin = 10;
                        const topPadding = 15;
                        
                        // Subtle separator line
                        ctx.strokeStyle = "#333";
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.moveTo(margin, y + 5);
                        ctx.lineTo(widget_width - margin, y + 5);
                        ctx.stroke();
                        
                        // Text label
                        ctx.fillStyle = "#dddddd"; // Light gray
                        ctx.font = "bold 12px Arial";
                        ctx.textAlign = "left";
                        ctx.fillText(`Image #${i}`, margin, y + topPadding + 10);
                        ctx.restore();
                    },
                    computeSize(width) {
                        return [width, 35]; // Vertical gap + label height
                    }
                });

                const insertFrameWidgetName = `insert_frame_${i}`;
                const strengthWidgetName = `strength_${i}`;

                // Add insert_frame widget with Sync Callback
                const savedInsertFrameValue = this.properties[insertFrameWidgetName];
                this.addWidget("number", insertFrameWidgetName, 
                    savedInsertFrameValue !== undefined ? savedInsertFrameValue : 0, 
                    (value) => {
                        const rounded = Math.round(value);
                        this.properties[insertFrameWidgetName] = rounded;
                        syncWidgetAcrossNodes(this, insertFrameWidgetName, rounded); // Sync out
                    }, { min: -9999, max: 9999, step: 10, precision: 0 }
                );

                // Add strength widget with Sync Callback
                const savedStrengthValue = this.properties[strengthWidgetName];
                this.addWidget("number", strengthWidgetName, 
                    savedStrengthValue !== undefined ? savedStrengthValue : 1.0, 
                    (value) => {
                        this.properties[strengthWidgetName] = value;
                        syncWidgetAcrossNodes(this, strengthWidgetName, value); // Sync out
                    }, { min: 0.0, max: 1.0, step: 0.01 }
                );
            }

            this.setDirtyCanvas(true, true);
            requestAnimationFrame(() => {
                if (this.computeSize) {
                    this.setSize(this.computeSize());
                    this.size[0] = initialWidth; // keep width fixed when restructuring
                }
            });
        };

        // --- STRICT ARRAY MAPPER: FIXES ALL SHIFTING FOREVER ---
        // This runs the exact instant the node is loaded, before any UI widgets shift indices.
        // It locks the perfectly mapped array values directly into our properties dictionary.
        const origConfigure = node.configure;
        node.configure = function(info) {
            if (origConfigure) {
                origConfigure.apply(this, arguments);
            }
            if (this.widgets) {
                this.widgets.forEach(w => {
                    if (w.name === "num_images" || w.name.startsWith("insert_frame_") || w.name.startsWith("strength_")) {
                        this.properties[w.name] = w.value;
                    }
                });
            }
        };

        // Handle deserialization to load properties properly from JSON
        const originalOnConfigure = node.onConfigure;
        node.onConfigure = function(info) {
            if (originalOnConfigure) {
                originalOnConfigure.apply(this, arguments);
            }
            if (info.properties) {
                this.properties = { ...this.properties, ...info.properties };
            }
            setTimeout(() => {
                const count = readSourceImageCount(this);
                // Fallback to properties.num_images if source node disconnected
                let targetCount = count !== null ? count : (this.properties.num_images || 0);
                this._applyWidgetCount(targetCount);
            }, 100);
        };

        // --- STRICT ARRAY GENERATOR ---
        // Completely detach from ComfyUI's blind visual array saving.
        // We construct an exact 101-element strict array that Python expects.
        // This makes your node 100% immune to UI/Header index shifting.
        const originalOnSerialize = node.onSerialize;
        node.onSerialize = function(info) {
            // Ensure properties are strictly synced with current widget values before building
            if (this.widgets) {
                this.widgets.forEach(w => {
                    if (w.name === "num_images" || w.name.startsWith("insert_frame_") || w.name.startsWith("strength_")) {
                        this.properties[w.name] = w.value;
                    }
                });
            }

            if (originalOnSerialize) {
                originalOnSerialize.apply(this, arguments);
            }
            
            info.properties = { ...this.properties };
            
            // Build the exact strict array that maps 1-to-1 to the Python backend
            const strictArray = [];
            const numWidgetVal = this.properties["num_images"];
            strictArray.push(numWidgetVal !== undefined ? numWidgetVal : 1);
            
            for (let i = 1; i <= 50; i++) {
                const fVal = this.properties[`insert_frame_${i}`];
                const sVal = this.properties[`strength_${i}`];
                strictArray.push(fVal !== undefined ? fVal : 0);
                strictArray.push(sVal !== undefined ? sVal : 1.0);
            }
            
            info.widgets_values = strictArray;
        };

        // Set up manual num_images widget callback
        setTimeout(() => {
            const numWidget = node.widgets?.find(w => w.name === "num_images");
            if (numWidget) {
                numWidget.callback = (val) => {
                    node.properties["num_images"] = val;
                    node._applyWidgetCount(val);
                };
            }
        }, 100);

        // Exposed receiver for push-based notifications
        node._syncImageCount = function(count) {
            this._applyWidgetCount(count);
        };

        // Helper: read image count from a connected MultiImageLoader node
        function readSourceImageCount(self) {
            const multiInput = self.inputs?.find(inp => inp.name === "multi_input");
            if (!multiInput || !multiInput.link) return null;

            const nodeGraph = self.graph || app.graph;
            
            // Helper to safely trace back through Reroutes and ComfyUI Group Nodes/Subgraphs
            function traceUpstream(graph, linkId, visited = new Set()) {
                if (!linkId || visited.has(linkId)) return null;
                visited.add(linkId);

                const link = graph.links[linkId];
                if (!link) return null;

                const originNode = graph.getNodeById(link.origin_id);
                if (!originNode) return null;

                if (originNode.comfyClass === "SmartMultiImageLoader") {
                    return originNode;
                }

                // Traverse Reroute nodes
                if (originNode.type === "Reroute" || originNode.comfyClass === "Reroute") {
                    if (originNode.inputs && originNode.inputs.length > 0 && originNode.inputs[0].link) {
                        return traceUpstream(graph, originNode.inputs[0].link, visited);
                    }
                }

                // Traverse standard ComfyUI Group Nodes (subgraphs)
                if (typeof originNode.getInnerNode === "function") {
                    try {
                        const innerNode = originNode.getInnerNode(link.origin_slot);
                        if (innerNode && innerNode.comfyClass === "SmartMultiImageLoader") {
                            return innerNode;
                        }
                    } catch (e) {
                        console.warn("Could not trace inner node", e);
                    }
                }

                return null;
            }

            let sourceNode = traceUpstream(nodeGraph, multiInput.link);

            // Helper to extract the count once we find a node
            function getCountFromNode(n) {
                if (typeof n._imageCount === "number") return n._imageCount;
                const pathsWidget = n.widgets?.find(w => w.name === "image_paths");
                if (pathsWidget) {
                    return (pathsWidget.value || "").split('\n').map(p => p.trim()).filter(p => p.length > 0).length;
                }
                return null;
            }

            if (sourceNode) {
                return getCountFromNode(sourceNode);
            }

            // Fallback Strategy: If it is connected to something, but we couldn't resolve it
            // directly (e.g. complex nested 3rd party subgraphs), scan the entire UI.
            // If there is EXACTLY ONE MultiImageLoader in the workspace, safely assume that's the one.
            let multiImageLoaders = [];
            function findAllLoaders(nodes) {
                if (!nodes) return;
                for (let n of nodes) {
                    if (n.comfyClass === "SmartMultiImageLoader") {
                        multiImageLoaders.push(n);
                    }
                    if (n.subgraph && n.subgraph._nodes) {
                        findAllLoaders(n.subgraph._nodes);
                    }
                }
            }
            if (app.graph && app.graph._nodes) {
                findAllLoaders(app.graph._nodes);
            }

            if (multiImageLoaders.length === 1) {
                return getCountFromNode(multiImageLoaders[0]);
            }

            return null;
        }

        // --- Backup polling via setInterval (4 Hz) ---
        const pollInterval = setInterval(() => {
            if (!node.graph) {
                clearInterval(pollInterval);
                return;
            }
            const count = readSourceImageCount(node);
            if (count !== null) {
                node._applyWidgetCount(count);
            }
        }, 250);

        // Clean up the interval when the node is deleted
        const origOnRemoved = node.onRemoved;
        node.onRemoved = function() {
            // Unregister this node instance
            window._LTXKeyframerGlobalNodes.delete(node);
            
            clearInterval(pollInterval);
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };

        // --- Connection change handler ---
        const onConnectionsChange = node.onConnectionsChange;
        node.onConnectionsChange = function(type, index, connected, link_info) {
            if (onConnectionsChange) onConnectionsChange.apply(this, arguments);

            if (type === 1) { // 1 = Input
                const input = this.inputs[index];
                if (input && input.name === "multi_input") {
                    if (connected) {
                        setTimeout(() => {
                            const count = readSourceImageCount(this);
                            this._applyWidgetCount(count !== null ? count : (this.properties.num_images || 0));
                        }, 100);
                    } else {
                        this._applyWidgetCount(0);
                    }
                }
            }
        };

        // --- Initial sync when first placed on canvas ---
        const origOnAdded = node.onAdded;
        node.onAdded = function() {
            if (origOnAdded) origOnAdded.apply(this, arguments);
            setTimeout(() => {
                const count = readSourceImageCount(this);
                this._applyWidgetCount(count !== null ? count : (this.properties.num_images || 0));
            }, 100);
        };
    }
});