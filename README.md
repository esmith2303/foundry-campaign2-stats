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
| Heals | PC uses of a healing activity, plus Quick Action heals (e.g. Lay on Hands, with the amount healed) |

Only player characters are tracked.

## Abilities ("+" toolbar button)

Every player gets a **+** button in the token controls. It lists the supported
abilities found on their character's sheet and runs them for them. Changes to
other characters are applied by the GM's client (the GM must be logged in).

| Ability | What it does |
|---------|--------------|
| Lay on Hands | Any character with a "Lay on Hands" feature that has a uses pool. Split the pool across party members and/or "Other"; heals the PCs (never past max HP, and only what's actually healed is spent), spends the pool, and posts a chat card. Counted as a heal on the dashboard, and the amount is added to the character's total healing. |

To add one: create `scripts/abilities/<Name>.mjs` (see `LayOnHands.mjs`) and
add it to `ABILITIES` in `scripts/QuickActions.mjs`.

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
