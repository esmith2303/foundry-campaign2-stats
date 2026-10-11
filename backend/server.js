import express from "express";
import knex from "knex";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const DB_CLIENT = process.env.DB_CLIENT || "pg";

const db = knex({
  client: DB_CLIENT,
  connection: {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || (DB_CLIENT === "pg" ? 5432 : 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  },
  pool: { min: 2, max: 10 },
});

async function migrateUp() {
  if (!(await db.schema.hasTable("actor_stats"))) {
    await db.schema.createTable("actor_stats", (t) => {
      t.increments("id").primary();
      t.timestamp("uploaded_at").notNullable();
      t.string("world_id", 100).notNullable();
      t.string("world_name", 255).nullable();
      t.string("actor_id", 100).notNullable();
      t.string("actor_name", 255).nullable();
      const counters = ["num_attacks","num_attack20","num_attack_fumble","num_attack_critical","num_attack_advantage","num_attack_disadvantage","num_attack_misses","attack_rolls_dice_total","attack_roll_total","num_d20_rolls","num_damage_rolls","damage_applied","damage_total","critical_damage_total","max_damage","num_saves","num_save_success","num_save_fail","healing_done","kills","damage_taken","healing_received","num_concentration_saves","num_concentration_success","num_concentration_fail","num_death_saves","num_death_save_success","num_death_save_fail"];
      for (const c of counters) { t.integer("s_" + c).nullable(); t.integer("l_" + c).nullable(); }
      t.timestamps(true, true);
      t.index(["world_id", "uploaded_at"]);
      t.index("actor_name");
    });
    console.log("Created table actor_stats");
  }
  if (!(await db.schema.hasTable("item_stats"))) {
    await db.schema.createTable("item_stats", (t) => {
      t.increments("id").primary();
      t.timestamp("uploaded_at").notNullable();
      t.string("world_id", 100).notNullable();
      t.string("actor_id", 100).notNullable();
      t.string("actor_name", 255).nullable();
      t.string("item_name", 255).notNullable();
      const ic = ["num_attacks","num_attack20","num_attack_fumble","num_attack_critical","damage_applied","damage_total","max_damage","kills","num_saves","num_save_success","num_save_fail"];
      for (const c of ic) { t.integer("s_" + c).nullable(); t.integer("l_" + c).nullable(); }
      t.timestamps(true, true);
      t.index(["world_id", "actor_id", "uploaded_at"]);
    });
    console.log("Created table item_stats");
  }
  if (!(await db.schema.hasTable("damage_by_type"))) {
    await db.schema.createTable("damage_by_type", (t) => {
      t.increments("id").primary();
      t.timestamp("uploaded_at").notNullable();
      t.string("world_id", 100).notNullable();
      t.string("actor_id", 100).notNullable();
      t.string("actor_name", 255).nullable();
      t.string("category", 50).notNullable();
      t.string("scope", 20).notNullable();
      t.string("damage_type", 50).notNullable();
      t.integer("amount").notNullable();
      t.timestamps(true, true);
      t.index(["world_id", "actor_id", "uploaded_at"]);
    });
    console.log("Created table damage_by_type");
  }
  if (!(await db.schema.hasTable("dice_rolls"))) {
    await db.schema.createTable("dice_rolls", (t) => {
      t.increments("id").primary();
      t.timestamp("uploaded_at").notNullable();
      t.string("world_id", 100).notNullable();
      t.string("actor_id", 100).notNullable();
      t.string("actor_name", 255).nullable();
      t.integer("die_type").notNullable().defaultTo(20);
      t.integer("face_value").notNullable();
      t.integer("count").notNullable();
      t.timestamps(true, true);
      t.index(["world_id", "actor_id", "uploaded_at"]);
    });
    console.log("Created table dice_rolls");
  } else {
    const hasDieType = await db.schema.hasColumn("dice_rolls", "die_type");
    if (!hasDieType) {
      await db.schema.alterTable("dice_rolls", (t) => { t.integer("die_type").notNullable().defaultTo(20); });
      console.log("Added die_type column to dice_rolls");
    }
  }
  if (!(await db.schema.hasTable("roll_outcomes"))) {
    await db.schema.createTable("roll_outcomes", (t) => {
      t.increments("id").primary();
      t.timestamp("uploaded_at").notNullable();
      t.string("world_id", 100).notNullable();
      t.string("actor_id", 100).notNullable();
      t.string("actor_name", 255).nullable();
      t.string("outcome_type", 30).notNullable(); // attack, save, check, death
      t.integer("success_count").notNullable().defaultTo(0);
      t.integer("failure_count").notNullable().defaultTo(0);
      t.timestamps(true, true);
      t.index(["world_id", "actor_id", "uploaded_at"]);
      t.index(["actor_name", "outcome_type"]);
    });
    console.log("Created table roll_outcomes");
  }
}

function mapCounters(c, p) {
  if (!c) return {};
  return {
    [`${p}num_attacks`]: c.numAttacks ?? null, [`${p}num_attack20`]: c.numAttack20 ?? null,
    [`${p}num_attack_fumble`]: c.numAttackFumble ?? null, [`${p}num_attack_critical`]: c.numAttackCritical ?? null,
    [`${p}num_attack_advantage`]: c.numAttackAdvantage ?? null, [`${p}num_attack_disadvantage`]: c.numAttackDisadvantage ?? null,
    [`${p}num_attack_misses`]: c.numAttackMisses ?? null, [`${p}attack_rolls_dice_total`]: c.attackRollsDiceTotal ?? null,
    [`${p}attack_roll_total`]: c.attackRollTotal ?? null, [`${p}num_d20_rolls`]: c.numD20Rolls ?? null,
    [`${p}num_damage_rolls`]: c.numDamageRolls ?? null, [`${p}damage_applied`]: c.damageApplied ?? null,
    [`${p}damage_total`]: c.damageTotal ?? null, [`${p}critical_damage_total`]: c.criticalDamageTotal ?? null,
    [`${p}max_damage`]: c.maxDamage ?? null, [`${p}num_saves`]: c.numSaves ?? null,
    [`${p}num_save_success`]: c.numSaveSuccess ?? null, [`${p}num_save_fail`]: c.numSaveFail ?? null,
    [`${p}healing_done`]: c.healingDone ?? null, [`${p}kills`]: c.kills ?? null,
    [`${p}damage_taken`]: c.damageTaken ?? null, [`${p}healing_received`]: c.healingReceived ?? null,
    [`${p}num_concentration_saves`]: c.numConcentrationSaves ?? null, [`${p}num_concentration_success`]: c.numConcentrationSuccess ?? null,
    [`${p}num_concentration_fail`]: c.numConcentrationFail ?? null, [`${p}num_death_saves`]: c.numDeathSaves ?? null,
    [`${p}num_death_save_success`]: c.numDeathSaveSuccess ?? null, [`${p}num_death_save_fail`]: c.numDeathSaveFail ?? null,
  };
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors());

function authMiddleware(req, res, next) {
  if (!API_KEY) return next();
  const header = req.headers["authorization"] ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function applyExcludes(q, exclude, excludeWorlds) {
  if (exclude) {
    const names = exclude.split(",").map(n => n.trim()).filter(Boolean);
    if (names.length) q = q.whereNotIn("actor_name", names);
  }
  if (excludeWorlds) {
    const wids = excludeWorlds.split(",").map(n => n.trim()).filter(Boolean);
    if (wids.length) q = q.whereNotIn("world_id", wids);
  }
  return q;
}

async function getLatestTimestamp(excludeWorlds) {
  let q = db("actor_stats").max("uploaded_at as ts");
  if (excludeWorlds) {
    const wids = excludeWorlds.split(",").map(n => n.trim()).filter(Boolean);
    if (wids.length) q = q.whereNotIn("world_id", wids);
  }
  const row = await q.first();
  return row?.ts ?? null;
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", db: DB_CLIENT }));

app.post("/api/roll-stats", authMiddleware, async (req, res) => {
  const { timestamp, worldId, worldName, stats, diceRolls } = req.body;
  if (!stats || typeof stats !== "object") {
    return res.status(400).json({ error: "Body must have a 'stats' object." });
  }

  const uploadedAt = timestamp ? new Date(timestamp) : new Date();
  const actorRows = [], itemRows = [], damageRows = [], diceRows = [], outcomeRows = [];

  for (const [actorId, actorData] of Object.entries(stats)) {
    const actorName = actorData.name ?? null;
    const base = { uploaded_at: uploadedAt, world_id: worldId, world_name: worldName ?? null, actor_id: actorId, actor_name: actorName };
    actorRows.push({ ...base, ...mapCounters(actorData.session, "s_"), ...mapCounters(actorData.lifetime, "l_") });

    for (const [, itemData] of Object.entries(actorData.itemStats ?? {})) {
      const isc = itemData.session ?? {}, ilc = itemData.lifetime ?? {};
      itemRows.push({
        uploaded_at: uploadedAt, world_id: worldId, actor_id: actorId, actor_name: actorName, item_name: itemData.name ?? "Unknown",
        s_num_attacks: isc.numAttacks??null, s_num_attack20: isc.numAttack20??null, s_num_attack_fumble: isc.numAttackFumble??null, s_num_attack_critical: isc.numAttackCritical??null,
        s_damage_applied: isc.damageApplied??null, s_damage_total: isc.damageTotal??null, s_max_damage: isc.maxDamage??null, s_kills: isc.kills??null,
        s_num_saves: isc.numSaves??null, s_num_save_success: isc.numSaveSuccess??null, s_num_save_fail: isc.numSaveFail??null,
        l_num_attacks: ilc.numAttacks??null, l_num_attack20: ilc.numAttack20??null, l_num_attack_fumble: ilc.numAttackFumble??null, l_num_attack_critical: ilc.numAttackCritical??null,
        l_damage_applied: ilc.damageApplied??null, l_damage_total: ilc.damageTotal??null, l_max_damage: ilc.maxDamage??null, l_kills: ilc.kills??null,
        l_num_saves: ilc.numSaves??null, l_num_save_success: ilc.numSaveSuccess??null, l_num_save_fail: ilc.numSaveFail??null,
      });
    }

    const dmgSources = [
      ["dealt","session",actorData.sessionDamageDealtByType],["dealt","lifetime",actorData.lifetimeDamageDealtByType],
      ["taken","session",actorData.sessionDamageTakenByType],["taken","lifetime",actorData.lifetimeDamageTakenByType],
      ["applied","session",actorData.sessionDamageAppliedByType],["applied","lifetime",actorData.lifetimeDamageAppliedByType],
    ];
    for (const [category, scope, byType] of dmgSources) {
      for (const [dmgType, amount] of Object.entries(byType ?? {})) {
        // dnd5e half-damage from successful saves can produce floats (e.g. 7.5).
        // The amount column is INTEGER, and 5e RAW rounds half-damage down.
        const amt = Math.floor(Number(amount) || 0);
        if (!dmgType || amt === 0) continue;
        damageRows.push({ uploaded_at: uploadedAt, world_id: worldId, actor_id: actorId, actor_name: actorName, category, scope, damage_type: dmgType, amount: amt });
      }
    }
  }

  if (diceRolls && typeof diceRolls === "object") {
    for (const [actorId, data] of Object.entries(diceRolls)) {
      const actorName = data.name ?? null;

      // Dice (new shape with dice.<faces>.<value>)
      if (data.dice && typeof data.dice === "object") {
        for (const [dieType, faceCounts] of Object.entries(data.dice)) {
          for (const [face, count] of Object.entries(faceCounts || {})) {
            const dt = parseInt(dieType), f = parseInt(face), c = parseInt(count);
            if (!isNaN(dt) && !isNaN(f) && !isNaN(c) && c > 0) {
              diceRows.push({ uploaded_at: uploadedAt, world_id: worldId, actor_id: actorId, actor_name: actorName, die_type: dt, face_value: f, count: c });
            }
          }
        }
      } else if (data.faces && typeof data.faces === "object") {
        // Legacy shape, treat as d20
        for (const [face, count] of Object.entries(data.faces)) {
          const f = parseInt(face), c = parseInt(count);
          if (!isNaN(f) && !isNaN(c) && c > 0) {
            diceRows.push({ uploaded_at: uploadedAt, world_id: worldId, actor_id: actorId, actor_name: actorName, die_type: 20, face_value: f, count: c });
          }
        }
      }

      // Outcomes
      if (data.outcomes && typeof data.outcomes === "object") {
        for (const [type, counts] of Object.entries(data.outcomes)) {
          const s = parseInt(counts?.success) || 0;
          const f = parseInt(counts?.failure) || 0;
          if (s > 0 || f > 0) {
            outcomeRows.push({ uploaded_at: uploadedAt, world_id: worldId, actor_id: actorId, actor_name: actorName, outcome_type: type, success_count: s, failure_count: f });
          }
        }
      }

      // Heal count — stored as a special row with outcome_type='heal'
      const healCount = parseInt(data.healCount) || 0;
      if (healCount > 0) {
        outcomeRows.push({ uploaded_at: uploadedAt, world_id: worldId, actor_id: actorId, actor_name: actorName, outcome_type: "heal", success_count: healCount, failure_count: 0 });
      }
    }
  }

  try {
    await db.transaction(async (trx) => {
      if (actorRows.length) await trx("actor_stats").insert(actorRows);
      if (itemRows.length) await trx("item_stats").insert(itemRows);
      if (damageRows.length) await trx("damage_by_type").insert(damageRows);
      if (diceRows.length) await trx("dice_rolls").insert(diceRows);
      if (outcomeRows.length) await trx("roll_outcomes").insert(outcomeRows);
    });
    console.log(`Inserted: ${actorRows.length} actors, ${itemRows.length} items, ${damageRows.length} damage, ${diceRows.length} dice, ${outcomeRows.length} outcomes`);
    res.json({ actors: actorRows.length, items: itemRows.length, damageRows: damageRows.length, diceRolls: diceRows.length, outcomes: outcomeRows.length });
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/summary", authMiddleware, async (req, res) => {
  const session = req.query.session;
  const excludeWorlds = req.query.excludeWorlds;
  try {
    let ts, p;
    if (!session || session === "all") { ts = await getLatestTimestamp(excludeWorlds); p = "l_"; }
    else { ts = new Date(session); p = "s_"; }
    if (!ts) return res.json([]);

    let q = db("actor_stats").select("actor_name",
      db.raw(`SUM(${p}num_attacks) as total_attacks`), db.raw(`SUM(${p}damage_total) as total_damage`),
      db.raw(`SUM(${p}kills) as total_kills`), db.raw(`SUM(${p}num_attack_critical) as total_crits`),
      db.raw(`SUM(${p}num_attack_fumble) as total_fumbles`), db.raw(`SUM(${p}healing_done) as total_healing`),
      db.raw(`SUM(${p}damage_taken) as total_damage_taken`), db.raw(`SUM(${p}num_saves) as total_saves`),
      db.raw(`SUM(${p}num_save_success) as total_save_success`), db.raw(`SUM(${p}num_save_fail) as total_save_fail`),
      db.raw(`SUM(${p}num_death_saves) as total_death_saves`), db.raw(`MAX(${p}max_damage) as max_single_hit`),
      db.raw("COUNT(*) as sessions_played")
    ).where("uploaded_at", ts).groupBy("actor_name").orderBy("total_damage", "desc");
    q = applyExcludes(q, req.query.exclude, excludeWorlds);
    res.json(await q);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/sessions", authMiddleware, async (req, res) => {
  const excludeWorlds = req.query.excludeWorlds;
  try {
    let q = db("actor_stats").select("uploaded_at", "world_name", "world_id")
      .groupBy("uploaded_at", "world_name", "world_id").orderBy("uploaded_at", "desc");
    q = applyExcludes(q, null, excludeWorlds);
    res.json(await q);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/worlds", authMiddleware, async (req, res) => {
  try {
    const rows = await db("actor_stats").select("world_id", "world_name")
      .count("* as uploads").max("uploaded_at as last_upload")
      .groupBy("world_id", "world_name").orderBy("last_upload", "desc");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/names", authMiddleware, async (req, res) => {
  const excludeWorlds = req.query.excludeWorlds;
  try {
    let q = db("actor_stats").distinct("actor_name").orderBy("actor_name");
    q = applyExcludes(q, null, excludeWorlds);
    const rows = await q;
    res.json(rows.map(r => r.actor_name).filter(Boolean));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/items", authMiddleware, async (req, res) => {
  const session = req.query.session;
  const excludeWorlds = req.query.excludeWorlds;
  try {
    let ts, p;
    if (!session || session === "all") { ts = await getLatestTimestamp(excludeWorlds); p = "l_"; }
    else { ts = new Date(session); p = "s_"; }
    if (!ts) return res.json([]);

    let q = db("item_stats").select("actor_name", "item_name",
      db.raw(`SUM(${p}num_attacks) as num_attacks`), db.raw(`SUM(${p}damage_total) as damage_total`),
      db.raw(`SUM(${p}num_attack_critical) as num_crits`), db.raw(`MAX(${p}max_damage) as max_damage`),
      db.raw(`SUM(${p}kills) as kills`)
    ).where("uploaded_at", ts).groupBy("actor_name", "item_name").orderBy("damage_total", "desc");
    q = applyExcludes(q, req.query.exclude, excludeWorlds);
    res.json(await q);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/damage-types", authMiddleware, async (req, res) => {
  const session = req.query.session;
  const excludeWorlds = req.query.excludeWorlds;
  try {
    let ts, scope;
    if (!session || session === "all") { ts = await getLatestTimestamp(excludeWorlds); scope = "lifetime"; }
    else { ts = new Date(session); scope = "session"; }
    if (!ts) return res.json([]);

    let q = db("damage_by_type").select("actor_name", "category", "damage_type")
      .sum("amount as amount").where("scope", scope).where("uploaded_at", ts)
      .groupBy("actor_name", "category", "damage_type").orderBy("amount", "desc");
    q = applyExcludes(q, req.query.exclude, excludeWorlds);
    res.json(await q);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/dice-rolls", authMiddleware, async (req, res) => {
  const session = req.query.session;
  const dieType = req.query.die_type ? parseInt(req.query.die_type) : null;
  const excludeWorlds = req.query.excludeWorlds;
  try {
    let q = db("dice_rolls").select("actor_name", "die_type", "face_value")
      .sum("count as count").groupBy("actor_name", "die_type", "face_value")
      .orderBy("actor_name").orderBy("die_type").orderBy("face_value");
    if (session && session !== "all") q = q.where("uploaded_at", new Date(session));
    if (dieType) q = q.where("die_type", dieType);
    q = applyExcludes(q, req.query.exclude, excludeWorlds);
    res.json(await q);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/outcomes", authMiddleware, async (req, res) => {
  const session = req.query.session;
  const excludeWorlds = req.query.excludeWorlds;
  try {
    let q = db("roll_outcomes").select("actor_name", "outcome_type")
      .sum("success_count as success_count").sum("failure_count as failure_count")
      .groupBy("actor_name", "outcome_type").orderBy("actor_name").orderBy("outcome_type");
    if (session && session !== "all") q = q.where("uploaded_at", new Date(session));
    q = applyExcludes(q, req.query.exclude, excludeWorlds);
    res.json(await q);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/dice-types", authMiddleware, async (req, res) => {
  const session = req.query.session;
  const excludeWorlds = req.query.excludeWorlds;
  try {
    let q = db("dice_rolls").distinct("die_type").orderBy("die_type");
    if (session && session !== "all") q = q.where("uploaded_at", new Date(session));
    q = applyExcludes(q, req.query.exclude, excludeWorlds);
    const rows = await q;
    res.json(rows.map(r => r.die_type));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

(async () => {
  try {
    await db.raw("SELECT 1");
    console.log(`Connected to ${DB_CLIENT}`);
    await migrateUp();
    app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  } catch (err) {
    console.error("Startup error:", err.message);
    process.exit(1);
  }
})();