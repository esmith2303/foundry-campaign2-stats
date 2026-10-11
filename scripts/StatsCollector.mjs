import { extractAll } from "./extract.mjs";

/**
 * StatsCollector
 * - snapshot(): midi-qol's own per-actor stats (damage, kills, items…)
 * - chatEvents(): dice / attacks / saves / checks / heals, read from the chat log
 */
export class StatsCollector {
  #moduleId;

  constructor(moduleId) {
    this.#moduleId = moduleId;
  }

  async snapshot() {
    // Force midi-qol to persist its in-memory state
    try {
      if (globalThis.MidiQOL?.gameStats?.saveStats) {
        await MidiQOL.gameStats.saveStats();
      }
    } catch (e) {
      console.warn(`${this.#moduleId} | Could not force midi-qol saveStats:`, e);
    }

    // Live in-memory state first, fall back to settings
    let stats = globalThis.MidiQOL?.gameStats?.currentStats ?? null;
    if (!stats || Object.keys(stats).length === 0) {
      try { stats = game.settings.get("midi-qol", "RollStats"); } catch {}
    }
    stats = stats || {};

    // Filter out user-level entries
    const filteredStats = {};
    for (const [id, data] of Object.entries(stats)) {
      if (game.users?.get(id)) continue;
      filteredStats[id] = data;
    }

    return {
      timestamp: new Date().toISOString(),
      worldId: game.world.id,
      worldName: game.world.title,
      stats: filteredStats,
    };
  }

  /** Every message in the chat log, run through the shared extractor. */
  chatEvents() {
    const ctx = {
      isPlayerCharacter: (id) => !!game.actors.get(id)?.hasPlayerOwner,
      actorName: (id, fallback) => game.actors.get(id)?.name ?? fallback,
      // Token UUIDs without an "Actor." part (unlinked tokens)
      resolveActorId: (uuid) => {
        try { const doc = fromUuidSync(uuid); return doc?.actor?.id ?? (doc?.documentName === "Actor" ? doc.id : null); }
        catch { return null; }
      },
    };
    return extractAll(game.messages.contents.map(m => m.toObject()), ctx);
  }

  // Count of actors with midi-qol stats this session
  get pendingCount() {
    const stats = globalThis.MidiQOL?.gameStats?.currentStats ?? {};
    return Object.keys(stats).filter(id => !game.users?.get(id)).length;
  }
}
