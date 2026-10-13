/**
 * Add Healing — heals a party member for an amount or a dice roll (the GM's
 * client applies the HP), or "Stats Only" to record the healing without
 * healing anyone. The healing counts for whichever character is picked as the
 * healer.
 */
import { MODULE_ID, escapeHtml, statCard, partyCharacters, hpOf, mountAmountPicker, resolveAmount, assertOwns, assertPartyTarget } from "./shared.mjs";

const APPLY = "add-healing.apply";

async function gmApply({ actorId, targetId, amount, roll } = {}, user) {
  const actor = game.actors.get(actorId);
  assertOwns(actor, user);
  const r = roll ? Roll.fromData(roll) : null;
  const total = Math.max(0, Math.floor(r ? r.total : Number(amount)));
  if (!(total > 0)) throw new Error("Nothing to heal.");

  let row;
  if (targetId) {
    const target = game.actors.get(targetId);
    assertPartyTarget(target, user);
    const hp = hpOf(target);
    if (hp.missing <= 0) throw new Error(`${target.name} is already at full HP.`);
    const applied = Math.min(total, hp.missing);
    if (applied > 0) await target.update({ "system.attributes.hp.value": hp.value + applied });
    row = { actorId: target.id, name: target.name, requested: total, applied, hpAfter: hp.value + applied, hpMax: hp.max };
  } else {
    row = { actorId: null, name: "Stats only", requested: total, applied: total };
  }

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: await statCard({
      icon: "fas fa-heart", title: "Healing", subtitle: actor.name,
      rows: [{ name: row.name, value: `+${row.applied}`, valueCls: "success",
               meta: [row.actorId && `HP ${row.hpAfter} / ${row.hpMax}`,
                      row.applied < row.requested && `capped at full HP (${row.requested})`],
               roll: r }],
      summary: row.actorId ? "Added manually" : "Added manually for stats — no character healed",
    }),
    rolls: r ? [r] : [],
    flags: { [MODULE_ID]: { abilityUse: { ability: "add-healing", actorId: actor.id, heals: [row.applied], targets: [row],
      undo: row.actorId && row.applied > 0 ? [{ kind: "hp", actorId: row.actorId, value: row.applied }] : [] } } },
  });
  return row;
}

function renderPanel(dialog, { actor, casters = [actor], close, back, runAsGM }) {
  const party = partyCharacters();
  const firstHurt = party.find(a => hpOf(a).missing > 0);
  // Who gets the healing in their stats (players usually only have the one)
  const healers = casters.length ? casters : [actor];
  const healerField = healers.length > 1 ? `
    <div class="field">
      <div class="field-label">Healing done by</div>
      <div class="players">
        ${healers.map(a => `
          <div class="player-row">
            <label>
              <input type="radio" name="qa-healer" value="${a.id}"${a.id === actor.id ? " checked" : ""}>
              <span>${escapeHtml(a.name)}</span>
            </label>
          </div>`).join("")}
      </div>
    </div>` : `
    <div class="field">
      <div class="field-label">Healing done by ${escapeHtml(actor.name)}</div>
    </div>`;
  dialog.innerHTML = `
    <div class="title">Add Healing</div>
    ${healerField}
    <div class="field">
      <div class="field-label">Heal</div>
      <div class="players">
        ${party.map(a => { const hp = hpOf(a); const full = hp.missing <= 0; return `
          <div class="player-row${full ? " qa-row-full" : ""}" title="${full ? "Already at full HP" : ""}">
            <label>
              <input type="radio" name="qa-heal-target" value="${a.id}" data-missing="${hp.missing}"${a === firstHurt ? " checked" : ""}${full ? " disabled" : ""}>
              <span>${escapeHtml(a.name)}</span>
            </label>
            <span class="qa-hp">${hp.value}/${hp.max}${full ? " · full HP" : ` · −${hp.missing}`}</span>
          </div>`; }).join("")}
        <div class="player-row">
          <label>
            <input type="radio" name="qa-heal-target" value="" data-missing=""${party.length ? "" : " checked"}>
            <span>Stats Only <span class="qa-dim">— no character is healed</span></span>
          </label>
        </div>
      </div>
    </div>
    <div class="qa-amount"></div>
    <div class="qa-warn" hidden></div>
    <div class="qa-error" hidden></div>
    <div class="actions">
      <button type="button" class="btn" data-qa="back">Back</button>
      <button type="button" class="btn primary" data-qa="go" disabled>Add Healing</button>
    </div>`;

  const picker = mountAmountPicker(dialog.querySelector(".qa-amount"), { label: "Healing" });
  const go = dialog.querySelector('[data-qa="go"]');
  const err = dialog.querySelector(".qa-error");
  const warn = dialog.querySelector(".qa-warn");
  const chosen = () => dialog.querySelector('input[name="qa-heal-target"]:checked');
  const refresh = () => {
    const pick = chosen();
    let message = "";
    if (!pick) message = "Everyone is already at full HP — choose Stats Only to record the healing without healing anyone.";
    else if (pick.value && picker.mode() === "set") {
      const missing = Number(pick.dataset.missing) || 0, amount = picker.setAmount() || 0;
      if (amount > missing) message = `Only ${missing} HP missing — healing will stop at full HP (+${missing}).`;
    }
    warn.hidden = !message;
    warn.textContent = message;
    go.disabled = !pick || !picker.isReady();
  };
  picker.onChange(refresh);
  dialog.querySelectorAll('input[name="qa-heal-target"]').forEach(r => r.addEventListener("change", refresh));
  refresh();

  dialog.querySelector('[data-qa="back"]').addEventListener("click", back);
  go.addEventListener("click", async () => {
    go.disabled = true; err.hidden = true;
    try {
      const targetId = dialog.querySelector('input[name="qa-heal-target"]:checked')?.value || null;
      const { amount, roll } = await resolveAmount(picker);
      if (!(amount > 0)) throw new Error(roll ? `Rolled ${roll.total} — nothing to heal.` : "Enter an amount.");
      const healerId = dialog.querySelector('input[name="qa-healer"]:checked')?.value || actor.id;
      const res = await runAsGM(APPLY, { actorId: healerId, targetId, amount, roll: roll ? roll.toJSON() : null });
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
  hint: "Stats + Heal PC",
  renderPanel,
  gmActions: { [APPLY]: gmApply },
};
