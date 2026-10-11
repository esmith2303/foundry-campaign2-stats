/**
 * Shops.
 *
 * GM: the store button opens a floating panel (it doesn't block the screen, so
 * compendiums and the Items sidebar stay usable) listing saved shops. A shop
 * has a title and wares; drag items in from a compendium, the Items sidebar or
 * a sheet (price taken from the item), or add custom items (0 gp). Name, price,
 * coin and stock are editable. Shops are saved in the world for reuse.
 *
 * "Visit" pushes the shop to every player (and the GM). Players pick a
 * character, quantities and — if they haggle — a different price. The GM's
 * client checks stock and coin, takes the money (making change), adds the
 * items to the sheet, reduces stock and posts a receipt card that shows any
 * price changes.
 */
import { MODULE_ID, escapeHtml } from "../abilities/shared.mjs";
import { registerGmAction, runAsGM, castersForUser } from "../QuickActions.mjs";
import { COIN_CP, DENOMS, toCp, walletCp, formatCp, pay } from "./currency.mjs";
import { detailsHtml, bindDetails, applyDetails, validateItem } from "./itemDetails.mjs";

const SOCKET = `module.${MODULE_ID}`;
export const SHOP_TOOL = "stats-shop";
const BUY = "shop.buy";
const PHYSICAL = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]);
const STACKABLE = new Set(["consumable", "loot"]);

// ── Setup ────────────────────────────────────────────────────────────────────

export function registerShop() {
  registerGmAction(BUY, gmBuy);
  game.socket.on(SOCKET, (data) => {
    if (data?.action === "shop.visit") openVisit(data.shop);
    else if (data?.action === "shop.stock") applyStock(data.shopId, data.stock);
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
  const dialog = document.createElement("div");
  dialog.id = "qa-shop-dialog";
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("shown"));

  const onClose = [];   // cleanup to run when the panel closes (e.g. the compendium window)
  const onKey = (e) => { if (e.key === "Escape" && !e.target.closest?.("input, select, textarea")) close(); };
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
    Object.assign(dialog.style, { pointerEvents: "auto", position: "fixed", left: "110px", top: "70px" });
    dialog.addEventListener("mousedown", (e) => {
      const handle = e.target.closest(".qa-drag-handle");
      if (!handle) return;
      const r = dialog.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => {
        dialog.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx))}px`;
        dialog.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))}px`;
      };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      e.preventDefault();
    });
  }
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
              <label><i class="fas fa-store qa-ability-icon"></i><span>${escapeHtml(s.title || "Untitled shop")}</span></label>
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
      ui.notifications.info(`Saved ${shop.title}.`);
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

/** GM: open the shop for everyone. */
function visit(shop) {
  if (!shop) return;
  game.socket.emit(SOCKET, { action: "shop.visit", shop });
  openVisit(shop);
  ui.notifications.info(`${shop.title} is open for the party.`);
}

let current = null;   // { shop, render } for the open visit popup

function applyStock(shopId, stock) {
  if (!current || current.shop.id !== shopId) return;
  for (const it of current.shop.items) if (it.key in stock) it.stock = stock[it.key];
  current.refreshStock();
}

function openVisit(shop) {
  const casters = castersForUser();
  if (!shop || (!game.user.isGM && !casters.length)) return;   // not in the party → nothing to show
  if (!casters.length) return ui.notifications.warn("No player characters to shop with.");
  const { dialog, close } = openShell({ floating: false });
  let buyer = (game.user.character && casters.includes(game.user.character)) ? game.user.character : casters[0];
  const qty = {}, price = {};

  const walletOf = (a) => walletCp(a?.system?.currency);
  const stockText = (it) => it.stock === null || it.stock === undefined ? "" : it.stock > 0 ? `${it.stock} left` : "sold out";

  function render() {
    dialog.innerHTML = `
      <div class="title">${escapeHtml(shop.title)}</div>
      <div class="field">
        <div class="field-label">Buying as</div>
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
      <div class="field">
        <div class="field-label qa-ware-cols"><span>Wares</span><span>Price each</span><span>Qty</span><span>Total</span></div>
        <div class="players">
          ${shop.items.map(it => `
            <div class="player-row qa-ware" data-key="${it.key}">
              <img class="qa-item-img" src="${escapeHtml(it.img || "icons/svg/item-bag.svg")}" alt="">
              <label class="qa-ware-name" title="${escapeHtml(plainText(it.data?.system?.description?.value))}"><span>${escapeHtml(it.name)}</span><span class="qa-hp qa-stock">${stockText(it)}</span></label>
              <div class="qa-price">
                <input type="number" class="qa-num qa-ware-price" min="0" step="any" value="${+(+(price[it.key] ?? it.price.value)).toFixed(2)}" title="Haggled? Change the price — it shows on the receipt">
                <span class="qa-denom">${it.price.denomination}</span>
              </div>
              <div class="num-input">
                <button type="button" data-step="-1">−</button>
                <input type="number" class="qa-ware-qty" min="0" step="1" value="${qty[it.key] ?? 0}">
                <button type="button" data-step="1">+</button>
              </div>
              <span class="qa-line-total">—</span>
            </div>`).join("")}
        </div>
      </div>
      <div class="qa-alloc">Total <b class="qa-total">0 gp</b> · <span class="qa-buyer-name">${escapeHtml(buyer.name)}</span> has <b class="qa-have">${formatCp(walletOf(buyer))}</b></div>
      <div class="qa-note">Haggled? Change the price — the receipt will show the change.</div>
      <div class="qa-error" hidden></div>
      <div class="actions">
        <button type="button" class="btn" data-act="leave">Leave</button>
        <button type="button" class="btn primary" data-act="buy" disabled>Buy</button>
      </div>`;

    const rows = [...dialog.querySelectorAll(".qa-ware")];
    const itemOf = (r) => shop.items.find(i => i.key === r.dataset.key);
    const qtyInput = (r) => r.querySelector(".qa-ware-qty");
    const capOf = (r) => { const s = itemOf(r).stock; return s === null || s === undefined ? 999 : s; };
    const err = dialog.querySelector(".qa-error");
    const buyBtn = dialog.querySelector('[data-act="buy"]');

    function refresh() {
      let total = 0, any = false;
      for (const r of rows) {
        const it = itemOf(r);
        const q = Math.max(0, Math.min(capOf(r), Math.floor(Number(qtyInput(r).value) || 0)));
        qtyInput(r).value = String(q);
        qty[it.key] = q;
        const unit = Math.max(0, Number(r.querySelector(".qa-ware-price").value) || 0);
        price[it.key] = unit;
        const line = q * toCp(unit, it.price.denomination);
        total += line;
        any ||= q > 0;
        r.querySelector(".qa-line-total").textContent = q ? formatCp(line) : "—";
        r.querySelector(".qa-ware-price").classList.toggle("edited", toCp(unit, it.price.denomination) !== toCp(it.price.value, it.price.denomination));
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
      err.hidden = !short;
      if (short) err.textContent = `${buyer.name} is ${formatCp(total - have)} short.`;
      buyBtn.disabled = !any || short;
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
    dialog.querySelectorAll('input[name="qa-buyer"]').forEach(r => r.addEventListener("change", () => {
      buyer = game.actors.get(r.value) ?? buyer;
      dialog.querySelector(".qa-buyer-name").textContent = buyer.name;
      refresh();
    }));
    dialog.querySelector('[data-act="leave"]').addEventListener("click", close);
    buyBtn.addEventListener("click", async () => {
      const lines = rows.map(r => ({ key: r.dataset.key, qty: qty[r.dataset.key] || 0, unit: price[r.dataset.key] }))
        .filter(l => l.qty > 0);
      buyBtn.disabled = true; buyBtn.textContent = "Buying…"; err.hidden = true;
      try {
        const res = await runAsGM(BUY, { shopId: shop.id, actorId: buyer.id, lines });
        ui.notifications.info(`${buyer.name} paid ${formatCp(res.totalCp)}; ${formatCp(res.leftCp)} left.`);
        for (const k of Object.keys(qty)) qty[k] = 0;
        for (const k of Object.keys(price)) delete price[k];   // haggled prices don't carry over
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

  current = { shop: foundry.utils.deepClone(shop), refreshStock: () => {} };
  shop = current.shop;
  render();
}

// ── GM: purchase ─────────────────────────────────────────────────────────────

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
    const unitCp = l.unit === undefined || l.unit === null ? listCp : toCp(l.unit, it.price.denomination);
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
        <div class="qa-roll-meta">${unit} each${changed ? ` · <span class="qa-was" title="Price changed by the player">list price ${escapeHtml(priceText(b.it.price))}</span>` : ""}</div>
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
            <div class="skill-name">${escapeHtml(shop.title)}</div>
            <div class="ability-tag">${escapeHtml(actor.name)} — purchase</div>
          </div>
          <span class="dc-badge">${formatCp(totalCp)}</span>
        </header>
        <section class="card-content">
          <ul class="qa-rows">${rows}</ul>
          <div class="group-summary">Paid ${formatCp(totalCp)} · ${formatCp(leftCp)} left${haggled ? " · price changed by player" : ""}</div>
        </section>
      </div>`,
    flags: { [MODULE_ID]: { shopPurchase: {
      shopId, shopTitle: shop.title, actorId: actor.id, totalCp, haggled,
      lines: bought.map(b => ({ name: b.it.name, qty: b.q, unitCp: b.unitCp, listCp: b.listCp })),
    } } },
  });

  return { totalCp, leftCp };
}
