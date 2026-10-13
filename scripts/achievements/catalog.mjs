/**
 * The long-term achievements. Pure data — edit names, text and thresholds here.
 *
 *   value(c, seq)  how far a character has got: c = their lifetime counters
 *                  (see engine.mjs), seq = Set of one-off moments found in
 *                  the chat log (streaks, firsts…)
 *   tiers          thresholds; each one reached posts its own card
 *   hidden         not shown anywhere until unlocked
 *   whisper        the card only goes to the GM and the character's player
 *                  (anything that would give away a secret death save)
 *   character      personal: only the character whose name starts with this
 *                  can earn it
 */

const n = (c, type) => c.types[type]?.n ?? 0;
const sum = (c, type) => c.types[type]?.sum ?? 0;
const max = (c, type) => c.types[type]?.max ?? 0;
const once = (id) => (c, seq) => (seq.has(id) ? 1 : 0);
// Per-item totals: how many times items matching `re` were used / killed with…
const itemN = (c, type, re) => Object.entries(c.items?.[type] ?? {}).reduce((t, [name, v]) => t + (re.test(name) ? v.n : 0), 0);
const distinct = (c, type) => Object.values(c.items?.[type] ?? {}).filter(v => v.n > 0).length;

export const ACHIEVEMENTS = [
  // ── Dice ──────────────────────────────────────────────────────────────────
  { id: "tymora", group: "Dice", icon: "fas fa-dice-d20", name: "Blessed by Tymora",
    tiers: [10, 25, 50, 100], desc: (t) => `Roll ${t} natural 20s`, value: (c) => n(c, "nat20") },
  { id: "cursed", group: "Dice", icon: "fas fa-skull-crossbones", name: "Cursed Bones",
    tiers: [10, 25, 50, 100], desc: (t) => `Roll ${t} natural 1s`, value: (c) => n(c, "nat1") },
  { id: "backToBack", group: "Dice", icon: "fas fa-dice", name: "Back to Back",
    tiers: [1], desc: () => "Roll two natural 20s in a row", value: once("backToBack") },
  { id: "universeHates", group: "Dice", icon: "fas fa-cloud-showers-heavy", name: "The Universe Hates You",
    tiers: [1], desc: () => "Roll three natural 1s in one session", value: once("universeHates") },
  { id: "average", group: "Dice", icon: "fas fa-scale-balanced", name: "Statistically Average",
    tiers: [1], desc: () => "Finish a session with your d20s averaging between 10 and 11", value: once("average") },

  // ── Combat ────────────────────────────────────────────────────────────────
  { id: "hundredKills", group: "Combat", icon: "fas fa-skull", name: "Hundred-Kill Club",
    tiers: [100], desc: (t) => `Reach ${t} kills`, value: (c) => n(c, "kill") },
  { id: "overkill", group: "Combat", icon: "fas fa-explosion", name: "Overkill",
    tiers: [1], desc: () => "Deal 25+ damage to something with 5 HP or less left", value: (c) => n(c, "overkill") },
  { id: "onePunch", group: "Combat", icon: "fas fa-hand-fist", name: "One Punch",
    tiers: [1], desc: () => "Kill something with the first hit it takes", value: once("onePunch") },
  { id: "glassCannon", group: "Combat", icon: "fas fa-wine-glass", name: "Glass Cannon",
    tiers: [1], desc: () => "Deal the most damage in a fight and take the most too", value: (c) => n(c, "recap_glass") },
  { id: "bigNumber", group: "Combat", icon: "fas fa-meteor", name: "Big Number Energy",
    tiers: [1], desc: () => "Land a single hit of 40+ damage", value: (c) => (max(c, "max_hit") >= 40 ? 1 : 0) },
  { id: "stormtrooper", group: "Combat", icon: "fas fa-wind", name: "Stormtrooper Academy",
    tiers: [1], desc: () => "Miss five attacks in a row", value: once("stormtrooper") },
  { id: "thousandCuts", group: "Combat", icon: "fas fa-khanda", name: "Thousand Cuts",
    tiers: [1000, 5000, 10000], desc: (t) => `Deal ${t.toLocaleString()} damage in total`, value: (c) => sum(c, "damage") },

  // ── Survival & support ────────────────────────────────────────────────────
  { id: "deathDodger", group: "Survival", icon: "fas fa-heart-pulse", name: "Death Dodger", whisper: true,
    tiers: [1], desc: () => "Stabilise on your own death saves", value: once("deathDodger") },
  { id: "notToday", group: "Survival", icon: "fas fa-person-rays", name: "Not Today",
    tiers: [1], desc: () => "Drop to 0 HP and be back on your feet in the same fight", value: once("notToday") },
  { id: "humanShield", group: "Survival", icon: "fas fa-shield-halved", name: "Human Shield",
    tiers: [100, 250, 500, 1000], desc: (t) => `Take ${t.toLocaleString()} damage in total`, value: (c) => sum(c, "damage_taken") },
  { id: "fieldMedic", group: "Survival", icon: "fas fa-kit-medical", name: "Field Medic",
    tiers: [50, 100, 250, 500], desc: (t) => `Heal ${t.toLocaleString()} HP in total`, value: (c) => sum(c, "heal") + sum(c, "healing") },
  { id: "ironWill", group: "Survival", icon: "fas fa-brain", name: "Iron Will",
    tiers: [1], desc: () => "Pass 25 saving throws in a row", value: once("ironWill") },
  { id: "untouched", group: "Survival", icon: "fas fa-feather", name: "Untouched",
    tiers: [5], desc: (t) => `Finish ${t} fights without taking a scratch`, value: (c) => n(c, "recap_untouched") },

  // ── Shopping ──────────────────────────────────────────────────────────────
  { id: "bigSpender", group: "Shopping", icon: "fas fa-coins", name: "Big Spender",
    tiers: [1000], desc: (t) => `Spend ${t.toLocaleString()} gp in shops`, value: (c) => c.shop.spentCp / 100 },
  { id: "silverTongue", group: "Shopping", icon: "fas fa-comments-dollar", name: "Silver Tongue",
    tiers: [10], desc: (t) => `Haggle ${t} prices down`, value: (c) => c.shop.haggles },
  { id: "hoarder", group: "Shopping", icon: "fas fa-box-open", name: "Hoarder",
    tiers: [50], desc: (t) => `Buy ${t} items`, value: (c) => c.shop.items },
  { id: "middleman", group: "Shopping", icon: "fas fa-arrow-right-arrow-left", name: "The Middleman",
    tiers: [1], desc: () => "Sell something for more than you paid for it", value: once("middleman") },

  // ── Casino ────────────────────────────────────────────────────────────────
  { id: "cardCounter", group: "Casino", icon: "fas fa-diamond", name: "Card Counter",
    tiers: [5], desc: (t) => `Get ${t} blackjacks`, value: (c) => sum(c, "bj_natural") },
  { id: "splittingHairs", group: "Casino", icon: "fas fa-code-branch", name: "Splitting Hairs",
    tiers: [1], desc: () => "Split at blackjack and win both hands", value: (c) => n(c, "bj_split_both") },
  { id: "onTheNose", group: "Casino", icon: "fas fa-bullseye", name: "On the Nose",
    tiers: [1], desc: () => "Hit a single number at roulette", value: (c) => n(c, "rl_straight") },
  { id: "longShot", group: "Casino", icon: "fas fa-horse-head", name: "The Long Shot",
    tiers: [1], desc: () => "Win on a lizard at 8/1 or longer", value: (c) => n(c, "lz_longshot") },
  { id: "lizardWhisperer", group: "Casino", icon: "fas fa-staff-snake", name: "Lizard Whisperer",
    tiers: [5], desc: (t) => `Back the winning lizard ${t} times`, value: (c) => n(c, "lz_win") },
  { id: "houseWins", group: "Casino", icon: "fas fa-house-crack", name: "The House Always Wins",
    tiers: [500], desc: (t) => `Lose ${t} gp at the casino`, value: (c) => Math.max(0, -sum(c, "gamble") / 100) },
  { id: "beatTheHouse", group: "Casino", icon: "fas fa-sack-dollar", name: "Beat the House",
    tiers: [1], desc: () => "Finish a casino night up", value: (c) => n(c, "casino_up") },

  // ── Combat recaps ─────────────────────────────────────────────────────────
  { id: "crowdFavourite", group: "Recaps", icon: "fas fa-crown", name: "Crowd Favourite",
    tiers: [5], desc: (t) => `Be the fight MVP ${t} times`, value: (c) => n(c, "recap_mvp") },
  { id: "executioner", group: "Recaps", icon: "fas fa-user-ninja", name: "Executioner Emeritus",
    tiers: [3], desc: (t) => `Earn Executioner ${t} times`, value: (c) => n(c, "recap_exec") },

  // ── Personal: Avolin (bard) ─────────────────────────────────────────────
  { id: "roasted", group: "Personal", character: "Avolin", icon: "fas fa-microphone", name: "Roasted",
    tiers: [1], desc: () => "Kill something with Vicious Mockery", value: (c) => itemN(c, "kill", /Vicious Mockery/i) },
  { id: "hypeMan", group: "Personal", character: "Avolin", icon: "fas fa-bullhorn", name: "Hype Man",
    tiers: [50], desc: (t) => `Hand out ${t} Bardic Inspirations`, value: (c) => itemN(c, "use", /^Bardic Inspiration/i) },
  { id: "encore", group: "Personal", character: "Avolin", icon: "fas fa-music", name: "Encore!",
    tiers: [3], desc: (t) => `Get ${t} downed allies back on their feet`, value: (c) => n(c, "revive") },

  // ── Personal: Lucien (paladin) ──────────────────────────────────────────
  { id: "goingForGold", group: "Personal", character: "Lucien", icon: "fas fa-medal", name: "Going for Gold",
    tiers: [10], desc: (t) => `Kill ${t} enemies with a javelin`, value: (c) => itemN(c, "kill", /Javelin/i) },
  { id: "smiteClub", group: "Personal", character: "Lucien", icon: "fas fa-sun", name: "Smite Club",
    tiers: [50], desc: (t) => `Smite ${t} times`, value: (c) => itemN(c, "use", /Smite/i) },
  { id: "holyMoly", group: "Personal", character: "Lucien", icon: "fas fa-bolt-lightning", name: "Holy Moly",
    tiers: [1], desc: () => "Land a single hit of 60+ damage", value: (c) => (max(c, "max_hit") >= 60 ? 1 : 0) },

  // ── Personal: Felldoh (wild magic sorcerer) ─────────────────────────────
  { id: "pettingZoo", group: "Personal", character: "Felldoh", icon: "fas fa-paw", name: "Petting Zoo",
    tiers: [4], desc: () => "Summon every creature a wild magic surge can conjure", value: (c) => distinct(c, "surge_summon") },
  { id: "offTheCharts", group: "Personal", character: "Felldoh", icon: "fas fa-percent", name: "Off the Charts",
    tiers: [1], desc: () => "Roll a 01 or a 100 on the wild magic surge table", value: (c) => n(c, "surge_extreme") },
  { id: "healthAndSafety", group: "Personal", character: "Felldoh", icon: "fas fa-triangle-exclamation", name: "Health and Safety Violation",
    tiers: [50, 100], desc: (t) => `Cause ${t} wild magic surges`, value: (c) => n(c, "surge") },

  // ── Hidden until unlocked ─────────────────────────────────────────────────
  { id: "friendlyFire", group: "Hidden", icon: "fas fa-person-falling-burst", name: "Friendly Fire", hidden: true,
    tiers: [1], desc: () => "Damage a party member", value: (c) => n(c, "friendly_fire") },
  { id: "foundItLikeThat", group: "Hidden", icon: "fas fa-shield-heart", name: "It Was Like That When I Found It", hidden: true,
    tiers: [1], desc: () => "Take no damage from a hit thanks to a resistance or immunity", value: (c) => n(c, "shrugged") },
];

// Torin's three are kept unreadable here so his player can't spoil them
const SEALED = "W3siaWQiOiJjbGVyaWMxIiwiaWNvbiI6ImZhcyBmYS1saW5rIiwibmFtZSI6IlNoYWtlbiwgTm90IFN0aXJyZWQiLCJkZXNjIjoiQ2FzdCBXYXJkaW5nIEJvbmQge3R9IHRpbWVzIiwiY2hhcmFjdGVyIjoiVG9yaW4iLCJ0eXBlIjoidXNlIiwibWF0Y2giOiJeV2FyZGluZyBCb25kIiwidGllcnMiOlsyNV19LHsiaWQiOiJjbGVyaWMyIiwiaWNvbiI6ImZhcyBmYS1maXJlLWZsYW1lLWN1cnZlZCIsIm5hbWUiOiJIb2x5IFNtb2tlcyEiLCJkZXNjIjoiRmluaXNoIG9mZiB7dH0gZW5lbWllcyB3aXRoIFNhY3JlZCBGbGFtZSIsImNoYXJhY3RlciI6IlRvcmluIiwidHlwZSI6ImtpbGwiLCJtYXRjaCI6Il5TYWNyZWQgRmxhbWUiLCJ0aWVycyI6WzEwXX0seyJpZCI6ImNsZXJpYzMiLCJpY29uIjoiZmFzIGZhLWhhbmQtYmFjay1maXN0IiwibmFtZSI6IkhhdmUgWW91IFRyaWVkIEhpdHRpbmcgSXQ/IiwiZGVzYyI6IkZpbmlzaCBvZmYge3R9IGVuZW1pZXMgd2l0aCB5b3VyIHF1YXJ0ZXJzdGFmZiIsImNoYXJhY3RlciI6IlRvcmluIiwidHlwZSI6ImtpbGwiLCJtYXRjaCI6IlF1YXJ0ZXJzdGFmZiIsInRpZXJzIjpbNV19XQ==";
for (const e of JSON.parse(globalThis.atob ? atob(SEALED) : Buffer.from(SEALED, "base64").toString())) {
  const re = new RegExp(e.match, "i");
  ACHIEVEMENTS.push({ id: e.id, group: "Personal", character: e.character, icon: e.icon, name: e.name, tiers: e.tiers,
    desc: (t) => e.desc.replace("{t}", t), value: (c) => itemN(c, e.type, re) });
}

export const achievementById = (id) => ACHIEVEMENTS.find(a => a.id === id);
export const ROMAN = ["", "I", "II", "III", "IV", "V", "VI"];
export const tierName = (a, tier) => (a.tiers.length > 1 ? `${a.name} ${ROMAN[tier] ?? tier}` : a.name);
