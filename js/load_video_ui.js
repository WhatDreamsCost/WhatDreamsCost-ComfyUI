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
                if (this.syncToggleVisual) this.syncToggleVisual();

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

                const cropXWidget = this.widgets.find((w) => w.name === "crop_x");
                const cropYWidget = this.widgets.find((w) => w.name === "crop_y");
                const cropWWidget = this.widgets.find((w) => w.name === "crop_w");
                const cropHWidget = this.widgets.find((w) => w.name === "crop_h");

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

                node.toggleWidgetVisibility = function () {
                    const isFrames = displayModeWidget && displayModeWidget.value === "frames";
                    setWidgetVisibility(startTimeWidget, !isFrames, "FLOAT");
                    setWidgetVisibility(endTimeWidget, !isFrames, "FLOAT");
                    setWidgetVisibility(durationWidget, !isFrames, "FLOAT");
                    setWidgetVisibility(startFrameWidget, isFrames, "INT");
                    setWidgetVisibility(endFrameWidget, isFrames, "INT");
                    setWidgetVisibility(durationFramesWidget, isFrames, "INT");
                    setWidgetVisibility(displayModeWidget, false, "combo"); // Toggle is hidden, driven by UI

                    setWidgetVisibility(cropXWidget, false, "FLOAT");
                    setWidgetVisibility(cropYWidget, false, "FLOAT");
                    setWidgetVisibility(cropWWidget, false, "FLOAT");
                    setWidgetVisibility(cropHWidget, false, "FLOAT");

                    // Allow the node to calculate its required min size, but DO NOT overwrite
                    // the current user-defined width/height unless it's strictly smaller than the minimum.
                    const minSize = node.computeSize();
                    node.size[0] = Math.max(node.size[0], minSize[0]);
                    node.size[1] = Math.max(node.size[1], minSize[1]);

                    if (node.onResize) node.onResize(node.size);
                    app.graph.setDirtyCanvas(true, true);
                };

                node.syncFramesFromTime = function () {
                    if (isSyncing || !frameRateWidget) return;
                    isSyncing = true;
                    const fr = frameRateWidget.value || 24;
                    if (startTimeWidget && startFrameWidget) startFrameWidget.value = Math.round(startTimeWidget.value * fr);
                    if (endTimeWidget && endFrameWidget) endFrameWidget.value = Math.round(endTimeWidget.value * fr);
                    if (durationWidget && durationFramesWidget) durationFramesWidget.value = Math.round(durationWidget.value * fr);
                    isSyncing = false;
                };

                node.syncTimeFromFrames = function () {
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
                    w.callback = function () {
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
                node.updatePreview = function (filename) {
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
                    videoWidget.callback = function () {
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
                            if (startTimeWidget) startTimeWidget.value = 0;
                            if (endTimeWidget) endTimeWidget.value = 0;
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
                                    if (startTimeWidget) startTimeWidget.value = 0;
                                    if (endTimeWidget) endTimeWidget.value = 0;
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
                                if (startTimeWidget) startTimeWidget.value = 0;
                                if (endTimeWidget) endTimeWidget.value = 0;
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
                node.onDropFile = function (file) {
                    // Check MIME type or common video file extensions to ensure all videos are caught
                    if (file.type.startsWith('video/') || file.name.toLowerCase().match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/)) {
                        uploadFile(file);
                        return true;
                    }
                    return false;
                };

                // Clean up DOM elements strictly tied to this node instance
                const originalOnRemove = node.onRemoved;
                node.onRemoved = function () {
                    if (fileInput && fileInput.parentNode) fileInput.parentNode.removeChild(fileInput);
                    if (originalOnRemove) originalOnRemove.apply(this, arguments);
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
                    fontSize: "12px",
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
                    gap: "6px",
                    position: "relative"
                });

                // Toggle Container UI
                const toggleWrapper = document.createElement("div");
                Object.assign(toggleWrapper.style, {
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    background: "rgba(0, 0, 0, 0.2)",
                    padding: "0 8px",
                    borderRadius: "4px",
                    height: "22px",
                    boxSizing: "border-box"
                });

                const toggleTitle = document.createElement("span");
                toggleTitle.textContent = "Display Mode";
                Object.assign(toggleTitle.style, {
                    fontSize: "12px",
                    color: "#38bdf8",
                    fontWeight: "bold",
                    whiteSpace: "nowrap"
                });

                // Segmented pill control
                const segmentedToggle = document.createElement("div");
                Object.assign(segmentedToggle.style, {
                    display: "flex",
                    alignItems: "center",
                    background: "rgba(0, 0, 0, 0.35)",
                    border: "1px solid rgba(56, 189, 248, 0.3)",
                    borderRadius: "4px",
                    overflow: "hidden",
                    height: "18px",
                    flexShrink: "0",
                    cursor: "pointer"
                });

                const createSegBtn = (label) => {
                    const btn = document.createElement("span");
                    btn.textContent = label;
                    Object.assign(btn.style, {
                        fontSize: "11px",
                        fontWeight: "bold",
                        padding: "0 8px",
                        lineHeight: "18px",
                        color: "rgba(255,255,255,0.45)",
                        background: "transparent",
                        transition: "background 0.2s, color 0.2s",
                        userSelect: "none",
                        whiteSpace: "nowrap"
                    });
                    return btn;
                };

                const segTime = createSegBtn("Time");
                const segDivider = document.createElement("span");
                segDivider.style.cssText = "width:1px;height:12px;background:rgba(56,189,248,0.25);flex-shrink:0;";
                const segFrames = createSegBtn("Frames");

                segmentedToggle.appendChild(segTime);
                segmentedToggle.appendChild(segDivider);
                segmentedToggle.appendChild(segFrames);

                const applySegmentState = (frames) => {
                    if (frames) {
                        segTime.style.background = "transparent";
                        segTime.style.color = "rgba(255,255,255,0.45)";
                        segFrames.style.background = "rgba(37,126,235,0.85)";
                        segFrames.style.color = "#fff";
                    } else {
                        segTime.style.background = "rgba(56,189,248,0.85)";
                        segTime.style.color = "#fff";
                        segFrames.style.background = "transparent";
                        segFrames.style.color = "rgba(255,255,255,0.45)";
                    }
                };

                // Keep a reference so the init block below can call it
                let isFramesMode = false;
                applySegmentState(false); // Default: Time is active

                const doToggle = () => {
                    isFramesMode = !isFramesMode;
                    applySegmentState(isFramesMode);

                    if (displayModeWidget) displayModeWidget.value = isFramesMode ? "frames" : "seconds";

                    // Sync values perfectly on flip
                    if (isFramesMode) node.syncFramesFromTime();
                    else node.syncTimeFromFrames();

                    node.toggleWidgetVisibility();
                    updateRuler();
                    updateUI(true);
                };

                segmentedToggle.onclick = doToggle;

                // Expose the switch activation so the init requestAnimationFrame below can call it
                const switchBox = { onclick: doToggle };

                // Allow onConfigure (workflow reload) to re-sync the visual highlight
                node.syncToggleVisual = function () {
                    const savedIsFrames = displayModeWidget && displayModeWidget.value === "frames";
                    isFramesMode = savedIsFrames;
                    applySegmentState(savedIsFrames);
                };

                toggleWrapper.appendChild(toggleTitle);
                toggleWrapper.appendChild(segmentedToggle);

                const leftContainer = document.createElement("div");
                Object.assign(leftContainer.style, {
                    flex: "1 1 0%",
                    display: "flex",
                    justifyContent: "flex-start",
                    minWidth: "max-content"
                });
                leftContainer.appendChild(toggleWrapper);
                playerTop.appendChild(leftContainer);

                const trimLength = document.createElement("span");
                Object.assign(trimLength.style, {
                    display: "flex",
                    alignItems: "center",
                    fontSize: "12px",
                    color: "#38bdf8", // Always remains blue
                    fontWeight: "bold",
                    background: "rgba(56, 189, 248, 0.1)", // Always remains blue
                    padding: "0 6px",
                    borderRadius: "4px",
                    whiteSpace: "nowrap",
                    height: "22px",
                    boxSizing: "border-box",
                    cursor: "pointer"
                });
                trimLength.textContent = "Trimmed: 0:00";

                const cropBtn = document.createElement("button");
                cropBtn.textContent = "Crop";
                Object.assign(cropBtn.style, {
                    background: "rgba(255, 255, 255, 0.1)",
                    color: "white",
                    border: "none",
                    borderRadius: "4px",
                    padding: "0 8px",
                    height: "22px",
                    fontSize: "12px",
                    fontWeight: "bold",
                    cursor: "pointer"
                });

                let isCropVisible = false;

                const cropUIContainer = document.createElement("div");
                Object.assign(cropUIContainer.style, {
                    display: "flex", alignItems: "center", gap: "6px", zIndex: "11"
                });

                const cropDims = document.createElement("span");
                Object.assign(cropDims.style, {
                    fontSize: "12px", color: "#38bdf8", fontWeight: "bold",
                    display: "none", padding: "0 6px", pointerEvents: "none"
                });

                const cropEditContainer = document.createElement("div");
                Object.assign(cropEditContainer.style, {
                    display: "none", alignItems: "center", gap: "4px"
                });

                const arSelect = document.createElement("select");
                Object.assign(arSelect.style, {
                    background: "#222", color: "#fff", border: "1px solid #555",
                    borderRadius: "3px", fontSize: "12px", padding: "2px", outline: "none",
                    cursor: "pointer"
                });
                const ratios = [
                    { name: "Freeform", val: 0 },
                    { name: "Original", val: -1 },
                    { name: "1:1", val: 1 },
                    { name: "4:5", val: 4 / 5 },
                    { name: "5:4", val: 5 / 4 },
                    { name: "16:9", val: 16 / 9 },
                    { name: "9:16", val: 9 / 16 },
                    { name: "4:3", val: 4 / 3 },
                    { name: "3:4", val: 3 / 4 },
                    { name: "3:2", val: 3 / 2 },
                    { name: "2:3", val: 2 / 3 },
                    { name: "2:1", val: 2 },
                    { name: "1:2", val: 1 / 2 }
                ];
                ratios.forEach(r => {
                    const opt = document.createElement("option");
                    opt.textContent = r.name;
                    opt.value = r.val;
                    arSelect.appendChild(opt);
                });

                const wInput = document.createElement("input");
                const hInput = document.createElement("input");
                const inputStyle = {
                    width: "40px", background: "rgba(0,0,0,0.5)", color: "#38bdf8",
                    border: "1px solid #555", borderRadius: "3px", fontSize: "12px",
                    textAlign: "center", padding: "2px", outline: "none"
                };
                Object.assign(wInput.style, inputStyle);
                Object.assign(hInput.style, inputStyle);
                wInput.type = "text";
                hInput.type = "text";

                const xSpan = document.createElement("span");
                xSpan.textContent = "x";
                xSpan.style.color = "#888";
                xSpan.style.fontSize = "12px";

                cropEditContainer.appendChild(arSelect);
                cropEditContainer.appendChild(wInput);
                cropEditContainer.appendChild(xSpan);
                cropEditContainer.appendChild(hInput);

                cropUIContainer.appendChild(cropDims);
                cropUIContainer.appendChild(cropEditContainer);
                playerTop.appendChild(cropUIContainer);

                const rightContainer = document.createElement("div");
                Object.assign(rightContainer.style, {
                    flex: "1 1 0%",
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "6px",
                    minWidth: "max-content"
                });
                rightContainer.appendChild(cropBtn);
                rightContainer.appendChild(trimLength);
                playerTop.appendChild(rightContainer);

                let currentAspectRatio = 0;

                const handleManualDimensionInput = (isWidth) => {
                    const vw = videoPreview.videoWidth;
                    const vh = videoPreview.videoHeight;
                    if (!vw || !vh) return;

                    let newW = parseInt(wInput.value) || Math.round((cropWWidget ? parseFloat(cropWWidget.value) || 1 : 1) * vw);
                    let newH = parseInt(hInput.value) || Math.round((cropHWidget ? parseFloat(cropHWidget.value) || 1 : 1) * vh);

                    if (currentAspectRatio > 0) {
                        if (isWidth) {
                            newH = Math.round(newW / currentAspectRatio);
                        } else {
                            newW = Math.round(newH * currentAspectRatio);
                        }
                    }

                    newW = Math.max(1, Math.min(newW, vw));
                    newH = Math.max(1, Math.min(newH, vh));

                    let cw_val = newW / vw;
                    let ch_val = newH / vh;

                    let cx = cropXWidget ? parseFloat(cropXWidget.value) || 0 : 0;
                    let cy = cropYWidget ? parseFloat(cropYWidget.value) || 0 : 0;

                    if (cx + cw_val > 1) cx = 1 - cw_val;
                    if (cy + ch_val > 1) cy = 1 - ch_val;

                    if (cropXWidget) cropXWidget.value = parseFloat(cx.toFixed(3));
                    if (cropYWidget) cropYWidget.value = parseFloat(cy.toFixed(3));
                    if (cropWWidget) cropWWidget.value = parseFloat(cw_val.toFixed(3));
                    if (cropHWidget) cropHWidget.value = parseFloat(ch_val.toFixed(3));

                    updateCropUI();
                    app.graph.setDirtyCanvas(true, false);
                };

                wInput.addEventListener("change", () => handleManualDimensionInput(true));
                hInput.addEventListener("change", () => handleManualDimensionInput(false));
                wInput.addEventListener("keydown", (e) => { if (e.key === "Enter") handleManualDimensionInput(true); });
                hInput.addEventListener("keydown", (e) => { if (e.key === "Enter") handleManualDimensionInput(false); });

                arSelect.onchange = () => {
                    currentAspectRatio = parseFloat(arSelect.value);
                    if (currentAspectRatio === -1 && videoPreview.videoWidth) {
                        currentAspectRatio = videoPreview.videoWidth / videoPreview.videoHeight;
                    }
                    if (currentAspectRatio > 0 && videoPreview.videoWidth) {
                        const vw = videoPreview.videoWidth;
                        const vh = videoPreview.videoHeight;
                        let cw_val = cropWWidget ? parseFloat(cropWWidget.value) || 1 : 1;
                        let cx = cropXWidget ? parseFloat(cropXWidget.value) || 0 : 0;
                        let cy = cropYWidget ? parseFloat(cropYWidget.value) || 0 : 0;

                        const actualW = cw_val * vw;
                        let actualH = actualW / currentAspectRatio;
                        let ch_val = actualH / vh;

                        if (ch_val > 1) {
                            ch_val = 1;
                            const newActualW = vh * currentAspectRatio;
                            cw_val = newActualW / vw;
                        }
                        if (cy + ch_val > 1) cy = 1 - ch_val;
                        if (cx + cw_val > 1) cx = 1 - cw_val;

                        if (cropXWidget) cropXWidget.value = parseFloat(cx.toFixed(3));
                        if (cropYWidget) cropYWidget.value = parseFloat(cy.toFixed(3));
                        if (cropWWidget) cropWWidget.value = parseFloat(cw_val.toFixed(3));
                        if (cropHWidget) cropHWidget.value = parseFloat(ch_val.toFixed(3));

                        updateCropUI();
                        app.graph.setDirtyCanvas(true, false);
                    }
                };

                cropBtn.onclick = () => {
                    isCropVisible = !isCropVisible;
                    cropBtn.style.background = isCropVisible ? "#38bdf8" : "rgba(255, 255, 255, 0.1)";
                    cropBtn.style.color = isCropVisible ? "black" : "white";
                    if (isCropVisible) {
                        cropBox.style.display = "block";
                        cropEditContainer.style.display = "flex";
                        cropDims.style.display = "none";
                    } else {
                        cropBox.style.display = "none";
                        cropEditContainer.style.display = "none";
                        // updateCropUI handles cropDims visibility when off
                    }
                    if (isCropVisible) {
                        videoPreview.pause();
                        videoPreview.controls = false;
                    } else {
                        videoPreview.controls = true;
                    }
                    updateCropUI();
                };

                container.appendChild(playerTop);

                // Video Preview Area (Native Controls)
                const videoWrapper = document.createElement("div");
                Object.assign(videoWrapper.style, {
                    position: "relative",
                    width: "100%",
                    flexGrow: "1",
                    minHeight: "0px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "#000",
                    borderRadius: "4px",
                    overflow: "hidden"
                });

                const videoPreview = document.createElement("video");
                Object.assign(videoPreview.style, {
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    outline: "none",
                    boxSizing: "border-box"
                });
                videoPreview.controls = true;
                videoPreview.controlsList = "nodownload nofullscreen noremoteplayback";
                videoPreview.muted = false; // Changed from true to false so the video starts unmuted
                videoWrapper.appendChild(videoPreview);

                const cropBox = document.createElement("div");
                Object.assign(cropBox.style, {
                    position: "absolute",
                    border: "2px dashed #38bdf8",
                    display: "none",
                    pointerEvents: "auto",
                    cursor: "move",
                    boxSizing: "border-box",
                    boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.5)",
                    zIndex: "10",
                    overflow: "hidden"
                });

                // 3x3 Grid lines
                for (let i = 1; i <= 2; i++) {
                    const vLine = document.createElement("div");
                    Object.assign(vLine.style, {
                        position: "absolute", left: `${i * 33.33}%`, top: "0", bottom: "0",
                        borderLeft: "1px dashed rgba(255,255,255,0.3)", pointerEvents: "none"
                    });
                    const hLine = document.createElement("div");
                    Object.assign(hLine.style, {
                        position: "absolute", top: `${i * 33.33}%`, left: "0", right: "0",
                        borderTop: "1px dashed rgba(255,255,255,0.3)", pointerEvents: "none"
                    });
                    cropBox.appendChild(vLine);
                    cropBox.appendChild(hLine);
                }

                const createCropHandle = (cursor, pos, borders) => {
                    const h = document.createElement("div");
                    Object.assign(h.style, {
                        position: "absolute",
                        width: "20px",
                        height: "20px",
                        background: "transparent",
                        cursor: cursor,
                        pointerEvents: "auto",
                        ...borders,
                        ...pos
                    });
                    return h;
                };

                const tlHandle = createCropHandle("nwse-resize", { top: "-3px", left: "-3px" }, { borderTop: "6px solid #38bdf8", borderLeft: "6px solid #38bdf8" });
                const trHandle = createCropHandle("nesw-resize", { top: "-3px", right: "-3px" }, { borderTop: "6px solid #38bdf8", borderRight: "6px solid #38bdf8" });
                const blHandle = createCropHandle("nesw-resize", { bottom: "-3px", left: "-3px" }, { borderBottom: "6px solid #38bdf8", borderLeft: "6px solid #38bdf8" });
                const brHandle = createCropHandle("nwse-resize", { bottom: "-3px", right: "-3px" }, { borderBottom: "6px solid #38bdf8", borderRight: "6px solid #38bdf8" });

                const tmHandle = createCropHandle("ns-resize", { top: "-3px", left: "50%", transform: "translateX(-50%)" }, { borderTop: "6px solid #38bdf8", width: "16px", height: "10px" });
                const bmHandle = createCropHandle("ns-resize", { bottom: "-3px", left: "50%", transform: "translateX(-50%)" }, { borderBottom: "6px solid #38bdf8", width: "16px", height: "10px" });
                const lmHandle = createCropHandle("ew-resize", { top: "50%", left: "-3px", transform: "translateY(-50%)" }, { borderLeft: "6px solid #38bdf8", width: "10px", height: "16px" });
                const rmHandle = createCropHandle("ew-resize", { top: "50%", right: "-3px", transform: "translateY(-50%)" }, { borderRight: "6px solid #38bdf8", width: "10px", height: "16px" });

                const handles = [tlHandle, trHandle, blHandle, brHandle, tmHandle, bmHandle, lmHandle, rmHandle];
                handles.forEach(h => cropBox.appendChild(h));
                videoWrapper.appendChild(cropBox);

                container.appendChild(videoWrapper);

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
                    fontSize: "11px",
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
                    node.domWidget.computeSize = function () {
                        return [360, 250];
                    };

                    // Applies the default creation bounds natively, increased default height
                    // to match the widgets required height out of the box.
                    requestAnimationFrame(() => {
                        if (node.size[0] < 690) {
                            node.size[0] = 690;
                        }

                        // INCREASE DEFAULT HEIGHT HERE:
                        // Change the 620 below to adjust the starting height of the node
                        if (node.size[1] < 740) {
                            node.size[1] = 740;
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

                // Crop logic
                let cropDragging = null;
                let dragStartX = 0;
                let dragStartY = 0;
                let dragStartCropX = 0;
                let dragStartCropY = 0;
                let dragStartCropW = 1;
                let dragStartCropH = 1;

                const updateCropUI = () => {
                    const vw = videoPreview.videoWidth;
                    const vh = videoPreview.videoHeight;

                    let cx = cropXWidget ? parseFloat(cropXWidget.value) || 0 : 0;
                    let cy = cropYWidget ? parseFloat(cropYWidget.value) || 0 : 0;
                    let cw_val = cropWWidget ? parseFloat(cropWWidget.value) || 1 : 1;
                    let ch_val = cropHWidget ? parseFloat(cropHWidget.value) || 1 : 1;

                    const actualW = vw ? Math.round(cw_val * vw) : 0;
                    const actualH = vh ? Math.round(ch_val * vh) : 0;

                    if (!isCropVisible || !vw) {
                        cropBox.style.display = "none";
                        cropEditContainer.style.display = "none";
                        if (cw_val < 0.999 || ch_val < 0.999 || cx > 0.001 || cy > 0.001) {
                            cropDims.textContent = `Crop: ${actualW}x${actualH}`;
                            cropDims.style.display = "inline-block";
                        } else {
                            cropDims.style.display = "none";
                        }
                        return;
                    }

                    cropDims.style.display = "none";
                    cropEditContainer.style.display = "flex";
                    cropBox.style.display = "block";

                    if (document.activeElement !== wInput) wInput.value = actualW;
                    if (document.activeElement !== hInput) hInput.value = actualH;

                    const cw = videoPreview.clientWidth;
                    const ch = videoPreview.clientHeight;

                    const ratio = Math.min(cw / vw, ch / vh);
                    const renderedW = vw * ratio;
                    const renderedH = vh * ratio;
                    const xOffset = (cw - renderedW) / 2;
                    const yOffset = (ch - renderedH) / 2;

                    cropBox.style.left = `${xOffset + cx * renderedW}px`;
                    cropBox.style.top = `${yOffset + cy * renderedH}px`;
                    cropBox.style.width = `${cw_val * renderedW}px`;
                    cropBox.style.height = `${ch_val * renderedH}px`;
                };

                const onCropPointerDown = (e, handle) => {
                    if (!isCropVisible) return;
                    e.preventDefault();
                    e.stopPropagation();
                    cropDragging = handle;
                    e.target.setPointerCapture(e.pointerId);

                    dragStartX = e.clientX;
                    dragStartY = e.clientY;
                    dragStartCropX = cropXWidget ? parseFloat(cropXWidget.value) || 0 : 0;
                    dragStartCropY = cropYWidget ? parseFloat(cropYWidget.value) || 0 : 0;
                    dragStartCropW = cropWWidget ? parseFloat(cropWWidget.value) || 1 : 1;
                    dragStartCropH = cropHWidget ? parseFloat(cropHWidget.value) || 1 : 1;

                    e.target.addEventListener("pointermove", onCropPointerMove);
                    e.target.addEventListener("pointerup", onCropPointerUp);
                };

                const onCropPointerMove = (e) => {
                    if (!cropDragging) return;
                    e.preventDefault();

                    const vw = videoPreview.videoWidth;
                    const vh = videoPreview.videoHeight;
                    const cw = videoPreview.clientWidth;
                    const ch = videoPreview.clientHeight;

                    const ratio = Math.min(cw / vw, ch / vh);
                    const renderedW = vw * ratio;
                    const renderedH = vh * ratio;

                    const dx = (e.clientX - dragStartX) / renderedW;
                    const dy = (e.clientY - dragStartY) / renderedH;

                    let new_cw = dragStartCropW;
                    let new_ch = dragStartCropH;
                    let new_cx = dragStartCropX;
                    let new_cy = dragStartCropY;

                    if (cropDragging === "tl") {
                        new_cw = dragStartCropW - dx;
                        new_ch = dragStartCropH - dy;
                    } else if (cropDragging === "tr") {
                        new_cw = dragStartCropW + dx;
                        new_ch = dragStartCropH - dy;
                    } else if (cropDragging === "bl") {
                        new_cw = dragStartCropW - dx;
                        new_ch = dragStartCropH + dy;
                    } else if (cropDragging === "br") {
                        new_cw = dragStartCropW + dx;
                        new_ch = dragStartCropH + dy;
                    } else if (cropDragging === "tm") {
                        new_ch = dragStartCropH - dy;
                    } else if (cropDragging === "bm") {
                        new_ch = dragStartCropH + dy;
                    } else if (cropDragging === "lm") {
                        new_cw = dragStartCropW - dx;
                    } else if (cropDragging === "rm") {
                        new_cw = dragStartCropW + dx;
                    }

                    if (currentAspectRatio > 0 && cropDragging !== "center") {
                        const R = currentAspectRatio * (vh / vw);
                        if (["tm", "bm"].includes(cropDragging)) {
                            new_cw = new_ch * R;
                            new_cx = dragStartCropX + (dragStartCropW - new_cw) / 2;
                        } else if (["lm", "rm"].includes(cropDragging)) {
                            new_ch = new_cw / R;
                            new_cy = dragStartCropY + (dragStartCropH - new_ch) / 2;
                        } else {
                            new_ch = new_cw / R;
                        }
                    }

                    if (cropDragging === "tl") {
                        new_cx = dragStartCropX + dragStartCropW - new_cw;
                        new_cy = dragStartCropY + dragStartCropH - new_ch;
                    } else if (cropDragging === "tr") {
                        new_cx = dragStartCropX;
                        new_cy = dragStartCropY + dragStartCropH - new_ch;
                    } else if (cropDragging === "bl") {
                        new_cx = dragStartCropX + dragStartCropW - new_cw;
                        new_cy = dragStartCropY;
                    } else if (cropDragging === "br") {
                        new_cx = dragStartCropX;
                        new_cy = dragStartCropY;
                    } else if (cropDragging === "tm") {
                        new_cy = dragStartCropY + dragStartCropH - new_ch;
                        if (!(currentAspectRatio > 0)) new_cx = dragStartCropX;
                    } else if (cropDragging === "bm") {
                        new_cy = dragStartCropY;
                        if (!(currentAspectRatio > 0)) new_cx = dragStartCropX;
                    } else if (cropDragging === "lm") {
                        new_cx = dragStartCropX + dragStartCropW - new_cw;
                        if (!(currentAspectRatio > 0)) new_cy = dragStartCropY;
                    } else if (cropDragging === "rm") {
                        new_cx = dragStartCropX;
                        if (!(currentAspectRatio > 0)) new_cy = dragStartCropY;
                    } else if (cropDragging === "center") {
                        new_cx = dragStartCropX + dx;
                        new_cy = dragStartCropY + dy;
                    }

                    if (new_cw < 0.02) {
                        new_cw = 0.02;
                        if (currentAspectRatio > 0) new_ch = new_cw / (currentAspectRatio * (vh / vw));
                    }
                    if (new_ch < 0.02) {
                        new_ch = 0.02;
                        if (currentAspectRatio > 0) new_cw = new_ch * (currentAspectRatio * (vh / vw));
                    }

                    if (cropDragging === "center") {
                        new_cx = Math.max(0, Math.min(new_cx, 1 - new_cw));
                        new_cy = Math.max(0, Math.min(new_cy, 1 - new_ch));
                    } else {
                        if (new_cx < 0) {
                            if (["tl", "bl", "lm"].includes(cropDragging)) { new_cw += new_cx; new_cx = 0; }
                        }
                        if (new_cy < 0) {
                            if (["tl", "tr", "tm"].includes(cropDragging)) { new_ch += new_cy; new_cy = 0; }
                        }
                        if (new_cx + new_cw > 1) {
                            if (["tr", "br", "rm"].includes(cropDragging)) new_cw = 1 - new_cx;
                        }
                        if (new_cy + new_ch > 1) {
                            if (["bl", "br", "bm"].includes(cropDragging)) new_ch = 1 - new_cy;
                        }

                        if (currentAspectRatio > 0) {
                            const R = currentAspectRatio * (vh / vw);
                            if (new_cw / new_ch > R + 0.001) {
                                new_cw = new_ch * R;
                                if (["tl", "bl", "lm"].includes(cropDragging)) new_cx = dragStartCropX + dragStartCropW - new_cw;
                            } else if (new_cw / new_ch < R - 0.001) {
                                new_ch = new_cw / R;
                                if (["tl", "tr", "tm"].includes(cropDragging)) new_cy = dragStartCropY + dragStartCropH - new_ch;
                            }
                        }
                    }

                    if (cropXWidget) cropXWidget.value = parseFloat(new_cx.toFixed(3));
                    if (cropYWidget) cropYWidget.value = parseFloat(new_cy.toFixed(3));
                    if (cropWWidget) cropWWidget.value = parseFloat(new_cw.toFixed(3));
                    if (cropHWidget) cropHWidget.value = parseFloat(new_ch.toFixed(3));

                    updateCropUI();
                    app.graph.setDirtyCanvas(true, false);
                };

                const onCropPointerUp = (e) => {
                    cropDragging = null;
                    e.target.releasePointerCapture(e.pointerId);
                    e.target.removeEventListener("pointermove", onCropPointerMove);
                    e.target.removeEventListener("pointerup", onCropPointerUp);
                };

                cropBox.onpointerdown = (e) => {
                    if (e.target === cropBox) onCropPointerDown(e, "center");
                };
                tlHandle.onpointerdown = (e) => onCropPointerDown(e, "tl");
                trHandle.onpointerdown = (e) => onCropPointerDown(e, "tr");
                blHandle.onpointerdown = (e) => onCropPointerDown(e, "bl");
                brHandle.onpointerdown = (e) => onCropPointerDown(e, "br");
                tmHandle.onpointerdown = (e) => onCropPointerDown(e, "tm");
                bmHandle.onpointerdown = (e) => onCropPointerDown(e, "bm");
                lmHandle.onpointerdown = (e) => onCropPointerDown(e, "lm");
                rmHandle.onpointerdown = (e) => onCropPointerDown(e, "rm");

                // Add a resize observer to the video wrapper so crop handles stay pinned
                const resizeObserver = new ResizeObserver(() => {
                    if (isCropVisible) updateCropUI();
                });
                resizeObserver.observe(videoWrapper);

                // Ensure we clean up observer
                const oldOnRemoved = node.onRemoved;
                node.onRemoved = function () {
                    resizeObserver.disconnect();
                    if (oldOnRemoved) oldOnRemoved.apply(this, arguments);
                }

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
                    durationWidget.callback = function (v) {
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
                    durationFramesWidget.callback = function (v) {
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
                    updateCropUI();
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
                        if (startTimeWidget) startTimeWidget.value = parseFloat(Math.min(val, e_val).toFixed(2));
                        if (duration > 0) videoPreview.currentTime = startTimeWidget.value;
                    } else {
                        dragging = 'end';
                        if (endTimeWidget) endTimeWidget.value = parseFloat(Math.max(val, s).toFixed(2));
                        if (duration > 0) videoPreview.currentTime = endTimeWidget.value;
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
                        if (startTimeWidget) startTimeWidget.value = parseFloat(Math.min(val, e_val).toFixed(2));
                        if (duration > 0) videoPreview.currentTime = startTimeWidget.value;
                    } else if (dragging === 'end') {
                        const s = startTimeWidget ? parseFloat(startTimeWidget.value) || 0 : 0;
                        if (endTimeWidget) endTimeWidget.value = parseFloat(Math.max(val, s).toFixed(2));
                        if (duration > 0) videoPreview.currentTime = endTimeWidget.value;
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

                        if (startTimeWidget) startTimeWidget.value = parseFloat(newStart.toFixed(2));
                        if (endTimeWidget) endTimeWidget.value = parseFloat(newEnd.toFixed(2));
                        if (duration > 0) videoPreview.currentTime = startTimeWidget.value;
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