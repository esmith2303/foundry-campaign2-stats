/**
 * Long-term achievements: "Blessed by Tymora", "Human Shield III"…
 *
 * The primary GM's client keeps score. A couple of seconds after anything is
 * posted to chat it re-checks the party (only new or changed messages are
 * re-read), and when a character reaches an achievement — or the next tier of
 * one — it posts a card to chat. What's been awarded is saved in the world, so
 * nothing is announced twice.
 *
 * Lifetime totals come from this chat log plus the stats server's totals for
 * anything older than it (up to the last upload), so clearing the chat loses
 * nothing and messages still in chat are always read by the current rules.
 * The first time it runs, everything already earned is recorded silently — no
 * cards and no note to anyone, so the first card is a surprise for everyone,
 * GM included. Those go to the dashboard's Trophy Cabinet with the next stats
 * upload instead (see recordedSilently()).
 *
 * Achievements that would give away a secret death save (Death Dodger) are
 * whispered to the GM and that character's player only, with a "Show to
 * everyone" button for the GM.
 */
import { MODULE_ID, escapeHtml, partyCharacters } from "../abilities/shared.mjs";
import { isPrimaryGM } from "../QuickActions.mjs";
import { chatContext } from "../StatsCollector.mjs";
import { analyseMessage, evaluate, newUnlocks } from "./engine.mjs";
import { linkInfo, buildLinks, DM_ID, DM_NAME } from "../extract.mjs";
import { ACHIEVEMENTS, achievementById, tierName, ROMAN } from "./catalog.mjs";

const STORE = "achievementStore";
// The achievements in 1.9.0, for worlds that started then (newer ones are tracked in the store)
const FIRST_RELEASE = ["tymora", "cursed", "backToBack", "universeHates", "average", "hundredKills", "overkill", "onePunch",
  "glassCannon", "bigNumber", "stormtrooper", "thousandCuts", "deathDodger", "notToday", "humanShield", "fieldMedic", "ironWill",
  "untouched", "bigSpender", "silverTongue", "hoarder", "middleman", "cardCounter", "splittingHairs", "onTheNose", "longShot",
  "lizardWhisperer", "houseWins", "beatTheHouse", "crowdFavourite", "executioner", "friendlyFire", "foundItLikeThat"];
const cache = new Map();          // message id → { stamp, info, key, item }
let baseline = null;              // the server's totals, or null if unavailable
let timer = null, running = false, again = false, ready = false;
let lastFetch = 0;

const enabled = () => { try { return game.settings.get(MODULE_ID, "achievements") !== false; } catch { return true; } };

export function registerAchievements() {
  const later = () => schedule();
  Hooks.on("createChatMessage", later);
  Hooks.on("updateChatMessage", later);
  Hooks.on("deleteChatMessage", (m) => { cache.delete(m.id); });
  Hooks.on(`${MODULE_ID}.uploaded`, () => refreshAchievements({ fetch: true }));
  Hooks.on("renderChatMessageHTML", (m, html) => bindReveal(m, html));
  Hooks.on("renderChatMessage", (m, html) => bindReveal(m, html));
  // First check once everything has settled
  setTimeout(() => refreshAchievements({ fetch: true }).finally(() => { ready = true; }), 3000);
}

function schedule(ms = 2500) {
  if (!ready || !enabled() || !isPrimaryGM()) return;
  clearTimeout(timer);
  timer = setTimeout(() => run().catch(e => console.warn(`${MODULE_ID} | achievements`, e)), ms);
}

/** Re-check now (optionally re-reading the server's totals, e.g. after an upload). */
export async function refreshAchievements({ fetch = false } = {}) {
  if (!enabled() || !isPrimaryGM()) return;
  if (fetch) { lastFetch = Date.now(); baseline = await fetchBaseline(); }
  return run();
}

async function fetchBaseline() {
  const apiUrl = game.settings.get(MODULE_ID, "apiUrl");
  if (!apiUrl) return null;
  // The server counts only what's older than this chat log; the chat log is
  // read here, so everything still in it is counted by the current rules.
  const oldest = Math.min(...game.messages.contents.map(m => Number(m.timestamp) || Infinity));
  const url = `${apiUrl.replace(/\/roll-stats\/?$/, "")}/achievement-baseline?worldId=${encodeURIComponent(game.world.id)}`
    + (Number.isFinite(oldest) ? `&before=${oldest}` : "");
  const headers = {};
  const key = game.settings.get(MODULE_ID, "apiKey");
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn(`${MODULE_ID} | achievements: couldn't read lifetime totals (${e.message}); counting this chat log only`);
    return null;
  }
}

async function run() {
  if (running) { again = true; return; }
  running = true;
  try {
    const ctx = chatContext();
    // 1. What each new or edited message contributes to linking messages together
    const docs = new Map();
    for (const doc of game.messages.contents) {
      docs.set(doc.id, doc);
      const stamp = doc._stats?.modifiedTime ?? doc.timestamp;
      const hit = cache.get(doc.id);
      if (hit && hit.stamp === stamp) continue;
      try { const obj = doc.toObject(); cache.set(doc.id, { stamp, info: linkInfo(obj), obj, key: null, item: null }); }
      catch (e) { console.warn(`${MODULE_ID} | achievements: skipped a message`, e); }
    }
    for (const id of cache.keys()) if (!docs.has(id)) cache.delete(id);
    // 2. Read each message (again if its links changed, e.g. a surge's d4 arrived)
    const links = buildLinks([...cache].map(([id, c]) => [id, c.info]), ctx);
    for (const [id, c] of cache) {
      const l = links(id);
      const key = c.info.surge !== null ? `${l.surgeD4}|${l.mainCharacter}` : "";
      if (c.item && c.key === key) continue;
      try { c.item = analyseMessage(c.obj ?? docs.get(id).toObject(), ctx, l); c.key = key; }
      catch (e) { console.warn(`${MODULE_ID} | achievements: skipped a message`, e); c.item = null; }
      c.obj = null;
    }
    const party = [...partyCharacters().map(a => a.id), DM_ID];   // the DM has achievements too
    const result = evaluate({
      items: [...cache.values()].map(c => c.item).filter(Boolean),
      baseline, sessions: (baseline?.uploads ?? []).map(Number), party,
      isParty: (id) => party.includes(id),
      nameOf: displayName,
    });
    await award(result, party);
  } finally {
    running = false;
    if (again) { again = false; schedule(500); }
  }
}

async function award(result, party) {
  const saved = game.settings.get(MODULE_ID, STORE) ?? {};
  const store = { ...foundry.utils.deepClone(saved), initialised: !!saved.initialised, awarded: foundry.utils.deepClone(saved.awarded ?? {}) };
  const first = !store.initialised;
  // The quiet first pass needs the server's totals (if there's a server), or
  // older achievements would pop up as cards later. Retry once a minute.
  if (first && baseline === null && game.settings.get(MODULE_ID, "apiUrl")) {
    if (Date.now() - lastFetch < 60e3) return;
    lastFetch = Date.now();
    baseline = await fetchBaseline();
    if (baseline === null) return;
    return run();
  }
  // Achievements added in an update: anything already earned when they arrive
  // is recorded silently too, like the first run (only new progress gets a card)
  const known = new Set(saved.known ?? (saved.initialised ? FIRST_RELEASE : []));
  const allIds = ACHIEVEMENTS.map(a => a.id);
  const newIds = allIds.some(id => !known.has(id));
  const posts = [];
  let quiet = false;
  for (const id of party) {
    const unlocks = newUnlocks(result[id].earned, store.awarded[id] ?? {});
    if (!unlocks.length) continue;
    const mine = (store.awarded[id] ??= {});
    for (const u of unlocks) mine[u.id] = Math.max(mine[u.id] ?? 0, u.tier);
    const silent = first ? unlocks : unlocks.filter(u => !known.has(u.id));
    const shown = first ? [] : unlocks.filter(u => known.has(u.id));
    if (silent.length) {
      // Remember what was recorded silently, for the dashboard
      quiet = true;
      store.silent ??= {};
      const rec = (store.silent[id] ??= {});
      for (const u of silent) rec[u.id] = Math.max(rec[u.id] ?? 0, u.tier);
    }
    if (shown.length) posts.push({ actorId: id, unlocks: shown, earned: result[id].earned });
  }
  if (!posts.length && !first && !quiet && !newIds) return;
  if (quiet && !store.silentAt) store.silentAt = Date.now();
  store.known = allIds;
  store.initialised = true;
  // Save first: if posting a card fails, it's lost rather than repeated
  await game.settings.set(MODULE_ID, STORE, store);
  for (const p of posts) {
    const actor = p.actorId === DM_ID ? { id: DM_ID, name: DM_NAME, dm: true } : game.actors.get(p.actorId);
    if (!actor) continue;
    const open = p.unlocks.filter(u => !achievementById(u.id)?.whisper);
    const secret = p.unlocks.filter(u => achievementById(u.id)?.whisper);
    if (open.length) await postCard(actor, open, p.earned);
    if (secret.length) await postCard(actor, secret, p.earned, { whisper: true });
  }
}

/**
 * The achievements recorded silently when achievements were switched on, as
 * one extra "message" for the stats upload, so they reach the dashboard's
 * Trophy Cabinet without a card ever being posted. Null if there are none.
 */
export function recordedSilently() {
  let store;
  try { store = game.settings.get(MODULE_ID, STORE); } catch { return null; }
  if (!store?.silent || !store.silentAt) return null;
  const messageId = "achievements-recorded";
  const outcomes = [];
  for (const [actorId, list] of Object.entries(store.silent)) {
    const actorName = displayName(actorId);
    if (!actorName) continue;
    for (const [id, tier] of Object.entries(list)) {
      const a = achievementById(id);
      if (!a || !(tier > 0)) continue;
      outcomes.push({ actorId, actorName, type: "achievement", success: true, key: `${messageId}:${actorId}:achievement:${id}`,
                      amount: Number(tier), detail: id.slice(0, 60), item: a.name });
    }
  }
  return outcomes.length ? { messageId, timestamp: store.silentAt, dice: [], outcomes, purchases: [] } : null;
}

// ── Cards ────────────────────────────────────────────────────────────────────

function pips(a, tier) {
  if (a.tiers.length < 2) return "";
  return `<span class="qa-ach-pips">${a.tiers.map((_, i) => `<i class="${i < tier ? "on" : ""}"></i>`).join("")}</span>`;
}

function itemHtml(u, earned, compact = false) {
  const a = achievementById(u.id);
  if (!a) return "";
  const threshold = a.tiers[u.tier - 1];
  const next = a.tiers[u.tier];
  const value = earned?.[a.id]?.value ?? threshold;
  const progress = !compact && next !== undefined
    ? `<div class="qa-ach-next"><span>Next: ${escapeHtml(a.desc(next))}</span><span class="qa-ach-bar"><b style="width:${Math.min(100, Math.round(100 * value / next))}%"></b></span><span class="qa-ach-count">${Math.floor(value).toLocaleString()} / ${next.toLocaleString()}</span></div>`
    : "";
  return `
    <div class="qa-ach-item${a.hidden ? " secret" : ""}">
      <span class="qa-ach-icon"><i class="${a.icon}"></i></span>
      <div class="qa-ach-text">
        <div class="qa-ach-name">${escapeHtml(tierName(a, u.tier))}${a.hidden ? ' <span class="qa-ach-tag">secret</span>' : ""}</div>
        <div class="qa-ach-desc">${escapeHtml(a.desc(threshold))}</div>
        ${progress}
      </div>
      ${pips(a, u.tier)}
    </div>`;
}

const displayName = (id) => (id === DM_ID ? DM_NAME : game.actors.get(id)?.name ?? null);

async function postCard(actor, list, earned, { whisper = false } = {}) {
  const ribbon = `<i class="fas fa-trophy"></i> Achievement${list.length > 1 ? "s" : ""} unlocked`;
  const content = `
    <div class="qa-ach-card">
      <div class="qa-ach-ribbon">${ribbon}</div>
      <div class="qa-ach-who">${escapeHtml(actor.name)}</div>
      ${list.map(u => itemHtml(u, earned)).join("")}
      ${whisper ? `${PRIVATE_START}<div class="qa-ach-foot"><i class="fas fa-user-secret"></i> Only you and the GM can see this</div>
        <button type="button" class="qa-ach-reveal" data-qa-ach-reveal><i class="fas fa-eye"></i> Show to everyone</button>${PRIVATE_END}` : ""}
    </div>`;
  const data = {
    speaker: actor.dm ? { alias: DM_NAME } : ChatMessage.getSpeaker({ actor }),
    content,
    flags: { [MODULE_ID]: { achievement: { actorId: actor.id, unlocks: list.map(u => ({ id: u.id, tier: u.tier, name: achievementById(u.id)?.name })) } } },
  };
  if (whisper) data.whisper = game.users.filter(u => u.isGM || (!actor.dm && actor.testUserPermission(u, "OWNER"))).map(u => u.id);
  return ChatMessage.create(data);
}

// ── Whispered cards: the GM can make them public ─────────────────────────────

const PRIVATE_START = "<!--qa-ach-private-->", PRIVATE_END = "<!--/qa-ach-private-->";

function bindReveal(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0] ?? html?.get?.(0);
  const btn = root?.querySelector?.("[data-qa-ach-reveal]");
  if (!btn || btn._qaBound) return;
  btn._qaBound = true;
  if (!game.user.isGM) { btn.remove(); return; }
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    const content = String(message.content ?? "").replace(new RegExp(`${PRIVATE_START}[\\s\\S]*?${PRIVATE_END}`, "g"), "");
    try { await message.update({ whisper: [], blind: false, content, [`flags.${MODULE_ID}.achievement.revealed`]: true }); }
    catch (err) { btn.disabled = false; ui.notifications?.warn(`Couldn't show the achievement: ${err.message}`); }
  });
}

export { ROMAN };
