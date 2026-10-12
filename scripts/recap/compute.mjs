/**
 * Combat recap numbers and achievements. Pure JS (no Foundry globals) so it can
 * be tested outside Foundry; CombatRecap.mjs gathers the inputs.
 *
 * Every number comes from the chat log between the start and end of combat,
 * through the same extractor as the dashboard (scripts/extract.mjs): hits and
 * misses, crits, fumbles, damage dealt and taken and kills (midi-qol's "HP
 * Updated" cards), healing, saves, death saves and the "+" button entries.
 * Natural 20s and 1s are counted from every d20 a PC rolled.
 */
import { extractMessage, asRollData, MODULE_ID } from "../extract.mjs";

function d20Results(roll) {
  // Natural results of the kept d20 on an attack / check / save roll
  const isD20 = roll?.class === "D20Roll" || (roll?.terms?.[0]?.faces === 20);
  if (!isD20) return null;
  for (const t of roll.terms || []) {
    if (t?.faces === 20 && Array.isArray(t.results)) {
      const kept = t.results.find(r => r.active !== false && !r.discarded);
      return kept ? kept.result : null;
    }
  }
  return null;
}
const isDamageRoll = (roll) => roll?.class === "DamageRoll" || roll?.options?.type === "damage";

/**
 * @param {object}   p
 * @param {object[]} p.messages   chat messages (plain objects) in the fight, oldest first
 * @param {object[]} p.pcs        [{ id, name, img }]
 * @param {object[]} p.enemies    [{ name, defeated }]
 * @param {number}   p.rounds, p.start, p.end, p.scene
 */
export function computeRecap({ messages = [], pcs = [], enemies = [], rounds = 0, start, end, scene = "" }) {
  const ids = new Set(pcs.map(p => p.id));
  const ctx = { isPlayerCharacter: (id) => ids.has(id), actorName: (id, f) => pcs.find(p => p.id === id)?.name ?? f };
  const S = Object.fromEntries(pcs.map(p => [p.id, {
    id: p.id, name: p.name, img: p.img ?? null,
    damage: 0, biggestHit: 0, taken: 0, healing: 0, kills: 0, crits: 0, fumbles: 0,
    hits: 0, misses: 0, savesPassed: 0, savesFailed: 0, deathSaves: 0, nat20: 0, nat1: 0,
    firstHitAt: null,
  }]));

  const downed = new Set();   // non-PC creatures taken to 0 HP in the fight
  for (const m of messages) {
    const speaker = m.speaker?.actor;
    const ts = m.timestamp ?? 0;
    // Enemies taken to 0 HP (for the defeated count; kills come from the extractor)
    const undo = m.flags?.["midi-qol"]?.undoDamage;
    if (Array.isArray(undo)) {
      for (const u of undo) {
        const before = Number(u?.oldHP), after = Number(u?.newHP);
        if (!(before > 0) || !(after <= 0) || ids.has(u?.actorId)) continue;
        downed.add(u.actorUuid ?? u.targetUuid ?? `${u.actorId}:${ts}`);
      }
    }
    // Dice: natural 20s / 1s rolled by a PC
    if (S[speaker] && !m.flags?.[MODULE_ID]?.combatRecap && !m.flags?.[MODULE_ID]?.abilityUse?.reverted) {
      for (const r of m.rolls || []) {
        const roll = asRollData(r);
        if (!roll || isDamageRoll(roll)) continue;
        {
          const nat = d20Results(roll);
          if (nat === 20) S[speaker].nat20++;
          if (nat === 1) S[speaker].nat1++;
        }
      }
    }
    // Outcomes, through the dashboard's extractor
    let res;
    try { res = extractMessage(m, ctx); } catch { continue; }
    for (const o of res.outcomes) {
      const s = S[o.actorId];
      if (!s) continue;
      const v = Number(o.amount) || 0;
      switch (o.type) {
        case "attack":
          if (o.success) { s.hits++; if (s.firstHitAt === null) s.firstHitAt = ts; } else s.misses++;
          break;
        case "attack_fix": { const moved = Math.min(v, s.misses); s.misses -= moved; s.hits += moved; break; }
        case "save": o.success ? s.savesPassed++ : s.savesFailed++; break;
        case "save_fix": { const moved = Math.min(v, s.savesFailed); s.savesFailed -= moved; s.savesPassed += moved; break; }
        case "death": s.deathSaves++; break;
        case "heal": case "healing": s.healing += v; break;
        case "damage": s.damage += v; s.biggestHit = Math.max(s.biggestHit, v); break;
        case "kill": s.kills += 1; break;
        case "damage_taken": s.taken += v; break;
        case "crit": s.crits += v; break;
        case "fumble": s.fumbles += v; break;
        case "max_hit": s.biggestHit = Math.max(s.biggestHit, v); break;
      }
    }
  }

  const list = Object.values(S);
  const achievements = awardAchievements(list);
  for (const s of list) s.achievements = achievements[s.id] ?? [];
  const mvp = [...list].sort((x, y) => (y.damage - x.damage) || (y.kills - x.kills) || (y.healing - x.healing))[0];

  return {
    scene, rounds, start, end,
    minutes: Number.isFinite(start) && Number.isFinite(end) ? Math.max(1, Math.round((end - start) / 60000)) : null,
    enemies: (() => {
      // The tracker may have lost defeated combatants (removed as they fell), so
      // also count the creatures the chat log shows being taken to 0 HP
      const onTracker = enemies.filter(e => e.defeated).length, standing = enemies.filter(e => !e.defeated).length;
      const defeated = Math.max(onTracker, downed.size);
      return { total: defeated + standing, defeated, names: enemies.filter(e => e.defeated).map(e => e.name) };
    })(),
    mvp: mvp && (mvp.damage > 0 || mvp.kills > 0 || mvp.healing > 0) ? mvp.id : null,
    party: {
      damage: list.reduce((t, s) => t + s.damage, 0),
      nat20: list.reduce((t, s) => t + s.nat20, 0),
      nat1: list.reduce((t, s) => t + s.nat1, 0),
    },
    pcs: list.sort((x, y) => (y.damage - x.damage) || x.name.localeCompare(y.name)),
  };
}

// ── Achievements ─────────────────────────────────────────────────────────────

export const ACHIEVEMENTS = {
  firstBlood:   { icon: "fas fa-droplet",       name: "First Blood",          text: "Landed the first hit of the fight" },
  executioner:  { icon: "fas fa-skull",         name: "Executioner",          text: "Most kills (at least 2)" },
  bigHitter:    { icon: "fas fa-hammer",        name: "Big Hitter",           text: "Biggest single hit of the fight" },
  natural:      { icon: "fas fa-dice-d20",      name: "Natural Born Killer",  text: "Rolled 2 or more natural 20s" },
  cursed:       { icon: "fas fa-ghost",         name: "Cursed Dice",          text: "Rolled 2 or more natural 1s" },
  critHappens:  { icon: "fas fa-burst",         name: "Crit Happens",         text: "Scored 2 or more critical hits" },
  medic:        { icon: "fas fa-kit-medical",   name: "Medic",                text: "Most healing" },
  meatShield:   { icon: "fas fa-shield-halved", name: "Meat Shield",          text: "Took the most damage" },
  untouchable:  { icon: "fas fa-feather",       name: "Untouchable",          text: "Didn't take a single point of damage" },
  sharpshooter: { icon: "fas fa-bullseye",      name: "Sharpshooter",         text: "Hit with every attack (3 or more)" },
  stormtrooper: { icon: "fas fa-wind",          name: "Stormtrooper",         text: "Missed every attack (3 or more)" },
  ironWill:     { icon: "fas fa-brain",         name: "Iron Will",            text: "Passed every saving throw (2 or more)" },
  closeCall:    { icon: "fas fa-heart-pulse",   name: "Close Call",           text: "Made a death saving throw" },
  pacifist:     { icon: "fas fa-dove",          name: "Pacifist",             text: "No attacks, no damage" },
};

function awardAchievements(list) {
  const out = {};
  const give = (s, key) => { if (s) (out[s.id] ??= []).includes(key) || out[s.id].push(key); };
  // "Most …": a single clear leader above a minimum
  const leader = (get, min = 1) => {
    const sorted = [...list].sort((a, b) => get(b) - get(a));
    if (!sorted.length || get(sorted[0]) < min) return null;
    return sorted.length > 1 && get(sorted[1]) === get(sorted[0]) ? null : sorted[0];
  };
  const firsts = list.filter(s => s.firstHitAt !== null).sort((a, b) => a.firstHitAt - b.firstHitAt);
  if (firsts.length) give(firsts[0], "firstBlood");
  give(leader(s => s.kills, 2), "executioner");
  give(leader(s => s.biggestHit, 1), "bigHitter");
  give(leader(s => s.healing, 1), "medic");
  give(leader(s => s.taken, 1), "meatShield");
  for (const s of list) {
    const attacks = s.hits + s.misses, saves = s.savesPassed + s.savesFailed;
    if (s.nat20 >= 2) give(s, "natural");
    if (s.nat1 >= 2) give(s, "cursed");
    if (s.crits >= 2) give(s, "critHappens");
    if (attacks >= 3 && s.misses === 0) give(s, "sharpshooter");
    if (attacks >= 3 && s.hits === 0) give(s, "stormtrooper");
    if (saves >= 2 && s.savesFailed === 0) give(s, "ironWill");
    if (s.deathSaves > 0) give(s, "closeCall");
    if (s.taken === 0 && (attacks > 0 || s.damage > 0 || s.healing > 0)) give(s, "untouchable");
    if (attacks === 0 && s.damage === 0 && (s.healing > 0 || saves > 0)) give(s, "pacifist");
  }
  return out;
}
