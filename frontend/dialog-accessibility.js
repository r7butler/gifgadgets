(function () {
  // Manage all editor and shared dialogs, including dynamically inserted ones.
  document.addEventListener('DOMContentLoaded', function () {
    var current = null;
    var previousFocus = null;
    var lastTrigger = null;
    // Safari does not focus a button when it is clicked with a pointer.
    document.addEventListener('click', function (event) {
      var trigger = event.target.closest('button, a[href], [role="button"]');
      if (trigger && trigger.getClientRects().length) lastTrigger = trigger;
    }, true);
    function focusables(dialog) {
      return Array.from(dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex]'))
        .filter(function (el) { return !el.disabled && el.tabIndex >= 0 && el.getClientRects().length; });
    }
    function syncDialog() {
      var dialogs = Array.from(document.querySelectorAll('.modal-overlay:not(.hidden)'));
      var next = dialogs[dialogs.length - 1] || null;
      if (next === current) return;
      var restoreFocus = current && previousFocus;
      current = null;
      if (restoreFocus && restoreFocus.isConnected) restoreFocus.focus();
      current = next;
      if (!next) return;
      previousFocus = lastTrigger && lastTrigger.getClientRects().length && !next.contains(lastTrigger)
        ? lastTrigger : document.activeElement;
      next.setAttribute('role', 'dialog');
      next.setAttribute('aria-modal', 'true');
      var title = next.querySelector('h2, .modal-title');
      if (title) {
        if (!title.id) title.id = 'dialog-title-' + Math.random().toString(36).slice(2);
        next.setAttribute('aria-labelledby', title.id);
      }
      next.tabIndex = -1;
      (focusables(next)[0] || next).focus();
    }
    new MutationObserver(syncDialog).observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class']
    });
    document.addEventListener('keydown', function (event) {
      syncDialog();
      if (!current) return;
      if (event.key === 'Escape') {
        if (current.dataset.dialogDismissible === 'false') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        var close = current.querySelector('.modal-close, [id$="-cancel"], [data-report-cancel], [data-confirm-cancel]');
        if (close) close.click(); else current.classList.add('hidden');
        syncDialog();
      } else if (event.key === 'Tab') {
        var targets = focusables(current);
        var index = targets.indexOf(document.activeElement);
        if (!targets.length || (event.shiftKey && index <= 0) || (!event.shiftKey && (index < 0 || index === targets.length - 1))) {
          event.preventDefault();
          (targets[event.shiftKey ? targets.length - 1 : 0] || current).focus();
        }
      }
    }, true);
    document.addEventListener('focusin', function (event) {
      if (current && !current.contains(event.target)) (focusables(current)[0] || current).focus();
    });
  });

})();
