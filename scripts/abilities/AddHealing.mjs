/**
 * Add Healing — heals a party member for an amount or a dice roll (the GM's
 * client applies the HP), or "None" to record the healing in the stats only.
 */
import { MODULE_ID, escapeHtml, statCard, partyCharacters, hpOf, mountAmountPicker, resolveAmount } from "./shared.mjs";

const APPLY = "add-healing.apply";

async function gmApply({ actorId, targetId, amount, roll } = {}, user) {
  const actor = game.actors.get(actorId);
  if (!actor) throw new Error("Character not found.");
  if (!user?.isGM && !actor.testUserPermission(user, "OWNER")) throw new Error("You don't own that character.");
  const r = roll ? Roll.fromData(roll) : null;
  const total = Math.max(0, Math.floor(r ? r.total : Number(amount)));
  if (!(total > 0)) throw new Error("Nothing to heal.");

  let row;
  if (targetId) {
    const target = game.actors.get(targetId);
    if (!target) throw new Error("That character no longer exists.");
    const hp = hpOf(target);
    const applied = Math.min(total, hp.missing);
    if (applied > 0) await target.update({ "system.attributes.hp.value": hp.value + applied });
    row = { actorId: target.id, name: target.name, requested: total, applied, hpAfter: hp.value + applied, hpMax: hp.max };
  } else {
    row = { actorId: null, name: "No character", requested: total, applied: total };
  }

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: statCard({
      icon: "fas fa-heart", title: "Healing", subtitle: actor.name,
      rows: [{ icon: "fas fa-heart", name: row.name,
               tags: [r && { text: r.formula }, row.applied < row.requested && { text: "capped", cls: "dis" },
                      row.actorId && { text: `${row.hpAfter} / ${row.hpMax}` }].filter(Boolean),
               value: `+${row.applied}`, valueCls: "success" }],
      summary: row.actorId ? "Added manually" : "Added manually for stats — no character healed",
    }),
    rolls: r ? [r] : [],
    flags: { [MODULE_ID]: { abilityUse: { ability: "add-healing", actorId: actor.id, heals: [row.applied], targets: [row] } } },
  });
  return row;
}

function renderPanel(dialog, { actor, close, back, runAsGM }) {
  const party = partyCharacters();
  dialog.innerHTML = `
    <div class="title">Add Healing</div>
    <div class="field">
      <div class="field-label">Heal — by ${escapeHtml(actor.name)}</div>
      <div class="players">
        ${party.map((a, i) => { const hp = hpOf(a); return `
          <div class="player-row">
            <label>
              <input type="radio" name="qa-heal-target" value="${a.id}"${i === 0 ? " checked" : ""}>
              <span>${escapeHtml(a.name)}</span>
            </label>
            <span class="qa-hp">${hp.value}/${hp.max}${hp.missing ? "" : " full"}</span>
          </div>`; }).join("")}
        <div class="player-row">
          <label>
            <input type="radio" name="qa-heal-target" value=""${party.length ? "" : " checked"}>
            <span>None <span class="qa-dim">— stats only, no character is healed</span></span>
          </label>
        </div>
      </div>
    </div>
    <div class="qa-amount"></div>
    <div class="qa-error" hidden></div>
    <div class="actions">
      <button type="button" class="btn" data-qa="back">Back</button>
      <button type="button" class="btn primary" data-qa="go" disabled>Add Healing</button>
    </div>`;

  const picker = mountAmountPicker(dialog.querySelector(".qa-amount"), { label: "Healing" });
  const go = dialog.querySelector('[data-qa="go"]');
  const err = dialog.querySelector(".qa-error");
  const refresh = () => { go.disabled = !picker.isReady(); };
  picker.onChange(refresh);

  dialog.querySelector('[data-qa="back"]').addEventListener("click", back);
  go.addEventListener("click", async () => {
    go.disabled = true; err.hidden = true;
    try {
      const targetId = dialog.querySelector('input[name="qa-heal-target"]:checked')?.value || null;
      const { amount, roll } = await resolveAmount(picker);
      if (!(amount > 0)) throw new Error(roll ? `Rolled ${roll.total} — nothing to heal.` : "Enter an amount.");
      const res = await runAsGM(APPLY, { actorId: actor.id, targetId, amount, roll: roll ? roll.toJSON() : null });
      ui.notifications.info(`Healing: ${res.name} +${res.applied}${res.applied < res.requested ? ` (${res.requested} rolled, capped at full HP)` : ""}.`);
      close();
    } catch (e) {
      err.hidden = false; err.textContent = e.message;
      refresh();
    }
  });
}

export const AddHealing = {
  id: "add-healing",
  label: "Add Healing",
  icon: "fas fa-heart",
  general: true,
  hint: "Heals a PC",
  renderPanel,
  gmActions: { [APPLY]: gmApply },
};
