const { app } = window.comfyAPI.app;

// Helper to forward wheel events to the LiteGraph canvas
function forwardWheelToCanvas(e) {
  const canvas = app.canvas?.canvas;
  if (canvas) {
    canvas.dispatchEvent(new WheelEvent(e.type, e));
    e.preventDefault();
  }
}

// Based on https://github.com/kijai/ComfyUI-KJNodes/blob/main/web/js/utility.js
// ─── Middle-click pan passthrough for DOM widgets ───
// Allows panning the LiteGraph canvas via middle-click drag on any DOM element
export function addMiddleClickPan(element) {
  const onMouseDown = (e) => {
    if (e.button !== 1) return;
    const ds = app.canvas?.ds;
    if (!ds) return;

    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const [startOffsetX, startOffsetY] = ds.offset;
    const scale = ds.scale; // Capture the canvas zoom factor at the start of dragging

    const onMove = (me) => {
      // Divide pixel delta by the scale to keep panning rate 1:1 with the cursor
      ds.offset[0] = startOffsetX + (me.clientX - startX) / scale;
      ds.offset[1] = startOffsetY + (me.clientY - startY) / scale;
      app.canvas.setDirty(true, true);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  element.addEventListener('mousedown', onMouseDown);
  return () => element.removeEventListener('mousedown', onMouseDown);
}

// ─── Wheel zoom passthrough for DOM widgets ───
// Re-dispatches wheel events to the LiteGraph canvas for zoom
export function addWheelPassthrough(element) {
  element.addEventListener('wheel', (e) => {
    if (e.shiftKey) return e.stopPropagation();
    forwardWheelToCanvas(e);
  }, { passive: false });
}

// ─── Wheel zoom passthrough for prompt inputs ───
export function addWheelPassthroughPrompt(element) {
  element.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      app.canvas?.processMouseWheel(e);
      return;
    }

    const canScrollY = element.scrollHeight > element.clientHeight;
    if (!canScrollY) {
      forwardWheelToCanvas(e);
    }
  }, { passive: false });
}
