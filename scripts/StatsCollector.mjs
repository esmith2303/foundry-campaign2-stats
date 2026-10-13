import { extractAll } from "./extract.mjs";

/**
 * StatsCollector
 * - session(): the marker that ends a stats session (time + world)
 * - chatEvents(): every stat — dice, attacks, damage, kills, healing, saves…
 *   read from the chat log (midi-qol's own counters aren't used)
 */
export class StatsCollector {
  #moduleId;

  constructor(moduleId) {
    this.#moduleId = moduleId;
  }

  session() {
    return { timestamp: new Date().toISOString(), worldId: game.world.id, worldName: game.world.title };
  }

  /** Every message in the chat log, run through the shared extractor. */
  chatEvents() {
    return extractAll(game.messages.contents.map(m => m.toObject()), chatContext());
  }
}

/** What the extractor needs to know about this world (also used by the achievements). */
export function chatContext() {
  return {
    isPlayerCharacter: (id) => !!game.actors.get(id)?.hasPlayerOwner,
    actorName: (id, fallback) => game.actors.get(id)?.name ?? fallback,
    // "+" entries and receipts only count when posted by the character's owner or a GM
    canUserAct: (userId, actorId) => {
      const user = game.users.get(userId), actor = game.actors.get(actorId);
      if (!user || !actor) return true;   // can't check (deleted user/actor): keep it
      return user.isGM || actor.testUserPermission(user, "OWNER");
    },
    // The character a player has assigned (for wild magic surge draws)
    characterOfUser: (userId) => game.users.get(userId)?.character?.id ?? null,
    // Token UUIDs without an "Actor." part (unlinked tokens)
    resolveActorId: (uuid) => {
      try { const doc = fromUuidSync(uuid); return doc?.actor?.id ?? (doc?.documentName === "Actor" ? doc.id : null); }
      catch { return null; }
    },
  };
}
