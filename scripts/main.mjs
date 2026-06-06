import { StatsCollector } from "./StatsCollector.mjs";
import { StatsUploader } from "./StatsUploader.mjs";
import { registerSettings } from "./settings.mjs";

const MODULE_ID = "dnd-group-campaign-2-stats";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initialising`);
  registerSettings(MODULE_ID);
});

Hooks.once("ready", () => {
  if (!game.modules.get("midi-qol")?.active) {
    ui.notifications.error("Midi-QOL Stats Uploader requires midi-qol to be active.");
    return;
  }

  game.modules.get(MODULE_ID).collector = new StatsCollector(MODULE_ID);
  game.modules.get(MODULE_ID).uploader = new StatsUploader(MODULE_ID);

  console.log(`${MODULE_ID} | Ready`);
});

// Register the button in the controls
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const tokenControls = controls["tokens"];
  if (!tokenControls) return;
  tokenControls.tools["midi-qol-upload"] = {
    name: "midi-qol-upload",
    title: "Upload Midi-QOL Stats",
    icon: "fas fa-cloud-upload-alt",
    button: true,
    onChange: () => {},
  };
});

// Attach click listener directly to the DOM button after every render
Hooks.on("renderSceneControls", () => {
  if (!game.user.isGM) return;
  const btn = document.querySelector('[data-tool="midi-qol-upload"]');
  if (!btn) return;

  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);

  newBtn.addEventListener("click", (e) => {
    e.stopPropagation();

    const mod = game.modules.get(MODULE_ID);
    const collector = mod?.collector;
    const uploader = mod?.uploader;

    if (!collector || !uploader) {
      ui.notifications.error("Midi-QOL Stats Uploader is not initialised.");
      return;
    }

    const apiUrl = game.settings.get(MODULE_ID, "apiUrl") || "(not configured)";
    const midiActive = game.modules.get("midi-qol")?.active;
    const now = new Date().toLocaleString();
    const actorCount = collector.pendingCount;

    new Dialog({
      title: "Upload Midi-QOL Stats",
      content: `
        <div class="stats-uploader-dialog">
          <p>Upload session stats for <strong>${actorCount}</strong> actor(s) and reset session counters.</p>
          <p><strong>Time:</strong> ${now}</p>
          <p><strong>Endpoint:</strong> <code>${apiUrl}</code></p>
          ${actorCount === 0 ? '<p style="color:orange">⚠ No stats yet — make some rolls first.</p>' : ""}
          ${apiUrl === "(not configured)" ? '<p style="color:orange">⚠ No API URL set in Module Settings.</p>' : ""}
        </div>
      `,
      buttons: {
        upload: {
          icon: '<i class="fas fa-cloud-upload-alt"></i>',
          label: "Upload & End Session",
          callback: () => uploader.snapshotAndUpload(collector),
        },
        settings: {
          icon: '<i class="fas fa-cog"></i>',
          label: "Settings",
          callback: () => game.settings.sheet.render(true),
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
        },
      },
      default: actorCount > 0 ? "upload" : "settings",
    }).render(true);
  });
});
