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

  game.settings.register(moduleId, "combatRecap", {
    name: "Combat recap",
    hint: "When combat ends, show everyone a recap of the fight with achievements, and save it to chat.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // Shops built by the GM (Shop button). { [shopId]: { id, title, items: [...] } }
  game.settings.register(moduleId, "achievements", {
    name: "Achievements",
    hint: "Award long-term achievements (natural 20s, kills, healing, the casino…) with a chat card when a character earns one.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
  // What's been awarded so far (so nothing is announced twice)
  game.settings.register(moduleId, "achievementStore", { scope: "world", config: false, type: Object, default: {} });

  game.settings.register(moduleId, "casinoName", {
    name: "Casino name",
    hint: "Shown on the casino's sign and its chat receipts.",
    scope: "world",
    config: true,
    type: String,
    default: "The Lucky Lizard",
  });

  game.settings.register(moduleId, "casinoMaxBet", {
    name: "Casino table limit (gp)",
    hint: "The most a character can stake on one hand, spin or race. The minimum bet is 1 gp.",
    scope: "world",
    config: true,
    type: Number,
    default: 100,
  });

  // The lizards' recent form (world) and the GM's running casino night (this browser only)
  game.settings.register(moduleId, "casinoLizards", { scope: "world", config: false, type: Object, default: {} });
  game.settings.register(moduleId, "casinoSave", { scope: "client", config: false, type: Object, default: {} });

  game.settings.register(moduleId, "shops", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
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
