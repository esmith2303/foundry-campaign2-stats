#!/usr/bin/env node
/**
 * dedupe-existing.js
 *
 * One-time cleanup: removes user-level duplicate entries from existing data.
 * For each session timestamp, finds entries with identical stats and keeps
 * only the one with the longer name (the character, not the player).
 *
 * Usage:
 *   node dedupe-existing.js              — interactive
 *   node dedupe-existing.js --yes        — skip confirmation
 *   node dedupe-existing.js --dry-run    — show what would be deleted
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
const dryRun = args.includes("--dry-run");
const skipConfirm = args.includes("--yes") || args.includes("-y");

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => { rl.question(q, (a) => { rl.close(); res(a.trim().toLowerCase()); }); });
}

(async () => {
  try {
    const sessions = await db("actor_stats").distinct("uploaded_at").orderBy("uploaded_at");
    console.log(`Found ${sessions.length} session(s) to check.\n`);

    const toDelete = []; // { row, reason }

    for (const { uploaded_at } of sessions) {
      const rows = await db("actor_stats").where("uploaded_at", uploaded_at);
      const groups = {};
      for (const row of rows) {
        const fp = [
          row.s_num_attacks||0, row.s_damage_total||0, row.s_kills||0,
          row.s_num_saves||0, row.s_healing_done||0, row.s_damage_taken||0,
          row.s_num_attack_critical||0, row.s_num_attack_fumble||0,
        ].join("|");
        if (!groups[fp]) groups[fp] = [];
        groups[fp].push(row);
      }

      for (const group of Object.values(groups)) {
        if (group.length <= 1) continue;
        // Skip groups where everyone has 0 activity
        if (group[0].s_num_attacks === 0 && group[0].s_damage_total === 0 &&
            group[0].s_kills === 0 && group[0].s_num_saves === 0) continue;

        // Keep entry with longer/more "character-like" name
        group.sort((a, b) => (b.actor_name || "").length - (a.actor_name || "").length);
        const keep = group[0];
        const dupes = group.slice(1);
        console.log(`${new Date(uploaded_at).toISOString()}`);
        console.log(`  KEEP   : ${keep.actor_name} (${keep.actor_id})`);
        for (const d of dupes) {
          console.log(`  DELETE : ${d.actor_name} (${d.actor_id})`);
          toDelete.push(d);
        }
      }
    }

    if (!toDelete.length) {
      console.log("\nNo duplicates found.");
      process.exit(0);
    }

    console.log(`\nTotal duplicate rows to delete: ${toDelete.length}`);

    if (dryRun) {
      console.log("(dry-run mode — no changes made)");
      process.exit(0);
    }

    if (!skipConfirm) {
      const answer = await ask("\nDelete these duplicates? (yes/no): ");
      if (answer !== "yes" && answer !== "y") { console.log("Cancelled."); process.exit(0); }
    }

    for (const row of toDelete) {
      await db("actor_stats").where("id", row.id).del();
      await db("item_stats").where({ uploaded_at: row.uploaded_at, actor_id: row.actor_id }).del();
      await db("damage_by_type").where({ uploaded_at: row.uploaded_at, actor_id: row.actor_id }).del();
    }
    console.log(`\nDeleted ${toDelete.length} duplicate rows.`);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();