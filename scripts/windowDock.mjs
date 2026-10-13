/**
 * "Back to …" dock: windows that matter mid-activity (a shop visit, a haggle
 * offer waiting for the GM, the casino) don't disappear when closed by
 * accident. ✕, Escape or a click outside tucks them away instead, keeping
 * everything in them (quantities, offers, bets), and a button at the bottom of
 * the screen brings them back.
 *
 *   const stash = makeStashable({ overlay, label, icon, discard });
 *   stash.hide()     — tuck the window away and show its dock button
 *   stash.show()     — bring it back
 *   stash.remove()   — the window really closed: drop the dock button
 * `discard` (optional) adds a small ✕ to the dock button that really closes it
 * (e.g. leaving the shop); without it the button stays until the activity ends.
 */

function dock() {
  let el = document.getElementById("qa-dock");
  if (!el) {
    el = document.createElement("div");
    el.id = "qa-dock";
    document.body.appendChild(el);
  }
  return el;
}

export function makeStashable({ overlay, label, icon = "fas fa-window-restore", discard = null }) {
  let pill = null;

  function show() {
    if (!pill) return;
    pill.remove();
    pill = null;
    overlay.style.display = "";
    if (!dock().children.length) dock().remove();
  }

  function hide() {
    if (pill || !overlay.isConnected) return;
    overlay.style.display = "none";
    pill = document.createElement("div");
    pill.className = "qa-dock-pill";
    const text = typeof label === "function" ? label() : label;
    pill.innerHTML = `
      <button type="button" class="qa-dock-open" title="Open it again"><i class="${icon}"></i> <span></span></button>
      ${discard ? '<button type="button" class="qa-dock-x" title="Close for good">✕</button>' : ""}`;
    pill.querySelector("span").textContent = `Back to ${text}`;
    pill.querySelector(".qa-dock-open").addEventListener("click", show);
    pill.querySelector(".qa-dock-x")?.addEventListener("click", () => { remove(); discard(); });
    dock().appendChild(pill);
  }

  function remove() {
    pill?.remove();
    pill = null;
    const d = document.getElementById("qa-dock");
    if (d && !d.children.length) d.remove();
  }

  return { hide, show, remove, get hidden() { return !!pill; } };
}
