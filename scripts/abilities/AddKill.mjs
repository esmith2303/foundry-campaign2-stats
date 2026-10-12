/** Add Kill — stats only. Records a kill for the character; changes nothing on any sheet. */
import { MODULE_ID, escapeHtml, statCard } from "./shared.mjs";

function renderPanel(dialog, { actor, close, back }) {
  dialog.innerHTML = `
    <div class="title">Add Kill</div>
    <div class="field">
      <div class="field-label">Confirm</div>
      <div class="player-row qa-confirm">
        <i class="fas fa-skull qa-ability-icon"></i>
        <span>Record a kill for <b>${escapeHtml(actor.name)}</b>?</span>
      </div>
      <div class="qa-note">For stats only — nothing is changed on any character or token.</div>
    </div>
    <div class="qa-error" hidden></div>
    <div class="actions">
      <button type="button" class="btn" data-qa="back">Back</button>
      <button type="button" class="btn primary" data-qa="go">Add Kill</button>
    </div>`;
  dialog.querySelector('[data-qa="back"]').addEventListener("click", back);
  const go = dialog.querySelector('[data-qa="go"]');
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: await statCard({ icon: "fas fa-skull", title: "Kill", subtitle: actor.name, summary: "Added manually for stats" }),
        flags: { [MODULE_ID]: { abilityUse: { ability: "add-kill", actorId: actor.id, kill: true, undo: [] } } },
      });
      ui.notifications.info(`Kill recorded for ${actor.name}.`);
      close();
    } catch (e) {
      go.disabled = false;
      const err = dialog.querySelector(".qa-error"); err.hidden = false; err.textContent = e.message;
    }
  });
}

export const AddKill = {
  id: "add-kill",
  label: "Add Kill",
  icon: "fas fa-skull",
  general: true,
  hint: "Stats only",
  renderPanel,
};
