/**
 * StatsCollector
 *
 * Reads midi-qol's RollStats from Foundry settings.
 * Filters out user-level stats (duplicates of actor stats).
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
      console.warn(`${this.#moduleId} | Could not read midi-qol RollStats setting`);
    }

    if (!stats || Object.keys(stats).length === 0) {
      stats = globalThis.MidiQOL?.gameStats?.currentStats ?? null;
    }

    if (!stats || Object.keys(stats).length === 0) {
      console.warn(`${this.#moduleId} | No stats available`);
      return null;
    }

    // Filter out user-level entries — midi-qol records stats for both
    // the actor (character) and the user (player) for every roll.
    // We only want actor entries to avoid duplicates.
    const filtered = {};
    for (const [id, data] of Object.entries(stats)) {
      // If this ID belongs to a user (player), skip it
      const isUser = game.users?.get(id);
      if (isUser) {
        console.debug(`${this.#moduleId} | Skipping user-level stats for "${data.name}" (${id})`);
        continue;
      }
      filtered[id] = data;
    }

    if (Object.keys(filtered).length === 0) {
      console.warn(`${this.#moduleId} | No actor stats after filtering out users`);
      return null;
    }

    return {
      timestamp: new Date().toISOString(),
      worldId: game.world.id,
      worldName: game.world.title,
      stats: filtered,
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
