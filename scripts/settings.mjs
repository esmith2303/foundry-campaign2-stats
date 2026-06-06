export function registerSettings(moduleId) {
  game.settings.register(moduleId, "apiUrl", {
    name: "API Endpoint URL",
    hint: "The URL of your backend endpoint. Example: http://your-server/api/roll-stats",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(moduleId, "apiKey", {
    name: "API Key (Bearer token)",
    hint: "Optional. Sent as Authorization: Bearer <key>.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  // Internal storage for dice roll tracking — not shown in settings UI
  game.settings.register(moduleId, "diceRolls", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });
}
