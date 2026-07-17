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
import { OrbitControls } from "./vendor/three/OrbitControls.js?v=20260717as";

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

  // pointSize is expressed as a fraction of the scan's own scale (its
  // bounding-sphere radius), not an absolute world-unit size — a fixed
  // absolute size that reads as a reasonable dot on a chair-sized object
  // is completely imperceptible against a multi-metre room scan, and the
  // density slider it drives would visibly do nothing on anything larger
  // than roughly object-sized
  var sizeScale = sphere.radius || 1;
  var hasColor = !!geometry.getAttribute("color");
  var material = new THREE.PointsMaterial({
    size: (opts.pointSize || 0.01) * sizeScale,
    sizeAttenuation: true,
    vertexColors: hasColor,
    color: hasColor ? 0xffffff : 0xcccccc,
  });
  var points = new THREE.Points(geometry, material);
  scene.add(points);

  var controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).add(new THREE.Vector3(0, 0, sphere.radius * 2.4 || 3));
  camera.near = Math.max(sphere.radius * 0.005, 0.001);
  camera.far = (sphere.radius || 1) * 30;
  camera.updateProjectionMatrix();
  // default zoomSpeed (1) reads as barely responding on a scan-sized scene —
  // scrolling should visibly close the distance in a couple of ticks, and
  // minDistance needs to allow getting genuinely close (matching camera.near)
  // instead of stopping well short of it, since "inspect fine detail up
  // close" is the whole point of this viewer
  controls.zoomSpeed = 4;
  controls.minDistance = Math.max(sphere.radius * 0.01, 0.005);
  controls.maxDistance = (sphere.radius || 1) * 15;
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.update();

  // hold Space + drag to pan (Blender-style temporary pan), instead of the
  // default left-drag orbit — OrbitControls already has real pan behaviour
  // wired to the right mouse button, so this just remaps the left button to
  // it for as long as Space is held, rather than reimplementing pan by hand
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

  var raf = null;
  var disposed = false;
  (function frame() {
    if (disposed) return;
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  })();

  return {
    setPointSize: function (size) { material.size = size * sizeScale; },
    resize: resize,
    screenshot: function () {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL("image/png");
    },
    dispose: function () {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      controls.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}
