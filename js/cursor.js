/*
  traces — custom cursor
  A small square follows the pointer, dragging a soft ink-like smear
  behind it on a canvas layer (blurred, tapering, fading over ~200ms).
  The square and the smear turn the interface blue over interactive
  elements (links, buttons, inputs), white otherwise. Inside an element
  marked with [data-crosshair] (the 3D capture canvas on annotation
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

  var canvas = null;
  var ctx = null;
  if (!reduceMotion) {
    canvas = document.createElement("canvas");
    canvas.className = "cursor-smear";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");

    function resize() {
      canvas.width = window.innerWidth * window.devicePixelRatio;
      canvas.height = window.innerHeight * window.devicePixelRatio;
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);
  }

  document.body.appendChild(cursor);

  var INTERACTIVE =
    "a, button, [role='button'], input, textarea, select, label, [data-selectable]";

  var mouseX = -100;
  var mouseY = -100;
  var isActive = false;
  var LIFETIME = 220; // ms the smear takes to fully fade
  var points = []; // { x, y, t }

  document.addEventListener("mousemove", function (e) {
    mouseX = e.clientX;
    mouseY = e.clientY;
    cursor.style.left = mouseX + "px";
    cursor.style.top = mouseY + "px";

    if (ctx) points.push({ x: mouseX, y: mouseY, t: performance.now() });

    // over some targets (the page itself, text nodes inside shadow trees)
    // there is no .closest — walk up to the nearest real element instead
    var target = e.target;
    if (target && typeof target.closest !== "function") target = target.parentElement;
    if (!target || typeof target.closest !== "function") return;

    // Blue square (and smear) over anything selectable.
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

  if (ctx) {
    (function paint() {
      var now = performance.now();
      while (points.length && now - points[0].t > LIFETIME) points.shift();

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (points.length > 1) {
        var color = isActive ? "10, 37, 180" : "240, 238, 234"; // rgb of --color-caption-blue / --color-cream
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.filter = "blur(0.6px)";

        for (var i = 1; i < points.length; i++) {
          var p0 = points[i - 1];
          var p1 = points[i];
          var age = (now - p1.t) / LIFETIME; // 0 = fresh, 1 = expired
          var fade = Math.max(0, 1 - age);
          ctx.globalAlpha = Math.min(1, fade * 1.1);
          ctx.lineWidth = Math.max(0.6, 3 * fade);
          ctx.strokeStyle = "rgb(" + color + ")";
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.filter = "none";
      }
      requestAnimationFrame(paint);
    })();
  }
})();
