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

  // Legacy live dice-tracking store. No longer used (stats come from the chat
  // log at upload time); kept registered so old worlds load cleanly.
  game.settings.register(moduleId, "diceRolls", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });
}
