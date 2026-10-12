#!/usr/bin/env node
/**
 * Backfill / correct all stats (dice, attacks, damage, kills, healing, saves…)
 * from a Foundry chat-log export.
 *
 * Uses the same extractor as the Foundry module (scripts/extract.mjs), and the
 * backend replaces everything stored for each message it receives — so this is
 * safe to run as many times as you like. Each roll lands in the session it
 * actually happened in (by message timestamp); no --into needed.
 *
 * Usage:
 *   API_KEY=... node scripts/process-chat-export.mjs <chat-export.json> [flags]
 *
 * Flags:
 *   --dry-run            Extract and print per-character totals, don't upload
 *   --target dev|prod    Which API to upload to (default: prod)
 *   --include-npcs       Include NPCs (default: player characters only)
 *   --since YYYY-MM-DD   Only messages from this date onward
 *   --until YYYY-MM-DD   Only messages up to the end of this date
 *   --out file.json      Also write the extracted events to a file
 *
 * Env:
 *   API_KEY   bearer token (required unless --dry-run)
 *   API_BASE  override the API base URL, e.g. http://localhost:3000/api
 */
import fs from "fs";
import { extractAll, summarise, uploadEvents } from "./extract.mjs";

const API_BASES = {
  prod: "http://13.223.137.11/api",
  dev:  "http://13.223.137.11/dev-api",
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const optionValues = new Set(["--target", "--since", "--until", "--out"].map(opt).filter(Boolean));
const file = args.find(a => !a.startsWith("--") && !optionValues.has(a));

if (!file) {
  console.error("Usage: node scripts/process-chat-export.mjs <chat-export.json> [--dry-run] [--target dev|prod] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--include-npcs] [--out file.json]");
  process.exit(1);
}

const DRY_RUN = flag("--dry-run");
const target = opt("--target") || "prod";
const API_BASE = process.env.API_BASE || API_BASES[target];
if (!API_BASE) { console.error(`Unknown --target "${target}" (use dev or prod)`); process.exit(1); }
const API_KEY = process.env.API_KEY;
if (!DRY_RUN && !API_KEY) {
  console.error("✘ Set the API_KEY env var, e.g.\n  API_KEY=$(grep ^API_KEY backend/.env | cut -d= -f2) node scripts/process-chat-export.mjs <file>");
  process.exit(1);
}
const since = opt("--since") ? new Date(opt("--since")).getTime() : null;
const until = opt("--until") ? new Date(opt("--until") + "T23:59:59.999").getTime() : null;

const data = JSON.parse(fs.readFileSync(file, "utf8"));
const messages = (data.messages || []).filter(m =>
  (since === null || m.timestamp >= since) && (until === null || m.timestamp <= until));
console.log(`Loaded ${data.messages?.length ?? 0} messages from "${data.worldName}" (${data.worldId}); processing ${messages.length}`);

const actors = data.actors || {};
const ctx = {
  includeNpcs: flag("--include-npcs"),
  isPlayerCharacter: (id) => !!actors[id]?.hasPlayerOwner,
  actorName: (id, fallback) => actors[id]?.name ?? fallback,
};
const results = extractAll(messages, ctx);

console.log("\nPer-character totals in this export:");
for (const a of Object.values(summarise(results))) {
  const o = Object.entries(a.outcomes).map(([k, v]) => `${k} ${v.success}/${v.failure}`).join("  ");
  const shop = (a.bought ? `   bought ${a.bought} items, ${(a.spentCp / 100).toFixed(2)} gp` : "")
             + (a.sold ? `   sold ${a.sold} items, ${(a.earnedCp / 100).toFixed(2)} gp` : "");
  console.log(`  ${a.name.padEnd(24)} dice ${String(a.dice).padStart(5)} (d20 ${String(a.d20).padStart(4)})   damage ${a.damage}  kills ${a.kills}  healing ${a.healing}  taken ${a.taken}${shop}`);
  console.log(`  ${"".padEnd(24)} ${o}`);
}

if (opt("--out")) {
  fs.writeFileSync(opt("--out"), JSON.stringify(results, null, 2));
  console.log(`\nWrote events to ${opt("--out")}`);
}

if (DRY_RUN) {
  console.log(`\nDry run — nothing uploaded (would send to ${API_BASE}/chat-events).`);
  process.exit(0);
}

const url = `${API_BASE}/chat-events`;
console.log(`\nUploading ${results.length} messages to ${url} …`);
try {
  await uploadEvents({
    url, apiKey: API_KEY, worldId: data.worldId, worldName: data.worldName, results,
    onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total}`),
  });
  console.log("\n✔ Done. Previous values for these messages were replaced.");
} catch (e) {
  console.error(`\n✘ Upload failed: ${e.message}`);
  process.exit(1);
}
