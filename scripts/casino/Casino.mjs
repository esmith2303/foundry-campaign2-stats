/**
 * The casino: a night of blackjack, roulette and lizard races.
 *
 * Flow
 *   Lobby  — the GM opens the casino; everyone gets the window. Each player
 *            marks the game their character wants (or sits out).
 *   Tables — the GM starts the night and the chosen games are played one after
 *            another, in lobby order, with everyone watching. Characters who
 *            picked the same game share the table, each with their own bets.
 *            After each round the GM deals another, moves to the next game or
 *            goes back to the lobby.
 *
 * The primary GM's client is the dealer: it holds the real state (including
 * the shoe and the dealer's hole card), takes every bet and action one at a
 * time, moves the money on the character sheets, and broadcasts what everyone
 * may see. Players' clicks reach it through runAsGM ("casino.act"). Each round
 * ends with a chat receipt (flags.casinoResult) that the stats upload reads.
 */
import { MODULE_ID, escapeHtml, partyCharacters, assertOwns } from "../abilities/shared.mjs";
import { registerGmAction, runAsGM, isPrimaryGM } from "../QuickActions.mjs";
import { walletCp, formatCp, pay, receive } from "../shop/currency.mjs";
import * as R from "./rules.mjs";
import { renderCasino, closeCasinoWindow, showCasinoWindow } from "./view.mjs";

const SOCKET = `module.${MODULE_ID}`;
export const CASINO_TOOL = "stats-casino";
const ACT = "casino.act";
export const GAMES = [
  { id: "blackjack", name: "Blackjack", icon: "fas fa-diamond", blurb: "Beat the dealer to 21. Blackjack pays 3 to 2." },
  { id: "roulette", name: "Roulette", icon: "fas fa-circle-dot", blurb: "Single zero. Numbers pay 35 to 1." },
  { id: "lizards", name: "Lizard Races", icon: "fas fa-flag-checkered", blurb: "Four lizards, one winner. Back your favourite." },
];
export const gameName = (id) => GAMES.find(g => g.id === id)?.name ?? id;

export const DEAL_MS = 320;          // between cards
export const DEALER_MS = 850;        // between the dealer's cards
export const SPIN_MS = 7000;         // roulette wheel
export const MIN_BET_CP = 100;       // 1 gp

const setting = (key, fallback) => { try { return game.settings.get(MODULE_ID, key) ?? fallback; } catch { return fallback; } };
export const casinoName = () => String(setting("casinoName", "") || "The Lucky Lizard");
export const maxBetCp = () => Math.max(MIN_BET_CP, Math.round((Number(setting("casinoMaxBet", 100)) || 100) * 100));

// ── GM-side state ────────────────────────────────────────────────────────────

let S = null;            // full state (GM only)
let pub = null;          // last public state (everyone)
let timers = [];
let queue = Promise.resolve();
const inTurn = (fn) => { const t = queue.then(fn); queue = t.catch(() => {}); return t; };

export function registerCasino() {
  registerGmAction(ACT, (payload, user) => inTurn(() => gmAct(payload, user)));
  game.socket.on(SOCKET, (data) => {
    if (data?.action === "casino.state") applyState(data.state);
    else if (data?.action === "casino.hello" && isPrimaryGM() && S?.open) broadcast();
  });
  // GM: pick up a night that was running before a reload
  if (isPrimaryGM()) {
    const saved = setting("casinoSave", null);
    if (saved?.open) { S = saved; resume(); broadcast(); }
  } else {
    game.socket.emit(SOCKET, { action: "casino.hello" });
  }
}

export function casinoTool() {
  return { name: CASINO_TOOL, title: "Casino", icon: "fas fa-dice", button: true, onChange: () => {} };
}

/** GM's toolbar button: open the casino, or bring its window back. */
export function openCasino() {
  if (S?.open || pub?.open) return showCasinoWindow(pub);
  runAsGM(ACT, { type: "open" }).catch(e => ui.notifications.error(e.message));
}

/** Client: send an action to the dealer (the GM's client). Resolves true if it went through. */
export function act(payload) {
  return runAsGM(ACT, payload).then(() => true, e => { ui.notifications.warn(e.message); return false; });
}

function applyState(state) {
  pub = state;
  if (!state?.open) return closeCasinoWindow();
  renderCasino(state);
}

function save() {
  try { game.settings.set(MODULE_ID, "casinoSave", S?.open ? S : null); } catch {}
}

function broadcast() {
  if (!S) return;
  S.v = (S.v || 0) + 1;
  const state = publicState(S);
  game.socket.emit(SOCKET, { action: "casino.state", state });
  applyState(state);
  save();
}

/** What players may see: no shoe, no hole card until it's turned over. */
function publicState(s) {
  const p = foundry.utils.deepClone(s);
  delete p.shoes;
  if (p.table) {
    delete p.table.shoe;
    if (p.table.game === "blackjack" && p.table.dealer?.holeHidden && p.table.dealer.cards[1]) {
      p.table.dealer.cards[1] = { id: p.table.dealer.cards[1].id, hidden: true };
    }
  }
  return p;
}

const later = (ms, fn) => { const t = setTimeout(() => { timers = timers.filter(x => x !== t); inTurn(fn).catch(e => console.warn(`${MODULE_ID} | casino`, e)); }, ms); timers.push(t); };
const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

// ── Money ────────────────────────────────────────────────────────────────────

function purse(actorId) { return walletCp(game.actors.get(actorId)?.system?.currency); }
function notePurses(ids) { for (const id of ids) S.purses[id] = purse(id); }

async function take(actorId, cp) {
  const actor = game.actors.get(actorId);
  if (!actor) throw new Error("Character not found.");
  const after = pay(actor.system?.currency, cp);
  if (!after) throw new Error(`${actor.name} can't cover ${formatCp(cp)} (has ${formatCp(purse(actorId))}).`);
  await actor.update({ "system.currency": after });
  S.purses[actorId] = walletCp(after);
}
async function give(actorId, cp) {
  if (!(cp > 0)) return;
  const actor = game.actors.get(actorId);
  if (!actor) return;
  const after = receive(actor.system?.currency, cp);
  await actor.update({ "system.currency": after });
  S.purses[actorId] = walletCp(after);
}

/** Money on the table that hasn't been settled yet, per character. */
function outstanding(t) {
  const out = {};
  if (!t || t.phase === "done") return out;
  for (const [id, seat] of Object.entries(t.seats ?? {})) {
    let cp = 0;
    if (t.game === "blackjack") cp = (seat.hands ?? []).reduce((a, h) => a + (h.betCp || 0), 0) + (seat.insuranceCp || 0);
    else cp = (seat.bets ?? []).reduce((a, b) => a + (b.cp || 0), 0);
    if (cp > 0) out[id] = cp;
  }
  return out;
}
async function refundTable() {
  const owed = outstanding(S?.table);
  for (const [id, cp] of Object.entries(owed)) await give(id, cp);
  if (Object.keys(owed).length) {
    const lines = Object.entries(owed).map(([id, cp]) => `${escapeHtml(game.actors.get(id)?.name ?? "Someone")}: ${formatCp(cp)}`).join("<br>");
    await ChatMessage.create({ speaker: { alias: casinoName() }, content: `<div class="skill-check-card qa-card"><header class="card-header"><span class="icon"><i class="fas fa-coins"></i></span><div class="title-block"><div class="skill-name">${escapeHtml(casinoName())}</div><div class="ability-tag">Round called off — stakes returned</div></div></header><section class="card-content"><div class="group-summary">${lines}</div></section></div>` });
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

const GM_ONLY = new Set(["open", "start", "again", "next", "lobby", "close", "force"]);

async function gmAct(p = {}, user) {
  const type = p.type;
  if (GM_ONLY.has(type) && !user?.isGM) throw new Error("Only the GM can do that.");
  if (type === "open") return openNight();
  if (!S?.open) throw new Error("The casino is closed.");
  if (type === "close") return closeNight();
  if (type === "lobby") return toLobby();
  if (type === "start") return startNight();
  if (type === "again") return newRound();
  if (type === "next") return nextGame();
  if (type === "force") return force();

  // Everything else is for one character
  const actor = game.actors.get(p.actorId);
  if (!actor) throw new Error("Character not found.");
  assertOwns(actor, user);
  if (type === "pick") return pick(actor, p.game);

  const t = S.table;
  if (S.phase !== "table" || !t) throw new Error("No game is running.");
  const seat = t.seats[actor.id];
  if (!seat) throw new Error(`${actor.name} isn't at this table.`);
  if (type === "sitout") {
    if (seat.status !== "betting") throw new Error("Bets are already in.");
    seat.status = "out";
    broadcast();
    return checkBetsIn();
  }
  if (t.game === "blackjack") return blackjackAct(t, seat, actor, p);
  if (t.game === "roulette") return rouletteBets(t, seat, actor, p);
  if (t.game === "lizards") return lizardBets(t, seat, actor, p);
}

// ── Lobby and the night ──────────────────────────────────────────────────────

function openNight() {
  clearTimers();
  S = { open: true, v: 0, name: casinoName(), maxBetCp: maxBetCp(), phase: "lobby", picks: {}, queue: [], qi: 0, purses: {}, table: null,
        shoes: {}, history: [], form: null, nightId: foundry.utils.randomID(), nightNets: {} };
  notePurses(partyCharacters().map(a => a.id));
  broadcast();
}

async function closeNight() {
  clearTimers();
  await refundTable();
  await postNightTally();
  S.open = false;
  broadcast();
  S = null;
  save();
}

async function toLobby() {
  clearTimers();
  await refundTable();
  S.phase = "lobby"; S.table = null; S.picks = {}; S.queue = []; S.qi = 0;
  notePurses(partyCharacters().map(a => a.id));
  broadcast();
}

function pick(actor, gameId) {
  if (S.phase !== "lobby") throw new Error("The tables are already open.");
  if (!partyCharacters().some(a => a.id === actor.id)) throw new Error(`${actor.name} isn't in the party.`);
  if (gameId && gameId !== "out" && !GAMES.some(g => g.id === gameId)) throw new Error("Unknown game.");
  if (gameId) S.picks[actor.id] = gameId; else delete S.picks[actor.id];
  broadcast();
}

function startNight() {
  if (S.phase !== "lobby") throw new Error("The night has already started.");
  S.queue = GAMES.map(g => g.id).filter(id => Object.values(S.picks).includes(id));
  if (!S.queue.length) throw new Error("Nobody has picked a game yet.");
  S.qi = 0;
  setTable(S.queue[0]);
  broadcast();
}

function nextGame() {
  if (S.table && S.table.phase !== "done") throw new Error("Finish this round first.");
  S.qi++;
  if (S.qi >= S.queue.length) return toLobby();
  setTable(S.queue[S.qi]);
  broadcast();
}

function newRound() {
  if (!S.table || S.table.phase !== "done") throw new Error("Finish this round first.");
  setTable(S.table.game, S.table.round + 1);
  broadcast();
}

function setTable(gameId, round = 1) {
  clearTimers();
  const players = Object.entries(S.picks).filter(([, g]) => g === gameId).map(([id]) => id);
  notePurses(players);
  const seats = Object.fromEntries(players.map(id => [id, { status: "betting" }]));
  const t = { game: gameId, players, round, phase: "betting", seats, results: null };
  if (gameId === "blackjack") {
    Object.values(seats).forEach(s => { s.hands = []; s.insuranceCp = 0; s.insurance = null; });
    t.dealer = { cards: [], holeHidden: true };
    t.turn = null; t.nextCardId = 1;
    const shoe = S.shoes.blackjack;
    t.shoe = shoe && !R.needsReshuffle(shoe) ? shoe : R.newShoe();
    t.shuffled = t.shoe !== shoe;
    t.shoeLeft = t.shoe.length;
  } else if (gameId === "roulette") {
    Object.values(seats).forEach(s => { s.bets = []; });
    t.spin = null;
    t.history = S.history ?? [];
  } else if (gameId === "lizards") {
    Object.values(seats).forEach(s => { s.bets = []; });
    S.form ??= foundry.utils.deepClone(setting("casinoLizards", null)?.form ?? R.seedForm());
    const field = R.drawField(4);
    const chances = R.winChances(field, 3000);
    t.field = field.map(L => ({ id: L.id, name: L.name, colour: L.colour, blurb: L.blurb, odds: R.oddsFor(chances[L.id]), form: S.form[L.id] ?? [] }));
    t.race = null;
  }
  S.table = t;
  S.phase = "table";
}

/** GM: hurry the table along (players who haven't bet sit out; undecided insurance is declined; the current hand stands). */
async function force() {
  const t = S.table;
  if (!t) return;
  if (t.phase === "betting") {
    for (const s of Object.values(t.seats)) if (s.status === "betting") s.status = "out";
    broadcast();
    return checkBetsIn();
  }
  if (t.game === "blackjack" && t.phase === "insurance") {
    for (const s of Object.values(t.seats)) if (s.status === "in" && s.insurance === null) s.insurance = false;
    return afterInsurance(t);
  }
  if (t.game === "blackjack" && t.phase === "playing" && t.turn) {
    const hand = t.seats[t.turn.actorId].hands[t.turn.hand];
    hand.done = true;
    return advanceTurn(t);
  }
}

async function checkBetsIn() {
  const t = S.table;
  if (!t || t.phase !== "betting") return;
  if (Object.values(t.seats).some(s => s.status === "betting")) return;
  const playing = Object.entries(t.seats).filter(([, s]) => s.status === "in").map(([id]) => id);
  if (!playing.length) {
    t.phase = "done";
    t.results = { empty: true, lines: [] };
    return broadcast();
  }
  if (t.game === "blackjack") return dealBlackjack(t);
  if (t.game === "roulette") return spinRoulette(t);
  if (t.game === "lizards") return runRace(t);
}

/** Resume after the GM's client reloaded mid-round. */
function resume() {
  const t = S.table;
  if (!t) return;
  if (t.game === "blackjack") {
    if (t.phase === "dealing") { t.dealQueue = null; finishDealInstantly(t); }
    else if (t.phase === "dealer") later(DEALER_MS, () => dealerStep(t));
  } else if (t.game === "roulette" && t.phase === "spinning") later(500, () => settleRoulette(t));
  else if (t.game === "lizards" && t.phase === "racing") later(500, () => settleRace(t));
}

// ── Blackjack ────────────────────────────────────────────────────────────────

function draw(t) {
  if (!t.shoe.length) { t.shoe = R.newShoe(); t.shuffled = true; }
  const c = t.shoe.pop();
  t.shoeLeft = t.shoe.length;
  return { c, id: t.nextCardId++ };
}

async function blackjackAct(t, seat, actor, p) {
  const type = p.type;
  if (type === "bet") {
    if (t.phase !== "betting" || seat.status !== "betting") throw new Error("Bets are already in.");
    const cp = Math.round(Number(p.cp));
    if (!(cp >= MIN_BET_CP)) throw new Error(`The minimum bet is ${formatCp(MIN_BET_CP)}.`);
    if (cp > S.maxBetCp) throw new Error(`The table limit is ${formatCp(S.maxBetCp)}.`);
    await take(actor.id, cp);
    seat.status = "in";
    seat.hands = [{ cards: [], betCp: cp }];
    broadcast();
    return checkBetsIn();
  }
  if (type === "insure") {
    if (t.phase !== "insurance" || seat.status !== "in" || seat.insurance !== null) throw new Error("Not now.");
    if (p.take) {
      const cp = Math.floor(seat.hands[0].betCp / 2);
      await take(actor.id, cp);
      seat.insuranceCp = cp;
      seat.insurance = true;
    } else seat.insurance = false;
    broadcast();
    if (Object.values(t.seats).every(s => s.status !== "in" || s.insurance !== null)) return afterInsurance(t);
    return;
  }
  // Hit / stand / double / split: only on your turn
  if (t.phase !== "playing" || t.turn?.actorId !== actor.id) throw new Error("It isn't your turn.");
  const hand = seat.hands[t.turn.hand];
  if (type === "hit") {
    hand.cards.push(draw(t));
    const total = R.handTotal(hand.cards).total;
    if (total >= 21) hand.done = true;
  } else if (type === "stand") {
    hand.done = true;
  } else if (type === "double") {
    if (!R.canDouble(hand)) throw new Error("You can only double on your first two cards.");
    await take(actor.id, hand.betCp);
    hand.betCp *= 2;
    hand.doubled = true;
    hand.cards.push(draw(t));
    hand.done = true;
  } else if (type === "split") {
    if (!R.canSplit(hand, seat.hands.length)) throw new Error("That hand can't be split.");
    await take(actor.id, hand.betCp);
    const aces = R.rankOf(hand.cards[0].c) === "A";
    const second = { cards: [hand.cards.pop()], betCp: hand.betCp, split: true, splitAces: aces };
    hand.split = true; hand.splitAces = aces;
    seat.hands.splice(t.turn.hand + 1, 0, second);
    hand.cards.push(draw(t));
    second.cards.push(draw(t));
    for (const h of [hand, second]) if (aces || R.handTotal(h.cards).total === 21) h.done = true;
  } else throw new Error("Unknown move.");
  broadcast();
  if (hand.done) return advanceTurn(t);
}

/** Deal two cards each, one at a time, dealer's second face down. */
function dealBlackjack(t) {
  t.phase = "dealing";
  const order = Object.keys(t.seats).filter(id => t.seats[id].status === "in");
  t.dealQueue = [...order.map(id => ["p", id]), ["d"], ...order.map(id => ["p", id]), ["d"]];
  broadcast();
  later(DEAL_MS, () => dealStep(t));
}
function dealStep(t) {
  if (S?.table !== t || t.phase !== "dealing") return;
  const next = t.dealQueue.shift();
  if (next) {
    if (next[0] === "p") t.seats[next[1]].hands[0].cards.push(draw(t));
    else t.dealer.cards.push(draw(t));
    broadcast();
  }
  if (t.dealQueue.length) return later(DEAL_MS, () => dealStep(t));
  return afterDeal(t);
}
function finishDealInstantly(t) {
  for (const [id, s] of Object.entries(t.seats)) if (s.status === "in") while (s.hands[0].cards.length < 2) s.hands[0].cards.push(draw(t));
  while (t.dealer.cards.length < 2) t.dealer.cards.push(draw(t));
  return afterDeal(t);
}

function afterDeal(t) {
  t.dealQueue = null;
  for (const s of Object.values(t.seats)) if (s.status === "in" && R.isBlackjack(s.hands[0].cards)) s.hands[0].done = true;
  if (R.rankOf(t.dealer.cards[0].c) === "A") {
    t.phase = "insurance";
    // A natural can't be insured against usefully here; it still gets the offer like everyone else
    return broadcast();
  }
  return afterInsurance(t);
}

/** Dealer peeks for blackjack (showing an ace or a ten), then play starts. */
function afterInsurance(t) {
  const up = R.cardValue(t.dealer.cards[0].c);
  if ((up === 11 || up === 10) && R.isBlackjack(t.dealer.cards.map(c => c.c))) {
    t.dealer.holeHidden = false;
    t.dealerBJ = true;
    broadcast();
    return later(DEALER_MS, () => settleBlackjack(t));
  }
  t.phase = "playing";
  t.turn = null;
  return advanceTurn(t);
}

function advanceTurn(t) {
  const order = Object.keys(t.seats).filter(id => t.seats[id].status === "in");
  for (const id of order) {
    const hands = t.seats[id].hands;
    for (let i = 0; i < hands.length; i++) {
      if (!hands[i].done) { t.turn = { actorId: id, hand: i }; return broadcast(); }
    }
  }
  t.turn = null;
  t.phase = "dealer";
  t.dealer.holeHidden = false;
  broadcast();
  return later(DEALER_MS, () => dealerStep(t));
}

function dealerStep(t) {
  if (S?.table !== t || t.phase !== "dealer") return;
  t.dealer.holeHidden = false;
  // The dealer only draws if someone is still in with a hand that isn't bust or a natural
  const live = Object.values(t.seats).some(s => s.status === "in" && s.hands.some(h => !R.isBust(h.cards) && !R.isBlackjack(h.cards, h.split)));
  if (live && R.dealerHits(t.dealer.cards)) {
    t.dealer.cards.push(draw(t));
    broadcast();
    return later(DEALER_MS, () => dealerStep(t));
  }
  return settleBlackjack(t);
}

const HAND_WORDS = { blackjack: "Blackjack!", win: "Win", push: "Push", lose: "Lose", bust: "Bust" };

async function settleBlackjack(t) {
  if (S?.table !== t || t.phase === "done") return;
  const dealerCodes = t.dealer.cards.map(c => c.c);
  const dealerBJ = R.isBlackjack(dealerCodes);
  const lines = [];
  for (const [id, s] of Object.entries(t.seats)) {
    if (s.status !== "in") continue;
    let stake = 0, ret = 0;
    const words = [];
    for (const h of s.hands) {
      const r = R.settleHand(h, dealerCodes);
      h.result = r.result; h.returnCp = r.returnCp;
      stake += h.betCp; ret += r.returnCp;
      const shown = R.isBlackjack(h.cards, h.split) ? "Blackjack" : R.handTotal(h.cards).total;
      words.push(`${shown}${h.doubled ? " (doubled)" : ""} — ${HAND_WORDS[r.result]}`);
    }
    if (s.insuranceCp) {
      stake += s.insuranceCp;
      const insRet = dealerBJ ? s.insuranceCp * 3 : 0;
      ret += insRet;
      words.push(`insurance ${dealerBJ ? "paid" : "lost"}`);
    }
    await give(id, ret);
    const split = s.hands.length > 1;
    lines.push({ actorId: id, stakeCp: stake, returnCp: ret, detail: words.join("; "), moments: {
      naturals: s.hands.filter(h => h.result === "blackjack").length,
      splitBoth: split && s.hands.every(h => h.result === "win" || h.result === "blackjack"),
    } });
  }
  t.phase = "done";
  t.dealerTotal = R.handTotal(dealerCodes).total;
  t.results = { lines, dealer: dealerBJ ? "Blackjack" : t.dealerTotal > 21 ? `Bust (${t.dealerTotal})` : `${t.dealerTotal}` };
  S.shoes.blackjack = t.shoe;
  broadcast();
  await postReceipt(t, `Dealer: ${t.results.dealer}`);
}

// ── Roulette ─────────────────────────────────────────────────────────────────

async function rouletteBets(t, seat, actor, p) {
  if (t.phase !== "betting" || seat.status !== "betting") throw new Error("Bets are already in.");
  const bets = (Array.isArray(p.bets) ? p.bets : []).map(b => ({ type: b.type, n: b.n === undefined ? undefined : Number(b.n), k: b.k === undefined ? undefined : Number(b.k), cp: Math.round(Number(b.cp)) }))
    .filter(R.validRouletteBet);
  if (!bets.length) throw new Error("Place at least one chip.");
  const total = bets.reduce((a, b) => a + b.cp, 0);
  if (total > S.maxBetCp) throw new Error(`The table limit is ${formatCp(S.maxBetCp)} a spin.`);
  if (bets.some(b => b.cp < MIN_BET_CP)) throw new Error(`The smallest chip is ${formatCp(MIN_BET_CP)}.`);
  await take(actor.id, total);
  seat.bets = bets;
  seat.status = "in";
  broadcast();
  return checkBetsIn();
}

function spinRoulette(t) {
  t.phase = "spinning";
  t.spin = { id: foundry.utils.randomID(), result: R.WHEEL[R.randomInt(37)], ms: SPIN_MS };
  broadcast();
  later(SPIN_MS + 400, () => settleRoulette(t));
}

async function settleRoulette(t) {
  if (S?.table !== t || t.phase !== "spinning") return;
  const n = t.spin.result;
  const lines = [];
  for (const [id, s] of Object.entries(t.seats)) {
    if (s.status !== "in") continue;
    let stake = 0, ret = 0;
    for (const b of s.bets) { stake += b.cp; b.returnCp = R.rouletteReturn(b, n); ret += b.returnCp; }
    await give(id, ret);
    const won = s.bets.filter(b => b.returnCp > 0).map(b => R.rouletteLabel(b));
    lines.push({ actorId: id, stakeCp: stake, returnCp: ret, detail: won.length ? `won on ${won.join(", ")}` : "no luck",
                 moments: { straight: s.bets.some(b => b.type === "n" && b.returnCp > 0) } });
  }
  t.phase = "done";
  t.results = { lines, number: n, colour: R.colourOf(n) };
  S.history = [n, ...(S.history ?? [])].slice(0, 12);
  t.history = S.history;
  broadcast();
  await postReceipt(t, `The ball lands on ${n} ${R.colourOf(n)}`);
}

// ── Lizard races ─────────────────────────────────────────────────────────────

async function lizardBets(t, seat, actor, p) {
  if (t.phase !== "betting" || seat.status !== "betting") throw new Error("Bets are already in.");
  const ids = new Set(t.field.map(L => L.id));
  const bets = (Array.isArray(p.bets) ? p.bets : []).map(b => ({ lizard: String(b.lizard), cp: Math.round(Number(b.cp)) }))
    .filter(b => ids.has(b.lizard) && b.cp >= MIN_BET_CP);
  if (!bets.length) throw new Error("Back at least one lizard.");
  const total = bets.reduce((a, b) => a + b.cp, 0);
  if (total > S.maxBetCp) throw new Error(`The table limit is ${formatCp(S.maxBetCp)} a race.`);
  await take(actor.id, total);
  seat.bets = bets;
  seat.status = "in";
  broadcast();
  return checkBetsIn();
}

function runRace(t) {
  const field = t.field.map(f => R.lizardById(f.id));
  const race = R.simulateRace(field);
  t.phase = "racing";
  t.race = { id: foundry.utils.randomID(), ...race, ms: race.ticks.length * R.TICK_MS };
  broadcast();
  later(t.race.ms + 1500, () => settleRace(t));
}

async function settleRace(t) {
  if (S?.table !== t || t.phase !== "racing") return;
  const winner = t.race.order[0];
  const lines = [];
  for (const [id, s] of Object.entries(t.seats)) {
    if (s.status !== "in") continue;
    let stake = 0, ret = 0;
    for (const b of s.bets) {
      stake += b.cp;
      const odds = t.field.find(L => L.id === b.lizard)?.odds;
      b.returnCp = b.lizard === winner ? R.lizardReturn(b.cp, odds) : 0;
      ret += b.returnCp;
    }
    await give(id, ret);
    const names = s.bets.map(b => `${R.lizardById(b.lizard)?.name} (${R.oddsText(t.field.find(L => L.id === b.lizard).odds)})`);
    const winning = s.bets.filter(b => b.lizard === winner).map(b => t.field.find(L => L.id === b.lizard)?.odds ?? [0, 1]);
    lines.push({ actorId: id, stakeCp: stake, returnCp: ret, detail: `backed ${names.join(", ")}`,
                 moments: { lizardWin: winning.length > 0, longShot: winning.some(([a, b]) => a / b >= 8) } });
  }
  S.form = R.recordForm(S.form ?? {}, t.race.order);
  try { await game.settings.set(MODULE_ID, "casinoLizards", { form: S.form }); } catch {}
  t.phase = "done";
  t.results = { lines, order: t.race.order };
  broadcast();
  await postReceipt(t, `${R.lizardById(winner)?.name} wins!`);
}

// ── Receipt ──────────────────────────────────────────────────────────────────

const signedCp = (cp) => `${cp > 0 ? "+" : cp < 0 ? "−" : "±"}${formatCp(Math.abs(cp))}`;

/** Closing time: a card with how everyone did tonight (feeds "Beat the House"). */
async function postNightTally() {
  const nets = S?.nightNets ?? {};
  const ids = Object.keys(nets);
  if (!ids.length) return;
  const rows = ids.sort((a, b) => nets[b] - nets[a]).map(id => `
      <li class="qa-roll-row"><div class="qa-receipt-head">
        <span class="qa-roll-name">${escapeHtml(game.actors.get(id)?.name ?? "Someone")}</span>
        <span class="qa-receipt-amt ${nets[id] > 0 ? "success" : nets[id] < 0 ? "failure" : ""}">${signedCp(nets[id])}</span>
      </div></li>`).join("");
  const house = -ids.reduce((a, id) => a + nets[id], 0);
  await ChatMessage.create({
    speaker: { alias: S.name },
    content: `
      <div class="skill-check-card qa-card cz-receipt">
        <header class="card-header">
          <span class="icon"><i class="fas fa-door-closed"></i></span>
          <div class="title-block"><div class="skill-name">${escapeHtml(S.name)}</div><div class="ability-tag">Closing time — tonight's takings</div></div>
        </header>
        <section class="card-content"><ul class="qa-rows">${rows}</ul>
          <div class="group-summary">The house ${house >= 0 ? "is up" : "is down"} ${formatCp(Math.abs(house))} on the night</div></section>
      </div>`,
    flags: { [MODULE_ID]: { casinoNight: { id: S.nightId, casino: S.name, nets } } },
  });
}

async function postReceipt(t, headline) {
  const lines = t.results?.lines ?? [];
  if (!lines.length) return;
  S.nightNets ??= {};
  for (const l of lines) S.nightNets[l.actorId] = (S.nightNets[l.actorId] ?? 0) + l.returnCp - l.stakeCp;
  const rows = lines.map(l => {
    const name = game.actors.get(l.actorId)?.name ?? "Someone";
    const net = l.returnCp - l.stakeCp;
    return `
      <li class="qa-roll-row">
        <div class="qa-receipt-head">
          <span class="qa-roll-name">${escapeHtml(name)}</span>
          <span class="qa-receipt-amt ${net > 0 ? "success" : net < 0 ? "failure" : ""}">${signedCp(net)}</span>
        </div>
        <div class="qa-roll-meta">Bet ${formatCp(l.stakeCp)} · back ${formatCp(l.returnCp)} · ${escapeHtml(l.detail)}</div>
      </li>`;
  }).join("");
  const house = lines.reduce((a, l) => a + l.stakeCp - l.returnCp, 0);
  await ChatMessage.create({
    speaker: { alias: S.name },
    content: `
      <div class="skill-check-card qa-card cz-receipt">
        <header class="card-header">
          <span class="icon"><i class="${GAMES.find(g => g.id === t.game)?.icon ?? "fas fa-dice"}"></i></span>
          <div class="title-block">
            <div class="skill-name">${escapeHtml(S.name)}</div>
            <div class="ability-tag">${escapeHtml(gameName(t.game))} — round ${t.round}</div>
          </div>
        </header>
        <section class="card-content">
          <div class="cz-receipt-headline">${escapeHtml(headline)}</div>
          <ul class="qa-rows">${rows}</ul>
          <div class="group-summary">The house ${house >= 0 ? "takes" : "pays out"} ${formatCp(Math.abs(house))}</div>
        </section>
      </div>`,
    flags: { [MODULE_ID]: { casinoResult: { casino: S.name, game: t.game, round: t.round, lines } } },
  });
}
