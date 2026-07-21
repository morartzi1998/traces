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
