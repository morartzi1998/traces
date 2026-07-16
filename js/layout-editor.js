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
  var GAPS_KEY = "traces-layout-gaps";

  function loadOverrides() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveOverrides(overrides) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(overrides)); } catch (e) {}
  }
  function loadGaps() {
    try { return JSON.parse(localStorage.getItem(GAPS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveGaps(gaps) {
    try { localStorage.setItem(GAPS_KEY, JSON.stringify(gaps)); } catch (e) {}
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

  // the space between two ROWS inside a card (e.g. between "type of capture"
  // and "what are you feeling") isn't the card's own position/size — it's
  // each child's own margin-top. Applied by (containerKey + ":" + child
  // index), since most rows don't have their own id.
  function applyGaps() {
    var gaps = loadGaps();
    document.querySelectorAll("[data-editable]").forEach(function (container) {
      var containerKey = container.dataset.editable;
      Array.prototype.forEach.call(container.children, function (child, i) {
        if (child.classList.contains("layout-edit-handle") ||
            child.classList.contains("layout-edit-resize") ||
            child.classList.contains("layout-edit-gap-handle")) return;
        var g = gaps[containerKey + ":" + i];
        if (g && g.marginTop != null) child.style.marginTop = g.marginTop + "px";
      });
    });
  }

    // a hidden element (display:none) has no layout, so measuring its
    // position via getBoundingClientRect() while hidden gives (0,0) — only
    // safe to seed once it's actually visible (called eagerly below for
    // cards already shown, and again from the switcher when one is toggled on)
    function seedPosition(el) {
      if (el.hidden || el.style.left) return;
      var rect = el.getBoundingClientRect();
      el.style.left = rect.left + "px"; el.style.right = "auto";
      el.style.top = rect.top + "px"; el.style.bottom = "auto";
    }

  function startEditMode() {
    var overrides = loadOverrides();
    var editables = Array.prototype.slice.call(document.querySelectorAll("[data-editable]"));

    editables.forEach(function (el) {
      seedPosition(el);

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

      // the space BETWEEN rows inside a card (between "type of capture" and
      // "what are you feeling", etc.) is each row's own margin-top — give
      // every direct child its own small drag-to-adjust handle
      var containerKey = el.dataset.editable;
      Array.prototype.forEach.call(el.children, function (child, i) {
        if (child.classList.contains("layout-edit-handle") ||
            child.classList.contains("layout-edit-resize") ||
            child.classList.contains("layout-edit-gap-handle")) return;
        var cs = getComputedStyle(child);
        if (cs.position === "static") child.style.position = "relative";

        var gapHandle = document.createElement("div");
        gapHandle.className = "layout-edit-gap-handle";
        gapHandle.title = "drag to adjust the space above this row";
        var startMargin = parseFloat(cs.marginTop) || 0;
        var label = document.createElement("span");
        label.className = "layout-edit-gap-label";
        label.textContent = Math.round(startMargin) + "px";
        gapHandle.appendChild(label);
        child.insertBefore(gapHandle, child.firstChild);

        var gapKey = containerKey + ":" + i;

        function persistGap() {
          var gaps = loadGaps();
          gaps[gapKey] = { marginTop: parseFloat(child.style.marginTop) || 0 };
          saveGaps(gaps);
        }

        gapHandle.addEventListener("mousedown", function (e) {
          e.stopPropagation();
          var base = parseFloat(child.style.marginTop) || startMargin;
          dragMove(e, function (dx, dy) {
            base = Math.max(0, base + dy);
            child.style.marginTop = base + "px";
            label.textContent = Math.round(base) + "px";
          });
          // dragMove's own mouseup already persists the card position;
          // hook a second listener to also persist this row's gap
          document.addEventListener("mouseup", persistGap, { once: true });
        });
      });
    });

    var bar = document.createElement("div");
    bar.className = "layout-edit-bar";
    bar.innerHTML =
      '<span>⠇⠇ red = move card, red corner = resize card, blue square = space above this row.</span>' +
      '<span id="layoutEditSwitcher"></span>' +
      '<button type="button" id="layoutEditCopy">Copy layout</button>' +
      '<button type="button" id="layoutEditReset">Reset</button>' +
      '<button type="button" id="layoutEditDone">Done</button>';
    document.body.appendChild(bar);

    // whitePanel / linkCard / remarkCard never appear together in real use
    // (each is a different situation) — showing all of them at once during
    // editing looks like duplicated/stacked cards, so only one is visible
    // at a time here too, switchable with these buttons
    var EXCLUSIVE = ["whitePanel", "linkCard", "remarkCard"];
    var exclusiveEls = editables.filter(function (el) {
      return EXCLUSIVE.indexOf(el.dataset.editable) !== -1;
    });
    if (exclusiveEls.length > 1) {
      var switcher = document.getElementById("layoutEditSwitcher");
      exclusiveEls.forEach(function (el) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = el.dataset.editable;
        btn.addEventListener("click", function () {
          exclusiveEls.forEach(function (other) { other.hidden = other !== el; });
          seedPosition(el);
        });
        switcher.appendChild(btn);
      });
    }

    document.getElementById("layoutEditCopy").addEventListener("click", function () {
      var json = JSON.stringify({ cards: loadOverrides(), spacing: loadGaps() }, null, 2);
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
      if (!confirm("Reset all card positions and row spacing back to default?")) return;
      saveOverrides({});
      saveGaps({});
      location.reload();
    });

    document.getElementById("layoutEditDone").addEventListener("click", function () {
      location.reload();
    });
  }

  window.LayoutEditor = { start: startEditMode, apply: applyOverrides };
  applyOverrides();
  applyGaps();
})();
