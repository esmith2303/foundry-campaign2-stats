import { StatsCollector } from "./StatsCollector.mjs";
import { StatsUploader } from "./StatsUploader.mjs";
import { registerSettings } from "./settings.mjs";

const MODULE_ID = "dnd-group-campaign-2-stats";

// ── Dice roll tracker ────────────────────────────────────────────────────────
// midi-qol doesn't track per-face d20 distribution. We do it ourselves.

function extractD20(roll) {
  if (!roll) return null;
  for (const term of roll.terms || []) {
    if (term.faces === 20 && term.results?.length) {
      const result = term.results[0];
      // Only count "active" results — i.e. the kept die when rolling with adv/dis
      if (result && (result.active === undefined || result.active)) {
        return result.result;
      }
    }
  }
  return null;
}

async function recordD20(actorId, actorName, face) {
  if (!game.user.isGM || !actorId || !face) return;
  try {
    const rolls = game.settings.get(MODULE_ID, "diceRolls") || {};
    if (!rolls[actorId]) rolls[actorId] = { name: actorName, faces: {} };
    rolls[actorId].name = actorName;
    rolls[actorId].faces[face] = (rolls[actorId].faces[face] || 0) + 1;
    await game.settings.set(MODULE_ID, "diceRolls", rolls);
  } catch (e) {
    console.warn(`${MODULE_ID} | Failed to record d20:`, e);
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
  console.log(`${MODULE_ID} | Ready`);
});

// ── Dice roll capture hooks ──────────────────────────────────────────────────
// Capture d20 face values from various roll types

Hooks.on("midi-qol.AttackRollComplete", (workflow) => {
  if (!game.user.isGM) return;
  const face = extractD20(workflow.attackRoll);
  if (face) recordD20(workflow.actor?.id, workflow.actor?.name, face);
});

Hooks.on("dnd5e.rollSavingThrow", (actor, roll) => {
  const face = extractD20(roll);
  if (face) recordD20(actor?.id, actor?.name, face);
});

Hooks.on("dnd5e.rollAbilityTest", (actor, roll) => {
  const face = extractD20(roll);
  if (face) recordD20(actor?.id, actor?.name, face);
});

Hooks.on("dnd5e.rollSkill", (actor, roll) => {
  const face = extractD20(roll);
  if (face) recordD20(actor?.id, actor?.name, face);
});

Hooks.on("dnd5e.rollDeathSave", (actor, roll) => {
  const face = extractD20(roll);
  if (face) recordD20(actor?.id, actor?.name, face);
});

// Fallback for v4+ dnd5e — newer hooks use rollAttackV2 etc.
Hooks.on("dnd5e.rollAttackV2", (rolls, data) => {
  if (!rolls?.length) return;
  const actor = data?.subject?.actor || data?.actor;
  const face = extractD20(rolls[0]);
  if (face) recordD20(actor?.id, actor?.name, face);
});

Hooks.on("dnd5e.rollSavingThrowV2", (rolls, data) => {
  if (!rolls?.length) return;
  const actor = data?.subject || data?.actor;
  const face = extractD20(rolls[0]);
  if (face) recordD20(actor?.id, actor?.name, face);
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
    const midiActive = game.modules.get("midi-qol")?.active;
    const now = new Date().toLocaleString();
    const actorCount = collector.pendingCount;
    const diceCount = Object.keys(game.settings.get(MODULE_ID, "diceRolls") || {}).length;

    new Dialog({
      title: "Upload Midi-QOL Stats",
      content: `
        <div class="stats-uploader-dialog">
          <p>Upload session stats for <strong>${actorCount}</strong> actor(s) and reset session counters.</p>
          <p><strong>Time:</strong> ${now}</p>
          <p><strong>Endpoint:</strong> <code>${apiUrl}</code></p>
          <p><strong>Dice tracked:</strong> ${diceCount} actor(s)</p>
          ${actorCount === 0 ? '<p style="color:orange">⚠ No stats yet — make some rolls first.</p>' : ""}
          ${apiUrl === "(not configured)" ? '<p style="color:orange">⚠ No API URL set in Module Settings.</p>' : ""}
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
