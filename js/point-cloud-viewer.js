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
import * as THREE from "./vendor/three/three.module.js?v=20260727gm";
import { OrbitControls } from "./vendor/three/OrbitControls.js?v=20260727gm";

export function mountPointCloudViewer(container, geometry, opts) {
  opts = opts || {};

  // the build-in intro reveals points in BUFFER ORDER (drawRange grows from a
  // few percent up to 100%). A mesh-derived cloud is stored in mesh order, so
  // an in-order reveal shows a solid STRIP of the object sweeping across the
  // frame — it reads as a "bar", not a cloud filling in. Shuffle the points
  // once up front so any prefix of the buffer is a spatially-uniform sample
  // and the object crystallises evenly from everywhere at once.
  // The reveal reorders the buffer — and anything ELSE that is indexed by point
  // has to travel with it. The merge screen keeps parallel arrays in userData
  // (each point's real colour, its per-scan tint, and which scan it came from)
  // and those used to be left in the original order while the points moved.
  // After that, "colour by scan" painted every tint onto the wrong point, and
  // switching back painted the real colours onto the wrong point too — garbled,
  // in both directions, permanently. Permute them alongside.
  (function orderPoints() {
    if (opts.buildIn === false || geometry.index) return;
    var pos = geometry.getAttribute("position");
    if (!pos) return;
    var n = pos.count;
    var p = pos.array;
    var colAttr = geometry.getAttribute("color");
    var c = colAttr ? colAttr.array : null;

    // revealFrom turns the intro into an EXPANSION: sorted by distance from a
    // given point, any prefix of the buffer is the sphere of cloud nearest it,
    // so the build-in grows outward from that spot instead of filling in
    // everywhere at once. Used when a space is opened on one of its objects —
    // the object appears first and the room assembles around it.
    // Otherwise a plain shuffle, so any prefix is a spatially-uniform sample
    // and the object crystallises evenly from everywhere at once (a
    // mesh-derived cloud is stored in mesh order, and revealing THAT in order
    // sweeps a solid strip across the frame — it reads as a bar, not a cloud).
    var order = new Uint32Array(n);
    for (var oi0 = 0; oi0 < n; oi0++) order[oi0] = oi0;
    if (opts.revealFrom) {
      var ax = opts.revealFrom.x, ay = opts.revealFrom.y, az = opts.revealFrom.z;
      var d2 = new Float32Array(n);
      for (var qi = 0; qi < n; qi++) {
        var qx = p[qi * 3] - ax, qy = p[qi * 3 + 1] - ay, qz = p[qi * 3 + 2] - az;
        d2[qi] = qx * qx + qy * qy + qz * qz;
      }
      order.sort(function (a, b) { return d2[a] - d2[b]; });
    } else {
      for (var i = n - 1; i > 0; i--) {
        var j = (Math.random() * (i + 1)) | 0;
        var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
      }
    }

    // permute into fresh buffers, then copy back — an in-place permutation
    // needs cycle tracking and is not worth it for a one-off
    function permuteVec3(arr) {
      if (!arr || arr.length < n * 3) return null;
      var out = new Float32Array(n * 3);
      for (var k = 0; k < n; k++) {
        var src = order[k] * 3, dst = k * 3;
        out[dst] = arr[src]; out[dst + 1] = arr[src + 1]; out[dst + 2] = arr[src + 2];
      }
      return out;
    }
    var np = permuteVec3(p);
    if (np) p.set(np);
    if (c) { var nc = permuteVec3(c); if (nc) c.set(nc); }
    pos.needsUpdate = true;
    if (colAttr) colAttr.needsUpdate = true;

    // the merge's parallel per-point arrays travel with the points
    var ud = geometry.userData || {};
    ["origColors", "altColors"].forEach(function (keyName) {
      var moved = permuteVec3(ud[keyName]);
      if (moved) ud[keyName] = moved;
    });
    if (ud.origin && ud.origin.length >= n) {
      var no = new (ud.origin.constructor || Array)(n);
      for (var m = 0; m < n; m++) no[m] = ud.origin[order[m]];
      ud.origin = no;
    }
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
    // carrying userData across by reference left the merge's per-point arrays
    // at the ORIGINAL length while the points were sampled down — the same
    // colour/point mismatch as the reveal ordering, just reached another way.
    // Sample them on the identical stride.
    var srcUd = geometry.userData || {};
    var thinUd = {};
    Object.keys(srcUd).forEach(function (kName) { thinUd[kName] = srcUd[kName]; });
    ["origColors", "altColors"].forEach(function (kName) {
      var arr = srcUd[kName];
      if (!arr || arr.length < posCount * 3) return;
      var out = new Float32Array(kept * 3);
      for (var q = 0; q < kept; q++) {
        var sq = q * stride * 3;
        out[q * 3] = arr[sq]; out[q * 3 + 1] = arr[sq + 1]; out[q * 3 + 2] = arr[sq + 2];
      }
      thinUd[kName] = out;
    });
    if (srcUd.origin && srcUd.origin.length >= posCount) {
      var oOut = new (srcUd.origin.constructor || Array)(kept);
      for (var w = 0; w < kept; w++) oOut[w] = srcUd.origin[w * stride];
      thinUd.origin = oOut;
    }
    thin.userData = thinUd;
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
  // A bare PointsMaterial draws every point as a hard SQUARE. Where a surface
  // runs at an angle those squares tile into visible diagonal lattices — the
  // "diamond" pattern that a real scan (round points) never shows. Discarding
  // the corners makes each point a disc instead. This is a cutout, not
  // transparency: no blending, no depth sorting, so it costs nothing and can't
  // reorder the cloud.
  material.onBeforeCompile = function (shader) {
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      "void main() {\n\tvec2 tracesPC = gl_PointCoord - vec2( 0.5 );\n\tif ( dot( tracesPC, tracesPC ) > 0.25 ) discard;"
    );
  };
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
  // How far back the whole cloud sits in frame. 2.4 radii is what every
  // landscape screen has always used. On a PORTRAIT viewport (a phone held
  // upright) the HORIZONTAL field is the narrow one, so that same distance
  // cut a wide object off at both edges — the sofa ran off the sides with
  // only its middle on screen. Widen by the aspect there; a landscape or
  // square viewport gets exactly the framing it does today.
  function fitDistance() {
    var w = container.clientWidth || 1, h = container.clientHeight || 1;
    var back = 2.4;
    if (w < h) back = back * (h / w);
    return (sphere.radius * back) || 3;
  }

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
    camera.position.copy(sphere.center).add(viewDir.multiplyScalar(fitDistance()));
  }
  // focusOn: arrive already looking AT a particular point rather than at the
  // whole cloud — entering a space through one of its objects should open on
  // that object, not on the room with the object somewhere in it. The pull-back
  // is a fraction of the cloud's own radius, so it frames comparably whether
  // the space is a small room or a large one.
  // A camera that jumps in a single frame reads as the capture being swapped
  // for a different one. Easing the same move over ~0.7s reads as travelling
  // to the thing you asked for, which is what "zoom to this" should feel like.
  var camTween = null;
  function tweenCamera(toPos, toTarget, ms) {
    camTween = {
      fromPos: camera.position.clone(), toPos: toPos.clone(),
      fromTarget: controls.target.clone(), toTarget: toTarget.clone(),
      ms: ms > 0 ? ms : 1, start: 0,
    };
  }
  function stepCameraTween(t) {
    if (!camTween) return;
    if (!camTween.start) camTween.start = t;
    var k = Math.min(1, (t - camTween.start) / camTween.ms);
    var e = k * k * (3 - 2 * k); // smoothstep, same easing as the build-in
    camera.position.lerpVectors(camTween.fromPos, camTween.toPos, e);
    controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, e);
    if (k >= 1) camTween = null;
  }
  // hands on the controls always win — an animation that fought a drag would
  // feel like the viewer was stuck
  if (controls.addEventListener) {
    controls.addEventListener("start", function () { camTween = null; });
  }

  function focusAt(pt, focusOpts) {
    if (!pt) return;
    var fp = new THREE.Vector3(pt.x, pt.y, pt.z);
    var away = camera.position.clone().sub(controls.target);
    if (away.lengthSq() < 1e-8) away.copy(camera.position).sub(sphere.center);
    if (away.lengthSq() < 1e-8) away.set(0, 0, 1);
    away.normalize().multiplyScalar(Math.max(sphere.radius * 0.28, 0.05));
    var dest = fp.clone().add(away);
    // arriving already framed on the object (opts.focusOn at mount) must be
    // instant — there is no "before" position for a move to start from
    if (focusOpts && focusOpts.animate === false) {
      camTween = null;
      camera.position.copy(dest);
      controls.target.copy(fp);
      controls.update();
      return;
    }
    tweenCamera(dest, fp, (focusOpts && focusOpts.ms) || 700);
  }

  // the reverse of focusAt: pull back out until the whole cloud is in frame
  // again. Leaving a space used to cut straight back to the object, which
  // threw away the sense of where in the room it had been standing.
  function zoomOut(ms, done) {
    var dir = camera.position.clone().sub(sphere.center);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
    dir.normalize().multiplyScalar(fitDistance());
    var span = ms > 0 ? ms : 520;
    tweenCamera(sphere.center.clone().add(dir), sphere.center.clone(), span);
    if (done) setTimeout(done, span);
  }

  if (opts.focusOn) focusAt(opts.focusOn, { animate: false });
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
  // A software-GL machine (the exhibition laptop, if it has no usable GPU) has
  // already capped how many points it will draw. The intro grows drawRange
  // itself and used to finish by clearing it to Infinity — quietly handing that
  // machine the entire scan the moment the animation ended, which is the worst
  // possible time to do it. Grow towards the cap and land on it instead.
  var drawCap = geometry.drawRange.count;
  var introTotal = Math.min(geometry.getAttribute("position").count,
                            drawCap === Infinity ? Infinity : drawCap);
  if (INTRO_MS && introTotal > 20000) {
    geometry.setDrawRange(0, Math.max(1, Math.floor(introTotal * 0.05)));
    material.size = introBaseSize * 3.6;
  } else {
    INTRO_MS = 0;
  }
  // Adaptive quality. This is the "the particles suddenly thinned out" report:
  // it halves the drawn points, repeatedly, down to 120k out of a million — and
  // it used to be one-way, so the only cure was a reload. Two things were wrong
  // with WHEN it fired, both of which point at transitions:
  //   - it measured from the moment of mount, which is exactly when another
  //     multi-megabyte cloud is being fetched and parsed on the same thread. The
  //     frames are slow because of THAT work, not because this cloud is too
  //     heavy to draw, and the cloud got punished for it.
  //   - a main-thread block (a parse, a GC pause, switching tabs) produces
  //     half-second frames. A GPU genuinely struggling produces 50-100ms ones.
  //     Both counted the same.
  // So: settle first, ignore stalls, need a longer streak — and let it climb
  // back up when the machine is plainly coping, instead of waiting for a reload.
  var qStep = 0, slowStreak = 0, fastStreak = 0, lastT = 0, settleUntil = 0;
  var basePixelRatio = renderer.getPixelRatio();
  function applyQuality() {
    if (qStep <= 0) {
      renderer.setPixelRatio(basePixelRatio);
      geometry.setDrawRange(0, drawCap);
    } else if (qStep === 1) {
      renderer.setPixelRatio(1);
      geometry.setDrawRange(0, drawCap);
    } else {
      renderer.setPixelRatio(1);
      var total = geometry.getAttribute("position").count;
      var target = Math.max(120000, Math.floor(total / Math.pow(2, qStep - 1)));
      geometry.setDrawRange(0, drawCap === Infinity ? target : Math.min(target, drawCap));
    }
    // fewer points read as a sparser object unless each one grows a little —
    // derived from the chosen size rather than multiplied in place, so stepping
    // back up returns to exactly the size that was chosen, not an accumulation
    material.size = introBaseSize * Math.pow(1.25, Math.max(0, qStep - 1));
  }
  function stepQualityDown() { if (qStep < 4) { qStep++; applyQuality(); } }
  function stepQualityUp() { if (qStep > 0) { qStep--; applyQuality(); } }
  (function frame(t) {
    if (disposed) return;
    if (INTRO_MS) {
      if (!introStart) introStart = t;
      var ik = Math.min(1, (t - introStart) / INTRO_MS);
      var ease = ik * ik * (3 - 2 * ik); // smoothstep: gentle start and landing
      geometry.setDrawRange(0, Math.max(1, Math.floor(introTotal * (0.05 + 0.95 * ease))));
      material.size = introBaseSize * (3.6 - 2.6 * ease);
      if (ik >= 1) {
        geometry.setDrawRange(0, drawCap);
        material.size = introBaseSize;
        INTRO_MS = 0;
      }
    } else {
      // give the cloud a moment to settle after mounting before judging it —
      // the build-in is running and, on a capture switch, the next scan is
      // still being fetched and parsed on this same thread
      if (!settleUntil) settleUntil = t + 1500;
      var dt = t - lastT;
      if (lastT && t > settleUntil && dt < 200) {
        if (dt > 40) { slowStreak++; fastStreak = 0; }
        else { fastStreak++; if (slowStreak > 0) slowStreak--; }
        if (slowStreak >= 20) { slowStreak = 0; stepQualityDown(); }
        else if (fastStreak >= 180 && qStep > 0) { fastStreak = 0; stepQualityUp(); }
      }
    }
    lastT = t;
    stepCameraTween(t);
    controls.update();
    renderer.render(scene, camera);
    frameCallbacks.forEach(function (cb) { cb(); });
    raf = requestAnimationFrame(frame);
  })(0);

  return {
    setPointSize: function (size) {
      material.size = size;
      // The build-in rewrites material.size on EVERY frame and finishes by
      // restoring its own starting value — so a size chosen during those two
      // seconds was applied, visibly ignored for the rest of the animation,
      // and then silently undone at the end. Since object.html applies a
      // capture's saved size the moment the cloud mounts, that is exactly
      // when it happened. Move the intro's target instead, so it eases toward
      // the newly chosen size and lands on it.
      introBaseSize = size;
      if (qStep > 0) applyQuality();
    },
    // what is ACTUALLY on screen right now — which is not always the saved
    // size, since a stale one gets replaced by the computed size above. The
    // slider seeds from this so it can never show one rung while the cloud
    // is drawn at another.
    getPointSize: function () { return material.size; },
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
    // frame a point after mounting — an object whose anchor is only worked out
    // once the cloud exists can still be zoomed to, not just one that already
    // had a stored anchor when the viewer was created
    focusAt: focusAt,
    // pull back to the whole cloud, animated — the "leaving" half of focusAt
    zoomOut: zoomOut,
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
    // A still of the cloud exactly as it is framed right now. A cloud drawn on
    // a transparent background is MOSTLY transparent — so if the read-back
    // comes back as a large opaque near-white sheet, the GPU handed back
    // something that is not this cloud, and handing it on would put a white
    // rectangle where the scan should be. Say so with null instead.
    screenshot: function () {
      renderer.render(scene, camera);
      var el = renderer.domElement;
      try {
        var probe = document.createElement("canvas");
        probe.width = 64; probe.height = 32;
        var pctx = probe.getContext("2d", { willReadFrequently: true });
        pctx.clearRect(0, 0, 64, 32);
        pctx.drawImage(el, 0, 0, 64, 32);
        var d = pctx.getImageData(0, 0, 64, 32).data;
        var total = d.length / 4, opaque = 0, light = 0;
        for (var i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 8) continue;
          opaque++;
          if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) light++;
        }
        if (opaque > total * 0.6 && light > opaque * 0.8) return null;
      } catch (e) {}
      return el.toDataURL("image/png");
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
