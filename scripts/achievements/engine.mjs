/**
 * Works out each character's achievements. Pure JS (testable outside Foundry).
 *
 * Two sources, so nothing is counted twice and nothing is lost when the chat
 * log is cleared:
 *   - lifetime counters: the server's totals up to the last stats upload
 *     ("baseline"), plus this world's chat messages after that upload
 *   - one-off moments and streaks (two natural 20s in a row, five misses in a
 *     row, a stabilised death save…): found in the chat log in order
 */
import { extractMessage, keptD20s, actorIdFromUuid, readHpEntry, MODULE_ID, DM_ID } from "../extract.mjs";
import { ACHIEVEMENTS } from "./catalog.mjs";

export const emptyCounters = () => ({ types: {}, items: {}, shop: { spentCp: 0, items: 0, haggles: 0 } });

// Per-item totals are kept for these (e.g. kills with a javelin, spells cast)
export const ITEM_TYPES = ["use", "kill", "surge_summon"];

function bump(t, amount, count) {
  t.n += count;
  t.sum += Number(amount) || 0;
  t.max = Math.max(t.max, Number(amount) || 0);
}
function addType(c, type, amount, item = null, count = 1) {
  bump((c.types[type] ??= { n: 0, sum: 0, max: 0 }), amount, count);
  if (item && ITEM_TYPES.includes(type)) bump(((c.items[type] ??= {})[item] ??= { n: 0, sum: 0, max: 0 }), amount, count);
}

/**
 * Everything the engine needs from one chat message (cache it by message id).
 * ctx is the extractor's: { isPlayerCharacter, actorName, canUserAct?, resolveActorId? }
 * link is buildLinks()'s for this message (which item an HP card was, a surge's d4…)
 */
export function analyseMessage(m, ctx, link = {}) {
  const id = m.id ?? m._id;
  const res = extractMessage(m, ctx, link.itemFor ?? null, link);
  const midi = m.flags?.["midi-qol"];
  const hp = [];
  if (Array.isArray(midi?.undoDamage)) {
    const src = actorIdFromUuid(midi.actorUuid) ?? actorIdFromUuid(midi.undoDamage[0]?.calcDamageOptions?.midi?.sourceActorUuid);
    for (const u of midi.undoDamage) {
      const r = readHpEntry(u);
      hp.push({ src, tgt: u?.actorId ?? actorIdFromUuid(u?.actorUuid), token: u?.targetUuid ?? u?.actorUuid ?? null,
                kind: r.kind, oldHP: r.oldHP, newHP: r.newHP });
    }
  }
  return {
    id, ts: Number(m.timestamp) || 0,
    outcomes: res.outcomes, purchases: res.purchases ?? [],
    d20s: keptD20s(m).filter(d => ctx.isPlayerCharacter(d.actorId)),
    hp,
  };
}

/**
 * @param p.items      analysed messages (any order)
 * @param p.baseline   { cutoff, actors: { actorId: counters } } from the server, or null
 * @param p.sessions   upload times (ms, ascending) — the ends of past sessions
 * @param p.party      actor ids to score
 * @param p.isParty    (actorId) → bool
 * @param p.nameOf     (actorId) → name (for personal achievements)
 * @returns { [actorId]: { counters, seq: Set, earned: { achId: { value, tier } } } }
 */
export function evaluate({ items, baseline = null, sessions = [], party = [], isParty = (id) => party.includes(id), nameOf = () => null }) {
  const cutoff = baseline?.cutoff ? Number(baseline.cutoff) : -Infinity;
  const counters = Object.fromEntries(party.map(id => [id, mergeBaseline(baseline?.actors?.[id])]));
  const seq = Object.fromEntries(party.map(id => [id, new Set()]));
  const sorted = [...items].sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));

  // ── Lifetime counters: the server's up to the last upload, the chat log after it
  for (const it of sorted) {
    if (it.ts <= cutoff) continue;
    for (const o of it.outcomes) if (counters[o.actorId]) addType(counters[o.actorId], o.type, o.amount, o.item);
    for (const pu of it.purchases) {
      const c = counters[pu.actorId];
      if (!c || pu.kind !== "buy") continue;
      c.shop.spentCp += pu.qty * pu.unitCp;
      c.shop.items += pu.qty;
      if (pu.listCp !== null && pu.listCp !== undefined && pu.unitCp < pu.listCp) c.shop.haggles += 1;
    }
  }

  // ── Moments and streaks, from the chat log in order
  const sessionOf = (ts) => sessions.filter(s => s < ts).length;     // index; complete if < sessions.length
  const last20 = {}, perSession = {}, missRun = {}, passRun = {}, dying = {}, downAt = {}, hitTokens = new Set(), cheapest = {};
  const award = (id, key) => seq[id]?.add(key);

  for (const it of sorted) {
    // dice: back-to-back 20s, three 1s in a session, session averages
    for (const d of it.d20s) {
      if (d.death) continue;
      if (d.value === 20 && last20[d.actorId]) award(d.actorId, "backToBack");
      last20[d.actorId] = d.value === 20;
      const s = ((perSession[d.actorId] ??= {})[sessionOf(it.ts)] ??= { n: 0, sum: 0, ones: 0 });
      s.n++; s.sum += d.value; if (d.value === 1) s.ones++;
      if (s.ones >= 3) award(d.actorId, "universeHates");
    }
    for (const o of it.outcomes) {
      const manual = String(o.detail ?? "").startsWith("manual");
      // five misses in a row / 25 saves passed in a row
      if (o.type === "attack" && !manual) {
        missRun[o.actorId] = o.success ? 0 : (missRun[o.actorId] ?? 0) + 1;
        if (missRun[o.actorId] >= 5) award(o.actorId, "stormtrooper");
      }
      if (o.type === "save" && !manual) {
        passRun[o.actorId] = o.success ? (passRun[o.actorId] ?? 0) + 1 : 0;
        if (passRun[o.actorId] >= 25) award(o.actorId, "ironWill");
      }
      // stabilising: 3 successes before 3 failures in one spell of dying (or a natural 20)
      if (o.type === "death") {
        const nat = it.d20s.find(d => d.death && d.actorId === o.actorId)?.value;
        let e = dying[o.actorId];
        if (!e || it.ts - e.at > 20 * 60e3) e = dying[o.actorId] = { ok: 0, bad: 0, at: it.ts };
        e.at = it.ts;
        if (nat === 20) { award(o.actorId, "deathDodger"); delete dying[o.actorId]; continue; }
        if (o.success) e.ok++; else e.bad += nat === 1 ? 2 : 1;
        if (e.ok >= 3 && e.bad < 3) { award(o.actorId, "deathDodger"); delete dying[o.actorId]; }
        else if (e.bad >= 3) delete dying[o.actorId];
      }
    }
    // HP cards: back up after dropping, killed by the first hit it took
    for (const h of it.hp) {
      if (h.tgt && isParty(h.tgt)) {
        if (h.kind === "damage" && h.oldHP > 0 && h.newHP <= 0) downAt[h.tgt] = it.ts;
        if (h.kind === "heal" && h.oldHP <= 0 && h.newHP > 0 && downAt[h.tgt] && it.ts - downAt[h.tgt] < 60 * 60e3) award(h.tgt, "notToday");
        if (h.kind === "heal" && h.newHP > 0) delete dying[h.tgt];
        continue;
      }
      if (h.kind !== "damage") continue;
      const first = h.token && !hitTokens.has(h.token);
      if (h.token) hitTokens.add(h.token);
      if (first && h.src && isParty(h.src) && h.oldHP > 0 && h.newHP <= 0) award(h.src, "onePunch");
    }
    // buying low, selling high
    for (const pu of it.purchases) {
      const key = `${pu.actorId}|${pu.itemName}`;
      if (pu.kind === "buy") cheapest[key] = Math.min(cheapest[key] ?? Infinity, pu.unitCp);
      else if (pu.kind === "sell" && cheapest[key] !== undefined && pu.unitCp > cheapest[key]) award(pu.actorId, "middleman");
    }
  }
  // Statistically average: a finished session with at least 10 d20s averaging 10–11
  for (const [actorId, bySession] of Object.entries(perSession)) {
    for (const [i, s] of Object.entries(bySession)) {
      if (Number(i) < sessions.length && s.n >= 10 && s.sum / s.n >= 10 && s.sum / s.n <= 11) award(actorId, "average");
    }
  }

  // Sessions run: days with an upload (two uploads in one night are one session)
  const sessionDays = new Set(sessions.map(ms => new Date(ms).toDateString())).size;
  const out = {};
  for (const id of party) {
    counters[id].sessions = sessionDays;
    const earned = {};
    for (const a of ACHIEVEMENTS) {
      // Personal achievements only count for their own character
      // (the Dungeon Master only has their own)
      const mine = a.character ? String(nameOf(id) ?? "").toLowerCase().startsWith(a.character.toLowerCase()) : id !== DM_ID;
      const value = mine ? Number(a.value(counters[id], seq[id])) || 0 : 0;
      earned[a.id] = { value, tier: a.tiers.filter(t => value >= t).length };
    }
    out[id] = { counters: counters[id], seq: seq[id], earned };
  }
  return out;
}

function mergeBaseline(b) {
  const c = emptyCounters();
  if (!b) return c;
  const num = (t) => ({ n: Number(t?.n) || 0, sum: Number(t?.sum) || 0, max: Number(t?.max) || 0 });
  for (const [type, t] of Object.entries(b.types ?? {})) c.types[type] = num(t);
  for (const [type, byItem] of Object.entries(b.items ?? {})) {
    c.items[type] = {};
    for (const [item, t] of Object.entries(byItem ?? {})) c.items[type][item] = num(t);
  }
  c.shop.spentCp = Number(b.shop?.spentCp) || 0;
  c.shop.items = Number(b.shop?.items) || 0;
  c.shop.haggles = Number(b.shop?.haggles) || 0;
  return c;
}

/** New tiers reached since `awarded` ({ achId: tier }) → [{ id, tier }] (one per tier). */
export function newUnlocks(earned, awarded = {}) {
  const out = [];
  for (const a of ACHIEVEMENTS) {
    const have = Number(awarded[a.id]) || 0, now = earned[a.id]?.tier ?? 0;
    for (let t = have + 1; t <= now; t++) out.push({ id: a.id, tier: t });
  }
  return out;
}

export { MODULE_ID };
