# To Coldly Go — Campaign Stats

A FoundryVTT module (`dnd-group-campaign-2-stats`) plus a small Node/Postgres
backend that records campaign stats and serves them to the dashboard.

## How it works

```
Foundry (GM clicks ☁↑ Upload)
 ├─ chat log ──▶ scripts/extract.mjs ──▶ POST /api/chat-events ──▶ chat_dice, chat_outcomes
 └─ midi-qol stats snapshot ─────────────▶ POST /api/roll-stats  ──▶ actor_stats, item_stats, damage_by_type
```

- **Dice, attacks, saves, checks, death saves and heals** are read from the
  chat log at upload time by `scripts/extract.mjs`. Nothing is counted live.
  Every event is keyed by its chat message ID, and the server replaces what it
  has for a message whenever that message is uploaded again — so uploads are
  idempotent and re-uploading can only correct, never double count.
- **Damage, kills, items etc.** still come from midi-qol's own stats.
- A **session** on the dashboard is one stats upload; dice/outcomes belong to
  the session whose upload follows them.

### What the extractor counts

| Stat | Source |
|------|--------|
| Dice | `message.rolls` only (midi-qol's flag copies of the same rolls are ignored), every die including dropped adv/dis dice; Monk's TokenBar request rolls; skill-check card breakdowns |
| Attacks | PC attack cards with at least one target — midi-qol's `isHit` (falls back to d20/AC) |
| Saves | Each target's `saved` result on any card (e.g. a monster's spell), Monk's TokenBar requests with a DC, standalone save rolls with a DC |
| Checks | Skill-check cards, Monk's TokenBar requests with a DC, standalone checks with a DC |
| Death saves | Death save rolls (≥10 or a natural 20) |
| Heals | PC uses of a healing activity, plus "+" button heals (Lay on Hands, Healer, Add Healing — with amounts) |

Only player characters are tracked.

## Abilities ("+" toolbar button)

Every player gets a **+** button in the token controls. Changes to other
characters are applied by the GM's client (the GM must be logged in). Every
action posts a chat card, which is what the stats are read from.

Always at the top, for every character:

| Action | What it does |
|--------|--------------|
| Add Kill | Confirm → records a kill for the character. Stats only. |
| Add Damage | Optional weapon or spell, a set amount or a dice roll (dice buttons + modifier, or type a formula), damage type (defaults to the weapon's, overridable). Stats only — applied to nobody. |
| Add Healing | Pick a PC (or "None" for stats only) and a set amount or dice roll; the PC is healed (never past max HP). |

Then the character's sheet abilities, alphabetically:

| Ability | Needs | What it does |
|---------|-------|--------------|
| Healer | Healer feat + a Healer's Kit with uses | Battle Medic: each use spends one kit use and one of the patient's hit dice (largest first); rolls that die + the healer's proficiency bonus. 1s are rerolled once (toggle) without spending another die or kit use. Several uses across several PCs in one go. |
| Lay on Hands | A "Lay on Hands" feature with a uses pool | Split the pool across PCs and/or "Other"; heals (never past max HP; only what's healed is spent) and spends the pool on the sheet. |

Stats: heals count as heals (each Healer use separately) and their amounts are
added to total healing; manual damage is added to total damage, max hit, its
damage type and its weapon; manual kills are added to kills (and the weapon,
if one was chosen). Dice rolled in these actions count in the dice stats.

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
- **Visit** opens the shop for every player who has a character (and the GM).
  Players pick who's buying, quantities and — if they haggle — a different
  price. The GM's client checks stock and money, takes the coins (giving
  change), adds the items (stacking consumables/loot), reduces stock for
  everyone, and posts a receipt card; changed prices are flagged in red.
  The GM must be logged in for purchases to go through.

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

`dice_rolls` and `roll_outcomes` are the old live-tracking tables; they're no
longer read and can be dropped once you're happy with the new numbers.
