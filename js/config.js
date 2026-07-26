/*
  traces — runtime config

  Set TRACES_API to your deployed Tripo worker URL to turn on real 3D
  reconstruction (upload a photo -> get a GLB). Leave it empty ("") and the
  capture flow runs in its simulated form instead.

  Example: window.TRACES_API = "https://traces-tripo.yourname.workers.dev";
*/
window.TRACES_API = "https://traces-tripo.traces-morartzi.workers.dev";

/*
  Auto-refresh to the newest deploy.

  Every screen's SAVE/EDIT logic lives in inline <script> inside its .html
  file. A ?v= query busts the cached .css/.js, but it can't bust the HTML
  itself — and GitHub Pages serves HTML with a ~10-minute cache, so a phone
  (especially an in-app browser like WhatsApp's) can keep running an old
  page's old logic well after a fix ships. That's what made edits "not
  update": the device was still running yesterday's page.

  This compares the version baked into THIS page (read off the ?v= on its own
  stylesheet link) against the live version.txt, and if they differ, reloads
  the page once through a cache-busting URL so the fresh HTML is actually
  fetched. A per-page, per-version sessionStorage guard means it can reload at
  most once for any given page+version — it can never loop, even if a stale
  copy somehow came back.
*/
(function autoRefresh() {
  try {
    var link = document.querySelector('link[rel="stylesheet"][href*="?v="]');
    if (!link) return;
    var built = (link.getAttribute("href").split("?v=")[1] || "").split("&")[0];
    if (!built) return;
    // version.txt sits at the site root; screens/*.html reach it one level up
    var vtUrl = (/\/screens\//.test(location.pathname) ? "../" : "") + "version.txt";
    fetch(vtUrl + "?_=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) {
        if (!text) return;
        var live = text.trim();
        if (!live || live === built) return;
        var flag = "traces-fresh:" + location.pathname + ":" + live;
        if (sessionStorage.getItem(flag)) return; // already refreshed this page for this version
        sessionStorage.setItem(flag, "1");
        var base = location.href.split("#")[0].split("?")[0];
        location.replace(base + "?b=" + encodeURIComponent(live));
      })
      .catch(function () {});
  } catch (e) {}
})();
