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
  } else if (!(await db.schema.hasColumn("chat_purchases", "shop_owner"))) {
    await db.schema.alterTable("chat_purchases", (t) => t.string("shop_owner", 255).nullable());
    console.log("Added shop_owner column to chat_purchases");
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

// A session (an actor_stats upload timestamp) covers every chat event after the
// previous upload in the same world, up to and including this one.
async function sessionRange(session) {
  if (!session || session === "all") return null;
  const to = new Date(session);
  const cur = await db("actor_stats").where("uploaded_at", to).first("world_id");
  let q = db("actor_stats").max("uploaded_at as ts").where("uploaded_at", "<", to);
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

// Totals from Quick Actions ("+" button) for a session range: manual kills,
// manual damage and healing never go through midi-qol, so they're added on top
// of its numbers. type: "heal" | "damage" | "kill"; groupBy: extra columns.
async function manualTotals(type, session, req, groupBy = []) {
  let q = db("chat_outcomes").select("actor_name", ...groupBy)
    .sum("amount as amount").max("amount as max_amount").count("* as n")
    .where("outcome_type", type).groupBy("actor_name", ...groupBy);
  q = applyRange(q, await sessionRange(session));
  q = applyExcludes(q, req.query.exclude, req.query.excludeWorlds);
  return (await q).map(r => ({ ...r, amount: Number(r.amount) || 0, max_amount: Number(r.max_amount) || 0, n: Number(r.n) || 0 }));
}

// Attacks / saves added with "Add Other" are real outcome rows (so they count
// in hit % and save %) tagged detail = "manual"; midi-qol never saw them, so
// they're also added to its attack / save totals. → [{actor_name, success, n}]
async function manualCounts(type, session, req) {
  let q = db("chat_outcomes").select("actor_name", "success").count("* as n")
    .where("outcome_type", type).where("detail", "manual").groupBy("actor_name", "success");
  q = applyRange(q, await sessionRange(session));
  q = applyExcludes(q, req.query.exclude, req.query.excludeWorlds);
  return (await q).map(r => ({ ...r, success: r.success === true || r.success === 1 || r.success === "1" || r.success === "t", n: Number(r.n) || 0 }));
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
    const rows = await q;

    // Quick Actions (Lay on Hands, Healer, Add Healing/Damage/Kill) never go
    // through midi-qol, so add them from the chat log for the same range.
    const [heal, dmg, kill, taken, crit, fumble, maxHit, atk, save, saveFix] = await Promise.all([
      manualTotals("heal", session, req), manualTotals("damage", session, req), manualTotals("kill", session, req),
      manualTotals("damage_taken", session, req), manualTotals("crit", session, req),
      manualTotals("fumble", session, req), manualTotals("max_hit", session, req),
      manualCounts("attack", session, req), manualCounts("save", session, req),
      manualTotals("save_fix", session, req),
    ]);
    const by = (list) => new Map(list.map(r => [r.actor_name, r]));
    const H = by(heal), D = by(dmg), K = by(kill), T = by(taken), C = by(crit), F = by(fumble), M = by(maxHit);
    const num = (v) => Number(v) || 0;
    for (const r of rows) {
      const h = H.get(r.actor_name), d = D.get(r.actor_name), k = K.get(r.actor_name), t = T.get(r.actor_name);
      const c = C.get(r.actor_name), f = F.get(r.actor_name), m = M.get(r.actor_name);
      if (h) r.total_healing = num(r.total_healing) + h.amount;
      if (d) {
        r.total_damage = num(r.total_damage) + d.amount;
        r.max_single_hit = Math.max(num(r.max_single_hit), d.max_amount);
      }
      if (k) r.total_kills = num(r.total_kills) + k.n;
      if (t) r.total_damage_taken = num(r.total_damage_taken) + t.amount;
      if (c) r.total_crits = num(r.total_crits) + c.amount;
      if (f) r.total_fumbles = num(r.total_fumbles) + f.amount;
      if (m) r.max_single_hit = Math.max(num(r.max_single_hit), m.max_amount);
      for (const a of atk) if (a.actor_name === r.actor_name) r.total_attacks = num(r.total_attacks) + a.n;
      for (const sv of save) if (sv.actor_name === r.actor_name) {
        r.total_saves = num(r.total_saves) + sv.n;
        if (sv.success) r.total_save_success = num(r.total_save_success) + sv.n;
        else r.total_save_fail = num(r.total_save_fail) + sv.n;
      }
      // Corrected saves: failed → passed (the save count stays the same)
      for (const fx of saveFix) if (fx.actor_name === r.actor_name) {
        const moved = Math.min(fx.amount, num(r.total_save_fail));
        r.total_save_fail = num(r.total_save_fail) - moved;
        r.total_save_success = num(r.total_save_success) + moved;
      }
    }
    rows.sort((x, y) => num(y.total_damage) - num(x.total_damage));
    res.json(rows);
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
    // ?testWorlds=1 → the player characters seen in worlds whose ID has "test"
    // in it (from the chat-log tables, which only ever hold PCs)
    if (req.query.testWorlds) {
      const lists = await Promise.all(["chat_dice", "chat_outcomes", "chat_purchases"]
        .map(t => db(t).distinct("actor_name").whereRaw("LOWER(world_id) LIKE ?", ["%test%"])));
      return res.json([...new Set(lists.flat().map(r => r.actor_name).filter(Boolean))].sort());
    }
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
    const rows = await q;
    // Manual damage / kills recorded against a weapon, spell or feature
    const [dmg, kill] = await Promise.all([
      manualTotals("damage", session, req, ["item_name"]), manualTotals("kill", session, req, ["item_name"]),
    ]);
    const find = (actor, item) => {
      let row = rows.find(r => r.actor_name === actor && r.item_name === item);
      if (!row) { row = { actor_name: actor, item_name: item, num_attacks: 0, damage_total: 0, num_crits: 0, max_damage: 0, kills: 0 }; rows.push(row); }
      return row;
    };
    for (const d of dmg) if (d.item_name) {
      const row = find(d.actor_name, d.item_name);
      row.damage_total = (Number(row.damage_total) || 0) + d.amount;
      row.max_damage = Math.max(Number(row.max_damage) || 0, d.max_amount);
    }
    for (const k of kill) if (k.item_name) {
      const row = find(k.actor_name, k.item_name);
      row.kills = (Number(row.kills) || 0) + k.n;
    }
    rows.sort((x, y) => (Number(y.damage_total) || 0) - (Number(x.damage_total) || 0));
    res.json(rows);
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
    const rows = await q;
    // Manual damage dealt / taken with a damage type counts towards that type
    for (const [type, category] of [["damage", "dealt"], ["damage_taken", "taken"]]) {
      for (const d of await manualTotals(type, session, req, ["detail"])) {
        if (!d.detail) continue;
        const row = rows.find(r => r.actor_name === d.actor_name && r.category === category && r.damage_type === d.detail);
        if (row) row.amount = (Number(row.amount) || 0) + d.amount;
        else rows.push({ actor_name: d.actor_name, category, damage_type: d.detail, amount: d.amount });
      }
    }
    rows.sort((x, y) => (Number(y.amount) || 0) - (Number(x.amount) || 0));
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
app.get("/api/shop-stats", authMiddleware, async (req, res) => {
  const session = req.query.session;
  try {
    const range = await sessionRange(session);
    const base = () => applyExcludes(applyRange(db("chat_purchases"), range), req.query.exclude, req.query.excludeWorlds);
    const n = (r, ...keys) => { for (const k of keys) r[k] = Number(r[k]) || 0; return r; };

    const [byActor, byShop, topItems, popular, recent, favShop] = await Promise.all([
      base().select("actor_name").sum("total_cp as spent_cp").sum("qty as items")
        .countDistinct("message_id as transactions").max("unit_cp as max_unit_cp")
        .groupBy("actor_name").orderBy("spent_cp", "desc"),
      base().select("shop_name", "shop_owner").sum("total_cp as spent_cp").sum("qty as items")
        .countDistinct("message_id as transactions").countDistinct("actor_name as buyers")
        .groupBy("shop_name", "shop_owner").orderBy("transactions", "desc"),
      base().select("actor_name", "item_name", "shop_name", "shop_owner", "unit_cp", "list_cp", "qty", "occurred_at")
        .orderBy("unit_cp", "desc").orderBy("occurred_at", "desc").limit(10),
      base().select("item_name").sum("qty as qty").sum("total_cp as spent_cp").countDistinct("actor_name as buyers")
        .groupBy("item_name").orderBy("qty", "desc").limit(10),
      base().select("actor_name", "item_name", "shop_name", "shop_owner", "unit_cp", "list_cp", "qty", "total_cp", "occurred_at")
        .orderBy("occurred_at", "desc").orderBy("id", "desc").limit(25),
      base().select("actor_name", "shop_name", "shop_owner").countDistinct("message_id as transactions")
        .groupBy("actor_name", "shop_name", "shop_owner"),
    ]);
    // Each player's most used shop and most expensive item
    for (const a of byActor) {
      n(a, "spent_cp", "items", "transactions", "max_unit_cp");
      const shops = favShop.filter(f => f.actor_name === a.actor_name).map(f => n(f, "transactions"))
        .sort((x, y) => y.transactions - x.transactions);
      a.favourite_shop = shops[0]?.shop_name ?? null;
      a.favourite_shop_owner = shops[0]?.shop_owner ?? null;
      a.priciest_item = (await base().where("actor_name", a.actor_name).orderBy("unit_cp", "desc").first("item_name"))?.item_name ?? null;
    }
    res.json({
      byActor,
      byShop: byShop.map(r => n(r, "spent_cp", "items", "transactions", "buyers")),
      topItems: topItems.map(r => n(r, "unit_cp", "list_cp", "qty")),
      popular: popular.map(r => n(r, "qty", "spent_cp", "buyers")),
      recent: recent.map(r => n(r, "unit_cp", "list_cp", "qty", "total_cp")),
    });
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
