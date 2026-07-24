/*
  traces — About screen scroll behaviour
  - the polaroid pile starts as a dense stack and fans downward as you scroll
  - a custom blue scroll indicator on the right tracks progress
  - both get a soft blur while scrolling that clears when it stops (echoing the
    cursor smear elsewhere in the interface)

  Include: <script src="../js/about.js" defer></script>
*/

(function () {
  var pile = document.querySelector(".ab-pile");
  var track = document.querySelector(".ab-scroll");
  var thumb = document.querySelector(".ab-scroll-thumb");
  if (!pile) return;

  var cards = [].slice.call(pile.querySelectorAll(".ab-polaroid"));
  var idle;

  function scroller() {
    return document.scrollingElement || document.documentElement;
  }

  function progress() {
    var s = scroller();
    var max = s.scrollHeight - window.innerHeight;
    // a window tall enough to hold the whole story leaves nothing to scroll —
    // show the pile fully fanned (the end state) instead of forever-stacked
    if (max <= 0) return 1;
    return Math.min(1, Math.max(0, s.scrollTop / max));
  }

  function layout() {
    var raw = progress();
    // the fan reaches full spread a little before the very end, so the whole
    // stack is open while you read the last of the story
    var p = Math.min(1, raw / 0.8);

    // fan the polaroids downward: compact near the top, fully open as p -> 1.
    // The per-card step is capped so the LAST card still sits whole above the
    // bottom nav at full spread — maximum scroll always ends on the complete
    // cascade, never on a clipped polaroid.
    var cardH = cards.length ? cards[0].offsetHeight : 0;
    var pileTop = pile.getBoundingClientRect().top;
    var avail = window.innerHeight - pileTop - cardH - 84;
    var per = Math.min(window.innerHeight * 0.185,
      cards.length > 1 ? Math.max(40, avail / (cards.length - 1)) : 0);
    cards.forEach(function (card, i) {
      var compact = i * 20;
      var spread = i * per;
      var y = compact + p * (spread - compact > 0 ? spread - compact : 0);
      card.style.transform = "translateY(" + y + "px) rotate(var(--tilt, 0deg))";
    });

    // custom scroll indicator tracks real scroll position
    if (track && thumb) {
      var trackH = track.clientHeight;
      var ratio = window.innerHeight / scroller().scrollHeight;
      var thumbH = Math.max(44, Math.round(trackH * ratio));
      thumb.style.height = thumbH + "px";
      thumb.style.transform = "translateY(" + raw * (trackH - thumbH) + "px)";
    }
  }

  function onScroll() {
    layout();
    pile.classList.add("is-scrolling");
    if (thumb) thumb.classList.add("is-scrolling");
    clearTimeout(idle);
    idle = setTimeout(function () {
      pile.classList.remove("is-scrolling");
      if (thumb) thumb.classList.remove("is-scrolling");
    }, 180);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", layout);
  layout();
})();
