/* pagination.js — Pagination (cours 10/page, quiz 15/page), nouvelles cartes mobiles et page Historique.
   index.html n'appelle ce module que par 3 lignes de délégation (renderCourses, renderLibraryList, renderHistory) :
       if (window.RevisioPager) return window.RevisioPager.renderXxx(...);
   Si ce fichier ne charge pas, l'ancien rendu d'index.html continue de fonctionner tel quel.
   Lit les variables d'index.html (coursesCache, libraryCache, historyData, isAdmin, currentLibraryFilter…) sans les modifier. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var INSTITUTION = window.REVISIO_INSTITUTION || 'INFAS Agboville';   // pas de colonne "établissement" en base : valeur par défaut modifiable
  var DEFAULTS = { courses: 10, library: 15 };
  var LEVEL_SHORT = { 'LICENCE 1': 'L1', 'LICENCE 2': 'L2', 'LICENCE 3': 'L3' };
  var SHORT_LEVEL = { L1: 'LICENCE 1', L2: 'LICENCE 2', L3: 'LICENCE 3' };
  var KEEP_UPPER = ['ECG', 'IRM', 'VIH', 'SIDA', 'HTA', 'AVC', 'IDE', 'SFM', 'TSS', 'ORL', 'SNC', 'ATCD', 'PDF', 'QCM', 'SONU'];

  var state = {
    courses: { page: 1, perPage: DEFAULTS.courses, level: 'all', type: 'all' },
    library: { page: 1, perPage: DEFAULTS.library }
  };

  /* ---------- accès sûrs aux variables globales d'index.html ---------- */
  function admin() { try { return typeof isAdmin !== 'undefined' && isAdmin === true; } catch (e) { return false; } }
  function getCourses() { try { return coursesCache || []; } catch (e) { return []; } }
  function getLibrary() { try { return libraryCache || []; } catch (e) { return []; } }
  function getHistory() { try { return historyData || []; } catch (e) { return []; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function byDateDesc(a, b) { return new Date(b.created_at || 0) - new Date(a.created_at || 0); }
  function fmtDate(d) { try { return new Date(d).toLocaleDateString('fr-FR'); } catch (e) { return ''; } }

  /* ---------- per-page (sélecteur réservé à l'admin) ---------- */
  function perPage(kind) {
    if (!admin()) return DEFAULTS[kind];
    var v = state[kind].perPage;
    return [10, 20, 50].indexOf(v) !== -1 || v === DEFAULTS[kind] ? v : DEFAULTS[kind];
  }

  /* ---------- URL : ?tab=courses&page=2&niveau=L1 ---------- */
  var urlInit = (function () {
    var q = new URLSearchParams(location.search);
    return { tab: q.get('tab'), page: parseInt(q.get('page'), 10) || 1, niveau: q.get('niveau'), type: q.get('type'), pp: parseInt(q.get('pp'), 10) || 0 };
  })();
  function writeUrl(kind) {
    try {
      var q = new URLSearchParams(location.search);
      ['page', 'niveau', 'type', 'pp'].forEach(function (k) { q.delete(k); });
      if (!kind) { var tv = q.get('tab'); if (tv === 'courses' || tv === 'library') q.delete('tab'); }
      if (kind) {
        q.set('tab', kind);
        var s = state[kind];
        if (s.page > 1) q.set('page', s.page);
        var lvl = kind === 'courses' ? s.level : (typeof currentLibraryFilter !== 'undefined' ? currentLibraryFilter : 'all');
        if (lvl && lvl !== 'all') q.set('niveau', LEVEL_SHORT[lvl] || lvl);
        if (kind === 'courses' && s.type !== 'all') q.set('type', s.type);
        if (admin() && perPage(kind) !== DEFAULTS[kind]) q.set('pp', perPage(kind));
      }
      var qs = q.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (e) {}
  }
  function visible(kind) { var t = $('tab-' + (kind === 'courses' ? 'courses' : 'library')); return !!t && !t.classList.contains('hide'); }

  /* ---------- pagination : calcul + HTML ---------- */
  function slice(kind, items) {
    var pp = perPage(kind), total = items.length, pages = Math.max(1, Math.ceil(total / pp));
    var s = state[kind];
    if (s.page > pages) s.page = pages;
    if (s.page < 1) s.page = 1;
    var start = (s.page - 1) * pp;
    return { items: items.slice(start, start + pp), total: total, pages: pages, page: s.page, from: total ? start + 1 : 0, to: Math.min(total, start + pp), pp: pp };
  }
  function pagerHtml(kind, p, noun, extra) {
    var html = '<div class="rv-pager" data-kind="' + kind + '">' +
      '<div class="rv-pager-info">Affichage : ' + p.from + ' - ' + p.to + ' sur ' + p.total + ' ' + noun + (extra || '') + '</div>';
    if (p.pages > 1) {
      html += '<div class="rv-pager-row">' +
        '<button type="button" class="rv-pbtn" data-pg="prev"' + (p.page <= 1 ? ' disabled' : '') + '>‹ Précédent</button>' +
        '<span class="rv-pnum">Page ' + p.page + ' sur ' + p.pages + '</span>' +
        '<button type="button" class="rv-pbtn" data-pg="next"' + (p.page >= p.pages ? ' disabled' : '') + '>Suivant ›</button></div>';
    }
    if (admin()) {
      html += '<div class="rv-perpage">Afficher : ' + [10, 20, 50].map(function (n) {
        return '<button type="button" data-pp="' + n + '" class="' + (p.pp === n ? 'active' : '') + '">' + n + '</button>';
      }).join('') + ' par page</div>';
    }
    return html + '</div>';
  }
  function rerender(kind) {
    if (kind === 'courses') { if (typeof window.renderCourses === 'function') window.renderCourses(); }
    else if (typeof window.renderLibraryList === 'function') window.renderLibraryList();
  }
  function scrollToList(kind) {
    var el = $(kind === 'courses' ? 'coursesList' : 'libraryList');
    if (!el) return;
    var top = el.getBoundingClientRect().top + window.pageYOffset - 72;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
  function bindPager(container, kind) {
    if (container.__rvPager) return;
    container.__rvPager = true;
    container.addEventListener('click', function (e) {
      var pg = e.target.closest('[data-pg]'), pp = e.target.closest('[data-pp]');
      if (pg && !pg.disabled) {
        state[kind].page += pg.getAttribute('data-pg') === 'next' ? 1 : -1;
        rerender(kind); scrollToList(kind);
      } else if (pp && admin()) {
        state[kind].perPage = parseInt(pp.getAttribute('data-pp'), 10); state[kind].page = 1;
        rerender(kind); scrollToList(kind);
      }
    });
  }

  /* ---------- titres de cours : sans code interne, en casse normale ---------- */
  function cleanTitle(raw) {
    var t = String(raw || '').trim(), code = '';
    var m = t.match(/^\s*(\d{2}[-_ ]?[A-Za-z]{1,4}[-_ ]?\d+)\s*[-–—:_.]*\s*/);
    if (m) { code = m[1].replace(/\s+/g, ''); t = t.slice(m[0].length); }
    var letters = t.replace(/[^A-Za-zÀ-ÿ]/g, '');
    var upper = letters.replace(/[^A-ZÀ-Þ]/g, '').length;
    if (letters.length > 3 && upper / letters.length > 0.6) {
      t = t.split(/(\s+-\s+)/).map(function (seg) {
        if (/^\s+-\s+$/.test(seg)) return seg;
        var words = seg.split(' ').map(function (w) {
          var bare = w.replace(/[^A-Za-zÀ-ÿ]/g, '');
          if (KEEP_UPPER.indexOf(bare.toUpperCase()) !== -1 || (bare.length >= 2 && bare.length <= 4 && !/[AEIOUYÀ-ÿ]/i.test(bare))) return w;
          return w.toLowerCase();
        });
        var s = words.join(' ');
        return s.charAt(0).toUpperCase() + s.slice(1);
      }).join('');
    }
    return { title: t || String(raw || ''), code: code };
  }

  /* ============================== COURS ============================== */
  function buildCourseToolbar() {
    var tab = $('tab-courses'), search = $('courseSearch');
    if (!tab || !search || $('rvCourseToolbar')) return;
    var bar = document.createElement('div'); bar.id = 'rvCourseToolbar'; bar.className = 'rv-toolbar';
    var lv = [['all', 'Tous'], ['LICENCE 1', 'Licence 1'], ['LICENCE 2', 'Licence 2'], ['LICENCE 3', 'Licence 3']];
    var ty = [['all', 'Tous'], ['pdf', 'PDF'], ['video', 'Vidéo']];
    bar.innerHTML =
      '<div class="rv-chips" id="rvLevelChips" role="group" aria-label="Niveau">' + lv.map(function (x) { return '<button type="button" class="rv-chip" data-level="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<div class="rv-chips rv-chips-type" id="rvTypeChips" role="group" aria-label="Type">' + ty.map(function (x) { return '<button type="button" class="rv-chip" data-type="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>';
    search.closest('.search-bar').insertAdjacentElement('afterend', bar);
    search.placeholder = 'Rechercher un cours par titre...';
    bar.addEventListener('click', function (e) {
      var l = e.target.closest('[data-level]'), t = e.target.closest('[data-type]');
      if (l) state.courses.level = l.getAttribute('data-level');
      else if (t) state.courses.type = t.getAttribute('data-type');
      else return;
      state.courses.page = 1; markChips(); rerender('courses');
    });
    search.addEventListener('input', function () { state.courses.page = 1; }, true);   // capture : avant le rendu d'index.html
    markChips();
  }
  function markChips() {
    document.querySelectorAll('#rvLevelChips .rv-chip').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-level') === state.courses.level); });
    document.querySelectorAll('#rvTypeChips .rv-chip').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-type') === state.courses.type); });
  }
  function courseCard(c) {
    var ct = cleanTitle(c.title), lvl = LEVEL_SHORT[c.level] || c.level || '';
    var hasVideo = !!c.video_url, hasFile = !!c.file_url;
    var kind = hasFile ? 'PDF' : 'Vidéo';
    var sub = [INSTITUTION, lvl, kind].filter(Boolean).join(' • ') + (hasFile && hasVideo ? ' + Vidéo' : '');
    var main = hasFile
      ? '<a class="rv-btn" href="' + esc(c.file_url) + '" target="_blank" rel="noopener">⬇ Télécharger</a>'
      : '<button type="button" class="rv-btn rv-video" data-video="' + esc(c.id) + '">▶ Voir la vidéo</button>';
    var extra = (hasFile && hasVideo) ? '<button type="button" class="rv-mini" data-video="' + esc(c.id) + '" title="Voir la vidéo" aria-label="Voir la vidéo">▶</button>' : '';
    var adm = admin()
      ? '<button type="button" class="rv-mini" data-edit="' + esc(c.id) + '" title="Modifier" aria-label="Modifier">✏️</button>' : '';
    var chk = admin() ? '<input type="checkbox" data-sel="' + esc(c.id) + '" data-lvl="' + esc(c.level || '') + '"' + (selSet().has(c.id) ? ' checked' : '') + ' aria-label="Sélectionner">' : '';
    return '<div class="rv-card">' + chk +
      '<div class="rv-main"><h3 class="rv-title">' + esc(ct.title) + '</h3><div class="rv-sub">' + esc(sub) + '</div>' +
      (ct.code ? '<div class="rv-code">' + esc(ct.code) + '</div>' : '') + '</div>' +
      '<div class="rv-actions">' + extra + adm + main + '</div></div>';
  }
  function selSet() { try { return selectedCourseIds; } catch (e) { return new Set(); } }
  function bulkBar() {
    if (!admin()) return '';
    var ids = selSet(), n = ids.size;
    return '<div class="rv-bulk' + (n ? ' show' : '') + '" id="rvBulk"><span id="rvBulkCount">' + n + ' sélectionné' + (n > 1 ? 's' : '') + '</span>' +
      '<span><button type="button" class="btn-move" data-bulk="move">➡️ Déplacer</button> <button type="button" class="btn-delete" data-bulk="delete">🗑️ Supprimer</button></span></div>';
  }
  function bindCourseList(list) {
    if (list.__rvCourses) return;
    list.__rvCourses = true;
    list.addEventListener('click', function (e) {
      var v = e.target.closest('[data-video]'), ed = e.target.closest('[data-edit]'), bk = e.target.closest('[data-bulk]');
      if (v) {
        var c = getCourses().filter(function (x) { return String(x.id) === v.getAttribute('data-video'); })[0];
        if (c && typeof openVideoModal === 'function') openVideoModal(c.video_url, c.title);
      } else if (ed) { if (typeof openEditCourse === 'function') openEditCourse(ed.getAttribute('data-edit')); }
      else if (bk) {
        var levels = {};
        getCourses().forEach(function (c) { if (selSet().has(c.id)) levels[c.level] = 1; });
        Object.keys(levels).forEach(function (lvl) {
          if (bk.getAttribute('data-bulk') === 'delete') { if (typeof deleteSelectedCourses === 'function') deleteSelectedCourses(lvl); }
          else if (typeof moveSelectedCourses === 'function') moveSelectedCourses(lvl);
        });
      }
    });
    list.addEventListener('change', function (e) {
      var cb = e.target.closest('[data-sel]');
      if (!cb) return;
      if (typeof toggleCourseSelection === 'function') toggleCourseSelection(cb.getAttribute('data-sel'), cb.checked, cb.getAttribute('data-lvl'));
      var n = selSet().size, bar = $('rvBulk'), cnt = $('rvBulkCount');
      if (bar) bar.classList.toggle('show', n > 0);
      if (cnt) cnt.textContent = n + ' sélectionné' + (n > 1 ? 's' : '');
    });
    bindPager(list, 'courses');
  }
  /* appelé par renderCourses() d'index.html avec la liste déjà filtrée par la recherche */
  function renderCourses(list, filtered) {
    var s = state.courses;
    var items = filtered.slice();
    if (s.level !== 'all') items = items.filter(function (c) { return c.level === s.level; });
    if (s.type === 'pdf') items = items.filter(function (c) { return !!c.file_url; });
    if (s.type === 'video') items = items.filter(function (c) { return !!c.video_url; });
    items.sort(byDateDesc);
    bindCourseList(list);
    if (!items.length) { list.innerHTML = '<p style="color:var(--muted)">Aucun cours ne correspond à votre recherche.</p>'; if (visible('courses')) writeUrl('courses'); return; }
    var p = slice('courses', items);
    list.innerHTML = bulkBar() + p.items.map(courseCard).join('') + pagerHtml('courses', p, 'cours');
    if (visible('courses')) writeUrl('courses');
  }

  /* ============================ BIBLIOTHÈQUE ============================ */
  function libCard(q) {
    var idx = getLibrary().indexOf(q);
    var lvl = q.level ? (LEVEL_SHORT[q.level] || q.level) : '';
    var n = Array.isArray(q.questions) ? q.questions.length : 0;
    var sub = [lvl, n + ' question' + (n > 1 ? 's' : ''), fmtDate(q.created_at)].filter(Boolean).join(' • ');
    var a = admin();
    var checked = (function () { try { return selectedQuizIds.has(q.id) ? 'checked' : ''; } catch (e) { return ''; } })();
    var id = esc(q.id);
    return '<div class="rv-card rv-lib' + (a ? '' : ' rv-lambda') + '">' +
      (a ? '<input type="checkbox" class="quiz-select-checkbox" data-quiz-id="' + id + '" ' + checked + ' onchange="toggleQuizSelection(\'' + id + '\', this.checked)" aria-label="Sélectionner">' : '') +
      '<div class="rv-main" style="cursor:pointer" onclick="openModeModalByIndex(' + idx + ')">' +
      '<div class="rv-title">' + esc(q.title) + '</div><div class="rv-sub">' + esc(sub) + '</div></div>' +
      '<div class="rv-actions">' +
      (a ? '<button type="button" class="rv-mini" onclick="event.stopPropagation(); moveQuiz(\'' + id + '\', \'' + esc(q.level || '') + '\')" title="Déplacer">➡️</button>' +
           '<button type="button" class="rv-mini" onclick="event.stopPropagation(); openEditQuiz(' + idx + ')" title="Modifier">✏️</button>' +
           '<button type="button" class="rv-mini" onclick="event.stopPropagation(); deleteLibraryQuiz(\'' + id + '\')" title="Supprimer">🗑️</button>' : '') +
      '<button type="button" class="rv-btn" onclick="event.stopPropagation(); openModeModalByIndex(' + idx + ')">▶️ Lancer</button>' +
      '</div></div>';
  }
  /* appelé par renderLibraryList() d'index.html avec la liste déjà filtrée */
  function renderLibrary(list, filtered, moreHtml) {
    bindPager(list, 'library');
    var items = filtered.slice().sort(byDateDesc);
    var st; try { st = libraryState; } catch (e) { st = null; }
    // On charge le reste du catalogue une fois, pour connaître le vrai nombre de pages
    if (st && st.hasMore && !st.loadingMore && !st.autoFailed && typeof loadMoreLibrary === 'function') loadMoreLibrary(true);
    var p = slice('library', items);
    var loading = st && (st.hasMore || st.loadingMore) && !st.autoFailed;
    list.innerHTML = p.items.map(libCard).join('') +
      pagerHtml('library', p, 'quiz', loading ? ' (chargement…)' : '') +
      (st && st.autoFailed ? (moreHtml || '') : '');
    if (visible('library')) writeUrl('library');
  }
  function initLibrary() {
    if (typeof window.filterLibrary === 'function' && !window.filterLibrary.__rv) {
      var orig = window.filterLibrary;
      var w = function () { state.library.page = 1; return orig.apply(this, arguments); };
      w.__rv = true; window.filterLibrary = w;
    }
    var s = $('quizSearch'); if (s) s.addEventListener('input', function () { state.library.page = 1; }, true);
    var names = { all: 'Tous', 'LICENCE 1': 'Licence 1', 'LICENCE 2': 'Licence 2', 'LICENCE 3': 'Licence 3' };
    document.querySelectorAll('#libraryFilters .level-filter').forEach(function (b) { var n = names[b.getAttribute('data-level')]; if (n) b.textContent = n; });
    if (s) s.placeholder = 'Rechercher un quiz par titre...';
  }

  /* ============================== HISTORIQUE ============================== */
  function pillClass(score) { return score < 10 ? 'red' : (score <= 14 ? 'orange' : 'green'); }
  function renderHistory(list) {
    var data = getHistory();
    list.innerHTML = data.map(function (h, i) { return { h: h, i: i }; }).reverse().map(function (x) {
      var h = x.h, sc = Number(h.score) || 0;
      return '<div class="rv-hist"><div class="rv-main"><div class="rv-title">' + esc(h.title) + '</div>' +
        '<div class="rv-sub">' + esc(new Date(h.date).toLocaleString('fr-FR')) + '</div></div>' +
        '<span class="rv-pill ' + pillClass(sc) + '">' + sc.toFixed(1) + '/20</span>' +
        '<button type="button" class="rv-btn" data-redo="' + x.i + '">↻ Refaire</button>' +
        (admin() ? '<button type="button" class="rv-mini" onclick="deleteHistoryItem(' + x.i + ')" title="Supprimer">🗑️</button>' : '') + '</div>';
    }).join('');
    if (!list.__rvHist) {
      list.__rvHist = true;
      list.addEventListener('click', function (e) {
        var b = e.target.closest('[data-redo]'); if (b) redo(getHistory()[parseInt(b.getAttribute('data-redo'), 10)]);
      });
    }
  }
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim(); }
  function findQuiz(title) { var t = norm(title), lib = getLibrary(); for (var i = 0; i < lib.length; i++) if (norm(lib[i].title) === t) return i; return -1; }
  async function redo(h) {
    if (!h) return;
    var i = findQuiz(h.title);
    try { var st = libraryState; if (i < 0 && st && st.hasMore && typeof loadMoreLibrary === 'function') { await loadMoreLibrary(true); i = findQuiz(h.title); } } catch (e) {}
    if (i >= 0 && typeof openModeModalByIndex === 'function') { openModeModalByIndex(i); return; }
    // Quiz introuvable dans la bibliothèque chargée : on y va avec la recherche pré-remplie
    if (typeof activateTab === 'function') activateTab('library');
    var s = $('quizSearch');
    if (s) { s.value = h.title; s.dispatchEvent(new Event('input', { bubbles: true })); }
  }

  /* ================================ INIT ================================ */
  function init() {
    // reprise de l'état depuis l'URL (une seule fois)
    if (urlInit.tab === 'courses') {
      state.courses.page = urlInit.page;
      if (SHORT_LEVEL[urlInit.niveau]) state.courses.level = SHORT_LEVEL[urlInit.niveau];
      if (urlInit.type === 'pdf' || urlInit.type === 'video') state.courses.type = urlInit.type;
    }
    if ([10, 20, 50].indexOf(urlInit.pp) !== -1) state[urlInit.tab === 'courses' ? 'courses' : 'library'].perPage = urlInit.pp;   // ignoré si non admin (voir perPage)
    buildCourseToolbar();
    initLibrary();
    if (urlInit.tab === 'library') {
      var b = SHORT_LEVEL[urlInit.niveau] && document.querySelector('#libraryFilters .level-filter[data-level="' + SHORT_LEVEL[urlInit.niveau] + '"]');
      if (b) b.click();
      state.library.page = urlInit.page;
    }
    // L'URL suit l'onglet actif ; hors cours/bibliothèque, on retire page/niveau/type
    var tabs = document.querySelector('#mainApp > .tabs');
    if (tabs) tabs.addEventListener('click', function () {
      setTimeout(function () {
        var a = document.querySelector('.tab.active'), n = a && a.getAttribute('data-tab');
        writeUrl(n === 'courses' || n === 'library' ? n : null);
      }, 0);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.RevisioPager = { renderCourses: renderCourses, renderLibrary: renderLibrary, renderHistory: renderHistory, state: state, cleanTitle: cleanTitle };
})();
