import { StatsCollector } from "./StatsCollector.mjs";
import { StatsUploader } from "./StatsUploader.mjs";
import { registerSettings } from "./settings.mjs";

const MODULE_ID = "dnd-group-campaign-2-stats";
const TRACKED_FACES = [4, 6, 8, 10, 12, 20];
const DEBUG = true;

function log(...args) { if (DEBUG) console.log(`${MODULE_ID} |`, ...args); }

// ── Dice extraction ──────────────────────────────────────────────────────────

function extractAllDice(roll) {
  const out = {};
  if (!roll) return out;
  function visit(term) {
    if (!term) return;
    if (TRACKED_FACES.includes(term.faces) && Array.isArray(term.results)) {
      for (const r of term.results) {
        // Track ALL rolls including dropped ones (advantage/disadvantage)
        // so raw dice luck is reflected, not just game-mechanic outcomes
        if (r && typeof r.result === "number") {
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

function asRoll(maybeRoll) {
  if (!maybeRoll) return null;
  if (maybeRoll.terms) return maybeRoll;
  if (typeof maybeRoll === "string") { try { return Roll.fromJSON(maybeRoll); } catch {} }
  if (maybeRoll.class && maybeRoll.terms === undefined) { try { return Roll.fromData(maybeRoll); } catch {} }
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

function getActorFromMessage(message) {
  if (message.speaker?.token) {
    const token = canvas?.tokens?.get(message.speaker.token);
    if (token?.actor) return token.actor;
  }
  if (message.speaker?.actor) return game.actors?.get(message.speaker.actor);
  return null;
}

// Tracks message IDs we've already recorded a non-attack outcome for
// (attack outcomes are handled exclusively by midi-qol.AttackRollComplete)
const outcomeRecordedForMessage = new Set();

function tryRecordNonAttackOutcome(message, actor) {
  if (outcomeRecordedForMessage.has(message.id)) return;

  const midi = message.flags?.["midi-qol"];
  const dnd = message.flags?.dnd5e;
  let recorded = false;

  // Save outcomes from midi-qol (NOT attack — that's the workflow hook's job)
  if (midi && typeof midi.isSuccess === "boolean") {
    recordOutcome(actor.id, actor.name, "save", midi.isSuccess, "msg:midi.isSuccess");
    recorded = true;
  }

  // Save/check/death outcomes from dnd5e flags
  if (!recorded && dnd?.roll) {
    const r = dnd.roll;
    const roll = message.rolls?.[0];
    const totalRoll = roll?.total;
    // DC can be in flag locations OR on the Roll's options (dnd5e 4.x+ stores it there)
    const dc = r?.dc
            ?? dnd.dc
            ?? dnd.targetDC
            ?? dnd.roll?.dc
            ?? roll?.options?.target
            ?? roll?.options?.targetValue
            ?? roll?.options?.dc;
    let success = null;
    if (typeof r.success === "boolean") success = r.success;
    else if (typeof dc === "number" && typeof totalRoll === "number") success = totalRoll >= dc;

    if (success !== null) {
      const t = r.type;
      // Skip attack — that's handled by AttackRollComplete
      if (t === "save" || t === "savingThrow") { recordOutcome(actor.id, actor.name, "save", success, "msg:dnd5e.save"); recorded = true; }
      else if (t === "ability") { recordOutcome(actor.id, actor.name, "check", success, "msg:dnd5e.ability"); recorded = true; }
      else if (t === "skill") { recordOutcome(actor.id, actor.name, "check", success, "msg:dnd5e.skill"); recorded = true; }
      else if (t === "death") { recordOutcome(actor.id, actor.name, "death", success, "msg:dnd5e.death"); recorded = true; }
    } else {
      log(`could not determine outcome for ${actor.name}: type=${r.type}, total=${totalRoll}, dc=${dc}, success=${r.success}`);
    }
  }

  if (recorded) outcomeRecordedForMessage.add(message.id);

  // Cap set size
  if (outcomeRecordedForMessage.size > 500) {
    const arr = [...outcomeRecordedForMessage];
    outcomeRecordedForMessage.clear();
    arr.slice(-250).forEach(id => outcomeRecordedForMessage.add(id));
  }
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
  console.log(`${MODULE_ID} | Ready — debug mode ON`);
});

// ── createChatMessage: dice capture + non-attack outcomes ────────────────────

Hooks.on("createChatMessage", (message) => {
  if (!game.user.isGM) return;

  const actor = getActorFromMessage(message);
  if (!actor) return;

  // Collect rolls from message.rolls + midi-qol flag locations
  const allRolls = [];
  if (message.rolls?.length) for (const r of message.rolls) allRolls.push(r);
  const midi = message.flags?.["midi-qol"];
  if (midi) {
    [midi.roll, midi.attackRoll, midi.damageRoll, ...(midi.damageRolls || []), ...(midi.rolls || [])]
      .filter(Boolean).forEach(x => { const r = asRoll(x); if (r) allRolls.push(r); });
  }

  // Combine dice from all rolls
  const combined = {};
  for (const roll of allRolls) {
    const faces = extractAllDice(roll);
    for (const [k, v] of Object.entries(faces)) {
      if (!combined[k]) combined[k] = [];
      combined[k].push(...v);
    }
  }
  if (Object.keys(combined).length) recordDice(actor.id, actor.name, combined, "chat");

  log(`chat msg ${message.id}: actor=${actor.name}, flags:`, Object.keys(message.flags || {}));
  if (message.flags?.dnd5e) log(`  dnd5e:`, JSON.stringify(message.flags.dnd5e).slice(0, 300));

  // Record non-attack outcomes (saves, checks, death)
  tryRecordNonAttackOutcome(message, actor);
});

// ── updateChatMessage: catch outcomes added by midi-qol AFTER creation ───────

Hooks.on("updateChatMessage", (message) => {
  if (!game.user.isGM) return;
  const actor = getActorFromMessage(message);
  if (!actor) return;
  tryRecordNonAttackOutcome(message, actor);
});

// ── midi-qol workflow hooks: attack outcomes + dice capture ──────────────────

function determineHit(workflow) {
  let d20 = null;
  for (const term of workflow.attackRoll?.terms || []) {
    if (term.faces === 20 && term.results?.length) {
      const active = term.results.find(r => r.active !== false);
      if (active) { d20 = active.result; break; }
    }
  }
  if (d20 === 20) return true;
  if (d20 === 1) return false;

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

  const hit = determineHit(workflow);
  if (hit !== null && !workflow._statsOutcomeRecorded) {
    recordOutcome(workflow.actor.id, workflow.actor.name, "attack", hit, "AttackRollComplete-AC");
    workflow._statsOutcomeRecorded = true;
  } else if (hit === null) {
    log("could not determine hit/miss — no target AC available");
  }

  // Also mark the attack chat message as "outcome handled" to prevent double-counting
  if (workflow.itemCardId) outcomeRecordedForMessage.add(workflow.itemCardId);
  if (workflow.chatCardId) outcomeRecordedForMessage.add(workflow.chatCardId);
});

Hooks.on("midi-qol.DamageRollComplete", (workflow) => {
  if (!game.user.isGM || !workflow?.actor) return;
  log("midi-qol.DamageRollComplete fired");
  const dr = workflow.damageRolls ?? (workflow.damageRoll ? [workflow.damageRoll] : []);
  for (const r of dr) captureFromRoll(workflow.actor, r, "midi.DamageRollComplete");

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
