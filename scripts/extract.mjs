/**
 * extract.mjs — turns chat messages into dice + outcome events.
 *
 * This is the ONLY place that decides what a roll means. It is used by:
 *   - the Foundry module at upload time (reads game.messages)
 *   - scripts/process-chat-export.mjs (reads a chat-log export JSON)
 * so live uploads and backfills always produce identical numbers.
 *
 * Every event is keyed by its chat message ID, and the backend replaces all
 * events for a message when it is uploaded again — so uploading the same chat
 * log twice never double counts, it just corrects.
 *
 * Pure JS, no Foundry globals: anything world-specific comes in via `ctx`.
 */

export const MODULE_ID = "dnd-group-campaign-2-stats";
export const TRACKED_FACES = [4, 6, 8, 10, 12, 20];

// ── Roll helpers ─────────────────────────────────────────────────────────────

/** Accepts a Roll instance, its JSON object, or a JSON string. */
function asRollData(r) {
  if (!r) return null;
  if (typeof r === "string") { try { return JSON.parse(r); } catch { return null; } }
  if (typeof r !== "object") return null;          // midi's d20AttackRoll is a bare number
  if (typeof r.toJSON === "function") {          // a live Roll instance
    try { return r.toJSON(); } catch { /* fall through */ }
  }
  return r;
}

/** Every die result in a roll, including dropped advantage/disadvantage dice. */
export function diceInRoll(rollLike) {
  const roll = asRollData(rollLike);
  const out = [];   // [faces, value]
  if (!roll) return out;
  const visit = (term) => {
    if (!term || typeof term !== "object") return;
    if (TRACKED_FACES.includes(term.faces) && Array.isArray(term.results)) {
      for (const r of term.results) if (typeof r?.result === "number") out.push([term.faces, r.result]);
    }
    for (const t of term.terms || []) visit(t);
    for (const t of term.operands || []) visit(t);
    for (const inner of term.rolls || []) for (const t of asRollData(inner)?.terms || []) visit(t);
  };
  for (const t of roll.terms || []) visit(t);
  return out;
}

/** The kept d20 of a roll (null if none). */
function keptD20(rollLike) {
  const roll = asRollData(rollLike);
  for (const t of roll?.terms || []) {
    if (t?.faces === 20 && Array.isArray(t.results)) {
      const kept = t.results.find(r => r.active !== false && !r.discarded);
      if (kept) return kept.result;
    }
  }
  return null;
}

/** "Actor.abc" / "Scene.x.Token.y.Actor.abc" → "abc" */
export function actorIdFromUuid(uuid) {
  const m = /(?:^|\.)Actor\.([A-Za-z0-9]{16})/.exec(uuid || "");
  return m ? m[1] : null;
}

const CHECK_TYPES = new Set(["skill", "ability", "check", "tool"]);
const SAVE_TYPES = new Set(["save", "savingthrow", "savingThrow"]);

function outcomeTypeFor(rollType) {
  if (SAVE_TYPES.has(rollType)) return "save";
  if (CHECK_TYPES.has(rollType)) return "check";
  if (rollType === "death" || rollType === "deathsave") return "death";
  return null;
}

// ── Main extractor ───────────────────────────────────────────────────────────

/**
 * @param message  plain chat message data: { id|_id, timestamp, speaker, flags, rolls }
 * @param ctx      {
 *   isPlayerCharacter(actorId) → bool,
 *   actorName(actorId, fallback) → string,
 *   resolveActorId?(uuid) → actorId|null   (live only: for token UUIDs without an Actor part)
 *   includeNpcs?: bool
 * }
 * @returns { messageId, timestamp, dice: [{actorId, actorName, dieType, face, count}],
 *            outcomes: [{actorId, actorName, type, success, key}] }
 */
export function extractMessage(message, ctx) {
  const messageId = message.id ?? message._id;
  const flags = message.flags || {};
  const dnd = flags.dnd5e || {};
  const midi = flags["midi-qol"] || {};
  const monks = flags["monks-tokenbar"] || {};
  const skillCheck = flags[MODULE_ID]?.skillCheck;
  const abilityUse = flags[MODULE_ID]?.abilityUse;
  const speakerId = message.speaker?.actor || null;

  const tracked = (actorId) => !!actorId && (ctx.includeNpcs || ctx.isPlayerCharacter(actorId));
  const nameOf = (actorId, fallback) => ctx.actorName(actorId, fallback) || fallback || "Unknown";
  const resolve = (uuid) => actorIdFromUuid(uuid) ?? ctx.resolveActorId?.(uuid) ?? null;

  const diceCounts = new Map();   // "actorId|faces|value" → count
  const addDice = (actorId, pairs) => {
    if (!tracked(actorId)) return;
    for (const [faces, value] of pairs) {
      const k = `${actorId}|${faces}|${value}`;
      diceCounts.set(k, (diceCounts.get(k) || 0) + 1);
    }
  };

  const outcomes = [];
  const addOutcome = (actorId, type, success, source, fallbackName, amount = null, extra = {}) => {
    if (!tracked(actorId) || !type || typeof success !== "boolean") return;
    outcomes.push({
      actorId, actorName: nameOf(actorId, fallbackName), type, success,
      key: `${messageId}:${actorId}:${type}:${source}`,
      amount: Number.isFinite(amount) ? amount : null,
      detail: extra.detail ?? null,      // e.g. damage type
      item: extra.item ?? null,          // weapon / spell / feature name
    });
  };

  const monkEntries = monks.requests
    ? Object.entries(monks).filter(([k, v]) => k.startsWith("token") && v && typeof v === "object" && v.actorid)
    : [];

  // ── Dice ───────────────────────────────────────────────────────────────────
  // message.rolls is the single source of truth for a normal message. midi-qol
  // ALSO copies the attack and damage rolls into its flags — reading those too
  // was the double-counting bug, so they are deliberately ignored here.
  if (monkEntries.length) {
    // Monk's TokenBar request card: no speaker, each token's roll lives on its entry
    for (const [, e] of monkEntries) if (e.roll) addDice(e.actorid, diceInRoll(e.roll));
  } else if (skillCheck) {
    // Our own skill-check card: rolls are never posted as messages, only the breakdown
    for (const [actorId, r] of Object.entries(skillCheck.rolls || {})) {
      const b = r?.breakdown;
      if (!b) continue;
      const pairs = [];
      if (b.d20Result != null) pairs.push([20, b.d20Result]);
      if (b.d20Dropped != null) pairs.push([20, b.d20Dropped]);
      for (const bd of b.bonusDice || []) {
        const faces = parseInt(/d(\d+)/.exec(bd.formula || "")?.[1]);
        if (TRACKED_FACES.includes(faces)) for (const v of bd.rolls || []) pairs.push([faces, v]);
      }
      addDice(actorId, pairs);
    }
  } else if (speakerId) {
    for (const r of message.rolls || []) addDice(speakerId, diceInRoll(r));
  }

  // ── Attacks (by the speaker) ───────────────────────────────────────────────
  if (speakerId) {
    const attackRoll = midi.attackRoll
      ?? (dnd.roll?.type === "attack" ? message.rolls?.[0] : null);
    const targets = Array.isArray(dnd.targets) && dnd.targets.length ? dnd.targets
                  : Array.isArray(midi.targets) ? midi.targets : [];
    // An attack with no target can't hit or miss — skip it rather than call it a miss
    if (asRollData(attackRoll) && targets.length) {
      let hit = typeof midi.isHit === "boolean" ? midi.isHit : null;
      if (hit === null) {
        const d20 = keptD20(attackRoll);
        const total = asRollData(attackRoll)?.total;
        const ac = targets[0]?.ac;
        if (d20 === 20) hit = true;
        else if (d20 === 1) hit = false;
        else if (typeof total === "number" && typeof ac === "number") hit = total >= ac;
      }
      addOutcome(speakerId, "attack", hit, "atk", message.speaker?.alias);
    }

    // Heals: one per healing activity used
    if (dnd.activity?.type === "heal") addOutcome(speakerId, "heal", true, "heal", message.speaker?.alias);
  }

  // ── Saves made by the TARGETS of a card ────────────────────────────────────
  // midi records each target's save on the caster's card (often a monster's),
  // usually with no separate message from the player — this is where most PC
  // saves live.
  for (const t of Array.isArray(dnd.targets) ? dnd.targets : []) {
    if (typeof t?.saved !== "boolean") continue;
    const actorId = resolve(t.uuid);
    addOutcome(actorId, "save", t.saved, "card", t.name);
  }

  // ── Monk's TokenBar requested saves / checks ───────────────────────────────
  for (const [, e] of monkEntries) {
    if (typeof e.passed !== "boolean") continue;   // no DC set, or contested
    const type = outcomeTypeFor(e.request?.type ?? monks.what);
    addOutcome(e.actorid, type, e.passed, "monks", e.realname || e.name);
  }

  // ── Our Quick Actions cards ("+" button) ──────────────────────────────────
  // heals:  one heal per entry, amount added to total healing (Lay on Hands,
  //         Add Healing, Healer kit uses). Older cards used a single `healing`.
  // damage: manual damage, added to total damage / damage type / item.
  // kill:   manual kill, added to kills.
  if (abilityUse?.actorId) {
    const who = abilityUse.actorId, alias = message.speaker?.alias, item = abilityUse.itemName ?? null;
    const heals = Array.isArray(abilityUse.heals) ? abilityUse.heals
                : Number(abilityUse.healing) > 0 ? [Number(abilityUse.healing)] : [];
    heals.forEach((amt, i) => addOutcome(who, "heal", true, i ? `ability${i}` : "ability", alias, Math.max(0, Number(amt) || 0), { item }));
    const dmg = abilityUse.damage;
    if (dmg && Number(dmg.amount) > 0) {
      addOutcome(who, "damage", true, "manual", alias, Number(dmg.amount), { detail: dmg.type || null, item });
    }
    if (abilityUse.kill) addOutcome(who, "kill", true, "manual", alias, 1, { item });

    // Take Damage → damage taken (detail = damage type)
    const taken = abilityUse.taken;
    if (taken && Number(taken.amount) > 0) {
      addOutcome(who, "damage_taken", true, "manual", alias, Number(taken.amount), { detail: taken.type || null });
    }

    // Add Other → one attack / save outcome per count (so hit % and save %
    // include them), tagged detail "manual" so the server can also add them to
    // midi-qol's attack / save totals; crits, fumbles and the biggest hit as amounts.
    const other = abilityUse.other;
    if (other) {
      const n = (v) => Math.max(0, Math.min(500, Math.floor(Number(v)) || 0));
      // `attacks` may be lower than the hits + misses (attack already counted
      // elsewhere, only the result is being added): those still count in hit %
      // ("manual-hit") but aren't added to the attack total ("manual").
      const hits = n(other.hits), attacks = n(other.attacks);
      const rows = hits + Math.max(0, attacks - hits, n(other.fumbles));   // fumbles are misses
      for (let i = 0; i < rows; i++) addOutcome(who, "attack", i < hits, `other${i}`, alias, null, { detail: i < attacks ? "manual" : "manual-hit" });
      for (let i = 0; i < n(other.saveSuccess); i++) addOutcome(who, "save", true, `otherS${i}`, alias, null, { detail: "manual" });
      for (let i = 0; i < n(other.saveFail); i++) addOutcome(who, "save", false, `otherF${i}`, alias, null, { detail: "manual" });
      if (n(other.crits)) addOutcome(who, "crit", true, "other", alias, n(other.crits));
      if (n(other.fumbles)) addOutcome(who, "fumble", true, "other", alias, n(other.fumbles));
      if (hits && n(other.maxHit)) addOutcome(who, "max_hit", true, "other", alias, n(other.maxHit));
      // Corrections: the server moves this many misses → hits / failed → passed saves
      if (n(other.missToHit)) addOutcome(who, "attack_fix", true, "other", alias, n(other.missToHit));
      if (n(other.failToPass)) addOutcome(who, "save_fix", true, "other", alias, n(other.failToPass));
    }
  }

  // ── Our skill-check cards ──────────────────────────────────────────────────
  if (skillCheck) {
    for (const [actorId, r] of Object.entries(skillCheck.rolls || {})) {
      addOutcome(actorId, "check", r?.success, "sc");
    }
  }

  // ── Standalone save / check / death rolls with a known DC ──────────────────
  if (speakerId && !monkEntries.length && dnd.roll?.type) {
    const type = outcomeTypeFor(dnd.roll.type);
    const roll = asRollData(message.rolls?.[0]);
    if (type && roll && typeof roll.total === "number") {
      let success = null;
      if (type === "death") {
        success = keptD20(roll) === 20 || roll.total >= 10;
      } else {
        const dc = roll.options?.target ?? dnd.roll.dc ?? dnd.targetDC;
        if (typeof dc === "number") success = roll.total >= dc;
      }
      addOutcome(speakerId, type, success, "roll", message.speaker?.alias);
    }
  }

  // ── Shop receipts (one row per item line, prices in copper) ──────────────
  const purchases = [];
  const shop = flags[MODULE_ID]?.shopPurchase;
  if (shop?.actorId && tracked(shop.actorId) && Array.isArray(shop.lines)) {
    shop.lines.forEach((l, i) => {
      const qty = Math.floor(Number(l?.qty)) || 0, unitCp = Math.round(Number(l?.unitCp));
      if (!l?.name || !(qty > 0) || !Number.isFinite(unitCp) || unitCp < 0) return;
      purchases.push({
        actorId: shop.actorId, actorName: nameOf(shop.actorId, message.speaker?.alias),
        shopId: shop.shopId ?? null, shopName: shop.shopTitle || "Shop", shopOwner: shop.shopOwner || null,
        itemName: l.name, itemType: l.type ?? null, qty, unitCp,
        listCp: Number.isFinite(Number(l.listCp)) ? Math.round(Number(l.listCp)) : null,
        key: `${messageId}:${shop.actorId}:purchase:${i}`,
      });
    });
  }

  const dice = [];
  for (const [k, count] of diceCounts) {
    const [actorId, faces, value] = k.split("|");
    dice.push({ actorId, actorName: nameOf(actorId, message.speaker?.alias), dieType: +faces, face: +value, count });
  }
  return { messageId, timestamp: message.timestamp, dice, outcomes, purchases };
}

/** Extract a whole chat log. Returns per-message results (including empty ones). */
export function extractAll(messages, ctx) {
  const out = [];
  for (const m of messages) {
    try { out.push(extractMessage(m, ctx)); }
    catch (e) { console.warn(`${MODULE_ID} | could not extract message ${m?.id ?? m?._id}:`, e); }
  }
  return out;
}

/** Per-actor totals, for logging / dry runs. */
export function summarise(results) {
  const by = {};
  const get = (id, name) => (by[id] ??= { name, dice: 0, d20: 0, outcomes: {}, healing: 0, bought: 0, spentCp: 0 });
  for (const r of results) {
    for (const d of r.dice) { const a = get(d.actorId, d.actorName); a.dice += d.count; if (d.dieType === 20) a.d20 += d.count; }
    for (const o of r.outcomes) {
      const a = get(o.actorId, o.actorName);
      if (o.type === "heal" && o.amount) a.healing += o.amount;
      const c = (a.outcomes[o.type] ??= { success: 0, failure: 0 });
      c[o.success ? "success" : "failure"]++;
    }
    for (const p of r.purchases ?? []) { const a = get(p.actorId, p.actorName); a.bought += p.qty; a.spentCp += p.qty * p.unitCp; }
  }
  return by;
}

// ── Upload ───────────────────────────────────────────────────────────────────

/** ".../api/roll-stats" → ".../api/chat-events" */
export function eventsUrlFrom(apiUrl) {
  return apiUrl.replace(/\/roll-stats\/?$/, "") + "/chat-events";
}

/**
 * Upload extracted results in chunks (keeps each request well under nginx's
 * default 1 MB body limit). Every message ID is sent, even ones with no
 * events, so the server can clear anything stale for that message.
 */
export async function uploadEvents({ url, apiKey, worldId, worldName, results, chunkSize = 400, onProgress }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let sent = 0;
  for (let i = 0; i < results.length; i += chunkSize) {
    const chunk = results.slice(i, i + chunkSize);
    const body = {
      worldId, worldName,
      messages: chunk.map(r => ({ id: r.messageId, ts: r.timestamp })),
      dice: chunk.flatMap(r => r.dice.map(d => ({ m: r.messageId, a: d.actorId, n: d.actorName, d: d.dieType, f: d.face, c: d.count }))),
      outcomes: chunk.flatMap(r => r.outcomes.map(o => ({ m: r.messageId, a: o.actorId, n: o.actorName, t: o.type, s: o.success, k: o.key, v: o.amount ?? null, d: o.detail ?? null, i: o.item ?? null }))),
      purchases: chunk.flatMap(r => (r.purchases ?? []).map(p => ({ m: r.messageId, a: p.actorId, n: p.actorName, s: p.shopId, sn: p.shopName, so: p.shopOwner, i: p.itemName, t: p.itemType, q: p.qty, u: p.unitCp, l: p.listCp, k: p.key }))),
    };
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      let detail = ""; try { detail = (await res.text()).slice(0, 200); } catch {}
      throw new Error(`Server returned ${res.status} on chunk ${i / chunkSize + 1}: ${detail}`);
    }
    sent += chunk.length;
    onProgress?.(sent, results.length);
  }
  return sent;
}
