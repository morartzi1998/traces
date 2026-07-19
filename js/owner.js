/*
  traces — owner-device flag
  The shared "archive" scope in the Cloudflare Worker store is one global
  pool with no per-visitor accounts — it exists only so Mor's own phone and
  computer see the same captures. Visiting once with ?owner=1 marks THIS
  browser as one of her own devices; every other visitor's gallery/object
  screen neither pulls from nor pushes into that shared pool, so a
  stranger's archive stays their own instead of showing her real captures.
  Loaded without "defer" (unlike flow.js) so window.isOwnerDevice() is
  already defined by the time each page's own inline script runs.
*/
(function () {
  try {
    if (new URLSearchParams(window.location.search).get("owner") === "1") {
      localStorage.setItem("traces-owner-device", "1");
    }
  } catch (e) {}
})();

window.isOwnerDevice = function () {
  try { return localStorage.getItem("traces-owner-device") === "1"; } catch (e) { return false; }
};
