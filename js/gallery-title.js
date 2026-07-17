/*
  traces — align the archive heading and filter row to the first polaroid

  The archive grid stays centred (the polaroids don't move); this only shifts
  the heading block and the object/space filter row so their left edge lines
  up with the first polaroid in the row, instead of sitting flush against the
  screen's own padding.
*/
(function () {
  function alignToFirst(el, contentLeft, first) {
    if (!el) return;
    el.style.marginLeft = "0";
    var delta = first.getBoundingClientRect().left - contentLeft;
    if (delta > 0) el.style.marginLeft = delta + "px";
  }

  function align() {
    var title = document.querySelector(".gal-title-block");
    var filters = document.querySelector(".gal-filters");
    var first = document.querySelector(".gal-grid .gal-item");
    var screenEl = document.querySelector(".gal-screen");
    if (!first || !screenEl) return;
    var cs = getComputedStyle(screenEl);
    var contentLeft = screenEl.getBoundingClientRect().left + parseFloat(cs.paddingLeft);
    alignToFirst(title, contentLeft, first);
    alignToFirst(filters, contentLeft, first);
  }
  window.alignGalleryTitle = align;
  window.addEventListener("load", align);
  window.addEventListener("resize", align);
  if (document.readyState !== "loading") align();
})();
