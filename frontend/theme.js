(function () {
  'use strict';

  var KEY = 'gw-theme';

  // Apply immediately (runs synchronously in <head>) to prevent flash of wrong theme
  if (localStorage.getItem(KEY) === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  var SUN = '<svg class="theme-icon icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  var MOON = '<svg class="theme-icon icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function toggle() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem(KEY, 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem(KEY, 'dark');
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.createElement('button');
    btn.className = 'theme-toggle';
    btn.title = 'Toggle light/dark theme';
    btn.setAttribute('aria-label', 'Toggle light/dark theme');
    btn.innerHTML = SUN + MOON;
    btn.addEventListener('click', toggle);

    // Landing pages — append to .site-nav
    var nav = document.querySelector('.site-nav');
    if (nav) {
      nav.appendChild(btn);
      return;
    }

    // Editor pages — prepend to .header-actions
    var actions = document.querySelector('.header-actions');
    if (actions) {
      actions.insertBefore(btn, actions.firstChild);
    }
  });
})();
