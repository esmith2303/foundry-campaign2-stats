/**
 * Add Damage — stats only. Damage dealt by the character outside the normal
 * workflow (a set amount or a dice roll), optionally with the weapon or spell
 * used and a damage type. Applied to nobody.
 */
import { MODULE_ID, escapeHtml, statCard, damageTypeOptions, itemDamageType, damageSourceGroups, mountAmountPicker, resolveAmount } from "./shared.mjs";

function renderPanel(dialog, { actor, close, back }) {
  const groups = damageSourceGroups(actor);
  const types = damageTypeOptions();
  dialog.innerHTML = `
    <div class="title">Add Damage</div>
    <div class="field">
      <div class="field-label">Dealt by ${escapeHtml(actor.name)} with</div>
      <select class="qa-select qa-source">
        <option value="">— nothing in particular —</option>
        ${groups.map(g => `<optgroup label="${escapeHtml(g.label)}">${g.items.map(i => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join("")}</optgroup>`).join("")}
      </select>
    </div>
    <div class="qa-amount"></div>
    <div class="field">
      <div class="field-label">Damage type</div>
      <select class="qa-select qa-type">
        <option value="">— unspecified —</option>
        ${types.map(t => `<option value="${t.key}">${escapeHtml(t.label)}</option>`).join("")}
      </select>
    </div>
    <div class="qa-note">For stats only — no one takes this damage in Foundry.</div>
    <div class="qa-error" hidden></div>
    <div class="actions">
      <button type="button" class="btn" data-qa="back">Back</button>
      <button type="button" class="btn primary" data-qa="go" disabled>Add Damage</button>
    </div>`;

  const picker = mountAmountPicker(dialog.querySelector(".qa-amount"), { label: "Damage" });
  const sourceSel = dialog.querySelector(".qa-source");
  const typeSel = dialog.querySelector(".qa-type");
  const go = dialog.querySelector('[data-qa="go"]');
  const err = dialog.querySelector(".qa-error");
  const refresh = () => { go.disabled = !picker.isReady(); };
  picker.onChange(refresh);

  // Picking a weapon/spell pre-selects its damage type (still overridable)
  sourceSel.addEventListener("change", () => {
    const t = itemDamageType(actor.items.get(sourceSel.value));
    if (t && types.some(x => x.key === t)) typeSel.value = t;
  });

  dialog.querySelector('[data-qa="back"]').addEventListener("click", back);
  go.addEventListener("click", async () => {
    go.disabled = true; err.hidden = true;
    try {
      const { amount, roll } = await resolveAmount(picker);
      if (!(amount > 0)) throw new Error(roll ? `Rolled ${roll.total} — nothing to add.` : "Enter an amount.");
      const item = actor.items.get(sourceSel.value) ?? null;
      const type = typeSel.value || null;
      const typeLabel = types.find(t => t.key === type)?.label;
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: statCard({
          icon: "fas fa-burst", title: "Damage", subtitle: actor.name,
          rows: [{ icon: "fas fa-burst", name: item?.name ?? "Damage",
                   tags: [typeLabel && { text: typeLabel }, roll && { text: roll.formula }].filter(Boolean),
                   value: String(amount), valueCls: "failure" }],
          summary: "Added manually for stats",
        }),
        rolls: roll ? [roll] : [],
        flags: { [MODULE_ID]: { abilityUse: {
          ability: "add-damage", actorId: actor.id, itemName: item?.name ?? null,
          damage: { amount, type, formula: roll?.formula ?? null },
        } } },
      });
      ui.notifications.info(`${amount} damage recorded for ${actor.name}.`);
      close();
    } catch (e) {
      err.hidden = false; err.textContent = e.message;
      refresh();
    }
  });
}

export const AddDamage = {
  id: "add-damage",
  label: "Add Damage",
  icon: "fas fa-burst",
  general: true,
  hint: "Stats only",
  renderPanel,
};
