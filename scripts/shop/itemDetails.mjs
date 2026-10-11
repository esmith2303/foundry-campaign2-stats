/**
 * The expandable "details" area under each shop item in the GM editor:
 * type, kind, rarity, charges, a damage/healing effect and a description —
 * the common things you'd set when making an item in Foundry. Anything more
 * (attacks, saves, effects…) goes through "Open full item sheet", which turns
 * the entry into a real world item and opens dnd5e's own sheet.
 *
 * Effects are written as dnd5e 4+/5 "activities" (damage / heal). Older
 * dnd5e versions get the equivalent legacy fields.
 */
import { MODULE_ID, escapeHtml, damageTypeOptions } from "../abilities/shared.mjs";

export const ITEM_TYPES = [
  ["weapon", "Weapon"], ["equipment", "Armour / equipment"], ["consumable", "Consumable"],
  ["tool", "Tool"], ["loot", "Loot / treasure"], ["container", "Container"],
];

const label = (v) => {
  const s = typeof v === "string" ? v : (v?.label ?? "");
  try { return game.i18n?.localize?.(s) ?? s; } catch { return s; }
};
const entries = (obj) => Object.entries(obj ?? {}).map(([k, v]) => [k, label(v)]).filter(([, l]) => l);

/** Kinds for a type, from dnd5e's config (e.g. consumable → potion, scroll, wand…). */
export function kindOptions(type) {
  const C = globalThis.CONFIG?.DND5E ?? {};
  switch (type) {
    case "weapon":     return entries(C.weaponTypes);
    case "equipment":  return [...entries(C.armorTypes), ...entries(C.miscEquipmentTypes ?? C.equipmentTypes)];
    case "consumable": return entries(C.consumableTypes);
    case "tool":       return entries(C.toolTypes);
    case "loot":       return entries(C.lootTypes);
    default:           return [];
  }
}
const rarityOptions = () => entries(globalThis.CONFIG?.DND5E?.itemRarity);

const isNewDnd5e = () => {
  const v = game.system?.version ?? "4.0.0";
  try { return !foundry.utils.isNewerVersion("4.0.0", v); } catch { return true; }
};

function stripHtml(html) {
  const d = document.createElement("div");
  d.innerHTML = String(html ?? "").replace(/<\/p>\s*<p>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n");
  return (d.textContent ?? "").trim();
}
const toHtml = (text) => String(text ?? "").trim().split(/\n{2,}/).filter(Boolean)
  .map(p => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");

/** First damage/heal effect on the item, as { effect, formula, damageType }. */
function readEffect(data) {
  const acts = Object.values(data.system?.activities ?? {});
  const partFormula = (p) => p?.custom?.enabled && p.custom.formula ? p.custom.formula
    : p?.number && p?.denomination ? `${p.number}d${p.denomination}${p.bonus ? ` + ${p.bonus}` : ""}` : "";
  for (const a of acts) {
    if (a?.type === "heal") return { effect: "heal", formula: partFormula(a.healing), damageType: "" };
    if (a?.type === "damage" || a?.type === "attack" || a?.type === "save") {
      const p = a.damage?.parts?.[0];
      if (p) return { effect: "damage", formula: partFormula(p), damageType: [...(p.types ?? [])][0] ?? "" };
    }
  }
  const legacy = data.system?.damage?.parts?.[0];
  if (Array.isArray(legacy) && legacy[0]) {
    return legacy[1] === "healing" ? { effect: "heal", formula: legacy[0], damageType: "" }
                                   : { effect: "damage", formula: legacy[0], damageType: legacy[1] ?? "" };
  }
  return { effect: "none", formula: "", damageType: "" };
}

/** Current details of an entry (created on first open, kept on the entry). */
export function detailsOf(entry) {
  if (entry.details) return entry.details;
  const d = entry.data ?? {};
  entry.details = {
    type: d.type ?? entry.type ?? "loot",
    kind: d.system?.type?.value ?? d.system?.consumableType ?? d.system?.weaponType ?? "",
    rarity: d.system?.rarity ?? "",
    charges: Number(d.system?.uses?.max) || "",
    description: stripHtml(d.system?.description?.value),
    descriptionDirty: false,
    ...readEffect(d),
    touched: false,
  };
  return entry.details;
}

/** Write the details back into the entry's item data (called on Save). */
export function applyDetails(entry) {
  const det = entry.details;
  if (!det?.touched || entry.linkUuid) return;
  const old = entry.data ?? {};
  const sameType = old.type === det.type;
  const system = sameType ? foundry.utils.deepClone(old.system ?? {}) : {
    description: foundry.utils.deepClone(old.system?.description ?? { value: "" }),
    weight: foundry.utils.deepClone(old.system?.weight ?? {}),
  };
  const data = { ...old, type: det.type, system };
  entry.type = det.type;

  if (det.descriptionDirty || !sameType) {
    system.description = { ...(system.description ?? {}), value: toHtml(det.description) };
  }
  if (det.rarity) system.rarity = det.rarity; else delete system.rarity;
  if (det.kind) system.type = { ...(typeof system.type === "object" ? system.type : {}), value: det.kind };

  const charges = Math.max(0, Math.floor(Number(det.charges) || 0));
  if (charges) {
    system.uses = { ...(system.uses ?? {}), max: String(charges), spent: 0 };
    if (det.type === "consumable") system.uses.autoDestroy = true;
  }

  // Effect → a single damage or heal activity (replacing any we made before)
  const formula = String(det.formula ?? "").trim();
  if (isNewDnd5e()) {
    const acts = foundry.utils.deepClone(system.activities ?? {});
    for (const [id, a] of Object.entries(acts)) if (a?.flags?.[MODULE_ID]?.shop) delete acts[id];
    if (det.effect !== "none" && formula) {
      const id = foundry.utils.randomID();
      const part = { custom: { enabled: true, formula }, types: det.effect === "heal" ? ["healing"] : (det.damageType ? [det.damageType] : []) };
      acts[id] = {
        _id: id, type: det.effect === "heal" ? "heal" : "damage", name: "",
        activation: { type: "action", value: 1 },
        consumption: det.type === "consumable" && charges ? { targets: [{ type: "itemUses", target: "", value: "1" }] } : { targets: [] },
        ...(det.effect === "heal" ? { healing: part } : { damage: { parts: [part] } }),
        flags: { [MODULE_ID]: { shop: true } },
      };
    }
    system.activities = acts;
  } else if (det.effect !== "none" && formula) {
    system.actionType = det.effect === "heal" ? "heal" : "other";
    system.damage = { parts: [[formula, det.effect === "heal" ? "healing" : (det.damageType || "")]] };
    system.activation = { type: "action", cost: 1 };
  }
  entry.data = data;
}

/** Throws a readable error if dnd5e wouldn't accept the item. */
export function validateItem(data, name) {
  const Cls = globalThis.CONFIG?.Item?.documentClass;
  if (!Cls) return;
  try { new Cls(foundry.utils.deepClone(data)); }
  catch (e) {
    const msg = String(e?.message ?? e).split("\n").map(l => l.trim()).filter(Boolean)
      .filter(l => !/validation errors:?$/i.test(l)).join("; ");
    throw new Error(`${name}: ${msg.slice(0, 220) || "dnd5e rejected this item"}`);
  }
}

// ── UI ───────────────────────────────────────────────────────────────────────

export function detailsHtml(entry) {
  if (entry.linkUuid) {
    return `<div class="qa-item-details" hidden>
      <div class="qa-note">Edited in its own item sheet (Items sidebar › Shop Items). Changes are picked up when you save the shop.</div>
      <div class="qa-details-actions"><button type="button" class="btn" data-act="sheet">Open item sheet</button></div>
    </div>`;
  }
  const det = detailsOf(entry);
  const opts = (list, val, blank) => `${blank ? `<option value="">${blank}</option>` : ""}${list.map(([k, l]) => `<option value="${escapeHtml(k)}"${k === val ? " selected" : ""}>${escapeHtml(l)}</option>`).join("")}`;
  const kinds = kindOptions(det.type);
  return `
    <div class="qa-item-details" hidden>
      <div class="qa-details-grid">
        <label>Type<select class="qa-select qa-d-type">${opts(ITEM_TYPES, det.type)}</select></label>
        <label>Kind<select class="qa-select qa-d-kind"${kinds.length ? "" : " disabled"}>${opts(kinds, det.kind, "—")}</select></label>
        <label>Rarity<select class="qa-select qa-d-rarity">${opts(rarityOptions(), det.rarity, "—")}</select></label>
        <label>Charges<input type="number" class="qa-num qa-d-charges" min="0" step="1" placeholder="—" value="${det.charges}"></label>
      </div>
      <div class="qa-details-grid qa-details-effect">
        <label>Effect<select class="qa-select qa-d-effect">${opts([["none", "None"], ["damage", "Damage"], ["heal", "Healing"]], det.effect)}</select></label>
        <label class="qa-d-wide">Formula<input type="text" class="qa-text qa-d-formula" placeholder="e.g. 2d4 + 2" value="${escapeHtml(det.formula)}"${det.effect === "none" ? " disabled" : ""}></label>
        <label>Damage type<select class="qa-select qa-d-dtype"${det.effect === "damage" ? "" : " disabled"}>${opts(damageTypeOptions().map(t => [t.key, t.label]), det.damageType, "—")}</select></label>
      </div>
      <label class="qa-d-desc">Description<textarea class="qa-text qa-d-description" rows="4" placeholder="What is it? What does it do?">${escapeHtml(det.description)}</textarea></label>
      <div class="qa-details-actions">
        <span class="qa-note">Need more (attacks, saves, effects)?</span>
        <button type="button" class="btn" data-act="sheet">Open full item sheet</button>
      </div>
    </div>`;
}

/** Wire up a details area. `onSheet` is called for "Open full item sheet". */
export function bindDetails(el, entry, { onSheet }) {
  el.querySelector('[data-act="sheet"]')?.addEventListener("click", onSheet);
  if (entry.linkUuid) return;
  const det = detailsOf(entry);
  const touch = () => { det.touched = true; };
  const q = (s) => el.querySelector(s);
  q(".qa-d-type").addEventListener("change", (e) => {
    det.type = e.target.value; det.kind = ""; touch();
    const kinds = kindOptions(det.type);
    q(".qa-d-kind").innerHTML = `<option value="">—</option>${kinds.map(([k, l]) => `<option value="${escapeHtml(k)}">${escapeHtml(l)}</option>`).join("")}`;
    q(".qa-d-kind").disabled = !kinds.length;
  });
  q(".qa-d-kind").addEventListener("change", (e) => { det.kind = e.target.value; touch(); });
  q(".qa-d-rarity").addEventListener("change", (e) => { det.rarity = e.target.value; touch(); });
  q(".qa-d-charges").addEventListener("input", (e) => { det.charges = e.target.value; touch(); });
  q(".qa-d-effect").addEventListener("change", (e) => {
    det.effect = e.target.value; touch();
    q(".qa-d-formula").disabled = det.effect === "none";
    q(".qa-d-dtype").disabled = det.effect !== "damage";
  });
  q(".qa-d-formula").addEventListener("input", (e) => { det.formula = e.target.value; touch(); });
  q(".qa-d-dtype").addEventListener("change", (e) => { det.damageType = e.target.value; touch(); });
  q(".qa-d-description").addEventListener("input", (e) => { det.description = e.target.value; det.descriptionDirty = true; touch(); });
}
