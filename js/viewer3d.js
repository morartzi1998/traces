/*
  traces — point-cloud viewer
  Renders a capture as a rotatable 3D point cloud, built by sampling the
  object photo's pixels (transparent background PNGs). Drag to orbit,
  scroll to zoom. Until real scan files exist this gives every capture a
  navigable 3D presence; swap the sampler for a .ply/.splat loader later.

  usage: initPointCloudViewer(containerEl, imageSrc, { autoSpin: true })
*/

function initPointCloudViewer(container, imgSrc, opts) {
  opts = opts || {};

  if (container.__pcSrc === imgSrc && container.__pcCanvas) {
    return container.__pcCanvas; // already showing this capture
  }
  if (container.__pcCanvas) {
    container.__pcCanvas.remove();
  }

  var canvas = document.createElement("canvas");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  container.appendChild(canvas);

  var gl = canvas.getContext("webgl", { antialias: false, alpha: true });
  if (!gl) {
    var img = document.createElement("img");
    img.src = imgSrc;
    img.style.maxWidth = "100%";
    img.style.maxHeight = "100%";
    container.replaceChild(img, canvas);
    return null;
  }

  var VS =
    "attribute vec3 aPos; attribute vec3 aCol;" +
    "uniform mat4 uMvp; uniform float uSize;" +
    "varying vec3 vCol;" +
    "void main(){ gl_Position = uMvp * vec4(aPos, 1.0);" +
    "  gl_PointSize = uSize / gl_Position.w; vCol = aCol; }";
  var FS =
    "precision mediump float; varying vec3 vCol;" +
    "void main(){ gl_FragColor = vec4(vCol, 1.0); }";

  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }
  var prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  var uMvp = gl.getUniformLocation(prog, "uMvp");
  var uSize = gl.getUniformLocation(prog, "uSize");
  var count = 0;

  // ---- build the cloud from the image ----
  var image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = function () {
    var W = 220;
    var H = Math.round((image.height / image.width) * W);
    var off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    var ctx = off.getContext("2d");
    ctx.drawImage(image, 0, 0, W, H);
    var data = ctx.getImageData(0, 0, W, H).data;

    var pos = [], col = [];
    var aspect = H / W;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4;
        if (data[i + 3] < 120) continue;
        var px = (x / W - 0.5) * 2.0;
        var py = (0.5 - y / H) * 2.0 * aspect;
        // volume: jittered depth slab, thicker near the vertical midline
        var envelope = 1.0 - Math.abs(px) * 0.7;
        var pz = (Math.random() - 0.5) * 0.55 * Math.max(envelope, 0.15);
        pos.push(px, py, pz);
        col.push(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
      }
    }
    count = pos.length / 3;

    function attr(name, arr) {
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    }
    attr("aPos", pos);
    attr("aCol", col);
  };
  image.src = imgSrc;

  // ---- interaction ----
  var rotX = 0, rotY = 0, tX = 0, tY = opts.autoSpin ? 0.4 : 0;
  var zoom = 1, tZoom = 1;
  var dragging = false, moved = 0, lx = 0, ly = 0;

  canvas.addEventListener("pointerdown", function (e) {
    dragging = true;
    moved = 0;
    lx = e.clientX;
    ly = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    var dx = e.clientX - lx, dy = e.clientY - ly;
    moved += Math.abs(dx) + Math.abs(dy);
    tY += dx * 0.008;
    tX = Math.max(-1.1, Math.min(1.1, tX + dy * 0.006));
    lx = e.clientX;
    ly = e.clientY;
  });
  canvas.addEventListener("pointerup", function () {
    dragging = false;
    if (moved > 6) {
      container.__suppressClick = true;
      setTimeout(function () { container.__suppressClick = false; }, 0);
    }
  });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    tZoom = Math.max(0.45, Math.min(2.6, tZoom * (e.deltaY > 0 ? 0.92 : 1.08)));
  }, { passive: false });

  // ---- render loop ----
  function mat(rx, ry, s, aspect) {
    var cx = Math.cos(rx), sx = Math.sin(rx);
    var cy = Math.cos(ry), sy = Math.sin(ry);
    // rotY then rotX, scale, then a mild perspective (w = 1 + z*0.35)
    return [
      cy * s / aspect, sx * sy * s, cx * sy * 0.35, cx * sy * s * 0.0,
      0, cx * s, -sx * 0.35, 0,
      -sy * s / aspect, sx * cy * s, cx * cy * 0.35, 0,
      0, 0, 1.6, 1.6,
    ];
  }

  function frame() {
    if (!canvas.isConnected) return; // page/section went away
    var w = container.clientWidth, h = container.clientHeight;
    if (w && h && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    if (opts.autoSpin && !dragging) tY += 0.0018;
    rotX += (tX - rotX) * 0.12;
    rotY += (tY - rotY) * 0.12;
    zoom += (tZoom - zoom) * 0.12;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (count) {
      gl.uniformMatrix4fv(uMvp, false, new Float32Array(mat(rotX, rotY, zoom * 1.05, w / Math.max(h, 1))));
      gl.uniform1f(uSize, 3.6 * (window.devicePixelRatio > 1 ? 1.4 : 1));
      gl.drawArrays(gl.POINTS, 0, count);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  container.__pcSrc = imgSrc;
  container.__pcCanvas = canvas;
  return canvas;
}
