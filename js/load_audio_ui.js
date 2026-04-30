import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "Comfy.LoadAudioUI",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "LoadAudioUI") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            const onDrawBackground = nodeType.prototype.onDrawBackground;
            
            // --- V1 LiteGraph Image Preview Hider ---
            nodeType.prototype.onDrawBackground = function (ctx) {
                if (onDrawBackground) {
                    onDrawBackground.apply(this, arguments);
                }
            };
            
            nodeType.prototype.onNodeCreated = function () {
                // Ensure standard creation logic runs first
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                const node = this; // Capture the node instance
                
                // Track if we are in the initial loading phase to prevent resetting saved trim values
                node._initializing = true;
                node._should_reset_trim = false;
				               
                // ====================================================================
                // FIX: HIDE DEFAULT COMFYUI AUDIO PLAYER SAFELY
                // ====================================================================
                setTimeout(() => {
                    if (node.widgets) {
                        const nativeWidgetIndex = node.widgets.findIndex(w => w.name === "audioUI");
                        if (nativeWidgetIndex !== -1) {
                            const w = node.widgets[nativeWidgetIndex];
                            if (w.element) {
                                w.element.style.display = "none";
                                w.element.style.height = "0px";
                                w.element.style.position = "absolute";
                                w.element.style.pointerEvents = "none";
                            }
                            w.type = "hidden";
                            w.hidden = true;
                            w.computeSize = () => [0, 0];
                            
                            // Only update height to account for the hidden widget, 
                            // preserving the width (whether it's the default 475 or a user-saved value).
                            const currentWidth = node.size[0];
                            const recommendedHeight = node.computeSize()[1];
                            node.setSize([currentWidth, recommendedHeight]);
                            
                            if (app.graph) {
                                app.graph.setDirtyCanvas(true, true);
                            }
                        }
                    }
                }, 10);
                // ====================================================================

				
                // --- THE CORE FIX FOR COMFYUI V2 ---
                Object.defineProperty(node, 'imgs', {
                    get: function() { return undefined; },
                    set: function(val) { /* Ignore attempts by ComfyUI to set an image preview */ },
                    configurable: true
                });

                // Shared upload handler
                const handleFileUpload = async (file) => {
                    if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) return false;
                    try {
                        const body = new FormData();
                        body.append("image", file);
                        body.append("type", "input");
                        body.append("subfolder", "");
                        
                        const resp = await api.fetchApi("/upload/image", {
                            method: "POST",
                            body,
                        });

                        if (resp.status === 200) {
                            const data = await resp.json();
                            const audioWidget = node.widgets && node.widgets.find(w => w.name === "audio");
                            if (audioWidget) {
                                // Manual upload should always reset the trim range
                                node._should_reset_trim = true;
                                audioWidget.value = data.name;
                                if (audioWidget.options && audioWidget.options.values && !audioWidget.options.values.includes(data.name)) {
                                    audioWidget.options.values.push(data.name);
                                }
                                if (audioWidget.callback) {
                                    audioWidget.callback(data.name);
                                }
                                app.graph.setDirtyCanvas(true, false);
                            }
                        }
                    } catch (err) {
                        console.error("Error uploading dragged audio file:", err);
                    }
                    return true;
                };

                this.onDragDrop = function(e) {
                    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        const file = e.dataTransfer.files[0];
                        if (file.type.startsWith('audio/') || file.type.startsWith('video/')) {
                            handleFileUpload(file);
                            return true;
                        }
                    }
                    return false;
                };

                // 1. Build the Main Custom HTML Container
                const container = document.createElement("div");
                const defaultBg = "rgba(30, 30, 30, 0.9)";
                Object.assign(container.style, {
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px", 
                    width: "100%",
                    padding: "10px", 
                    boxSizing: "border-box",
                    background: defaultBg,
                    borderRadius: "6px",
                    color: "white",
                    fontFamily: "sans-serif",
                    marginTop: "8px",
                    flexShrink: "0",
                    transition: "background 0.2s"
                });

                const playerTop = document.createElement("div");
                Object.assign(playerTop.style, {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "0 2px",
                    marginBottom: "-4px"
                });
                
                const playerTitle = document.createElement("span");
                playerTitle.textContent = "No audio selected";
                Object.assign(playerTitle.style, {
                    fontSize: "11px",
                    color: "#aaa",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: "140px"
                });

                const trimLength = document.createElement("span");
                Object.assign(trimLength.style, {
                    fontSize: "11px",
                    color: "#38bdf8",
                    fontWeight: "bold",
                    background: "rgba(56, 189, 248, 0.1)",
                    padding: "3px 6px",
                    borderRadius: "4px",
                    whiteSpace: "nowrap"
                });
                trimLength.textContent = "Trimmed: 0.0s";

                playerTop.appendChild(playerTitle);
                playerTop.appendChild(trimLength);
                container.appendChild(playerTop);

                const audioEl = document.createElement("audio");
                audioEl.controls = true;
                audioEl.style.width = "100%";
                audioEl.style.height = "40px";
                audioEl.style.outline = "none";
                container.appendChild(audioEl);

                const trimArea = document.createElement("div");
                Object.assign(trimArea.style, {
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                    background: "rgba(0, 0, 0, 0.35)",
                    padding: "12px",
                    borderRadius: "6px",
                    border: "1px solid rgba(255, 255, 255, 0.05)"
                });

                const timeRuler = document.createElement("div");
                Object.assign(timeRuler.style, {
                    position: "relative",
                    width: "100%",
                    height: "22px",
                    fontSize: "10px",
                    color: "#aaa",
                    pointerEvents: "none",
                    userSelect: "none"
                });
                trimArea.appendChild(timeRuler);

                const sliderBox = document.createElement("div");
                Object.assign(sliderBox.style, {
                    position: "relative",
                    width: "100%",
                    height: "24px",
                    background: "#111",
                    borderRadius: "4px",
                    cursor: "pointer",
                    userSelect: "none",
                    boxShadow: "inset 0 1px 3px rgba(0,0,0,0.5)"
                });

                const fill = document.createElement("div");
                Object.assign(fill.style, {
                    position: "absolute",
                    height: "100%",
                    background: "rgba(14, 165, 233, 0.35)",
                    pointerEvents: "none"
                });
                sliderBox.appendChild(fill);

                const createHandle = (color) => {
                    const h = document.createElement("div");
                    Object.assign(h.style, {
                        position: "absolute",
                        top: "0",
                        width: "8px",
                        height: "100%",
                        background: color,
                        transform: "translateX(-50%)",
                        pointerEvents: "none",
                        boxShadow: "0 0 4px rgba(0,0,0,0.8)",
                        borderRadius: "2px"
                    });
                    return h;
                };

                const startHandle = createHandle("#38bdf8");
                const endHandle = createHandle("#38bdf8");
                sliderBox.appendChild(startHandle);
                sliderBox.appendChild(endHandle);
                trimArea.appendChild(sliderBox);
                
                container.appendChild(trimArea);

                // 4. Attach container to the node UI
                const widget = this.addDOMWidget("audio_ui", "audio_ui", container);
                
                // --- DEFAULT SIZE FOR NEW NODES ---
                // We set the width to 475 initially. 
                // If a workflow is loading, LiteGraph will overwrite this size 
                // automatically after this function finishes.
                this.size = [475, this.computeSize()[1]];
                
                widget.computeSize = function(width) {
                    return [width, 200];
                };

                // 5. Bind Node Data to UI dynamically 
                setTimeout(() => {
                    const audioWidget = node.widgets && node.widgets.find(w => w.name === "audio");
                    const startWidget = node.widgets && node.widgets.find(w => w.name === "start_time");
                    const endWidget = node.widgets && node.widgets.find(w => w.name === "end_time");
                    
                    if (audioWidget) {
                        const updateAudio = () => {
                            if (!audioWidget.value || audioWidget.value === "none") {
                                playerTitle.textContent = "No audio selected";
                                return;
                            }
                            let filename = audioWidget.value;
                            let subfolder = "";
                            if (filename.includes("/") || filename.includes("\\")) {
                                const sep = filename.includes("/") ? "/" : "\\";
                                const parts = filename.split(sep);
                                filename = parts.pop();
                                subfolder = parts.join("/");
                            }
                            playerTitle.textContent = filename;
                            audioEl.src = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
                        };
                        audioWidget.callback = function() {
                            // If user manually changes the dropdown, flag for trim reset
                            if (!node._initializing) {
                                node._should_reset_trim = true;
                            }
                            updateAudio();
                        };
                        updateAudio();
                    }

                    container.ondragover = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        container.style.background = "rgba(14, 165, 233, 0.2)";
                    };
                    container.ondragleave = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        container.style.background = defaultBg;
                    };
                    container.ondrop = async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        container.style.background = defaultBg;
                        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                            handleFileUpload(e.dataTransfer.files[0]);
                        }
                    };

                    let duration = 0;
                    let dragging = null;

                    const formatTime = (secs) => {
                        if (secs < 60) return secs.toFixed(1) + "s";
                        const m = Math.floor(secs / 60);
                        const s = (secs % 60).toFixed(1);
                        return `${m}:${s.padStart(4, '0')}`;
                    };

                    const updateRuler = () => {
                        timeRuler.innerHTML = '';
                        if (!duration) return;
                        const numMajorTicks = 5;
                        const subTicks = 4;
                        const totalTicks = (numMajorTicks - 1) * subTicks; 
                        for (let i = 0; i <= totalTicks; i++) {
                            const pct = i / totalTicks;
                            const t = duration * pct;
                            const isMajor = i % subTicks === 0;
                            const tickWrapper = document.createElement("div");
                            Object.assign(tickWrapper.style, {
                                position: "absolute", left: `${pct * 100}%`, top: "0",
                                display: "flex", flexDirection: "column", alignItems: "center", transform: "translateX(-50%)"
                            });
                            if (i === 0) { tickWrapper.style.transform = "none"; tickWrapper.style.alignItems = "flex-start"; }
                            if (i === totalTicks) { tickWrapper.style.transform = "translateX(-100%)"; tickWrapper.style.alignItems = "flex-end"; }
                            const line = document.createElement("div");
                            Object.assign(line.style, {
                                width: isMajor ? "2px" : "1px", height: isMajor ? "6px" : "4px",
                                background: isMajor ? "#aaa" : "#555", marginBottom: "2px", borderRadius: "1px"
                            });
                            tickWrapper.appendChild(line);
                            if (isMajor) {
                                const label = document.createElement("div");
                                label.textContent = formatTime(t);
                                tickWrapper.appendChild(label);
                            }
                            timeRuler.appendChild(tickWrapper);
                        }
                    };
                    
                    const updateUI = (syncPlayer = false) => {
                        if (!duration) return;
                        let s = startWidget ? parseFloat(startWidget.value) || 0 : 0;
                        let e = endWidget ? parseFloat(endWidget.value) || 0 : 0;
                        if (e === 0 || e > duration) e = duration;
                        if (s > e) s = e;
                        const sPct = (s / duration) * 100;
                        const ePct = (e / duration) * 100;
                        startHandle.style.left = `${sPct}%`;
                        endHandle.style.left = `${ePct}%`;
                        fill.style.left = `${sPct}%`;
                        fill.style.width = `${ePct - sPct}%`;
                        trimLength.textContent = `Trimmed: ${formatTime(e - s)}`;
                        if (syncPlayer && audioEl.readyState >= 1) { audioEl.currentTime = s; }
                    };

                    audioEl.onloadedmetadata = () => {
                        duration = audioEl.duration;
                        
                        // Handle trim reset for new audio selection
                        if (node._should_reset_trim) {
                            if (startWidget) startWidget.value = 0;
                            if (endWidget) endWidget.value = parseFloat(duration.toFixed(3));
                            node._should_reset_trim = false;
                        } else {
                            // Default clamping logic for initial load or out-of-bounds saved values
                            let e = endWidget ? parseFloat(endWidget.value) || 0 : 0;
                            if (endWidget && (e === 0 || e > duration)) { 
                                endWidget.value = parseFloat(duration.toFixed(3)); 
                            }
                        }
                        
                        updateRuler(); 
                        updateUI();
                        app.graph.setDirtyCanvas(true, false);
                    };

                    audioEl.ontimeupdate = () => {
                        if (dragging || !duration) return;
                        let s = startWidget ? parseFloat(startWidget.value) || 0 : 0;
                        let e = endWidget ? parseFloat(endWidget.value) || duration : duration;
                        if (e === 0) e = duration;
                        if (audioEl.currentTime >= e) { audioEl.pause(); audioEl.currentTime = s; }
                    };

                    audioEl.onplay = () => {
                        let s = startWidget ? parseFloat(startWidget.value) || 0 : 0;
                        let e = endWidget ? parseFloat(endWidget.value) || duration : duration;
                        if (e === 0) e = duration;
                        if (audioEl.currentTime < s || audioEl.currentTime >= e) { audioEl.currentTime = s; }
                    };

                    [startWidget, endWidget].forEach(w => {
                        if (w) {
                            const orig = w.callback;
                            w.callback = function() { updateUI(true); if(orig) orig.apply(this, arguments); };
                        }
                    });

                    sliderBox.onpointerdown = (e) => {
                        if (!duration) return;
                        const rect = sliderBox.getBoundingClientRect();
                        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                        const val = (x / rect.width) * duration;
                        let s = startWidget ? parseFloat(startWidget.value) || 0 : 0;
                        let e_val = endWidget ? parseFloat(endWidget.value) || duration : duration;
                        if (Math.abs(val - s) < Math.abs(val - e_val)) {
                            dragging = 'start';
                            if(startWidget) startWidget.value = parseFloat(Math.min(val, e_val).toFixed(3));
                        } else {
                            dragging = 'end';
                            if(endWidget) endWidget.value = parseFloat(Math.max(val, s).toFixed(3));
                        }
                        updateUI(true); app.graph.setDirtyCanvas(true, false);
                        sliderBox.setPointerCapture(e.pointerId);
                    };

                    sliderBox.onpointermove = (e) => {
                        if (!dragging || !duration) return;
                        const rect = sliderBox.getBoundingClientRect();
                        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                        const val = (x / rect.width) * duration;
                        if (dragging === 'start') {
                            let e_val = endWidget ? parseFloat(endWidget.value) || duration : duration;
                            if(startWidget) startWidget.value = parseFloat(Math.min(val, e_val).toFixed(3));
                        } else if (dragging === 'end') {
                            const s = startWidget ? parseFloat(startWidget.value) || 0 : 0;
                            if(endWidget) endWidget.value = parseFloat(Math.max(val, s).toFixed(3));
                        }
                        updateUI(true); app.graph.setDirtyCanvas(true, false);
                    };

                    sliderBox.onpointerup = (e) => { dragging = null; sliderBox.releasePointerCapture(e.pointerId); };

                    // Exit initialization phase
                    setTimeout(() => { node._initializing = false; }, 500);

                }, 100);
                return r;
            }
        }
    }
});