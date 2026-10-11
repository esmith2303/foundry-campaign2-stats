/** Small helpers shared by the Quick Actions popup and the abilities. */

export const MODULE_ID = "dnd-group-campaign-2-stats";

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** The party: player-owned characters, alphabetical. */
export function partyCharacters() {
  return game.actors.contents
    .filter(a => a.type === "character" && a.hasPlayerOwner)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Current / effective max / missing HP of an actor. */
export function hpOf(actor) {
  const hp = actor?.system?.attributes?.hp ?? {};
  const value = Number(hp.value) || 0;
  const max = Number(hp.effectiveMax ?? ((Number(hp.max) || 0) + (Number(hp.tempmax) || 0))) || 0;
  return { value, max, missing: Math.max(0, max - value) };
}
