const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

// --- UI Constants & Configuration ---
const RULER_HEIGHT = 24;
const BLOCK_HEIGHT = 160; // Increased to make the image timeline area much taller
const PROMPT_TRACK_HEIGHT = 72;
const CAMERA_TRACK_HEIGHT = 72;
const CONTROL_TRACK_HEIGHT = 72;
const AUDIO_TRACK_HEIGHT = 80;
const CANVAS_HEIGHT = RULER_HEIGHT + BLOCK_HEIGHT + PROMPT_TRACK_HEIGHT + CAMERA_TRACK_HEIGHT + CONTROL_TRACK_HEIGHT + AUDIO_TRACK_HEIGHT;
const HANDLE_HIT_PX = 14;
const MIN_SEGMENT_LENGTH = 6;
const MAX_THUMBNAIL_DIM = 512; // Increased to maintain quality for taller images

const HIDDEN_WIDGET_NAMES = [
  "timeline_data", "local_prompts", "segment_lengths", "guide_strength", "audio_data", "use_custom_audio",
  "duration_frames", "duration_seconds", "frame_rate", "custom_width", "custom_height", "resize_method",
];
const CAMERA_MOTION_PRESETS = [
  { value: "none", label: "无指定 / None", prompt: "" },
  { value: "static", label: "固定镜头 / Static", prompt: "static camera, locked stable shot, no pan, no zoom, no camera shake" },
  { value: "dolly_in", label: "推镜 / Dolly In", prompt: "dolly in, camera moves forward toward the subject with stable framing" },
  { value: "dolly_out", label: "拉镜 / Dolly Out", prompt: "dolly out, camera moves backward away from the subject with stable framing" },
  { value: "dolly_left", label: "向左横移 / Dolly Left", prompt: "dolly left, camera tracks left with stable framing" },
  { value: "dolly_right", label: "向右横移 / Dolly Right", prompt: "dolly right, camera tracks right with stable framing" },
  { value: "jib_up", label: "升镜 / Jib Up", prompt: "jib up, camera rises upward with stable framing" },
  { value: "jib_down", label: "降镜 / Jib Down", prompt: "jib down, camera lowers downward with stable framing" },
  { value: "focus_shift", label: "焦点转移 / Focus Shift", prompt: "focus shift, rack focus from one subject plane to another while camera remains stable" },
];
const CAMERA_MOTION_BY_ID = Object.fromEntries(CAMERA_MOTION_PRESETS.map(p => [p.value, p]));

const DIRECTOR_I18N = {
  en: {
    audio: "Audio",
    keyframe: "KeyFrame",
    ref: "Ref",
    localPrompt: "Local Prompt",
    camera: "Camera",
    cut: "Cut",
    icControl: "IC-Control",
    icLoraControl: "IC-LoRA Control",
    strength: "Strength",
    keyframeStrength: "Keyframe Strength",
    referenceStrength: "Reference Strength",
    icControlStrength: "IC-Control Strength",
    delete: "Delete",
    settings: "Settings",
    showHideSegments: "Show/Hide Segments",
    showHideSegmentsTitle: "Show/Hide long-auto segment memory",
    queueAll: "Queue All",
    queueAllTitle: "Render every planned long-auto cut sequentially and feed each tail frame into the next segment",
    rendering: "Rendering...",
    autoCut: "Auto Cut",
    autoCutOnTitle: "Auto split at camera and IC-Control boundaries, plus manual cuts and max length",
    autoCutOffTitle: "Only split at manual cuts and max length",
    on: "ON",
    off: "OFF",
    help: "Help / Documentation",
    start: "Start",
    end: "End",
    referenceEmpty: "Reference channel empty",
    dropKeyframe: "Drop Keyframe",
    dropAudio: "Drop Audio",
    continue: "Continue",
    continueTitle: "Continue rendering from this segment; completed segments are skipped",
    regen: "Re-gen",
    regenTitle: "Regenerate only this segment, using a keyframe or the previous completed tail frame as the start frame",
    reset: "Reset",
    resetTitle: "Forget this segment's completed video/tail memory",
    done: "done",
    pending: "pending",
    placeholder: "placeholder",
    videoOk: "video ok",
    videoMissing: "video ?",
    tailOk: "tail ok",
    tailMissing: "tail ?",
    longAutoSegments: "Long-Auto Segments",
    closeSegments: "Close Segments",
    noLongAutoMemory: "Long-auto segment memory is only available in long-auto workflows.",
    timelineSettings: "Timeline Settings",
    closeSettings: "Close Settings",
    displayMode: "Display Mode",
    frames: "Frames",
    seconds: "Seconds",
    renderSegment: "Render Segment",
    output: "Output",
    durationFrames: "Duration Frames",
    durationSeconds: "Duration Seconds",
    maxSegmentSeconds: "Max Segment Seconds",
    frameRate: "Frame Rate",
    width: "Width",
    height: "Height",
    resize: "Resize",
    useGlobalPrompt: "Use Global Prompt",
    customAudio: "Custom Audio",
    hideWidgets: "Hide Widgets on Node",
    showWidgets: "Show Widgets on Node",
    manualCut: "Manual Cut",
    localPromptSegment: "Local Prompt Segment",
    cameraSegment: "Camera Segment",
  },
  zh: {
    audio: "音频",
    keyframe: "关键帧",
    ref: "参考图",
    localPrompt: "局部提示词",
    camera: "镜头",
    cut: "裁切",
    icControl: "IC 控制",
    icLoraControl: "IC-LoRA 控制",
    strength: "强度",
    keyframeStrength: "关键帧强度",
    referenceStrength: "参考图强度",
    icControlStrength: "IC 控制强度",
    delete: "删除",
    settings: "设置",
    showHideSegments: "显示/隐藏分段",
    showHideSegmentsTitle: "显示/隐藏 Long-Auto 分段记忆",
    queueAll: "队列全部",
    queueAllTitle: "按顺序渲染所有计划分段，并把每段尾帧传给下一段",
    rendering: "渲染中...",
    autoCut: "自动裁切",
    autoCutOnTitle: "在镜头和 IC-Control 边界自动切分，并保留手动切点和最长段限制",
    autoCutOffTitle: "只按手动切点和最长段限制切分",
    on: "开",
    off: "关",
    help: "帮助 / 文档",
    start: "开始",
    end: "结束",
    referenceEmpty: "参考通道为空",
    dropKeyframe: "拖入关键帧",
    dropAudio: "拖入音频",
    continue: "继续",
    continueTitle: "从此分段继续渲染；已完成分段会跳过",
    regen: "重生成",
    regenTitle: "只重新生成此分段，首帧使用关键帧或上一段完成的尾帧",
    reset: "重置",
    resetTitle: "忘记此分段已完成的视频/尾帧记忆",
    done: "完成",
    pending: "等待",
    placeholder: "占位",
    videoOk: "视频 ok",
    videoMissing: "视频 ?",
    tailOk: "尾帧 ok",
    tailMissing: "尾帧 ?",
    longAutoSegments: "Long-Auto 分段",
    closeSegments: "关闭分段面板",
    noLongAutoMemory: "Long-Auto 分段记忆只在 long-auto 工作流中可用。",
    timelineSettings: "时间线设置",
    closeSettings: "关闭设置",
    displayMode: "显示模式",
    frames: "帧",
    seconds: "秒",
    renderSegment: "渲染分段",
    output: "输出",
    durationFrames: "总帧数",
    durationSeconds: "总秒数",
    maxSegmentSeconds: "最大分段秒数",
    frameRate: "帧率",
    width: "宽度",
    height: "高度",
    resize: "缩放",
    useGlobalPrompt: "使用全局提示词",
    customAudio: "自定义音频",
    hideWidgets: "隐藏节点控件",
    showWidgets: "显示节点控件",
    manualCut: "手动裁切",
    localPromptSegment: "局部提示词片段",
    cameraSegment: "镜头片段",
  },
};

function getUILanguage() {
  if (typeof window.shezwGetUILanguage === "function") return window.shezwGetUILanguage();
  const metaNode = (app?.graph?._nodes || []).find((node) => node.type === "ShezwMetaInfo");
  const value = `${metaNode?.properties?.ui_language || window.shezwCurrentUILanguage || "en"}`.trim();
  return Object.prototype.hasOwnProperty.call(DIRECTOR_I18N, value) ? value : "en";
}

function t(key, fallback = key) {
  const lang = getUILanguage();
  return DIRECTOR_I18N[lang]?.[key] || DIRECTOR_I18N.en[key] || fallback;
}

function hideWidget(w) {
  if (!w) return;
  if (!w._origType && w.type !== "hidden") w._origType = w.type;
  // We don't set w.type = "hidden" anymore because it causes rendering issues in Nodes 2.0.
  // Instead we use the computeSize = () => [0,0] trick which works in both V1 and V2.
  w.hidden = true;
  if (!w.options) w.options = {};
  w.options.hidden = true;
  w.computeSize = () => [0, 0];
  if (w.element) w.element.style.display = "none";
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function getCameraMotionPreset(value) {
  return CAMERA_MOTION_BY_ID[value] || CAMERA_MOTION_BY_ID.static;
}

function cameraPromptForMotion(value) {
  return getCameraMotionPreset(value).prompt;
}

function cameraLabelForMotion(value) {
  return getCameraMotionPreset(value).label;
}

function inferCameraMotionFromPrompt(prompt) {
  const text = (prompt || "").toLowerCase();
  if (!text.trim()) return "none";
  if (text.includes("focus") || text.includes("rack focus") || text.includes("拉焦") || text.includes("焦点")) return "focus_shift";
  if (text.includes("dolly in") || text.includes("dolly-in") || text.includes("push in") || text.includes("push-in") || text.includes("pushes in") || text.includes("推镜") || text.includes("推近")) return "dolly_in";
  if (text.includes("dolly out") || text.includes("dolly-out") || text.includes("pull out") || text.includes("pull-out") || text.includes("pull back") || text.includes("拉镜") || text.includes("拉远")) return "dolly_out";
  if (text.includes("dolly left") || text.includes("track left") || text.includes("trucks left") || text.includes("向左") || text.includes("左横移")) return "dolly_left";
  if (text.includes("dolly right") || text.includes("track right") || text.includes("trucks right") || text.includes("向右") || text.includes("右横移")) return "dolly_right";
  if (text.includes("jib up") || text.includes("crane up") || text.includes("rises upward") || text.includes("升镜") || text.includes("上升")) return "jib_up";
  if (text.includes("jib down") || text.includes("crane down") || text.includes("lowers downward") || text.includes("降镜") || text.includes("下降")) return "jib_down";
  if (text.includes("static") || text.includes("locked") || text.includes("stable") || text.includes("hold") || text.includes("no pan") || text.includes("no zoom") || text.includes("固定") || text.includes("静止") || text.includes("稳定")) return "static";
  return "none";
}

// --- Modern Dark/Grey UI CSS (ComfyUI Match) ---
const STYLES = `
  .pr-wrapper {
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    padding-bottom: 4px;
  }
  .pr-wrapper.drag-active {
    outline: 2px dashed #888;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
  }
  .pr-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 2px 0px;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pr-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pr-btn {
    background: #222;
    color: #e0e0e0;
    border: 1px solid #111;
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: all 0.2s ease;
  }
  .pr-btn:hover {
    background: #333;
    border-color: #555;
  }
  .pr-btn.active {
    background: #263243;
    border-color: #5f83b6;
    color: #f2f7ff;
  }
  .pr-btn-danger:hover {
    background: #4a1515;
    border-color: #cc4444;
    color: #ffaaaa;
  }
  .pr-canvas {
    border-radius: 6px;
    border: 1px solid #111;
    background: #2a2a2a;
    cursor: pointer;
    width: 100%;
    outline: none;
    display: block; /* Ensure no inline baseline gaps */
  }
  .pr-prop-container {
    display: flex;
    flex-direction: column;
    width: 100%;
    flex-grow: 1; /* Automatically scales to fill node height */
    min-height: 40px;
  }
  .pr-prompt-area {
    width: 100%;
    height: 100%;
    background: #222;
    color: #e0e0e0;
    border: 1px solid #111;
    border-radius: 6px;
    padding: 8px;
    resize: none; /* Removed the manual resize corner handle */
    font-size: 12px;
    line-height: 1.4;
    box-sizing: border-box;
    outline: none;
    transition: border-color 0.2s ease;
  }
  .pr-prompt-area:focus {
    border-color: #888;
  }
  .pr-camera-select {
    width: 100%;
    min-height: 38px;
    background: #222;
    color: #e0e0e0;
    border: 1px solid #111;
    border-radius: 6px;
    padding: 8px;
    font-size: 12px;
    box-sizing: border-box;
    outline: none;
  }
  .pr-camera-select:focus {
    border-color: #888;
  }
  .pr-audio-info {
    width: 100%;
    height: 100%;
    background: #181818;
    color: #aaa;
    border: 1px solid #111;
    border-radius: 6px;
    padding: 10px;
    font-size: 12px;
    line-height: 1.6;
    box-sizing: border-box;
    display: none;
  }
  .pr-audio-info span { color: #fff; font-weight: 500; }
  .pr-reference-channel {
    display: flex;
    align-items: stretch;
    gap: 8px;
    min-height: 82px;
    background: #151515;
    border: 1px solid #111;
    border-radius: 6px;
    padding: 8px;
    box-sizing: border-box;
    overflow-x: auto;
  }
  .pr-reference-empty {
    color: #777;
    font-size: 12px;
    display: flex;
    align-items: center;
    padding: 0 6px;
  }
  .pr-reference-card {
    width: 92px;
    min-width: 92px;
    border: 1px solid #333;
    border-radius: 5px;
    background: #202020;
    color: #ddd;
    cursor: pointer;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .pr-reference-card.active {
    border-color: #d7a94f;
    box-shadow: 0 0 0 1px #d7a94f inset;
  }
  .pr-reference-card img {
    width: 100%;
    height: 58px;
    object-fit: cover;
    background: #000;
  }
  .pr-reference-label {
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
    text-align: center;
    color: #f2d28a;
  }
  .pr-controls-group {
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 4px;
    box-sizing: border-box;
    width: 100%;
  }
  .pr-strength-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    box-sizing: border-box;
  }
  .pr-height-resizer {
    height: 6px;
    background: #2a2a2a;
    cursor: ns-resize;
    border-radius: 3px;
    margin: 2px 0;
    transition: background 0.15s;
    border: 1px solid #1e1e1e;
  }
  .pr-height-resizer:hover {
    background: #444;
    border-color: #555;
  }
  .pr-strength-label {
    font-size: 11px;
    font-weight: 600;
    color: #fff;
    white-space: nowrap;
    margin-left: auto;
  }
  .pr-strength-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 80px;
    height: 4px;
    background: #444;
    border-radius: 2px;
    outline: none;
    cursor: pointer;
    border: 1px solid #222;
  }
  .pr-strength-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #aaa;
    cursor: pointer;
  }
  .pr-strength-slider:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
  .pr-strength-input {
    font-size: 12px;
    font-weight: 700;
    color: #fff;
    background: linear-gradient(90deg, #d7a94f 0%, #d7a94f 100%, #222 100%, #222 100%);
    border: 1px solid #6f5624;
    border-radius: 5px;
    width: 180px;
    height: 24px;
    text-align: right;
    padding: 0 10px;
    box-sizing: border-box;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04);
  }
  .pr-strength-input::-webkit-outer-spin-button,
  .pr-strength-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .pr-strength-input[type=number] {
    -moz-appearance: textfield;
  }
  .pr-strength-input:disabled {
    opacity: 0.38;
    cursor: not-allowed;
    border-color: #444;
  }
  .pr-gap-menu {
    position: fixed;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 9999;
    box-shadow: 0 4px 16px rgba(0,0,0,0.6);
  }
  .pr-gap-menu-btn {
    background: #2a2a2a;
    color: #e0e0e0;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 6px 14px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: background 0.15s ease;
  }
  .pr-gap-menu-btn:hover {
    background: #3a3a3a;
    border-color: #666;
  }
  .pr-player-controls {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    padding: 2px 0;
    flex-wrap: wrap;
    width: 100%;
  }
  .pr-icon-btn {
    background: #2a2a2a;
    border: 1px solid #444;
    color: #eee;
    cursor: pointer;
    padding: 6px 12px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }
  .pr-icon-btn * {
    pointer-events: none;
  }
  .pr-icon-btn:hover {
    color: #fff;
    background: #3a3a3a;
    border-color: #666;
  }
  .pr-icon-btn.active {
    color: #4fff8f;
    border-color: #4fff8f;
    background: #1a3a2a;
  }
  .pr-seek-bar {
    -webkit-appearance: none;
    appearance: none;
    height: 6px;
    background: #444;
    border-radius: 3px;
    outline: none;
    cursor: pointer;
    border: 1px solid #222;
  }
  .pr-seek-bar::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #ff4444;
    cursor: pointer;
    border: 2px solid #222;
  }
  .pr-timeline-viewport {
    width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .pr-timeline-viewport::-webkit-scrollbar {
    height: 10px;
  }
  .pr-timeline-viewport::-webkit-scrollbar-track {
    background: #151515;
    border-radius: 5px;
  }
  .pr-timeline-viewport::-webkit-scrollbar-thumb {
    background: #444
    border-radius: 5px;
    border: 1px solid #000;
  }
  .pr-timeline-viewport::-webkit-scrollbar-thumb:hover {
    background: #666
    border-color: #000;
  }
  .pr-zoom-controls {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: 12px;
  }
  .pr-zoom-slider {
    width: 80px;
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    background: #444;
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }
  .pr-zoom-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #aaa;
    cursor: pointer;
  }
  .pr-right-group {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .pr-segment-bounds {
    font-size: 12px;
    color: #aaa;
    font-family: monospace;
  }
  .pr-timecode {
    font-size: 14px;
    font-weight: bold;
    color: #e0e0e0;
    font-family: monospace;
  }
  .pr-settings-menu {
    position: fixed;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 9999;
    box-shadow: 0 4px 20px rgba(0,0,0,0.7);
    min-width: 220px;
    max-height: calc(100vh - 24px);
    overflow-y: auto;
  }
  .pr-settings-title {
    font-size: 11px;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding-bottom: 4px;
    border-bottom: 1px solid #333;
    margin-bottom: 2px;
  }
  .pr-settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .pr-settings-label {
    font-size: 12px;
    color: #bbb;
    flex: 1;
    white-space: nowrap;
  }
  .pr-number-control {
    display: flex;
    align-items: center;
    border: 1px solid #444;
    border-radius: 4px;
    background: #2a2a2a;
    overflow: hidden;
  }
  .pr-number-btn {
    background: #333;
    color: #aaa;
    border: none;
    width: 20px;
    height: 22px;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s;
    user-select: none;
  }
  .pr-number-btn:hover {
    background: #444;
    color: #fff;
  }
  .pr-settings-input {
    background: transparent;
    color: #e0e0e0;
    border: none;
    padding: 0 4px;
    font-size: 12px;
    width: 50px;
    height: 22px;
    text-align: center;
    font-family: monospace;
    outline: none;
    -moz-appearance: textfield;
  }
  .pr-settings-input::-webkit-outer-spin-button,
  .pr-settings-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .pr-settings-select {
    background: #2a2a2a;
    color: #e0e0e0;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 3px 4px;
    font-size: 12px;
    width: 98px;
    cursor: pointer;
  }
  .pr-settings-divider {
    border: none;
    border-top: 1px solid #2a2a2a;
    margin: 2px 0;
  }
  .pr-settings-toggle-btn {
    width: 100%;
    background: #252525;
    color: #aaa;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 5px 8px;
    font-size: 11px;
    cursor: pointer;
    text-align: center;
    transition: all 0.15s;
  }
  .pr-settings-toggle-btn:hover {
    background: #2e2e2e;
    color: #ccc;
    border-color: #555;
  }
  .pr-settings-close-btn {
    background: transparent;
    color: #888;
    border: none;
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: all 0.15s;
  }
  .pr-settings-close-btn:hover {
    color: #fff;
    background: rgba(255,255,255,0.1);
  }
  .pr-segment-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 260px;
    overflow: auto;
    width: 100%;
  }
  .pr-segment-row {
    display: grid;
    grid-template-columns: 44px 1fr auto auto;
    gap: 6px;
    align-items: center;
    background: #202020;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 5px;
  }
  .pr-segment-row.done {
    border-color: #3d6849;
    background: #1d2a20;
  }
  .pr-segment-row.active {
    border-color: #5f83b6;
  }
  .pr-segment-index {
    font-size: 11px;
    color: #ddd;
    font-weight: 600;
  }
  .pr-segment-meta {
    min-width: 0;
    font-size: 10px;
    color: #aaa;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pr-segment-status {
    font-size: 10px;
    color: #aaa;
  }
  .pr-segment-row.done .pr-segment-status {
    color: #8fe09f;
  }
  .pr-mini-btn {
    background: #2b2b2b;
    color: #ddd;
    border: 1px solid #444;
    border-radius: 4px;
    font-size: 10px;
    padding: 3px 5px;
    cursor: pointer;
  }
  .pr-mini-btn:hover {
    background: #383838;
    border-color: #666;
  }
  .pr-mini-btn.danger:hover {
    background: #4a1515;
    border-color: #cc4444;
  }
  .pr-segmented-control {
    display: flex;
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 2px;
    width: 110px;
    height: 22px;
    align-items: center;
    box-sizing: border-box;
  }
  .pr-segment {
    flex: 1;
    text-align: center;
    font-size: 10px;
    font-weight: 500;
    line-height: 18px;
    cursor: pointer;
    border-radius: 4px;
    color: #888;
    transition: all 0.15s ease;
  }
  .pr-segment.active {
    background: #333;
    color: #fff;
  }
  .pr-segment:hover:not(.active) {
    color: #ccc;
  }
`;

if (!document.getElementById("prompt-relay-styles")) {
  const styleEl = document.createElement("style");
  styleEl.id = "prompt-relay-styles";
  styleEl.textContent = STYLES;
  document.head.appendChild(styleEl);
}

// --- Icons ---
const ICONS = {
  upload: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`,
  audio: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,
  bolt: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 10-13h-7l0-7z"></path></svg>`,
  image: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg>`,
  camera: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
  control: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7"></path><path d="M4 10V3"></path><path d="M12 21v-9"></path><path d="M12 8V3"></path><path d="M20 21v-5"></path><path d="M20 12V3"></path><path d="M2 14h4"></path><path d="M10 8h4"></path><path d="M18 16h4"></path></svg>`,
  cut: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"></line><path d="M6 7l6-4 6 4"></path><path d="M6 17l6 4 6-4"></path></svg>`,
  scissors: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.1" y2="15.9"></line><line x1="8.1" y1="8.1" x2="20" y2="20"></line></svg>`,
  video: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="14" height="14" rx="2"></rect><path d="M17 9l4-3v12l-4-3"></path></svg>`,
  trash: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  text: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>`,
  play: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
  pause: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`,
  loop: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12A9 9 0 0 0 6 5.3L3 8"></path><polyline points="3 3 3 8 8 8"></polyline><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"></path><polyline points="21 21 21 16 16 16"></polyline></svg>`,
  minus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  fit: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><polyline points="8 7 3 12 8 17"></polyline><polyline points="16 7 21 12 16 17"></polyline></svg>`,
  list: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><circle cx="3.5" cy="6" r="1"></circle><circle cx="3.5" cy="12" r="1"></circle><circle cx="3.5" cy="18" r="1"></circle></svg>`,
  fan: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"></circle><path d="M12 2c3 0 4 3 2 6l-2 4"></path><path d="M21 17c-1.5 2.6-4.7 2.4-6.5-.4L12 12"></path><path d="M3 17c-1.5-2.6.2-5.4 3.5-5.6L12 12"></path></svg>`,
  toggle: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="10" rx="5"></rect><circle cx="9" cy="12" r="2"></circle></svg>`,
  gear: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  close: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`
};

// --- Data Models ---
function parseInitial(jsonStr) {
  let parsed = { segments: [], promptSegments: [], referenceImages: [], cameraSegments: [], controlSegments: [], audioSegments: [], cutSegments: [], meta: {} };
  try {
    if (jsonStr) {
      const p = JSON.parse(jsonStr);
      if (Array.isArray(p.segments)) parsed.segments = p.segments;
      if (Array.isArray(p.promptSegments)) parsed.promptSegments = p.promptSegments;
      if (Array.isArray(p.referenceImages)) parsed.referenceImages = p.referenceImages;
      if (Array.isArray(p.cameraSegments)) parsed.cameraSegments = p.cameraSegments;
      if (Array.isArray(p.controlSegments)) parsed.controlSegments = p.controlSegments;
      if (Array.isArray(p.audioSegments)) parsed.audioSegments = p.audioSegments;
      if (Array.isArray(p.cutSegments)) parsed.cutSegments = p.cutSegments;
      if (p.meta && typeof p.meta === "object" && !Array.isArray(p.meta)) parsed.meta = p.meta;
    }
  } catch (e) { }

  let currentStart = 0;
  const migratedPromptSegments = [];
  const imageSegments = [];
  for (let seg of parsed.segments) {
    if (seg.start === undefined) {
      seg.start = currentStart;
      currentStart += seg.length;
    }
    // Guarantee ID assignment to prevent node loading drag breaks
    if (!seg.id) {
      seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    }
    if (seg.type === "text") {
      migratedPromptSegments.push({ ...seg, type: "prompt" });
      continue;
    }
    if ((seg.prompt || "").trim()) {
      migratedPromptSegments.push({
        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
        start: seg.start,
        length: seg.length,
        prompt: seg.prompt,
        type: "prompt",
      });
      seg.caption = seg.caption || seg.prompt;
      delete seg.prompt;
    }
    if (seg.guideStrength === undefined) seg.guideStrength = 1.0;
    imageSegments.push(seg);
  }
  parsed.segments = imageSegments;
  parsed.promptSegments = [...migratedPromptSegments, ...parsed.promptSegments];

  for (let seg of parsed.promptSegments) {
    if (!seg.id) {
      seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    }
    seg.type = "prompt";
    if (seg.start === undefined) seg.start = 0;
    if (seg.length === undefined) seg.length = 24;
    if (seg.prompt === undefined) seg.prompt = "";
  }

  for (let seg of parsed.audioSegments) {
    if (!seg.id) {
      seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    }
    if (seg.trimStart === undefined) seg.trimStart = 0;
  }

  for (let seg of parsed.cameraSegments) {
    if (!seg.id) {
      seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    }
    if (seg.type === undefined) seg.type = "camera";
    if (!CAMERA_MOTION_BY_ID[seg.cameraMotion]) {
      seg.cameraMotion = inferCameraMotionFromPrompt(seg.prompt);
    }
    seg.prompt = cameraPromptForMotion(seg.cameraMotion);
  }

  for (let seg of parsed.controlSegments) {
    if (!seg.id) {
      seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    }
    seg.type = "control";
    if (!seg.controlType) seg.controlType = "camera_depth";
    if (seg.strength === undefined) seg.strength = 0.75;
    if (seg.prompt === undefined) seg.prompt = "";
  }

  parsed.referenceImages.forEach((seg, idx) => {
    if (!seg.id) {
      seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    }
    seg.type = "reference";
    seg.refName = `@Ref${idx + 1}`;
    if (seg.note === undefined) seg.note = "";
  });

  for (let seg of parsed.cutSegments) {
    if (!seg.id) {
      seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    }
    seg.type = "cut";
    if (seg.start === undefined) seg.start = seg.frame !== undefined ? seg.frame : 0;
    seg.start = Math.max(0, Math.round(seg.start || 0));
    seg.frame = seg.start;
    if (seg.label === undefined) seg.label = "CUT";
  }

  return parsed;
}

class TimelineEditor {
  constructor(node, container, domWidget) {
    this.node = node;
    this.container = container;
    this.domWidget = domWidget;

    // Track heights (dynamic)
    this.rulerHeight = RULER_HEIGHT;
    this.blockHeight = BLOCK_HEIGHT;
    this.cameraTrackHeight = CAMERA_TRACK_HEIGHT;
    this.controlTrackHeight = CONTROL_TRACK_HEIGHT;
    this.audioTrackHeight = AUDIO_TRACK_HEIGHT;
    this.canvasHeight = CANVAS_HEIGHT;

    // Core data
    this.timeline = { segments: [], promptSegments: [], referenceImages: [], cameraSegments: [], controlSegments: [], audioSegments: [], cutSegments: [], meta: {} };
    this.selectionType = "image"; // "image", "prompt", "reference", "camera", "control", "audio", or "cut"
    this.selectedIndex = -1;
    this.multiSelection = [];

    // Interactions
    this._isDragging = false;
    this._dragType = null;
    this._dragStartX = 0;
    this._dragInitialTimeline = null;
    this.zoomLevel = 1.0;
    this._lastZoom = 1.0;
    this._lastScale = 1.0;
    this._dragTargetId = null;
    this._dragTargetIdRight = null;
    this._previewSegments = null;
    this._lastWidth = 0;
    this._hoveredGapIdx = -1;
    this._isHovering = false;
    this._boxSelectStart = null;
    this._boxSelectRect = null;
    this._settingsInputBindings = [];
    this._languageChangeHandler = () => this.refreshLanguage();

    // Playback state
    this.currentFrame = 0;
    this.isPlaying = false;
    this.isLooping = false;
    this.audioContext = null;
    this.activeAudioNodes = [];
    this.playbackStartTime = 0;
    this.playbackStartFrame = 0;
    this._playLoopId = null;

    // --- Ghost dragging state ---
    this._ghostSegmentId = null;
    this._ghostTrack = null;
    this._ghostInitialTimeline = null;

    // Attach to Python widgets
    this._gapMenu = null;         // Active gap popup menu element
    this._gapMenuDismisser = null;

    // Attach to Python widgets
    this.durationFramesWidget = this.node.widgets.find(w => w.name === "duration_frames");
    this.durationSecondsWidget = this.node.widgets.find(w => w.name === "duration_seconds");
    this.frameRateWidget = this.node.widgets.find(w => w.name === "frame_rate");
    this.timelineDataWidget = this.node.widgets.find(w => w.name === "timeline_data");
    this.localPromptsWidget = this.node.widgets.find(w => w.name === "local_prompts");
    this.segmentLengthsWidget = this.node.widgets.find(w => w.name === "segment_lengths");
    this.guideStrengthWidget = this.node.widgets.find(w => w.name === "guide_strength");
    this.displayModeWidget = this.node.widgets.find(w => w.name === "display_mode");

    this.timeline = parseInitial(this.timelineDataWidget?.value);
    this.loadImages();

    this.createDOM();
    window.addEventListener("shezw-ui-language-change", this._languageChangeHandler);
    if (this.timeline.segments.length > 0) {
      this.selectedIndex = 0;
    }
    this.updateUIFromSelection();
    this.commitChanges(true);
    this.updateLongAutoUI();
    // Hide settings widgets by default to reduce node clutter.
    // Deferred so all widget types are finalized before we touch them.
    setTimeout(() => this.hideSettingsWidgets(), 0);

    let isSyncing = false;

    const origDurationFramesCallback = this.durationFramesWidget?.callback;
    if (this.durationFramesWidget) {
      this.durationFramesWidget.callback = (...args) => {
        if (origDurationFramesCallback) origDurationFramesCallback.apply(this.durationFramesWidget, args);

        if (!isSyncing && this.durationSecondsWidget) {
          isSyncing = true;
          this.durationSecondsWidget.value = parseFloat((this.getDurationFrames() / this.getFrameRate()).toFixed(3));
          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origDurationSecondsCallback = this.durationSecondsWidget?.callback;
    if (this.durationSecondsWidget) {
      this.durationSecondsWidget.callback = (...args) => {
        if (origDurationSecondsCallback) origDurationSecondsCallback.apply(this.durationSecondsWidget, args);

        if (!isSyncing && this.durationFramesWidget) {
          isSyncing = true;
          const newFrames = Math.max(1, Math.round(this.durationSecondsWidget.value * this.getFrameRate()));
          this.durationFramesWidget.value = newFrames;
          if (this.durationFramesWidget.callback) this.durationFramesWidget.callback(newFrames);
          isSyncing = false;
        }
      };
    }

    const origFrameRateCallback = this.frameRateWidget?.callback;
    if (this.frameRateWidget) {
      this.frameRateWidget.callback = (...args) => {
        if (origFrameRateCallback) origFrameRateCallback.apply(this.frameRateWidget, args);
        if (!isSyncing && this.durationSecondsWidget) {
          isSyncing = true;
          this.durationSecondsWidget.value = parseFloat((this.getDurationFrames() / this.getFrameRate()).toFixed(3));
          isSyncing = false;
        }
      };
    }

    const origDisplayModeCallback = this.displayModeWidget?.callback;
    if (this.displayModeWidget) {
      this.displayModeWidget.callback = (...args) => {
        if (origDisplayModeCallback) origDisplayModeCallback.apply(this.displayModeWidget, args);
        this.updateWidgetVisibility();
        this.updateUIFromSelection();
        this.render();
      };
      this.updateWidgetVisibility(); // Initial trigger
    }

    // Polling is much more reliable in Comfy than ResizeObserver due to scale transforms
    this._renderLoop = requestAnimationFrame(() => this.checkResize());
  }

  destroy() {
    cancelAnimationFrame(this._renderLoop);
    this.pauseAudio();
    window.removeEventListener("shezw-ui-language-change", this._languageChangeHandler);
    window.removeEventListener("keydown", this.handleKeyDown, true);
    window.removeEventListener("paste", this.handlePaste, true);
  }

  reloadFromWidgets() {
    this.timeline = parseInitial(this.timelineDataWidget?.value);
    this.loadImages();
    this.selectionType = "image";
    this.selectedIndex = this.timeline.segments.length > 0 ? 0 : -1;
    this.clearMultiSelection();
    this.currentFrame = 0;
    this.updateUIFromSelection();
    this.commitChanges();
    this.reconcileLongAutoMemoryFromPrefix().catch((err) => {
      console.warn("[Shezw LongAuto] Prefix output analysis failed", err);
    });
  }

  getDurationFrames() {
    return parseInt((this.durationFramesWidget && this.durationFramesWidget.value > 0) ? this.durationFramesWidget.value : 24, 10);
  }

  getFrameRate() {
    return parseInt((this.frameRateWidget && this.frameRateWidget.value > 0) ? this.frameRateWidget.value : 24, 10);
  }

  getTrackY(track) {
    if (track === "prompt") return RULER_HEIGHT + this.blockHeight;
    if (track === "camera") return RULER_HEIGHT + this.blockHeight + PROMPT_TRACK_HEIGHT;
    if (track === "control") return RULER_HEIGHT + this.blockHeight + PROMPT_TRACK_HEIGHT + this.cameraTrackHeight;
    if (track === "audio") return RULER_HEIGHT + this.blockHeight + PROMPT_TRACK_HEIGHT + this.cameraTrackHeight + this.controlTrackHeight;
    return RULER_HEIGHT;
  }

  getTrackHeight(track) {
    if (track === "prompt") return PROMPT_TRACK_HEIGHT;
    if (track === "camera") return this.cameraTrackHeight;
    if (track === "control") return this.controlTrackHeight;
    if (track === "audio") return this.audioTrackHeight;
    return this.blockHeight;
  }

  getTrackCenterY(track) {
    return this.getTrackY(track) + this.getTrackHeight(track) / 2;
  }

  getTrackTypeAtY(y) {
    if (y < RULER_HEIGHT || y > this.canvasHeight) return null;
    if (y <= RULER_HEIGHT + this.blockHeight) return "image";
    if (y <= RULER_HEIGHT + this.blockHeight + PROMPT_TRACK_HEIGHT) return "prompt";
    if (y <= RULER_HEIGHT + this.blockHeight + PROMPT_TRACK_HEIGHT + this.cameraTrackHeight) return "camera";
    if (y <= RULER_HEIGHT + this.blockHeight + PROMPT_TRACK_HEIGHT + this.cameraTrackHeight + this.controlTrackHeight) return "control";
    return "audio";
  }

  getTrackArray(track) {
    if (track === "cut") return this.timeline.cutSegments || [];
    if (track === "audio") return this.timeline.audioSegments;
    if (track === "control") return this.timeline.controlSegments;
    if (track === "camera") return this.timeline.cameraSegments;
    if (track === "prompt") return this.timeline.promptSegments;
    return this.timeline.segments;
  }

  setTrackArray(track, arr) {
    if (track === "cut") this.timeline.cutSegments = arr;
    else if (track === "audio") this.timeline.audioSegments = arr;
    else if (track === "control") this.timeline.controlSegments = arr;
    else if (track === "camera") this.timeline.cameraSegments = arr;
    else if (track === "prompt") this.timeline.promptSegments = arr;
    else this.timeline.segments = arr;
  }

  clearMultiSelection() {
    this.multiSelection = [];
  }

  isMultiSelected(track, id) {
    return (this.multiSelection || []).some((item) => item.track === track && item.id === id);
  }

  isSegmentSelected(track, id, primaryId = null) {
    return id === primaryId || this.isMultiSelected(track, id);
  }

  // Grow the timeline duration to fit `requiredFrames` if it is currently shorter.
  // The timeline only ever grows — never shrinks — through this method.
  growTimelineIfNeeded(requiredFrames) {
    const current = this.getDurationFrames();
    if (requiredFrames <= current) return; // already big enough

    const newFrames = Math.ceil(requiredFrames);
    if (this.durationFramesWidget) {
      this.durationFramesWidget.value = newFrames;
    }
    if (this.durationSecondsWidget) {
      this.durationSecondsWidget.value = parseFloat((newFrames / this.getFrameRate()).toFixed(3));
    }
    // Notify ComfyUI that the widget value changed so it serialises correctly.
    if (window.app && window.app.graph) {
      window.app.graph.setDirtyCanvas(true, true);
    }
  }

  // Returns the maximum allowed zoom level, computed so that at max zoom
  // the viewport shows exactly 4 seconds of the visual timeline.
  getMaxZoom() {
    const visualDurationSecs = this.getVisualDurationFrames() / this.getFrameRate();
    const baseMaxZoom = Math.max(1, visualDurationSecs / 4);

    // Limit max zoom to prevent canvas width from exceeding browser limits (causing crash)
    const viewportWidth = this.viewport ? this.viewport.clientWidth : 1000;
    const MAX_CANVAS_WIDTH = 32768; // Extended limit for modern browsers
    const limitMaxZoom = MAX_CANVAS_WIDTH / Math.max(1, viewportWidth);

    return Math.max(1, Math.min(baseMaxZoom, limitMaxZoom));
  }

  // Returns the visual timeline length in frames:
  // the furthest segment end (across both tracks) × 1.30, with a floor of getDurationFrames().
  // This is used for all rendering/positioning — the actual output duration is getDurationFrames().
  getVisualDurationFrames() {
    let furthest = 0;
    for (const seg of this.timeline.segments) {
      furthest = Math.max(furthest, seg.start + seg.length);
    }
    for (const seg of this.timeline.promptSegments) {
      furthest = Math.max(furthest, seg.start + seg.length);
    }
    for (const seg of this.timeline.audioSegments) {
      furthest = Math.max(furthest, seg.start + seg.length);
    }
    for (const seg of this.timeline.cameraSegments) {
      furthest = Math.max(furthest, seg.start + seg.length);
    }
    for (const seg of this.timeline.controlSegments) {
      furthest = Math.max(furthest, seg.start + seg.length);
    }
    for (const seg of this.timeline.cutSegments || []) {
      furthest = Math.max(furthest, (seg.start ?? seg.frame ?? 0) + 1);
    }
    const outputDuration = this.getDurationFrames();
    if (furthest <= 0) return outputDuration;
    return Math.max(outputDuration, Math.ceil(furthest * 1.30));
  }

  getLongAutoPlan() {
    const durationFrames = this.getDurationFrames();
    const frameRate = this.getFrameRate();
    const meta = this.timeline.meta || {};
    const rawMaxSegmentSeconds = Number(meta.maxSegmentSeconds);
    const maxSegmentSeconds = clamp(
      Number.isFinite(rawMaxSegmentSeconds) && rawMaxSegmentSeconds > 0 ? rawMaxSegmentSeconds : 15,
      3,
      60
    );
    const maxFrames = Math.max(1, Math.floor(maxSegmentSeconds * frameRate));
    const manualToleranceFrames = Math.max(0, Math.round((meta.manualCutToleranceSeconds ?? 0.25) * frameRate));
    const autoCut = meta.autoCut !== false;
    const manualFrames = [];
    const soft = new Map();
    const isNearManualCut = (frame) => manualFrames.some((cutFrame) => Math.abs(cutFrame - frame) <= manualToleranceFrames);
    const addSoftBoundary = (frame, reason) => {
      const f = clamp(Math.round(frame || 0), 0, durationFrames);
      if (f <= 0 || f >= durationFrames) return;
      if (isNearManualCut(f)) return;
      if (!soft.has(f)) soft.set(f, new Set());
      soft.get(f).add(reason);
    };
    for (const cut of this.timeline.cutSegments || []) {
      const frame = clamp(Math.round(cut.start ?? cut.frame ?? 0), 0, durationFrames);
      if (frame > 0 && frame < durationFrames) manualFrames.push(frame);
    }
    manualFrames.sort((a, b) => a - b);
    for (let i = manualFrames.length - 1; i > 0; i--) {
      if (manualFrames[i] === manualFrames[i - 1]) manualFrames.splice(i, 1);
    }
    if (autoCut) {
      for (const cam of this.timeline.cameraSegments || []) {
        addSoftBoundary(cam.start || 0, "camera_start");
        addSoftBoundary((cam.start || 0) + (cam.length || 0), "camera_end");
      }
      for (const ctrl of this.timeline.controlSegments || []) {
        addSoftBoundary(ctrl.start || 0, "ic_start");
        addSoftBoundary((ctrl.start || 0) + (ctrl.length || 0), "ic_end");
      }
    }

    const cuts = new Map([[0, new Set(["timeline_start"])]]);
    const addCut = (frame, reasons) => {
      frame = clamp(Math.round(frame || 0), 0, durationFrames);
      if (frame <= 0 || frame > durationFrames) return;
      if (!cuts.has(frame)) cuts.set(frame, new Set());
      for (const r of reasons) cuts.get(frame).add(r);
    };

    for (const frame of manualFrames) addCut(frame, ["manual_cut"]);

    const manualPoints = [0, ...manualFrames, durationFrames];
    const softPoints = [...soft.keys()].sort((a, b) => a - b);
    for (let i = 0; i < manualPoints.length - 1; i++) {
      let cursor = manualPoints[i];
      const right = manualPoints[i + 1];
      const localSoftPoints = softPoints.filter(frame => frame > cursor && frame < right);
      while (right - cursor > maxFrames) {
        const candidates = localSoftPoints.filter(frame => frame > cursor);
        let lastWithin = null;
        for (const frame of candidates) {
          if (frame - cursor <= maxFrames) lastWithin = frame;
          else break;
        }

        let nextCut = null;
        let reasons = null;
        if (lastWithin !== null) {
          nextCut = lastWithin;
          reasons = soft.get(nextCut) || new Set(["auto_boundary"]);
        } else {
          const remaining = right - cursor;
          const offset = remaining < maxFrames * 2
            ? Math.max(1, Math.min(remaining - 1, Math.round(remaining * 2 / 3)))
            : maxFrames;
          nextCut = cursor + offset;
          reasons = new Set([remaining < maxFrames * 2 ? "max_length_balanced" : "max_length"]);
        }

        if (!nextCut || nextCut <= cursor || nextCut >= right) break;
        addCut(nextCut, reasons);
        cursor = nextCut;
      }
    }
    addCut(durationFrames, ["timeline_end"]);

    const ordered = [...cuts.keys()].sort((a, b) => a - b);
    const plan = [];
    for (let i = 0; i < ordered.length - 1; i++) {
      const start = ordered[i];
      const end = ordered[i + 1];
      if (end <= start) continue;
      plan.push({
        index: plan.length,
        start,
        end,
        length: end - start,
        reasons: [...(cuts.get(start) || [])],
      });
    }
    return plan;
  }

  async queueCurrentGraphPrompt() {
    if (typeof window.shezwApplyGlobalPrefixToGraph === "function") {
      window.shezwApplyGlobalPrefixToGraph();
    }
    if (app?.graphToPrompt && api) {
      const prompt = await app.graphToPrompt();
      const resp = await api.fetchApi("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: api.clientId,
          prompt: prompt.output,
          extra_data: {
            extra_pnginfo: { workflow: prompt.workflow },
            shezw_long_auto_segment: true,
            shezw_cleanup_after_prompt: true,
            shezw_unload_models_after_prompt: true,
          },
        }),
      });
      const data = await resp.json();
      if (data?.node_errors && Object.keys(data.node_errors).length) {
        throw new Error(`ComfyUI rejected the prompt: ${JSON.stringify(data.node_errors)}`);
      }
      const promptId = data?.prompt_id || data?.promptId || data?.id;
      if (promptId) return String(promptId);
      throw new Error(`ComfyUI did not return a prompt_id: ${JSON.stringify(data)}`);
    }

    const queueFn = app?.__shezwOriginalQueuePrompt || app?.queuePrompt;
    if (typeof queueFn === "function") {
      try {
        return await queueFn.call(app, 0, 1);
      } catch (err) {
        try {
          return await queueFn.call(app, 0);
        } catch (_err) {
          throw err;
        }
      }
    }
    throw new Error("ComfyUI queuePrompt API is unavailable in this frontend build.");
  }

  async cleanupPromptAfterSegment(promptId, waitSeconds = 2) {
    if (!promptId || !api?.fetchApi) return;
    const payload = {
      prompt_id: String(promptId),
      wait_seconds: waitSeconds,
      unload_models: true,
    };
    const endpoints = ["/shezw/prompt/cleanup", "/shezw/upscale/cleanup"];
    for (const endpoint of endpoints) {
      try {
        const resp = await api.fetchApi(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (resp.ok) return;
        if (resp.status !== 404 || endpoint === endpoints[endpoints.length - 1]) {
          console.warn("[Shezw LongAuto] Prompt cleanup endpoint failed", endpoint, resp.status, await resp.text());
          return;
        }
      } catch (err) {
        if (endpoint === endpoints[endpoints.length - 1]) {
          console.warn("[Shezw LongAuto] Prompt cleanup request failed", err);
        }
      }
    }
  }

  async waitForPromptHistory(promptId, timeoutMs = 1000 * 60 * 60 * 6) {
    if (!promptId || typeof promptId !== "string") return null;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const resp = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
      if (resp.ok) {
        const data = await resp.json();
        const item = data?.[promptId] || data;
        if (item?.status?.status_str === "error") {
          throw new Error(`ComfyUI prompt ${promptId} failed.`);
        }
        if (item?.outputs && Object.keys(item.outputs).length) return item;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Timed out waiting for ComfyUI prompt ${promptId} to finish.`);
  }

  getTailSaveNodeIds() {
    const nodes = app?.graph?._nodes || [];
    return nodes
      .filter((node) => this.isTailSaveNode(node))
      .map((node) => String(node.id));
  }

  isTailSaveNode(node) {
    if (!node) return false;
    const type = `${node.type || ""}`.toLowerCase();
    const title = `${node.title || ""}`.toLowerCase();
    const widgets = node.widgets || [];
    const prefixWidget = widgets.find((w) => w.name === "filename_prefix") || widgets[0];
    const prefix = `${prefixWidget?.value || ""}`.replace(/\\/g, "/").toLowerCase();
    const isSaveNode = type.includes("save") || title.includes("save");
    const hasTailPrefix = prefix.includes("tail-frame") || prefix.includes("tail_frame") || prefix.includes("last-frame") || prefix.includes("last_frame");
    const hasTailTitle = title.includes("save last frame") || title.includes("tail frame");
    return isSaveNode && (hasTailPrefix || hasTailTitle);
  }

  getTailSavePrefix() {
    const nodes = app?.graph?._nodes || [];
    const node = nodes.find((candidate) => this.isTailSaveNode(candidate));
    const prefixWidget = node?.widgets?.find((w) => w.name === "filename_prefix") || node?.widgets?.[0];
    if (prefixWidget?.value) return `${prefixWidget.value}`.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const configuredPrefix = this.timeline?.meta?.tailFramePrefix;
    if (typeof configuredPrefix === "string" && configuredPrefix.trim()) {
      return configuredPrefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    }
    return "video/ltx-director-pro-tail-frame";
  }

  getSegmentVideoPrefix() {
    const nodes = app?.graph?._nodes || [];
    const node = nodes.find((candidate) => {
      const title = `${candidate?.title || ""}`.toLowerCase();
      const type = `${candidate?.type || ""}`.toLowerCase();
      return (type.includes("save") || title.includes("save")) && (title.includes("segment video") || title.includes("director-pro video"));
    });
    const prefixWidget = node?.widgets?.find((w) => w.name === "filename_prefix") || node?.widgets?.[0];
    if (prefixWidget?.value) return `${prefixWidget.value}`.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const configuredPrefix = this.timeline?.meta?.segmentVideoPrefix;
    if (typeof configuredPrefix === "string" && configuredPrefix.trim()) {
      return configuredPrefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    }
    return "video/ltx-director-pro-segment";
  }

  async fetchLatestTailFrame(sinceSeconds = 0, retryDelays = [0, 5000, 10000]) {
    const prefix = this.getTailSavePrefix();
    const delays = Array.isArray(retryDelays) && retryDelays.length ? retryDelays : [0, 5000, 10000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      const delay = Math.max(0, Number(delays[attempt]) || 0);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const params = new URLSearchParams({ prefix });
      if (sinceSeconds) params.set("since", String(Math.max(0, sinceSeconds)));
      const resp = await api.fetchApi(`/shezw/long_auto/latest_tail_frame?${params.toString()}`);
      if (!resp.ok) {
        console.warn("[Shezw LongAuto] Latest tail-frame lookup failed", resp.status, await resp.text());
        return null;
      }
      const data = await resp.json();
      if (data?.found && data?.imageFile) {
        return {
          imageFile: data.imageFile,
          imageType: data.type || "output",
          subfolder: data.subfolder || "",
          guideStrength: 1.0,
        };
      }
      console.warn("[Shezw LongAuto] Tail-frame lookup did not find a file.", {
        attempt: attempt + 1,
        attempts: delays.length,
        nextDelayMs: delays[attempt + 1] || 0,
        prefix,
      });
    }
    return null;
  }

  extractTailFrameFromHistory(history) {
    const outputs = history?.outputs || {};
    const preferred = new Set(this.getTailSaveNodeIds());
    const orderedIds = [
      ...Object.keys(outputs).filter((id) => preferred.has(String(id))),
      ...Object.keys(outputs).filter((id) => !preferred.has(String(id))),
    ];

    const imageExtRE = /\.(png|jpg|jpeg|webp)$/i;
    const normalizeTailString = (value) => {
      if (typeof value !== "string") return null;
      let text = value.trim();
      if (!text || !imageExtRE.test(text)) return null;
      text = text.replace(/\\/g, "/");
      const typeMatch = text.match(/^(input|output|temp)\/(.+)$/i);
      const pathText = typeMatch ? typeMatch[2] : text;
      const slashIdx = pathText.lastIndexOf("/");
      return {
        imageFile: slashIdx >= 0 ? pathText.slice(slashIdx + 1) : pathText,
        imageType: typeMatch ? typeMatch[1].toLowerCase() : "output",
        subfolder: slashIdx >= 0 ? pathText.slice(0, slashIdx) : "",
        guideStrength: 1.0,
      };
    };
    const collectStrings = (value, out = []) => {
      if (typeof value === "string") {
        out.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, out);
      } else if (value && typeof value === "object") {
        for (const item of Object.values(value)) collectStrings(item, out);
      }
      return out;
    };

    for (const id of orderedIds) {
      const nodeOutput = outputs[id] || {};
      const images = [
        ...(nodeOutput.images || []),
        ...(nodeOutput.ui?.images || []),
      ];
      for (const image of images) {
        const filename = image?.filename || "";
        if (!filename) continue;
        const haystack = `${filename} ${image?.subfolder || ""} ${id}`.toLowerCase();
        if (preferred.has(String(id)) || haystack.includes("tail") || haystack.includes("last")) {
          return {
            imageFile: filename,
            imageType: image?.type || "output",
            subfolder: image?.subfolder || "",
            guideStrength: 1.0,
          };
        }
      }

      const strings = collectStrings({
        filename: nodeOutput.filename,
        filenames: nodeOutput.filenames,
        file: nodeOutput.file,
        files: nodeOutput.files,
        output: nodeOutput.output,
        text: nodeOutput.text,
      });
      for (const value of strings) {
        const haystack = `${value} ${id}`.toLowerCase();
        if (preferred.has(String(id)) || haystack.includes("tail") || haystack.includes("last")) {
          const tail = normalizeTailString(value);
          if (tail) return tail;
        }
      }
    }
    console.warn("[Shezw LongAuto] Tail frame not found in prompt history.", {
      preferredTailNodeIds: [...preferred],
      outputKeys: Object.keys(outputs),
      outputShapes: Object.fromEntries(Object.entries(outputs).map(([id, value]) => [id, Object.keys(value || {})])),
    });
    return null;
  }

  extractSegmentVideoFromHistory(history) {
    const outputs = history?.outputs || {};
    const prefix = this.getSegmentVideoPrefix().toLowerCase();
    const videoExtRE = /\.(mp4|webm|mov|mkv)$/i;
    const normalizeVideo = (value, fallback = {}) => {
      if (!value) return null;
      let filename = "";
      let type = fallback.type || "output";
      let subfolder = fallback.subfolder || "";
      if (typeof value === "string") {
        const text = value.trim().replace(/\\/g, "/");
        if (!videoExtRE.test(text)) return null;
        const typeMatch = text.match(/^(input|output|temp)\/(.+)$/i);
        const pathText = typeMatch ? typeMatch[2] : text;
        const slashIdx = pathText.lastIndexOf("/");
        filename = slashIdx >= 0 ? pathText.slice(slashIdx + 1) : pathText;
        subfolder = slashIdx >= 0 ? pathText.slice(0, slashIdx) : subfolder;
        type = typeMatch ? typeMatch[1].toLowerCase() : type;
      } else if (typeof value === "object") {
        filename = value.filename || value.file || value.name || "";
        type = value.type || type;
        subfolder = value.subfolder || subfolder;
      }
      if (!filename || !videoExtRE.test(filename)) return null;
      return { videoFile: filename, videoType: type, subfolder };
    };
    const collect = (value, out = []) => {
      if (typeof value === "string") {
        out.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) collect(item, out);
      } else if (value && typeof value === "object") {
        out.push(value);
        for (const item of Object.values(value)) collect(item, out);
      }
      return out;
    };

    for (const nodeOutput of Object.values(outputs)) {
      const values = collect({
        videos: nodeOutput?.videos,
        gifs: nodeOutput?.gifs,
        files: nodeOutput?.files,
        ui: nodeOutput?.ui,
        filename: nodeOutput?.filename,
      });
      for (const value of values) {
        const video = normalizeVideo(value);
        if (!video) continue;
        const haystack = `${video.subfolder}/${video.videoFile}`.replace(/\\/g, "/").toLowerCase();
        if (!prefix || haystack.includes(prefix) || video.videoFile.toLowerCase().includes("segment")) {
          return video;
        }
      }
    }
    return null;
  }

  getLongAutoMemory() {
    if (!this.timeline.meta) this.timeline.meta = {};
    const currentPrefix = this.getCurrentGlobalPrefix();
    const mem = this.timeline.meta.longAutoMemory;
    if (!mem || typeof mem !== "object" || !mem.segments || typeof mem.segments !== "object") {
      this.timeline.meta.longAutoMemory = {
        schema: "shezw.long_auto.memory.v1",
        prefix: currentPrefix || "",
        segments: {},
        resetSegments: {},
      };
      return this.timeline.meta.longAutoMemory;
    }

    const memoryPrefix = `${mem.prefix || ""}`.trim();
    const inferredPrefix = this.inferLongAutoMemoryPrefix(mem);
    const effectivePrefix = memoryPrefix || inferredPrefix;
    if (currentPrefix && effectivePrefix && effectivePrefix !== currentPrefix) {
      this.timeline.meta.longAutoMemory = {
        schema: "shezw.long_auto.memory.v1",
        prefix: currentPrefix,
        segments: {},
        resetSegments: {},
        previousPrefix: effectivePrefix,
        resetAt: new Date().toISOString(),
      };
      return this.timeline.meta.longAutoMemory;
    }
    mem.prefix = currentPrefix || effectivePrefix || "";
    if (!mem.resetSegments || typeof mem.resetSegments !== "object") mem.resetSegments = {};
    return this.timeline.meta.longAutoMemory;
  }

  getCurrentGlobalPrefix() {
    if (typeof window.shezwGetGlobalPrefix === "function") return `${window.shezwGetGlobalPrefix() || ""}`.trim();
    return "";
  }

  inferLongAutoMemoryPrefix(memory) {
    for (const record of Object.values(memory?.segments || {})) {
      const subfolder = record?.video?.subfolder || record?.tailFrame?.subfolder || "";
      const match = `${subfolder}`.replace(/\\/g, "/").match(/(?:^|\/)video\/([^/]+)/);
      if (match?.[1]) return match[1];
    }
    return "";
  }

  applySettingWidgetValue(widget, value) {
    if (!widget) return;
    widget.value = value;
    if (widget.callback) {
      try {
        widget.callback(value, app.canvas, this.node, null, null);
      } catch (_) {
        // Keep Store reliable even if a third-party widget callback throws.
      }
    }
    if (app?.graph) app.graph.setDirtyCanvas(true, true);
  }

  flushSettingsInputs() {
    for (const binding of this._settingsInputBindings || []) {
      if (!binding?.input?.isConnected || !binding.widget) continue;
      if (!binding.dirty && document.activeElement !== binding.input) continue;
      let value = parseFloat(binding.input.value);
      if (!Number.isFinite(value)) value = binding.widget.value;
      value = clamp(value, binding.min, binding.max);
      value = binding.isFloat ? Number(value.toFixed(4)) : Math.round(value);
      binding.input.value = binding.isFloat ? value.toFixed(4) : String(value);
      binding.dirty = false;
      this.applySettingWidgetValue(binding.widget, value);
    }
  }

  prepareStoryScriptStore() {
    this.flushSettingsInputs();
    if (this.timeline.meta?.longAuto || this.timeline.meta?.longAutoMemory) this.getLongAutoMemory();
    this.commitChanges(true);
  }

  getStoryScriptWidgets() {
    this.prepareStoryScriptStore();
    const names = [
      "global_prompt",
      "duration_frames",
      "duration_seconds",
      "timeline_data",
      "local_prompts",
      "segment_lengths",
      "epsilon",
      "guide_strength",
      "use_custom_audio",
      "frame_rate",
      "display_mode",
      "custom_width",
      "custom_height",
      "resize_method",
      "divisible_by",
      "img_compression",
      "metadata",
    ];
    const widgets = {};
    for (const name of names) {
      const widget = this.node.widgets?.find((w) => w.name === name);
      if (widget) widgets[name] = widget.value;
    }
    if (widgets.duration_seconds === undefined) {
      widgets.duration_seconds = parseFloat((this.getDurationFrames() / this.getFrameRate()).toFixed(3));
    }
    if (widgets.duration_frames === undefined) widgets.duration_frames = this.getDurationFrames();
    if (widgets.frame_rate === undefined) widgets.frame_rate = this.getFrameRate();
    if (widgets.timeline_data === undefined && this.timelineDataWidget) widgets.timeline_data = this.timelineDataWidget.value;
    if (widgets.use_custom_audio === undefined) widgets.use_custom_audio = false;
    return widgets;
  }

  segmentMemoryKey(seg) {
    return `${Math.round(seg.start)}:${Math.round(seg.end)}:${(seg.reasons || []).join("+")}`;
  }

  getSegmentMemory(seg) {
    return this.getLongAutoMemory().segments[this.segmentMemoryKey(seg)] || null;
  }

  setSegmentMemory(seg, record) {
    const memory = this.getLongAutoMemory();
    const key = this.segmentMemoryKey(seg);
    memory.updatedAt = new Date().toISOString();
    delete memory.resetSegments?.[key];
    memory.segments[key] = {
      index: seg.index,
      start: seg.start,
      end: seg.end,
      reasons: [...(seg.reasons || [])],
      ...record,
    };
  }

  async persistStoryScriptState(reason = "long_auto_update") {
    if (typeof window.shezwStoreCurrentStoryScript !== "function") return null;
    try {
      const result = await window.shezwStoreCurrentStoryScript("");
      console.info("[Shezw LongAuto] Stored story script", { reason, filename: result?.filename });
      return result;
    } catch (err) {
      console.warn("[Shezw LongAuto] Story script auto-store failed", { reason, err });
      return null;
    }
  }

  async reconcileLongAutoMemoryFromPrefix() {
    if (!this.timeline.meta?.longAuto) return false;
    const prefix = this.getCurrentGlobalPrefix();
    if (!prefix || this._lastPrefixAnalysis === prefix) return false;
    this._lastPrefixAnalysis = prefix;

    const plan = this.getLongAutoPlan();
    if (!plan.length || !api?.fetchApi) return false;

    const resp = await api.fetchApi(`/shezw/long_auto/prefix_outputs?${new URLSearchParams({ prefix }).toString()}`);
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    if (!data?.ok) throw new Error(data?.error || "Prefix output analysis failed");

    const tails = Array.isArray(data.tail_frames) ? data.tail_frames : [];
    const videos = Array.isArray(data.segment_videos) ? data.segment_videos : [];
    if (!tails.length && !videos.length) return false;

    const memory = this.getLongAutoMemory();
    let changed = false;
    const count = Math.min(plan.length, Math.max(tails.length, videos.length));
    for (let index = 0; index < count; index += 1) {
      const seg = plan[index];
      const key = this.segmentMemoryKey(seg);
      const existing = memory.segments[key];
      const reset = memory.resetSegments?.[key];
      if (reset && (!reset.prefix || reset.prefix === prefix)) continue;
      if (existing?.tailFrame && existing?.video) continue;

      const tail = tails[index];
      const video = videos[index];
      const record = {
        ...(existing || {}),
        status: "done",
        recoveredFromPrefix: true,
        recoveredAt: new Date().toISOString(),
      };
      if (tail && !record.tailFrame) {
        record.tailFrame = {
          imageFile: tail.filename,
          imageType: tail.type || "output",
          subfolder: tail.subfolder || "",
          guideStrength: 1.0,
        };
      }
      if (video && !record.video) {
        record.video = {
          videoFile: video.filename,
          videoType: video.type || "output",
          subfolder: video.subfolder || "",
        };
      }
      if (!record.tailFrame && !record.video) continue;
      memory.segments[key] = {
        index: seg.index,
        start: seg.start,
        end: seg.end,
        reasons: [...(seg.reasons || [])],
        ...record,
      };
      changed = true;
    }

    if (changed) {
      memory.updatedAt = new Date().toISOString();
      this.commitChanges();
      await this.persistStoryScriptState("prefix_output_analysis");
      this.updateLongAutoUI();
    }
    return changed;
  }

  resetSegmentMemory(seg) {
    const memory = this.getLongAutoMemory();
    const key = this.segmentMemoryKey(seg);
    delete memory.segments[key];
    if (!memory.resetSegments || typeof memory.resetSegments !== "object") memory.resetSegments = {};
    memory.resetSegments[key] = {
      prefix: this.getCurrentGlobalPrefix(),
      resetAt: new Date().toISOString(),
    };
    memory.updatedAt = new Date().toISOString();
    this.commitChanges();
    this.persistStoryScriptState("long_auto_memory_reset");
    this.render();
  }

  findPreviousCompletedTail(plan, startIndex) {
    for (let i = startIndex - 1; i >= 0; i--) {
      const record = this.getSegmentMemory(plan[i]);
      if (record?.tailFrame) return record.tailFrame;
    }
    return null;
  }

  updateLongAutoUI() {
    if (!this.queueAllCutsBtn) return;
    const isLongAuto = !!(this.timeline.meta && this.timeline.meta.longAuto);
    this.queueAllCutsBtn.style.display = isLongAuto ? "" : "none";
    if (this.autoCutBtn) {
      this.autoCutBtn.style.display = isLongAuto ? "" : "none";
      const isAutoCutOn = this.timeline.meta?.autoCut !== false;
      this.autoCutBtn.classList.toggle("active", isAutoCutOn);
      this.autoCutBtn.innerHTML = `${ICONS.toggle} ${t("autoCut")}: ${isAutoCutOn ? t("on") : t("off")}`;
      this.autoCutBtn.title = isAutoCutOn
        ? t("autoCutOnTitle")
        : t("autoCutOffTitle");
    }
    if (this._isQueueingAllCuts) {
      this.queueAllCutsBtn.disabled = true;
      this.queueAllCutsBtn.innerHTML = `${ICONS.fan} ${t("rendering")}`;
    } else {
      this.queueAllCutsBtn.disabled = false;
      this.queueAllCutsBtn.innerHTML = `${ICONS.fan} ${t("queueAll")}`;
    }
    this.queueAllCutsBtn.title = t("queueAllTitle");
  }

  refreshLanguage() {
    if (this.langEls) {
      this.langEls.uploadBtn.innerHTML = `${ICONS.bolt} ${t("keyframe")}`;
      this.langEls.uploadReferenceBtn.innerHTML = `${ICONS.image} ${t("ref")}`;
      this.langEls.uploadAudioBtn.innerHTML = `${ICONS.audio} ${t("audio")}`;
      this.langEls.addTextBtn.innerHTML = `${ICONS.text} ${t("localPrompt")}`;
      this.langEls.addCameraBtn.innerHTML = `${ICONS.camera} ${t("camera")}`;
      this.langEls.addControlBtn.innerHTML = `${ICONS.video} ${t("icControl")}`;
      this.langEls.addCutBtn.innerHTML = `${ICONS.scissors} ${t("cut")}`;
      this.langEls.deleteBtn.innerHTML = `${ICONS.trash} ${t("delete")}`;
      this.langEls.settingsBtn.title = t("settings");
      this.langEls.segmentsBtn.innerHTML = `${ICONS.list} ${t("showHideSegments")}`;
      this.langEls.segmentsBtn.title = t("showHideSegmentsTitle");
      this.langEls.helpBtn.title = t("help");
    }
    this.updateLongAutoUI();
    this.updateUIFromSelection();
    this.renderReferenceChannel();
    const anchor = this._settingsAnchorEl;
    const wasSegmentsMenu = !!this._segmentsMenuOpen;
    if (this._settingsMenu && anchor) {
      this.dismissSettingsMenu();
      if (wasSegmentsMenu) this.showSegmentsMenu(anchor);
      else this.showSettingsMenu(anchor);
    }
    this.render();
  }

  async queueAllCutSegments(options = {}) {
    if (this._isQueueingAllCuts) return;
    const plan = this.getLongAutoPlan();
    if (!plan.length) return;

    if (!this.timeline.meta) this.timeline.meta = {};
    const startIndex = clamp(parseInt(options.startIndex ?? 0, 10) || 0, 0, Math.max(0, plan.length - 1));
    const skipCompleted = options.skipCompleted !== false;
    const stopAfterOne = !!options.stopAfterOne;
    const originalMeta = { ...this.timeline.meta };
    let previousTailFrame = originalMeta.previousTailFrame || this.findPreviousCompletedTail(plan, startIndex);
    this._isQueueingAllCuts = true;
    this.updateLongAutoUI();

    try {
      for (const seg of plan.slice(startIndex)) {
        const existingRecord = this.getSegmentMemory(seg);
        if (skipCompleted && existingRecord?.tailFrame) {
          previousTailFrame = existingRecord.tailFrame;
          continue;
        }
        this.timeline.meta.activeSegmentIndex = seg.index;
        if (seg.index > 0 && previousTailFrame) {
          this.timeline.meta.previousTailFrame = previousTailFrame;
        } else {
          delete this.timeline.meta.previousTailFrame;
        }
        this.commitChanges(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const queuedAtSeconds = Date.now() / 1000;
        let promptId = null;
        try {
          promptId = await this.queueCurrentGraphPrompt();
          const history = await this.waitForPromptHistory(promptId);
          const tailFrame = this.extractTailFrameFromHistory(history) || await this.fetchLatestTailFrame(queuedAtSeconds);
          const segmentVideo = this.extractSegmentVideoFromHistory(history);
          if (!tailFrame && seg.index < plan.length - 1) {
            throw new Error(`Segment ${seg.index} finished without a tail-frame PNG; stopped before queuing the next segment.`);
          }
          if (tailFrame) previousTailFrame = tailFrame;
          this.setSegmentMemory(seg, {
            status: "done",
            promptId,
            queuedAtSeconds,
            completedAt: new Date().toISOString(),
            tailFrame,
            video: segmentVideo,
          });
          this.commitChanges(true);
          await this.persistStoryScriptState("long_auto_segment_done");
          await this.cleanupPromptAfterSegment(promptId, 2);
        } catch (err) {
          if (promptId) await this.cleanupPromptAfterSegment(promptId, 2);
          throw err;
        }
        if (stopAfterOne) break;
      }
    } catch (err) {
      console.error("[Shezw LongAuto] Failed to queue all cuts", err);
      throw err;
    } finally {
      const rememberedMemory = this.timeline.meta?.longAutoMemory;
      this.timeline.meta = { ...originalMeta };
      if (rememberedMemory) this.timeline.meta.longAutoMemory = rememberedMemory;
      this._isQueueingAllCuts = false;
      this.commitChanges();
      await this.persistStoryScriptState("long_auto_queue_finished");
      this.updateLongAutoUI();
    }
  }

  // Sync the zoom slider's max attribute to the current getMaxZoom() value,
  // clamping zoomLevel if it now exceeds the new max.
  updateZoomSliderMax() {
    if (!this.zoomSlider) return;
    const maxZoom = this.getMaxZoom();
    this.zoomSlider.max = maxZoom.toFixed(2);
    if (this.zoomLevel > maxZoom) {
      this.zoomLevel = maxZoom;
      this.zoomSlider.value = maxZoom;
      // Resize the canvas to match the clamped zoom
      const viewportWidth = this.viewport ? this.viewport.clientWidth : 0;
      if (viewportWidth > 0) {
        const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
        this.canvas.style.width = newCanvasWidth + "px";
        this.resizeCanvas(newCanvasWidth);
      }
    }
  }

  loadImages() {
    for (const seg of this.timeline.segments) {
      if (seg.imageB64 && !seg.imgObj) {
        seg.imgObj = new Image();
        seg.imgObj.onload = () => this.render();
        seg.imgObj.src = seg.imageB64;
      }
    }
    this.loadReferences();
  }

  loadReferences() {
    for (const seg of this.timeline.referenceImages || []) {
      if (seg.imageB64 && !seg.imgObj) {
        seg.imgObj = new Image();
        seg.imgObj.onload = () => this.renderReferenceChannel();
        seg.imgObj.src = seg.imageB64;
      }
    }
  }

  createDOM() {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "pr-wrapper";

    this.wrapper.addEventListener("mouseenter", () => { this._isHovering = true; });
    this.wrapper.addEventListener("mouseleave", () => { this._isHovering = false; });

    this.handleKeyDown = (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : "";
      if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;

      if ((e.key === "Delete" || e.key === "Backspace") && this.selectedIndex !== -1 && this._isHovering) {
        this.deleteSelectedSegment();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === " " || e.code === "Space") && this._isHovering) {
        this.togglePlay();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", this.handleKeyDown, true);

    this.handlePaste = (e) => {
      if (this._isHovering) {
        const activeTag = document.activeElement ? document.activeElement.tagName : "";
        if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;

        if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
          const imageFiles = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
          if (imageFiles.length > 0) {
            this.handleImageUpload(imageFiles, this.currentFrame);
            e.preventDefault();
            e.stopPropagation();
          }
        }
      }
    };
    window.addEventListener("paste", this.handlePaste, true);

    // --- Toolbar ---
    const toolbar = document.createElement("div");
    toolbar.className = "pr-toolbar";

    const actionGroup = document.createElement("div");
    actionGroup.className = "pr-actions";

    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "image/*";
    this.fileInput.multiple = true;
    this.fileInput.style.display = "none";
    this.fileInput.addEventListener("change", (e) => this.handleImageUpload(e.target.files));

    this.referenceFileInput = document.createElement("input");
    this.referenceFileInput.type = "file";
    this.referenceFileInput.accept = "image/*";
    this.referenceFileInput.multiple = true;
    this.referenceFileInput.style.display = "none";
    this.referenceFileInput.addEventListener("change", (e) => this.handleReferenceUpload(e.target.files));

    this.audioFileInput = document.createElement("input");
    this.audioFileInput.type = "file";
    this.audioFileInput.accept = "audio/*";
    this.audioFileInput.multiple = true;
    this.audioFileInput.style.display = "none";
    this.audioFileInput.addEventListener("change", (e) => this.handleAudioUpload(e.target.files));

    const uploadBtn = document.createElement("button");
    uploadBtn.className = "pr-btn";
    uploadBtn.innerHTML = `${ICONS.bolt} ${t("keyframe")}`;
    uploadBtn.addEventListener("click", () => this.fileInput.click());

    const uploadReferenceBtn = document.createElement("button");
    uploadReferenceBtn.className = "pr-btn";
    uploadReferenceBtn.innerHTML = `${ICONS.image} ${t("ref")}`;
    uploadReferenceBtn.addEventListener("click", () => this.referenceFileInput.click());

    const uploadAudioBtn = document.createElement("button");
    uploadAudioBtn.className = "pr-btn";
    uploadAudioBtn.innerHTML = `${ICONS.audio} ${t("audio")}`;
    uploadAudioBtn.addEventListener("click", () => this.audioFileInput.click());

    const addTextBtn = document.createElement("button");
    addTextBtn.className = "pr-btn";
    addTextBtn.innerHTML = `${ICONS.text} ${t("localPrompt")}`;
    addTextBtn.addEventListener("click", () => this.addTextSegmentFreeSpace());

    const addCameraBtn = document.createElement("button");
    addCameraBtn.className = "pr-btn";
    addCameraBtn.innerHTML = `${ICONS.camera} ${t("camera")}`;
    addCameraBtn.addEventListener("click", () => this.addCameraSegmentFreeSpace());

    const addControlBtn = document.createElement("button");
    addControlBtn.className = "pr-btn";
    addControlBtn.innerHTML = `${ICONS.video} ${t("icControl")}`;
    addControlBtn.addEventListener("click", () => this.addControlSegmentFreeSpace());

    this.autoCutBtn = document.createElement("button");
    this.autoCutBtn.className = "pr-btn";
    this.autoCutBtn.style.display = "none";
    this.autoCutBtn.innerHTML = `${ICONS.toggle} ${t("autoCut")}: ${t("on")}`;
    this.autoCutBtn.title = t("autoCutOnTitle");
    this.autoCutBtn.addEventListener("click", () => {
      if (!this.timeline.meta) this.timeline.meta = {};
      this.timeline.meta.autoCut = this.timeline.meta.autoCut === false;
      this.commitChanges();
      this.render();
    });

    this.queueAllCutsBtn = document.createElement("button");
    this.queueAllCutsBtn.className = "pr-btn";
    this.queueAllCutsBtn.innerHTML = `${ICONS.fan} ${t("queueAll")}`;
    this.queueAllCutsBtn.title = t("queueAllTitle");
    this.queueAllCutsBtn.style.display = "none";
    this.queueAllCutsBtn.addEventListener("click", () => this.queueAllCutSegments());

    const addCutBtn = document.createElement("button");
    addCutBtn.className = "pr-btn";
    addCutBtn.innerHTML = `${ICONS.scissors} ${t("cut")}`;
    addCutBtn.title = "Add a manual long-auto split point at the playhead";
    addCutBtn.addEventListener("click", () => this.addCutAtFrame(this.currentFrame));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "pr-btn pr-btn-danger";
    deleteBtn.innerHTML = `${ICONS.trash} ${t("delete")}`;
    deleteBtn.addEventListener("click", () => this.deleteSelectedSegment());
    this.langEls = {
      uploadBtn,
      uploadReferenceBtn,
      uploadAudioBtn,
      addTextBtn,
      addCameraBtn,
      addControlBtn,
      addCutBtn,
      deleteBtn,
    };

    actionGroup.appendChild(this.fileInput);
    actionGroup.appendChild(this.referenceFileInput);
    actionGroup.appendChild(this.audioFileInput);
    actionGroup.appendChild(uploadAudioBtn);
    actionGroup.appendChild(uploadBtn);
    actionGroup.appendChild(uploadReferenceBtn);
    actionGroup.appendChild(addTextBtn);
    actionGroup.appendChild(addCameraBtn);
    actionGroup.appendChild(addCutBtn);
    actionGroup.appendChild(addControlBtn);
    actionGroup.appendChild(deleteBtn);
    toolbar.appendChild(actionGroup);

    const rightGroup = document.createElement("div");
    rightGroup.className = "pr-right-group";

    this.segmentBoundsDisplay = document.createElement("div");
    this.segmentBoundsDisplay.className = "pr-segment-bounds";
    this.segmentBoundsDisplay.textContent = `${t("start")}: - | ${t("end")}: -`;

    this.timeCodeDisplay = document.createElement("div");
    this.timeCodeDisplay.className = "pr-timecode";
    this.timeCodeDisplay.textContent = this.formatTime(0);

    const settingsBtn = document.createElement("button");
    settingsBtn.className = "pr-btn";
    settingsBtn.style.padding = "6px";
    settingsBtn.style.justifyContent = "center";
    settingsBtn.style.width = "28px";
    settingsBtn.style.height = "28px";
    settingsBtn.style.boxSizing = "border-box";
    settingsBtn.innerHTML = ICONS.gear;
    settingsBtn.title = t("settings");
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this._settingsMenu && !this._segmentsMenuOpen) {
        this.dismissSettingsMenu();
      } else {
        this.showSettingsMenu(settingsBtn);
      }
    });

    const segmentsBtn = document.createElement("button");
    segmentsBtn.className = "pr-btn";
    segmentsBtn.style.padding = "6px 8px";
    segmentsBtn.style.height = "28px";
    segmentsBtn.style.boxSizing = "border-box";
    segmentsBtn.innerHTML = `${ICONS.list} ${t("showHideSegments")}`;
    segmentsBtn.title = t("showHideSegmentsTitle");
    segmentsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this._settingsMenu && this._segmentsMenuOpen) {
        this.dismissSettingsMenu();
      } else {
        this.showSegmentsMenu(segmentsBtn);
      }
    });

    const helpBtn = document.createElement("button");
    helpBtn.className = "pr-btn";
    helpBtn.style.padding = "6px";
    helpBtn.style.justifyContent = "center";
    helpBtn.style.width = "28px";
    helpBtn.style.height = "28px";
    helpBtn.style.boxSizing = "border-box";
    helpBtn.innerHTML = "?";
    helpBtn.title = t("help");
    helpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.open("https://github.com/shezw/ltx-director-pro/blob/adv-pro/README.pro.md", "_blank", "noopener,noreferrer");
    });

    const btnGroup = document.createElement("div");
    btnGroup.style.display = "flex";
    btnGroup.style.gap = "6px";
    btnGroup.style.alignItems = "center";
    btnGroup.appendChild(segmentsBtn);
    btnGroup.appendChild(this.queueAllCutsBtn);
    btnGroup.appendChild(this.autoCutBtn);
    btnGroup.appendChild(helpBtn);
    btnGroup.appendChild(settingsBtn);
    rightGroup.appendChild(btnGroup);
    Object.assign(this.langEls, { settingsBtn, segmentsBtn, helpBtn });

    toolbar.appendChild(rightGroup);

    // --- Canvas & Viewport ---
    this.viewport = document.createElement("div");
    this.viewport.className = "pr-timeline-viewport";

    this.viewport.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();

        let zoomDelta = e.deltaY > 0 ? -0.5 : 0.5;
        this.zoomLevel = Math.max(1, Math.min(this.getMaxZoom(), this.zoomLevel + zoomDelta));
        if (this.zoomSlider) this.zoomSlider.value = this.zoomLevel;

        const oldWidth = this.canvas.offsetWidth;
        const newWidth = this.viewport.clientWidth * this.zoomLevel;
        const mouseX = e.clientX - this.viewport.getBoundingClientRect().left;
        const scrollRatio = (this.viewport.scrollLeft + mouseX) / oldWidth;

        this.canvas.style.width = newWidth + "px";
        this.viewport.scrollLeft = scrollRatio * newWidth - mouseX;
      }
    }, { passive: false, capture: true });

    this.canvas = document.createElement("canvas");
    this.canvas.className = "pr-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.canvas.style.width = "100%";

    this.viewport.appendChild(this.canvas);

    this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.canvas.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.canvas.style.height = `${CANVAS_HEIGHT}px`;

    // --- Content Area Container ---
    const propContainer = document.createElement("div");
    propContainer.className = "pr-prop-container";

    // --- Text Area (Local Prompt/Camera/Reference) ---
    this.promptInput = document.createElement("textarea");
    this.promptInput.className = "pr-prompt-area";
    this.promptInput.placeholder = "Enter prompt for selected segment...";
    this.promptInput.addEventListener("input", () => {
      if (this.selectionType === "prompt" && this.timeline.promptSegments[this.selectedIndex]) {
        this.timeline.promptSegments[this.selectedIndex].prompt = this.promptInput.value;
        this.commitChanges();
      } else if (this.selectionType === "control" && this.timeline.controlSegments[this.selectedIndex]) {
        this.timeline.controlSegments[this.selectedIndex].prompt = this.promptInput.value;
        this.commitChanges();
      } else if (this.selectionType === "reference" && this.timeline.referenceImages[this.selectedIndex]) {
        this.timeline.referenceImages[this.selectedIndex].note = this.promptInput.value;
        this.commitChanges();
      }
    });

    this.cameraSelect = document.createElement("select");
    this.cameraSelect.className = "pr-camera-select";
    this.cameraSelect.style.display = "none";
    for (const preset of CAMERA_MOTION_PRESETS) {
      const option = document.createElement("option");
      option.value = preset.value;
      option.textContent = preset.label;
      this.cameraSelect.appendChild(option);
    }
    this.cameraSelect.addEventListener("change", () => {
      const seg = this.timeline.cameraSegments[this.selectedIndex];
      if (this.selectionType !== "camera" || !seg) return;
      seg.cameraMotion = this.cameraSelect.value;
      seg.prompt = cameraPromptForMotion(seg.cameraMotion);
      this.commitChanges();
    });

    // --- Audio Info Area ---
    this.audioInfoArea = document.createElement("div");
    this.audioInfoArea.className = "pr-audio-info";

    propContainer.appendChild(this.promptInput);
    propContainer.appendChild(this.cameraSelect);
    propContainer.appendChild(this.audioInfoArea);

    this.wrapper.addEventListener("dragover", (e) => {
      e.preventDefault();
      this.wrapper.classList.add("drag-active");

      const { x, y } = this.getMousePos(e);
      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      if (!logicalWidth || totalFrames <= 0) return;

      const hoveredTrack = this.getTrackTypeAtY(y);
      const isAudioTrack = hoveredTrack === "audio";
      const trackType = isAudioTrack ? "audio" : "image";
      const arrToModify = isAudioTrack ? this.timeline.audioSegments : this.timeline.segments;

      if (!this._ghostSegmentId || this._ghostTrack !== trackType) {
        this._ghostSegmentId = "GHOST_" + Date.now();
        this._ghostTrack = trackType;
        this._ghostInitialTimeline = JSON.parse(JSON.stringify(arrToModify));

        const frameRate = this.getFrameRate();
        const newLength = Math.max(1, frameRate * 1);

        let mouseFrameX = x * (totalFrames / logicalWidth);
        let startFrame = this.snapFrameToCut(Math.round(mouseFrameX - newLength / 2), { totalFrames });
        startFrame = clamp(startFrame, 0, totalFrames - newLength);

        this._ghostInitialTimeline.push({
          id: this._ghostSegmentId,
          start: startFrame,
          length: newLength,
          type: "ghost"
        });
      }

      let mouseFrameX = x * (totalFrames / logicalWidth);
      const ghost = this._ghostInitialTimeline.find(s => s.id === this._ghostSegmentId);
      let D_mouse_start = this.snapFrameToCut(mouseFrameX - ghost.length / 2, { totalFrames });

      this._previewSegments = this._applyCenterDragPhysics(
        this._ghostInitialTimeline,
        this._ghostSegmentId,
        D_mouse_start,
        mouseFrameX,
        totalFrames,
        totalFrames,
        logicalWidth
      );
      this.render();
    });

    this.wrapper.addEventListener("dragleave", (e) => {
      const rect = this.wrapper.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX >= rect.right ||
        e.clientY < rect.top || e.clientY >= rect.bottom) {
        this.wrapper.classList.remove("drag-active");
        this._ghostSegmentId = null;
        this._ghostTrack = null;
        this._ghostInitialTimeline = null;
        this._previewSegments = null;
        this.render();
      }
    });

    this.wrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.wrapper.classList.remove("drag-active");

      let targetFrameStart = null;
      let targetTrack = this._ghostTrack || "image";

      if (this._ghostSegmentId && this._previewSegments) {
        const ghost = this._previewSegments.find(s => s.id === this._ghostSegmentId);
        if (ghost) {
          targetFrameStart = ghost.resolvedStart !== undefined ? ghost.resolvedStart : ghost.start;
        }
      }
      this._ghostSegmentId = null;
      this._ghostTrack = null;
      this._ghostInitialTimeline = null;
      this._previewSegments = null;
      this.render();

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const imageFiles = [];
        const audioFiles = [];
        for (let file of e.dataTransfer.files) {
          if (file.type.startsWith("audio/")) audioFiles.push(file);
          if (file.type.startsWith("image/")) imageFiles.push(file);
        }

        // Let implicit intent handle mixing drops: use the track we hovered over
        // for the first type we process, or fallback.
        if (audioFiles.length > 0 && (targetTrack === "audio" || imageFiles.length === 0)) {
          this.handleAudioUpload(audioFiles, targetFrameStart);
        } else if (imageFiles.length > 0) {
          this.handleImageUpload(imageFiles, targetFrameStart);
        }
      }
    });

    window.addEventListener("mousemove", (e) => this.onMouseMove(e));
    window.addEventListener("mouseup", (e) => this.onMouseUp(e));

    // --- Player Controls ---
    const playerControls = document.createElement("div");
    playerControls.className = "pr-player-controls";

    this.playBtn = document.createElement("button");
    this.playBtn.className = "pr-icon-btn";
    this.playBtn.style.padding = "4px";
    this.playBtn.innerHTML = ICONS.play;
    this.playBtn.title = "Play/Pause Audio";
    this.playBtn.addEventListener("click", () => this.togglePlay());

    this.loopBtn = document.createElement("button");
    this.loopBtn.className = "pr-icon-btn";
    this.loopBtn.style.padding = "4px";
    this.loopBtn.innerHTML = ICONS.loop;
    this.loopBtn.title = "Toggle Loop";
    this.loopBtn.addEventListener("click", () => this.toggleLoop());

    this.seekBar = document.createElement("input");
    this.seekBar.type = "range";
    this.seekBar.className = "pr-seek-bar";
    this.seekBar.min = "0";
    this.seekBar.value = "0";
    this.seekBar.style.flex = "1"; // take up remaining space
    this.seekBar.addEventListener("input", (e) => {
      this.currentFrame = parseInt(e.target.value, 10);
      this.render();
      if (this.isPlaying) {
        this.playAudio();
      }
    });

    // --- Zoom Controls ---
    const zoomControls = document.createElement("div");
    zoomControls.className = "pr-zoom-controls";

    const zoomOutBtn = document.createElement("button");
    zoomOutBtn.className = "pr-icon-btn";
    zoomOutBtn.style.padding = "4px";
    zoomOutBtn.innerHTML = ICONS.minus;
    zoomOutBtn.title = "Zoom Out";
    zoomOutBtn.addEventListener("click", () => {
      const currentZoom = parseFloat(this.zoomSlider.value);
      this.zoomSlider.value = Math.max(1, currentZoom - 0.5);
      this.zoomSlider.dispatchEvent(new Event("input"));
    });

    this.zoomSlider = document.createElement("input");
    this.zoomSlider.type = "range";
    this.zoomSlider.className = "pr-zoom-slider";
    this.zoomSlider.min = "1";
    this.zoomSlider.max = "1"; // Updated dynamically via updateZoomSliderMax()
    this.zoomSlider.step = "0.1";
    this.zoomSlider.value = "1";
    this.zoomSlider.title = "Zoom Level";
    this.zoomSlider.addEventListener("input", (e) => {
      this.zoomLevel = parseFloat(e.target.value);

      const viewportWidth = this.viewport.clientWidth;
      const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);

      this.canvas.style.width = newCanvasWidth + "px";
      this.resizeCanvas(newCanvasWidth);
      this._lastWidth = viewportWidth;
      this._lastZoom = this.zoomLevel;

      // Keep playhead centered
      const totalFrames = this.getVisualDurationFrames();
      const playheadRatio = this.currentFrame / totalFrames;
      const newPlayheadX = playheadRatio * newCanvasWidth;
      this.viewport.scrollLeft = newPlayheadX - (viewportWidth / 2);
    });

    const zoomInBtn = document.createElement("button");
    zoomInBtn.className = "pr-icon-btn";
    zoomInBtn.style.padding = "4px";
    zoomInBtn.innerHTML = ICONS.plus;
    zoomInBtn.title = "Zoom In";
    zoomInBtn.addEventListener("click", () => {
      const currentZoom = parseFloat(this.zoomSlider.value);
      this.zoomSlider.value = Math.min(this.getMaxZoom(), currentZoom + 0.5);
      this.zoomSlider.dispatchEvent(new Event("input"));
    });

    const zoomFitBtn = document.createElement("button");
    zoomFitBtn.className = "pr-icon-btn";
    zoomFitBtn.style.padding = "4px";
    zoomFitBtn.style.marginLeft = "4px";
    zoomFitBtn.innerHTML = ICONS.fit;
    zoomFitBtn.title = "Zoom to Fit (show full timeline)";
    zoomFitBtn.addEventListener("click", () => {
      this.zoomLevel = 1;
      this.zoomSlider.value = 1;
      const viewportWidth = this.viewport.clientWidth;
      this.canvas.style.width = viewportWidth + "px";
      this.resizeCanvas(viewportWidth);
      this._lastWidth = viewportWidth;
      this._lastZoom = 1;
      this.viewport.scrollLeft = 0;
    });

    zoomControls.appendChild(zoomOutBtn);
    zoomControls.appendChild(this.zoomSlider);
    zoomControls.appendChild(zoomInBtn);
    zoomControls.appendChild(zoomFitBtn);

    playerControls.appendChild(this.playBtn);
    playerControls.appendChild(this.loopBtn);
    playerControls.appendChild(this.seekBar);
    playerControls.appendChild(zoomControls);



    // --- Guide Strength Slider ---
    this.strengthRow = document.createElement("div");
    this.strengthRow.className = "pr-strength-row";

    this.strengthLabel = document.createElement("span");
    this.strengthLabel.className = "pr-strength-label";
    this.strengthLabel.textContent = `${t("strength")}:`;

    this.strengthValue = document.createElement("input");
    this.strengthValue.type = "text";
    this.strengthValue.className = "pr-strength-input";
    this.strengthValue.value = "1.00";
    this.strengthValue.disabled = true;
    this.strengthValue.style.cursor = "ew-resize";

    // Dragging logic for guide strength
    let isDragging = false;
    let startX = 0;
    let startVal = 0;
    let hasMoved = false;

    this.strengthValue.addEventListener("mousedown", (e) => {
      if (this.strengthValue.disabled) return;
      startX = e.clientX;
      startVal = parseFloat(this.strengthValue.value) || 1.0;
      hasMoved = false;

      const onMouseMove = (moveEvent) => {
        const deltaX = moveEvent.clientX - startX;
        if (Math.abs(deltaX) > 3) {
          hasMoved = true;
          isDragging = true;
        }

        if (isDragging) {
          moveEvent.preventDefault();
          const sensitivity = 0.002;
          let newVal = startVal + deltaX * sensitivity;

          if (newVal < 0) newVal = 0;
          if (newVal > 1) newVal = 1;

          this.strengthValue.value = newVal.toFixed(2);
          this.updateStrengthVisual();

          if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
            const seg = this.timeline.segments[this.selectedIndex];
            seg.guideStrength = newVal;
            this.commitChanges();
          }
        }
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        if (!hasMoved) {
          this.strengthValue.focus();
          this.strengthValue.select();
        }
        isDragging = false;
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    this.strengthValue.addEventListener("change", (e) => {
      let val = parseFloat(e.target.value);
      if (isNaN(val)) val = 1;
      val = Math.max(0, Math.min(1, val));
      this.strengthValue.value = val.toFixed(2);
      this.updateStrengthVisual();
      if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
        const seg = this.timeline.segments[this.selectedIndex];
        seg.guideStrength = val;
        this.commitChanges();
      }
    });

    this.strengthRow.appendChild(this.timeCodeDisplay);
    this.strengthRow.appendChild(this.segmentBoundsDisplay);
    this.strengthRow.appendChild(this.strengthLabel);
    this.strengthRow.appendChild(this.strengthValue);


    this.referenceChannel = document.createElement("div");
    this.referenceChannel.className = "pr-reference-channel";
    this.wrapper.appendChild(this.referenceChannel);
    this.renderReferenceChannel();
    this.wrapper.appendChild(this.viewport);
    this.wrapper.appendChild(toolbar);

    const controlsGroup = document.createElement("div");
    controlsGroup.className = "pr-controls-group";
    controlsGroup.appendChild(this.strengthRow);
    controlsGroup.appendChild(playerControls);
    this.wrapper.appendChild(controlsGroup);
    this.wrapper.appendChild(propContainer);

    this.container.appendChild(this.wrapper);
  }

  checkResize() {
    const viewportWidth = this.viewport.clientWidth;
    const currentScale = this.getRenderScale();

    if (viewportWidth > 0 && (this._lastWidth !== viewportWidth || this._lastZoom !== this.zoomLevel || this._lastScale !== currentScale)) {
      this._lastWidth = viewportWidth;
      this._lastZoom = this.zoomLevel;
      this._lastScale = currentScale;

      const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
      this.canvas.style.width = newCanvasWidth + "px";
      this.resizeCanvas(newCanvasWidth);
    }
    this._renderLoop = requestAnimationFrame(() => this.checkResize());
  }

  getRenderScale() {
    const dpr = window.devicePixelRatio || 1;
    let graphScale = 1;
    try {
      if (window.app && window.app.canvas && window.app.canvas.ds && window.app.canvas.ds.scale) {
        graphScale = window.app.canvas.ds.scale;
      }
    } catch (e) { }
    // Scale up if zoomed in, but don't drop below 1x DPR if zoomed out
    return dpr * Math.max(1, graphScale);
  }

  resizeCanvas(widthPx) {
    const scale = this.getRenderScale();
    const targetWidth = Math.round(widthPx * scale);
    const targetHeight = Math.round(this.canvasHeight * scale);

    this.canvas.width = targetWidth;
    this.canvas.height = targetHeight;
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.render();
  }

  // Helper to map mouse events accurately regardless of canvas scaling
  getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();

    const scaleX = this.canvas.offsetWidth / rect.width;
    const scaleY = this.canvas.offsetHeight / rect.height;

    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    return { x, y };
  }

  // --- Async Image Upload Logic (Handles multiple images simultaneously) ---
  async handleImageUpload(files, targetFrameStart = null, explicitLength = null) {
    const frameRate = this.getFrameRate();
    const durationFrames = this.getDurationFrames();
    const newLength = explicitLength !== null ? explicitLength : frameRate * 1; // Default to 1 second long

    for (let file of files) {
      if (!file.type.startsWith("image/")) continue;

      await new Promise(async (resolve) => {
        try {
          const body = new FormData();
          body.append("image", file);
          const resp = await api.fetchApi("/upload/image", { method: "POST", body });
          if (resp.status !== 200) { resolve(); return; }

          const data = await resp.json();
          const filename = data.name;
          const subfolder = data.subfolder || "";
          const imageFile = subfolder ? subfolder + "/" + filename : filename;
          const imgUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

          const img = new Image();
          img.onload = () => {

            let newStart = targetFrameStart;
            if (newStart === null) {
              // Fallback: find the first free slot, or append past the end
              newStart = 0;
              this.timeline.segments.sort((a, b) => a.start - b.start);
              for (let i = 0; i < this.timeline.segments.length; i++) {
                let seg = this.timeline.segments[i];
                if (newStart + newLength <= seg.start) break;
                newStart = Math.max(newStart, seg.start + seg.length);
              }
            } else {
              newStart = this.snapFrameToCut(newStart, { totalFrames: this.getVisualDurationFrames() });
            }

            // Use the visual timeline as the physics bound so segments can
            // land anywhere in the padded visual area without touching duration_frames.
            const currentDuration = this.getVisualDurationFrames();

            if (targetFrameStart !== null) {
              // Resolve physics to push existing segments
              let tempId = "TEMP_" + Date.now();
              this.timeline.segments.push({ id: tempId, start: newStart, length: newLength, type: "temp" });
              let result = this._applyCenterDragPhysics(this.timeline.segments, tempId, newStart, newStart + newLength / 2, currentDuration, currentDuration, 1);

              // Update original segments with resolved physics to preserve imgObj
              for (let shiftedSeg of result) {
                let original = this.timeline.segments.find(s => s.id === shiftedSeg.id);
                if (original) {
                  original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
                }
              }

              let tempSeg = this.timeline.segments.find(s => s.id === tempId);
              newStart = tempSeg.start;
              this.timeline.segments = this.timeline.segments.filter(s => s.id !== tempId);
              targetFrameStart = newStart + newLength; // For the next file in batch
            }

            // Use the full intended length — the timeline has already been grown to fit.
            let constrainedLength = newLength;

            const seg = {
              id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
              start: newStart,
              length: constrainedLength,
              prompt: "",
              type: "image",
              imageFile: imageFile,
              imageB64: imgUrl,
              guideStrength: 1.0,
            };

            const displayImg = new Image();
            displayImg.onload = () => {
              seg.imgObj = displayImg;
              this.render();
              resolve(); // Resolve promise letting next image process
            };
            displayImg.src = imgUrl;

            this.timeline.segments.push(seg);
            this.timeline.segments.sort((a, b) => a.start - b.start);
            this.selectionType = "image";
            this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);

            this.updateUIFromSelection();
            this.commitChanges(true);
          };
          img.src = imgUrl;
        } catch (err) {
          console.error("[PromptRelay] Image upload failed", err);
          resolve();
        }
      });
    }
    this.fileInput.value = "";
  }

  // --- Async Reference Upload Logic ---
  async handleReferenceUpload(files) {
    for (let file of files) {
      if (!file.type.startsWith("image/")) continue;

      await new Promise(async (resolve) => {
        try {
          const body = new FormData();
          body.append("image", file);
          const resp = await api.fetchApi("/upload/image", { method: "POST", body });
          if (resp.status !== 200) { resolve(); return; }

          const data = await resp.json();
          const filename = data.name;
          const subfolder = data.subfolder || "";
          const imageFile = subfolder ? subfolder + "/" + filename : filename;
          const imgUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

          const seg = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            type: "reference",
            imageFile,
            imageB64: imgUrl,
            note: "",
          };

          const displayImg = new Image();
          displayImg.onload = () => {
            seg.imgObj = displayImg;
            this.renumberReferences();
            this.renderReferenceChannel();
            this.updateUIFromSelection();
            this.commitChanges(true);
            resolve();
          };
          displayImg.src = imgUrl;

          this.timeline.referenceImages.push(seg);
          this.renumberReferences();
          this.selectionType = "reference";
          this.selectedIndex = this.timeline.referenceImages.findIndex(s => s.id === seg.id);
        } catch (err) {
          console.error("[PromptRelay] Reference upload failed", err);
          resolve();
        }
      });
    }
    this.referenceFileInput.value = "";
  }

  renumberReferences() {
    (this.timeline.referenceImages || []).forEach((seg, idx) => {
      seg.refName = `@Ref${idx + 1}`;
      seg.type = "reference";
    });
  }

  renderReferenceChannel() {
    if (!this.referenceChannel) return;
    this.renumberReferences();
    this.referenceChannel.innerHTML = "";

    const refs = this.timeline.referenceImages || [];
    if (!refs.length) {
      const empty = document.createElement("div");
      empty.className = "pr-reference-empty";
      empty.textContent = t("referenceEmpty");
      this.referenceChannel.appendChild(empty);
      return;
    }

    refs.forEach((seg, idx) => {
      const card = document.createElement("div");
      card.className = "pr-reference-card";
      if (this.selectionType === "reference" && this.selectedIndex === idx) {
        card.classList.add("active");
      }
      card.title = `${seg.refName}${seg.note ? ": " + seg.note : ""}`;
      card.addEventListener("click", () => {
        this.selectionType = "reference";
        this.selectedIndex = idx;
        this.updateUIFromSelection();
        this.renderReferenceChannel();
      });

      const img = document.createElement("img");
      img.src = seg.imageB64 || "";
      const label = document.createElement("div");
      label.className = "pr-reference-label";
      label.textContent = seg.refName;

      card.appendChild(img);
      card.appendChild(label);
      this.referenceChannel.appendChild(card);
    });
  }

  // --- Async Audio Upload Logic ---
  async handleAudioUpload(files, targetFrameStart = null) {
    const frameRate = this.getFrameRate();
    const durationFrames = this.getDurationFrames();

    for (let file of files) {
      if (!file.type.startsWith("audio/")) continue;

      await new Promise(async (resolve) => {
        try {
          const body = new FormData();
          body.append("image", file);
          const resp = await api.fetchApi("/upload/image", { method: "POST", body });
          if (resp.status !== 200) { resolve(); return; }

          const data = await resp.json();
          const filename = data.name;
          const subfolder = data.subfolder || "";
          const audioFile = subfolder ? subfolder + "/" + filename : filename;

          const arrayBuffer = await file.arrayBuffer();
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
          const clipDurationSecs = audioBuffer.duration;
          const clipFrames = Math.max(1, Math.ceil(clipDurationSecs * frameRate));

          const channelData = audioBuffer.getChannelData(0);
          const peaks = [];
          const numPeaks = 200;
          const step = Math.floor(channelData.length / numPeaks);
          for (let i = 0; i < numPeaks; i++) {
            let max = 0;
            for (let j = 0; j < step; j++) {
              const val = Math.abs(channelData[i * step + j]);
              if (val > max) max = val;
            }
            peaks.push(max);
          }

          let newLength = clipFrames;
          let newStart = targetFrameStart;

          if (newStart === null) {
            // Find the first free slot, or place past the end of all existing audio
            newStart = 0;
            this.timeline.audioSegments.sort((a, b) => a.start - b.start);
            for (let i = 0; i < this.timeline.audioSegments.length; i++) {
              let seg = this.timeline.audioSegments[i];
              if (newStart + newLength <= seg.start) break;
              newStart = Math.max(newStart, seg.start + seg.length);
            }
          } else {
            newStart = this.snapFrameToCut(newStart, { totalFrames: this.getVisualDurationFrames() });
          }

          // Use the visual timeline as the physics bound so segments can
          // land anywhere in the padded visual area without touching duration_frames.
          const currentDuration = this.getVisualDurationFrames();

          if (targetFrameStart !== null) {
            let tempId = "TEMP_" + Date.now();
            this.timeline.audioSegments.push({ id: tempId, start: newStart, length: newLength, type: "temp" });
            let result = this._applyCenterDragPhysics(this.timeline.audioSegments, tempId, newStart, newStart + newLength / 2, currentDuration, currentDuration, 1);

            for (let shiftedSeg of result) {
              let original = this.timeline.audioSegments.find(s => s.id === shiftedSeg.id);
              if (original) original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
            }

            let tempSeg = this.timeline.audioSegments.find(s => s.id === tempId);
            newStart = tempSeg.start;
            this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== tempId);
            targetFrameStart = newStart + newLength;
          }

          // Use the full clip length — timeline has already grown to fit.
          let constrainedLength = newLength;

          const seg = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            type: "audio",
            start: newStart,
            length: constrainedLength,
            trimStart: 0,
            audioDurationFrames: clipFrames,
            audioFile: audioFile,
            fileName: file.name,
            waveformPeaks: peaks
          };

          this.timeline.audioSegments.push(seg);
          this.timeline.audioSegments.sort((a, b) => a.start - b.start);
          this.selectionType = "audio";
          this.selectedIndex = this.timeline.audioSegments.findIndex(s => s.id === seg.id);

          this.updateUIFromSelection();
          this.commitChanges(true);
          this.render();
          resolve();
        } catch (err) {
          console.error("[PromptRelay] Audio processing failed", err);
          resolve();
        }
      });
    }
    this.audioFileInput.value = "";
  }

  deleteSelectedSegment() {
    if ((this.multiSelection || []).length > 1) {
      for (const track of ["image", "prompt", "camera", "control", "audio", "cut"]) {
        const selectedIds = new Set(this.multiSelection.filter((item) => item.track === track).map((item) => item.id));
        if (!selectedIds.size) continue;
        const filtered = this.getTrackArray(track).filter((seg) => !selectedIds.has(seg.id));
        this.setTrackArray(track, filtered);
      }
      this.clearMultiSelection();
      this.selectedIndex = -1;
      this.updateUIFromSelection();
      this.commitChanges();
      this.render();
      this.renderReferenceChannel();
      return;
    }

    if (this.selectionType === "cut") {
      if ((this.timeline.cutSegments || []).length === 0 || this.selectedIndex === -1) return;
      this.timeline.cutSegments.splice(this.selectedIndex, 1);
      this.selectedIndex = Math.max(-1, Math.min(this.selectedIndex - 1, this.timeline.cutSegments.length - 1));
    } else if (this.selectionType === "audio") {
      if (this.timeline.audioSegments.length === 0 || this.selectedIndex === -1) return;
      this.timeline.audioSegments.splice(this.selectedIndex, 1);
      this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
    } else if (this.selectionType === "control") {
      if (this.timeline.controlSegments.length === 0 || this.selectedIndex === -1) return;
      this.timeline.controlSegments.splice(this.selectedIndex, 1);
      this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
    } else if (this.selectionType === "reference") {
      if (this.timeline.referenceImages.length === 0 || this.selectedIndex === -1) return;
      this.timeline.referenceImages.splice(this.selectedIndex, 1);
      this.renumberReferences();
      this.selectedIndex = Math.max(-1, Math.min(this.selectedIndex, this.timeline.referenceImages.length - 1));
    } else if (this.selectionType === "camera") {
      if (this.timeline.cameraSegments.length === 0 || this.selectedIndex === -1) return;
      this.timeline.cameraSegments.splice(this.selectedIndex, 1);
      this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
    } else if (this.selectionType === "prompt") {
      if (this.timeline.promptSegments.length === 0 || this.selectedIndex === -1) return;
      this.timeline.promptSegments.splice(this.selectedIndex, 1);
      this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
    } else {
      if (this.timeline.segments.length === 0 || this.selectedIndex === -1) return;
      this.timeline.segments.splice(this.selectedIndex, 1);
      this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
    }
    this.clearMultiSelection();
    this.updateUIFromSelection();
    this.commitChanges();
    this.render();
    this.renderReferenceChannel();
  }

  formatTime(frames, dropSuffix = false) {
    const mode = this.displayModeWidget ? this.displayModeWidget.value : "seconds";
    if (mode === "seconds") {
      const secs = frames / this.getFrameRate();
      return dropSuffix ? secs.toFixed(2) : secs.toFixed(2) + "s";
    }
    return dropSuffix ? Math.round(frames).toString() : Math.round(frames) + " frames";
  }

  updateWidgetVisibility() {
    const mode = this.displayModeWidget ? this.displayModeWidget.value : "seconds";

    if (this.durationFramesWidget) {
      // Always visible regardless of display mode
      this.durationFramesWidget.type = "INT";
      if (!this.durationFramesWidget.options) this.durationFramesWidget.options = {};
      this.durationFramesWidget.options.hidden = false;
      this.durationFramesWidget.hidden = false;
      delete this.durationFramesWidget.computeSize;
    }
    if (this.durationSecondsWidget) {
      // Always visible regardless of display mode
      this.durationSecondsWidget.type = "FLOAT";
      if (!this.durationSecondsWidget.options) this.durationSecondsWidget.options = {};
      this.durationSecondsWidget.options.hidden = false;
      this.durationSecondsWidget.hidden = false;
      delete this.durationSecondsWidget.computeSize;
    }

    // Force node resize and redraw deferred to next tick
    setTimeout(() => {
      if (this.node && this.node.computeSize) {
        const sz = this.node.computeSize();
        this.node.size[1] = sz[1];
        if (window.app && window.app.graph) {
          window.app.graph.setDirtyCanvas(true, true);
        }
      }
    }, 0);
  }

  updateStrengthVisual() {
    if (!this.strengthValue) return;
    const raw = parseFloat(this.strengthValue.value);
    const val = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    const pct = Math.round(val * 100);
    const active = this.strengthValue.disabled ? "#555" : "#d7a94f";
    const activeText = this.strengthValue.disabled ? "#ddd" : "#fff";
    this.strengthValue.style.background =
      `linear-gradient(90deg, ${active} 0%, ${active} ${pct}%, #222 ${pct}%, #222 100%)`;
    this.strengthValue.style.color = activeText;
  }

  updateUIFromSelection() {
    let seg = null;
    if (this.selectedIndex >= 0) {
      if (this.selectionType === "cut") {
        seg = (this.timeline.cutSegments || [])[this.selectedIndex] || null;
      } else if (this.selectionType === "audio") {
        const origSeg = this.timeline.audioSegments[this.selectedIndex];
        if (origSeg) {
          const previewIsAudio = this._ghostTrack === 'audio' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');
          const arr = (this._previewSegments && previewIsAudio) ? this._previewSegments : this.timeline.audioSegments;
          seg = arr.find(s => s.id === origSeg.id) || origSeg;
        }
      } else if (this.selectionType === "reference") {
        seg = this.timeline.referenceImages[this.selectedIndex] || null;
      } else if (this.selectionType === "control") {
        const origSeg = this.timeline.controlSegments[this.selectedIndex];
        if (origSeg) {
          const previewIsControl = this._ghostTrack === 'control' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'control');
          const arr = (this._previewSegments && previewIsControl) ? this._previewSegments : this.timeline.controlSegments;
          seg = arr.find(s => s.id === origSeg.id) || origSeg;
        }
      } else if (this.selectionType === "camera") {
        const origSeg = this.timeline.cameraSegments[this.selectedIndex];
        if (origSeg) {
          const previewIsCamera = this._ghostTrack === 'camera' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'camera');
          const arr = (this._previewSegments && previewIsCamera) ? this._previewSegments : this.timeline.cameraSegments;
          seg = arr.find(s => s.id === origSeg.id) || origSeg;
        }
      } else if (this.selectionType === "prompt") {
        const origSeg = this.timeline.promptSegments[this.selectedIndex];
        if (origSeg) {
          const previewIsPrompt = this._ghostTrack === 'prompt' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'prompt');
          const arr = (this._previewSegments && previewIsPrompt) ? this._previewSegments : this.timeline.promptSegments;
          seg = arr.find(s => s.id === origSeg.id) || origSeg;
        }
      } else {
        const origSeg = this.timeline.segments[this.selectedIndex];
        if (origSeg) {
          const previewIsImage = this._ghostTrack === 'image' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'image');
          const arr = (this._previewSegments && previewIsImage) ? this._previewSegments : this.timeline.segments;
          seg = arr.find(s => s.id === origSeg.id) || origSeg;
        }
      }
    }

    if (this.selectionType === "cut" && seg) {
      if (this.strengthLabel) this.strengthLabel.textContent = `${t("cut")}:`;
      this.audioInfoArea.style.display = "none";
      if (this.cameraSelect) this.cameraSelect.style.display = "none";
      this.promptInput.style.display = "block";
      this.promptInput.placeholder = "Manual long-auto split point";
      this.promptInput.value = seg.label || "CUT";
      this.promptInput.disabled = true;
      this.strengthRow.style.display = "flex";
      this.strengthValue.value = "1.00";
      this.strengthValue.disabled = true;
    } else if (this.selectionType === "audio" && seg) {
      if (this.strengthLabel) this.strengthLabel.textContent = `${t("strength")}:`;
      this.promptInput.style.display = "none";
      if (this.cameraSelect) this.cameraSelect.style.display = "none";
      this.strengthRow.style.display = "flex";
      this.audioInfoArea.style.display = "block";
      this.audioInfoArea.innerHTML = `
        File: <span>${seg.fileName || "Unknown"}</span><br>
        Length: <span>${this.formatTime(seg.audioDurationFrames)}</span> Output Length: <span>${this.formatTime(seg.length)}</span><br>
        Trim-in: <span>${this.formatTime(Math.round(seg.trimStart))}</span> Trim-Out: <span>${this.formatTime(Math.round(seg.audioDurationFrames - (seg.trimStart + seg.length)))}</span>
      `;
      this.strengthValue.value = "1.00";
      this.strengthValue.disabled = true;
    } else if (this.selectionType === "reference" && seg) {
      if (this.strengthLabel) this.strengthLabel.textContent = `${t("referenceStrength")}:`;
      this.audioInfoArea.style.display = "none";
      if (this.cameraSelect) this.cameraSelect.style.display = "none";
      this.promptInput.style.display = "block";
      this.promptInput.placeholder = `Describe how ${seg.refName || "@Ref"} should be used...`;
      this.promptInput.value = seg.note || "";
      this.promptInput.disabled = false;
      this.strengthRow.style.display = "flex";
      this.strengthValue.value = "1.00";
      this.strengthValue.disabled = true;
    } else if (this.selectionType === "camera" && seg) {
      if (this.strengthLabel) this.strengthLabel.textContent = `${t("strength")}:`;
      this.audioInfoArea.style.display = "none";
      this.promptInput.style.display = "none";
      this.promptInput.value = "";
      this.promptInput.disabled = true;
      if (this.cameraSelect) {
        if (!CAMERA_MOTION_BY_ID[seg.cameraMotion]) seg.cameraMotion = inferCameraMotionFromPrompt(seg.prompt);
        this.cameraSelect.value = seg.cameraMotion;
        this.cameraSelect.style.display = "block";
        this.cameraSelect.disabled = false;
      }
      this.strengthRow.style.display = "flex";
      this.strengthValue.value = "1.00";
      this.strengthValue.disabled = true;
    } else if (this.selectionType === "prompt" && seg) {
      if (this.strengthLabel) this.strengthLabel.textContent = `${t("strength")}:`;
      this.audioInfoArea.style.display = "none";
      if (this.cameraSelect) this.cameraSelect.style.display = "none";
      this.promptInput.style.display = "block";
      this.promptInput.placeholder = "Describe action, expression, state, or shot intent for this time range...";
      this.promptInput.value = seg.prompt || "";
      this.promptInput.disabled = false;
      this.strengthRow.style.display = "flex";
      this.strengthValue.value = "1.00";
      this.strengthValue.disabled = true;
    } else if (this.selectionType === "control" && seg) {
      if (this.strengthLabel) this.strengthLabel.textContent = `${t("icControlStrength")}:`;
      this.audioInfoArea.style.display = "none";
      if (this.cameraSelect) this.cameraSelect.style.display = "none";
      this.promptInput.style.display = "block";
      this.promptInput.placeholder = "Describe the intended IC-LoRA control signal...";
      this.promptInput.value = seg.prompt || "";
      this.promptInput.disabled = false;
      this.strengthRow.style.display = "flex";
      this.strengthValue.value = (seg.strength ?? 0.75).toFixed(2);
      this.strengthValue.disabled = true;
    } else {
      if (this.strengthLabel) this.strengthLabel.textContent = `${t("keyframeStrength")}:`;
      this.audioInfoArea.style.display = "none";
      if (this.cameraSelect) this.cameraSelect.style.display = "none";
      this.strengthRow.style.display = "flex";

      if (seg) {
        this.promptInput.style.display = "none";
        this.promptInput.value = "";
        this.promptInput.disabled = true;
        const strength = seg.guideStrength ?? 1.0;
        this.strengthValue.value = strength.toFixed(2);
        this.strengthValue.disabled = false;
      } else {
        this.promptInput.style.display = "none";
        this.promptInput.value = "";
        this.promptInput.disabled = true;
        this.strengthValue.value = "1.00";
        this.strengthValue.disabled = true;
      }
    }

    this.updateStrengthVisual();

    if (this.segmentBoundsDisplay) {
      if (this.selectionType === "reference" && seg) {
        this.segmentBoundsDisplay.textContent = `Reference: ${seg.refName || "-"}`;
      } else if (this.selectionType === "cut" && seg) {
        this.segmentBoundsDisplay.textContent = `Cut: ${this.formatTime(seg.start ?? seg.frame ?? 0, true)}`;
      } else if (seg) {
        const startStr = this.formatTime(seg.start, true);
        const endStr = this.formatTime(seg.start + seg.length, true);
        this.segmentBoundsDisplay.textContent = `${t("start")}: ${startStr} | ${t("end")}: ${endStr}`;
      } else {
        this.segmentBoundsDisplay.textContent = `${t("start")}: - | ${t("end")}: -`;
      }
    }
  }

  // --- Rendering logic ---
  render() {
    const width = this.canvas.offsetWidth || this._lastWidth;
    const height = this.canvasHeight;
    const totalFrames = this.getVisualDurationFrames();

    if (!width || width <= 0) return;

    this.ctx.clearRect(0, 0, width, height);



    // Render Track Backgrounds
    this.ctx.fillStyle = "#111"; // Image track bg
    this.ctx.fillRect(0, RULER_HEIGHT, width, this.blockHeight);
    this.ctx.fillStyle = "#0d1518"; // Local prompt track bg
    this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight, width, PROMPT_TRACK_HEIGHT);
    this.ctx.fillStyle = "#10141c"; // Camera track bg
    this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight + PROMPT_TRACK_HEIGHT, width, this.cameraTrackHeight);
    this.ctx.fillStyle = "#181122"; // IC-LoRA control track bg
    this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight + PROMPT_TRACK_HEIGHT + this.cameraTrackHeight, width, this.controlTrackHeight);
    this.ctx.fillStyle = "#111"; // Audio track bg
    this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight + PROMPT_TRACK_HEIGHT + this.cameraTrackHeight + this.controlTrackHeight, width, this.audioTrackHeight);



    // Determine which track the preview belongs to.
    // _ghostTrack is set during HTML file drag-and-drop.
    // During canvas mouse drags, _ghostTrack is null, so fall back to selectionType.
    const previewIsAudio = this._ghostTrack === 'audio' ||
      (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');
    const previewIsCamera = this._ghostTrack === 'camera' ||
      (this._previewSegments && this._ghostTrack === null && this.selectionType === 'camera');
    const previewIsControl = this._ghostTrack === 'control' ||
      (this._previewSegments && this._ghostTrack === null && this.selectionType === 'control');
    const previewIsPrompt = this._ghostTrack === 'prompt' ||
      (this._previewSegments && this._ghostTrack === null && this.selectionType === 'prompt');

    let renderSegments = (this._previewSegments && !previewIsAudio && !previewIsCamera && !previewIsControl && !previewIsPrompt)
      ? this._previewSegments : this.timeline.segments;

    let renderPromptSegments = (this._previewSegments && previewIsPrompt)
      ? this._previewSegments : this.timeline.promptSegments;

    let renderCameraSegments = (this._previewSegments && previewIsCamera)
      ? this._previewSegments : this.timeline.cameraSegments;

    let renderControlSegments = (this._previewSegments && previewIsControl)
      ? this._previewSegments : this.timeline.controlSegments;

    let renderAudioSegments = (this._previewSegments && previewIsAudio)
      ? this._previewSegments : this.timeline.audioSegments;



    const activeSegId = this.selectionType === "image" ? this.timeline.segments[this.selectedIndex]?.id : null;
    const activePromptSegId = this.selectionType === "prompt" ? this.timeline.promptSegments[this.selectedIndex]?.id : null;
    const activeCameraSegId = this.selectionType === "camera" ? this.timeline.cameraSegments[this.selectedIndex]?.id : null;
    const activeControlSegId = this.selectionType === "control" ? this.timeline.controlSegments[this.selectedIndex]?.id : null;
    const activeAudioSegId = this.selectionType === "audio" ? this.timeline.audioSegments[this.selectedIndex]?.id : null;
    const activeCutSegId = this.selectionType === "cut" ? this.timeline.cutSegments?.[this.selectedIndex]?.id : null;

    // Sort segments so that the selected one is drawn last (on top)
    const isImageSelection = this.selectionType === "image";
    const sortedSegments = [...renderSegments].sort((a, b) => {
      const aSel = isImageSelection && a.id === activeSegId;
      const bSel = isImageSelection && b.id === activeSegId;
      return aSel - bSel;
    });

    const isAudioSelection = this.selectionType === "audio";
    const sortedAudioSegments = [...renderAudioSegments].sort((a, b) => {
      const aSel = isAudioSelection && a.id === activeAudioSegId;
      const bSel = isAudioSelection && b.id === activeAudioSegId;
      return aSel - bSel;
    });

    const isCameraSelection = this.selectionType === "camera";
    const sortedCameraSegments = [...renderCameraSegments].sort((a, b) => {
      const aSel = isCameraSelection && a.id === activeCameraSegId;
      const bSel = isCameraSelection && b.id === activeCameraSegId;
      return aSel - bSel;
    });

    const isControlSelection = this.selectionType === "control";
    const sortedControlSegments = [...renderControlSegments].sort((a, b) => {
      const aSel = isControlSelection && a.id === activeControlSegId;
      const bSel = isControlSelection && b.id === activeControlSegId;
      return aSel - bSel;
    });

    const isPromptSelection = this.selectionType === "prompt";
    const sortedPromptSegments = [...renderPromptSegments].sort((a, b) => {
      const aSel = isPromptSelection && a.id === activePromptSegId;
      const bSel = isPromptSelection && b.id === activePromptSegId;
      return aSel - bSel;
    });

    // --- Draw Keyframe Segments ---
    for (let i = 0; i < sortedSegments.length; i++) {
      const seg = sortedSegments[i];
      const startX = (seg.start / totalFrames) * width;
      const pxWidth = (seg.length / totalFrames) * width;
      const isSelected = this.isSegmentSelected("image", seg.id, this.selectionType === "image" ? activeSegId : null);

      const originalSeg = this.timeline.segments.find(s => s.id === seg.id);
      const imgObj = originalSeg ? originalSeg.imgObj : seg.imgObj;

      if ((this._isDragging && this.selectionType === "image" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
        this.ctx.globalAlpha = 0.65;
      } else {
        this.ctx.globalAlpha = 1.0;
      }

      if (seg.type === "ghost") {
        this.ctx.fillStyle = "#2a2a2a";
        this.ctx.fillRect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);

        this.ctx.strokeStyle = "#777";
        this.ctx.lineWidth = 2;
        this.ctx.setLineDash([5, 5]);
        this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
        this.ctx.setLineDash([]);

        this.ctx.fillStyle = "#aaa";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.font = "bold 12px sans-serif";
        this.ctx.fillText(t("dropKeyframe"), startX + pxWidth / 2, RULER_HEIGHT + this.blockHeight / 2);
      } else {
        this.ctx.fillStyle = "#000";
        this.ctx.fillRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
      }

      if (imgObj && imgObj.complete && imgObj.naturalWidth > 0 && seg.type !== "ghost") {
        const imgRatio = imgObj.naturalWidth / imgObj.naturalHeight;
        const boxRatio = pxWidth / this.blockHeight;
        let drawW, drawH, drawX, drawY;
        if (imgRatio > boxRatio) {
          drawW = pxWidth; drawH = pxWidth / imgRatio;
          drawX = startX; drawY = RULER_HEIGHT + (this.blockHeight - drawH) / 2;
        } else {
          drawH = this.blockHeight; drawW = this.blockHeight * imgRatio;
          drawY = RULER_HEIGHT; drawX = startX + (pxWidth - drawW) / 2;
        }

        // Clip to segment bounds so tiled images don't bleed into adjacent segments
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.rect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
        this.ctx.clip();

        if (imgRatio > boxRatio) {
          // Fits width, vertical letterboxing (black bars top/bottom) — keep as is
          this.ctx.drawImage(imgObj, drawX, drawY, drawW, drawH);
        } else {
          // Fits height, horizontal letterboxing (black bars left/right) — tile horizontally
          this.ctx.drawImage(imgObj, drawX, drawY, drawW, drawH);

          // Tile left
          let leftX = drawX - drawW;
          while (leftX + drawW > startX) {
            this.ctx.drawImage(imgObj, leftX, drawY, drawW, drawH);
            leftX -= drawW;
          }

          // Tile right
          let rightX = drawX + drawW;
          while (rightX < startX + pxWidth) {
            this.ctx.drawImage(imgObj, rightX, drawY, drawW, drawH);
            rightX += drawW;
          }
        }
        this.ctx.restore();

        // --- Prompt subtitle overlay ---
        if (seg.prompt && seg.type !== "ghost" && pxWidth > 24) {
          const overlayH = Math.round(this.blockHeight * 0.20);
          const overlayY = RULER_HEIGHT + this.blockHeight - overlayH;

          this.ctx.save();
          this.ctx.beginPath();
          this.ctx.rect(startX, overlayY, pxWidth, overlayH);
          this.ctx.clip();

          // Translucent background
          this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
          this.ctx.fillRect(startX, overlayY, pxWidth, overlayH);

          // Text
          const fontSize = Math.min(11, overlayH * 0.58);
          this.ctx.font = `${fontSize}px sans-serif`;
          this.ctx.fillStyle = "#e0e3ed";
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";

          // Measure and truncate to single line
          const maxTextW = pxWidth - 10;
          let label = seg.prompt;
          if (this.ctx.measureText(label).width > maxTextW) {
            while (label.length > 0 && this.ctx.measureText(label + "…").width > maxTextW) {
              label = label.slice(0, -1);
            }
            label += "…";
          }

          this.ctx.fillText(label, startX + pxWidth / 2, overlayY + overlayH / 2);
          this.ctx.restore();
        }
      }

      if (seg.type !== "ghost" && pxWidth > 42) {
        const badgeText = `KF ${(seg.guideStrength ?? 1.0).toFixed(2)}`;
        this.ctx.save();
        this.ctx.font = "bold 10px sans-serif";
        const badgeW = Math.min(pxWidth - 8, Math.max(46, this.ctx.measureText(badgeText).width + 12));
        const badgeH = 18;
        const badgeX = startX + 5;
        const badgeY = RULER_HEIGHT + 6;
        this.ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
        this.ctx.beginPath();
        this.ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 5);
        this.ctx.fill();
        this.ctx.fillStyle = "#ffe08a";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2);
        this.ctx.restore();
      }

      if (isSelected) {
        this.ctx.strokeStyle = "#fff";
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
        this.ctx.fillStyle = "#fff";
        this.ctx.beginPath();
        this.ctx.roundRect(startX, RULER_HEIGHT + this.blockHeight / 2 - 12, 4, 24, 2);
        this.ctx.fill();
        this.ctx.beginPath();
        this.ctx.roundRect(startX + pxWidth - 4, RULER_HEIGHT + this.blockHeight / 2 - 12, 4, 24, 2);
        this.ctx.fill();
      } else {
        this.ctx.strokeStyle = "#000";
        this.ctx.lineWidth = 1.5;
        this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
      }
      this.ctx.globalAlpha = 1.0;
    }

    // --- Draw Local Prompt Segments ---
    for (let i = 0; i < sortedPromptSegments.length; i++) {
      const seg = sortedPromptSegments[i];
      const startX = (seg.start / totalFrames) * width;
      const pxWidth = (seg.length / totalFrames) * width;
      const isSelected = this.isSegmentSelected("prompt", seg.id, this.selectionType === "prompt" ? activePromptSegId : null);
      const trackY = this.getTrackY("prompt");

      if ((this._isDragging && this.selectionType === "prompt" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
        this.ctx.globalAlpha = 0.65;
      } else {
        this.ctx.globalAlpha = 1.0;
      }

      this.drawPromptSegmentVisuals(this.ctx, seg, isSelected, trackY, PROMPT_TRACK_HEIGHT, startX, pxWidth);
      this.ctx.globalAlpha = 1.0;
    }

    // --- Draw Camera Segments ---
    for (let i = 0; i < sortedCameraSegments.length; i++) {
      const seg = sortedCameraSegments[i];
      const startX = (seg.start / totalFrames) * width;
      const pxWidth = (seg.length / totalFrames) * width;
      const isSelected = this.isSegmentSelected("camera", seg.id, this.selectionType === "camera" ? activeCameraSegId : null);
      const trackY = this.getTrackY("camera");

      if ((this._isDragging && this.selectionType === "camera" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
        this.ctx.globalAlpha = 0.65;
      } else {
        this.ctx.globalAlpha = 1.0;
      }

      this.drawCameraSegmentVisuals(this.ctx, seg, isSelected, trackY, this.cameraTrackHeight, startX, pxWidth);
      this.ctx.globalAlpha = 1.0;
    }

    // --- Draw IC-Control Segments ---
    for (let i = 0; i < sortedControlSegments.length; i++) {
      const seg = sortedControlSegments[i];
      const startX = (seg.start / totalFrames) * width;
      const pxWidth = (seg.length / totalFrames) * width;
      const isSelected = this.isSegmentSelected("control", seg.id, this.selectionType === "control" ? activeControlSegId : null);
      const trackY = this.getTrackY("control");

      if ((this._isDragging && this.selectionType === "control" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
        this.ctx.globalAlpha = 0.65;
      } else {
        this.ctx.globalAlpha = 1.0;
      }

      this.drawControlSegmentVisuals(this.ctx, seg, isSelected, trackY, this.controlTrackHeight, startX, pxWidth);
      this.ctx.globalAlpha = 1.0;
    }

    // --- Draw Audio Segments ---
    for (let i = 0; i < sortedAudioSegments.length; i++) {
      const seg = sortedAudioSegments[i];
      const startX = (seg.start / totalFrames) * width;
      const pxWidth = (seg.length / totalFrames) * width;
      const isSelected = this.isSegmentSelected("audio", seg.id, this.selectionType === "audio" ? activeAudioSegId : null);
      const trackY = this.getTrackY("audio");

      if ((this._isDragging && this.selectionType === "audio" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
        this.ctx.globalAlpha = 0.65;
      } else {
        this.ctx.globalAlpha = 1.0;
      }

      if (seg.type === "ghost") {
        this.ctx.fillStyle = "#1a1a1a";
        this.ctx.fillRect(startX, trackY, pxWidth, this.audioTrackHeight);
        this.ctx.strokeStyle = "#555";
        this.ctx.lineWidth = 2;
        this.ctx.setLineDash([5, 5]);
        this.ctx.strokeRect(startX, trackY, pxWidth, this.audioTrackHeight);
        this.ctx.setLineDash([]);
        this.ctx.fillStyle = "#888";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.font = "bold 12px sans-serif";
        this.ctx.fillText(t("dropAudio"), startX + pxWidth / 2, trackY + this.audioTrackHeight / 2);
      } else {
        this.drawAudioSegmentVisuals(this.ctx, seg, isSelected, trackY, this.audioTrackHeight, startX, pxWidth);
      }
      this.ctx.globalAlpha = 1.0;
    }

    // --- Draw Ruler & Divider AFTER segments to prevent overlap ---
    // Ruler Background
    this.ctx.fillStyle = "#1e1e1e";
    this.ctx.fillRect(0, 0, width, RULER_HEIGHT);

    // Crisp Ruler Text
    this.ctx.fillStyle = "#aaa";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.font = "10px sans-serif";

    const frameRate = this.getFrameRate();
    const mode = this.displayModeWidget ? this.displayModeWidget.value : "seconds";

    // Define logical steps for both modes
    let steps;
    if (mode === "seconds") {
      steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    } else {
      steps = [1, 2, 5, 10, 24, 48, 120, 240, 480, 960, 1920];
    }

    const minSpacingPx = 60;
    let majorStep = steps[steps.length - 1];
    for (let i = 0; i < steps.length; i++) {
      const stepFrames = mode === "seconds" ? steps[i] * frameRate : steps[i];
      const spacingPx = (stepFrames / totalFrames) * width;
      if (spacingPx >= minSpacingPx) {
        majorStep = steps[i];
        break;
      }
    }

    const majorStepFrames = mode === "seconds" ? majorStep * frameRate : majorStep;

    let minorStep;
    if (mode === "seconds") {
      if (majorStep <= 0.2) minorStep = majorStep / 2;
      else if (majorStep <= 1) minorStep = majorStep / 5;
      else if (majorStep <= 5) minorStep = 1;
      else if (majorStep <= 15) minorStep = 5;
      else if (majorStep <= 30) minorStep = 10;
      else if (majorStep <= 60) minorStep = 10;
      else minorStep = majorStep / 5;
    } else {
      if (majorStep <= 5) minorStep = 1;
      else if (majorStep <= 10) minorStep = 2;
      else if (majorStep <= 24) minorStep = 6;
      else if (majorStep <= 48) minorStep = 12;
      else minorStep = majorStep / 5;
    }
    const minorStepFrames = mode === "seconds" ? minorStep * frameRate : minorStep;

    this.ctx.fillStyle = "#444";
    const totalMinorTicks = Math.floor(totalFrames / minorStepFrames);
    for (let i = 0; i <= totalMinorTicks; i++) {
      const frameVal = i * minorStepFrames;
      if (Math.abs(frameVal % majorStepFrames) < 0.1) continue;

      const x = (frameVal / totalFrames) * width;
      this.ctx.fillRect(Math.floor(x), RULER_HEIGHT - 3, 1, 3);
    }

    this.ctx.fillStyle = "#aaa";
    const totalMajorTicks = Math.floor(totalFrames / majorStepFrames);
    for (let i = 0; i <= totalMajorTicks; i++) {
      const frameVal = i * majorStepFrames;
      const x = (frameVal / totalFrames) * width;

      this.ctx.fillStyle = "#aaa";
      this.ctx.fillRect(Math.floor(x), RULER_HEIGHT - 6, 1, 6);

      if (frameVal > 0 && frameVal < totalFrames) {
        this.ctx.textAlign = "center";
        this.ctx.fillText(this.formatTime(frameVal, true), x, RULER_HEIGHT / 2);
      }
    }

    this.ctx.textAlign = "left";
    const zeroLabel = mode === "seconds" ? "0" : this.formatTime(0, true);
    this.ctx.fillText(zeroLabel, 4, RULER_HEIGHT / 2);

    // Divider
    this.ctx.fillStyle = "#333";
    this.ctx.fillRect(0, this.getTrackY("prompt"), width, 1);
    this.ctx.fillRect(0, this.getTrackY("camera"), width, 1);
    this.ctx.fillRect(0, this.getTrackY("control"), width, 1);
    this.ctx.fillRect(0, this.getTrackY("audio"), width, 1);

    this.drawAutoCutGuides(this.ctx, totalFrames, width);
    this.drawCutMarkers(this.ctx, totalFrames, width, activeCutSegId);

    // Draw gap "+" buttons
    if (!this._isDragging) {
      const BTN_R = 12;
      const gapRegions = this.getGapRegions();
      for (let i = 0; i < gapRegions.length; i++) {
        const gap = gapRegions[i];
        if (gap.widthPx < BTN_R * 2 + 8) continue;
        const hov = this._hoveredGapIdx === i;
        const BTN_W = 18;
        const BTN_H = 18;
        this.ctx.beginPath();
        this.ctx.roundRect(gap.centerX - BTN_W / 2, gap.centerY - BTN_H / 2, BTN_W, BTN_H, 4);
        this.ctx.fillStyle = hov ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.05)";
        this.ctx.fill();
        this.ctx.fillStyle = hov ? "#fff" : "#888";
        this.ctx.font = "14px sans-serif";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText("+", gap.centerX, gap.centerY + 1);
      }
    }

    // --- Out-of-duration shadow overlay ---
    // Draw a translucent black mask over the region beyond the actual output duration
    // so the user can clearly see which content will be included in the render.
    const outputFrames = this.getDurationFrames();
    if (outputFrames < totalFrames) {
      const cutoffX = (outputFrames / totalFrames) * width;
      // Semi-transparent black overlay on both tracks
      this.ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      this.ctx.fillRect(cutoffX, RULER_HEIGHT, width - cutoffX, this.blockHeight + this.cameraTrackHeight + this.controlTrackHeight + this.audioTrackHeight);
      // Subtle tinted ruler overlay
      this.ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
      this.ctx.fillRect(cutoffX, 0, width - cutoffX, RULER_HEIGHT);
      /*
      // Dashed boundary line at the output duration cutoff
      this.ctx.save();
      this.ctx.strokeStyle = "rgba(255, 80, 80, 0.7)";
      this.ctx.lineWidth = 1.5;
      this.ctx.setLineDash([5, 4]);
      this.ctx.beginPath();
      this.ctx.moveTo(cutoffX, 0);
      this.ctx.lineTo(cutoffX, CANVAS_HEIGHT);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
      this.ctx.restore();
      */
    }

    // --- Draw Playhead ---
    const playheadX = (this.currentFrame / totalFrames) * width;

    // Playhead Line
    this.ctx.beginPath();
    this.ctx.moveTo(playheadX, 14);
    this.ctx.lineTo(playheadX, this.canvasHeight);
    this.ctx.strokeStyle = "#ff4444";
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();

    // Playhead Handle (Polygon above numbers)
    this.ctx.fillStyle = "#ff4444";
    this.ctx.beginPath();
    this.ctx.moveTo(playheadX - 6, 0);
    this.ctx.lineTo(playheadX + 6, 0);
    this.ctx.lineTo(playheadX + 6, 8);
    this.ctx.lineTo(playheadX, 14);
    this.ctx.lineTo(playheadX - 6, 8);
    this.ctx.fill();

    // Draw vertical grab bar on the right edge of viewport for resizing width
    const grabBarW = 4;
    const grabBarH = 50;
    const grabBarX = this.viewport.scrollLeft + this.viewport.clientWidth - grabBarW - 3;
    const grabBarY = RULER_HEIGHT + (this.blockHeight + PROMPT_TRACK_HEIGHT + this.cameraTrackHeight + this.controlTrackHeight + this.audioTrackHeight - grabBarH) / 2;
    
    this.ctx.fillStyle = "rgba(40, 40, 40, 0.6)";
    this.ctx.beginPath();
    this.ctx.roundRect(grabBarX, grabBarY, grabBarW, grabBarH, 2);
    this.ctx.fill();

    // Draw horizontal grab bar at the bottom of viewport for resizing height
    const hBarW = 50;
    const hBarH = 4;
    const hBarX = this.viewport.scrollLeft + (this.viewport.clientWidth - hBarW) / 2;
    const hBarY = this.canvasHeight - hBarH - 3; // 3px from the bottom edge
    
    this.ctx.fillStyle = "rgba(20, 20, 20, 0.8)";
    this.ctx.beginPath();
    this.ctx.roundRect(hBarX, hBarY, hBarW, hBarH, 2);
    this.ctx.fill();

    if (this._boxSelectRect) {
      const r = this._boxSelectRect;
      this.ctx.save();
      this.ctx.fillStyle = "rgba(120, 180, 255, 0.16)";
      this.ctx.strokeStyle = "rgba(160, 210, 255, 0.9)";
      this.ctx.lineWidth = 1.5;
      this.ctx.setLineDash([5, 3]);
      this.ctx.fillRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
      this.ctx.strokeRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
      this.ctx.restore();
    }

    this.updatePlayerUI();
  }

  drawAudioSegmentVisuals(ctx, seg, isSelected, yOffset, trackHeight, startX, pxWidth) {
    ctx.fillStyle = isSelected ? "#2a4a3a" : "#1a2a1a";
    ctx.fillRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

    if (seg.waveformPeaks && pxWidth > 0) {
      ctx.fillStyle = isSelected ? "rgba(100, 255, 100, 0.6)" : "rgba(100, 255, 100, 0.3)";
      const startRatio = seg.trimStart / seg.audioDurationFrames;
      const endRatio = (seg.trimStart + seg.length) / seg.audioDurationFrames;
      const peakCount = seg.waveformPeaks.length;
      const centerY = yOffset + trackHeight / 2;

      ctx.beginPath();
      for (let i = 0; i < pxWidth; i++) {
        const pixelRatio = i / pxWidth;
        const globalRatio = startRatio + pixelRatio * (endRatio - startRatio);
        const peakIdx = Math.floor(globalRatio * peakCount);

        if (peakIdx >= 0 && peakIdx < peakCount) {
          const val = seg.waveformPeaks[peakIdx];
          const amp = (val * (trackHeight - 12) / 2) * 0.9;
          ctx.fillRect(startX + i, centerY - amp, 1, amp * 2);
        }
      }
    }

    ctx.strokeStyle = isSelected ? "#4fff8f" : "#000";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

    if (isSelected) {
      ctx.fillStyle = "#4fff8f";
      ctx.beginPath();
      ctx.roundRect(startX, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(startX + pxWidth - 4, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
    }

    ctx.fillStyle = "#ccc";
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.save();
    ctx.beginPath();
    ctx.rect(startX, yOffset + 2, pxWidth, trackHeight - 3);
    ctx.clip();

    let text = seg.fileName || "Audio Track";
    const maxWidth = pxWidth - 12;
    if (ctx.measureText(text).width > maxWidth && maxWidth > 0) {
      while (text.length > 0 && ctx.measureText(text + "...").width > maxWidth) {
        text = text.slice(0, -1);
      }
      text = text + "...";
    }

    ctx.fillText(text, startX + 6, yOffset + 8);
    ctx.restore();
  }

  drawPromptSegmentVisuals(ctx, seg, isSelected, yOffset, trackHeight, startX, pxWidth) {
    ctx.fillStyle = isSelected ? "#17444a" : "#102d32";
    ctx.fillRect(startX, yOffset + 2, pxWidth, trackHeight - 3);
    ctx.strokeStyle = isSelected ? "#80e6f2" : "#22545c";
    ctx.lineWidth = isSelected ? 2 : 1.5;
    ctx.strokeRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

    if (isSelected) {
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.roundRect(startX, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(startX + pxWidth - 4, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(startX + 6, yOffset + 6, Math.max(0, pxWidth - 12), trackHeight - 12);
    ctx.clip();

    const label = seg.prompt || "Local Prompt";
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#d7fbff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    let text = label;
    const maxW = pxWidth - 18;
    if (maxW > 12 && ctx.measureText(text).width > maxW) {
      while (text.length > 0 && ctx.measureText(text + "...").width > maxW) {
        text = text.slice(0, -1);
      }
      text += "...";
    }
    if (pxWidth > 18) ctx.fillText(text, startX + 8, yOffset + trackHeight / 2);
    ctx.restore();
  }

  drawCameraSegmentVisuals(ctx, seg, isSelected, yOffset, trackHeight, startX, pxWidth) {
    ctx.fillStyle = isSelected ? "#23415c" : "#16283a";
    ctx.fillRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

    ctx.strokeStyle = isSelected ? "#6db7ff" : "#000";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

    if (isSelected) {
      ctx.fillStyle = "#6db7ff";
      ctx.beginPath();
      ctx.roundRect(startX, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(startX + pxWidth - 4, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(startX, yOffset + 2, pxWidth, trackHeight - 3);
    ctx.clip();

    ctx.fillStyle = isSelected ? "#dff0ff" : "#b8d7ef";
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    let text = cameraLabelForMotion(seg.cameraMotion || inferCameraMotionFromPrompt(seg.prompt));
    const maxWidth = pxWidth - 14;
    if (ctx.measureText(text).width > maxWidth && maxWidth > 0) {
      while (text.length > 0 && ctx.measureText(text + "...").width > maxWidth) {
        text = text.slice(0, -1);
      }
      text = text + "...";
    }

    ctx.fillText(text, startX + 7, yOffset + trackHeight / 2);
    ctx.restore();
  }

  drawControlSegmentVisuals(ctx, seg, isSelected, yOffset, trackHeight, startX, pxWidth) {
    ctx.fillStyle = isSelected ? "#4c2d68" : "#2a1b3a";
    ctx.fillRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

    ctx.strokeStyle = isSelected ? "#c78cff" : "#000";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

    if (isSelected) {
      ctx.fillStyle = "#c78cff";
      ctx.beginPath();
      ctx.roundRect(startX, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(startX + pxWidth - 4, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(startX, yOffset + 2, pxWidth, trackHeight - 3);
    ctx.clip();
    ctx.fillStyle = isSelected ? "#f1dfff" : "#d8baf2";
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    let text = `${seg.controlType || "control"} ${(seg.strength ?? 0.75).toFixed(2)}${seg.prompt ? ": " + seg.prompt : ""}`;
    const maxWidth = pxWidth - 14;
    if (ctx.measureText(text).width > maxWidth && maxWidth > 0) {
      while (text.length > 0 && ctx.measureText(text + "...").width > maxWidth) {
        text = text.slice(0, -1);
      }
      text = text + "...";
    }
    ctx.fillText(text, startX + 7, yOffset + trackHeight / 2);
    ctx.restore();
  }

  drawCutMarkers(ctx, totalFrames, width, activeCutSegId) {
    const cuts = [...(this.timeline.cutSegments || [])].sort((a, b) => (a.start ?? a.frame ?? 0) - (b.start ?? b.frame ?? 0));
    if (!cuts.length || totalFrames <= 0) return;
    const yTop = RULER_HEIGHT;
    const yBottom = this.canvasHeight;
    for (const cut of cuts) {
      const frame = clamp(Math.round(cut.start ?? cut.frame ?? 0), 0, totalFrames);
      const x = (frame / totalFrames) * width;
      const selected = this.isSegmentSelected("cut", cut.id, activeCutSegId);

      ctx.save();
      ctx.strokeStyle = selected ? "#ffef8a" : "rgba(255, 210, 75, 0.82)";
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.setLineDash(selected ? [] : [4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, yBottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = selected ? "#ffef8a" : "#d7a94f";
      ctx.beginPath();
      ctx.moveTo(x - 6, RULER_HEIGHT - 1);
      ctx.lineTo(x + 6, RULER_HEIGHT - 1);
      ctx.lineTo(x, RULER_HEIGHT + 8);
      ctx.closePath();
      ctx.fill();

      if (selected || width > 500) {
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = selected ? "#fff2a8" : "#d7a94f";
        ctx.fillText(cut.label || "CUT", x, RULER_HEIGHT + 10);
      }
      ctx.restore();
    }
  }

  getAutoCutGuideFrames() {
    if (!this.timeline.meta?.longAuto) return [];
    const plan = this.getLongAutoPlan();
    const frames = new Map();
    for (const seg of plan) {
      if (seg.start <= 0) continue;
      const reasons = seg.reasons || [];
      if (!reasons.length || reasons.includes("manual_cut") || reasons.includes("timeline_start")) continue;
      frames.set(seg.start, reasons);
    }
    return [...frames.entries()].map(([frame, reasons]) => ({ frame, reasons }));
  }

  drawAutoCutGuides(ctx, totalFrames, width) {
    const guides = this.getAutoCutGuideFrames();
    if (!guides.length || totalFrames <= 0) return;
    const yTop = RULER_HEIGHT;
    const yBottom = this.canvasHeight;
    ctx.save();
    ctx.strokeStyle = "rgba(135, 205, 255, 0.78)";
    ctx.lineWidth = 1.25;
    ctx.setLineDash([3, 5]);
    for (const guide of guides) {
      const frame = clamp(Math.round(guide.frame || 0), 0, totalFrames);
      if (frame <= 0 || frame >= totalFrames) continue;
      const x = (frame / totalFrames) * width;
      ctx.beginPath();
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, yBottom);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }


  // --- Interaction Logic ---
  hitCutMarker(mouseX, mouseY, tolerancePx = 7) {
    if (mouseY < RULER_HEIGHT - 2 || mouseY > this.canvasHeight) return null;
    const width = this.canvas.offsetWidth || this._lastWidth || 0;
    const totalFrames = this.getVisualDurationFrames();
    if (!width || totalFrames <= 0) return null;
    let best = null;
    for (let i = 0; i < (this.timeline.cutSegments || []).length; i++) {
      const cut = this.timeline.cutSegments[i];
      const frame = clamp(Math.round(cut.start ?? cut.frame ?? 0), 0, totalFrames);
      const x = (frame / totalFrames) * width;
      const dx = Math.abs(mouseX - x);
      if (dx <= tolerancePx && (!best || dx < best.dx)) {
        best = { type: "cut", index: i, track: "cut", dx };
      }
    }
    return best;
  }

  getCutSnapToleranceFrames() {
    const seconds = Number(this.timeline?.meta?.manualCutToleranceSeconds ?? 0.25);
    return Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0.25) * this.getFrameRate()));
  }

  snapFrameToCut(frame, opts = {}) {
    const totalFrames = opts.totalFrames ?? this.getVisualDurationFrames();
    const toleranceFrames = opts.toleranceFrames ?? this.getCutSnapToleranceFrames();
    const ignoreCutId = opts.ignoreCutId || null;
    if (!toleranceFrames || !(this.timeline.cutSegments || []).length) {
      return clamp(frame, 0, totalFrames);
    }

    let bestFrame = null;
    let bestDistance = Infinity;
    for (const cut of this.timeline.cutSegments || []) {
      if (ignoreCutId && cut.id === ignoreCutId) continue;
      const cutFrame = clamp(Math.round(cut.start ?? cut.frame ?? 0), 0, totalFrames);
      const distance = Math.abs(frame - cutFrame);
      if (distance <= toleranceFrames && distance < bestDistance) {
        bestFrame = cutFrame;
        bestDistance = distance;
      }
    }
    return bestFrame === null ? clamp(frame, 0, totalFrames) : bestFrame;
  }

  normalizeRect(a, b) {
    return {
      x1: Math.min(a.x, b.x),
      y1: Math.min(a.y, b.y),
      x2: Math.max(a.x, b.x),
      y2: Math.max(a.y, b.y),
    };
  }

  collectBoxSelection(rect) {
    const width = this.canvas.offsetWidth || this._lastWidth || 0;
    const totalFrames = this.getVisualDurationFrames();
    if (!width || totalFrames <= 0) return [];

    const selected = [];
    const intersects = (ax1, ay1, ax2, ay2) => ax2 >= rect.x1 && ax1 <= rect.x2 && ay2 >= rect.y1 && ay1 <= rect.y2;
    for (const track of ["image", "prompt", "camera", "control", "audio"]) {
      const y = this.getTrackY(track);
      const h = this.getTrackHeight(track);
      const arr = this.getTrackArray(track);
      arr.forEach((seg, index) => {
        const x1 = (seg.start / totalFrames) * width;
        const x2 = ((seg.start + seg.length) / totalFrames) * width;
        if (intersects(x1, y, x2, y + h)) selected.push({ track, index, id: seg.id });
      });
    }

    if (rect.y2 >= RULER_HEIGHT && rect.y1 <= this.canvasHeight) {
      (this.timeline.cutSegments || []).forEach((cut, index) => {
        const frame = clamp(Math.round(cut.start ?? cut.frame ?? 0), 0, totalFrames);
        const x = (frame / totalFrames) * width;
        if (x >= rect.x1 && x <= rect.x2) selected.push({ track: "cut", index, id: cut.id });
      });
    }
    return selected;
  }

  getHitTest(mouseX, mouseY) {
    const width = this.canvas.offsetWidth;
    const totalFrames = this.getVisualDurationFrames();

    // Check Playhead Handle first
    const playheadX = (this.currentFrame / totalFrames) * width;
    if (mouseY <= 24 && Math.abs(mouseX - playheadX) <= 12) {
      return { type: "playhead" };
    }

    if (mouseY <= RULER_HEIGHT) {
      return { type: "ruler" };
    }

    if (mouseY < RULER_HEIGHT || mouseY > this.canvasHeight) return null;

    const cutHit = this.hitCutMarker(mouseX, mouseY);
    if (cutHit) return cutHit;

    const trackType = this.getTrackTypeAtY(mouseY);
    if (!trackType) return null;
    const trackSegments = this.getTrackArray(trackType);

    if (trackSegments.length === 0) return null;

    // The variables width and totalFrames are already declared above.

    let sortedSegments = [...trackSegments]
      .map((s, i) => ({ ...s, originalIndex: i }))
      .sort((a, b) => a.start - b.start);

    const HANDLE_CORE = 4;

    for (let i = 0; i < sortedSegments.length; i++) {
      const seg = sortedSegments[i];
      const startX = (seg.start / totalFrames) * width;
      const pxWidth = (seg.length / totalFrames) * width;
      const endX = startX + pxWidth;

      const prevSeg = sortedSegments[i - 1];
      const nextSeg = sortedSegments[i + 1];

      const isLeftJoint = prevSeg && prevSeg.start + prevSeg.length === seg.start;
      if (!isLeftJoint) {
        if (Math.abs(mouseX - startX) <= HANDLE_HIT_PX) {
          return { type: "edge", index: seg.originalIndex, dir: "left", track: trackType };
        }
      }

      const isRightJoint = nextSeg && nextSeg.start === seg.start + seg.length;
      if (isRightJoint) {
        const dx = mouseX - endX;
        if (Math.abs(dx) <= HANDLE_HIT_PX) {
          if (dx < -HANDLE_CORE) {
            return { type: "edge", index: seg.originalIndex, dir: "right", track: trackType };
          } else if (dx > HANDLE_CORE) {
            return { type: "edge", index: nextSeg.originalIndex, dir: "left", track: trackType };
          } else {
            return { type: "joint", leftIndex: seg.originalIndex, rightIndex: nextSeg.originalIndex, track: trackType };
          }
        }
      } else {
        if (Math.abs(mouseX - endX) <= HANDLE_HIT_PX) {
          return { type: "edge", index: seg.originalIndex, dir: "right", track: trackType };
        }
      }
    }

    for (let i = 0; i < sortedSegments.length; i++) {
      const seg = sortedSegments[i];
      const startX = (seg.start / totalFrames) * width;
      const pxWidth = (seg.length / totalFrames) * width;
      const endX = startX + pxWidth;

      if (mouseX >= startX && mouseX < endX) {
        return { type: "center", index: seg.originalIndex, track: trackType };
      }
    }

    return null;
  }

  onMouseDown(e) {
    if (e.button !== 0) return;
    const { x, y } = this.getMousePos(e);

    const isOverDivider = Math.abs(y - (RULER_HEIGHT + this.blockHeight)) <= 4;
    if (isOverDivider) {
      this._isDragging = true;
      this._dragType = "divider";
      this._startBlockHeight = this.blockHeight;
      this._startY = y;
      return;
    }

    const isAtBottom = Math.abs(y - this.canvasHeight) <= 15;
    if (isAtBottom) {
      this._isDragging = true;
      this._dragType = "height_resize";
      this._startBlockHeight = this.blockHeight;
      this._startY = y;
      document.body.style.userSelect = "none";
      return;
    }

    const viewRect = this.viewport.getBoundingClientRect();
    const isAtRightEdge = Math.abs(e.clientX - viewRect.right) <= 20;
    if (isAtRightEdge) {
      this._isDragging = true;
      this._dragType = "width_resize";
      this._startNodeWidth = this.node.size[0];
      this._startX = e.clientX;
      document.body.style.userSelect = "none";
      return;
    }

    if (y >= RULER_HEIGHT && y <= this.canvasHeight) {
      const BTN_R = 12;
      const gapRegions = this.getGapRegions();
      for (let i = 0; i < gapRegions.length; i++) {
        const gap = gapRegions[i];
        if (gap.widthPx < BTN_R * 2 + 8) continue;
        const dx = x - gap.centerX, dy2 = y - gap.centerY;
        if (dx * dx + dy2 * dy2 <= BTN_R * BTN_R) {
          if (gap.track === "audio") {
            // Direct to audio upload
            this.promptAddAudioInGap(gap.frameStart, gap.frameEnd);
          } else if (gap.track === "prompt") {
            this.addSegmentInGap(gap.frameStart, gap.frameEnd, "prompt");
          } else if (gap.track === "camera") {
            this.addSegmentInGap(gap.frameStart, gap.frameEnd, "camera");
          } else if (gap.track === "control") {
            this.addSegmentInGap(gap.frameStart, gap.frameEnd, "control");
          } else {
            this.showGapMenu(e.clientX, e.clientY, gap);
          }
          return;
        }
      }
    }

    const hit = this.getHitTest(x, y);
    if (!hit) {
      if (y >= RULER_HEIGHT && y <= this.canvasHeight) {
        this._isDragging = true;
        this._dragType = "box_select";
        this._boxSelectStart = { x, y };
        this._boxSelectRect = this.normalizeRect(this._boxSelectStart, { x, y });
        this.clearMultiSelection();
        document.body.style.userSelect = "none";
      } else {
        // Only deselect if they clicked the same track but hit empty space
        const clickedTrack = this.getTrackTypeAtY(y);
        if (this.selectionType === clickedTrack) {
          this.selectedIndex = -1;
          this.clearMultiSelection();
          this.updateUIFromSelection();
        }
      }
      this.render();
      return;
    }

    if (hit.type === "playhead" || hit.type === "ruler") {
      this._isDragging = true;
      this._dragType = "playhead";
      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      let mouseFrameX = x * (totalFrames / logicalWidth);
      this.currentFrame = this.snapFrameToCut(mouseFrameX, { totalFrames });
      this.render();
      if (this.isPlaying) {
        this.playAudio();
      }
      return;
    }

    if (hit.type === "cut") {
      this.selectionType = "cut";
      this.selectedIndex = hit.index;
      this.clearMultiSelection();
      this.updateUIFromSelection();
      this._isDragging = true;
      this._dragType = "cut_move";
      this._dragStartX = x;
      this._dragTargetId = (this.timeline.cutSegments || [])[hit.index]?.id || null;
      this._dragInitialTimeline = JSON.parse(JSON.stringify(this.timeline.cutSegments || []));
      document.body.style.userSelect = "none";
      this.render();
      return;
    }

    this.selectionType = hit.track;
    this.clearMultiSelection();
    const targetArray = this.getTrackArray(hit.track);

    if (hit.type === "joint") {
      this.selectedIndex = hit.leftIndex;
      this.updateUIFromSelection();
      this._dragType = "joint";
      this._dragTargetId = targetArray[hit.leftIndex].id;
      this._dragTargetIdRight = targetArray[hit.rightIndex].id;
    } else if (hit.type === "center") {
      this.selectedIndex = hit.index;
      this.updateUIFromSelection();
      this._dragType = "center";
    } else {
      if (this.selectedIndex !== hit.index) {
        this.selectedIndex = hit.index;
        this.updateUIFromSelection();
      }
      this._dragType = hit.dir;
    }

    this._isDragging = true;
    this._previewSegments = null;
    this._dragStartX = x;
    this._dragInitialTimeline = JSON.parse(JSON.stringify(targetArray));

    if (hit.type !== "joint") {
      this._dragTargetId = targetArray[hit.index].id;
    }
    this.render();
  }

  onMouseMove(e) {
    const { x: mouseX, y: mouseY } = this.getMousePos(e);

    if (!this._isDragging) {
      let newHoveredGapIdx = -1;
      const BTN_R = 12;
      const gapRegions = this.getGapRegions();
      for (let i = 0; i < gapRegions.length; i++) {
        const gap = gapRegions[i];
        if (gap.widthPx < BTN_R * 2 + 8) continue;
        const dx = mouseX - gap.centerX, dy2 = mouseY - gap.centerY;
        if (dx * dx + dy2 * dy2 <= BTN_R * BTN_R) { newHoveredGapIdx = i; break; }
      }
      if (this._hoveredGapIdx !== newHoveredGapIdx) {
        this._hoveredGapIdx = newHoveredGapIdx;
        this.render();
      }

      const isOverDivider = Math.abs(mouseY - (RULER_HEIGHT + this.blockHeight)) <= 4;
      const isAtBottom = Math.abs(mouseY - this.canvasHeight) <= 15;
      const viewRect = this.viewport.getBoundingClientRect();
      const isAtRightEdge = Math.abs(e.clientX - viewRect.right) <= 20;
      const hit = this.getHitTest(mouseX, mouseY);
      if (isOverDivider || isAtBottom) {
        this.canvas.style.cursor = "ns-resize";
      } else if (isAtRightEdge) {
        this.canvas.style.cursor = "ew-resize";
      } else if (newHoveredGapIdx >= 0) {
        this.canvas.style.cursor = "pointer";
      } else if (hit?.type === "edge") {
        this.canvas.style.cursor = "ew-resize";
      } else if (hit?.type === "joint") {
        this.canvas.style.cursor = "col-resize";
      } else if (hit?.type === "center") {
        this.canvas.style.cursor = "grab";
      } else if (hit?.type === "cut") {
        this.canvas.style.cursor = "pointer";
      } else if (hit?.type === "playhead") {
        this.canvas.style.cursor = "ew-resize";
      } else {
        this.canvas.style.cursor = "default";
      }
      return;
    }

    if (this._dragType === "divider") {
      this.canvas.style.cursor = "ns-resize";
      const deltaY = mouseY - this._startY;

      const minBlockH = 50;
      this.blockHeight = Math.max(minBlockH, this._startBlockHeight + deltaY);
      this.canvasHeight = this.rulerHeight + this.blockHeight + PROMPT_TRACK_HEIGHT + this.cameraTrackHeight + this.controlTrackHeight + this.audioTrackHeight;
      this.canvas.style.height = `${this.canvasHeight}px`;

      this.resizeCanvas(this.canvas.offsetWidth);
      this.render();
      return;
    }

    if (this._dragType === "height_resize") {
      this.canvas.style.cursor = "ns-resize";
      const deltaY = mouseY - this._startY;

      this.blockHeight = Math.max(100, this._startBlockHeight + deltaY);
      this.canvasHeight = this.rulerHeight + this.blockHeight + PROMPT_TRACK_HEIGHT + this.cameraTrackHeight + this.controlTrackHeight + this.audioTrackHeight;

      this.canvas.style.height = `${this.canvasHeight}px`;

      this.resizeCanvas(this.canvas.offsetWidth);
      this.render();

      if (this.node && this.node.computeSize) {
        const sz = this.node.computeSize();
        this.node.size[1] = sz[1];
        if (window.app && window.app.graph) {
          window.app.graph.setDirtyCanvas(true, true);
        }
      }
      return;
    }

    if (this._dragType === "width_resize") {
      this.canvas.style.cursor = "ew-resize";
      const deltaX = e.clientX - this._startX;

      this.node.size[0] = Math.max(300, this._startNodeWidth + deltaX);

      if (window.app && window.app.graph) {
        window.app.graph.setDirtyCanvas(true, true);
      }
      return;
    }

    if (this._dragType === "box_select") {
      this.canvas.style.cursor = "crosshair";
      this._boxSelectRect = this.normalizeRect(this._boxSelectStart, { x: mouseX, y: mouseY });
      this.multiSelection = this.collectBoxSelection(this._boxSelectRect);
      this.render();
      return;
    }

    if (this._dragType === "playhead") {
      this.canvas.style.cursor = "ew-resize";
      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      let mouseFrameX = mouseX * (totalFrames / logicalWidth);
      this.currentFrame = this.snapFrameToCut(mouseFrameX, { totalFrames });
      this.render();
      if (this.isPlaying) {
        this.playAudio(); // Scrub (restart from new position)
      }
      return;
    }

    if (this._dragType === "cut_move") {
      this.canvas.style.cursor = "ew-resize";
      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      const dragDelta = Math.round((mouseX - this._dragStartX) * (totalFrames / logicalWidth));
      const initialCut = (this._dragInitialTimeline || []).find((cut) => cut.id === this._dragTargetId);
      const cut = (this.timeline.cutSegments || []).find((item) => item.id === this._dragTargetId);
      if (!initialCut || !cut) return;
      const initialFrame = Math.round(initialCut.start ?? initialCut.frame ?? 0);
      let nextFrame = this.snapFrameToCut(initialFrame + dragDelta, { totalFrames, ignoreCutId: this._dragTargetId });
      nextFrame = clamp(Math.round(nextFrame), 0, Math.max(0, totalFrames - 1));
      cut.start = nextFrame;
      cut.frame = nextFrame;
      this.render();
      return;
    }

    this.canvas.style.cursor = this._dragType === "center" ? "grabbing" :
      this._dragType === "joint" ? "col-resize" : "ew-resize";

    const logicalWidth = this.canvas.offsetWidth;
    const totalFrames = this.getVisualDurationFrames();
    const durationFrames = totalFrames;
    const dragDelta = Math.round((mouseX - this._dragStartX) * (totalFrames / logicalWidth));

    let t = JSON.parse(JSON.stringify(this._dragInitialTimeline));

    // --- Rolling Edit (Slide Edit) ---
    if (this._dragType === "joint") {
      let leftIdx = t.findIndex(s => s.id === this._dragTargetId);
      let rightIdx = t.findIndex(s => s.id === this._dragTargetIdRight);

      if (leftIdx >= 0 && rightIdx >= 0) {
        let origLeft = this._dragInitialTimeline.find(s => s.id === this._dragTargetId);
        let origRight = this._dragInitialTimeline.find(s => s.id === this._dragTargetIdRight);

        let maxDeltaRight = origRight.length - MIN_SEGMENT_LENGTH;
        let maxDeltaLeft = origLeft.length - MIN_SEGMENT_LENGTH;

        if (this.selectionType === "audio") {
          // Drag LEFT: right clip extends left by un-trimming its head.
          // Can only un-trim as much as the right clip has been trimmed (trimStart >= 0).
          maxDeltaLeft = Math.min(maxDeltaLeft, origRight.trimStart || 0);
          // Drag RIGHT: left clip extends right by consuming its remaining tail audio.
          // Can only extend as far as the left clip's unplayed tail allows.
          let availLeftTail = (origLeft.audioDurationFrames || origLeft.length) - ((origLeft.trimStart || 0) + origLeft.length);
          maxDeltaRight = Math.min(maxDeltaRight, availLeftTail);
        }

        const originalJointFrame = origLeft.start + origLeft.length;
        const snappedJointFrame = this.snapFrameToCut(originalJointFrame + dragDelta, { totalFrames });
        let safeDelta = clamp(snappedJointFrame - originalJointFrame, -maxDeltaLeft, maxDeltaRight);

        t[leftIdx].length = origLeft.length + safeDelta;
        t[rightIdx].start = origRight.start + safeDelta;
        t[rightIdx].length = origRight.length - safeDelta;

        if (this.selectionType === "audio") {
          t[rightIdx].trimStart = origRight.trimStart + safeDelta;
        }
      }
    }
    // --- Edge & Center Drags ---
    else {
      const targetIdx = t.findIndex((s) => s.id === this._dragTargetId);
      if (targetIdx < 0) return;

      if (this._dragType === "right") {
        const snappedEnd = this.snapFrameToCut(t[targetIdx].start + t[targetIdx].length + dragDelta, { totalFrames });
        let newLen = snappedEnd - t[targetIdx].start;
        let maxPossibleLength = totalFrames - t[targetIdx].start;
        let nextSeg = t.find(s => s.start >= t[targetIdx].start + t[targetIdx].length && s.id !== t[targetIdx].id);
        if (nextSeg) {
          maxPossibleLength = nextSeg.start - t[targetIdx].start;
        }

        if (this.selectionType === "audio") {
          maxPossibleLength = Math.min(maxPossibleLength, (t[targetIdx].audioDurationFrames || t[targetIdx].length) - (t[targetIdx].trimStart || 0));
        }

        t[targetIdx].length = Math.max(MIN_SEGMENT_LENGTH, Math.min(newLen, maxPossibleLength));

      } else if (this._dragType === "left") {
        let newStart = this.snapFrameToCut(t[targetIdx].start + dragDelta, { totalFrames });
        let minPossibleStart = 0;
        let prevSeg = t.slice().reverse().find(s => s.start + s.length <= t[targetIdx].start && s.id !== t[targetIdx].id);
        if (prevSeg) {
          minPossibleStart = prevSeg.start + prevSeg.length;
        }

        if (this.selectionType === "audio") {
          minPossibleStart = Math.max(minPossibleStart, t[targetIdx].start - (t[targetIdx].trimStart || 0));
        }

        let maxStart = t[targetIdx].start + t[targetIdx].length - MIN_SEGMENT_LENGTH;
        newStart = Math.max(minPossibleStart, Math.min(newStart, maxStart));

        let diff = newStart - t[targetIdx].start;
        t[targetIdx].start = newStart;
        t[targetIdx].length -= diff;
        if (this.selectionType === "audio") {
          t[targetIdx].trimStart += diff;
        }

      } else if (this._dragType === "center") {
        let initT = this._dragInitialTimeline;
        let dIdx = initT.findIndex(s => s.id === this._dragTargetId);
        if (dIdx < 0) return;
        let D = JSON.parse(JSON.stringify(initT[dIdx]));

        let D_mouse_start = this.snapFrameToCut(D.start + dragDelta, { totalFrames });
        let mouseFrameX = mouseX * (totalFrames / logicalWidth);

        t = this._applyCenterDragPhysics(initT, D.id, D_mouse_start, mouseFrameX, durationFrames, totalFrames, logicalWidth);
      }
    }

    this._previewSegments = t;
    this.updateUIFromSelection(); // Live update of trim values
    this.render();
  }

  _applyCenterDragPhysics(initT, D_id, D_mouse_start, mouseFrameX, durationFrames, totalFrames, logicalWidth) {
    let t_copy = JSON.parse(JSON.stringify(initT));
    let dIdx = t_copy.findIndex(s => s.id === D_id);
    if (dIdx < 0) return t_copy;

    let D = t_copy[dIdx];
    D_mouse_start = this.snapFrameToCut(D_mouse_start, { totalFrames });
    let D_clamped_start = clamp(D_mouse_start, 0, durationFrames - D.length);

    let baseSegments = t_copy.filter(s => s.id !== D.id);

    let insertIdx = baseSegments.length;
    for (let i = 0; i < baseSegments.length; i++) {
      let centerBase = baseSegments[i].start + baseSegments[i].length / 2;
      if (mouseFrameX < centerBase) {
        insertIdx = i;
        break;
      }
    }

    let leftBound = insertIdx > 0 ? baseSegments[insertIdx - 1].start + baseSegments[insertIdx - 1].length : 0;
    let rightBound = insertIdx < baseSegments.length ? baseSegments[insertIdx].start : durationFrames;

    if (rightBound - leftBound >= D.length) {
      D_clamped_start = clamp(D_clamped_start, leftBound, rightBound - D.length);
    } else {
      let gapCenter = (leftBound + rightBound) / 2;
      D_clamped_start = gapCenter - D.length / 2;
    }

    let t_test = [];
    for (let i = 0; i < insertIdx; i++) {
      t_test.push({ ...baseSegments[i], original_start: baseSegments[i].start });
    }
    t_test.push({ ...D, start: D_clamped_start, original_start: D_clamped_start });
    let D_index = insertIdx;

    for (let i = insertIdx; i < baseSegments.length; i++) {
      t_test.push({ ...baseSegments[i], original_start: baseSegments[i].start });
    }

    for (let i = D_index + 1; i < t_test.length; i++) {
      let prev = t_test[i - 1];
      t_test[i].start = Math.max(t_test[i].original_start, prev.start + prev.length);
    }

    for (let i = D_index - 1; i >= 0; i--) {
      let next = t_test[i + 1];
      t_test[i].start = Math.min(t_test[i].original_start, next.start - t_test[i].length);
    }

    let rightCursor = durationFrames;
    for (let i = t_test.length - 1; i >= 0; i--) {
      if (t_test[i].start + t_test[i].length > rightCursor) {
        t_test[i].start = rightCursor - t_test[i].length;
      }
      rightCursor = t_test[i].start;
    }
    let leftCursor = 0;
    for (let i = 0; i < t_test.length; i++) {
      if (t_test[i].start < leftCursor) {
        t_test[i].start = leftCursor;
      }
      leftCursor = t_test[i].start + t_test[i].length;
    }

    let result = t_test.map(s => {
      let clean = { ...s };
      delete clean.original_start;
      return clean;
    });

    let draggedPreview = result.find(s => s.id === D.id);
    if (draggedPreview) {
      draggedPreview.resolvedStart = draggedPreview.start;
    }

    return result;
  }

  onMouseUp(e) {
    document.body.style.userSelect = "";
    if (this._isDragging) {
      if (this._dragType === "box_select") {
        const picked = this.collectBoxSelection(this._boxSelectRect || { x1: 0, y1: 0, x2: 0, y2: 0 });
        this.multiSelection = picked;
        if (picked.length) {
          const primary = picked[picked.length - 1];
          this.selectionType = primary.track;
          this.selectedIndex = this.getTrackArray(primary.track).findIndex((seg) => seg.id === primary.id);
        } else {
          this.selectedIndex = -1;
        }
        this._isDragging = false;
        this._dragType = null;
        this._boxSelectStart = null;
        this._boxSelectRect = null;
        this.canvas.style.cursor = "default";
        this.updateUIFromSelection();
        this.render();
        return;
      }

      if (this._dragType === "cut_move") {
        const movedId = this._dragTargetId;
        const tolerance = Math.max(1, this.getCutSnapToleranceFrames());
        let cuts = [...(this.timeline.cutSegments || [])].sort((a, b) => (a.start ?? a.frame ?? 0) - (b.start ?? b.frame ?? 0));
        const moved = cuts.find((cut) => cut.id === movedId);
        if (moved) {
          const movedFrame = Math.round(moved.start ?? moved.frame ?? 0);
          const duplicate = cuts.find((cut) => cut.id !== movedId && Math.abs(Math.round(cut.start ?? cut.frame ?? 0) - movedFrame) <= tolerance);
          if (duplicate) {
            cuts = cuts.filter((cut) => cut.id !== movedId);
            this.timeline.cutSegments = cuts;
            this.selectedIndex = cuts.findIndex((cut) => cut.id === duplicate.id);
          } else {
            this.timeline.cutSegments = cuts;
            this.selectedIndex = cuts.findIndex((cut) => cut.id === movedId);
          }
        }
        this._isDragging = false;
        this._dragType = null;
        this._dragTargetId = null;
        this._dragInitialTimeline = null;
        this.canvas.style.cursor = "default";
        this.updateUIFromSelection();
        this.commitChanges();
        return;
      }

      if (this._previewSegments) {
        const targetArray = this.getTrackArray(this.selectionType);

        const mappedArray = this._previewSegments.map(ps => {
          const orig = targetArray.find(s => s.id === ps.id);
          let finalStart = ps.resolvedStart !== undefined ? ps.resolvedStart : ps.start;
          let newPs = { ...ps, start: finalStart };
          if (orig && orig.imgObj) newPs.imgObj = orig.imgObj;
          delete newPs.resolvedStart;
          return newPs;
        });

        this.setTrackArray(this.selectionType, mappedArray);
        if (this._dragTargetId) this.selectedIndex = this.getTrackArray(this.selectionType).findIndex(s => s.id === this._dragTargetId);
      }

      this._isDragging = false;
      this._previewSegments = null;
      this._ghostTrack = null;
      this._dragType = null;
      this.canvas.style.cursor = "default";
      this.commitChanges();
    }
  }

  // --- Backend Data Sync ---
  commitChanges(skipRender = false) {
    let sortedSegments = [...this.timeline.segments].sort((a, b) => a.start - b.start);
    let sortedPromptSegments = [...this.timeline.promptSegments].sort((a, b) => a.start - b.start);
    let sortedCameraSegments = [...this.timeline.cameraSegments].sort((a, b) => a.start - b.start);
    let sortedControlSegments = [...this.timeline.controlSegments].sort((a, b) => a.start - b.start);
    let sortedCutSegments = [...(this.timeline.cutSegments || [])].sort((a, b) => (a.start ?? a.frame ?? 0) - (b.start ?? b.frame ?? 0));
    const durationFrames = this.getDurationFrames();

    const contiguousLengths = [];
    const contiguousPrompts = [];
    const neutralGapPrompt = "maintain the global scene and current visual continuity";
    const cameraPrompt = (seg) => {
      const motion = CAMERA_MOTION_BY_ID[seg.cameraMotion] ? seg.cameraMotion : inferCameraMotionFromPrompt(seg.prompt);
      return cameraPromptForMotion(motion);
    };
    const cameraLabel = (seg) => {
      const prompt = cameraPrompt(seg);
      return prompt ? `Camera: ${prompt}` : "";
    };
    const controlLabel = (seg) => {
      const kind = seg.controlType || "control";
      const strength = (seg.strength ?? 0.75).toFixed(2);
      const prompt = (seg.prompt || "").trim();
      return `IC-LoRA ${kind} strength ${strength}${prompt ? ": " + prompt : ""}`;
    };
    this.renumberReferences();
    const referenceHints = (this.timeline.referenceImages || [])
      .map((ref) => {
        const note = (ref.note || "").trim();
        return note ? `Reference ${ref.refName}: ${note}` : "";
      })
      .filter(Boolean);

    const hasPrompting =
      sortedPromptSegments.some(s => s.start < durationFrames && (s.prompt || "").trim()) ||
      sortedCameraSegments.some(s => s.start < durationFrames && cameraPrompt(s)) ||
      sortedControlSegments.some(s => s.start < durationFrames && ((s.prompt || "").trim() || s.controlType));

    if (hasPrompting) {
      const cuts = new Set([0, durationFrames]);
      const addCuts = (seg) => {
        const start = clamp(Math.round(seg.start || 0), 0, durationFrames);
        const end = clamp(Math.round((seg.start || 0) + (seg.length || 0)), 0, durationFrames);
        if (end > start) {
          cuts.add(start);
          cuts.add(end);
        }
      };
      sortedPromptSegments.forEach(addCuts);
      sortedCameraSegments.forEach(addCuts);
      sortedControlSegments.forEach(addCuts);

      const orderedCuts = [...cuts].sort((a, b) => a - b);
      for (let i = 0; i < orderedCuts.length - 1; i++) {
        const start = orderedCuts[i];
        const end = orderedCuts[i + 1];
        if (end <= start) continue;

        const activeLocalPrompts = sortedPromptSegments
          .filter(seg => seg.start < end && seg.start + seg.length > start)
          .map(seg => (seg.prompt || "").trim())
          .filter(Boolean);

        const activeCameraPrompts = sortedCameraSegments
          .filter(cam => cam.start < end && cam.start + cam.length > start)
          .map(cameraLabel);

        const activeControlPrompts = sortedControlSegments
          .filter(ctrl => ctrl.start < end && ctrl.start + ctrl.length > start)
          .map(controlLabel);

        const parts = [...activeLocalPrompts, ...activeCameraPrompts, ...activeControlPrompts, ...referenceHints].filter(Boolean);
        contiguousLengths.push(end - start);
        contiguousPrompts.push((parts.length > 0 ? parts : [neutralGapPrompt]).join(". "));
      }
    }

    const toSave = {
      segments: sortedSegments.map(s => {
        const { imgObj, prompt, ...rest } = s;
        return rest;
      }),
      promptSegments: sortedPromptSegments.map(s => ({ ...s })),
      referenceImages: (this.timeline.referenceImages || []).map(s => {
        const { imgObj, ...rest } = s;
        return rest;
      }),
      cameraSegments: (this.timeline.cameraSegments || []).map(s => {
        const motion = CAMERA_MOTION_BY_ID[s.cameraMotion] ? s.cameraMotion : inferCameraMotionFromPrompt(s.prompt);
        return { ...s, cameraMotion: motion, prompt: cameraPromptForMotion(motion) };
      }),
      controlSegments: (this.timeline.controlSegments || []).map(s => ({ ...s })),
      audioSegments: (this.timeline.audioSegments || []).map(s => ({ ...s })),
      cutSegments: sortedCutSegments.map(s => ({
        id: s.id,
        type: "cut",
        start: Math.max(0, Math.round(s.start ?? s.frame ?? 0)),
        frame: Math.max(0, Math.round(s.start ?? s.frame ?? 0)),
        label: s.label || "CUT",
      })),
      meta: (this.timeline.meta && typeof this.timeline.meta === "object") ? { ...this.timeline.meta } : {}
    };
    if (toSave.meta.longAuto && typeof toSave.meta.autoCut !== "boolean") {
      toSave.meta.autoCut = true;
    }
    if (toSave.meta.longAuto) {
      const rawMaxSegmentSeconds = Number(toSave.meta.maxSegmentSeconds);
      toSave.meta.maxSegmentSeconds = clamp(
        Number.isFinite(rawMaxSegmentSeconds) && rawMaxSegmentSeconds > 0 ? rawMaxSegmentSeconds : 15,
        3,
        60
      );
    }

    const jsonStr = JSON.stringify(toSave);
    if (this.timelineDataWidget) this.timelineDataWidget.value = jsonStr;
    this.updateLongAutoUI();

    if (this.localPromptsWidget) {
      this.localPromptsWidget.value = contiguousPrompts.join(" | ");
    }
    if (this.segmentLengthsWidget) {
      this.segmentLengthsWidget.value = contiguousLengths.join(",");
    }

    if (this.guideStrengthWidget) {
      const imgStrengths = sortedSegments
        .map(s => (s.guideStrength !== undefined ? s.guideStrength : 1.0).toFixed(2));
      this.guideStrengthWidget.value = imgStrengths.join(",");
    }

    this.renderReferenceChannel();

    // Keep zoom slider max in sync with the current timeline duration.
    this.updateZoomSliderMax();

    setTimeout(() => {
      if (this.node && this.node.computeSize) {
        const sz = this.node.computeSize();
        this.node.size[1] = sz[1];
        if (app.graph) app.graph.setDirtyCanvas(true, true);
      }
    }, 0);

    if (!skipRender) this.render();
  }

  // --- Gap Region Calculation ---
  getGapRegions() {
    const totalFrames = this.getVisualDurationFrames();
    const outputFrames = this.getDurationFrames();
    const width = this.canvas.offsetWidth || this._lastWidth || 0;
    const gaps = [];
    if (!width) return gaps;

    // Image gaps
    let cursor = 0;
    const sortedImg = [...this.timeline.segments].sort((a, b) => a.start - b.start);
    for (const seg of sortedImg) {
      if (seg.start > cursor) {
        const x0 = (cursor / totalFrames) * width;
        const x1 = (seg.start / totalFrames) * width;
        gaps.push({ track: 'image', frameStart: cursor, frameEnd: seg.start, centerX: (x0 + x1) / 2, centerY: RULER_HEIGHT + this.blockHeight / 2, widthPx: x1 - x0 });
      }
      cursor = seg.start + seg.length;
    }
    if (cursor < outputFrames) {
      const x0 = (cursor / totalFrames) * width;
      const x1 = (outputFrames / totalFrames) * width;
      gaps.push({ track: 'image', frameStart: cursor, frameEnd: outputFrames, centerX: (x0 + x1) / 2, centerY: RULER_HEIGHT + this.blockHeight / 2, widthPx: x1 - x0 });
    }

    // Local prompt gaps
    cursor = 0;
    const sortedPrompt = [...this.timeline.promptSegments].sort((a, b) => a.start - b.start);
    for (const seg of sortedPrompt) {
      if (seg.start > cursor) {
        const x0 = (cursor / totalFrames) * width;
        const x1 = (seg.start / totalFrames) * width;
        gaps.push({ track: 'prompt', frameStart: cursor, frameEnd: seg.start, centerX: (x0 + x1) / 2, centerY: this.getTrackCenterY("prompt"), widthPx: x1 - x0 });
      }
      cursor = seg.start + seg.length;
    }
    if (cursor < outputFrames) {
      const x0 = (cursor / totalFrames) * width;
      const x1 = (outputFrames / totalFrames) * width;
      gaps.push({ track: 'prompt', frameStart: cursor, frameEnd: outputFrames, centerX: (x0 + x1) / 2, centerY: this.getTrackCenterY("prompt"), widthPx: x1 - x0 });
    }

    // Camera gaps
    cursor = 0;
    const sortedCam = [...this.timeline.cameraSegments].sort((a, b) => a.start - b.start);
    for (const seg of sortedCam) {
      if (seg.start > cursor) {
        const x0 = (cursor / totalFrames) * width;
        const x1 = (seg.start / totalFrames) * width;
        gaps.push({ track: 'camera', frameStart: cursor, frameEnd: seg.start, centerX: (x0 + x1) / 2, centerY: this.getTrackCenterY("camera"), widthPx: x1 - x0 });
      }
      cursor = seg.start + seg.length;
    }
    if (cursor < outputFrames) {
      const x0 = (cursor / totalFrames) * width;
      const x1 = (outputFrames / totalFrames) * width;
      gaps.push({ track: 'camera', frameStart: cursor, frameEnd: outputFrames, centerX: (x0 + x1) / 2, centerY: this.getTrackCenterY("camera"), widthPx: x1 - x0 });
    }

    // IC-LoRA control gaps
    cursor = 0;
    const sortedCtrl = [...this.timeline.controlSegments].sort((a, b) => a.start - b.start);
    for (const seg of sortedCtrl) {
      if (seg.start > cursor) {
        const x0 = (cursor / totalFrames) * width;
        const x1 = (seg.start / totalFrames) * width;
        gaps.push({ track: 'control', frameStart: cursor, frameEnd: seg.start, centerX: (x0 + x1) / 2, centerY: this.getTrackCenterY("control"), widthPx: x1 - x0 });
      }
      cursor = seg.start + seg.length;
    }
    if (cursor < outputFrames) {
      const x0 = (cursor / totalFrames) * width;
      const x1 = (outputFrames / totalFrames) * width;
      gaps.push({ track: 'control', frameStart: cursor, frameEnd: outputFrames, centerX: (x0 + x1) / 2, centerY: this.getTrackCenterY("control"), widthPx: x1 - x0 });
    }

    // Audio gaps
    cursor = 0;
    const sortedAud = [...this.timeline.audioSegments].sort((a, b) => a.start - b.start);
    for (const seg of sortedAud) {
      if (seg.start > cursor) {
        const x0 = (cursor / totalFrames) * width;
        const x1 = (seg.start / totalFrames) * width;
        gaps.push({ track: 'audio', frameStart: cursor, frameEnd: seg.start, centerX: (x0 + x1) / 2, centerY: this.getTrackCenterY("audio"), widthPx: x1 - x0 });
      }
      cursor = seg.start + seg.length;
    }
    if (cursor < outputFrames) {
      const x0 = (cursor / totalFrames) * width;
      const x1 = (outputFrames / totalFrames) * width;
      gaps.push({ track: 'audio', frameStart: cursor, frameEnd: outputFrames, centerX: (x0 + x1) / 2, centerY: this.getTrackCenterY("audio"), widthPx: x1 - x0 });
    }

    return gaps;
  }

  promptAddAudioInGap(frameStart, frameEnd) {
    const fi = document.createElement("input");
    fi.type = "file";
    fi.accept = "audio/*";
    fi.addEventListener("change", (ev) => {
      if (ev.target.files?.[0]) this.handleAudioUpload([ev.target.files[0]], frameStart);
    });
    fi.click();
  }

  // --- Context Menu ---
  onContextMenu(e) {
    e.preventDefault();
    const { x: mouseX, y: mouseY } = this.getMousePos(e);

    const clickedTrackType = this.getTrackTypeAtY(mouseY);
    const isAudioTrack = clickedTrackType === "audio";
    const isImageTrack = clickedTrackType === "image";
    const isPromptTrack = clickedTrackType === "prompt";
    const isCameraTrack = clickedTrackType === "camera";
    const isControlTrack = clickedTrackType === "control";

    const logicalWidth = this.canvas.offsetWidth || 1;
    const totalFrames = this.getVisualDurationFrames();
    const cursor = mouseX * (totalFrames / logicalWidth);

    const cutHit = this.hitCutMarker(mouseX, mouseY);
    if (cutHit) {
      const cutSeg = (this.timeline.cutSegments || [])[cutHit.index];
      if (cutSeg) {
        this.showContextMenu(e.clientX, e.clientY, cutSeg, "cut");
        return;
      }
    }

    let clickedSeg = null;
    let trackType = "";

    if (isAudioTrack) {
      clickedSeg = this.timeline.audioSegments.find(s => cursor >= s.start && cursor <= s.start + s.length);
      trackType = "audio";
    } else if (isPromptTrack) {
      clickedSeg = this.timeline.promptSegments.find(s => cursor >= s.start && cursor <= s.start + s.length);
      trackType = "prompt";
    } else if (isCameraTrack) {
      clickedSeg = this.timeline.cameraSegments.find(s => cursor >= s.start && cursor <= s.start + s.length);
      trackType = "camera";
    } else if (isControlTrack) {
      clickedSeg = this.timeline.controlSegments.find(s => cursor >= s.start && cursor <= s.start + s.length);
      trackType = "control";
    } else if (isImageTrack) {
      clickedSeg = this.timeline.segments.find(s => cursor >= s.start && cursor <= s.start + s.length);
      trackType = clickedSeg ? clickedSeg.type : "";
    }

    if (clickedSeg) {
      this.showContextMenu(e.clientX, e.clientY, clickedSeg, trackType);
    } else if (isAudioTrack || isImageTrack || isPromptTrack || isCameraTrack || isControlTrack) {
      const gapRegions = this.getGapRegions();
      const currentTrack = clickedTrackType;
      let gap = gapRegions.find(g => cursor >= g.frameStart && cursor <= g.frameEnd && g.track === currentTrack);

      if (!gap) {
        const startFrame = Math.round(cursor);
        gap = {
          track: currentTrack,
          frameStart: startFrame,
          frameEnd: startFrame + Math.max(1, this.getFrameRate())
        };
      }
      gap.clickedFrame = cursor;

      this.showGapContextMenu(e.clientX, e.clientY, gap);
    }
  }

  showContextMenu(clientX, clientY, seg, trackType) {
    this.dismissContextMenu();
    const menu = document.createElement("div");
    menu.className = "pr-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const isImage = trackType === "image" && seg.imageB64;

    if (isImage) {
      const copyBtn = document.createElement("button");
      copyBtn.className = "pr-gap-menu-btn";
      copyBtn.innerHTML = `Copy Image`;
      copyBtn.onclick = async () => {
        try {
          const res = await fetch(seg.imageB64);
          const blob = await res.blob();
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        } catch (err) {
          console.error("Failed to copy image", err);
        }
        this.dismissContextMenu();
      };
      menu.appendChild(copyBtn);

      const saveBtn = document.createElement("button");
      saveBtn.className = "pr-gap-menu-btn";
      saveBtn.innerHTML = `Save Image`;
      saveBtn.onclick = () => {
        const a = document.createElement("a");
        a.href = seg.imageB64;
        a.download = "timeline_image.jpg";
        a.click();
        this.dismissContextMenu();
      };
      menu.appendChild(saveBtn);

      const openBtn = document.createElement("button");
      openBtn.className = "pr-gap-menu-btn";
      openBtn.innerHTML = `Open Image in New Tab`;
      openBtn.onclick = () => {
        const win = window.open();
        if (win) {
          win.document.write(`<body style="margin:0;display:flex;justify-content:center;align-items:center;background:#0e0e0e;height:100vh;"><img style="max-width:100%;max-height:100%;" src="${seg.imageB64}" /></body>`);
          win.document.close();
        }
        this.dismissContextMenu();
      };
      menu.appendChild(openBtn);
    }

    if (trackType !== "audio" && trackType !== "image" && trackType !== "cut") {
      const copyPromptBtn = document.createElement("button");
      copyPromptBtn.className = "pr-gap-menu-btn";
      copyPromptBtn.innerHTML = `Copy Prompt`;
      copyPromptBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(seg.prompt || "");
        } catch (err) {
          console.error("Failed to copy prompt", err);
        }
        this.dismissContextMenu();
      };
      menu.appendChild(copyPromptBtn);
    }

    const copySegBtn = document.createElement("button");
    copySegBtn.className = "pr-gap-menu-btn";
    copySegBtn.innerHTML = `Copy Segment`;
    copySegBtn.onclick = () => {
      this._copiedSegment = { ...seg, id: Date.now().toString() + Math.random().toString(36).substr(2, 5) };
      this._copiedSegmentTrack = ["audio", "control", "camera", "prompt", "cut"].includes(trackType) ? trackType : "image";
      this.dismissContextMenu();
    };
    menu.appendChild(copySegBtn);

    const currentTrack = ["audio", "control", "camera", "prompt", "cut"].includes(trackType) ? trackType : "image";
    if (this._copiedSegment && this._copiedSegmentTrack === currentTrack) {
      const pasteReplaceBtn = document.createElement("button");
      pasteReplaceBtn.className = "pr-gap-menu-btn";
      pasteReplaceBtn.innerHTML = `Paste & Replace`;
      pasteReplaceBtn.onclick = () => {
        const newSeg = {
          ...this._copiedSegment,
          id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
          start: seg.start,
          length: this._copiedSegment.length
        };
        const targetArray = this.getTrackArray(currentTrack);
        const idx = targetArray.findIndex(s => s.id === seg.id);
        if (idx >= 0) targetArray[idx] = newSeg;
        this.commitChanges();
        this.dismissContextMenu();
      };
      menu.appendChild(pasteReplaceBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.className = "pr-gap-menu-btn";
    delBtn.innerHTML = t("delete");
    delBtn.style.color = "#ff4444";
    delBtn.onclick = () => {
      this.selectionType = currentTrack;
      const list = this.getTrackArray(currentTrack);
      this.selectedIndex = list.findIndex(s => s.id === seg.id);
      this.deleteSelectedSegment();
      this.dismissContextMenu();
    };
    menu.appendChild(delBtn);

    document.body.appendChild(menu);
    this._contextMenu = menu;

    setTimeout(() => {
      this._contextMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissContextMenu(); };
      document.addEventListener("pointerdown", this._contextMenuDismisser, true);
    }, 0);
  }

  showGapContextMenu(clientX, clientY, gap) {
    this.dismissContextMenu();
    const menu = document.createElement("div");
    menu.className = "pr-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const currentTrack = gap.track === "audio" ? "audio" : (gap.track === "control" ? "control" : (gap.track === "camera" ? "camera" : (gap.track === "prompt" ? "prompt" : "image")));

    const clickedFrame = Math.max(0, Math.round(this.snapFrameToCut(gap.clickedFrame !== undefined ? gap.clickedFrame : gap.frameStart)));
    const cutBtn = document.createElement("button");
    cutBtn.className = "pr-gap-menu-btn";
    cutBtn.innerHTML = `${ICONS.cut} ${t("manualCut")}`;
    cutBtn.onclick = () => {
      this.addCutAtFrame(clickedFrame);
      this.dismissContextMenu();
    };
    menu.appendChild(cutBtn);

    if (this._copiedSegment && this._copiedSegmentTrack === currentTrack) {
      const pasteBtn = document.createElement("button");
      pasteBtn.className = "pr-gap-menu-btn";
      pasteBtn.innerHTML = `Paste Segment`;
      pasteBtn.onclick = () => {
        const startFrame = clamp(
          Math.round(this.snapFrameToCut(gap.clickedFrame !== undefined ? gap.clickedFrame : gap.frameStart)),
          gap.frameStart,
          Math.max(gap.frameStart, gap.frameEnd - 1)
        );
        const gapLength = gap.frameEnd - startFrame;

        const newSeg = {
          ...this._copiedSegment,
          id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
          start: startFrame,
          length: Math.min(this._copiedSegment.length, gapLength)
        };
        const targetArray = this.getTrackArray(currentTrack);
        targetArray.push(newSeg);
        targetArray.sort((a, b) => a.start - b.start);
        this.commitChanges();
        this.dismissContextMenu();
      };
      menu.appendChild(pasteBtn);
    }

    if (currentTrack === "image") {
      const imgBtn = document.createElement("button");
      imgBtn.className = "pr-gap-menu-btn";
      imgBtn.innerHTML = `${ICONS.upload} Keyframe Segment`;
      imgBtn.onclick = () => {
        this.dismissContextMenu();
        const fi = document.createElement("input");
        fi.type = "file"; fi.accept = "image/*";
        fi.addEventListener("change", (ev) => {
          if (ev.target.files?.[0]) {
            const gapLength = gap.frameEnd - gap.frameStart;
            this.handleImageUpload([ev.target.files[0]], gap.frameStart, gapLength);
          }
        });
        fi.click();
      };
      menu.appendChild(imgBtn);
    } else if (currentTrack === "prompt") {
      const promptBtn = document.createElement("button");
      promptBtn.className = "pr-gap-menu-btn";
      promptBtn.innerHTML = `${ICONS.text} ${t("localPromptSegment")}`;
      promptBtn.onclick = () => {
        this.addSegmentInGap(gap.frameStart, gap.frameEnd, "prompt");
        this.dismissContextMenu();
      };
      menu.appendChild(promptBtn);
    } else if (currentTrack === "camera") {
      const cameraBtn = document.createElement("button");
      cameraBtn.className = "pr-gap-menu-btn";
      cameraBtn.innerHTML = `${ICONS.camera} ${t("cameraSegment")}`;
      cameraBtn.onclick = () => {
        this.addSegmentInGap(gap.frameStart, gap.frameEnd, "camera");
        this.dismissContextMenu();
      };
      menu.appendChild(cameraBtn);
    } else if (currentTrack === "control") {
      const controlBtn = document.createElement("button");
      controlBtn.className = "pr-gap-menu-btn";
      controlBtn.innerHTML = `${ICONS.control} ${t("icLoraControl")}`;
      controlBtn.onclick = () => {
        this.addSegmentInGap(gap.frameStart, gap.frameEnd, "control");
        this.dismissContextMenu();
      };
      menu.appendChild(controlBtn);
    }

    document.body.appendChild(menu);
    this._contextMenu = menu;
    setTimeout(() => {
      this._contextMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissContextMenu(); };
      document.addEventListener("pointerdown", this._contextMenuDismisser, true);
    }, 0);
  }
  dismissContextMenu() {
    if (this._contextMenu) { this._contextMenu.remove(); this._contextMenu = null; }
    if (this._contextMenuDismisser) { document.removeEventListener("pointerdown", this._contextMenuDismisser, true); this._contextMenuDismisser = null; }
  }

  // --- Gap Popup Menu ---
  showGapMenu(clientX, clientY, gap) {
    this.dismissGapMenu();
    const menu = document.createElement("div");
    menu.className = "pr-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const imgBtn = document.createElement("button");
    imgBtn.className = "pr-gap-menu-btn";
    imgBtn.innerHTML = `${ICONS.upload} Keyframe Segment`;
    imgBtn.addEventListener("click", () => {
      this.dismissGapMenu();
      const fi = document.createElement("input");
      fi.type = "file"; fi.accept = "image/*";
      fi.addEventListener("change", (ev) => {
        if (ev.target.files?.[0]) {
          const gapLength = gap.frameEnd - gap.frameStart;
          this.handleImageUpload([ev.target.files[0]], gap.frameStart, gapLength);
        }
      });
      fi.click();
    });

    menu.appendChild(imgBtn);
    const currentTrack = gap.track === "audio" ? "audio" : (gap.track === "control" ? "control" : (gap.track === "camera" ? "camera" : (gap.track === "prompt" ? "prompt" : "image")));
    if (this._copiedSegment && this._copiedSegmentTrack === currentTrack) {
      const pasteBtn = document.createElement("button");
      pasteBtn.className = "pr-gap-menu-btn";
      pasteBtn.innerHTML = `Paste Segment`;
      pasteBtn.onclick = () => {
        const startFrame = clamp(
          Math.round(this.snapFrameToCut(gap.frameStart)),
          gap.frameStart,
          Math.max(gap.frameStart, gap.frameEnd - 1)
        );
        const gapLength = gap.frameEnd - startFrame;

        let finalLength = Math.min(this._copiedSegment.length, gapLength);
        if (currentTrack === "image") {
          finalLength = gapLength;
        }

        const newSeg = {
          ...this._copiedSegment,
          id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
          start: startFrame,
          length: finalLength
        };
        const targetArray = this.getTrackArray(currentTrack);
        targetArray.push(newSeg);
        targetArray.sort((a, b) => a.start - b.start);
        this.commitChanges();
        this.dismissGapMenu();
      };
      menu.appendChild(pasteBtn);
    }

    document.body.appendChild(menu);
    this._gapMenu = menu;
    setTimeout(() => {
      this._gapMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissGapMenu(); };
      document.addEventListener("pointerdown", this._gapMenuDismisser, true);
    }, 0);
  }

  dismissGapMenu() {
    if (this._gapMenu) { this._gapMenu.remove(); this._gapMenu = null; }
    if (this._gapMenuDismisser) { document.removeEventListener("pointerdown", this._gapMenuDismisser, true); this._gapMenuDismisser = null; }
  }

  // --- Settings Menu ---
  // Widgets that are managed by the settings menu (hidden from node by default).
  get _settingsWidgetNames() {
    return [
      "display_mode", "duration_frames", "duration_seconds", "frame_rate", "custom_width", "custom_height", "resize_method",
      "epsilon", "divisible_by", "img_compression",
    ];
  }

  // Hide all settings widgets on the node (called on init).
  hideSettingsWidgets() {
    for (const name of this._settingsWidgetNames) {
      const w = this.node.widgets?.find(w => w.name === name);
      if (w) hideWidget(w);

      // Also remove corresponding input slot if it exists and is NOT connected
      // to prevent overlapping issues in classic ComfyUI (nodes v1)
      if (this.node.inputs) {
        const inputIdx = this.node.inputs.findIndex(i => i.name === name);
        if (inputIdx !== -1) {
          const input = this.node.inputs[inputIdx];
          if (input.link == null) {
            this.node.removeInput(inputIdx);
          }
        }
      }
    }
    this.updateWidgetVisibility();

    // Workaround: toggle display mode to force ComfyUI to refresh the node
    if (this.displayModeWidget) {
      const origVal = this.displayModeWidget.value;
      const otherVal = origVal === "frames" ? "seconds" : "frames";

      this.displayModeWidget.value = otherVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(otherVal);

      this.displayModeWidget.value = origVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(origVal);
    }
  }

  // Restore all settings widgets on the node.
  showSettingsWidgets() {
    for (const name of this._settingsWidgetNames) {
      const w = this.node.widgets?.find(w => w.name === name);
      if (!w) continue;
      
      const typeMap = {
        display_mode: "combo", epsilon: "FLOAT", divisible_by: "INT",
        img_compression: "INT",
        duration_frames: "INT", duration_seconds: "FLOAT", frame_rate: "INT",
        custom_width: "INT", custom_height: "INT", resize_method: "combo",
      };
      w.type = typeMap[name] || w._origType || "number";
      w.hidden = false;
      if (w.options) w.options.hidden = false;
      delete w.computeSize;
      if (w.element) w.element.style.display = "";
    }
    this.updateWidgetVisibility();

    // Workaround: toggle display mode to force ComfyUI to refresh the node
    if (this.displayModeWidget) {
      const origVal = this.displayModeWidget.value;
      const otherVal = origVal === "frames" ? "seconds" : "frames";

      this.displayModeWidget.value = otherVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(otherVal);

      this.displayModeWidget.value = origVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(origVal);
    }
  }

  _makeSettingRow(label, inputEl) {
    const row = document.createElement("div");
    row.className = "pr-settings-row";
    const lbl = document.createElement("span");
    lbl.className = "pr-settings-label";
    lbl.textContent = label;
    row.appendChild(lbl);
    row.appendChild(inputEl);
    return row;
  }

  buildLongAutoSegmentList(plan) {
    const list = document.createElement("div");
    list.className = "pr-segment-list";
    const activeIdx = parseInt(this.timeline.meta?.activeSegmentIndex || 0, 10) || 0;
    const refreshFloatingMenu = () => {
      const anchor = this._settingsAnchorEl;
      const wasSegmentsMenu = !!this._segmentsMenuOpen;
      this.dismissSettingsMenu();
      if (!anchor) return;
      if (wasSegmentsMenu) this.showSegmentsMenu(anchor);
      else this.showSettingsMenu(anchor);
    };

    for (const seg of plan) {
      const record = this.getSegmentMemory(seg);
      const isDone = !!record?.tailFrame;
      const row = document.createElement("div");
      row.className = `pr-segment-row${isDone ? " done" : ""}${seg.index === activeIdx ? " active" : ""}`;
      row.title = (seg.reasons || []).join(", ");

      const index = document.createElement("div");
      index.className = "pr-segment-index";
      index.textContent = `#${seg.index}`;

      const meta = document.createElement("div");
      meta.className = "pr-segment-meta";
      const range = `${this.formatTime(seg.start, true)}-${this.formatTime(seg.end, true)}`;
      const reason = (seg.reasons || []).join(",") || "segment";
      const media = isDone
        ? `${record.video ? t("videoOk") : t("videoMissing")} / ${record.tailFrame ? t("tailOk") : t("tailMissing")}`
        : t("placeholder");
      meta.textContent = `${range} · ${reason} · ${media}`;

      const status = document.createElement("div");
      status.className = "pr-segment-status";
      status.textContent = isDone ? t("done") : t("pending");

      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.gap = "4px";

      const continueBtn = document.createElement("button");
      continueBtn.className = "pr-mini-btn";
      continueBtn.textContent = t("continue");
      continueBtn.title = t("continueTitle");
      continueBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.dismissSettingsMenu();
        this.queueAllCutSegments({ startIndex: seg.index }).catch((err) => {
          console.error("[Shezw LongAuto] Continue failed", err);
        });
      });

      const regenBtn = document.createElement("button");
      regenBtn.className = "pr-mini-btn";
      regenBtn.textContent = t("regen");
      regenBtn.title = t("regenTitle");
      regenBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.resetSegmentMemory(seg);
        this.dismissSettingsMenu();
        this.queueAllCutSegments({ startIndex: seg.index, skipCompleted: false, stopAfterOne: true }).catch((err) => {
          console.error("[Shezw LongAuto] Re-gen failed", err);
        });
      });

      const resetBtn = document.createElement("button");
      resetBtn.className = "pr-mini-btn danger";
      resetBtn.textContent = t("reset");
      resetBtn.title = t("resetTitle");
      resetBtn.disabled = !isDone;
      resetBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.resetSegmentMemory(seg);
        refreshFloatingMenu();
      });

      actions.appendChild(continueBtn);
      actions.appendChild(regenBtn);
      actions.appendChild(resetBtn);

      row.addEventListener("click", () => {
        if (!this.timeline.meta) this.timeline.meta = {};
        this.timeline.meta.activeSegmentIndex = seg.index;
        this.commitChanges();
        this.render();
        refreshFloatingMenu();
      });

      row.appendChild(index);
      row.appendChild(meta);
      row.appendChild(status);
      row.appendChild(actions);
      list.appendChild(row);
    }
    return list;
  }

  _positionFloatingMenu(menu, anchorEl) {
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const menuW = menu.offsetWidth || 230;
    const menuH = menu.offsetHeight || 350;
    let left = rect.right - menuW;
    let top = rect.bottom + 6;
    if (left < 4) left = 4;
    if (top + menuH > window.innerHeight - 4) top = Math.max(4, rect.top - menuH - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  _installFloatingMenuDismiss(menu, anchorEl) {
    setTimeout(() => {
      this._settingsDismisser = (ev) => {
        if (!menu.contains(ev.target) && !anchorEl.contains(ev.target)) this.dismissSettingsMenu();
      };
      document.addEventListener("mousedown", this._settingsDismisser);
    }, 0);
  }

  showSegmentsMenu(anchorEl) {
    this.dismissSettingsMenu();
    this._settingsAnchorEl = anchorEl;
    this._segmentsMenuOpen = true;

    const menu = document.createElement("div");
    menu.className = "pr-settings-menu";

    const titleContainer = document.createElement("div");
    titleContainer.className = "pr-settings-title";
    titleContainer.style.display = "flex";
    titleContainer.style.justifyContent = "space-between";
    titleContainer.style.alignItems = "center";

    const titleText = document.createElement("span");
    titleText.textContent = t("longAutoSegments");
    titleContainer.appendChild(titleText);

    const closeBtn = document.createElement("button");
    closeBtn.className = "pr-settings-close-btn";
    closeBtn.innerHTML = ICONS.close;
    closeBtn.title = t("closeSegments");
    closeBtn.addEventListener("click", () => this.dismissSettingsMenu());
    titleContainer.appendChild(closeBtn);
    menu.appendChild(titleContainer);

    if (this.timeline.meta && this.timeline.meta.longAuto) {
      menu.appendChild(this.buildLongAutoSegmentList(this.getLongAutoPlan()));
    } else {
      const empty = document.createElement("div");
      empty.className = "pr-reference-empty";
      empty.textContent = t("noLongAutoMemory");
      menu.appendChild(empty);
    }

    this._positionFloatingMenu(menu, anchorEl);
    this._settingsMenu = menu;
    this._installFloatingMenuDismiss(menu, anchorEl);
  }

  showSettingsMenu(anchorEl) {
    this.dismissSettingsMenu();
    this._settingsAnchorEl = anchorEl;
    this._segmentsMenuOpen = false;
    this._settingsInputBindings = [];
    const menu = document.createElement("div");
    menu.className = "pr-settings-menu";

    // Title & Close Button Container
    const titleContainer = document.createElement("div");
    titleContainer.className = "pr-settings-title";
    titleContainer.style.display = "flex";
    titleContainer.style.justifyContent = "space-between";
    titleContainer.style.alignItems = "center";

    const titleText = document.createElement("span");
    titleText.textContent = t("timelineSettings");
    titleContainer.appendChild(titleText);

    const closeBtn = document.createElement("button");
    closeBtn.className = "pr-settings-close-btn";
    closeBtn.innerHTML = ICONS.close;
    closeBtn.title = t("closeSettings");
    closeBtn.addEventListener("click", () => this.dismissSettingsMenu());
    titleContainer.appendChild(closeBtn);

    menu.appendChild(titleContainer);

    // Helper: fire a widget's callback safely
    const fireCallback = (w, val) => this.applySettingWidgetValue(w, val);

    // --- Display Mode ---
    const dmWidget = this.node.widgets?.find(w => w.name === "display_mode");
    if (dmWidget) {
      const ctrl = document.createElement("div");
      ctrl.className = "pr-segmented-control";

      const framesSeg = document.createElement("div");
      framesSeg.className = "pr-segment";
      framesSeg.textContent = t("frames");

      const secondsSeg = document.createElement("div");
      secondsSeg.className = "pr-segment";
      secondsSeg.textContent = t("seconds");

      const updateActive = (val) => {
        if (val === "frames") {
          framesSeg.classList.add("active");
          secondsSeg.classList.remove("active");
        } else {
          secondsSeg.classList.add("active");
          framesSeg.classList.remove("active");
        }
      };

      updateActive(dmWidget.value);

      const onSegClick = (val) => {
        fireCallback(dmWidget, val);
        updateActive(val);
        // Update ruler/timecode immediately
        if (this.updateWidgetVisibility) this.updateWidgetVisibility();
        if (this.updateUIFromSelection) this.updateUIFromSelection();
        this.render();
      };

      framesSeg.addEventListener("click", () => onSegClick("frames"));
      secondsSeg.addEventListener("click", () => onSegClick("seconds"));

      ctrl.appendChild(secondsSeg);
      ctrl.appendChild(framesSeg);

      menu.appendChild(this._makeSettingRow(t("displayMode"), ctrl));
    }

    if (this.timeline.meta && this.timeline.meta.longAuto) {
      const segmentSelect = document.createElement("select");
      segmentSelect.className = "pr-settings-input";
      segmentSelect.style.width = "150px";
      const plan = this.getLongAutoPlan();
      const activeIdx = clamp(parseInt(this.timeline.meta.activeSegmentIndex || 0, 10), 0, Math.max(0, plan.length - 1));
      this.timeline.meta.activeSegmentIndex = activeIdx;

      for (const seg of plan) {
        const option = document.createElement("option");
        option.value = String(seg.index);
        option.textContent = `#${seg.index} ${this.formatTime(seg.start, true)}-${this.formatTime(seg.end, true)}`;
        if (seg.index === activeIdx) option.selected = true;
        segmentSelect.appendChild(option);
      }

      segmentSelect.addEventListener("change", () => {
        if (!this.timeline.meta) this.timeline.meta = {};
        this.timeline.meta.activeSegmentIndex = parseInt(segmentSelect.value, 10) || 0;
        this.commitChanges();
      });

      menu.appendChild(this._makeSettingRow(t("renderSegment"), segmentSelect));
    }

    const divider1 = document.createElement("hr");
    divider1.className = "pr-settings-divider";
    menu.appendChild(divider1);

    // Helper to create scrubbable number control with horizontal buttons
    const createScrubbableNumberControl = (w, step, min, max, isFloat = false) => {
      const container = document.createElement("div");
      container.className = "pr-number-control";

      const decBtn = document.createElement("button");
      decBtn.className = "pr-number-btn";
      decBtn.textContent = "-";

      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = "pr-settings-input";
      inp.value = w.value;
      inp.step = step.toString();
      inp.min = min.toString();
      inp.max = max.toString();
      const binding = { widget: w, input: inp, min, max, isFloat, dirty: false };
      this._settingsInputBindings.push(binding);

      const incBtn = document.createElement("button");
      incBtn.className = "pr-number-btn";
      incBtn.textContent = "+";

      decBtn.addEventListener("click", () => {
        let val = parseFloat(inp.value) - step;
        if (val < min) val = min;
        inp.value = isFloat ? val.toFixed(4) : Math.round(val);
        fireCallback(w, parseFloat(inp.value));
      });

      incBtn.addEventListener("click", () => {
        let val = parseFloat(inp.value) + step;
        if (val > max) val = max;
        inp.value = isFloat ? val.toFixed(4) : Math.round(val);
        fireCallback(w, parseFloat(inp.value));
      });

      inp.addEventListener("change", () => {
        let val = parseFloat(inp.value);
        if (isNaN(val)) val = w.value;
        if (val < min) val = min;
        if (val > max) val = max;
        inp.value = isFloat ? val.toFixed(4) : Math.round(val);
        binding.dirty = false;
        fireCallback(w, parseFloat(inp.value));
      });
      inp.addEventListener("input", () => {
        binding.dirty = true;
      });

      // Dragging logic
      let isDragging = false;
      let startX = 0;
      let startVal = 0;
      let hasMoved = false;

      inp.style.cursor = "ew-resize";

      inp.addEventListener("mousedown", (e) => {
        startX = e.clientX;
        startVal = parseFloat(inp.value);
        hasMoved = false;

        const onMouseMove = (moveEvent) => {
          const deltaX = moveEvent.clientX - startX;
          if (Math.abs(deltaX) > 3) {
            hasMoved = true;
            isDragging = true;
          }

          if (isDragging) {
            moveEvent.preventDefault();
            const sensitivity = isFloat ? 0.001 : 0.5;
            let newVal = startVal + deltaX * sensitivity;

            if (newVal < min) newVal = min;
            if (newVal > max) newVal = max;

            inp.value = isFloat ? newVal.toFixed(4) : Math.round(newVal);
            fireCallback(w, parseFloat(inp.value));
          }
        };

        const onMouseUp = () => {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);

          if (!hasMoved) {
            inp.focus();
            inp.select();
          }
          isDragging = false;
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });

      container.appendChild(decBtn);
      container.appendChild(inp);
      container.appendChild(incBtn);

      return container;
    };

    const createMetaNumberControl = (metaKey, defaultValue, step, min, max, isFloat = false, onChange = null) => {
      const pseudoWidget = {
        value: this.timeline.meta?.[metaKey] ?? defaultValue,
        callback: (val) => {
          if (!this.timeline.meta) this.timeline.meta = {};
          const parsed = Number(val);
          const next = clamp(Number.isFinite(parsed) ? parsed : defaultValue, min, max);
          this.timeline.meta[metaKey] = isFloat ? Number(next.toFixed(3)) : Math.round(next);
          this.commitChanges();
          if (onChange) onChange(this.timeline.meta[metaKey]);
        }
      };
      return createScrubbableNumberControl(pseudoWidget, step, min, max, isFloat);
    };

    const createSelectControl = (w, fallbackValues = []) => {
      const select = document.createElement("select");
      select.className = "pr-settings-input";
      select.style.width = "118px";
      const values = Array.isArray(w.options?.values) && w.options.values.length
        ? w.options.values
        : fallbackValues;
      for (const raw of values) {
        const value = typeof raw === "object" ? (raw.value ?? raw.name ?? raw.label ?? String(raw)) : raw;
        const label = typeof raw === "object" ? (raw.label ?? raw.name ?? raw.value ?? String(raw)) : raw;
        const option = document.createElement("option");
        option.value = String(value);
        option.textContent = String(label);
        if (String(w.value) === String(value)) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener("change", () => fireCallback(w, select.value));
      return select;
    };

    const outputRows = [
      [t("durationFrames"), "duration_frames", 1, 1, 100000, false],
      [t("durationSeconds"), "duration_seconds", 0.01, 0.01, 7200, true],
      [t("frameRate"), "frame_rate", 1, 1, 120, false],
      [t("width"), "custom_width", 8, 64, 8192, false],
      [t("height"), "custom_height", 8, 64, 8192, false],
    ];
    const hasOutputSettings = outputRows.some(([, name]) => this.node.widgets?.find(w => w.name === name)) ||
      this.node.widgets?.find(w => w.name === "resize_method");
    if (hasOutputSettings) {
      const outputTitle = document.createElement("div");
      outputTitle.className = "pr-settings-title";
      outputTitle.textContent = t("output");
      menu.appendChild(outputTitle);
      for (const [label, name, step, min, max, isFloat] of outputRows) {
        const widget = this.node.widgets?.find(w => w.name === name);
        if (widget) menu.appendChild(this._makeSettingRow(label, createScrubbableNumberControl(widget, step, min, max, isFloat)));
        if (name === "duration_seconds" && this.timeline.meta?.longAuto) {
          menu.appendChild(this._makeSettingRow(
            t("maxSegmentSeconds"),
            createMetaNumberControl("maxSegmentSeconds", 15, 1, 3, 60, false, () => {
              this.updateLongAutoUI();
              this.render();
            })
          ));
        }
      }
      const resizeWidget = this.node.widgets?.find(w => w.name === "resize_method");
      if (resizeWidget) {
        menu.appendChild(this._makeSettingRow(t("resize"), createSelectControl(resizeWidget, ["crop", "pad", "stretch"])));
      }

      const dividerOutput = document.createElement("hr");
      dividerOutput.className = "pr-settings-divider";
      menu.appendChild(dividerOutput);
    }

    // --- Epsilon ---
    const epsWidget = this.node.widgets?.find(w => w.name === "epsilon");
    if (epsWidget) {
      menu.appendChild(this._makeSettingRow("Epsilon", createScrubbableNumberControl(epsWidget, 0.0001, 0.0001, 0.99, true)));
    }

    // --- Divisible By ---
    const divByWidget = this.node.widgets?.find(w => w.name === "divisible_by");
    if (divByWidget) {
      menu.appendChild(this._makeSettingRow("Divisible By", createScrubbableNumberControl(divByWidget, 1, 1, 256, false)));
    }

    // --- Img Compression ---
    const compWidget = this.node.widgets?.find(w => w.name === "img_compression");
    if (compWidget) {
      menu.appendChild(this._makeSettingRow("Img Compression", createScrubbableNumberControl(compWidget, 1, 0, 100, false)));
    }

    // --- Global Prompt Toggle ---
    const globalPromptWidget = this.node.widgets?.find(w => w.name === "global_prompt");
    if (globalPromptWidget) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !(globalPromptWidget.options && globalPromptWidget.options.hidden);
      cb.style.cursor = "pointer";
      cb.addEventListener("change", () => {
        const isVisible = cb.checked;
        if (!globalPromptWidget.options) globalPromptWidget.options = {};
        globalPromptWidget.options.hidden = !isVisible;

        if (isVisible) {
          delete globalPromptWidget.computeSize;
          globalPromptWidget.hidden = false;
          if (globalPromptWidget.element) globalPromptWidget.element.style.display = "";
        } else {
          globalPromptWidget.computeSize = () => [0, 0];
          globalPromptWidget.hidden = true;
          if (globalPromptWidget.element) globalPromptWidget.element.style.display = "none";
        }

        // Force refresh via display mode double-toggle trick
        if (this.displayModeWidget) {
          const origVal = this.displayModeWidget.value;
          const otherVal = origVal === "frames" ? "seconds" : "frames";
          this.displayModeWidget.value = otherVal;
          if (this.displayModeWidget.callback) this.displayModeWidget.callback(otherVal);
          this.displayModeWidget.value = origVal;
          if (this.displayModeWidget.callback) this.displayModeWidget.callback(origVal);
        }
      });
      menu.appendChild(this._makeSettingRow(t("useGlobalPrompt"), cb));
    }

    const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
    if (customAudioWidget) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!customAudioWidget.value;
      cb.style.cursor = "pointer";
      cb.addEventListener("change", () => {
        fireCallback(customAudioWidget, cb.checked);
        this.node.setDirtyCanvas(true, true);
      });
      menu.appendChild(this._makeSettingRow(t("customAudio"), cb));
    }

    // --- Show/Hide on Node Toggle ---
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "pr-settings-toggle-btn";
    const widgetsVisible = !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
    toggleBtn.textContent = widgetsVisible ? t("hideWidgets") : t("showWidgets");
    toggleBtn.addEventListener("click", () => {
      const nowVisible = !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
      if (nowVisible) {
        this.hideSettingsWidgets();
        toggleBtn.textContent = t("showWidgets");
      } else {
        this.showSettingsWidgets();
        toggleBtn.textContent = t("hideWidgets");
      }
    });
    menu.appendChild(toggleBtn);

    this._positionFloatingMenu(menu, anchorEl);
    this._settingsMenu = menu;
    this._installFloatingMenuDismiss(menu, anchorEl);
  }

  dismissSettingsMenu() {
    this.flushSettingsInputs();
    if (this._settingsMenu) { this._settingsMenu.remove(); this._settingsMenu = null; }
    if (this._settingsDismisser) { document.removeEventListener("mousedown", this._settingsDismisser); this._settingsDismisser = null; }
    this._segmentsMenuOpen = false;
    this._settingsInputBindings = [];
  }


  addSegmentInGap(frameStart, frameEnd, type = "prompt") {
    const snappedStart = clamp(Math.round(this.snapFrameToCut(frameStart)), 0, Math.max(0, frameEnd - 1));
    const seg = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      start: snappedStart, length: Math.max(1, frameEnd - snappedStart),
      prompt: "", type,
    };
    const track = type === "control" ? "control" : (type === "camera" ? "camera" : (type === "prompt" ? "prompt" : "image"));
    if (type === "control") {
      seg.controlType = "camera_depth";
      seg.strength = 0.75;
      seg.prompt = "use a depth/control video to drive smooth camera motion";
    } else if (type === "camera") {
      seg.cameraMotion = "static";
      seg.prompt = cameraPromptForMotion(seg.cameraMotion);
    }
    const targetArray = this.getTrackArray(track);
    targetArray.push(seg);
    targetArray.sort((a, b) => a.start - b.start);
    this.selectionType = track;
    this.selectedIndex = targetArray.findIndex(s => s.id === seg.id);
    this.updateUIFromSelection();
    this.commitChanges();
  }

  addTextSegmentFreeSpace() {
    const frameRate = this.getFrameRate();
    const newLength = Math.max(1, frameRate); // 1 second default
    const sorted = [...this.timeline.promptSegments].sort((a, b) => a.start - b.start);
    let newStart = 0;
    for (const seg of sorted) {
      if (newStart + newLength <= seg.start) break;
      newStart = Math.max(newStart, seg.start + seg.length);
    }
    // Place the segment at the first free slot in the visual timeline (no output duration change).
    const durationFrames = this.getVisualDurationFrames();
    const seg = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      start: newStart, length: Math.min(newLength, Math.max(newLength, durationFrames - newStart)),
      prompt: "", type: "prompt",
    };
    this.timeline.promptSegments.push(seg);
    this.timeline.promptSegments.sort((a, b) => a.start - b.start);
    this.selectionType = "prompt";
    this.selectedIndex = this.timeline.promptSegments.findIndex(s => s.id === seg.id);
    this.updateUIFromSelection();
    this.commitChanges();
  }

  addCameraSegmentFreeSpace() {
    const frameRate = this.getFrameRate();
    const newLength = Math.max(1, frameRate);
    const sorted = [...this.timeline.cameraSegments].sort((a, b) => a.start - b.start);
    let newStart = 0;
    for (const seg of sorted) {
      if (newStart + newLength <= seg.start) break;
      newStart = Math.max(newStart, seg.start + seg.length);
    }
    const durationFrames = this.getVisualDurationFrames();
    const seg = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      start: newStart,
      length: Math.min(newLength, Math.max(newLength, durationFrames - newStart)),
      cameraMotion: "static",
      prompt: cameraPromptForMotion("static"),
      type: "camera",
    };
    this.timeline.cameraSegments.push(seg);
    this.timeline.cameraSegments.sort((a, b) => a.start - b.start);
    this.selectionType = "camera";
    this.selectedIndex = this.timeline.cameraSegments.findIndex(s => s.id === seg.id);
    this.updateUIFromSelection();
    this.commitChanges();
  }

  addControlSegmentFreeSpace() {
    const frameRate = this.getFrameRate();
    const newLength = Math.max(1, frameRate);
    const sorted = [...this.timeline.controlSegments].sort((a, b) => a.start - b.start);
    let newStart = 0;
    for (const seg of sorted) {
      if (newStart + newLength <= seg.start) break;
      newStart = Math.max(newStart, seg.start + seg.length);
    }
    const durationFrames = this.getVisualDurationFrames();
    const seg = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      start: newStart,
      length: Math.min(newLength, Math.max(newLength, durationFrames - newStart)),
      prompt: "use a depth/control video to drive smooth camera motion",
      type: "control",
      controlType: "camera_depth",
      strength: 0.75,
    };
    this.timeline.controlSegments.push(seg);
    this.timeline.controlSegments.sort((a, b) => a.start - b.start);
    this.selectionType = "control";
    this.selectedIndex = this.timeline.controlSegments.findIndex(s => s.id === seg.id);
    this.updateUIFromSelection();
    this.commitChanges();
  }

  addCutAtFrame(frame) {
    const totalFrames = this.getVisualDurationFrames();
    const cutFrame = clamp(Math.round(this.snapFrameToCut(frame || 0, { totalFrames })), 0, Math.max(0, totalFrames - 1));
    if (!this.timeline.cutSegments) this.timeline.cutSegments = [];

    const existingIdx = this.timeline.cutSegments.findIndex(seg => Math.abs((seg.start ?? seg.frame ?? 0) - cutFrame) <= this.getCutSnapToleranceFrames());
    if (existingIdx >= 0) {
      this.selectionType = "cut";
      this.selectedIndex = existingIdx;
      this.updateUIFromSelection();
      this.render();
      return;
    }

    const seg = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      type: "cut",
      start: cutFrame,
      frame: cutFrame,
      label: "CUT",
    };
    this.timeline.cutSegments.push(seg);
    this.timeline.cutSegments.sort((a, b) => (a.start ?? a.frame ?? 0) - (b.start ?? b.frame ?? 0));
    this.selectionType = "cut";
    this.selectedIndex = this.timeline.cutSegments.findIndex(s => s.id === seg.id);
    this.updateUIFromSelection();
    this.commitChanges();
  }

  // --- Audio Player Engine ---
  updatePlayerUI() {
    if (!this.playBtn || !this.loopBtn) return;
    this.playBtn.innerHTML = this.isPlaying ? ICONS.pause : ICONS.play;
    if (this.isLooping) {
      this.loopBtn.classList.add("active");
    } else {
      this.loopBtn.classList.remove("active");
    }
    if (this.seekBar) {
      this.seekBar.max = this.getVisualDurationFrames();
      this.seekBar.value = this.currentFrame;
    }
    if (this.timeCodeDisplay) {
      this.timeCodeDisplay.textContent = this.formatTime(this.currentFrame);
    }
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pauseAudio();
    } else {
      if (this.currentFrame >= this.getVisualDurationFrames()) {
        this.currentFrame = 0;
      }
      this.playAudio();
    }
  }

  toggleLoop() {
    this.isLooping = !this.isLooping;
    this.updatePlayerUI();
  }

  async playAudio() {
    this.pauseAudio(true); // clear any existing playback, but don't suspend context if scrubbing

    this._playCounter = (this._playCounter || 0) + 1;
    const playId = this._playCounter;
    this._currentPlayId = playId;
    this.isPlaying = true;

    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state !== 'running') {
      try { await this.audioContext.resume(); } catch (e) { }
    }
    if (this._currentPlayId !== playId || !this.isPlaying) return;

    this.updatePlayerUI();

    const frameRate = this.getFrameRate();
    this.playbackStartFrame = this.currentFrame;
    this.playbackStartTime = this.audioContext.currentTime;

    // Decode and schedule all audio segments that happen AT or AFTER currentFrame
    for (let seg of this.timeline.audioSegments) {
      const segStartFrame = seg.start;
      const segEndFrame = seg.start + seg.length;

      if (segEndFrame <= this.currentFrame) continue;

      try {
        // Build audio buffer: fetch from server URL if audioFile is set, otherwise fall back to audioB64
        let audioBuffer;
        if (seg.audioFile) {
          const audioUrl = api.apiURL(`/view?filename=${encodeURIComponent(seg.audioFile.split("/").pop())}&type=input&subfolder=${encodeURIComponent(seg.audioFile.includes("/") ? seg.audioFile.split("/").slice(0, -1).join("/") : "")}`);
          const resp = await fetch(audioUrl);
          const arrayBuffer = await resp.arrayBuffer();
          audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
        } else if (seg.audioB64) {
          const binaryString = window.atob(seg.audioB64);
          const len = binaryString.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          audioBuffer = await this.audioContext.decodeAudioData(bytes.buffer);
        } else {
          continue;
        }
        if (this._currentPlayId !== playId || !this.isPlaying) return;

        const framesToSkipInSegment = Math.max(0, this.currentFrame - segStartFrame);
        const waitFrames = Math.max(0, segStartFrame - this.currentFrame);
        const waitTimeSec = waitFrames / frameRate;

        const fileOffsetFrames = seg.trimStart + framesToSkipInSegment;
        const fileOffsetSec = fileOffsetFrames / frameRate;

        const playDurationFrames = seg.length - framesToSkipInSegment;
        const playDurationSec = playDurationFrames / frameRate;

        if (playDurationSec <= 0) continue;

        const bufferNode = this.audioContext.createBufferSource();
        bufferNode.buffer = audioBuffer;
        bufferNode["connect"](this.audioContext.destination);

        const startTime = this.audioContext.currentTime + waitTimeSec;
        bufferNode.start(startTime, fileOffsetSec, playDurationSec);

        this.activeAudioNodes.push(bufferNode);
      } catch (err) {
        console.error("Playback decode error for segment:", err);
      }
    }

    if (this._currentPlayId !== playId || !this.isPlaying) return;

    const loop = () => {
      if (!this.isPlaying || this._currentPlayId !== playId) return;

      const elapsedSec = this.audioContext.currentTime - this.playbackStartTime;
      const elapsedFrames = elapsedSec * frameRate;

      this.currentFrame = this.playbackStartFrame + elapsedFrames;

      const visualDurationFrames = this.getVisualDurationFrames();
      const durationFrames = this.getDurationFrames();

      if (this.isLooping) {
        const loopBound = (this.playbackStartFrame >= durationFrames) ? visualDurationFrames : durationFrames;
        if (this.currentFrame >= loopBound) {
          this.currentFrame = 0;
          this.playAudio(); // Restart playback
          return;
        }
      } else {
        if (this.currentFrame >= visualDurationFrames) {
          this.currentFrame = visualDurationFrames;
          this.pauseAudio();
          this.render();
          return;
        }
      }

      this.render();
      this._playLoopId = requestAnimationFrame(loop);
    };

    this._playLoopId = requestAnimationFrame(loop);
  }

  pauseAudio(isScrubbing = false) {
    this.isPlaying = false;
    this._currentPlayId = null;

    if (!isScrubbing && this.audioContext && this.audioContext.state === 'running') {
      try { this.audioContext.suspend(); } catch (e) { }
    }

    for (let node of this.activeAudioNodes) {
      try { node.stop(); } catch (e) { }
      try { node.disconnect(); } catch (e) { }
    }
    this.activeAudioNodes = [];

    if (this._playLoopId) {
      cancelAnimationFrame(this._playLoopId);
      this._playLoopId = null;
    }
    this.updatePlayerUI();
  }
}

function installLongAutoQueueHook() {
  if (!app || typeof app.queuePrompt !== "function" || app.__shezwLongAutoQueueHookInstalled) return;
  app.__shezwLongAutoQueueHookInstalled = true;
  app.__shezwOriginalQueuePrompt = app.queuePrompt.bind(app);

  app.queuePrompt = async function (...args) {
    const nodes = app.graph?._nodes || [];
    const longAutoNode = nodes.find((node) => {
      const editor = node?._timelineEditor;
      return !!(editor && editor.timeline?.meta?.longAuto && editor.timeline?.meta?.queueAllByDefault);
    });

    if (longAutoNode?._timelineEditor && !longAutoNode._timelineEditor._isQueueingAllCuts) {
      return await longAutoNode._timelineEditor.queueAllCutSegments();
    }

    return await app.__shezwOriginalQueuePrompt(...args);
  };
}

// --- Node Registration Hooks ---
const APPENDED_WIDGET_DEFAULTS = [
  ["timeline_data", "{}"],
  ["local_prompts", ""],
  ["segment_lengths", ""],
];

app.registerExtension({
  name: "LTXDirector",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    installLongAutoQueueHook();
    if (nodeData.name === "LTXDirector") {

      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        if (onNodeCreated) onNodeCreated.apply(this, arguments);

        for (const [name, def] of APPENDED_WIDGET_DEFAULTS) {
          if (!this.widgets?.find(w => w.name === name)) {
            this.addWidget("string", name, def, () => { });
          }
        }
        for (const w of this.widgets) {
          if (HIDDEN_WIDGET_NAMES.includes(w.name)) hideWidget(w);
        }

        // Set default width to be wider on creation (approx 2.5x default ~220px)
        this.size[0] = 1000;

        // Force default for img_compression if not set (ComfyUI sometimes skips optional defaults)
        const compWidget = this.widgets?.find(w => w.name === "img_compression");
        if (compWidget && (compWidget.value === undefined || compWidget.value === null || compWidget.value === 0)) {
          compWidget.value = 18;
        }

        // Hide global prompt by default on creation without destroying its DOM element
        const globalPromptWidget = this.widgets?.find(w => w.name === "global_prompt");
        if (globalPromptWidget) {
          if (!globalPromptWidget.options) globalPromptWidget.options = {};
          globalPromptWidget.options.hidden = true;
          globalPromptWidget.hidden = true;
          globalPromptWidget.computeSize = () => [0, 0];
          setTimeout(() => {
            if (globalPromptWidget.element) globalPromptWidget.element.style.display = "none";
          }, 0);
        }

        const container = document.createElement("div");
        const widget = this.addDOMWidget("timeline_ui", "timeline_ui", container, {
          getValue: () => "",
          setValue: () => { },
        });

        widget.computeSize = function (width) {
          const canvasH = self._timelineEditor ? self._timelineEditor.canvasHeight : CANVAS_HEIGHT;
          return [width, canvasH + 235];
        };

        const self = this;
        setTimeout(() => {
          try {
            self._timelineEditor = new TimelineEditor(self, container, widget);
          } catch (err) {
            console.error("[PromptRelay] timeline editor init failed:", err);
          }
        }, 0);
      };

      const onRemoved = nodeType.prototype.onRemoved;
      nodeType.prototype.onRemoved = function () {
        this._timelineEditor?.destroy();
        return onRemoved?.apply(this, arguments);
      };

      const onConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function (info) {
        const out = onConfigure?.apply(this, arguments);
        for (const [name, def] of APPENDED_WIDGET_DEFAULTS) {
          const w = this.widgets.find(x => x.name === name);
          if (w && (w.value == null || w.value === "")) w.value = def;
        }

        setTimeout(() => {
          if (this._timelineEditor) {
            this._timelineEditor.reloadFromWidgets();
          }
        }, 0);
        return out;
      };
    }
  },
});
