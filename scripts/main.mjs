import { StatsCollector } from "./StatsCollector.mjs";
import { StatsUploader } from "./StatsUploader.mjs";
import { UploaderUI } from "./UploaderUI.mjs";
import { registerSettings } from "./settings.mjs";

const MODULE_ID = "dnd-group-campaign-2-stats";

// ── Initialisation ────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initialising`);
  registerSettings(MODULE_ID);

  // Must be registered here — getSceneControlButtons fires before "ready"
  UploaderUI.addToolbarButton(MODULE_ID);
});

Hooks.once("ready", () => {
  if (!game.modules.get("midi-qol")?.active) {
    ui.notifications.error(
      "Midi-QOL Stats Uploader requires midi-qol to be active."
    );
    return;
  }

  game.modules.get(MODULE_ID).collector = new StatsCollector(MODULE_ID);
  game.modules.get(MODULE_ID).uploader = new StatsUploader(MODULE_ID);

  console.log(`${MODULE_ID} | Ready`);
});

// ── Listen to midi-qol roll completions ──────────────────────────────────────

Hooks.on("midi-qol.RollComplete", (workflow) => {
  if (!game.user.isGM) return;
  const collector = game.modules.get(MODULE_ID)?.collector;
  if (collector) collector.record(workflow);
});
