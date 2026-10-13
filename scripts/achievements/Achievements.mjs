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
 * The first time it runs, everything already earned is announced once per
 * character as a "trophy cabinet" card instead of a flood of cards.
 *
 * Achievements that would give away a secret death save (Death Dodger) are
 * whispered to the GM and that character's player only, with a "Show to
 * everyone" button for the GM.
 */
import { MODULE_ID, escapeHtml, partyCharacters } from "../abilities/shared.mjs";
import { isPrimaryGM } from "../QuickActions.mjs";
import { chatContext } from "../StatsCollector.mjs";
import { analyseMessage, evaluate, newUnlocks } from "./engine.mjs";
import { ACHIEVEMENTS, achievementById, tierName, ROMAN } from "./catalog.mjs";

const STORE = "achievementStore";
const cache = new Map();          // message id → { stamp, item }
let baseline = null;              // the server's totals, or null if unavailable
let timer = null, running = false, again = false, ready = false;

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
  if (fetch) baseline = await fetchBaseline();
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
    const seen = new Set();
    for (const doc of game.messages.contents) {
      seen.add(doc.id);
      const stamp = doc._stats?.modifiedTime ?? doc.timestamp;
      const hit = cache.get(doc.id);
      if (hit && hit.stamp === stamp) continue;
      try { cache.set(doc.id, { stamp, item: analyseMessage(doc.toObject(), ctx) }); }
      catch (e) { console.warn(`${MODULE_ID} | achievements: skipped a message`, e); }
    }
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
    const party = partyCharacters().map(a => a.id);
    const result = evaluate({
      items: [...cache.values()].map(c => c.item),
      baseline, sessions: (baseline?.uploads ?? []).map(Number), party,
      isParty: (id) => party.includes(id),
    });
    await award(result, party);
  } finally {
    running = false;
    if (again) { again = false; schedule(500); }
  }
}

async function award(result, party) {
  const saved = game.settings.get(MODULE_ID, STORE) ?? {};
  const store = { initialised: !!saved.initialised, awarded: foundry.utils.deepClone(saved.awarded ?? {}) };
  const first = !store.initialised;
  const posts = [];
  for (const id of party) {
    const unlocks = newUnlocks(result[id].earned, store.awarded[id] ?? {});
    if (!unlocks.length) continue;
    const mine = (store.awarded[id] ??= {});
    for (const u of unlocks) mine[u.id] = Math.max(mine[u.id] ?? 0, u.tier);
    posts.push({ actorId: id, unlocks, earned: result[id].earned });
  }
  if (!posts.length && !first) return;
  store.initialised = true;
  // Save first: if posting a card fails, it's lost rather than repeated
  await game.settings.set(MODULE_ID, STORE, store);
  for (const p of posts) {
    const actor = game.actors.get(p.actorId);
    if (!actor) continue;
    const open = p.unlocks.filter(u => !achievementById(u.id)?.whisper);
    const secret = p.unlocks.filter(u => achievementById(u.id)?.whisper);
    if (open.length) await postCard(actor, open, p.earned, { summary: first });
    if (secret.length) await postCard(actor, secret, p.earned, { summary: first, whisper: true });
  }
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

async function postCard(actor, unlocks, earned, { summary = false, whisper = false } = {}) {
  // Summary: one line per achievement at its highest tier so far
  let list = unlocks;
  if (summary) {
    const best = {};
    for (const u of unlocks) best[u.id] = Math.max(best[u.id] ?? 0, u.tier);
    list = ACHIEVEMENTS.filter(a => best[a.id]).map(a => ({ id: a.id, tier: best[a.id] }));
  }
  const ribbon = summary ? `<i class="fas fa-trophy"></i> Trophy cabinet — ${list.length} already earned`
    : `<i class="fas fa-trophy"></i> Achievement${list.length > 1 ? "s" : ""} unlocked`;
  const content = `
    <div class="qa-ach-card${summary ? " summary" : ""}">
      <div class="qa-ach-ribbon">${ribbon}</div>
      <div class="qa-ach-who">${escapeHtml(actor.name)}</div>
      ${list.map(u => itemHtml(u, earned, summary)).join("")}
      ${whisper ? `${PRIVATE_START}<div class="qa-ach-foot"><i class="fas fa-user-secret"></i> Only you and the GM can see this</div>
        <button type="button" class="qa-ach-reveal" data-qa-ach-reveal><i class="fas fa-eye"></i> Show to everyone</button>${PRIVATE_END}` : ""}
    </div>`;
  const data = {
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    flags: { [MODULE_ID]: { achievement: { actorId: actor.id, summary, unlocks: list.map(u => ({ id: u.id, tier: u.tier, name: achievementById(u.id)?.name })) } } },
  };
  if (whisper) data.whisper = game.users.filter(u => u.isGM || actor.testUserPermission(u, "OWNER")).map(u => u.id);
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
