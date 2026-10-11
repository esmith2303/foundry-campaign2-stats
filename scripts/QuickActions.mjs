/**
 * QuickActions — the "+" toolbar button.
 *
 * Opens a popup listing the supported abilities found on the player's
 * character sheet, and lets each ability run its own little UI. Anything that
 * changes other characters (healing, spending pools…) runs on the GM's client
 * via runAsGM(), because players can't edit actors they don't own.
 *
 * To add an ability: create scripts/abilities/<Name>.mjs exporting an object
 * like LayOnHands (id, label, icon, findItem, summary, renderPanel, gmActions)
 * and add it to ABILITIES below. Always-available actions (no sheet item) set
 * `general: true` and go in GENERAL.
 */
import { AddKill } from "./abilities/AddKill.mjs";
import { AddDamage } from "./abilities/AddDamage.mjs";
import { AddHealing } from "./abilities/AddHealing.mjs";
import { Healer } from "./abilities/Healer.mjs";
import { LayOnHands } from "./abilities/LayOnHands.mjs";
import { MODULE_ID, escapeHtml, partyCharacters } from "./abilities/shared.mjs";

const SOCKET = `module.${MODULE_ID}`;
export const QUICK_ACTIONS_TOOL = "stats-quick-actions";

// Always shown, in this order, for every character
const GENERAL = [AddKill, AddDamage, AddHealing];
// Shown when the character's sheet has them; listed alphabetically
const ABILITIES = [Healer, LayOnHands];

const GM_HANDLERS = Object.assign({}, ...[...GENERAL, ...ABILITIES].map(a => a.gmActions || {}));
const pending = new Map();   // requestId → { resolve, reject, timer }

// ── Setup ────────────────────────────────────────────────────────────────────

export function registerQuickActions() {
  game.socket.on(SOCKET, onSocket);
}

/** Tool definition for getSceneControlButtons (shown to every user). */
export function quickActionsTool() {
  return {
    name: QUICK_ACTIONS_TOOL,
    title: "Abilities",
    icon: "fas fa-plus",
    button: true,
    onChange: () => {},
  };
}

// ── GM routing ───────────────────────────────────────────────────────────────

function activeGM() {
  return game.users.activeGM ?? game.users.find(u => u.isGM && u.active) ?? null;
}

function isPrimaryGM() {
  return game.user.isGM && activeGM()?.id === game.user.id;
}

/**
 * Run a GM action: directly if we are the GM, otherwise ask the GM's client
 * over the socket and wait for its answer. Rejects with a readable message.
 */
export async function runAsGM(action, payload) {
  const handler = GM_HANDLERS[action];
  if (!handler) throw new Error(`Unknown action "${action}".`);
  if (game.user.isGM) return handler(payload, game.user);

  if (!activeGM()) throw new Error("The GM needs to be logged in to apply this.");
  const requestId = foundry.utils.randomID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("The GM's client didn't respond — try again."));
    }, 15000);
    pending.set(requestId, { resolve, reject, timer });
    game.socket.emit(SOCKET, { action: "qa.request", requestId, userId: game.user.id, gmAction: action, payload });
  });
}

function onSocket(data) {
  if (data?.action === "qa.request") {
    if (!isPrimaryGM()) return;
    const reply = (extra) => game.socket.emit(SOCKET, { action: "qa.response", requestId: data.requestId, userId: data.userId, ...extra });
    const user = game.users.get(data.userId);
    const handler = GM_HANDLERS[data.gmAction];
    Promise.resolve()
      .then(() => {
        if (!user) throw new Error("Unknown user.");
        if (!handler) throw new Error(`Unknown action "${data.gmAction}".`);
        return handler(data.payload, user);
      })
      .then(result => reply({ ok: true, result }))
      .catch(err => {
        console.warn(`${MODULE_ID} | quick action failed:`, err);
        reply({ ok: false, error: err?.message || String(err) });
      });
  } else if (data?.action === "qa.response") {
    if (data.userId !== game.user.id) return;
    const p = pending.get(data.requestId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(data.requestId);
    data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
  }
}

// ── Popup ────────────────────────────────────────────────────────────────────

function castersForUser() {
  const pcs = partyCharacters();
  if (game.user.isGM) return pcs;
  const mine = pcs.filter(a => a.isOwner);
  const main = game.user.character;
  return main && mine.includes(main) ? [main, ...mine.filter(a => a !== main)] : mine;
}

export function openQuickActions() {
  const casters = castersForUser();
  if (!casters.length) return ui.notifications.warn("You don't own a character in the party.");

  // Same overlay/dialog structure as the skill-check dialog; its stylesheet
  // (SkillCheck.mjs) styles #qa-overlay / #qa-dialog too, so they match.
  document.getElementById("qa-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "qa-overlay";
  const dialog = document.createElement("div");
  dialog.id = "qa-dialog";
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("shown"));

  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    overlay.classList.remove("shown");
    setTimeout(() => overlay.remove(), 200);
  }
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  // Start on the first character that actually has a supported ability
  let caster = casters.find(c => ABILITIES.some(ab => ab.findItem(c))) ?? casters[0];

  function showList() {
    const found = ABILITIES.map(a => ({ a, item: a.findItem(caster) }))
      .filter(x => x.item)
      .sort((x, y) => x.item.name.localeCompare(y.item.name));

    const casterField = casters.length > 1 ? `
      <div class="field">
        <div class="field-label">Character</div>
        <div class="players">
          ${casters.map(a => `
            <div class="player-row">
              <label>
                <input type="radio" name="qa-caster" value="${a.id}"${a === caster ? " checked" : ""}>
                <span>${escapeHtml(a.name)}</span>
              </label>
            </div>`).join("")}
        </div>
      </div>` : "";

    const abilityRow = (id, icon, name, tag) => `
      <div class="player-row qa-ability-row">
        <label class="qa-ability-label"><i class="${icon} qa-ability-icon"></i><span>${escapeHtml(name)}</span></label>
        <span class="qa-tag">${escapeHtml(tag)}</span>
        <button type="button" class="btn primary qa-use" data-ability="${id}">Use</button>
      </div>`;
    const generalRows = GENERAL.map(a => abilityRow(a.id, a.icon, a.label, a.hint || "")).join("");
    const abilityRows = found.length
      ? found.map(({ a, item }) => abilityRow(a.id, a.icon, item.name, a.summary(caster, item))).join("")
      : `<div class="player-row qa-empty">No supported abilities on ${escapeHtml(caster.name)}'s sheet yet (supported: ${ABILITIES.map(a => a.label).sort().join(", ")}).</div>`;

    dialog.innerHTML = `
      <div class="title">Abilities</div>
      ${casterField}
      <div class="field">
        <div class="field-label">${casters.length > 1 ? "Record" : `${escapeHtml(caster.name)} — Record`}</div>
        <div class="players">${generalRows}</div>
      </div>
      <div class="field">
        <div class="field-label">From the sheet</div>
        <div class="players">${abilityRows}</div>
      </div>
      <div class="actions">
        <button type="button" class="btn" data-qa="close">Close</button>
      </div>`;

    dialog.querySelector('[data-qa="close"]').addEventListener("click", close);
    dialog.querySelectorAll('input[name="qa-caster"]').forEach(r => r.addEventListener("change", () => {
      caster = game.actors.get(r.value) ?? caster;
      showList();
    }));
    dialog.querySelectorAll(".qa-use").forEach(btn => btn.addEventListener("click", () => {
      const general = GENERAL.find(a => a.id === btn.dataset.ability);
      if (general) return showAbility(general, null);
      const ability = ABILITIES.find(a => a.id === btn.dataset.ability);
      const item = ability?.findItem(caster);
      if (ability && item) showAbility(ability, item);
    }));
  }

  function showAbility(ability, item) {
    dialog.innerHTML = "";
    ability.renderPanel(dialog, { actor: caster, item, close, back: showList, runAsGM });
  }

  showList();
}
