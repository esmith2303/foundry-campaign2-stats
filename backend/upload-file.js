/**
 * upload-file.js
 *
 * Upload an existing midi-qol JSON export directly to your database.
 * Does NOT require Foundry to be running.
 *
 * Usage:
 *   node upload-file.js session_1.json
 *   node upload-file.js session_1.json --world "My Campaign"
 *   node upload-file.js session_1.json --timestamp "2024-06-01T20:00:00Z"
 *
 * Options:
 *   --world      World name to tag the records with (default: from filename)
 *   --timestamp  ISO timestamp to use (default: now)
 */

import fs from "fs";
import path from "path";
import knex from "knex";
import dotenv from "dotenv";

dotenv.config();

const DB_CLIENT = process.env.DB_CLIENT || "pg";

const db = knex({
  client: DB_CLIENT,
  connection: {
    host:     process.env.DB_HOST     || "localhost",
    port:     Number(process.env.DB_PORT) || (DB_CLIENT === "pg" ? 5432 : 3306),
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  },
});

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith("--"));

if (!filePath) {
  console.error("Usage: node upload-file.js <path-to-json>");
  process.exit(1);
}

const worldFlag     = args.indexOf("--world");
const tsFlag        = args.indexOf("--timestamp");
const worldName     = worldFlag     !== -1 ? args[worldFlag + 1]     : path.basename(filePath, ".json");
const timestampArg  = tsFlag        !== -1 ? args[tsFlag + 1]        : null;
const uploadedAt    = timestampArg  ? new Date(timestampArg)          : new Date();

// ── Read JSON ─────────────────────────────────────────────────────────────────

let stats;
try {
  const raw = fs.readFileSync(filePath, "utf-8");
  stats = JSON.parse(raw);
} catch (err) {
  console.error(`Could not read ${filePath}: ${err.message}`);
  process.exit(1);
}

// Detect if file is already wrapped in a snapshot envelope or is bare stats
const isBare = !stats.stats && !stats.timestamp;
const payload = isBare
  ? { timestamp: uploadedAt.toISOString(), worldId: worldName, worldName, stats }
  : stats;

console.log(`Uploading ${Object.keys(payload.stats).length} actors from "${filePath}"`);
console.log(`Timestamp: ${uploadedAt.toISOString()}`);

// ── Same mapping logic as server.js ──────────────────────────────────────────

function mapCounters(counters, prefix) {
  if (!counters) return {};
  return {
    [`${prefix}num_attacks`]:               counters.numAttacks               ?? null,
    [`${prefix}num_attack20`]:              counters.numAttack20              ?? null,
    [`${prefix}num_attack_fumble`]:         counters.numAttackFumble          ?? null,
    [`${prefix}num_attack_critical`]:       counters.numAttackCritical        ?? null,
    [`${prefix}num_attack_advantage`]:      counters.numAttackAdvantage       ?? null,
    [`${prefix}num_attack_disadvantage`]:   counters.numAttackDisadvantage    ?? null,
    [`${prefix}num_attack_misses`]:         counters.numAttackMisses          ?? null,
    [`${prefix}attack_rolls_dice_total`]:   counters.attackRollsDiceTotal     ?? null,
    [`${prefix}attack_roll_total`]:         counters.attackRollTotal          ?? null,
    [`${prefix}num_d20_rolls`]:             counters.numD20Rolls              ?? null,
    [`${prefix}num_damage_rolls`]:          counters.numDamageRolls           ?? null,
    [`${prefix}damage_applied`]:            counters.damageApplied            ?? null,
    [`${prefix}damage_total`]:              counters.damageTotal              ?? null,
    [`${prefix}critical_damage_total`]:     counters.criticalDamageTotal      ?? null,
    [`${prefix}max_damage`]:                counters.maxDamage                ?? null,
    [`${prefix}num_saves`]:                 counters.numSaves                 ?? null,
    [`${prefix}num_save_success`]:          counters.numSaveSuccess           ?? null,
    [`${prefix}num_save_fail`]:             counters.numSaveFail              ?? null,
    [`${prefix}healing_done`]:              counters.healingDone              ?? null,
    [`${prefix}kills`]:                     counters.kills                    ?? null,
    [`${prefix}damage_taken`]:              counters.damageTaken              ?? null,
    [`${prefix}healing_received`]:          counters.healingReceived          ?? null,
    [`${prefix}num_concentration_saves`]:   counters.numConcentrationSaves    ?? null,
    [`${prefix}num_concentration_success`]: counters.numConcentrationSuccess  ?? null,
    [`${prefix}num_concentration_fail`]:    counters.numConcentrationFail     ?? null,
    [`${prefix}num_death_saves`]:           counters.numDeathSaves            ?? null,
    [`${prefix}num_death_save_success`]:    counters.numDeathSaveSuccess      ?? null,
    [`${prefix}num_death_save_fail`]:       counters.numDeathSaveFail         ?? null,
  };
}

const actorRows  = [];
const itemRows   = [];
const damageRows = [];

for (const [actorId, actorData] of Object.entries(payload.stats)) {
  const actorName = actorData.name ?? null;
  const base = { uploaded_at: uploadedAt, world_id: payload.worldId ?? worldName, world_name: payload.worldName ?? worldName, actor_id: actorId, actor_name: actorName };

  actorRows.push({ ...base, ...mapCounters(actorData.session, "s_"), ...mapCounters(actorData.lifetime, "l_") });

  for (const [, itemData] of Object.entries(actorData.itemStats ?? {})) {
    const isc = itemData.session  ?? {};
    const ilc = itemData.lifetime ?? {};
    itemRows.push({
      uploaded_at: uploadedAt, world_id: payload.worldId ?? worldName, actor_id: actorId, actor_name: actorName, item_name: itemData.name ?? "Unknown",
      s_num_attacks: isc.numAttacks ?? null, s_num_attack20: isc.numAttack20 ?? null,
      s_num_attack_fumble: isc.numAttackFumble ?? null, s_num_attack_critical: isc.numAttackCritical ?? null,
      s_damage_applied: isc.damageApplied ?? null, s_damage_total: isc.damageTotal ?? null,
      s_max_damage: isc.maxDamage ?? null, s_kills: isc.kills ?? null,
      s_num_saves: isc.numSaves ?? null, s_num_save_success: isc.numSaveSuccess ?? null, s_num_save_fail: isc.numSaveFail ?? null,
      l_num_attacks: ilc.numAttacks ?? null, l_num_attack20: ilc.numAttack20 ?? null,
      l_num_attack_fumble: ilc.numAttackFumble ?? null, l_num_attack_critical: ilc.numAttackCritical ?? null,
      l_damage_applied: ilc.damageApplied ?? null, l_damage_total: ilc.damageTotal ?? null,
      l_max_damage: ilc.maxDamage ?? null, l_kills: ilc.kills ?? null,
      l_num_saves: ilc.numSaves ?? null, l_num_save_success: ilc.numSaveSuccess ?? null, l_num_save_fail: ilc.numSaveFail ?? null,
    });
  }

  const dmgSources = [
    ["dealt",   "session",  actorData.sessionDamageDealtByType],
    ["dealt",   "lifetime", actorData.lifetimeDamageDealtByType],
    ["taken",   "session",  actorData.sessionDamageTakenByType],
    ["taken",   "lifetime", actorData.lifetimeDamageTakenByType],
    ["applied", "session",  actorData.sessionDamageAppliedByType],
    ["applied", "lifetime", actorData.lifetimeDamageAppliedByType],
  ];
  for (const [category, scope, byType] of dmgSources) {
    for (const [dmgType, amount] of Object.entries(byType ?? {})) {
      damageRows.push({ uploaded_at: uploadedAt, world_id: payload.worldId ?? worldName, actor_id: actorId, actor_name: actorName, category, scope, damage_type: dmgType, amount });
    }
  }
}

// ── Insert ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await db.raw("SELECT 1");
    await db.transaction(async (trx) => {
      if (actorRows.length)  await trx("actor_stats").insert(actorRows);
      if (itemRows.length)   await trx("item_stats").insert(itemRows);
      if (damageRows.length) await trx("damage_by_type").insert(damageRows);
    });
    console.log(`✔ Inserted: ${actorRows.length} actors, ${itemRows.length} items, ${damageRows.length} damage rows`);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
