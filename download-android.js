/* ============================================================================
   download-android.js — Téléchargement de l'application Android (Revisio.apk)
   ----------------------------------------------------------------------------
   Ce module :
     - injecte la modale d'information (HTML généré à la volée)
     - gère l'ouverture / fermeture / fond / touche Échap
     - mémorise la fermeture de la bannière dans localStorage
     - masque la bannière et le bouton si l'app tourne déjà en mode installé
       (PWA standalone, ou WebView Android via user-agent RevisioAndroid)
   Aucune dépendance externe. Chargé en defer → n'alourdit pas index.html.
   ============================================================================ */

(function () {
  'use strict';

  // ---------- Configuration ----------
  const APK_URL          = '/Revisio.apk';        // chemin servi par Express
  const APK_FILENAME     = 'Revisio.apk';         // nom du fichier téléchargé
  const APK_VERSION      = '1.0';                 // à ajuster
  const APK_SIZE         = '~15 Mo';              // à ajuster
  const APK_MIN_ANDROID  = '7.0+';                // à ajuster
  const APK_DISMISS_KEY  = 'revisio_apk_banner_dismissed';

  // ---------- Détection environnement « déjà installé » ----------
  function isAlreadyInstalled() {
    // PWA installée (mode standalone)
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    if (navigator.standalone === true) return true;   // iOS
    // App Android (WebView) : l'APK définit ce user-agent ou injecte window.__REVISIO_APP__
    if (window.__REVISIO_APP__ === true) return true;
    if (/RevisioAndroid/i.test(navigator.userAgent)) return true;
    return false;
  }

  // ---------- Construction de la modale (HTML généré une seule fois) ----------
  function buildModal() {
    if (document.getElementById('apkInfoModal')) return;   // déjà construite

    const modal = document.createElement('div');
    modal.id = 'apkInfoModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', "Télécharger l'application Android");
    modal.innerHTML = `
      <div class="apk-info-content">
        <div class="apk-info-header">
          <h2>📱 Télécharger la version Android</h2>
          <button type="button" data-apk-close title="Fermer" aria-label="Fermer">✖</button>
        </div>

        <div class="apk-info-warning">
          ⚠️ Android peut afficher un avertissement «&nbsp;Source inconnue&nbsp;». C'est normal pour les applications hors Play Store : autorise l'installation pour continuer.
        </div>

        <div class="apk-info-section">
          <h3>✨ Ce que tu obtiens</h3>
          <ul style="margin:0;padding-left:20px;">
            <li>🔔 Notifications push instantanées (quiz, communauté)</li>
            <li>📚 Accès rapide à tous tes cours et quiz</li>
            <li>💬 Chat communauté optimisé</li>
            <li>🚀 Lancement plus rapide que dans le navigateur</li>
            <li>📶 Mode hors-ligne pour les cours déjà ouverts</li>
          </ul>
        </div>

        <div class="apk-info-section">
          <h3>📲 Comment installer</h3>
          <ol>
            <li>Clique sur <b>«&nbsp;Télécharger&nbsp;»</b> ci-dessous</li>
            <li>Ouvre le fichier depuis ta barre de notifications</li>
            <li>Si demandé, autorise l'installation depuis cette source</li>
            <li>Clique sur <b>«&nbsp;Installer&nbsp;»</b>, puis ouvre l'application</li>
          </ol>
        </div>

        <div class="apk-info-section" style="font-size:12px;color:var(--muted);">
          <b>Version&nbsp;:</b> ${APK_VERSION} &nbsp;·&nbsp;
          <b>Taille&nbsp;:</b> ${APK_SIZE} &nbsp;·&nbsp;
          <b>Android&nbsp;:</b> ${APK_MIN_ANDROID}
        </div>

        <div class="apk-info-section" style="font-size:12px;color:var(--muted);">
          💡 <b>Déjà installé&nbsp;?</b> Télécharge à nouveau le fichier pour obtenir la dernière version (elle remplacera l'ancienne sans perdre tes données).
        </div>

        <div class="apk-info-footer">
          <button type="button" class="btn-cancel" data-apk-close>Annuler</button>
          <a class="btn-confirm" href="${APK_URL}" download="${APK_FILENAME}" data-apk-download>
            📥 Télécharger
          </a>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Fermetures : bouton ✖, bouton Annuler, clic sur le fond, touche Échap
    modal.querySelectorAll('[data-apk-close]').forEach(btn => {
      btn.addEventListener('click', closeModal);
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('show')) closeModal();
    });
    // Suivi du clic de téléchargement (facultatif)
    const dl = modal.querySelector('[data-apk-download]');
    if (dl) {
      dl.addEventListener('click', () => {
        console.log('[APK] téléchargement initié');
        closeModal();
      });
    }
  }

  // ---------- Ouverture / fermeture ----------
  function openModal() {
    buildModal();
    const modal = document.getElementById('apkInfoModal');
    if (modal) modal.classList.add('show');
  }
  function closeModal() {
    const modal = document.getElementById('apkInfoModal');
    if (modal) modal.classList.remove('show');
  }

  // ---------- Bannière ----------
  function hideBanner() {
    const banner = document.getElementById('apkBanner');
    if (banner) banner.style.display = 'none';
    try { localStorage.setItem(APK_DISMISS_KEY, '1'); } catch (e) {}
  }

  function initBanner() {
    const banner = document.getElementById('apkBanner');
    if (!banner) return;
    // Masquée si déjà fermée par l'utilisateur OU si l'app est déjà installée
    let dismissed = false;
    try { dismissed = localStorage.getItem(APK_DISMISS_KEY) === '1'; } catch (e) {}
    if (dismissed || isAlreadyInstalled()) {
      banner.style.display = 'none';
      // On cache aussi le bouton du header
      const btn = document.getElementById('apkBtn');
      if (btn) btn.style.display = 'none';
      return;
    }
    // Délégation d'événements pour ne rien câbler dans index.html
    banner.addEventListener('click', (e) => {
      if (e.target.closest('[data-apk-dismiss]')) { hideBanner(); }
    });
  }

  // ---------- Bouton du header ----------
  function initHeaderButton() {
    const btn = document.getElementById('apkBtn');
    if (!btn) return;
    if (isAlreadyInstalled()) { btn.style.display = 'none'; return; }
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openModal();
    });
  }

  // ---------- API publique (au cas où index.html veut l'utiliser) ----------
  window.AndroidDownload = {
    open: openModal,
    close: closeModal,
    isInstalled: isAlreadyInstalled,
    apkUrl: APK_URL
  };

  // ---------- Init ----------
  function init() {
    initHeaderButton();
    initBanner();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();