/*
  traces — screen flow helper
  goTo(page) navigates between screens. On the real site this is a normal
  page load; the single-file preview build overrides window.__artifactGo
  to switch sections instead.
*/

function goTo(page) {
  if (window.__artifactGo) {
    window.__artifactGo(page);
  } else if (window.location.hostname === "morartzi1998.github.io") {
    // a plain relative href has, on at least one visitor's machine, ended up
    // resolving to a long-dead custom domain that used to point here instead
    // of the page actually on screen. The current path (not the origin) is
    // what's trustworthy there, so rebuild the target from that plus a
    // hardcoded known-good origin instead of letting the browser resolve the
    // relative href on its own.
    var afterRoot = window.location.pathname.replace(/^.*\/traces\//, "");
    var dir = afterRoot.slice(0, afterRoot.lastIndexOf("/") + 1);
    window.location.href = "https://morartzi1998.github.io/traces/" + dir + page;
  } else {
    window.location.href = page;
  }
}

function openObject(item, target) {
  try {
    sessionStorage.setItem("traces-item", item);
    // opening through the normal path (home, archive, loading) is NOT
    // community browsing — clear any leftover community flag so the object
    // view's prev/next arrows stay within the archive set. community.html
    // sets this flag itself, right before it navigates.
    sessionStorage.removeItem("traces-from-community");
  } catch (e) {}
  goTo(target || "object.html");
}

/* screens/* pages link between siblings; the root page needs the prefix */
function locationPrefix() {
  return window.location.pathname.indexOf("/screens/") === -1 && !window.__artifactGo
    ? "screens/" : "";
}

/*
  Exhibition / kiosk idle reset: after a long stretch with no interaction at
  all, return to the home screen so the next person starts fresh. Any real
  user activity (move, tap, key, scroll) restarts the countdown.

  Skipped on the active capture-work screens (upload / processing /
  describe) - navigating away from those mid-flow would throw away an
  in-progress scan, which is the opposite of helpful.
*/
(function idleReset() {
  var IDLE_MS = 10 * 60 * 1000;
  var path = window.location.pathname;
  var skip = /\/(upload|processing|describe-capture|phone-capture)\.html$/.test(path);
  if (skip || window.__artifactGo) return; // single-file preview has no pages to reset to
  var timer = null;
  function goHome() {
    // an in-flight sync to the shared server (e.g. the heavy timeline
    // re-uploads on the archive) must never be killed by this reset —
    // navigating away silently aborted the transfer every time the tab
    // sat untouched for ten minutes, which is precisely when a long
    // upload is left alone to finish. Wait another round instead.
    if (window.RemoteCaptures && RemoteCaptures.busy && RemoteCaptures.busy()) { reset(); return; }
    goTo(path.indexOf("/screens/") !== -1 ? "../index.html" : "index.html");
  }
  function reset() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(goHome, IDLE_MS);
  }
  ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "wheel", "click"].forEach(function (ev) {
    window.addEventListener(ev, reset, { passive: true });
  });
  reset();
})();

// ----- stale-page detector ---------------------------------------------
// GitHub Pages caches each HTML page for up to ~10 minutes, and a long-lived
// owner tab can keep serving an even older copy — which shows up as "works
// in a private window (always fresh) but not in my normal one". Compare the
// version this page was built with against the tiny always-fresh
// version.txt, and offer a one-tap refresh when they differ.
(function staleCheck() {
  if (window.__artifactGo) return;
  var script = document.querySelector('script[src*="?v="]');
  var m = script && script.src.match(/\?v=([0-9a-z]+)/);
  if (!m) return;
  var mine = m[1];
  var base = window.location.pathname.indexOf("/screens/") !== -1 ? "../" : "";
  function check() {
    fetch(base + "version.txt?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (latest) {
        if (!latest) return;
        latest = latest.trim();
        if (!latest || latest === mine) return;
        if (document.getElementById("staleToast")) return;
        var toast = document.createElement("button");
        toast.id = "staleToast";
        toast.type = "button";
        toast.textContent = "a newer version of traces is ready — tap to refresh";
        toast.style.cssText = "position:fixed;left:50%;bottom:5vh;transform:translateX(-50%);" +
          "z-index:9999;background:#0a25b4;color:#fff;border:none;padding:10px 18px;" +
          "font-family:inherit;font-size:0.85rem;letter-spacing:0.05em;cursor:pointer;" +
          "box-shadow:0 4px 18px rgba(0,0,0,0.35)";
        toast.addEventListener("click", function () { window.location.reload(); });
        document.body.appendChild(toast);
      }).catch(function () {});
  }
  // once shortly after load, then every few minutes for long-lived tabs
  setTimeout(check, 4000);
  setInterval(check, 4 * 60 * 1000);
})();

// ----- fullscreen for exhibition machines ------------------------------
// a quiet corner button that takes the whole site fullscreen (no browser
// tabs). Browser-level fullscreen (F11 on Windows) survives navigation too.
(function fullscreenButton() {
  if (window.__artifactGo) return;
  function mount() {
    if (document.getElementById("fsBtn")) return;
    var btn = document.createElement("button");
    btn.id = "fsBtn";
    btn.type = "button";
    btn.title = "full screen";
    btn.setAttribute("aria-label", "Enter full screen");
    btn.textContent = "⛶";
    btn.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:9998;background:none;" +
      "border:none;color:rgba(240,234,220,0.45);font-size:18px;cursor:pointer;padding:4px;line-height:1";
    btn.addEventListener("click", function () {
      var el = document.documentElement;
      if (el.requestFullscreen) el.requestFullscreen().catch(function () {});
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    });
    function sync() { btn.hidden = !!document.fullscreenElement; }
    document.addEventListener("fullscreenchange", sync);
    sync();
    document.body.appendChild(btn);
  }
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
