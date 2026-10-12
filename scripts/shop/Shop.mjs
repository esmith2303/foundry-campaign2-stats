/**
 * Shops.
 *
 * GM: the store button opens a floating panel (it doesn't block the screen, so
 * compendiums and the Items sidebar stay usable) listing saved shops. A shop
 * has a title, an owner and wares; drag items in from a compendium, the Items
 * sidebar or a sheet (price taken from the item), or add custom items (0 gp).
 * Name, price, coin and stock are editable. Shops are saved in the world.
 *
 * "Visit" pushes the shop to every player (and the GM). Players pick a
 * character and:
 *   Buy  — quantities at the shop's prices. To haggle they change a price and
 *          press Haggle: Persuasion is rolled and the GM accepts, counters or
 *          refuses (haggle.mjs). Agreed prices hold for the visit.
 *   Sell — anything physical from their sheet at an asking price (half value
 *          by default; asking more rolls Persuasion). The GM decides what the
 *          shop buys; sold items join the wares at the price paid + 10%.
 * The GM's client does every purchase and sale, one at a time: checks stock
 * and coin, moves items and money, updates stock and posts a receipt card.
 */
import { MODULE_ID, escapeHtml, assertOwns } from "../abilities/shared.mjs";
import { registerGmAction, runAsGM, castersForUser } from "../QuickActions.mjs";
import { COIN_CP, DENOMS, toCp, walletCp, formatCp, pay, receive } from "./currency.mjs";
import { rollPersuasion, sendOffer, answerCounter, cancelOffer, configureHaggle, handleHaggleSocket } from "./haggle.mjs";
import { detailsHtml, bindDetails, applyDetails, validateItem } from "./itemDetails.mjs";
import { addWindowControls } from "../windowControls.mjs";

const SOCKET = `module.${MODULE_ID}`;
export const SHOP_TOOL = "stats-shop";
const BUY = "shop.buy";
const SELL = "shop.sell";
// GM's client: prices agreed by haggling, for the current visit. { shopId: { actorId: { wareKey: unitCp } } }
const deals = {};
const PHYSICAL = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]);
const STACKABLE = new Set(["consumable", "loot"]);

/** The shop owner's name: a character sheet (follows renames) or a typed name. */
export function ownerName(shop) {
  const o = shop?.owner;
  if (!o) return "";
  return ((o.actorId && game.actors?.get(o.actorId)?.name) || o.name || "").trim();
}
const OWNER_CUSTOM = "__custom";

/** Owner dropdown: nobody, every actor (grouped), or a typed name. */
function ownerOptions(shop) {
  const o = shop.owner;
  // An owner whose sheet was deleted becomes a typed name
  if (o?.actorId && !game.actors?.get(o.actorId)) shop.owner = o.name ? { actorId: null, name: o.name } : null;
  const current = shop.owner?.actorId ?? (shop.owner ? OWNER_CUSTOM : "");
  const actors = [...(game.actors?.contents ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const groups = [
    ["Player characters", actors.filter(a => a.type === "character" && a.hasPlayerOwner)],
    ["NPCs", actors.filter(a => a.type === "npc")],
    ["Other characters", actors.filter(a => !(a.type === "character" && a.hasPlayerOwner) && a.type !== "npc")],
  ].filter(([, list]) => list.length);
  const opt = (value, label) => `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
  return opt("", "— no owner —")
    + groups.map(([label, list]) => `<optgroup label="${escapeHtml(label)}">${list.map(a => opt(a.id, a.name)).join("")}</optgroup>`).join("")
    + opt(OWNER_CUSTOM, "Someone else — type a name…");
}

/** "Shop Name (Shop Owner)" — or just the shop name when there's no owner. */
export function shopLabel(shop) {
  const title = shop?.title || "Untitled shop", owner = ownerName(shop);
  return owner ? `${title} (${owner})` : title;
}

// ── Setup ────────────────────────────────────────────────────────────────────

export function registerShop() {
  registerGmAction(BUY, gmBuyInTurn);
  registerGmAction(SELL, gmSellInTurn);
  // A deal struck by haggling (GM's client): remember the price, or carry out the sale
  configureHaggle({
    agreed: async (offer, lines, user) => {
      if (offer.kind === "sell") {
        return gmSellInTurn({ shopId: offer.shopId, actorId: offer.actorId, lines: lines.map(l => ({ itemId: l.key, qty: l.qty, unitCp: l.dealCp })) }, user);
      }
      assertOwns(game.actors.get(offer.actorId), user);   // only for a character the player owns
      const forActor = ((deals[offer.shopId] ??= {})[offer.actorId] ??= {});
      for (const l of lines) forActor[l.key] = l.dealCp;
      return {};
    },
  });
  game.socket.on(SOCKET, (data) => {
    if (handleHaggleSocket(data)) return;
    if (data?.action === "shop.visit") openVisit(data.shop);
    else if (data?.action === "shop.stock") applyStock(data.shopId, data.stock);
    else if (data?.action === "shop.wares") applyWares(data.shop);
  });
}

export function shopTool() {
  return { name: SHOP_TOOL, title: "Shops", icon: "fas fa-store", button: true, onChange: () => {} };
}

// ── Storage ──────────────────────────────────────────────────────────────────

function allShops() {
  try { return foundry.utils.deepClone(game.settings.get(MODULE_ID, "shops") || {}); } catch { return {}; }
}
async function saveShop(shop) {
  const shops = allShops();
  shops[shop.id] = { ...shop, updatedAt: Date.now() };
  await game.settings.set(MODULE_ID, "shops", shops);
}
async function deleteShop(id) {
  const shops = allShops();
  delete shops[id];
  await game.settings.set(MODULE_ID, "shops", shops);
}
const newId = () => foundry.utils.randomID();

function priceOf(item) {
  const p = item?.system?.price;
  if (p && typeof p === "object") return { value: Number(p.value) || 0, denomination: DENOMS.includes(p.denomination) ? p.denomination : "gp" };
  return { value: Number(p) || 0, denomination: "gp" };
}

/** A shop entry from a real item (compendium, sidebar or sheet). */
function entryFromItem(item, uuid) {
  const data = item.toObject();
  for (const k of ["_id", "folder", "sort", "ownership", "_stats"]) delete data[k];
  return { key: newId(), name: item.name, img: item.img, type: item.type, uuid: uuid ?? null, price: priceOf(item), stock: 1, data };
}

function customEntry() {
  const data = { name: "New item", type: "loot", img: "icons/svg/item-bag.svg", system: { price: { value: 0, denomination: "gp" }, quantity: 1 } };
  return { key: newId(), name: data.name, img: data.img, type: data.type, uuid: null, price: { value: 0, denomination: "gp" }, stock: 1, data };
}

const priceText = (p) => `${+(+p.value).toFixed(2)} ${p.denomination}`;

function plainText(html) {
  const d = document.createElement("div");
  d.innerHTML = String(html ?? "").replace(/<\/(p|div|li|h\d)>|<br\s*\/?>/gi, " ");
  return (d.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
}

function cleanItemData(doc) {
  const data = doc.toObject();
  for (const k of ["_id", "folder", "sort", "ownership", "_stats"]) delete data[k];
  return data;
}

/** The "Shop Items" folder in the Items sidebar (made on first use). */
async function shopFolder() {
  const existing = game.folders?.find?.(f => f.type === "Item" && f.name === "Shop Items");
  if (existing) return existing;
  const Folder = CONFIG.Folder?.documentClass ?? globalThis.Folder;
  return Folder.create({ name: "Shop Items", type: "Item" });
}

// ── Popup shell ──────────────────────────────────────────────────────────────

/**
 * floating: no dark backdrop and clicks pass through around the panel, so the
 * GM can drag from compendium windows. The title bar moves the panel.
 */
function openShell({ floating }) {
  document.getElementById("qa-shop-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "qa-shop-overlay";
  if (floating) overlay.classList.add("qa-floating");
  const frame = document.createElement("div");
  frame.id = "qa-shop-dialog";
  // Screens render into `dialog`; the − / ✕ controls live beside it in the frame
  const dialog = document.createElement("div");
  dialog.className = "qa-win-body";
  frame.appendChild(dialog);
  overlay.appendChild(frame);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("shown"));

  const onClose = [];   // cleanup to run when the panel closes (e.g. the compendium window)
  const onKey = (e) => {
    if (e.key === "Escape" && !frame._qaWin?.minimised && !e.target.closest?.("input, select, textarea")) close();
  };
  function close() {
    onClose.splice(0).forEach(f => { try { f(); } catch {} });
    document.removeEventListener("keydown", onKey);
    overlay.classList.remove("shown");
    setTimeout(() => overlay.remove(), 200);
  }
  document.addEventListener("keydown", onKey);
  if (!floating) overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  if (floating) {
    // Set in code so no stylesheet can bring the dark backdrop back: the
    // overlay is see-through and click-through; only the panel catches clicks.
    Object.assign(overlay.style, { background: "transparent", pointerEvents: "none" });
    Object.assign(frame.style, { pointerEvents: "auto", position: "fixed", left: "110px", top: "70px" });
    frame.addEventListener("mousedown", (e) => {
      const handle = e.target.closest(".qa-drag-handle");
      if (!handle) return;
      const r = frame.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => {
        frame.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx))}px`;
        frame.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))}px`;
      };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      e.preventDefault();
    });
  }
  addWindowControls({ frame, overlay, close });
  return { overlay, dialog, close, onClose };
}

// ── Compendium helper (GM editor) ────────────────────────────────────────────

const PACK_KEY = `${MODULE_ID}.shopPack`;
function itemPacks() {
  return (game.packs?.filter?.(p => (p.documentName ?? p.metadata?.type) === "Item") ?? [])
    .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
}
function defaultPack(packs) {
  let saved = null;
  try { saved = localStorage.getItem(PACK_KEY); } catch {}
  return packs.find(p => p.collection === saved)
      ?? packs.find(p => p.metadata?.packageName === game.system?.id && /(^|\.)items/i.test(p.collection))
      ?? packs.find(p => /item|equipment/i.test(p.title ?? ""))
      ?? packs[0] ?? null;
}
/** Open a compendium window and put it just to the right of the shop panel. */
async function openPackBeside(pack, dialog) {
  if (!pack) return null;
  await pack.render(true);
  const app = [...(pack.apps ?? [])][0] ?? null;
  setTimeout(() => {
    const r = dialog.getBoundingClientRect();
    const width = 320;
    const left = r.right + 12 + width <= window.innerWidth ? r.right + 12 : Math.max(0, window.innerWidth - width - 10);
    try { app?.setPosition?.({ left, top: r.top }); } catch {}
  }, 150);
  return app;
}

// ── GM: shop list ────────────────────────────────────────────────────────────

export function openShopManager() {
  if (!game.user.isGM) return;
  // Clicking the store button again brings a minimised shop panel back
  const open = document.querySelector("#qa-shop-overlay.qa-floating #qa-shop-dialog");
  if (open?._qaWin?.minimised) return open._qaWin.restore();
  const { dialog, close, onClose } = openShell({ floating: true });
  let packApp = null;   // the compendium window we opened, closed with the panel
  onClose.push(() => packApp?.close?.());

  function showList() {
    const shops = Object.values(allShops()).sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    dialog.innerHTML = `
      <div class="title qa-drag-handle">Shops</div>
      <div class="field">
        <div class="field-label">Saved shops</div>
        <div class="players">
          ${shops.length ? shops.map(s => `
            <div class="player-row qa-shop-row" data-id="${s.id}">
              <label><i class="fas fa-store qa-ability-icon"></i><span>${escapeHtml(shopLabel(s))}</span></label>
              <span class="qa-tag">${s.items?.length ?? 0} item${s.items?.length === 1 ? "" : "s"}</span>
              <button type="button" class="btn" data-act="edit">Edit</button>
              <button type="button" class="btn primary" data-act="visit">Visit</button>
              <button type="button" class="btn qa-del" data-act="delete" title="Delete">✕</button>
            </div>`).join("") : `<div class="player-row qa-empty">No shops yet — make one.</div>`}
        </div>
      </div>
      <div class="actions">
        <button type="button" class="btn" data-act="close">Close</button>
        <button type="button" class="btn primary" data-act="new">New Shop</button>
      </div>`;
    dialog.querySelector('[data-act="close"]').addEventListener("click", close);
    dialog.querySelector('[data-act="new"]').addEventListener("click", () => showEditor({ id: newId(), title: "", items: [] }, true));
    for (const row of dialog.querySelectorAll(".qa-shop-row")) {
      const shop = () => allShops()[row.dataset.id];
      row.querySelector('[data-act="edit"]').addEventListener("click", () => showEditor(shop(), false));
      row.querySelector('[data-act="visit"]').addEventListener("click", () => { close(); visit(shop()); });
      const del = row.querySelector('[data-act="delete"]');
      del.addEventListener("click", async () => {
        if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "Delete?"; return; }
        await deleteShop(row.dataset.id);
        showList();
      });
    }
  }

  // ── GM: shop editor ──────────────────────────────────────────────────────
  function showEditor(original, isNew) {
    const shop = foundry.utils.deepClone(original);
    shop.items ??= [];

    const itemRow = (it) => `
      <div class="qa-shop-entry" data-key="${it.key}">
      <div class="player-row qa-shop-item" data-key="${it.key}">
        <img class="qa-item-img" src="${escapeHtml(it.img || "icons/svg/item-bag.svg")}" alt="">
        <input type="text" class="qa-text qa-item-name" value="${escapeHtml(it.name)}" maxlength="120">
        <div class="qa-price">
          <input type="number" class="qa-num qa-item-price" min="0" step="any" value="${+(+it.price.value).toFixed(2)}">
          <select class="qa-item-denom">${DENOMS.map(d => `<option value="${d}"${d === it.price.denomination ? " selected" : ""}>${d}</option>`).join("")}</select>
        </div>
        <input type="number" class="qa-num qa-item-stock" min="0" step="1" placeholder="∞" value="${it.stock ?? ""}" title="Stock (leave empty for unlimited)">
        <button type="button" class="btn qa-chev" data-act="details" title="Details: type, effect, description…"><i class="fas fa-chevron-down"></i></button>
        <button type="button" class="btn qa-del" data-act="remove" title="Remove">✕</button>
      </div>
      ${detailsHtml(it)}
      </div>`;

    dialog.innerHTML = `
      <div class="title qa-drag-handle">${isNew ? "New Shop" : "Edit Shop"}</div>
      <div class="field">
        <div class="field-label">Shop name</div>
        <input type="text" class="qa-text qa-shop-title" placeholder="e.g. The Gilded Flagon" value="${escapeHtml(shop.title)}" maxlength="80">
      </div>
      <div class="field">
        <div class="field-label">Shop owner</div>
        <div class="qa-owner-row">
          <select class="qa-select qa-owner-select">${ownerOptions(shop)}</select>
          <input type="text" class="qa-text qa-owner-name" placeholder="Owner's name" maxlength="60"
            value="${escapeHtml(shop.owner && !shop.owner.actorId ? shop.owner.name : "")}"${shop.owner && !shop.owner.actorId ? "" : " hidden"}>
        </div>
      </div>
      <div class="field">
        <div class="field-label qa-shop-cols"><span>Wares</span><span>Price</span><span>Stock</span><span></span><span></span></div>
        <div class="players qa-shop-items">${shop.items.map(itemRow).join("")}</div>
        ${itemPacks().length ? `
        <div class="player-row qa-pack-row">
          <span class="qa-tag">Compendium</span>
          <select class="qa-select qa-pack">${itemPacks().map(p => `<option value="${escapeHtml(p.collection)}">${escapeHtml(p.title)}</option>`).join("")}</select>
          <button type="button" class="btn" data-act="open-pack">Open</button>
        </div>` : ""}
        <div class="qa-dropzone"><i class="fas fa-hand-pointer"></i> Drag items here from a compendium, the Items sidebar or a character sheet</div>
        <button type="button" class="btn qa-add-custom" data-act="custom">+ Custom item</button>
      </div>
      <div class="qa-error" hidden></div>
      <div class="actions">
        <button type="button" class="btn" data-act="back">Back</button>
        <button type="button" class="btn" data-act="save">Save</button>
        <button type="button" class="btn primary" data-act="visit">Save &amp; Visit</button>
      </div>`;

    const list = dialog.querySelector(".qa-shop-items");
    const err = dialog.querySelector(".qa-error");
    const showErr = (m) => { err.hidden = !m; err.textContent = m || ""; };

    // Turn an entry into a real world item and open dnd5e's own sheet for it
    async function openSheet(it, entryEl) {
      showErr("");
      try {
        let doc = it.linkUuid ? await fromUuid(it.linkUuid) : null;
        if (!doc) {
          applyDetails(it);
          const data = foundry.utils.deepClone(it.data);
          data.name = (it.name || "").trim() || "Unnamed item";
          data.system ??= {};
          data.system.price = { value: it.price.value, denomination: it.price.denomination };
          data.folder = (await shopFolder())?.id ?? null;
          const Item = CONFIG.Item?.documentClass ?? globalThis.Item;
          doc = await Item.create(data);
          it.linkUuid = doc.uuid;
          delete it.details;
          const fresh = document.createElement("div");
          fresh.innerHTML = detailsHtml(it);
          const det = entryEl.querySelector(".qa-item-details");
          const panel = fresh.firstElementChild;
          panel.hidden = det.hidden;
          det.replaceWith(panel);
          bindDetails(panel, it, { onSheet: () => openSheet(it, entryEl) });
        }
        doc.sheet?.render(true);
      } catch (ex) { showErr(`Couldn't open the item sheet: ${ex.message}`); }
    }

    function bindRow(entryEl) {
      const row = entryEl.querySelector(".qa-shop-item");
      const it = shop.items.find(i => i.key === entryEl.dataset.key);
      const chev = row.querySelector('[data-act="details"]');
      chev.addEventListener("click", () => {
        const panel = entryEl.querySelector(".qa-item-details");
        panel.hidden = !panel.hidden;
        entryEl.classList.toggle("open", !panel.hidden);
      });
      bindDetails(entryEl.querySelector(".qa-item-details"), it, { onSheet: () => openSheet(it, entryEl) });
      row.querySelector(".qa-item-name").addEventListener("input", (e) => { it.name = e.target.value; });
      row.querySelector(".qa-item-price").addEventListener("input", (e) => { it.price.value = Math.max(0, Number(e.target.value) || 0); });
      row.querySelector(".qa-item-denom").addEventListener("change", (e) => { it.price.denomination = e.target.value; });
      row.querySelector(".qa-item-stock").addEventListener("input", (e) => {
        const v = e.target.value.trim();
        it.stock = v === "" ? null : Math.max(0, Math.floor(Number(v)) || 0);
      });
      row.querySelector('[data-act="remove"]').addEventListener("click", () => {
        shop.items = shop.items.filter(i => i !== it);
        entryEl.remove();
      });
    }
    const addEntry = (entry) => {
      shop.items.push(entry);
      list.insertAdjacentHTML("beforeend", itemRow(entry));
      bindRow(list.lastElementChild);
      list.lastElementChild.querySelector(".qa-item-name").focus();
    };
    list.querySelectorAll(".qa-shop-entry").forEach(bindRow);
    dialog.querySelector(".qa-shop-title").addEventListener("input", (e) => { shop.title = e.target.value; });
    // Owner: a character sheet, a typed name, or nobody
    const ownerSel = dialog.querySelector(".qa-owner-select"), ownerInput = dialog.querySelector(".qa-owner-name");
    const readOwner = () => {
      if (ownerSel.value === OWNER_CUSTOM) {
        const name = ownerInput.value.trim();
        shop.owner = name ? { actorId: null, name } : null;
      } else if (ownerSel.value) {
        shop.owner = { actorId: ownerSel.value, name: game.actors.get(ownerSel.value)?.name ?? "" };
      } else shop.owner = null;
    };
    ownerSel.addEventListener("change", () => {
      ownerInput.hidden = ownerSel.value !== OWNER_CUSTOM;
      if (!ownerInput.hidden) ownerInput.focus();
      readOwner();
    });
    ownerInput.addEventListener("input", readOwner);

    // Compendium: open the remembered (or default) item compendium beside the panel
    const packSel = dialog.querySelector(".qa-pack");
    if (packSel) {
      const packs = itemPacks();
      const first = defaultPack(packs);
      if (first) packSel.value = first.collection;
      const openSelected = async () => {
        const pack = game.packs.get(packSel.value);
        try { localStorage.setItem(PACK_KEY, packSel.value); } catch {}
        if (packApp && packApp !== [...(pack?.apps ?? [])][0]) { try { await packApp.close(); } catch {} }
        packApp = await openPackBeside(pack, dialog);
      };
      packSel.addEventListener("change", openSelected);
      dialog.querySelector('[data-act="open-pack"]').addEventListener("click", openSelected);
      if (!packApp?.rendered) openSelected();
    }
    dialog.querySelector('[data-act="custom"]').addEventListener("click", () => addEntry(customEntry()));

    // Drag & drop from compendiums, the sidebar or sheets
    const zone = dialog.querySelector(".qa-dropzone");
    dialog.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
    dialog.addEventListener("dragleave", (e) => { if (!dialog.contains(e.relatedTarget)) zone.classList.remove("over"); });
    dialog.addEventListener("drop", async (e) => {
      e.preventDefault();
      zone.classList.remove("over");
      showErr("");
      const data = dragData(e);
      if (data?.type !== "Item") return showErr("Only items can be added — drag an item, not a folder or actor.");
      try {
        const item = data.uuid ? await fromUuid(data.uuid) : null;
        if (!item) return showErr("Couldn't load that item.");
        if (!PHYSICAL.has(item.type)) showErr(`${item.name} is a ${item.type}, not usually something you buy — added anyway.`);
        addEntry(entryFromItem(item, data.uuid));
      } catch (ex) { showErr(ex.message); }
    });

    // Returns the saved shop, or null (with the error shown) if an item is invalid
    async function doSave() {
      showErr("");
      shop.title = shop.title.trim() || "Untitled shop";
      if (shop.owner?.actorId) shop.owner.name = game.actors.get(shop.owner.actorId)?.name ?? shop.owner.name;
      try {
        for (const it of shop.items) {
          if (it.linkUuid) {
            // Edited in its own sheet: that's the source of truth (the shop keeps its price)
            const doc = await fromUuid(it.linkUuid);
            if (doc) {
              it.data = cleanItemData(doc);
              it.name = doc.name; it.img = doc.img; it.type = doc.type;
              const row = list.querySelector(`.qa-shop-item[data-key="${it.key}"]`);
              if (row) { row.querySelector(".qa-item-name").value = doc.name; row.querySelector(".qa-item-img").src = doc.img; }
            } else {
              delete it.linkUuid;   // world item was deleted — keep the last copy
            }
          } else {
            applyDetails(it);   // edits stay on the entry until the save succeeds
          }
          it.name = (it.name || "").trim() || "Unnamed item";
          it.data.name = it.name;
          it.data.system ??= {};
          it.data.system.price = { value: it.price.value, denomination: it.price.denomination };
          validateItem(it.data, it.name);
        }
      } catch (ex) {
        showErr(`Not saved — ${ex.message}`);
        return null;
      }
      // Store without the editor-only details (they're rebuilt from the item next time)
      await saveShop({ ...shop, items: shop.items.map(({ details, ...rest }) => rest) });
      return shop;
    }
    dialog.querySelector('[data-act="back"]').addEventListener("click", showList);
    dialog.querySelector('[data-act="save"]').addEventListener("click", async () => {
      if (!await doSave()) return;
      ui.notifications.info(`Saved ${shopLabel(shop)}.`);
      isNew = false;
      dialog.querySelector(".title").textContent = "Edit Shop";
    });
    dialog.querySelector('[data-act="visit"]').addEventListener("click", async () => {
      if (!shop.items.length) return showErr("Add some wares first.");
      const saved = await doSave();
      if (!saved) return;
      close();
      visit(saved);
    });
  }

  showList();
}

function dragData(e) {
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  try { const d = TE?.getDragEventData?.(e); if (d && Object.keys(d).length) return d; } catch {}
  try { return JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return null; }
}

// ── Visit ────────────────────────────────────────────────────────────────────

/** GM: open the shop for everyone. Haggled prices last for one visit. */
function visit(shop) {
  if (!shop) return;
  delete deals[shop.id];
  game.socket.emit(SOCKET, { action: "shop.visit", shop });
  openVisit(shop);
  ui.notifications.info(`${shopLabel(shop)} is open for the party.`);
}

let current = null;   // { shop, refreshStock, render } for the open visit popup

function applyStock(shopId, stock) {
  if (!current || current.shop.id !== shopId) return;
  for (const it of current.shop.items) if (it.key in stock) it.stock = stock[it.key];
  current.refreshStock();
}
/** New wares (e.g. something a player sold) — redraw the open shop. */
function applyWares(shop) {
  if (!current || current.shop.id !== shop?.id) return;
  current.shop.items = foundry.utils.deepClone(shop.items);
  current.render();
}

// What a shop can be offered: physical items, not containers (their contents would be orphaned)
const SELLABLE = new Set(["weapon", "equipment", "consumable", "tool", "loot"]);
const valueCpOf = (item) => { const p = priceOf(item); return toCp(p.value, p.denomination); };
const quantityOf = (item) => {
  const q = item?.system?.quantity;
  return q === undefined || q === null ? 1 : Math.max(0, Math.floor(Number(q)) || 0);
};
const gp = (cp) => +(cp / 100).toFixed(2);
const fromGp = (v) => Math.max(0, Math.round((Number(v) || 0) * 100));

function openVisit(shop) {
  const casters = castersForUser();
  if (!shop || (!game.user.isGM && !casters.length)) return;   // not in the party → nothing to show
  if (!casters.length) return ui.notifications.warn("No player characters to shop with.");
  const { dialog, close } = openShell({ floating: false });
  const isGM = game.user.isGM;
  let buyer = (game.user.character && casters.includes(game.user.character)) ? game.user.character : casters[0];
  let tab = "buy";
  const qty = {}, price = {};          // buy: per ware key (price in the ware's coin)
  const agreedBy = {};                 // actorId → { wareKey: unitCp } prices the GM agreed to
  const sellQty = {}, sellAsk = {};    // sell: per item id (asking price in gp)
  let pending = null;                  // offer waiting for the GM: { id, kind }
  let status = null;                   // { kind: "wait" | "counter" | "ok" | "no", text, lines? }

  const walletOf = (a) => walletCp(a?.system?.currency);
  const stockText = (it) => it.stock === null || it.stock === undefined ? "" : it.stock > 0 ? `${it.stock} left` : "sold out";
  const agreed = () => (agreedBy[buyer.id] ??= {});
  const listCpOf = (it) => toCp(it.price.value, it.price.denomination);
  const coinOf = (it) => COIN_CP[it.price.denomination] ?? 100;
  const basePriceOf = (it) => (agreed()[it.key] ?? listCpOf(it)) / coinOf(it);   // agreed price, else list
  const sellables = () => [...(buyer.items?.contents ?? buyer.items?._l ?? buyer.items ?? [])]
    .filter(i => SELLABLE.has(i.type) && quantityOf(i) > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  function statusHtml() {
    if (!status) return "";
    if (status.kind === "counter") {
      return `<div class="qa-offer-status counter">
        <div><b>Counter-offer</b> from ${escapeHtml(ownerName(shop) || "the shopkeeper")}:</div>
        <ul>${status.lines.map(l => `<li>${escapeHtml(l.name)} ×${l.qty}: <b>${formatCp(l.dealCp)}</b> each <span class="qa-tag">you asked ${formatCp(l.offerCp)}</span></li>`).join("")}</ul>
        <div class="qa-offer-actions"><button type="button" class="btn" data-act="counter-no">Decline</button><button type="button" class="btn primary" data-act="counter-yes">Accept</button></div>
      </div>`;
    }
    return `<div class="qa-offer-status ${status.kind}">${status.kind === "wait" ? '<i class="fas fa-hourglass-half"></i> ' : ""}${escapeHtml(status.text)}
      ${status.kind === "wait" ? '<button type="button" class="btn" data-act="cancel-offer">Withdraw</button>' : ""}</div>`;
  }

  function buyHtml() {
    return `
      <div class="field">
        <div class="field-label qa-ware-cols"><span>Wares</span><span>Price each</span><span>Qty</span><span>Total</span></div>
        <div class="players">
          ${shop.items.length ? shop.items.map(it => `
            <div class="player-row qa-ware" data-key="${it.key}">
              <img class="qa-item-img" src="${escapeHtml(it.img || "icons/svg/item-bag.svg")}" alt="">
              <label class="qa-ware-name" title="${escapeHtml(plainText(it.data?.system?.description?.value))}"><span>${escapeHtml(it.name)}</span><span class="qa-hp qa-stock">${stockText(it)}</span></label>
              <div class="qa-price">
                <input type="number" class="qa-num qa-ware-price" min="0" step="any" value="${+(+(price[it.key] ?? basePriceOf(it))).toFixed(2)}"
                  title="${isGM ? "Change the price — it shows on the receipt" : "Change the price and press Haggle to make an offer"}">
                <span class="qa-denom">${it.price.denomination}</span>
              </div>
              <div class="num-input">
                <button type="button" data-step="-1">−</button>
                <input type="number" class="qa-ware-qty" min="0" step="1" value="${qty[it.key] ?? 0}">
                <button type="button" data-step="1">+</button>
              </div>
              <span class="qa-line-total">—</span>
            </div>`).join("") : `<div class="player-row qa-empty">Nothing for sale right now.</div>`}
        </div>
      </div>
      <div class="qa-alloc">Total <b class="qa-total">0 gp</b> · <span class="qa-buyer-name">${escapeHtml(buyer.name)}</span> has <b class="qa-have">${formatCp(walletOf(buyer))}</b></div>
      <div class="qa-note">${isGM ? "Change a price to sell at a different price — the receipt will show it."
        : "Want a better price? Change it and press <b>Haggle</b> — you'll roll Persuasion and the shopkeeper decides."}</div>`;
  }

  function sellHtml() {
    const items = sellables();
    return `
      <div class="field">
        <div class="field-label qa-sell-cols"><span>Your items</span><span>Value</span><span>Asking (gp)</span><span>Qty</span><span>Total</span></div>
        <div class="players">
          ${items.length ? items.map(i => {
            const v = valueCpOf(i);
            return `
            <div class="player-row qa-sell" data-id="${i.id}">
              <img class="qa-item-img" src="${escapeHtml(i.img || "icons/svg/item-bag.svg")}" alt="">
              <label class="qa-ware-name"><span>${escapeHtml(i.name)}</span><span class="qa-hp">${quantityOf(i) > 1 ? `have ${quantityOf(i)}` : ""}${i.system?.equipped ? " · equipped" : ""}</span></label>
              <span class="qa-sell-value">${v ? formatCp(v) : "—"}</span>
              <input type="number" class="qa-num qa-sell-ask" min="0" step="any" value="${sellAsk[i.id] ?? gp(Math.floor(v / 2))}" title="Shops usually pay half the value">
              <div class="num-input">
                <button type="button" data-step="-1">−</button>
                <input type="number" class="qa-sell-qty" min="0" step="1" value="${sellQty[i.id] ?? 0}">
                <button type="button" data-step="1">+</button>
              </div>
              <span class="qa-line-total">—</span>
            </div>`;
          }).join("") : `<div class="player-row qa-empty">${escapeHtml(buyer.name)} has nothing the shop could buy.</div>`}
        </div>
      </div>
      <div class="qa-alloc">Asking <b class="qa-total">0 gp</b> · <span class="qa-buyer-name">${escapeHtml(buyer.name)}</span> has <b class="qa-have">${formatCp(walletOf(buyer))}</b></div>
      <div class="qa-note">Shops usually pay half an item's value.${isGM ? "" : " Ask for more and you'll roll Persuasion."} The shopkeeper decides what they'll buy.</div>`;
  }

  function render() {
    dialog.innerHTML = `
      <div class="title">${escapeHtml(shopLabel(shop))}</div>
      <div class="field">
        <div class="field-label">${tab === "buy" ? "Buying as" : "Selling as"}</div>
        <div class="players">
          ${casters.map(a => `
            <div class="player-row">
              <label>
                <input type="radio" name="qa-buyer" value="${a.id}"${a === buyer ? " checked" : ""}${casters.length === 1 ? " hidden" : ""}>
                <span>${escapeHtml(a.name)}</span>
              </label>
              <span class="qa-tag qa-purse" data-actor="${a.id}">${formatCp(walletOf(a))}</span>
            </div>`).join("")}
        </div>
      </div>
      <div class="mode-toggle qa-shop-tabs">
        <button type="button" data-tab="buy" class="${tab === "buy" ? "active" : ""}">Buy</button>
        <button type="button" data-tab="sell" class="${tab === "sell" ? "active" : ""}">Sell</button>
      </div>
      ${tab === "buy" ? buyHtml() : sellHtml()}
      ${statusHtml()}
      <div class="qa-error" hidden></div>
      <div class="actions">
        <button type="button" class="btn" data-act="leave">Leave</button>
        ${tab === "buy"
          ? `${isGM ? "" : '<button type="button" class="btn" data-act="haggle" disabled>Haggle</button>'}<button type="button" class="btn primary" data-act="buy" disabled>Buy</button>`
          : `<button type="button" class="btn primary" data-act="sell" disabled>${isGM ? "Sell" : "Offer to sell"}</button>`}
      </div>`;

    dialog.querySelector('[data-act="leave"]').addEventListener("click", () => {
      if (pending) cancelOffer(pending.id);
      close();
    });
    dialog.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => {
      if (b.dataset.tab === tab) return;
      tab = b.dataset.tab;
      if (status?.kind !== "wait" && status?.kind !== "counter") status = null;
      render();
    }));
    dialog.querySelectorAll('input[name="qa-buyer"]').forEach(r => r.addEventListener("change", () => {
      buyer = game.actors.get(r.value) ?? buyer;
      for (const k of Object.keys(price)) delete price[k];
      render();
    }));
    dialog.querySelector('[data-act="cancel-offer"]')?.addEventListener("click", () => {
      if (pending) cancelOffer(pending.id);
      pending = null; status = { kind: "no", text: "Offer withdrawn." };
      render();
    });
    dialog.querySelector('[data-act="counter-yes"]')?.addEventListener("click", () => {
      answerCounter(pending.id, true);
      status = { kind: "wait", text: "Shaking on it…" };
      render();
    });
    dialog.querySelector('[data-act="counter-no"]')?.addEventListener("click", () => {
      answerCounter(pending.id, false);
      pending = null; status = { kind: "no", text: "You declined the counter-offer." };
      if (tab === "buy") for (const k of Object.keys(price)) delete price[k];
      render();
    });
    if (tab === "buy") bindBuy(); else bindSell();
  }

  // Handles the GM's answers to an offer
  function onReply(r) {
    if (!pending || r.offerId !== pending.id) return;
    const kind = pending.kind;
    switch (r.status) {
      case "countered":
        status = { kind: "counter", lines: r.lines };
        break;
      case "accepted":   // haggled purchase prices
        for (const l of r.lines) { agreed()[l.key] = l.dealCp; delete price[l.key]; }
        pending = null;
        status = { kind: "ok", text: `Deal! ${r.lines.map(l => `${l.name} at ${formatCp(l.dealCp)}`).join(", ")} — now press Buy.` };
        break;
      case "done":       // sale carried out
        pending = null;
        for (const k of Object.keys(sellQty)) delete sellQty[k];
        for (const k of Object.keys(sellAsk)) delete sellAsk[k];
        status = { kind: "ok", text: `Sold for ${formatCp(r.result?.totalCp ?? 0)}.` };
        setTimeout(render, 400);   // let the sheet changes arrive
        break;
      default:           // refused, declined, error, cancelled
        pending = null;
        status = { kind: "no", text: r.message || "No deal." };
        if (kind === "buy") for (const k of Object.keys(price)) delete price[k];
    }
    render();
  }

  function bindBuy() {
    const rows = [...dialog.querySelectorAll(".qa-ware")];
    const itemOf = (r) => shop.items.find(i => i.key === r.dataset.key);
    const qtyInput = (r) => r.querySelector(".qa-ware-qty");
    const capOf = (r) => { const s = itemOf(r).stock; return s === null || s === undefined ? 999 : s; };
    const err = dialog.querySelector(".qa-error");
    const buyBtn = dialog.querySelector('[data-act="buy"]');
    const haggleBtn = dialog.querySelector('[data-act="haggle"]');
    // A player's changed price is an offer until the GM agrees to it
    const offerCpOf = (r) => toCp(Math.max(0, Number(r.querySelector(".qa-ware-price").value) || 0), itemOf(r).price.denomination);
    const isOffer = (r) => !isGM && offerCpOf(r) !== Math.round(basePriceOf(itemOf(r)) * coinOf(itemOf(r)));

    function refresh() {
      let total = 0, any = false, unagreed = false, offers = 0;
      for (const r of rows) {
        const it = itemOf(r);
        const q = Math.max(0, Math.min(capOf(r), Math.floor(Number(qtyInput(r).value) || 0)));
        qtyInput(r).value = String(q);
        qty[it.key] = q;
        const unit = Math.max(0, Number(r.querySelector(".qa-ware-price").value) || 0);
        price[it.key] = unit;
        const offer = isOffer(r);
        offers += offer ? 1 : 0;
        unagreed ||= offer && q > 0;
        const line = q * toCp(unit, it.price.denomination);
        total += line;
        any ||= q > 0;
        r.querySelector(".qa-line-total").textContent = q ? formatCp(line) : "—";
        const input = r.querySelector(".qa-ware-price");
        input.classList.toggle("edited", toCp(unit, it.price.denomination) !== listCpOf(it));
        input.classList.toggle("agreed", agreed()[it.key] !== undefined && !offer);
        input.disabled = !!pending;
        const [minus, plus] = r.querySelectorAll("[data-step]");
        minus.disabled = q <= 0;
        plus.disabled = q >= capOf(r);
        qtyInput(r).disabled = capOf(r) === 0;
        r.classList.toggle("qa-sold-out", capOf(r) === 0);
        r.querySelector(".qa-stock").textContent = stockText(it);
      }
      const have = walletOf(buyer);
      dialog.querySelector(".qa-total").textContent = formatCp(total);
      dialog.querySelector(".qa-have").textContent = formatCp(have);
      const short = total > have;
      const needsHaggle = unagreed && !pending;
      err.hidden = !(short || needsHaggle);
      if (short) err.textContent = `${buyer.name} is ${formatCp(total - have)} short.`;
      else if (needsHaggle) err.textContent = "You've changed a price — Haggle first, or put it back.";
      buyBtn.disabled = !any || short || unagreed || !!pending;
      if (haggleBtn) haggleBtn.disabled = !offers || !!pending;
      if (haggleBtn) haggleBtn.textContent = offers ? `Haggle (${offers})` : "Haggle";
    }

    for (const r of rows) {
      qtyInput(r).addEventListener("input", refresh);
      qtyInput(r).addEventListener("focus", (e) => e.target.select());
      r.querySelector(".qa-ware-price").addEventListener("input", refresh);
      r.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => {
        qtyInput(r).value = String((Math.floor(Number(qtyInput(r).value)) || 0) + Number(b.dataset.step));
        refresh();
      }));
    }
    haggleBtn?.addEventListener("click", async () => {
      const lines = rows.filter(isOffer).map(r => {
        const it = itemOf(r);
        return { key: it.key, name: it.name, img: it.img, qty: Math.max(1, qty[it.key] || 0), listCp: listCpOf(it), offerCp: offerCpOf(r) };
      });
      if (!lines.length) return;
      haggleBtn.disabled = true;
      const roll = await rollPersuasion(buyer);
      try {
        const id = sendOffer({ kind: "buy", shopId: shop.id, shopLabel: shopLabel(shop), actorId: buyer.id, actorName: buyer.name, roll, lines }, onReply);
        pending = { id, kind: "buy" };
        status = { kind: "wait", text: `Haggling${roll ? ` (Persuasion ${roll.total})` : ""} — waiting for the shopkeeper…` };
      } catch (e) { status = { kind: "no", text: e.message }; }
      render();
    });
    buyBtn.addEventListener("click", async () => {
      const lines = rows.map(r => ({ key: r.dataset.key, qty: qty[r.dataset.key] || 0, unit: isGM ? price[r.dataset.key] : undefined }))
        .filter(l => l.qty > 0);
      buyBtn.disabled = true; buyBtn.textContent = "Buying…"; err.hidden = true;
      try {
        const res = await runAsGM(BUY, { shopId: shop.id, actorId: buyer.id, lines });
        ui.notifications.info(`${buyer.name} paid ${formatCp(res.totalCp)}; ${formatCp(res.leftCp)} left.`);
        for (const k of Object.keys(qty)) qty[k] = 0;
        for (const k of Object.keys(price)) delete price[k];
        status = null;
        render();
      } catch (e) {
        err.hidden = false; err.textContent = e.message;
        buyBtn.textContent = "Buy";
        refresh();
      }
    });
    refresh();
    current.refreshStock = refresh;
  }

  function bindSell() {
    const rows = [...dialog.querySelectorAll(".qa-sell")];
    const itemOf = (r) => buyer.items.get(r.dataset.id);
    const qtyInput = (r) => r.querySelector(".qa-sell-qty");
    const err = dialog.querySelector(".qa-error");
    const sellBtn = dialog.querySelector('[data-act="sell"]');

    function refresh() {
      let total = 0, any = false;
      for (const r of rows) {
        const item = itemOf(r);
        if (!item) continue;
        const cap = quantityOf(item);
        const q = Math.max(0, Math.min(cap, Math.floor(Number(qtyInput(r).value) || 0)));
        qtyInput(r).value = String(q);
        sellQty[item.id] = q;
        const ask = Math.max(0, Number(r.querySelector(".qa-sell-ask").value) || 0);
        sellAsk[item.id] = ask;
        const line = q * fromGp(ask);
        total += line;
        any ||= q > 0;
        r.querySelector(".qa-line-total").textContent = q ? formatCp(line) : "—";
        r.querySelector(".qa-sell-ask").classList.toggle("edited", fromGp(ask) > Math.floor(valueCpOf(item) / 2));
        r.querySelector(".qa-sell-ask").disabled = !!pending;
        const [minus, plus] = r.querySelectorAll("[data-step]");
        minus.disabled = q <= 0 || !!pending;
        plus.disabled = q >= cap || !!pending;
      }
      dialog.querySelector(".qa-total").textContent = formatCp(total);
      dialog.querySelector(".qa-have").textContent = formatCp(walletOf(buyer));
      err.hidden = true;
      sellBtn.disabled = !any || !!pending;
    }

    for (const r of rows) {
      qtyInput(r).addEventListener("input", refresh);
      qtyInput(r).addEventListener("focus", (e) => e.target.select());
      r.querySelector(".qa-sell-ask").addEventListener("input", refresh);
      r.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => {
        qtyInput(r).value = String((Math.floor(Number(qtyInput(r).value)) || 0) + Number(b.dataset.step));
        refresh();
      }));
    }
    sellBtn.addEventListener("click", async () => {
      const lines = rows.map(r => ({ r, item: itemOf(r) })).filter(x => x.item && (sellQty[x.item.id] || 0) > 0).map(({ item }) => ({
        key: item.id, name: item.name, img: item.img, qty: sellQty[item.id], listCp: valueCpOf(item), offerCp: fromGp(sellAsk[item.id]),
      }));
      if (!lines.length) return;
      sellBtn.disabled = true; err.hidden = true;
      if (isGM) {
        try {
          const res = await runAsGM(SELL, { shopId: shop.id, actorId: buyer.id, lines: lines.map(l => ({ itemId: l.key, qty: l.qty, unitCp: l.offerCp })) });
          for (const k of Object.keys(sellQty)) delete sellQty[k];
          for (const k of Object.keys(sellAsk)) delete sellAsk[k];
          status = { kind: "ok", text: `Sold for ${formatCp(res.totalCp)}.` };
          setTimeout(render, 300);
        } catch (e) { err.hidden = false; err.textContent = e.message; sellBtn.disabled = false; }
        return;
      }
      // Asking more than half the value is haggling: roll Persuasion
      const haggling = lines.some(l => l.offerCp > Math.floor(l.listCp / 2));
      const roll = haggling ? await rollPersuasion(buyer) : null;
      try {
        const id = sendOffer({ kind: "sell", shopId: shop.id, shopLabel: shopLabel(shop), actorId: buyer.id, actorName: buyer.name, roll, lines }, onReply);
        pending = { id, kind: "sell" };
        status = { kind: "wait", text: `Offered to the shopkeeper${roll ? ` (Persuasion ${roll.total})` : ""} — waiting…` };
      } catch (e) { status = { kind: "no", text: e.message }; }
      render();
    });
    refresh();
    current.refreshStock = () => {};
  }

  current = { shop: foundry.utils.deepClone(shop), refreshStock: () => {}, render: () => render() };
  shop = current.shop;
  render();
}

// ── GM: purchase ─────────────────────────────────────────────────────────────

/**
 * Purchases are handled one at a time, in the order they arrive. Each one
 * reads the shop's stock and the buyer's purse only after the previous one has
 * finished saving, so two players can't both get the last item, and a double
 * click can't be charged once for two lots.
 */
let buyQueue = Promise.resolve();
function inTurn(fn) {
  const turn = buyQueue.then(fn);
  buyQueue = turn.catch(() => {});   // a refused purchase doesn't hold up the next
  return turn;
}
const gmBuyInTurn = (payload, user) => inTurn(() => gmBuy(payload, user));
const gmSellInTurn = (payload, user) => inTurn(() => gmSell(payload, user));

async function gmBuy({ shopId, actorId, lines } = {}, user) {
  const shops = allShops();
  const shop = shops[shopId];
  if (!shop) throw new Error("That shop no longer exists.");
  const actor = game.actors.get(actorId);
  if (!actor) throw new Error("Character not found.");
  if (!user?.isGM && !actor.testUserPermission(user, "OWNER")) throw new Error("You don't own that character.");

  const bought = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    const it = shop.items.find(i => i.key === l?.key);
    const q = Math.floor(Number(l?.qty)) || 0;
    if (!it || q <= 0) continue;
    if (it.stock !== null && it.stock !== undefined && q > it.stock) {
      throw new Error(it.stock ? `Only ${it.stock} ${it.name} left.` : `${it.name} has sold out.`);
    }
    const listCp = toCp(it.price.value, it.price.denomination);
    // Players pay the list price, or what the GM agreed when they haggled; the GM can set any price
    const deal = deals[shopId]?.[actorId]?.[it.key];
    const unitCp = deal !== undefined ? deal
      : user?.isGM && l.unit !== undefined && l.unit !== null ? toCp(l.unit, it.price.denomination) : listCp;
    bought.push({ it, q, unitCp, listCp, unitValue: unitCp / (COIN_CP[it.price.denomination] ?? 100) });
  }
  if (!bought.length) throw new Error("Nothing selected.");

  const totalCp = bought.reduce((t, b) => t + b.q * b.unitCp, 0);
  const before = walletCp(actor.system?.currency);
  const after = pay(actor.system?.currency, totalCp);
  if (!after) throw new Error(`${actor.name} can't afford that: costs ${formatCp(totalCp)}, has ${formatCp(before)}.`);

  // Items (stack consumables/loot onto a matching item already on the sheet)
  const create = [];
  for (const b of bought) {
    const existing = STACKABLE.has(b.it.type) ? actor.items.find(i => i.type === b.it.type && i.name === b.it.name) : null;
    if (existing) {
      await existing.update({ "system.quantity": (Number(existing.system?.quantity) || 0) + b.q });
    } else {
      // Items edited in their own sheet: use the latest version of that item
      const linked = b.it.linkUuid ? await fromUuid(b.it.linkUuid).catch(() => null) : null;
      const data = linked ? cleanItemData(linked) : foundry.utils.deepClone(b.it.data);
      data.name = b.it.name;
      data.system ??= {};
      data.system.quantity = b.q;
      data.system.price = { value: b.it.price.value, denomination: b.it.price.denomination };
      create.push(data);
    }
  }
  if (create.length) await actor.createEmbeddedDocuments("Item", create);

  // Money (after the items, so a problem adding them never charges anyone)
  await actor.update({ "system.currency": after });

  // Stock
  const stock = {};
  for (const b of bought) {
    if (b.it.stock !== null && b.it.stock !== undefined) { b.it.stock -= b.q; stock[b.it.key] = b.it.stock; }
  }
  if (Object.keys(stock).length) {
    shops[shopId] = shop;
    await game.settings.set(MODULE_ID, "shops", shops);
    game.socket.emit(SOCKET, { action: "shop.stock", shopId, stock });
    applyStock(shopId, stock);
  }

  // Receipt
  const leftCp = walletCp(after);
  const rows = bought.map(b => {
    const unit = `${+b.unitValue.toFixed(2)} ${b.it.price.denomination}`;
    const changed = b.unitCp !== b.listCp;
    return `
      <li class="qa-roll-row">
        <div class="qa-receipt-head">
          <span class="qa-roll-name">${b.q}× ${escapeHtml(b.it.name)}</span>
          <span class="qa-receipt-amt">${formatCp(b.q * b.unitCp)}</span>
        </div>
        <div class="qa-roll-meta">${unit} each${changed ? ` · <span class="qa-was" title="Haggled price">list price ${escapeHtml(priceText(b.it.price))}</span>` : ""}</div>
      </li>`;
  }).join("");
  const haggled = bought.some(b => b.unitCp !== b.listCp);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="skill-check-card qa-card">
        <header class="card-header">
          <span class="icon"><i class="fas fa-store"></i></span>
          <div class="title-block">
            <div class="skill-name">${escapeHtml(shopLabel(shop))}</div>
            <div class="ability-tag">${escapeHtml(actor.name)} — purchase</div>
          </div>
          <span class="dc-badge">${formatCp(totalCp)}</span>
        </header>
        <section class="card-content">
          <ul class="qa-rows">${rows}</ul>
          <div class="group-summary">Paid ${formatCp(totalCp)} · ${formatCp(leftCp)} left${haggled ? " · haggled" : ""}</div>
        </section>
      </div>`,
    flags: { [MODULE_ID]: { shopPurchase: {
      shopId, shopTitle: shop.title, shopOwner: ownerName(shop) || null, actorId: actor.id, totalCp, haggled,
      lines: bought.map(b => ({ name: b.it.name, type: b.it.type ?? b.it.data?.type ?? null, qty: b.q, unitCp: b.unitCp, listCp: b.listCp })),
    } } },
  });

  return { totalCp, leftCp };
}

// ── GM: sale ─────────────────────────────────────────────────────────────────

/**
 * A character sells items to the shop (after the GM agreed): the items leave
 * the sheet, the coins arrive, and the shop puts them up for sale at the price
 * it paid + 10% (the GM can change that in the shop editor).
 */
async function gmSell({ shopId, actorId, lines } = {}, user) {
  const shops = allShops();
  const shop = shops[shopId];
  if (!shop) throw new Error("That shop no longer exists.");
  const actor = game.actors.get(actorId);
  if (!actor) throw new Error("Character not found.");
  if (!user?.isGM && !actor.testUserPermission(user, "OWNER")) throw new Error("You don't own that character.");

  const sold = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    const q = Math.floor(Number(l?.qty)) || 0;
    if (q <= 0) continue;
    const item = actor.items.get(l.itemId);
    if (!item) throw new Error(`${actor.name} doesn't have that item any more.`);
    const have = quantityOf(item);
    if (q > have) throw new Error(`${actor.name} only has ${have} ${item.name}.`);
    sold.push({ item, q, have, unitCp: Math.max(0, Math.round(Number(l.unitCp) || 0)), valueCp: valueCpOf(item), data: cleanItemData(item) });
  }
  if (!sold.length) throw new Error("Nothing to sell.");
  const totalCp = sold.reduce((t, s) => t + s.q * s.unitCp, 0);
  const after = receive(actor.system?.currency, totalCp);

  // Take the items, then pay
  const updates = sold.filter(s => s.q < s.have).map(s => ({ _id: s.item.id, "system.quantity": s.have - s.q }));
  const deletes = sold.filter(s => s.q >= s.have).map(s => s.item.id);
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  if (deletes.length) await actor.deleteEmbeddedDocuments("Item", deletes);
  await actor.update({ "system.currency": after });

  // Into the shop's wares at the price paid + 10%
  for (const s of sold) {
    const existing = shop.items.find(i => i.name === s.item.name && i.type === s.item.type);
    if (existing) {
      if (existing.stock !== null && existing.stock !== undefined) existing.stock += s.q;
      continue;
    }
    const resale = { value: gp(Math.round(s.unitCp * 1.1)), denomination: "gp" };
    const data = s.data;
    data.system ??= {};
    data.system.quantity = 1;
    data.system.price = { ...resale };
    if ("equipped" in data.system) data.system.equipped = false;
    if ("attuned" in data.system) data.system.attuned = false;
    delete data.system.container;
    shop.items.push({ key: newId(), name: s.item.name, img: s.item.img, type: s.item.type, uuid: null, price: resale, stock: s.q, data });
  }
  shops[shopId] = shop;
  await game.settings.set(MODULE_ID, "shops", shops);
  game.socket.emit(SOCKET, { action: "shop.wares", shop });
  applyWares(shop);

  // Receipt
  const leftCp = walletCp(after);
  const rows = sold.map(s => `
      <li class="qa-roll-row">
        <div class="qa-receipt-head">
          <span class="qa-roll-name">${s.q}× ${escapeHtml(s.item.name)}</span>
          <span class="qa-receipt-amt">+${formatCp(s.q * s.unitCp)}</span>
        </div>
        <div class="qa-roll-meta">${formatCp(s.unitCp)} each${s.valueCp ? ` · value ${formatCp(s.valueCp)}` : ""}</div>
      </li>`).join("");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="skill-check-card qa-card">
        <header class="card-header">
          <span class="icon"><i class="fas fa-hand-holding-dollar"></i></span>
          <div class="title-block">
            <div class="skill-name">${escapeHtml(shopLabel(shop))}</div>
            <div class="ability-tag">${escapeHtml(actor.name)} — sale</div>
          </div>
          <span class="dc-badge">+${formatCp(totalCp)}</span>
        </header>
        <section class="card-content">
          <ul class="qa-rows">${rows}</ul>
          <div class="group-summary">Received ${formatCp(totalCp)} · now has ${formatCp(leftCp)}</div>
        </section>
      </div>`,
    flags: { [MODULE_ID]: { shopSale: {
      shopId, shopTitle: shop.title, shopOwner: ownerName(shop) || null, actorId: actor.id, totalCp,
      lines: sold.map(s => ({ name: s.item.name, type: s.item.type ?? null, qty: s.q, unitCp: s.unitCp, valueCp: s.valueCp })),
    } } },
  });
  return { totalCp, leftCp };
}
