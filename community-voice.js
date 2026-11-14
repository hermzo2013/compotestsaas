/* ============================================================================
   community-voice.js — Enregistrement de notes vocales pour la Communauté
   ----------------------------------------------------------------------------
   Ce module est chargé À LA DEMANDE (import dynamique) par index.html.
   Il expose window.CommunityVoice avec :
     - start()          : demande le micro et démarre l'enregistrement
     - stop()           : arrête l'enregistrement et prépare l'aperçu
     - cancel()         : annule tout (micro coupé, blob supprimé)
     - getBlob()        : renvoie le Blob audio prêt (ou null)
     - getDuration()    : renvoie la durée en secondes
     - hasRecording()   : true si un blob est prêt à être publié
     - isRecording()    : true si l'enregistrement est en cours
   ----------------------------------------------------------------------------
   Il pilote lui-même l'UI des zones #voiceRecorder / #voicePreview / #voiceMicBtn
   (qui existent dans index.html) et ne touche à rien d'autre.
   ============================================================================ */

(function () {
  'use strict';

  // ---------- Configuration ----------
  const VOICE_MAX_SECONDS = 180;               // 3 min maximum
  const VOICE_MAX_BYTES = 5 * 1024 * 1024;    // 5 Mo maximum (comme les pièces jointes)

  // ---------- État interne ----------
  let session = null;        // { rec, stream, chunks, cancelled, startedAt, stopSeconds, timerId }
  let starting = false;      // évite le double-clic pendant la demande d'autorisation
  let blob = null;           // note prête à publier
  let duration = 0;          // durée (secondes)
  let previewAudio = null;   // HTMLAudioElement pour l'aperçu
  let previewUrl = null;     // URL.createObjectURL pour l'aperçu

  // ---------- Utilitaires ----------
  const $ = (id) => document.getElementById(id);

  // 00:05 (secondes → mm:ss)
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }

  // Choisit le meilleur format audio supporté (webm/opus en priorité, mp4 pour Safari)
  function pickMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
      .find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  function extFor(mime) {
    return /mp4/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm';
  }

  // Met à jour l'UI : 'idle' | 'recording' | 'preview'
  function setUi(state) {
    const btn = $('voiceMicBtn');
    if (btn) {
      btn.classList.toggle('recording', state === 'recording');
      btn.textContent = state === 'recording' ? '🔴' : '🎤';
      btn.title = state === 'recording' ? "Arrêter l'enregistrement" : 'Enregistrer une note vocale';
    }
    if ($('voiceRecorder')) $('voiceRecorder').style.display = state === 'recording' ? 'flex' : 'none';
    if ($('voicePreview')) $('voicePreview').style.display = state === 'preview' ? 'flex' : 'none';
    if ($('voicePlayBtn')) $('voicePlayBtn').textContent = '▶️';
  }

  // Coupe le micro (les pistes doivent être arrêtées explicitement)
  function releaseStream(s) {
    if (s && s.stream) {
      s.stream.getTracks().forEach((t) => t.stop());
      s.stream = null;
    }
  }

  // Libère les ressources de l'aperçu
  function releasePreview() {
    if (previewAudio) { previewAudio.pause(); previewAudio = null; }
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  }

  // ---------- Démarrage ----------
  async function start() {
    if (isRecording() || starting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      return alert("L'enregistrement vocal n'est pas disponible sur ce navigateur (la page doit être en HTTPS).");
    }
    // On repart d'une note vierge
    cancel();
    starting = true;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      starting = false;
      return alert(
        e.name === 'NotAllowedError'
          ? "Autorisation du micro refusée. Autorise-la dans les réglages du navigateur."
          : e.name === 'NotFoundError'
          ? 'Aucun micro détecté.'
          : 'Micro indisponible : ' + e.message
      );
    }

    try {
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
      const s = { rec, stream, chunks: [], cancelled: false, startedAt: Date.now(), stopSeconds: 0, timerId: null };
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) s.chunks.push(e.data); };
      rec.onstop = () => onStopped(s, rec.mimeType || mime || 'audio/webm');
      rec.start(1000);                        // un chunk par seconde
      session = s;

      $('voiceTimer').textContent = '00:00';
      $('voiceBarFill').style.width = '0%';
      setUi('recording');

      // Timer + barre de progression + arrêt automatique à 3 min
      s.timerId = setInterval(() => {
        const sec = (Date.now() - s.startedAt) / 1000;
        $('voiceTimer').textContent = fmtTime(sec);
        $('voiceBarFill').style.width = Math.min(100, (sec / VOICE_MAX_SECONDS) * 100) + '%';
        if (sec >= VOICE_MAX_SECONDS) stop();
      }, 250);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      alert("Impossible de démarrer l'enregistrement : " + e.message);
    } finally {
      starting = false;
    }
  }

  // ---------- Arrêt ----------
  function stop() {
    const s = session;
    if (!s || s.rec.state !== 'recording') return;
    s.stopSeconds = Math.round((Date.now() - s.startedAt) / 1000);
    clearInterval(s.timerId);
    s.rec.stop();                              // déclenche onStopped()
  }

  // Appelé quand MediaRecorder a fini : assemble le fichier et affiche l'aperçu
  function onStopped(s, mime) {
    releaseStream(s);
    if (s.cancelled) return;
    if (session === s) session = null;

    const b = new Blob(s.chunks, { type: String(mime).split(';')[0] || 'audio/webm' });
    if (s.stopSeconds < 1 || b.size === 0) {
      setUi('idle');
      return alert('Enregistrement trop court.');
    }
    if (b.size > VOICE_MAX_BYTES) {
      setUi('idle');
      return alert('Note vocale trop volumineuse (5 Mo maximum).');
    }

    blob = b;
    duration = Math.min(s.stopSeconds, VOICE_MAX_SECONDS);
    releasePreview();
    previewUrl = URL.createObjectURL(b);
    previewAudio = new Audio(previewUrl);
    previewAudio.onended = () => { if ($('voicePlayBtn')) $('voicePlayBtn').textContent = '▶️'; };

    $('voicePreviewDuration').textContent = fmtTime(duration);
    setUi('preview');                          // ▶️ 00:05 [🗑️ Supprimer]
  }

  // ---------- Annulation ----------
  function cancel() {
    if (session) {
      session.cancelled = true;
      clearInterval(session.timerId);
      try { if (session.rec.state !== 'inactive') session.rec.stop(); } catch (e) {}
      releaseStream(session);
      session = null;
    }
    blob = null;
    duration = 0;
    releasePreview();
    setUi('idle');
  }

  // ---------- Aperçu : play / pause ----------
  function togglePreview() {
    if (!previewAudio) return;
    if (previewAudio.paused) {
      previewAudio.play().catch(() => {});
      $('voicePlayBtn').textContent = '⏸️';
    } else {
      previewAudio.pause();
      $('voicePlayBtn').textContent = '▶️';
    }
  }

  // ---------- Accesseurs publics ----------
  function isRecording() { return !!(session && session.rec && session.rec.state === 'recording'); }
  function hasRecording() { return !!blob; }
  function getBlob() { return blob; }
  function getDuration() { return duration; }

  // ---------- Export ----------
  window.CommunityVoice = {
    start,
    stop,
    cancel,
    togglePreview,
    isRecording,
    hasRecording,
    getBlob,
    getDuration,
    fmtTime,
    extFor,
    VOICE_MAX_SECONDS,
    VOICE_MAX_BYTES
  };

  // Raccourcis globaux utilisés par les onclick= des boutons dans index.html
  window.toggleVoiceRecording = () => { if (isRecording()) stop(); else start(); };
  window.stopVoiceRecording = stop;
  window.discardVoiceNote = cancel;
  window.toggleVoicePreviewPlayback = togglePreview;

  console.log('[CommunityVoice] module chargé');
})();