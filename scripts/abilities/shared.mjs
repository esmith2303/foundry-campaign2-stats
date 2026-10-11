/** Small helpers shared by the Quick Actions popup and the abilities. */

export const MODULE_ID = "dnd-group-campaign-2-stats";

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** The party: player-owned characters, alphabetical. */
export function partyCharacters() {
  return game.actors.contents
    .filter(a => a.type === "character" && a.hasPlayerOwner)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Current / effective max / missing HP of an actor. */
export function hpOf(actor) {
  const hp = actor?.system?.attributes?.hp ?? {};
  const value = Number(hp.value) || 0;
  const max = Number(hp.effectiveMax ?? ((Number(hp.max) || 0) + (Number(hp.tempmax) || 0))) || 0;
  return { value, max, missing: Math.max(0, max - value) };
}

export function profOf(actor) {
  return Number(actor?.system?.attributes?.prof) || 0;
}

/** Party members as plain picker rows, with HP. */
export function partyRows() {
  return partyCharacters().map(a => ({ actor: a, ...hpOf(a) }));
}

// ── Damage types / items ─────────────────────────────────────────────────────

/** [{ key, label }] from dnd5e's config, minus healing. */
export function damageTypeOptions() {
  const types = globalThis.CONFIG?.DND5E?.damageTypes ?? {};
  return Object.entries(types)
    .map(([key, v]) => ({ key, label: typeof v === "string" ? v : (v?.label ?? key) }))
    .filter(t => !["healing", "temphp"].includes(t.key))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Best guess at an item's first damage type (dnd5e 4/5 activities, then 3.x parts). */
export function itemDamageType(item) {
  const s = item?.system ?? {};
  const first = (types) => {
    if (!types) return null;
    if (types instanceof Set) return [...types][0] ?? null;
    if (Array.isArray(types)) return types[0] ?? null;
    return null;
  };
  const base = first(s.damage?.base?.types);
  if (base) return base;
  const acts = s.activities?.contents ?? (s.activities ? Object.values(s.activities) : []);
  for (const a of acts) {
    const t = first(a?.damage?.parts?.[0]?.types);
    if (t) return t;
  }
  const part = s.damage?.parts?.[0];
  return Array.isArray(part) ? (part[1] || null) : null;
}

/** Weapons and spells on a sheet, grouped for a <select>. */
export function damageSourceGroups(actor) {
  const groups = [["weapon", "Weapons"], ["spell", "Spells"]];
  return groups.map(([type, label]) => ({
    label,
    items: actor.items.filter(i => i.type === type).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter(g => g.items.length);
}

// ── Hit dice & kits ──────────────────────────────────────────────────────────

/** Remaining hit dice per class, largest die first (dnd5e 4/5 "hd", 3.x "hitDice"). */
export function hitDiceOf(actor) {
  const out = [];
  for (const cls of actor?.items?.filter(i => i.type === "class") ?? []) {
    const s = cls.system ?? {};
    if (s.hd && typeof s.hd === "object") {
      const faces = parseInt(String(s.hd.denomination ?? "").replace(/\D/g, ""));
      const max = Number(s.hd.max ?? s.levels) || 0;
      const spent = Number(s.hd.spent) || 0;
      if (faces) out.push({ item: cls, faces, left: Math.max(0, max - spent), spent, path: "system.hd.spent" });
    } else if (s.hitDice) {
      const faces = parseInt(String(s.hitDice).replace(/\D/g, ""));
      const max = Number(s.levels) || 0;
      const spent = Number(s.hitDiceUsed) || 0;
      if (faces) out.push({ item: cls, faces, left: Math.max(0, max - spent), spent, path: "system.hitDiceUsed" });
    }
  }
  return out.sort((a, b) => b.faces - a.faces);
}

export function hitDiceLeft(actor) {
  return hitDiceOf(actor).reduce((s, h) => s + h.left, 0);
}

/** "2×d10, 1×d6" */
export function hitDiceLabel(actor) {
  const by = {};
  for (const h of hitDiceOf(actor)) if (h.left) by[h.faces] = (by[h.faces] || 0) + h.left;
  const parts = Object.entries(by).sort((a, b) => b[0] - a[0]).map(([f, n]) => `${n}×d${f}`);
  return parts.length ? parts.join(", ") : "none";
}

/** Uses left on an item with a uses pool, or its quantity if it has none. */
export function usesLeft(item) {
  const u = item?.system?.uses;
  const max = Number(u?.max) || 0;
  const qty = Math.max(1, Number(item?.system?.quantity) || 1);
  if (max > 0) {
    const value = typeof u.value === "number" ? u.value : Math.max(0, max - (Number(u.spent) || 0));
    return Math.max(0, value) + (qty - 1) * max;
  }
  return Number(item?.system?.quantity) || 0;
}

/** Spend `n` uses; rolls over into the next kit in the stack when one runs out. */
export async function spendUses(item, n) {
  const u = item.system?.uses;
  const max = Number(u?.max) || 0;
  let qty = Math.max(0, Number(item.system?.quantity) || 0);
  if (max <= 0) return item.update({ "system.quantity": Math.max(0, qty - n) });
  const src = item._source?.system?.uses ?? {};
  const hasSpent = "spent" in src;
  let spent = hasSpent ? (Number(src.spent) || 0) : max - (Number(src.value) || 0);
  spent += n;
  while (spent >= max && qty > 1) { spent -= max; qty -= 1; }
  spent = Math.min(spent, max);
  const update = { "system.quantity": qty };
  update[hasSpent ? "system.uses.spent" : "system.uses.value"] = hasSpent ? spent : max - spent;
  return item.update(update);
}

// ── Chat card ────────────────────────────────────────────────────────────────
// Our own card style (header like the skill-check card), with each result laid
// out like a Foundry roll: a formula bar, then a big result box (green for
// heals, red for damage). Clicking the box opens the dice breakdown.

/** [{ faces, results: [{ result, dropped }] }] and the flat modifier of a Roll. */
function diceOf(roll) {
  const dice = [];
  let mod = 0, sign = 1;
  for (const t of roll?.terms ?? []) {
    if (t?.operator) { sign = t.operator === "-" ? -1 : 1; continue; }
    if (t?.faces && Array.isArray(t.results)) {
      dice.push({ faces: t.faces, results: t.results.map(r => ({ result: r.result, dropped: r.active === false || !!r.discarded })) });
    } else if (typeof t?.number === "number" && !t?.faces) {
      mod += sign * t.number;
    }
  }
  return { dice, mod };
}

/**
 * rows: [{ name, meta: [string], value, valueCls: "success"|"failure", roll?: Roll, total?: number }]
 *   value  → what the result box shows (e.g. "+8"); falls back to total / roll.total
 *   roll   → adds the formula bar and a click-to-open dice breakdown
 */
export async function statCard({ icon, title, subtitle, badge, rows = [], summary }) {
  const rowHtml = rows.map(r => {
    const shown = r.value ?? r.total ?? r.roll?.total;
    const cls = r.valueCls || "";
    const resultIcon = cls === "success" ? "fas fa-heart" : cls === "failure" ? "fas fa-burst" : "fas fa-dice-d20";
    const meta = (r.meta || []).filter(Boolean);
    let formula = "", result;
    if (r.roll) {
      const { dice, mod } = diceOf(r.roll);
      formula = `<div class="qa-formula">${escapeHtml(r.roll.formula)}</div>`;
      const parts = dice.map(d => `<span class="qa-die-group"><b>d${d.faces}</b> ${d.results.map(x =>
        x.dropped ? `<s title="rerolled / dropped">${x.result}</s>` : `<span>${x.result}</span>`).join(" ")}</span>`);
      if (mod) parts.push(`<span class="qa-die-group">${mod > 0 ? "+" : "−"} ${Math.abs(mod)}</span>`);
      parts.push(`<span class="qa-die-group">= <b>${escapeHtml(r.roll.total)}</b></span>`);
      result = `
        <details class="qa-result ${cls}">
          <summary><i class="${resultIcon} qa-result-icon"></i><span class="qa-result-total">${escapeHtml(shown)}</span><i class="fas fa-chevron-down qa-result-chev"></i></summary>
          <div class="qa-dice">${parts.join("")}</div>
        </details>`;
    } else if (shown !== undefined && shown !== null) {
      result = `
        <div class="qa-result ${cls}">
          <div class="qa-result-line"><i class="${resultIcon} qa-result-icon"></i><span class="qa-result-total">${escapeHtml(shown)}</span><span class="qa-result-chev"></span></div>
        </div>`;
    }
    return `
      <li class="qa-roll-row">
        <div class="qa-roll-name">${escapeHtml(r.name)}</div>
        ${meta.length ? `<div class="qa-roll-meta">${meta.map(escapeHtml).join(" · ")}</div>` : ""}
        ${formula}${result ?? ""}
      </li>`;
  }).join("");
  return `
    <div class="skill-check-card qa-card">
      <header class="card-header">
        <span class="icon"><i class="${icon}"></i></span>
        <div class="title-block">
          <div class="skill-name">${escapeHtml(title)}</div>
          ${subtitle ? `<div class="ability-tag">${escapeHtml(subtitle)}</div>` : ""}
        </div>
        ${badge ? `<span class="dc-badge">${escapeHtml(badge)}</span>` : ""}
      </header>
      <section class="card-content">
        ${rowHtml ? `<ul class="qa-rows">${rowHtml}</ul>` : ""}
        ${summary ? `<div class="group-summary">${escapeHtml(summary)}</div>` : ""}
      </section>
    </div>`;
}

// ── Amount picker: a set number, or dice ─────────────────────────────────────

const DICE = [4, 6, 8, 10, 12, 20];

/**
 * Renders into `el`. Returns { formula(): string|null, describe(): string, onChange(fn) }.
 * "Set" mode → plain integer; "Roll" mode → a dice formula built with the dice
 * buttons (like a dice tray) and a ± modifier, or typed by hand.
 */
export function mountAmountPicker(el, { label = "Amount" } = {}) {
  el.innerHTML = `
    <div class="field">
      <div class="field-label qa-amount-head">
        <span>${escapeHtml(label)}</span>
        <div class="mode-toggle qa-amount-mode">
          <button type="button" data-mode="set" class="active">Set</button>
          <button type="button" data-mode="roll">Roll</button>
        </div>
      </div>
      <div class="player-row qa-amount-set">
        <label><span>Amount</span></label>
        <div class="num-input">
          <button type="button" data-step="-1">−</button>
          <input type="number" class="qa-set-value" min="0" step="1" value="0">
          <button type="button" data-step="1">+</button>
        </div>
      </div>
      <div class="qa-amount-roll" hidden>
        <div class="player-row qa-dice-row">
          ${DICE.map(f => `<button type="button" class="btn qa-die" data-faces="${f}">d${f}</button>`).join("")}
          <button type="button" class="btn qa-die-clear" title="Clear">✕</button>
        </div>
        <div class="player-row">
          <input type="text" class="qa-formula" placeholder="e.g. 2d6 + 3" spellcheck="false">
          <span class="group-threshold-label">Mod</span>
          <div class="num-input">
            <button type="button" data-mod="-1">−</button>
            <input type="number" class="qa-mod" step="1" value="0">
            <button type="button" data-mod="1">+</button>
          </div>
        </div>
      </div>
    </div>`;

  let mode = "set";
  const counts = {};           // faces → number of dice
  const listeners = [];
  const fire = () => listeners.forEach(f => f());
  const setInput = el.querySelector(".qa-set-value");
  const formulaInput = el.querySelector(".qa-formula");
  const modInput = el.querySelector(".qa-mod");
  let typed = false;

  const build = () => {
    const dice = Object.keys(counts).map(Number).sort((a, b) => b - a).filter(f => counts[f] > 0).map(f => `${counts[f]}d${f}`);
    const mod = Math.floor(Number(modInput.value) || 0);
    let s = dice.join(" + ");
    if (mod) s = s ? `${s} ${mod > 0 ? "+" : "-"} ${Math.abs(mod)}` : String(mod);
    formulaInput.value = s;
    typed = false;
    fire();
  };

  el.querySelectorAll(".qa-amount-mode button").forEach(b => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    el.querySelectorAll(".qa-amount-mode button").forEach(x => x.classList.toggle("active", x === b));
    el.querySelector(".qa-amount-set").hidden = mode !== "set";
    el.querySelector(".qa-amount-roll").hidden = mode !== "roll";
    fire();
  }));
  el.querySelectorAll(".qa-amount-set [data-step]").forEach(b => b.addEventListener("click", (e) => {
    setInput.value = String(Math.max(0, (Math.floor(Number(setInput.value)) || 0) + Number(b.dataset.step) * (e.shiftKey ? 5 : 1)));
    fire();
  }));
  setInput.addEventListener("input", fire);
  setInput.addEventListener("focus", () => setInput.select());
  el.querySelectorAll(".qa-die").forEach(b => b.addEventListener("click", () => {
    if (typed) { Object.keys(counts).forEach(k => delete counts[k]); modInput.value = "0"; }
    const f = Number(b.dataset.faces);
    counts[f] = (counts[f] || 0) + 1;
    build();
  }));
  el.querySelector(".qa-die-clear").addEventListener("click", () => {
    Object.keys(counts).forEach(k => delete counts[k]);
    modInput.value = "0";
    build();
  });
  el.querySelectorAll("[data-mod]").forEach(b => b.addEventListener("click", () => {
    modInput.value = String((Math.floor(Number(modInput.value)) || 0) + Number(b.dataset.mod));
    build();
  }));
  modInput.addEventListener("input", build);
  formulaInput.addEventListener("input", () => { typed = true; fire(); });

  return {
    /** "roll" → a dice formula (or null if empty/invalid); "set" → null */
    formula() {
      if (mode !== "roll") return null;
      const f = formulaInput.value.trim();
      if (!f) return null;
      try { return globalThis.Roll?.validate?.(f) === false ? null : f; } catch { return null; }
    },
    /** Set amount (integer ≥ 0), only meaningful in "set" mode */
    setAmount() { return mode === "set" ? Math.max(0, Math.floor(Number(setInput.value)) || 0) : null; },
    mode: () => mode,
    isReady() { return mode === "set" ? this.setAmount() > 0 : !!this.formula(); },
    onChange(fn) { listeners.push(fn); },
  };
}

/** Evaluate a picker into { amount, roll } (roll is a Roll, or null for a set amount). */
export async function resolveAmount(picker) {
  if (picker.mode() === "set") return { amount: picker.setAmount(), roll: null };
  const roll = await new Roll(picker.formula()).evaluate();
  return { amount: Math.max(0, Math.floor(roll.total)), roll };
}
