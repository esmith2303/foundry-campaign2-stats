/*
 * "Avg Init" column in the Character Statistics table: each character's
 * average initiative result (initiative is rolled every round in this game).
 *
 * Install: copy next to index.html (/var/www/dashboard/initiative.js) and add
 * one line after the other add-on scripts:   <script src="initiative.js"></script>
 */
(function () {
  if (typeof loadDashboard !== "function") return console.warn("initiative.js: load it after the dashboard script");

  var renderToken = 0;
  async function addColumn() {
    var token = ++renderToken;
    var session = document.getElementById("session-select").value;
    var parts = [];
    if (session !== "all") parts.push("session=" + encodeURIComponent(session));
    if (hiddenNames.length) parts.push("exclude=" + encodeURIComponent(hiddenNames.join(",")));
    if (hiddenWorlds.length) parts.push("excludeWorlds=" + encodeURIComponent(hiddenWorlds.join(",")));
    var rows;
    try { rows = keepPCsOnly(await apiFetch("/initiative" + (parts.length ? "?" + parts.join("&") : ""))); }
    catch (e) { console.warn("initiative.js: could not load initiative", e); return; }
    if (token !== renderToken) return;

    // The table whose panel heading is "Character Statistics"
    var table = null;
    document.querySelectorAll("#content .panel").forEach(function (p) {
      var h = p.querySelector("h2");
      if (!table && h && /character statistics/i.test(h.textContent)) table = p.querySelector("table");
    });
    if (!table || table.querySelector("th.avg-init")) return;
    var byName = {};
    rows.forEach(function (r) { byName[r.actor_name] = r; });

    var th = document.createElement("th");
    th.className = "num avg-init";
    th.title = "Average initiative result";
    th.textContent = "Avg Init";
    table.querySelector("thead tr").appendChild(th);
    table.querySelectorAll("tbody tr").forEach(function (tr) {
      var name = tr.querySelector("td.name");
      var r = name && byName[name.textContent];
      var td = document.createElement("td");
      td.className = "num";
      td.textContent = r ? r.avg.toFixed(1) : "—";
      tr.appendChild(td);
    });
  }

  var original = loadDashboard;
  loadDashboard = async function () {
    var result = await original.apply(this, arguments);
    addColumn();
    return result;
  };
})();
