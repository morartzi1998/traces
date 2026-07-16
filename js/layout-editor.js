/*
  traces — manual layout editor (v2)

  First version put a small icon directly on every single row (spacing,
  font-size, line thickness) — it covered the real content and made the
  card unreadable while editing, and it only reached rows inside four
  pre-marked cards, not the page title or anything else. Rebuilt around
  two separate, simpler ideas:

  1. The four overlay cards (white details panel, link-preview card,
     remark card, blue annotation panel) plus the timeline can be dragged
     and resized directly — a small red handle + red corner, same as
     before. Only one of the four cards shows at a time (switchable),
     since they never appear together in real use.

  2. Everything else — including the four cards' own contents, the page
     title, "updated N days ago", literally anything — is edited by
     clicking on it (a dashed outline appears on hover in edit mode) and
     adjusting it from a fixed side panel: space above, font size, hidden,
     and (for a divider line) its thickness. No icons sit on the content
     itself, so nothing is obscured.

  Everything is stored in localStorage and applied on every load — visible
  immediately, without needing edit mode active. "Copy layout" serializes
  it all to JSON so it can be handed over and hard-coded into the real
  CSS, after which this whole mechanism gets turned back off.
*/
(function () {
  var CARDS_KEY = "traces-layout-overrides"; // card position/size, keyed by data-editable
  var PROPS_KEY = "traces-layout-props";     // everything else, keyed by a DOM path

  function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { return {}; }
  }
  function saveJSON(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
  }

  // a reproducible address for an element, so the SAME element gets the
  // same key across reloads without needing every editable thing to carry
  // its own id: walk up to the nearest ancestor that already has one, then
  // record child-indices down to the target
  function pathKey(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) { parts.unshift(node.id); return parts.join("/"); }
      var parent = node.parentElement;
      if (!parent) return null;
      parts.unshift(Array.prototype.indexOf.call(parent.children, node));
      node = parent;
    }
    return null;
  }

  function resolvePath(key) {
    var parts = key.split("/");
    var node = document.getElementById(parts[0]);
    for (var i = 1; i < parts.length && node; i++) {
      node = node.children[parseInt(parts[i], 10)];
    }
    return node || null;
  }

  function applyOverrides() {
    var overrides = loadJSON(CARDS_KEY);
    document.querySelectorAll("[data-editable]").forEach(function (el) {
      var o = overrides[el.dataset.editable];
      if (!o) return;
      if (o.left != null) { el.style.left = o.left + "px"; el.style.right = "auto"; }
      if (o.top != null) { el.style.top = o.top + "px"; el.style.bottom = "auto"; }
      if (o.width != null) el.style.width = o.width + "px";
      if (o.height != null) el.style.height = o.height + "px";
    });
  }

  function applyProps() {
    var props = loadJSON(PROPS_KEY);
    Object.keys(props).forEach(function (key) {
      var el = resolvePath(key);
      if (!el) return;
      var p = props[key];
      if (p.marginTop != null) el.style.marginTop = p.marginTop + "px";
      if (p.fontSize != null) el.style.fontSize = p.fontSize + "px";
      if (p.thickness != null) el.style.borderTopWidth = p.thickness + "px";
      if (p.hidden) el.style.display = "none";
    });
  }

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

  function isEditorChrome(el) {
    return !!el.closest(".layout-edit-bar, .layout-edit-panel, .layout-edit-json, .layout-edit-handle, .layout-edit-resize");
  }

  function startEditMode() {
    document.body.classList.add("layout-editing-active");
    var overrides = loadJSON(CARDS_KEY);
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

      function persistCard() {
        var r = el.getBoundingClientRect();
        overrides[el.dataset.editable] = {
          left: Math.round(r.left), top: Math.round(r.top),
          width: Math.round(r.width), height: Math.round(r.height),
        };
        saveJSON(CARDS_KEY, overrides);
      }

      handle.addEventListener("mousedown", function (e) {
        e.stopPropagation();
        dragMove(e, function (dx, dy) {
          el.style.left = (el.offsetLeft + dx) + "px";
          el.style.top = (el.offsetTop + dy) + "px";
        }, persistCard);
      });

      resize.addEventListener("mousedown", function (e) {
        e.stopPropagation();
        dragMove(e, function (dx, dy) {
          el.style.width = Math.max(120, el.offsetWidth + dx) + "px";
          el.style.height = Math.max(80, el.offsetHeight + dy) + "px";
        }, persistCard);
      });
    });

    // whitePanel / linkCard / remarkCard / bluePanel never appear together
    // in real use (each is a different situation) — only one is visible
    // at a time here too, switchable, instead of showing all stacked up
    var EXCLUSIVE = ["whitePanel", "linkCard", "remarkCard", "bluePanel"];
    var exclusiveEls = editables.filter(function (el) {
      return EXCLUSIVE.indexOf(el.dataset.editable) !== -1;
    });

    // ---- the side panel for everything else (click anything to select) ----
    var panel = document.createElement("div");
    panel.className = "layout-edit-panel";
    panel.hidden = true;
    panel.innerHTML =
      '<p class="layout-edit-panel-title" id="layoutPanelTitle"></p>' +
      '<label>space above <input type="number" id="layoutPropMargin"> px</label>' +
      '<label>font size <input type="number" id="layoutPropFont"> px</label>' +
      '<label id="layoutPropThicknessRow">line thickness <input type="number" id="layoutPropThickness"> px</label>' +
      '<label><input type="checkbox" id="layoutPropHidden"> hide this element</label>' +
      '<button type="button" id="layoutPropClose">Done with this element</button>';
    document.body.appendChild(panel);

    var marginInput = document.getElementById("layoutPropMargin");
    var fontInput = document.getElementById("layoutPropFont");
    var thicknessRow = document.getElementById("layoutPropThicknessRow");
    var thicknessInput = document.getElementById("layoutPropThickness");
    var hiddenInput = document.getElementById("layoutPropHidden");
    var panelTitle = document.getElementById("layoutPanelTitle");

    var selected = null;
    var selectedKey = null;

    function describe(el) {
      var text = (el.textContent || "").trim().slice(0, 40);
      return el.tagName.toLowerCase() + (text ? ": “" + text + "”" : "");
    }

    function selectElement(el) {
      if (selected) selected.classList.remove("layout-edit-selected");
      var key = pathKey(el);
      if (!key) return;
      selected = el;
      selectedKey = key;
      selected.classList.add("layout-edit-selected");
      panelTitle.textContent = describe(el);
      var cs = getComputedStyle(el);
      marginInput.value = Math.round(parseFloat(cs.marginTop) || 0);
      fontInput.value = Math.round(parseFloat(cs.fontSize) || 0);
      hiddenInput.checked = cs.display === "none";
      thicknessRow.style.display = el.tagName === "HR" ? "" : "none";
      if (el.tagName === "HR") thicknessInput.value = Math.round(parseFloat(cs.borderTopWidth) || 1);
      panel.hidden = false;
    }

    function persistSelected(patch) {
      if (!selectedKey) return;
      var props = loadJSON(PROPS_KEY);
      props[selectedKey] = Object.assign({}, props[selectedKey], patch);
      saveJSON(PROPS_KEY, props);
    }

    document.addEventListener("click", function (e) {
      if (isEditorChrome(e.target)) return;
      if (!document.body.classList.contains("layout-editing-active")) return;
      e.preventDefault();
      e.stopPropagation();
      selectElement(e.target);
    }, true);

    marginInput.addEventListener("input", function () {
      if (!selected) return;
      var v = parseFloat(marginInput.value) || 0;
      selected.style.marginTop = v + "px";
      persistSelected({ marginTop: v });
    });
    fontInput.addEventListener("input", function () {
      if (!selected) return;
      var v = parseFloat(fontInput.value) || 0;
      selected.style.fontSize = v + "px";
      persistSelected({ fontSize: v });
    });
    thicknessInput.addEventListener("input", function () {
      if (!selected) return;
      var v = parseFloat(thicknessInput.value) || 1;
      selected.style.borderTopWidth = v + "px";
      persistSelected({ thickness: v });
    });
    hiddenInput.addEventListener("change", function () {
      if (!selected) return;
      selected.style.display = hiddenInput.checked ? "none" : "";
      persistSelected({ hidden: hiddenInput.checked });
    });
    document.getElementById("layoutPropClose").addEventListener("click", function () {
      if (selected) selected.classList.remove("layout-edit-selected");
      selected = null; selectedKey = null;
      panel.hidden = true;
    });

    // ---- the bottom bar: card switcher + add line + copy/reset/done ----
    var bar = document.createElement("div");
    bar.className = "layout-edit-bar";
    bar.innerHTML =
      '<span>Click anything to edit it (panel, top right). ⠇⠇ red / red corner move &amp; resize a whole card.</span>' +
      '<span id="layoutEditSwitcher"></span>' +
      '<button type="button" id="layoutEditAddLine">+ Add line</button>' +
      '<button type="button" id="layoutEditCopy">Copy layout</button>' +
      '<button type="button" id="layoutEditReset">Reset</button>' +
      '<button type="button" id="layoutEditDone">Done</button>';
    document.body.appendChild(bar);

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
      var hr = document.createElement("hr");
      hr.className = "layout-edit-added-line";
      container.appendChild(hr);
      var key = pathKey(hr);
      if (key) {
        var props = loadJSON(PROPS_KEY);
        props[key] = props[key] || {};
        saveJSON(PROPS_KEY, props);
      }
    });

    document.getElementById("layoutEditCopy").addEventListener("click", function () {
      var json = JSON.stringify({ cards: loadJSON(CARDS_KEY), props: loadJSON(PROPS_KEY) }, null, 2);
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
      if (!confirm("Reset all card positions and element edits back to default?")) return;
      saveJSON(CARDS_KEY, {});
      saveJSON(PROPS_KEY, {});
      location.reload();
    });

    document.getElementById("layoutEditDone").addEventListener("click", function () {
      location.reload();
    });
  }

  window.LayoutEditor = { start: startEditMode, apply: applyOverrides };
  applyOverrides();
  applyProps();
})();
