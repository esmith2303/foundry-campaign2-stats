/**
 * StatsCollector
 * Reads midi-qol's live stats + our dice/outcomes tracker.
 * Returns a snapshot if EITHER source has data.
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

    // Our dice + outcomes tracker
    let diceRolls = {};
    try { diceRolls = game.settings.get(this.#moduleId, "diceRolls") || {}; } catch {}
    const filteredDice = {};
    for (const [id, data] of Object.entries(diceRolls)) {
      if (game.users?.get(id)) continue;
      filteredDice[id] = data;
    }

    const hasStats = Object.keys(filteredStats).length > 0;
    const hasDice = Object.keys(filteredDice).length > 0;

    if (!hasStats && !hasDice) {
      console.warn(`${this.#moduleId} | No stats or dice data to upload`);
      return null;
    }

    return {
      timestamp: new Date().toISOString(),
      worldId: game.world.id,
      worldName: game.world.title,
      stats: filteredStats,
      diceRolls: filteredDice,
    };
  }

  // Count of actors with ANY tracked data (midi-qol stats OR dice OR outcomes)
  get pendingCount() {
    const actorIds = new Set();

    const stats = globalThis.MidiQOL?.gameStats?.currentStats ?? {};
    for (const [id] of Object.entries(stats)) {
      if (!game.users?.get(id)) actorIds.add(id);
    }

    let diceRolls = {};
    try { diceRolls = game.settings.get(this.#moduleId, "diceRolls") || {}; } catch {}
    for (const [id] of Object.entries(diceRolls)) {
      if (!game.users?.get(id)) actorIds.add(id);
    }

    return actorIds.size;
  }
}
