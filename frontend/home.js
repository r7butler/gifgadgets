/* Homepage: plays the hero demo only while it is on screen, and never against
   the visitor's wishes. Reduced motion waits for a press of play. */
(function () {
  'use strict';

  var video = document.getElementById('home-demo-video');
  var toggle = document.getElementById('home-demo-toggle');
  if (!video || !toggle) return;

  var heldByVisitor = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function render() {
    var playing = !video.paused;
    toggle.classList.toggle('is-playing', playing);
    toggle.setAttribute('aria-label', playing ? 'Pause animation' : 'Play animation');
  }
  function play() {
    var attempt = video.play();
    // Blocked or failed playback leaves the poster, which already makes the point.
    if (attempt && attempt.catch) attempt.catch(render);
  }

  toggle.addEventListener('click', function () {
    heldByVisitor = !video.paused;
    if (heldByVisitor) video.pause(); else play();
  });
  video.addEventListener('play', render);
  video.addEventListener('pause', render);
  toggle.hidden = false;
  render();

  if (!('IntersectionObserver' in window)) {
    if (!heldByVisitor) play();
    return;
  }
  new IntersectionObserver(function (entries) {
    if (entries[0].isIntersecting) { if (!heldByVisitor) play(); }
    else if (!video.paused) video.pause();
  }, { threshold: 0.5 }).observe(video);
})();
