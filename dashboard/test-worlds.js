/*
 * Test-world characters for the stats dashboard.
 *
 * The dashboard only shows the four campaign PCs (ALLOWED_PC_NAMES). This also
 * lets in every player character from worlds whose world ID has "test" in it,
 * so test characters show up when you look at a test world. They're listed in
 * Manage Names with a TEST tag and can be hidden like any other name.
 *
 * Install: copy next to index.html and add, before </body> (after the
 * dashboard's own script):   <script src="test-worlds.js"></script>
 */
(function () {
  if (typeof ALLOWED_PC_NAMES === "undefined" || typeof loadDashboard !== "function") {
    return console.warn("test-worlds.js: load it after the dashboard script");
  }
  var added = new Set();       // names we let in (never the real four)
  var fetched = null;

  function loadTestNames(force) {
    if (!fetched || force) {
      fetched = apiFetch("/names?testWorlds=1")
        .then(function (names) {
          (Array.isArray(names) ? names : []).forEach(function (n) {
            if (n && !ALLOWED_PC_NAMES.has(n)) { ALLOWED_PC_NAMES.add(n); added.add(n); }
          });
        })
        .catch(function (e) { console.warn("test-worlds.js: could not load test-world names", e); });
    }
    return fetched;
  }

  // Names must be in before the dashboard filters anything
  var originalLoad = loadDashboard;
  loadDashboard = async function () {
    await loadTestNames(false);
    return originalLoad.apply(this, arguments);
  };

  var badge = '<span style="background:#e05555;color:#fff;font-family:var(--font-mono);font-size:.55rem;padding:1px 5px;border-radius:2px;margin-left:.4rem;letter-spacing:.05em">TEST</span>';
  var originalModal = showManageModal;
  showManageModal = async function () {
    await loadTestNames(true);   // pick up test characters uploaded since the page loaded
    await originalModal.apply(this, arguments);
    document.querySelectorAll("#name-list .name-row .name-label").forEach(function (label) {
      if (added.has(label.textContent.trim())) label.insertAdjacentHTML("beforeend", badge);
    });
  };
})();
