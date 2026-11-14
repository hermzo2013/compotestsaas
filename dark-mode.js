/* ============================================================================
   dark-mode.js — Mode sombre persistant pour Révisio
   ----------------------------------------------------------------------------
   Ce module est chargé À LA DEMANDE (import dynamique) par index.html.
   Il expose UNIQUEMENT window.DarkMode avec :
     - init()    : applique le thème sauvegardé (appelé très tôt dans index.html)
     - toggle()  : bascule clair ↔ sombre
     - enable()  : force le mode sombre
     - disable() : force le mode clair
     - isDark()  : renvoie true si sombre
   Persistance : localStorage['revisio_theme'] = 'dark' | 'light'
   Application : classe .dark sur <html> (permet le CSS [data-theme] ou .dark)
   ============================================================================ */

(function () {
  'use strict';

  const STORAGE_KEY = 'revisio_theme';
  const DARK_CLASS = 'dark';
  const ROOT = document.documentElement;

  // Lit le thème sauvegardé, en tenant compte de la préférence système si aucun choix explicite
  function readSaved() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === 'dark' || v === 'light') return v;
    } catch (e) { /* localStorage indisponible */ }
    // Pas de choix explicite : on suit la préférence système
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }

  // Applique un thème (sans sauvegarder)
  function applyTheme(theme) {
    if (theme === 'dark') ROOT.classList.add(DARK_CLASS);
    else ROOT.classList.remove(DARK_CLASS);
    // Met à jour la meta theme-color (barre système sur mobile)
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0F172A' : '#064E3B');
    // Met à jour le libellé du bouton si présent
    const btn = document.getElementById('darkModeBtn');
    if (btn) {
      btn.textContent = theme === 'dark' ? '☀️' : '🌙';
      btn.setAttribute('aria-label', theme === 'dark' ? 'Désactiver le mode sombre' : 'Activer le mode sombre');
      btn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    }
  }

  // Sauvegarde un thème
  function saveTheme(theme) {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) {}
  }

  // API publique
  const DarkMode = {
    init() {
      applyTheme(readSaved());
    },
    enable() {
      saveTheme('dark');
      applyTheme('dark');
    },
    disable() {
      saveTheme('light');
      applyTheme('light');
    },
    toggle() {
      const isDark = ROOT.classList.contains(DARK_CLASS);
      if (isDark) this.disable(); else this.enable();
    },
    isDark() {
      return ROOT.classList.contains(DARK_CLASS);
    }
  };

  window.DarkMode = DarkMode;

  // Écoute les changements de préférence système UNIQUEMENT si l'utilisateur n'a pas choisi explicitement
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => {
      let hasExplicit = false;
      try { hasExplicit = localStorage.getItem(STORAGE_KEY) === 'dark' || localStorage.getItem(STORAGE_KEY) === 'light'; } catch (err) {}
      if (!hasExplicit) applyTheme(e.matches ? 'dark' : 'light');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  console.log('[DarkMode] module chargé');
})();