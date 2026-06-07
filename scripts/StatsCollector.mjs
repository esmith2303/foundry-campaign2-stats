/**
 * StatsCollector
 *
 * Reads midi-qol's RollStats from the live in-memory store first
 * (MidiQOL.gameStats.currentStats), since the persisted setting only
 * updates every N rolls (configSettings.saveStatsEvery, default 20).
 *
 * Also forces a save before reading to ensure the persisted version is
 * up-to-date — that way if the in-memory store is unavailable, the
 * fallback to settings is still fresh.
 */
export class StatsCollector {
  #moduleId;

  constructor(moduleId) {
    this.#moduleId = moduleId;
  }

  async snapshot() {
    // Force midi-qol to persist its current in-memory state
    try {
      if (globalThis.MidiQOL?.gameStats?.saveStats) {
        await MidiQOL.gameStats.saveStats();
      }
    } catch (e) {
      console.warn(`${this.#moduleId} | Could not force midi-qol saveStats:`, e);
    }

    // Prefer live in-memory state — it's always current
    let stats = globalThis.MidiQOL?.gameStats?.currentStats ?? null;

    // Fallback to settings if in-memory unavailable
    if (!stats || Object.keys(stats).length === 0) {
      try { stats = game.settings.get("midi-qol", "RollStats"); } catch {}
    }

    if (!stats || Object.keys(stats).length === 0) {
      console.warn(`${this.#moduleId} | No stats available`);
      return null;
    }

    // Filter out user-level entries (player vs character duplicates)
    const filtered = {};
    for (const [id, data] of Object.entries(stats)) {
      if (game.users?.get(id)) continue;
      filtered[id] = data;
    }
    if (Object.keys(filtered).length === 0) {
      console.warn(`${this.#moduleId} | No actor stats after filtering users`);
      return null;
    }

    // Our dice tracker
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
    // Use in-memory state for count too
    const stats = globalThis.MidiQOL?.gameStats?.currentStats ?? {};
    let count = 0;
    for (const [id] of Object.entries(stats)) {
      if (!game.users?.get(id)) count++;
    }
    return count;
  }
}
