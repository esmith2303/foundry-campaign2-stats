/**
 * Add Other — stats only. Attacks, hits, crits, fumbles and saves that never
 * went through Foundry, plus the biggest hit (for the Max Hit stat).
 *
 * Adding hits or fumbles adds the same number of attacks, and crits are hits.
 * Attacks can then be lowered on their own (down to 0) when those attacks are
 * already counted — e.g. midi-qol saw the attack roll but the hit wasn't
 * recorded — so only the hit is registered.
 *
 * What it records:
 *   attacks → added to the total attacks
 *   hits    → hits in hit %; misses = attacks beyond the hits, and at least the fumbles
 *   crits / fumbles → added to the crit / fumble totals
 *   maxHit  → compared with Max Hit, used only if bigger; blank = not used
 *   missToHit / failToPass → corrections: move an already-recorded miss to a
 *              hit / failed save to a pass (nothing is added to the totals)
 */
import { MODULE_ID, escapeHtml, statCard } from "./shared.mjs";

const ROWS = [
  { key: "attacks",     label: "Attacks",        hint: "added to total" },
  { key: "hits",        label: "Hits",           hint: "", extra: { key: "maxHit", label: "Biggest hit" } },
  { key: "crits",       label: "Crits",          hint: "count as hits" },
  { key: "fumbles",     label: "Fumbles",        hint: "count as misses" },
  { key: "saveSuccess", label: "Save (success)", hint: "" },
  { key: "saveFail",    label: "Save (failure)", hint: "" },
];
// Fixes for results Foundry got wrong (e.g. the wrong AC or DC): they move an
// already-recorded result, so no attack or save is added.
const FIXES = [
  { key: "missToHit",  label: "Miss → hit",            hint: "was a hit" },
  { key: "failToPass", label: "Failed save → passed",  hint: "was a pass" },
];

const counter = (key, placeholder = "") => `
  <div class="num-input" data-key="${key}">
    <button type="button" data-step="-1">−</button>
    <input type="number" min="0" step="1" value="${placeholder ? "" : 0}"${placeholder ? ` placeholder="${placeholder}"` : ""}>
    <button type="button" data-step="1">+</button>
  </div>`;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The counts as they'll be recorded. */
function totals(v) {
  return { ...v, misses: Math.max(0, v.attacks - v.hits, v.fumbles), maxHit: v.hits > 0 ? v.maxHit : 0 };
}

function describe(t) {
  const parts = [];
  if (t.attacks || t.hits) {
    const hits = plural(t.hits, "hit") + (t.crits ? ` incl. ${plural(t.crits, "crit")}` : "");
    const misses = plural(t.misses, "miss", "misses") + (t.fumbles ? ` incl. ${plural(t.fumbles, "fumble")}` : "");
    parts.push(`${t.attacks ? `+${plural(t.attacks, "attack")} to total` : "Not added to attacks"} · ${hits}, ${misses}`);
  }
  if (t.saveSuccess + t.saveFail) parts.push(`${plural(t.saveSuccess + t.saveFail, "save")} (${t.saveSuccess} passed, ${t.saveFail} failed)`);
  if (t.missToHit) parts.push(`${plural(t.missToHit, "miss", "misses")} → ${t.missToHit === 1 ? "hit" : "hits"}`);
  if (t.failToPass) parts.push(`${plural(t.failToPass, "failed save")} → passed`);
  return parts.join(" · ");
}

function renderPanel(dialog, { actor, close, back }) {
  // The values exactly as shown; changes to one can carry over to others (see change())
  const v = { attacks: 0, hits: 0, crits: 0, fumbles: 0, saveSuccess: 0, saveFail: 0, maxHit: 0, missToHit: 0, failToPass: 0 };

  dialog.innerHTML = `
    <div class="title">Add Other</div>
    <div class="field">
      <div class="field-label">${escapeHtml(actor.name)}</div>
      <div class="players">
        ${ROWS.map(r => `
          <div class="player-row qa-other-row" data-row="${r.key}">
            <label><span>${escapeHtml(r.label)}</span>${r.hint ? `<span class="qa-tag">${escapeHtml(r.hint)}</span>` : ""}</label>
            ${counter(r.key)}
          </div>${r.extra ? `
          <div class="player-row qa-other-row qa-other-sub" data-row="${r.extra.key}">
            <label><span>${escapeHtml(r.extra.label)}</span><span class="qa-tag">damage, optional</span></label>
            ${counter(r.extra.key, "—")}
          </div>` : ""}`).join("")}
      </div>
      <div class="qa-note">For stats only — nothing is changed on any character. Adding hits or fumbles adds attacks too;
        lower Attacks if the attack is already counted but no hit or miss was (e.g. rolled with no target).
        “Biggest hit” replaces Max Hit only if it's bigger — leave it blank to skip it.</div>
    </div>
    <div class="field">
      <div class="field-label">Corrections — Foundry got it wrong</div>
      <div class="players">
        ${FIXES.map(r => `
          <div class="player-row qa-other-row" data-row="${r.key}">
            <label><span>${escapeHtml(r.label)}</span><span class="qa-tag">${escapeHtml(r.hint)}</span></label>
            ${counter(r.key)}
          </div>`).join("")}
      </div>
      <div class="qa-note">When Foundry recorded the wrong result (e.g. it had the wrong AC or DC): moves a recorded miss to a hit, or a failed save to a pass. No attack or save is added.</div>
    </div>
    <div class="qa-note qa-other-summary"></div>
    <div class="qa-error" hidden></div>
    <div class="actions">
      <button type="button" class="btn" data-qa="back">Back</button>
      <button type="button" class="btn primary" data-qa="go" disabled>Add</button>
    </div>`;

  const go = dialog.querySelector('[data-qa="go"]');
  const err = dialog.querySelector(".qa-error");
  const summary = dialog.querySelector(".qa-other-summary");
  const boxes = Object.fromEntries([...dialog.querySelectorAll(".num-input[data-key]")].map(b => [b.dataset.key, b]));

  const render = () => {
    const t = totals(v);
    for (const [key, box] of Object.entries(boxes)) {
      const input = box.querySelector("input");
      const shown = key === "maxHit" && !v.maxHit ? "" : String(v[key]);   // biggest hit: blank when unset
      if (input.value !== shown) input.value = shown;
      box.querySelector('[data-step="-1"]').disabled = v[key] <= (key === "hits" ? v.crits : 0);
    }
    const noHits = v.hits === 0;
    boxes.maxHit.querySelectorAll("button, input").forEach(el => { el.disabled = noHits || (el.dataset.step === "-1" && !v.maxHit); });
    const any = t.attacks + t.hits + t.fumbles + t.saveSuccess + t.saveFail + t.missToHit + t.failToPass > 0;
    summary.textContent = any ? describe(t) : "";
    summary.hidden = !any;
    go.disabled = !any;
  };

  /** Set one value; hits / fumbles carry their change over to attacks, crits pull hits up. */
  const change = (key, raw) => {
    const next = Math.max(0, Math.floor(Number(raw)) || 0);
    const grow = (k, d) => { v[k] = Math.max(0, v[k] + d); };
    if (key === "hits") {
      const n = Math.max(next, v.crits);
      grow("attacks", n - v.hits); v.hits = n;
    } else if (key === "fumbles") {
      grow("attacks", next - v.fumbles); v.fumbles = next;
    } else if (key === "crits") {
      v.crits = next;
      if (v.crits > v.hits) { grow("attacks", v.crits - v.hits); v.hits = v.crits; }
    } else {
      v[key] = next;
    }
    render();
  };

  for (const [key, box] of Object.entries(boxes)) {
    const input = box.querySelector("input");
    box.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", (e) => {
      change(key, v[key] + Number(b.dataset.step) * (e.shiftKey ? 5 : 1));
    }));
    input.addEventListener("focus", () => input.select());
    input.addEventListener("change", () => change(key, input.value));
  }
  render();

  dialog.querySelector('[data-qa="back"]').addEventListener("click", back);
  go.addEventListener("click", async () => {
    go.disabled = true; err.hidden = true;
    try {
      const t = totals(v);
      const rows = [];
      if (t.attacks) rows.push({ name: "Attacks", meta: ["added to total"], value: String(t.attacks) });
      if (t.hits) rows.push({ name: "Hits", meta: [t.crits && plural(t.crits, "crit"), t.maxHit && `biggest ${t.maxHit}`], value: String(t.hits), valueCls: "success" });
      if (t.misses || t.fumbles) rows.push({ name: "Misses", meta: [t.fumbles && plural(t.fumbles, "fumble")], value: String(t.misses), valueCls: "failure" });
      if (t.saveSuccess) rows.push({ name: "Saves passed", value: String(t.saveSuccess), valueCls: "success" });
      if (t.saveFail) rows.push({ name: "Saves failed", value: String(t.saveFail), valueCls: "failure" });
      if (t.missToHit) rows.push({ name: "Miss → hit", meta: ["correction"], value: String(t.missToHit), valueCls: "success" });
      if (t.failToPass) rows.push({ name: "Failed save → passed", meta: ["correction"], value: String(t.failToPass), valueCls: "success" });
      if (!rows.length) throw new Error("Nothing to add.");

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: await statCard({ icon: "fas fa-list-check", title: "Other Stats", subtitle: actor.name, rows, summary: "Added manually for stats" }),
        flags: { [MODULE_ID]: { abilityUse: {
          ability: "add-other", actorId: actor.id,
          other: { attacks: t.attacks, hits: t.hits, crits: t.crits, fumbles: t.fumbles,
                   saveSuccess: t.saveSuccess, saveFail: t.saveFail, maxHit: t.maxHit,
                   missToHit: t.missToHit, failToPass: t.failToPass }, undo: [],
        } } },
      });
      ui.notifications.info(`Stats recorded for ${actor.name}.`);
      close();
    } catch (e) {
      err.hidden = false; err.textContent = e.message;
      render();
    }
  });
}

export const AddOther = {
  id: "add-other",
  label: "Add Other",
  icon: "fas fa-list-check",
  general: true,
  hint: "Stats only",
  renderPanel,
};
