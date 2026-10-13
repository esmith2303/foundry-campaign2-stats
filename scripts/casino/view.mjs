/**
 * The casino window, drawn on every client from the dealer's public state.
 * Bets being built (stakes not yet placed) live only here, in `draft`, so other
 * players' clicks re-rendering the window never wipe them.
 */
import { escapeHtml, partyCharacters } from "../abilities/shared.mjs";
import { openPopup } from "../popup.mjs";
import { formatCp } from "../shop/currency.mjs";
import * as R from "./rules.mjs";
import { act, GAMES, gameName, MIN_BET_CP } from "./Casino.mjs";

let win = null;            // { frame, body, close, isClosed, hide, show, isHidden }
let shownKey = null;       // lobby / which game: a new one brings a tucked-away window back
let last = null;           // last state rendered
const seenCards = new Set();
const seenHidden = new Set();
// Bets being built: stake = gold per click on the board (roulette / lizards); bj = each blackjack bet
const draft = { stake: 100, bj: {}, roulette: {}, lizards: {}, as: null, round: null };
let busy = false;

const COIN_STEPS = [1, 10, 25, 100];
const SUIT = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANK = { T: "10" };

// ── Window ───────────────────────────────────────────────────────────────────

export function closeCasinoWindow() {
  last = null; shownKey = null;
  if (win && !win.isClosed()) win.close();
  win = null;
}

/** GM's toolbar button / anyone's dock button: bring the window back. */
export function showCasinoWindow(state = last) {
  if (win && !win.isClosed() && win.isHidden()) win.show();
  if (state) renderCasino(state);
}

function ensureWindow(state) {
  if (win && !win.isClosed()) return win;
  const width = Math.min(1060, window.innerWidth - 24);
  // ✕ only tucks the casino into the "Back to …" dock; it stays open until the GM closes it
  win = openPopup({
    id: "cz-casino", floating: true, className: "cz-dialog", width: `${width}px`,
    left: Math.max(12, (window.innerWidth - width) / 2), top: Math.max(12, window.innerHeight * 0.04),
    stash: { label: () => last?.name ?? state?.name ?? "the casino", icon: "fas fa-dice" },
    onClose: () => { win = null; },
  });
  return win;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const actorOf = (id) => game.actors.get(id);
const nameOf = (id) => actorOf(id)?.name ?? "Someone";
const imgOf = (id) => actorOf(id)?.img || "icons/svg/mystery-man.svg";
const mine = (id) => game.user.isGM || !!actorOf(id)?.isOwner;
const gp = (cp) => formatCp(cp);
const signed = (cp) => `${cp > 0 ? "+" : cp < 0 ? "−" : "±"}${formatCp(Math.abs(cp))}`;
const portrait = (id, cls = "") => `<img class="cz-portrait ${cls}" src="${escapeHtml(imgOf(id))}" alt="">`;

/** A little pile of gold coins with the amount on it (taller for bigger stakes). */
function coinHtml(cp, extra = "") {
  const v = cp / 100;
  const height = v >= 100 ? 4 : v >= 25 ? 3 : v >= 10 ? 2 : 1;
  const label = v >= 1000 ? `${Math.round(v / 100) / 10}k` : +v.toFixed(2);
  return `<span class="cz-coins h${height} ${extra}" title="${gp(cp)}"><span class="cz-coin-top">${label}</span></span>`;
}
/**
 * Stake picker: type an amount, or add +1 / +10 / +25 / +100 gp coins.
 * key "bj:<actorId>" sets that blackjack bet; "stake" sets the gold placed per click on the board.
 */
function stakeHtml(state, key, cp, hint = "") {
  const max = state.maxBetCp / 100;
  return `
    <div class="cz-stake-picker">
      <label class="cz-stake-field"><span class="cz-coins h2"><span class="cz-coin-top">gp</span></span>
        <input type="number" class="cz-stake-input" data-stake="${key}" min="0" max="${max}" step="1" value="${cp ? +(cp / 100).toFixed(2) : ""}" placeholder="0">
        <span class="cz-stake-unit">gp</span></label>
      <div class="cz-coin-btns">${COIN_STEPS.filter(n => n <= max).map(n => `<button type="button" class="cz-coin-btn" data-stake-add="${key}" data-gp="${n}" title="Add ${n} gp">+${n}</button>`).join("")}
        ${key === "stake" ? "" : `<button type="button" class="cz-btn small ghost" data-stake-clear="${key}"${cp ? "" : " disabled"}>Clear</button>`}</div>
      ${hint ? `<div class="cz-note">${hint}</div>` : ""}
    </div>`;
}
const stakeOf = (key) => key === "stake" ? draft.stake : draft.bj[key.slice(3)] ?? 0;
function setStake(key, cp, maxCp) {
  cp = Math.max(0, Math.min(maxCp, Math.round(cp)));
  if (key === "stake") draft.stake = cp;
  else if (cp) draft.bj[key.slice(3)] = cp;
  else delete draft.bj[key.slice(3)];
}

async function send(payload) {
  if (busy) return false;
  busy = true;
  try { return await act(payload); } finally { busy = false; }
}

// ── Render ───────────────────────────────────────────────────────────────────

export function renderCasino(state) {
  last = state;
  const key = state.phase === "table" ? `t${state.qi}:${state.table?.game}` : "lobby";
  const w = ensureWindow(state);
  // A new game (or the lobby) brings a tucked-away window back for everyone to watch
  if (key !== shownKey) { shownKey = key; if (w.isHidden()) w.show(); }
  const roundKey = state.table ? `${key}:${state.table.round}` : key;
  if (draft.round !== roundKey) { draft.round = roundKey; draft.bj = {}; draft.roulette = {}; draft.lizards = {}; }

  const body = w.body;
  // Someone typing a stake keeps their cursor when another player's move redraws the window
  const typing = document.activeElement?.closest?.("#cz-casino") ? document.activeElement : null;
  const focusKey = typing?.dataset?.stake, caret = typing?.selectionStart;
  // Keep a running wheel or race across re-renders
  const keep = body.querySelector("[data-keep]");
  keep?.remove();

  const t = state.table;
  const sub = state.phase === "lobby" ? "Pick your game" : `${gameName(t.game)} · Round ${t.round}`;
  body.innerHTML = `
    <div class="cz-sign qa-drag-handle">
      <span class="cz-lamp"></span>
      <div class="cz-board"><div class="cz-name">${escapeHtml(state.name)}</div><div class="cz-sub">${escapeHtml(sub)}</div></div>
      <span class="cz-lamp"></span>
    </div>
    ${game.user.isGM ? gmBar(state) : ""}
    <div class="cz-main">${state.phase === "lobby" ? lobbyHtml(state) : tableHtml(state)}</div>`;

  const slot = body.querySelector("[data-keep-slot]");
  if (slot) {
    if (keep && keep.dataset.keep === slot.dataset.keepSlot) slot.replaceWith(keep);
    else slot.replaceWith(buildStage(slot.dataset.keepSlot, state));
  }
  updateStage(body.querySelector("[data-keep]"), state);
  bind(body, state);
  if (focusKey) {
    const input = body.querySelector(`[data-stake="${focusKey}"]`);
    if (input) { input.value = typing.value; input.focus(); try { input.setSelectionRange(caret, caret); } catch {} }
  }
}

// ── GM bar ───────────────────────────────────────────────────────────────────

function gmBar(state) {
  const t = state.table;
  const btn = (type, label, cls = "", disabled = false) => `<button type="button" class="cz-btn ${cls}" data-gm="${type}"${disabled ? " disabled" : ""}>${label}</button>`;
  const left = [];
  if (state.phase === "lobby") {
    const games = GAMES.filter(g => Object.values(state.picks).includes(g.id));
    left.push(btn("start", `<i class="fas fa-door-open"></i> Open the tables${games.length ? ` (${games.map(g => g.name).join(" → ")})` : ""}`, "primary", !games.length));
  } else if (t) {
    if (t.phase === "betting") left.push(btn("force", `<i class="fas fa-forward"></i> ${t.game === "blackjack" ? "Deal" : t.game === "roulette" ? "Spin" : "Start the race"} now`, "", false));
    if (t.game === "blackjack" && t.phase === "insurance") left.push(btn("force", "<i class=\"fas fa-forward\"></i> No more insurance"));
    if (t.game === "blackjack" && t.phase === "playing" && t.turn) left.push(btn("force", `<i class="fas fa-hand"></i> Stand for ${escapeHtml(nameOf(t.turn.actorId))}`));
    if (t.phase === "done") {
      left.push(btn("again", `<i class="fas fa-rotate-right"></i> Another round`, "primary"));
      const next = state.queue[state.qi + 1];
      left.push(btn("next", next ? `Next: ${escapeHtml(gameName(next))} <i class="fas fa-arrow-right"></i>` : `<i class="fas fa-list"></i> Back to the lobby`));
    }
  }
  const right = [];
  if (state.phase !== "lobby") right.push(btn("lobby", `<i class="fas fa-list"></i> Lobby`, "ghost"));
  right.push(btn("close", `<i class="fas fa-door-closed"></i> Close the casino`, "ghost"));
  return `<div class="cz-gmbar"><span class="cz-gm-tag">GM</span>${left.join("")}<span class="cz-spacer"></span>${right.join("")}</div>`;
}

// ── Lobby ────────────────────────────────────────────────────────────────────

const GAME_ART = {
  blackjack: `<div class="cz-art-cards"><span class="cz-mini-card">A<b>♠</b></span><span class="cz-mini-card red">K<b>♥</b></span></div>`,
  roulette: `<div class="cz-art-wheel"></div>`,
  lizards: `<div class="cz-art-lizard">🦎</div>`,
};

function lobbyHtml(state) {
  const party = partyCharacters();
  const myIds = party.filter(a => mine(a.id)).map(a => a.id);
  const cards = GAMES.map(g => {
    const marked = party.filter(a => state.picks[a.id] === g.id);
    // Players get a "+ name" chip for their own characters; the GM a dropdown for anyone
    const ghosts = game.user.isGM ? [] : myIds.filter(id => state.picks[id] !== g.id);
    const others = game.user.isGM ? party.filter(a => state.picks[a.id] !== g.id) : [];
    return `
      <div class="cz-game" data-game="${g.id}">
        <div class="cz-game-art">${GAME_ART[g.id]}</div>
        <div class="cz-game-name">${g.name}</div>
        <div class="cz-game-blurb">${escapeHtml(g.blurb)}</div>
        <div class="cz-marks">
          ${marked.map(a => `<button type="button" class="cz-mark on${mine(a.id) ? " mine" : ""}" data-pick="${a.id}" data-game="${g.id}" ${mine(a.id) ? 'title="Click to take your mark off"' : "disabled"}>${portrait(a.id)}<span>${escapeHtml(a.name)}</span></button>`).join("")}
          ${ghosts.map(id => `<button type="button" class="cz-mark ghost" data-pick="${id}" data-game="${g.id}" title="Put ${escapeHtml(nameOf(id))}'s mark here">${portrait(id)}<span>＋ ${escapeHtml(nameOf(id))}</span></button>`).join("")}
          ${!marked.length && !ghosts.length ? `<div class="cz-empty">No takers yet</div>` : ""}
        </div>
        ${others.length ? `<select class="cz-gm-pick" data-gm-pick="${g.id}"><option value="">Seat someone here…</option>${others.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("")}</select>` : ""}
      </div>`;
  }).join("");
  const rows = party.map(a => {
    const p = state.picks[a.id];
    const status = !p ? `<span class="cz-dim">Deciding…</span>` : p === "out" ? `<span class="cz-dim">Sitting out</span>` : `<b>${escapeHtml(gameName(p))}</b>`;
    return `
      <div class="cz-party-row">
        ${portrait(a.id)}
        <span class="cz-party-name">${escapeHtml(a.name)}</span>
        <span class="cz-party-status">${status}</span>
        ${mine(a.id) && state.purses?.[a.id] !== undefined ? `<span class="cz-purse"><i class="fas fa-coins"></i> ${gp(state.purses[a.id])}</span>` : ""}
        ${mine(a.id) && p !== "out" ? `<button type="button" class="cz-btn ghost small" data-pick="${a.id}" data-game="out">Sit out</button>` : ""}
      </div>`;
  }).join("");
  return `
    <div class="cz-lobby">
      <div class="cz-games">${cards}</div>
      <div class="cz-party">
        <div class="cz-section">The party</div>
        ${rows || `<div class="cz-empty">No party characters.</div>`}
        <div class="cz-note">Table limit ${gp(state.maxBetCp)} · minimum ${gp(MIN_BET_CP)}. Games are played in this order, everyone watching.</div>
      </div>
    </div>`;
}

// ── Tables ───────────────────────────────────────────────────────────────────

function tableHtml(state) {
  const t = state.table;
  const next = state.queue[state.qi + 1];
  const watching = !t.players.some(mine);
  const head = `
    <div class="cz-table-head">
      <span class="cz-phase">${phaseText(t)}</span>
      ${watching ? `<span class="cz-watch"><i class="fas fa-eye"></i> Watching</span>` : ""}
      ${next ? `<span class="cz-next">Up next: ${escapeHtml(gameName(next))}</span>` : ""}
    </div>`;
  const body = t.game === "blackjack" ? blackjackHtml(state, t) : t.game === "roulette" ? rouletteHtml(state, t) : lizardsHtml(state, t);
  return head + body + resultsHtml(state, t);
}

function phaseText(t) {
  const waiting = Object.entries(t.seats).filter(([, s]) => s.status === "betting").map(([id]) => nameOf(id));
  switch (t.phase) {
    case "betting": return waiting.length ? `Place your bets — waiting on ${escapeHtml(waiting.join(", "))}` : "Bets are in";
    case "dealing": return "Dealing…";
    case "insurance": return "Dealer shows an ace — insurance?";
    case "playing": return t.turn ? `${escapeHtml(nameOf(t.turn.actorId))} to play${t.seats[t.turn.actorId].hands.length > 1 ? ` (hand ${t.turn.hand + 1})` : ""}` : "";
    case "dealer": return "Dealer plays…";
    case "spinning": return "No more bets — the wheel is spinning";
    case "racing": return "And they're off!";
    case "done": return t.results?.empty ? "Everyone sat this one out" : "Round over";
    default: return "";
  }
}

function resultsHtml(state, t) {
  if (t.phase !== "done" || !t.results?.lines?.length) return "";
  return `<div class="cz-results">${t.results.lines.map(l => {
    const net = l.returnCp - l.stakeCp;
    return `<div class="cz-result ${net > 0 ? "win" : net < 0 ? "loss" : "even"}">${portrait(l.actorId)}<span class="cz-result-name">${escapeHtml(nameOf(l.actorId))}</span><span class="cz-result-detail">${escapeHtml(l.detail)}</span><span class="cz-result-net">${signed(net)}</span></div>`;
  }).join("")}</div>`;
}

function seatHead(state, id, s, extra = "") {
  const purse = mine(id) && state.purses?.[id] !== undefined ? `<span class="cz-purse"><i class="fas fa-coins"></i> ${gp(state.purses[id])}</span>` : "";
  const status = s.status === "betting" ? `<span class="cz-dim">betting…</span>` : s.status === "out" ? `<span class="cz-dim">sitting out</span>` : "";
  return `<div class="cz-seat-head">${portrait(id)}<span class="cz-seat-name">${escapeHtml(nameOf(id))}</span>${status}${extra}${purse}</div>`;
}

/** Who this client is betting for on a shared board (roulette / lizards). */
function bettingAs(t) {
  const ids = t.players.filter(id => mine(id) && t.seats[id]?.status === "betting");
  if (!ids.includes(draft.as)) draft.as = ids[0] ?? null;
  return ids;
}
function asPicker(t, ids) {
  if (ids.length < 2) return "";
  return `<label class="cz-as">Betting for <select data-as>${ids.map(id => `<option value="${id}"${id === draft.as ? " selected" : ""}>${escapeHtml(nameOf(id))}</option>`).join("")}</select></label>`;
}

// Blackjack ───────────────────────────────────────────────────────────────────

function cardHtml(card, i) {
  const fresh = !seenCards.has(card.id);
  if (fresh) seenCards.add(card.id);
  if (card.hidden) { seenHidden.add(card.id); return `<span class="cz-card back${fresh ? " deal" : ""}" data-card="${card.id}"></span>`; }
  const flip = seenHidden.delete(card.id);
  const r = R.rankOf(card.c), s = R.suitOf(card.c);
  const red = s === "H" || s === "D";
  return `<span class="cz-card${red ? " red" : ""}${fresh ? " deal" : ""}${flip ? " flip" : ""}" data-card="${card.id}"><span class="cz-card-rank">${RANK[r] ?? r}</span><span class="cz-card-suit">${SUIT[s]}</span><span class="cz-card-pip">${SUIT[s]}</span></span>`;
}

function totalText(cards) {
  if (cards.some(c => c.hidden)) return R.handTotal(cards.filter(c => !c.hidden)).total + " + ?";
  const { total, soft } = R.handTotal(cards);
  if (cards.length === 2 && total === 21) return "Blackjack";
  return total > 21 ? `Bust (${total})` : `${soft && total < 21 ? "soft " : ""}${total}`;
}

function blackjackHtml(state, t) {
  const dealer = `
    <div class="cz-dealer">
      <div class="cz-dealer-label">Dealer ${t.dealer.cards.length ? `<span class="cz-total">${totalText(t.dealer.cards)}</span>` : ""}</div>
      <div class="cz-hand">${t.dealer.cards.map(cardHtml).join("") || `<span class="cz-card slot"></span><span class="cz-card slot"></span>`}</div>
      <div class="cz-shoe" title="Cards left in the shoe"><i class="fas fa-layer-group"></i> ${t.shoeLeft}</div>
      <div class="cz-felt-rules">Blackjack pays 3 to 2 · Dealer stands on 17 · Insurance pays 2 to 1</div>
    </div>`;
  const seats = t.players.map(id => {
    const s = t.seats[id];
    const myTurn = t.phase === "playing" && t.turn?.actorId === id;
    const hands = (s.hands ?? []).map((h, i) => {
      const active = myTurn && t.turn.hand === i;
      const res = h.result ? `<span class="cz-hand-result ${h.result}">${{ blackjack: "Blackjack!", win: "Win", push: "Push", lose: "Lose", bust: "Bust" }[h.result]}</span>` : "";
      return `
        <div class="cz-bj-hand${active ? " active" : ""}">
          <div class="cz-hand">${h.cards.map(cardHtml).join("")}</div>
          <div class="cz-hand-foot">${h.cards.length ? `<span class="cz-total">${totalText(h.cards)}</span>` : ""}<span class="cz-stake">${coinHtml(h.betCp)}${h.doubled ? " doubled" : ""}</span>${res}</div>
        </div>`;
    }).join("");
    const ins = s.insuranceCp ? `<div class="cz-ins">Insurance ${gp(s.insuranceCp)}</div>` : s.insurance === false && t.phase === "insurance" ? `<div class="cz-ins cz-dim">No insurance</div>` : "";
    return `<div class="cz-seat${myTurn ? " turn" : ""}${s.status === "out" ? " out" : ""}">${seatHead(state, id, s)}${hands}${ins}${blackjackControls(state, t, id, s)}</div>`;
  }).join("");
  return `<div class="cz-felt cz-bj">${dealer}<div class="cz-seats">${seats}</div></div>`;
}

function blackjackControls(state, t, id, s) {
  if (!mine(id)) return "";
  if (t.phase === "betting" && s.status === "betting") {
    const bet = draft.bj[id] ?? 0;
    return `
      <div class="cz-controls">
        ${stakeHtml(state, `bj:${id}`, bet)}
        <div class="cz-row"><button type="button" class="cz-btn primary" data-bj-bet="${id}"${bet >= MIN_BET_CP ? "" : " disabled"}>Place bet${bet ? ` (${gp(bet)})` : ""}</button>
          <button type="button" class="cz-btn ghost" data-sitout="${id}">Sit out</button></div>
      </div>`;
  }
  if (t.phase === "insurance" && s.status === "in" && s.insurance === null) {
    const cost = Math.floor((s.hands[0]?.betCp ?? 0) / 2);
    return `<div class="cz-controls"><div class="cz-row">
      <button type="button" class="cz-btn primary" data-act="insure" data-take="1" data-actor="${id}">Insure (${gp(cost)})</button>
      <button type="button" class="cz-btn" data-act="insure" data-take="0" data-actor="${id}">No thanks</button></div></div>`;
  }
  if (t.phase === "playing" && t.turn?.actorId === id) {
    const hand = s.hands[t.turn.hand];
    return `<div class="cz-controls"><div class="cz-row">
      <button type="button" class="cz-btn primary" data-act="hit" data-actor="${id}">Hit</button>
      <button type="button" class="cz-btn" data-act="stand" data-actor="${id}">Stand</button>
      <button type="button" class="cz-btn" data-act="double" data-actor="${id}"${R.canDouble(hand) ? "" : " disabled"}>Double (${gp(hand.betCp)})</button>
      <button type="button" class="cz-btn" data-act="split" data-actor="${id}"${R.canSplit(hand, s.hands.length) ? "" : " disabled"}>Split (${gp(hand.betCp)})</button>
    </div></div>`;
  }
  return "";
}

// Roulette ─────────────────────────────────────────────────────────────────────

function rouletteHtml(state, t) {
  const ids = bettingAs(t);
  const placed = {};   // key → [{ id, cp, draft }]
  const add = (b, id, isDraft) => (placed[R.rouletteKey(b)] ??= []).push({ id, cp: b.cp, draft: isDraft, won: b.returnCp > 0 });
  for (const id of t.players) for (const b of t.seats[id].bets ?? []) add(b, id, false);
  for (const [id, bets] of Object.entries(draft.roulette)) if (t.seats[id]?.status === "betting") for (const b of bets) add(b, id, true);
  const colourIdx = Object.fromEntries(t.players.map((id, i) => [id, i % 6]));
  const chipsOn = (key) => (placed[key] ?? []).map(p => `<span class="cz-dot p${colourIdx[p.id]}${p.draft ? " draft" : ""}${p.won ? " won" : ""}" title="${escapeHtml(nameOf(p.id))}: ${gp(p.cp)}">${+(p.cp / 100).toFixed(2)}</span>`).join("");
  const win = t.phase === "done" ? t.results?.number : null;
  const cell = (b, label, cls = "") => {
    const key = R.rouletteKey(b);
    const hit = win !== null && win !== undefined && R.rouletteWins(b, win);
    return `<button type="button" class="cz-cell ${cls}${hit ? " hit" : ""}" data-rb='${JSON.stringify(b)}' ${ids.length ? "" : "disabled"}><span class="cz-cell-label">${label}</span><span class="cz-cell-chips">${chipsOn(key)}</span></button>`;
  };
  let grid = "";
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 12; col++) {
      const n = col * 3 + (3 - row);
      grid += cell({ type: "n", n }, n, `num ${R.colourOf(n)}`);
    }
    grid += cell({ type: "column", k: 3 - row }, "2:1", "colbet");
  }
  const board = `
    <div class="cz-board-wrap">
      <div class="cz-rboard">
        ${cell({ type: "n", n: 0 }, "0", "num green zero")}
        <div class="cz-rgrid">${grid}</div>
        <div class="cz-dozens">${[1, 2, 3].map(k => cell({ type: "dozen", k }, ["1st 12", "2nd 12", "3rd 12"][k - 1], "outside")).join("")}</div>
        <div class="cz-evens">${cell({ type: "low" }, "1–18", "outside")}${cell({ type: "even" }, "Even", "outside")}${cell({ type: "red" }, "<span class='cz-diamond red'></span>", "outside")}${cell({ type: "black" }, "<span class='cz-diamond black'></span>", "outside")}${cell({ type: "odd" }, "Odd", "outside")}${cell({ type: "high" }, "19–36", "outside")}</div>
      </div>
    </div>`;
  const mineBetting = ids.length > 0;
  const myDraft = draft.roulette[draft.as] ?? [];
  const draftTotal = myDraft.reduce((a, b) => a + b.cp, 0);
  const controls = mineBetting ? `
    <div class="cz-controls">
      ${asPicker(t, ids)}
      ${stakeHtml(state, "stake", draft.stake, `Click the board to put ${draft.stake ? gp(draft.stake) : "your stake"} down; right-click to take it back.`)}
      <div class="cz-row">
        <button type="button" class="cz-btn primary" data-rl-place${draftTotal ? "" : " disabled"}>Place bets (${gp(draftTotal)})</button>
        <button type="button" class="cz-btn ghost" data-rl-clear${draftTotal ? "" : " disabled"}>Clear my bets</button>
        <button type="button" class="cz-btn ghost" data-sitout="${draft.as}">Sit out</button>
      </div>
    </div>` : "";
  const seats = t.players.map(id => {
    const s = t.seats[id];
    const total = (s.bets ?? []).reduce((a, b) => a + b.cp, 0);
    return `<div class="cz-seat mini${s.status === "out" ? " out" : ""}">${seatHead(state, id, s, `<span class="cz-dot p${colourIdx[id]} key"></span>`)}${total ? `<div class="cz-seat-bets">${(s.bets ?? []).map(b => `<span class="cz-betpill${b.returnCp > 0 ? " won" : ""}">${escapeHtml(R.rouletteLabel(b))} · ${gp(b.cp)}</span>`).join("")}</div>` : ""}</div>`;
  }).join("");
  const hist = (t.history ?? []).map(n => `<span class="cz-hist ${R.colourOf(n)}">${n}</span>`).join("");
  return `
    <div class="cz-felt cz-roulette">
      <div class="cz-wheel-col">
        <div data-keep-slot="wheel:${t.round}"></div>
        <div class="cz-history">${hist ? `<span class="cz-dim">Last spins</span>${hist}` : ""}</div>
      </div>
      <div class="cz-board-col">${board}${controls}</div>
    </div>
    <div class="cz-seats row">${seats}</div>`;
}

const POCKET = 360 / 37;
function wheelSvg() {
  const R1 = 120, R2 = 92, R3 = 62;
  const pt = (r, deg) => { const a = (deg - 90) * Math.PI / 180; return [r * Math.cos(a), r * Math.sin(a)]; };
  let wedges = "", labels = "";
  R.WHEEL.forEach((n, i) => {
    const a0 = i * POCKET - POCKET / 2, a1 = a0 + POCKET;
    const [x0, y0] = pt(R1, a0), [x1, y1] = pt(R1, a1), [x2, y2] = pt(R2 - 18, a1), [x3, y3] = pt(R2 - 18, a0);
    const fill = n === 0 ? "#1e7a46" : R.REDS.has(n) ? "#a3241f" : "#141414";
    wedges += `<path d="M${x0},${y0} A${R1},${R1} 0 0 1 ${x1},${y1} L${x2},${y2} A${R2 - 18},${R2 - 18} 0 0 0 ${x3},${y3} Z" fill="${fill}" stroke="#c9a84c" stroke-width=".6"/>`;
    const [lx, ly] = pt(R1 - 12, i * POCKET);
    labels += `<text x="${lx}" y="${ly}" transform="rotate(${i * POCKET} ${lx} ${ly})" text-anchor="middle" dominant-baseline="central">${n}</text>`;
  });
  return `
    <svg class="cz-wheel" viewBox="-135 -135 270 270">
      <circle r="132" fill="#3b2412" stroke="#c9a84c" stroke-width="3"/>
      <circle r="124" fill="#5a3818"/>
      <g class="cz-wheel-rot">
        ${wedges}<g class="cz-wheel-nums">${labels}</g>
        <circle r="${R2 - 18}" fill="#6b4420" stroke="#c9a84c" stroke-width="1.5"/>
        <circle r="${R3 - 20}" fill="#8a5a2a" stroke="#e8c65a" stroke-width="1"/>
        ${[0, 90, 180, 270].map(d => `<rect x="-3" y="-${R3 - 6}" width="6" height="${(R3 - 6) * 2}" rx="3" fill="#c9a84c" transform="rotate(${d / 2})"/>`).join("")}
        <circle r="9" fill="#e8c65a"/>
      </g>
      <g class="cz-ball-rot"><circle cx="0" cy="-${R1 - 26}" r="6" fill="#f4f1ea" stroke="#999" stroke-width=".8"/></g>
      <path d="M0,-118 L-8,-134 L8,-134 Z" fill="#e8c65a" stroke="#3b2412" stroke-width="1.5"/>
    </svg>
    <div class="cz-wheel-result"></div>`;
}

// Lizards ─────────────────────────────────────────────────────────────────────

function lizardsHtml(state, t) {
  const ids = bettingAs(t);
  const myDraft = draft.lizards[draft.as] ?? {};
  const backers = (lid) => t.players.flatMap(id => (t.seats[id].bets ?? []).filter(b => b.lizard === lid).map(b => ({ id, cp: b.cp })));
  const placing = t.phase === "done" ? Object.fromEntries((t.results?.order ?? []).map((id, i) => [id, i + 1])) : {};
  const runners = t.field.map((L, i) => {
    const mineCp = myDraft[L.id] ?? 0;
    const b = backers(L.id);
    const place = placing[L.id];
    return `
      <div class="cz-runner${place === 1 ? " winner" : ""}" style="--liz:${L.colour}">
        <span class="cz-saddle">${i + 1}</span>
        <div class="cz-runner-main">
          <div class="cz-runner-name">${escapeHtml(L.name)}${place ? ` <span class="cz-place p${place}">${["1st", "2nd", "3rd", "4th"][place - 1]}</span>` : ""}</div>
          <div class="cz-runner-blurb">${escapeHtml(L.blurb)}</div>
          <div class="cz-form" title="Last races, most recent on the right">Form ${(L.form ?? []).map(f => `<b class="f${f}">${f}</b>`).join("") || "—"}</div>
          ${b.length ? `<div class="cz-backers">${b.map(x => `<span class="cz-betpill">${escapeHtml(nameOf(x.id))} ${gp(x.cp)}</span>`).join("")}</div>` : ""}
        </div>
        <div class="cz-odds">${R.oddsText(L.odds)}</div>
        ${ids.length ? `<div class="cz-runner-bet">${mineCp ? `<span class="cz-stake">${coinHtml(mineCp)}</span>` : ""}<button type="button" class="cz-btn small" data-lz-add="${L.id}"${draft.stake ? "" : " disabled"}>＋ ${draft.stake ? gp(draft.stake) : "stake"}</button>${mineCp ? `<button type="button" class="cz-btn small ghost" data-lz-clear="${L.id}">✕</button>` : ""}</div>` : ""}
      </div>`;
  }).join("");
  const draftTotal = Object.values(myDraft).reduce((a, b) => a + b, 0);
  const controls = ids.length ? `
    <div class="cz-controls">
      ${asPicker(t, ids)}
      ${stakeHtml(state, "stake", draft.stake, "Set a stake, then back as many lizards as you like.")}
      <div class="cz-row">
        <button type="button" class="cz-btn primary" data-lz-place${draftTotal ? "" : " disabled"}>Place bets (${gp(draftTotal)})</button>
        <button type="button" class="cz-btn ghost" data-sitout="${draft.as}">Sit out</button>
      </div>
      <div class="cz-note">Odds pay on a win: a 5/2 winner on 10 gp brings back 35 gp.</div>
    </div>` : "";
  const seats = t.players.map(id => {
    const s = t.seats[id];
    return `<div class="cz-seat mini${s.status === "out" ? " out" : ""}">${seatHead(state, id, s)}${(s.bets ?? []).length ? `<div class="cz-seat-bets">${s.bets.map(b => `<span class="cz-betpill${b.returnCp > 0 ? " won" : ""}">${escapeHtml(R.lizardById(b.lizard)?.name ?? "")} · ${gp(b.cp)}</span>`).join("")}</div>` : ""}</div>`;
  }).join("");
  return `
    <div class="cz-felt cz-lizards">
      <div data-keep-slot="track:${t.round}"></div>
      <div class="cz-racecard"><div class="cz-section">Tonight's runners</div>${controls}${runners}</div>
    </div>
    <div class="cz-seats row">${seats}</div>`;
}

/** A racing lizard seen from above, facing right, in its silks colour. */
function lizardSvg(n) {
  return `
    <svg class="cz-liz-svg" viewBox="0 0 72 32" aria-hidden="true">
      <g class="cz-legs-a"><path d="M44 12 L49 3 M30 20 L24 29" /></g>
      <g class="cz-legs-b"><path d="M44 20 L49 29 M30 12 L24 3" /></g>
      <path class="cz-liz-tail" d="M27 13 C18 12 12 6 1 9 C10 10 15 16 27 19 Z"/>
      <ellipse class="cz-liz-skin" cx="36" cy="16" rx="13" ry="6.5"/>
      <path class="cz-liz-skin" d="M47 11.5 C55 10 63 12.5 66 16 C63 19.5 55 22 47 20.5 Z"/>
      <path class="cz-liz-stripe" d="M25 16 L60 16"/>
      <circle cx="58.5" cy="12.6" r="1.5" fill="#111"/><circle cx="58.5" cy="19.4" r="1.5" fill="#111"/>
      <rect x="31" y="11" width="10" height="10" rx="2" class="cz-liz-silk"/>
      <text x="36" y="19.2" text-anchor="middle" class="cz-liz-no">${n}</text>
    </svg>`;
}

function trackHtml(t) {
  const lanes = t.field.map((L, i) => `
    <div class="cz-lane" style="--liz:${L.colour}">
      <span class="cz-lane-no">${i + 1}</span>
      <div class="cz-liz" data-liz="${L.id}" style="left:0%">${lizardSvg(i + 1)}</div>
      <span class="cz-lane-place" data-place="${L.id}"></span>
    </div>`).join("");
  return `<div class="cz-track"><div class="cz-rail"></div>${lanes}<div class="cz-call">${t.phase === "betting" ? "The lizards are in their boxes…" : ""}</div></div>`;
}

// ── Stages that keep running across re-renders ───────────────────────────────

function buildStage(key, state) {
  const el = document.createElement("div");
  el.dataset.keep = key;
  el.className = "cz-stage";
  el.innerHTML = key.startsWith("wheel") ? wheelSvg() : trackHtml(state.table);
  return el;
}

function updateStage(el, state) {
  if (!el || !state.table) return;
  const t = state.table;
  if (t.game === "roulette") return updateWheel(el, t);
  if (t.game === "lizards") return updateTrack(el, t);
}

function updateWheel(el, t) {
  const rot = el.querySelector(".cz-wheel-rot"), ball = el.querySelector(".cz-ball-rot"), out = el.querySelector(".cz-wheel-result");
  if (!t.spin) { out.textContent = ""; return; }
  const idx = R.WHEEL.indexOf(t.spin.result);
  const target = 360 * 5 + (360 - idx * POCKET);
  const showResult = () => { out.innerHTML = `<span class="cz-hist big ${R.colourOf(t.spin.result)}">${t.spin.result}</span>`; };
  if (el.dataset.spun === t.spin.id) { if (t.phase === "done") showResult(); return; }
  el.dataset.spun = t.spin.id;
  if (t.phase !== "spinning") {   // arrived late: just show where it landed
    rot.style.transition = ball.style.transition = "none";
    rot.style.transform = `rotate(${target}deg)`; ball.style.transform = "rotate(0deg)";
    return showResult();
  }
  rot.style.transition = ball.style.transition = "none";
  rot.style.transform = "rotate(0deg)"; ball.style.transform = "rotate(0deg)";
  void rot.getBoundingClientRect();
  const ms = t.spin.ms ?? 7000;
  rot.style.transition = `transform ${ms}ms cubic-bezier(.15,.55,.12,1)`;
  ball.style.transition = `transform ${ms}ms cubic-bezier(.2,.6,.1,1)`;
  rot.style.transform = `rotate(${target}deg)`;
  ball.style.transform = `rotate(${-360 * 8}deg)`;
  out.textContent = "";
}

function updateTrack(el, t) {
  if (!t.race) return;
  const call = el.querySelector(".cz-call");
  const lizEls = Object.fromEntries([...el.querySelectorAll("[data-liz]")].map(x => [x.dataset.liz, x]));
  const ids = t.field.map(L => L.id);
  const placeEls = Object.fromEntries([...el.querySelectorAll("[data-place]")].map(x => [x.dataset.place, x]));
  const showPlace = (id) => {
    const p = t.race.order.indexOf(id) + 1, x = placeEls[id];
    if (!x || x.textContent) return;
    x.textContent = ["1st", "2nd", "3rd", "4th"][p - 1] ?? "";
    x.className = `cz-lane-place shown p${p}`;
  };
  const place = (frame) => ids.forEach((id, i) => {
    const x = lizEls[id];
    // the lizard's nose (70px into its box) reaches the line at 100
    if (x) { x.style.left = `calc((100% - 96px) * ${(frame[i] / 100).toFixed(4)})`; x.classList.toggle("running", frame[i] > 0 && frame[i] < 100); }
    if (frame[i] >= 100) showPlace(id);
  });
  const finalWords = () => {
    const [a, b] = t.race.order;
    const gap = (t.race.times[b] ?? 0) - (t.race.times[a] ?? 0);
    const by = gap < 120 ? "by a nose" : gap < 400 ? "by a length" : gap < 900 ? "comfortably" : "by a country mile";
    return `${escapeHtml(R.lizardById(a)?.name ?? "")} wins ${by}!`;
  };
  if (el.dataset.raced === t.race.id) { if (t.phase === "done") call.innerHTML = finalWords(); return; }
  el.dataset.raced = t.race.id;
  if (t.phase !== "racing") { place(t.race.ticks.at(-1)); call.innerHTML = finalWords(); return; }
  let start = null, leader = null;
  const frame = (now) => {
    start ??= now;   // the first frame's timestamp can be a touch before performance.now()
    const ft = Math.max(0, (now - start) / R.TICK_MS);
    const i = Math.min(t.race.ticks.length - 1, Math.floor(ft));
    const j = Math.min(t.race.ticks.length - 1, i + 1), f = Math.min(1, ft - i);
    const pos = t.race.ticks[i].map((p, k) => p + (t.race.ticks[j][k] - p) * f);
    place(pos);
    const lead = ids[pos.indexOf(Math.max(...pos))];
    if (lead !== leader && ft > 8) {
      leader = lead;
      const name = R.lizardById(lead)?.name ?? "";
      call.textContent = ft > t.race.ticks.length * 0.75 ? `${name} surges ahead!` : leader ? `${name} takes the lead!` : "";
    }
    if (i < t.race.ticks.length - 1) requestAnimationFrame(frame);
    else call.innerHTML = finalWords();
  };
  call.textContent = "And they're off!";
  requestAnimationFrame(frame);
}

// ── Events ───────────────────────────────────────────────────────────────────

function bind(body, state) {
  const t = state.table;
  body.querySelectorAll("[data-gm]").forEach(b => b.addEventListener("click", async () => {
    const type = b.dataset.gm;
    // Closing asks twice, right here (a Foundry dialog would open behind the casino)
    if (type === "close" && !b.classList.contains("armed")) {
      const owed = state.table && state.table.phase !== "done";
      b.classList.add("armed");
      b.innerHTML = `<i class="fas fa-door-closed"></i> Click again to close for everyone${owed ? " (bets handed back)" : ""}`;
      setTimeout(() => { if (b.isConnected && b.classList.contains("armed")) { b.classList.remove("armed"); b.innerHTML = '<i class="fas fa-door-closed"></i> Close the casino'; } }, 4000);
      return;
    }
    b.disabled = true;
    await send({ type });
  }));
  body.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", () => {
    const id = b.dataset.pick, g = b.dataset.game;
    send({ type: "pick", actorId: id, game: state.picks[id] === g && g !== "out" ? null : g });
  }));
  body.querySelectorAll("[data-gm-pick]").forEach(sel => sel.addEventListener("change", () => {
    if (sel.value) send({ type: "pick", actorId: sel.value, game: sel.dataset.gmPick });
  }));
  // Stakes: type an amount or add coins
  body.querySelectorAll("[data-stake-add]").forEach(b => b.addEventListener("click", () => {
    const key = b.dataset.stakeAdd, next = stakeOf(key) + Number(b.dataset.gp) * 100;
    if (next > state.maxBetCp) ui.notifications.warn(`The table limit is ${gp(state.maxBetCp)}.`);
    setStake(key, next, state.maxBetCp);
    renderCasino(last);
  }));
  body.querySelectorAll("[data-stake-clear]").forEach(b => b.addEventListener("click", () => { setStake(b.dataset.stakeClear, 0, state.maxBetCp); renderCasino(last); }));
  body.querySelectorAll("[data-stake]").forEach(input => {
    const key = input.dataset.stake;
    input.addEventListener("input", () => {
      setStake(key, (Number(input.value) || 0) * 100, state.maxBetCp);
      // keep typing: just refresh the blackjack button rather than redrawing everything
      const bet = body.querySelector(`[data-bj-bet="${key.slice(3)}"]`);
      if (bet) { const cp = stakeOf(key); bet.disabled = cp < MIN_BET_CP; bet.textContent = cp ? `Place bet (${gp(cp)})` : "Place bet"; }
    });
    input.addEventListener("change", () => {
      if ((Number(input.value) || 0) * 100 > state.maxBetCp) ui.notifications.warn(`The table limit is ${gp(state.maxBetCp)}.`);
      setStake(key, (Number(input.value) || 0) * 100, state.maxBetCp);
      renderCasino(last);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  });
  body.querySelectorAll("[data-sitout]").forEach(b => b.addEventListener("click", () => send({ type: "sitout", actorId: b.dataset.sitout })));
  body.querySelectorAll("[data-as]").forEach(sel => sel.addEventListener("change", () => { draft.as = sel.value; renderCasino(last); }));
  // Blackjack
  body.querySelectorAll("[data-bj-bet]").forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.bjBet;
    b.disabled = true;
    if (await send({ type: "bet", actorId: id, cp: draft.bj[id] })) delete draft.bj[id];
    else b.disabled = false;
  }));
  body.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => {
    body.querySelectorAll("[data-act]").forEach(x => { x.disabled = true; });
    send({ type: b.dataset.act, actorId: b.dataset.actor, take: b.dataset.take === "1" }).then(ok => { if (!ok) renderCasino(last); });
  }));
  // Roulette
  body.querySelectorAll("[data-rb]").forEach(c => {
    const bet = JSON.parse(c.dataset.rb);
    const key = R.rouletteKey(bet);
    c.addEventListener("click", () => {
      if (!draft.as) return;
      if (draft.stake < MIN_BET_CP) return ui.notifications.warn("Set your stake first (at least 1 gp).");
      const list = draft.roulette[draft.as] ??= [];
      const total = list.reduce((a, b) => a + b.cp, 0);
      if (total + draft.stake > state.maxBetCp) return ui.notifications.warn(`The table limit is ${gp(state.maxBetCp)} a spin.`);
      const existing = list.find(b => R.rouletteKey(b) === key);
      if (existing) existing.cp += draft.stake; else list.push({ ...bet, cp: draft.stake });
      renderCasino(last);
    });
    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const list = draft.roulette[draft.as];
      const existing = list?.find(b => R.rouletteKey(b) === key);
      if (!existing) return;
      existing.cp -= Math.max(MIN_BET_CP, draft.stake);
      if (existing.cp < MIN_BET_CP) list.splice(list.indexOf(existing), 1);
      renderCasino(last);
    });
  });
  body.querySelector("[data-rl-clear]")?.addEventListener("click", () => { delete draft.roulette[draft.as]; renderCasino(last); });
  body.querySelector("[data-rl-place]")?.addEventListener("click", async (e) => {
    const id = draft.as;
    e.currentTarget.disabled = true;
    if (await send({ type: "bets", actorId: id, bets: draft.roulette[id] ?? [] })) delete draft.roulette[id];
    renderCasino(last);
  });
  // Lizards
  body.querySelectorAll("[data-lz-add]").forEach(b => b.addEventListener("click", () => {
    if (!draft.as) return;
    const d = draft.lizards[draft.as] ??= {};
    const total = Object.values(d).reduce((a, x) => a + x, 0);
    if (draft.stake < MIN_BET_CP) return ui.notifications.warn("Set your stake first (at least 1 gp).");
    if (total + draft.stake > state.maxBetCp) return ui.notifications.warn(`The table limit is ${gp(state.maxBetCp)} a race.`);
    d[b.dataset.lzAdd] = (d[b.dataset.lzAdd] ?? 0) + draft.stake;
    renderCasino(last);
  }));
  body.querySelectorAll("[data-lz-clear]").forEach(b => b.addEventListener("click", () => { delete draft.lizards[draft.as]?.[b.dataset.lzClear]; renderCasino(last); }));
  body.querySelector("[data-lz-place]")?.addEventListener("click", async (e) => {
    const id = draft.as;
    e.currentTarget.disabled = true;
    const bets = Object.entries(draft.lizards[id] ?? {}).map(([lizard, cp]) => ({ lizard, cp }));
    if (await send({ type: "bets", actorId: id, bets })) delete draft.lizards[id];
    renderCasino(last);
  });
}
