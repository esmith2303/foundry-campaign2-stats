/**
 * StatsCollector
 *
 * Reads midi-qol's RollStats from Foundry settings.
 * Stats are stored at game.settings.get("midi-qol", "RollStats")
 * and also accessible via MidiQOL.gameStats.currentStats.
 */
export class StatsCollector {
  #moduleId;

  constructor(moduleId) {
    this.#moduleId = moduleId;
  }

  snapshot() {
    // Try multiple sources — same data, different access paths
    let stats = null;

    // 1. Direct from Foundry settings (most reliable)
    try {
      stats = game.settings.get("midi-qol", "RollStats");
    } catch (e) {
      console.warn(`${this.#moduleId} | Could not read midi-qol RollStats setting`);
    }

    // 2. Fallback to MidiQOL global
    if (!stats || Object.keys(stats).length === 0) {
      stats = globalThis.MidiQOL?.gameStats?.currentStats ?? null;
    }

    if (!stats || Object.keys(stats).length === 0) {
      console.warn(`${this.#moduleId} | No stats available — no rolls have been made this session`);
      return null;
    }

    return {
      timestamp: new Date().toISOString(),
      worldId: game.world.id,
      worldName: game.world.title,
      stats,
    };
  }

  get pendingCount() {
    try {
      const stats = game.settings.get("midi-qol", "RollStats");
      return Object.keys(stats ?? {}).length;
    } catch {
      return 0;
    }
  }
}
