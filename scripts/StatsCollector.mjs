/**
 * StatsCollector
 *
 * Snapshots midi-qol's RollStats + our custom dice roll tracker.
 * Filters out user-level duplicates (player vs character).
 */
export class StatsCollector {
  #moduleId;

  constructor(moduleId) {
    this.#moduleId = moduleId;
  }

  snapshot() {
    let stats = null;
    try {
      stats = game.settings.get("midi-qol", "RollStats");
    } catch (e) {
      console.warn(`${this.#moduleId} | Could not read midi-qol RollStats`);
    }
    if (!stats || Object.keys(stats).length === 0) {
      stats = globalThis.MidiQOL?.gameStats?.currentStats ?? null;
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

    // Pull our dice roll tracker
    let diceRolls = {};
    try {
      diceRolls = game.settings.get(this.#moduleId, "diceRolls") || {};
    } catch {}
    // Filter user entries from dice rolls too
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
    try {
      const stats = game.settings.get("midi-qol", "RollStats");
      let count = 0;
      for (const [id] of Object.entries(stats ?? {})) {
        if (!game.users?.get(id)) count++;
      }
      return count;
    } catch {
      return 0;
    }
  }
}
