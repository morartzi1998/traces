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
        // how far this cell sits from the image centre, normalised so a
        // corner is ~1. An elliptical falloff off this melts the hard
        // rectangular boundary away: cells out toward the edges/corners fade
        // and thin, so the assembled picture reads as an organic living mass
        // of colour, never a photo fenced inside a square.
        var dcx = (x + 0.5) / gw - 0.5, dcy = (y + 0.5) / gh - 0.5;
        var rd = Math.sqrt(dcx * dcx + dcy * dcy) / 0.7071;
        var edge = 1 - smoothstep(0.5, 0.98, rd); // 1 in the body, →0 at the rim
        // thin the rim out entirely for some cells so the outline stays soft
        // and irregular (wispy) rather than a clean rounded rectangle
        if (edge < 0.06 && Math.random() > edge * 8) continue;
        // scatter the start over a soft DISC (not the full square) so the
        // very first frame already reads as an organic blob rather than a
        // rectangle filling the whole canvas — denser toward the middle
        var sa = Math.random() * Math.PI * 2, sr = Math.sqrt(Math.random());
        parts.push({
          tx: (x + 0.5) / gw, ty: (y + 0.5) / gh, // target, image-relative
          r: px[o], g: px[o + 1], b: px[o + 2],
          edge: edge,
          // scattered start + its own drift personality
          sx: 0.5 + Math.cos(sa) * sr * 0.46, sy: 0.5 + Math.sin(sa) * sr * 0.46,
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
      // over-clear a couple of pixels past every edge so a particle drawn
      // right at the boundary can never leave a stale residue column/row
      ctx.clearRect(-2, -2, w + 4, h + 4);

      // fit the image area inside the container, centred, with margin
      var fit = Math.min((w * 0.8) / iw, (h * 0.8) / ih);
      var dw = iw * fit, dh = ih * fit;
      var ox = (w - dw) / 2, oy = (h - dh) / 2;

      var t = (now - t0) / 1000;
      var dotBase = Math.max(1.6, cell * fit);
      // the picture NEVER settles into a still frame. Even fully assembled,
      // every particle keeps a clearly VISIBLE living orbit around its place,
      // a colour twinkle and a gentle size pulse, so there's always obvious
      // motion — the loader can't read as stuck (the long park at "99%"
      // especially, where the reconstruction genuinely is still working
      // server-side). The floor is high enough to be unmistakably alive yet
      // small next to the object, so the picture stays perfectly readable.
      var WOB_FLOOR = 0.36;
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        // each particle starts assembling after its own small delay, so the
        // picture condenses organically instead of snapping as one sheet
        var lp = Math.max(0, Math.min(1, (progress - p.dl) / (1 - p.dl)));
        var e = lp * lp * (3 - 2 * lp); // smoothstep
        // big drift while scattered, easing DOWN to a permanent gentle sway
        // (not to zero) so the assembled picture keeps breathing
        var wob = WOB_FLOOR + (1 - e) * (1 - WOB_FLOOR);
        // scattered start and assembled target — blended by e, then a living
        // wobble added ON TOP so motion persists even at full assembly
        var sxp = p.sx * w, syp = p.sy * h;
        var X = sxp + (ox + p.tx * dw - sxp) * e + Math.sin(t * p.sp + p.ph) * 26 * wob;
        var Y = syp + (oy + p.ty * dh - syp) * e + Math.cos(t * p.sp * 0.85 + p.ph) * 21 * wob;
        // colours from the photo, lifted brighter while adrift; a per-particle
        // twinkle keeps the colours visibly shifting the whole time
        var tw = 0.7 + 0.3 * Math.sin(t * 1.9 + p.ph * 2.3);
        var lift = Math.round(70 * (1 - e));
        // the elliptical edge falloff makes the rim fade to nothing, so the
        // whole thing reads as an organic blob of colour rather than a framed
        // rectangle (rim particles stay a touch visible so the outline breathes)
        ctx.globalAlpha = (0.5 + 0.5 * e) * tw * (0.12 + 0.88 * p.edge);
        ctx.fillStyle = "rgb(" + Math.min(255, p.r + lift) + "," + Math.min(255, p.g + lift) + "," + Math.min(255, p.b + lift) + ")";
        // a gentle size pulse on top of the assembly growth — the dots keep
        // breathing rather than freezing into a fixed grid
        var sz = dotBase * (0.4 + 0.65 * e) * (0.9 + 0.14 * Math.sin(t * 1.3 + p.ph));
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

function smoothstep(a, b, x) {
  var t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
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
