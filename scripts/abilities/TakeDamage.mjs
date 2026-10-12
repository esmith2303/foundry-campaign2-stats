/**
 * Take Damage — damage the character took, for the "damage taken" stat, and
 * (unless "Apply to character sheet" is unticked) taken off their HP.
 *
 * Resistances, vulnerabilities and immunities are ignored: the amount entered
 * is exactly what comes off (temp HP first, as in the rules). Dice rolled here
 * are the enemy's damage, so they aren't added to the character's roll stats.
 */
import { MODULE_ID, escapeHtml, statCard, damageTypeOptions, mountAmountPicker, resolveAmount } from "./shared.mjs";

function hpState(actor) {
  const hp = actor?.system?.attributes?.hp ?? {};
  const value = Number(hp.value) || 0;
  const max = Number(hp.effectiveMax ?? ((Number(hp.max) || 0) + (Number(hp.tempmax) || 0))) || 0;
  return { value, max, temp: Math.max(0, Number(hp.temp) || 0) };
}

/** What `amount` damage does: temp HP soaks first, HP stops at 0. */
function afterDamage(hp, amount) {
  const fromTemp = Math.min(hp.temp, amount);
  return { temp: hp.temp - fromTemp, value: Math.max(0, hp.value - (amount - fromTemp)) };
}

const hpText = (v, max, temp) => `${v} / ${max}${temp ? ` (+${temp} temp)` : ""}`;

function renderPanel(dialog, { actor, close, back }) {
  const types = damageTypeOptions();
  dialog.innerHTML = `
    <div class="title">Take Damage</div>
    <div class="qa-amount"></div>
    <div class="field">
      <div class="field-label">Damage type</div>
      <select class="qa-select qa-type">
        <option value="">— unspecified —</option>
        ${types.map(t => `<option value="${t.key}">${escapeHtml(t.label)}</option>`).join("")}
      </select>
    </div>
    <div class="field">
      <div class="player-row checkbox-row qa-apply-row">
        <label><input type="checkbox" class="qa-apply" checked><span>Apply to character sheet</span></label>
        <span class="qa-tag qa-hp-preview"></span>
      </div>
      <div class="qa-note qa-apply-note"></div>
    </div>
    <div class="qa-warn" hidden></div>
    <div class="qa-error" hidden></div>
    <div class="actions">
      <button type="button" class="btn" data-qa="back">Back</button>
      <button type="button" class="btn primary" data-qa="go" disabled>Take Damage</button>
    </div>`;

  const picker = mountAmountPicker(dialog.querySelector(".qa-amount"), { label: `Damage taken by ${actor.name}` });
  const typeSel = dialog.querySelector(".qa-type");
  const applyCb = dialog.querySelector(".qa-apply");
  const preview = dialog.querySelector(".qa-hp-preview");
  const note = dialog.querySelector(".qa-apply-note");
  const warn = dialog.querySelector(".qa-warn");
  const go = dialog.querySelector('[data-qa="go"]');
  const err = dialog.querySelector(".qa-error");

  const refresh = () => {
    const hp = hpState(actor);
    const apply = applyCb.checked;
    const amount = picker.setAmount();
    note.textContent = apply
      ? "Resistances, vulnerabilities and immunities are ignored — the amount you enter is exactly what comes off (temp HP first)."
      : "Stats only — HP isn't changed. Use this for damage taken earlier that's already on the sheet.";
    if (!apply) preview.textContent = "";
    else if (amount > 0) {
      const a = afterDamage(hp, amount);
      preview.textContent = `HP ${hpText(hp.value, hp.max, hp.temp)} → ${hpText(a.value, hp.max, a.temp)}`;
    } else preview.textContent = `HP ${hpText(hp.value, hp.max, hp.temp)}`;
    const toZero = apply && amount > 0 && afterDamage(hp, amount).value === 0;
    warn.hidden = !toZero;
    if (toZero) warn.textContent = hp.value === 0 ? `${actor.name} is already at 0 HP.` : `This takes ${actor.name} to 0 HP.`;
    go.disabled = !picker.isReady();
  };
  picker.onChange(refresh);
  applyCb.addEventListener("change", refresh);
  refresh();

  dialog.querySelector('[data-qa="back"]').addEventListener("click", back);
  go.addEventListener("click", async () => {
    go.disabled = true; err.hidden = true;
    try {
      const { amount, roll } = await resolveAmount(picker);
      if (!(amount > 0)) throw new Error(roll ? `Rolled ${roll.total} — no damage.` : "Enter an amount.");
      const type = typeSel.value || null;
      const typeLabel = types.find(t => t.key === type)?.label;
      const apply = applyCb.checked;

      let hpMeta = "Stats only — HP not changed";
      const undo = [];
      if (apply) {
        const before = hpState(actor);
        const after = afterDamage(before, amount);
        await actor.update({ "system.attributes.hp.temp": after.temp, "system.attributes.hp.value": after.value });
        undo.push({ kind: "hp", actorId: actor.id, value: after.value - before.value, temp: after.temp - before.temp });
        hpMeta = `HP ${hpText(before.value, before.max, before.temp)} → ${hpText(after.value, before.max, after.temp)}`;
      }

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: await statCard({
          icon: "fas fa-heart-crack", title: "Damage Taken", subtitle: actor.name,
          rows: [{ name: typeLabel ? `${typeLabel} damage` : "Damage", meta: [hpMeta],
                   roll, value: `−${amount}`, valueCls: "failure" }],
          summary: apply ? "Added manually · resistances ignored" : "Added manually for stats",
        }),
        // No `rolls`: these dice are the enemy's, not this character's
        flags: { [MODULE_ID]: { abilityUse: {
          ability: "take-damage", actorId: actor.id,
          taken: { amount, type, applied: apply, formula: roll?.formula ?? null }, undo,
        } } },
      });
      ui.notifications.info(apply ? `${actor.name} took ${amount} damage.` : `${amount} damage taken recorded for ${actor.name}.`);
      close();
    } catch (e) {
      err.hidden = false; err.textContent = e.message;
      refresh();
    }
  });
}

export const TakeDamage = {
  id: "take-damage",
  label: "Take Damage",
  icon: "fas fa-heart-crack",
  general: true,
  hint: "Updates HP",
  renderPanel,
};
