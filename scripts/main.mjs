import { StatsCollector } from "./StatsCollector.mjs";
import { StatsUploader } from "./StatsUploader.mjs";
import { registerSettings } from "./settings.mjs";

const MODULE_ID = "dnd-group-campaign-2-stats";
const TRACKED_FACES = [4, 6, 8, 10, 12, 20];

// ── Dice extraction ──────────────────────────────────────────────────────────

function extractAllDice(roll) {
  // Returns { 4: [results...], 6: [...], 20: [...] }
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
  }

  for (const term of roll.terms || []) visit(term);
  return out;
}

async function recordDice(actorId, actorName, faceMap) {
  if (!game.user.isGM || !actorId) return;
  const totalFaces = Object.keys(faceMap).length;
  if (!totalFaces) return;
  try {
    const rolls = game.settings.get(MODULE_ID, "diceRolls") || {};
    if (!rolls[actorId]) rolls[actorId] = { name: actorName, dice: {} };
    rolls[actorId].name = actorName;
    if (!rolls[actorId].dice) rolls[actorId].dice = {};
    for (const [faces, results] of Object.entries(faceMap)) {
      if (!rolls[actorId].dice[faces]) rolls[actorId].dice[faces] = {};
      for (const value of results) {
        rolls[actorId].dice[faces][value] = (rolls[actorId].dice[faces][value] || 0) + 1;
      }
    }
    await game.settings.set(MODULE_ID, "diceRolls", rolls);
  } catch (e) {
    console.warn(`${MODULE_ID} | Failed to record dice:`, e);
  }
}

function captureFromRoll(actor, roll) {
  if (!actor || !roll) return;
  const faces = extractAllDice(roll);
  if (Object.keys(faces).length) recordDice(actor.id, actor.name, faces);
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
  console.log(`${MODULE_ID} | Ready`);
});

// ── Dice roll capture hooks ──────────────────────────────────────────────────

// Midi-qol full workflow — captures attack + damage dice
Hooks.on("midi-qol.RollComplete", (workflow) => {
  if (!game.user.isGM) return;
  const actor = workflow?.actor;
  if (!actor) return;
  // Attack roll dice
  if (workflow.attackRoll) captureFromRoll(actor, workflow.attackRoll);
  // Damage roll(s) — newer midi-qol uses damageRolls array, older uses damageRoll
  const damageRolls = workflow.damageRolls ?? (workflow.damageRoll ? [workflow.damageRoll] : []);
  for (const dr of damageRolls) captureFromRoll(actor, dr);
});

// Standalone dnd5e roll hooks for saves, checks, skills, etc.
Hooks.on("dnd5e.rollSavingThrow", (actor, roll) => captureFromRoll(actor, roll));
Hooks.on("dnd5e.rollAbilityTest", (actor, roll) => captureFromRoll(actor, roll));
Hooks.on("dnd5e.rollSkill", (actor, roll) => captureFromRoll(actor, roll));
Hooks.on("dnd5e.rollDeathSave", (actor, roll) => captureFromRoll(actor, roll));

// v4+ dnd5e hooks
Hooks.on("dnd5e.rollAttackV2", (rolls, data) => {
  const actor = data?.subject?.actor || data?.actor;
  for (const r of rolls || []) captureFromRoll(actor, r);
});
Hooks.on("dnd5e.rollSavingThrowV2", (rolls, data) => {
  const actor = data?.subject || data?.actor;
  for (const r of rolls || []) captureFromRoll(actor, r);
});
Hooks.on("dnd5e.rollDamageV2", (rolls, data) => {
  const actor = data?.subject?.actor || data?.actor;
  for (const r of rolls || []) captureFromRoll(actor, r);
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
          <p>Upload session stats for <strong>${actorCount}</strong> actor(s) and reset session counters.</p>
          <p><strong>Time:</strong> ${now}</p>
          <p><strong>Endpoint:</strong> <code>${apiUrl}</code></p>
          <p><strong>Dice tracked:</strong> ${diceCount} actor(s)</p>
        </div>
      `,
      buttons: {
        upload: {
          icon: '<i class="fas fa-cloud-upload-alt"></i>',
          label: "Upload & End Session",
          callback: () => uploader.snapshotAndUpload(collector),
        },
        settings: {
          icon: '<i class="fas fa-cog"></i>',
          label: "Settings",
          callback: () => game.settings.sheet.render(true),
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
        },
      },
      default: actorCount > 0 ? "upload" : "settings",
    }).render(true);
  });
});
