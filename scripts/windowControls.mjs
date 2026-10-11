/**
 * Window controls for every popup the module makes: − (minimise) and ✕ (close)
 * in the top-right corner, and double-click the title to minimise / restore.
 *
 * Minimised, a popup shrinks to a small bar (title · − · ✕) where it was, its
 * dark backdrop goes away so the rest of the screen is usable, and the bar can
 * be dragged. Restore with −, or by double-clicking the bar.
 *
 * The controls sit beside the popup's content (not inside it), so popups that
 * re-render their content keep them.
 */
export function addWindowControls({ frame, overlay = null, close, titleOf }) {
  if (!frame || frame._qaWin) return frame?._qaWin;
  frame.classList.add("qa-has-winctl");

  const bar = document.createElement("div");
  bar.className = "qa-winctl";
  bar.innerHTML = `
    <span class="qa-win-bar-title"></span>
    <button type="button" class="qa-win-btn qa-win-min" title="Minimise" aria-label="Minimise">−</button>
    <button type="button" class="qa-win-btn qa-win-close" title="Close" aria-label="Close">✕</button>`;
  frame.prepend(bar);

  const title = () => (titleOf?.() ?? frame.querySelector(".title")?.textContent ?? "").trim() || "Window";
  let minimised = false;
  let saved = null;

  function minimise() {
    if (minimised) return;
    const r = frame.getBoundingClientRect();
    saved = {
      frame: frame.getAttribute("style") ?? "",
      overlay: overlay?.getAttribute("style") ?? "",
      floating: getComputedStyle(frame).position === "fixed",
    };
    bar.querySelector(".qa-win-bar-title").textContent = title();
    frame.classList.add("qa-minimised");
    Object.assign(frame.style, { position: "fixed", left: `${Math.round(r.left)}px`, top: `${Math.round(r.top)}px`, margin: "0", pointerEvents: "auto" });
    if (overlay) {
      overlay.classList.add("qa-overlay-min");
      Object.assign(overlay.style, { background: "transparent", pointerEvents: "none" });
    }
    bar.querySelector(".qa-win-min").title = "Restore";
    minimised = true;
  }

  function restore() {
    if (!minimised) return;
    const { left, top } = frame.style;
    frame.classList.remove("qa-minimised");
    frame.setAttribute("style", saved.frame);
    // Free-floating windows come back where the bar is; centred popups re-centre
    if (saved.floating) Object.assign(frame.style, { left, top });
    if (overlay) {
      overlay.classList.remove("qa-overlay-min");
      overlay.setAttribute("style", saved.overlay);
    }
    bar.querySelector(".qa-win-min").title = "Minimise";
    minimised = false;
  }

  const toggle = () => (minimised ? restore() : minimise());

  bar.querySelector(".qa-win-min").addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
  bar.querySelector(".qa-win-close").addEventListener("click", (e) => { e.stopPropagation(); close(); });

  frame.addEventListener("dblclick", (e) => {
    if (e.target.closest("input, select, textarea, button")) return;
    if (minimised || e.target.closest(".title, .qa-drag-handle, .qa-winctl")) {
      e.preventDefault();
      toggle();
      window.getSelection?.()?.removeAllRanges?.();
    }
  });

  // Drag the minimised bar by its title
  bar.querySelector(".qa-win-bar-title").addEventListener("mousedown", (e) => {
    if (!minimised || e.button !== 0) return;
    const r = frame.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      frame.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - dx))}px`;
      frame.style.top = `${Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - dy))}px`;
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    e.preventDefault();
  });

  frame._qaWin = { minimise, restore, toggle, get minimised() { return minimised; } };
  return frame._qaWin;
}
