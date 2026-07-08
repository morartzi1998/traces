/*
  traces — custom cursor
  A small white square follows the pointer. Over interactive elements
  (links, buttons, inputs) it turns the interface blue. Inside an element
  marked with [data-crosshair] (the 3D capture canvas on annotation
  screens), two perpendicular hairlines extend from the cursor to the
  edges of that element.

  Include on every screen: <script src="js/cursor.js" defer></script>
*/

(function () {
  // Touch-only devices keep the native behaviour.
  if (!window.matchMedia("(pointer: fine)").matches) return;

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
  document.body.appendChild(cursor);

  var INTERACTIVE =
    "a, button, [role='button'], input, textarea, select, label, [data-selectable]";

  document.addEventListener("mousemove", function (e) {
    cursor.style.left = e.clientX + "px";
    cursor.style.top = e.clientY + "px";

    var target = e.target;

    // Blue square over anything selectable.
    cursor.classList.toggle("cursor--active", !!target.closest(INTERACTIVE));

    // Crosshair inside a capture canvas.
    var zone = target.closest("[data-crosshair]");
    if (zone) {
      var r = zone.getBoundingClientRect();
      lineX.style.display = "block";
      lineY.style.display = "block";
      lineX.style.top = e.clientY + "px";
      lineX.style.left = r.left + "px";
      lineX.style.width = r.width + "px";
      lineY.style.left = e.clientX + "px";
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
})();
