/*
  traces — animated film grain
  A faint monochrome grain flickers across the whole interface, giving the
  cream surfaces the living, analog "paper under light" quality from the
  reference. The grain is regenerated a few times a second (not every
  frame) so it reads as a gentle flicker rather than harsh TV static.

  Include on every screen: <script src="js/grain.js" defer></script>
  Honours prefers-reduced-motion (renders one static grain, no flicker).
*/

(function () {
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var view = document.createElement("canvas");
  view.className = "grain-overlay";
  view.setAttribute("aria-hidden", "true");

  function mount() {
    (document.body || document.documentElement).appendChild(view);
    start();
  }

  var vctx = view.getContext("2d");

  // small noise buffer, scaled up over the viewport for a soft, filmic grain
  var noise = document.createElement("canvas");
  noise.width = 140;
  noise.height = 80;
  var nctx = noise.getContext("2d");

  function drawNoise() {
    var img = nctx.createImageData(noise.width, noise.height);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var v = 120 + Math.random() * 135; // light-ish grey specks
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = Math.random() * 255; // varied alpha = uneven grain
    }
    nctx.putImageData(img, 0, 0);
  }

  function paint() {
    view.width = Math.ceil(window.innerWidth / 2);
    view.height = Math.ceil(window.innerHeight / 2);
    drawNoise();
    vctx.clearRect(0, 0, view.width, view.height);
    // random sub-pixel offset each redraw adds to the flicker
    var ox = (Math.random() * 12 - 6) | 0;
    var oy = (Math.random() * 12 - 6) | 0;
    vctx.drawImage(noise, ox, oy, view.width + 12, view.height + 12);
  }

  var last = 0;
  var INTERVAL = 90; // ms between grain redraws (~11 fps flicker)

  function start() {
    if (reduce) { paint(); return; }
    (function loop(t) {
      if (!view.isConnected) return;
      if (t - last > INTERVAL) { paint(); last = t; }
      requestAnimationFrame(loop);
    })(0);
  }

  window.addEventListener("resize", function () { if (!reduce) paint(); });

  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount);
})();
