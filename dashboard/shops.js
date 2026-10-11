/*
 * Shops section for the stats dashboard.
 *
 * Install: copy this file next to the dashboard's index.html
 * (/var/www/dashboard/shops.js) and add one line after the dashboard's main
 * <script> block, just before </body>:
 *
 *     <script src="shops.js"></script>
 *
 * It reuses the dashboard's own globals (apiFetch, keepPCsOnly, hiddenNames,
 * hiddenWorlds, COLORS, Chart) and adds a "Shops" panel at the bottom every
 * time the dashboard loads, for the selected session or lifetime.
 */
(function () {
  if (typeof loadDashboard !== "function") return console.warn("shops.js: load it after the dashboard script");

  var style = document.createElement("style");
  style.textContent =
    "#shop-section{margin-bottom:3rem}" +
    "#shop-section .section-title{font-family:var(--font-display);font-size:1.1rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold);margin:0 0 1.2rem;display:flex;align-items:center;gap:.6rem}" +
    "#shop-section .section-title::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--gold-dim),transparent)}" +
    "#shop-section .stat-card .value.small{font-size:1.15rem;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    "#shop-section .panel{margin-bottom:2rem}" +
    "#shop-section td .dim{color:var(--text-dim)}" +
    "#shop-section td .was{color:var(--red-bright);text-decoration:line-through;margin-right:.35rem}" +
    "#shop-section .table-scroll{overflow-x:auto}" +
    "#shop-section td .sold{color:var(--green)}" +
    "#shop-section .tag-sold{font-family:var(--font-mono);font-size:.6rem;letter-spacing:.06em;text-transform:uppercase;color:var(--green);border:1px solid rgba(58,179,74,.4);border-radius:2px;padding:0 .3rem;margin-left:.35rem}" +
    "#shop-section .grid-2>*,#shop-section .panel{min-width:0}";
  document.head.appendChild(style);

  // 1234 cp → "12 gp 3 sp 4 cp" (thousands separated)
  function money(cp) {
    cp = Math.max(0, Math.round(Number(cp) || 0));
    var gp = Math.floor(cp / 100), sp = Math.floor((cp % 100) / 10), c = cp % 10, out = [];
    if (gp) out.push(gp.toLocaleString() + " gp");
    if (sp) out.push(sp + " sp");
    if (c) out.push(c + " cp");
    return out.join(" ") || "0 gp";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  // "Shop Name (Shop Owner)", or just the name
  function shopName(name, owner) {
    name = name || "Shop";
    return owner ? name + " (" + owner + ")" : name;
  }
  function when(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function price(r) {
    var was = r.list_cp != null && r.list_cp !== r.unit_cp ? '<span class="was" title="Shop price">' + money(r.list_cp) + "</span>" : "";
    return was + money(r.unit_cp);
  }
  function card(label, value, sub, cls) {
    return '<div class="stat-card"><div class="label">' + label + '</div><div class="value ' + (cls || "") + '" title="' + esc(value) + '">' + esc(value) + "</div>" +
      (sub ? '<div class="sub">' + esc(sub) + "</div>" : "") + "</div>";
  }

  var renderToken = 0;

  async function renderShops() {
    var token = ++renderToken;
    var content = document.getElementById("content");
    if (!content) return;
    var session = document.getElementById("session-select").value;
    var parts = [];
    if (session !== "all") parts.push("session=" + encodeURIComponent(session));
    if (hiddenNames.length) parts.push("exclude=" + encodeURIComponent(hiddenNames.join(",")));
    if (hiddenWorlds.length) parts.push("excludeWorlds=" + encodeURIComponent(hiddenWorlds.join(",")));
    var data;
    try { data = await apiFetch("/shop-stats" + (parts.length ? "?" + parts.join("&") : "")); }
    catch (e) { console.warn("shops.js: could not load shop stats", e); return; }
    if (token !== renderToken) return;   // a newer load started meanwhile

    document.getElementById("shop-section")?.remove();
    var section = document.createElement("div");
    section.id = "shop-section";

    var byActor = keepPCsOnly(data.byActor), byShop = data.byShop || [];
    var topItems = keepPCsOnly(data.topItems), recent = keepPCsOnly(data.recent);
    var html = '<div class="section-title">Shops</div>';

    if (!byActor.length) {
      section.innerHTML = html + '<div class="panel"><div class="no-data">No shop purchases or sales for this selection.</div></div>';
      content.appendChild(section);
      return;
    }

    var spent = 0, transactions = 0, items = 0, earned = 0, soldItems = 0, sales = 0;
    byActor.forEach(function (a) {
      spent += a.spent_cp; transactions += a.transactions; items += a.items;
      earned += a.earned_cp || 0; soldItems += a.items_sold || 0; sales += a.sales || 0;
    });
    var top = topItems[0], busiest = byShop[0];
    var bigSpender = byActor.slice().sort(function (x, y) { return y.spent_cp - x.spent_cp; })[0];
    var plural = function (n, w) { return n + " " + w + (n === 1 ? "" : "s"); };

    html += '<div class="overview">' +
      card("Gold Spent", money(spent), "across " + byShop.length + " shop" + (byShop.length === 1 ? "" : "s"), "gold small") +
      card("Purchases", transactions, plural(items, "item") + " bought") +
      card("Gold Earned", money(earned), sales ? plural(soldItems, "item") + " sold in " + plural(sales, "sale") : "nothing sold yet", "small") +
      card("Biggest Spender", bigSpender.spent_cp ? bigSpender.actor_name : "—", bigSpender.spent_cp ? money(bigSpender.spent_cp) : "", "small") +
      card("Most Expensive Item", top ? top.item_name : "—", top ? money(top.unit_cp) + " · " + top.actor_name : "", "gold small") +
      card("Most Used Shop", busiest ? shopName(busiest.shop_name, busiest.shop_owner) : "—", busiest ? plural(busiest.transactions, "deal") + " · " + money(busiest.spent_cp + (busiest.sold_cp || 0)) + " traded" : "", "small") +
      "</div>";

    html += '<div class="grid-2"><div class="panel"><h2>Gold Spent &amp; Earned by Player</h2><div class="chart-container"><canvas id="shopSpendChart"></canvas></div></div>' +
      '<div class="panel"><h2>Shops by Deals</h2><div class="chart-container"><canvas id="shopShopsChart"></canvas></div></div></div>';

    html += '<div class="panel"><h2>Shoppers</h2><div class="table-scroll"><table><thead><tr><th>Name</th><th class="num">Spent</th><th class="num">Purchases</th><th class="num">Items</th><th class="num">Sold</th><th>Most Expensive</th><th>Favourite Shop</th></tr></thead><tbody>';
    byActor.forEach(function (a) {
      html += '<tr><td class="name">' + esc(a.actor_name) + '</td><td class="num highlight">' + money(a.spent_cp) + '</td><td class="num">' + a.transactions +
        '</td><td class="num">' + a.items + '</td><td class="num">' + (a.earned_cp ? '<span class="sold">' + money(a.earned_cp) + '</span><br><span class="dim">' + plural(a.items_sold, "item") + "</span>" : "—") +
        "</td><td>" + (a.priciest_item ? esc(a.priciest_item) + ' <span class="dim">' + money(a.max_unit_cp) + "</span>" : "—") + "</td><td>" + esc(a.favourite_shop ? shopName(a.favourite_shop, a.favourite_shop_owner) : "—") + "</td></tr>";
    });
    html += "</tbody></table></div></div>";

    html += '<div class="grid-2"><div class="panel"><h2>Most Expensive Items</h2><div class="table-scroll"><table><thead><tr><th>Item</th><th>Buyer</th><th class="num">Price</th></tr></thead><tbody>';
    topItems.forEach(function (r) {
      html += "<tr><td>" + esc(r.item_name) + (r.qty > 1 ? ' <span class="dim">×' + r.qty + "</span>" : "") + '<br><span class="dim">' + esc(shopName(r.shop_name, r.shop_owner)) + "</span></td><td>" + esc(r.actor_name) + '</td><td class="num highlight">' + price(r) + "</td></tr>";
    });
    html += '</tbody></table></div></div><div class="panel"><h2>Recent Deals</h2><div class="table-scroll"><table><thead><tr><th>When</th><th>Who</th><th>Item</th><th class="num">Price</th></tr></thead><tbody>';
    recent.forEach(function (r) {
      var isSale = r.kind === "sell";
      var each = isSale ? (r.qty > 1 ? money(r.unit_cp) + " each" : "") + (r.list_cp ? (r.qty > 1 ? " · " : "") + "value " + money(r.list_cp) : "")
                        : (r.qty > 1 || r.list_cp !== r.unit_cp ? price(r) + " each" : "");
      html += '<tr><td class="dim">' + when(r.occurred_at) + "</td><td>" + esc(r.actor_name) + "</td><td>" + esc(r.item_name) + (r.qty > 1 ? ' <span class="dim">×' + r.qty + "</span>" : "") +
        (isSale ? '<span class="tag-sold">sold</span>' : "") +
        '<br><span class="dim">' + esc(shopName(r.shop_name, r.shop_owner)) + '</span></td><td class="num">' + (isSale ? '<span class="sold">+' + money(r.total_cp) + "</span>" : money(r.total_cp)) +
        (each ? '<br><span class="dim">' + each + "</span>" : "") + "</td></tr>";
    });
    html += "</tbody></table></div></div></div>";

    section.innerHTML = html;
    content.appendChild(section);

    var C = typeof COLORS !== "undefined" ? COLORS : ["#c9a84c", "#e05555", "#4a7ab3", "#3ab34a", "#8a4ab3"];
    new Chart(document.getElementById("shopSpendChart"), {
      type: "bar",
      data: { labels: byActor.map(function (a) { return a.actor_name; }),
        datasets: [
          { label: "Spent", data: byActor.map(function (a) { return a.spent_cp / 100; }),
            backgroundColor: byActor.map(function (_, i) { return C[i % C.length] + "99"; }),
            borderColor: byActor.map(function (_, i) { return C[i % C.length]; }), borderWidth: 1 },
          { label: "Earned selling", data: byActor.map(function (a) { return (a.earned_cp || 0) / 100; }),
            backgroundColor: "rgba(58,179,74,.35)", borderColor: "#3ab34a", borderWidth: 1 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: earned > 0, position: "top", labels: { usePointStyle: true, pointStyle: "rectRounded" } },
          tooltip: { callbacks: { label: function (ctx) { var a = byActor[ctx.dataIndex];
            return ctx.dataset.label + ": " + money(ctx.datasetIndex ? a.earned_cp : a.spent_cp); } } } },
        scales: { y: { grid: { color: "#1a1a28" }, ticks: { callback: function (v) { return v + " gp"; } } }, x: { grid: { display: false } } } },
    });
    new Chart(document.getElementById("shopShopsChart"), {
      type: "doughnut",
      data: { labels: byShop.map(function (s) { return shopName(s.shop_name, s.shop_owner); }),
        datasets: [{ data: byShop.map(function (s) { return s.transactions; }),
          backgroundColor: byShop.map(function (_, i) { return C[i % C.length] + "cc"; }), borderColor: "#0a0a0f", borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "right", labels: { padding: 12, usePointStyle: true, pointStyle: "rectRounded" } },
          tooltip: { callbacks: { label: function (ctx) { var s = byShop[ctx.dataIndex];
            return shopName(s.shop_name, s.shop_owner) + ": " + plural(s.transactions, "deal") + ", " + money(s.spent_cp) + " spent" +
              (s.sold_cp ? ", " + money(s.sold_cp) + " paid out" : "") + ", " + plural(s.buyers, "customer"); } } } } },
    });
  }

  // Run after every dashboard load (session change, hide/show names, refresh…)
  var original = loadDashboard;
  loadDashboard = async function () {
    var result = await original.apply(this, arguments);
    renderShops();
    return result;
  };
})();
