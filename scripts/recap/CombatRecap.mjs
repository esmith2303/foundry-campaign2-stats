/**
 * End-of-combat recap: when the GM ends a combat, everyone gets a popup with
 * how each player character did, the MVP and the achievements they earned. It
 * is also saved to chat as a card (with a button to open the popup again).
 *
 * The GM's client does the work: it notes midi-qol's counters when combat
 * starts, and when the combat is deleted (End Combat) it reads the chat log for
 * the fight, works out the recap (compute.mjs) and shares it.
 */
import { MODULE_ID, escapeHtml } from "../abilities/shared.mjs";
import { isPrimaryGM } from "../QuickActions.mjs";
import { openPopup } from "../popup.mjs";
import { computeRecap, midiSnapshot, ACHIEVEMENTS } from "./compute.mjs";

const SOCKET = `module.${MODULE_ID}`;
const FLAG = "recapStart";

export function registerCombatRecap() {
  Hooks.on("combatStart", (combat) => noteStart(combat));
  Hooks.on("updateCombat", (combat, change) => { if (change?.round >= 1 && !combat.getFlag?.(MODULE_ID, FLAG)) noteStart(combat); });
  Hooks.on("deleteCombat", (combat) => { onCombatEnd(combat).catch(e => console.warn(`${MODULE_ID} | combat recap failed`, e)); });
  game.socket.on(SOCKET, (data) => { if (data?.action === "recap.show") showRecapPopup(data.recap); });
  Hooks.on("renderChatMessageHTML", (m, html) => bindCard(m, html));
  Hooks.on("renderChatMessage", (m, html) => bindCard(m, html));
}

const enabled = () => { try { return game.settings.get(MODULE_ID, "combatRecap") !== false; } catch { return true; } };
const midiStats = () => globalThis.MidiQOL?.gameStats?.currentStats ?? (() => { try { return game.settings.get("midi-qol", "RollStats"); } catch { return {}; } })();

function partyIn(combat) {
  const seen = new Map();
  for (const c of combat?.combatants ?? []) {
    const a = c.actor;
    if (a && a.type === "character" && a.hasPlayerOwner && !seen.has(a.id)) seen.set(a.id, { id: a.id, name: a.name, img: a.img || c.img || null });
  }
  return [...seen.values()];
}

async function noteStart(combat) {
  if (!isPrimaryGM() || !combat || combat.getFlag?.(MODULE_ID, FLAG)) return;
  const pcs = partyIn(combat);
  try {
    await combat.setFlag(MODULE_ID, FLAG, { start: Date.now(), midi: midiSnapshot(midiStats(), pcs.map(p => p.id)) });
  } catch (e) { console.warn(`${MODULE_ID} | couldn't note the combat start`, e); }
}

async function onCombatEnd(combat) {
  if (!isPrimaryGM() || !enabled() || !combat || !(combat.round >= 1)) return;
  const pcs = partyIn(combat);
  if (!pcs.length) return;
  const noted = combat.getFlag?.(MODULE_ID, FLAG) ?? null;
  const end = Date.now();
  // Started before this module noted it: fall back to when the combat was created
  const created = typeof combat._stats?.createdTime === "number" ? combat._stats.createdTime : Date.parse(combat._stats?.createdTime ?? "");
  const start = noted?.start ?? (Number.isFinite(created) ? created : end - 60 * 60e3);
  const enemies = [...(combat.combatants ?? [])].filter(c => !(c.actor?.hasPlayerOwner && c.actor?.type === "character")).map(c => ({
    name: c.name,
    defeated: !!c.isDefeated || (Number(c.actor?.system?.attributes?.hp?.value) <= 0 && c.actor?.system?.attributes?.hp?.max > 0),
  }));
  const messages = game.messages.contents
    .filter(m => (m.timestamp ?? 0) >= start && (m.timestamp ?? 0) <= end)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(m => m.toObject());
  const recap = computeRecap({
    messages, pcs, enemies, rounds: combat.round, start, end, scene: combat.scene?.name ?? "",
    midiStart: noted?.midi ?? {}, midiEnd: midiSnapshot(midiStats(), pcs.map(p => p.id)),
  });

  await ChatMessage.create({
    speaker: { alias: "Combat Recap" },
    content: cardHtml(recap),
    flags: { [MODULE_ID]: { combatRecap: recap } },
  });
  game.socket.emit(SOCKET, { action: "recap.show", recap });
  showRecapPopup(recap);
}

// ── Chat card ────────────────────────────────────────────────────────────────

const chip = (key) => {
  const a = ACHIEVEMENTS[key];
  return a ? `<span class="qa-recap-chip" title="${escapeHtml(a.text)}"><i class="${a.icon}"></i>${escapeHtml(a.name)}</span>` : "";
};
function headline(r) {
  const won = r.enemies.total && r.enemies.defeated === r.enemies.total;
  return won ? "Victory" : "Combat Over";
}
function subline(r) {
  return [r.scene, `${r.rounds} round${r.rounds === 1 ? "" : "s"}`, r.minutes ? `${r.minutes} min` : "",
          r.enemies.total ? `${r.enemies.defeated}/${r.enemies.total} foes defeated` : ""].filter(Boolean).join(" · ");
}

function cardHtml(r) {
  const rows = r.pcs.map(p => `
    <li class="qa-roll-row qa-recap-row">
      <div class="qa-receipt-head">
        <span class="qa-roll-name">${p.id === r.mvp ? '<i class="fas fa-crown qa-recap-crown" title="MVP"></i> ' : ""}${escapeHtml(p.name)}</span>
        <span class="qa-receipt-amt">${p.damage} dmg</span>
      </div>
      <div class="qa-roll-meta">${[
        `hits ${p.hits}/${p.hits + p.misses}`, p.biggestHit ? `best ${p.biggestHit}` : "", p.kills ? `${p.kills} kill${p.kills === 1 ? "" : "s"}` : "",
        p.healing ? `${p.healing} healed` : "", `${p.taken} taken`].filter(Boolean).join(" · ")}</div>
      ${p.achievements.length ? `<div class="qa-recap-chips">${p.achievements.map(chip).join("")}</div>` : ""}
    </li>`).join("");
  return `
    <div class="skill-check-card qa-card qa-recap-card">
      <header class="card-header">
        <span class="icon"><i class="fas fa-trophy"></i></span>
        <div class="title-block">
          <div class="skill-name">${headline(r)}</div>
          <div class="ability-tag">${escapeHtml(subline(r))}</div>
        </div>
      </header>
      <section class="card-content">
        <ul class="qa-rows">${rows}</ul>
        <button type="button" class="qa-recap-open" data-qa-recap><i class="fas fa-trophy"></i> View recap</button>
      </section>
    </div>`;
}

function bindCard(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0] ?? html?.get?.(0);
  const btn = root?.querySelector?.("[data-qa-recap]");
  if (!btn || btn._qaBound) return;
  btn._qaBound = true;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const recap = message?.flags?.[MODULE_ID]?.combatRecap ?? message?.getFlag?.(MODULE_ID, "combatRecap");
    if (recap) showRecapPopup(recap);
  });
}

// ── Popup ────────────────────────────────────────────────────────────────────

export function showRecapPopup(r) {
  if (!r?.pcs?.length) return;
  const { body } = openPopup({ id: "qa-recap", className: "qa-recap-dialog" });
  const mvp = r.pcs.find(p => p.id === r.mvp);
  const portrait = (p, cls = "") => p.img
    ? `<img class="qa-recap-portrait ${cls}" src="${escapeHtml(p.img)}" alt="">`
    : `<span class="qa-recap-portrait ${cls} qa-recap-initial">${escapeHtml((p.name || "?")[0])}</span>`;
  const stat = (label, value, cls = "") => `<div class="qa-recap-stat ${cls}"><span>${label}</span><b>${value}</b></div>`;

  body.innerHTML = `
    <div class="title">${headline(r)}</div>
    <div class="qa-recap-sub">${escapeHtml(subline(r))}</div>
    ${mvp ? `
    <div class="qa-recap-mvp">
      ${portrait(mvp, "big")}
      <div class="qa-recap-mvp-text">
        <div class="qa-recap-mvp-label"><i class="fas fa-crown"></i> MVP</div>
        <div class="qa-recap-mvp-name">${escapeHtml(mvp.name)}</div>
        <div class="qa-recap-mvp-line">${mvp.damage} damage${mvp.kills ? ` · ${mvp.kills} kill${mvp.kills === 1 ? "" : "s"}` : ""}${mvp.healing ? ` · ${mvp.healing} healed` : ""}</div>
      </div>
    </div>` : ""}
    <div class="qa-recap-grid">
      ${r.pcs.map((p, i) => `
        <div class="qa-recap-pc" style="--i:${i}">
          <div class="qa-recap-pc-head">${portrait(p)}<span class="qa-recap-pc-name">${escapeHtml(p.name)}</span>${p.id === r.mvp ? '<i class="fas fa-crown qa-recap-crown" title="MVP"></i>' : ""}</div>
          <div class="qa-recap-stats">
            ${stat("Damage", p.damage, "gold")}
            ${stat("Best hit", p.biggestHit || "—")}
            ${stat("Hits", `${p.hits}/${p.hits + p.misses}`)}
            ${stat("Kills", p.kills)}
            ${stat("Healed", p.healing)}
            ${stat("Taken", p.taken, "red")}
            ${stat("Nat 20", p.nat20)}
            ${stat("Nat 1", p.nat1)}
          </div>
          <div class="qa-recap-chips">${p.achievements.length
            ? p.achievements.map((k, j) => { const a = ACHIEVEMENTS[k]; return a ? `<span class="qa-recap-chip" style="--j:${i * 3 + j}" title="${escapeHtml(a.text)}"><i class="${a.icon}"></i>${escapeHtml(a.name)}</span>` : ""; }).join("")
            : '<span class="qa-recap-none">No achievements this time</span>'}</div>
        </div>`).join("")}
    </div>
    <div class="qa-recap-party">Party damage <b>${r.party.damage}</b> · natural 20s <b>${r.party.nat20}</b> · natural 1s <b>${r.party.nat1}</b></div>`;
}
