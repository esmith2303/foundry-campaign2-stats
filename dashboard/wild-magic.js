/*
 * "Unicorns Summoned" card in the stats row at the top of the dashboard
 * (from wild magic surges in the chat log).
 *
 * Install: copy next to index.html (/var/www/dashboard/wild-magic.js) and add
 * one line after the other add-on scripts:   <script src="wild-magic.js"></script>
 */
(function () {
  if (typeof loadDashboard !== "function") return console.warn("wild-magic.js: load it after the dashboard script");

  var style = document.createElement("style");
  style.textContent =
    ".stat-card.unicorn-card .value{display:flex;align-items:center;gap:.5rem}" +
    ".stat-card.unicorn-card svg{width:1.7rem;height:1.7rem;fill:var(--gold);flex:none}";
  document.head.appendChild(style);

  // A small horn, so the card stands out a little
  var HORN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 15.5 21.5 2.5 8.5 20.5Z"/><g fill="none" stroke="var(--bg2)" stroke-width="1.1" stroke-linecap="round"><path d="M8 12 11.1 16.9"/><path d="M11.9 9.2 13.95 12.95"/><path d="M15.4 6.7 16.55 9.35"/><path d="M18.5 4.5 18.9 6.1"/></g></svg>';

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  var renderToken = 0;
  async function renderUnicorns() {
    var token = ++renderToken;
    var session = document.getElementById("session-select").value;
    var parts = [];
    if (session !== "all") parts.push("session=" + encodeURIComponent(session));
    if (hiddenNames.length) parts.push("exclude=" + encodeURIComponent(hiddenNames.join(",")));
    if (hiddenWorlds.length) parts.push("excludeWorlds=" + encodeURIComponent(hiddenWorlds.join(",")));
    var rows;
    try { rows = keepPCsOnly(await apiFetch("/wild-magic" + (parts.length ? "?" + parts.join("&") : ""))); }
    catch (e) { console.warn("wild-magic.js: could not load wild magic stats", e); return; }
    if (token !== renderToken) return;

    var overview = document.querySelector("#content > .overview");
    if (!overview) return;
    var old = overview.querySelector(".unicorn-card");
    if (old) old.remove();

    var unicorns = 0, surges = 0, top = null;
    rows.forEach(function (r) {
      unicorns += r.unicorns; surges += r.surges;
      if (r.unicorns && (!top || r.unicorns > top.unicorns)) top = r;
    });
    var sub = surges
      ? (top && top.unicorns === unicorns ? esc(top.actor_name) + " · " : "") + surges + " wild magic surge" + (surges === 1 ? "" : "s")
      : "No wild magic surges";
    var card = document.createElement("div");
    card.className = "stat-card unicorn-card";
    card.innerHTML = '<div class="label">Unicorns Summoned</div><div class="value gold">' + HORN + unicorns + '</div><div class="sub">' + sub + "</div>";
    overview.appendChild(card);
  }

  var original = loadDashboard;
  loadDashboard = async function () {
    var result = await original.apply(this, arguments);
    renderUnicorns();
    return result;
  };
})();
