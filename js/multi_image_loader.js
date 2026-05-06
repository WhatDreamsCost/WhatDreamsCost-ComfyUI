import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "Comfy.MultiImageLoader",
    async nodeCreated(node) {
        if (node.comfyClass !== "MultiImageLoader") return;

        // Helper to detect if we are in the new Nodes 2.0 / V3 Web Component frontend
        let v3NodeElement = null;
        function checkIsV3() {
            if (v3NodeElement) return true;
            let el = container.parentElement;
            while (el) {
                if ((el.tagName && el.tagName.toLowerCase().includes('comfy-node')) || 
                    (el.classList && el.classList.contains('comfy-node'))) {
                    v3NodeElement = el;
                    return true;
                }
                el = el.parentElement || (el.getRootNode ? el.getRootNode().host : null);
            }
            return false;
        }

        // --- 1. UI Setup: Main Container ---
        const container = document.createElement("div");
        container.style.cssText = `
            width: 100%;
            min-height: 250px; 
            min-width: 100px; /* Reduced from 400px to allow thin resizing in V3 */
            background: #222222;
            border: 1px solid #353545;
            border-radius: 4px;
            margin-top: 5px;
            padding: 10px;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            gap: 10px;
            pointer-events: auto;
            overflow: hidden;
        `;

        // Top Bar for Actions
        const topBar = document.createElement("div");
        // Added flex-wrap: wrap so buttons stack if the node gets extremely thin
        topBar.style.cssText = "display: flex; flex-wrap: wrap; justify-content: flex-start; align-items: center; width: 100%; gap: 8px;";
        
        const uploadBtn = document.createElement("button");
        uploadBtn.innerText = "Upload Images";
        uploadBtn.style.cssText = `
            background: #3a3f4b; color: white; border: 1px solid #5a5f6b; 
            padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 10px;
        `;

        const removeAllBtn = document.createElement("button");
        removeAllBtn.innerText = "Remove All";
        removeAllBtn.style.cssText = `
            background: #cc2222; color: white; border: 1px solid #aa1111; 
            padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 10px;
            transition: background 0.2s;
        `;
        removeAllBtn.onmouseenter = () => { removeAllBtn.style.background = "#ff3333"; };
        removeAllBtn.onmouseleave = () => { removeAllBtn.style.background = "#cc2222"; };
        removeAllBtn.onclick = () => {
            setWidgetValue([], false);
        };

        topBar.appendChild(uploadBtn);
        topBar.appendChild(removeAllBtn);
        container.appendChild(topBar);

        const gridWrapper = document.createElement("div");
        gridWrapper.style.cssText = `
            position: relative;
            flex-grow: 1;
            width: 100%;
            min-height: 0;
        `;

        const grid = document.createElement("div");
        grid.style.cssText = `
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            display: grid;
            gap: 8px;
            justify-content: center;
            align-content: center;
        `;
        
        gridWrapper.appendChild(grid);
        container.appendChild(gridWrapper);

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.multiple = true;
        fileInput.accept = "image/*";
        fileInput.style.display = "none";
        container.appendChild(fileInput);

        // Add the Widget to the Node
        const galleryWidget = node.addDOMWidget("Gallery", "html_gallery", container, { serialize: false });
        
        galleryWidget.computeSize = function() {
            const galleryY = this.last_y || 40;
            const minOutputsHeight = (node.outputs ? node.outputs.length : 1) * 20;
            const requiredGalleryHeight = Math.max(250, minOutputsHeight + 40 - galleryY);
            return [150, requiredGalleryHeight]; // Changed minimum theoretical widget width
        };

        // --- SAFELY HIDE THE IMAGE_PATHS WIDGET ---
        const pathsWidget = node.widgets.find(w => w.name === "image_paths");
        if (pathsWidget) {
            // Forcefully lock the hidden state against V3's reactive redraws
            Object.defineProperty(pathsWidget, 'hidden', {
                get: () => true,
                set: () => {} // Ignore attempts by V3 to unhide it
            });
            Object.defineProperty(pathsWidget, 'type', {
                get: () => "hidden",
                set: () => {} // Ignore attempts by V3 to reset the type
            });
            
            pathsWidget.computeSize = function() {
                return [0, 0];
            };

            // Catch for V3 delayed DOM rendering to ensure no stubborn inputs appear
            const hideInterval = setInterval(() => {
                if (pathsWidget.element) {
                    pathsWidget.element.style.display = "none";
                }
            }, 50);
            setTimeout(() => clearInterval(hideInterval), 1000);
        }

        const oldCallback = pathsWidget?.callback;

        function setWidgetValue(newPathsArray, isRearranging = false) {
            if (!pathsWidget) return;
            const val = newPathsArray.join("\n");
            
            const tempCallback = pathsWidget.callback;
            pathsWidget.callback = null;
            
            pathsWidget.value = val;
            if (oldCallback) oldCallback.apply(pathsWidget, [val]);
            
            pathsWidget.callback = tempCallback;
            refreshGallery(isRearranging);
        }

        // --- 2. Logic: Output Syncing & Dynamic Packing ---
        function syncOutputs(count) {
            if (!node.outputs) return;

            let changed = false;
            const targetTotal = count + 1;
            
            const wasFresh = node.outputs.length >= 50;

            while (node.outputs.length > targetTotal && node.outputs.length > 1) {
                node.removeOutput(node.outputs.length - 1);
                changed = true;
            }

            for (let i = node.outputs.length; i < targetTotal; i++) {
                node.addOutput(`image_${i}`, "IMAGE");
                changed = true;
            }

            if (changed || wasFresh) {
                updateLayout(wasFresh);
            }
        }

        function notifyConnectedNodes(imageCount) {
            if (!node.outputs) return;
            for (const output of node.outputs) {
                if (!output.links) continue;
                for (const linkId of output.links) {
                    const link = app.graph.links[linkId];
                    if (!link) continue;
                    const targetNode = app.graph.getNodeById(link.target_id);
                    if (targetNode && typeof targetNode._syncImageCount === "function") {
                        targetNode._syncImageCount(imageCount);
                    }
                }
            }
        }

        function optimizeGrid(gridW, gridH) {
            const paths = (pathsWidget?.value || "").split(/\n|,/).map(s => s.trim()).filter(s => s);
            const N = paths.length;
            
            if (N === 0) {
                grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(75px, 1fr))';
                grid.style.gridAutoRows = 'max-content';
                return;
            }
            
            if (gridW <= 0 || gridH <= 0) return;

            let bestS = 0;
            let bestCols = 1;

            for (let c = 1; c <= N; c++) {
                const r = Math.ceil(N / c);
                // Math.max guarantees we don't end up with negative max width in ultra-thin layouts
                const maxW = Math.max(5, (gridW - (c - 1) * 8) / c);
                const maxH = Math.max(5, (gridH - (r - 1) * 8) / r);
                const size = Math.min(maxW, maxH);
                
                // By using >= instead of strict > (with a tiny 0.1 buffer for float precision),
                // if multiple column counts yield the exact same optimal cell size
                // (which happens when height is the bottleneck), we aggressively pack
                // more items horizontally onto the row to fill empty space.
                if (size >= bestS - 0.1) {
                    bestS = size;
                    bestCols = c;
                }
            }
            
            // Allow grid cells to shrink down to 10px instead of 15 to prevent horizontal overflow in V3
            bestS = Math.max(10, Math.floor(bestS)); 
            
            grid.style.gridTemplateColumns = `repeat(${bestCols}, ${bestS}px)`;
            grid.style.gridAutoRows = `${bestS}px`;
        }

        let v3EventsAttached = false;

        function enforceV3CSS() {
            const isV3 = checkIsV3();
            if (isV3 && v3NodeElement) {
                const paddingBottom = 15;
                const galleryY = galleryWidget.last_y || 40;
                const minOutputsHeight = (node.outputs ? node.outputs.length : 1) * 20;
                const absoluteMinHeight = Math.max(galleryY + 250 + paddingBottom, minOutputsHeight + 40);

                // For Nodes 2.0 (V3), we remove the min-width constraint completely.
                // We leave min-height so outputs don't bleed out vertically.
                v3NodeElement.style.removeProperty('min-width');
                v3NodeElement.style.setProperty('min-height', absoluteMinHeight + 'px', 'important');

                // Attach drag & drop to the entire V3 Web Component
                if (!v3EventsAttached) {
                    v3EventsAttached = true;
                    v3NodeElement.addEventListener("dragover", (e) => {
                        e.preventDefault(); 
                    });
                    v3NodeElement.addEventListener("drop", (e) => {
                        if (e.dataTransfer && e.dataTransfer.files) {
                            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
                            if (files.length > 0) {
                                e.preventDefault();
                                e.stopPropagation();
                                handleFiles(files);
                            }
                        }
                    });
                }
            }
        }

        let isLayouting = false;
        
        function updateLayout(forceShrink = false) {
            if (isLayouting) return;
            isLayouting = true;

            const isV3 = checkIsV3();
            const minW = isV3 ? 100 : 200; // 100 in V3, 440 in V1
            const paddingBottom = isV3 ? 15 : 25; // Apply extra 20px pad on V1

            const galleryY = galleryWidget.last_y || 40; 
            const minOutputsHeight = (node.outputs ? node.outputs.length : 1) * 20;
            const absoluteMinHeight = Math.max(galleryY + 250 + paddingBottom, minOutputsHeight + 40);

            node.min_size = [minW, absoluteMinHeight];
            enforceV3CSS();

            let targetW = Math.max(node.size[0], minW);
            let targetH = forceShrink ? absoluteMinHeight : node.size[1];

            targetH = Math.max(targetH, absoluteMinHeight);

            if (node.size[0] !== targetW || node.size[1] !== targetH) {
                node.setSize([targetW, targetH]);
                app.graph.setDirtyCanvas(true, true);
            }

            const availableGalleryHeight = targetH - galleryY - paddingBottom;
            container.style.height = availableGalleryHeight + "px";

            isLayouting = false;
        }

        // --- OVERRIDE LOGIC FOR RESIZING --- 
        const origOnResize = node.onResize;
        node.onResize = function(size) {
            const isV3 = checkIsV3();
            const minW = isV3 ? 100 : 220; // Adjust limits based on frontend
            const paddingBottom = isV3 ? 15 : 25; // Apply extra 20px pad on V1

            const galleryY = galleryWidget.last_y || 40;
            const minOutputsHeight = (this.outputs ? this.outputs.length : 1) * 20;
            const absoluteMinHeight = Math.max(galleryY + 250 + paddingBottom, minOutputsHeight + 40);
            
            size[0] = Math.max(size[0], minW);
            size[1] = Math.max(size[1], absoluteMinHeight);

            if (origOnResize) origOnResize.call(this, size);
            if (isLayouting) return; 
            
            node.min_size = [minW, absoluteMinHeight];
            enforceV3CSS(); 
            
            const availableGalleryHeight = size[1] - galleryY - paddingBottom;
            container.style.height = availableGalleryHeight + "px";
        };

        const origComputeSize = node.computeSize;
        node.computeSize = function(out) {
            const isV3 = checkIsV3();
            const minW = isV3 ? 100 : 220; 
            const paddingBottom = isV3 ? 15 : 25; 

            let res = origComputeSize ? origComputeSize.apply(this, arguments) : [minW, 250];
            const galleryY = galleryWidget.last_y || 40;
            const minOutputsHeight = (this.outputs ? this.outputs.length : 1) * 20;
            const absoluteMinHeight = Math.max(galleryY + 250 + paddingBottom, minOutputsHeight + 40);

            this.min_size = [minW, absoluteMinHeight];
            res[0] = Math.max(res[0], minW);
            res[1] = Math.max(res[1], absoluteMinHeight);
            
            enforceV3CSS(); 
            return res;
        };

        const origSetSize = node.setSize;
        node.setSize = function(size) {
            const isV3 = checkIsV3();
            const minW = isV3 ? 100 : 220;
            const paddingBottom = isV3 ? 15 : 25; 

            const galleryY = galleryWidget.last_y || 40;
            const minOutputsHeight = (this.outputs ? this.outputs.length : 1) * 20;
            const absoluteMinHeight = Math.max(galleryY + 250 + paddingBottom, minOutputsHeight + 40);

            size[0] = Math.max(size[0], minW);
            size[1] = Math.max(size[1], absoluteMinHeight);

            if (origSetSize) {
                origSetSize.call(this, size);
            } else {
                this.size = size;
            }
            enforceV3CSS();
        };

        let lastObservedWidth = 0;
        let lastObservedHeight = 0;
        
        const resizeObserver = new ResizeObserver((entries) => {
            enforceV3CSS(); 
            for (const entry of entries) {
                const w = Math.round(entry.contentRect.width);
                const h = Math.round(entry.contentRect.height);
                
                if (Math.abs(w - lastObservedWidth) > 1 || Math.abs(h - lastObservedHeight) > 1) {
                    lastObservedWidth = w;
                    lastObservedHeight = h;
                    if (h > 0) {
                        optimizeGrid(w, h);
                    }
                }
            }
        });
        resizeObserver.observe(gridWrapper);

        // --- 3. Logic: Gallery Rendering ---
        let draggedNode = null;
        let lastSwapX = 0;
        let lastSwapY = 0;
        let lastSwapTime = 0;

        function refreshGallery(isRearranging = false) {
            grid.innerHTML = "";
            const paths = (pathsWidget?.value || "").split(/\n|,/).map(s => s.trim()).filter(s => s);
            
            if (!isRearranging) {
                syncOutputs(paths.length);
            }
            node._imageCount = paths.length;
            notifyConnectedNodes(paths.length);

            paths.forEach((path, index) => {
                const item = document.createElement("div");
                item.dataset.path = path; 
                item.draggable = true;
                item.style.cssText = `
                    position: relative; 
                    width: 100%;
                    height: 100%;
                    aspect-ratio: 1 / 1; 
                    background: #000000; 
                    border-radius: 4px; 
                    border: 1px solid #444; 
                    overflow: hidden; 
                    cursor: grab;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                `;

                const img = document.createElement("img");
                img.src = `/api/view?filename=${encodeURIComponent(path)}&type=input`;
                // Allow pointer-events so context menu interacts directly with the image
                img.style.cssText = "max-width: 100%; max-height: 100%; object-fit: contain; pointer-events: auto; display: block;";
                img.draggable = false; // Prevent native browser ghost dragging on the image itself
                
                const del = document.createElement("div");
                del.style.cssText = `
                    position: absolute; top: 0; right: 0; 
                    background: #cc2222; color: white; 
                    width: 18px; height: 18px; 
                    display: flex; align-items: center; justify-content: center; 
                    font-size: 14px; cursor: pointer; z-index: 10;
                    font-family: Arial, sans-serif; font-weight: bold;
                    line-height: 1; border-bottom-left-radius: 4px;
                    transition: background 0.2s;
                `;
                del.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 1L9 9M9 1L1 9" stroke="white" stroke-width="2" stroke-linecap="round"/>
                </svg>`;
                
                del.onmouseenter = () => { del.style.background = "#ff3333"; };
                del.onmouseleave = () => { del.style.background = "#cc2222"; };
                
                del.onclick = (e) => {
                    e.stopPropagation();
                    const newPaths = paths.filter((_, i) => i !== index);
                    setWidgetValue(newPaths, false);
                };

                const numBadge = document.createElement("div");
                numBadge.style.cssText = `
                    position: absolute; bottom: 0; left: 0; 
                    background: rgba(0, 0, 0, 0.75); color: #fff; 
                    padding: 2px 6px; font-size: 11px; font-family: sans-serif;
                    font-weight: bold; border-top-right-radius: 4px; pointer-events: none;
                    z-index: 5;
                `;
                numBadge.innerText = (index + 1).toString();

                // Prevent LiteGraph context menu and instead show standard browser context menu (Copy, Save, Open)
                item.addEventListener("contextmenu", (e) => {
                    e.stopPropagation();
                });

                item.ondragstart = (e) => { 
                    draggedNode = item; 
                    
                    e.dataTransfer.setData('text/plain', path);
                    e.dataTransfer.effectAllowed = "move";
                    
                    setTimeout(() => { 
                        if (draggedNode === item) {
                            // Style as an empty dashed placeholder
                            item.style.background = "transparent";
                            item.style.border = "2px dashed #666";
                            // Hide the visual children (image, delete button, badge)
                            Array.from(item.children).forEach(c => c.style.opacity = "0");
                        }
                    }, 0);
                };
                
                item.ondragend = () => { 
                    if (draggedNode) {
                        // Restore original appearance
                        draggedNode.style.background = "#000000";
                        draggedNode.style.border = "1px solid #444";
                        Array.from(draggedNode.children).forEach(c => c.style.opacity = "1");
                    }
                    draggedNode = null; 
                    
                    const newPaths = Array.from(grid.children).map(n => n.dataset.path);
                    const currentVal = (pathsWidget?.value || "").trim();
                    if (newPaths.join("\n") !== currentVal) {
                        setWidgetValue(newPaths, true);
                    }
                };

                item.ondragover = (e) => { 
                    e.preventDefault(); 
                    e.stopPropagation(); 
                    if (!draggedNode || draggedNode === item) return;

                    const distMoved = Math.hypot(e.clientX - lastSwapX, e.clientY - lastSwapY);
                    if (Date.now() - lastSwapTime < 50 && distMoved < 5) {
                        return;
                    }

                    const itemRect = item.getBoundingClientRect();
                    const bufferX = itemRect.width * 0.25; 
                    const bufferY = itemRect.height * 0.25;
                    
                    if (e.clientX < itemRect.left + bufferX || e.clientX > itemRect.right - bufferX ||
                        e.clientY < itemRect.top + bufferY || e.clientY > itemRect.bottom - bufferY) {
                        return;
                    }

                    const items = Array.from(grid.children);
                    const draggedIdx = items.indexOf(draggedNode);
                    const targetIdx = items.indexOf(item);

                    // Instantly snap the placeholder to its new position, moving items aside
                    if (draggedIdx < targetIdx) {
                        grid.insertBefore(draggedNode, item.nextSibling);
                    } else {
                        grid.insertBefore(draggedNode, item);
                    }

                    lastSwapX = e.clientX;
                    lastSwapY = e.clientY;
                    lastSwapTime = Date.now();
                };
                
                item.ondrop = (e) => {
                    e.preventDefault();
                    e.stopPropagation(); 
                };

                item.appendChild(img);
                item.appendChild(del);
                item.appendChild(numBadge);
                grid.appendChild(item);
            });

            if (!isRearranging) {
                requestAnimationFrame(() => {
                    updateLayout();
                    if (gridWrapper.offsetWidth > 0) optimizeGrid(gridWrapper.offsetWidth, gridWrapper.offsetHeight);
                });
            }
        }

        // --- 4. Logic: File Handling ---
        async function handleFiles(files) {
            const uploaded = [];
            for (const file of files) {
                const body = new FormData();
                body.append("image", file);
                try {
                    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
                    if (resp.status === 200) {
                        const data = await resp.json();
                        let name = data.name;
                        if (data.subfolder) name = data.subfolder + "/" + name;
                        uploaded.push(name);
                    }
                } catch (e) { console.error("Upload error", e); }
            }
            if (uploaded.length > 0) {
                const current = (pathsWidget?.value || "").trim();
                const allPaths = current ? current.split('\n').concat(uploaded) : uploaded;
                setWidgetValue(allPaths, false);
            }
        }

        // Apply drag & drop to LiteGraph node container bounds (V1)
        const origOnDragDrop = node.onDragDrop;
        node.onDragDrop = function(e) {
            let handled = false;
            if (e.dataTransfer && e.dataTransfer.files) {
                const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
                if (files.length > 0) {
                    e.preventDefault();
                    handleFiles(files);
                    handled = true;
                }
            }
            if (!handled && origOnDragDrop) {
                return origOnDragDrop.apply(this, arguments);
            }
            return handled;
        };

        const origOnDragOver = node.onDragOver;
        node.onDragOver = function(e) {
            if (e.dataTransfer && e.dataTransfer.items) {
                const hasImage = Array.from(e.dataTransfer.items).some(f => f.kind === 'file' && f.type.startsWith('image/'));
                if (hasImage) {
                    e.preventDefault();
                    return true;
                }
            }
            if (origOnDragOver) {
                return origOnDragOver.apply(this, arguments);
            }
            return false;
        };

        uploadBtn.onclick = () => fileInput.click();
        fileInput.onchange = (e) => handleFiles(e.target.files);
        
        container.ondragover = (e) => { 
            e.preventDefault(); 
            e.stopPropagation(); 
            container.style.borderColor = "#4CAF50"; 
        };
        container.ondragleave = (e) => { 
            e.preventDefault();
            e.stopPropagation(); 
            container.style.borderColor = "#353545"; 
        };
        container.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation(); 
            container.style.borderColor = "#353545";
            if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
        };

        // --- 5. Logic: Paste Handling ---
        const pasteHandler = (e) => {
            if (app.canvas.selected_nodes && app.canvas.selected_nodes[node.id]) {
                const items = e.clipboardData?.items;
                if (!items) return;

                const files = [];
                for (let i = 0; i < items.length; i++) {
                    if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
                        files.push(items[i].getAsFile());
                    }
                }

                if (files.length > 0) {
                    e.preventDefault();
                    e.stopImmediatePropagation(); 
                    handleFiles(files);
                }
            }
        };

        document.addEventListener("paste", pasteHandler, { capture: true });

        const origOnRemoved = node.onRemoved;
        node.onRemoved = function() {
            document.removeEventListener("paste", pasteHandler, { capture: true });
            resizeObserver.disconnect();
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };

        if (pathsWidget) {
            pathsWidget.callback = (v) => {
                if (oldCallback) oldCallback.apply(pathsWidget, [v]);
                refreshGallery();
            };
        }

        // Run immediately to trim blank outputs before LiteGraph does its first layout calculations
        refreshGallery();

        // Enforce the tightest possible packing explicitly upon being dropped into the graph (V1 specifically)
        const origOnAdded = node.onAdded;
        node.onAdded = function() {
            if (origOnAdded) origOnAdded.apply(this, arguments);
            const isV3 = checkIsV3();
            if (!isV3) {
                requestAnimationFrame(() => {
                    const galleryY = galleryWidget.last_y || 40;
                    const minOutputsHeight = (this.outputs ? this.outputs.length : 1) * 20;
                    const paddingBottom = 25; // Apply extra 20px pad on V1
                    const absoluteMinHeight = Math.max(galleryY + 250 + paddingBottom, minOutputsHeight + 40);
                    // Force the node to snap to its absolute minimum size on initial drop
                    if (this.size && this.size[1] > absoluteMinHeight + 5) {
                        this.setSize([this.size[0], absoluteMinHeight]);
                        if (app.graph) app.graph.setDirtyCanvas(true, true);
                    }
                });
            }
        };

        setTimeout(() => refreshGallery(), 100);
    }
});