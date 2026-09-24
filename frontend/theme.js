(function () {
  'use strict';

  function _signedFetch(url, options) {
    if (options && options.body) {
      var raw = typeof options.body === 'string'
        ? new TextEncoder().encode(options.body) : options.body;
      return crypto.subtle.digest('SHA-256', raw).then(function (buf) {
        var hex = Array.from(new Uint8Array(buf))
          .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        options.headers = options.headers || {};
        options.headers['x-amz-content-sha256'] = hex;
        return fetch(url, options);
      });
    }
    return fetch(url, options);
  }

  var KEY = 'gw-theme';

  // Apply immediately (runs synchronously in <head>) to prevent flash of wrong theme
  if (localStorage.getItem(KEY) === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  var SUN = '<svg class="theme-icon icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  var MOON = '<svg class="theme-icon icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  var confirmModal;
  var reportIssueModal;
  var editorHeaderSyncers = [];
  var editorHeaderObserver;

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

  function setupMobileNav(nav) {
    var links = nav.querySelector('.site-nav-links');
    if (!links) return;

    var actions = document.createElement('div');
    actions.className = 'site-nav-actions';

    var menuBtn = document.createElement('button');
    menuBtn.className = 'site-nav-toggle';
    menuBtn.type = 'button';
    menuBtn.setAttribute('aria-label', 'Toggle navigation menu');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.setAttribute('aria-controls', 'site-nav-links');
    menuBtn.innerHTML =
      '<span class="site-nav-toggle-bar" aria-hidden="true"></span>' +
      '<span class="site-nav-toggle-bar" aria-hidden="true"></span>' +
      '<span class="site-nav-toggle-bar" aria-hidden="true"></span>';

    if (!links.id) links.id = 'site-nav-links';
    menuBtn.setAttribute('aria-controls', links.id);

    function setOpen(isOpen) {
      nav.classList.toggle('is-open', isOpen);
      menuBtn.classList.toggle('is-open', isOpen);
      menuBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    menuBtn.addEventListener('click', function () {
      setOpen(!nav.classList.contains('is-open'));
    });

    document.addEventListener('click', function (event) {
      if (!nav.classList.contains('is-open')) return;
      if (nav.contains(event.target)) return;
      setOpen(false);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setOpen(false);
    });

    links.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false);
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 768) setOpen(false);
    });

    nav.appendChild(actions);
    actions.appendChild(menuBtn);

    return actions;
  }

  function ensureHeaderActions(header) {
    var actions = header.querySelector('.header-actions');
    if (actions) return actions;

    actions = document.createElement('div');
    actions.className = 'header-actions';

    Array.prototype.slice.call(header.children).forEach(function (child) {
      if (child.classList && child.classList.contains('logo')) return;
      actions.appendChild(child);
    });

    header.appendChild(actions);
    return actions;
  }

  function getActionLabel(source) {
    var label = '';
    Array.prototype.forEach.call(source.childNodes, function (node) {
      if (node.nodeType === 3) label += node.textContent;
    });
    label = label.replace(/\s+/g, ' ').trim();
    return label || source.getAttribute('aria-label') || source.title || 'Action';
  }

  function createActionProxy(source, iconOnly) {
    if (!source) return null;

    var proxy = document.createElement('button');
    proxy.type = 'button';
    proxy.className = source.className + ' ' + (iconOnly ? 'editor-shortcut-btn' : 'editor-mobile-menu-item');
    proxy.setAttribute('aria-label', source.getAttribute('aria-label') || getActionLabel(source));
    proxy.title = source.title || getActionLabel(source);

    var icon = source.querySelector('svg');
    if (icon) {
      proxy.innerHTML = icon.outerHTML;
    } else {
      proxy.textContent = iconOnly ? getActionLabel(source).charAt(0) : getActionLabel(source);
    }

    if (!iconOnly) {
      var text = document.createTextNode(' ' + getActionLabel(source));
      proxy.appendChild(text);
    }

    function isSourceAvailable() {
      if (source.disabled) return false;
      if (source.closest('.hidden')) return false;
      if (source.tagName === 'A') {
        var href = source.getAttribute('href');
        if (!href || href === '#') return false;
      }
      return true;
    }

    function syncState() {
      var enabled = isSourceAvailable();
      proxy.disabled = !enabled;
      proxy.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      proxy.classList.toggle('disabled', !enabled);
    }

    proxy.addEventListener('click', function () {
      syncState();
      if (proxy.disabled) return;
      source.click();
    });

    editorHeaderSyncers.push(syncState);
    syncState();
    return proxy;
  }

  function ensureEditorHeaderObserver() {
    if (editorHeaderObserver || !document.body) return;
    editorHeaderObserver = new MutationObserver(function (mutations) {
      var shouldSync = mutations.some(function (mutation) {
        var target = mutation.target;
        if (!target || target.nodeType !== 1) return false;
        if (target.classList.contains('editor-shortcut-btn')) return false;
        if (target.classList.contains('editor-mobile-menu-item')) return false;
        if (target.classList.contains('editor-header-mobile-actions')) return false;
        if (target.classList.contains('editor-header-toggle')) return false;
        if (target.closest('.editor-header-mobile-actions')) return false;
        return true;
      });
      if (!shouldSync) return;
      editorHeaderSyncers.forEach(function (sync) { sync(); });
    });
    editorHeaderObserver.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'href']
    });
  }

  function setupEditorHeader(header, actions) {
    if (!header || !actions || header.querySelector('.editor-header-mobile-actions')) return actions;

    var mobileActions = document.createElement('div');
    mobileActions.className = 'editor-header-mobile-actions';

    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'editor-header-toggle';
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('aria-label', 'Toggle editor menu');
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.innerHTML =
      '<span class="editor-header-toggle-bar" aria-hidden="true"></span>' +
      '<span class="editor-header-toggle-bar" aria-hidden="true"></span>' +
      '<span class="editor-header-toggle-bar" aria-hidden="true"></span>';

    function setOpen(isOpen) {
      header.classList.toggle('is-open', isOpen);
      toggleBtn.classList.toggle('is-open', isOpen);
      toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    [
      document.getElementById('btn-new'),
      document.getElementById('btn-download'),
      document.getElementById('btn-export'),
      document.getElementById('btn-share')
    ].forEach(function (source) {
      var proxy = createActionProxy(source, true);
      if (proxy) mobileActions.appendChild(proxy);
    });

    [
      document.getElementById('btn-download'),
      document.getElementById('btn-export')
    ].forEach(function (source) {
      if (!source || actions.contains(source)) return;
      var menuProxy = createActionProxy(source, false);
      if (menuProxy) actions.appendChild(menuProxy);
    });

    toggleBtn.addEventListener('click', function () {
      setOpen(!header.classList.contains('is-open'));
    });

    document.addEventListener('click', function (event) {
      if (!header.classList.contains('is-open')) return;
      if (header.contains(event.target)) return;
      setOpen(false);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setOpen(false);
    });

    header.addEventListener('click', function (event) {
      if (event.target.closest('.header-actions .btn, .header-actions a, .theme-toggle')) {
        setOpen(false);
      }
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 768) setOpen(false);
    });

    header.appendChild(mobileActions);
    header.appendChild(toggleBtn);
    ensureEditorHeaderObserver();
    return actions;
  }

  function ensureConfirmModal() {
    if (confirmModal) return confirmModal;
    if (!document.body) return null;

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay hidden';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Confirm action');
    overlay.innerHTML =
      '<div class="modal modal-sm">' +
        '<h2 class="modal-title">Discard progress?</h2>' +
        '<p class="modal-body-text">Starting a new file will remove your current edits.</p>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-ghost" data-confirm-cancel>Cancel</button>' +
          '<button type="button" class="btn btn-danger" data-confirm-accept>Start New</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    confirmModal = {
      overlay: overlay,
      title: overlay.querySelector('.modal-title'),
      body: overlay.querySelector('.modal-body-text'),
      cancel: overlay.querySelector('[data-confirm-cancel]'),
      accept: overlay.querySelector('[data-confirm-accept]'),
      onConfirm: null
    };

    function closeConfirm() {
      confirmModal.overlay.classList.add('hidden');
      confirmModal.onConfirm = null;
    }

    confirmModal.close = closeConfirm;

    confirmModal.cancel.addEventListener('click', closeConfirm);
    confirmModal.overlay.addEventListener('click', function (event) {
      if (event.target === confirmModal.overlay) closeConfirm();
    });
    confirmModal.accept.addEventListener('click', function () {
      var onConfirm = confirmModal.onConfirm;
      closeConfirm();
      if (onConfirm) onConfirm();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && confirmModal && !confirmModal.overlay.classList.contains('hidden')) {
        closeConfirm();
      }
    });

    return confirmModal;
  }

  var FLAG_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>';

  function ensureReportIssueModal() {
    if (reportIssueModal) return reportIssueModal;
    if (!document.body) return null;

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay hidden';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Report an issue');
    overlay.innerHTML =
      '<div class="modal">' +
        '<button type="button" class="modal-close" aria-label="Close">&times;</button>' +
        '<h2 class="modal-title">Report an Issue</h2>' +
        '<div class="form-group">' +
          '<label for="report-issue-title">Subject</label>' +
          '<input type="text" id="report-issue-title" placeholder="Brief summary of the issue" maxlength="200">' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="report-issue-body">Description</label>' +
          '<textarea id="report-issue-body" rows="5" placeholder="What were you doing? What went wrong?" style="resize:vertical"></textarea>' +
        '</div>' +
        '<div class="modal-actions" style="justify-content:flex-end">' +
          '<button type="button" class="btn btn-ghost" data-report-cancel>Cancel</button>' +
          '<button type="button" class="btn btn-primary" data-report-submit>Submit</button>' +
        '</div>' +
        '<p class="report-issue-status" style="display:none;margin-top:.75rem;font-size:.875rem;text-align:center"></p>' +
      '</div>';

    document.body.appendChild(overlay);

    var titleInput = overlay.querySelector('#report-issue-title');
    var bodyInput = overlay.querySelector('#report-issue-body');
    var submitBtn = overlay.querySelector('[data-report-submit]');
    var cancelBtn = overlay.querySelector('[data-report-cancel]');
    var closeBtn = overlay.querySelector('.modal-close');
    var statusEl = overlay.querySelector('.report-issue-status');

    function openModal() {
      titleInput.value = '';
      bodyInput.value = '';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';
      statusEl.style.display = 'none';
      statusEl.className = 'report-issue-status';
      overlay.classList.remove('hidden');
      setTimeout(function () { titleInput.focus(); }, 50);
    }

    function closeModal() {
      overlay.classList.add('hidden');
    }

  function showStatus(msg, isError) {
      statusEl.textContent = msg;
      statusEl.style.display = 'block';
      statusEl.style.color = isError ? 'var(--danger, #ef4444)' : 'var(--success, #22c55e)';
    }

    submitBtn.addEventListener('click', function () {
      var title = titleInput.value.trim();
      if (!title) { titleInput.focus(); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';
      statusEl.style.display = 'none';

      resolveApiBase()
        .then(function (apiBase) {
          if (!apiBase) throw new Error('Missing API base URL');
          return _signedFetch(apiBase + '/report-issue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title, body: bodyInput.value.trim() })
          });
        })
        .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
        .then(function (r) {
          if (r.ok) {
            showStatus('Issue submitted — thank you!', false);
            submitBtn.textContent = 'Done';
            setTimeout(closeModal, 2000);
          } else {
            showStatus((r.data && r.data.error) || 'Something went wrong.', true);
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit';
          }
        })
        .catch(function () {
          showStatus('Network error — please try again.', true);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit';
        });
    });

    cancelBtn.addEventListener('click', closeModal);
    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeModal();
    });

    reportIssueModal = { open: openModal, close: closeModal };
    return reportIssueModal;
  }

  function openReportIssue() {
    var modal = ensureReportIssueModal();
    if (modal) modal.open();
  }

  function makeReportIssueBtn(className) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute('aria-label', 'Report an issue');
    btn.title = 'Report an issue';
    btn.innerHTML = FLAG_ICON + ' <span>Report issue</span>';
    btn.addEventListener('click', openReportIssue);
    return btn;
  }

  window.GWConfirmAction = function (opts) {
    var modal = ensureConfirmModal();
    if (!modal) {
      if (!opts || !opts.onConfirm) return;
      if (window.confirm((opts.title ? opts.title + '\n\n' : '') + (opts.message || 'Are you sure?'))) {
        opts.onConfirm();
      }
      return;
    }

    opts = opts || {};
    modal.title.textContent = opts.title || 'Discard progress?';
    modal.body.textContent = opts.message || 'Starting a new file will remove your current edits.';
    modal.accept.textContent = opts.confirmLabel || 'Start New';
    modal.onConfirm = opts.onConfirm || null;
    modal.overlay.classList.remove('hidden');
  };

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
      var actions = setupMobileNav(nav);
      if (actions) {
        actions.insertBefore(btn, actions.firstChild);
      } else {
        nav.appendChild(btn);
      }
      // Also inject into the collapsible nav links for mobile
      var navLinks = nav.querySelector('.site-nav-links');
      if (navLinks) {
        navLinks.appendChild(makeReportIssueBtn('report-issue-nav-btn'));
      }
      return;
    }

    // Editor pages — place theme toggle directly on header (always visible),
    // report-issue and mobile menu inside .header-actions
    var header = document.querySelector('.editor-header, .video-editor-header, .vtg-header');
    if (header) {
      var headerActions = ensureHeaderActions(header);
      headerActions.insertBefore(makeReportIssueBtn('report-issue-nav-btn'), headerActions.firstChild);
      // Place theme toggle on the header itself, before header-actions, so it's
      // always visible even when header-actions collapses on mobile
      btn.style.marginLeft = 'auto';
      btn.style.marginRight = '8px';
      header.insertBefore(btn, headerActions);
      setupEditorHeader(header, headerActions);
    }
  });

  // ── Global error reporting ──

  var reportedErrors = {};
  var ERROR_COOLDOWN = 60000; // 1 minute between duplicate reports

  function reportErrorToGithub(title, body) {
    var key = title;
    var now = Date.now();
    if (reportedErrors[key] && now - reportedErrors[key] < ERROR_COOLDOWN) return;
    reportedErrors[key] = now;

    // location.href can carry share IDs (e.g. editor.html?id=...), so report the
    // path only — enough to locate the bug, nothing that identifies the visitor.
    var fullBody = body +
      '\n\n---\n' +
      '**Page:** ' + location.origin + location.pathname + '\n' +
      '**UA:** ' + navigator.userAgent + '\n' +
      '**Time:** ' + new Date().toISOString();

    resolveApiBase().then(function (apiBase) {
      if (!apiBase) return;
      _signedFetch(apiBase + '/report-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '[Auto] ' + title, body: fullBody })
      }).catch(function () {});
    });
  }

  function resolveApiBase() {
    if (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) {
      return Promise.resolve(API_BASE_URL);
    }
    if (window.__gifwidgetsApiBaseUrl) {
      return Promise.resolve(window.__gifwidgetsApiBaseUrl);
    }
    if (!window.__gifwidgetsApiBaseUrlPromise) {
      window.__gifwidgetsApiBaseUrlPromise = fetch('/app.js', { cache: 'no-store' })
        .then(function (res) { return res.ok ? res.text() : ''; })
        .then(function (source) {
          var match = source.match(/const API_BASE_URL = "([^"]+)"/);
          window.__gifwidgetsApiBaseUrl = match ? match[1] : '';
          return window.__gifwidgetsApiBaseUrl;
        })
        .catch(function () { return ''; });
    }
    return window.__gifwidgetsApiBaseUrlPromise;
  }

  window.onerror = function (message, source, lineno, colno) {
    var title = String(message).substring(0, 150);
    var body = '**Error:** `' + message + '`\n' +
      '**Source:** `' + (source || '?') + ':' + (lineno || '?') + ':' + (colno || '?') + '`';
    reportErrorToGithub(title, body);
  };

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    var msg = (reason && reason.message) ? reason.message : String(reason);
    var stack = (reason && reason.stack) ? '\n```\n' + reason.stack.substring(0, 500) + '\n```' : '';
    var title = 'Unhandled rejection: ' + msg.substring(0, 120);
    var body = '**Rejection:** `' + msg + '`' + stack;
    reportErrorToGithub(title, body);
  });

})();
