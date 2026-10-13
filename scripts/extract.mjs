/**
 * extract.mjs — turns chat messages into dice + outcome events.
 *
 * This is the ONLY place that decides what a roll means. It is used by:
 *   - the Foundry module at upload time (reads game.messages)
 *   - scripts/process-chat-export.mjs (reads a chat-log export JSON)
 *   - the end-of-combat recap
 * so live uploads, backfills and recaps always produce identical numbers.
 *
 * Every stat comes from the chat log. midi-qol's own counters (its "RollStats")
 * are NOT used: they count damage rolled on misses, area damage at full value
 * for every target, every damage/heal use as an "attack", the saves ENEMIES
 * made against your spells as your saves, and kills unreliably. What we do use
 * from midi-qol is what it writes on its chat cards: hit/miss, and the
 * "HP Updated" card it posts when damage or healing is applied (who dealt it,
 * each target's HP before and after, damage after saves/resistances, types).
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
export function asRollData(r) {
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
export function keptD20(rollLike) {
  const roll = asRollData(rollLike);
  for (const t of roll?.terms || []) {
    if (t?.faces === 20 && Array.isArray(t.results)) {
      const kept = t.results.find(r => r.active !== false && !r.discarded);
      if (kept) return kept.result;
    }
  }
  return null;
}

/**
 * Every kept d20 a character rolled in a message: [{ actorId, value, death }].
 * Reads the same places as the dice counts (the message's rolls, Monk's
 * TokenBar entries, our skill-check cards). Undone "+" cards and recap cards
 * count for nothing.
 */
export function keptD20s(message) {
  const flags = message?.flags || {};
  const own = flags[MODULE_ID] || {};
  if (own.abilityUse?.reverted || own.combatRecap || own.achievement) return [];
  const out = [];
  const isD20 = (r) => r?.class === "D20Roll" || r?.terms?.[0]?.faces === 20;
  const monks = flags["monks-tokenbar"] || {};
  const entries = monks.requests ? Object.entries(monks).filter(([k, v]) => k.startsWith("token") && v?.actorid) : [];
  if (entries.length) {
    for (const [, e] of entries) {
      const v = keptD20(e.roll);
      if (v) out.push({ actorId: e.actorid, value: v, death: false });
    }
  } else if (own.skillCheck) {
    for (const [actorId, r] of Object.entries(own.skillCheck.rolls || {})) {
      const v = r?.breakdown?.d20Result;
      if (v) out.push({ actorId, value: v, death: false });
    }
  } else if (message.speaker?.actor) {
    const death = flags.dnd5e?.roll?.type === "death" || flags.dnd5e?.roll?.type === "deathsave";
    for (const r of message.rolls || []) {
      const roll = asRollData(r);
      if (!isD20(roll)) continue;
      const v = keptD20(roll);
      if (v) out.push({ actorId: message.speaker.actor, value: v, death });
    }
  }
  return out;
}

/** "Actor.abc" / "Scene.x.Token.y.Actor.abc" → "abc" */
export function actorIdFromUuid(uuid) {
  const m = /(?:^|\.)Actor\.([A-Za-z0-9]{16})/.exec(uuid || "");
  return m ? m[1] : null;
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&apos;": "'" };
const decode = (t) => t.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g, (e) => ENTITIES[e]);

/** The weapon / spell / feature name on a dnd5e item card (null if none). */
export function itemNameFromCard(message) {
  const html = String(message?.content ?? "");
  const name = /class="title"\s*>\s*([^<]+?)\s*</.exec(html)?.[1]
            ?? /<img[^>]*class="gold-icon"[^>]*alt="([^"]+)"/.exec(html)?.[1];
  return name ? decode(name).trim().slice(0, 255) || null : null;
}

const HEAL_TYPES = new Set(["healing", "temphp"]);

/**
 * One midi-qol "HP Updated" entry → what happened to that target.
 * kind: "heal" (HP restored, capped at max), "temp" (temp HP only — not
 * counted), "damage" (after saves / resistances / immunities, temp HP
 * included, overkill included) or null (nothing changed).
 * byType: damage split by type, scaled so it adds up to the total.
 */
export function readHpEntry(u) {
  const detail = Array.isArray(u?.damageDetail) ? u.damageDetail : [];
  const oldHP = Number(u?.oldHP) || 0, newHP = Number(u?.newHP) || 0;
  const healing = detail.length && detail.every(d => HEAL_TYPES.has(d?.type))
               || Number(u?.healingAdjustedTotalDamage) < 0;
  if (healing) {
    const restored = Math.max(0, newHP - oldHP);
    return restored > 0 ? { kind: "heal", amount: restored, oldHP, newHP }
                        : { kind: detail.some(d => d?.type === "temphp") ? "temp" : null, amount: 0, oldHP, newHP };
  }
  const total = Math.max(0, Math.round(Number(u?.totalDamage) || 0));
  if (!total) return { kind: null, amount: 0, oldHP, newHP };
  // Split by type: the detail holds the values before saves, so scale them
  const raw = new Map();
  for (const d of detail) {
    const v = Number(d?.value ?? d?.damage) || 0;
    if (v > 0 && !HEAL_TYPES.has(d?.type)) raw.set(d?.type || "none", (raw.get(d?.type || "none") || 0) + v);
  }
  const rawSum = [...raw.values()].reduce((a, b) => a + b, 0);
  const byType = [];
  if (!rawSum) byType.push([null, total]);
  else {
    let left = total;
    const parts = [...raw.entries()].sort((a, b) => b[1] - a[1]);
    parts.forEach(([type, v], i) => {
      const share = i === parts.length - 1 ? left : Math.round(total * v / rawSum);
      left -= share;
      if (share > 0) byType.push([type === "none" ? null : type, share]);
    });
  }
  return { kind: "damage", amount: total, byType, oldHP, newHP, killed: oldHP > 0 && newHP <= 0 };
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
 *   canUserAct(userId, actorId) → bool (optional: may this user post entries for this character?),
 *   actorName(actorId, fallback) → string,
 *   resolveActorId?(uuid) → actorId|null   (live only: for token UUIDs without an Actor part)
 *   characterOfUser?(userId) → actorId|null (live only: the player's own character)
 *   includeNpcs?: bool
 * }
 * @param itemFor  optional (actorId) → item name, for HP Updated cards (which don't
 *                 say which weapon/spell did it); buildLinks() supplies it
 * @param link     optional { surgeD4, mainCharacter } from buildLinks(): the d4 the
 *                 player rolled after a wild magic surge, and the character they
 *                 usually play
 * @returns { messageId, timestamp, dice: [{actorId, actorName, dieType, face, count}],
 *            outcomes: [{actorId, actorName, type, success, key, amount, detail, item}] }
 *
 * Outcome types:
 *   attack (hit/miss, targeted only) · attack_nt (attack roll with no target)
 *   crit / fumble (amount = count) · damage (amount, detail = damage type)
 *   max_hit (biggest single hit on one target) · kill · healing (HP restored)
 *   damage_taken (amount, detail = type) · save · check · death · heal (one per
 *   heal used / "+" heal with amount) · attack_fix / save_fix (corrections)
 *   wager / gamble (casino stake and winnings in cp, detail = game)
 *   surge (wild magic surge, amount = the d100) · surge_extreme (a 01 or 100)
 *   surge_summon (the 05–08 "friendly creature" result, amount = the d4)
 *   unicorn (that d4 was a 4) · use (an item / spell / feature card, item = name)
 *   revive (healed a party member up from 0 HP)
 */
export function extractMessage(message, ctx, itemFor = null, link = {}) {
  const messageId = message.id ?? message._id;
  // A "+" card that was undone counts for nothing (dice included)
  if (message.flags?.[MODULE_ID]?.abilityUse?.reverted) return { messageId, timestamp: message.timestamp, dice: [], outcomes: [], purchases: [] };
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
    if (asRollData(attackRoll)) {
      const alias = message.speaker?.alias, item = itemNameFromCard(message);
      const d20 = keptD20(attackRoll);
      // An attack with no target can't hit or miss — counted as an attack, not in hit %
      if (targets.length) {
        let hit = typeof midi.isHit === "boolean" ? midi.isHit : null;
        if (hit === null) {
          const total = asRollData(attackRoll)?.total;
          const ac = targets[0]?.ac;
          if (d20 === 20) hit = true;
          else if (d20 === 1) hit = false;
          else if (typeof total === "number" && typeof ac === "number") hit = total >= ac;
        }
        addOutcome(speakerId, "attack", hit, "atk", alias, null, { item });
      } else {
        addOutcome(speakerId, "attack_nt", true, "atk", alias, null, { item });
      }
      // Crits / fumbles: midi-qol's flag (knows expanded crit ranges), else a natural 20 / 1
      const crit = typeof midi.isCritical === "boolean" ? midi.isCritical : d20 === 20;
      const fumble = typeof midi.isFumble === "boolean" ? midi.isFumble : d20 === 1;
      if (crit) addOutcome(speakerId, "crit", true, "atk", alias, 1, { item });
      if (fumble) addOutcome(speakerId, "fumble", true, "atk", alias, 1, { item });
    }

    // Heals: one per healing activity used
    if (dnd.activity?.type === "heal") addOutcome(speakerId, "heal", true, "heal", message.speaker?.alias);

    // The item / spell / feature card itself, for "cast it 25 times" achievements
    if (!Array.isArray(midi.undoDamage) && !flags[MODULE_ID]) {
      const used = itemNameFromCard(message);
      if (used && !/^Concentration Check/i.test(used)) addOutcome(speakerId, "use", true, "use", message.speaker?.alias, 1, { item: used });
    }
  }

  // ── Damage / healing actually applied (midi-qol's "HP Updated" card) ───────
  // One entry per target: who did it, HP before/after, damage after saves and
  // resistances. Damage to a party member is damage taken (even friendly fire);
  // damage to anyone else is damage dealt by the source, and taking them from
  // above 0 HP to 0 is a kill.
  if (Array.isArray(midi.undoDamage)) {
    midi.undoDamage.forEach((u, i) => {
      const src = resolve(midi.actorUuid) ?? resolve(u?.calcDamageOptions?.midi?.sourceActorUuid);
      const tgt = u?.actorId ?? resolve(u?.actorUuid);
      const r = readHpEntry(u);
      const tgtParty = !!tgt && ctx.isPlayerCharacter(tgt);
      // A hit on a party member that did nothing because of resistance/immunity (not a save)
      if (tgtParty && !r.kind && !u?.saved && !u?.superSaver && Number(u?.rawTotalDamage ?? 0) > 0
          && !(u?.damageDetail ?? []).every(d => ["healing", "temphp"].includes(d?.type))) {
        addOutcome(tgt, "shrugged", true, `hp${i}`, null, 1);
      }
      if (!r.kind || r.kind === "temp") return;
      const item = src ? itemFor?.(src) ?? null : null;
      if (r.kind === "heal") {
        if (src) addOutcome(src, "healing", true, `hp${i}`, null, r.amount, { item });
        // Back on their feet: a party member healed up from 0 HP
        if (src && tgtParty && ctx.isPlayerCharacter(src) && r.oldHP !== null && r.oldHP <= 0 && r.newHP > 0) addOutcome(src, "revive", true, `hp${i}`, null, 1, { item });
        return;
      }
      if (tgtParty) {
        r.byType.forEach(([type, amt], j) => addOutcome(tgt, "damage_taken", true, `hp${i}t${j}`, null, amt, { detail: type }));
        if (src && src !== tgt && ctx.isPlayerCharacter(src)) addOutcome(src, "friendly_fire", true, `hp${i}`, null, r.amount);
        return;
      }
      if (!src) return;
      r.byType.forEach(([type, amt], j) => addOutcome(src, "damage", true, `hp${i}d${j}`, null, amt, { detail: type, item }));
      addOutcome(src, "max_hit", true, `hp${i}`, null, r.amount, { item });
      if (r.killed) addOutcome(src, "kill", true, `hp${i}`, null, 1, { item });
      if (r.oldHP > 0 && r.oldHP <= 5 && r.amount >= 25) addOutcome(src, "overkill", true, `hp${i}`, null, r.amount, { item });
    });
  }

  // ── Natural 20s and 1s (kept d20s; death saves left out — they're secret) ──
  keptD20s(message).forEach((d, i) => {
    if (d.death) return;
    if (d.value === 20) addOutcome(d.actorId, "nat20", true, `n${i}`, message.speaker?.alias, 1);
    if (d.value === 1) addOutcome(d.actorId, "nat1", true, `n${i}`, message.speaker?.alias, 1);
  });

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
  // A "+" entry only counts if whoever posted it owns that character (or is the GM)
  const authorId = message.author ?? message.user ?? null;
  const allowed = (actorId) => !ctx.canUserAct || !authorId || ctx.canUserAct(authorId, actorId);
  if (abilityUse?.actorId && allowed(abilityUse.actorId)) {
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

  // ── Casino receipts: one "wager" (stake) and one "gamble" (winnings, can be
  // negative) per character per round; detail = the game
  const casino = flags[MODULE_ID]?.casinoResult;
  if (casino && Array.isArray(casino.lines) && allowed(casino.lines[0]?.actorId)) {
    casino.lines.forEach((l, i) => {
      const stake = Math.round(Number(l?.stakeCp)), back = Math.round(Number(l?.returnCp));
      if (!l?.actorId || !Number.isFinite(stake) || !Number.isFinite(back) || stake <= 0) return;
      const extra = { detail: casino.game ?? null, item: casino.casino ?? null };
      addOutcome(l.actorId, "wager", true, `c${i}`, null, stake, extra);
      addOutcome(l.actorId, "gamble", back > stake, `c${i}`, null, back - stake, extra);
    });
  }

  // Casino moments for achievements (receipts from 1.9.0 on carry these)
  if (casino && Array.isArray(casino.lines) && allowed(casino.lines[0]?.actorId)) {
    casino.lines.forEach((l, i) => {
      const m = l?.moments ?? {};
      if (m.naturals > 0) addOutcome(l.actorId, "bj_natural", true, `c${i}`, null, m.naturals);
      if (m.splitBoth) addOutcome(l.actorId, "bj_split_both", true, `c${i}`, null, 1);
      if (m.straight) addOutcome(l.actorId, "rl_straight", true, `c${i}`, null, 1);
      if (m.lizardWin) addOutcome(l.actorId, "lz_win", true, `c${i}`, null, 1);
      if (m.longShot) addOutcome(l.actorId, "lz_longshot", true, `c${i}`, null, 1);
    });
  }
  // Wild magic surges: a d100 roll-table draw by a player. The 05–08 result
  // summons a friendly creature, picked by the player's next d4 (4 = unicorn).
  const surge = surgeRoll(message);
  if (surge !== null && authorId) {
    const own = ctx.characterOfUser?.(authorId) ?? link.mainCharacter ?? null;
    const who = own ?? (speakerId && ctx.isPlayerCharacter(speakerId) ? speakerId : null);
    if (who) {
      addOutcome(who, "surge", true, "surge", null, surge);
      if (surge === 1 || surge === 100) addOutcome(who, "surge_extreme", true, "surge", null, surge);
      if (surge >= 5 && surge <= 8 && link.surgeD4) {
        addOutcome(who, "surge_summon", true, "summon", null, link.surgeD4, { item: `Creature ${link.surgeD4}` });
        if (link.surgeD4 === 4) addOutcome(who, "unicorn", true, "unicorn", null, 1);
      }
    }
  }
  // End of a casino night: who finished up
  const night = flags[MODULE_ID]?.casinoNight;
  if (night?.nets && allowed(Object.keys(night.nets)[0])) {
    Object.entries(night.nets).forEach(([actorId, net], i) => { if (Number(net) > 0) addOutcome(actorId, "casino_up", true, `night${i}`, null, Number(net)); });
  }
  // Combat recap cards: MVP, Executioner, untouched fights, glass cannons
  const recap = flags[MODULE_ID]?.combatRecap;
  if (recap && Array.isArray(recap.pcs)) {
    const pcs = recap.pcs;
    const leader = (get) => {
      const sorted = [...pcs].sort((a, b) => (get(b) || 0) - (get(a) || 0));
      return sorted[0] && (get(sorted[0]) || 0) > 0 && !(sorted[1] && get(sorted[1]) === get(sorted[0])) ? sorted[0].id : null;
    };
    const topDamage = leader(p => p.damage), topTaken = leader(p => p.taken);
    for (const p of pcs) {
      if (recap.mvp === p.id) addOutcome(p.id, "recap_mvp", true, "recap", p.name, 1);
      if ((p.achievements ?? []).includes("executioner")) addOutcome(p.id, "recap_exec", true, "recap", p.name, 1);
      const engaged = (p.hits || 0) + (p.misses || 0) > 0 || (p.damage || 0) > 0 || (p.healing || 0) > 0;
      if (engaged && (p.taken || 0) === 0) addOutcome(p.id, "recap_untouched", true, "recap", p.name, 1);
      if (topDamage === p.id && topTaken === p.id) addOutcome(p.id, "recap_glass", true, "recap", p.name, 1);
    }
  }
  // Achievement cards themselves (for the dashboard's trophy cabinet)
  const ach = flags[MODULE_ID]?.achievement;
  if (ach?.actorId && Array.isArray(ach.unlocks)) {
    ach.unlocks.forEach((u, i) => addOutcome(ach.actorId, "achievement", true, `a${i}`, null, Number(u.tier) || 0, { detail: String(u.id).slice(0, 60), item: u.name ?? null }));
  }

  // ── Shop receipts: purchases and sales (one row per item line, prices in copper)
  const purchases = [];
  for (const [kind, rec] of [["buy", flags[MODULE_ID]?.shopPurchase], ["sell", flags[MODULE_ID]?.shopSale]]) {
    if (!rec?.actorId || !tracked(rec.actorId) || !Array.isArray(rec.lines) || !allowed(rec.actorId)) continue;
    rec.lines.forEach((l, i) => {
      const qty = Math.floor(Number(l?.qty)) || 0, unitCp = Math.round(Number(l?.unitCp));
      if (!l?.name || !(qty > 0) || !Number.isFinite(unitCp) || unitCp < 0) return;
      const list = kind === "sell" ? l.valueCp : l.listCp;
      purchases.push({
        kind, actorId: rec.actorId, actorName: nameOf(rec.actorId, message.speaker?.alias),
        shopId: rec.shopId ?? null, shopName: rec.shopTitle || "Shop", shopOwner: rec.shopOwner || null,
        itemName: l.name, itemType: l.type ?? null, qty, unitCp,
        listCp: Number.isFinite(Number(list)) ? Math.round(Number(list)) : null,
        key: `${messageId}:${rec.actorId}:${kind === "sell" ? "sale" : "purchase"}:${i}`,
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
  const links = buildLinks(messages.map(m => [m?.id ?? m?._id, linkInfo(m)]), ctx);
  const out = [];
  for (const m of messages) {
    try { const l = links(m?.id ?? m?._id); out.push(extractMessage(m, ctx, l.itemFor ?? null, l)); }
    catch (e) { console.warn(`${MODULE_ID} | could not extract message ${m?.id ?? m?._id}:`, e); }
  }
  return out;
}

/** The d100 of a roll-table draw (how wild magic surges are rolled), or null. */
export function surgeRoll(m) {
  if (!m?.flags?.core?.RollTable) return null;
  const r = asRollData(m.rolls?.[0]);
  const t = r?.terms?.find(x => x?.faces);
  return t?.faces === 100 && t.number === 1 ? Number(r.total) : null;
}

/** A message that's just a single d4 roll → its value, else null. */
function loneD4(m) {
  const rolls = m?.rolls ?? [];
  if (rolls.length !== 1) return null;
  const r = asRollData(rolls[0]);
  const dice = (r?.terms ?? []).filter(x => x?.faces);
  return dice.length === 1 && dice[0].faces === 4 && dice[0].number === 1 ? Number(r.total) : null;
}

/**
 * Some messages need context from others:
 *   - HP Updated cards don't name the weapon or spell, so they're paired with
 *     the closest item card (within 3 minutes) from the same character that
 *     rolled damage or healing
 *   - a wild magic surge's creature is the d4 the same player rolled within 3
 *     minutes (before their next surge), and the surge belongs to the
 *     character that player usually speaks as
 * linkInfo() is the little each message contributes (cheap to keep per message);
 * buildLinks() turns them all into (messageId) → { itemFor, surgeD4, mainCharacter }.
 */
export function linkInfo(m) {
  const hp = Array.isArray(m?.flags?.["midi-qol"]?.undoDamage);
  const actor = m?.speaker?.actor ?? null;
  const damageItem = actor && !hp && (m.rolls || []).some(r => asRollData(r)?.class === "DamageRoll") ? itemNameFromCard(m) : null;
  return { ts: Number(m?.timestamp) || 0, author: m?.author ?? m?.user ?? null, actor, damageItem, hp, surge: surgeRoll(m), d4: loneD4(m) };
}

export function buildLinks(infos, ctx, windowMs = 180000) {
  const list = [...infos].sort((a, b) => a[1].ts - b[1].ts);   // [[id, info]…]
  const cards = new Map();    // actorId → [{ ts, name }] (sorted)
  const speaks = new Map();   // userId → Map(actorId → count)
  for (const [, x] of list) {
    if (x.damageItem) { if (!cards.has(x.actor)) cards.set(x.actor, []); cards.get(x.actor).push({ ts: x.ts, name: x.damageItem }); }
    if (x.author && x.actor && ctx.isPlayerCharacter(x.actor)) {
      if (!speaks.has(x.author)) speaks.set(x.author, new Map());
      speaks.get(x.author).set(x.actor, (speaks.get(x.author).get(x.actor) || 0) + 1);
    }
  }
  const main = (u) => [...(speaks.get(u) ?? new Map())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const links = new Map();
  list.forEach(([id, x], i) => {
    if (x.hp) {
      links.set(id, { itemFor: (actorId) => {
        let best = null;
        for (const c of cards.get(actorId) ?? []) {
          const dt = Math.abs(c.ts - x.ts);
          if (dt <= windowMs && (!best || dt < best.dt)) best = { dt, name: c.name };
        }
        return best?.name ?? null;
      } });
    }
    if (x.surge !== null) {
      let d4 = null;
      for (let j = i + 1; j < list.length; j++) {
        const y = list[j][1];
        if (y.ts - x.ts > windowMs) break;
        if (y.author !== x.author) continue;
        if (y.surge !== null) break;
        if (y.d4 !== null) { d4 = y.d4; break; }
      }
      links.set(id, { ...links.get(id), surgeD4: d4, mainCharacter: main(x.author) });
    }
  });
  return (id) => links.get(id) ?? {};
}

/** Per-actor totals, for logging / dry runs. */
export function summarise(results) {
  const by = {};
  const get = (id, name) => (by[id] ??= { name, dice: 0, d20: 0, outcomes: {}, healing: 0, damage: 0, kills: 0, taken: 0, bought: 0, spentCp: 0 });
  for (const r of results) {
    for (const d of r.dice) { const a = get(d.actorId, d.actorName); a.dice += d.count; if (d.dieType === 20) a.d20 += d.count; }
    for (const o of r.outcomes) {
      const a = get(o.actorId, o.actorName);
      if ((o.type === "heal" || o.type === "healing") && o.amount) a.healing += o.amount;
      if (o.type === "damage") a.damage += o.amount || 0;
      if (o.type === "kill") a.kills += 1;
      if (o.type === "damage_taken") a.taken += o.amount || 0;
      if (o.type === "gamble") a.casinoNet = (a.casinoNet || 0) + (o.amount || 0);
      const c = (a.outcomes[o.type] ??= { success: 0, failure: 0 });
      c[o.success ? "success" : "failure"]++;
    }
    for (const p of r.purchases ?? []) {
      const a = get(p.actorId, p.actorName);
      if (p.kind === "sell") { a.sold = (a.sold || 0) + p.qty; a.earnedCp = (a.earnedCp || 0) + p.qty * p.unitCp; }
      else { a.bought += p.qty; a.spentCp += p.qty * p.unitCp; }
    }
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
      purchases: chunk.flatMap(r => (r.purchases ?? []).map(p => ({ m: r.messageId, a: p.actorId, n: p.actorName, s: p.shopId, sn: p.shopName, so: p.shopOwner, kd: p.kind, i: p.itemName, t: p.itemType, q: p.qty, u: p.unitCp, l: p.listCp, k: p.key }))),
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
