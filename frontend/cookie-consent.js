/* Analytics starts only after the user's choice. Storage may be unavailable. */
(function () {
  'use strict';
  if (window.GWAnalyticsChoices) return;
  var choice;
  try { choice = localStorage.getItem('gc_cookie_consent'); } catch (_) {}
  var started = false;
  function start() {
    window['ga-disable-G-STTEFW2R1M'] = false;
    if (started) return;
    started = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', 'G-STTEFW2R1M', { page_location: location.origin + location.pathname });
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=G-STTEFW2R1M';
    document.head.appendChild(script);
  }
  function show() {
    if (document.getElementById('cookie-consent')) return;
    var banner = document.createElement('section');
    banner.id = 'cookie-consent';
    banner.className = 'cookie-consent';
    banner.setAttribute('aria-label', 'Analytics choices');
    banner.innerHTML = '<p>Allow analytics cookies to help us understand how these tools are used?</p>' +
      '<button id="cookie-reject" class="btn btn-ghost btn-small">Reject</button>' +
      '<button id="cookie-accept" class="btn btn-accent btn-small">Accept</button>';
    document.body.appendChild(banner);
    function choose(value) {
      choice = value;
      try { localStorage.setItem('gc_cookie_consent', value); } catch (_) {}
      if (value === 'accepted') start();
      else window['ga-disable-G-STTEFW2R1M'] = true;
      banner.remove();
    }
    banner.querySelector('#cookie-accept').onclick = function () { choose('accepted'); };
    banner.querySelector('#cookie-reject').onclick = function () { choose('rejected'); };
  }
  window.GWAnalyticsChoices = show;
  // Keep the choice accessible after the banner is dismissed.
  var settings = document.createElement('button');
  settings.textContent = 'Analytics choices';
  settings.className = 'btn btn-ghost btn-small';
  settings.id = 'analytics-settings';
  settings.onclick = show;
  function placeSettings() {
    var target = document.querySelector('.header-actions, .site-footer, .site-nav-links') || document.body;
    target.appendChild(settings);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', placeSettings);
  else placeSettings();
  if (choice === 'accepted') start();
  else if (choice !== 'rejected') show();
})();
