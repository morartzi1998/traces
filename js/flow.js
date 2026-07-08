/*
  traces — screen flow helper
  goTo(page) navigates between screens. On the real site this is a normal
  page load; the single-file preview build overrides window.__artifactGo
  to switch sections instead.
*/

function goTo(page) {
  if (window.__artifactGo) {
    window.__artifactGo(page);
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
