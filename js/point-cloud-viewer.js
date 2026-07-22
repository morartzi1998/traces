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
import * as THREE from "three";
import { OrbitControls } from "./vendor/three/OrbitControls.js?v=20260724n";

export function mountPointCloudViewer(container, geometry, opts) {
  opts = opts || {};

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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  // on a machine that reports little memory, thin an extra-dense cloud —
  // half the points still read as a full surface at these densities, and
  // it halves both the GPU upload and the frame cost
  var mem = navigator.deviceMemory || 8;
  var posCount = geometry.getAttribute("position") ? geometry.getAttribute("position").count : 0;
  if (mem <= 4 && posCount > 240000) {
    var srcPos = geometry.getAttribute("position").array;
    var srcCol = geometry.getAttribute("color") ? geometry.getAttribute("color").array : null;
    var stride = Math.ceil(posCount / 220000);
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
    var center = (refined && refined.count > count * 0.5) ? refined.center : first.center;
    var std = (refined && refined.count > count * 0.5) ? refined.std : first.std;
    var trimmed = std * 2.5;
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
  //    0.013 — exactly how their scans have always rendered. Do not touch.
  var hasColor = !!geometry.getAttribute("color");
  var isDerived = !!(geometry.userData && geometry.userData.derived);
  // derived clouds render OPAQUE — big enough that neighbouring points
  // overlap into a continuous surface rather than a speckled see-through one
  var autoSize = isDerived ? sphere.radius * 0.011 : 0.013;
  var chosenSize = opts.pointSize || autoSize || 0.01;
  // a size saved against a DIFFERENT representation of this capture (the
  // old voxel cloud, a mesh at another coordinate scale) can be so far off
  // this cloud's scale that every point lands sub-pixel — an "empty" stage.
  // A person's deliberate choice is never 20x off; that's stale data.
  if (isDerived && opts.pointSize &&
      (opts.pointSize < autoSize * 0.05 || opts.pointSize > autoSize * 20)) {
    chosenSize = autoSize;
  }
  var material = new THREE.PointsMaterial({
    size: chosenSize,
    sizeAttenuation: true,
    vertexColors: hasColor,
    color: hasColor ? 0xffffff : 0xcccccc,
  });
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
    camera.position.copy(sphere.center).add(new THREE.Vector3(0, 0, sphere.radius * 2.4 || 3));
  }
  camera.near = Math.max(sphere.radius * 0.005, 0.001);
  camera.far = (sphere.radius || 1) * 30;
  camera.updateProjectionMatrix();
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
    var hits = raycaster.intersectObject(points);
    return hits.length ? hits[0].point.clone() : null;
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
    if (lastT && checked < 240 && qStep < 4) {
      checked++;
      var dt = t - lastT;
      // ~<15fps sustained means genuinely struggling, not a one-off hitch
      if (dt > 66) { slowStreak++; } else if (slowStreak > 0) { slowStreak--; }
      if (slowStreak >= 20) { slowStreak = 0; stepQualityDown(); }
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
    project: project,
    onFrame: onFrame,
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
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}
