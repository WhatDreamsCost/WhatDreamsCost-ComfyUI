import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "Comfy.MultiImageLoader",
    async nodeCreated(node) {
        if (node.comfyClass !== "MultiImageLoader") return;

        // --- 1. UI Setup: Main Container ---
        const container = document.createElement("div");
        container.style.cssText = `
            width: 100%;
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
        topBar.style.cssText = "display: flex; justify-content: flex-start; align-items: center; width: 100%; gap: 8px;";
        
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

        // The Grid Area - Setup to center the dynamically packed square blocks
        const grid = document.createElement("div");
        grid.style.cssText = `
            position: relative; /* Crucial for anti-flicker offset calculations */
            flex-grow: 1;
            display: grid;
            gap: 8px;
            width: 100%;
            justify-content: center;
            align-content: center;
        `;
        container.appendChild(grid);

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.multiple = true;
        fileInput.accept = "image/*";
        fileInput.style.display = "none";
        container.appendChild(fileInput);

        // Add the Widget to the Node
        const galleryWidget = node.addDOMWidget("Gallery", "html_gallery", container, { serialize: false });
        
        // Permanently neutralize the DOM widget's built-in computeSize to prevent infinite LiteGraph loops
        galleryWidget.computeSize = () => [0, 0];

        // --- BUG FIX ---
        // Find the paths widget and properly hide it from LiteGraph
        const pathsWidget = node.widgets.find(w => w.name === "image_paths");
        if (pathsWidget) {
            // Tell LiteGraph to ignore this widget for hit-testing and drawing
            pathsWidget.hidden = true; 
            
            // Return -4 to absorb LiteGraph's default 4px vertical margin between widgets,
            // entirely eliminating its invisible "ghost" hitbox.
            pathsWidget.computeSize = () => [0, -4]; 
            
            // Aggressively neutralize the actual DOM element AND its ComfyUI wrapper using a global stylesheet
            // ComfyUI's background render loop continually overwrites inline styles (like display: none).
            // By assigning unique IDs and injecting a global !important CSS rule, we guarantee it remains dead.
            if (pathsWidget.element) {
                const uid = node.id || Math.random().toString(36).substring(2, 9);
                pathsWidget.element.id = `hidden-paths-textarea-${uid}`;
                if (pathsWidget.element.parentElement) {
                    pathsWidget.element.parentElement.id = `hidden-paths-wrapper-${uid}`;
                }

                // Inject the shield-killer style into the document head if it doesn't exist yet
                if (!document.getElementById("multi-image-loader-shield-killer")) {
                    const style = document.createElement("style");
                    style.id = "multi-image-loader-shield-killer";
                    style.innerHTML = `
                        [id^="hidden-paths-textarea-"],
                        [id^="hidden-paths-wrapper-"] {
                            display: none !important;
                            pointer-events: none !important;
                            position: absolute !important;
                            width: 0px !important;
                            height: 0px !important;
                            opacity: 0 !important;
                            z-index: -9999 !important;
                            overflow: hidden !important;
                        }
                    `;
                    document.head.appendChild(style);
                }
            }
        }

        const oldCallback = pathsWidget?.callback;

        // Centralized helper to prevent infinite loops when updating values internally
        function setWidgetValue(newPathsArray, isRearranging = false) {
            if (!pathsWidget) return;
            const val = newPathsArray.join("\n");
            
            // Temporarily silence the main callback
            const tempCallback = pathsWidget.callback;
            pathsWidget.callback = null;
            
            pathsWidget.value = val;
            if (oldCallback) oldCallback.apply(pathsWidget, [val]);
            
            pathsWidget.callback = tempCallback;
            refreshGallery(isRearranging);
        }

        // --- 2. Logic: Output Syncing & Dynamic Packing ---
        // Manages image_N outputs (slots 1+) while always preserving multi_output at slot 0
        function syncOutputs(count) {
            if (!node.outputs) return;

            let changed = false;
            // Target = multi_output (slot 0) + count image outputs
            const targetTotal = count + 1;

            // Remove excess outputs from the end, but NEVER remove slot 0 (multi_output)
            while (node.outputs.length > targetTotal && node.outputs.length > 1) {
                node.removeOutput(node.outputs.length - 1);
                changed = true;
            }

            // Add missing image_N outputs after multi_output
            for (let i = node.outputs.length; i < targetTotal; i++) {
                node.addOutput(`image_${i}`, "IMAGE");
                changed = true;
            }

            if (changed) {
                updateLayout();
            }
        }

        // Push-based notification: broadcast image count to all connected nodes
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

        // 2D Square Packing Algorithm: Calculates the optimal grid sizes to fill empty space
        function optimizeGrid(nodeW, containerH) {
            const paths = (pathsWidget?.value || "").split(/\n|,/).map(s => s.trim()).filter(s => s);
            const N = paths.length;
            
            if (N === 0) {
                grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(75px, 1fr))';
                grid.style.gridAutoRows = 'max-content';
                return;
            }

            // Approximate the available internal working space
            const gridW = nodeW - 22; // Container padding + border
            const gridH = containerH - 60; // Top bar height + container padding + gap
            
            if (gridW <= 0 || gridH <= 0) return;

            let bestS = 0;
            let bestCols = 1;

            // Test every possible column combination to find the one that yields the largest squares
            for (let c = 1; c <= N; c++) {
                const r = Math.ceil(N / c);
                const maxW = (gridW - (c - 1) * 8) / c;
                const maxH = (gridH - (r - 1) * 8) / r;
                const size = Math.min(maxW, maxH);
                
                if (size > bestS) {
                    bestS = size;
                    bestCols = c;
                }
            }
            
            bestS = Math.max(75, Math.floor(bestS)); // Keep a minimum size floor
            
            // Force the grid to perfectly adopt the optimal maximum square scale
            grid.style.gridTemplateColumns = `repeat(${bestCols}, ${bestS}px)`;
            grid.style.gridAutoRows = `${bestS}px`;
        }

        // Centralized measurement function shared by automatic updates and manual resizes
        function getGalleryHeights() {
            const baseHeight = node.computeSize()[1];
            
            // Temporarily force natural height measurement using minimum settings
            const oldHeight = container.style.height;
            const oldCols = grid.style.gridTemplateColumns;
            const oldRows = grid.style.gridAutoRows;
            
            container.style.height = 'fit-content';
            grid.style.gridTemplateColumns = `repeat(auto-fit, minmax(75px, 1fr))`;
            grid.style.gridAutoRows = `max-content`;
            
            const naturalGalleryHeight = container.offsetHeight || 100;
            const minNodeHeight = baseHeight + naturalGalleryHeight + 15;
            
            // Restore styles instantly
            container.style.height = oldHeight;
            grid.style.gridTemplateColumns = oldCols;
            grid.style.gridAutoRows = oldRows;
            
            return { baseHeight, minNodeHeight };
        }

        let isLayouting = false;
        let isFirstLayout = true;
        function updateLayout(forceHeight = null) {
            if (isLayouting) return;
            isLayouting = true;

            const { baseHeight, minNodeHeight } = getGalleryHeights();

            let targetW = Math.max(node.size[0], 240);
            let targetH = forceHeight !== null ? forceHeight : node.size[1];
            
            if (isFirstLayout) {
                targetH = 0; // Force shrink to minimum bounds on initial load
                isFirstLayout = false;
            }

            // Enforce minimum height
            targetH = Math.max(targetH, minNodeHeight);

            if (node.size[0] !== targetW || node.size[1] !== targetH) {
                node.setSize([targetW, targetH]);
                app.graph.setDirtyCanvas(true, true);
            }

            const availableGalleryHeight = targetH - baseHeight - 15;
            container.style.height = availableGalleryHeight + "px";

            // Recalculate and stretch image squares using the new node space
            optimizeGrid(targetW, availableGalleryHeight);

            isLayouting = false;
        }

        // Intercept user dragging the node corner to strictly enforce size constraints
        const origOnResize = node.onResize;
        node.onResize = function(size) {
            if (origOnResize) origOnResize.call(this, size);
            if (isLayouting) return; // Prevent duplicate cycles
            
            const { baseHeight, minNodeHeight } = getGalleryHeights();
            
            // Prevent user from making node smaller than the minimum content
            size[0] = Math.max(size[0], 240);
            size[1] = Math.max(size[1], minNodeHeight);
            
            // Immediately apply the fluid heights for smooth dragging
            const availableGalleryHeight = size[1] - baseHeight - 15;
            container.style.height = availableGalleryHeight + "px";
            
            // Expand the image slots instantly as you drag
            optimizeGrid(size[0], availableGalleryHeight);
        };

        // Auto-adjust layout if dimensions change programmatically (e.g., undo/redo wrap reflows)
        let lastWidth = -1;
        let lastHeight = -1;
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const currentWidth = entry.contentRect.width;
                const currentHeight = entry.contentRect.height;
                if ((lastWidth !== -1 && Math.abs(currentWidth - lastWidth) > 2) || 
                    (lastHeight !== -1 && Math.abs(currentHeight - lastHeight) > 2)) {
                    requestAnimationFrame(() => updateLayout());
                }
                lastWidth = currentWidth;
                lastHeight = currentHeight;
            }
        });
        resizeObserver.observe(container);

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
            // Cache image count on the node for easy access by connected nodes
            node._imageCount = paths.length;
            // Push notification: immediately tell connected nodes about the new count
            notifyConnectedNodes(paths.length);

            paths.forEach((path, index) => {
                const item = document.createElement("div");
                item.dataset.path = path; // Store path on the node for easy retrieval
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
                    will-change: transform;
                `;

                const img = document.createElement("img");
                img.src = `/api/view?filename=${encodeURIComponent(path)}&type=input`;
                img.style.cssText = "max-width: 100%; max-height: 100%; object-fit: contain; pointer-events: none; display: block;";
                
                // Delete Button
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

                // Number Badge
                const numBadge = document.createElement("div");
                numBadge.style.cssText = `
                    position: absolute; bottom: 0; left: 0; 
                    background: rgba(0, 0, 0, 0.75); color: #fff; 
                    padding: 2px 6px; font-size: 11px; font-family: sans-serif;
                    font-weight: bold; border-top-right-radius: 4px; pointer-events: none;
                    z-index: 5;
                `;
                numBadge.innerText = (index + 1).toString();

                // Dynamic Animated Drag & Drop Events
                item.ondragstart = (e) => { 
                    draggedNode = item; 
                    // Delay opacity drop so the browser capture image remains opaque
                    setTimeout(() => { 
                        if (draggedNode === item) {
                            item.style.opacity = "0.4"; 
                            item.style.pointerEvents = "none"; // Prevent drag ghost from capturing events
                        }
                    }, 0);
                    e.dataTransfer.effectAllowed = "move";
                };
                
                item.ondragend = () => { 
                    if (draggedNode) {
                        draggedNode.style.opacity = "1";
                        draggedNode.style.pointerEvents = "auto";
                    }
                    draggedNode = null; 
                    
                    // The DOM visually reorders during dragover. Here we finalize it to data.
                    const newPaths = Array.from(grid.children).map(n => n.dataset.path);
                    const currentVal = (pathsWidget?.value || "").trim();
                    if (newPaths.join("\n") !== currentVal) {
                        setWidgetValue(newPaths, true);
                    }
                };

                item.ondragover = (e) => { 
                    e.preventDefault(); 
                    e.stopPropagation(); // Stop ComfyUI canvas listener from grabbing this internally
                    if (!draggedNode || draggedNode === item) return;

                    // ANTI-FLICKER 1: Prevent rapid swaps if the mouse hasn't moved physically.
                    // Reduced delay from 300ms to 50ms and distance to 5px to drastically improve responsiveness 
                    // while still absorbing the immediate CSS transform shock.
                    const distMoved = Math.hypot(e.clientX - lastSwapX, e.clientY - lastSwapY);
                    if (Date.now() - lastSwapTime < 50 && distMoved < 5) {
                        return;
                    }

                    // ANTI-FLICKER 2: True logical target boundaries.
                    // Reduced the buffer from 25% down to 10%, meaning 80% of the target square 
                    // is now an active drop zone, making it much easier to trigger a swap.
                    const gridRect = grid.getBoundingClientRect();
                    const mouseX = e.clientX - gridRect.left;
                    const mouseY = e.clientY - gridRect.top;
                    
                    const left = item.offsetLeft;
                    const top = item.offsetTop;
                    const width = item.offsetWidth;
                    const height = item.offsetHeight;
                    
                    const bufferX = width * 0.10; 
                    const bufferY = height * 0.10;
                    
                    if (mouseX < left + bufferX || mouseX > left + width - bufferX ||
                        mouseY < top + bufferY || mouseY > top + height - bufferY) {
                        return;
                    }

                    const items = Array.from(grid.children);
                    const draggedIdx = items.indexOf(draggedNode);
                    const targetIdx = items.indexOf(item);

                    // FLIP Animation Step 1: Record old positions
                    const rects = new Map();
                    items.forEach(node => rects.set(node, node.getBoundingClientRect()));

                    // Physically move the DOM element to the new slot
                    if (draggedIdx < targetIdx) {
                        grid.insertBefore(draggedNode, item.nextSibling);
                    } else {
                        grid.insertBefore(draggedNode, item);
                    }

                    // FLIP Animation Step 2: Calculate difference and animate
                    items.forEach(node => {
                        const oldRect = rects.get(node);
                        const newRect = node.getBoundingClientRect();
                        const dx = oldRect.left - newRect.left;
                        const dy = oldRect.top - newRect.top;

                        if (dx !== 0 || dy !== 0) {
                            // Instantly shift it visually back to the old spot
                            node.style.transition = 'none';
                            node.style.transform = `translate(${dx}px, ${dy}px)`;

                            // Force browser layout recalculation
                            node.offsetWidth; 

                            // Turn on transition and remove transform so it glides to its real new position
                            node.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';
                            node.style.transform = '';
                        }
                    });

                    // Log the swap to lock out rapid feedback triggers
                    lastSwapX = e.clientX;
                    lastSwapY = e.clientY;
                    lastSwapTime = Date.now();
                };
                
                item.ondrop = (e) => {
                    e.preventDefault();
                    e.stopPropagation(); // Stop ComfyUI canvas listener
                    // Finalization is handled safely in ondragend
                };

                item.appendChild(img);
                item.appendChild(del);
                item.appendChild(numBadge);
                grid.appendChild(item);
            });

            if (!isRearranging) {
                requestAnimationFrame(() => updateLayout());
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

        uploadBtn.onclick = () => fileInput.click();
        fileInput.onchange = (e) => handleFiles(e.target.files);
        
        container.ondragover = (e) => { 
            e.preventDefault(); 
            e.stopPropagation(); // Prevent ComfyUI from seeing the drag event over this node
            container.style.borderColor = "#4CAF50"; 
        };
        container.ondragleave = (e) => { 
            e.preventDefault();
            e.stopPropagation(); // Prevent ComfyUI from seeing the drag event leave
            container.style.borderColor = "#353545"; 
        };
        container.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation(); // Crucial: Stop ComfyUI from capturing the dropped file and making a LoadImage node!
            container.style.borderColor = "#353545";
            if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
        };

        // --- 5. Logic: Paste Handling ---
        const pasteHandler = (e) => {
            // Only capture the paste if THIS specific node is currently selected in the graph
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
                    e.stopImmediatePropagation(); // Crucial: Stops ComfyUI from turning the pasted image into a "Load Image" node
                    handleFiles(files);
                }
            }
        };

        // Use capture: true to intercept the event BEFORE ComfyUI's default global paste listener triggers
        document.addEventListener("paste", pasteHandler, { capture: true });

        // Clean up the global event listener if the node is deleted
        const origOnRemoved = node.onRemoved;
        node.onRemoved = function() {
            document.removeEventListener("paste", pasteHandler, { capture: true });
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };

        // Hooks the main callback for external state loads (e.g., undo/redo or initial graph load)
        if (pathsWidget) {
            pathsWidget.callback = (v) => {
                if (oldCallback) oldCallback.apply(pathsWidget, [v]);
                refreshGallery();
            };
        }

        setTimeout(() => refreshGallery(), 100);
    }
});