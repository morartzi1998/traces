/*
  traces — background flicker
  A very faint fine-pixel grain sits over the whole interface and gently
  flickers, giving the background a quiet analog shimmer. Deliberately
  subtle: small crisp pixels, low alpha, soft-light blend, with a slow
  breathing opacity. Honours prefers-reduced-motion (one still layer).

  Include on every screen: <script src="js/grain.js" defer></script>
*/

(function () {
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var view = document.createElement("canvas");
  view.className = "grain-overlay";
  view.setAttribute("aria-hidden", "true");
  var vctx = view.getContext("2d");

  function paint() {
    // backing store at ~half viewport → crisp small pixels once CSS-scaled
    view.width = Math.ceil(window.innerWidth / 2);
    view.height = Math.ceil(window.innerHeight / 2);
    var img = vctx.createImageData(view.width, view.height);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var v = 110 + Math.random() * 60; // low-contrast grey
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = Math.random() * 70;    // sparse, faint specks
    }
    vctx.putImageData(img, 0, 0);
  }

  var last = 0;
  var INTERVAL = 120; // ms between redraws (~8 fps quiet flicker)

  function start() {
    if (reduce) { paint(); return; }
    (function loop(t) {
      if (!view.isConnected) return;
      if (t - last > INTERVAL) { paint(); last = t; }
      requestAnimationFrame(loop);
    })(0);
  }

  function mount() {
    (document.body || document.documentElement).appendChild(view);
    start();
  }

  window.addEventListener("resize", function () { if (!reduce) paint(); });

  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount);
})();
