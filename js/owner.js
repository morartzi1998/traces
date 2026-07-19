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
