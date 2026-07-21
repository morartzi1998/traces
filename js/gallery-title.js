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
    var titleText = document.querySelector(".gal-title");
    var addCapture = document.querySelector(".gal-add");
    if (!first || !screenEl) return;
    var cs = getComputedStyle(screenEl);
    var contentLeft = screenEl.getBoundingClientRect().left + parseFloat(cs.paddingLeft);
    alignToFirst(title, contentLeft, first);
    alignToFirst(filters, contentLeft, first);

    /* Keep the fixed CTA on the exact same top axis as the archive heading,
       even when responsive type or viewport height changes. On a phone the
       CTA is a floating chip anchored to the bottom-right by CSS instead, so
       clear any inline top there — leaving it set would pin the top while CSS
       pins the bottom, stretching the chip down the whole screen. */
    if (addCapture && titleText) {
      if (window.matchMedia && window.matchMedia("(max-width: 720px)").matches) {
        // on a phone the CTA floats on the right, aligned to the object/space
        // filter row (using the empty space beside it)
        var filters = document.querySelector(".gal-filters");
        if (filters) {
          addCapture.style.top = Math.round(filters.getBoundingClientRect().top) + "px";
        }
      } else {
        addCapture.style.top = Math.round(titleText.getBoundingClientRect().top) + "px";
      }
    }
  }
  window.alignGalleryTitle = align;
  window.addEventListener("load", align);
  window.addEventListener("resize", align);
  if (document.readyState !== "loading") align();

  // the grid fills in over several async steps (local items render
  // instantly, remote/showcase items trail in later) - rather than trust
  // every one of those call sites to remember to re-align afterwards,
  // watch the grid directly so a layout shift is always caught
  var grid = document.querySelector(".gal-grid");
  if (grid && window.MutationObserver) {
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; align(); });
    }).observe(grid, { childList: true });
  }
})();
