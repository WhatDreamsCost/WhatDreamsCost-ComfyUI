import { app } from "../../scripts/app.js";

// Global registry to track all LTXSequencer nodes across all subgraphs
window._LTXSequencerGlobalNodes = window._LTXSequencerGlobalNodes || new Set();

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

/**
 * FULL STATE SYNC: 
 * Instead of syncing one widget, we push the entire properties object 
 * to ensure no values are ever lost during subgraph transitions or deletions.
 */
function syncFullStateAcrossNodes(sourceNode) {
    if (!window._LTXSequencerGlobalNodes) return;
    
    for (const targetNode of window._LTXSequencerGlobalNodes) {
        if (targetNode === sourceNode) continue;

        // 1. Mirror the properties object completely
        // We use a shallow copy to ensure we don't accidentally share object references
        const newState = { ...sourceNode.properties };
        targetNode.properties = { ...targetNode.properties, ...newState };

        // 2. Check if we need to rebuild the widget list (if num_images changed)
        const targetImageCount = targetNode.properties["num_images"] || 0;
        const currentVisibleCount = targetNode._currentImageCount;

        if (targetImageCount !== currentVisibleCount) {
            targetNode._applyWidgetCount(targetImageCount);
        }

        // 3. Update all existing widget values visually
        if (targetNode.widgets) {
            let modeChanged = false;
            targetNode.widgets.forEach(w => {
                const newValue = targetNode.properties[w.name];
                if (newValue !== undefined && w.value !== newValue) {
                    w.value = newValue;
                    if (w.name === "insert_mode") modeChanged = true;
                }
            });

            if (modeChanged && targetNode._updateVisibility) {
                targetNode._updateVisibility();
            }
        }
        
        targetNode.setDirtyCanvas(true, false);
    }
}

app.registerExtension({
    name: "Comfy.LTXSequencer.DynamicInputs",
    async nodeCreated(node) {
        if (node.comfyClass !== "LTXSequencer") return;

        // Register this node instance globally
        window._LTXSequencerGlobalNodes.add(node);

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
        setTimeout(moveSeparator, 50);

        // Binds custom callbacks to python-schema generated widgets
        node._hookStaticWidgets = function() {
            if (!this.widgets) return;
            const staticNames = ["num_images", "insert_mode", "frame_rate"];
            staticNames.forEach(name => {
                const w = this.widgets.find(w => w.name === name);
                if (w && !w._has_custom_callback) {
                    const orig = w.callback;
                    w.callback = (val) => {
                        this.properties[name] = val;
                        
                        if (name === "num_images") {
                            this._applyWidgetCount(val);
                        }
                        
                        // Push full state to siblings
                        syncFullStateAcrossNodes(this);

                        if (name === "insert_mode") {
                            this._updateVisibility();
                        }
                        if (orig) orig.apply(w, [val]);
                    };
                    w._has_custom_callback = true;
                }
            });
        };

        // Handles show/hiding widgets based on insertion method
        node._updateVisibility = function() {
            const mode = this.properties["insert_mode"] || "frames";
            if (!this.widgets) return;
            
            let changed = false;
            for (const w of this.widgets) {
                let shouldBeVisible = true;
                
                if (w.name.startsWith("insert_frame_")) {
                    shouldBeVisible = (mode === "frames");
                } else if (w.name.startsWith("insert_second_")) {
                    shouldBeVisible = (mode === "seconds");
                } else if (w.name.startsWith("insert_fraction_")) {
                    shouldBeVisible = (mode === "fractional");
                }
                
                const isHidden = (w.type === "hidden");
                if (shouldBeVisible && isHidden) {
                    toggleWidget(w, true);
                    changed = true;
                } else if (!shouldBeVisible && !isHidden) {
                    toggleWidget(w, false);
                    changed = true;
                }
            }
            
            if (changed) {
                this.setDirtyCanvas(true, true);
                requestAnimationFrame(() => {
                    if (this.computeSize) {
                        this.setSize(this.computeSize());
                    }
                });
            }
        };

        // Core update: synchronize widget visibility to match imageCount
        node._applyWidgetCount = function(count) {
            this._hookStaticWidgets();

            const isInitialLoad = this._currentImageCount === -1;
            if (this._currentImageCount === count && !isInitialLoad) {
                this._updateVisibility();
                return;
            }
            this._currentImageCount = count;

            const initialWidth = this.size[0];
            const numWidget = this.widgets?.find(w => w.name === "num_images");
            if (numWidget) {
                numWidget.label = "images_loaded";
                numWidget.value = Math.max(0, Math.min(count || 0, 50));
            }

            // 1. Update properties from current widget values before restructuring
            if (this.widgets) {
                this.widgets.forEach(w => {
                    if (w.name.startsWith("insert_") || w.name.startsWith("strength_") || ["num_images", "insert_mode", "frame_rate"].includes(w.name)) {
                        if (w.type !== "hidden" && w.type !== "button") this.properties[w.name] = w.value;
                    }
                });
            }

            // 2. Clear dynamic widgets
            if (this.widgets) {
                this.widgets = this.widgets.filter(w => 
                    !w.name.startsWith("insert_frame_") && 
                    !w.name.startsWith("insert_second_") && 
                    !w.name.startsWith("insert_fraction_") &&
                    !w.name.startsWith("strength_") &&
                    !w.name.startsWith("header_")
                );
            } else {
                this.widgets = [];
            }

            // 3. Rebuild precisely
            for (let i = 1; i <= count; i++) {
                // Header
                const headerName = `header_${i}`;
                this.addCustomWidget({
                    name: headerName,
                    type: "text",
                    value: `Image #${i}`,
                    draw(ctx, node, widget_width, y, widget_height) {
                        ctx.save();
                        const margin = 10;
                        const topPadding = 15;
                        ctx.strokeStyle = "#333";
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.moveTo(margin, y + 5);
                        ctx.lineTo(widget_width - margin, y + 5);
                        ctx.stroke();
                        ctx.fillStyle = "#dddddd";
                        ctx.font = "bold 12px Arial";
                        ctx.textAlign = "left";
                        ctx.fillText(`Image #${i}`, margin, y + topPadding + 10);
                        ctx.restore();
                    },
                    computeSize(width) { return [width, 35]; }
                });

                // Helper to add widget with full sync
                const addSyncedWidget = (type, name, def, options) => {
                    const saved = this.properties[name];
                    return this.addWidget(type, name, saved !== undefined ? saved : def, (val) => {
                        this.properties[name] = val;
                        syncFullStateAcrossNodes(this);
                    }, options);
                };

                addSyncedWidget("number", `insert_frame_${i}`, 0, { min: -9999, max: 9999, step: 10, precision: 0 });
                addSyncedWidget("number", `insert_second_${i}`, 0.0, { min: 0.0, max: 9999.0, step: 0.1, precision: 2 });
                addSyncedWidget("number", `insert_fraction_${i}`, 0.0, { min: 0.0, max: 1.0, step: 0.01, precision: 3 });
                addSyncedWidget("number", `strength_${i}`, 1.0, { min: 0.0, max: 1.0, step: 0.01 });
            }

            this._updateVisibility();
            this.setDirtyCanvas(true, true);
            requestAnimationFrame(() => {
                if (this.computeSize) {
                    this.setSize(this.computeSize());
                    this.size[0] = initialWidth;
                }
            });
        };

        const origConfigure = node.configure;
        node.configure = function(info) {
            if (origConfigure) origConfigure.apply(this, arguments);
            if (this.widgets) {
                this.widgets.forEach(w => {
                    if (w.name.startsWith("insert_") || w.name.startsWith("strength_") || ["num_images", "insert_mode", "frame_rate"].includes(w.name)) {
                        if (w.type !== "button") this.properties[w.name] = w.value;
                    }
                });
            }
        };

        node.onConfigure = function(info) {
            if (info.properties) {
                this.properties = { ...this.properties, ...info.properties };
            }
            this._hookStaticWidgets();
            setTimeout(() => {
                const count = readSourceImageCount(this);
                let targetCount = count !== null ? count : (this.properties.num_images || 0);
                this._applyWidgetCount(targetCount);
                this._updateVisibility();
            }, 100);
        };

        const originalOnSerialize = node.onSerialize;
        node.onSerialize = function(info) {
            if (this.widgets) {
                this.widgets.forEach(w => {
                    if (w.name.startsWith("insert_") || w.name.startsWith("strength_") || ["num_images", "insert_mode", "frame_rate"].includes(w.name)) {
                        if (w.type !== "hidden" && w.type !== "button") this.properties[w.name] = w.value;
                    }
                });
            }
            if (originalOnSerialize) originalOnSerialize.apply(this, arguments);
            info.properties = { ...this.properties };
            
            const strictArray = [];
            strictArray.push(this.properties["num_images"] !== undefined ? this.properties["num_images"] : 1);
            strictArray.push(this.properties["insert_mode"] !== undefined ? this.properties["insert_mode"] : "frames");
            strictArray.push(this.properties["frame_rate"] !== undefined ? this.properties["frame_rate"] : 24);

            for (let i = 1; i <= 50; i++) {
                strictArray.push(this.properties[`insert_frame_${i}`] !== undefined ? this.properties[`insert_frame_${i}`] : 0);
                strictArray.push(this.properties[`insert_second_${i}`] !== undefined ? this.properties[`insert_second_${i}`] : 0.0);
                strictArray.push(this.properties[`strength_${i}`] !== undefined ? this.properties[`strength_${i}`] : 1.0);
            }

            for (let i = 1; i <= 50; i++) {
                strictArray.push(this.properties[`insert_fraction_${i}`] !== undefined ? this.properties[`insert_fraction_${i}`] : 0.0);
            }
            info.widgets_values = strictArray;
        };

        function readSourceImageCount(self) {
            const multiInput = self.inputs?.find(inp => inp.name === "multi_input");
            if (!multiInput || !multiInput.link) return null;
            const nodeGraph = self.graph || app.graph;
            
            function traceUpstream(graph, linkId, visited = new Set()) {
                if (!linkId || visited.has(linkId)) return null;
                visited.add(linkId);
                const link = graph.links[linkId];
                if (!link) return null;
                const originNode = graph.getNodeById(link.origin_id);
                if (!originNode) return null;
                if (originNode.comfyClass === "MultiImageLoader") return originNode;
                if (originNode.type === "Reroute" || originNode.comfyClass === "Reroute") {
                    if (originNode.inputs?.[0]?.link) return traceUpstream(graph, originNode.inputs[0].link, visited);
                }
                if (typeof originNode.getInnerNode === "function") {
                    try {
                        const innerNode = originNode.getInnerNode(link.origin_slot);
                        if (innerNode?.comfyClass === "MultiImageLoader") return innerNode;
                    } catch (e) {}
                }
                return null;
            }

            let sourceNode = traceUpstream(nodeGraph, multiInput.link);
            function getCountFromNode(n) {
                if (typeof n._imageCount === "number") return n._imageCount;
                const pathsWidget = n.widgets?.find(w => w.name === "image_paths");
                return pathsWidget ? (pathsWidget.value || "").split('\n').filter(p => p.trim()).length : null;
            }

            if (sourceNode) return getCountFromNode(sourceNode);

            let multiImageLoaders = [];
            function findAllLoaders(nodes) {
                if (!nodes) return;
                for (let n of nodes) {
                    if (n.comfyClass === "MultiImageLoader") multiImageLoaders.push(n);
                    if (n.subgraph?._nodes) findAllLoaders(n.subgraph._nodes);
                }
            }
            if (app.graph?._nodes) findAllLoaders(app.graph._nodes);
            if (multiImageLoaders.length === 1) return getCountFromNode(multiImageLoaders[0]);
            return null;
        }

        const pollInterval = setInterval(() => {
            if (!node.graph) {
                clearInterval(pollInterval);
                return;
            }
            const count = readSourceImageCount(node);
            if (count !== null && count !== node._currentImageCount) {
                node._applyWidgetCount(count);
                syncFullStateAcrossNodes(node); // Sync the new count to others
            }
        }, 500);

        const origOnRemoved = node.onRemoved;
        node.onRemoved = function() {
            window._LTXSequencerGlobalNodes.delete(node);
            clearInterval(pollInterval);
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };

        node.onConnectionsChange = function(type, index, connected) {
            if (type === 1 && this.inputs[index]?.name === "multi_input") {
                if (connected) {
                    setTimeout(() => {
                        const count = readSourceImageCount(this);
                        this._applyWidgetCount(count !== null ? count : (this.properties.num_images || 0));
                    }, 100);
                } else {
                    this._applyWidgetCount(0);
                }
            }
        };

        node.onAdded = function() {
            setTimeout(() => {
                const count = readSourceImageCount(this);
                this._applyWidgetCount(count !== null ? count : (this.properties.num_images || 0));
            }, 100);
        };
    }
});
