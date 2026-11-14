(function () {
  'use strict';

  function trapFocus(modal) {
    if (!modal) return;
    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const focusables = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      const visible = Array.from(focusables).filter(el => el.offsetParent !== null);
      if (!visible.length) return;
      const first = visible[0];
      const last = visible[visible.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    modal.addEventListener('keydown', onKey);
  }

  function init() {
    document.querySelectorAll('.atab-content').forEach(el => {
      if (!el.getAttribute('aria-live')) el.setAttribute('aria-live', 'polite');
    });
    const analysis = document.getElementById('analysisStatus');
    if (analysis) analysis.setAttribute('aria-live', 'polite');

    ['#adminModal', '#editQuizModal', '#modeModal', '#helpModal', '#videoModal', '#editCourseModal', '#apkInfoModal', '#globalSearchModal'].forEach(sel => {
      const m = document.querySelector(sel);
      if (!m) return;
      if (!m.getAttribute('role')) m.setAttribute('role', 'dialog');
      if (!m.getAttribute('aria-modal')) m.setAttribute('aria-modal', 'true');
      trapFocus(m);
    });

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.removeAttribute('aria-current'));
        tab.setAttribute('aria-current', 'page');
      });
    });

    const observer = new MutationObserver(() => {
      document.querySelectorAll('button[data-icon-btn]').forEach(btn => {
        if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', btn.textContent.trim());
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.A11y = { init };
})();