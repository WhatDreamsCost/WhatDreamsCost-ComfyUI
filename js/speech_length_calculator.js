import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

// 1. DEFINE CSS STYLES GLOBALLY ONCE
// We use DOM elements instead of Canvas drawing so it works flawlessly in ComfyUI V3
const cssStyles = `
    .slc-ui-container {
        width: 100%;
        height: 100%;
        min-height: 260px; /* Increased from 220px to prevent V1 cropping */
        background-color: rgba(15, 15, 19, 0.7);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        padding: 12px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        font-family: sans-serif;
        color: #ffffff;
        overflow: hidden;
        pointer-events: auto; /* allows text selection */
    }
    .slc-empty {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
    }
    .slc-empty-title { color: #aaaaaa; font-size: 14px; font-weight: 500; margin-bottom: 4px; }
    .slc-empty-sub { color: #777777; font-size: 11px; }
    .slc-headers {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
    }
    .slc-header-block {
        flex: 1;
        background-color: rgba(0, 0, 0, 0.4);
        border-radius: 6px;
        padding: 8px 0;
        display: flex;
        flex-direction: column;
        align-items: center;
    }
    .slc-header-title { color: #888888; font-size: 9px; font-weight: bold; margin-bottom: 4px; }
    .slc-header-value { color: #ffffff; font-size: 16px; font-weight: bold; }
    .slc-cards {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .slc-card {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background-color: rgba(0, 0, 0, 0.25);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 4px;
        padding: 8px 12px 8px 16px;
        position: relative;
        overflow: hidden;
    }
    .slc-card::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 4px;
    }
    .slc-card.slow::before { background-color: #93c5fd; }
    .slc-card.avg::before { background-color: #86efac; }
    .slc-card.fast::before { background-color: #fca5a5; }
    
    .slc-card-left { display: flex; flex-direction: column; }
    .slc-card-speed { font-size: 12px; font-weight: bold; margin-bottom: 2px; }
    .slc-card.slow .slc-card-speed { color: #93c5fd; }
    .slc-card.avg .slc-card-speed { color: #86efac; }
    .slc-card.fast .slc-card-speed { color: #fca5a5; }
    .slc-card-wpm { font-size: 10px; color: #aaaaaa; }
    
    .slc-card-right { display: flex; flex-direction: column; align-items: flex-end; }
    .slc-card-time { font-size: 13px; font-weight: bold; color: #ffffff; margin-bottom: 2px; }
    .slc-card-frames { font-size: 11px; font-family: monospace; color: #888888; }
    
    .slc-legend {
        margin-top: auto;
        padding-top: 8px;
        color: #999999;
        font-size: 10px;
        font-weight: 500;
    }
`;

// Inject styles to document head safely
if (!document.getElementById("speech-length-calculator-styles")) {
    const styleEl = document.createElement("style");
    styleEl.id = "speech-length-calculator-styles";
    styleEl.textContent = cssStyles;
    document.head.appendChild(styleEl);
}

// 2. HELPER TO GENERATE THE HTML CONTENT
function buildUIHTML(statsData) {
    if (!statsData || statsData.empty) {
        return `
            <div class="slc-empty">
                <div class="slc-empty-title">Awaiting Script</div>
                <div class="slc-empty-sub">Wrap spoken text inside "quotes"</div>
            </div>
        `;
    }
    
    return `
        <div class="slc-headers">
            <div class="slc-header-block">
                <div class="slc-header-title">SPOKEN WORDS</div>
                <div class="slc-header-value">${statsData.wordCount}</div>
            </div>
            <div class="slc-header-block">
                <div class="slc-header-title">ADDED TIME</div>
                <div class="slc-header-value">${statsData.additionalTime}s</div>
            </div>
        </div>
        <div class="slc-cards">
            <div class="slc-card slow">
                <div class="slc-card-left">
                    <div class="slc-card-speed">SLOW</div>
                    <div class="slc-card-wpm">100 WPM</div>
                </div>
                <div class="slc-card-right">
                    <div class="slc-card-time">${statsData.slow.time}</div>
                    <div class="slc-card-frames">${statsData.slow.frames} frames</div>
                </div>
            </div>
            <div class="slc-card avg">
                <div class="slc-card-left">
                    <div class="slc-card-speed">AVG</div>
                    <div class="slc-card-wpm">130 WPM</div>
                </div>
                <div class="slc-card-right">
                    <div class="slc-card-time">${statsData.avg.time}</div>
                    <div class="slc-card-frames">${statsData.avg.frames} frames</div>
                </div>
            </div>
            <div class="slc-card fast">
                <div class="slc-card-left">
                    <div class="slc-card-speed">FAST</div>
                    <div class="slc-card-wpm">160 WPM</div>
                </div>
                <div class="slc-card-right">
                    <div class="slc-card-time">${statsData.fast.time}</div>
                    <div class="slc-card-frames">${statsData.fast.frames} frames</div>
                </div>
            </div>
        </div>
        <div class="slc-legend">WPM = Words Per Minute</div>
    `;
}

app.registerExtension({
    name: "Comfy.SpeechLengthCalculator",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "SpeechLengthCalculator") {

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

                // 3. CREATE THE DOM WIDGET
                const uiContainer = document.createElement("div");
                uiContainer.className = "slc-ui-container";
                uiContainer.innerHTML = buildUIHTML({ empty: true });

                // Attach to node: standard addDOMWidget works natively in both V1 and V3 Frontends
                let statsWidget;
                if (typeof this.addDOMWidget === "function") {
                    statsWidget = this.addDOMWidget("Stats", "HTML", uiContainer, {
                        serialize: false,
                        hideOnZoom: false
                    });
                } else {
                    // Fallback for very old unpatched V1 installations
                    statsWidget = ComfyWidgets["STRING"](this, "Stats", ["STRING", { multiline: true }], app).widget;
                    if (statsWidget.inputEl) {
                        statsWidget.inputEl.style.display = "none";
                        if (statsWidget.inputEl.parentNode) {
                            statsWidget.inputEl.parentNode.appendChild(uiContainer);
                        }
                    }
                }

                // Tell LiteGraph exactly how much vertical space to hold for our UI
                statsWidget.computeSize = function() {
                    return [0, 280]; // Increased from 240 to prevent bottom cropping in V1
                };

                // Ensure the node is wide enough on initial creation
                requestAnimationFrame(() => {
                    const minWidth = 340; 
                    if (this.size[0] < minWidth) this.size[0] = minWidth;
                    
                    // Fine tune initial height to account for the larger computeSize and make text box taller
                    if (this.size[1] < 500) this.size[1] = 500; 
                    
                    this.setDirtyCanvas(true, true);
                });

                // Fetch text from input link OR widget
                this._getCurrentText = () => {
                    const inputSlot = this.inputs && this.inputs.find(i => i.name === "text_input" || (i.name === "text" && i.link));
                    if (inputSlot && inputSlot.link) {
                        const link = app.graph.links[inputSlot.link];
                        if (link) {
                            const sourceNode = app.graph.getNodeById(link.origin_id);
                            if (sourceNode && sourceNode.widgets) {
                                const w = sourceNode.widgets.find(w => w.name === "value" || w.name === "text" || w.name === "Text" || w.type === "customtext" || w.type === "STRING");
                                if (w && typeof w.value === "string") return w.value;
                            }
                        }
                    }
                    const textWidget = this.widgets && this.widgets.find(w => w.name === "text");
                    return textWidget ? (textWidget.value || "") : "";
                };

                this._lastState = { text: null, fps: null, addTime: null };

                const updateStats = () => {
                    const fpsWidget = this.widgets && this.widgets.find(w => w.name === "fps");
                    const additionalTimeWidget = this.widgets && this.widgets.find(w => w.name === "additional_time");

                    if (!fpsWidget) return;

                    const text = this._getCurrentText();
                    const fps = fpsWidget.value || 24;
                    const additionalTime = additionalTimeWidget ? parseFloat(additionalTimeWidget.value) || 0 : 0;

                    // Skip expensive calculations if nothing changed
                    if (this._lastState.text === text && 
                        this._lastState.fps === fps && 
                        this._lastState.addTime === additionalTime) {
                        return;
                    }
                    
                    this._lastState.text = text;
                    this._lastState.fps = fps;
                    this._lastState.addTime = additionalTime;

                    const regex = /"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’/g;
                    let match;
                    let quotedText = "";
                    while ((match = regex.exec(text)) !== null) {
                        quotedText += (match[1] || match[2] || match[3] || match[4] || "") + " ";
                    }

                    const words = quotedText.trim().split(/\s+/).filter(w => w.length > 0);
                    const wordCount = words.length;

                    const formatTime = (wpm) => {
                        const baseMins = wordCount / wpm;
                        const totalSecs = (baseMins * 60) + additionalTime;
                        
                        const mins = Math.floor(totalSecs / 60);
                        let secs = totalSecs % 60;
                        secs = Math.ceil(secs * 10) / 10;
                        const frames = Math.ceil(totalSecs * fps);

                        const secsStr = secs.toFixed(1);
                        const timeStr = mins > 0 ? `${mins}m ${secsStr}s` : `${secsStr}s`;
                        
                        return {
                            time: timeStr,
                            frames: frames.toString()
                        };
                    };

                    const statsData = {
                        empty: (wordCount === 0 && additionalTime === 0),
                        wordCount: wordCount,
                        additionalTime: additionalTime,
                        slow: formatTime(100),
                        avg: formatTime(130),
                        fast: formatTime(160)
                    };
                    
                    // 4. INJECT HTML TO THE DOM
                    // Replaces the heavy canvas redrawing!
                    uiContainer.innerHTML = buildUIHTML(statsData);
                    
                    this.setDirtyCanvas(true, false);
                };

                // We still use onDrawBackground as an efficient silent trigger 
                // to auto-update in case upstream nodes silently change their text
                const onDrawBackground = this.onDrawBackground;
                this.onDrawBackground = function(ctx) {
                    if (onDrawBackground) onDrawBackground.apply(this, arguments);
                    updateStats();
                };

                // Bind events to update in real time based on node interactions
                setTimeout(() => {
                    const textWidget = this.widgets && this.widgets.find(w => w.name === "text");
                    const fpsWidget = this.widgets && this.widgets.find(w => w.name === "fps");
                    const additionalTimeWidget = this.widgets && this.widgets.find(w => w.name === "additional_time");

                    if (textWidget) {
                        const origCallback = textWidget.callback;
                        textWidget.callback = function() {
                            if (origCallback) origCallback.apply(this, arguments);
                            updateStats();
                        }
                    }
                    if (fpsWidget) {
                        const origFpsCallback = fpsWidget.callback;
                        fpsWidget.callback = function() {
                            if (origFpsCallback) origFpsCallback.apply(this, arguments);
                            updateStats();
                        }
                    }
                    if (additionalTimeWidget) {
                        const origAddCallback = additionalTimeWidget.callback;
                        additionalTimeWidget.callback = function() {
                            if (origAddCallback) origAddCallback.apply(this, arguments);
                            updateStats();
                        }
                    }
                    updateStats();
                }, 100);

                return r;
            };
        }
    }
});