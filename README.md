# Midi-QOL Stats Uploader

A FoundryVTT module that collects roll data from **midi-qol** and lets the GM
upload it to a PostgreSQL or MySQL database with a single button click.

---

## How it works

```
midi-qol  ──(hook)──▶  StatsCollector  ──(in-memory queue)──▶  [GM clicks button]
                                                                       │
                                                               StatsUploader.upload()
                                                                       │
                                                               POST /api/roll-stats
                                                                       │
                                                               backend/server.js
                                                                       │
                                                            INSERT INTO roll_stats
```

Every completed roll fires the `midi-qol.RollComplete` hook. The module
captures actor name, item name, attack total, d20 result, crit/fumble flags,
damage, saving throws, and targets into an in-memory queue. When the GM clicks
the toolbar button and confirms, the whole queue is sent to your backend in one
HTTP request, then flushed.

---

## Installation

### 1. Install the Foundry module

Copy the `midi-qol-stats-uploader/` folder (everything except `backend/`) into
your Foundry `Data/modules/` directory so the path is:

```
Data/modules/midi-qol-stats-uploader/module.json
```

Enable it in Foundry under **Game Settings → Manage Modules**.

### 2. Start the backend

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your DB credentials and API key
node server.js
```

The server will automatically create the `roll_stats` table on first run.

### 3. Configure the module in Foundry

Go to **Settings → Module Settings → Midi-QOL Stats Uploader** and set:

| Setting | Value |
|---------|-------|
| **API Endpoint URL** | `http://your-server:3000/api/roll-stats` |
| **API Key** | The `API_KEY` value from your `.env` |

---

## The GM button

A cloud-upload icon (☁ ↑) appears in the **Token Controls** toolbar on the left
side of the canvas. Click it to see how many rolls are queued, then click
**Upload Now** to send them.

---

## Database schema

Table: `roll_stats`

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `workflow_id` | varchar | midi-qol internal ID |
| `recorded_at` | timestamp | when the roll happened |
| `world_id` | varchar | Foundry world ID |
| `actor_name` | varchar | character who rolled |
| `item_name` | varchar | spell/weapon/ability used |
| `has_attack` | boolean | |
| `attack_total` | int | final attack roll value |
| `attack_d20` | int | raw d20 result (before modifiers) |
| `is_critical` | boolean | |
| `is_fumble` | boolean | |
| `damage_total` | int | |
| `saves` | jsonb | array of `{tokenUuid, total, success}` |
| `targets_hit` | jsonb | array of `{id, name}` |
| `targets_missed` | jsonb | array of `{id, name}` |
| … | | see `server.js` for full list |

---

## Extending

- **Add more fields**: edit `StatsCollector.mjs` (`#extract`) to pull extra
  properties from the workflow, then add matching columns in `server.js`
  (`migrateUp` + the `rows.map` block).
- **Change trigger**: Instead of a button, call `uploader.drainAndUpload(collector)`
  from a `Hooks.on("combatEnd", ...)` listener in `main.mjs`.
- **Different auth**: Replace the bearer-token middleware in `server.js` with
  whatever suits your infrastructure (JWT, IP whitelist, etc.).
