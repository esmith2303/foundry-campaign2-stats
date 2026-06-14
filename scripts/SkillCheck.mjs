// SkillCheck.mjs — GM tool: pick a skill in the popover → opens a check-config
// dialog → posts a chat card with per-player dice buttons → players click to roll
// → results stream back, with blind DC / blind roll / group check rules respected.

const MODULE_ID = "dnd-group-campaign-2-stats";
const SOCKET = `module.${MODULE_ID}`;

// ─────────────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────────────

export function registerSkillCheck() {
  // Inject module-level styles once (chat <style> tags are sanitized by Foundry)
  injectStylesOnce();
  // Socket bridge so non-GM clients can ask the GM to mutate the chat card
  game.socket.on(SOCKET, onSocket);
  // Bind roll buttons + apply blind visibility every time a chat card renders.
  // V13 replaces renderChatMessage with renderChatMessageHTML; register BOTH
  // so we work on V11/V12 (jQuery) and V13 (HTMLElement).
  Hooks.on("renderChatMessage", onRenderChatMessage);
  Hooks.on("renderChatMessageHTML", onRenderChatMessage);
  console.log(`${MODULE_ID} | SkillCheck registered for user ${game.user.name} (GM=${game.user.isGM})`);
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
// One-time CSS injection (works around Foundry stripping chat <style>)
// ─────────────────────────────────────────────────────────────────────────────

function injectStylesOnce() {
  if (document.getElementById("skill-check-styles")) return;
  const style = document.createElement("style");
  style.id = "skill-check-styles";
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;900&family=Crimson+Text:wght@400;700&family=JetBrains+Mono:wght@400;700&display=swap');

    /* ─── DIALOG ───────────────────────────────────────────────────────── */
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
      background:#0a0a0f;
      color:#d4d0c8;
      font-family:'Crimson Text',serif;
      border:1px solid #8a6d2b;
      border-radius:4px;
      padding:1.1rem 1.2rem 1rem 1.2rem;
      box-shadow:0 10px 40px rgba(0,0,0,.7), 0 0 30px rgba(201,168,76,.1);
      min-width:380px; max-width:520px; max-height:90vh;
      overflow:auto;
    }
    #skill-check-dialog .title {
      font-family:'Cinzel',serif; font-weight:600;
      font-size:1rem; color:#c9a84c;
      letter-spacing:.12em; text-transform:uppercase;
      text-align:center;
      margin:0 0 .8rem 0; padding-bottom:.6rem;
      border-bottom:1px solid #8a6d2b;
    }
    #skill-check-dialog .field { margin:.55rem 0; }
    #skill-check-dialog .field-label {
      font-family:'Cinzel',serif; font-size:.65rem;
      letter-spacing:.1em; text-transform:uppercase;
      color:#c9a84c; margin-bottom:.25rem;
    }

    /* Aggressive button reset to defeat any Foundry/dnd5e :hover/:focus borders */
    #skill-check-dialog button {
      border:1px solid transparent !important;
      outline:none !important;
      box-shadow:none !important;
      background-image:none !important;
      text-shadow:none !important;
    }
    #skill-check-dialog button:focus,
    #skill-check-dialog button:hover,
    #skill-check-dialog button:active,
    #skill-check-dialog button:focus-visible {
      border:1px solid transparent !important;
      outline:none !important;
      box-shadow:none !important;
    }
    #skill-check-dialog input[type=number] {
      outline:none !important; box-shadow:none !important;
      background:transparent !important;
      border:none !important;
    }

    #skill-check-dialog .num-input {
      display:inline-flex; align-items:center;
      background:#12121a; border:1px solid #2a2a3a !important;
      border-radius:3px; overflow:hidden;
    }
    #skill-check-dialog .num-input button {
      background:#1a1a28 !important; color:#c9a84c !important;
      width:1.9rem; height:1.9rem;
      font-family:'JetBrains Mono',monospace; font-weight:700;
      font-size:1rem; cursor:pointer;
      transition:background .1s, color .1s;
      padding:0;
      line-height:1;
      display:inline-flex; align-items:center; justify-content:center;
    }
    #skill-check-dialog .num-input button:hover {
      background:#22223a !important; color:#e8c65a !important;
    }
    #skill-check-dialog .num-input input {
      color:#f0ece4 !important;
      width:3.5rem; text-align:center;
      font-family:'JetBrains Mono',monospace; font-weight:600; font-size:.9rem;
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
      background:#12121a;
      border:1px solid #2a2a3a;
      border-radius:3px;
    }
    #skill-check-dialog .player-row label {
      flex:1; display:flex; align-items:center; gap:.5rem;
      cursor:pointer; color:#f0ece4;
      font-size:.85rem;
    }
    #skill-check-dialog input[type=checkbox] {
      accent-color:#c9a84c;
      width:.95rem; height:.95rem;
      cursor:pointer;
    }
    #skill-check-dialog .mode-toggle {
      display:inline-flex; border:1px solid #2a2a3a; border-radius:3px; overflow:hidden;
    }
    #skill-check-dialog .mode-toggle button {
      background:#1a1a28 !important; color:#7a7770 !important;
      padding:.25rem .55rem;
      font-family:'JetBrains Mono',monospace; font-size:.65rem;
      cursor:pointer; letter-spacing:.05em;
      transition:background .1s, color .1s;
      text-transform:uppercase;
    }
    #skill-check-dialog .mode-toggle button.active {
      background:#8a6d2b !important; color:#0a0a0f !important;
      font-weight:700;
    }
    #skill-check-dialog .mode-toggle button:hover:not(.active) {
      background:#22223a !important; color:#c9a84c !important;
    }
    #skill-check-dialog .checkbox-row {
      display:flex; gap:1.2rem; margin:.6rem 0 .2rem 0;
      padding:.45rem .5rem;
      background:#12121a; border:1px solid #2a2a3a; border-radius:3px;
    }
    #skill-check-dialog .checkbox-row label,
    #skill-check-dialog .group-row label {
      display:flex; align-items:center; gap:.45rem;
      font-size:.8rem; color:#f0ece4;
      cursor:pointer;
    }
    #skill-check-dialog .group-row {
      display:flex; align-items:center; gap:.7rem;
      padding:.45rem .5rem;
      background:#12121a; border:1px solid #2a2a3a; border-radius:3px;
      margin:.4rem 0;
    }
    #skill-check-dialog .group-threshold {
      display:flex; align-items:center; gap:.5rem;
      margin-left:auto;
      opacity:.4; pointer-events:none;
      transition:opacity .15s;
    }
    #skill-check-dialog .group-threshold.enabled { opacity:1; pointer-events:auto; }
    #skill-check-dialog .group-threshold-label {
      font-size:.7rem; color:#7a7770;
      font-family:'JetBrains Mono',monospace; letter-spacing:.05em;
    }
    #skill-check-dialog .actions {
      display:flex; gap:.5rem; justify-content:flex-end;
      margin-top:.9rem; padding-top:.6rem;
      border-top:1px solid #2a2a3a;
    }
    #skill-check-dialog .btn {
      padding:.4rem 1rem;
      font-family:'Cinzel',serif; font-size:.7rem;
      letter-spacing:.1em; text-transform:uppercase;
      background:#1a1a28 !important; color:#d4d0c8 !important;
      border:1px solid #2a2a3a !important; border-radius:3px;
      cursor:pointer;
      transition:background .1s, color .1s, border-color .1s;
    }
    #skill-check-dialog .btn:hover {
      background:#22223a !important; color:#c9a84c !important;
    }
    #skill-check-dialog .btn.primary {
      background:#8a6d2b !important; color:#0a0a0f !important;
      border-color:#c9a84c !important;
      font-weight:700;
    }
    #skill-check-dialog .btn.primary:hover {
      background:#c9a84c !important; color:#0a0a0f !important;
    }

    /* ─── CHAT CARD (matches dnd5e/midi-qol look) ──────────────────────── */
    .skill-check-card {
      font-family:"Signika",sans-serif;
      font-size:14px;
      line-height:1.35;
      background:#f0f0e0;
      border:1px solid #6f6c66;
      border-radius:3px;
      overflow:hidden;
      margin:.25em 0;
    }
    .skill-check-card .card-header {
      display:flex; align-items:center; gap:.5em;
      padding:.4em .6em;
      background:linear-gradient(to right, #4b4a44 0%, #2c2b27 100%);
      border-bottom:1px solid #2c2b27;
      color:#f0f0e0;
    }
    .skill-check-card .card-header .icon {
      width:30px; height:30px; flex:0 0 30px;
      border:1px solid #c9a84c;
      border-radius:3px;
      background:#1a1a1a;
      display:flex; align-items:center; justify-content:center;
      color:#c9a84c; font-size:.95em;
    }
    .skill-check-card .card-header .title-block { flex:1; line-height:1.15; }
    .skill-check-card .card-header .skill-name {
      font-weight:700; font-size:1.05em;
      color:#f0f0e0;
      letter-spacing:.02em;
    }
    .skill-check-card .card-header .ability-tag {
      font-size:.72em; opacity:.85;
      text-transform:uppercase; letter-spacing:.08em;
      color:#c9a84c;
    }
    .skill-check-card .card-header .dc-badge {
      flex:0 0 auto;
      padding:.18em .55em;
      background:#1a1a1a;
      border:1px solid #c9a84c;
      border-radius:3px;
      color:#e8c65a;
      font-size:.85em; font-weight:700;
      letter-spacing:.04em;
      font-family:"Signika",sans-serif;
    }
    .skill-check-card .card-content {
      padding:.4em .6em;
    }
    .skill-check-card .player-list {
      list-style:none; padding:0; margin:0;
    }
    .skill-check-card .player-row {
      display:flex; align-items:center; gap:.45em;
      padding:.32em .15em;
      border-bottom:1px solid #d8d6c8;
    }
    .skill-check-card .player-row:last-child { border-bottom:none; }
    .skill-check-card .player-row.rolled {
      flex-direction:column; align-items:stretch;
      padding:0;
    }
    .skill-check-card .player-row.rolled .player-row-main {
      display:flex; align-items:center; gap:.45em;
      padding:.32em .15em;
    }
    .skill-check-card .player-row.rolled.has-breakdown .player-row-main {
      cursor:pointer;
      transition:background .1s;
    }
    .skill-check-card .player-row.rolled.has-breakdown .player-row-main:hover {
      background:rgba(0,0,0,.04);
    }
    .skill-check-card .expand-arrow {
      width:1.2em; text-align:center;
      color:#888; font-size:.75em;
      transition:transform .15s;
      margin-left:.1em;
    }
    .skill-check-card .player-row.expanded .expand-arrow {
      transform:rotate(180deg);
    }
    .skill-check-card .roll-breakdown {
      display:none;
      padding:.45em .9em .55em .9em;
      background:#e8e3d0;
      border-top:1px dashed #c9a84c;
      font-size:.95em;
    }
    .skill-check-card .player-row.expanded .roll-breakdown {
      display:block;
    }
    .skill-check-card .bd-row {
      display:flex; justify-content:space-between; align-items:baseline;
      padding:.12em 0;
    }
    .skill-check-card .bd-label { color:#5b5949; }
    .skill-check-card .bd-value {
      font-family:"Signika",sans-serif; font-weight:600;
      color:#1f1f1f;
    }
    .skill-check-card .bd-kept { color:#1f1f1f; font-weight:700; font-size:1.05em; }
    .skill-check-card .bd-dropped {
      color:#9c7a3a;
      margin-left:.45em;
      font-weight:500;
      font-size:.95em;
      opacity:.85;
    }
    .skill-check-card .bd-row.bd-total {
      border-top:1px solid #c9a84c;
      margin-top:.15em; padding-top:.3em;
      font-weight:700;
    }
    .skill-check-card .bd-row.bd-total .bd-value { font-size:1.05em; }
    .skill-check-card .roll-btn {
      width:26px; height:26px;
      background:#fff !important;
      border:1px solid #6f6c66 !important;
      border-radius:3px !important;
      color:#7a1818 !important;
      cursor:pointer;
      display:inline-flex; align-items:center; justify-content:center;
      padding:0; line-height:1;
      transition:background .1s, transform .1s;
      box-shadow:none !important;
      outline:none !important;
    }
    .skill-check-card .roll-btn:hover {
      background:#f7f1d8 !important; transform:scale(1.06);
    }
    .skill-check-card .roll-btn:disabled {
      opacity:.4; cursor:not-allowed; transform:none;
    }
    .skill-check-card .rolled-icon {
      width:26px; height:26px; display:inline-flex;
      align-items:center; justify-content:center;
      color:#999; font-size:.85em;
    }
    .skill-check-card .player-name {
      flex:1; font-weight:600; color:#1f1f1f;
    }
    .skill-check-card .mode-tag {
      font-size:.7em; font-weight:700;
      padding:.08em .35em;
      border-radius:2px;
      letter-spacing:.05em;
      background:#e8e3d0; color:#5b5949;
      text-transform:uppercase;
    }
    .skill-check-card .mode-tag.adv { background:#d5ecd5; color:#2e5d2e; }
    .skill-check-card .mode-tag.dis { background:#ecd5d5; color:#7a2828; }
    .skill-check-card .roll-result {
      font-family:"Signika",sans-serif; font-weight:700;
      min-width:1.6em; text-align:right;
      color:#1f1f1f;
    }
    .skill-check-card .roll-result.placeholder { color:#999; font-style:italic; font-weight:400; }
    .skill-check-card .roll-status {
      font-weight:700;
      min-width:1em; text-align:center;
    }
    .skill-check-card .roll-status.success { color:#2e7d2e; }
    .skill-check-card .roll-status.failure { color:#a23030; }
    .skill-check-card .group-summary {
      margin-top:.5em; padding:.4em .5em;
      background:#e8e3d0;
      border-top:1px solid #c9a84c;
      font-size:.85em;
      text-align:center;
      color:#1f1f1f;
    }
    .skill-check-card .group-summary.muted { color:#7a7770; }
    .skill-check-card .group-result { font-weight:700; margin-left:.4em; }
    .skill-check-card .group-result.success { color:#2e7d2e; }
    .skill-check-card .group-result.failure { color:#a23030; }
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialog
// ─────────────────────────────────────────────────────────────────────────────

function buildDialog(skillKey, skillLabel, ability, characters) {
  document.getElementById("skill-check-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "skill-check-overlay";

  const dialog = document.createElement("div");
  dialog.id = "skill-check-dialog";
  dialog.innerHTML = `
    <div class="title">${escapeHtml(skillLabel)} Check${ability ? ` (${ability.toUpperCase()})` : ""}</div>

    <div class="field">
      <div class="field-label">Difficulty Class</div>
      <div class="num-input">
        <button type="button" data-step="-1">−</button>
        <input id="sc-dc" type="number" value="10" min="1" max="40">
        <button type="button" data-step="1">+</button>
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

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("shown"));

  const dcInput = dialog.querySelector("#sc-dc");
  const thrInput = dialog.querySelector("#sc-threshold");
  const thrWrap = dialog.querySelector("#sc-threshold-wrap");
  const groupCb = dialog.querySelector("#sc-group");
  const blindDcCb = dialog.querySelector("#sc-blind-dc");
  const blindRollCb = dialog.querySelector("#sc-blind-roll");

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

  dialog.querySelectorAll(".mode-toggle").forEach(toggle => {
    toggle.querySelectorAll("button").forEach(b => {
      b.addEventListener("click", () => {
        toggle.querySelectorAll("button").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
      });
    });
  });

  const updateThresholdDefault = () => {
    const checked = dialog.querySelectorAll(".sc-player-checkbox:checked").length;
    thrInput.max = String(Math.max(1, checked));
    if (!thrInput._userTouched) {
      thrInput.value = String(Math.floor(checked / 2) + 1);
    } else {
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

  groupCb.addEventListener("change", () => {
    thrWrap.classList.toggle("enabled", groupCb.checked);
  });

  const close = () => {
    overlay.classList.remove("shown");
    setTimeout(() => overlay.remove(), 200);
  };
  dialog.querySelector("#sc-cancel").addEventListener("click", close);

  dialog.querySelector("#sc-submit").addEventListener("click", async () => {
    const players = [];
    for (const row of dialog.querySelectorAll(".player-row")) {
      const cb = row.querySelector(".sc-player-checkbox");
      if (!cb?.checked) continue;
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
      skillKey, skillLabel, ability,
      dc,
      blindDC: blindDcCb.checked,
      blindRoll: blindRollCb.checked,
      groupCheck,
      threshold,
      players,
    });
  });

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e) => {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
  };
  document.addEventListener("keydown", onKey);
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat message
// ─────────────────────────────────────────────────────────────────────────────

async function createSkillCheckMessage(config) {
  const state = {
    ...config,
    rolls: {},
    createdBy: game.user.id,
  };
  const content = renderCheckContent(state);

  await ChatMessage.create({
    speaker: { alias: `${config.skillLabel} Check` },
    content,
    flags: { [MODULE_ID]: { skillCheck: state } },
  });
}

/**
 * Renders the full chat card. ALL data is included as data-* attributes on the
 * relevant elements. The renderChatMessage hook (per-client) then applies the
 * blind rules by hiding/masking elements based on whether the local user is GM.
 */
function renderCheckContent(state) {
  const rows = state.players.map(p => {
    const r = state.rolls[p.actorId];
    const modeClass = p.mode === "adv" ? "adv" : p.mode === "dis" ? "dis" : "";
    const modeTag = p.mode === "nor" ? "" :
      `<span class="mode-tag ${modeClass}">${p.mode.toUpperCase()}</span>`;

    if (!r) {
      return `
        <li class="player-row" data-actor-id="${p.actorId}">
          <button class="roll-btn" data-actor-id="${p.actorId}" data-mode="${p.mode}" title="Roll for ${escapeHtml(p.actorName)}">
            <i class="fas fa-dice-d20"></i>
          </button>
          <span class="player-name">${escapeHtml(p.actorName)}</span>
          ${modeTag}
          <span class="roll-result placeholder">—</span>
          <span class="roll-status"></span>
        </li>`;
    }

    const statusClass = r.success ? "success" : "failure";
    const statusGlyph = r.success ? "✓" : "✗";
    const breakdownHtml = renderBreakdown(r.breakdown);
    const hasBreakdown = !!breakdownHtml;
    return `
      <li class="player-row rolled${hasBreakdown ? " has-breakdown" : ""}" data-actor-id="${p.actorId}">
        <div class="player-row-main">
          <span class="rolled-icon"><i class="fas fa-dice-d20"></i></span>
          <span class="player-name">${escapeHtml(p.actorName)}</span>
          ${modeTag}
          <span class="roll-result" data-total="${r.total}">${r.total}</span>
          <span class="roll-status ${statusClass}" data-success="${r.success ? "1" : "0"}">${statusGlyph}</span>
          ${hasBreakdown ? `<span class="expand-arrow"><i class="fas fa-chevron-down"></i></span>` : ""}
        </div>
        ${breakdownHtml}
      </li>`;
  }).join("");

  let groupHtml = "";
  if (state.groupCheck) {
    const rolledCount = Object.keys(state.rolls).length;
    const allRolled = rolledCount === state.players.length;
    const successCount = state.players.filter(p => state.rolls[p.actorId]?.success).length;
    const groupPassed = successCount >= state.threshold;

    if (allRolled) {
      const resultClass = groupPassed ? "success" : "failure";
      const resultText = groupPassed ? "✓ PASSED" : "✗ FAILED";
      groupHtml = `
        <div class="group-summary" data-group="final" data-passed="${groupPassed ? "1" : "0"}">
          Group: <span class="group-count">${successCount}</span>/${state.players.length} succeeded (threshold ${state.threshold})
          <span class="group-result ${resultClass}">${resultText}</span>
        </div>`;
    } else {
      groupHtml = `<div class="group-summary muted" data-group="pending">Group check — threshold ${state.threshold} of ${state.players.length} (${rolledCount}/${state.players.length} rolled)</div>`;
    }
  }

  return `
    <div class="skill-check-card" data-blind-dc="${state.blindDC ? "1" : "0"}" data-blind-roll="${state.blindRoll ? "1" : "0"}">
      <header class="card-header">
        <span class="icon"><i class="fas fa-dice-d20"></i></span>
        <div class="title-block">
          <div class="skill-name">${escapeHtml(state.skillLabel)} Check</div>
          ${state.ability ? `<div class="ability-tag">${state.ability.toUpperCase()}</div>` : ""}
        </div>
        <span class="dc-badge" data-dc="${state.dc}">DC ${state.dc}</span>
      </header>
      <section class="card-content">
        <ul class="player-list">${rows}</ul>
        ${groupHtml}
      </section>
    </div>
  `;
}

/**
 * Per-client render hook (V11/V12 jQuery + V13 HTMLElement).
 *  - Adds dice click handlers (only enabled for actor owners)
 *  - Applies blind rules by mutating the DOM for non-GM viewers
 */
function onRenderChatMessage(message, html, _data) {
  const state = message.flags?.[MODULE_ID]?.skillCheck;
  if (!state) return;

  // html may be a jQuery wrapper (V12) or an HTMLElement (V13)
  const root = (html instanceof HTMLElement) ? html
             : (html?.[0]) ? html[0]
             : (html?.get) ? html.get(0)
             : null;
  if (!root) return;

  const card = root.querySelector?.(".skill-check-card");
  if (!card) return;

  // Dedup: both renderChatMessage and renderChatMessageHTML may fire on V13
  if (card._scProcessed) return;
  card._scProcessed = true;

  const isGM = game.user.isGM;
  console.log(`${MODULE_ID} | renderChatMessage user=${game.user.name} isGM=${isGM} blindDC=${state.blindDC} blindRoll=${state.blindRoll}`);

  // ── Apply blind rules for non-GM viewers ──────────────────────────────
  if (!isGM) {
    if (state.blindDC) {
      const dcBadge = card.querySelector(".dc-badge");
      if (dcBadge) {
        dcBadge.textContent = "DC ??";
        console.log(`${MODULE_ID} | Blind DC applied`);
      }
    }
    if (state.blindRoll) {
      const resultEls = card.querySelectorAll(".roll-result[data-total]");
      for (const el of resultEls) {
        el.textContent = "rolled";
        el.classList.add("placeholder");
      }
      // No breakdowns for players when rolls are blind
      for (const bd of card.querySelectorAll(".roll-breakdown")) bd.remove();
      for (const arrow of card.querySelectorAll(".expand-arrow")) arrow.remove();
      for (const row of card.querySelectorAll(".player-row.rolled")) row.classList.remove("has-breakdown");
      if (resultEls.length) console.log(`${MODULE_ID} | Blind roll applied to ${resultEls.length} results`);
    }
    if (state.blindDC || state.blindRoll) {
      for (const el of card.querySelectorAll(".roll-status[data-success]")) {
        el.textContent = "";
        el.classList.remove("success", "failure");
      }
      const groupFinal = card.querySelector('.group-summary[data-group="final"]');
      if (groupFinal) {
        groupFinal.innerHTML = `Group check complete (${state.players.length} rolled) — result hidden`;
        groupFinal.classList.add("muted");
      }
    }
  }

  // ── Wire expand/collapse on rolled rows that have a breakdown ─────────
  for (const row of card.querySelectorAll(".player-row.rolled.has-breakdown")) {
    const actorId = row.dataset.actorId;
    const key = `${message.id}-${actorId}`;
    if (_expandedKeys.has(key)) row.classList.add("expanded");

    const main = row.querySelector(".player-row-main");
    if (main) {
      main.addEventListener("click", (e) => {
        if (e.target.closest("button")) return; // don't toggle if clicking a button
        row.classList.toggle("expanded");
        if (row.classList.contains("expanded")) _expandedKeys.add(key);
        else _expandedKeys.delete(key);
      });
    }
  }

  // ── Bind roll buttons ──────────────────────────────────────────────────
  for (const btn of card.querySelectorAll(".roll-btn")) {
    const actorId = btn.dataset.actorId;
    const mode = btn.dataset.mode;
    const actor = game.actors.get(actorId);

    const owns = userOwnsActor(actor, game.user);
    console.log(`${MODULE_ID} | Button for ${actor?.name || actorId}: owns=${owns} (user=${game.user.name})`);

    if (!actor || !owns) {
      btn.disabled = true;
      btn.title = "Not your character";
      continue;
    }
    if (state.rolls?.[actorId]) {
      btn.disabled = true;
      continue;
    }
    btn.addEventListener("click", () => onPlayerRollClick(message.id, actorId, mode));
  }
}

/**
 * Robust ownership check that works across Foundry versions.
 * V11/V12 use `actor.ownership[userId]`, V13 same.
 * GMs always own everything.
 */
function userOwnsActor(actor, user) {
  if (!actor || !user) return false;
  if (user.isGM) return true;
  // Use Foundry's built-in test if available
  try {
    if (typeof actor.testUserPermission === "function") {
      const OWNER = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
      if (actor.testUserPermission(user, OWNER)) return true;
    }
  } catch (e) { /* fall through */ }
  // Direct check on ownership map (V10+)
  const ownership = actor.ownership || actor.permission || {};
  const OWNER = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const userLevel = ownership[user.id];
  const defaultLevel = ownership.default ?? 0;
  return (userLevel ?? defaultLevel) >= OWNER;
}

async function onPlayerRollClick(messageId, actorId, mode) {
  const message = game.messages.get(messageId);
  const state = message?.flags?.[MODULE_ID]?.skillCheck;
  if (!message || !state) return;

  const actor = game.actors.get(actorId);
  if (!actor || !userOwnsActor(actor, game.user)) return ui.notifications.warn("Not your character.");
  if (state.rolls?.[actorId]) return;

  // Always build & evaluate the roll manually so that:
  //   1. The DM's chosen mode (adv/normal/dis) is honored — no player prompt
  //   2. We can capture Guidance, Bardic Inspiration, etc. via active effects
  //   3. No chat roll cards appear anywhere — players + GM only see our card
  const formula = buildBlindRollFormula(actor, state.skillKey, mode);
  const rollData = actor.getRollData ? actor.getRollData() : {};
  console.log(`${MODULE_ID} | Roll formula for ${actor.name} (${mode}): ${formula}`);

  let roll;
  try {
    roll = new Roll(formula, rollData);
    await roll.evaluate();
  } catch (e) {
    console.error(`${MODULE_ID} | Roll failed:`, e);
    ui.notifications.error("Roll failed — see console.");
    return;
  }

  // For non-blind rolls, fire the 3D dice animation publicly so everyone
  // gets the satisfying dice roll. Skip for blind so nothing visibly happens.
  if (!state.blindRoll && game.dice3d) {
    try {
      await game.dice3d.showForRoll(roll, game.user, true);
    } catch (e) {
      console.warn(`${MODULE_ID} | DSN show failed:`, e);
    }
  }

  // Play the standard Foundry dice roll sound (broadcast to all clients).
  // For blind rolls we still play the sound — hearing it doesn't reveal the
  // result, and players need audio feedback that their click registered.
  playDiceSound();

  const total = roll.total;
  const formulaStr = roll.formula || "";
  const success = total >= state.dc;
  const breakdown = extractBreakdown(roll, mode);

  const payload = { messageId, actorId, total, formula: formulaStr, success, breakdown };
  if (game.user.isGM) {
    await applyRollUpdate(payload);
  } else {
    game.socket.emit(SOCKET, { action: "skillCheckRoll", ...payload });
  }
}

function onSocket(data) {
  if (data?.action !== "skillCheckRoll") return;
  if (!game.user.isGM) return;
  const primary = game.users.find(u => u.isGM && u.active);
  if (primary && primary.id !== game.user.id) return;
  applyRollUpdate(data).catch(err => console.error(`${MODULE_ID} | applyRollUpdate:`, err));
}

async function applyRollUpdate({ messageId, actorId, total, formula, success, breakdown }) {
  const message = game.messages.get(messageId);
  const state = message?.flags?.[MODULE_ID]?.skillCheck;
  if (!message || !state) return;
  if (state.rolls?.[actorId]) return;

  const newRolls = { ...(state.rolls || {}), [actorId]: { total, formula, success, breakdown } };
  const newState = { ...state, rolls: newRolls };
  const newContent = renderCheckContent(newState);

  await message.update({
    content: newContent,
    flags: { [MODULE_ID]: { skillCheck: newState } },
  });

  // Record dice + check outcome to the module's diceRolls setting so the
  // dashboard picks it up (same store the main.mjs tracker writes to).
  const actor = game.actors.get(actorId);
  if (actor && breakdown) {
    try {
      await trackSkillCheck(actor, breakdown, success);
    } catch (e) {
      console.warn(`${MODULE_ID} | trackSkillCheck failed:`, e);
    }
  }
}

/**
 * Explicitly track a skill check's dice + outcome into the module's diceRolls
 * setting (same store that main.mjs's createChatMessage tracker writes to).
 * Only runs on the GM client to avoid races with multiple writers.
 */
async function trackSkillCheck(actor, breakdown, success) {
  if (!game.user.isGM) return;

  const store = game.settings.get(MODULE_ID, "diceRolls") || {};
  if (!store[actor.id]) {
    store[actor.id] = { name: actor.name, dice: {}, outcomes: {} };
  }
  const data = store[actor.id];
  if (!data.dice) data.dice = {};
  if (!data.outcomes) data.outcomes = {};

  const recordFace = (faces, value) => {
    const k = String(faces);
    if (!data.dice[k]) data.dice[k] = {};
    const v = String(value);
    data.dice[k][v] = (data.dice[k][v] || 0) + 1;
  };

  // d20 — track both kept and dropped so raw dice luck is reflected
  if (breakdown.d20Result != null) recordFace(20, breakdown.d20Result);
  if (breakdown.d20Dropped != null) recordFace(20, breakdown.d20Dropped);

  // Bonus dice from Guidance, Bardic Inspiration, etc.
  for (const bd of (breakdown.bonusDice || [])) {
    const facesMatch = bd.formula?.match?.(/d(\d+)/);
    if (!facesMatch) continue;
    const faces = parseInt(facesMatch[1]);
    if (![4, 6, 8, 10, 12].includes(faces)) continue;
    for (const result of (bd.rolls || [])) {
      recordFace(faces, result);
    }
  }

  // Check success/failure outcome
  if (!data.outcomes.check) data.outcomes.check = { success: 0, failure: 0 };
  data.outcomes.check[success ? "success" : "failure"] += 1;

  await game.settings.set(MODULE_ID, "diceRolls", store);
  console.log(`${MODULE_ID} | Tracked skill check for ${actor.name}: success=${success}, d20=${breakdown.d20Result}${breakdown.d20Dropped != null ? `/${breakdown.d20Dropped}` : ""}, bonus=${(breakdown.bonusDice || []).map(b => b.formula + "=" + b.result).join(",") || "none"}`);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/**
 * Play Foundry's standard dice-roll sound, broadcast to all clients.
 * Works across V11/V12 (global AudioHelper) and V13 (foundry.audio.AudioHelper).
 */
function playDiceSound() {
  try {
    const src = CONFIG?.sounds?.dice || "sounds/dice.wav";
    const opts = { src, volume: 0.8, autoplay: true, loop: false };
    const broadcast = true;
    if (foundry?.audio?.AudioHelper?.play) {
      foundry.audio.AudioHelper.play(opts, broadcast);
    } else if (typeof AudioHelper !== "undefined" && AudioHelper.play) {
      AudioHelper.play(opts, broadcast);
    } else if (game.audio?.play) {
      game.audio.play(opts);
    }
  } catch (e) {
    console.warn(`${MODULE_ID} | Couldn't play dice sound:`, e);
  }
}

/**
 * Extract roll breakdown (d20 result, bonus dice, modifier) from a Roll instance.
 * Works for both Foundry raw Rolls and dnd5e D20Rolls. The modifier is
 * computed implicitly as (total - sum of all dice) so it's always correct
 * regardless of how the underlying terms are structured.
 */
function extractBreakdown(roll, mode) {
  const breakdown = {
    mode,
    d20Result: null,
    d20Dropped: null,
    bonusDice: [],
    modifier: 0,
    total: roll.total ?? 0,
    formula: roll.formula || "",
  };

  const dice = roll.dice || [];
  let mainD20Found = false;

  for (const die of dice) {
    const faces = die.faces;
    const results = die.results || [];
    const active = results.filter(r => !r.discarded && r.active !== false);
    const dropped = results.filter(r => r.discarded || r.active === false);

    if (faces === 20 && !mainD20Found) {
      breakdown.d20Result = active[0]?.result ?? null;
      if (dropped.length) breakdown.d20Dropped = dropped[0]?.result ?? null;
      mainD20Found = true;
    } else {
      const sum = active.reduce((s, r) => s + r.result, 0);
      breakdown.bonusDice.push({
        formula: `${die.number || 1}d${faces}`,
        result: sum,
        rolls: active.map(r => r.result),
      });
    }
  }

  const diceSum = (breakdown.d20Result || 0) + breakdown.bonusDice.reduce((s, b) => s + b.result, 0);
  breakdown.modifier = breakdown.total - diceSum;

  return breakdown;
}

/** Track which player rows are expanded per session (keyed by messageId-actorId). */
const _expandedKeys = new Set();

/**
 * Render the dropdown breakdown HTML for a rolled row. Returns "" if no
 * breakdown data is available (e.g., older rolls created before this feature).
 */
function renderBreakdown(breakdown) {
  if (!breakdown || breakdown.d20Result === null || breakdown.d20Result === undefined) return "";
  const { mode, d20Result, d20Dropped, bonusDice = [], modifier = 0, total = 0 } = breakdown;

  const modeLabel = mode === "adv" ? " (advantage)" : mode === "dis" ? " (disadvantage)" : "";
  const d20ValueHtml = (d20Dropped !== null && d20Dropped !== undefined)
    ? `<span class="bd-kept">${d20Result}</span><span class="bd-dropped">(${d20Dropped})</span>`
    : `<span class="bd-kept">${d20Result}</span>`;

  let html = `
    <div class="bd-row">
      <span class="bd-label">1d20${modeLabel}</span>
      <span class="bd-value">${d20ValueHtml}</span>
    </div>
  `;

  for (const bd of bonusDice) {
    const rolls = bd.rolls || [];
    const valueStr = rolls.length > 1
      ? `${rolls.join(" + ")} = ${bd.result}`
      : `${bd.result}`;
    html += `
      <div class="bd-row">
        <span class="bd-label">${escapeHtml(bd.formula)}</span>
        <span class="bd-value">${escapeHtml(valueStr)}</span>
      </div>
    `;
  }

  if (modifier !== 0) {
    html += `
      <div class="bd-row">
        <span class="bd-label">Modifier</span>
        <span class="bd-value">${modifier >= 0 ? "+" : ""}${modifier}</span>
      </div>
    `;
  }

  html += `
    <div class="bd-row bd-total">
      <span class="bd-label">Total</span>
      <span class="bd-value">${total}</span>
    </div>
  `;

  return `<div class="roll-breakdown">${html}</div>`;
}

/**
 * Build a d20 + modifier + bonuses formula for a blind skill check.
 * Captures everything dnd5e would normally pick up at roll time:
 *  - skill.total: ability mod + proficiency + flat active-effect bonuses
 *  - bonuses.abilities.check: dice bonuses (Guidance "1d4", Bardic Inspiration "1d6/d8/d10/d12")
 *  - bonuses.abilities.skill: global skill bonus
 *  - skill.bonuses.check: skill-specific bonus
 */
function buildBlindRollFormula(actor, skillKey, mode) {
  const skill = actor.system?.skills?.[skillKey];
  const mod = Number.isFinite(skill?.total) ? skill.total : 0;
  const checkBonus = actor.system?.bonuses?.abilities?.check || "";
  const skillBonus = actor.system?.bonuses?.abilities?.skill || "";
  const specificBonus = skill?.bonuses?.check || "";

  const parts = [];
  parts.push(mode === "adv" ? "2d20kh" : mode === "dis" ? "2d20kl" : "1d20");

  if (mod !== 0) {
    parts.push((mod >= 0 ? "+ " : "- ") + Math.abs(mod));
  }

  const cleanBonus = (b) => {
    if (!b) return null;
    const trimmed = String(b).trim();
    if (!trimmed || trimmed === "0" || trimmed === "+0" || trimmed === "-0") return null;
    if (!/^[+-]/.test(trimmed)) return "+ " + trimmed;
    // Normalize the spacing around the leading +/-
    return trimmed.replace(/^([+-])\s*/, "$1 ");
  };

  for (const b of [checkBonus, skillBonus, specificBonus]) {
    const c = cleanBonus(b);
    if (c) parts.push(c);
  }

  return parts.join(" ");
}
