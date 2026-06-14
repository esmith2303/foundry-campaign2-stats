// SkillCheck.mjs — GM tool: pick a skill in the popover → opens a check-config
// dialog → posts a chat card with per-player dice buttons → players click to roll
// → results stream back, with blind DC / blind roll / group check rules respected.

const MODULE_ID = "dnd-group-campaign-2-stats";
const SOCKET = `module.${MODULE_ID}`;

// ─────────────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────────────

export function registerSkillCheck() {
  // Socket bridge so non-GM clients can ask the GM to mutate the chat card
  game.socket.on(SOCKET, onSocket);
  // Bind roll buttons every time a chat card renders for the local user
  Hooks.on("renderChatMessage", onRenderChatMessage);
}

/** Called from the popover when GM clicks a skill name. */
export function openSkillCheckDialog(skillKey) {
  if (!game.user.isGM) return;
  const skillConfig = CONFIG.DND5E?.skills?.[skillKey];
  if (!skillConfig) return ui.notifications.warn("Unknown skill: " + skillKey);

  const characters = game.actors.contents
    .filter(a => a.hasPlayerOwner && (a.type === "character" || a.type === "npc"))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!characters.length) return ui.notifications.warn("No player-owned characters found.");

  buildDialog(skillKey, skillConfig.label || skillKey, skillConfig.ability || "", characters);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialog
// ─────────────────────────────────────────────────────────────────────────────

function buildDialog(skillKey, skillLabel, ability, characters) {
  // Close any existing
  document.getElementById("skill-check-dialog")?.remove();

  const dialog = document.createElement("div");
  dialog.id = "skill-check-dialog";
  dialog.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;900&family=Crimson+Text:wght@400;700&family=JetBrains+Mono:wght@400;700&display=swap');

      #skill-check-overlay {
        position:fixed; inset:0; background:rgba(0,0,0,.55);
        z-index:99999; display:flex; align-items:center; justify-content:center;
        opacity:0; transition:opacity .15s ease;
      }
      #skill-check-overlay.shown { opacity:1; }
      #skill-check-dialog {
        --bg:#0a0a0f;--bg2:#12121a;--bg3:#1a1a28;--bg4:#22223a;
        --gold:#c9a84c;--gold-dim:#8a6d2b;--gold-bright:#e8c65a;
        --text:#d4d0c8;--text-dim:#7a7770;--text-bright:#f0ece4;
        --border:#2a2a3a;--red:#c44e4e;--green:#5fa85f;
        --font-display:'Cinzel',serif;--font-body:'Crimson Text',serif;--font-mono:'JetBrains Mono',monospace;
        background:var(--bg);
        color:var(--text);
        font-family:var(--font-body);
        border:1px solid var(--gold-dim);
        border-radius:4px;
        padding:1.1rem 1.2rem 1rem 1.2rem;
        box-shadow:0 10px 40px rgba(0,0,0,.7), 0 0 30px rgba(201,168,76,.1);
        min-width:380px; max-width:520px; max-height:90vh;
        overflow:auto;
      }
      #skill-check-dialog .title {
        font-family:var(--font-display); font-weight:600;
        font-size:1rem; color:var(--gold);
        letter-spacing:.12em; text-transform:uppercase;
        text-align:center;
        margin:0 0 .8rem 0; padding-bottom:.6rem;
        border-bottom:1px solid var(--gold-dim);
      }
      #skill-check-dialog .field { margin:.55rem 0; }
      #skill-check-dialog .field-label {
        font-family:var(--font-display); font-size:.65rem;
        letter-spacing:.1em; text-transform:uppercase;
        color:var(--gold); margin-bottom:.25rem;
      }
      #skill-check-dialog .dc-row {
        display:flex; align-items:center; gap:.5rem;
      }
      #skill-check-dialog .num-input {
        display:inline-flex; align-items:center;
        background:var(--bg2); border:1px solid var(--border);
        border-radius:3px; overflow:hidden;
      }
      #skill-check-dialog .num-input button {
        background:var(--bg3); color:var(--gold);
        border:none; width:1.8rem; height:1.8rem;
        font-family:var(--font-mono); font-weight:700;
        font-size:1rem; cursor:pointer;
        transition:background .1s;
      }
      #skill-check-dialog .num-input button:hover { background:var(--bg4); color:var(--gold-bright); }
      #skill-check-dialog .num-input input {
        background:transparent; color:var(--text-bright);
        border:none; outline:none;
        width:3.5rem; text-align:center;
        font-family:var(--font-mono); font-weight:600; font-size:.9rem;
        padding:0;
      }
      #skill-check-dialog .num-input input::-webkit-outer-spin-button,
      #skill-check-dialog .num-input input::-webkit-inner-spin-button {
        -webkit-appearance:none; margin:0;
      }
      #skill-check-dialog .players { margin:.5rem 0; }
      #skill-check-dialog .player-row {
        display:flex; align-items:center; gap:.5rem;
        padding:.35rem .45rem;
        margin:.2rem 0;
        background:var(--bg2);
        border:1px solid var(--border);
        border-radius:3px;
      }
      #skill-check-dialog .player-row label {
        flex:1; display:flex; align-items:center; gap:.5rem;
        cursor:pointer; color:var(--text-bright);
        font-size:.85rem;
      }
      #skill-check-dialog .player-row input[type=checkbox] {
        accent-color:var(--gold);
        width:.95rem; height:.95rem;
        cursor:pointer;
      }
      #skill-check-dialog .mode-toggle {
        display:inline-flex; border:1px solid var(--border); border-radius:3px; overflow:hidden;
      }
      #skill-check-dialog .mode-toggle button {
        background:var(--bg3); color:var(--text-dim);
        border:none; padding:.25rem .55rem;
        font-family:var(--font-mono); font-size:.65rem;
        cursor:pointer; letter-spacing:.05em;
        transition:background .1s, color .1s;
        text-transform:uppercase;
      }
      #skill-check-dialog .mode-toggle button.active {
        background:var(--gold-dim); color:var(--bg);
        font-weight:700;
      }
      #skill-check-dialog .mode-toggle button:hover:not(.active) {
        background:var(--bg4); color:var(--gold);
      }
      #skill-check-dialog .checkbox-row {
        display:flex; gap:1.2rem; margin:.6rem 0 .2rem 0;
        padding:.45rem .5rem;
        background:var(--bg2); border:1px solid var(--border); border-radius:3px;
      }
      #skill-check-dialog .checkbox-row label {
        display:flex; align-items:center; gap:.45rem;
        font-size:.8rem; color:var(--text-bright);
        cursor:pointer;
      }
      #skill-check-dialog .checkbox-row input[type=checkbox] {
        accent-color:var(--gold);
        width:.95rem; height:.95rem;
        cursor:pointer;
      }
      #skill-check-dialog .group-row {
        display:flex; align-items:center; gap:.7rem;
        padding:.45rem .5rem;
        background:var(--bg2); border:1px solid var(--border); border-radius:3px;
        margin:.4rem 0;
      }
      #skill-check-dialog .group-row label {
        display:flex; align-items:center; gap:.45rem;
        font-size:.8rem; color:var(--text-bright);
        cursor:pointer;
      }
      #skill-check-dialog .group-row input[type=checkbox] {
        accent-color:var(--gold);
        width:.95rem; height:.95rem;
        cursor:pointer;
      }
      #skill-check-dialog .group-threshold {
        display:flex; align-items:center; gap:.5rem;
        margin-left:auto;
        opacity:.4; pointer-events:none;
        transition:opacity .15s;
      }
      #skill-check-dialog .group-threshold.enabled { opacity:1; pointer-events:auto; }
      #skill-check-dialog .group-threshold-label {
        font-size:.7rem; color:var(--text-dim);
        font-family:var(--font-mono); letter-spacing:.05em;
      }
      #skill-check-dialog .actions {
        display:flex; gap:.5rem; justify-content:flex-end;
        margin-top:.9rem; padding-top:.6rem;
        border-top:1px solid var(--border);
      }
      #skill-check-dialog .btn {
        padding:.4rem 1rem;
        font-family:var(--font-display); font-size:.7rem;
        letter-spacing:.1em; text-transform:uppercase;
        background:var(--bg3); color:var(--text);
        border:1px solid var(--border); border-radius:3px;
        cursor:pointer;
        transition:background .1s, color .1s, border-color .1s;
      }
      #skill-check-dialog .btn:hover { background:var(--bg4); color:var(--gold); }
      #skill-check-dialog .btn.primary {
        background:var(--gold-dim); color:var(--bg);
        border-color:var(--gold);
        font-weight:700;
      }
      #skill-check-dialog .btn.primary:hover { background:var(--gold); color:var(--bg); }
      #skill-check-dialog .btn.primary:disabled {
        background:var(--bg3); color:var(--text-dim);
        border-color:var(--border);
        cursor:not-allowed;
      }
    </style>
    <div class="title">${escapeHtml(skillLabel)} Check${ability ? ` (${ability.toUpperCase()})` : ""}</div>

    <div class="field">
      <div class="field-label">Difficulty Class</div>
      <div class="dc-row">
        <div class="num-input">
          <button type="button" data-step="-1">−</button>
          <input id="sc-dc" type="number" value="10" min="1" max="40">
          <button type="button" data-step="1">+</button>
        </div>
      </div>
    </div>

    <div class="field">
      <div class="field-label">Players</div>
      <div class="players">
        ${characters.map(c => `
          <div class="player-row" data-actor-id="${c.id}">
            <label>
              <input type="checkbox" class="sc-player-checkbox" data-actor-id="${c.id}" checked>
              <span>${escapeHtml(c.name)}</span>
            </label>
            <div class="mode-toggle" data-actor-id="${c.id}">
              <button type="button" data-mode="adv">Adv</button>
              <button type="button" data-mode="nor" class="active">Nor</button>
              <button type="button" data-mode="dis">Dis</button>
            </div>
          </div>
        `).join("")}
      </div>
    </div>

    <div class="checkbox-row">
      <label><input type="checkbox" id="sc-blind-dc"> Blind DC</label>
      <label><input type="checkbox" id="sc-blind-roll"> Blind Rolls</label>
    </div>

    <div class="group-row">
      <label><input type="checkbox" id="sc-group"> Group check</label>
      <div class="group-threshold" id="sc-threshold-wrap">
        <span class="group-threshold-label">Threshold</span>
        <div class="num-input">
          <button type="button" data-step="-1" data-target="threshold">−</button>
          <input id="sc-threshold" type="number" value="3" min="1">
          <button type="button" data-step="1" data-target="threshold">+</button>
        </div>
      </div>
    </div>

    <div class="actions">
      <button type="button" class="btn" id="sc-cancel">Cancel</button>
      <button type="button" class="btn primary" id="sc-submit">Roll Check</button>
    </div>
  `;

  const overlay = document.createElement("div");
  overlay.id = "skill-check-overlay";
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("shown"));

  // ── Wire up controls ───────────────────────────────────────────────────
  const dcInput = dialog.querySelector("#sc-dc");
  const thrInput = dialog.querySelector("#sc-threshold");
  const thrWrap = dialog.querySelector("#sc-threshold-wrap");
  const groupCb = dialog.querySelector("#sc-group");
  const blindDcCb = dialog.querySelector("#sc-blind-dc");
  const blindRollCb = dialog.querySelector("#sc-blind-roll");

  // Number steppers
  dialog.querySelectorAll(".num-input button").forEach(btn => {
    btn.addEventListener("click", () => {
      const step = Number(btn.dataset.step);
      const isThreshold = btn.dataset.target === "threshold";
      const input = isThreshold ? thrInput : dcInput;
      const min = Number(input.min) || 1;
      const max = Number(input.max) || 999;
      const val = Math.max(min, Math.min(max, (Number(input.value) || 0) + step));
      input.value = val;
    });
  });

  // Mode toggles per player
  dialog.querySelectorAll(".mode-toggle").forEach(toggle => {
    toggle.querySelectorAll("button").forEach(b => {
      b.addEventListener("click", () => {
        toggle.querySelectorAll("button").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
      });
    });
  });

  // Update threshold default + max when player selection changes
  const updateThresholdDefault = () => {
    const checked = dialog.querySelectorAll(".sc-player-checkbox:checked").length;
    thrInput.max = String(Math.max(1, checked));
    if (!thrInput._userTouched) {
      thrInput.value = String(Math.floor(checked / 2) + 1);
    } else {
      // Clamp existing value to new max
      const v = Number(thrInput.value);
      if (v > checked) thrInput.value = String(checked);
      if (v < 1) thrInput.value = "1";
    }
  };
  dialog.querySelectorAll(".sc-player-checkbox").forEach(cb => {
    cb.addEventListener("change", updateThresholdDefault);
  });
  thrInput.addEventListener("input", () => { thrInput._userTouched = true; });
  updateThresholdDefault();

  // Group check toggle
  groupCb.addEventListener("change", () => {
    thrWrap.classList.toggle("enabled", groupCb.checked);
  });

  // Cancel / submit
  const close = () => {
    overlay.classList.remove("shown");
    setTimeout(() => overlay.remove(), 200);
  };
  dialog.querySelector("#sc-cancel").addEventListener("click", close);

  dialog.querySelector("#sc-submit").addEventListener("click", async () => {
    // Collect player selections
    const players = [];
    for (const row of dialog.querySelectorAll(".player-row")) {
      const cb = row.querySelector(".sc-player-checkbox");
      if (!cb.checked) continue;
      const actorId = cb.dataset.actorId;
      const mode = row.querySelector(".mode-toggle button.active")?.dataset.mode || "nor";
      const actor = game.actors.get(actorId);
      if (!actor) continue;
      players.push({ actorId, actorName: actor.name, mode });
    }
    if (!players.length) {
      ui.notifications.warn("Select at least one player.");
      return;
    }
    const dc = Number(dcInput.value) || 10;
    const groupCheck = groupCb.checked;
    const threshold = Math.max(1, Math.min(players.length, Number(thrInput.value) || 1));

    close();

    await createSkillCheckMessage({
      skillKey,
      skillLabel,
      ability,
      dc,
      blindDC: blindDcCb.checked,
      blindRoll: blindRollCb.checked,
      groupCheck,
      threshold,
      players,
    });
  });

  // Click outside to close
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  // ESC to close
  const onKey = (e) => {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
  };
  document.addEventListener("keydown", onKey);
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat message
// ─────────────────────────────────────────────────────────────────────────────

async function createSkillCheckMessage(config) {
  // Each player starts unrolled
  const state = {
    ...config,
    rolls: {}, // actorId -> { total, formula, success }
    createdBy: game.user.id,
  };
  const content = renderCheckContent(state);

  await ChatMessage.create({
    speaker: { alias: "Skill Check" },
    content,
    flags: { [MODULE_ID]: { skillCheck: state } },
    // Visible to all by default; per-row visibility is handled in renderChatMessage
  });
}

function renderCheckContent(state) {
  const dcDisplay = state.blindDC
    ? `<span class="dc gm-only">DC ${state.dc}</span><span class="dc dc-hidden non-gm-only">DC ??</span>`
    : `<span class="dc">DC ${state.dc}</span>`;

  const rows = state.players.map(p => {
    const r = state.rolls[p.actorId];
    const modeTag = p.mode === "adv" ? `<span class="mode-tag adv">ADV</span>`
                  : p.mode === "dis" ? `<span class="mode-tag dis">DIS</span>`
                  : "";

    if (!r) {
      // Not rolled yet — show clickable dice
      return `
        <div class="player-row" data-actor-id="${p.actorId}">
          <button class="roll-btn" data-actor-id="${p.actorId}" data-mode="${p.mode}" title="Roll for ${escapeHtml(p.actorName)}">
            <i class="fas fa-dice-d20"></i>
          </button>
          <span class="player-name">${escapeHtml(p.actorName)}</span>
          ${modeTag}
          <span class="result pending">…</span>
        </div>`;
    }

    // Rolled — show result respecting blind settings
    const totalHtml = state.blindRoll
      ? `<span class="result gm-only">${r.total}</span><span class="result rolled-hidden non-gm-only">rolled</span>`
      : `<span class="result">${r.total}</span>`;

    const successHtml = (state.blindDC || state.blindRoll)
      ? `<span class="status gm-only">${r.success ? "✓" : "✗"}</span>`
      : `<span class="status ${r.success ? "success" : "failure"}">${r.success ? "✓" : "✗"}</span>`;

    return `
      <div class="player-row rolled" data-actor-id="${p.actorId}">
        <span class="rolled-icon"><i class="fas fa-dice-d20"></i></span>
        <span class="player-name">${escapeHtml(p.actorName)}</span>
        ${modeTag}
        ${totalHtml}
        ${successHtml}
      </div>`;
  }).join("");

  // Group summary (if applicable)
  let groupHtml = "";
  if (state.groupCheck) {
    const rolledIds = Object.keys(state.rolls);
    const allRolled = rolledIds.length === state.players.length;
    const successCount = state.players.filter(p => state.rolls[p.actorId]?.success).length;
    const groupPassed = successCount >= state.threshold;

    if (allRolled) {
      const visibleClass = (state.blindDC || state.blindRoll) ? "gm-only" : "";
      groupHtml = `
        <div class="group-summary ${visibleClass}">
          Group: ${successCount}/${state.players.length} succeeded (threshold ${state.threshold})
          <span class="group-result ${groupPassed ? "success" : "failure"}">${groupPassed ? "✓ PASSED" : "✗ FAILED"}</span>
        </div>`;
    } else {
      groupHtml = `<div class="group-summary muted">Group check — threshold ${state.threshold} of ${state.players.length} (${rolledIds.length}/${state.players.length} rolled)</div>`;
    }
  }

  return `
    <div class="skill-check-card">
      <style>
        .skill-check-card {
          --gold:#c9a84c; --gold-bright:#e8c65a;
          --green:#5fa85f; --red:#c44e4e;
          --bg-soft:rgba(20,20,30,.4);
          font-family:'Crimson Text',serif;
        }
        .skill-check-card .check-header {
          display:flex; justify-content:space-between; align-items:center;
          font-family:'Cinzel',serif; font-weight:600;
          font-size:.95rem; color:var(--gold);
          letter-spacing:.06em; text-transform:uppercase;
          padding-bottom:.4rem; border-bottom:1px solid rgba(201,168,76,.3);
          margin-bottom:.5rem;
        }
        .skill-check-card .dc { font-family:'JetBrains Mono',monospace; font-size:.8rem; }
        .skill-check-card .dc.dc-hidden { color:rgba(201,168,76,.6); }
        .skill-check-card .player-row {
          display:flex; align-items:center; gap:.5rem;
          padding:.3rem .4rem; margin:.15rem 0;
          background:var(--bg-soft); border-radius:3px;
          font-size:.85rem;
        }
        .skill-check-card .roll-btn {
          background:transparent; border:1px solid rgba(201,168,76,.5);
          color:var(--gold-bright); cursor:pointer;
          width:1.9rem; height:1.9rem; padding:0;
          border-radius:3px; font-size:.85rem;
          transition:background .1s, color .1s, transform .1s;
        }
        .skill-check-card .roll-btn:hover {
          background:rgba(201,168,76,.15); transform:scale(1.05);
        }
        .skill-check-card .roll-btn:disabled {
          opacity:.3; cursor:not-allowed; transform:none;
        }
        .skill-check-card .rolled-icon {
          width:1.9rem; height:1.9rem; display:flex; align-items:center; justify-content:center;
          color:rgba(201,168,76,.4); font-size:.85rem;
        }
        .skill-check-card .player-name { flex:1; font-weight:600; }
        .skill-check-card .mode-tag {
          font-family:'JetBrains Mono',monospace; font-size:.6rem;
          padding:.1rem .3rem; border-radius:2px;
          background:rgba(201,168,76,.15); color:var(--gold);
          letter-spacing:.05em;
        }
        .skill-check-card .mode-tag.adv { background:rgba(95,168,95,.18); color:#7fc97f; }
        .skill-check-card .mode-tag.dis { background:rgba(196,78,78,.18); color:#e07878; }
        .skill-check-card .result {
          font-family:'JetBrains Mono',monospace; font-weight:700;
          min-width:1.8rem; text-align:right;
          color:#f0ece4;
        }
        .skill-check-card .result.pending { color:rgba(244,238,228,.3); }
        .skill-check-card .result.rolled-hidden { color:rgba(244,238,228,.4); font-style:italic; }
        .skill-check-card .status {
          font-family:'JetBrains Mono',monospace; font-weight:700;
          min-width:1rem; text-align:center;
        }
        .skill-check-card .status.success { color:var(--green); }
        .skill-check-card .status.failure { color:var(--red); }
        .skill-check-card .group-summary {
          margin-top:.5rem; padding-top:.4rem; border-top:1px solid rgba(201,168,76,.25);
          font-family:'JetBrains Mono',monospace; font-size:.75rem;
          color:#d4d0c8; text-align:center;
        }
        .skill-check-card .group-summary.muted { color:rgba(212,208,200,.5); }
        .skill-check-card .group-result { font-weight:700; margin-left:.5rem; }
        .skill-check-card .group-result.success { color:var(--green); }
        .skill-check-card .group-result.failure { color:var(--red); }
        .skill-check-card .gm-only { display:none; }
        .skill-check-card.is-gm .gm-only { display:inline-flex; align-items:center; }
        .skill-check-card.is-gm .non-gm-only { display:none; }
      </style>
      <div class="check-header">
        <span>${escapeHtml(state.skillLabel)}${state.ability ? ` (${state.ability.toUpperCase()})` : ""}</span>
        ${dcDisplay}
      </div>
      <div class="players">${rows}</div>
      ${groupHtml}
    </div>
  `;
}

function onRenderChatMessage(message, html, _data) {
  const state = message.flags?.[MODULE_ID]?.skillCheck;
  if (!state) return;

  const card = html[0]?.querySelector?.(".skill-check-card") || html.find(".skill-check-card")[0];
  if (!card) return;

  // Toggle GM-only visibility
  if (game.user.isGM) card.classList.add("is-gm");

  // Bind roll buttons
  for (const btn of card.querySelectorAll(".roll-btn")) {
    const actorId = btn.dataset.actorId;
    const mode = btn.dataset.mode;
    const actor = game.actors.get(actorId);

    // Disable for users who don't own this actor
    if (!actor || !actor.isOwner) {
      btn.disabled = true;
      btn.title = "Not your character";
      continue;
    }
    // Already rolled?
    if (state.rolls?.[actorId]) {
      btn.disabled = true;
      continue;
    }
    btn.addEventListener("click", () => onPlayerRollClick(message.id, actorId, mode));
  }
}

async function onPlayerRollClick(messageId, actorId, mode) {
  const message = game.messages.get(messageId);
  const state = message?.flags?.[MODULE_ID]?.skillCheck;
  if (!message || !state) return;

  const actor = game.actors.get(actorId);
  if (!actor?.isOwner) return ui.notifications.warn("Not your character.");
  if (state.rolls?.[actorId]) return; // already rolled

  // Build roll options. We suppress automatic chat output and post our own update.
  const rollOptions = {
    advantage: mode === "adv",
    disadvantage: mode === "dis",
    chatMessage: false,        // We post our own result via the card
    fastForward: true,         // Skip the default dnd5e dialog
    targetValue: state.dc,     // dnd5e records DC for success eval
  };

  // dnd5e API has shifted across versions. Try the new signature first, fall back.
  let roll;
  try {
    roll = await actor.rollSkill({ skill: state.skillKey, ...rollOptions });
  } catch (e1) {
    try {
      roll = await actor.rollSkill(state.skillKey, rollOptions);
    } catch (e2) {
      console.error(`${MODULE_ID} | rollSkill failed:`, e1, e2);
      ui.notifications.error("Skill roll failed — check console.");
      return;
    }
  }
  // rollSkill can return either a Roll or an array of Rolls depending on version
  if (Array.isArray(roll)) roll = roll[0];
  if (!roll) return;

  const total = roll.total;
  const formula = roll.formula || "";
  const success = total >= state.dc;

  // GM updates the message directly; players go through socket
  const payload = { messageId, actorId, total, formula, success };
  if (game.user.isGM) {
    await applyRollUpdate(payload);
  } else {
    game.socket.emit(SOCKET, { action: "skillCheckRoll", ...payload });
  }
}

function onSocket(data) {
  if (data?.action !== "skillCheckRoll") return;
  if (!game.user.isGM) return;
  // Only the active GM applies, to avoid duplicate updates with multi-GM tables
  const primary = game.users.find(u => u.isGM && u.active);
  if (primary && primary.id !== game.user.id) return;
  applyRollUpdate(data).catch(err => console.error(`${MODULE_ID} | applyRollUpdate:`, err));
}

async function applyRollUpdate({ messageId, actorId, total, formula, success }) {
  const message = game.messages.get(messageId);
  const state = message?.flags?.[MODULE_ID]?.skillCheck;
  if (!message || !state) return;
  if (state.rolls?.[actorId]) return; // dedupe

  const newRolls = { ...(state.rolls || {}), [actorId]: { total, formula, success } };
  const newState = { ...state, rolls: newRolls };
  const newContent = renderCheckContent(newState);

  await message.update({
    content: newContent,
    flags: { [MODULE_ID]: { skillCheck: newState } },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
