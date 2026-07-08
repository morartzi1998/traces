/*
  traces — custom cursor
  A small square follows the pointer, leaving a short trail of shrinking,
  fading squares behind it. The whole trail turns the interface blue over
  interactive elements (links, buttons, inputs), white otherwise. Inside an
  element marked with [data-crosshair] (the 3D capture canvas on annotation
  screens), two perpendicular hairlines extend from the cursor to the
  edges of that element.

  Include on every screen: <script src="js/cursor.js" defer></script>
*/

(function () {
  // Touch-only devices keep the native behaviour.
  if (!window.matchMedia("(pointer: fine)").matches) return;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.documentElement.classList.add("has-custom-cursor");

  var cursor = document.createElement("div");
  cursor.className = "cursor";
  cursor.setAttribute("aria-hidden", "true");

  var lineX = document.createElement("div");
  lineX.className = "cursor-line cursor-line--x";
  var lineY = document.createElement("div");
  lineY.className = "cursor-line cursor-line--y";
  lineX.setAttribute("aria-hidden", "true");
  lineY.setAttribute("aria-hidden", "true");

  document.body.appendChild(lineX);
  document.body.appendChild(lineY);

  // Trail: a handful of squares that lag behind the cursor, each one
  // chasing the point ahead of it, shrinking and fading with distance.
  var TRAIL_LENGTH = reduceMotion ? 0 : 6;
  var trail = [];
  for (var i = 0; i < TRAIL_LENGTH; i++) {
    var seg = document.createElement("div");
    seg.className = "cursor-trail";
    seg.setAttribute("aria-hidden", "true");
    var size = 11 - i * 1.3;
    seg.style.width = size + "px";
    seg.style.height = size + "px";
    seg.style.opacity = (0.5 - i * 0.075).toFixed(2);
    document.body.appendChild(seg);
    trail.push({ el: seg, x: -100, y: -100, size: size });
  }

  document.body.appendChild(cursor);

  var INTERACTIVE =
    "a, button, [role='button'], input, textarea, select, label, [data-selectable]";

  var mouseX = -100;
  var mouseY = -100;
  var isActive = false;

  document.addEventListener("mousemove", function (e) {
    mouseX = e.clientX;
    mouseY = e.clientY;
    cursor.style.left = mouseX + "px";
    cursor.style.top = mouseY + "px";

    var target = e.target;

    // Blue square (and trail) over anything selectable.
    isActive = !!target.closest(INTERACTIVE);
    cursor.classList.toggle("cursor--active", isActive);

    // Crosshair inside a capture canvas.
    var zone = target.closest("[data-crosshair]");
    if (zone) {
      var r = zone.getBoundingClientRect();
      lineX.style.display = "block";
      lineY.style.display = "block";
      lineX.style.top = mouseY + "px";
      lineX.style.left = r.left + "px";
      lineX.style.width = r.width + "px";
      lineY.style.left = mouseX + "px";
      lineY.style.top = r.top + "px";
      lineY.style.height = r.height + "px";
      cursor.classList.add("cursor--crosshair");
    } else {
      lineX.style.display = "none";
      lineY.style.display = "none";
      cursor.classList.remove("cursor--crosshair");
    }
  });

  document.addEventListener("mouseleave", function () {
    cursor.style.display = "none";
    lineX.style.display = "none";
    lineY.style.display = "none";
  });

  document.addEventListener("mouseenter", function () {
    cursor.style.display = "block";
  });

  if (TRAIL_LENGTH) {
    (function animateTrail() {
      var leadX = mouseX;
      var leadY = mouseY;
      for (var i = 0; i < trail.length; i++) {
        var seg = trail[i];
        seg.x += (leadX - seg.x) * 0.32;
        seg.y += (leadY - seg.y) * 0.32;
        seg.el.style.transform =
          "translate(" + (seg.x - seg.size / 2) + "px, " + (seg.y - seg.size / 2) + "px)";
        seg.el.classList.toggle("cursor-trail--active", isActive);
        leadX = seg.x;
        leadY = seg.y;
      }
      requestAnimationFrame(animateTrail);
    })();
  }
})();
