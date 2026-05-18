const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

// ─── Constants ────────────────────────────────────────────────────────────────
const AS_RULER_H = 24;
const AS_TRACK_H = 80;
const AS_CANVAS_H = AS_RULER_H + AS_TRACK_H;
const AS_HIT_PX = 14;
const AS_MIN_LEN = 6;

// ─── Utilities ────────────────────────────────────────────────────────────────
function asClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function asHideWidget(w) {
  if (!w) return;
  w.hidden = true;
  if (!w.options) w.options = {};
  w.options.hidden = true;
  w.computeSize = () => [0, 0];
  if (w.element) w.element.style.display = "none";
}

// ─── Styles ───────────────────────────────────────────────────────────────────
if (!document.getElementById("as-styles")) {
  const el = document.createElement("style");
  el.id = "as-styles";
  el.textContent = `
    .as-wrap {
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      display: flex; flex-direction: column; gap: 8px;
      width: 100%; box-sizing: border-box; padding-bottom: 4px;
    }
    .as-wrap.drag-active {
      outline: 2px dashed #888;
      background: rgba(255,255,255,0.05);
      border-radius: 6px;
    }
    .as-toolbar {
      display: flex; justify-content: space-between; align-items: center;
      flex-wrap: wrap; gap: 6px; padding: 2px 0;
    }
    .as-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .as-btn {
      background: #222; color: #e0e0e0; border: 1px solid #111;
      border-radius: 4px; padding: 6px 12px; font-size: 11px; font-weight: 500;
      cursor: pointer; display: flex; align-items: center; gap: 6px;
      transition: all 0.2s ease;
    }
    .as-btn:hover { background: #333; border-color: #555; }
    .as-btn-danger:hover { background: #4a1515; border-color: #cc4444; color: #ffaaaa; }
    .as-vp { width: 100%; overflow-x: auto; overflow-y: hidden; }
    .as-vp::-webkit-scrollbar { height: 10px; }
    .as-vp::-webkit-scrollbar-track { background: #151515; border-radius: 5px; }
    .as-vp::-webkit-scrollbar-thumb { background: #444; border-radius: 5px; }
    .as-vp::-webkit-scrollbar-thumb:hover { background: #666; }
    .as-canvas {
      border-radius: 6px; border: 1px solid #111; background: #2a2a2a;
      cursor: default; width: 100%; outline: none; display: block;
    }
    .as-player {
      display: flex; justify-content: center; align-items: center;
      gap: 12px; padding: 2px 0; flex-wrap: wrap; width: 100%;
    }
    .as-ibtn {
      background: #2a2a2a; border: 1px solid #444; color: #eee; cursor: pointer;
      padding: 6px 12px; border-radius: 4px; display: flex; align-items: center;
      justify-content: center; transition: all 0.2s;
    }
    .as-ibtn * { pointer-events: none; }
    .as-ibtn:hover { color: #fff; background: #3a3a3a; border-color: #666; }
    .as-ibtn.active { color: #4fff8f; border-color: #4fff8f; background: #1a3a2a; }
    .as-seek {
      -webkit-appearance: none; appearance: none; flex: 1; min-width: 80px;
      height: 6px; background: #444; border-radius: 3px; outline: none;
      cursor: pointer; border: 1px solid #222;
    }
    .as-seek::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 14px; height: 14px; border-radius: 50%;
      background: #ff4444; cursor: pointer; border: 2px solid #222;
    }
    .as-tc { font-size: 13px; font-weight: bold; color: #e0e0e0; font-family: monospace; }
    .as-rg { display: flex; align-items: center; gap: 8px; }
    .as-zoom {
      width: 70px; -webkit-appearance: none; appearance: none;
      height: 4px; background: #444; border-radius: 2px; outline: none; cursor: pointer;
    }
    .as-zoom::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 12px; height: 12px; border-radius: 50%; background: #aaa; cursor: pointer;
    }
    .as-info { font-size: 11px; color: #666; font-family: monospace; white-space: nowrap; }
  `;
  document.head.appendChild(el);
}

// ─── Icons ────────────────────────────────────────────────────────────────────
const ASI = {
  upload: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  trash:  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  play:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  pause:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
  loop:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12A9 9 0 0 0 6 5.3L3 8"/><polyline points="3 3 3 8 8 8"/><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"/><polyline points="21 21 21 16 16 16"/></svg>`,
  fit:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><polyline points="8 7 3 12 8 17"/><polyline points="16 7 21 12 16 17"/></svg>`,
};

// ─── Data helpers ─────────────────────────────────────────────────────────────
function asParse(jsonStr) {
  let parsed = { audioSegments: [] };
  try {
    if (jsonStr) {
      const p = JSON.parse(jsonStr);
      if (Array.isArray(p.audioSegments)) parsed.audioSegments = p.audioSegments;
    }
  } catch (_) {}
  for (const s of parsed.audioSegments) {
    if (!s.id) s.id = Date.now() + Math.random().toString(36).slice(2);
    if (s.trimStart == null) s.trimStart = 0;
  }
  return parsed;
}

// ─── Editor class ─────────────────────────────────────────────────────────────
class AudioSequencerEditor {
  constructor(node, container, domWidget) {
    this.node = node;
    this.container = container;
    this.domWidget = domWidget;

    this.timeline = { audioSegments: [] };
    this.selectedIndex = -1;

    // Drag state
    this._isDragging = false;
    this._dragType = null;
    this._dragStartX = 0;
    this._dragInitialTimeline = null;
    this._dragTargetId = null;
    this._dragTargetIdRight = null;
    this._previewSegments = null;
    this._lastWidth = 0;

    // Zoom
    this.zoomLevel = 1.0;

    // Playback
    this.currentFrame = 0;
    this.isPlaying = false;
    this.isLooping = false;
    this.audioContext = null;
    this.activeAudioNodes = [];
    this._playLoopId = null;
    this._currentPlayId = null;
    this._playCounter = 0;
    this.playbackStartFrame = 0;
    this.playbackStartTime = 0;

    // Widget refs
    this.timelineDataWidget   = node.widgets?.find(w => w.name === "timeline_data");
    this.durationFramesWidget = node.widgets?.find(w => w.name === "duration_frames");
    this.frameRateWidget      = node.widgets?.find(w => w.name === "frame_rate");
    this.displayModeWidget    = node.widgets?.find(w => w.name === "display_mode");

    this.timeline = asParse(this.timelineDataWidget?.value);

    this._buildDOM();
    this.commitChanges(true);

    // Keep render in sync when display mode changes
    const origDM = this.displayModeWidget?.callback;
    if (this.displayModeWidget) {
      this.displayModeWidget.callback = (...a) => {
        origDM?.apply(this.displayModeWidget, a);
        this.render();
      };
    }

    this._resizeLoop = requestAnimationFrame(this._checkResize.bind(this));
  }

  destroy() {
    cancelAnimationFrame(this._resizeLoop);
    this.pauseAudio();
    window.removeEventListener("mousemove", this._mmHandler);
    window.removeEventListener("mouseup",   this._muHandler);
    window.removeEventListener("keydown",   this._keyHandler, true);
  }

  // ── Accessors ──────────────────────────────────────────────────────────────
  getDurationFrames() {
    return Math.max(1, parseInt(this.durationFramesWidget?.value || 240, 10));
  }
  getFrameRate() {
    return Math.max(1, parseFloat(this.frameRateWidget?.value || 24));
  }
  getVisualDuration() {
    let furthest = 0;
    for (const s of this.timeline.audioSegments) furthest = Math.max(furthest, s.start + s.length);
    const out = this.getDurationFrames();
    return furthest <= 0 ? out : Math.max(out, Math.ceil(furthest * 1.3));
  }
  formatTime(frames, bare = false) {
    const mode = this.displayModeWidget?.value || "seconds";
    if (mode === "seconds") {
      const s = (frames / this.getFrameRate()).toFixed(2);
      return bare ? s : s + "s";
    }
    const f = Math.round(frames).toString();
    return bare ? f : f + "f";
  }

  // ── DOM construction ───────────────────────────────────────────────────────
  _buildDOM() {
    const wrap = document.createElement("div");
    wrap.className = "as-wrap";

    // ── Toolbar ──
    const toolbar = document.createElement("div");
    toolbar.className = "as-toolbar";

    const left = document.createElement("div");
    left.className = "as-actions";

    this._audioInput = document.createElement("input");
    this._audioInput.type = "file";
    this._audioInput.accept = "audio/*";
    this._audioInput.multiple = true;
    this._audioInput.style.display = "none";
    this._audioInput.addEventListener("change", e => this._uploadFiles(e.target.files));

    const addBtn = document.createElement("button");
    addBtn.className = "as-btn";
    addBtn.innerHTML = ASI.upload + " Add Audio";
    addBtn.title = "Upload audio file(s)";
    addBtn.addEventListener("click", () => this._audioInput.click());

    const delBtn = document.createElement("button");
    delBtn.className = "as-btn as-btn-danger";
    delBtn.innerHTML = ASI.trash + " Clear All";
    delBtn.title = "Remove all clips";
    delBtn.addEventListener("click", () => {
      this.timeline.audioSegments = [];
      this.selectedIndex = -1;
      this.commitChanges();
    });

    left.appendChild(addBtn);
    left.appendChild(delBtn);
    left.appendChild(this._audioInput);

    const right = document.createElement("div");
    right.className = "as-rg";

    this._infoLabel = document.createElement("span");
    this._infoLabel.className = "as-info";

    const fitBtn = document.createElement("button");
    fitBtn.className = "as-btn";
    fitBtn.innerHTML = ASI.fit;
    fitBtn.title = "Fit to view";
    fitBtn.addEventListener("click", () => {
      this.zoomLevel = 1.0;
      if (this._zoomSlider) this._zoomSlider.value = 1.0;
      const vw = this._vp?.clientWidth || 0;
      if (vw > 0) { this._canvas.style.width = vw + "px"; this._resizeCanvas(vw); }
    });

    this._zoomSlider = document.createElement("input");
    this._zoomSlider.type = "range";
    this._zoomSlider.className = "as-zoom";
    this._zoomSlider.min = "1"; this._zoomSlider.max = "20"; this._zoomSlider.step = "0.1"; this._zoomSlider.value = "1";
    this._zoomSlider.title = "Zoom";
    this._zoomSlider.addEventListener("input", () => {
      this.zoomLevel = parseFloat(this._zoomSlider.value);
      const vw = this._vp?.clientWidth || 0;
      if (vw > 0) {
        const nw = Math.max(vw, vw * this.zoomLevel);
        this._canvas.style.width = nw + "px";
        this._resizeCanvas(nw);
      }
    });

    right.appendChild(this._infoLabel);
    right.appendChild(fitBtn);
    right.appendChild(this._zoomSlider);

    toolbar.appendChild(left);
    toolbar.appendChild(right);

    // ── Viewport + Canvas ──
    this._vp = document.createElement("div");
    this._vp.className = "as-vp";

    this._canvas = document.createElement("canvas");
    this._canvas.className = "as-canvas";
    this._canvas.height = AS_CANVAS_H;
    this._ctx = this._canvas.getContext("2d");

    this._vp.appendChild(this._canvas);

    // ── Player controls ──
    const player = document.createElement("div");
    player.className = "as-player";

    this._playBtn = document.createElement("button");
    this._playBtn.className = "as-ibtn";
    this._playBtn.innerHTML = ASI.play;
    this._playBtn.title = "Play / Pause (Space)";
    this._playBtn.addEventListener("click", () => this.togglePlay());

    this._loopBtn = document.createElement("button");
    this._loopBtn.className = "as-ibtn";
    this._loopBtn.innerHTML = ASI.loop;
    this._loopBtn.title = "Toggle loop";
    this._loopBtn.addEventListener("click", () => this.toggleLoop());

    this._seekBar = document.createElement("input");
    this._seekBar.type = "range"; this._seekBar.className = "as-seek";
    this._seekBar.min = "0"; this._seekBar.max = String(this.getDurationFrames()); this._seekBar.value = "0";
    this._seekBar.addEventListener("input", () => {
      this.currentFrame = parseFloat(this._seekBar.value);
      this.render();
      if (this.isPlaying) this.playAudio();
    });

    this._tc = document.createElement("span");
    this._tc.className = "as-tc";
    this._tc.textContent = this.formatTime(0);

    player.appendChild(this._playBtn);
    player.appendChild(this._loopBtn);
    player.appendChild(this._seekBar);
    player.appendChild(this._tc);

    wrap.appendChild(toolbar);
    wrap.appendChild(this._vp);
    wrap.appendChild(player);
    this.container.appendChild(wrap);

    // ── Events ──
    this._canvas.addEventListener("mousedown", e => this._onDown(e));
    this._mmHandler = e => this._onMove(e);
    this._muHandler = e => this._onUp(e);
    window.addEventListener("mousemove", this._mmHandler);
    window.addEventListener("mouseup",   this._muHandler);
    this._canvas.addEventListener("mousemove", e => this._onHover(e));
    this._canvas.addEventListener("mouseleave", () => { this._canvas.style.cursor = "default"; });

    // Drag & drop from OS
    wrap.addEventListener("dragover", e => {
      e.preventDefault();
      const hasAudio = [...(e.dataTransfer.items || [])].some(i => i.type.startsWith("audio/"));
      if (hasAudio) wrap.classList.add("drag-active");
    });
    wrap.addEventListener("dragleave", () => wrap.classList.remove("drag-active"));
    wrap.addEventListener("drop", e => {
      e.preventDefault();
      wrap.classList.remove("drag-active");
      const files = [...(e.dataTransfer.files || [])].filter(f => f.type.startsWith("audio/"));
      if (files.length) {
        const { x } = this._mousePos(e);
        const dropFrame = Math.round((x / this._canvas.offsetWidth) * this.getVisualDuration());
        this._uploadFiles(files, dropFrame);
      }
    });

    // Keyboard
    this._keyHandler = e => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") { e.preventDefault(); this.togglePlay(); }
      if (e.code === "Delete" || e.code === "Backspace") {
        if (this.selectedIndex >= 0) this.deleteSelected();
      }
    };
    window.addEventListener("keydown", this._keyHandler, true);
  }

  // ── Resize loop ────────────────────────────────────────────────────────────
  _checkResize() {
    const vw = this._vp?.clientWidth || 0;
    if (vw > 0 && this._lastWidth !== vw) {
      this._lastWidth = vw;
      const nw = Math.max(vw, vw * this.zoomLevel);
      this._canvas.style.width = nw + "px";
      this._resizeCanvas(nw);
    }
    this._resizeLoop = requestAnimationFrame(this._checkResize.bind(this));
  }

  _resizeCanvas(width) {
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width  = Math.round(width * dpr);
    this._canvas.height = Math.round(AS_CANVAS_H * dpr);
    this._ctx.scale(dpr, dpr);
    this.render();
  }

  _mousePos(e) {
    const rect = this._canvas.getBoundingClientRect();
    const sx = (this._canvas.offsetWidth  || rect.width)  / rect.width;
    const sy = (this._canvas.offsetHeight || rect.height) / rect.height;
    return {
      x: (e.clientX - rect.left) * sx + this._vp.scrollLeft,
      y: (e.clientY - rect.top)  * sy,
    };
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  render() {
    if (!this._ctx) return;
    const w = this._canvas.offsetWidth;
    const h = AS_CANVAS_H;
    const total = this.getVisualDuration();
    const ctx = this._ctx;

    // Background
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(0, 0, w, h);

    // Audio track background
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, AS_RULER_H, w, AS_TRACK_H);

    // Duration cutoff shading
    const cutX = (this.getDurationFrames() / total) * w;
    if (cutX < w) {
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(cutX, AS_RULER_H, w - cutX, AS_TRACK_H);
      ctx.strokeStyle = "#555";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(cutX, AS_RULER_H); ctx.lineTo(cutX, h); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Segments
    const segs = this._previewSegments || this.timeline.audioSegments;
    const activeId = this.timeline.audioSegments[this.selectedIndex]?.id;
    const sorted = [...segs].sort((a, b) => a.start - b.start);

    for (const seg of sorted) {
      const sx = (seg.start  / total) * w;
      const pw = (seg.length / total) * w;
      const sel = seg.id === activeId;
      ctx.globalAlpha = (this._isDragging && seg.id === this._dragTargetId) ? 0.6 : 1.0;
      this._drawClip(seg, sel, sx, pw);
      ctx.globalAlpha = 1.0;
    }

    // ── Ruler ──
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, w, AS_RULER_H);

    const fr = this.getFrameRate();
    const mode = this.displayModeWidget?.value || "seconds";
    const steps = mode === "seconds"
      ? [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
      : [1, 2, 5, 10, 24, 48, 120, 240, 480, 960];

    let majStep = steps[steps.length - 1];
    for (const s of steps) {
      const sf = mode === "seconds" ? s * fr : s;
      if ((sf / total) * w >= 60) { majStep = s; break; }
    }
    const majF = mode === "seconds" ? majStep * fr : majStep;

    let minStep;
    if (mode === "seconds") {
      minStep = majStep <= 0.2 ? majStep / 2 : majStep <= 1 ? majStep / 5 : majStep <= 5 ? 1 : majStep / 5;
    } else {
      minStep = majStep <= 5 ? 1 : majStep <= 24 ? 6 : majStep / 5;
    }
    const minF = mode === "seconds" ? minStep * fr : minStep;

    // Minor ticks
    ctx.fillStyle = "#444";
    const nMin = Math.floor(total / minF);
    for (let i = 1; i <= nMin; i++) {
      const fv = i * minF;
      if (Math.abs(fv % majF) < 0.1) continue;
      ctx.fillRect(Math.floor((fv / total) * w), AS_RULER_H - 3, 1, 3);
    }

    // Major ticks + labels
    ctx.fillStyle = "#aaa";
    ctx.font = "10px sans-serif";
    ctx.textBaseline = "middle";
    const nMaj = Math.floor(total / majF);
    for (let i = 0; i <= nMaj; i++) {
      const fv = i * majF;
      const x = (fv / total) * w;
      ctx.fillRect(Math.floor(x), AS_RULER_H - 6, 1, 6);
      if (fv > 0 && fv < total) {
        ctx.textAlign = "center";
        ctx.fillText(this.formatTime(fv, true), x, AS_RULER_H / 2);
      }
    }
    ctx.textAlign = "left";
    ctx.fillText(mode === "seconds" ? "0" : "0", 4, AS_RULER_H / 2);

    // Playhead
    const phX = (this.currentFrame / total) * w;
    ctx.beginPath(); ctx.moveTo(phX, 14); ctx.lineTo(phX, h);
    ctx.strokeStyle = "#ff4444"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = "#ff4444";
    ctx.beginPath();
    ctx.moveTo(phX - 6, 0); ctx.lineTo(phX + 6, 0);
    ctx.lineTo(phX + 6, 8); ctx.lineTo(phX, 14); ctx.lineTo(phX - 6, 8);
    ctx.fill();

    // Info label
    const sel = this.timeline.audioSegments[this.selectedIndex];
    if (sel && this._infoLabel) {
      this._infoLabel.textContent =
        `${sel.fileName || "clip"} | ${this.formatTime(sel.start)} → ${this.formatTime(sel.start + sel.length)}`;
    } else if (this._infoLabel) {
      const n = this.timeline.audioSegments.length;
      this._infoLabel.textContent = `${n} clip${n !== 1 ? "s" : ""}`;
    }

    this._updatePlayerUI();
  }

  _drawClip(seg, isSelected, sx, pw) {
    const ctx = this._ctx;
    const y = AS_RULER_H;
    const th = AS_TRACK_H;

    ctx.fillStyle = isSelected ? "#2a4a3a" : "#1a2a1a";
    ctx.fillRect(sx, y + 2, pw, th - 3);

    if (seg.waveformPeaks && pw > 0) {
      ctx.fillStyle = isSelected ? "rgba(100,255,100,0.6)" : "rgba(100,255,100,0.3)";
      const dur = seg.audioDurationFrames || 1;
      const r0 = seg.trimStart / dur;
      const r1 = (seg.trimStart + seg.length) / dur;
      const pc = seg.waveformPeaks.length;
      const cy = y + th / 2;
      for (let i = 0; i < pw; i++) {
        const gr = r0 + (i / pw) * (r1 - r0);
        const pi = Math.floor(gr * pc);
        if (pi >= 0 && pi < pc) {
          const amp = (seg.waveformPeaks[pi] * (th - 12) / 2) * 0.9;
          ctx.fillRect(sx + i, cy - amp, 1, amp * 2);
        }
      }
    }

    ctx.strokeStyle = isSelected ? "#4fff8f" : "#333";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx, y + 2, pw, th - 3);

    if (isSelected) {
      ctx.fillStyle = "#4fff8f";
      ctx.beginPath(); ctx.roundRect(sx,          y + th / 2 - 12, 4, 24, 2); ctx.fill();
      ctx.beginPath(); ctx.roundRect(sx + pw - 4, y + th / 2 - 12, 4, 24, 2); ctx.fill();
    }

    // Label
    ctx.fillStyle = "#ccc"; ctx.font = "11px sans-serif";
    ctx.textBaseline = "top"; ctx.textAlign = "left";
    ctx.save();
    ctx.beginPath(); ctx.rect(sx, y + 2, pw, th - 3); ctx.clip();
    let txt = seg.fileName || "Audio";
    const mw = pw - 12;
    if (mw > 0 && ctx.measureText(txt).width > mw) {
      while (txt.length > 0 && ctx.measureText(txt + "…").width > mw) txt = txt.slice(0, -1);
      txt += "…";
    }
    if (mw > 0) ctx.fillText(txt, sx + 6, y + 8);
    ctx.restore();
  }

  // ── Hit testing ────────────────────────────────────────────────────────────
  _hit(mx, my) {
    const w = this._canvas.offsetWidth;
    const total = this.getVisualDuration();

    // Playhead handle
    const phX = (this.currentFrame / total) * w;
    if (my <= 24 && Math.abs(mx - phX) <= 12) return { type: "playhead" };
    if (my <= AS_RULER_H) return { type: "ruler" };
    if (my > AS_CANVAS_H) return null;

    const segs = this.timeline.audioSegments;
    if (!segs.length) return null;

    const sorted = [...segs].map((s, i) => ({ ...s, oi: i })).sort((a, b) => a.start - b.start);

    // Edge / joint priority pass
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      const sx = (s.start  / total) * w;
      const pw = (s.length / total) * w;
      const ex = sx + pw;

      const prev = sorted[i - 1];
      const next = sorted[i + 1];

      const leftJoint = prev && prev.start + prev.length === s.start;
      if (!leftJoint && Math.abs(mx - sx) <= AS_HIT_PX)
        return { type: "edge", index: s.oi, dir: "left" };

      const rightJoint = next && next.start === s.start + s.length;
      if (rightJoint && Math.abs(mx - ex) <= AS_HIT_PX) {
        const dx = mx - ex;
        if (dx < -4) return { type: "edge",  index: s.oi,        dir: "right" };
        if (dx >  4) return { type: "edge",  index: next.oi,     dir: "left"  };
        return { type: "joint", leftIndex: s.oi, rightIndex: next.oi };
      } else if (!rightJoint && Math.abs(mx - ex) <= AS_HIT_PX) {
        return { type: "edge", index: s.oi, dir: "right" };
      }
    }

    // Center pass
    for (const s of sorted) {
      const sx = (s.start  / total) * w;
      const pw = (s.length / total) * w;
      if (mx >= sx && mx < sx + pw) return { type: "center", index: s.oi };
    }

    return null;
  }

  // ── Interaction ────────────────────────────────────────────────────────────
  _onDown(e) {
    if (e.button !== 0) return;
    const { x, y } = this._mousePos(e);
    const h = this._hit(x, y);

    if (!h) { this.selectedIndex = -1; this.render(); return; }

    if (h.type === "playhead" || h.type === "ruler") {
      this._isDragging = true;
      this._dragType = "playhead";
      this.currentFrame = asClamp((x / this._canvas.offsetWidth) * this.getVisualDuration(), 0, this.getVisualDuration());
      this.render();
      if (this.isPlaying) this.playAudio();
      return;
    }

    if (h.type === "joint") {
      this.selectedIndex = h.leftIndex;
      this._dragType = "joint";
      this._dragTargetId      = this.timeline.audioSegments[h.leftIndex].id;
      this._dragTargetIdRight = this.timeline.audioSegments[h.rightIndex].id;
    } else if (h.type === "center") {
      this.selectedIndex = h.index;
      this._dragType = "center";
      this._dragTargetId = this.timeline.audioSegments[h.index].id;
    } else {
      this.selectedIndex = h.index;
      this._dragType = h.dir;
      this._dragTargetId = this.timeline.audioSegments[h.index].id;
    }

    this._isDragging = true;
    this._dragStartX = x;
    this._dragInitialTimeline = JSON.parse(JSON.stringify(this.timeline.audioSegments));
    this._previewSegments = null;
    this.render();
  }

  _onMove(e) {
    if (!this._isDragging) return;
    const { x } = this._mousePos(e);
    const w = this._canvas.offsetWidth;
    const total = this.getVisualDuration();

    if (this._dragType === "playhead") {
      this.currentFrame = asClamp((x / w) * total, 0, total);
      this.render();
      if (this.isPlaying) this.playAudio();
      return;
    }

    const delta = Math.round((x - this._dragStartX) * (total / w));
    let t = JSON.parse(JSON.stringify(this._dragInitialTimeline));

    if (this._dragType === "joint") {
      const li = t.findIndex(s => s.id === this._dragTargetId);
      const ri = t.findIndex(s => s.id === this._dragTargetIdRight);
      if (li >= 0 && ri >= 0) {
        const ol = this._dragInitialTimeline.find(s => s.id === this._dragTargetId);
        const or_ = this._dragInitialTimeline.find(s => s.id === this._dragTargetIdRight);
        const maxL = Math.min(ol.length - AS_MIN_LEN, or_.trimStart || 0);
        const tail = (ol.audioDurationFrames || ol.length) - ((ol.trimStart || 0) + ol.length);
        const maxR = Math.min(or_.length - AS_MIN_LEN, tail);
        const d = asClamp(delta, -maxL, maxR);
        t[li].length = ol.length + d;
        t[ri].start = or_.start + d;
        t[ri].length = or_.length - d;
        t[ri].trimStart = (or_.trimStart || 0) + d;
      }
    } else if (this._dragType === "right") {
      const i = t.findIndex(s => s.id === this._dragTargetId);
      if (i >= 0) {
        const maxAudio = (t[i].audioDurationFrames || Infinity) - (t[i].trimStart || 0);
        t[i].length = asClamp(t[i].length + delta, AS_MIN_LEN, maxAudio);
      }
    } else if (this._dragType === "left") {
      const i = t.findIndex(s => s.id === this._dragTargetId);
      if (i >= 0) {
        const orig = this._dragInitialTimeline.find(s => s.id === this._dragTargetId);
        const minS = orig.start - (orig.trimStart || 0);
        const maxS = orig.start + orig.length - AS_MIN_LEN;
        const ns = asClamp(orig.start + delta, minS, maxS);
        const diff = ns - orig.start;
        t[i].start = ns;
        t[i].length = orig.length - diff;
        t[i].trimStart = (orig.trimStart || 0) + diff;
      }
    } else if (this._dragType === "center") {
      const i = t.findIndex(s => s.id === this._dragTargetId);
      if (i >= 0) {
        const orig = this._dragInitialTimeline.find(s => s.id === this._dragTargetId);
        t[i].start = Math.max(0, orig.start + delta);
      }
    }

    this._previewSegments = t;
    this.render();
  }

  _onUp(e) {
    document.body.style.userSelect = "";
    if (!this._isDragging) return;
    if (this._previewSegments) {
      this.timeline.audioSegments = this._previewSegments.map(s => ({ ...s }));
      if (this._dragTargetId)
        this.selectedIndex = this.timeline.audioSegments.findIndex(s => s.id === this._dragTargetId);
    }
    this._isDragging = false;
    this._previewSegments = null;
    this._canvas.style.cursor = "default";
    this.commitChanges();
  }

  _onHover(e) {
    if (this._isDragging) return;
    const { x, y } = this._mousePos(e);
    const h = this._hit(x, y);
    if (!h || h.type === "ruler")   this._canvas.style.cursor = "default";
    else if (h.type === "playhead") this._canvas.style.cursor = "ew-resize";
    else if (h.type === "edge" || h.type === "joint") this._canvas.style.cursor = "ew-resize";
    else if (h.type === "center")   this._canvas.style.cursor = "grab";
  }

  // ── Clip management ────────────────────────────────────────────────────────
  deleteSelected() {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.timeline.audioSegments.length) return;
    this.timeline.audioSegments.splice(this.selectedIndex, 1);
    this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
    this.commitChanges();
  }

  // ── Audio upload ───────────────────────────────────────────────────────────
  async _uploadFiles(files, targetFrameStart = null) {
    const fr = this.getFrameRate();
    for (const file of files) {
      if (!file.type.startsWith("audio/")) continue;
      await new Promise(async resolve => {
        try {
          const body = new FormData();
          body.append("image", file);
          const resp = await api.fetchApi("/upload/image", { method: "POST", body });
          if (resp.status !== 200) { resolve(); return; }

          const data = await resp.json();
          const sub = data.subfolder || "";
          const audioFile = sub ? sub + "/" + data.name : data.name;

          const ab = await file.arrayBuffer();
          const ac = new (window.AudioContext || window.webkitAudioContext)();
          const buf = await ac.decodeAudioData(ab);
          const clipFrames = Math.max(1, Math.ceil(buf.duration * fr));

          // Waveform peaks for display
          const ch = buf.getChannelData(0);
          const nPeaks = 200;
          const step = Math.max(1, Math.floor(ch.length / nPeaks));
          const peaks = [];
          for (let i = 0; i < nPeaks; i++) {
            let mx = 0;
            for (let j = 0; j < step; j++) {
              const v = Math.abs(ch[Math.min(i * step + j, ch.length - 1)]);
              if (v > mx) mx = v;
            }
            peaks.push(mx);
          }

          let newStart = targetFrameStart;
          if (newStart === null) {
            newStart = 0;
            this.timeline.audioSegments.sort((a, b) => a.start - b.start);
            for (const ex of this.timeline.audioSegments) {
              if (newStart + clipFrames <= ex.start) break;
              newStart = Math.max(newStart, ex.start + ex.length);
            }
          }

          const seg = {
            id: Date.now() + Math.random().toString(36).slice(2),
            type: "audio",
            start: Math.max(0, newStart),
            length: clipFrames,
            trimStart: 0,
            audioDurationFrames: clipFrames,
            audioFile,
            fileName: file.name,
            waveformPeaks: peaks,
          };

          this.timeline.audioSegments.push(seg);
          this.timeline.audioSegments.sort((a, b) => a.start - b.start);
          this.selectedIndex = this.timeline.audioSegments.findIndex(s => s.id === seg.id);
          this.commitChanges(true);
          this.render();
          resolve();
        } catch (err) {
          console.error("[AudioSequencer] Upload failed:", err);
          resolve();
        }
      });
    }
    this._audioInput.value = "";
  }

  // ── State sync ─────────────────────────────────────────────────────────────
  commitChanges(skipRender = false) {
    const json = JSON.stringify({ audioSegments: this.timeline.audioSegments.map(s => ({ ...s })) });
    if (this.timelineDataWidget) this.timelineDataWidget.value = json;
    if (this._seekBar) this._seekBar.max = this.getVisualDuration();
    if (!skipRender) this.render();
    setTimeout(() => {
      if (this.node?.computeSize) {
        const sz = this.node.computeSize();
        this.node.size[1] = sz[1];
        if (app.graph) app.graph.setDirtyCanvas(true, true);
      }
    }, 0);
  }

  // ── Playback ───────────────────────────────────────────────────────────────
  _updatePlayerUI() {
    if (this._playBtn) this._playBtn.innerHTML = this.isPlaying ? ASI.pause : ASI.play;
    if (this._loopBtn) this._loopBtn.classList.toggle("active", this.isLooping);
    if (this._seekBar) { this._seekBar.max = this.getVisualDuration(); this._seekBar.value = this.currentFrame; }
    if (this._tc) this._tc.textContent = this.formatTime(this.currentFrame);
  }

  togglePlay() {
    if (this.isPlaying) this.pauseAudio();
    else { if (this.currentFrame >= this.getVisualDuration()) this.currentFrame = 0; this.playAudio(); }
  }
  toggleLoop() { this.isLooping = !this.isLooping; this._updatePlayerUI(); }

  async playAudio() {
    this.pauseAudio(true);
    this._playCounter = (this._playCounter || 0) + 1;
    const playId = this._playCounter;
    this._currentPlayId = playId;
    this.isPlaying = true;

    if (!this.audioContext) this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioContext.state !== "running") try { await this.audioContext.resume(); } catch (_) {}
    if (this._currentPlayId !== playId || !this.isPlaying) return;

    this._updatePlayerUI();
    const fr = this.getFrameRate();
    this.playbackStartFrame = this.currentFrame;
    this.playbackStartTime  = this.audioContext.currentTime;

    for (const seg of this.timeline.audioSegments) {
      if (seg.start + seg.length <= this.currentFrame) continue;
      try {
        let audioBuffer;
        if (seg.audioFile) {
          const fn  = seg.audioFile.split("/").pop();
          const sub = seg.audioFile.includes("/") ? seg.audioFile.split("/").slice(0, -1).join("/") : "";
          const url = api.apiURL(`/view?filename=${encodeURIComponent(fn)}&type=input&subfolder=${encodeURIComponent(sub)}`);
          audioBuffer = await this.audioContext.decodeAudioData(await (await fetch(url)).arrayBuffer());
        } else if (seg.audioB64) {
          const s = window.atob(seg.audioB64);
          const b = new Uint8Array(s.length);
          for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
          audioBuffer = await this.audioContext.decodeAudioData(b.buffer);
        } else continue;

        if (this._currentPlayId !== playId || !this.isPlaying) return;

        const skip   = Math.max(0, this.currentFrame - seg.start);
        const wait   = Math.max(0, seg.start - this.currentFrame) / fr;
        const offset = ((seg.trimStart || 0) + skip) / fr;
        const dur    = (seg.length - skip) / fr;
        if (dur <= 0) continue;

        const src = this.audioContext.createBufferSource();
        src.buffer = audioBuffer;
        src.connect(this.audioContext.destination);
        const t0 = this.audioContext.currentTime + wait;
        const safeOff = Math.min(offset, audioBuffer.duration - 0.001);
        src.start(Math.max(this.audioContext.currentTime, t0), Math.max(0, safeOff), Math.min(dur, audioBuffer.duration - safeOff));
        this.activeAudioNodes.push(src);
      } catch (err) {
        console.warn("[AudioSequencer] Playback error:", err);
      }
    }

    if (this._currentPlayId !== playId || !this.isPlaying) return;

    const startCF = this.currentFrame;
    const startWT = this.audioContext.currentTime;
    const totalF  = this.getVisualDuration();

    const loop = () => {
      if (this._currentPlayId !== playId || !this.isPlaying) return;
      this.currentFrame = startCF + (this.audioContext.currentTime - startWT) * fr;
      if (this.currentFrame >= totalF) {
        if (this.isLooping) { this.currentFrame = 0; this.playAudio(); return; }
        else { this.currentFrame = totalF; this.pauseAudio(); return; }
      }
      this.render();
      this._playLoopId = requestAnimationFrame(loop);
    };
    this._playLoopId = requestAnimationFrame(loop);
  }

  pauseAudio(isScrubbing = false) {
    this.isPlaying = false;
    this._currentPlayId = null;
    if (!isScrubbing && this.audioContext?.state === "running")
      try { this.audioContext.suspend(); } catch (_) {}
    for (const n of this.activeAudioNodes) { try { n.stop(); } catch (_) {} try { n.disconnect(); } catch (_) {} }
    this.activeAudioNodes = [];
    if (this._playLoopId) { cancelAnimationFrame(this._playLoopId); this._playLoopId = null; }
    this._updatePlayerUI();
  }
}

// ─── Node registration ────────────────────────────────────────────────────────
app.registerExtension({
  name: "AudioSequencer",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "AudioSequencer") return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);

      // Ensure the hidden data widget exists
      if (!this.widgets?.find(w => w.name === "timeline_data"))
        this.addWidget("string", "timeline_data", "{}", () => {});

      asHideWidget(this.widgets?.find(w => w.name === "timeline_data"));

      this.size[0] = 700;

      const container = document.createElement("div");
      const self = this;

      const domWidget = this.addDOMWidget("as_ui", "as_ui", container, {
        getValue: () => "",
        setValue: () => {},
      });
      domWidget.computeSize = function (width) { return [width, AS_CANVAS_H + 95]; };

      setTimeout(() => {
        try { self._asEditor = new AudioSequencerEditor(self, container, domWidget); }
        catch (err) { console.error("[AudioSequencer] init error:", err); }
      }, 0);
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this._asEditor?.destroy();
      return onRemoved?.apply(this, arguments);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const out = onConfigure?.apply(this, arguments);
      setTimeout(() => {
        if (this._asEditor) {
          this._asEditor.timeline = asParse(this._asEditor.timelineDataWidget?.value);
          this._asEditor.selectedIndex = -1;
          this._asEditor.render();
        }
      }, 0);
      return out;
    };
  },
});
