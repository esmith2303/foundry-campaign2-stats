/**
 * Undo for the "+" Abilities chat cards (Add Kill / Damage / Healing / Other,
 * Take Damage, Healer, Lay on Hands).
 *
 * Each card stores what it changed in `abilityUse.undo`:
 *   { kind: "hp",    actorId, value, temp }        HP (and temp HP) added (+) or removed (−)
 *   { kind: "spent", actorId, itemId, path, delta } a "spent" counter raised (hit dice)
 *   { kind: "uses",  actorId, itemId, count }       item uses spent (Healer's Kit)
 *   { kind: "pool",  actorId, itemId, amount }      pool spent (Lay on Hands)
 * Undo reverses each one relative to now (so anything that happened since is
 * kept), marks the card as reverted, and the stats ignore it from then on.
 *
 * Runs on the GM's client. Allowed for the GM, whoever posted the card, and
 * the owner of the character it was for.
 */
import { MODULE_ID, escapeHtml, hpOf } from "./shared.mjs";

export const REVERT = "qa.revert";

/** Can this user undo this card? */
export function canRevert(message, user) {
  const use = message?.flags?.[MODULE_ID]?.abilityUse;
  if (!use || use.reverted) return false;
  if (user?.isGM) return true;
  const authorId = message.author?.id ?? message.author ?? message.user?.id ?? message.user;
  if (authorId && authorId === user?.id) return true;
  const actor = game.actors.get(use.actorId);
  return !!actor?.testUserPermission?.(user, "OWNER");
}

/** Older cards (before undo data was stored): work out what we safely can. */
function legacyUndo(use) {
  const out = [];
  if (use.ability === "add-healing") {
    for (const t of use.targets ?? []) if (t?.actorId && t.applied > 0) out.push({ kind: "hp", actorId: t.actorId, value: t.applied });
  } else if (use.ability === "lay-on-hands") {
    for (const t of use.targets ?? []) if (t?.actorId && t.applied > 0) out.push({ kind: "hp", actorId: t.actorId, value: t.applied });
    const caster = game.actors.get(use.actorId);
    const item = caster?.items?.find?.(i => i.name === use.itemName);
    if (item && use.healing > 0) out.push({ kind: "pool", actorId: caster.id, itemId: item.id, amount: use.healing });
  } else if (use.ability === "take-damage" && use.taken?.applied) {
    return null;   // can't tell HP from temp HP — undo the stats only
  } else if (use.ability === "healer") {
    return null;
  }
  return out;
}

async function restoreUses(item, n) {
  const u = item.system?.uses;
  const max = Number(u?.max) || 0;
  let qty = Math.max(0, Number(item.system?.quantity) || 0);
  if (max <= 0) return item.update({ "system.quantity": qty + n });
  const src = item._source?.system?.uses ?? {};
  const hasSpent = "spent" in src;
  let spent = (hasSpent ? (Number(src.spent) || 0) : max - (Number(src.value) || 0)) - n;
  while (spent < 0) { spent += max; qty += 1; }
  const update = { "system.quantity": qty };
  update[hasSpent ? "system.uses.spent" : "system.uses.value"] = hasSpent ? spent : max - spent;
  return item.update(update);
}

async function restorePool(item, amount) {
  const src = item._source?.system?.uses ?? {};
  if ("spent" in src) return item.update({ "system.uses.spent": Math.max(0, (Number(src.spent) || 0) - amount) });
  const max = Number(item.system?.uses?.max) || 0;
  return item.update({ "system.uses.value": Math.min(max || Infinity, (Number(src.value) || 0) + amount) });
}

/** GM side. */
export async function gmRevert({ messageId } = {}, user) {
  const message = game.messages.get(messageId);
  const use = message?.flags?.[MODULE_ID]?.abilityUse;
  if (!use) throw new Error("That card can't be undone.");
  if (use.reverted) throw new Error("That's already been undone.");
  if (!canRevert(message, user)) throw new Error("You can only undo your own entries.");

  const undo = Array.isArray(use.undo) ? use.undo : legacyUndo(use);
  const notes = [];
  if (undo === null) notes.push("sheet changes not undone (card from an older version) — fix HP by hand");

  for (const e of [...(undo ?? [])].reverse()) {
    const actor = game.actors.get(e.actorId);
    if (!actor) { notes.push("a character no longer exists"); continue; }
    if (e.kind === "hp") {
      const hp = hpOf(actor);
      const temp = Math.max(0, Number(actor.system?.attributes?.hp?.temp) || 0);
      const update = { "system.attributes.hp.value": Math.max(0, Math.min(hp.max || Infinity, hp.value - (Number(e.value) || 0))) };
      if (e.temp) update["system.attributes.hp.temp"] = Math.max(0, temp - (Number(e.temp) || 0));
      await actor.update(update);
    } else {
      const item = actor.items.get(e.itemId);
      if (!item) { notes.push(`${actor.name}'s item is gone`); continue; }
      if (e.kind === "spent") {
        const cur = Number(foundry.utils.getProperty(item, e.path)) || 0;
        await item.update({ [e.path]: Math.max(0, cur - (Number(e.delta) || 0)) });
      } else if (e.kind === "uses") await restoreUses(item, Number(e.count) || 0);
      else if (e.kind === "pool") await restorePool(item, Number(e.amount) || 0);
    }
  }

  // Mark the card: it stays in chat (struck through) but no longer counts
  const banner = `<div class="qa-reverted-banner"><i class="fas fa-rotate-left"></i> Undone by ${escapeHtml(user?.name ?? "the GM")}${notes.length ? ` — ${escapeHtml(notes.join("; "))}` : ""}</div>`;
  const content = String(message.content ?? "")
    .replace('class="skill-check-card qa-card', 'class="skill-check-card qa-card qa-reverted')
    .replace('<section class="card-content">', `<section class="card-content">${banner}`);
  await message.update({
    content,
    [`flags.${MODULE_ID}.abilityUse.reverted`]: { by: user?.id ?? null, byName: user?.name ?? null, at: Date.now(), notes },
  });
  return { notes };
}

/** Player side: adds the Undo button to a rendered card. */
export function addRevertButton(message, root, runAsGM) {
  if (!message || !root?.querySelector) return;
  const card = root.querySelector(".qa-card");
  if (!card || card.querySelector(".qa-revert") || !canRevert(message, game.user)) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "qa-revert";
  btn.innerHTML = '<i class="fas fa-rotate-left"></i> Undo';
  btn.title = "Undo this — puts back everything it changed and removes it from the stats";
  (card.querySelector(".card-content") ?? card).appendChild(btn);
  btn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed");
      btn.innerHTML = '<i class="fas fa-rotate-left"></i> Click again to undo';
      setTimeout(() => { if (btn.isConnected && !btn.disabled) { btn.classList.remove("armed"); btn.innerHTML = '<i class="fas fa-rotate-left"></i> Undo'; } }, 4000);
      return;
    }
    btn.disabled = true; btn.textContent = "Undoing…";
    try {
      const res = await runAsGM(REVERT, { messageId: message.id ?? message._id });
      ui.notifications.info(res?.notes?.length ? `Undone (${res.notes.join("; ")}).` : "Undone.");
    } catch (err) {
      ui.notifications.error(err.message);
      btn.disabled = false; btn.classList.remove("armed"); btn.innerHTML = '<i class="fas fa-rotate-left"></i> Undo';
    }
  });
}
