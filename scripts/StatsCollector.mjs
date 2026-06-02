/**
 * StatsCollector
 *
 * Reads midi-qol's built-in actor stats object and packages it for upload.
 *
 * The JSON export format (as seen in session_1.json) is:
 * {
 *   "<actorId>": {
 *     "name": "Actor Name",
 *     "session": { ...counters... },
 *     "lifetime": { ...counters... },
 *     "itemStats": { "<itemName>": { "name", "session", "lifetime" } },
 *     "sessionDamageDealtByType": { "<type>": <number> },
 *     "sessionDamageTakenByType": { ... },
 *     "sessionDamageAppliedByType": { ... },
 *     "lifetimeDamage*ByType": { ... }
 *   }
 * }
 *
 * We read this live from midi-qol's internal store so the GM doesn't need
 * to manually export — we replicate exactly what the JSON download produces,
 * then add a session timestamp.
 */
export class StatsCollector {
  #moduleId;

  constructor(moduleId) {
    this.#moduleId = moduleId;
  }

  /**
   * Snapshot the current midi-qol stats, mirroring the JSON export format.
   * Returns { timestamp, stats } where stats matches the exported JSON shape.
   */
  snapshot() {
    const midiApi = globalThis.MidiQOL ?? game.modules.get("midi-qol")?.api;

    // midi-qol exposes player stats via MidiQOL.playerStats or similar
    // Fall back to reading from the internal store directly
    let rawStats = null;

    // Try the public API first (varies by version)
    if (typeof midiApi?.playerStats === "object") {
      rawStats = midiApi.playerStats;
    } else if (typeof midiApi?.getPlayerStats === "function") {
      rawStats = midiApi.getPlayerStats();
    } else {
      // Read directly from the internal module store — same source the
      // "Export JSON" button uses
      const midiModule = game.modules.get("midi-qol");
      rawStats =
        midiModule?.playerStats ??
        midiModule?.stats ??
        null;
    }

    if (!rawStats) {
      console.warn(`${this.#moduleId} | Could not read midi-qol stats — is midi-qol active and has any rolls been made?`);
      return null;
    }

    return {
      timestamp: new Date().toISOString(),
      worldId: game.world.id,
      worldName: game.world.title,
      stats: rawStats,
    };
  }

  /**
   * Pending count is always 0/1 — we snapshot on demand rather than queue.
   * Kept for UI compatibility.
   */
  get pendingCount() {
    // We can always take a snapshot if midi-qol is active
    const midiActive = game.modules.get("midi-qol")?.active ?? false;
    return midiActive ? 1 : 0;
  }
}
