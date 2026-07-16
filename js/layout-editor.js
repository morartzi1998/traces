/*
  traces — manual layout editor

  She wants to reposition/resize the overlay cards herself (the white
  details panel, link-preview card, remark card, blue annotation panel,
  timeline) rather than describing coordinates back and forth. Turning on
  edit mode adds:
   - a drag handle + resize handle to every element carrying a
     data-editable="key" attribute (the card's own position/size)
   - a small blue "space above" handle + green "A" text-size handle to
     every direct child of a data-editable OR data-editable-rows container
     (data-editable-rows is for a container that needs per-row controls
     but isn't itself something she repositions, e.g. the blue panel's
     inner body)
   - for <hr> rows specifically, a hide/show toggle and a thickness handle
  Everything is stored in localStorage and applied on every load — visible
  immediately, without needing the edit UI active. A "Copy layout" button
  serializes it all to JSON so it can be handed over and hard-coded into
  the real CSS, after which this whole mechanism gets turned back off.
*/
(function () {
  var STORE_KEY = "traces-layout-overrides";
  var GAPS_KEY = "traces-layout-gaps";
  var FONTS_KEY = "traces-layout-fonts";
  var LINES_KEY = "traces-layout-lines";
  var ROW_CONTAINER_SELECTOR = "[data-editable], [data-editable-rows]";

  function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { return {}; }
  }
  function saveJSON(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
  }

  function rowContainerKey(el) {
    return el.dataset.editable || el.dataset.editableRows;
  }

  function isEditorChrome(el) {
    return el.classList.contains("layout-edit-handle") ||
      el.classList.contains("layout-edit-resize") ||
      el.classList.contains("layout-edit-gap-handle") ||
      el.classList.contains("layout-edit-font-handle") ||
      el.classList.contains("layout-edit-line-toggle") ||
      el.classList.contains("layout-edit-added-line");
  }

  function applyOverrides() {
    var overrides = loadJSON(STORE_KEY);
    document.querySelectorAll("[data-editable]").forEach(function (el) {
      var o = overrides[el.dataset.editable];
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
    var gaps = loadJSON(GAPS_KEY);
    document.querySelectorAll(ROW_CONTAINER_SELECTOR).forEach(function (container) {
      var key = rowContainerKey(container);
      Array.prototype.forEach.call(container.children, function (child, i) {
        if (isEditorChrome(child)) return;
        var g = gaps[key + ":" + i];
        if (g && g.marginTop != null) child.style.marginTop = g.marginTop + "px";
      });
    });
  }

  // same idea, for each row's own font-size
  function applyFonts() {
    var fonts = loadJSON(FONTS_KEY);
    document.querySelectorAll(ROW_CONTAINER_SELECTOR).forEach(function (container) {
      var key = rowContainerKey(container);
      Array.prototype.forEach.call(container.children, function (child, i) {
        if (isEditorChrome(child)) return;
        var f = fonts[key + ":" + i];
        if (f && f.fontSize != null) child.style.fontSize = f.fontSize + "px";
      });
    });
  }

  // <hr> divider rows: hidden (removed) or a custom thickness
  function applyLines() {
    var lines = loadJSON(LINES_KEY);
    document.querySelectorAll(ROW_CONTAINER_SELECTOR).forEach(function (container) {
      var key = rowContainerKey(container);
      Array.prototype.forEach.call(container.children, function (child, i) {
        if (isEditorChrome(child) || child.tagName !== "HR") return;
        var l = lines[key + ":" + i];
        if (!l) return;
        if (l.hidden) child.style.display = "none";
        if (l.thickness != null) child.style.borderTopWidth = l.thickness + "px";
      });
      // extra lines she added during editing, appended at the end
      var extra = lines[key + ":extra"] || 0;
      var already = container.querySelectorAll(":scope > hr.layout-edit-added-line").length;
      for (var n = already; n < extra; n++) {
        var hr = document.createElement("hr");
        hr.className = "layout-edit-added-line";
        container.appendChild(hr);
      }
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

  function dragMove(startEvent, onMove, onDone) {
    startEvent.preventDefault();
    var startX = startEvent.clientX, startY = startEvent.clientY;
    function move(e) {
      onMove(e.clientX - startX, e.clientY - startY);
      startX = e.clientX; startY = e.clientY;
    }
    function up() {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      if (onDone) onDone();
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  function addRowControls(container) {
    var containerKey = rowContainerKey(container);
    // snapshot first — an <hr> gets wrapped in a div below (browsers don't
    // reliably support <hr> holding child nodes, which broke click/drag on
    // its controls), and mutating container.children while iterating a
    // live list would shift indices for anything not yet visited
    var snapshot = Array.prototype.slice.call(container.children);
    snapshot.forEach(function (rawChild, i) {
      // guards re-running this on a container that's already wired up
      // (e.g. after "+ Add line" appends one more row) — without it,
      // every already-decorated row would get a second set of handles.
      // Marked on the FINAL row element (the <hr>'s wrapper, once one
      // exists) so a second pass recognizes it even though by then
      // container.children[i] is the wrapper, not the original <hr>.
      if (isEditorChrome(rawChild) || rawChild.dataset.layoutEditDone) return;

      var isLine = rawChild.tagName === "HR";
      var child = rawChild;
      if (isLine) {
        // <hr> can't reliably host the control buttons as children —
        // wrap it in a positioned div and put the controls there instead
        var wrap = document.createElement("div");
        wrap.className = "layout-edit-hr-wrap";
        rawChild.parentNode.insertBefore(wrap, rawChild);
        wrap.appendChild(rawChild);
        child = wrap;
      }
      child.dataset.layoutEditDone = "1";

      var cs = getComputedStyle(child);
      if (cs.position === "static") child.style.position = "relative";
      var rowKey = containerKey + ":" + i;

      var gapHandle = document.createElement("div");
      gapHandle.className = "layout-edit-gap-handle";
      gapHandle.title = "drag to adjust the space above this row";
      var startMargin = parseFloat(cs.marginTop) || 0;
      var gapLabel = document.createElement("span");
      gapLabel.className = "layout-edit-gap-label";
      gapLabel.textContent = Math.round(startMargin) + "px";
      gapHandle.appendChild(gapLabel);
      child.insertBefore(gapHandle, child.firstChild);

      gapHandle.addEventListener("mousedown", function (e) {
        e.stopPropagation();
        var base = parseFloat(child.style.marginTop) || startMargin;
        dragMove(e, function (dx, dy) {
          base = Math.max(0, base + dy);
          child.style.marginTop = base + "px";
          gapLabel.textContent = Math.round(base) + "px";
        }, function () {
          var gaps = loadJSON(GAPS_KEY);
          gaps[rowKey] = { marginTop: parseFloat(child.style.marginTop) || 0 };
          saveJSON(GAPS_KEY, gaps);
        });
      });

      // font size for this same row — dragged horizontally so it doesn't
      // fight with the (vertical) spacing drag
      var fontHandle = document.createElement("div");
      fontHandle.className = "layout-edit-font-handle";
      fontHandle.title = "drag sideways to resize this row's text";
      fontHandle.appendChild(document.createTextNode("A"));
      var startFont = parseFloat(cs.fontSize) || 14;
      var fontLabel = document.createElement("span");
      fontLabel.className = "layout-edit-gap-label layout-edit-font-label";
      fontLabel.textContent = Math.round(startFont) + "px";
      fontHandle.appendChild(fontLabel);
      child.insertBefore(fontHandle, child.firstChild);

      fontHandle.addEventListener("mousedown", function (e) {
        e.stopPropagation();
        var base = parseFloat(child.style.fontSize) || startFont;
        dragMove(e, function (dx) {
          base = Math.max(8, Math.min(72, base + dx * 0.3));
          child.style.fontSize = base + "px";
          fontLabel.textContent = Math.round(base) + "px";
        }, function () {
          var fonts = loadJSON(FONTS_KEY);
          fonts[rowKey] = { fontSize: parseFloat(child.style.fontSize) || startFont };
          saveJSON(FONTS_KEY, fonts);
        });
      });

      // <hr> dividers: remove (hide) and thickness, instead of gap/font —
      // these act on rawChild (the actual <hr>), not child (its wrapper)
      if (isLine) {
        gapHandle.style.background = "#999";
        fontHandle.hidden = true;
        var lineCs = getComputedStyle(rawChild);

        var lineToggle = document.createElement("button");
        lineToggle.type = "button";
        lineToggle.className = "layout-edit-line-toggle";
        lineToggle.textContent = "×";
        lineToggle.title = "hide this line";
        child.appendChild(lineToggle);
        lineToggle.addEventListener("mousedown", function (e) { e.stopPropagation(); });
        lineToggle.addEventListener("click", function () {
          var hidden = rawChild.style.display !== "none";
          rawChild.style.display = hidden ? "none" : "";
          lineToggle.title = hidden ? "show this line" : "hide this line";
          lineToggle.textContent = hidden ? "+" : "×";
          var lines = loadJSON(LINES_KEY);
          lines[rowKey] = lines[rowKey] || {};
          lines[rowKey].hidden = hidden;
          saveJSON(LINES_KEY, lines);
        });

        var thicknessHandle = document.createElement("div");
        thicknessHandle.className = "layout-edit-gap-handle layout-edit-thickness-handle";
        thicknessHandle.title = "drag to adjust this line's thickness";
        var startThickness = parseFloat(lineCs.borderTopWidth) || 1;
        var thickLabel = document.createElement("span");
        thickLabel.className = "layout-edit-gap-label";
        thickLabel.textContent = Math.round(startThickness) + "px";
        thicknessHandle.appendChild(thickLabel);
        child.appendChild(thicknessHandle);
        thicknessHandle.addEventListener("mousedown", function (e) {
          e.stopPropagation();
          var base = parseFloat(rawChild.style.borderTopWidth) || startThickness;
          dragMove(e, function (dx, dy) {
            base = Math.max(1, base + dy * 0.3);
            rawChild.style.borderTopWidth = base + "px";
            thickLabel.textContent = Math.round(base) + "px";
          }, function () {
            var lines = loadJSON(LINES_KEY);
            lines[rowKey] = lines[rowKey] || {};
            lines[rowKey].thickness = parseFloat(rawChild.style.borderTopWidth) || startThickness;
            saveJSON(LINES_KEY, lines);
          });
        });
      }
    });
  }

  function startEditMode() {
    var overrides = loadJSON(STORE_KEY);
    var editables = Array.prototype.slice.call(document.querySelectorAll("[data-editable]"));
    var rowContainers = Array.prototype.slice.call(document.querySelectorAll(ROW_CONTAINER_SELECTOR));

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

      handle.addEventListener("mousedown", function (e) {
        dragMove(e, function (dx, dy) {
          el.style.left = (el.offsetLeft + dx) + "px";
          el.style.top = (el.offsetTop + dy) + "px";
        }, function () {
          var r = el.getBoundingClientRect();
          overrides[el.dataset.editable] = {
            left: Math.round(r.left), top: Math.round(r.top),
            width: Math.round(r.width), height: Math.round(r.height),
          };
          saveJSON(STORE_KEY, overrides);
        });
      });

      resize.addEventListener("mousedown", function (e) {
        dragMove(e, function (dx, dy) {
          el.style.width = Math.max(120, el.offsetWidth + dx) + "px";
          el.style.height = Math.max(80, el.offsetHeight + dy) + "px";
        }, function () {
          var r = el.getBoundingClientRect();
          overrides[el.dataset.editable] = {
            left: Math.round(r.left), top: Math.round(r.top),
            width: Math.round(r.width), height: Math.round(r.height),
          };
          saveJSON(STORE_KEY, overrides);
        });
      });
    });

    rowContainers.forEach(addRowControls);

    var bar = document.createElement("div");
    bar.className = "layout-edit-bar";
    bar.innerHTML =
      '<span>⠇⠇ move card, red corner resize, blue = row spacing, green A = row text size, gray = line thickness/×.</span>' +
      '<span id="layoutEditSwitcher"></span>' +
      '<button type="button" id="layoutEditAddLine">+ Add line</button>' +
      '<button type="button" id="layoutEditCopy">Copy layout</button>' +
      '<button type="button" id="layoutEditReset">Reset</button>' +
      '<button type="button" id="layoutEditDone">Done</button>';
    document.body.appendChild(bar);

    // whitePanel / linkCard / remarkCard / bluePanel never appear together
    // in real use (each is a different situation) — showing all of them at
    // once during editing looks like duplicated/stacked cards, so only one
    // is visible at a time here too, switchable with these buttons
    var EXCLUSIVE = ["whitePanel", "linkCard", "remarkCard", "bluePanel"];
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

    function activeContainer() {
      var visible = exclusiveEls.filter(function (el) { return !el.hidden; })[0];
      return visible || editables[0];
    }

    document.getElementById("layoutEditAddLine").addEventListener("click", function () {
      var container = activeContainer();
      if (!container) return;
      var key = rowContainerKey(container) || container.dataset.editable;
      var lines = loadJSON(LINES_KEY);
      lines[key + ":extra"] = (lines[key + ":extra"] || 0) + 1;
      saveJSON(LINES_KEY, lines);
      var hr = document.createElement("hr");
      hr.className = "layout-edit-added-line";
      container.appendChild(hr);
      addRowControls(container);
    });

    document.getElementById("layoutEditCopy").addEventListener("click", function () {
      var json = JSON.stringify({
        cards: loadJSON(STORE_KEY),
        spacing: loadJSON(GAPS_KEY),
        fonts: loadJSON(FONTS_KEY),
        lines: loadJSON(LINES_KEY),
      }, null, 2);
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
      if (!confirm("Reset all card positions, row spacing, text sizes, and lines back to default?")) return;
      saveJSON(STORE_KEY, {});
      saveJSON(GAPS_KEY, {});
      saveJSON(FONTS_KEY, {});
      saveJSON(LINES_KEY, {});
      location.reload();
    });

    document.getElementById("layoutEditDone").addEventListener("click", function () {
      location.reload();
    });
  }

  window.LayoutEditor = { start: startEditMode, apply: applyOverrides };
  applyOverrides();
  applyGaps();
  applyFonts();
  applyLines();
})();
