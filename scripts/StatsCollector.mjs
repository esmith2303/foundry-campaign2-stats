/**
 * StatsCollector
 * Reads midi-qol's live stats + our dice tracker.
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
    if (!stats || Object.keys(stats).length === 0) {
      console.warn(`${this.#moduleId} | No stats available`);
      return null;
    }

    // Filter out user-level entries
    const filtered = {};
    for (const [id, data] of Object.entries(stats)) {
      if (game.users?.get(id)) continue;
      filtered[id] = data;
    }
    if (Object.keys(filtered).length === 0) {
      console.warn(`${this.#moduleId} | No actor stats after filtering users`);
      return null;
    }

    // Our dice + outcomes tracker
    let diceRolls = {};
    try { diceRolls = game.settings.get(this.#moduleId, "diceRolls") || {}; } catch {}
    const filteredDice = {};
    for (const [id, data] of Object.entries(diceRolls)) {
      if (game.users?.get(id)) continue;
      filteredDice[id] = data;
    }

    return {
      timestamp: new Date().toISOString(),
      worldId: game.world.id,
      worldName: game.world.title,
      stats: filtered,
      diceRolls: filteredDice,
    };
  }

  get pendingCount() {
    const stats = globalThis.MidiQOL?.gameStats?.currentStats ?? {};
    let count = 0;
    for (const [id] of Object.entries(stats)) {
      if (!game.users?.get(id)) count++;
    }
    return count;
  }
}
