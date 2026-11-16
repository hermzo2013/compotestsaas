// community.js — Logique de l'espace Communauté
// Dépend de : supabaseClient, currentUser (définis dans index.html)
// Expose sur window : toggleCommunityPopup, loadCommunity, postMessage, etc.
//
// Dépendances implicites (définies dans le script principal d'index.html, utilisées à l'appel, jamais au chargement) :
//   - $()  esc()  API_BASE  isAdmin  supabaseClient  currentUser
//   - supaFail()  logSupabaseError()  classifySupabaseError()  (aussi utilisées par le bloc « rappels » : restent dans index.html)
//   - window.Skeleton (optionnel)
//   - window.CommunityVoice : fourni par community-voice.js, chargé À LA DEMANDE par import() depuis index.html
//     (ce n'est pas une balise <script>) ; tous les accès sont gardés par « window.CommunityVoice && ... ».
// Ordre de chargement : balise <script src="/community.js"></script> SANS defer, juste avant le script principal
//   (handleSession() appelle communityPoller / updateCommunityBadge dès l'authentification).
// Extrait de index.html le 2026-11-16 — déplacement pur, logique interne inchangée.

'use strict';

// ----- État de la communauté (déplacé depuis index.html, lignes 2156-2158) -----
let replyingTo = null;
let unreadRepliesCount = 0;
let selectedAttachment = null;

// ==========================================
// 💬 COMMUNAUTÉ
// ==========================================
function toggleCommunityPopup() {
  const popup = $('communityPopup');
  if (!popup) return;
  if (popup.classList.contains('show')) {
    popup.classList.remove('show');
    if (window.CommunityVoice && CommunityVoice.isRecording()) CommunityVoice.stop();
  }
  else { popup.classList.add('show'); loadCommunity(); markRepliesAsRead(); }
}
window.toggleCommunityPopup = toggleCommunityPopup;

function onAttachmentSelected(input) {
  if (!input.files || input.files.length === 0) return;
  if (window.CommunityVoice && (CommunityVoice.hasRecording() || CommunityVoice.isRecording())) {
    alert("Supprimez d'abord la note vocale (🗑️) pour joindre un fichier.");
    input.value = '';
    return;
  }
  const file = input.files[0];
  if (file.size > 5 * 1024 * 1024) { alert("Fichier trop volumineux (5 Mo maximum)."); input.value = ''; return; }
  selectedAttachment = file;
  $('attachmentName').textContent = file.name;
  $('attachmentPreview').style.display = 'flex';
}
window.onAttachmentSelected = onAttachmentSelected;

function removeAttachment() {
  selectedAttachment = null;
  $('communityFileInput').value = '';
  $('attachmentPreview').style.display = 'none';
  $('attachmentName').textContent = '';
}
window.removeAttachment = removeAttachment;

async function uploadAttachment(file) {
  if (!supabaseClient || !file) return null;
  const fileExt = file.name.split('.').pop();
  const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${fileExt}`;
  const filePath = `${currentUser.id}/${fileName}`;
  const { data, error } = await supabaseClient.storage.from('community_attachments').upload(filePath, file, { cacheControl: '3600', upsert: false });
  if (error) throw new Error("Erreur upload : " + error.message);
  const { data: urlData } = supabaseClient.storage.from('community_attachments').getPublicUrl(filePath);
  return urlData.publicUrl;
}
window.uploadAttachment = uploadAttachment;

// ==========================================
// 🎤 LECTEUR AUDIO CUSTOM (style WhatsApp)
// ==========================================

let activeAudioEl = null;
let activeAudioId = null;

function waveBarsFor(postId, count = 28) {
  let seed = 0;
  for (let i = 0; i < postId.length; i++) seed = (seed * 31 + postId.charCodeAt(i)) >>> 0;
  const bars = [];
  for (let i = 0; i < count; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const v = (seed >>> 16) % 100;
    bars.push(30 + Math.round((v / 99) * 70));
  }
  return bars;
}

function renderAudioPlayer(postId, url, duration) {
  const bars = waveBarsFor(postId);
  const durTxt = duration ? fmtVoiceTime(duration) : '--:--';
  const barsHtml = bars.map(pct => `<span class="bar" style="height:${pct}%"></span>`).join('');
  return `<div class="chat-audio-player" data-audio-id="${esc(postId)}">
    <button type="button" class="chat-audio-play" data-audio-play="${esc(postId)}" aria-label="Lecture">▶️</button>
    <div class="chat-audio-main">
      <div class="chat-audio-wave" data-audio-wave="${esc(postId)}">${barsHtml}</div>
      <div class="chat-audio-info">
        <span class="cur" data-audio-cur="${esc(postId)}">00:00</span>
        <span data-audio-dur="${esc(postId)}">${durTxt}</span>
      </div>
    </div>
  </div>
  <audio preload="metadata" src="${esc(url)}" data-audio-src="${esc(postId)}" style="display:none"></audio>`;
}

function bindAudioPlayers() {
  document.querySelectorAll('[data-audio-play]').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    const id = btn.dataset.audioPlay;
    const audio = document.querySelector(`audio[data-audio-src="${CSS.escape(id)}"]`);
    const wave = document.querySelector(`[data-audio-wave="${CSS.escape(id)}"]`);
    const curEl = document.querySelector(`[data-audio-cur="${CSS.escape(id)}"]`);
    const durEl = document.querySelector(`[data-audio-dur="${CSS.escape(id)}"]`);
    if (!audio || !wave) return;

    const applyDuration = () => {
      if (isFinite(audio.duration) && audio.duration > 0 && durEl) {
        durEl.textContent = fmtVoiceTime(audio.duration);
      }
    };
    audio.addEventListener('loadedmetadata', applyDuration);
    if (audio.readyState >= 1) applyDuration();

    const paintProgress = () => {
      const d = audio.duration;
      const pct = (isFinite(d) && d > 0) ? (audio.currentTime / d) : 0;
      const bars = wave.querySelectorAll('.bar');
      const playedCount = Math.round(pct * bars.length);
      bars.forEach((b, i) => b.classList.toggle('played', i < playedCount));
      if (curEl) curEl.textContent = fmtVoiceTime(audio.currentTime);
    };
    audio.addEventListener('timeupdate', paintProgress);
    audio.addEventListener('seeked', paintProgress);

    audio.addEventListener('ended', () => {
      btn.textContent = '▶️';
      btn.setAttribute('aria-label', 'Lecture');
      audio.currentTime = 0;
      paintProgress();
      if (activeAudioEl === audio) { activeAudioEl = null; activeAudioId = null; }
    });

    btn.addEventListener('click', () => {
      if (activeAudioEl && activeAudioEl !== audio) {
        activeAudioEl.pause();
        activeAudioEl.currentTime = 0;
        const prevBtn = document.querySelector(`[data-audio-play="${CSS.escape(activeAudioId || '')}"]`);
        if (prevBtn) { prevBtn.textContent = '▶️'; prevBtn.setAttribute('aria-label', 'Lecture'); }
      }
      if (audio.paused) {
        audio.play().then(() => {
          btn.textContent = '⏸️';
          btn.setAttribute('aria-label', 'Pause');
          activeAudioEl = audio;
          activeAudioId = id;
        }).catch(err => {
          console.warn('Lecture audio refusée :', err);
          btn.textContent = '▶️';
        });
      } else {
        audio.pause();
        btn.textContent = '▶️';
        btn.setAttribute('aria-label', 'Lecture');
        activeAudioEl = null;
        activeAudioId = null;
      }
    });

    wave.addEventListener('click', (e) => {
      const rect = wave.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      if (isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = pct * audio.duration;
        paintProgress();
      }
    });
  });
}

function fmtVoiceTime(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
}

// ==========================================
// 🔔 NOTIFICATION AUTOMATIQUE
// ==========================================
async function notifyCommunityPost({ authorName, content, attachmentType }) {
  try {
    const { data } = await supabaseClient.auth.getSession();
    const token = data && data.session && data.session.access_token;
    if (!token) return;
    let body;
    if (attachmentType === 'audio') body = '🎤 Note vocale';
    else if (attachmentType) body = '📎 Pièce jointe';
    else body = content.length > 80 ? content.slice(0, 80) + '…' : content;
    const res = await fetch(API_BASE + '/api/push/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ title: '💬 Nouveau message de ' + authorName, body, url: '/?tab=community' })
    });
    if (!res.ok) console.warn('Notification communauté non envoyée (HTTP ' + res.status + ')');
  } catch (e) { console.warn('Notification communauté non envoyée :', e); }
}

async function loadCommunity() {
  if (!supabaseClient) return;
  const list = $('communityList');
  list.innerHTML = window.Skeleton ? Skeleton.list(4) : '<p style="color:var(--muted);text-align:center;padding:20px;">Chargement...</p>';
  try {
    const { data, error } = await supabaseClient.from('community_posts').select('*').order('created_at', { ascending: false });
    if (error) { list.innerHTML = `<p style="color:var(--red);text-align:center;padding:20px;">Erreur : ${esc(error.message)}</p>`; return; }
    if (!data || data.length === 0) { list.innerHTML = '<p style="color:var(--muted);text-align:center;padding:20px;">Aucun message pour le moment. Soyez le premier à publier !</p>'; return; }
    list.innerHTML = data.map(post => {
      const isAuthor = currentUser && post.user_id === currentUser.id;
      const canDelete = isAdmin || isAuthor;
      const date = new Date(post.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
      let replyContext = '';
      if (post.reply_to_id) {
        const parentPost = data.find(p => p.id === post.reply_to_id);
        if (parentPost) replyContext = `<div class="chat-reply-info">↩️ En réponse à <b>@${esc(parentPost.author_name || 'Anonyme')}</b></div>`;
      }
      let attachmentHtml = '';
      if (post.attachment_url) {
        if (post.attachment_type === 'audio') {
          let dur = 0;
          const mHash = String(post.attachment_url).match(/#d=(\d+)/);
          const mName = String(post.attachment_url).match(/_d(\d+)\./);
          if (mHash) dur = parseInt(mHash[1], 10);
          else if (mName) dur = parseInt(mName[1], 10);
          attachmentHtml = renderAudioPlayer(post.id, post.attachment_url, dur);
        }
        else if (post.attachment_type === 'image') attachmentHtml = `<div class="chat-attachment"><img src="${esc(post.attachment_url)}" alt="Image partagée par ${esc(post.author_name || 'un utilisateur')} dans la communauté" loading="lazy" decoding="async" onclick="window.open('${esc(post.attachment_url)}', '_blank')"></div>`;
        else attachmentHtml = `<div class="chat-attachment"><a href="${esc(post.attachment_url)}" target="_blank" rel="noopener"><i class='bx bx-file' aria-hidden="true"></i> Télécharger le fichier</a></div>`;
      }
      const hideText = post.attachment_type === 'audio' && post.content === '🎤 Note vocale';
      const contentHtml = hideText ? '' : `<div class="chat-msg-content">${esc(post.content)}</div>`;
      const replyBtn = !isAuthor ? `<button onclick="startReply('${post.id}', '${post.user_id}', '${esc(post.author_name || 'Anonyme')}')">↩️ Répondre</button>` : '';
      const deleteBtn = canDelete ? `<button class="del" onclick="deleteCommunityPost('${post.id}')">🗑️</button>` : '';
      return `<div class="chat-msg ${isAuthor ? 'is-mine' : ''}">
        <div class="chat-msg-header"><span class="chat-msg-author">👤 ${esc(post.author_name || 'Anonyme')}</span><span class="chat-msg-date">${date}</span></div>
        ${replyContext}${contentHtml}${attachmentHtml}
        <div class="chat-msg-actions">${replyBtn}${deleteBtn}</div></div>`;
    }).join('');
    bindAudioPlayers();
  } catch (e) { list.innerHTML = `<p style="color:var(--red);text-align:center;padding:20px;">Erreur réseau : ${esc(e.message)}</p>`; }
}
window.loadCommunity = loadCommunity;

function startReply(postId, userId, authorName) {
  replyingTo = { postId, userId, authorName };
  const input = $('communityInput');
  input.value = `@${authorName} `;
  input.focus();
  $('communityCharCount').textContent = input.value.length;
  $('replyingTo').style.display = 'flex';
  $('replyingToText').innerHTML = `↩️ Répondre à <b>@${esc(authorName)}</b>`;
}
window.startReply = startReply;

function cancelReply() {
  replyingTo = null;
  $('communityInput').value = '';
  $('communityCharCount').textContent = '0';
  $('replyingTo').style.display = 'none';
}
window.cancelReply = cancelReply;

async function postMessage() {
  if (!supabaseClient || !currentUser) return;
  const input = $('communityInput');
  const content = input.value.trim();

  const Voice = window.CommunityVoice || null;
  if (Voice && Voice.isRecording()) {
    return alert("Arrêtez l'enregistrement (⏹️) avant de publier.");
  }
  const isVoice = !!(Voice && Voice.hasRecording());

  if (!content && !selectedAttachment && !isVoice) {
    return alert("Écrivez un message, joignez un fichier ou enregistrez une note vocale.");
  }
  if (content.length > 1000) return alert("Message trop long (1000 caractères max).");

  const btn = $('communityPostBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳...';

  try {
    let attachmentUrl = null, attachmentType = null;

    if (isVoice) {
      btn.textContent = '🎤 Envoi...';
      const blob = Voice.getBlob();
      const dur = Voice.getDuration();
      const ext = Voice.extFor(blob.type);
      const filePath = `${currentUser.id}/voice_${Date.now()}_d${dur}.${ext}`;
      const { error: upErr } = await supabaseClient.storage
        .from('community_attachments')
        .upload(filePath, blob, { contentType: blob.type || 'audio/webm', cacheControl: '3600', upsert: false });
      if (upErr) throw new Error('Erreur upload vocal : ' + upErr.message);
      const { data: urlData } = supabaseClient.storage.from('community_attachments').getPublicUrl(filePath);
      attachmentUrl = urlData.publicUrl + '#d=' + dur;
      attachmentType = 'audio';
    } else if (selectedAttachment) {
      btn.textContent = '📎 Envoi...';
      attachmentUrl = await uploadAttachment(selectedAttachment);
      attachmentType = selectedAttachment.type.startsWith('image/') ? 'image' : 'file';
    }

    const authorName = currentUser.user_metadata?.full_name || (currentUser.email || '').split('@')[0];
    const postData = {
      user_id: currentUser.id,
      author_name: authorName,
      content: content || (isVoice ? '🎤 Note vocale' : '(pièce jointe)'),
      attachment_url: attachmentUrl,
      attachment_type: attachmentType
    };
    if (replyingTo) {
      postData.reply_to_id = replyingTo.postId;
      postData.recipient_id = replyingTo.userId;
    }

    const { error } = await supabaseClient.from('community_posts').insert(postData);
    if (error) {
      alert('Erreur : ' + error.message);
    } else {
      notifyCommunityPost({ authorName, content, attachmentType });
      input.value = '';
      $('communityCharCount').textContent = '0';
      removeAttachment();
      if (Voice) Voice.cancel();
      cancelReply();
      await loadCommunity();
    }
  } catch (e) {
    alert('Erreur : ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
window.postMessage = postMessage;

async function deleteCommunityPost(postId) {
  if (!supabaseClient || !currentUser) return;
  if (!confirm("Supprimer ce message ?")) return;
  try {
    const { error } = await supabaseClient.from('community_posts').delete().eq('id', postId);
    if (error) alert("Erreur : " + error.message);
    else await loadCommunity();
  } catch (e) { alert("Erreur réseau : " + e.message); }
}
window.deleteCommunityPost = deleteCommunityPost;

const communitySeenKey = () => 'revisio_community_seen_' + (currentUser ? currentUser.id : '');

// ===== Suivi des messages non lus / sondage (extrait du bloc « COMMUNITY POLLING » d'index.html) =====

async function markCommunitySeen() {
  if (!supabaseClient || !currentUser) return { ok: false, kind: 'skipped' };
  const r = await supabaseClient.from('community_posts').select('created_at').order('created_at', { ascending: false }).limit(1);
  if (r.error) return supaFail('markCommunitySeen', r.error, r.status); // en cas d'erreur on n'écrase pas la date « vue »
  localStorage.setItem(communitySeenKey(), (r.data && r.data[0] && r.data[0].created_at) || '1970-01-01T00:00:00Z');
  return { ok: true };
}

async function countNewCommunityPosts() {
  const popup = $('communityPopup');
  if (!localStorage.getItem(communitySeenKey()) || (popup && popup.classList.contains('show'))) {
    const m = await markCommunitySeen();
    return m.ok ? { ok: true, count: 0 } : Object.assign({ count: 0 }, m);
  }
  const since = localStorage.getItem(communitySeenKey());
  const r = await supabaseClient.from('community_posts').select('id,recipient_id').neq('user_id', currentUser.id).gt('created_at', since).limit(100);
  if (r.error) return Object.assign({ count: 0 }, supaFail('countNewCommunityPosts', r.error, r.status));
  return { ok: true, count: (r.data || []).filter(p => p.recipient_id !== currentUser.id).length };
}

// Single-flight : un seul cycle de requêtes à la fois, les appelants simultanés partagent la même promesse.
var unreadInFlight = null;
function checkUnreadReplies() {
  if (!supabaseClient || !currentUser) return Promise.resolve({ ok: false, kind: 'skipped' });
  if (unreadInFlight) return unreadInFlight;
  const uid = currentUser.id;
  unreadInFlight = (async () => {
    try {
      let readIds = [];
      try { readIds = JSON.parse(localStorage.getItem('comptest_read_community') || '[]'); } catch (e) {}
      const r = await supabaseClient.from('community_posts').select('id').eq('recipient_id', uid);
      if (r.error) return supaFail('checkUnreadReplies', r.error, r.status);
      if (!currentUser || currentUser.id !== uid) return { ok: false, kind: 'skipped' };
      const unread = (r.data || []).filter(post => !readIds.includes(post.id));
      const n = await countNewCommunityPosts();
      if (!n.ok) return n;
      if (!currentUser || currentUser.id !== uid) return { ok: false, kind: 'skipped' };
      unreadRepliesCount = unread.length;
      updateCommunityBadge(unreadRepliesCount + n.count);
      return { ok: true };
    } catch (e) {
      return supaFail('checkUnreadReplies', e);
    } finally { unreadInFlight = null; }
  })();
  return unreadInFlight;
}
window.checkUnreadReplies = checkUnreadReplies;

// Sondage contrôlé : setTimeout récursif (jamais de setInterval), backoff exponentiel après échec,
// pause onglet masqué / hors ligne, reprise automatique, nettoyage complet à l'arrêt.
var communityPollConfig = { base: 30000, max: 300000, minGap: 5000 };
var communityPoller = (function () {
  var timer = null, running = false, inFlight = false, failures = 0, lastKind = null, lastRun = 0, listening = false, uid = null;
  function canRun() { return running && !!currentUser && !document.hidden && navigator.onLine !== false; }
  function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
  function delay() {
    if (!failures) return communityPollConfig.base;
    var d = Math.min(communityPollConfig.max, communityPollConfig.base * Math.pow(2, failures));
    return d + Math.floor(Math.random() * d * 0.1);
  }
  function schedule() { clearTimer(); if (canRun()) timer = setTimeout(tick, delay()); }
  async function tick() {
    timer = null;
    if (!canRun() || inFlight) return;
    inFlight = true; lastRun = Date.now();
    try {
      var r = await checkUnreadReplies();
      if (!running) return;
      if (r.ok) { if (failures) console.info('[Communauté] vérifications rétablies'); failures = 0; lastKind = null; }
      else if (r.kind !== 'skipped') {
        failures++;
        if (failures === 1 || r.kind !== lastKind) logSupabaseError(r.scope || 'community-poll', r.kind, r.error, r.status);
        lastKind = r.kind;
      }
    } finally { inFlight = false; schedule(); }
  }
  function wake(reset) {
    if (!running) return;
    clearTimer();
    if (reset) failures = 0;
    if (!reset && Date.now() - lastRun < communityPollConfig.minGap) { schedule(); return; }
    tick();
  }
  function onVisibility() { if (document.hidden) clearTimer(); else wake(false); }
  function onOnline() { wake(true); }
  function onOffline() { clearTimer(); }
  function listen(on) {
    if (on === listening) return;
    listening = on;
    var f = on ? 'addEventListener' : 'removeEventListener';
    document[f]('visibilitychange', onVisibility);
    window[f]('online', onOnline);
    window[f]('offline', onOffline);
  }
  return {
    start: function (userId) {
      if (running && uid === userId) return;
      if (running) this.stop();
      running = true; uid = userId; failures = 0; lastKind = null; lastRun = 0;
      listen(true); wake(true);
    },
    stop: function () { running = false; uid = null; clearTimer(); listen(false); },
    state: function () { return { running: running, failures: failures, hasTimer: !!timer, inFlight: inFlight, listening: listening }; }
  };
})();

function updateCommunityBadge(count) {
  const badge = $('communityWidgetBadge');
  if (!badge) return;
  if (count > 0) { badge.textContent = count > 99 ? '99+' : count; badge.style.display = 'flex'; }
  else badge.style.display = 'none';
}

async function markRepliesAsRead() {
  if (!supabaseClient || !currentUser) return;
  try {
    const { data } = await supabaseClient.from('community_posts').select('id').eq('recipient_id', currentUser.id);
    if (data && data.length > 0) {
      const readIds = JSON.parse(localStorage.getItem('comptest_read_community') || '[]');
      const newReadIds = [...new Set([...readIds, ...data.map(p => p.id)])];
      localStorage.setItem('comptest_read_community', JSON.stringify(newReadIds));
    }
    unreadRepliesCount = 0;
    await markCommunitySeen();
    updateCommunityBadge(0);
  } catch (e) { console.error('Erreur markRepliesAsRead:', e); }
}
window.markRepliesAsRead = markRepliesAsRead;
// ==========================================
// Exposition explicite sur window (utilisées par onclick="..." et par les autres scripts)
// ==========================================
window.toggleCommunityPopup = toggleCommunityPopup;
window.postMessage = postMessage;
window.startReply = startReply;
window.cancelReply = cancelReply;
window.deleteCommunityPost = deleteCommunityPost;
window.onAttachmentSelected = onAttachmentSelected;
window.removeAttachment = removeAttachment;
window.uploadAttachment = uploadAttachment;
window.checkUnreadReplies = checkUnreadReplies;
window.markRepliesAsRead = markRepliesAsRead;
window.loadCommunity = loadCommunity;
window.updateCommunityBadge = updateCommunityBadge;
