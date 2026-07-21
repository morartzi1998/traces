/*
  traces — a small looping "assembling particle cloud" used as the loading
  state for a point-cloud capture. A real scan is tens of megabytes, so the
  fetch + parse takes real time; a drifting, slowly-turning sphere of points
  reads as a space being built rather than an empty, broken-looking frame.
  (The same visual language processing.html uses while a scan reconstructs.)

  ParticleLoader.start(canvasEl) -> { stop() }
*/
window.ParticleLoader = (function () {
  function start(canvas) {
    if (!canvas) return { stop: function () {} };
    canvas.hidden = false;
    var ctx = canvas.getContext("2d");
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var raf = null, running = true;

    function size() {
      var r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    }
    size();
    window.addEventListener("resize", size);

    // seed points on a rough sphere shell, each with a small drift + twinkle
    var N = 460, pts = [];
    for (var i = 0; i < N; i++) {
      var u = Math.random(), v = Math.random();
      var theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
      pts.push({
        x: Math.sin(phi) * Math.cos(theta),
        y: Math.sin(phi) * Math.sin(theta),
        z: Math.cos(phi),
        drift: 0.14 + Math.random() * 0.5,
        twinkle: Math.random() * Math.PI * 2
      });
    }

    var t0 = performance.now();
    function frame(now) {
      if (!running) return;
      var w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.32;
      var ang = (now - t0) * 0.0003;               // slow turntable rotation
      var cosA = Math.cos(ang), sinA = Math.sin(ang);
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        var s = p.drift;
        var jx = Math.sin(now * 0.0011 + p.twinkle) * s;
        var jy = Math.cos(now * 0.0013 + p.twinkle) * s;
        var jz = Math.sin(now * 0.0009 + p.twinkle * 1.7) * s;
        var px = p.x + jx, py = p.y + jy, pz = p.z + jz;
        var rx = px * cosA + pz * sinA;
        var rz = -px * sinA + pz * cosA;
        var persp = 1 / (2.2 - rz);
        var sx = cx + rx * R * persp * 1.6;
        var sy = cy + py * R * persp * 1.6;
        var depth = Math.max(0, Math.min(1, (rz + 1) / 2)); // 0 back … 1 front
        var tw = 0.6 + 0.4 * Math.sin(now * 0.004 + p.twinkle);
        var alpha = (0.26 + 0.5 * depth) * tw;
        var rad = (0.7 + depth * 1.5) * dpr;
        ctx.beginPath();
        ctx.arc(sx, sy, rad, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255," + alpha.toFixed(3) + ")";
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return {
      stop: function () {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        window.removeEventListener("resize", size);
        try { ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (e) {}
        canvas.hidden = true;
      }
    };
  }
  return { start: start };
})();
