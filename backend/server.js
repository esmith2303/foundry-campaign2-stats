/**
 * Midi-QOL Stats — Backend API Server
 * ─────────────────────────────────────
 * Receives a stats snapshot from FoundryVTT and writes it to PostgreSQL or MySQL.
 *
 * The snapshot matches the shape of midi-qol's JSON export:
 * {
 *   timestamp, worldId, worldName,
 *   stats: {
 *     "<actorId>": {
 *       name, session{...}, lifetime{...},
 *       itemStats: { "<itemName>": { name, session, lifetime } },
 *       sessionDamageDealtByType, sessionDamageTakenByType, sessionDamageAppliedByType,
 *       lifetimeDamageDealtByType, lifetimeDamageTakenByType, lifetimeDamageAppliedByType
 *     }
 *   }
 * }
 *
 * Tables created automatically:
 *   actor_stats       — one row per actor per upload (session + lifetime totals)
 *   item_stats        — one row per item per actor per upload
 *   damage_by_type    — one row per damage type per actor per upload
 *
 * Setup:
 *   npm install
 *   cp .env.example .env
 *   node server.js
 */

import express from "express";
import knex from "knex";
import dotenv from "dotenv";

dotenv.config();

const PORT      = process.env.PORT      || 3000;
const API_KEY   = process.env.API_KEY   || "";
const DB_CLIENT = process.env.DB_CLIENT || "pg";   // "pg" or "mysql2"

// ── Database ──────────────────────────────────────────────────────────────────

const db = knex({
  client: DB_CLIENT,
  connection: {
    host:     process.env.DB_HOST     || "localhost",
    port:     Number(process.env.DB_PORT) || (DB_CLIENT === "pg" ? 5432 : 3306),
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  },
  pool: { min: 2, max: 10 },
});

// ── Schema ────────────────────────────────────────────────────────────────────

async function migrateUp() {
  // ── actor_stats ────────────────────────────────────────────────────────────
  if (!(await db.schema.hasTable("actor_stats"))) {
    await db.schema.createTable("actor_stats", (t) => {
      t.increments("id").primary();
      t.timestamp("uploaded_at").notNullable();   // when the GM clicked upload
      t.string("world_id",   100).notNullable();
      t.string("world_name", 255).nullable();
      t.string("actor_id",   100).notNullable();
      t.string("actor_name", 255).nullable();

      // Session counters
      t.integer("s_num_attacks").nullable();
      t.integer("s_num_attack20").nullable();
      t.integer("s_num_attack_fumble").nullable();
      t.integer("s_num_attack_critical").nullable();
      t.integer("s_num_attack_advantage").nullable();
      t.integer("s_num_attack_disadvantage").nullable();
      t.integer("s_num_attack_misses").nullable();
      t.integer("s_attack_rolls_dice_total").nullable();
      t.integer("s_attack_roll_total").nullable();
      t.integer("s_num_d20_rolls").nullable();
      t.integer("s_num_damage_rolls").nullable();
      t.integer("s_damage_applied").nullable();
      t.integer("s_damage_total").nullable();
      t.integer("s_critical_damage_total").nullable();
      t.integer("s_max_damage").nullable();
      t.integer("s_num_saves").nullable();
      t.integer("s_num_save_success").nullable();
      t.integer("s_num_save_fail").nullable();
      t.integer("s_healing_done").nullable();
      t.integer("s_kills").nullable();
      t.integer("s_damage_taken").nullable();
      t.integer("s_healing_received").nullable();
      t.integer("s_num_concentration_saves").nullable();
      t.integer("s_num_concentration_success").nullable();
      t.integer("s_num_concentration_fail").nullable();
      t.integer("s_num_death_saves").nullable();
      t.integer("s_num_death_save_success").nullable();
      t.integer("s_num_death_save_fail").nullable();

      // Lifetime counters (same set, prefixed l_)
      t.integer("l_num_attacks").nullable();
      t.integer("l_num_attack20").nullable();
      t.integer("l_num_attack_fumble").nullable();
      t.integer("l_num_attack_critical").nullable();
      t.integer("l_num_attack_advantage").nullable();
      t.integer("l_num_attack_disadvantage").nullable();
      t.integer("l_num_attack_misses").nullable();
      t.integer("l_attack_rolls_dice_total").nullable();
      t.integer("l_attack_roll_total").nullable();
      t.integer("l_num_d20_rolls").nullable();
      t.integer("l_num_damage_rolls").nullable();
      t.integer("l_damage_applied").nullable();
      t.integer("l_damage_total").nullable();
      t.integer("l_critical_damage_total").nullable();
      t.integer("l_max_damage").nullable();
      t.integer("l_num_saves").nullable();
      t.integer("l_num_save_success").nullable();
      t.integer("l_num_save_fail").nullable();
      t.integer("l_healing_done").nullable();
      t.integer("l_kills").nullable();
      t.integer("l_damage_taken").nullable();
      t.integer("l_healing_received").nullable();
      t.integer("l_num_concentration_saves").nullable();
      t.integer("l_num_concentration_success").nullable();
      t.integer("l_num_concentration_fail").nullable();
      t.integer("l_num_death_saves").nullable();
      t.integer("l_num_death_save_success").nullable();
      t.integer("l_num_death_save_fail").nullable();

      t.timestamps(true, true);
      t.index(["world_id", "uploaded_at"]);
      t.index("actor_name");
    });
    console.log("✔ Created table actor_stats");
  }

  // ── item_stats ─────────────────────────────────────────────────────────────
  if (!(await db.schema.hasTable("item_stats"))) {
    await db.schema.createTable("item_stats", (t) => {
      t.increments("id").primary();
      t.timestamp("uploaded_at").notNullable();
      t.string("world_id",   100).notNullable();
      t.string("actor_id",   100).notNullable();
      t.string("actor_name", 255).nullable();
      t.string("item_name",  255).notNullable();

      // Session
      t.integer("s_num_attacks").nullable();
      t.integer("s_num_attack20").nullable();
      t.integer("s_num_attack_fumble").nullable();
      t.integer("s_num_attack_critical").nullable();
      t.integer("s_damage_applied").nullable();
      t.integer("s_damage_total").nullable();
      t.integer("s_max_damage").nullable();
      t.integer("s_kills").nullable();
      t.integer("s_num_saves").nullable();
      t.integer("s_num_save_success").nullable();
      t.integer("s_num_save_fail").nullable();

      // Lifetime
      t.integer("l_num_attacks").nullable();
      t.integer("l_num_attack20").nullable();
      t.integer("l_num_attack_fumble").nullable();
      t.integer("l_num_attack_critical").nullable();
      t.integer("l_damage_applied").nullable();
      t.integer("l_damage_total").nullable();
      t.integer("l_max_damage").nullable();
      t.integer("l_kills").nullable();
      t.integer("l_num_saves").nullable();
      t.integer("l_num_save_success").nullable();
      t.integer("l_num_save_fail").nullable();

      t.timestamps(true, true);
      t.index(["world_id", "actor_id", "uploaded_at"]);
    });
    console.log("✔ Created table item_stats");
  }

  // ── damage_by_type ─────────────────────────────────────────────────────────
  if (!(await db.schema.hasTable("damage_by_type"))) {
    await db.schema.createTable("damage_by_type", (t) => {
      t.increments("id").primary();
      t.timestamp("uploaded_at").notNullable();
      t.string("world_id",    100).notNullable();
      t.string("actor_id",    100).notNullable();
      t.string("actor_name",  255).nullable();
      t.string("category",    50).notNullable();  // "dealt" | "taken" | "applied"
      t.string("scope",       20).notNullable();  // "session" | "lifetime"
      t.string("damage_type", 50).notNullable();  // "slashing", "fire", etc.
      t.integer("amount").notNullable();
      t.timestamps(true, true);
      t.index(["world_id", "actor_id", "uploaded_at"]);
    });
    console.log("✔ Created table damage_by_type");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map a stats counter object to DB column names (with prefix s_ or l_) */
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

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));

function authMiddleware(req, res, next) {
  if (!API_KEY) return next();
  const header = req.headers["authorization"] ?? "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", db: DB_CLIENT }));

app.post("/api/roll-stats", authMiddleware, async (req, res) => {
  const { timestamp, worldId, worldName, stats } = req.body;

  if (!stats || typeof stats !== "object") {
    return res.status(400).json({ error: "Body must have a 'stats' object." });
  }

  const uploadedAt = timestamp ? new Date(timestamp) : new Date();
  const actorRows     = [];
  const itemRows      = [];
  const damageRows    = [];

  for (const [actorId, actorData] of Object.entries(stats)) {
    const actorName = actorData.name ?? null;
    const base = { uploaded_at: uploadedAt, world_id: worldId, world_name: worldName ?? null, actor_id: actorId, actor_name: actorName };

    // actor_stats row
    actorRows.push({
      ...base,
      ...mapCounters(actorData.session,  "s_"),
      ...mapCounters(actorData.lifetime, "l_"),
    });

    // item_stats rows
    for (const [, itemData] of Object.entries(actorData.itemStats ?? {})) {
      const itemBase = { uploaded_at: uploadedAt, world_id: worldId, actor_id: actorId, actor_name: actorName, item_name: itemData.name ?? "Unknown" };
      // Only store the most useful item counters (keep table manageable)
      const isc = itemData.session  ?? {};
      const ilc = itemData.lifetime ?? {};
      itemRows.push({
        ...itemBase,
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

    // damage_by_type rows
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
        damageRows.push({ uploaded_at: uploadedAt, world_id: worldId, actor_id: actorId, actor_name: actorName, category, scope, damage_type: dmgType, amount });
      }
    }
  }

  try {
    await db.transaction(async (trx) => {
      if (actorRows.length)  await trx("actor_stats").insert(actorRows);
      if (itemRows.length)   await trx("item_stats").insert(itemRows);
      if (damageRows.length) await trx("damage_by_type").insert(damageRows);
    });

    console.log(`Inserted: ${actorRows.length} actors, ${itemRows.length} items, ${damageRows.length} damage rows — ${uploadedAt.toISOString()}`);
    res.json({ actors: actorRows.length, items: itemRows.length, damageRows: damageRows.length });
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await db.raw("SELECT 1");
    console.log(`✔ Connected to ${DB_CLIENT}`);
    await migrateUp();
    app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  } catch (err) {
    console.error("Startup error:", err.message);
    process.exit(1);
  }
})();
