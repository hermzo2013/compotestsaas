(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  let modal = null;
  let input = null;
  let results = null;
  let currentResults = [];
  let selectedIdx = 0;

  function buildModal() {
    if (modal) return;
    modal = document.createElement('div');
    modal.id = 'globalSearchModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Recherche globale');
    modal.innerHTML =
      '<div class="global-search-content">' +
      '<div class="global-search-header">' +
      '<span class="global-search-icon">🔍</span>' +
      '<input type="search" id="globalSearchInput" placeholder="Rechercher quiz, cours, messages..." autocomplete="off" aria-label="Recherche">' +
      '<button type="button" class="global-search-close" aria-label="Fermer la recherche">✖</button>' +
      '</div>' +
      '<div id="globalSearchResults" class="global-search-results"><p class="global-search-hint">Tape pour rechercher...</p></div>' +
      '<div class="global-search-footer"><span>↑↓ naviguer</span><span>Entrée ouvrir</span><span>Échap fermer</span></div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.querySelector('.global-search-close').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    input = modal.querySelector('#globalSearchInput');
    results = modal.querySelector('#globalSearchResults');
    const debouncedSearch = debounce(doSearch, 300);
    input.addEventListener('input', () => debouncedSearch(input.value));
    input.addEventListener('keydown', onKeyDown);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const el = results.querySelector('.global-search-item.active');
      if (el) el.click();
    }
  }

  function moveSelection(dir) {
    if (!currentResults.length) return;
    selectedIdx = (selectedIdx + dir + currentResults.length) % currentResults.length;
    const items = results.querySelectorAll('.global-search-item');
    items.forEach((el, i) => el.classList.toggle('active', i === selectedIdx));
    if (items[selectedIdx]) items[selectedIdx].scrollIntoView({ block: 'nearest' });
  }

  async function doSearch(query) {
    const q = String(query || '').trim();
    if (!q || q.length < 2) {
      results.innerHTML = '<p class="global-search-hint">Tape au moins 2 caractères pour rechercher...</p>';
      currentResults = [];
      return;
    }
    results.innerHTML = '<p class="global-search-hint">Recherche en cours...</p>';
    const sb = window.supabaseClient;
    if (!sb) {
      results.innerHTML = '<p class="global-search-hint">Supabase non disponible.</p>';
      return;
    }
    const term = '%' + q + '%';
    const [quizRes, courseRes, msgRes] = await Promise.all([
      sb.from('quizzes').select('id,title,subject,level').or('title.ilike.' + term + ',subject.ilike.' + term).limit(10).catch(() => ({ data: [] })),
      sb.from('courses').select('id,title,level').ilike('title', term).limit(10).catch(() => ({ data: [] })),
      sb.from('community_posts').select('id,content,author_name,created_at').ilike('content', term).limit(10).catch(() => ({ data: [] }))
    ]);
    const quizzes = (quizRes && quizRes.data) || [];
    const courses = (courseRes && courseRes.data) || [];
    const messages = (msgRes && msgRes.data) || [];

    currentResults = [];
    let html = '';

    if (quizzes.length) {
      html += '<div class="global-search-group"><div class="global-search-group-title">📚 Quiz (' + quizzes.length + ')</div>';
      quizzes.forEach(q => {
        currentResults.push({ type: 'quiz', item: q });
        html += '<div class="global-search-item" data-idx="' + (currentResults.length - 1) + '"><b>' + esc(q.title) + '</b><span>' + esc(q.subject || '') + ' · ' + esc(q.level || '') + '</span></div>';
      });
      html += '</div>';
    }
    if (courses.length) {
      html += '<div class="global-search-group"><div class="global-search-group-title">📖 Cours (' + courses.length + ')</div>';
      courses.forEach(c => {
        currentResults.push({ type: 'course', item: c });
        html += '<div class="global-search-item" data-idx="' + (currentResults.length - 1) + '"><b>' + esc(c.title) + '</b><span>' + esc(c.level || '') + '</span></div>';
      });
      html += '</div>';
    }
    if (messages.length) {
      html += '<div class="global-search-group"><div class="global-search-group-title">💬 Messages (' + messages.length + ')</div>';
      messages.forEach(m => {
        currentResults.push({ type: 'message', item: m });
        const preview = (m.content || '').slice(0, 80) + ((m.content || '').length > 80 ? '…' : '');
        html += '<div class="global-search-item" data-idx="' + (currentResults.length - 1) + '"><b>' + esc(m.author_name || 'Anonyme') + '</b><span>' + esc(preview) + '</span></div>';
      });
      html += '</div>';
    }
    if (!currentResults.length) {
      html = '<p class="global-search-hint">Aucun résultat pour « ' + esc(q) + ' ».</p>';
    } else {
      selectedIdx = 0;
    }
    results.innerHTML = html;
    results.querySelectorAll('.global-search-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx, 10);
        const r = currentResults[idx];
        if (!r) return;
        close();
        handleResult(r);
      });
    });
  }

  function handleResult(r) {
    if (r.type === 'quiz') {
      const cache = window.libraryCache || [];
      const idx = cache.findIndex(q => q.id === r.item.id);
      if (idx >= 0 && window.openModeModalByIndex) window.openModeModalByIndex(idx);
      else {
        const tab = document.querySelector('.tab[data-tab="library"]');
        if (tab) tab.click();
      }
    } else if (r.type === 'course') {
      const tab = document.querySelector('.tab[data-tab="courses"]');
      if (tab) tab.click();
    } else if (r.type === 'message') {
      const popup = document.getElementById('communityPopup');
      if (popup && !popup.classList.contains('show') && window.toggleCommunityPopup) window.toggleCommunityPopup();
    }
  }

  function open() {
    buildModal();
    modal.classList.add('show');
    input.value = '';
    results.innerHTML = '<p class="global-search-hint">Tape pour rechercher...</p>';
    currentResults = [];
    selectedIdx = 0;
    setTimeout(() => input.focus(), 50);
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (!modal) return;
    modal.classList.remove('show');
    document.body.style.overflow = '';
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      open();
    }
  });

  window.GlobalSearch = { open, close };
})();