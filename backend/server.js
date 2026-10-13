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

  // ── Per-chat-message events (replace dice_rolls / roll_outcomes) ──────────
  // One set of rows per chat message. Re-uploading a message deletes and
  // re-inserts its rows, so uploads are idempotent and backfills just correct.
  // dice_rolls / roll_outcomes above are legacy and no longer read.
  if (!(await db.schema.hasTable("chat_dice"))) {
    await db.schema.createTable("chat_dice", (t) => {
      t.increments("id").primary();
      t.string("world_id", 100).notNullable();
      t.string("message_id", 64).notNullable();
      t.timestamp("occurred_at").notNullable();
      t.string("actor_id", 100).notNullable();
      t.string("actor_name", 255).nullable();
      t.integer("die_type").notNullable();
      t.integer("face_value").notNullable();
      t.integer("count").notNullable();
      t.index(["world_id", "message_id"]);
      t.index(["occurred_at"]);
    });
    console.log("Created table chat_dice");
  }
  if (!(await db.schema.hasTable("chat_outcomes"))) {
    await db.schema.createTable("chat_outcomes", (t) => {
      t.increments("id").primary();
      t.string("world_id", 100).notNullable();
      t.string("message_id", 64).notNullable();
      t.timestamp("occurred_at").notNullable();
      t.string("actor_id", 100).notNullable();
      t.string("actor_name", 255).nullable();
      t.string("outcome_type", 30).notNullable(); // attack, save, check, death, heal, damage, kill, damage_taken, crit, fumble, max_hit, attack_fix, save_fix
      t.boolean("success").notNullable();
      t.string("event_key", 200).notNullable();
      t.integer("amount").nullable();             // e.g. HP healed / damage dealt via a Quick Action
      t.string("detail", 60).nullable();          // e.g. damage type
      t.string("item_name", 255).nullable();      // weapon / spell / feature used
      t.unique(["world_id", "event_key"]);
      t.index(["world_id", "message_id"]);
      t.index(["occurred_at"]);
    });
    console.log("Created table chat_outcomes");
  } else {
    for (const [col, add] of [
      ["amount",    (t) => t.integer("amount").nullable()],
      ["detail",    (t) => t.string("detail", 60).nullable()],
      ["item_name", (t) => t.string("item_name", 255).nullable()],
    ]) {
      if (!(await db.schema.hasColumn("chat_outcomes", col))) {
        await db.schema.alterTable("chat_outcomes", add);
        console.log(`Added ${col} column to chat_outcomes`);
      }
    }
  }
  // One row per item line on a shop receipt (prices in copper)
  if (!(await db.schema.hasTable("chat_purchases"))) {
    await db.schema.createTable("chat_purchases", (t) => {
      t.increments("id").primary();
      t.string("world_id", 100).notNullable();
      t.string("message_id", 64).notNullable();
      t.timestamp("occurred_at").notNullable();
      t.string("actor_id", 100).notNullable();
      t.string("actor_name", 255).nullable();
      t.string("shop_id", 100).nullable();
      t.string("shop_name", 255).nullable();
      t.string("shop_owner", 255).nullable();
      t.string("kind", 8).notNullable().defaultTo("buy");   // buy | sell (player sold to the shop)
      t.string("item_name", 255).notNullable();
      t.string("item_type", 40).nullable();
      t.integer("qty").notNullable();
      t.integer("unit_cp").notNullable();        // price paid each
      t.integer("list_cp").nullable();           // shop's price each (differs if haggled)
      t.integer("total_cp").notNullable();
      t.string("event_key", 200).notNullable();
      t.unique(["world_id", "event_key"]);
      t.index(["world_id", "message_id"]);
      t.index(["occurred_at"]);
    });
    console.log("Created table chat_purchases");
  } else {
    for (const [col, add] of [
      ["shop_owner", (t) => t.string("shop_owner", 255).nullable()],
      ["kind",       (t) => t.string("kind", 8).notNullable().defaultTo("buy")],
    ]) {
      if (!(await db.schema.hasColumn("chat_purchases", col))) {
        await db.schema.alterTable("chat_purchases", add);
        console.log(`Added ${col} column to chat_purchases`);
      }
    }
  }
  // One row per "Upload Stats" press: marks where each session ends. (Sessions
  // used to be read from actor_stats, which only got rows when midi-qol had
  // stats; its counters are no longer used.)
  if (!(await db.schema.hasTable("stat_uploads"))) {
    await db.schema.createTable("stat_uploads", (t) => {
      t.increments("id").primary();
      t.timestamp("uploaded_at").notNullable();
      t.string("world_id", 100).notNullable();
      t.string("world_name", 255).nullable();
      t.unique(["world_id", "uploaded_at"]);
      t.index(["uploaded_at"]);
    });
    const old = await db("actor_stats").select("uploaded_at", "world_id").max("world_name as world_name")
      .groupBy("uploaded_at", "world_id");
    for (const part of chunks(old, 500)) await db("stat_uploads").insert(part);
    console.log(`Created table stat_uploads (${old.length} earlier uploads copied from actor_stats)`);
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

// A session (an upload timestamp) covers every chat event after the previous
// upload in the same world, up to and including this one.
async function sessionRange(session) {
  if (!session || session === "all") return null;
  const to = new Date(session);
  const cur = await db("stat_uploads").where("uploaded_at", to).first("world_id");
  let q = db("stat_uploads").max("uploaded_at as ts").where("uploaded_at", "<", to);
  if (cur?.world_id) q = q.where("world_id", cur.world_id);
  const prev = (await q.first())?.ts ?? null;
  return { from: prev ? new Date(prev) : null, to };
}

function applyRange(q, range) {
  if (!range) return q;
  if (range.from) q = q.where("occurred_at", ">", range.from);
  return q.where("occurred_at", "<=", range.to);
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Totals of one chat_outcomes type for a session range (sum / max of amount,
// row count). groupBy: extra columns, e.g. detail (damage type) or item_name.
async function manualTotals(type, session, req, groupBy = []) {
  let q = db("chat_outcomes").select("actor_name", ...groupBy)
    .sum("amount as amount").max("amount as max_amount").count("* as n")
    .where("outcome_type", type).groupBy("actor_name", ...groupBy);
  q = applyRange(q, await sessionRange(session));
  q = applyExcludes(q, req.query.exclude, req.query.excludeWorlds);
  return (await q).map(r => ({ ...r, amount: Number(r.amount) || 0, max_amount: Number(r.max_amount) || 0, n: Number(r.n) || 0 }));
}

// Per-character totals for the stats table, all from the chat log
// (see scripts/extract.mjs for what each outcome type means).
async function characterTotals(session, req) {
  const T = (cond, val = "1") => db.raw(`SUM(CASE WHEN ${cond} THEN ${val} ELSE 0 END)`);
  const is = (t) => `outcome_type = '${t}'`;
  let q = db("chat_outcomes").select("actor_name",
      // "manual-hit" rows are results added to an attack counted elsewhere: hit % only
      db.raw(`${T(`(${is("attack")} AND COALESCE(detail, '') <> 'manual-hit') OR ${is("attack_nt")}`).toString()} as total_attacks`),
      db.raw(`${T(is("crit"), "COALESCE(amount, 0)").toString()} as total_crits`),
      db.raw(`${T(is("fumble"), "COALESCE(amount, 0)").toString()} as total_fumbles`),
      db.raw(`${T(is("damage"), "COALESCE(amount, 0)").toString()} as total_damage`),
      db.raw(`MAX(CASE WHEN ${is("damage")} OR ${is("max_hit")} THEN amount ELSE 0 END) as max_single_hit`),
      db.raw(`${T(is("kill")).toString()} as total_kills`),
      db.raw(`${T(`${is("heal")} OR ${is("healing")}`, "COALESCE(amount, 0)").toString()} as total_healing`),
      db.raw(`${T(is("damage_taken"), "COALESCE(amount, 0)").toString()} as total_damage_taken`),
      db.raw(`${T(is("save")).toString()} as total_saves`),
      db.raw(`${T(`${is("save")} AND success`).toString()} as total_save_success`),
      db.raw(`${T(`${is("save")} AND NOT success`).toString()} as total_save_fail`),
      db.raw(`${T(is("save_fix"), "COALESCE(amount, 0)").toString()} as save_fixes`),
      db.raw(`${T(is("death")).toString()} as total_death_saves`))
    .groupBy("actor_name");
  q = applyRange(q, await sessionRange(session));
  q = applyExcludes(q, req.query.exclude, req.query.excludeWorlds);
  const num = (v) => Number(v) || 0;
  return (await q).map(r => {
    for (const k of Object.keys(r)) if (k !== "actor_name") r[k] = num(r[k]);
    // "Add Other" corrections: failed saves that really passed (count unchanged)
    const moved = Math.min(r.save_fixes, r.total_save_fail);
    r.total_save_fail -= moved;
    r.total_save_success += moved;
    delete r.save_fixes;
    return r;
  });
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", db: DB_CLIENT }));

// Body: { worldId, worldName, messages: [{id, ts}], dice: [{m,a,n,d,f,c}], outcomes: [{m,a,n,t,s,k}] }
// Replaces everything stored for the listed messages.
app.post("/api/chat-events", authMiddleware, async (req, res) => {
  const { worldId, messages, dice = [], outcomes = [], purchases } = req.body ?? {};
  if (!worldId || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Body must have worldId and a messages array." });
  }
  const tsById = new Map();
  for (const m of messages) {
    const ts = Number(m?.ts);
    if (m?.id && Number.isFinite(ts)) tsById.set(String(m.id), new Date(ts));
  }
  const ids = [...tsById.keys()];

  const diceRows = [], outcomeRows = [];
  for (const d of dice) {
    const at = tsById.get(String(d.m));
    const dt = parseInt(d.d), f = parseInt(d.f), c = parseInt(d.c);
    if (!at || !d.a || isNaN(dt) || isNaN(f) || !(c > 0)) continue;
    diceRows.push({ world_id: worldId, message_id: String(d.m), occurred_at: at, actor_id: String(d.a),
                    actor_name: d.n ?? null, die_type: dt, face_value: f, count: c });
  }
  const seenKeys = new Set();
  for (const o of outcomes) {
    const at = tsById.get(String(o.m));
    if (!at || !o.a || !o.t || typeof o.s !== "boolean" || !o.k || seenKeys.has(o.k)) continue;
    seenKeys.add(o.k);
    const amount = o.v === null || o.v === undefined || !Number.isFinite(Number(o.v)) ? null : Math.round(Number(o.v));
    outcomeRows.push({ world_id: worldId, message_id: String(o.m), occurred_at: at, actor_id: String(o.a),
                       actor_name: o.n ?? null, outcome_type: String(o.t), success: o.s, event_key: String(o.k).slice(0, 200), amount,
                       detail: o.d ? String(o.d).slice(0, 60) : null, item_name: o.i ? String(o.i).slice(0, 255) : null });
  }

  // Shop purchases — only replaced when the client sends them (older module
  // versions don't, and mustn't wipe what's there)
  const purchaseRows = [];
  const hasPurchases = Array.isArray(purchases);
  const int = (v) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? x : null; };
  for (const p of hasPurchases ? purchases : []) {
    const at = tsById.get(String(p.m));
    const qty = int(p.q), unit = int(p.u);
    if (!at || !p.a || !p.i || !p.k || !(qty > 0) || unit === null || unit < 0) continue;
    purchaseRows.push({ world_id: worldId, message_id: String(p.m), occurred_at: at, actor_id: String(p.a),
                        actor_name: p.n ?? null, shop_id: p.s ? String(p.s).slice(0, 100) : null,
                        shop_name: p.sn ? String(p.sn).slice(0, 255) : null, shop_owner: p.so ? String(p.so).slice(0, 255) : null,
                        kind: p.kd === "sell" ? "sell" : "buy",
                        item_name: String(p.i).slice(0, 255),
                        item_type: p.t ? String(p.t).slice(0, 40) : null, qty, unit_cp: unit,
                        list_cp: int(p.l), total_cp: qty * unit, event_key: String(p.k).slice(0, 200) });
  }

  try {
    await db.transaction(async (trx) => {
      for (const part of chunks(ids, 500)) {
        await trx("chat_dice").where("world_id", worldId).whereIn("message_id", part).del();
        await trx("chat_outcomes").where("world_id", worldId).whereIn("message_id", part).del();
        if (hasPurchases) await trx("chat_purchases").where("world_id", worldId).whereIn("message_id", part).del();
      }
      for (const part of chunks(diceRows, 500)) await trx("chat_dice").insert(part);
      for (const part of chunks(outcomeRows, 500)) await trx("chat_outcomes").insert(part);
      for (const part of chunks(purchaseRows, 500)) await trx("chat_purchases").insert(part);
    });
    console.log(`chat-events ${worldId}: ${ids.length} messages, ${diceRows.length} dice rows, ${outcomeRows.length} outcomes, ${purchaseRows.length} purchases`);
    res.json({ messages: ids.length, diceRows: diceRows.length, outcomes: outcomeRows.length, purchases: purchaseRows.length });
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/roll-stats", authMiddleware, async (req, res) => {
  const { timestamp, worldId, worldName, diceRolls } = req.body ?? {};
  const stats = req.body?.stats && typeof req.body.stats === "object" ? req.body.stats : {};
  if (!worldId) return res.status(400).json({ error: "Body must have a worldId." });

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
      // The session marker. (Older module versions also send midi-qol's
      // counters below; they're stored but no longer used.)
      const marker = await trx("stat_uploads").where({ world_id: worldId, uploaded_at: uploadedAt }).first("id");
      if (!marker) await trx("stat_uploads").insert({ uploaded_at: uploadedAt, world_id: worldId, world_name: worldName ?? null });
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
  try {
    const rows = await characterTotals(req.query.session, req);
    rows.sort((x, y) => y.total_damage - x.total_damage);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/sessions", authMiddleware, async (req, res) => {
  try {
    let q = db("stat_uploads").select("uploaded_at", "world_name", "world_id").orderBy("uploaded_at", "desc");
    q = applyExcludes(q, null, req.query.excludeWorlds);
    res.json(await q);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/worlds", authMiddleware, async (req, res) => {
  try {
    const rows = await db("stat_uploads").select("world_id").max("world_name as world_name")
      .count("* as uploads").max("uploaded_at as last_upload")
      .groupBy("world_id").orderBy("last_upload", "desc");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/names", authMiddleware, async (req, res) => {
  try {
    // Characters seen in the chat-log tables (player characters only).
    // ?testWorlds=1 → only those from worlds whose ID has "test" in it
    const lists = await Promise.all(["chat_dice", "chat_outcomes", "chat_purchases"].map(t => {
      let q = db(t).distinct("actor_name");
      if (req.query.testWorlds) q = q.whereRaw("LOWER(world_id) LIKE ?", ["%test%"]);
      else q = applyExcludes(q, null, req.query.excludeWorlds);
      return q;
    }));
    res.json([...new Set(lists.flat().map(r => r.actor_name).filter(Boolean))].sort());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Per weapon / spell / feature. Damage and kills come from HP Updated cards,
// paired with the item card that rolled them; "+" entries carry their own item.
app.get("/api/items", authMiddleware, async (req, res) => {
  try {
    const T = (cond, val = "1") => db.raw(`SUM(CASE WHEN ${cond} THEN ${val} ELSE 0 END)`).toString();
    let q = db("chat_outcomes").select("actor_name", "item_name",
        db.raw(`${T("(outcome_type = 'attack' AND COALESCE(detail, '') <> 'manual-hit') OR outcome_type = 'attack_nt'")} as num_attacks`),
        db.raw(`${T("outcome_type = 'damage'", "COALESCE(amount, 0)")} as damage_total`),
        db.raw(`${T("outcome_type = 'crit'", "COALESCE(amount, 0)")} as num_crits`),
        db.raw("MAX(CASE WHEN outcome_type IN ('damage', 'max_hit') THEN amount ELSE 0 END) as max_damage"),
        db.raw(`${T("outcome_type = 'kill'")} as kills`))
      .whereNotNull("item_name").whereIn("outcome_type", ["attack", "attack_nt", "damage", "crit", "max_hit", "kill"])
      .groupBy("actor_name", "item_name");
    q = applyRange(q, await sessionRange(req.query.session));
    q = applyExcludes(q, req.query.exclude, req.query.excludeWorlds);
    const rows = (await q).map(r => {
      for (const k of ["num_attacks", "damage_total", "num_crits", "max_damage", "kills"]) r[k] = Number(r[k]) || 0;
      return r;
    });
    rows.sort((x, y) => y.damage_total - x.damage_total);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Damage dealt / taken by damage type
app.get("/api/damage-types", authMiddleware, async (req, res) => {
  try {
    const rows = [];
    for (const [type, category] of [["damage", "dealt"], ["damage_taken", "taken"]]) {
      for (const d of await manualTotals(type, req.query.session, req, ["detail"])) {
        rows.push({ actor_name: d.actor_name, category, damage_type: d.detail || "untyped", amount: d.amount });
      }
    }
    rows.sort((x, y) => y.amount - x.amount);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/dice-rolls", authMiddleware, async (req, res) => {
  const session = req.query.session;
  const dieType = req.query.die_type ? parseInt(req.query.die_type) : null;
  const excludeWorlds = req.query.excludeWorlds;
  try {
    let q = db("chat_dice").select("actor_name", "die_type", "face_value")
      .sum("count as count").groupBy("actor_name", "die_type", "face_value")
      .orderBy("actor_name").orderBy("die_type").orderBy("face_value");
    q = applyRange(q, await sessionRange(session));
    if (dieType) q = q.where("die_type", dieType);
    q = applyExcludes(q, req.query.exclude, excludeWorlds);
    res.json(await q);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/outcomes", authMiddleware, async (req, res) => {
  const session = req.query.session;
  const excludeWorlds = req.query.excludeWorlds;
  try {
    let q = db("chat_outcomes").select("actor_name", "outcome_type",
        db.raw("SUM(CASE WHEN success THEN 1 ELSE 0 END) as success_count"),
        db.raw("SUM(CASE WHEN success THEN 0 ELSE 1 END) as failure_count"))
      .whereIn("outcome_type", ["attack", "save", "check", "death", "heal"])   // kills/damage go into the totals instead
      .groupBy("actor_name", "outcome_type").orderBy("actor_name").orderBy("outcome_type");
    q = applyRange(q, await sessionRange(session));
    q = applyExcludes(q, req.query.exclude, excludeWorlds);
    const rows = (await q).map(r => ({ ...r, success_count: Number(r.success_count) || 0, failure_count: Number(r.failure_count) || 0 }));
    // "Add Other" corrections: Foundry recorded a miss / failed save that was really a hit / pass
    for (const [fixType, type] of [["attack_fix", "attack"], ["save_fix", "save"]]) {
      for (const f of await manualTotals(fixType, session, req)) {
        const row = rows.find(r => r.actor_name === f.actor_name && r.outcome_type === type);
        if (!row) continue;
        const moved = Math.min(f.amount, row.failure_count);   // only what was actually recorded
        row.failure_count -= moved;
        row.success_count += moved;
      }
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Shop spending for the dashboard. Amounts are in copper (100 cp = 1 gp).
// Shop spending and selling for the dashboard. Amounts are in copper (100 cp = 1 gp).
app.get("/api/shop-stats", authMiddleware, async (req, res) => {
  const session = req.query.session;
  try {
    const range = await sessionRange(session);
    const all = () => applyExcludes(applyRange(db("chat_purchases"), range), req.query.exclude, req.query.excludeWorlds);
    const buys = () => all().where("kind", "buy");
    const sales = () => all().where("kind", "sell");
    const n = (r, ...keys) => { for (const k of keys) r[k] = Number(r[k]) || 0; return r; };
    const sumIf = (kind, col, as) => db.raw(`SUM(CASE WHEN kind = ? THEN ${col} ELSE 0 END) as ${as}`, [kind]);

    const [bought, sold, byShop, topItems, popular, recent, favShop] = await Promise.all([
      buys().select("actor_name").sum("total_cp as spent_cp").sum("qty as items")
        .countDistinct("message_id as transactions").max("unit_cp as max_unit_cp").groupBy("actor_name"),
      sales().select("actor_name").sum("total_cp as earned_cp").sum("qty as items_sold")
        .countDistinct("message_id as sales").groupBy("actor_name"),
      all().select("shop_name", "shop_owner", sumIf("buy", "total_cp", "spent_cp"), sumIf("sell", "total_cp", "sold_cp"),
          sumIf("buy", "qty", "items"), sumIf("sell", "qty", "items_sold"))
        .countDistinct("message_id as transactions").countDistinct("actor_name as buyers")
        .groupBy("shop_name", "shop_owner").orderBy("transactions", "desc"),
      buys().select("actor_name", "item_name", "shop_name", "shop_owner", "unit_cp", "list_cp", "qty", "occurred_at")
        .orderBy("unit_cp", "desc").orderBy("occurred_at", "desc").limit(10),
      buys().select("item_name").sum("qty as qty").sum("total_cp as spent_cp").countDistinct("actor_name as buyers")
        .groupBy("item_name").orderBy("qty", "desc").limit(10),
      all().select("kind", "actor_name", "item_name", "shop_name", "shop_owner", "unit_cp", "list_cp", "qty", "total_cp", "occurred_at")
        .orderBy("occurred_at", "desc").orderBy("id", "desc").limit(25),
      all().select("actor_name", "shop_name", "shop_owner").countDistinct("message_id as transactions")
        .groupBy("actor_name", "shop_name", "shop_owner"),
    ]);
    // One row per character: what they bought and sold, favourite shop, priciest buy
    const byActor = new Map();
    for (const b of bought) byActor.set(b.actor_name, { ...n(b, "spent_cp", "items", "transactions", "max_unit_cp"), earned_cp: 0, items_sold: 0, sales: 0 });
    for (const x of sold) {
      const row = byActor.get(x.actor_name) ?? { actor_name: x.actor_name, spent_cp: 0, items: 0, transactions: 0, max_unit_cp: 0 };
      Object.assign(row, n(x, "earned_cp", "items_sold", "sales"));
      byActor.set(x.actor_name, row);
    }
    for (const a of byActor.values()) {
      const shops = favShop.filter(f => f.actor_name === a.actor_name).map(f => n(f, "transactions"))
        .sort((x, y) => y.transactions - x.transactions);
      a.favourite_shop = shops[0]?.shop_name ?? null;
      a.favourite_shop_owner = shops[0]?.shop_owner ?? null;
      a.priciest_item = a.items ? (await buys().where("actor_name", a.actor_name).orderBy("unit_cp", "desc").first("item_name"))?.item_name ?? null : null;
    }
    res.json({
      byActor: [...byActor.values()].sort((x, y) => y.spent_cp - x.spent_cp || y.earned_cp - x.earned_cp),
      byShop: byShop.map(r => n(r, "spent_cp", "sold_cp", "items", "items_sold", "transactions", "buyers")),
      topItems: topItems.map(r => n(r, "unit_cp", "list_cp", "qty")),
      popular: popular.map(r => n(r, "qty", "spent_cp", "buyers")),
      recent: recent.map(r => n(r, "unit_cp", "list_cp", "qty", "total_cp")),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Casino winnings and losses. Amounts are in copper; "net" is the player's
// side (positive = they won money off the house).
app.get("/api/casino-stats", authMiddleware, async (req, res) => {
  try {
    const range = await sessionRange(req.query.session);
    const rows = () => applyExcludes(applyRange(db("chat_outcomes"), range), req.query.exclude, req.query.excludeWorlds)
      .whereIn("outcome_type", ["wager", "gamble"]);
    const T = (cond, val) => db.raw(`SUM(CASE WHEN ${cond} THEN ${val} ELSE 0 END)`).toString();
    const [byActorGame, recentRows] = await Promise.all([
      rows().select("actor_name", "detail as game",
          db.raw(`${T("outcome_type = 'wager'", "amount")} as wagered_cp`),
          db.raw(`${T("outcome_type = 'gamble'", "amount")} as net_cp`),
          db.raw(`${T("outcome_type = 'gamble'", "1")} as rounds`),
          db.raw(`${T("outcome_type = 'gamble' AND success", "1")} as wins`),
          db.raw("MAX(CASE WHEN outcome_type = 'gamble' THEN amount END) as best_cp"),
          db.raw("MIN(CASE WHEN outcome_type = 'gamble' THEN amount END) as worst_cp"))
        .groupBy("actor_name", "detail"),
      rows().select("message_id", "actor_name", "detail as game", "item_name as casino", "outcome_type", "amount", "occurred_at")
        .orderBy("occurred_at", "desc").limit(60),
    ]);
    const num = (v) => Number(v) || 0;
    const actors = new Map(), games = new Map();
    for (const r of byActorGame) {
      for (const k of ["wagered_cp", "net_cp", "rounds", "wins", "best_cp", "worst_cp"]) r[k] = num(r[k]);
      const a = actors.get(r.actor_name) ?? { actor_name: r.actor_name, wagered_cp: 0, net_cp: 0, rounds: 0, wins: 0, best_cp: 0, worst_cp: 0, games: {} };
      a.wagered_cp += r.wagered_cp; a.net_cp += r.net_cp; a.rounds += r.rounds; a.wins += r.wins;
      a.best_cp = Math.max(a.best_cp, r.best_cp); a.worst_cp = Math.min(a.worst_cp, r.worst_cp);
      a.games[r.game ?? "other"] = { rounds: r.rounds, net_cp: r.net_cp, wagered_cp: r.wagered_cp };
      actors.set(r.actor_name, a);
      const g = games.get(r.game) ?? { game: r.game, wagered_cp: 0, net_cp: 0, rounds: 0, players: 0 };
      g.wagered_cp += r.wagered_cp; g.net_cp += r.net_cp; g.rounds += r.rounds; g.players += 1;
      games.set(r.game, g);
    }
    for (const a of actors.values()) {
      a.favourite_game = Object.entries(a.games).sort((x, y) => y[1].rounds - x[1].rounds)[0]?.[0] ?? null;
    }
    // One line per character per round: stake and winnings side by side
    const recent = new Map();
    for (const r of recentRows) {
      const key = `${r.message_id}|${r.actor_name}`;
      const line = recent.get(key) ?? { actor_name: r.actor_name, game: r.game, casino: r.casino, occurred_at: r.occurred_at, wagered_cp: 0, net_cp: 0 };
      if (r.outcome_type === "wager") line.wagered_cp = num(r.amount); else line.net_cp = num(r.amount);
      recent.set(key, line);
    }
    res.json({
      byActor: [...actors.values()].sort((x, y) => y.net_cp - x.net_cp),
      byGame: [...games.values()].sort((x, y) => y.rounds - x.rounds),
      recent: [...recent.values()].slice(0, 20),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Achievements (the GM's Foundry client asks for this): each character's
// lifetime totals in one world, up to that world's latest upload. The module
// adds anything in the chat log after that, so nothing counts twice.
app.get("/api/achievement-baseline", authMiddleware, async (req, res) => {
  const worldId = req.query.worldId;
  if (!worldId) return res.status(400).json({ error: "worldId is required" });
  try {
    const uploads = (await db("stat_uploads").select("uploaded_at").where("world_id", worldId).orderBy("uploaded_at"))
      .map(r => new Date(r.uploaded_at).getTime());
    // Only count what's no longer in the caller's chat log (`before` = its oldest
    // message); the module reads the rest itself with the current extractor.
    const before = Number(req.query.before) || null;
    let cutoff = uploads.length ? uploads[uploads.length - 1] : null;
    if (cutoff && before) cutoff = Math.min(cutoff, before - 1);
    const actors = {};
    if (cutoff) {
      const until = new Date(cutoff);
      const [types, shop] = await Promise.all([
        db("chat_outcomes").select("actor_id", "outcome_type").count("* as n").sum("amount as sum").max("amount as max")
          .where("world_id", worldId).where("occurred_at", "<=", until).groupBy("actor_id", "outcome_type"),
        db("chat_purchases").select("actor_id",
            db.raw("SUM(CASE WHEN kind = 'buy' THEN total_cp ELSE 0 END) as spent_cp"),
            db.raw("SUM(CASE WHEN kind = 'buy' THEN qty ELSE 0 END) as items"),
            db.raw("SUM(CASE WHEN kind = 'buy' AND list_cp IS NOT NULL AND unit_cp < list_cp THEN 1 ELSE 0 END) as haggles"))
          .where("world_id", worldId).where("occurred_at", "<=", until).groupBy("actor_id"),
      ]);
      const get = (id) => (actors[id] ??= { types: {}, shop: { spentCp: 0, items: 0, haggles: 0 } });
      for (const r of types) get(r.actor_id).types[r.outcome_type] = { n: Number(r.n) || 0, sum: Number(r.sum) || 0, max: Number(r.max) || 0 };
      for (const r of shop) get(r.actor_id).shop = { spentCp: Number(r.spent_cp) || 0, items: Number(r.items) || 0, haggles: Number(r.haggles) || 0 };
    }
    res.json({ cutoff, uploads, actors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Achievement descriptions come from the module's own list (only sent for
// achievements someone has earned, so locked ones stay unknown)
let achievementCatalog = null;
async function achievementInfo(id) {
  if (achievementCatalog === null) {
    try { achievementCatalog = (await import(new URL("../scripts/achievements/catalog.mjs", import.meta.url))).ACHIEVEMENTS; }
    catch (err) { console.warn("Achievement descriptions unavailable:", err.message); achievementCatalog = []; }
  }
  return achievementCatalog.find(a => a.id === id) ?? null;
}

// Trophy cabinet for the dashboard: every achievement card that's been uploaded
app.get("/api/achievements", authMiddleware, async (req, res) => {
  try {
    let q = db("chat_outcomes").select("actor_name", "detail as id", "item_name as name")
      .max("amount as tier").min("occurred_at as first_at").max("occurred_at as last_at")
      .where("outcome_type", "achievement").groupBy("actor_name", "detail", "item_name");
    q = applyRange(q, await sessionRange(req.query.session));
    q = applyExcludes(q, req.query.exclude, req.query.excludeWorlds);
    const rows = await Promise.all((await q).map(async (r) => {
      const tier = Number(r.tier) || 0;
      const a = await achievementInfo(r.id);
      let desc = null;
      try { desc = a ? a.desc(a.tiers[Math.max(0, tier - 1)]) : null; } catch { /* leave it blank */ }
      return { ...r, tier, desc };
    }));
    rows.sort((a, b) => new Date(b.last_at) - new Date(a.last_at));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/dice-types", authMiddleware, async (req, res) => {
  const session = req.query.session;
  const excludeWorlds = req.query.excludeWorlds;
  try {
    let q = db("chat_dice").distinct("die_type").orderBy("die_type");
    q = applyRange(q, await sessionRange(session));
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
