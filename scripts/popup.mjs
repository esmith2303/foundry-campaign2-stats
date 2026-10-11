/**
 * A popup in the module's style (same look as the skill-check, Abilities and
 * Shop popups), with − / ✕ window controls.
 *
 *   modal    → dark backdrop, centred, closes on a click outside or Escape
 *   floating → no backdrop and the rest of the screen stays usable; dragged by
 *              any element with class "qa-drag-handle"; placed at { left, top }
 *
 * Content goes into `body` (re-rendering it keeps the window controls).
 */
import { addWindowControls } from "./windowControls.mjs";

export function openPopup({ id, floating = false, className = "", left, top, width, onClose } = {}) {
  if (id) document.getElementById(`${id}-overlay`)?.remove();
  const overlay = document.createElement("div");
  overlay.className = "qa-popup-overlay";
  if (id) overlay.id = `${id}-overlay`;
  const frame = document.createElement("div");
  frame.className = `qa-popup-dialog ${className}`.trim();
  if (id) frame.id = id;
  const body = document.createElement("div");
  body.className = "qa-win-body";
  frame.appendChild(body);
  overlay.appendChild(frame);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("shown"));

  let closed = false;
  const onKey = (e) => {
    if (e.key === "Escape" && !floating && !frame._qaWin?.minimised && !e.target.closest?.("input, select, textarea")) close();
  };
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    overlay.classList.remove("shown");
    setTimeout(() => overlay.remove(), 200);
    try { onClose?.(); } catch (e) { console.warn(e); }
  }
  document.addEventListener("keydown", onKey);

  if (width) frame.style.width = width;
  if (floating) {
    // Inline so no stylesheet can bring the backdrop back
    Object.assign(overlay.style, { background: "transparent", pointerEvents: "none" });
    Object.assign(frame.style, { pointerEvents: "auto", position: "fixed", left: `${left ?? 120}px`, top: `${top ?? 80}px`, margin: "0" });
    frame.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".qa-drag-handle") || e.target.closest("input, select, textarea, button")) return;
      const r = frame.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => {
        frame.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx))}px`;
        frame.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))}px`;
      };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      e.preventDefault();
    });
  } else {
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  }
  addWindowControls({ frame, overlay, close });
  return { overlay, frame, body, close, isClosed: () => closed };
}
