/**
 * registerSettings
 *
 * Registers the module's persistent settings with Foundry.
 * These appear under Settings → Module Settings → Midi-QOL Stats Uploader.
 */
export function registerSettings(moduleId) {
  game.settings.register(moduleId, "apiUrl", {
    name: "API Endpoint URL",
    hint: "The URL of your backend endpoint that receives roll data. Example: https://your-server.com/api/roll-stats",
    scope: "world",      // stored server-side, same for all users
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(moduleId, "apiKey", {
    name: "API Key (Bearer token)",
    hint: "Optional. If set, sent as Authorization: Bearer <key> with every request.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(moduleId, "debugLogging", {
    name: "Debug Logging",
    hint: "Log each recorded workflow to the browser console.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
}
