/*
  traces — manual layout editor

  She wants to reposition/resize the overlay cards herself (the white
  details panel, link-preview card, remark card, timeline) rather than
  describing coordinates back and forth. Turning on edit mode adds a drag
  handle + resize handle to every element carrying a data-editable="key"
  attribute; positions are stored in localStorage (as left/top/width/height
  overrides in px) and applied on every load — visible immediately, without
  needing the edit UI active. A "copy layout" button in the edit bar
  serializes the current overrides to JSON so she can hand them to me, after
  which I hard-code the values into the real CSS and this whole mechanism
  gets turned back off.
*/
(function () {
  var STORE_KEY = "traces-layout-overrides";

  function loadOverrides() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveOverrides(overrides) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(overrides)); } catch (e) {}
  }

  function applyOverrides() {
    var overrides = loadOverrides();
    document.querySelectorAll("[data-editable]").forEach(function (el) {
      var key = el.dataset.editable;
      var o = overrides[key];
      if (!o) return;
      if (o.left != null) { el.style.left = o.left + "px"; el.style.right = "auto"; }
      if (o.top != null) { el.style.top = o.top + "px"; el.style.bottom = "auto"; }
      if (o.width != null) el.style.width = o.width + "px";
      if (o.height != null) el.style.height = o.height + "px";
    });
  }

  function startEditMode() {
    var overrides = loadOverrides();
    var editables = Array.prototype.slice.call(document.querySelectorAll("[data-editable]"));

    editables.forEach(function (el) {
      // dragging/resizing needs a fixed pixel starting point, whatever
      // mix of vw/vh/right/bottom the real CSS is using
      var rect = el.getBoundingClientRect();
      if (!el.style.left) { el.style.left = rect.left + "px"; el.style.right = "auto"; }
      if (!el.style.top) { el.style.top = rect.top + "px"; el.style.bottom = "auto"; }

      var handle = document.createElement("div");
      handle.className = "layout-edit-handle";
      handle.textContent = "⠇⠇";
      handle.title = "drag to move";
      el.appendChild(handle);

      var resize = document.createElement("div");
      resize.className = "layout-edit-resize";
      resize.title = "drag to resize";
      el.appendChild(resize);

      el.classList.add("layout-editing");

      function persist() {
        var r = el.getBoundingClientRect();
        overrides[el.dataset.editable] = {
          left: Math.round(r.left),
          top: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
        saveOverrides(overrides);
      }

      function dragMove(startEvent, onMove) {
        startEvent.preventDefault();
        var startX = startEvent.clientX, startY = startEvent.clientY;
        function move(e) {
          onMove(e.clientX - startX, e.clientY - startY);
          startX = e.clientX; startY = e.clientY;
        }
        function up() {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          persist();
        }
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      }

      handle.addEventListener("mousedown", function (e) {
        dragMove(e, function (dx, dy) {
          el.style.left = (el.offsetLeft + dx) + "px";
          el.style.top = (el.offsetTop + dy) + "px";
        });
      });

      resize.addEventListener("mousedown", function (e) {
        dragMove(e, function (dx, dy) {
          el.style.width = Math.max(120, el.offsetWidth + dx) + "px";
          el.style.height = Math.max(80, el.offsetHeight + dy) + "px";
        });
      });
    });

    var bar = document.createElement("div");
    bar.className = "layout-edit-bar";
    bar.innerHTML =
      '<span>Editing card layout — drag the ⠇⠇ handles to move, corners to resize.</span>' +
      '<button type="button" id="layoutEditCopy">Copy layout</button>' +
      '<button type="button" id="layoutEditReset">Reset</button>' +
      '<button type="button" id="layoutEditDone">Done</button>';
    document.body.appendChild(bar);

    document.getElementById("layoutEditCopy").addEventListener("click", function () {
      var json = JSON.stringify(loadOverrides(), null, 2);
      var box = document.getElementById("layoutEditJson");
      if (!box) {
        box = document.createElement("textarea");
        box.id = "layoutEditJson";
        box.className = "layout-edit-json";
        document.body.appendChild(box);
      }
      box.value = json;
      box.hidden = false;
      box.focus();
      box.select();
      try { navigator.clipboard.writeText(json); } catch (e) {}
    });

    document.getElementById("layoutEditReset").addEventListener("click", function () {
      if (!confirm("Reset all card positions back to default?")) return;
      saveOverrides({});
      location.reload();
    });

    document.getElementById("layoutEditDone").addEventListener("click", function () {
      location.reload();
    });
  }

  window.LayoutEditor = { start: startEditMode, apply: applyOverrides };
  applyOverrides();
})();
