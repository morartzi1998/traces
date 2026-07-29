/*
  traces — owner-device flag
  The shared "archive" scope in the Cloudflare Worker store is one global
  pool with no per-visitor accounts — it exists only so Mor's own phone and
  computer see the same captures. Visiting once with ?owner=1 marks THIS
  browser as one of her own devices; every other visitor's gallery/object
  screen neither pulls from nor pushes into that shared pool, so a
  stranger's archive stays their own instead of showing her real captures.
  ?owner=0 clears it again — e.g. to preview the site as a regular visitor
  would see it, without needing a separate incognito window.
  Loaded without "defer" (unlike flow.js) so window.isOwnerDevice() is
  already defined by the time each page's own inline script runs.
*/
(function () {
  try {
    var flag = new URLSearchParams(window.location.search).get("owner");
    if (flag === "1") {
      localStorage.setItem("traces-owner-device", "1");
    } else if (flag === "0") {
      localStorage.removeItem("traces-owner-device");
    }
  } catch (e) {}
})();

window.isOwnerDevice = function () {
  try { return localStorage.getItem("traces-owner-device") === "1"; } catch (e) { return false; }
};

/*
  Exhibition "kiosk mode": ?kiosk=1 marks THIS browser as an exhibition kiosk.
  Its only effect is that whatever visitors save to the local archive gets
  uploaded to the shared store (the archive-page sync, normally owner-only),
  so the owner can watch it in the private live log alongside community shares.
  It deliberately does NOT set the owner flag, so there is no owner UI at all —
  no edit menus, no "my device" badge — the community stays locked to editing
  and the visitor experience is untouched. Opt-in and dormant otherwise:
  nothing changes unless a device is explicitly opened with ?kiosk=1.
  ?kiosk=0 clears it again.
*/
(function () {
  try {
    var kflag = new URLSearchParams(window.location.search).get("kiosk");
    if (kflag === "1") {
      localStorage.setItem("traces-kiosk", "1");
    } else if (kflag === "0") {
      localStorage.removeItem("traces-kiosk");
    }
  } catch (e) {}
})();

window.isKioskDevice = function () {
  try { return localStorage.getItem("traces-kiosk") === "1"; } catch (e) { return false; }
};

/*
  A one-off, owner-facing confirmation shown ONLY at setup time — i.e. only when
  the URL actually carries ?kiosk=1 or ?kiosk=0. It lets Mor SEE that the flag
  took hold, without opening dev tools. It never appears during normal visitor
  use, because the parameter is only ever in the URL when she deliberately sets
  it (an idle reset navigates to a bare index.html, no parameter, no message).
*/
(function () {
  try {
    var k = new URLSearchParams(window.location.search).get("kiosk");
    if (k !== "1" && k !== "0") return;
    var msg = k === "1"
      ? "Kiosk mode ON — this device now reports archive saves to your live log."
      : "Kiosk mode OFF — this device no longer reports to your log.";
    var show = function () {
      if (!document.body) return;
      var t = document.createElement("div");
      t.textContent = msg;
      t.setAttribute("role", "status");
      t.style.cssText =
        "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;" +
        "max-width:90vw;padding:13px 20px;border-radius:8px;background:rgba(20,18,16,0.94);" +
        "color:#f0eeea;font:14px/1.45 system-ui,sans-serif;letter-spacing:.01em;text-align:center;" +
        "box-shadow:0 8px 30px rgba(0,0,0,0.5);transition:opacity .45s ease;";
      document.body.appendChild(t);
      setTimeout(function () { t.style.opacity = "0"; }, 5200);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 5800);
    };
    if (document.body) show();
    else document.addEventListener("DOMContentLoaded", show);
  } catch (e) {}
})();

// a tiny, easy-to-spot way to confirm (without opening dev tools) whether
// THIS particular browser is currently flagged as one of Mor's own devices
// - only ever shown when true, so a regular visitor never sees it at all
if (window.isOwnerDevice()) {
  document.addEventListener("DOMContentLoaded", function () {
    var badge = document.createElement("div");
    badge.textContent = "מכשיר שלי מחובר";
    // every screen corner is already taken by a nav-corner link (logo,
    // Archive, Community, About), and the vertical-middle-left spot this
    // used to sit in turned out to collide with object.html's capture
    // timeline (which can occupy a good chunk of that side on a phone) -
    // bottom-center is clear of all of those on every screen
    badge.style.cssText =
      "position:fixed;bottom:6px;left:50%;transform:translateX(-50%);z-index:99999;" +
      "font-size:10px;opacity:0.45;color:#fff;" +
      "font-family:sans-serif;pointer-events:none;white-space:nowrap;";
    document.body.appendChild(badge);
  });
}
