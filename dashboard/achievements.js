/*
 * Trophy Cabinet section for the stats dashboard: every achievement each
 * character has unlocked (from the achievement cards in the chat log).
 *
 * Install: copy next to index.html (/var/www/dashboard/achievements.js) and
 * add one line after casino.js:   <script src="achievements.js"></script>
 */
(function () {
  if (typeof loadDashboard !== "function") return console.warn("achievements.js: load it after the dashboard script");

  var style = document.createElement("style");
  style.textContent =
    "#trophy-section{margin-bottom:3rem}" +
    "#trophy-section .section-title{font-family:var(--font-display);font-size:1.1rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold);margin:0 0 1.2rem;display:flex;align-items:center;gap:.6rem}" +
    "#trophy-section .section-title::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--gold-dim),transparent)}" +
    "#trophy-section .cabinets{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}" +
    "#trophy-section .cabinet h2{display:flex;justify-content:space-between;align-items:baseline}" +
    "#trophy-section .cabinet h2 span{font-family:var(--font-mono);font-size:.75rem;color:var(--text-dim);letter-spacing:0}" +
    "#trophy-section .trophy{display:flex;align-items:center;gap:.6rem;padding:.4rem 0;border-bottom:1px solid var(--border)}" +
    "#trophy-section .trophy:last-child{border-bottom:none}" +
    "#trophy-section .medal{flex:none;width:26px;height:26px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff3c4 0,#e8c65a 35%,#a8832f 100%);box-shadow:0 0 0 1px #0a0a0f,0 0 0 2px var(--gold-dim);display:flex;align-items:center;justify-content:center;font:700 .62rem var(--font-mono);color:#2a1a08}" +
    "#trophy-section .trophy .tname{flex:1;min-width:0;display:flex;flex-direction:column;gap:.1rem}" +
    "#trophy-section .trophy .tdesc{color:#a8a49b;font-size:.85em;font-style:italic;line-height:1.25}" +
    "#trophy-section .medal svg{width:14px;height:14px;display:block;fill:#2a1a08}" +
    "#trophy-section .trophy .when{font-family:var(--font-mono);font-size:.7rem;color:var(--text-dim);white-space:nowrap}";
  document.head.appendChild(style);

  var ROMAN = ["", "I", "II", "III", "IV", "V", "VI"];
  // A centred star for one-off achievements (a text ★ sits low and small)
  var STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>';
  // Achievements with tiers (the medal shows the tier reached)
  var TIERED = { tymora: 1, cursed: 1, thousandCuts: 1, humanShield: 1, fieldMedic: 1 };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function day(ts) { return new Date(ts).toLocaleDateString(); }

  var renderToken = 0;
  async function renderTrophies() {
    var token = ++renderToken;
    var content = document.getElementById("content");
    if (!content) return;
    var session = document.getElementById("session-select").value;
    var parts = [];
    if (session !== "all") parts.push("session=" + encodeURIComponent(session));
    if (hiddenNames.length) parts.push("exclude=" + encodeURIComponent(hiddenNames.join(",")));
    if (hiddenWorlds.length) parts.push("excludeWorlds=" + encodeURIComponent(hiddenWorlds.join(",")));
    var rows, failed = null;
    try { rows = await apiFetch("/achievements" + (parts.length ? "?" + parts.join("&") : "")); }
    catch (e) { console.warn("achievements.js: could not load achievements", e); failed = e; }
    if (token !== renderToken) return;

    var existing = document.getElementById("trophy-section");
    if (existing) existing.remove();
    var section = document.createElement("div");
    section.id = "trophy-section";
    var title = '<div class="section-title">' + (session === "all" ? "Trophy Cabinet" : "Achievements This Session") + "</div>";
    if (failed) {
      // Most likely the stats server hasn't been restarted since updating (pm2 restart)
      section.innerHTML = title + '<div class="panel"><div class="no-data">Couldn\'t load achievements (' + esc(failed.message) +
        "). If that's a 404, the stats server needs restarting with the latest code.</div></div>";
      return place(section);
    }
    rows = keepPCsOnly(rows);
    if (!rows.length) {
      section.innerHTML = title + '<div class="panel"><div class="no-data">No achievements ' + (session === "all" ? "yet" : "this session") + ".</div></div>";
      return place(section);
    }
    var by = {};
    rows.forEach(function (r) { (by[r.actor_name] = by[r.actor_name] || []).push(r); });
    var names = Object.keys(by).sort(function (a, b) { return by[b].length - by[a].length || a.localeCompare(b); });
    var html = title + '<div class="cabinets">';
    names.forEach(function (n) {
      html += '<div class="panel cabinet"><h2>' + esc(n) + "<span>" + by[n].length + " earned</span></h2>";
      by[n].forEach(function (r) {
        var tiered = TIERED[r.id];
        html += '<div class="trophy"><span class="medal">' + (tiered ? ROMAN[r.tier] || r.tier : STAR) + '</span><span class="tname"><span>' + esc(r.name || r.id) +
          (tiered ? " " + (ROMAN[r.tier] || r.tier) : "") + "</span>" + (r.desc ? '<span class="tdesc">' + esc(r.desc) + "</span>" : "") + '</span><span class="when">' + day(r.last_at) + "</span></div>";
      });
      html += "</div>";
    });
    section.innerHTML = html + "</div>";
    place(section);
  }

  // Keep the cabinet at the very bottom, after Shops and Casino
  function place(section) {
    var content = document.getElementById("content");
    content.appendChild(section);
  }
  new MutationObserver(function () {
    var content = document.getElementById("content"), trophy = document.getElementById("trophy-section");
    if (content && trophy && trophy.parentNode === content && content.lastElementChild !== trophy) content.appendChild(trophy);
  }).observe(document.body, { childList: true, subtree: true });

  var original = loadDashboard;
  loadDashboard = async function () {
    var result = await original.apply(this, arguments);
    renderTrophies();
    return result;
  };
})();
