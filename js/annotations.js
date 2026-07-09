/*
  traces — capture annotations
  Click anywhere inside #captureCanvas to pin a note: the sidebar swaps
  from the cream "Describe what you captured" form to the blue "Describe
  your thought and memories in this particular annotations" panel, with a
  pending marker shown at the clicked spot. Save adds it to the
  annotations list (and the capture); Cancel reverts to the cream form.
*/

(function () {
  var canvas = document.getElementById("captureCanvas");
  var defaultSidebar = document.querySelector(".sidebar:not(.sidebar--blue)");
  var blueSidebar = document.getElementById("annotateSidebar");
  var list = document.getElementById("annotationList");
  var count = document.getElementById("annotationCount");
  if (!canvas || !list || !count || !blueSidebar || !defaultSidebar) return;

  var empty = list.querySelector(".annotations-empty");
  // the freshly-scanned capture already carries its annotations, shown as
  // pins on the object straight away (matches the object view).
  var annotations = [
    { x: 0.46, y: 0.72, title: "missing", text: "one bulb has been missing for years - we never replaced it." },
    { x: 0.58, y: 0.4, title: "lights", text: "there is something strange about the lights in the hallway. no matter how many times i change them, they never all work at the same time." },
  ];
  var pendingSpot = null;
  var pendingMarker = null;

  function render() {
    count.textContent = annotations.length;
    empty.style.display = annotations.length ? "none" : "";
    list.querySelectorAll(".annotation-row").forEach(function (n) { n.remove(); });
    canvas.querySelectorAll(".annotation-marker:not(.annotation-marker--pending)").forEach(function (n) { n.remove(); });

    annotations.forEach(function (a, i) {
      var marker = document.createElement("div");
      marker.className = "annotation-marker";
      marker.style.left = a.x * 100 + "%";
      marker.style.top = a.y * 100 + "%";
      var label = document.createElement("span");
      label.className = "label";
      label.textContent = a.title;
      marker.appendChild(label);
      canvas.appendChild(marker);

      var row = document.createElement("div");
      row.className = "annotation-row";
      var text = document.createElement("span");
      text.textContent = a.title;
      var remove = document.createElement("button");
      remove.className = "remove";
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove annotation");
      remove.textContent = "—";
      remove.addEventListener("click", function () {
        annotations.splice(i, 1);
        render();
      });
      row.appendChild(text);
      row.appendChild(remove);
      list.appendChild(row);
    });
  }

  function showPendingMarker(spot) {
    clearPendingMarker();
    pendingMarker = document.createElement("div");
    pendingMarker.className = "annotation-marker annotation-marker--pending";
    pendingMarker.style.left = spot.x * 100 + "%";
    pendingMarker.style.top = spot.y * 100 + "%";
    var label = document.createElement("span");
    label.className = "label";
    pendingMarker.appendChild(label);
    canvas.appendChild(pendingMarker);
  }

  function clearPendingMarker() {
    if (pendingMarker) {
      pendingMarker.remove();
      pendingMarker = null;
    }
  }

  function openBlue(spot) {
    pendingSpot = spot;
    showPendingMarker(spot);
    document.getElementById("daName").value = "";
    document.getElementById("daText").value = "";
    defaultSidebar.hidden = true;
    blueSidebar.hidden = false;
    document.getElementById("daName").focus();
  }

  function closeBlue() {
    blueSidebar.hidden = true;
    defaultSidebar.hidden = false;
    clearPendingMarker();
    pendingSpot = null;
  }

  canvas.addEventListener("click", function (e) {
    if (canvas.__suppressClick) return; // a drag on the capture, not a pick
    if (e.target.closest(".annotation-marker")) return;
    var r = canvas.getBoundingClientRect();
    openBlue({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  });

  document.getElementById("daCancel").addEventListener("click", closeBlue);
  document.getElementById("daSave").addEventListener("click", function () {
    var title = document.getElementById("daName").value.trim();
    var text = document.getElementById("daText").value.trim();
    if (title && pendingSpot) {
      annotations.push({ x: pendingSpot.x, y: pendingSpot.y, title: title, text: text });
      render();
    }
    closeBlue();
  });

  render();
})();
