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
  // a fresh capture starts with NO annotations — the user adds their own
  var annotations = [];
  var pendingSpot = null;
  var pendingMarker = null;
  var editingIndex = -1; // >= 0 while editing an existing annotation

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
      marker.style.cursor = "pointer";
      marker.addEventListener("click", function (e) { e.stopPropagation(); openEdit(i); });
      canvas.appendChild(marker);

      var row = document.createElement("div");
      row.className = "annotation-row";
      var text = document.createElement("span");
      text.textContent = a.title;
      text.style.cursor = "pointer";
      text.title = "Edit annotation";
      text.addEventListener("click", function () { openEdit(i); });
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
    editingIndex = -1;
    pendingSpot = spot;
    showPendingMarker(spot);
    document.getElementById("daName").value = "";
    document.getElementById("daText").value = "";
    defaultSidebar.hidden = true;
    blueSidebar.hidden = false;
    document.getElementById("daName").focus();
  }

  function openEdit(i) {
    editingIndex = i;
    var a = annotations[i];
    pendingSpot = { x: a.x, y: a.y };
    showPendingMarker(pendingSpot);
    document.getElementById("daName").value = a.title || "";
    document.getElementById("daText").value = a.text || "";
    defaultSidebar.hidden = true;
    blueSidebar.hidden = false;
    document.getElementById("daName").focus();
  }

  function closeBlue() {
    blueSidebar.hidden = true;
    defaultSidebar.hidden = false;
    clearPendingMarker();
    pendingSpot = null;
    editingIndex = -1;
  }

  // tilt3d sets __suppressClick after drags on the flat-photo path, but a
  // model-viewer or point-cloud capture handles its own drag-to-orbit — the
  // click that browsers fire at the END of that drag would otherwise open
  // the annotation panel on every orbit. Track drag distance here directly
  // so every capture type gets the same "a drag is not a pick" guard.
  var downAt = null;
  canvas.addEventListener("pointerdown", function (e) {
    downAt = { x: e.clientX, y: e.clientY };
  }, true);
  canvas.addEventListener("pointerup", function (e) {
    if (downAt && Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 6) {
      canvas.__suppressClick = true;
      setTimeout(function () { canvas.__suppressClick = false; }, 0);
    }
    downAt = null;
  }, true);

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
      if (editingIndex >= 0 && annotations[editingIndex]) {
        annotations[editingIndex].title = title;
        annotations[editingIndex].text = text;
      } else {
        annotations.push({ x: pendingSpot.x, y: pendingSpot.y, title: title, text: text });
      }
      render();
    }
    closeBlue();
  });

  // expose the current annotations so "Save to archive" can store them with
  // the capture (the array is mutated in place, so this stays current)
  window.getCaptureAnnotations = function () {
    return annotations.map(function (a) {
      return { x: a.x, y: a.y, title: a.title, text: a.text, type: a.type || "story", since: 2021 };
    });
  };

  render();
})();
