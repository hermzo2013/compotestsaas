/* mobile-ux.js — Refonte UX mobile : menu Profil, avatar, bouton "+" admin, page Profil, modale "Ajouter un cours".
   Aucune logique métier ici : on s'appuie sur les fonctions/IDs existants (activateTab, isAdmin, addCourse…).
   Chargé en defer, après index.html. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement;
  var APK_KEY = 'revisio_apk_banner_dismissed';

  function adminNow() { try { return typeof isAdmin !== 'undefined' && isAdmin === true; } catch (e) { return false; } }

  /* ---------- État global → classes sur <html> (utilisées par mobile-ux.css) ---------- */
  function syncState() {
    root.classList.toggle('is-admin', adminNow());
    var c = $('tab-courses');
    root.classList.toggle('on-courses', !!c && !c.classList.contains('hide'));
    try { root.classList.toggle('apk-dismissed', localStorage.getItem(APK_KEY) === '1'); } catch (e) {}
    try { if (window.AndroidDownload && window.AndroidDownload.isInstalled()) root.classList.add('app-installed'); } catch (e) {}
    var m = $('pmRole'); if (m) m.textContent = adminNow() ? 'Administrateur' : 'Étudiant';
    syncAvatar();
  }
  function syncAvatar() {
    var l = $('userLabel'), a = $('avatarInitial');
    if (!l || !a) return;
    var name = (l.textContent || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
    a.textContent = (name && name !== 'Non connecté') ? name.charAt(0) : '?';
    var big = $('profileName'); if (big) big.textContent = name || '—';
  }

  /* ---------- Menu déroulant Profil ---------- */
  function setMenu(open) {
    var m = $('profileMenu'), b = $('profileBtn');
    if (!m || !b) return;
    m.hidden = !open;
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function initMenu() {
    var b = $('profileBtn'), m = $('profileMenu');
    if (!b || !m) return;
    b.addEventListener('click', function (e) { e.stopPropagation(); setMenu(m.hidden); });
    m.addEventListener('click', function (e) { if (e.target.closest('button')) setTimeout(function () { setMenu(false); }, 0); });
    document.addEventListener('click', function (e) { if (!m.hidden && !e.target.closest('.profile-wrap')) setMenu(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });
    var p = $('pmProfile'); if (p) p.addEventListener('click', function () { goTab('profile'); });
    var n = $('pmInbox'); if (n) n.addEventListener('click', function () { var bell = $('bellBtn'); if (bell) bell.click(); });
  }
  function goTab(name) { try { if (typeof activateTab === 'function') activateTab(name); window.scrollTo(0, 0); } catch (e) {} }

  /* ---------- Page Profil > À propos (+ onglet caché indispensable à activateTab) ---------- */
  function buildProfile() {
    var tabs = document.querySelector('#mainApp > .tabs'), main = $('mainApp');
    if (!tabs || !main || $('tab-profile')) return;
    var btn = document.createElement('button');
    btn.className = 'tab'; btn.setAttribute('data-tab', 'profile'); btn.style.display = 'none';
    btn.setAttribute('aria-hidden', 'true'); btn.tabIndex = -1; btn.type = 'button';
    tabs.appendChild(btn);
    var sec = document.createElement('div');
    sec.id = 'tab-profile'; sec.className = 'tab-content hide';
    sec.innerHTML =
      '<div class="panel">' +
      '<div class="rv-profile-head"><span class="avatar-btn"><span id="avatarInitial2">?</span></span>' +
      '<div><div id="profileName" style="font-weight:800;font-size:18px">—</div><div class="rv-sub" id="pmRole2"></div></div></div>' +
      '<div class="rv-about"><h3>À propos</h3>' +
      '<a href="/confidentialite" target="_blank" rel="noopener">Confidentialité <span>›</span></a>' +
      '<a href="/conditions" target="_blank" rel="noopener">Conditions d’utilisation <span>›</span></a>' +
      '<button type="button" id="aboutCookies">Gérer les cookies <span>›</span></button>' +
      '<div class="rv-credit">Développé par <b>NSC-GROUP</b> ( THC )</div></div></div>';
    main.appendChild(sec);
    $('aboutCookies').addEventListener('click', function () { if (window.RevisioConsent) window.RevisioConsent.open(); });
  }

  /* ---------- Bouton central "+" (admin) : feuille d'actions ---------- */
  function sheet() {
    var bg = $('rvSheetBg'), sh = $('rvSheet');
    if (bg) return { bg: bg, sh: sh };
    bg = document.createElement('div'); bg.id = 'rvSheetBg'; bg.className = 'rv-sheet-bg';
    sh = document.createElement('div'); sh.id = 'rvSheet'; sh.className = 'rv-sheet'; sh.setAttribute('role', 'dialog');
    sh.innerHTML =
      '<button type="button" data-go="create">📚 Créer un test</button>' +
      '<button type="button" data-go="import-html">🧩 Importer HTML</button>' +
      '<button type="button" class="rv-sheet-cancel" data-close="1">Annuler</button>';
    document.body.appendChild(bg); document.body.appendChild(sh);
    bg.addEventListener('click', closeSheet);
    sh.addEventListener('click', function (e) {
      var g = e.target.closest('[data-go]');
      if (g) { closeSheet(); goTab(g.getAttribute('data-go')); }
      else if (e.target.closest('[data-close]')) closeSheet();
    });
    return { bg: bg, sh: sh };
  }
  function openSheet() { if (!adminNow()) return; var s = sheet(); s.bg.classList.add('show'); requestAnimationFrame(function () { s.sh.classList.add('show'); }); }
  function closeSheet() { var bg = $('rvSheetBg'), sh = $('rvSheet'); if (sh) sh.classList.remove('show'); if (bg) bg.classList.remove('show'); }
  function buildFab() {
    if ($('fabAdd')) return;
    var f = document.createElement('button');
    f.id = 'fabAdd'; f.type = 'button'; f.setAttribute('aria-label', 'Créer'); f.textContent = '+';
    f.addEventListener('click', openSheet);
    document.body.appendChild(f);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeSheet(); closeCourseForm(); } });
  }

  /* ---------- Page Cours (admin) : "+ Ajouter" → formulaire en feuille modale ---------- */
  function openCourseForm() {
    if (!adminNow()) return;
    var f = $('adminCourseForm'); if (!f) return;
    f.classList.remove('hide'); f.classList.add('rv-open');
    var bg = $('rvSheetBg') || sheet().bg; bg.classList.add('show');
    bg.onclick = closeCourseForm;
  }
  function closeCourseForm() {
    var f = $('adminCourseForm'); if (f) f.classList.remove('rv-open');
    var bg = $('rvSheetBg'); if (bg) { bg.classList.remove('show'); bg.onclick = null; }
  }
  function buildCourseModal() {
    var f = $('adminCourseForm');
    if (f && !f.querySelector('.rv-form-head')) {
      var h = f.querySelector('h3');
      var head = document.createElement('div'); head.className = 'rv-form-head';
      var x = document.createElement('button'); x.type = 'button'; x.className = 'rv-form-close'; x.setAttribute('aria-label', 'Fermer'); x.textContent = '✕';
      x.addEventListener('click', closeCourseForm);
      if (h) { f.insertBefore(head, h); head.appendChild(h); }
      head.appendChild(x);
    }
    if (!$('fabCourse')) {
      var b = document.createElement('button'); b.id = 'fabCourse'; b.type = 'button'; b.textContent = '＋ Ajouter';
      b.addEventListener('click', openCourseForm);
      document.body.appendChild(b);
    }
    /* Après un ajout réussi, addCourse() recharge la liste : on referme la feuille à ce moment-là */
    if (typeof window.loadCourses === 'function' && !window.loadCourses.__rv) {
      var orig = window.loadCourses;
      var wrapped = async function () { var r = await orig.apply(this, arguments); closeCourseForm(); return r; };
      wrapped.__rv = true; window.loadCourses = wrapped;
    }
  }

  /* ---------- Téléchargement : navigateur (fetch + Blob) ou application Android (DownloadManager) ---------- */
  function isAndroidApp() {
    try { return !!(window.Android && typeof window.Android.downloadFile === 'function'); } catch (e) { return false; }
  }
  window.handleDownload = async function handleDownload(url, filename) {
    if (!url) { alert("Fichier introuvable, contacte l'admin"); return; }
    filename = filename || String(url).split('?')[0].split('/').pop() || 'cours.pdf';
    if (isAndroidApp()) {                                   // WebView Android : pont natif
      try { window.Android.downloadFile(String(url), String(filename)); } catch (e) { alert('Téléchargement impossible : ' + (e && e.message || e)); }
      return;
    }
    try {                                                   // Navigateur : fetch + Blob + URL.createObjectURL
      var res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var blob = await res.blob();
      var href = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = href; a.download = filename; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
    } catch (e) {                                           // CORS / réseau : repli = ouverture directe du fichier
      window.open(url, '_blank', 'noopener');
    }
  };

  /* ---------- Init ---------- */
  function init() {
    buildProfile(); buildFab(); buildCourseModal(); initMenu();
    var observe = function (el, opts) { if (el) new MutationObserver(syncState).observe(el, opts); };
    observe($('adminBtn'), { attributes: true, attributeFilter: ['style'] });
    observe($('tab-courses'), { attributes: true, attributeFilter: ['class'] });
    observe($('userLabel'), { childList: true, characterData: true, subtree: true });
    observe($('mainApp'), { attributes: true, attributeFilter: ['style'] });
    var ban = $('apkBanner'); if (ban) ban.addEventListener('click', function (e) { if (e.target.closest('[data-apk-dismiss]')) setTimeout(syncState, 0); });
    syncState();
    /* Le 2e avatar / rôle de la page Profil suivent le menu */
    new MutationObserver(function () { var a = $('avatarInitial'), b = $('avatarInitial2'); if (a && b) b.textContent = a.textContent; var r = $('pmRole'), r2 = $('pmRole2'); if (r && r2) r2.textContent = r.textContent; }).observe($('profileBtn') || document.body, { childList: true, subtree: true, characterData: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.RevisioMobileUX = { syncState: syncState, openCourseForm: openCourseForm, closeCourseForm: closeCourseForm };
})();
