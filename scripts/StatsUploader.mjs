/**
 * StatsUploader
 *
 * Sends a stats snapshot to the configured HTTP endpoint.
 *
 * POST <apiUrl>
 * Headers:
 *   Content-Type: application/json
 *   Authorization: Bearer <apiKey>   (if set)
 *
 * Body:
 * {
 *   "timestamp": "2024-01-01T20:00:00.000Z",
 *   "worldId": "my-world",
 *   "worldName": "My Campaign",
 *   "stats": {
 *     "<actorId>": {
 *       "name": "Actor Name",
 *       "session": { ...counters... },
 *       "lifetime": { ...counters... },
 *       "itemStats": { ... },
 *       "sessionDamageDealtByType": { ... },
 *       ...
 *     }
 *   }
 * }
 */
export class StatsUploader {
  #moduleId;

  constructor(moduleId) {
    this.#moduleId = moduleId;
  }

  async upload(snapshot) {
    const apiUrl = game.settings.get(this.#moduleId, "apiUrl");
    const apiKey = game.settings.get(this.#moduleId, "apiKey");

    if (!apiUrl) {
      return { success: false, error: "No API URL configured. Check module settings." };
    }

    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    let response;
    try {
      response = await fetch(apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(snapshot),
      });
    } catch (networkErr) {
      return { success: false, error: `Network error: ${networkErr.message}` };
    }

    if (!response.ok) {
      let detail = "";
      try { detail = `: ${(await response.text()).slice(0, 200)}`; } catch {}
      return { success: false, error: `Server returned ${response.status}${detail}` };
    }

    return { success: true };
  }

  /**
   * Convenience: snapshot + upload + notify user.
   */
  async snapshotAndUpload(collector) {
    const snapshot = collector.snapshot();

    if (!snapshot) {
      ui.notifications.warn("Midi-QOL Stats: Could not read stats from midi-qol. Make sure some rolls have been made this session.");
      return;
    }

    const actorCount = Object.keys(snapshot.stats).length;
    ui.notifications.info(`Midi-QOL Stats: Uploading stats for ${actorCount} actor(s)…`);

    const result = await this.upload(snapshot);

    if (result.success) {
      ui.notifications.info(`Midi-QOL Stats: ✔ Uploaded stats for ${actorCount} actor(s) — ${new Date(snapshot.timestamp).toLocaleTimeString()}`);
    } else {
      ui.notifications.error(`Midi-QOL Stats: Upload failed — ${result.error}`);
      console.error(`${this.#moduleId} | Upload failed:`, result.error);
    }
  }
}
