/*
  traces — drag-to-rotate capture
  Lets a captured photo be "handled" like a real object: dragging tilts it
  in 3D (rotateX/rotateY via CSS perspective), scroll zooms it. The photo
  itself stays a crisp flat image — this fakes the object's volume through
  motion rather than a sparse point cloud.

  usage: initTilt3D(containerEl, imgEl)
  After a drag (not just a click), containerEl.__suppressClick is set for
  one tick so callers can skip a click-to-annotate handler on that same
  container.
*/

function initTilt3D(container, img) {
  var rotX = 0, rotY = 0, tX = 0, tY = 0;
  var zoom = 1, tZoom = 1;
  var dragging = false;
  var lx = 0, ly = 0, moved = 0;
  // the custom square cursor sets cursor:none globally; don't fight it
  // with an inline grab/grabbing icon when it's active.
  var ownsCursor = !document.documentElement.classList.contains("has-custom-cursor");

  container.style.perspective = "1400px";
  img.style.transformStyle = "preserve-3d";
  img.style.willChange = "transform";
  if (ownsCursor) container.style.cursor = "grab";

  container.addEventListener("pointerdown", function (e) {
    if (container.dataset.mode === "model") return; // model-viewer handles its own orbit
    dragging = true;
    moved = 0;
    lx = e.clientX;
    ly = e.clientY;
    try { container.setPointerCapture(e.pointerId); } catch (err) {}
    if (ownsCursor) container.style.cursor = "grabbing";
  });

  container.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    var dx = e.clientX - lx;
    var dy = e.clientY - ly;
    moved += Math.abs(dx) + Math.abs(dy);
    tY += dx * 0.3;
    tX = Math.max(-35, Math.min(35, tX - dy * 0.3));
    lx = e.clientX;
    ly = e.clientY;
  });

  function release() {
    if (dragging && moved > 6) {
      container.__suppressClick = true;
      setTimeout(function () { container.__suppressClick = false; }, 0);
    }
    dragging = false;
    if (ownsCursor) container.style.cursor = "grab";
  }

  container.addEventListener("pointerup", release);
  container.addEventListener("pointerleave", release);

  container.addEventListener("wheel", function (e) {
    if (container.dataset.mode === "model") return;
    e.preventDefault();
    tZoom = Math.max(0.6, Math.min(1.8, tZoom * (e.deltaY > 0 ? 0.94 : 1.06)));
  }, { passive: false });

  (function frame() {
    if (!img.isConnected) return;
    rotX += (tX - rotX) * 0.15;
    rotY += (tY - rotY) * 0.15;
    zoom += (tZoom - zoom) * 0.15;
    img.style.transform =
      "rotateX(" + -rotX + "deg) rotateY(" + rotY + "deg) scale(" + zoom + ")";
    requestAnimationFrame(frame);
  })();
}
