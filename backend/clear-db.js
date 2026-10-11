#!/usr/bin/env node
/**
 * clear-db.js — Clear data from the foundry stats database.
 *
 * Usage:
 *   node clear-db.js                       — interactive, clears everything
 *   node clear-db.js --yes                 — skip confirmation
 *   node clear-db.js --actor "Name"        — delete one actor's data
 *   node clear-db.js --session "<ts>"      — delete one session's data
 *   node clear-db.js --dice-only           — clear ONLY dice tables (dice + outcomes)
 */

import knex from "knex";
import dotenv from "dotenv";
import readline from "readline";

dotenv.config();

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
});

const args = process.argv.slice(2);
const skipConfirm = args.includes("--yes") || args.includes("-y");
const diceOnly = args.includes("--dice-only");
const actorIdx = args.indexOf("--actor");
const sessionIdx = args.indexOf("--session");
const actorName = actorIdx !== -1 ? args[actorIdx + 1] : null;
const sessionTs = sessionIdx !== -1 ? args[sessionIdx + 1] : null;

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => { rl.question(q, (a) => { rl.close(); res(a.trim().toLowerCase()); }); });
}

const TABLES = ["actor_stats", "item_stats", "damage_by_type", "dice_rolls", "roll_outcomes"];
const DICE_TABLES = ["dice_rolls", "roll_outcomes"];

async function showCounts() {
  for (const t of TABLES) {
    try {
      const { n } = await db(t).count("* as n").first();
      console.log(`  ${t.padEnd(18)}: ${n} rows`);
    } catch {
      console.log(`  ${t.padEnd(18)}: (not present)`);
    }
  }
}

async function deleteByActor(name, diceOnlyFlag = false) {
  const tables = diceOnlyFlag ? DICE_TABLES : TABLES;
  console.log(`\nDeleting ${diceOnlyFlag ? "dice/outcomes only" : "all data"} for actor: "${name}"`);
  let total = 0;
  for (const t of tables) {
    try {
      const n = await db(t).where("actor_name", name).del();
      console.log(`  ${t}: ${n} rows`);
      total += n;
    } catch (e) { console.log(`  ${t}: skipped (${e.message})`); }
  }
  console.log(`Deleted ${total} total rows`);
}

async function deleteBySession(ts, diceOnlyFlag = false) {
  const uploaded = new Date(ts);
  const tables = diceOnlyFlag ? DICE_TABLES : TABLES;
  console.log(`\nDeleting ${diceOnlyFlag ? "dice/outcomes only" : "all data"} for session uploaded at: ${uploaded.toISOString()}`);
  let total = 0;
  for (const t of tables) {
    try {
      const n = await db(t).where("uploaded_at", uploaded).del();
      console.log(`  ${t}: ${n} rows`);
      total += n;
    } catch (e) { console.log(`  ${t}: skipped (${e.message})`); }
  }
  console.log(`Deleted ${total} total rows`);
}

async function clearAll() {
  console.log("\nClearing ALL tables...");
  for (const t of [...TABLES].reverse()) {
    try { await db(t).truncate(); console.log(`  ${t}: cleared`); }
    catch (e) { console.log(`  ${t}: ${e.message}`); }
  }
}

async function clearDice() {
  console.log("\nClearing dice tables...");
  for (const t of DICE_TABLES) {
    try { await db(t).truncate(); console.log(`  ${t}: cleared`); }
    catch (e) { console.log(`  ${t}: ${e.message}`); }
  }
}

async function listSessions() {
  const rows = await db("actor_stats").select("uploaded_at", "world_name")
    .groupBy("uploaded_at", "world_name").orderBy("uploaded_at", "desc");
  if (!rows.length) { console.log("  No sessions found."); return; }
  rows.forEach((r, i) => console.log(`  ${i + 1}. ${new Date(r.uploaded_at).toISOString()}  (${r.world_name || "unknown"})`));
}

async function listActors() {
  const rows = await db("actor_stats").select("actor_name").groupBy("actor_name").orderBy("actor_name");
  if (!rows.length) { console.log("  No actors found."); return; }
  rows.forEach((r) => console.log(`  - ${r.actor_name}`));
}

(async () => {
  try {
    await db.raw("SELECT 1");
    console.log("=== Foundry Stats Database ===\n");
    console.log("Current data:");
    await showCounts();

    if (sessionTs) {
      const what = diceOnly ? "dice + outcomes" : "ALL data";
      if (!skipConfirm) {
        const a = await ask(`\nDelete ${what} for session "${sessionTs}"? (yes/no): `);
        if (a !== "yes" && a !== "y") { console.log("Cancelled."); process.exit(0); }
      }
      await deleteBySession(sessionTs, diceOnly);
    } else if (actorName) {
      const what = diceOnly ? "dice + outcomes" : "ALL data";
      if (!skipConfirm) {
        const a = await ask(`\nDelete ${what} for actor "${actorName}"? (yes/no): `);
        if (a !== "yes" && a !== "y") { console.log("Cancelled."); process.exit(0); }
      }
      await deleteByActor(actorName, diceOnly);
    } else if (diceOnly) {
      if (!skipConfirm) {
        const a = await ask("\nClear ALL dice + outcome data across EVERY session and world? (yes/no): ");
        if (a !== "yes" && a !== "y") { console.log("Cancelled."); process.exit(0); }
      }
      await clearDice();
    } else {
      console.log("\nSessions:");
      await listSessions();
      console.log("\nActors:");
      await listActors();
      if (!skipConfirm) {
        const a = await ask("\nClear ALL data? (yes/no): ");
        if (a !== "yes" && a !== "y") { console.log("Cancelled."); process.exit(0); }
      }
      await clearAll();
    }

    console.log("\nRemaining data:");
    await showCounts();
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();