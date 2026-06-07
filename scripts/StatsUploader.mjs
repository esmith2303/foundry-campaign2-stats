/**
 * StatsUploader
 * Uploads snapshot to API, then resets midi-qol session and our dice tracker.
 */
export class StatsUploader {
  #moduleId;

  constructor(moduleId) {
    this.#moduleId = moduleId;
  }

  async upload(snapshot) {
    const apiUrl = game.settings.get(this.#moduleId, "apiUrl");
    const apiKey = game.settings.get(this.#moduleId, "apiKey");

    if (!apiUrl) return { success: false, error: "No API URL configured." };

    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    let response;
    try {
      response = await fetch(apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(snapshot),
      });
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
    const snapshot = await collector.snapshot();
    if (!snapshot) {
      ui.notifications.warn("Midi-QOL Stats: No stats to upload.");
      return;
    }

    const actorCount = Object.keys(snapshot.stats).length;
    ui.notifications.info(`Midi-QOL Stats: Uploading ${actorCount} actor(s)…`);

    const result = await this.upload(snapshot);

    if (result.success) {
      try {
        await MidiQOL.gameStats.endSession();
        await game.settings.set(this.#moduleId, "diceRolls", {});
        ui.notifications.info(`Midi-QOL Stats: ✔ Uploaded ${actorCount} actor(s) and reset session.`);
      } catch (e) {
        console.warn(`${this.#moduleId} | Failed to reset:`, e);
        ui.notifications.info(`Midi-QOL Stats: ✔ Uploaded ${actorCount} actor(s).`);
      }
    } else {
      ui.notifications.error(`Midi-QOL Stats: Upload failed — ${result.error}`);
    }
  }
}
