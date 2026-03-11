// Cookie consent banner for GDPR / AdSense compliance
(function () {
  if (localStorage.getItem('gc_cookie_consent')) return;

  var banner = document.createElement('div');
  banner.id = 'cookie-consent';
  banner.className = 'cookie-consent';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Cookie consent');
  banner.innerHTML =
    '<p>This site uses cookies and Google AdSense to show ads. By continuing, you agree to our use of cookies.</p>' +
    '<button id="cookie-accept" class="btn btn-accent btn-small">Got it</button>';
  document.body.appendChild(banner);

  document.getElementById('cookie-accept').addEventListener('click', function () {
    localStorage.setItem('gc_cookie_consent', '1');
    banner.remove();
  });
})();
