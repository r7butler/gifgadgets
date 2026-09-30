/* Homepage: plays the hero demo only while it is on screen, and never against
   the visitor's wishes. Reduced motion waits for a press of play. There is a
   day and a night clip; the stylesheet shows the one matching the theme, and
   this plays whichever is showing. */
(function () {
  'use strict';

  var videos = [].slice.call(document.querySelectorAll('.home-demo-video'));
  var media = document.querySelector('.home-demo-media');
  var toggle = document.getElementById('home-demo-toggle');
  if (!videos.length || !media || !toggle) return;

  var heldByVisitor = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var onScreen = !('IntersectionObserver' in window);

  function current() {
    return videos.filter(function (v) { return getComputedStyle(v).display !== 'none'; })[0] || videos[0];
  }
  function render() {
    var playing = !current().paused;
    toggle.classList.toggle('is-playing', playing);
    toggle.setAttribute('aria-label', playing ? 'Pause animation' : 'Play animation');
  }
  function play() {
    var attempt = current().play();
    // Blocked or failed playback leaves the poster, which already makes the point.
    if (attempt && attempt.catch) attempt.catch(render);
  }
  function sync() {
    var shown = current();
    videos.forEach(function (v) { if (v !== shown && !v.paused) v.pause(); });
    if (onScreen && !heldByVisitor) play();
    else if (!shown.paused) shown.pause();
    render();
  }

  toggle.addEventListener('click', function () {
    heldByVisitor = !current().paused;
    if (heldByVisitor) current().pause(); else play();
  });
  videos.forEach(function (v) {
    v.addEventListener('play', render);
    v.addEventListener('pause', render);
  });
  toggle.hidden = false;
  // Switching theme swaps which clip is showing.
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (onScreen) sync();
  else new IntersectionObserver(function (entries) {
    onScreen = entries[0].isIntersecting;
    sync();
  }, { threshold: 0.5 }).observe(media);
})();
