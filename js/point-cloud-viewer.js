/*
  traces — live point-cloud viewer

  glTF/model-viewer has no notion of point size — a "POINTS" primitive
  always renders at a fixed, tiny pixel size no matter how dense the source
  scan is or how far the camera zooms in. That's exactly why the earlier
  approach snapped points to a grid and emitted one small 3D particle
  (an octahedron) per cell instead — but a particle has a real world-space
  size, so zooming in far enough always eventually reveals it as a solid
  shape rather than a point. A reference point-cloud viewer (and this file)
  renders every point as a real GPU point sprite instead: sized in screen
  space, so it never "becomes visible as a shape" the way a discrete 3D
  particle does, and reads as crisp, fine detail at any zoom level.

  usage:
    var pv = mountPointCloudViewer(containerEl, geometry, { pointSize });
    pv.setPointSize(0.02);
    pv.dispose();
*/
import * as THREE from "./vendor/three/three.module.js?v=20260727dw";
import { OrbitControls } from "./vendor/three/OrbitControls.js?v=20260727dw";

export function mountPointCloudViewer(container, geometry, opts) {
  opts = opts || {};

  // the build-in intro reveals points in BUFFER ORDER (drawRange grows from a
  // few percent up to 100%). A mesh-derived cloud is stored in mesh order, so
  // an in-order reveal shows a solid STRIP of the object sweeping across the
  // frame — it reads as a "bar", not a cloud filling in. Shuffle the points
  // once up front so any prefix of the buffer is a spatially-uniform sample
  // and the object crystallises evenly from everywhere at once.
  (function shufflePoints() {
    if (opts.buildIn === false || geometry.index) return;
    var pos = geometry.getAttribute("position");
    if (!pos) return;
    var p = pos.array;
    var colAttr = geometry.getAttribute("color");
    var c = colAttr ? colAttr.array : null;
    for (var i = pos.count - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0;
      var pi = i * 3, pj = j * 3, t;
      t = p[pi]; p[pi] = p[pj]; p[pj] = t;
      t = p[pi + 1]; p[pi + 1] = p[pj + 1]; p[pj + 1] = t;
      t = p[pi + 2]; p[pi + 2] = p[pj + 2]; p[pj + 2] = t;
      if (c) {
        t = c[pi]; c[pi] = c[pj]; c[pj] = t;
        t = c[pi + 1]; c[pi + 1] = c[pj + 1]; c[pj + 1] = t;
        t = c[pi + 2]; c[pi + 2] = c[pj + 2]; c[pj + 2] = t;
      }
    }
    pos.needsUpdate = true;
    if (colAttr) colAttr.needsUpdate = true;
  })();

  // a low-powered exhibition laptop (weak integrated GPU, little RAM) can
  // refuse an antialiased context outright — which used to throw and leave
  // a blank stage. Retry without the frills before giving up.
  // preserveDrawingBuffer so screenshot() below can read back a frame
  // on demand instead of racing the render loop's own buffer swaps
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch (e) {
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true,
      powerPreference: "low-power" });
  }
  // overdraw is the killer here, not point count alone: an "opaque" cloud
  // means every screen pixel is written dozens of times, and at Retina 2x
  // that's 4x again — enough to saturate even a strong GPU and stutter the
  // whole machine. A dense cloud caps the backing resolution; the sprites
  // are soft-edged anyway, so the difference is invisible.
  var cloudCount0 = geometry.getAttribute("position") ? geometry.getAttribute("position").count : 0;
  var maxDpr = cloudCount0 > 300000 ? 1.25 : cloudCount0 > 120000 ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));

  // on a machine that reports little memory, thin an extra-dense cloud —
  // half the points still read as a full surface at these densities, and
  // it halves both the GPU upload and the frame cost
  // iOS/Safari never reports deviceMemory (it stays undefined → 8), so a phone
  // was treated as an 8GB desktop and the full-density cloud was uploaded —
  // which is exactly what silently failed to load on phones (the rug and other
  // heavy scans). Treat any mobile device as memory-constrained so the thinning
  // runs there too; desktops are unaffected.
  var isMobile = /Mobi|Android|iP(hone|ad|od)/i.test(navigator.userAgent || "") ||
    ((navigator.maxTouchPoints || 0) > 1 && /Mac/.test(navigator.platform || ""));
  var mem = navigator.deviceMemory || (isMobile ? 3 : 8);
  var posCount = geometry.getAttribute("position") ? geometry.getAttribute("position").count : 0;
  // Only decimate the genuinely huge clouds — the ones that actually failed to
  // upload on a handset (a 1M+ rug/room scan). An earlier version thinned every
  // mobile cloud to 180k, which quietly gutted normal room scans on any
  // touch-capable machine (including a touchscreen Mac at the exhibition) so
  // they read as sparse. Keep the target high and the trigger high: typical
  // scans pass through untouched, and only the extreme clouds get reduced —
  // still to a density that reads as a full surface.
  var thinTarget = isMobile ? 600000 : 900000;
  var thinFloor = isMobile ? 750000 : 1100000;
  if ((mem <= 4 || isMobile) && posCount > thinFloor) {
    var srcPos = geometry.getAttribute("position").array;
    var srcCol = geometry.getAttribute("color") ? geometry.getAttribute("color").array : null;
    var stride = Math.ceil(posCount / thinTarget);
    var kept = Math.floor(posCount / stride);
    var np = new Float32Array(kept * 3);
    var nc = srcCol ? new Float32Array(kept * 3) : null;
    for (var i = 0; i < kept; i++) {
      var s = i * stride * 3;
      np[i * 3] = srcPos[s]; np[i * 3 + 1] = srcPos[s + 1]; np[i * 3 + 2] = srcPos[s + 2];
      if (nc) { nc[i * 3] = srcCol[s]; nc[i * 3 + 1] = srcCol[s + 1]; nc[i * 3 + 2] = srcCol[s + 2]; }
    }
    var thin = new THREE.BufferGeometry();
    thin.setAttribute("position", new THREE.BufferAttribute(np, 3));
    if (nc) thin.setAttribute("color", new THREE.BufferAttribute(nc, 3));
    thin.userData = geometry.userData;
    geometry = thin;
  }
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";
  container.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);

  geometry.computeBoundingSphere();
  var rawSphere = geometry.boundingSphere && geometry.boundingSphere.radius > 0
    ? geometry.boundingSphere
    : new THREE.Sphere(new THREE.Vector3(), 1);

  // a raw phone scan commonly carries a handful of stray/noise points far
  // from the real surface (background clutter, reflections) - a bounding
  // sphere is defined entirely by its most extreme point, so even one of
  // those drags both its center (the orbit pivot - reads as "rotating
  // around the wrong point") and its radius (which the camera's near/far
  // planes and zoom limits all scale from - an inflated radius reads as
  // "can't get close", i.e. restricted movement) badly off the actual
  // object. The mean position of every point is far less swayed by a small
  // minority of outliers, and a radius trimmed to how far points actually
  // spread *around that mean* (capped at the raw sphere as a safety
  // ceiling, in case the cloud has no real outliers at all) stays
  // representative of the real object either way.
  var sphere = (function () {
    var pos = geometry.getAttribute("position");
    var count = pos.count;
    if (!count) return rawSphere;

    function meanAndStd(filter) {
      var cx = 0, cy = 0, cz = 0, n = 0;
      for (var i = 0; i < count; i++) {
        if (filter && !filter(i)) continue;
        cx += pos.getX(i); cy += pos.getY(i); cz += pos.getZ(i); n++;
      }
      if (!n) return null;
      cx /= n; cy /= n; cz /= n;
      var sumSq = 0;
      for (var j = 0; j < count; j++) {
        if (filter && !filter(j)) continue;
        var dx = pos.getX(j) - cx, dy = pos.getY(j) - cy, dz = pos.getZ(j) - cz;
        sumSq += dx * dx + dy * dy + dz * dz;
      }
      return { center: new THREE.Vector3(cx, cy, cz), std: Math.sqrt(sumSq / n), count: n };
    }

    // first pass over every point, including any stray outliers - just
    // enough to know roughly where they sit so the second pass can
    // exclude them outright
    var first = meanAndStd(null);
    var cutoff = first.std * 3;
    var fx = first.center.x, fy = first.center.y, fz = first.center.z;
    function withinCutoff(i) {
      var dx = pos.getX(i) - fx, dy = pos.getY(i) - fy, dz = pos.getZ(i) - fz;
      return (dx * dx + dy * dy + dz * dz) <= cutoff * cutoff;
    }
    // second pass, actually excluding whatever sat beyond that first
    // rough cutoff - a real minority of far-flung noise points otherwise
    // still dominates a single-pass std (squaring distance weights them
    // enormously even though they're a tiny fraction of the total count)
    var refined = cutoff > 0 ? meanAndStd(withinCutoff) : first;
    var std = (refined && refined.count > count * 0.5) ? refined.std : first.std;
    var trimmed = std * 2.5;
    // the ORBIT PIVOT is this center — and a mean gets dragged toward
    // whichever side of a scan is denser, or out along a long sparse arm
    // (a walking cane, a strip of wall). An off-centre pivot is exactly what
    // made some captures sweep across the screen like a clock hand instead
    // of turning in place like a dancer. The per-axis MEDIAN stays planted
    // in the dense mass of the object no matter what hangs off its sides.
    var center = (function () {
      var stride = Math.max(1, Math.floor(count / 60000));
      var xs = [], ys = [], zs = [];
      for (var mi = 0; mi < count; mi += stride) {
        if (!withinCutoff(mi)) continue;
        xs.push(pos.getX(mi)); ys.push(pos.getY(mi)); zs.push(pos.getZ(mi));
      }
      if (!xs.length) return (refined && refined.count > count * 0.5) ? refined.center : first.center;
      function med(arr) { arr.sort(function (a, b) { return a - b; }); return arr[arr.length >> 1]; }
      return new THREE.Vector3(med(xs), med(ys), med(zs));
    })();
    // only step in when there's a real sign of outlier bloat (the trimmed
    // spread is well under the raw extent) - for an already well-formed
    // cloud this leaves the plain bounding sphere untouched rather than
    // risking a framing regression on the vast majority of scans that
    // never had this problem to begin with
    var radius = (trimmed > 0 && trimmed < rawSphere.radius * 0.6) ? trimmed : rawSphere.radius;
    return new THREE.Sphere(center, radius || 1);
  })();

  // Sizing rules, in order:
  // 1. an explicitly saved size always wins — a person's own choice;
  // 2. a MACHINE-DERIVED cloud (flagged by deserializeGeometry — sampled off
  //    a mesh by us, never hand-tuned) scales with its own radius, because
  //    these arrive at wildly different coordinate scales: a fixed size
  //    rendered one sub-pixel ("empty" stage) and another as giant squares;
  // 3. a person's UPLOADED scan with no saved size keeps the original fixed
  //    0.013 — exactly how their scans have always rendered — but ONLY while
  //    that scan is anywhere near the object scale the number assumes. A
  //    room-scale upload measures ~18 units across its radius where an object
  //    measures ~1.6, so a fixed 0.013 leaves every point sub-pixel and the
  //    cloud reads as a thin speckle, exactly the way a stale saved size does.
  //    Off-scale uploads therefore size by radius like a derived cloud; the
  //    ordinary object-scale ones keep the fixed number untouched.
  var hasColor = !!geometry.getAttribute("color");
  var isDerived = !!(geometry.userData && geometry.userData.derived);
  // derived clouds render OPAQUE — big enough that neighbouring points
  // overlap into a continuous surface rather than a speckled see-through one
  var LEGACY_UPLOAD_SIZE = 0.013;
  var scaleSize = sphere.radius * 0.008;
  // "off scale" = the radius-appropriate size is more than 2x away from the
  // fixed one, a margin wide enough that no normal object trips it
  var offScale = scaleSize > LEGACY_UPLOAD_SIZE * 2 || scaleSize < LEGACY_UPLOAD_SIZE / 2;
  var autoSize = (isDerived || offScale) ? scaleSize : LEGACY_UPLOAD_SIZE;
  var chosenSize = opts.pointSize || autoSize || 0.01;
  // A saved size can be stale: written against a different representation of
  // this capture, or — more often — picked from the old absolute size ladder,
  // which only ever spanned object-scale values. On a room-scale cloud every
  // rung of that ladder is several times too small, so the saved number is not
  // a deliberate choice at all, just the closest the slider could get.
  // The live ladder spans 0.47x-2.03x of this radius-derived size, so anything
  // outside a slightly wider window than that could not have been chosen for
  // THIS cloud and is treated as stale rather than intentional.
  // An object-scale upload is left alone entirely — its saved size is a real
  // choice made on a ladder that could actually express it.
  if ((isDerived || offScale) && opts.pointSize &&
      (opts.pointSize < autoSize * 0.3 || opts.pointSize > autoSize * 3.5)) {
    chosenSize = autoSize;
  }
  var material = new THREE.PointsMaterial({
    size: chosenSize,
    sizeAttenuation: true,
    vertexColors: hasColor,
    color: hasColor ? 0xffffff : 0xcccccc,
  });
  // a managed/locked-down PC often runs Chrome with hardware acceleration
  // disabled by policy — WebGL then renders in SOFTWARE (SwiftShader), which
  // manages ~3fps on a dense cloud: reads as frozen/never-loading. Detect it
  // and start in a light mode that software rendering can actually push;
  // the adaptive governor below fine-tunes from there.
  var softwareGL = false;
  try {
    var glc = renderer.getContext();
    var dbgInfo = glc.getExtension("WEBGL_debug_renderer_info");
    var gpuName = dbgInfo ? String(glc.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL)) : "";
    softwareGL = /swiftshader|software|llvmpipe/i.test(gpuName);
  } catch (e) {}
  if (softwareGL) {
    renderer.setPixelRatio(1);
    var totalPts = geometry.getAttribute("position").count;
    if (totalPts > 90000) {
      // the buffer's order spreads points across the whole object, so a
      // prefix still covers it evenly — lighter, never a hole
      geometry.setDrawRange(0, 90000);
      material.size = material.size * 1.7;
    }
  }
  var points = new THREE.Points(geometry, material);
  // a raw phone scan's own coordinate frame can come in at any tilt - there's
  // no single rotation that fixes every scan (see the note above
  // deserializeGeometry in voxelize-shared.js), so instead of guessing, this
  // pivot lets object.html's own "straighten" control rotate the cloud
  // in place around its real center and save whatever angle actually looks
  // upright. Orbiting an already-tilted cloud never fixed the tilt itself -
  // only where you were standing to look at it - which is why "set this
  // angle as default view" alone couldn't solve it.
  var pivot = new THREE.Group();
  pivot.position.copy(sphere.center);
  points.position.copy(sphere.center).negate();
  pivot.add(points);
  scene.add(pivot);
  if (opts.tilt) pivot.rotation.set(opts.tilt.x || 0, 0, opts.tilt.z || 0);

  var controls = new OrbitControls(camera, renderer.domElement);
  // the orbit always pivots around the scan's own actual center — a saved
  // view only ever replaces the starting *camera position* (the angle/
  // distance someone picked as looking right), never the pivot itself.
  // Letting a saved view also carry its own target let the pivot drift off
  // the object's center (e.g. from a pan before saving), which reads as
  // "rotating around the wrong point" the moment you orbit afterward.
  controls.target.copy(sphere.center);
  // a raw scan's own coordinate frame is whatever orientation the phone
  // happened to be in when the capture started — there's no single default
  // angle that reads sensibly across every scan. A saved view (the person's
  // own hand-picked "this is the right way up/around" orbit) overrides the
  // generic centered/backed-off guess once they've set one for this capture.
  // sanity-check a saved view against THIS cloud: a view saved against a
  // different representation of the capture (an old voxel cloud, a mesh at
  // another coordinate scale) can park the camera absurdly far away or
  // inside the cloud — either reads as a blank stage, not a framing choice
  var ivOk = false;
  if (opts.initialView && opts.initialView.position) {
    var ivp = opts.initialView.position;
    var dist = Math.hypot(ivp.x - sphere.center.x, ivp.y - sphere.center.y, ivp.z - sphere.center.z);
    ivOk = dist > sphere.radius * 0.05 && dist < sphere.radius * 14;
  }
  if (ivOk) {
    camera.position.set(opts.initialView.position.x, opts.initialView.position.y, opts.initialView.position.z);
  } else {
    // Default framing. A hard-coded +Z view collapses a genuinely FLAT
    // capture whose broad face happens to point sideways (a rug, a panel, a
    // painting, a scan taken edge-out) into a single thin line of points —
    // exactly the "line made of particles" the loading screen showed for
    // some uploads. Look at the object down its THINNEST axis instead, so
    // its widest face always fills the frame. A normal boxy object never
    // trips the flatness test below and keeps the familiar straight-on view,
    // so nothing that already framed well moves.
    var viewDir = new THREE.Vector3(0, 0, 1);
    var upVec = new THREE.Vector3(0, 1, 0);
    geometry.computeBoundingBox();
    var bbox = geometry.boundingBox;
    if (bbox) {
      var ext = new THREE.Vector3();
      bbox.getSize(ext);
      var maxExt = Math.max(ext.x, ext.y, ext.z);
      var minExt = Math.min(ext.x, ext.y, ext.z);
      // only a genuinely sheet-like capture (one axis a small fraction of the
      // widest) swings to a face-on view. The flattest real *3D* object here —
      // a cabinet — sits at ~0.37, while an actual flat sheet (a rug) is
      // ~0.05, so 0.15 separates them with a wide margin and never reframes a
      // boxy object that already looked right.
      if (maxExt > 0 && minExt < maxExt * 0.15) {
        if (ext.z <= ext.x && ext.z <= ext.y) {
          // thin front-to-back: the default straight-on view already
          // presents the whole face
          viewDir.set(0, 0, 1); upVec.set(0, 1, 0);
        } else if (ext.x <= ext.y && ext.x <= ext.z) {
          // thin side-to-side: swing round to look at its wide Y-Z face
          viewDir.set(1, 0, 0); upVec.set(0, 1, 0);
        } else {
          // thin top-to-bottom (lying flat, like a rug on the floor):
          // look straight down on it — Z becomes screen-up
          viewDir.set(0, 1, 0); upVec.set(0, 0, -1);
        }
      }
    }
    camera.up.copy(upVec);
    camera.position.copy(sphere.center).add(viewDir.multiplyScalar(sphere.radius * 2.4 || 3));
  }
  camera.near = Math.max(sphere.radius * 0.005, 0.001);
  camera.far = (sphere.radius || 1) * 30;
  camera.updateProjectionMatrix();

  // Everything that decides how this cloud ends up looking, recorded so a
  // display complaint can be diagnosed from the actual numbers on the actual
  // machine instead of guessed at from a screenshot. Surfaced by object.html
  // under ?pcdebug=1.
  var diagnostics = {
    rawCount: posCount,
    drawnCount: geometry.getAttribute("position").count,
    wasThinned: posCount !== geometry.getAttribute("position").count,
    isMobile: isMobile,
    deviceMemory: navigator.deviceMemory || null,
    memUsed: mem,
    softwareGL: softwareGL,
    pixelRatio: renderer.getPixelRatio(),
    isDerived: isDerived,
    offScale: offScale,
    autoSize: autoSize,
    chosenSize: chosenSize,
    optsPointSize: opts.pointSize || null,
    rawRadius: rawSphere.radius,
    radius: sphere.radius,
    radiusWasTrimmed: sphere.radius !== rawSphere.radius,
    hadSavedView: !!(opts.initialView && opts.initialView.position),
    savedViewAccepted: ivOk,
    savedViewDist: (opts.initialView && opts.initialView.position)
      ? Math.hypot(opts.initialView.position.x - sphere.center.x,
        opts.initialView.position.y - sphere.center.y,
        opts.initialView.position.z - sphere.center.z) : null,
    cameraDist: Math.hypot(camera.position.x - sphere.center.x,
      camera.position.y - sphere.center.y, camera.position.z - sphere.center.z),
  };
  // default zoomSpeed (1) reads as barely responding on a scan-sized scene —
  // scrolling should visibly close the distance in a couple of ticks, and
  // minDistance needs to allow getting genuinely close (matching camera.near)
  // instead of stopping well short of it, since "inspect fine detail up
  // close" is the whole point of this viewer
  controls.zoomSpeed = 8;
  controls.minDistance = Math.max(sphere.radius * 0.01, 0.005);
  controls.maxDistance = (sphere.radius || 1) * 15;
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  // opt-in slow turn (studio recording mode only — the site itself shows
  // clouds still). Touching it stops the turn, and it only resumes after 6
  // quiet seconds — resuming right on release made it impossible to
  // actually SET an angle (it drifted away mid-thought).
  controls.autoRotate = !!opts.autoRotate;
  controls.autoRotateSpeed = 0.55;
  var autoRotateWanted = !!opts.autoRotate;
  var autoRotateResume = null;
  controls.addEventListener("start", function () {
    controls.autoRotate = false;
    if (autoRotateResume) { clearTimeout(autoRotateResume); autoRotateResume = null; }
  });
  controls.addEventListener("end", function () {
    if (autoRotateResume) clearTimeout(autoRotateResume);
    autoRotateResume = setTimeout(function () {
      if (autoRotateWanted) controls.autoRotate = true;
    }, 6000);
  });
  function setAutoRotate(on) {
    autoRotateWanted = !!on;
    if (autoRotateResume) { clearTimeout(autoRotateResume); autoRotateResume = null; }
    controls.autoRotate = !!on;
  }
  controls.update();

  // hold Space + drag to pan — orbit alone only spins around one fixed
  // pivot, which isn't enough to explore a room-sized space scan; this
  // reuses OrbitControls' own built-in pan (already wired to the right
  // mouse button) by remapping the left button to it for as long as Space
  // is held, rather than reimplementing panning by hand
  var spaceHeld = false;
  var hovering = false;
  container.addEventListener("pointerenter", function () { hovering = true; });
  container.addEventListener("pointerleave", function () { hovering = false; });

  function isTypingTarget(el) {
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  }

  function onKeyDown(e) {
    if (e.code !== "Space" || spaceHeld) return;
    if (!hovering || isTypingTarget(document.activeElement)) return;
    e.preventDefault(); // stop the page from scrolling while panning
    spaceHeld = true;
    controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
  }
  function onKeyUp(e) {
    if (e.code !== "Space") return;
    spaceHeld = false;
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  function resize() {
    var w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  var ro = (typeof ResizeObserver !== "undefined") ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);

  // hit-testing a point cloud needs a real-world tolerance around the ray
  // (a point is dimensionless) — scaled to the scan's own size so it works
  // whether the camera is close up or backed off to frame the whole thing
  var raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = Math.max(sphere.radius * 0.02, 0.001);

  // screen point -> nearest 3D point actually on the cloud, so a new
  // annotation anchors to real geometry instead of a flat click coordinate
  function raycastFromScreen(clientX, clientY) {
    var rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    // default Points threshold is 1 WORLD UNIT — in a room-sized scan that
    // grabs the first point anywhere near the ray (usually the floor in
    // front), which is how a pin ended up in a "random" spot. Scale the
    // threshold to the scene and take the point most exactly UNDER the
    // cursor (smallest distance to the ray), not the first along it.
    raycaster.params.Points = raycaster.params.Points || {};
    raycaster.params.Points.threshold = Math.max(sphere.radius * 0.015, 1e-4);
    var hits = raycaster.intersectObject(points);
    if (!hits.length) return null;
    var best = hits[0];
    for (var hi = 1; hi < hits.length; hi++) {
      var h = hits[hi];
      if (h.distanceToRay < best.distanceToRay - 1e-9 ||
          (Math.abs(h.distanceToRay - best.distanceToRay) <= 1e-9 && h.distance < best.distance)) {
        best = h;
      }
    }
    return best.point.clone();
  }

  // 3D point -> its current screen position (fractional, 0..1 within the
  // container) — called every frame so a pinned annotation marker tracks
  // the point as the camera orbits, the same job model-viewer's own hotspot
  // slots do natively for a glTF mesh
  var projectVec = new THREE.Vector3();
  function project(pos) {
    projectVec.set(pos.x, pos.y, pos.z);
    var view = projectVec.clone().applyMatrix4(camera.matrixWorldInverse);
    var behind = view.z > 0; // the camera looks down -Z in its own view space
    projectVec.project(camera);
    return { x: (projectVec.x + 1) / 2, y: (1 - projectVec.y) / 2, behind: behind };
  }

  var frameCallbacks = [];
  function onFrame(cb) {
    frameCallbacks.push(cb);
    return function unsubscribe() {
      var i = frameCallbacks.indexOf(cb);
      if (i !== -1) frameCallbacks.splice(i, 1);
    };
  }

  var raf = null;
  var disposed = false;
  // ---- adaptive quality ----
  // a weak GPU (or Chrome running without hardware acceleration) can render
  // the MESH fine yet choke on half a million attenuated point sprites.
  // Watch the real frame time and step the load down until it's smooth:
  // first drop the pixel ratio (fill-rate is the usual bottleneck), then
  // progressively draw fewer points. The buffer's order spreads points
  // across the whole object, so drawing a prefix still covers it evenly —
  // the cloud gets a little lighter, never a hole.
  // ---- build-in: the scan RESOLVES on arrival ----
  // instead of popping in finished, the cloud starts as a sparse, oversized
  // blur of itself and sharpens into full precision over ~1.6s — the object
  // visibly "builds" out of its own points as it loads
  var introStart = 0;
  var INTRO_MS = opts.buildIn === false ? 0 : 2200;
  var introBaseSize = material.size;
  var introTotal = geometry.getAttribute("position").count;
  if (INTRO_MS && introTotal > 20000) {
    geometry.setDrawRange(0, Math.max(1, Math.floor(introTotal * 0.05)));
    material.size = introBaseSize * 3.6;
  } else {
    INTRO_MS = 0;
  }
  var qStep = 0, slowStreak = 0, lastT = 0, checked = 0;
  function stepQualityDown() {
    qStep++;
    if (qStep === 1) {
      renderer.setPixelRatio(1);
    } else {
      var total = geometry.getAttribute("position").count;
      var target = Math.max(120000, Math.floor(total / Math.pow(2, qStep - 1)));
      geometry.setDrawRange(0, target);
      material.size = material.size * 1.25; // fewer, slightly bigger points
    }
  }
  (function frame(t) {
    if (disposed) return;
    if (INTRO_MS) {
      if (!introStart) introStart = t;
      var ik = Math.min(1, (t - introStart) / INTRO_MS);
      var ease = ik * ik * (3 - 2 * ik); // smoothstep: gentle start and landing
      geometry.setDrawRange(0, Math.max(1, Math.floor(introTotal * (0.05 + 0.95 * ease))));
      material.size = introBaseSize * (3.6 - 2.6 * ease);
      if (ik >= 1) {
        geometry.setDrawRange(0, Infinity);
        material.size = introBaseSize;
        INTRO_MS = 0;
      }
    } else if (lastT && checked < 240 && qStep < 4) {
      checked++;
      var dt = t - lastT;
      // ~<15fps sustained means genuinely struggling, not a one-off hitch
      if (dt > 40) { slowStreak++; } else if (slowStreak > 0) { slowStreak--; }
      if (slowStreak >= 12) { slowStreak = 0; stepQualityDown(); }
    }
    lastT = t;
    controls.update();
    renderer.render(scene, camera);
    frameCallbacks.forEach(function (cb) { cb(); });
    raf = requestAnimationFrame(frame);
  })(0);

  return {
    setPointSize: function (size) { material.size = size; },
    // rotates the cloud in place around its own center (not the camera) -
    // x is a forward/back tilt, z is a side-to-side lean
    setTilt: function (x, z) { pivot.rotation.set(x, 0, z); },
    getTilt: function () { return { x: pivot.rotation.x, z: pivot.rotation.z }; },
    resize: resize,
    raycastFromScreen: raycastFromScreen,
    setAutoRotate: setAutoRotate,
    project: project,
    onFrame: onFrame,
    // the cloud's own extent, so a caller can test whether a 3D point taken
    // from some OTHER representation of the same capture (the mesh) lives in
    // this cloud's coordinate frame at all — see object.html's anchor bridge
    getDiagnostics: function () { return diagnostics; },
    // the size this cloud renders at when nothing is saved for it — the base
    // object.html builds its size ladder from, so the slider's rungs always
    // land in the same scale the viewer is actually drawing in
    getAutoSize: function () { return autoSize; },
    getBounds: function () {
      return {
        center: { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z },
        radius: sphere.radius,
      };
    },
    // the current orbit, in a form that can be stored and handed back to
    // opts.initialView on a later mount to reproduce this exact framing
    getView: function () {
      return {
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      };
    },
    screenshot: function () {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL("image/png");
    },
    dispose: function () {
      disposed = true;
      frameCallbacks.length = 0;
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      // container (the stage's fixed points slot) outlives any one mount —
      // switching captures repeatedly without this leaked a fresh pair of
      // window-level key listeners every time, each still watching the same
      // long-lived container for hover
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      controls.dispose();
      material.dispose();
      renderer.dispose();
      // renderer.dispose() alone does NOT free the underlying WebGL context —
      // the browser keeps it alive until GC, and it caps live contexts at ~16.
      // Browsing through a dozen-plus point clouds (each mount makes a fresh
      // context) silently hit that ceiling, and from then on new viewers
      // couldn't get a context at all: the cloud just span on "loading"
      // forever ("doesn't load in various places"). forceContextLoss releases
      // it immediately so navigation can go on indefinitely.
      try { renderer.forceContextLoss(); } catch (e) {}
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}
