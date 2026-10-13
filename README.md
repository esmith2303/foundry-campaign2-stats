# To Coldly Go — Campaign Stats

A FoundryVTT module (`dnd-group-campaign-2-stats`) plus a small Node/Postgres
backend that records campaign stats and serves them to the dashboard.

## How it works

```
Foundry (GM clicks ☁↑ Upload)
 ├─ chat log ──▶ scripts/extract.mjs ──▶ POST /api/chat-events ──▶ chat_dice, chat_outcomes, chat_purchases
 └─ end of session ──────────────────────▶ POST /api/roll-stats  ──▶ stat_uploads
```

- **Every stat** is read from the chat log at upload time by
  `scripts/extract.mjs`. Nothing is counted live. Every event is keyed by its
  chat message ID, and the server replaces what it has for a message whenever
  that message is uploaded again — so uploads are idempotent and re-uploading
  can only correct, never double count. **Upload before clearing the chat.**
- **midi-qol's own counters aren't used** (since 1.7.0). Checked against a
  session's chat log, they count damage rolled on misses, area damage at full
  value for every target (even ones that saved for half), every damage or
  healing use as an "attack", the saves enemies made against your spells as
  *your* saves, and kills unreliably. midi-qol is still required: its chat
  cards say whether an attack hit, and its "HP Updated" card (posted when
  damage or healing is applied) is where damage, kills, healing and damage
  taken are read from.
- A **session** on the dashboard is one stats upload; events belong to the
  session whose upload follows them.

### What the extractor counts

| Stat | Source |
|------|--------|
| Dice | `message.rolls` only (midi-qol's flag copies of the same rolls are ignored), every die including dropped adv/dis dice; Monk's TokenBar request rolls; skill-check card breakdowns |
| Attacks | PC attack rolls. Hit % only uses those with a target — midi-qol's `isHit` (falls back to d20/AC) |
| Crits / fumbles | Attack rolls midi-qol marked critical / fumbled (else a natural 20 / 1) |
| Damage dealt | midi-qol "HP Updated" cards: damage after saves, resistances and immunities, to anyone outside the party (overkill included), split by damage type, credited to the weapon/spell card it came from; plus Add Damage |
| Max hit | The biggest single "HP Updated" hit on one target, Add Damage, or Add Other's biggest hit |
| Kills | A PC's damage taking a creature (not a party member) from above 0 HP to 0, plus Add Kill |
| Damage taken | "HP Updated" damage to a party member (from anyone, friendly fire included), plus Take Damage |
| Healing | HP actually restored on "HP Updated" cards (not past max; temp HP isn't healing), plus "+" button heals |
| Saves | Each target's `saved` result on any card (e.g. a monster's spell), Monk's TokenBar requests with a DC, standalone save rolls with a DC |
| Checks | Skill-check cards, Monk's TokenBar requests with a DC, standalone checks with a DC |
| Death saves | Death save rolls (≥10 or a natural 20) |
| Heals (count) | PC uses of a healing activity, plus "+" button heals (Lay on Hands, Healer, Add Healing) |

Only player characters are tracked.

## Abilities ("+" toolbar button)

**The party** is the characters assigned to the players (Configure Player →
Character), so the GM's lists — Abilities, heal targets, the shop's buyers,
the skill check and skills sheet — show just those, not every sheet a player
owns. If no player has a character assigned, every player-owned character
counts. Players only ever act as characters they own, and only heal party
members; the GM's client checks both. At upload, "+" entries and receipts only
count if they were posted by the character's owner or a GM.

Every player gets a **+** button in the token controls. Changes to other
characters are applied by the GM's client (the GM must be logged in). Every
action posts a chat card, which is what the stats are read from.

Always at the top, for every character:

| Action | What it does |
|--------|--------------|
| Add Kill | Confirm → records a kill for the character. Stats only. |
| Add Damage | Optional weapon or spell, a set amount or a dice roll (dice buttons + modifier, or type a formula), damage type (defaults to the weapon's, overridable). Stats only — applied to nobody. |
| Add Healing | Pick who did the healing (if you have more than one character), then a PC to heal (or "Stats Only") and a set amount or dice roll; the PC is healed (never past max HP). |
| Take Damage | A set amount or dice roll, optional damage type, and "Apply to character sheet" (on by default). On: the amount comes straight off HP (temp HP first; resistances, vulnerabilities and immunities are ignored). Off: stats only, for damage already on the sheet. |
| Add Other | Stats only. +/− counts of attacks, hits (plus an optional biggest hit, which replaces Max Hit only if bigger), crits, fumbles, saves passed and saves failed. Adding hits or fumbles adds attacks and crits add hits; Attacks can then be lowered (even below hits) when the attack is already counted but no hit/miss was (e.g. no target). **Corrections** (Miss → hit, Failed save → passed) fix a result Foundry got wrong, e.g. the wrong AC or DC: they move an already-recorded miss / failed save without adding an attack or save. |

**Undo**: every "+" card has an Undo button (click twice) for the GM, whoever
posted it, and the owner of that character. It puts back everything the action
changed — HP and temp HP, Lay on Hands pool, Healer's Kit uses and hit dice —
relative to now, so anything that happened since is kept. The card stays in
chat, struck through and marked "Undone by …", and stops counting in the stats
(the next upload removes it). Cards from before this version can be undone for
the stats; Add Healing and Lay on Hands also restore the sheet, Take Damage and
Healer can't (fix HP by hand).

Then the character's sheet abilities, alphabetically:

| Ability | Needs | What it does |
|---------|-------|--------------|
| Healer | Healer feat + a Healer's Kit with uses | Battle Medic: each use spends one kit use and one of the patient's hit dice (largest first); rolls that die + the healer's proficiency bonus. 1s are rerolled once (toggle) without spending another die or kit use. Several uses across several PCs in one go. |
| Lay on Hands | A "Lay on Hands" feature with a uses pool | Split the pool across PCs and/or "Other"; heals (never past max HP; only what's healed is spent) and spends the pool on the sheet. |

Stats: heals count as heals (each Healer use separately) and their amounts are
added to total healing; manual damage is added to total damage, max hit, its
damage type and its weapon; manual kills are added to kills (and the weapon,
if one was chosen). Damage taken is added to damage taken (and its type).
Add Other's attacks and saves count in hit % and save % and are added to the
attack / save totals; its crits, fumbles and biggest hit are added to crits,
fumbles and max hit. Dice rolled in these actions count in the dice stats,
except Take Damage's (those are the enemy's dice).

To add one: create `scripts/abilities/<Name>.mjs` (see `LayOnHands.mjs`) and
add it to `ABILITIES` (sheet abilities) or `GENERAL` (always shown) in
`scripts/QuickActions.mjs`.

## Shops (GM "store" button)

The GM gets a **store** button in the token controls (players don't).

- **Shops** list: every saved shop with Edit / Visit / Delete, and New Shop.
- **Editing a shop** (a floating panel — move it by its title; the rest of the
  screen stays usable; an item compendium opens beside it automatically, and
  you can switch compendium from the panel): set the shop's name, drag items in from a compendium,
  the Items sidebar or a character sheet (price comes from the item), or add a
  custom item (0 gp). Name, price, coin and stock are editable; leave stock
  empty for unlimited. The chevron on each item opens its details: type, kind
  (potion, spell scroll, martial weapon…), rarity, charges, a damage or healing
  effect, and description. "Open full item sheet" turns it into a real item
  (Items sidebar › Shop Items) edited with dnd5e's own sheet; the shop picks up
  changes on save. Saving checks every item is valid for dnd5e. Shops are saved
  in the world for next time.
- **Shop owner**: pick any character sheet (player characters, NPCs, others)
  or "Someone else" and type a name. The shop then shows as
  "Shop Name (Shop Owner)" in the list, the shop window, receipts and the
  dashboard. An owner picked from a sheet follows that sheet's renames.
- **Visit** opens the shop for every player who has a character (and the GM),
  with **Buy** and **Sell** tabs. The GM's client does every purchase and sale,
  one at a time (so two players can't both buy the last item): it checks stock
  and money, moves the items and coins (making change), updates stock for
  everyone and posts a receipt card. The GM must be logged in.
- **Haggling**: a player changes a price and presses **Haggle**. Their
  Persuasion is rolled automatically and the GM gets a popup with the offer
  and the roll: **Accept**, change the price (a **counter-offer** the player
  accepts or declines) or **Refuse**. Agreed prices last for that visit; the
  receipt shows the list price crossed out. The GM shopping as a character can
  just type a price.
- **Selling**: players offer anything physical from their sheet (not
  containers) at an asking price — half the item's value by default; asking
  more rolls Persuasion. The GM ticks what the shop will buy, and can counter.
  Sold items leave the sheet, the coins arrive, and the shop adds them to its
  wares at the price it paid + 10% (change it in the editor).

Every receipt is also a stat: who bought or sold what, from which shop, how
many and at what price (each line of the receipt). They're uploaded with the chat log
like everything else (old receipts in the log count too) and shown in the
dashboard's **Shops** section: gold spent and earned, purchases, biggest
spender, most expensive item, most used shop, spending and selling per player,
shops by deals, each player's favourite shop and priciest buy, the most
expensive items and the latest deals. API: `GET /api/shop-stats?session=…`.

### Dashboard Shops section

`dashboard/shops.js` adds the Shops section to the existing dashboard. Copy it
next to the dashboard's `index.html` and add one line before `</body>`, after
the dashboard's own script:

```html
<script src="shops.js"></script>
```

`dashboard/test-worlds.js` lets in every player character from worlds whose
world ID has "test" in it (the dashboard otherwise only shows the four campaign
PCs), so test characters show up when looking at a test world; they're tagged
TEST in Manage Names. Install it the same way:
`<script src="test-worlds.js"></script>`.

## Casino (GM "dice" button)

A night at the casino: **Blackjack**, **Roulette** and the **Lizard Races**,
in a tavern-styled window everyone sees.

1. **Lobby.** The GM opens the casino and the window pops up for everyone.
   Each player clicks "＋ name" on the game their character wants, which puts
   their mark there (click it again to take it off), or chooses *Sit out*. The
   GM can seat anyone with the "Seat someone here…" list.
2. **The night.** The GM presses *Open the tables*. The chosen games are played
   one at a time, in lobby order (Blackjack → Roulette → Lizard Races), with
   everyone watching. Characters who chose the same game share the table, each
   with their own bets. A player who closes the window finds it in the "Back
   to …" dock (see below), and it comes back by itself when the next game
   starts.
3. **After each round** the GM picks *Another round*, *Next: …* or *Lobby*.
   *Close the casino* (click twice) ends the night. Ending or leaving a round
   early hands every stake back (with a chat note).

The GM also gets a hurry-along button: *Deal / Spin / Start the race now*
(anyone who hasn't bet sits out), *No more insurance*, and *Stand for …* (for
a player who's gone quiet).

| Game | Rules |
|---|---|
| Blackjack | 6-deck shoe (reshuffled at the cut card, carried between rounds). Dealer stands on all 17s and peeks for blackjack. Blackjack pays 3:2. Double on any first two cards (also after a split). Split any two cards of the same value, up to 4 hands; split aces get one card each, and 21 on a split hand isn't a blackjack. Insurance (half the bet) when the dealer shows an ace pays 2:1. |
| Roulette | European single zero. Set your stake, click the board to place it, right-click to take it back. Numbers pay 35:1, dozens and columns 2:1, red/black, odd/even and 1–18/19–36 evens. Zero loses every outside bet. The result is drawn first, then played out over about 7 seconds the same on every screen: the wheel turns one way, the ball races round the rim the other way, drops, bounces across a few pockets and settles in the winning one. |
| Lizard Races | Four lizards are drawn from a stable of ten, each with hidden speed, consistency and finishing kick. The odds come from simulating that exact field 3,000 times, less the house's cut (about 12%), so favourites really do win more often. Each lizard's last six finishes show as its form. Back one or more lizards to win. The race lasts about 6–7 seconds, is the same on every screen, and calls the lead changes. |

**Betting.** Bets are gold, not chips: type a stake or add +1 / +10 / +25 /
+100 gp coins. At blackjack the stake is your bet; at roulette and the races
it's what each click puts down.

**Money.** Bets come straight off the character sheet when they're placed, and
winnings are paid back when the round settles. All of it happens on the GM's
client, one action at a time. The table limit (default 100 gp a hand, spin or
race) and the casino's name are module settings; the minimum bet is 1 gp.
Players can only bet for characters they own, and only on their turn.

**Fairness.** The dealer is the GM's client. The shoe and the dealer's hole
card are never sent to players until they're turned over, and every random
draw uses the browser's cryptographic random numbers. If the GM reloads
mid-night, the night carries on from where it was, for the same GM in the same
browser.

**Stats.** Every round posts a receipt to chat (each character's stake, what
came back and what happened). The upload reads it like everything else, and
the dashboard's **Casino** section shows rounds played, gold wagered, how far
the house is up or down, luckiest and unluckiest, biggest win, won/lost per
player, rounds by game, each player's record and favourite game, and recent
rounds. API: `GET /api/casino-stats?session=…`. Install
`dashboard/casino.js` like shops.js: `<script src="casino.js"></script>`, after
shops.js.

## "Back to …" dock

Windows that matter mid-activity don't vanish when closed by accident. ✕,
Escape or a click outside tucks them into a button at the bottom of the screen
("Back to The Gilded Flagon (Marta)"), with everything in them kept: quantities,
typed prices, an offer waiting for the GM, casino bets. This covers:

- **Shop visits.** The dock button's own ✕ leaves the shop for good (and
  withdraws an offer still waiting).
- **The GM's haggle / sale offers.** Closing one no longer refuses the offer;
  it waits in the dock until answered.
- **The casino.** It stays in the dock until the GM closes the casino, and comes
  back by itself when the next game starts.

## Combat recap

When the GM ends a combat (that started and had player characters in it),
everyone gets a **recap** popup: Victory / Combat Over, rounds, time, foes
defeated, the **MVP** (most damage) and a card per character — damage, best
hit, hits, kills, healing, damage taken, natural 20s and 1s — with the
**achievements** they earned. It's also saved to chat with a "View recap"
button. Turn it off in the module settings ("Combat recap").

Numbers come from the chat log for the fight, read by the same extractor as
the dashboard ("+" button entries included), so a recap always agrees with
the dashboard.

| Achievement | For |
|---|---|
| First Blood | the first hit of the fight |
| Executioner | most kills (2+) |
| Big Hitter | the biggest single hit |
| Natural Born Killer / Cursed Dice | 2+ natural 20s / 1s |
| Crit Happens | 2+ critical hits |
| Medic | most healing |
| Meat Shield / Untouchable | most damage taken / none at all |
| Sharpshooter / Stormtrooper | hit / missed every attack (3+) |
| Iron Will | passed every save (2+) |
| Close Call | made a death save |
| Pacifist | no attacks or damage, but healed or saved |

## Long-term achievements

Campaign-long achievements, separate from the per-fight recap ones. When a
character earns one (or the next tier of one), a card is posted to chat with
the character as speaker. The primary GM's client keeps score, a couple of
seconds after each chat message, so the GM needs to be logged in. Turn it off
in the module settings ("Achievements"). The dashboard shows them in a
**Trophy Cabinet** section (or "Achievements This Session").

- **Lifetime totals** = this world's chat log + the stats server's totals for
  anything older than it, so clearing the chat loses nothing. If the server
  can't be reached, only the chat log is counted (nothing already awarded is
  lost).
- **Streaks and moments** (two 20s in a row, five misses in a row…) are found
  in the chat log in order.
- What's been awarded is saved in the world (hidden setting
  `achievementStore`), so nothing is announced twice.
- **The first run is silent.** Everything already earned when achievements
  are switched on is recorded with no cards and no note, so the first card is
  a surprise for everyone, GM included. Those earlier achievements still go
  to the dashboard's Trophy Cabinet with the next stats upload. If the stats
  server can't be reached, it waits and tries again each minute rather than
  recording half the picture.
- **Death saves stay secret.** Natural 20s / 1s on death saves don't count
  towards Tymora / Cursed Bones, and the Death Dodger card is whispered to the
  GM and that character's player only. When the party finds out, the GM can
  press **Show to everyone** on the card to make it public. (It still shows
  in the dashboard's Trophy Cabinet.)
- Casino moments (blackjacks, split wins, single numbers, lizards) count for
  rounds played on 1.9.0 or later.

- **Personal achievements.** Each character also has three of their own that
  only they can earn (`character` in the catalog). One set is stored encoded so
  its player can't spoil it by reading the code.
- **The Dungeon Master** has a few of their own too, about the party's
  suffering and the casino's takings (never deaths). Their cards post like
  anyone's, and their cabinet only appears on the dashboard once they've
  earned one.
- **New achievements added in an update** that a character has already earned
  are recorded silently too, so only new progress gets a card.
- **Nothing is listed until someone earns it.** Players only ever see
  achievements on unlock cards and in the dashboard's Trophy Cabinet, so one
  nobody has earned stays unknown. That's why they aren't listed in this
  README.

Names, wording and thresholds live in `scripts/achievements/catalog.mjs`.

The dashboard's Trophy Cabinet is `dashboard/achievements.js`: copy it next to
`index.html` and add `<script src="achievements.js"></script>` after the other
add-on scripts.

## Average initiative

Initiative is rolled every round in this game, so the dashboard shows each
character's average initiative result (not how many times they rolled).
`dashboard/initiative.js` adds an **Avg Init** column to the Character
Statistics table: `<script src="initiative.js"></script>`.

## Wild magic

Wild magic surges are picked up from the chat log: a d100 roll-table draw by a
player counts as a surge for their character. When the d100 is 05–08 (a
friendly creature appears), the player's next d4 says which creature; a 4 is a
unicorn. `dashboard/wild-magic.js` adds a **Unicorns Summoned** card to the
stats row at the top of the dashboard, installed like the others:
`<script src="wild-magic.js"></script>`.

## Backfilling / correcting from a chat export

```bash
API_KEY=$(grep ^API_KEY backend/.env | cut -d= -f2 | tr -d '\r') \
  node scripts/process-chat-export.mjs chat-export.json --dry-run      # check totals first
API_KEY=$(grep ^API_KEY backend/.env | cut -d= -f2 | tr -d '\r') \
  node scripts/process-chat-export.mjs chat-export.json                # upload (prod)
```

Flags: `--target dev|prod`, `--since YYYY-MM-DD`, `--until YYYY-MM-DD`,
`--include-npcs`, `--out events.json`. Safe to run repeatedly.

## Backend

```bash
cd backend && npm install && cp .env.example .env   # fill in DB + API_KEY
pm2 start server.js --name stats                    # tables are created on start
```

Other scripts in `backend/`: `upload-file.js` (load a midi-qol JSON export),
`clear-db.js`, `dedupe-existing.js`. DB backups: `scripts/backup-db.sh` /
`restore-db.sh` (password from `~/.pgpass`).

`stat_uploads` marks where each session ends (created on first start from the
old `actor_stats` uploads). `actor_stats`, `item_stats`, `damage_by_type`
(midi-qol's counters), `dice_rolls` and `roll_outcomes` are no longer read and
can be dropped once you're happy with the new numbers.
