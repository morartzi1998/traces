/*
  traces — capture annotations
  Click anywhere inside #captureCanvas to pin a note: the sidebar swaps
  from the cream "Describe what you captured" form to the blue "Describe
  your thought and memories in this particular annotations" panel, with a
  pending marker shown at the clicked spot. Save adds it to the
  annotations list (and the capture); Cancel reverts to the cream form.

  A pinned note is anchored to the actual 3D surface it was placed on, so it
  stays stuck to the object while you turn it — a model-viewer hotspot for a
  mesh, a re-projected marker for a point cloud. A flat photo has no depth to
  anchor to, so there it stays at the 2D spot it was placed.
*/

(function () {
  var canvas = document.getElementById("captureCanvas");
  var defaultSidebar = document.querySelector(".sidebar:not(.sidebar--blue)");
  var blueSidebar = document.getElementById("annotateSidebar");
  var list = document.getElementById("annotationList");
  var count = document.getElementById("annotationCount");
  if (!canvas || !list || !count || !blueSidebar || !defaultSidebar) return;

  var mv = document.getElementById("captureModel");
  var empty = list.querySelector(".annotations-empty");
  var hint = document.querySelector(".annotations-hint");
  var emptyRuleTop = document.getElementById("annotationsEmptyRuleTop");
  var emptyRuleBottom = document.getElementById("annotationsEmptyRuleBottom");
  // a fresh capture starts with NO annotations — the user adds their own
  var annotations = [];
  var pendingSpot = null;
  var pendingMarker = null;
  var editingIndex = -1; // >= 0 while editing an existing annotation
  var frameUnsubs = []; // point-cloud projection loops to tear down on re-render

  function pcv() { return window.__pcViewer || null; }
  function modelActive() { return !!(mv && !mv.hidden); }
  function pointsActive() { return !!pcv(); }

  function vec3ToStr(v) { return v.x + " " + v.y + " " + v.z; }
  function strToVec3(s) { var p = (s || "").split(" ").map(Number); return { x: p[0] || 0, y: p[1] || 0, z: p[2] || 0 }; }

  // the best 3D anchor for a screen click: a mesh gives a position + surface
  // normal (model-viewer), a point cloud gives a world position (raycast).
  // Returns the fields to store on the spot, or {} when there's nothing 3D to
  // hit (a flat photo, or the ray missed the object).
  function anchorAt(clientX, clientY) {
    if (modelActive() && mv.positionAndNormalFromPoint) {
      try {
        var h = mv.positionAndNormalFromPoint(clientX, clientY);
        if (h && h.position) return { pos: h.position.toString(), normal: h.normal ? h.normal.toString() : null };
      } catch (e) {}
    }
    if (pointsActive() && pcv().raycastFromScreen) {
      try {
        var hit = pcv().raycastFromScreen(clientX, clientY);
        if (hit) return { ppos: vec3ToStr(hit) };
      } catch (e) {}
    }
    return {};
  }

  // build one marker for a spot, anchored however it can be. onClick (optional)
  // makes it editable. pending markers carry no label text yet.
  function buildMarker(a, onClick, pending) {
    var cls = "annotation-marker" + (pending ? " annotation-marker--pending" : "");
    function withLabel(el) {
      el.className = cls;
      var label = document.createElement("span");
      label.className = "label";
      if (!pending) label.textContent = a.title || "";
      el.appendChild(label);
      if (onClick) {
        el.style.cursor = "pointer";
        el.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
      }
      return el;
    }

    // a mesh: a real model-viewer hotspot, positioned automatically as it turns
    if (a.pos && modelActive()) {
      var m = withLabel(document.createElement("div"));
      m.setAttribute("slot", pending ? "hotspot-pending" : ("hotspot-a" + Math.random().toString(36).slice(2)));
      m.dataset.position = a.pos;
      if (a.normal) m.dataset.normal = a.normal;
      mv.appendChild(m);
      return m;
    }
    // a point cloud: re-project the stored world point every frame
    if (a.ppos && pointsActive()) {
      var pm = withLabel(document.createElement("div"));
      canvas.appendChild(pm);
      var world = strToVec3(a.ppos);
      var upd = function () {
        var proj = pcv().project(world);
        pm.style.display = proj.behind ? "none" : "";
        pm.style.left = proj.x * 100 + "%";
        pm.style.top = proj.y * 100 + "%";
      };
      upd();
      if (pcv().onFrame) frameUnsubs.push(pcv().onFrame(upd));
      return pm;
    }
    // a flat photo (or a missed ray): the 2D spot it was placed at
    var fm = withLabel(document.createElement("div"));
    fm.style.left = (a.x != null ? a.x : 0.5) * 100 + "%";
    fm.style.top = (a.y != null ? a.y : 0.5) * 100 + "%";
    canvas.appendChild(fm);
    return fm;
  }

  function clearMarkers() {
    canvas.querySelectorAll(".annotation-marker:not(.annotation-marker--pending)").forEach(function (n) { n.remove(); });
    if (mv) mv.querySelectorAll('[slot^="hotspot-"]').forEach(function (n) {
      if (!n.classList.contains("annotation-marker--pending")) n.remove();
    });
    frameUnsubs.forEach(function (u) { try { u(); } catch (e) {} });
    frameUnsubs = [];
  }

  function render() {
    count.textContent = annotations.length;
    empty.style.display = annotations.length ? "none" : "";
    // the hint and the dotted brackets around "no annotations yet" only
    // make sense while there's nothing yet to look at — once real
    // annotations exist, their own solid row separators take over
    if (hint) hint.style.display = annotations.length ? "none" : "";
    if (emptyRuleTop) emptyRuleTop.style.display = annotations.length ? "none" : "";
    if (emptyRuleBottom) emptyRuleBottom.style.display = annotations.length ? "none" : "";
    list.querySelectorAll(".annotation-row").forEach(function (n) { n.remove(); });
    clearMarkers();

    annotations.forEach(function (a, i) {
      buildMarker(a, function () { openEdit(i); }, false);

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
    pendingMarker = buildMarker(spot, null, true);
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
    pendingSpot = { x: a.x, y: a.y, pos: a.pos, normal: a.normal, ppos: a.ppos };
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
    var spot = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    // anchor the pin to the actual 3D surface under the cursor when there is
    // one, so it stays stuck to the object as it's turned
    var anchor = anchorAt(e.clientX, e.clientY);
    if (anchor.pos) { spot.pos = anchor.pos; spot.normal = anchor.normal; }
    if (anchor.ppos) spot.ppos = anchor.ppos;
    openBlue(spot);
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
        annotations.push({
          x: pendingSpot.x, y: pendingSpot.y,
          pos: pendingSpot.pos || null, normal: pendingSpot.normal || null,
          ppos: pendingSpot.ppos || null,
          title: title, text: text
        });
      }
      render();
    }
    closeBlue();
  });

  // expose the current annotations so "Save to archive" can store them with
  // the capture (the array is mutated in place, so this stays current). The
  // 3D anchor (pos/normal for a mesh, ppos for a point cloud) rides along so
  // the object view can re-pin it to the same spot on the surface.
  window.getCaptureAnnotations = function () {
    return annotations.map(function (a) {
      return {
        x: a.x, y: a.y, title: a.title, text: a.text, type: a.type || "story", since: 2021,
        pos: a.pos || null, normal: a.normal || null, ppos: a.ppos || null
      };
    });
  };

  render();
})();
