/*
  traces — align the archive heading to the first polaroid

  The archive grid stays centred (the polaroids don't move); this only shifts the
  heading block so its left edge lines up with the first polaroid in the row.
*/
(function () {
  function align() {
    var title = document.querySelector(".gal-title-block");
    var first = document.querySelector(".gal-grid .gal-item");
    var screenEl = document.querySelector(".gal-screen");
    if (!title || !first || !screenEl) return;
    var cs = getComputedStyle(screenEl);
    var contentLeft = screenEl.getBoundingClientRect().left + parseFloat(cs.paddingLeft);
    title.style.marginLeft = "0";
    var delta = first.getBoundingClientRect().left - contentLeft;
    if (delta > 0) title.style.marginLeft = delta + "px";
  }
  window.alignGalleryTitle = align;
  window.addEventListener("load", align);
  window.addEventListener("resize", align);
  if (document.readyState !== "loading") align();
})();
