#!/usr/bin/env node
/**
 * Process a Foundry chat-log export and upload extracted dice/outcomes to the API.
 *
 * Handles BOTH storage patterns:
 *  - rolls in message.rolls (typical dnd5e roll, save, skill, check)
 *  - rolls in flags["midi-qol"].attackRoll / damageRolls (midi-qol attack workflow in prod)
 *
 * Usage:
 *   node process-chat-export.js <chat-export.json> [flags]
 *
 * Flags:
 *   --dry-run                 Don't upload, just print payload summary
 *   --target dev              Upload to dev API instead of prod
 *   --include-npcs            Include NPCs (default: skipped)
 *   --since YYYY-MM-DD        Only process messages from this date onward
 *   --until YYYY-MM-DD        Only process messages up to this date
 *   --into "<ISO timestamp>"  Merge into an existing session (uses that timestamp)
 *   --list-sessions           List existing sessions in the API and exit
 *   --out file.json           Write payload to file alongside upload
 *
 * Env overrides:
 *   API_URL=...   API_KEY=...
 */
const fs = require("fs");

const API_URLS = {
  prod: "http://13.223.137.11/api/roll-stats",
  dev:  "http://13.223.137.11/dev-api/roll-stats",
};
const SESSIONS_URLS = {
  prod: "http://13.223.137.11/api/sessions",
  dev:  "http://13.223.137.11/dev-api/sessions",
};
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error("✘ Set the API_KEY env var, e.g. API_KEY=$(grep ^API_KEY backend/.env | cut -d= -f2) node scripts/process-chat-export.js ...");
  process.exit(1);
}
const TRACKED_FACES = [4, 6, 8, 10, 12, 20];

// Args
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const INCLUDE_NPCS = args.includes("--include-npcs");
const target = args[args.indexOf("--target") + 1] || "prod";
const sinceArg = args[args.indexOf("--since") + 1];
const untilArg = args[args.indexOf("--until") + 1];
const sinceTs = (args.includes("--since") && sinceArg) ? new Date(sinceArg).getTime() : null;
const untilTs = (args.includes("--until") && untilArg) ? new Date(untilArg + "T23:59:59").getTime() : null;
const intoTimestamp = args[args.indexOf("--into") + 1];
const useInto = args.includes("--into") && intoTimestamp;
const API_URL = process.env.API_URL || API_URLS[target] || API_URLS.prod;
const SESSIONS_URL = SESSIONS_URLS[target] || SESSIONS_URLS.prod;
const outIdx = args.indexOf("--out");
const OUT_FILE = outIdx >= 0 ? args[outIdx + 1] : null;

// Subcommand: --list-sessions (no file needed)
if (args.includes("--list-sessions")) {
  (async () => {
    const headers = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
    const res = await fetch(SESSIONS_URL, { headers });
    if (!res.ok) { console.error(`Failed (${res.status}):`, await res.text()); process.exit(1); }
    const sessions = await res.json();
    console.log(`Sessions in ${target} (most recent first):`);
    for (const s of sessions) {
      console.log(`  ${s.uploaded_at}   ${s.world_name || s.world_id || "—"}`);
    }
    console.log(`\nTo merge into one of these: --into "<uploaded_at>"`);
    process.exit(0);
  })();
} else {
  runMain();
}

function runMain() {

const file = args.find(a => !a.startsWith("--")
  && !["dev", "prod"].includes(a)
  && !/^\d{4}-\d{2}-\d{2}/.test(a));
if (!file) {
  console.error("Usage: node process-chat-export.js <chat-export.json> [--dry-run] [--target dev] [--into TIMESTAMP] [--list-sessions]");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(`Loaded ${data.messageCount} messages from "${data.worldName}" (${data.worldId})`);
if (sinceTs) console.log(`Filter: since ${new Date(sinceTs).toISOString()}`);
if (untilTs) console.log(`Filter: until ${new Date(untilTs).toISOString()}`);
if (useInto) console.log(`Merge mode: will upload with timestamp ${intoTimestamp}`);

// ── extraction helpers ─────────────────────────────────────────────────────
const result = {};
function ensure(id, name) {
  if (!result[id]) result[id] = { name, dice: {}, outcomes: {} };
  result[id].name = name;
  return result[id];
}
function addDice(id, name, faceMap) {
  const d = ensure(id, name);
  for (const [faces, results] of Object.entries(faceMap)) {
    if (!d.dice[faces]) d.dice[faces] = {};
    for (const v of results) d.dice[faces][v] = (d.dice[faces][v] || 0) + 1;
  }
}
function addOutcome(id, name, type, success) {
  const d = ensure(id, name);
  if (!d.outcomes[type]) d.outcomes[type] = { success: 0, failure: 0 };
  d.outcomes[type][success ? "success" : "failure"] += 1;
}
function addHeal(id, name) {
  const d = ensure(id, name);
  d.healCount = (d.healCount || 0) + 1;
}

function extractDice(roll) {
  const out = {};
  if (!roll) return out;
  function visit(term) {
    if (!term) return;
    if (TRACKED_FACES.includes(term.faces) && Array.isArray(term.results)) {
      for (const r of term.results) {
        if (r && typeof r.result === "number") {
          if (!out[term.faces]) out[term.faces] = [];
          out[term.faces].push(r.result);
        }
      }
    }
    if (Array.isArray(term.terms))    for (const t of term.terms)    visit(t);
    if (Array.isArray(term.rolls))    for (const r of term.rolls)    if (r?.terms) for (const t of r.terms) visit(t);
    if (Array.isArray(term.operands)) for (const t of term.operands) visit(t);
  }
  for (const term of roll.terms || []) visit(term);
  return out;
}

function mergeFaceMap(into, from) {
  for (const [k, v] of Object.entries(from)) {
    if (!into[k]) into[k] = [];
    into[k].push(...v);
  }
}

function isHealRolls(rolls) {
  return (rolls || []).some(r => {
    const t = r?.options?.type;
    if (t === "healing" || t === "temphp") return true;
    for (const term of r?.terms || []) {
      const flv = (term.flavor || term.options?.flavor || "").toLowerCase();
      if (flv.includes("heal")) return true;
    }
    return false;
  });
}

// ── process messages ───────────────────────────────────────────────────────
let processed = 0, dropped = 0;
const dropReasons = {};
function drop(reason) { dropped++; dropReasons[reason] = (dropReasons[reason] || 0) + 1; }

for (const message of data.messages || []) {
  if (sinceTs && message.timestamp < sinceTs) { drop("before_since"); continue; }
  if (untilTs && message.timestamp > untilTs) { drop("after_until"); continue; }

  const actorId = message.speaker?.actor;
  if (!actorId) { drop("no_actor_id"); continue; }
  if (data.users?.[actorId]) { drop("is_user_id"); continue; }
  const actorInfo = data.actors?.[actorId];
  if (!actorInfo) { drop("actor_not_found"); continue; }
  if (!INCLUDE_NPCS && !actorInfo.hasPlayerOwner) { drop("npc"); continue; }
  const actorName = actorInfo.name || message.speaker?.alias || "Unknown";

  const midi = message.flags?.["midi-qol"];
  const dnd  = message.flags?.dnd5e;

  // === Collect all rolls from ALL the places midi-qol might stash them ===
  const allRolls = [];
  if (Array.isArray(message.rolls)) allRolls.push(...message.rolls);
  if (midi?.attackRoll)        allRolls.push(midi.attackRoll);
  if (midi?.d20AttackRoll)     allRolls.push(midi.d20AttackRoll);
  if (Array.isArray(midi?.damageRolls))      allRolls.push(...midi.damageRolls);
  if (Array.isArray(midi?.otherDamageRolls)) allRolls.push(...midi.otherDamageRolls);

  // === Dice extraction ===
  const combined = {};
  for (const roll of allRolls) {
    mergeFaceMap(combined, extractDice(roll));
  }
  if (Object.keys(combined).length) addDice(actorId, actorName, combined);

  // === Attack outcome ===
  const isAttackMsg = midi?.messageType === "attack"
                   || dnd?.activity?.type === "attack"
                   || dnd?.roll?.type === "attack";
  if (isAttackMsg) {
    // Prefer midi.isHit if present (already determined by midi-qol)
    let hit = null;
    if (typeof midi?.isHit === "boolean") hit = midi.isHit;
    else {
      // Use the attack roll if available
      const attackRoll = midi?.attackRoll || message.rolls?.[0];
      if (attackRoll) {
        // Find d20 result
        let d20 = null;
        for (const t of attackRoll.terms || []) {
          if (t.faces === 20 && Array.isArray(t.results)) {
            const active = t.results.find(r => r.active !== false);
            if (active) { d20 = active.result; break; }
          }
        }
        if (d20 === 20) hit = true;
        else if (d20 === 1) hit = false;
        else {
          const total = attackRoll.total;
          const ac = attackRoll.options?.target ?? dnd?.targets?.[0]?.ac;
          if (typeof total === "number" && typeof ac === "number") hit = total >= ac;
        }
      }
    }
    if (hit !== null) addOutcome(actorId, actorName, "attack", hit);
  }

  // === Heal detection ===
  const isHealActivity = dnd?.activity?.type === "heal";
  const allDamageRolls = [
    ...(midi?.damageRolls || []),
    ...(midi?.otherDamageRolls || []),
  ];
  if (isHealActivity || isHealRolls(allDamageRolls)) {
    addHeal(actorId, actorName);
  }

  // === Save / check / death outcomes ===
  if (dnd) {
    const r = dnd.roll;
    const act = dnd.activity;
    const rollType = r?.type || act?.type;
    const roll = message.rolls?.[0];
    const dc = r?.dc ?? dnd.dc ?? dnd.targetDC ?? roll?.options?.target ?? roll?.options?.targetValue;
    let success = null;
    if (r && typeof r.success === "boolean") success = r.success;
    else if (typeof midi?.isHit === "boolean" && rollType === "save") success = midi.isHit; // unusual
    else if (typeof dc === "number" && typeof roll?.total === "number") success = roll.total >= dc;

    if (success !== null && rollType) {
      const t = rollType;
      if (t === "save" || t === "savingThrow") addOutcome(actorId, actorName, "save", success);
      else if (t === "ability") addOutcome(actorId, actorName, "check", success);
      else if (t === "skill")   addOutcome(actorId, actorName, "check", success);
      else if (t === "death")   addOutcome(actorId, actorName, "death", success);
    }
  }
  processed++;
}

console.log(`Processed ${processed}, dropped ${dropped}`, dropReasons);
console.log("Per-actor summary:");
for (const [id, d] of Object.entries(result)) {
  const diceCount = Object.values(d.dice).reduce((s, f) => s + Object.values(f).reduce((x, y) => x + y, 0), 0);
  const outcomeCount = Object.values(d.outcomes).reduce((s, o) => s + o.success + o.failure, 0);
  const outcomeBreakdown = Object.entries(d.outcomes).map(([k, v]) => `${k}:${v.success}/${v.failure}`).join(" ");
  console.log(`  ${d.name.padEnd(28)}  dice=${String(diceCount).padStart(4)}  outcomes=${String(outcomeCount).padStart(4)} [${outcomeBreakdown}]  heals=${d.healCount || 0}`);
}

const payload = {
  timestamp: useInto ? intoTimestamp : (data.exportedAt || new Date().toISOString()),
  worldId: data.worldId,
  worldName: data.worldName,
  stats: {},
  diceRolls: result,
};

if (OUT_FILE) {
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
  console.log(`Wrote payload to ${OUT_FILE}`);
}

if (DRY_RUN) {
  console.log("\n=== DRY RUN — would upload to:", API_URL, "===");
  console.log("(Not uploading. Use --out file.json to inspect full payload.)");
  process.exit(0);
}

(async () => {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) { console.error(`Upload failed (${res.status}):`, text); process.exit(1); }
  console.log(`✔ Uploaded to ${API_URL}:`, text);
})();
} // end runMain