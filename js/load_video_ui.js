import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "Comfy.LoadVideoUI",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "LoadVideoUI") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            const onConfigure = nodeType.prototype.onConfigure;
            const onResize = nodeType.prototype.onResize;
            const onDrawForeground = nodeType.prototype.onDrawForeground;

            // Hook into workflow loading to instantly restore the video UI
            nodeType.prototype.onConfigure = function (info) {
                if (onConfigure) {
                    onConfigure.apply(this, arguments);
                }
                
                // Force UI synchronization
                if (this.syncFramesFromTime) this.syncFramesFromTime();
                if (this.toggleWidgetVisibility) this.toggleWidgetVisibility();
                
                if (this.widgets) {
                    const videoWidget = this.widgets.find(w => w.name === "video");
                    if (videoWidget && videoWidget.value && this.updatePreview) {
                        this.updatePreview(videoWidget.value);
                    }
                }
            };
            
            // Continuous frame-accurate check to guarantee exact height alignment 
            // even on initial graph load when the workflow reloads!
            nodeType.prototype.onDrawForeground = function (ctx) {
                if (onDrawForeground) onDrawForeground.apply(this, arguments);
                
                if (this.domWidget && this.domWidget.element && this.domWidget.last_y) {
                    const remainingHeight = this.size[1] - this.domWidget.last_y - 18;
                    const currentHeight = parseFloat(this.domWidget.element.style.height);
                    const targetHeight = Math.max(150, remainingHeight);
                    
                    // Only update DOM if the height has drifted by more than 1 pixel
                    if (isNaN(currentHeight) || Math.abs(currentHeight - targetHeight) > 1) {
                        this.domWidget.element.style.height = `${targetHeight}px`;
                    }
                }
            };

            // Allow the node to scale nicely when resized by the user
            nodeType.prototype.onResize = function (size) {
                if (onResize) onResize.apply(this, arguments);
                if (this.domWidget && this.domWidget.element) {
                    // Fill the exact width provided by LiteGraph's bounds natively
                    this.domWidget.element.style.width = "100%";
                    this.domWidget.element.style.margin = "0";
                    
                    // Fallback calc if last_y isn't ready
                    let yOffset = this.domWidget.last_y;
                    if (!yOffset) {
                        yOffset = 30; // Default LiteGraph Title Height
                        if (this.widgets) {
                            for (let w of this.widgets) {
                                if (w === this.domWidget) break;
                                yOffset += (w.computeSize ? w.computeSize()[1] : 20) + 4;
                            }
                        }
                    }
                    
                    const remainingHeight = size[1] - yOffset - 18;
                    this.domWidget.element.style.height = `${Math.max(150, remainingHeight)}px`;
                }
            };

            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                const node = this;

                // Find the core widgets
                const videoWidget = this.widgets.find((w) => w.name === "video");
                const frameRateWidget = this.widgets.find((w) => w.name === "frame_rate");
                const displayModeWidget = this.widgets.find((w) => w.name === "display_mode");
                
                const startTimeWidget = this.widgets.find((w) => w.name === "start_time");
                const endTimeWidget = this.widgets.find((w) => w.name === "end_time");
                const durationWidget = this.widgets.find((w) => w.name === "duration");
                
                const startFrameWidget = this.widgets.find((w) => w.name === "start_frame");
                const endFrameWidget = this.widgets.find((w) => w.name === "end_frame");
                const durationFramesWidget = this.widgets.find((w) => w.name === "duration_frames");

                // ====================================================================
                // WIDGET HIDING & SYNC ENGINE
                // ====================================================================
                let isSyncing = false;
                
                function setWidgetVisibility(w, visible, typeStr) {
                    if (!w) return;
                    w.hidden = !visible;
                    if (!visible) {
                        w.type = "hidden";
                        w.computeSize = () => [0, -4]; // Suppresses gap allocation in V1
                    } else {
                        w.type = typeStr;
                        delete w.computeSize; // Restores standard ComfyUI measurement
                    }
                }
                
                node.toggleWidgetVisibility = function() {
                    const isFrames = displayModeWidget && displayModeWidget.value === "frames";
                    setWidgetVisibility(startTimeWidget, !isFrames, "FLOAT");
                    setWidgetVisibility(endTimeWidget, !isFrames, "FLOAT");
                    setWidgetVisibility(durationWidget, !isFrames, "FLOAT");
                    setWidgetVisibility(startFrameWidget, isFrames, "INT");
                    setWidgetVisibility(endFrameWidget, isFrames, "INT");
                    setWidgetVisibility(durationFramesWidget, isFrames, "INT");
                    setWidgetVisibility(displayModeWidget, false, "combo"); // Toggle is hidden, driven by UI
                    
                    // Allow the node to calculate its required min size, but DO NOT overwrite
                    // the current user-defined width/height unless it's strictly smaller than the minimum.
                    const minSize = node.computeSize();
                    node.size[0] = Math.max(node.size[0], minSize[0]);
                    node.size[1] = Math.max(node.size[1], minSize[1]);
                    
                    if (node.onResize) node.onResize(node.size);
                    app.graph.setDirtyCanvas(true, true);
                };
                
                node.syncFramesFromTime = function() {
                    if (isSyncing || !frameRateWidget) return;
                    isSyncing = true;
                    const fr = frameRateWidget.value || 24;
                    if (startTimeWidget && startFrameWidget) startFrameWidget.value = Math.round(startTimeWidget.value * fr);
                    if (endTimeWidget && endFrameWidget) endFrameWidget.value = Math.round(endTimeWidget.value * fr);
                    if (durationWidget && durationFramesWidget) durationFramesWidget.value = Math.round(durationWidget.value * fr);
                    isSyncing = false;
                };

                node.syncTimeFromFrames = function() {
                    if (isSyncing || !frameRateWidget) return;
                    isSyncing = true;
                    const fr = frameRateWidget.value || 24;
                    if (startTimeWidget && startFrameWidget) startTimeWidget.value = parseFloat((startFrameWidget.value / fr).toFixed(3));
                    if (endTimeWidget && endFrameWidget) endTimeWidget.value = parseFloat((endFrameWidget.value / fr).toFixed(3));
                    if (durationWidget && durationFramesWidget) durationFramesWidget.value = parseFloat((durationFramesWidget.value / fr).toFixed(3));
                    isSyncing = false;
                };

                // Bind standard input callbacks to synchronize automatically
                function bindWidget(w, isFrame, isFrameRate = false) {
                    if (!w) return;
                    const orig = w.callback;
                    w.callback = function() {
                        if (orig) orig.apply(this, arguments);
                        if (isFrame) node.syncTimeFromFrames();
                        else node.syncFramesFromTime();
                        
                        // Always force a ruler update if framerate changes so the timeline marks match the new rate
                        if (duration === 0 || isFrameRate) updateRuler();
                        updateUI(true);
                    };
                }
                
                bindWidget(startTimeWidget, false);
                bindWidget(endTimeWidget, false);
                bindWidget(startFrameWidget, true);
                bindWidget(endFrameWidget, true);
                bindWidget(frameRateWidget, false, true); // Triggers re-sync of frames from time AND updates ruler

                // Bind update function to the node so onConfigure can access it
                node.updatePreview = function(filename) {
                    if (!filename) {
                        return;
                    }
                    let url;
                    
                    // Check if absolute path (Starts with C:\ or /)
                    if (filename.match(/^[a-zA-Z]:\\/) || filename.startsWith('/')) {
                        url = api.apiURL(`/video_ui_custom_view?filename=${encodeURIComponent(filename)}`);
                    } else {
                        url = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input`);
                    }

                    if (videoPreview) videoPreview.src = url;
                };

                if (videoWidget) {
                    const originalCallback = videoWidget.callback;
                    videoWidget.callback = function() {
                        if (originalCallback) originalCallback.apply(this, arguments);
                        if (node.updatePreview) node.updatePreview(this.value); 
                    };
                }

                // Initialize widget visibility right away
                if (displayModeWidget && !displayModeWidget.value) displayModeWidget.value = "seconds";
                node.toggleWidgetVisibility();

                // ====================================================================
                // CHOOSE FILE BUTTON (Native ComfyUI Widget, placed below duration)
                // ====================================================================
                const fileInput = document.createElement("input");
                fileInput.type = "file";
                fileInput.accept = "video/*";
                fileInput.style.display = "none";
                document.body.appendChild(fileInput);
                
                const btnWidget = this.addWidget("button", "choose file to upload", null, () => {
                    fileInput.click();
                });

                // Define robust upload logic
                const uploadFile = async (file) => {
                    try {
                        if (errorMsg) errorMsg.style.display = "none";

                        // Fast Path: If desktop environment exposes absolute file path, skip upload entirely!
                        if (file.path) {
                            videoWidget.value = file.path;
                            node.updatePreview(file.path);
                            if(startTimeWidget) startTimeWidget.value = 0;
                            if(endTimeWidget) endTimeWidget.value = 0;
                            node.syncFramesFromTime();
                            return;
                        }

                        btnWidget.name = "Uploading...";
                        node.setDirtyCanvas(true, false);

                        const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks

                        if (file.size > CHUNK_SIZE) {
                            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
                            const safeFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                            const safeName = Date.now() + "_" + safeFileName;

                            for (let i = 0; i < totalChunks; i++) {
                                btnWidget.name = `Uploading... ${Math.round((i / totalChunks) * 100)}%`;
                                node.setDirtyCanvas(true, false);
                                
                                const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
                                
                                const formData = new FormData();
                                formData.append("file", chunk);
                                formData.append("filename", safeName);
                                formData.append("chunk_index", i);
                                formData.append("total_chunks", totalChunks);

                                const resp = await api.fetchApi("/video_ui_upload_chunk", {
                                    method: "POST",
                                    body: formData,
                                });

                                if (resp.status !== 200) {
                                    throw new Error("Chunk upload failed");
                                }
                                
                                if (i === totalChunks - 1) {
                                    const data = await resp.json();
                                    videoWidget.value = data.name;
                                    node.updatePreview(data.name);
                                    if(startTimeWidget) startTimeWidget.value = 0;
                                    if(endTimeWidget) endTimeWidget.value = 0;
                                    node.syncFramesFromTime();
                                }
                            }
                        } else {
                            // Standard upload for small files
                            const body = new FormData();
                            body.append("image", file);

                            const resp = await api.fetchApi("/upload/image", {
                                method: "POST",
                                body: body,
                            });

                            if (resp.status === 413) {
                                throw new Error("File too large. Make sure python backend has the chunking update.");
                            }

                            if (resp.status === 200) {
                                const data = await resp.json();
                                videoWidget.value = data.name;
                                node.updatePreview(data.name);
                                if(startTimeWidget) startTimeWidget.value = 0;
                                if(endTimeWidget) endTimeWidget.value = 0;
                                node.syncFramesFromTime();
                            } else {
                                throw new Error(`Upload failed: ${resp.statusText}`);
                            }
                        }
                    } catch (error) {
                        console.error("Upload failed", error);
                        if (errorMsg) {
                            errorMsg.textContent = "Upload failed. Check console.";
                            errorMsg.style.display = "block";
                        }
                    } finally {
                        btnWidget.name = "choose file to upload";
                        node.setDirtyCanvas(true, false);
                        fileInput.value = ""; // reset input
                    }
                };

                fileInput.addEventListener("change", (e) => {
                    if (e.target.files.length) {
                        uploadFile(e.target.files[0]);
                    }
                });

                // Attach drag & drop directly onto the LiteGraph node canvas frame
                node.onDropFile = function(file) {
                    // Check MIME type or common video file extensions to ensure all videos are caught
                    if (file.type.startsWith('video/') || file.name.toLowerCase().match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/)) {
                        uploadFile(file);
                        return true; 
                    }
                    return false;
                };

                // Clean up DOM elements strictly tied to this node instance
                const originalOnRemove = node.onRemoved;
                node.onRemoved = function() {
                    if(fileInput && fileInput.parentNode) fileInput.parentNode.removeChild(fileInput);
                    if(originalOnRemove) originalOnRemove.apply(this, arguments);
                };

                // ====================================================================
                // UI CONTAINER (Preview & Timeline Editor)
                // ====================================================================
                const container = document.createElement("div");
                const defaultBg = "rgba(30, 30, 30, 0.9)";
                Object.assign(container.style, {
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px", 
                    width: "100%", 
                    margin: "0", 
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

                const errorMsg = document.createElement("div");
                Object.assign(errorMsg.style, {
                    color: "#ff6b6b",
                    fontSize: "11px",
                    display: "none",
                    marginBottom: "4px",
                    flexShrink: "0",
                    boxSizing: "border-box"
                });
                container.appendChild(errorMsg);

                // Top Bar: Display Mode Toggle & Trimmed Length
                const playerTop = document.createElement("div");
                Object.assign(playerTop.style, {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "0 2px",
                    marginBottom: "-4px",
                    flexShrink: "0", 
                    boxSizing: "border-box",
                    flexWrap: "wrap", // Prevent squishing/overflow by letting it wrap gracefully
                    gap: "6px"
                });
                
                // Toggle Container UI
                const toggleWrapper = document.createElement("div");
                Object.assign(toggleWrapper.style, {
                    display: "flex",
                    alignItems: "center",
                    gap: "4px", 
                    background: "rgba(0, 0, 0, 0.2)",
                    padding: "0 6px",
                    borderRadius: "4px",
                    height: "22px",
                    boxSizing: "border-box"
                });
                
                const toggleTitle = document.createElement("span");
                toggleTitle.textContent = "Display:";
                Object.assign(toggleTitle.style, {
                    fontSize: "11px",
                    color: "#38bdf8", // Locked to Blue
                    fontWeight: "bold"
                });
                
                const modeText = document.createElement("span");
                Object.assign(modeText.style, {
                    fontSize: "11px",
                    color: "#38bdf8", // Locked to Blue
                    fontWeight: "bold",
                    minWidth: "40px",
                    textAlign: "left", // Changed to left for tighter alignment with "Display:"
                    marginRight: "4px" // Adds spacing before the toggle switch
                });
                modeText.textContent = "Time";
                
                const switchBox = document.createElement("div");
                Object.assign(switchBox.style, {
                    width: "26px", height: "14px", background: "#38bdf8", borderRadius: "14px", // Shorter and adjusted width
                    display: "flex", alignItems: "center", padding: "2px", boxSizing: "border-box", // Uses flexbox to perfectly center thumb
                    cursor: "pointer", transition: "background 0.3s",
                    flexShrink: "0"
                });
                
                const switchThumb = document.createElement("div");
                Object.assign(switchThumb.style, {
                    width: "10px", height: "10px", background: "white", borderRadius: "50%",
                    transition: "transform 0.3s"
                });
                switchBox.appendChild(switchThumb);

                let isFramesMode = false;
                switchBox.onclick = () => {
                    isFramesMode = !isFramesMode;
                    
                    // Switch only the toggle button itself: Custom Blue (#257eeb) for Frames, Light Blue (#38bdf8) for Time
                    switchBox.style.background = isFramesMode ? "#257eeb" : "#38bdf8";
                    switchThumb.style.transform = isFramesMode ? "translateX(12px)" : "translateX(0px)"; // Adjusted translation to fit smaller box
                    modeText.textContent = isFramesMode ? "Frames" : "Time";
                    
                    if (displayModeWidget) displayModeWidget.value = isFramesMode ? "frames" : "seconds";
                    
                    // Sync values perfectly on flip
                    if (isFramesMode) node.syncFramesFromTime();
                    else node.syncTimeFromFrames();
                    
                    node.toggleWidgetVisibility();
                    updateRuler();
                    updateUI(true);
                };
                
                // Reordered appending to match requested Layout (Display: -> Mode Text -> Toggle Switch)
                toggleWrapper.appendChild(toggleTitle);
                toggleWrapper.appendChild(modeText);
                toggleWrapper.appendChild(switchBox);
                
                playerTop.appendChild(toggleWrapper);

                const trimLength = document.createElement("span");
                Object.assign(trimLength.style, {
                    display: "flex",
                    alignItems: "center",
                    fontSize: "11px",
                    color: "#38bdf8", // Always remains blue
                    fontWeight: "bold",
                    background: "rgba(56, 189, 248, 0.1)", // Always remains blue
                    padding: "0 6px",
                    borderRadius: "4px",
                    whiteSpace: "nowrap",
                    height: "22px",
                    boxSizing: "border-box"
                });
                trimLength.textContent = "Trimmed: 0:00";
                playerTop.appendChild(trimLength);
                
                container.appendChild(playerTop);

                // Video Preview Area (Native Controls)
                const videoPreview = document.createElement("video");
                Object.assign(videoPreview.style, {
                    width: "100%",
                    background: "#000",
                    borderRadius: "4px",
                    objectFit: "contain",
                    flexGrow: "1", // Force player to expand and fill available vertical space dynamically calculated by onResize
                    minHeight: "0px", 
                    outline: "none",
                    boxSizing: "border-box"
                });
                videoPreview.controls = true; 
                videoPreview.controlsList = "nodownload nofullscreen noremoteplayback"; 
                videoPreview.muted = false; // Changed from true to false so the video starts unmuted
                container.appendChild(videoPreview);

                // Trim Area (Time Ruler & Slider)
                const trimArea = document.createElement("div");
                Object.assign(trimArea.style, {
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                    background: "rgba(0, 0, 0, 0.35)",
                    padding: "12px",
                    borderRadius: "6px",
                    border: "1px solid rgba(255, 255, 255, 0.05)",
                    flexShrink: "0", // Prevent timeline from squishing when shrinking node
                    boxSizing: "border-box" 
                });

                const timeRuler = document.createElement("div");
                Object.assign(timeRuler.style, {
                    position: "relative",
                    width: "100%",
                    height: "22px",
                    fontSize: "10px",
                    color: "#aaa",
                    pointerEvents: "none",
                    userSelect: "none",
                    boxSizing: "border-box"
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
                    boxShadow: "inset 0 1px 3px rgba(0,0,0,0.5)",
                    boxSizing: "border-box"
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

                // Delay DOM Widget creation to ensure it is added after all standard widgets
                setTimeout(() => {
                    // Add HTML widget to LiteGraph
                    node.domWidget = node.addDOMWidget("VideoUI", "div", container);
                    
                    // Fixed: Return a solid minimum required bounding box.
                    // Bumped horizontal from 200px to 360px. This natively stops LiteGraph 
                    // from letting the node be squished too thin, completely preventing overlap.
                    node.domWidget.computeSize = function() {
                        return [360, 250]; 
                    };
    
                    // Applies the default creation bounds natively, increased default height
                    // to match the widgets required height out of the box.
                    requestAnimationFrame(() => {
                        if (node.size[0] < 550) {
                            node.size[0] = 550;
                        }
                        
                        // INCREASE DEFAULT HEIGHT HERE:
                        // Change the 620 below to adjust the starting height of the node
                        if (node.size[1] < 680) {
                            node.size[1] = 680;
                        }
                        
                        // Trigger manual resize call so the vertical math applies instantly
                        if (node.onResize) node.onResize(node.size);
                        
                        // Sync visual toggle to initial data
                        if (displayModeWidget && displayModeWidget.value === "frames") {
                            isFramesMode = false; // prime for click
                            switchBox.onclick();
                        }
                        
                        app.graph.setDirtyCanvas(true, true);
                    });
                }, 100);

                // ====================================================================
                // LOGIC & SYNCING
                // ====================================================================
                let duration = 0;
                let dragging = null;
                let dragOffset = 0;
                let dragSelectionWidth = 0;
                let isUpdatingDuration = false;

                // Smart helper to ensure timeline displays correctly even with no video loaded
                const getActiveDuration = () => {
                    if (duration > 0) return duration;
                    let e = endTimeWidget ? parseFloat(endTimeWidget.value) || 0 : 0;
                    let s = startTimeWidget ? parseFloat(startTimeWidget.value) || 0 : 0;
                    let maxVal = Math.max(e, s);
                    return maxVal > 0 ? Math.max(maxVal, 1.0) : 1.0; // Default to 1.0 if completely empty
                };

                // Time Duration Hook
                if (durationWidget) {
                    const origCallback = durationWidget.callback;
                    durationWidget.callback = function(v) {
                        if (isUpdatingDuration) {
                            if (origCallback) origCallback.apply(this, arguments);
                            return;
                        }
                        
                        isUpdatingDuration = true;
                        const activeDur = getActiveDuration();
                        let d = parseFloat(v) || 0;
                        if (d < 0) d = 0;
                        if (d > activeDur) d = activeDur;

                        let s = startTimeWidget ? parseFloat(startTimeWidget.value) || 0 : 0;
                        let newStart = s;
                        let newEnd = s + d;

                        if (newEnd > activeDur) {
                            newEnd = activeDur;
                            newStart = activeDur - d;
                        }

                        if (startTimeWidget) startTimeWidget.value = parseFloat(newStart.toFixed(2));
                        if (endTimeWidget) endTimeWidget.value = parseFloat(newEnd.toFixed(2));
                        node.syncFramesFromTime();

                        if (duration === 0) updateRuler();
                        updateUI(true);
                        app.graph.setDirtyCanvas(true, false);
                        
                        if (origCallback) origCallback.apply(this, arguments);
                        isUpdatingDuration = false;
                    };
                }

                // Frame Duration Hook
                if (durationFramesWidget) {
                    const origCallback = durationFramesWidget.callback;
                    durationFramesWidget.callback = function(v) {
                        if (isUpdatingDuration || !frameRateWidget) {
                            if (origCallback) origCallback.apply(this, arguments);
                            return;
                        }
                        
                        isUpdatingDuration = true;
                        const fr = frameRateWidget.value || 24;
                        const activeDurFrames = Math.round(getActiveDuration() * fr);
                        
                        let d = parseInt(v) || 0;
                        if (d < 0) d = 0;
                        if (d > activeDurFrames) d = activeDurFrames;

                        let s = startFrameWidget ? parseInt(startFrameWidget.value) || 0 : 0;
                        let newStart = s;
                        let newEnd = s + d;

                        if (newEnd > activeDurFrames) {
                            newEnd = activeDurFrames;
                            newStart = activeDurFrames - d;
                        }

                        if (startFrameWidget) startFrameWidget.value = newStart;
                        if (endFrameWidget) endFrameWidget.value = newEnd;
                        node.syncTimeFromFrames();

                        if (duration === 0) updateRuler();
                        updateUI(true);
                        app.graph.setDirtyCanvas(true, false);
                        
                        if (origCallback) origCallback.apply(this, arguments);
                        isUpdatingDuration = false;
                    };
                }

                // Standard Video Player Format HH:MM:SS (only shows hours if it's over an hour long)
                const formatTime = (secs) => {
                    const h = Math.floor(secs / 3600);
                    const m = Math.floor((secs % 3600) / 60);
                    const s = Math.floor(secs % 60);
                    const mStr = m.toString().padStart(2, '0');
                    const sStr = s.toString().padStart(2, '0');
                    
                    if (h > 0) {
                        return `${h}:${mStr}:${sStr}`;
                    } else {
                        return `${m}:${sStr}`;
                    }
                };

                const updateRuler = () => {
                    timeRuler.innerHTML = '';
                    const activeDur = getActiveDuration();
                    const numMajorTicks = 5;
                    const subTicks = 4;
                    const totalTicks = (numMajorTicks - 1) * subTicks; 
                    
                    const isFrames = displayModeWidget && displayModeWidget.value === "frames";
                    const fr = frameRateWidget ? frameRateWidget.value : 24;

                    for (let i = 0; i <= totalTicks; i++) {
                        const pct = i / totalTicks;
                        const t = activeDur * pct;
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
                            if (isFrames) {
                                label.textContent = Math.round(t * fr);
                            } else {
                                label.textContent = formatTime(t);
                            }
                            tickWrapper.appendChild(label);
                        }
                        timeRuler.appendChild(tickWrapper);
                    }
                };

                function updateUI(syncPlayer = false) {
                    const activeDur = getActiveDuration();
                    
                    let s = startTimeWidget ? parseFloat(startTimeWidget.value) || 0 : 0;
                    let e = endTimeWidget ? parseFloat(endTimeWidget.value) || 0 : 0;
                    
                    let visualEnd = e;
                    if (visualEnd === 0 || visualEnd > activeDur) visualEnd = activeDur;
                    if (s > visualEnd) s = visualEnd;

                    let pStart = (s / activeDur) * 100;
                    let pEnd = (visualEnd / activeDur) * 100;

                    pStart = Math.max(0, Math.min(pStart, 100));
                    pEnd = Math.max(0, Math.min(pEnd, 100));

                    startHandle.style.left = `${pStart}%`;
                    endHandle.style.left = `${pEnd}%`;
                    
                    fill.style.left = `${pStart}%`;
                    fill.style.width = `${pEnd - pStart}%`;

                    const currentDur = parseFloat((visualEnd - s).toFixed(2));
                    const isFrames = displayModeWidget && displayModeWidget.value === "frames";
                    const fr = frameRateWidget ? frameRateWidget.value : 24;

                    if (isFrames) {
                        trimLength.textContent = `Trimmed: ${Math.round(currentDur * fr)} frames`;
                        // Keeps its blue styling securely
                    } else {
                        trimLength.textContent = `Trimmed: ${formatTime(currentDur)}`;
                        // Keeps its blue styling securely
                    }
                    
                    // Only automatically push data directly to durationWidget if a real video is loaded 
                    if (duration > 0 && !isUpdatingDuration) {
                        isUpdatingDuration = true;
                        if (durationWidget && durationWidget.value !== currentDur) {
                            durationWidget.value = currentDur;
                        }
                        if (durationFramesWidget && durationFramesWidget.value !== Math.round(currentDur * fr)) {
                            durationFramesWidget.value = Math.round(currentDur * fr);
                        }
                        isUpdatingDuration = false;
                    }

                    if (syncPlayer && duration > 0) {
                        videoPreview.currentTime = s;
                    }
                }

                // Force draw default empty state on creation
                setTimeout(() => {
                    updateRuler();
                    updateUI();
                }, 50);

                videoPreview.onloadedmetadata = () => {
                    duration = videoPreview.duration;
                    if (endTimeWidget && (endTimeWidget.value === 0 || endTimeWidget.value > duration)) {
                        endTimeWidget.value = duration;
                        node.syncFramesFromTime();
                    }
                    updateRuler();
                    updateUI();
                };

                // Loop Trim during Native Playback
                videoPreview.ontimeupdate = () => {
                    if (!duration || dragging) return;
                    
                    let s = startTimeWidget ? parseFloat(startTimeWidget.value) || 0 : 0;
                    let e = endTimeWidget ? parseFloat(endTimeWidget.value) || duration : duration;
                    if (e === 0) e = duration;

                    if (videoPreview.currentTime >= e && e > 0) {
                        videoPreview.currentTime = s;
                    } else if (videoPreview.currentTime < s) {
                        videoPreview.currentTime = s;
                    }
                };

                // --- Timeline Drag Logic (Primary state runs in Seconds format to lock playback natively) ---
                sliderBox.onpointerdown = (e) => {
                    const activeDur = getActiveDuration();
                    const rect = sliderBox.getBoundingClientRect();
                    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                    const val = (x / rect.width) * activeDur;
                    
                    let s = startTimeWidget ? parseFloat(startTimeWidget.value) || 0 : 0;
                    let e_val = endTimeWidget ? parseFloat(endTimeWidget.value) || activeDur : activeDur;
                    if (e_val === 0) e_val = activeDur;
                    
                    const handleTolerance = (10 / rect.width) * activeDur;
                    
                    if (val > s + handleTolerance && val < e_val - handleTolerance) {
                        dragging = 'center';
                        dragOffset = val - s;
                        dragSelectionWidth = e_val - s;
                    } else if (Math.abs(val - s) < Math.abs(val - e_val)) {
                        dragging = 'start';
                        if(startTimeWidget) startTimeWidget.value = parseFloat(Math.min(val, e_val).toFixed(2));
                        if(duration > 0) videoPreview.currentTime = startTimeWidget.value;
                    } else {
                        dragging = 'end';
                        if(endTimeWidget) endTimeWidget.value = parseFloat(Math.max(val, s).toFixed(2));
                        if(duration > 0) videoPreview.currentTime = endTimeWidget.value;
                    }
                    
                    node.syncFramesFromTime();
                    updateUI(); 
                    app.graph.setDirtyCanvas(true, false);
                    sliderBox.setPointerCapture(e.pointerId);
                };

                sliderBox.onpointermove = (e) => {
                    if (!dragging) return;
                    const activeDur = getActiveDuration();
                    const rect = sliderBox.getBoundingClientRect();
                    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                    const val = (x / rect.width) * activeDur;
                    
                    if (dragging === 'start') {
                        let e_val = endTimeWidget ? parseFloat(endTimeWidget.value) || activeDur : activeDur;
                        if (e_val === 0) e_val = activeDur;
                        if(startTimeWidget) startTimeWidget.value = parseFloat(Math.min(val, e_val).toFixed(2));
                        if(duration > 0) videoPreview.currentTime = startTimeWidget.value;
                    } else if (dragging === 'end') {
                        const s = startTimeWidget ? parseFloat(startTimeWidget.value) || 0 : 0;
                        if(endTimeWidget) endTimeWidget.value = parseFloat(Math.max(val, s).toFixed(2));
                        if(duration > 0) videoPreview.currentTime = endTimeWidget.value;
                    } else if (dragging === 'center') {
                        let newStart = val - dragOffset;
                        let newEnd = newStart + dragSelectionWidth;
                        
                        if (newStart < 0) {
                            newStart = 0;
                            newEnd = dragSelectionWidth;
                        } else if (newEnd > activeDur) {
                            newEnd = activeDur;
                            newStart = activeDur - dragSelectionWidth;
                        }
                        
                        if(startTimeWidget) startTimeWidget.value = parseFloat(newStart.toFixed(2));
                        if(endTimeWidget) endTimeWidget.value = parseFloat(newEnd.toFixed(2));
                        if(duration > 0) videoPreview.currentTime = startTimeWidget.value;
                    }
                    
                    node.syncFramesFromTime();
                    updateUI(); 
                    app.graph.setDirtyCanvas(true, false);
                };

                sliderBox.onpointerup = (e) => { 
                    dragging = null; 
                    sliderBox.releasePointerCapture(e.pointerId); 
                };

                // --- Improved Global Drag & Drop for Node Inner Content ---
                let dragCounter = 0;
                container.addEventListener("dragenter", (e) => {
                    e.preventDefault();
                    dragCounter++;
                    if (dragCounter === 1) {
                        container.style.outline = "2px dashed #38bdf8";
                        container.style.outlineOffset = "-2px";
                        container.style.background = "rgba(14, 165, 233, 0.1)";
                    }
                });
                
                container.addEventListener("dragover", (e) => {
                    e.preventDefault(); 
                });

                container.addEventListener("dragleave", (e) => {
                    e.preventDefault();
                    dragCounter--;
                    if (dragCounter === 0) {
                        container.style.outline = "none";
                        container.style.background = defaultBg;
                    }
                });
                
                container.addEventListener("drop", (e) => {
                    e.preventDefault();
                    e.stopPropagation(); 
                    dragCounter = 0;
                    container.style.outline = "none";
                    container.style.background = defaultBg;
                    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        const file = e.dataTransfer.files[0];
                        if (file.type.startsWith('video/') || file.name.toLowerCase().match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/)) {
                            uploadFile(file);
                        }
                    }
                });

                if (videoWidget && videoWidget.value) {
                    node.updatePreview(videoWidget.value);
                }

                return r;
            };
        }
    },
});