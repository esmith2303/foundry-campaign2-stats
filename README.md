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
| Add Healing | Pick a PC (or "None" for stats only) and a set amount or dice roll; the PC is healed (never past max HP). |
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
