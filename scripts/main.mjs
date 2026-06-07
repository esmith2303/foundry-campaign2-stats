import { StatsCollector } from "./StatsCollector.mjs";
import { StatsUploader } from "./StatsUploader.mjs";
import { registerSettings } from "./settings.mjs";

const MODULE_ID = "dnd-group-campaign-2-stats";
const TRACKED_FACES = [4, 6, 8, 10, 12, 20];
const DEBUG = true; // Set to false once working — logs every roll capture

function log(...args) { if (DEBUG) console.log(`${MODULE_ID} |`, ...args); }

// ── Dice extraction ──────────────────────────────────────────────────────────

function extractAllDice(roll) {
  const out = {};
  if (!roll) return out;
  function visit(term) {
    if (!term) return;
    if (TRACKED_FACES.includes(term.faces) && Array.isArray(term.results)) {
      for (const r of term.results) {
        if (r && (r.active === undefined || r.active) && typeof r.result === "number") {
          if (!out[term.faces]) out[term.faces] = [];
          out[term.faces].push(r.result);
        }
      }
    }
    if (Array.isArray(term.terms)) for (const t of term.terms) visit(t);
    if (Array.isArray(term.rolls)) for (const r of term.rolls) if (r?.terms) for (const t of r.terms) visit(t);
    if (Array.isArray(term.operands)) for (const t of term.operands) visit(t);
  }
  for (const term of roll.terms || []) visit(term);
  return out;
}

// Try to coerce various stored-roll shapes into a usable Roll-like object
function asRoll(maybeRoll) {
  if (!maybeRoll) return null;
  // Already a Roll instance
  if (maybeRoll.terms) return maybeRoll;
  // Serialised JSON
  if (typeof maybeRoll === "string") {
    try { return Roll.fromJSON(maybeRoll); } catch {}
  }
  if (maybeRoll.class && maybeRoll.terms === undefined) {
    try { return Roll.fromData(maybeRoll); } catch {}
  }
  // Object with terms directly
  if (Array.isArray(maybeRoll.terms)) return maybeRoll;
  return null;
}

// ── Storage ──────────────────────────────────────────────────────────────────

async function recordDice(actorId, actorName, faceMap, source = "?") {
  if (!game.user.isGM || !actorId) return;
  if (!Object.keys(faceMap).length) return;
  log(`record dice [${source}] ${actorName}:`, faceMap);
  try {
    const rolls = game.settings.get(MODULE_ID, "diceRolls") || {};
    if (!rolls[actorId]) rolls[actorId] = { name: actorName, dice: {}, outcomes: {} };
    rolls[actorId].name = actorName;
    if (!rolls[actorId].dice) rolls[actorId].dice = {};
    for (const [faces, results] of Object.entries(faceMap)) {
      if (!rolls[actorId].dice[faces]) rolls[actorId].dice[faces] = {};
      for (const value of results) {
        rolls[actorId].dice[faces][value] = (rolls[actorId].dice[faces][value] || 0) + 1;
      }
    }
    await game.settings.set(MODULE_ID, "diceRolls", rolls);
  } catch (e) { console.warn(`${MODULE_ID} | Failed to record dice:`, e); }
}

async function recordOutcome(actorId, actorName, type, success, source = "?") {
  if (!game.user.isGM || !actorId || !type || success === null || success === undefined) return;
  log(`record outcome [${source}] ${actorName} ${type}: ${success ? "success" : "failure"}`);
  try {
    const rolls = game.settings.get(MODULE_ID, "diceRolls") || {};
    if (!rolls[actorId]) rolls[actorId] = { name: actorName, dice: {}, outcomes: {} };
    rolls[actorId].name = actorName;
    if (!rolls[actorId].outcomes) rolls[actorId].outcomes = {};
    if (!rolls[actorId].outcomes[type]) rolls[actorId].outcomes[type] = { success: 0, failure: 0 };
    rolls[actorId].outcomes[type][success ? "success" : "failure"] += 1;
    await game.settings.set(MODULE_ID, "diceRolls", rolls);
  } catch (e) { console.warn(`${MODULE_ID} | Failed to record outcome:`, e); }
}

function captureFromRoll(actor, roll, source) {
  if (!actor || !roll) return;
  const faces = extractAllDice(roll);
  if (Object.keys(faces).length) recordDice(actor.id, actor.name, faces, source);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initialising`);
  registerSettings(MODULE_ID);
});

Hooks.once("ready", () => {
  if (!game.modules.get("midi-qol")?.active) {
    ui.notifications.error("Midi-QOL Stats Uploader requires midi-qol to be active.");
    return;
  }
  game.modules.get(MODULE_ID).collector = new StatsCollector(MODULE_ID);
  game.modules.get(MODULE_ID).uploader = new StatsUploader(MODULE_ID);
  console.log(`${MODULE_ID} | Ready — debug mode ON, watch console for "record dice/outcome" lines`);
});

// ── Universal capture via createChatMessage ──────────────────────────────────

Hooks.on("createChatMessage", (message) => {
  if (!game.user.isGM) return;

  // Get actor from speaker
  let actor = null;
  if (message.speaker?.token) {
    const token = canvas?.tokens?.get(message.speaker.token);
    if (token?.actor) actor = token.actor;
  }
  if (!actor && message.speaker?.actor) {
    actor = game.actors?.get(message.speaker.actor);
  }
  if (!actor) {
    log("chat msg with no actor — skipping", message.id);
    return;
  }

  // Collect ALL rolls from every possible location
  const allRolls = [];

  // Standard: message.rolls
  if (message.rolls?.length) {
    for (const r of message.rolls) allRolls.push({ roll: r, source: "msg.rolls" });
  }

  // midi-qol flags can hold rolls
  const midi = message.flags?.["midi-qol"];
  if (midi) {
    if (midi.roll) { const r = asRoll(midi.roll); if (r) allRolls.push({ roll: r, source: "midi.roll" }); }
    if (midi.attackRoll) { const r = asRoll(midi.attackRoll); if (r) allRolls.push({ roll: r, source: "midi.attackRoll" }); }
    if (midi.damageRoll) { const r = asRoll(midi.damageRoll); if (r) allRolls.push({ roll: r, source: "midi.damageRoll" }); }
    if (Array.isArray(midi.damageRolls)) {
      for (const dr of midi.damageRolls) { const r = asRoll(dr); if (r) allRolls.push({ roll: r, source: "midi.damageRolls[]" }); }
    }
    if (Array.isArray(midi.rolls)) {
      for (const dr of midi.rolls) { const r = asRoll(dr); if (r) allRolls.push({ roll: r, source: "midi.rolls[]" }); }
    }
  }

  log(`chat msg ${message.id}: actor=${actor.name}, ${allRolls.length} roll(s) found, flags:`, Object.keys(message.flags || {}));

  // Capture dice from all found rolls (dedupe by combining first)
  const combined = {};
  for (const { roll, source } of allRolls) {
    const faces = extractAllDice(roll);
    for (const [k, v] of Object.entries(faces)) {
      if (!combined[k]) combined[k] = [];
      combined[k].push(...v);
    }
  }
  if (Object.keys(combined).length) {
    recordDice(actor.id, actor.name, combined, "chat");
  } else if (allRolls.length) {
    log("rolls found but no tracked dice (only modifiers?)");
  }

  // Outcomes from midi-qol flags
  if (midi) {
    if (typeof midi.isHit === "boolean") recordOutcome(actor.id, actor.name, "attack", midi.isHit, "midi.isHit");
    if (typeof midi.isSuccess === "boolean") recordOutcome(actor.id, actor.name, "save", midi.isSuccess, "midi.isSuccess");
  }

  // Outcomes from dnd5e flags
  const dnd = message.flags?.dnd5e;
  if (dnd) {
    log(`dnd5e flags for ${message.id}:`, JSON.stringify(dnd).slice(0, 500));

    const r = dnd.roll;
    const totalRoll = message.rolls?.[0]?.total;

    // Try various paths to determine success
    function findSuccess(rollType) {
      // Direct boolean in roll
      if (r && typeof r.success === "boolean") return r.success;
      // Top-level success
      if (typeof dnd.success === "boolean") return dnd.success;
      // Calculate from DC if available
      const dc = r?.dc ?? dnd.dc ?? dnd.targetDC ?? dnd.roll?.dc;
      if (typeof dc === "number" && typeof totalRoll === "number") return totalRoll >= dc;
      return null;
    }

    if (r) {
      const t = r.type;
      if (t === "save" || t === "savingThrow") {
        const s = findSuccess("save");
        if (s !== null) recordOutcome(actor.id, actor.name, "save", s, "dnd5e.save");
      } else if (t === "ability") {
        const s = findSuccess("check");
        if (s !== null) recordOutcome(actor.id, actor.name, "check", s, "dnd5e.ability");
      } else if (t === "skill") {
        const s = findSuccess("check");
        if (s !== null) recordOutcome(actor.id, actor.name, "check", s, "dnd5e.skill");
      } else if (t === "death") {
        const s = findSuccess("death");
        if (s !== null) recordOutcome(actor.id, actor.name, "death", s, "dnd5e.death");
      }
    }
  }
});

// ── updateChatMessage — catch outcomes added by midi-qol AFTER message creation ───

const outcomeMessagesSeen = new Set();

Hooks.on("updateChatMessage", (message, _changes, _options, _userId) => {
  if (!game.user.isGM) return;
  if (outcomeMessagesSeen.has(message.id)) return;

  const midi = message.flags?.["midi-qol"];
  const dnd = message.flags?.dnd5e;

  // Get actor
  let actor = null;
  if (message.speaker?.token) {
    const token = canvas?.tokens?.get(message.speaker.token);
    if (token?.actor) actor = token.actor;
  }
  if (!actor && message.speaker?.actor) actor = game.actors?.get(message.speaker.actor);
  if (!actor) return;

  let recorded = false;

  if (midi) {
    if (typeof midi.isHit === "boolean") { recordOutcome(actor.id, actor.name, "attack", midi.isHit, "update:midi.isHit"); recorded = true; }
    if (typeof midi.isSuccess === "boolean") { recordOutcome(actor.id, actor.name, "save", midi.isSuccess, "update:midi.isSuccess"); recorded = true; }
  }

  if (!recorded && dnd?.roll) {
    const r = dnd.roll;
    const totalRoll = message.rolls?.[0]?.total;
    const dc = r?.dc ?? dnd.dc ?? dnd.targetDC;
    let success = null;
    if (typeof r.success === "boolean") success = r.success;
    else if (typeof dc === "number" && typeof totalRoll === "number") success = totalRoll >= dc;

    if (success !== null) {
      const t = r.type;
      if (t === "save" || t === "savingThrow") { recordOutcome(actor.id, actor.name, "save", success, "update:dnd5e.save"); recorded = true; }
      else if (t === "ability") { recordOutcome(actor.id, actor.name, "check", success, "update:dnd5e.ability"); recorded = true; }
      else if (t === "skill") { recordOutcome(actor.id, actor.name, "check", success, "update:dnd5e.skill"); recorded = true; }
      else if (t === "death") { recordOutcome(actor.id, actor.name, "death", success, "update:dnd5e.death"); recorded = true; }
    }
  }

  if (recorded) outcomeMessagesSeen.add(message.id);
  // Cap set size
  if (outcomeMessagesSeen.size > 500) {
    const arr = [...outcomeMessagesSeen];
    outcomeMessagesSeen.clear();
    arr.slice(-250).forEach(id => outcomeMessagesSeen.add(id));
  }
});

// ── midi-qol workflow hooks (belt and braces) ────────────────────────────────

// Determine hit/miss by checking nat 20/1 + comparing attack total to target AC
function determineHit(workflow) {
  // Find the d20 result (active one, accounting for advantage/disadvantage)
  let d20 = null;
  for (const term of workflow.attackRoll?.terms || []) {
    if (term.faces === 20 && term.results?.length) {
      const active = term.results.find(r => r.active !== false);
      if (active) { d20 = active.result; break; }
    }
  }
  // Nat 20 always hits, nat 1 always misses
  if (d20 === 20) return true;
  if (d20 === 1) return false;

  // Compare attack total to target AC
  if (workflow.targets?.size > 0 && typeof workflow.attackTotal === "number") {
    const target = [...workflow.targets][0];
    const ac = target?.actor?.system?.attributes?.ac?.value
            ?? target?.actor?.system?.attributes?.ac?.flat
            ?? target?.actor?.system?.attributes?.ac;
    if (typeof ac === "number") return workflow.attackTotal >= ac;
  }
  return null;
}

Hooks.on("midi-qol.AttackRollComplete", (workflow) => {
  if (!game.user.isGM || !workflow?.actor) return;
  log("midi-qol.AttackRollComplete fired, attackTotal:", workflow.attackTotal, "targets:", workflow.targets?.size);
  captureFromRoll(workflow.actor, workflow.attackRoll, "midi.AttackRollComplete");

  // Determine hit/miss right now
  const hit = determineHit(workflow);
  if (hit !== null && !workflow._statsOutcomeRecorded) {
    recordOutcome(workflow.actor.id, workflow.actor.name, "attack", hit, "AttackRollComplete-AC");
    workflow._statsOutcomeRecorded = true;
  } else if (hit === null) {
    log("could not determine hit/miss — no target AC available");
  }
});

Hooks.on("midi-qol.DamageRollComplete", (workflow) => {
  if (!game.user.isGM || !workflow?.actor) return;
  log("midi-qol.DamageRollComplete fired");
  const dr = workflow.damageRolls ?? (workflow.damageRoll ? [workflow.damageRoll] : []);
  for (const r of dr) captureFromRoll(workflow.actor, r, "midi.DamageRollComplete");

  // Fallback: if attack outcome wasn't recorded yet but damage rolled, it hit
  if (workflow.attackRoll && !workflow._statsOutcomeRecorded) {
    recordOutcome(workflow.actor.id, workflow.actor.name, "attack", true, "DamageRollComplete-fallback");
    workflow._statsOutcomeRecorded = true;
  }
});

Hooks.on("midi-qol.RollComplete", (workflow) => {
  if (!game.user.isGM) return;
  log("midi-qol.RollComplete fired");
});

// ── Toolbar button ───────────────────────────────────────────────────────────

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const tokenControls = controls["tokens"];
  if (!tokenControls) return;
  tokenControls.tools["midi-qol-upload"] = {
    name: "midi-qol-upload",
    title: "Upload Midi-QOL Stats",
    icon: "fas fa-cloud-upload-alt",
    button: true,
    onChange: () => {},
  };
});

Hooks.on("renderSceneControls", () => {
  if (!game.user.isGM) return;
  const btn = document.querySelector('[data-tool="midi-qol-upload"]');
  if (!btn) return;
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);

  newBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const mod = game.modules.get(MODULE_ID);
    const collector = mod?.collector;
    const uploader = mod?.uploader;
    if (!collector || !uploader) {
      ui.notifications.error("Midi-QOL Stats Uploader is not initialised.");
      return;
    }
    const apiUrl = game.settings.get(MODULE_ID, "apiUrl") || "(not configured)";
    const now = new Date().toLocaleString();
    const actorCount = collector.pendingCount;
    const diceData = game.settings.get(MODULE_ID, "diceRolls") || {};
    const diceCount = Object.keys(diceData).length;

    new Dialog({
      title: "Upload Midi-QOL Stats",
      content: `
        <div class="stats-uploader-dialog">
          <p>Upload session stats for <strong>${actorCount}</strong> actor(s).</p>
          <p><strong>Time:</strong> ${now}</p>
          <p><strong>Endpoint:</strong> <code>${apiUrl}</code></p>
          <p><strong>Dice tracked:</strong> ${diceCount} actor(s)</p>
        </div>
      `,
      buttons: {
        upload: { icon: '<i class="fas fa-cloud-upload-alt"></i>', label: "Upload & End Session", callback: () => uploader.snapshotAndUpload(collector) },
        settings: { icon: '<i class="fas fa-cog"></i>', label: "Settings", callback: () => game.settings.sheet.render(true) },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" },
      },
      default: actorCount > 0 ? "upload" : "settings",
    }).render(true);
  });
});
