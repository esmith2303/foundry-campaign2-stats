/**
 * Casino rules — pure JS, no Foundry globals (so they can be tested in Node).
 *
 *   Blackjack  6-deck shoe, dealer stands on all 17s, blackjack pays 3:2,
 *              double on any first two cards (also after a split), split any
 *              two cards of the same value up to 4 hands, split aces get one
 *              card each, insurance pays 2:1 when the dealer shows an ace.
 *   Roulette   European single zero. Straight numbers 35:1, dozens and
 *              columns 2:1, red/black, odd/even, 1–18/19–36 evens. Zero loses
 *              every outside bet.
 *   Lizards    A stable of named lizards with hidden ratings. Four race; the
 *              odds come from simulating the same race thousands of times, so
 *              favourites really do win more often.
 *
 * Money is always in copper pieces (cp).
 */

// ── Randomness ───────────────────────────────────────────────────────────────

/**
 * A fair random float in [0, 1), from the browser's cryptographic generator.
 * Used for everything that decides a result (cards, the wheel, the race).
 * Drawn in batches: one call per number is slow.
 */
let pool = new Uint32Array(0), poolAt = 0;
export function random() {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) return Math.random();
  if (poolAt >= pool.length) { pool = new Uint32Array(2048); c.getRandomValues(pool); poolAt = 0; }
  return pool[poolAt++] / 2 ** 32;
}

/**
 * A fast generator (sfc32) for estimates that don't decide anything — the
 * thousands of practice races behind the lizard odds. Seeded fresh each time.
 */
export function fastRandom(seed = Math.floor(random() * 2 ** 32)) {
  let a = seed >>> 0, b = 0x9e3779b9, c = 0x243f6a88, d = 0xb7e15162;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();   // warm up
  return next;
}
export const randomInt = (n, rng = random) => Math.floor(rng() * n);

export function shuffle(list, rng = random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1, rng); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ── Blackjack ────────────────────────────────────────────────────────────────

export const RANKS = "A23456789TJQK";
export const SUITS = "SHDC";
export const SHOE_DECKS = 6;

/** A shuffled shoe of card codes like "AS", "TH", "9C". */
export function newShoe(decks = SHOE_DECKS, rng = random) {
  const cards = [];
  for (let d = 0; d < decks; d++) for (const s of SUITS) for (const r of RANKS) cards.push(r + s);
  return shuffle(cards, rng);
}
/** Reshuffle once three quarters of the shoe has been dealt (the cut card). */
export const needsReshuffle = (shoe, decks = SHOE_DECKS) => shoe.length < decks * 52 * 0.25;

export const rankOf = (code) => code?.[0];
export const suitOf = (code) => code?.[1];
export const cardValue = (code) => { const r = rankOf(code); return r === "A" ? 11 : "TJQK".includes(r) ? 10 : Number(r); };

/** { total, soft } — soft when an ace is still counting as 11. */
export function handTotal(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { const code = c?.c ?? c; if (!code) continue; total += cardValue(code); if (rankOf(code) === "A") aces++; }
  while (total > 21 && aces) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}
export const isBust = (cards) => handTotal(cards).total > 21;
/** A natural: two cards making 21, not on a split hand. */
export const isBlackjack = (cards, split = false) => !split && cards.length === 2 && handTotal(cards).total === 21;
export const dealerHits = (cards) => handTotal(cards).total < 17;   // stands on soft 17

export function canDouble(hand) {
  return !hand.done && hand.cards.length === 2 && !hand.splitAces;
}
export function canSplit(hand, handCount, maxHands = 4) {
  if (hand.done || hand.cards.length !== 2 || handCount >= maxHands || hand.splitAces) return false;
  const [a, b] = hand.cards.map(c => c.c ?? c);
  return cardValue(a) === cardValue(b);
}

/**
 * Settle one player hand against the dealer.
 * → { result: "blackjack" | "win" | "push" | "lose" | "bust", returnCp }
 *   returnCp is what goes back to the player (stake included).
 */
export function settleHand(hand, dealerCards) {
  const bet = hand.betCp;
  const p = handTotal(hand.cards).total, d = handTotal(dealerCards).total;
  const playerBJ = isBlackjack(hand.cards, hand.split), dealerBJ = isBlackjack(dealerCards);
  if (p > 21) return { result: "bust", returnCp: 0 };
  if (playerBJ && dealerBJ) return { result: "push", returnCp: bet };
  if (playerBJ) return { result: "blackjack", returnCp: bet + Math.floor(bet * 3 / 2) };
  if (dealerBJ) return { result: "lose", returnCp: 0 };
  if (d > 21 || p > d) return { result: "win", returnCp: bet * 2 };
  if (p === d) return { result: "push", returnCp: bet };
  return { result: "lose", returnCp: 0 };
}

// ── Roulette ─────────────────────────────────────────────────────────────────

/** Pockets in wheel order (European). */
export const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
export const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export const colourOf = (n) => n === 0 ? "green" : REDS.has(n) ? "red" : "black";

/** Bet types → what they pay (x to 1). A bet is { type, n? (straight), k? (dozen/column 1–3), cp }. */
export const ROULETTE_PAYS = { n: 35, dozen: 2, column: 2, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1 };

export function rouletteWins(bet, n) {
  switch (bet.type) {
    case "n": return Number(bet.n) === n;
    case "red": return colourOf(n) === "red";
    case "black": return colourOf(n) === "black";
    case "odd": return n > 0 && n % 2 === 1;
    case "even": return n > 0 && n % 2 === 0;
    case "low": return n >= 1 && n <= 18;
    case "high": return n >= 19 && n <= 36;
    case "dozen": return n > 0 && Math.ceil(n / 12) === Number(bet.k);
    case "column": return n > 0 && ((n - 1) % 3) + 1 === Number(bet.k);
    default: return false;
  }
}
/** What a bet returns (stake included) when `n` comes up. */
export const rouletteReturn = (bet, n) => rouletteWins(bet, n) ? bet.cp * (ROULETTE_PAYS[bet.type] + 1) : 0;

export function validRouletteBet(b) {
  if (!b || !(b.type in ROULETTE_PAYS) || !(Number.isInteger(b.cp) && b.cp > 0)) return false;
  if (b.type === "n") return Number.isInteger(b.n) && b.n >= 0 && b.n <= 36;
  if (b.type === "dozen" || b.type === "column") return [1, 2, 3].includes(b.k);
  return true;
}
export const rouletteKey = (b) => b.type === "n" ? `n${b.n}` : b.type === "dozen" || b.type === "column" ? `${b.type}${b.k}` : b.type;
export function rouletteLabel(b) {
  switch (b.type) {
    case "n": return `${b.n}`;
    case "dozen": return ["1st 12", "2nd 12", "3rd 12"][b.k - 1];
    case "column": return `Column ${b.k}`;
    case "low": return "1–18";
    case "high": return "19–36";
    default: return b.type[0].toUpperCase() + b.type.slice(1);
  }
}

// ── Lizard races ─────────────────────────────────────────────────────────────

/**
 * The stable. speed = average pace, grit = consistency (low grit → wild
 * swings), kick = burst over the last stretch. Hidden from players: they see
 * the odds and recent form.
 */
export const STABLE = [
  { id: "scuttles", name: "Sir Scuttlesworth", colour: "#c9a84c", blurb: "Old money. Never in a hurry.", speed: 1.02, grit: 0.85, kick: 0.03 },
  { id: "gertie",   name: "Gravel Gertie",     colour: "#9a7b5a", blurb: "Eats rocks. Runs like one.", speed: 0.985, grit: 0.9, kick: 0.02 },
  { id: "ember",    name: "Emberbelly",        colour: "#d2552d", blurb: "Hot-blooded and hot-headed.", speed: 1.0, grit: 0.55, kick: 0.09 },
  { id: "flick",    name: "Lady Flicktongue",  colour: "#7b4fa8", blurb: "Elegant, aloof, quick.", speed: 1.035, grit: 0.8, kick: 0.03 },
  { id: "mudbelly", name: "Mudbelly Murphy",   colour: "#6b7a3a", blurb: "Has never once tried.", speed: 0.97, grit: 0.5, kick: 0.1 },
  { id: "pip",      name: "Pip the Unlikely",  colour: "#5aa0c8", blurb: "Small. Hopeful. Small.", speed: 0.96, grit: 0.35, kick: 0.12 },
  { id: "thunder",  name: "Thunderclaw",       colour: "#3c5fb0", blurb: "Built like a cart, starts like one.", speed: 1.0, grit: 0.75, kick: 0.07 },
  { id: "dusty",    name: "Old Dusty",         colour: "#b8a88a", blurb: "Won the Harvest Cup. Twelve years ago.", speed: 0.99, grit: 0.88, kick: 0.01 },
  { id: "jade",     name: "Jade Dart",         colour: "#2e9c6a", blurb: "Fast out of the gate. Fades.", speed: 1.04, grit: 0.6, kick: -0.06 },
  { id: "brim",     name: "Brimstone",         colour: "#8c2a2a", blurb: "Smells of sulphur. Nobody asks.", speed: 1.0, grit: 0.7, kick: 0.05 },
];
export const lizardById = (id) => STABLE.find(l => l.id === id);

export const RACE_LENGTH = 100;
export const TICK_MS = 100;
const BASE_PACE = RACE_LENGTH / 66;   // the winner finishes in about 6 seconds

function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * One race. Returns
 *   ticks:  [[pos0, pos1, pos2, pos3], …] every TICK_MS (0–RACE_LENGTH)
 *   order:  lizard ids in finishing order
 *   times:  finishing time (ms) per lizard, interpolated between ticks
 */
export function simulateRace(field, rng = random) {
  const n = field.length;
  const pos = new Array(n).fill(0), mom = new Array(n).fill(0), times = new Array(n).fill(null);
  // a slow or fast start for each lizard
  for (let i = 0; i < n; i++) mom[i] = gaussian(rng) * (1.1 - field[i].grit) * 0.25;
  const ticks = [pos.map(() => 0)];
  let t = 0;
  while (times.some(x => x === null) && t < 400) {
    t++;
    for (let i = 0; i < n; i++) {
      if (times[i] !== null) continue;
      const L = field[i];
      // momentum keeps the pace smooth: surges and stumbles last a while
      mom[i] = 0.85 * mom[i] + 0.15 * gaussian(rng) * (1.25 - L.grit) * 1.3;
      let pace = BASE_PACE * L.speed * (1 + mom[i]);
      if (pos[i] > RACE_LENGTH * 0.7) pace *= 1 + L.kick;
      pace = Math.max(BASE_PACE * 0.25, pace);
      const before = pos[i];
      pos[i] = Math.min(RACE_LENGTH, before + pace);
      if (pos[i] >= RACE_LENGTH) times[i] = (t - 1 + (RACE_LENGTH - before) / pace) * TICK_MS;
    }
    ticks.push(pos.map(p => Math.round(p * 10) / 10));
  }
  const order = field.map((L, i) => ({ id: L.id, time: times[i] ?? Infinity })).sort((a, b) => a.time - b.time).map(x => x.id);
  return { ticks, order, times: Object.fromEntries(field.map((L, i) => [L.id, Math.round(times[i] ?? 0)])) };
}

/** Each lizard's chance of winning this field, by simulation. */
export function winChances(field, runs = 4000, rng = fastRandom()) {
  const wins = Object.fromEntries(field.map(L => [L.id, 0]));
  for (let r = 0; r < runs; r++) wins[simulateRace(field, rng).order[0]]++;
  return Object.fromEntries(field.map(L => [L.id, (wins[L.id] + 0.5) / (runs + 0.5 * field.length)]));
}

/** Bookmaker's odds ladder (x to y). */
export const ODDS_LADDER = [[1, 4], [1, 3], [2, 5], [1, 2], [4, 6], [4, 5], [1, 1], [6, 5], [6, 4], [7, 4], [2, 1], [9, 4], [5, 2], [11, 4], [3, 1], [7, 2], [4, 1], [9, 2], [5, 1], [6, 1], [7, 1], [8, 1], [10, 1], [12, 1], [14, 1], [16, 1], [20, 1], [25, 1], [33, 1], [50, 1]];
export const HOUSE_MARGIN = 0.08;

/** Odds for a win chance p, with the house's cut: the biggest ladder price at or under fair. */
export function oddsFor(p, margin = HOUSE_MARGIN) {
  const offered = (1 - margin) / Math.max(p, 0.001) - 1;
  let best = ODDS_LADDER[0];
  for (const o of ODDS_LADDER) if (o[0] / o[1] <= offered) best = o;
  return best;
}
export const oddsText = ([a, b]) => a === b ? "Evens" : `${a}/${b}`;
/** What a winning bet returns (stake included). */
export const lizardReturn = (cp, [a, b]) => cp + Math.floor(cp * a / b);

/** Pick four runners. */
export const drawField = (count = 4, rng = random) => shuffle(STABLE, rng).slice(0, count);

/** Recent form for every lizard: last 6 placings (1–4), newest last. */
export function seedForm(rng = fastRandom(), races = 6) {
  const form = Object.fromEntries(STABLE.map(L => [L.id, []]));
  for (const L of STABLE) {
    for (let r = 0; r < races; r++) {
      const others = shuffle(STABLE.filter(x => x.id !== L.id), rng).slice(0, 3);
      const order = simulateRace(shuffle([L, ...others], rng), rng).order;
      form[L.id].push(order.indexOf(L.id) + 1);
    }
  }
  return form;
}
export function recordForm(form, order, keep = 6) {
  const next = { ...form };
  order.forEach((id, i) => { next[id] = [...(next[id] ?? []), i + 1].slice(-keep); });
  return next;
}
