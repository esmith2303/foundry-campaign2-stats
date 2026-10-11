/**
 * Lay on Hands — spend a healing pool across one or more targets.
 *
 * Works for any character with a "Lay on Hands" feature that has a uses pool
 * (dnd5e's paladin feature: max = 5 × paladin level). The player picks
 * amounts per party member (or "Other"), and the GM's client:
 *   - checks the pool again,
 *   - heals each party member (never above their max HP; only what was
 *     actually healed is taken from the pool),
 *   - spends the pool on the item,
 *   - posts a chat card, which the stats extractor counts as a heal.
 */
import { MODULE_ID, escapeHtml, partyCharacters, hpOf } from "./shared.mjs";

const ID = "lay-on-hands";
const APPLY = "lay-on-hands.apply";

function slug(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isLayOnHands(item) {
  return item?.system?.identifier === ID || slug(item?.name).startsWith(ID);
}

function poolMax(item) {
  return Number(item?.system?.uses?.max) || 0;
}

function poolLeft(item) {
  const u = item?.system?.uses;
  if (!u) return 0;
  if (typeof u.value === "number") return Math.max(0, u.value);
  return Math.max(0, poolMax(item) - (Number(u.spent) || 0));
}

/** Take `amount` out of the item's pool (dnd5e 3.1+ uses "spent", older uses "value"). */
async function spend(item, amount) {
  const src = item._source?.system?.uses ?? {};
  if ("spent" in src) return item.update({ "system.uses.spent": (Number(src.spent) || 0) + amount });
  return item.update({ "system.uses.value": Math.max(0, (Number(src.value) || 0) - amount) });
}

// ── GM side ──────────────────────────────────────────────────────────────────

async function gmApply({ actorId, itemId, targets } = {}, user) {
  const actor = game.actors.get(actorId);
  if (!actor) throw new Error("Character not found.");
  if (!user?.isGM && !actor.testUserPermission(user, "OWNER")) throw new Error("You don't own that character.");
  const item = actor.items.get(itemId);
  if (!item || !isLayOnHands(item)) throw new Error("Lay on Hands not found on that character.");

  const wanted = (Array.isArray(targets) ? targets : [])
    .map(t => ({ actorId: t?.actorId || null, name: String(t?.name ?? "").trim().slice(0, 60), amount: Math.floor(Number(t?.amount)) }))
    .filter(t => t.amount > 0);
  if (!wanted.length) throw new Error("Pick at least one target and an amount.");

  // Work out what each target actually receives (never past max HP)
  const results = wanted.map(t => {
    if (!t.actorId) return { actorId: null, name: t.name || "Other", requested: t.amount, applied: t.amount };
    const target = game.actors.get(t.actorId);
    if (!target) throw new Error("A selected character no longer exists.");
    const hp = hpOf(target);
    const applied = Math.min(t.amount, hp.missing);
    return { actorId: target.id, name: target.name, requested: t.amount, applied, hpBefore: hp.value, hpAfter: hp.value + applied, hpMax: hp.max, _actor: target };
  });

  const total = results.reduce((s, r) => s + r.applied, 0);
  const before = poolLeft(item);
  const max = poolMax(item);
  if (total <= 0) throw new Error("Everyone selected is already at full HP.");
  if (total > before) throw new Error(`Not enough in the pool: ${total} needed, ${before} left.`);

  await spend(item, total);
  for (const r of results) {
    if (r._actor && r.applied > 0) await r._actor.update({ "system.attributes.hp.value": r.hpAfter });
  }
  const after = before - total;
  const clean = results.map(({ _actor, ...r }) => r);

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: chatCard(item.name, actor.name, clean, before, after, max),
    flags: { [MODULE_ID]: { abilityUse: {
      ability: ID, itemName: item.name, actorId: actor.id,
      healing: total, poolBefore: before, poolAfter: after, poolMax: max, targets: clean,
    } } },
  });

  return { total, after, max, targets: clean };
}

function chatCard(itemName, casterName, results, before, after, max) {
  // Same card structure/styles as the skill-check card (SkillCheck.mjs)
  const rows = results.filter(r => r.applied > 0 || r.requested > 0).map(r => {
    const tag = r.actorId ? `<span class="mode-tag">${r.hpAfter} / ${r.hpMax}</span>` : "";
    const capped = r.applied < r.requested ? `<span class="mode-tag dis" title="${r.requested} asked; capped at full HP">capped</span>` : "";
    return `
      <li class="player-row">
        <span class="rolled-icon"><i class="fas fa-heart"></i></span>
        <span class="player-name">${escapeHtml(r.name)}</span>
        ${capped}${tag}
        <span class="roll-status success">+${r.applied}</span>
      </li>`;
  }).join("");
  return `
    <div class="skill-check-card qa-card">
      <header class="card-header">
        <span class="icon"><i class="fas fa-hand-holding-heart"></i></span>
        <div class="title-block">
          <div class="skill-name">${escapeHtml(itemName)}</div>
          <div class="ability-tag">${escapeHtml(casterName)}</div>
        </div>
        <span class="dc-badge">Pool ${after} / ${max}</span>
      </header>
      <section class="card-content">
        <ul class="player-list">${rows}</ul>
        <div class="group-summary">${before - after} HP spent · pool ${before} → ${after}</div>
      </section>
    </div>`;
}

// ── Player side (popup panel) ────────────────────────────────────────────────

function renderPanel(dialog, { actor, item, close, back, runAsGM }) {
  const pool = poolLeft(item);
  const max = poolMax(item);
  const party = partyCharacters();

  const numInput = () => `
    <div class="num-input">
      <button type="button" data-step="-1">−</button>
      <input type="number" min="0" step="1" value="0">
      <button type="button" data-step="1">+</button>
    </div>`;

  const row = (a) => {
    const hp = hpOf(a);
    const full = hp.missing === 0;
    return `
      <div class="player-row qa-target${full ? " qa-is-full" : ""}" data-actor-id="${a.id}" data-limit="${hp.missing}">
        <label>
          <span>${escapeHtml(a.name)}${a === actor ? ' <span class="qa-dim">(self)</span>' : ""}</span>
          <span class="qa-hp">${hp.value}/${hp.max}${full ? " full" : ""}</span>
        </label>
        ${numInput()}
        <button type="button" class="btn qa-full" title="Heal to full (up to what's left in the pool)">Full</button>
      </div>`;
  };

  dialog.innerHTML = `
    <div class="title">${escapeHtml(item.name)}</div>

    <div class="field">
      <div class="field-label">Healing Pool — ${escapeHtml(actor.name)}</div>
      <div class="player-row qa-pool">
        <div class="qa-poolbar"><div class="qa-poolfill"></div></div>
        <span class="qa-pool-num"><b class="qa-left">${pool}</b> / ${max}</span>
      </div>
    </div>

    <div class="field">
      <div class="field-label">Heal</div>
      <div class="players">
        ${party.map(row).join("")}
        <div class="player-row qa-target qa-other" data-limit="">
          <label><input type="text" class="qa-other-name" placeholder="Other (who?)" maxlength="60"></label>
          ${numInput()}
          <span class="qa-full-spacer"></span>
        </div>
      </div>
    </div>

    <div class="qa-alloc">Allocating <b class="qa-sum">0</b> · <b class="qa-remaining">${pool}</b> left in pool</div>
    <div class="qa-error" hidden></div>

    <div class="actions">
      <button type="button" class="btn" data-qa="back">Back</button>
      <button type="button" class="btn primary qa-apply" disabled>${escapeHtml(item.name)}</button>
    </div>`;

  const rows = [...dialog.querySelectorAll(".qa-target")];
  const sumEl = dialog.querySelector(".qa-sum");
  const remainingEl = dialog.querySelector(".qa-remaining");
  const leftEl = dialog.querySelector(".qa-left");
  const fillEl = dialog.querySelector(".qa-poolfill");
  const applyBtn = dialog.querySelector(".qa-apply");
  const errEl = dialog.querySelector(".qa-error");

  const inputOf = (r) => r.querySelector("input[type=number]");
  const valueOf = (r) => Math.max(0, Math.floor(Number(inputOf(r).value) || 0));
  const limitOf = (r) => (r.dataset.limit === "" ? Infinity : Number(r.dataset.limit));
  const total = () => rows.reduce((s, r) => s + valueOf(r), 0);
  // Most this row may take: its missing HP, and never more than the pool has left
  const maxFor = (r) => Math.max(0, Math.min(limitOf(r), pool - (total() - valueOf(r))));

  function setValue(r, v) {
    inputOf(r).value = String(Math.max(0, Math.min(maxFor(r), Math.floor(Number(v)) || 0)));
    refresh();
  }

  function refresh() {
    const t = total();
    const remaining = pool - t;
    sumEl.textContent = t;
    remainingEl.textContent = remaining;
    leftEl.textContent = remaining;
    fillEl.style.width = `${max ? Math.round(100 * remaining / max) : 0}%`;
    for (const r of rows) {
      const v = valueOf(r), cap = maxFor(r);
      const [minus, plus] = r.querySelectorAll("[data-step]");
      minus.disabled = v <= 0;
      plus.disabled = v >= cap;
      inputOf(r).disabled = limitOf(r) === 0 || pool <= 0;
      const full = r.querySelector(".qa-full");
      if (full) full.disabled = v >= cap;
    }
    applyBtn.disabled = t <= 0;
  }

  for (const r of rows) {
    const input = inputOf(r);
    input.addEventListener("input", () => { if (valueOf(r) > maxFor(r)) input.value = String(maxFor(r)); refresh(); });
    input.addEventListener("change", () => setValue(r, input.value));
    input.addEventListener("focus", () => input.select());
    r.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", (e) => {
      setValue(r, valueOf(r) + Number(b.dataset.step) * (e.shiftKey ? 5 : 1));
    }));
    r.querySelector(".qa-full")?.addEventListener("click", () => setValue(r, maxFor(r)));
  }

  if (pool <= 0) {
    errEl.hidden = false;
    errEl.textContent = "The pool is empty — it refills on a long rest.";
  }

  dialog.querySelector('[data-qa="back"]').addEventListener("click", back);
  applyBtn.addEventListener("click", async () => {
    const targets = rows.map(r => r.classList.contains("qa-other")
      ? { actorId: null, name: r.querySelector(".qa-other-name").value, amount: valueOf(r) }
      : { actorId: r.dataset.actorId, amount: valueOf(r) })
      .filter(t => t.amount > 0);
    applyBtn.disabled = true;
    applyBtn.textContent = "Applying…";
    errEl.hidden = true;
    try {
      const res = await runAsGM(APPLY, { actorId: actor.id, itemId: item.id, targets });
      const who = res.targets.filter(t => t.applied > 0).map(t => `${t.name} +${t.applied}`).join(", ");
      ui.notifications.info(`${item.name}: ${who}. Pool ${res.after} / ${res.max}.`);
      close();
    } catch (e) {
      errEl.hidden = false;
      errEl.textContent = e.message;
      applyBtn.textContent = item.name;
      refresh();
    }
  });

  refresh();
}

export const LayOnHands = {
  id: ID,
  label: "Lay on Hands",
  icon: "fas fa-hand-holding-heart",
  findItem: (actor) => actor?.items?.find(i => isLayOnHands(i) && poolMax(i) > 0) ?? null,
  summary: (actor, item) => `Pool ${poolLeft(item)} / ${poolMax(item)}`,
  renderPanel,
  gmActions: { [APPLY]: gmApply },
};
