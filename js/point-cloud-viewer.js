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
import { OrbitControls } from "./vendor/three/OrbitControls.js?v=20260719w";

export function mountPointCloudViewer(container, geometry, opts) {
  opts = opts || {};

  // preserveDrawingBuffer so screenshot() below can read back a frame
  // on demand instead of racing the render loop's own buffer swaps
  var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";
  container.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);

  geometry.computeBoundingSphere();
  var sphere = geometry.boundingSphere && geometry.boundingSphere.radius > 0
    ? geometry.boundingSphere
    : new THREE.Sphere(new THREE.Vector3(), 1);

  // pointSize is a plain absolute world-unit size, not scaled by the scan's
  // bounding-sphere radius: the camera itself already backs off
  // proportionally to that same radius (below), so a fixed size already
  // reads consistently across scan scales without also scaling it —
  // multiplying by radius on top of that double-counts the scale and
  // oversizes badly on a large scan (looks like a solid blob up close,
  // no per-point detail).
  var hasColor = !!geometry.getAttribute("color");
  var material = new THREE.PointsMaterial({
    size: opts.pointSize || 0.01,
    sizeAttenuation: true,
    vertexColors: hasColor,
    color: hasColor ? 0xffffff : 0xcccccc,
  });
  var points = new THREE.Points(geometry, material);
  scene.add(points);

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
  if (opts.initialView) {
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
  (function frame() {
    if (disposed) return;
    controls.update();
    renderer.render(scene, camera);
    frameCallbacks.forEach(function (cb) { cb(); });
    raf = requestAnimationFrame(frame);
  })();

  return {
    setPointSize: function (size) { material.size = size; },
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
