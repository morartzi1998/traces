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
  var INSERTS_KEY = "traces-layout-inserts"; // lines added during editing: [{after, id}]
  var UNDO_KEY = "traces-layout-undo-stack"; // stack of {cards, props, inserts} snapshots

  function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { return {}; }
  }
  function saveJSON(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
  }

  function loadUndoStack() {
    try { return JSON.parse(localStorage.getItem(UNDO_KEY)) || []; } catch (e) { return []; }
  }
  function saveUndoStack(stack) {
    try { localStorage.setItem(UNDO_KEY, JSON.stringify(stack)); } catch (e) {}
  }
  // snapshot all three stores together, so one Undo click always reverts
  // one whole user action (a drag, a duplicate, a multi-select edit) even
  // when that action touched more than one store at once
  function snapshotForUndo() {
    var stack = loadUndoStack();
    stack.push({ cards: loadJSON(CARDS_KEY), props: loadJSON(PROPS_KEY), inserts: loadJSON(INSERTS_KEY) });
    if (stack.length > 30) stack.shift();
    saveUndoStack(stack);
  }
  function undoLast() {
    var stack = loadUndoStack();
    var snap = stack.pop();
    if (!snap) return;
    saveUndoStack(stack);
    saveJSON(CARDS_KEY, snap.cards);
    saveJSON(PROPS_KEY, snap.props);
    saveJSON(INSERTS_KEY, snap.inserts);
    location.reload();
  }

  // a reproducible address for an element, so the SAME element gets the
  // same key across reloads without needing every editable thing to carry
  // its own id: walk up to the nearest ancestor that already has one, then
  // record child-indices down to the target
  function pathKey(el) {
    var parts = [];
    var node = el;
    // falls back to document.body as the root if nothing closer has an id
    // (a container like the timeline is marked up with only a class) —
    // without this, anything inside such a container silently fails to
    // select at all
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) { parts.unshift(node.id); return parts.join("/"); }
      var parent = node.parentElement;
      if (!parent) return null;
      parts.unshift(Array.prototype.indexOf.call(parent.children, node));
      node = parent;
    }
    if (node === document.body) { parts.unshift("BODY"); return parts.join("/"); }
    return null;
  }

  function resolvePath(key) {
    var parts = key.split("/");
    var node = parts[0] === "BODY" ? document.body : document.getElementById(parts[0]);
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

  // elements she duplicated with "+ Duplicate" (a divider, a timeline dot,
  // anything) — re-created at the same anchor point on every load, before
  // pathKey-based props are applied (so anything AFTER the insertion point
  // still resolves to the right index)
  function applyInserts() {
    var inserts = loadJSON(INSERTS_KEY);
    (inserts.list || []).forEach(function (entry) {
      if (document.querySelector('[data-insert-id="' + entry.id + '"]')) return;
      var anchor = resolvePath(entry.after);
      if (!anchor || !anchor.parentNode) return;
      var clone;
      if (entry.tag === "HR" && !entry.html) {
        clone = document.createElement("hr");
        clone.className = "layout-edit-added-line";
      } else {
        clone = document.createElement(entry.tag || "hr");
        clone.className = entry.className || "";
        if (entry.html != null) clone.innerHTML = entry.html;
      }
      clone.dataset.insertId = entry.id;
      anchor.parentNode.insertBefore(clone, anchor.nextSibling);
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
      if (p.width != null) el.style.width = p.width + "px";
      if (p.height != null) el.style.height = p.height + "px";
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
      onMove(e.clientX - startX, e.clientY - startY, e);
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

  // move `el` to sit right before the first sibling whose vertical midpoint
  // is below the cursor (or to the end, if none is) — lets a duplicated
  // line/element be dropped anywhere among its siblings, not just glued
  // right after wherever it was cloned from
  function reorderAmongSiblings(el, clientY) {
    var parent = el.parentNode;
    if (!parent) return;
    var siblings = Array.prototype.filter.call(parent.children, function (n) {
      return n !== el && !isEditorChrome(n);
    });
    var target = null;
    for (var i = 0; i < siblings.length; i++) {
      var r = siblings[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { target = siblings[i]; break; }
    }
    if (target) {
      if (el.nextSibling !== target) parent.insertBefore(el, target);
    } else if (parent.lastElementChild !== el) {
      parent.appendChild(el);
    }
    // never let it land as the very first child — the insert model anchors
    // to an existing preceding sibling, so it always needs one
    if (parent.firstElementChild === el && siblings.length) {
      parent.insertBefore(el, siblings[0].nextSibling);
    }
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
        snapshotForUndo();
        var r = el.getBoundingClientRect();
        overrides[el.dataset.editable] = {
          left: Math.round(r.left), top: Math.round(r.top),
          width: Math.round(r.width), height: Math.round(r.height),
        };
        saveJSON(CARDS_KEY, overrides);
      }

      handle.addEventListener("mousedown", function (e) {
        e.stopPropagation();
        snapshotForUndo();
        dragMove(e, function (dx, dy) {
          el.style.left = (el.offsetLeft + dx) + "px";
          el.style.top = (el.offsetTop + dy) + "px";
        }, persistCard);
      });

      resize.addEventListener("mousedown", function (e) {
        e.stopPropagation();
        snapshotForUndo();
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
    editables.forEach(function (el) { if (!el.hidden) revealAll(el); });

    // revealing nested conditional UI (an annotation's "view" state, etc.)
    // that's normally hidden depending on what she was doing right before
    // opening edit mode — otherwise its lines/text are invisible and can't
    // be clicked at all
    function revealAll(container) {
      if (!container) return;
      container.querySelectorAll("[hidden]").forEach(function (el) { el.hidden = false; });
    }

    // ---- the side panel for everything else (click anything to select) ----
    var panel = document.createElement("div");
    panel.className = "layout-edit-panel";
    panel.hidden = true;
    panel.innerHTML =
      '<p class="layout-edit-panel-title" id="layoutPanelTitle">' +
        '<span class="layout-edit-panel-drag" id="layoutPanelDrag" title="drag to move this panel">⠇⠇</span>' +
        '<span id="layoutPanelDesc"></span>' +
      '</p>' +
      '<label>space above <input type="number" id="layoutPropMargin"> px</label>' +
      '<label>font size <input type="number" id="layoutPropFont"> px</label>' +
      '<label>width <input type="number" id="layoutPropWidth"> px</label>' +
      '<label>height <input type="number" id="layoutPropHeight"> px</label>' +
      '<label id="layoutPropThicknessRow">line thickness <input type="number" id="layoutPropThickness"> px</label>' +
      '<label><input type="checkbox" id="layoutPropHidden"> hide this element</label>' +
      '<button type="button" id="layoutEditDuplicate">+ Duplicate this element</button>' +
      '<button type="button" id="layoutPropDeleteLine" hidden>Delete this line</button>' +
      '<button type="button" id="layoutPropClose">Done with this element</button>';
    document.body.appendChild(panel);

    var marginInput = document.getElementById("layoutPropMargin");
    var fontInput = document.getElementById("layoutPropFont");
    var widthInput = document.getElementById("layoutPropWidth");
    var heightInput = document.getElementById("layoutPropHeight");
    var thicknessRow = document.getElementById("layoutPropThicknessRow");
    var thicknessInput = document.getElementById("layoutPropThickness");
    var hiddenInput = document.getElementById("layoutPropHidden");
    var deleteLineBtn = document.getElementById("layoutPropDeleteLine");
    var panelDesc = document.getElementById("layoutPanelDesc");
    var panelDrag = document.getElementById("layoutPanelDrag");
    panelDrag.addEventListener("mousedown", function (e) {
      e.stopPropagation();
      var rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + "px";
      panel.style.top = rect.top + "px";
      panel.style.right = "auto";
      dragMove(e, function (dx, dy) {
        panel.style.left = (panel.offsetLeft + dx) + "px";
        panel.style.top = (panel.offsetTop + dy) + "px";
      });
    });

    // shift-click adds to the selection instead of replacing it, so a
    // change (move, hide, resize…) can apply to several elements at once.
    // `selected`/`selectedKey` always mirror the LAST-clicked one (what the
    // panel displays); `items` holds the full multi-selection.
    var items = []; // [{ el, key }]
    var selected = null;
    var selectedKey = null;

    function describe(el) {
      var text = (el.textContent || "").trim().slice(0, 40);
      var label = el.tagName.toLowerCase() + (text ? ": “" + text + "”" : "");
      return items.length > 1 ? label + "  (+" + (items.length - 1) + " more selected)" : label;
    }

    function clearSelection() {
      items.forEach(function (it) { it.el.classList.remove("layout-edit-selected"); });
      items = [];
      selected = null; selectedKey = null;
    }

    function selectElement(el, additive) {
      var key = pathKey(el);
      if (!key) return;
      if (!additive) clearSelection();
      var existing = items.filter(function (it) { return it.el === el; })[0];
      if (existing) {
        // shift-clicking an already-selected element deselects just that one
        existing.el.classList.remove("layout-edit-selected");
        items = items.filter(function (it) { return it !== existing; });
      } else {
        el.classList.add("layout-edit-selected");
        items.push({ el: el, key: key });
      }
      if (!items.length) { panel.hidden = true; return; }
      var last = items[items.length - 1];
      selected = last.el; selectedKey = last.key;
      panelDesc.textContent = describe(selected);
      var cs = getComputedStyle(selected);
      marginInput.value = Math.round(parseFloat(cs.marginTop) || 0);
      fontInput.value = Math.round(parseFloat(cs.fontSize) || 0);
      var rect = selected.getBoundingClientRect();
      widthInput.value = Math.round(rect.width);
      heightInput.value = Math.round(rect.height);
      hiddenInput.checked = cs.display === "none";
      var isLine = selected.tagName === "HR";
      thicknessRow.style.display = isLine ? "" : "none";
      deleteLineBtn.hidden = !isLine;
      if (isLine) thicknessInput.value = Math.round(parseFloat(cs.borderTopWidth) || 1);
      panel.hidden = false;
    }

    // applies fn(el, key) to every selected element, or just the primary
    // one if nothing is multi-selected (covers plain single-select too)
    function forEachSelected(fn) {
      (items.length ? items : (selected ? [{ el: selected, key: selectedKey }] : [])).forEach(function (it) {
        fn(it.el, it.key);
      });
    }

    function persistFor(key, patch) {
      if (!key) return;
      var props = loadJSON(PROPS_KEY);
      props[key] = Object.assign({}, props[key], patch);
      saveJSON(PROPS_KEY, props);
    }

    // mousedown (not click) so the same gesture can both select AND, if she
    // moves the mouse before releasing, drag the element's spacing right
    // there instead of only through the panel's number input
    document.addEventListener("mousedown", function (e) {
      if (isEditorChrome(e.target)) return;
      if (!document.body.classList.contains("layout-editing-active")) return;
      e.preventDefault();
      e.stopPropagation();
      var el = e.target;
      selectElement(el, e.shiftKey);
      if (!selectedKey) return;

      // a duplicated line/element can be dropped anywhere among its
      // siblings — reorder it live under the cursor instead of only
      // nudging its margin, since that's what "put it wherever I want"
      // actually needs (margin can't cross past a neighbouring row)
      if (el.dataset.insertId && items.length <= 1) {
        var draggedInsert = false;
        dragMove(e, function (dx, dy, ev) {
          if (!draggedInsert) { snapshotForUndo(); draggedInsert = true; el.classList.add("layout-edit-dragging"); }
          reorderAmongSiblings(el, (ev && ev.clientY) || e.clientY);
        }, function () {
          el.classList.remove("layout-edit-dragging");
          if (!draggedInsert) return;
          var prev = el.previousElementSibling;
          var newAfterKey = prev ? pathKey(prev) : null;
          if (!newAfterKey) return;
          var inserts = loadJSON(INSERTS_KEY);
          inserts.list = (inserts.list || []).map(function (entry) {
            return String(entry.id) === String(el.dataset.insertId)
              ? Object.assign({}, entry, { after: newAfterKey })
              : entry;
          });
          saveJSON(INSERTS_KEY, inserts);
        });
        return;
      }

      // drag applies the same delta to every selected element, not just
      // the one the mouse happens to be over
      var bases = items.map(function (it) { return { el: it.el, key: it.key, start: parseFloat(getComputedStyle(it.el).marginTop) || 0 }; });
      var draggedYet = false;
      dragMove(e, function (dx, dy) {
        if (!draggedYet) { snapshotForUndo(); draggedYet = true; }
        bases.forEach(function (b) {
          b.start = Math.max(0, b.start + dy);
          b.el.style.marginTop = b.start + "px";
        });
        marginInput.value = Math.round(bases[bases.length - 1].start);
      }, function () {
        // a plain click (select only, no movement) must not silently write
        // a marginTop override — only persist when something actually moved
        if (!draggedYet) return;
        bases.forEach(function (b) { persistFor(b.key, { marginTop: parseFloat(b.el.style.marginTop) || 0 }); });
      });
    }, true);
    // swallow the click that follows the mousedown above, so it doesn't
    // also fire whatever the element would normally do (navigate, toggle…)
    document.addEventListener("click", function (e) {
      if (isEditorChrome(e.target)) return;
      if (!document.body.classList.contains("layout-editing-active")) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    marginInput.addEventListener("input", function () {
      if (!selected) return;
      snapshotForUndo();
      var v = parseFloat(marginInput.value) || 0;
      forEachSelected(function (el, key) { el.style.marginTop = v + "px"; persistFor(key, { marginTop: v }); });
    });
    fontInput.addEventListener("input", function () {
      if (!selected) return;
      snapshotForUndo();
      var v = parseFloat(fontInput.value) || 0;
      forEachSelected(function (el, key) { el.style.fontSize = v + "px"; persistFor(key, { fontSize: v }); });
    });
    thicknessInput.addEventListener("input", function () {
      if (!selected) return;
      snapshotForUndo();
      var v = parseFloat(thicknessInput.value) || 1;
      forEachSelected(function (el, key) { el.style.borderTopWidth = v + "px"; persistFor(key, { thickness: v }); });
    });
    widthInput.addEventListener("input", function () {
      if (!selected) return;
      snapshotForUndo();
      var v = parseFloat(widthInput.value) || 0;
      forEachSelected(function (el, key) { el.style.width = v + "px"; persistFor(key, { width: v }); });
    });
    heightInput.addEventListener("input", function () {
      if (!selected) return;
      snapshotForUndo();
      var v = parseFloat(heightInput.value) || 0;
      forEachSelected(function (el, key) { el.style.height = v + "px"; persistFor(key, { height: v }); });
    });
    hiddenInput.addEventListener("change", function () {
      if (!selected) return;
      snapshotForUndo();
      var v = hiddenInput.checked;
      forEachSelected(function (el, key) { el.style.display = v ? "none" : ""; persistFor(key, { hidden: v }); });
    });
    deleteLineBtn.addEventListener("click", function () {
      snapshotForUndo();
      forEachSelected(function (el, key) {
        if (el.tagName !== "HR") return;
        var insertId = el.dataset.insertId;
        if (insertId) {
          var inserts = loadJSON(INSERTS_KEY);
          inserts.list = (inserts.list || []).filter(function (e) { return String(e.id) !== insertId; });
          saveJSON(INSERTS_KEY, inserts);
        } else {
          persistFor(key, { hidden: true });
        }
        el.remove();
      });
      clearSelection();
      panel.hidden = true;
    });
    document.getElementById("layoutPropClose").addEventListener("click", function () {
      clearSelection();
      panel.hidden = true;
    });

    // ---- the bottom bar: card switcher + add line + copy/reset/done ----
    var bar = document.createElement("div");
    bar.className = "layout-edit-bar";
    bar.innerHTML =
      '<span>Click anything to edit it (panel, top right). ⠇⠇ red / red corner move &amp; resize a whole card.</span>' +
      '<span id="layoutEditSwitcher"></span>' +
      '<button type="button" id="layoutEditCopy">Copy layout</button>' +
      '<button type="button" id="layoutEditUndo">Undo</button>' +
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
          revealAll(el);
        });
        switcher.appendChild(btn);
      });
    }

    function activeContainer() {
      var visible = exclusiveEls.filter(function (el) { return !el.hidden; })[0];
      return visible || editables[0];
    }

    // duplicates whatever's currently selected — a divider, a timeline
    // dot, any element — and drops the copy right after it. Falls back to
    // a plain new divider at the end of the active card if nothing's
    // selected (e.g. clicked straight from the bottom bar in an earlier
    // version of this tool; kept as a safe default)
    function duplicateOne(anchorEl) {
      var clone = anchorEl.cloneNode(true);
      clone.classList.remove("layout-edit-selected");
      var anchorKey = pathKey(anchorEl);
      if (!anchorKey) return;
      anchorEl.parentNode.insertBefore(clone, anchorEl.nextSibling);
      var id = Date.now() + "-" + Math.floor(Math.random() * 1000) + "-" + Math.floor(Math.random() * 1000);
      clone.dataset.insertId = id;
      var inserts = loadJSON(INSERTS_KEY);
      inserts.list = inserts.list || [];
      inserts.list.push({
        after: anchorKey, id: id,
        tag: clone.tagName, className: clone.className, html: clone.innerHTML || undefined,
      });
      saveJSON(INSERTS_KEY, inserts);
    }

    function duplicateSelected() {
      snapshotForUndo();
      if (items.length) {
        items.slice().forEach(function (it) { duplicateOne(it.el); });
        return;
      }
      var container = activeContainer();
      if (!container) return;
      var anchorEl = container.lastElementChild || container;
      var anchorKey = pathKey(anchorEl);
      if (!anchorKey) return;
      var hr = document.createElement("hr");
      hr.className = "layout-edit-added-line";
      anchorEl.parentNode.insertBefore(hr, anchorEl.nextSibling);
      var id = Date.now() + "-" + Math.floor(Math.random() * 1000);
      hr.dataset.insertId = id;
      var inserts = loadJSON(INSERTS_KEY);
      inserts.list = inserts.list || [];
      inserts.list.push({ after: anchorKey, id: id, tag: "HR", className: "layout-edit-added-line" });
      saveJSON(INSERTS_KEY, inserts);
    }
    document.getElementById("layoutEditDuplicate").addEventListener("click", duplicateSelected);

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

    document.getElementById("layoutEditUndo").addEventListener("click", function () {
      undoLast();
    });

    document.getElementById("layoutEditReset").addEventListener("click", function () {
      if (!confirm("Reset all card positions and element edits back to default?")) return;
      saveJSON(CARDS_KEY, {});
      saveJSON(PROPS_KEY, {});
      saveJSON(INSERTS_KEY, {});
      saveUndoStack([]);
      location.reload();
    });

    document.getElementById("layoutEditDone").addEventListener("click", function () {
      location.reload();
    });
  }

  window.LayoutEditor = { start: startEditMode, apply: applyOverrides };
  applyOverrides();
  applyInserts();
  applyProps();
})();
