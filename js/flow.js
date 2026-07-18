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
  try { sessionStorage.setItem("traces-item", item); } catch (e) {}
  goTo(target || "object.html");
}

/* screens/* pages link between siblings; the root page needs the prefix */
function locationPrefix() {
  return window.location.pathname.indexOf("/screens/") === -1 && !window.__artifactGo
    ? "screens/" : "";
}
