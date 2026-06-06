/**
 * UploaderUI — GM toolbar button + confirmation dialog
 *
 * v13+: controls is an object keyed by name, tools is also an object.
 *       Buttons use onChange instead of onClick.
 * v11/v12: controls is an array, tools is an array, uses onClick.
 */
export class UploaderUI {
  static addToolbarButton(moduleId) {
    Hooks.on("getSceneControlButtons", (controls) => {
      if (!game.user.isGM) return;

      const tokenControls = controls["tokens"];
      if (tokenControls) {
        tokenControls.tools["midi-qol-upload"] = {
          name: "midi-qol-upload",
          title: "Upload Midi-QOL Stats",
          icon: "fas fa-cloud-upload-alt",
          button: true,
          onClick: () => UploaderUI.#showUploadDialog(moduleId),
        };
      }
    });
  }

  static async showUploadDialog(moduleId) {
    const mod = game.modules.get(moduleId);
    const collector = mod?.collector;
    const uploader = mod?.uploader;

    if (!collector || !uploader) {
      ui.notifications.error("Midi-QOL Stats Uploader is not initialised.");
      return;
    }

    const apiUrl = game.settings.get(moduleId, "apiUrl") || "(not configured)";
    const midiActive = game.modules.get("midi-qol")?.active;
    const now = new Date().toLocaleString();

    const content = `
      <div class="stats-uploader-dialog">
        <p>This will upload a <strong>snapshot</strong> of current midi-qol session stats
        for all actors to your database.</p>
        <table class="upload-info-table">
          <tr><td>Timestamp</td><td><strong>${now}</strong></td></tr>
          <tr><td>Endpoint</td><td><code>${apiUrl}</code></td></tr>
          <tr><td>midi-qol</td><td>${midiActive ? "✔ active" : "✘ not active"}</td></tr>
        </table>
        ${!apiUrl || apiUrl === "(not configured)"
          ? '<p class="warn">⚠ No API URL set — configure it in Module Settings first.</p>'
          : ""}
      </div>
    `;

    new Dialog({
      title: "Upload Midi-QOL Stats",
      content,
      buttons: {
        upload: {
          icon: '<i class="fas fa-cloud-upload-alt"></i>',
          label: "Upload Snapshot Now",
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
      default: midiActive ? "upload" : "settings",
    }).render(true);
  }
}
