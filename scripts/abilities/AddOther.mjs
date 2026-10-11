/**
 * Add Other — stats only. Attacks, hits, crits, fumbles and saves that never
 * went through Foundry, plus the biggest hit (for the Max Hit stat).
 *
 * Hits and fumbles are attacks, and crits are hits, so the bigger counts follow
 * the smaller ones up (2 hits → at least 2 attacks) and back down to whatever
 * was entered for them.
 */
import { MODULE_ID, escapeHtml, statCard } from "./shared.mjs";

const ROWS = [
  { key: "attacks",     label: "Attacks",        hint: "hit or miss" },
  { key: "hits",        label: "Hits",           hint: "", extra: { key: "maxHit", label: "↳ Biggest hit" } },
  { key: "crits",       label: "Crits",          hint: "count as hits" },
  { key: "fumbles",     label: "Fumbles",        hint: "count as misses" },
  { key: "saveSuccess", label: "Save (success)", hint: "" },
  { key: "saveFail",    label: "Save (failure)", hint: "" },
];

const counter = (key, value) => `
  <div class="num-input" data-key="${key}">
    <button type="button" data-step="-1">−</button>
    <input type="number" min="0" step="1" value="${value}">
    <button type="button" data-step="1">+</button>
  </div>`;

/** Counts as entered, and the totals they imply. */
function totals(set) {
  const crits = set.crits, fumbles = set.fumbles;
  const hits = Math.max(set.hits, crits);
  const attacks = Math.max(set.attacks, hits + fumbles);
  return { attacks, hits, crits, fumbles, misses: attacks - hits,
           saveSuccess: set.saveSuccess, saveFail: set.saveFail,
           maxHit: hits > 0 ? set.maxHit : 0 };
}

function describe(t) {
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts = [];
  if (t.attacks) {
    const hits = plural(t.hits, "hit") + (t.crits ? ` incl. ${plural(t.crits, "crit")}` : "");
    const misses = plural(t.misses, "miss", "misses") + (t.fumbles ? ` incl. ${plural(t.fumbles, "fumble")}` : "");
    parts.push(`${plural(t.attacks, "attack")}: ${hits}, ${misses}`);
  }
  if (t.saveSuccess + t.saveFail) parts.push(`${plural(t.saveSuccess + t.saveFail, "save")} (${t.saveSuccess} passed, ${t.saveFail} failed)`);
  return parts.join(" · ");
}

function renderPanel(dialog, { actor, close, back }) {
  const set = { attacks: 0, hits: 0, crits: 0, fumbles: 0, saveSuccess: 0, saveFail: 0, maxHit: 0 };

  dialog.innerHTML = `
    <div class="title">Add Other</div>
    <div class="field">
      <div class="field-label">${escapeHtml(actor.name)}</div>
      <div class="players">
        ${ROWS.map(r => `
          <div class="player-row qa-other-row" data-row="${r.key}">
            <label><span>${escapeHtml(r.label)}</span>${r.hint ? `<span class="qa-tag">${escapeHtml(r.hint)}</span>` : ""}</label>
            ${counter(r.key, 0)}
          </div>${r.extra ? `
          <div class="player-row qa-other-row qa-other-sub" data-row="${r.extra.key}">
            <label><span>${escapeHtml(r.extra.label)}</span><span class="qa-tag">damage, for Max Hit</span></label>
            ${counter(r.extra.key, 0)}
          </div>` : ""}`).join("")}
      </div>
      <div class="qa-note qa-other-summary"></div>
      <div class="qa-note">For stats only — nothing is changed on any character. Hits, crits and fumbles count as attacks too.
        “Biggest hit” only updates Max Hit — use Add Damage to add to damage dealt.</div>
    </div>
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
    const t = totals(set);
    // Floors: attacks can't drop below hits + fumbles, hits not below crits
    const floor = { attacks: t.hits + t.fumbles, hits: t.crits };
    for (const [key, box] of Object.entries(boxes)) {
      const shown = t[key];
      const input = box.querySelector("input");
      if (document.activeElement !== input || Number(input.value) !== shown) input.value = String(shown);
      box.querySelector('[data-step="-1"]').disabled = shown <= (floor[key] ?? 0);
    }
    boxes.maxHit.querySelector('[data-step="1"]').disabled = t.hits === 0;
    boxes.maxHit.querySelector("input").disabled = t.hits === 0;
    const any = t.attacks + t.crits + t.saveSuccess + t.saveFail > 0;
    summary.textContent = any ? describe(t) : "";
    summary.hidden = !any;
    go.disabled = !any;
  };

  // `set` holds what was entered; totals() derives the shown counts from it,
  // so a bigger count follows a smaller one up and back down to its own value.
  const setValue = (key, v) => { set[key] = Math.max(0, Math.floor(Number(v)) || 0); render(); };

  for (const [key, box] of Object.entries(boxes)) {
    const input = box.querySelector("input");
    box.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", (e) => {
      setValue(key, totals(set)[key] + Number(b.dataset.step) * (e.shiftKey ? 5 : 1));
    }));
    input.addEventListener("focus", () => input.select());
    input.addEventListener("change", () => setValue(key, input.value));
  }
  render();

  dialog.querySelector('[data-qa="back"]').addEventListener("click", back);
  go.addEventListener("click", async () => {
    go.disabled = true; err.hidden = true;
    try {
      const t = totals(set);
      const rows = [];
      if (t.attacks) rows.push({ name: "Attacks", meta: [`${t.hits} hit${t.hits === 1 ? "" : "s"}`, `${t.misses} miss${t.misses === 1 ? "" : "es"}`], value: String(t.attacks) });
      if (t.crits) rows.push({ name: "Crits", value: String(t.crits), valueCls: "success" });
      if (t.fumbles) rows.push({ name: "Fumbles", value: String(t.fumbles), valueCls: "failure" });
      if (t.maxHit) rows.push({ name: "Biggest hit", meta: ["for Max Hit"], value: String(t.maxHit) });
      if (t.saveSuccess) rows.push({ name: "Saves passed", value: String(t.saveSuccess), valueCls: "success" });
      if (t.saveFail) rows.push({ name: "Saves failed", value: String(t.saveFail), valueCls: "failure" });
      if (!rows.length) throw new Error("Nothing to add.");

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: await statCard({ icon: "fas fa-list-check", title: "Other Stats", subtitle: actor.name, rows, summary: "Added manually for stats" }),
        flags: { [MODULE_ID]: { abilityUse: {
          ability: "add-other", actorId: actor.id,
          other: { attacks: t.attacks, hits: t.hits, crits: t.crits, fumbles: t.fumbles,
                   saveSuccess: t.saveSuccess, saveFail: t.saveFail, maxHit: t.maxHit },
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
