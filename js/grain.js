/*
  traces — background flicker
  A very faint, low-contrast noise sits over the whole interface and
  gently flickers, giving the background a living, analog shimmer. It is
  deliberately subtle: a soft-light blend at low opacity whose strength
  also breathes over time, so it reads as a quiet flicker rather than
  visible static. Honours prefers-reduced-motion (one static, still layer).

  Include on every screen: <script src="js/grain.js" defer></script>
*/

(function () {
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var view = document.createElement("canvas");
  view.className = "grain-overlay";
  view.setAttribute("aria-hidden", "true");
  var vctx = view.getContext("2d");

  // small noise buffer, softly scaled up over the viewport
  var noise = document.createElement("canvas");
  noise.width = 90;
  noise.height = 52;
  var nctx = noise.getContext("2d");

  function drawNoise() {
    var img = nctx.createImageData(noise.width, noise.height);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      // low-contrast grey clustered around mid so soft-light barely nudges
      var v = 118 + Math.random() * 40;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 40 + Math.random() * 90;
    }
    nctx.putImageData(img, 0, 0);
  }

  function paint() {
    view.width = Math.ceil(window.innerWidth / 2);
    view.height = Math.ceil(window.innerHeight / 2);
    drawNoise();
    vctx.clearRect(0, 0, view.width, view.height);
    var ox = (Math.random() * 10 - 5) | 0;
    var oy = (Math.random() * 10 - 5) | 0;
    vctx.drawImage(noise, ox, oy, view.width + 10, view.height + 10);
  }

  var last = 0;
  var INTERVAL = 130; // ms between redraws (~7-8 fps: a quiet flicker, not static)

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
