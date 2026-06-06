/**
 * StatsUploader
 *
 * Sends a stats snapshot to the configured HTTP endpoint.
 * After a successful upload, resets midi-qol's session counters.
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

  async snapshotAndUpload(collector) {
    const snapshot = collector.snapshot();

    if (!snapshot) {
      ui.notifications.warn("Midi-QOL Stats: No stats to upload — no rolls have been made this session.");
      return;
    }

    const actorCount = Object.keys(snapshot.stats).length;
    ui.notifications.info(`Midi-QOL Stats: Uploading stats for ${actorCount} actor(s)…`);

    const result = await this.upload(snapshot);

    if (result.success) {
      // Reset midi-qol session counters so next session starts fresh
      try {
        await MidiQOL.gameStats.endSession();
        ui.notifications.info(
          `Midi-QOL Stats: ✔ Uploaded ${actorCount} actor(s) and reset session counters.`
        );
      } catch (e) {
        console.warn(`${this.#moduleId} | Failed to reset session:`, e);
        ui.notifications.info(
          `Midi-QOL Stats: ✔ Uploaded ${actorCount} actor(s) but could not reset session counters.`
        );
      }
    } else {
      ui.notifications.error(`Midi-QOL Stats: Upload failed — ${result.error}`);
    }
  }
}
