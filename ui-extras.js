/* Révisio — confort d'utilisation : chargement en « squelettes » et bandeau hors ligne. */
(function () {
  'use strict';

  // ---------- Styles (clair / sombre, animation désactivée si l'utilisateur le demande) ----------
  var css = '\
.skel{position:relative;overflow:hidden;background:#E5E7EB;border-radius:8px}\
.skel::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:skel-shimmer 1.3s infinite}\
.skel-row{display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid #E5E7EB}\
.skel-col{flex:1;display:flex;flex-direction:column;gap:8px}\
.skel-line{height:12px}.skel-line.w70{width:70%}.skel-line.w45{width:45%}.skel-line.w90{width:90%}\
.skel-pill{width:34px;height:34px;border-radius:10px;flex:none}\
@keyframes skel-shimmer{100%{transform:translateX(100%)}}\
@media (prefers-color-scheme:dark){.skel{background:#374151}.skel::after{background:linear-gradient(90deg,transparent,rgba(255,255,255,.12),transparent)}.skel-row{border-color:#374151}}\
@media (prefers-reduced-motion:reduce){.skel::after{animation:none}}\
#offlineBanner{position:fixed;top:0;left:0;right:0;z-index:10002;padding:calc(6px + env(safe-area-inset-top,0px)) 12px 6px;text-align:center;font:600 13px/1.4 system-ui,sans-serif;background:#92400E;color:#fff;transition:background .2s}\
#offlineBanner.back{background:#047857}\
#offlineBanner a{color:#fff;text-decoration:underline;margin-left:8px}\
html.offline-on body{padding-top:34px}\
html.offline-on header{top:34px}';
  var st = document.createElement('style'); st.id = 'uiExtrasStyle'; st.textContent = css; document.head.appendChild(st);

  // ---------- Squelettes ----------
  function row() {
    return '<div class="skel-row"><div class="skel skel-pill"></div><div class="skel-col"><div class="skel skel-line w70"></div><div class="skel skel-line w45"></div></div></div>';
  }
  window.Skeleton = {
    /** HTML de n lignes « titre + sous-titre » (listes de quiz, cours, communauté…) */
    list: function (n) { var h = ''; for (var i = 0; i < (n || 4); i++) h += row(); return '<div aria-busy="true" aria-label="Chargement">' + h + '</div>'; },
    /** HTML de n lignes de texte grises */
    lines: function (n) { var h = '', w = ['w90', 'w70', 'w45']; for (var i = 0; i < (n || 3); i++) h += '<div class="skel skel-line ' + w[i % 3] + '" style="margin:10px 0"></div>'; return '<div aria-busy="true">' + h + '</div>'; },
    /** Insère un squelette juste après un élément (ex. pendant que l'IA travaille) ; retourne l'élément (appeler .remove()) */
    show: function (after, n) {
      var d = document.createElement('div'); d.className = 'skel-holder'; d.innerHTML = window.Skeleton.list(n || 4);
      if (after && after.parentNode) after.parentNode.insertBefore(d, after.nextSibling); else document.body.appendChild(d);
      return d;
    }
  };

  // ---------- Bandeau « hors ligne » ----------
  var banner = null, hideTimer = null;
  function ensure() {
    if (banner) return banner;
    banner = document.createElement('div'); banner.id = 'offlineBanner'; banner.setAttribute('role', 'status'); banner.setAttribute('aria-live', 'polite');
    document.body.appendChild(banner); return banner;
  }
  function showOffline() {
    clearTimeout(hideTimer);
    var b = ensure(); b.className = ''; b.textContent = '📡 Vous êtes hors ligne';
    var a = document.createElement('a'); a.href = '/offline.html'; a.textContent = 'Voir les quiz hors ligne'; b.appendChild(a);
    document.documentElement.classList.add('offline-on');
  }
  function showBack() {
    var b = ensure(); b.className = 'back'; b.textContent = '✅ Connexion rétablie';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { if (banner) { banner.remove(); banner = null; } document.documentElement.classList.remove('offline-on'); }, 2500);
  }
  window.addEventListener('offline', showOffline);
  window.addEventListener('online', showBack);
  if (!navigator.onLine) { if (document.body) showOffline(); else document.addEventListener('DOMContentLoaded', showOffline); }
})();
