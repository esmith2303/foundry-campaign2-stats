import { StatsCollector } from "./StatsCollector.mjs";
import { StatsUploader } from "./StatsUploader.mjs";
import { registerSettings } from "./settings.mjs";
import { registerSkillCheck, openSkillCheckDialog } from "./SkillCheck.mjs";
import { registerQuickActions, quickActionsTool, openQuickActions, QUICK_ACTIONS_TOOL } from "./QuickActions.mjs";
import { registerShop, shopTool, openShopManager, SHOP_TOOL } from "./shop/Shop.mjs";

const MODULE_ID = "dnd-group-campaign-2-stats";

// Dice, attack, save, check and heal stats are no longer counted live.
// They're extracted from the chat log at upload time (see extract.mjs), so
// there are no hooks here that can miss, race or double count a roll.

// ── Lifecycle ────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initialising`);
  registerSettings(MODULE_ID);
  loadStyles();
});

// Foundry 13 puts stylesheets listed in module.json into a low-priority CSS
// layer, so the skill-check styles (added straight to the page) would win over
// them. Adding ours the same way keeps every popup styled as intended.
function loadStyles() {
  const version = game.modules.get(MODULE_ID)?.version ?? "";
  for (const file of ["styles/quick-actions.css", "styles/shop.css"]) {
    if (document.querySelector(`link[data-qa-style="${file}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${foundry.utils.getRoute(`modules/${MODULE_ID}/${file}`)}?v=${version}`;
    link.dataset.qaStyle = file;
    document.head.appendChild(link);
  }
}

Hooks.once("ready", async () => {
  if (!game.modules.get("midi-qol")?.active) {
    ui.notifications.error("Midi-QOL Stats Uploader requires midi-qol to be active.");
    return;
  }
  game.modules.get(MODULE_ID).collector = new StatsCollector(MODULE_ID);
  game.modules.get(MODULE_ID).uploader = new StatsUploader(MODULE_ID);
  registerSkillCheck();
  registerQuickActions();
  registerShop();

  // Clear the old live-tracking store; nothing reads it any more
  if (game.user.isGM) {
    try {
      const old = game.settings.get(MODULE_ID, "diceRolls");
      if (old && Object.keys(old).length) await game.settings.set(MODULE_ID, "diceRolls", {});
    } catch {}
  }
  console.log(`${MODULE_ID} | Ready`);
});

// ── Toolbar button ───────────────────────────────────────────────────────────

Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControls = controls["tokens"];
  if (!tokenControls) return;

  // "+" Abilities button — every user
  tokenControls.tools[QUICK_ACTIONS_TOOL] = quickActionsTool();

  if (!game.user.isGM) return;
  // Shops — GM only (players just get the Visit popup when the GM opens one)
  tokenControls.tools[SHOP_TOOL] = shopTool();
  tokenControls.tools["midi-qol-upload"] = {
    name: "midi-qol-upload",
    title: "Upload Midi-QOL Stats",
    icon: "fas fa-cloud-upload-alt",
    button: true,
    onChange: () => {},
  };
  tokenControls.tools["midi-qol-skills"] = {
    name: "midi-qol-skills",
    title: "Character Skill Sheet",
    icon: "fas fa-scroll",
    button: true,
    onChange: () => {},
  };
});

Hooks.on("renderSceneControls", () => {
  // "+" Abilities button — every user
  const qaBtn = document.querySelector(`[data-tool="${QUICK_ACTIONS_TOOL}"]`);
  if (qaBtn) {
    const newQaBtn = qaBtn.cloneNode(true);
    qaBtn.parentNode.replaceChild(newQaBtn, qaBtn);
    newQaBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openQuickActions();
    });
  }

  if (!game.user.isGM) return;

  const shopBtn = document.querySelector(`[data-tool="${SHOP_TOOL}"]`);
  if (shopBtn) {
    const newShopBtn = shopBtn.cloneNode(true);
    shopBtn.parentNode.replaceChild(newShopBtn, shopBtn);
    newShopBtn.addEventListener("click", (e) => { e.stopPropagation(); openShopManager(); });
  }

  const btn = document.querySelector('[data-tool="midi-qol-upload"]');
  if (!btn) return;
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);

  newBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const mod = game.modules.get(MODULE_ID);
    const collector = mod?.collector;
    const uploader = mod?.uploader;
    if (!collector || !uploader) {
      ui.notifications.error("Midi-QOL Stats Uploader is not initialised.");
      return;
    }
    const apiUrl = game.settings.get(MODULE_ID, "apiUrl") || "(not configured)";
    const now = new Date().toLocaleString();
    const actorCount = collector.pendingCount;
    const messageCount = game.messages?.size ?? 0;

    new Dialog({
      title: "Upload Midi-QOL Stats",
      content: `
        <div class="stats-uploader-dialog">
          <p>Upload session stats for <strong>${actorCount}</strong> actor(s).</p>
          <p><strong>Time:</strong> ${now}</p>
          <p><strong>Endpoint:</strong> <code>${apiUrl}</code></p>
          <p><strong>Chat log:</strong> ${messageCount} message(s) — dice, attacks, saves and heals are read from these</p>
        </div>
      `,
      buttons: {
        upload: { icon: '<i class="fas fa-cloud-upload-alt"></i>', label: "Upload & End Session", callback: () => uploader.snapshotAndUpload(collector) },
        settings: { icon: '<i class="fas fa-cog"></i>', label: "Settings", callback: () => game.settings.sheet.render(true) },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" },
      },
      default: (actorCount > 0 || messageCount > 0) ? "upload" : "settings",
    }).render(true);
  });

  // ── Skills sheet button ────────────────────────────────────────────────
  const skillsBtn = document.querySelector('[data-tool="midi-qol-skills"]');
  if (skillsBtn) {
    const newSkillsBtn = skillsBtn.cloneNode(true);
    skillsBtn.parentNode.replaceChild(newSkillsBtn, skillsBtn);
    newSkillsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showSkillsSheet(newSkillsBtn);
    });
  }
});

function showSkillsSheet(anchorBtn) {
  // Toggle: if already open, close it
  const existing = document.getElementById("midi-skills-popover");
  if (existing) { existing._close?.(); return; }

  const characters = game.actors.contents
    .filter(a => a.hasPlayerOwner && (a.type === "character" || a.type === "npc"))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!characters.length) {
    ui.notifications.warn("No player-owned characters found.");
    return;
  }

  const skillConfig = CONFIG.DND5E?.skills || {};
  const skillKeys = Object.keys(skillConfig).sort((a, b) =>
    (skillConfig[a].label || a).localeCompare(skillConfig[b].label || b)
  );

  if (!skillKeys.length) {
    ui.notifications.warn("No skills configured in dnd5e.");
    return;
  }

  // Build rows
  const headerRow = `<tr><th class="skill-col">Skill</th>${characters.map(c =>
    `<th>${c.name.split(" ")[0]}</th>`).join("")}</tr>`;

  const bodyRows = skillKeys.map(skillKey => {
    const info = skillConfig[skillKey];
    const label = info.label || skillKey;
    const ability = (info.ability || "").toUpperCase();
    const cells = characters.map(char => {
      const skill = char.system?.skills?.[skillKey];
      if (!skill) return `<td class="skill-value muted"><div class="cell-inner"><span class="num">—</span><span class="stars"></span></div></td>`;
      const total = skill.total ?? 0;
      const sign = total >= 0 ? "+" : "";
      const prof = skill.value ?? (skill.proficient ? 1 : 0);
      let marker = "";
      if (prof >= 2)        marker = `<span class="prof expert" title="Expertise">★★</span>`;
      else if (prof >= 1)   marker = `<span class="prof" title="Proficient">★</span>`;
      else if (prof >= 0.5) marker = `<span class="prof half" title="Half">☆</span>`;
      return `<td class="skill-value${prof >= 1 ? " proficient" : ""}"><div class="cell-inner"><span class="num">${sign}${total}</span><span class="stars">${marker}</span></div></td>`;
    }).join("");
    return `<tr><td class="skill-name${game.user.isGM ? " clickable" : ""}" data-skill-key="${skillKey}">${label}<span class="ability">${ability}</span></td>${cells}</tr>`;
  }).join("");

  const popover = document.createElement("div");
  popover.id = "midi-skills-popover";
  popover.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;900&family=Crimson+Text:wght@400;700&family=JetBrains+Mono:wght@400;700&display=swap');

      #midi-skills-popover {
        --bg:#0a0a0f;--bg2:#12121a;--bg3:#1a1a28;--bg4:#22223a;
        --gold:#c9a84c;--gold-dim:#8a6d2b;--gold-bright:#e8c65a;
        --text:#d4d0c8;--text-dim:#7a7770;--text-bright:#f0ece4;
        --border:#2a2a3a;
        --font-display:'Cinzel',serif;--font-body:'Crimson Text',serif;--font-mono:'JetBrains Mono',monospace;
        position:fixed;
        z-index:100000;
        background:var(--bg);
        border:1px solid var(--gold-dim);
        border-radius:4px;
        padding:.9rem 1rem .8rem 1rem;
        box-shadow:0 10px 40px rgba(0,0,0,.6), 0 0 30px rgba(201,168,76,.08);
        font-family:var(--font-body);
        color:var(--text);
        width:max-content;
        max-width:95vw;
        max-height:90vh;
        display:flex; flex-direction:column;
        opacity:0; transform:translateX(-6px);
        transition:opacity .15s ease, transform .15s ease;
      }
      #midi-skills-popover.shown { opacity:1; transform:translateX(0); }
      #midi-skills-popover .title {
        font-family:var(--font-display); font-weight:600;
        font-size:.75rem; color:var(--gold);
        letter-spacing:.12em; text-transform:uppercase;
        margin:0 0 .6rem 0;
        padding-bottom:.5rem;
        border-bottom:1px solid var(--gold-dim);
        text-align:center;
      }
      #midi-skills-popover .skills-wrap {
        overflow:auto; flex:1; min-height:0;
        scrollbar-width:thin; scrollbar-color:var(--gold-dim) var(--bg2);
      }
      #midi-skills-popover .skills-wrap::-webkit-scrollbar { width:6px; height:6px; }
      #midi-skills-popover .skills-wrap::-webkit-scrollbar-thumb { background:var(--gold-dim); }
      #midi-skills-popover .skills-wrap::-webkit-scrollbar-track { background:var(--bg2); }
      #midi-skills-popover table {
        border-collapse:separate; border-spacing:0; width:auto; font-size:.75rem;
      }
      #midi-skills-popover th, #midi-skills-popover td {
        padding:.3rem .55rem;
        border-bottom:1px solid var(--border);
        text-align:center;
        white-space:nowrap;
      }
      #midi-skills-popover th {
        background:var(--bg3); color:var(--gold);
        font-family:var(--font-display); font-weight:600;
        font-size:.6rem; letter-spacing:.08em; text-transform:uppercase;
        position:sticky; top:0; z-index:2;
        border-bottom:1px solid var(--gold-dim);
        white-space:nowrap;
      }
      #midi-skills-popover th.skill-col { text-align:left; }
      #midi-skills-popover td.skill-name {
        text-align:left; white-space:nowrap;
        color:var(--text-bright); font-family:var(--font-body);
        font-size:.85rem;
      }
      #midi-skills-popover td.skill-name.clickable {
        cursor:pointer; transition:color .1s, background .1s;
      }
      #midi-skills-popover td.skill-name.clickable:hover {
        color:var(--gold-bright); background:rgba(201,168,76,.08);
      }
      #midi-skills-popover td.skill-name.clickable:active {
        background:rgba(201,168,76,.16);
      }
      #midi-skills-popover td.skill-name .ability {
        color:var(--text-dim); font-family:var(--font-mono);
        font-size:.55rem; margin-left:.4rem; letter-spacing:.05em;
      }
      #midi-skills-popover td.skill-value {
        font-family:var(--font-mono); font-weight:600;
        color:var(--text);
      }
      #midi-skills-popover td.skill-value .cell-inner {
        display:grid;
        grid-template-columns:1.4rem 1fr 1.4rem;
        align-items:center;
      }
      #midi-skills-popover td.skill-value .num {
        grid-column:2; text-align:center;
      }
      #midi-skills-popover td.skill-value .stars {
        grid-column:3; text-align:left; padding-left:.15rem;
      }
      #midi-skills-popover td.skill-value.muted {
        color:var(--text-dim); font-weight:400;
      }
      #midi-skills-popover td.skill-value.proficient {
        color:var(--gold-bright);
      }
      #midi-skills-popover tbody tr:hover td {
        background:rgba(201,168,76,.05);
      }
      #midi-skills-popover .prof {
        color:var(--gold); font-size:.75rem;
      }
      #midi-skills-popover .prof.expert { color:var(--gold-bright); }
      #midi-skills-popover .prof.half    { color:var(--text-dim); }
      #midi-skills-popover .legend {
        margin-top:.5rem; padding-top:.45rem;
        border-top:1px solid var(--border);
        color:var(--text-dim); font-size:.6rem;
        text-align:center; letter-spacing:.05em;
        font-family:var(--font-mono);
      }
      #midi-skills-popover .legend .prof { display:inline; margin:0 .15rem; font-size:.75rem; }
    </style>
    <div class="title">Character Skills</div>
    <div class="skills-wrap">
      <table>
        <thead>${headerRow}</thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <div class="legend">
      <span class="prof">★</span>Proficient &nbsp;
      <span class="prof expert">★★</span>Expertise &nbsp;
      <span class="prof half">☆</span>Half
    </div>
  `;

  document.body.appendChild(popover);

  // GM: clicking a skill name opens the skill check dialog
  if (game.user.isGM) {
    popover.querySelectorAll("td.skill-name.clickable").forEach(cell => {
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        const skillKey = cell.dataset.skillKey;
        if (skillKey) openSkillCheckDialog(skillKey);
        // Close popover after launching the dialog
        popover._close?.();
      });
    });
  }

  // Position next to the button — to the right by default, flip left if no room
  const margin = 8;
  const aRect = anchorBtn.getBoundingClientRect();
  const pRect = popover.getBoundingClientRect();
  let left = aRect.right + margin;
  if (left + pRect.width > window.innerWidth - margin) {
    left = aRect.left - pRect.width - margin;
    if (left < margin) left = margin;
  }
  let top = aRect.top;
  if (top + pRect.height > window.innerHeight - margin) {
    top = window.innerHeight - pRect.height - margin;
  }
  if (top < margin) top = margin;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  requestAnimationFrame(() => popover.classList.add("shown"));

  // Close handler
  const close = () => {
    popover.classList.remove("shown");
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey);
    setTimeout(() => popover.remove(), 200);
  };
  popover._close = close;

  const onOutside = (e) => {
    if (!popover.contains(e.target) && e.target !== anchorBtn && !anchorBtn.contains(e.target)) close();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };

  // Defer to avoid catching the click that opened us
  setTimeout(() => {
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey);
  }, 0);
}
