/*
 * Casino section for the stats dashboard.
 *
 * Install: copy this file next to the dashboard's index.html
 * (/var/www/dashboard/casino.js) and add one line after shops.js:
 *
 *     <script src="casino.js"></script>
 *
 * Uses the dashboard's own globals (apiFetch, keepPCsOnly, hiddenNames,
 * hiddenWorlds, COLORS, Chart). Adds a "Casino" panel below Shops on every
 * dashboard load, for the selected session or lifetime.
 */
(function () {
  if (typeof loadDashboard !== "function") return console.warn("casino.js: load it after the dashboard script");

  var style = document.createElement("style");
  style.textContent =
    "#casino-section{margin-bottom:3rem}" +
    "#casino-section .section-title{font-family:var(--font-display);font-size:1.1rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold);margin:0 0 1.2rem;display:flex;align-items:center;gap:.6rem}" +
    "#casino-section .section-title::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--gold-dim),transparent)}" +
    "#casino-section .stat-card .value.small{font-size:1.15rem;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    "#casino-section .panel{margin-bottom:2rem}" +
    "#casino-section .table-scroll{overflow-x:auto}" +
    "#casino-section td .dim{color:var(--text-dim)}" +
    "#casino-section .up{color:var(--green)}#casino-section .down{color:var(--red-bright,#e05555)}" +
    "#casino-section .grid-2>*,#casino-section .panel{min-width:0}";
  document.head.appendChild(style);

  var GAME = { blackjack: "Blackjack", roulette: "Roulette", lizards: "Lizard Races" };
  function gameName(g) { return GAME[g] || g || "Other"; }
  function money(cp) {
    cp = Math.abs(Math.round(Number(cp) || 0));
    var gp = Math.floor(cp / 100), sp = Math.floor((cp % 100) / 10), c = cp % 10, out = [];
    if (gp) out.push(gp.toLocaleString() + " gp");
    if (sp) out.push(sp + " sp");
    if (c) out.push(c + " cp");
    return out.join(" ") || "0 gp";
  }
  function signed(cp) { return (cp > 0 ? "+" : cp < 0 ? "−" : "±") + money(cp); }
  function updown(cp) { return '<span class="' + (cp > 0 ? "up" : cp < 0 ? "down" : "dim") + '">' + signed(cp) + "</span>"; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function when(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function card(label, value, sub, cls) {
    return '<div class="stat-card"><div class="label">' + label + '</div><div class="value ' + (cls || "") + '" title="' + esc(value) + '">' + esc(value) + "</div>" +
      (sub ? '<div class="sub">' + esc(sub) + "</div>" : "") + "</div>";
  }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }

  var renderToken = 0;

  async function renderCasino() {
    var token = ++renderToken;
    var content = document.getElementById("content");
    if (!content) return;
    var session = document.getElementById("session-select").value;
    var parts = [];
    if (session !== "all") parts.push("session=" + encodeURIComponent(session));
    if (hiddenNames.length) parts.push("exclude=" + encodeURIComponent(hiddenNames.join(",")));
    if (hiddenWorlds.length) parts.push("excludeWorlds=" + encodeURIComponent(hiddenWorlds.join(",")));
    var data;
    try { data = await apiFetch("/casino-stats" + (parts.length ? "?" + parts.join("&") : "")); }
    catch (e) { console.warn("casino.js: could not load casino stats", e); return; }
    if (token !== renderToken) return;

    document.getElementById("casino-section")?.remove();
    var section = document.createElement("div");
    section.id = "casino-section";
    var byActor = keepPCsOnly(data.byActor), byGame = data.byGame || [], recent = keepPCsOnly(data.recent);
    var html = '<div class="section-title">Casino</div>';

    if (!byActor.length) {
      section.innerHTML = html + '<div class="panel"><div class="no-data">No casino rounds for this selection.</div></div>';
      return place(section);
    }

    var rounds = 0, wagered = 0, net = 0, best = null;
    byActor.forEach(function (a) {
      rounds += a.rounds; wagered += a.wagered_cp; net += a.net_cp;
      if (!best || a.best_cp > best.best_cp) best = a;
    });
    var sorted = byActor.slice().sort(function (x, y) { return y.net_cp - x.net_cp; });
    var lucky = sorted[0], unlucky = sorted[sorted.length - 1];
    var highRoller = byActor.slice().sort(function (x, y) { return y.wagered_cp - x.wagered_cp; })[0];
    var popular = byGame[0];

    html += '<div class="overview">' +
      card("Rounds Played", rounds, popular ? "most played: " + gameName(popular.game) : "") +
      card("Gold Wagered", money(wagered), "high roller: " + highRoller.actor_name + " (" + money(highRoller.wagered_cp) + ")", "gold small") +
      card(net <= 0 ? "The House Is Up" : "The House Is Down", money(net), net <= 0 ? "the party has lost " + money(net) : "the party has won " + money(net), "small") +
      card("Luckiest", lucky.net_cp > 0 ? lucky.actor_name : "—", lucky.net_cp > 0 ? signed(lucky.net_cp) + " overall" : "nobody's ahead", "small") +
      card("Unluckiest", unlucky.net_cp < 0 ? unlucky.actor_name : "—", unlucky.net_cp < 0 ? signed(unlucky.net_cp) + " overall" : "nobody's behind", "small") +
      card("Biggest Win", best && best.best_cp > 0 ? signed(best.best_cp) : "—", best && best.best_cp > 0 ? best.actor_name + " in one round" : "", "gold small") +
      "</div>";

    html += '<div class="grid-2"><div class="panel"><h2>Won &amp; Lost by Player</h2><div class="chart-container"><canvas id="casinoNetChart"></canvas></div></div>' +
      '<div class="panel"><h2>Rounds by Game</h2><div class="chart-container"><canvas id="casinoGameChart"></canvas></div></div></div>';

    html += '<div class="panel"><h2>Gamblers</h2><div class="table-scroll"><table><thead><tr><th>Name</th><th class="num">Rounds</th><th class="num">Won</th><th class="num">Wagered</th><th class="num">Up / Down</th><th class="num">Best Round</th><th class="num">Worst Round</th><th>Favourite Game</th></tr></thead><tbody>';
    byActor.forEach(function (a) {
      html += '<tr><td class="name">' + esc(a.actor_name) + '</td><td class="num">' + a.rounds + '</td><td class="num">' + a.wins +
        ' <span class="dim">(' + Math.round(100 * a.wins / Math.max(1, a.rounds)) + '%)</span></td><td class="num">' + money(a.wagered_cp) +
        '</td><td class="num highlight">' + updown(a.net_cp) + '</td><td class="num">' + (a.best_cp > 0 ? updown(a.best_cp) : "—") +
        '</td><td class="num">' + (a.worst_cp < 0 ? updown(a.worst_cp) : "—") + "</td><td>" + esc(gameName(a.favourite_game)) + "</td></tr>";
    });
    html += "</tbody></table></div></div>";

    html += '<div class="grid-2"><div class="panel"><h2>By Game</h2><div class="table-scroll"><table><thead><tr><th>Game</th><th class="num">Rounds</th><th class="num">Wagered</th><th class="num">Players Up / Down</th></tr></thead><tbody>';
    byGame.forEach(function (g) {
      html += "<tr><td>" + esc(gameName(g.game)) + '</td><td class="num">' + g.rounds + '</td><td class="num">' + money(g.wagered_cp) + '</td><td class="num highlight">' + updown(g.net_cp) + "</td></tr>";
    });
    html += '</tbody></table></div></div><div class="panel"><h2>Recent Rounds</h2><div class="table-scroll"><table><thead><tr><th>When</th><th>Who</th><th>Game</th><th class="num">Staked</th><th class="num">Result</th></tr></thead><tbody>';
    recent.forEach(function (r) {
      html += '<tr><td class="dim">' + when(r.occurred_at) + "</td><td>" + esc(r.actor_name) + "</td><td>" + esc(gameName(r.game)) +
        '</td><td class="num">' + money(r.wagered_cp) + '</td><td class="num">' + updown(r.net_cp) + "</td></tr>";
    });
    html += "</tbody></table></div></div></div>";
    section.innerHTML = html;
    place(section);

    var C = typeof COLORS !== "undefined" ? COLORS : ["#c9a84c", "#e05555", "#4a7ab3", "#3ab34a", "#8a4ab3"];
    new Chart(document.getElementById("casinoNetChart"), {
      type: "bar",
      data: { labels: byActor.map(function (a) { return a.actor_name; }),
        datasets: [{ label: "Up / down", data: byActor.map(function (a) { return a.net_cp / 100; }),
          backgroundColor: byActor.map(function (a) { return a.net_cp >= 0 ? "rgba(58,179,74,.45)" : "rgba(224,85,85,.45)"; }),
          borderColor: byActor.map(function (a) { return a.net_cp >= 0 ? "#3ab34a" : "#e05555"; }), borderWidth: 1 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (ctx) { var a = byActor[ctx.dataIndex];
          return signed(a.net_cp) + " over " + plural(a.rounds, "round") + " (" + money(a.wagered_cp) + " wagered)"; } } } },
        scales: { y: { grid: { color: "#1a1a28" }, ticks: { callback: function (v) { return v + " gp"; } } }, x: { grid: { display: false } } } },
    });
    new Chart(document.getElementById("casinoGameChart"), {
      type: "doughnut",
      data: { labels: byGame.map(function (g) { return gameName(g.game); }),
        datasets: [{ data: byGame.map(function (g) { return g.rounds; }),
          backgroundColor: byGame.map(function (_, i) { return C[i % C.length] + "cc"; }), borderColor: "#0a0a0f", borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "right", labels: { padding: 12, usePointStyle: true, pointStyle: "rectRounded" } },
          tooltip: { callbacks: { label: function (ctx) { var g = byGame[ctx.dataIndex];
            return gameName(g.game) + ": " + plural(g.rounds, "round") + ", " + money(g.wagered_cp) + " wagered, players " + signed(g.net_cp); } } } } },
    });
  }

  // Keep the Casino section after Shops, whichever finishes loading first
  function place(section) {
    var content = document.getElementById("content");
    var shops = document.getElementById("shop-section");
    if (shops && shops.parentNode === content) content.insertBefore(section, shops.nextSibling);
    else content.appendChild(section);
  }
  new MutationObserver(function () {
    var content = document.getElementById("content");
    var shops = document.getElementById("shop-section"), casino = document.getElementById("casino-section");
    if (content && shops && casino && shops.parentNode === content && casino.parentNode === content &&
        (shops.compareDocumentPosition(casino) & Node.DOCUMENT_POSITION_PRECEDING)) {
      content.insertBefore(casino, shops.nextSibling);
    }
  }).observe(document.body, { childList: true, subtree: true });

  var original = loadDashboard;
  loadDashboard = async function () {
    var result = await original.apply(this, arguments);
    renderCasino();
    return result;
  };
})();
