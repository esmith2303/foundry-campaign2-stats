/**
 * Healer feat (2024 "Battle Medic") — any character with the Healer feat and a
 * Healer's Kit. Each use spends one kit use; the patient spends one of their
 * Hit Point Dice, the healer rolls it and adds their Proficiency Bonus.
 * "Healing Rerolls": a 1 on that die is rerolled once (Foundry's `r1`), using
 * the same hit die and the same kit use.
 *
 * Several uses (across several patients) can be applied from one popup. The
 * GM's client rolls, spends the hit dice and kit uses, heals, and posts one card.
 */
import { MODULE_ID, escapeHtml, statCard, partyCharacters, hpOf, profOf, hitDiceOf, hitDiceLeft, hitDiceLabel, usesLeft, spendUses } from "./shared.mjs";

const APPLY = "healer.apply";

function slug(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
// "Healer", "Healer (Origin Feat)" … but never "Healer's Kit"
function isHealerFeat(item) {
  if (item?.type !== "feat") return false;
  return item.system?.identifier === "healer" || /^healer(?!['’]?s?[-\s]*kit)\b/i.test(String(item.name ?? "").trim());
}
function isHealersKit(item) {
  return item?.type !== "feat" && (item?.system?.identifier === "healers-kit" || /^healer'?s?[-\s]?kit/i.test(item?.name ?? ""));
}
/** The kit to use: one with uses left, else any (so the panel can say it's empty). */
function findKit(actor) {
  const kits = actor?.items?.filter(isHealersKit) ?? [];
  return kits.find(k => usesLeft(k) > 0) ?? kits[0] ?? null;
}

// ── GM side ──────────────────────────────────────────────────────────────────

async function gmApply({ actorId, featId, kitId, plan, reroll = true } = {}, user) {
  const actor = game.actors.get(actorId);
  if (!actor) throw new Error("Character not found.");
  if (!user?.isGM && !actor.testUserPermission(user, "OWNER")) throw new Error("You don't own that character.");
  const feat = actor.items.get(featId);
  if (!isHealerFeat(feat)) throw new Error("The Healer feat isn't on that character.");
  const kit = actor.items.get(kitId);
  if (!kit || !isHealersKit(kit)) throw new Error("Healer's Kit not found.");

  const wanted = (Array.isArray(plan) ? plan : [])
    .map(p => ({ actorId: p?.actorId, count: Math.floor(Number(p?.count)) || 0 }))
    .filter(p => p.count > 0);
  const totalUses = wanted.reduce((s, p) => s + p.count, 0);
  if (!totalUses) throw new Error("Choose who to tend to.");
  const kitLeft = usesLeft(kit);
  if (totalUses > kitLeft) throw new Error(`Not enough Healer's Kit uses: ${totalUses} needed, ${kitLeft} left.`);
  const patients = wanted.map(p => {
    const t = game.actors.get(p.actorId);
    if (!t) throw new Error("A selected character no longer exists.");
    if (hitDiceLeft(t) < p.count) throw new Error(`${t.name} only has ${hitDiceLeft(t)} hit dice left.`);
    return { target: t, count: p.count };
  });

  const prof = profOf(actor);
  const rows = [], rolls = [], heals = [];
  let hdSpent = 0;
  for (const { target, count } of patients) {
    const hp = hpOf(target);
    let current = hp.value;
    for (let i = 0; i < count; i++) {
      const hd = hitDiceOf(target).find(h => h.left > 0);
      const roll = await new Roll(`1d${hd.faces}${reroll ? "r1" : ""} + ${prof}`).evaluate();
      const applied = Math.max(0, Math.min(roll.total, hp.max - current));
      current += applied;
      await hd.item.update({ [hd.path]: hd.spent + 1 });
      hdSpent++;
      rolls.push(roll);
      heals.push(applied);
      rows.push({
        name: target.name, value: `+${applied}`, valueCls: "success", roll,
        meta: [`hit die d${hd.faces}`, applied < roll.total && `capped at full HP (${roll.total})`],
      });
    }
    if (current !== hp.value) await target.update({ "system.attributes.hp.value": current });
    rows[rows.length - 1].meta.push(`HP ${current} / ${hp.max}`);
  }
  await spendUses(kit, totalUses);
  const kitAfter = usesLeft(kit);

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: await statCard({
      icon: "fas fa-kit-medical", title: feat.name, subtitle: actor.name,
      badge: `Kit ${kitAfter} left`, rows,
      summary: `${totalUses} kit use${totalUses === 1 ? "" : "s"} · ${hdSpent} hit ${hdSpent === 1 ? "die" : "dice"} spent`,
    }),
    rolls,
    flags: { [MODULE_ID]: { abilityUse: { ability: "healer", actorId: actor.id, itemName: feat.name, heals, kitUses: totalUses } } },
  });
  return { totalUses, kitAfter, healed: heals.reduce((s, h) => s + h, 0) };
}

// ── Player side ──────────────────────────────────────────────────────────────

function renderPanel(dialog, { actor, item, close, back, runAsGM }) {
  const kit = findKit(actor);
  const kitLeft = kit ? usesLeft(kit) : 0;
  const prof = profOf(actor);
  const party = partyCharacters();

  if (!kitLeft) {
    dialog.innerHTML = `
      <div class="title">${escapeHtml(item.name)}</div>
      <div class="player-row qa-empty">${kit ? `${escapeHtml(kit.name)} is out of uses.` : `${escapeHtml(actor.name)} has no Healer's Kit in their inventory.`}</div>
      <div class="actions"><button type="button" class="btn" data-qa="back">Back</button></div>`;
    dialog.querySelector('[data-qa="back"]').addEventListener("click", back);
    return;
  }

  const row = (a) => {
    const hp = hpOf(a);
    const hdLeft = hitDiceLeft(a);
    return `
      <div class="player-row qa-target" data-actor-id="${a.id}" data-limit="${hdLeft}">
        <label>
          <span>${escapeHtml(a.name)}${a === actor ? ' <span class="qa-dim">(self)</span>' : ""}</span>
          <span class="qa-hp">${hp.value}/${hp.max} · HD ${hitDiceLabel(a)}</span>
        </label>
        <div class="num-input">
          <button type="button" data-step="-1">−</button>
          <input type="number" min="0" step="1" value="0">
          <button type="button" data-step="1">+</button>
        </div>
      </div>`;
  };

  dialog.innerHTML = `
    <div class="title">${escapeHtml(item.name)}</div>
    <div class="field">
      <div class="field-label">${escapeHtml(kit.name)} — ${escapeHtml(actor.name)}</div>
      <div class="player-row qa-pool">
        <span class="qa-pool-num">Uses <b class="qa-left">${kitLeft}</b></span>
        <span class="qa-tag">Each use: patient's hit die + ${prof}</span>
      </div>
    </div>
    <div class="field">
      <div class="field-label">Tend to (uses each)</div>
      <div class="players">${party.map(row).join("")}</div>
    </div>
    <div class="checkbox-row">
      <label><input type="checkbox" class="qa-reroll" checked> Reroll 1s (Healer feat — same hit die &amp; kit use)</label>
    </div>
    <div class="qa-alloc">Using <b class="qa-sum">0</b> · <b class="qa-remaining">${kitLeft}</b> kit uses left</div>
    <div class="qa-error" hidden></div>
    <div class="actions">
      <button type="button" class="btn" data-qa="back">Back</button>
      <button type="button" class="btn primary qa-apply" disabled>Use ${escapeHtml(kit.name)}</button>
    </div>`;

  const rows = [...dialog.querySelectorAll(".qa-target")];
  const inputOf = (r) => r.querySelector("input[type=number]");
  const valueOf = (r) => Math.max(0, Math.floor(Number(inputOf(r).value) || 0));
  const total = () => rows.reduce((s, r) => s + valueOf(r), 0);
  const maxFor = (r) => Math.max(0, Math.min(Number(r.dataset.limit), kitLeft - (total() - valueOf(r))));
  const applyBtn = dialog.querySelector(".qa-apply");
  const err = dialog.querySelector(".qa-error");

  function refresh() {
    const t = total();
    dialog.querySelector(".qa-sum").textContent = t;
    dialog.querySelector(".qa-remaining").textContent = kitLeft - t;
    dialog.querySelector(".qa-left").textContent = kitLeft - t;
    for (const r of rows) {
      const v = valueOf(r), cap = maxFor(r);
      const [minus, plus] = r.querySelectorAll("[data-step]");
      minus.disabled = v <= 0;
      plus.disabled = v >= cap;
      inputOf(r).disabled = Number(r.dataset.limit) === 0;
    }
    applyBtn.disabled = t <= 0;
  }
  const setValue = (r, v) => { inputOf(r).value = String(Math.max(0, Math.min(maxFor(r), Math.floor(Number(v)) || 0))); refresh(); };
  for (const r of rows) {
    const input = inputOf(r);
    input.addEventListener("input", () => { if (valueOf(r) > maxFor(r)) input.value = String(maxFor(r)); refresh(); });
    input.addEventListener("change", () => setValue(r, input.value));
    input.addEventListener("focus", () => input.select());
    r.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => setValue(r, valueOf(r) + Number(b.dataset.step))));
  }

  dialog.querySelector('[data-qa="back"]').addEventListener("click", back);
  applyBtn.addEventListener("click", async () => {
    const plan = rows.map(r => ({ actorId: r.dataset.actorId, count: valueOf(r) })).filter(p => p.count > 0);
    applyBtn.disabled = true; applyBtn.textContent = "Applying…"; err.hidden = true;
    try {
      const res = await runAsGM(APPLY, { actorId: actor.id, featId: item.id, kitId: kit.id, plan, reroll: dialog.querySelector(".qa-reroll").checked });
      ui.notifications.info(`${item.name}: healed ${res.healed} HP using ${res.totalUses} kit use(s); ${res.kitAfter} left.`);
      close();
    } catch (e) {
      err.hidden = false; err.textContent = e.message;
      applyBtn.textContent = `Use ${kit.name}`;
      refresh();
    }
  });
  refresh();
}

export const Healer = {
  id: "healer",
  label: "Healer",
  icon: "fas fa-kit-medical",
  findItem: (actor) => actor?.items?.find(isHealerFeat) ?? null,
  summary: (actor) => {
    const kit = findKit(actor);
    return kit ? `Kit ${usesLeft(kit)} · +${profOf(actor)}` : "No Healer's Kit";
  },
  renderPanel,
  gmActions: { [APPLY]: gmApply },
};
