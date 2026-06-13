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

async function recordHealEvent(actorId, actorName) {
  if (!game.user.isGM || !actorId) return;
  log(`record heal event ${actorName}`);
  try {
    const rolls = game.settings.get(MODULE_ID, "diceRolls") || {};
    if (!rolls[actorId]) rolls[actorId] = { name: actorName, dice: {}, outcomes: {} };
    rolls[actorId].name = actorName;
    rolls[actorId].healCount = (rolls[actorId].healCount || 0) + 1;
    await game.settings.set(MODULE_ID, "diceRolls", rolls);
  } catch (e) { console.warn(`${MODULE_ID} | Failed to record heal:`, e); }
}

function isHealWorkflow(workflow) {
  // midi-qol parses damage into a list with types
  if (Array.isArray(workflow.damageList)) {
    for (const d of workflow.damageList) {
      if (d?.type === "healing" || d?.type === "temphp") return true;
    }
  }
  // Some versions expose applicableDamageTypes
  if (Array.isArray(workflow.applicableDamageTypes)) {
    if (workflow.applicableDamageTypes.some(t => t === "healing" || t === "temphp")) return true;
  }
  // Check each damage roll's options/flavor
  const damageRolls = workflow.damageRolls ?? (workflow.damageRoll ? [workflow.damageRoll] : []);
  for (const dr of damageRolls) {
    if (dr?.options?.type === "healing" || dr?.options?.type === "temphp") return true;
    for (const term of dr?.terms || []) {
      const flavor = (term.flavor || term.options?.flavor || "").toLowerCase();
      if (flavor.includes("heal")) return true;
    }
  }
  return false;
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

// Tracks message IDs we've already recorded an outcome for
const outcomeRecordedForMessage = new Set();

function tryRecordAttackOutcomeFromMessage(message, actor) {
  if (outcomeRecordedForMessage.has(message.id)) return false;

  const dnd = message.flags?.dnd5e;
  const midi = message.flags?.["midi-qol"];

  // Is this an attack roll message?
  const isAttack = dnd?.activity?.type === "attack"
    || dnd?.roll?.type === "attack"
    || midi?.roll === "attackRoll"
    || midi?.type === "attackRoll";
  if (!isAttack) return false;

  // Find the d20
  const roll = message.rolls?.[0];
  if (!roll) return false;
  let d20 = null;
  for (const term of roll.terms || []) {
    if (term.faces === 20 && term.results?.length) {
      const active = term.results.find(r => r.active !== false);
      if (active) { d20 = active.result; break; }
    }
  }

  // Determine hit/miss
  let hit = null;
  if (d20 === 20) hit = true;
  else if (d20 === 1) hit = false;
  else if (typeof midi?.isHit === "boolean") hit = midi.isHit;
  else {
    // Use target AC from dnd5e flags
    const targets = dnd?.targets || [];
    if (targets.length && typeof roll.total === "number") {
      const ac = targets[0]?.ac;
      if (typeof ac === "number") hit = roll.total >= ac;
    }
  }

  if (hit !== null) {
    recordOutcome(actor.id, actor.name, "attack", hit, "msg:attack");
    outcomeRecordedForMessage.add(message.id);
    return true;
  }
  return false;
}

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

  // Record attack outcomes from the message itself (works even if midi-qol hooks were suppressed)
  tryRecordAttackOutcomeFromMessage(message, actor);

  // Record non-attack outcomes (saves, checks, death)
  tryRecordNonAttackOutcome(message, actor);
});

// ── updateChatMessage: catch outcomes added by midi-qol AFTER creation ───────

Hooks.on("updateChatMessage", (message) => {
  if (!game.user.isGM) return;
  const actor = getActorFromMessage(message);
  if (!actor) return;
  tryRecordAttackOutcomeFromMessage(message, actor);
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

  // Check if the chat-hook path already recorded this attack
  const msgIds = [workflow.itemCardId, workflow.chatCardId].filter(Boolean);
  const alreadyRecorded = msgIds.some(id => outcomeRecordedForMessage.has(id));
  if (alreadyRecorded) {
    workflow._statsOutcomeRecorded = true;
    log("attack outcome already recorded via chat hook, skipping");
    return;
  }

  const hit = determineHit(workflow);
  if (hit !== null && !workflow._statsOutcomeRecorded) {
    recordOutcome(workflow.actor.id, workflow.actor.name, "attack", hit, "AttackRollComplete-AC");
    workflow._statsOutcomeRecorded = true;
    msgIds.forEach(id => outcomeRecordedForMessage.add(id));
  } else if (hit === null) {
    log("could not determine hit/miss — no target AC available");
  }
});

Hooks.on("midi-qol.DamageRollComplete", (workflow) => {
  if (!game.user.isGM || !workflow?.actor) return;
  log("midi-qol.DamageRollComplete fired");
  const dr = workflow.damageRolls ?? (workflow.damageRoll ? [workflow.damageRoll] : []);
  for (const r of dr) captureFromRoll(workflow.actor, r, "midi.DamageRollComplete");

  // Detect heal events
  if (isHealWorkflow(workflow)) {
    recordHealEvent(workflow.actor.id, workflow.actor.name);
  }

  // Also capture the d20 from attackRoll here, in case AttackRollComplete was suppressed
  if (workflow.attackRoll) captureFromRoll(workflow.actor, workflow.attackRoll, "midi.DamageRollComplete(attack)");

  // Determine hit/miss — works whether or not AttackRollComplete already ran
  if (workflow.attackRoll && !workflow._statsOutcomeRecorded) {
    // Check if chat-hook path already recorded this attack
    const msgIds = [workflow.itemCardId, workflow.chatCardId].filter(Boolean);
    const alreadyRecorded = msgIds.some(id => outcomeRecordedForMessage.has(id));
    if (alreadyRecorded) {
      workflow._statsOutcomeRecorded = true;
      log("attack outcome already recorded via chat hook, skipping in DamageRollComplete");
      return;
    }
    const hit = determineHit(workflow);
    if (hit !== null) {
      recordOutcome(workflow.actor.id, workflow.actor.name, "attack", hit, "DamageRollComplete-AC");
    } else {
      recordOutcome(workflow.actor.id, workflow.actor.name, "attack", true, "DamageRollComplete-fallback");
    }
    workflow._statsOutcomeRecorded = true;
    msgIds.forEach(id => outcomeRecordedForMessage.add(id));
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
  tokenControls.tools["midi-qol-skills"] = {
    name: "midi-qol-skills",
    title: "Character Skill Sheet",
    icon: "fas fa-scroll",
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

  // ── Skills sheet button ────────────────────────────────────────────────
  const skillsBtn = document.querySelector('[data-tool="midi-qol-skills"]');
  if (skillsBtn) {
    const newSkillsBtn = skillsBtn.cloneNode(true);
    skillsBtn.parentNode.replaceChild(newSkillsBtn, skillsBtn);
    newSkillsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showSkillsSheet();
    });
  }
});

function showSkillsSheet() {
  // Remove existing overlay if open
  document.getElementById("midi-skills-overlay")?.remove();

  const characters = game.actors.contents
    .filter(a => a.hasPlayerOwner && (a.type === "character" || a.type === "npc"))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!characters.length) {
    ui.notifications.warn("No player-owned characters found.");
    return;
  }

  const skillConfig = CONFIG.DND5E?.skills || {};
  const skillKeys = Object.keys(skillConfig).sort((a, b) =>
    (skillConfig[a].label || a).localeCompare(skillConfig[b].label || b)
  );

  if (!skillKeys.length) {
    ui.notifications.warn("No skills configured in dnd5e.");
    return;
  }

  // Build rows
  const headerRow = `<tr><th class="skill-col">Skill</th>${characters.map(c =>
    `<th>${c.name.split(" ")[0]}</th>`).join("")}</tr>`;

  const bodyRows = skillKeys.map(skillKey => {
    const info = skillConfig[skillKey];
    const label = info.label || skillKey;
    const ability = (info.ability || "").toUpperCase();
    const cells = characters.map(char => {
      const skill = char.system?.skills?.[skillKey];
      if (!skill) return `<td class="skill-value muted">—</td>`;
      const total = skill.total ?? 0;
      const sign = total >= 0 ? "+" : "";
      const prof = skill.value ?? (skill.proficient ? 1 : 0);
      let marker = "";
      if (prof >= 2)        marker = `<span class="prof expert" title="Expertise">★★</span>`;
      else if (prof >= 1)   marker = `<span class="prof" title="Proficient">★</span>`;
      else if (prof >= 0.5) marker = `<span class="prof half" title="Half">☆</span>`;
      return `<td class="skill-value${prof >= 1 ? " proficient" : ""}">${sign}${total}${marker ? " " + marker : ""}</td>`;
    }).join("");
    return `<tr><td class="skill-name">${label}<span class="ability">${ability}</span></td>${cells}</tr>`;
  }).join("");

  const overlay = document.createElement("div");
  overlay.id = "midi-skills-overlay";
  overlay.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;900&family=Crimson+Text:wght@400;700&family=JetBrains+Mono:wght@400;700&display=swap');

      #midi-skills-overlay {
        --bg:#0a0a0f;--bg2:#12121a;--bg3:#1a1a28;--bg4:#22223a;
        --gold:#c9a84c;--gold-dim:#8a6d2b;--gold-bright:#e8c65a;
        --text:#d4d0c8;--text-dim:#7a7770;--text-bright:#f0ece4;
        --border:#2a2a3a;
        --font-display:'Cinzel',serif;--font-body:'Crimson Text',serif;--font-mono:'JetBrains Mono',monospace;
        position:fixed; inset:0;
        background:rgba(0,0,0,.75); backdrop-filter:blur(2px);
        z-index:100000;
        display:flex; align-items:center; justify-content:center;
        font-family:var(--font-body);
        color:var(--text);
      }
      #midi-skills-overlay .modal {
        background:var(--bg); border:1px solid var(--gold-dim); border-radius:4px;
        padding:2rem 2.2rem;
        max-width:95vw; max-height:90vh;
        display:flex; flex-direction:column;
        box-shadow:0 0 80px rgba(201,168,76,.08);
      }
      #midi-skills-overlay h2 {
        font-family:var(--font-display); font-weight:900;
        font-size:1.4rem; color:var(--gold);
        letter-spacing:.12em; text-transform:uppercase;
        text-align:center; margin:0 0 .3rem 0;
        text-shadow:0 0 30px rgba(201,168,76,.2);
      }
      #midi-skills-overlay .subtitle {
        font-family:var(--font-body); font-style:italic;
        color:var(--text-dim); font-size:.9rem; text-align:center;
        margin-bottom:1.5rem;
      }
      #midi-skills-overlay .skills-wrap {
        overflow:auto; max-height:65vh; border:1px solid var(--border);
        border-radius:2px; background:var(--bg2);
      }
      #midi-skills-overlay table {
        border-collapse:collapse; width:100%; font-size:.85rem;
      }
      #midi-skills-overlay th, #midi-skills-overlay td {
        padding:.55rem .9rem; border-bottom:1px solid var(--border);
        text-align:center;
      }
      #midi-skills-overlay th {
        background:var(--bg3); color:var(--gold);
        font-family:var(--font-display); font-weight:600;
        font-size:.7rem; letter-spacing:.1em; text-transform:uppercase;
        position:sticky; top:0; z-index:1;
        border-bottom:2px solid var(--gold-dim);
      }
      #midi-skills-overlay th.skill-col { text-align:left; }
      #midi-skills-overlay td.skill-name {
        text-align:left; white-space:nowrap;
        color:var(--text-bright); font-family:var(--font-body);
        font-size:.95rem;
      }
      #midi-skills-overlay td.skill-name .ability {
        color:var(--text-dim); font-family:var(--font-mono);
        font-size:.65rem; margin-left:.5rem; letter-spacing:.05em;
      }
      #midi-skills-overlay td.skill-value {
        font-family:var(--font-mono); font-weight:600;
        color:var(--text);
      }
      #midi-skills-overlay td.skill-value.muted {
        color:var(--text-dim); font-weight:400;
      }
      #midi-skills-overlay td.skill-value.proficient {
        color:var(--gold-bright);
      }
      #midi-skills-overlay tbody tr:hover td {
        background:rgba(201,168,76,.04);
      }
      #midi-skills-overlay .prof {
        color:var(--gold); margin-left:3px; font-size:.85rem;
      }
      #midi-skills-overlay .prof.expert { color:var(--gold-bright); }
      #midi-skills-overlay .prof.half    { color:var(--text-dim); }
      #midi-skills-overlay .legend {
        margin-top:1rem; padding-top:.8rem;
        border-top:1px solid var(--border);
        color:var(--text-dim); font-size:.75rem;
        text-align:center; letter-spacing:.05em;
        font-family:var(--font-mono);
      }
      #midi-skills-overlay .legend .prof { display:inline; margin:0 .2rem 0 0; }
      #midi-skills-overlay .close-row {
        text-align:center; margin-top:1.2rem;
      }
      #midi-skills-overlay button.close {
        background:var(--bg3); border:1px solid var(--gold-dim);
        color:var(--gold);
        font-family:var(--font-display); font-size:.7rem;
        letter-spacing:.1em; text-transform:uppercase;
        padding:.5rem 1.6rem; border-radius:2px; cursor:pointer;
        transition:all .2s;
      }
      #midi-skills-overlay button.close:hover {
        background:var(--bg4); border-color:var(--gold);
        color:var(--gold-bright);
      }
    </style>
    <div class="modal">
      <h2>Character Skill Sheet</h2>
      <p class="subtitle">Proficiencies marked with a star</p>
      <div class="skills-wrap">
        <table>
          <thead>${headerRow}</thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
      <div class="legend">
        <span class="prof">★</span> Proficient &nbsp;&nbsp;
        <span class="prof expert">★★</span> Expertise &nbsp;&nbsp;
        <span class="prof half">☆</span> Half-Proficient
      </div>
      <div class="close-row"><button class="close">Close</button></div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };

  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("button.close").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
}
