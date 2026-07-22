/*
  traces — photo-particles

  The captured PHOTO itself becomes the loading animation: the picture is
  sampled into a few thousand coloured particles that start scattered and
  drifting, and assemble into the image as progress climbs — so what builds
  on screen during a wait is the person's own object, never a generic
  spinner. Driven by a real progress number (Tripo's reconstruction %) or,
  when none exists, by time.

  usage:
    mountPhotoParticles(container, imageSrc).then(function (pp) {
      pp.setProgress(0.4);  // 0..1 — how assembled the picture is
      pp.dispose();
    });
*/

export function mountPhotoParticles(container, imageSrc, opts) {
  opts = opts || {};
  var GRID = opts.grid || 130; // particles across the longer image side

  return loadImage(imageSrc).then(function (img) {
    var canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    container.appendChild(canvas);
    var ctx = canvas.getContext("2d");

    // sample the photo into a grid of coloured points
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    var longSide = Math.max(iw, ih);
    var cell = longSide / GRID;
    var gw = Math.max(2, Math.round(iw / cell)), gh = Math.max(2, Math.round(ih / cell));
    var s = document.createElement("canvas");
    s.width = gw; s.height = gh;
    var sctx = s.getContext("2d");
    sctx.drawImage(img, 0, 0, gw, gh);
    var px = sctx.getImageData(0, 0, gw, gh).data;

    var parts = [];
    for (var y = 0; y < gh; y++) {
      for (var x = 0; x < gw; x++) {
        var o = (y * gw + x) * 4;
        if (px[o + 3] < 24) continue; // transparent corner of a cut-out
        parts.push({
          tx: (x + 0.5) / gw, ty: (y + 0.5) / gh, // target, image-relative
          r: px[o], g: px[o + 1], b: px[o + 2],
          // scattered start + its own drift personality
          sx: Math.random(), sy: Math.random(),
          ph: Math.random() * Math.PI * 2,
          sp: 0.5 + Math.random(), // drift speed factor
          dl: Math.random() * 0.25, // per-particle assembly delay (stagger)
        });
      }
    }

    var progress = 0;
    var raf = null;
    var disposed = false;
    var t0 = performance.now();

    function frame(now) {
      if (disposed) return;
      var w = container.clientWidth, h = container.clientHeight;
      var dpr = Math.min(window.devicePixelRatio || 1, 1.6);
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // fit the image area inside the container, centred, with margin
      var fit = Math.min((w * 0.8) / iw, (h * 0.8) / ih);
      var dw = iw * fit, dh = ih * fit;
      var ox = (w - dw) / 2, oy = (h - dh) / 2;

      var t = (now - t0) / 1000;
      var dotBase = Math.max(1.6, cell * fit);
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        // each particle starts assembling after its own small delay, so the
        // picture condenses organically instead of snapping as one sheet
        var lp = Math.max(0, Math.min(1, (progress - p.dl) / (1 - p.dl)));
        var e = lp * lp * (3 - 2 * lp); // smoothstep
        // scattered position keeps drifting; the drift dies as it locks in
        var wob = (1 - e);
        var dx = p.sx * w + Math.sin(t * p.sp + p.ph) * 30 * wob;
        var dy = p.sy * h + Math.cos(t * p.sp * 0.8 + p.ph) * 24 * wob;
        var X = dx + (ox + p.tx * dw - dx) * e;
        var Y = dy + (oy + p.ty * dh - dy) * e;
        // brighter and small while adrift (visible over the dark bg even
        // for a dark photo); true colour at full size once placed, sized to
        // its grid cell so the finished picture reads continuous
        var lift = Math.round(70 * (1 - e));
        ctx.globalAlpha = 0.55 + 0.45 * e;
        ctx.fillStyle = "rgb(" + Math.min(255, p.r + lift) + "," + Math.min(255, p.g + lift) + "," + Math.min(255, p.b + lift) + ")";
        var sz = dotBase * (0.4 + 0.65 * e);
        ctx.fillRect(X - sz / 2, Y - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return {
      setProgress: function (p) { progress = Math.max(progress, Math.max(0, Math.min(1, p))); },
      dispose: function () {
        disposed = true;
        if (raf) cancelAnimationFrame(raf);
        canvas.remove();
      },
    };
  });
}

function loadImage(src) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function () { resolve(img); };
    img.onerror = reject;
    img.src = src;
  });
}
