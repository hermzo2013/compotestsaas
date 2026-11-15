/* consent.js — Bandeau d'information / consentement (cookies et stockage local) de Révisio.
   Révisio n'utilise aucun traceur publicitaire ni outil de mesure d'audience : seuls des éléments
   « essentiels » (session, thème, historique local) sont stockés. Le choix est mémorisé et exposé via
   window.RevisioConsent pour conditionner tout futur service optionnel :
       if (window.RevisioConsent && window.RevisioConsent.allows('analytics')) { ...charger l'outil... }
   Écouter aussi l'événement : document.addEventListener('revisio:consent', e => e.detail.optional) */
(function () {
  'use strict';
  var KEY = 'revisio_consent', VERSION = 1, banner = null;

  function read() {
    try { var v = JSON.parse(localStorage.getItem(KEY)); return v && v.v === VERSION ? v : null; } catch (e) { return null; }
  }
  function save(optional) {
    var c = { v: VERSION, essential: true, optional: !!optional, ts: new Date().toISOString() };
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) {}
    try { document.dispatchEvent(new CustomEvent('revisio:consent', { detail: c })); } catch (e) {}
    return c;
  }
  function close() { if (banner && banner.parentNode) banner.parentNode.removeChild(banner); banner = null; }

  function injectStyle() {
    if (document.getElementById('consentStyle')) return;
    var s = document.createElement('style');
    s.id = 'consentStyle';
    s.textContent =
      '#consentBanner{position:fixed;left:0;right:0;bottom:0;z-index:6000;background:#fff;color:#0F172A;border-top:3px solid #059669;box-shadow:0 -6px 24px rgba(0,0,0,.18);padding:14px 16px calc(14px + env(safe-area-inset-bottom,0px));font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
      'html.dark #consentBanner{background:#1E293B;color:#E2E8F0;border-top-color:#34D399}' +
      '#consentBanner .cb-in{max-width:920px;margin:0 auto;display:flex;gap:14px;align-items:center;flex-wrap:wrap}' +
      '#consentBanner p{margin:0;flex:1 1 320px}' +
      '#consentBanner a{color:#059669;font-weight:700}' +
      'html.dark #consentBanner a{color:#34D399}' +
      '#consentBanner .cb-btns{display:flex;gap:8px;flex-wrap:wrap}' +
      '#consentBanner button{min-height:44px;padding:0 16px;border-radius:10px;border:2px solid #059669;font-weight:800;font-size:14px;cursor:pointer;background:#059669;color:#fff}' +
      '#consentBanner button.cb-alt{background:transparent;color:#059669}' +
      'html.dark #consentBanner button.cb-alt{color:#34D399;border-color:#34D399}' +
      '#consentBanner button:focus-visible{outline:3px solid #F59E0B;outline-offset:2px}';
    document.head.appendChild(s);
  }

  function open() {
    if (banner) return;
    injectStyle();
    banner = document.createElement('div');
    banner.id = 'consentBanner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookies et stockage local');
    banner.innerHTML =
      '<div class="cb-in">' +
      '<p><strong>🍪 Cookies et stockage local.</strong> Révisio utilise uniquement des données <b>essentielles</b> stockées sur votre appareil (session de connexion, thème, historique) et ne contient ni publicité ni traceur. ' +
      'Vous pouvez accepter les éventuels services optionnels futurs ou vous limiter à l\'essentiel. ' +
      '<a href="/confidentialite">Politique de confidentialité</a> · <a href="/conditions">Conditions</a></p>' +
      '<div class="cb-btns">' +
      '<button type="button" class="cb-alt" data-consent="essential">Essentiel uniquement</button>' +
      '<button type="button" data-consent="all">Tout accepter</button>' +
      '</div></div>';
    banner.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button[data-consent]');
      if (!b) return;
      save(b.getAttribute('data-consent') === 'all');
      close();
    });
    document.body.appendChild(banner);
  }

  function init() { if (!read()) open(); }

  window.RevisioConsent = {
    open: open,
    get: read,
    allows: function (category) { if (category === 'essential') return true; var c = read(); return !!(c && c.optional); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
