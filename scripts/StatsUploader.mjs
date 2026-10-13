import { uploadEvents, eventsUrlFrom } from "./extract.mjs";

/**
 * StatsUploader
 * 1. Uploads every stat from the whole chat log (idempotent — the server
 *    replaces anything already stored for those messages).
 * 2. Marks the end of the session (POST /roll-stats with no midi-qol stats).
 * Events go first so a failure part-way can simply be retried without
 * creating an extra session.
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

  async upload(body) {
    const apiUrl = game.settings.get(this.#moduleId, "apiUrl");
    if (!apiUrl) return { success: false, error: "No API URL configured." };

    let response;
    try {
      response = await fetch(apiUrl, { method: "POST", headers: this.#headers(), body: JSON.stringify(body) });
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

    // The session ends now: stamp it before reading the chat, so anything posted
    // while uploading lands in the next session (achievements rely on this)
    const marker = collector.session();

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

    // 2. End the session
    const result = await this.upload({ ...marker, stats: {} });
    if (!result.success) {
      return ui.notifications.error(`Stats: rolls uploaded, but the session couldn't be closed — ${result.error}. Try again.`);
    }
    ui.notifications.info(`Stats: ✔ uploaded ${results.length} chat message(s); new session started.`);
    Hooks.callAll(`${this.#moduleId}.uploaded`);
  }
}
