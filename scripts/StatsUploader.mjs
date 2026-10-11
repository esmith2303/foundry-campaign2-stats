import { uploadEvents, eventsUrlFrom } from "./extract.mjs";

/**
 * StatsUploader
 * 1. Uploads dice/outcome events from the whole chat log (idempotent — the
 *    server replaces anything already stored for those messages).
 * 2. Uploads midi-qol's session stats, then resets the midi-qol session.
 * Events go first so a failure part-way can simply be retried without
 * creating a duplicate stats session.
 */
export class StatsUploader {
  #moduleId;

  constructor(moduleId) {
    this.#moduleId = moduleId;
  }

  #headers() {
    const apiKey = game.settings.get(this.#moduleId, "apiKey");
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    return headers;
  }

  async upload(snapshot) {
    const apiUrl = game.settings.get(this.#moduleId, "apiUrl");
    if (!apiUrl) return { success: false, error: "No API URL configured." };

    let response;
    try {
      response = await fetch(apiUrl, { method: "POST", headers: this.#headers(), body: JSON.stringify(snapshot) });
    } catch (e) {
      return { success: false, error: `Network error: ${e.message}` };
    }
    if (!response.ok) {
      let detail = "";
      try { detail = `: ${(await response.text()).slice(0, 200)}`; } catch {}
      return { success: false, error: `Server returned ${response.status}${detail}` };
    }
    return { success: true };
  }

  async snapshotAndUpload(collector) {
    const apiUrl = game.settings.get(this.#moduleId, "apiUrl");
    if (!apiUrl) return ui.notifications.error("Stats: no API URL configured.");

    // 1. Chat-log events
    const results = collector.chatEvents();
    ui.notifications.info(`Stats: uploading rolls from ${results.length} chat message(s)…`);
    try {
      await uploadEvents({
        url: eventsUrlFrom(apiUrl),
        apiKey: game.settings.get(this.#moduleId, "apiKey"),
        worldId: game.world.id,
        worldName: game.world.title,
        results,
      });
    } catch (e) {
      console.error(`${this.#moduleId} | chat events upload failed:`, e);
      return ui.notifications.error(`Stats: roll upload failed — ${e.message}. Nothing was reset; try again.`);
    }

    // 2. midi-qol stats
    const snapshot = await collector.snapshot();
    const actorCount = Object.keys(snapshot.stats).length;
    if (!actorCount) {
      return ui.notifications.warn("Stats: ✔ rolls uploaded, but midi-qol had no session stats to upload.");
    }
    const result = await this.upload(snapshot);
    if (!result.success) {
      return ui.notifications.error(`Stats: rolls uploaded, but midi-qol stats failed — ${result.error}`);
    }

    try {
      await MidiQOL.gameStats.endSession();
      ui.notifications.info(`Stats: ✔ uploaded rolls and ${actorCount} actor(s); session reset.`);
    } catch (e) {
      console.warn(`${this.#moduleId} | Failed to reset midi-qol session:`, e);
      ui.notifications.info(`Stats: ✔ uploaded rolls and ${actorCount} actor(s).`);
    }
  }
}
