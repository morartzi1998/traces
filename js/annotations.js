/*
  traces — capture annotations
  Click anywhere inside #captureCanvas to pin a note at that point.
  Each pin shows a small blue square with its label on the capture,
  and a matching row in the sidebar list (with a remove button).
*/

(function () {
  var canvas = document.getElementById("captureCanvas");
  var list = document.getElementById("annotationList");
  var count = document.getElementById("annotationCount");
  if (!canvas || !list || !count) return;

  var empty = list.querySelector(".annotations-empty");
  var annotations = [];

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

  canvas.addEventListener("click", function (e) {
    if (e.target.closest(".annotation-marker")) return;
    var text = window.prompt("Add a note for this spot:");
    if (!text) return;
    var r = canvas.getBoundingClientRect();
    annotations.push({
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
      text: text.trim(),
    });
    render();
  });
})();
