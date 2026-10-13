/**
 * Haggling and sale offers between a player and the GM.
 *
 *   player ── shop.offer ───────────▶ GM popup (Persuasion roll shown)
 *          ◀── shop.offerReply ─────  accepted | countered | refused | done | error
 *   player ── shop.counterReply ────▶ (accept or decline the GM's counter-offer)
 *   player ── shop.offerCancel ─────▶ (withdraw while waiting)
 *
 * offer = { id, userId, kind: "buy" | "sell", shopId, shopLabel, actorId, actorName,
 *           roll: { total, d20, formula } | null,
 *           lines: [{ key, name, img, qty, listCp, offerCp }] }
 *   buy:  key = ware key,   listCp = the shop's price each
 *   sell: key = item id,    listCp = the item's listed value each
 *
 * What happens when a deal is agreed (record the haggled price / carry out the
 * sale) is up to the shop: see configureHaggle().
 */
import { MODULE_ID, escapeHtml } from "../abilities/shared.mjs";
import { activeGM, isPrimaryGM } from "../QuickActions.mjs";
import { openPopup } from "../popup.mjs";
import { formatCp } from "./currency.mjs";

const SOCKET = `module.${MODULE_ID}`;

// ── Player side ──────────────────────────────────────────────────────────────

const waiting = new Map();   // offerId → reply handler

/** Roll Persuasion for the actor (posts the usual dnd5e roll card). */
export async function rollPersuasion(actor) {
  let res = null;
  try {
    const v = game.system?.version ?? "4.1.0";
    const newApi = (() => { try { return !foundry.utils.isNewerVersion("4.1.0", v); } catch { return true; } })();
    res = newApi
      ? await actor.rollSkill({ skill: "per" }, { configure: false }, { create: true })
      : await actor.rollSkill("per", { fastForward: true, chatMessage: true });
  } catch (e) {
    console.warn(`${MODULE_ID} | Persuasion roll failed`, e);
  }
  const roll = Array.isArray(res) ? res[0] : res;
  if (!roll || typeof roll.total !== "number") return null;
  const d20 = roll.dice?.find?.(d => d.faces === 20);
  const kept = d20?.results?.find?.(r => r.active !== false && !r.discarded)?.result ?? null;
  return { total: roll.total, d20: kept, formula: roll.formula };
}

/** Send an offer to the GM; `onReply(reply)` is called with each answer. Returns the offer id. */
export function sendOffer(offer, onReply) {
  if (!activeGM()) throw new Error("The GM needs to be logged in to haggle.");
  offer.id = foundry.utils.randomID();
  offer.userId = game.user.id;
  waiting.set(offer.id, onReply);
  game.socket.emit(SOCKET, { action: "shop.offer", offer });
  return offer.id;
}
export function answerCounter(offerId, accept) {
  game.socket.emit(SOCKET, { action: "shop.counterReply", offerId, userId: game.user.id, accept });
}
export function cancelOffer(offerId) {
  waiting.delete(offerId);
  game.socket.emit(SOCKET, { action: "shop.offerCancel", offerId, userId: game.user.id });
}

// ── GM side ──────────────────────────────────────────────────────────────────

const open = new Map();   // offerId → { offer, popup, counterLines }
let onAgreed = async () => ({});
let stagger = 0;

/** `agreed(offer, lines, user)` runs when a deal is struck and returns details for the player. */
export function configureHaggle({ agreed }) { onAgreed = agreed; }

/** Socket handler; returns true if the message was a haggle message. */
export function handleHaggleSocket(data) {
  switch (data?.action) {
    case "shop.offer":
      if (isPrimaryGM()) showOffer(data.offer);
      return true;
    case "shop.offerReply":
      if (data.userId === game.user.id) {
        const h = waiting.get(data.offerId);
        if (["accepted", "refused", "declined", "done", "error", "cancelled"].includes(data.status)) waiting.delete(data.offerId);
        h?.(data);
      }
      return true;
    case "shop.counterReply":
      if (isPrimaryGM()) counterAnswered(data);
      return true;
    case "shop.offerCancel":
      if (isPrimaryGM()) {
        const o = open.get(data.offerId);
        if (o) { open.delete(data.offerId); o.popup.close(); ui.notifications.info(`${o.offer.actorName} withdrew their offer.`); }
      }
      return true;
  }
  return false;
}

function reply(offer, status, extra = {}) {
  game.socket.emit(SOCKET, { action: "shop.offerReply", offerId: offer.id, userId: offer.userId, status, ...extra });
}

const gpValue = (cp) => +(cp / 100).toFixed(2);
const toCpGp = (v) => Math.max(0, Math.round((Number(v) || 0) * 100));

function rollText(roll) {
  if (!roll) return "no roll";
  const nat = roll.d20 === 20 ? " · natural 20!" : roll.d20 === 1 ? " · natural 1" : roll.d20 ? ` · d20 ${roll.d20}` : "";
  return `Persuasion ${roll.total}${nat}`;
}

function showOffer(offer) {
  const user = game.users.get(offer.userId);
  const left = Math.max(10, window.innerWidth - 560 - (stagger % 4) * 24), top = 70 + (stagger % 4) * 24;
  stagger++;
  // Closing it by accident doesn't refuse the offer: it waits in the "Back to …" dock until answered
  const popup = openPopup({ id: `qa-offer-${offer.id}`, floating: true, className: "qa-offer-dialog", left, top,
    stash: { label: `${offer.actorName}'s ${offer.kind === "sell" ? "sale offer" : "haggle"}`, icon: "fas fa-comments-dollar" },
    onClose: () => { if (open.has(offer.id)) { open.delete(offer.id); reply(offer, "refused", { message: "The shopkeeper isn't interested." }); } } });
  const entry = { offer, popup, counterLines: null };
  open.set(offer.id, entry);
  const sell = offer.kind === "sell";

  popup.body.innerHTML = `
    <div class="title qa-drag-handle">${sell ? "Sale offer" : "Haggle"}</div>
    <div class="qa-offer-head">
      <div><b>${escapeHtml(offer.actorName)}</b>${user ? ` <span class="qa-tag">${escapeHtml(user.name)}</span>` : ""}</div>
      <div class="qa-tag">${escapeHtml(offer.shopLabel)}</div>
      <div class="qa-offer-roll ${offer.roll?.d20 === 20 ? "nat20" : offer.roll?.d20 === 1 ? "nat1" : ""}">${offer.roll ? `<i class="fas fa-comments"></i> ${escapeHtml(rollText(offer.roll))}` : sell ? "Asking the usual price — no Persuasion roll" : ""}</div>
    </div>
    <div class="field">
      <div class="field-label qa-offer-cols"><span></span><span>${sell ? "Selling" : "Item"}</span><span>${sell ? "Value" : "Price"}</span><span>Asks</span><span>Deal, gp</span></div>
      <div class="players">
        ${offer.lines.map(l => `
          <div class="player-row qa-offer-line" data-key="${escapeHtml(l.key)}">
            <input type="checkbox" class="qa-offer-take" checked title="${sell ? "Buy this" : "Include"}">
            <label class="qa-offer-name"><span>${escapeHtml(l.name)}</span><span class="qa-tag">×${l.qty}</span></label>
            <span class="qa-offer-list">${formatCp(l.listCp)}</span>
            <span class="qa-offer-ask">${formatCp(l.offerCp)}</span>
            <input type="number" class="qa-num qa-offer-price" min="0" step="any" value="${gpValue(l.offerCp)}">
          </div>`).join("")}
      </div>
      <div class="qa-note">${sell ? "Untick anything the shop won't buy. Change a price to make a counter-offer." : "Change a price to make a counter-offer."}</div>
    </div>
    <div class="qa-offer-state qa-note" hidden></div>
    <div class="qa-error" hidden></div>
    <div class="actions">
      <button type="button" class="btn" data-act="refuse">Refuse</button>
      <button type="button" class="btn primary" data-act="accept">Accept</button>
    </div>`;

  const body = popup.body;
  const accept = body.querySelector('[data-act="accept"]');
  const err = body.querySelector(".qa-error");
  const linesNow = () => offer.lines.map(l => {
    const row = body.querySelector(`.qa-offer-line[data-key="${CSS.escape(l.key)}"]`);
    return { ...l, take: row.querySelector(".qa-offer-take").checked, dealCp: toCpGp(row.querySelector(".qa-offer-price").value) };
  });
  const isCounter = () => linesNow().some(l => l.take && l.dealCp !== l.offerCp);
  const refresh = () => {
    const ls = linesNow();
    for (const l of ls) {
      const row = body.querySelector(`.qa-offer-line[data-key="${CSS.escape(l.key)}"]`);
      row.classList.toggle("qa-offer-off", !l.take);
      row.querySelector(".qa-offer-price").disabled = !l.take;
      row.querySelector(".qa-offer-price").classList.toggle("edited", l.take && l.dealCp !== l.offerCp);
    }
    const none = !ls.some(l => l.take);
    accept.disabled = none;
    accept.textContent = none ? "Accept" : isCounter() ? "Counter-offer" : "Accept";
  };
  body.querySelectorAll(".qa-offer-take, .qa-offer-price").forEach(el => el.addEventListener("input", refresh));
  body.querySelectorAll(".qa-offer-take").forEach(el => el.addEventListener("change", refresh));
  refresh();

  body.querySelector('[data-act="refuse"]').addEventListener("click", () => {
    open.delete(offer.id);
    reply(offer, "refused", { message: sell ? "The shopkeeper won't buy that." : "The shopkeeper won't budge on the price." });
    popup.close();
  });
  accept.addEventListener("click", async () => {
    const lines = linesNow().filter(l => l.take).map(({ take, ...l }) => l);
    err.hidden = true;
    if (isCounter()) {
      entry.counterLines = lines;
      reply(offer, "countered", { lines });
      setWaiting(entry, `Counter-offer sent — waiting for ${offer.actorName}…`);
      return;
    }
    await finalise(entry, lines);
  });
}

function setWaiting(entry, text) {
  const b = entry.popup.body;
  const state = b.querySelector(".qa-offer-state");
  state.hidden = false; state.textContent = text;
  b.querySelectorAll("input, .actions .btn.primary").forEach(el => { el.disabled = true; });
}

async function finalise(entry, lines) {
  const { offer, popup } = entry;
  const err = popup.body.querySelector(".qa-error");
  setWaiting(entry, "Making the deal…");
  try {
    const result = await onAgreed(offer, lines, game.users.get(offer.userId));
    open.delete(offer.id);
    reply(offer, offer.kind === "sell" ? "done" : "accepted", { lines, result });
    popup.close();
  } catch (e) {
    err.hidden = false; err.textContent = e.message;
    popup.body.querySelector(".qa-offer-state").hidden = true;
    reply(offer, "error", { message: e.message });
    open.delete(offer.id);
  }
}

async function counterAnswered({ offerId, accept }) {
  const entry = open.get(offerId);
  if (!entry) return;
  if (!accept) {
    open.delete(offerId);
    reply(entry.offer, "declined", { message: "Counter-offer declined." });
    setWaiting(entry, `${entry.offer.actorName} declined the counter-offer.`);
    setTimeout(() => entry.popup.close(), 1800);
    return;
  }
  await finalise(entry, entry.counterLines);
}
