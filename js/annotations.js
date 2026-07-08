/*
  traces — capture annotations
  Click anywhere inside #captureCanvas to pin a note at that point: a small
  inline input opens where you clicked; Enter saves, Escape cancels. Each
  pin shows a blue square with its label on the capture, and a matching row
  in the sidebar list (with a remove button).
*/

(function () {
  var canvas = document.getElementById("captureCanvas");
  var list = document.getElementById("annotationList");
  var count = document.getElementById("annotationCount");
  if (!canvas || !list || !count) return;

  var empty = list.querySelector(".annotations-empty");
  var annotations = [];
  var editor = null;

  function render() {
    count.textContent = annotations.length;
    empty.style.display = annotations.length ? "none" : "";
    list.querySelectorAll(".annotation-row").forEach(function (n) { n.remove(); });
    canvas.querySelectorAll(".annotation-marker").forEach(function (n) { n.remove(); });

    annotations.forEach(function (a, i) {
      var marker = document.createElement("div");
      marker.className = "annotation-marker";
      marker.style.left = a.x * 100 + "%";
      marker.style.top = a.y * 100 + "%";
      var label = document.createElement("span");
      label.className = "label";
      label.textContent = a.text;
      marker.appendChild(label);
      canvas.appendChild(marker);

      var row = document.createElement("div");
      row.className = "annotation-row";
      var text = document.createElement("span");
      text.textContent = a.text;
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

  function closeEditor() {
    if (editor) {
      editor.remove();
      editor = null;
    }
  }

  function openEditor(xPct, yPct) {
    closeEditor();
    editor = document.createElement("div");
    editor.className = "annotation-editor";
    editor.style.left = xPct * 100 + "%";
    editor.style.top = yPct * 100 + "%";

    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = "add a note…";
    input.setAttribute("aria-label", "Annotation text");
    editor.appendChild(input);
    canvas.appendChild(editor);
    input.focus();

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var text = input.value.trim();
        if (text) {
          annotations.push({ x: xPct, y: yPct, text: text });
          render();
        }
        closeEditor();
      } else if (e.key === "Escape") {
        closeEditor();
      }
    });
    input.addEventListener("blur", function () {
      setTimeout(closeEditor, 100);
    });
  }

  canvas.addEventListener("click", function (e) {
    if (canvas.__suppressClick) return; // the 3D viewer was being orbited
    if (e.target.closest(".annotation-marker") || e.target.closest(".annotation-editor")) return;
    var r = canvas.getBoundingClientRect();
    openEditor((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  });
})();
