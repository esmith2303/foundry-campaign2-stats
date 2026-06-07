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
    // Some terms have results array of {result, active, ...}
    if (TRACKED_FACES.includes(term.faces) && Array.isArray(term.results)) {
      for (const r of term.results) {
        // Only count active results — the kept die when rolling adv/dis
        if (r && (r.active === undefined || r.active) && typeof r.result === "number") {
          if (!out[term.faces]) out[term.faces] = [];
          out[term.faces].push(r.result);
        }
      }
    }
    // Recurse into nested structures
    if (Array.isArray(term.terms)) for (const t of term.terms) visit(t);
    if (Array.isArray(term.rolls)) for (const r of term.rolls) if (r?.terms) for (const t of r.terms) visit(t);
    if (Array.isArray(term.operands)) for (const t of term.operands) visit(t);
  }

  for (const term of roll.terms || []) visit(term);
  return out;
}

// ── Storage helpers ──────────────────────────────────────────────────────────

async function recordDice(actorId, actorName, faceMap) {
  if (!game.user.isGM || !actorId) return;
  if (!Object.keys(faceMap).length) return;
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
  } catch (e) {
    console.warn(`${MODULE_ID} | Failed to record dice:`, e);
  }
}

async function recordOutcome(actorId, actorName, type, success) {
  if (!game.user.isGM || !actorId || !type || success === null || success === undefined) return;
  try {
    const rolls = game.settings.get(MODULE_ID, "diceRolls") || {};
    if (!rolls[actorId]) rolls[actorId] = { name: actorName, dice: {}, outcomes: {} };
    rolls[actorId].name = actorName;
    if (!rolls[actorId].outcomes) rolls[actorId].outcomes = {};
    if (!rolls[actorId].outcomes[type]) rolls[actorId].outcomes[type] = { success: 0, failure: 0 };
    rolls[actorId].outcomes[type][success ? "success" : "failure"] += 1;
    await game.settings.set(MODULE_ID, "diceRolls", rolls);
  } catch (e) {
    console.warn(`${MODULE_ID} | Failed to record outcome:`, e);
  }
}

// ── Message inspection ──────────────────────────────────────────────────────

function getActorFromMessage(message) {
  // Try token first (more reliable for owned actors)
  if (message.speaker?.token) {
    const token = canvas?.tokens?.get(message.speaker.token);
    if (token?.actor) return token.actor;
  }
  if (message.speaker?.actor) {
    return game.actors?.get(message.speaker.actor);
  }
  return null;
}

function determineOutcome(message) {
  const midi = message.flags?.["midi-qol"];
  const dnd = message.flags?.dnd5e;

  // midi-qol attack messages
  if (midi) {
    if (midi.type === "attackRoll" || midi.isAttack || midi.isHit !== undefined) {
      if (typeof midi.isHit === "boolean") return { type: "attack", success: midi.isHit };
    }
    if (midi.type === "saveRoll" && typeof midi.isSuccess === "boolean") {
      return { type: "save", success: midi.isSuccess };
    }
  }

  // dnd5e standard messages
  if (dnd?.roll) {
    const r = dnd.roll;
    if (r.type === "attack" && typeof r.success === "boolean") return { type: "attack", success: r.success };
    if (r.type === "save" && typeof r.success === "boolean") return { type: "save", success: r.success };
    if (r.type === "ability" && typeof r.success === "boolean") return { type: "check", success: r.success };
    if (r.type === "skill" && typeof r.success === "boolean") return { type: "check", success: r.success };
    if (r.type === "death" && typeof r.success === "boolean") return { type: "death", success: r.success };
  }

  return null;
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

// ── Universal capture: every chat message with rolls ─────────────────────────

Hooks.on("createChatMessage", (message) => {
  if (!game.user.isGM) return;
  if (!message.rolls?.length) return;

  const actor = getActorFromMessage(message);
  if (!actor) return;

  // Capture all dice from all rolls in the message
  const combinedFaces = {};
  for (const roll of message.rolls) {
    const faces = extractAllDice(roll);
    for (const [k, v] of Object.entries(faces)) {
      if (!combinedFaces[k]) combinedFaces[k] = [];
      combinedFaces[k].push(...v);
    }
  }
  if (Object.keys(combinedFaces).length) {
    recordDice(actor.id, actor.name, combinedFaces);
  }

  // Determine success/failure if applicable
  const outcome = determineOutcome(message);
  if (outcome) {
    recordOutcome(actor.id, actor.name, outcome.type, outcome.success);
  }
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
