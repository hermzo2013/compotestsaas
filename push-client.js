/* Révisio — notifications push : navigateur/PWA (Web Push) et application Android (Firebase) + panneau d'envoi admin */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var cap = window.Capacitor;
  var PN = (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.PushNotifications) || null;
  var native = !!PN;
  var webSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  var supported = native || webSupported;
  var TOKEN_KEY = 'revisio_fcm_token';

  function apiBase() { return (typeof API_BASE !== 'undefined') ? API_BASE : ''; }

  async function api(path, method, body) {
    var s = await supabaseClient.auth.getSession();
    var token = s && s.data && s.data.session && s.data.session.access_token;
    if (!token) throw new Error('Session expirée. Reconnecte-toi.');
    var res = await fetch(apiBase() + path, {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('Erreur ' + res.status));
    return data;
  }

  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safePath(u) { return (typeof u === 'string' && /^\/(?!\/)\S{0,299}$/.test(u)) ? u : null; }

  function toast(title, body) {
    var t = document.createElement('div');
    t.setAttribute('role', 'status');
    t.style.cssText = 'position:fixed;left:12px;right:12px;top:calc(12px + env(safe-area-inset-top,0px));z-index:10001;background:#064E3B;color:#fff;border-radius:14px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.3);font:14px/1.4 system-ui,sans-serif';
    var a = document.createElement('div'); a.style.fontWeight = '800'; a.textContent = title || 'Révisio';
    var b = document.createElement('div'); b.textContent = body || '';
    t.append(a, b); document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 6000);
  }

  // ---------- Android (Firebase via Capacitor) ----------
  var pendingReg = null, nativeReady = false;

  function nativeInit() {
    if (nativeReady) return; nativeReady = true;
    PN.addListener('registration', function (t) {
      var token = t && t.value; if (!token) return;
      if (pendingReg) { var p = pendingReg; pendingReg = null; p.resolve(token); return; }
      store(TOKEN_KEY, token);                                   // renouvellement automatique du jeton
      api('/api/push/subscribe', 'POST', { fcm_token: token }).catch(function () {});
    });
    PN.addListener('registrationError', function (e) {
      if (pendingReg) { var p = pendingReg; pendingReg = null; p.reject(new Error('Enregistrement impossible : ' + ((e && e.error) || 'erreur inconnue'))); }
    });
    PN.addListener('pushNotificationReceived', function (n) { toast(n && n.title, n && n.body); });
    PN.addListener('pushNotificationActionPerformed', function (a) {
      var url = safePath(a && a.notification && a.notification.data && a.notification.data.url);
      if (url) location.href = url;
    });
  }

  async function nativePermission() {
    var p = await PN.checkPermissions();
    return p.receive === 'granted' ? 'granted' : (p.receive === 'denied' ? 'denied' : 'default');
  }

  async function nativeEnable(prefs) {
    nativeInit();
    var perm = await PN.checkPermissions();
    if (perm.receive !== 'granted') perm = await PN.requestPermissions();
    if (perm.receive !== 'granted') throw new Error("Autorisation refusée : active les notifications pour Révisio dans les réglages d'Android.");
    try { await PN.createChannel({ id: 'revisio', name: 'Révisio', description: 'Nouveaux quiz et messages', importance: 4, visibility: 1 }); } catch (e) {}
    var token = await new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { pendingReg = null; reject(new Error("Pas de réponse de Firebase. Vérifie la connexion internet et la configuration de l'application.")); }, 20000);
      pendingReg = { resolve: function (v) { clearTimeout(timer); resolve(v); }, reject: function (e) { clearTimeout(timer); reject(e); } };
      PN.register();
    });
    await api('/api/push/subscribe', 'POST', Object.assign({ fcm_token: token }, prefs || {}));
    store(TOKEN_KEY, token);
    return { id: { fcm_token: token } };
  }

  // ---------- Navigateur / PWA (Web Push) ----------
  function b64ToBytes(b64) {
    var pad = '='.repeat((4 - b64.length % 4) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function webSub() {
    var reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function webEnable(prefs) {
    var perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm !== 'granted') throw new Error('Autorisation refusée : active les notifications dans les réglages du navigateur.');
    var k = await api('/api/push/key');
    if (!k.enabled) throw new Error('Les notifications web ne sont pas configurées sur le serveur.');
    var reg = await navigator.serviceWorker.ready;
    var opts = { userVisibleOnly: true, applicationServerKey: b64ToBytes(k.publicKey) };
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      try { sub = await reg.pushManager.subscribe(opts); }
      catch (e) {
        var old = await reg.pushManager.getSubscription();
        if (old) await old.unsubscribe();
        sub = await reg.pushManager.subscribe(opts);
      }
    }
    await api('/api/push/subscribe', 'POST', Object.assign({ subscription: sub.toJSON() }, prefs || {}));
    return { id: { endpoint: sub.endpoint } };
  }

  // ---------- Interface commune ----------
  async function permission() {
    if (native) return nativePermission();
    return Notification.permission;
  }

  async function currentId() {
    if (native) { var t = load(TOKEN_KEY); return (t && (await nativePermission()) === 'granted') ? { fcm_token: t } : null; }
    var s = await webSub().catch(function () { return null; });
    return s ? { endpoint: s.endpoint } : null;
  }

  async function enable(prefs) { return native ? nativeEnable(prefs) : webEnable(prefs); }

  async function disable() {
    var id = await currentId();
    if (!id) return;
    try { await api('/api/push/unsubscribe', 'POST', id); } catch (e) {}
    if (native) { try { await PN.unregister(); } catch (e) {} store(TOKEN_KEY, null); }
    else { var s = await webSub().catch(function () { return null; }); if (s) await s.unsubscribe(); }
  }

  async function refreshButton() {
    var btn = $('pushBtn'); if (!btn) return;
    var on = false;
    if (supported && (await permission().catch(function () { return 'default'; })) === 'granted') on = !!(await currentId());
    btn.textContent = on ? '🔔 Notifications activées' : '🔔 Activer les notifications';
  }

  function closeDialog() { var d = $('pushDialog'); if (d) d.remove(); }

  async function openDialog() {
    if (!supported) {
      alert("Les notifications ne sont pas disponibles ici. Utilise Chrome sur Android, ou sur iPhone ajoute d'abord Révisio à l'écran d'accueil (Safari → Partager).");
      return;
    }
    if ((await permission()) === 'denied') {
      alert(native
        ? "Les notifications sont bloquées pour Révisio. Autorise-les dans Paramètres Android → Applications → Révisio → Notifications, puis réessaie."
        : "Les notifications sont bloquées pour ce site. Autorise-les dans les réglages du navigateur (cadenas de l'adresse → Notifications), puis réessaie.");
      return;
    }
    closeDialog();
    var id = await currentId();
    var st = { notify_quiz: true, notify_messages: true };
    if (id) {
      try { var r = await api('/api/push/status', 'POST', id); if (r.subscribed) st = r; } catch (e) {}
      if (st.notify_quiz === undefined) st.notify_quiz = true;
      if (st.notify_messages === undefined) st.notify_messages = true;
    }

    var ov = document.createElement('div'); ov.id = 'pushDialog';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;color:#1F2937;border-radius:16px;padding:20px;max-width:380px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.25);font-family:inherit';
    var h = document.createElement('h3'); h.style.margin = '0 0 12px'; h.textContent = '🔔 Notifications';
    box.appendChild(h);
    function row(label, checked) {
      var l = document.createElement('label'); l.style.cssText = 'display:flex;gap:10px;align-items:center;margin:10px 0;font-size:14px;cursor:pointer';
      var c = document.createElement('input'); c.type = 'checkbox'; c.checked = checked; c.style.cssText = 'width:auto;margin:0';
      l.append(c, document.createTextNode(label)); box.appendChild(l); return c;
    }
    var cq = row('Nouveaux quiz', st.notify_quiz);
    var cm = row("Messages de l'équipe", st.notify_messages);
    var msg = document.createElement('div'); msg.style.cssText = 'font-size:13px;font-weight:700;min-height:18px;margin:8px 0'; box.appendChild(msg);
    var bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:6px'; box.appendChild(bar);
    function btn(text, fn, ghost) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = text; if (ghost) b.className = 'ghost';
      b.onclick = async function () { b.disabled = true; try { await fn(); } catch (e) { msg.style.color = '#B91C1C'; msg.textContent = e.message; } b.disabled = false; };
      bar.appendChild(b);
    }
    btn(id ? 'Enregistrer' : 'Activer', async function () {
      var prefs = { notify_quiz: cq.checked, notify_messages: cm.checked };
      if (id) await api('/api/push/preferences', 'POST', Object.assign({}, id, prefs));
      else { var r = await enable(prefs); id = r.id; }
      msg.style.color = '#047857'; msg.textContent = 'Enregistré ✓'; refreshButton();
    });
    if (id) btn('Désactiver', async function () { await disable(); closeDialog(); refreshButton(); }, true);
    btn('Fermer', closeDialog, true);
    ov.appendChild(box); ov.addEventListener('click', function (e) { if (e.target === ov) closeDialog(); });
    document.body.appendChild(ov);
  }

  // ---------- panneau admin ----------
  function fmtDate(iso) { try { return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return ''; } }

  function updatePreview() {
    if (!$('pushTitle')) return;
    $('pushTitleCount').textContent = $('pushTitle').value.length + '/80';
    $('pushBodyCount').textContent = $('pushBody').value.length + '/300';
    $('pushPreviewTitle').textContent = $('pushTitle').value || 'Titre de la notification';
    $('pushPreviewBody').textContent = $('pushBody').value || 'Ton message apparaîtra ici.';
  }

  async function adminLoad() {
    var list = $('pushHistory'); if (!list) return;
    try {
      var d = await api('/api/admin/push/history');
      $('pushSubCount').textContent = d.subscribers + ' appareil(s) abonné(s)' + (d.android !== undefined ? ' (' + d.web + ' web · ' + d.android + ' Android)' : '');
      list.textContent = '';
      if (!d.history.length) { list.textContent = 'Aucun envoi pour le moment.'; return; }
      d.history.forEach(function (m) {
        var item = document.createElement('div'); item.style.cssText = 'border-bottom:1px solid #E5E7EB;padding:8px 0';
        var t = document.createElement('div'); t.style.fontWeight = '700'; t.textContent = (m.kind === 'quiz' ? '🆕 ' : '📣 ') + m.title;
        var b = document.createElement('div'); b.textContent = m.body;
        var meta = document.createElement('div'); meta.style.cssText = 'font-size:11px;color:#6B7280';
        meta.textContent = fmtDate(m.created_at) + ' · ' + m.delivered + '/' + m.recipients + ' reçu(s)' + (m.failed ? ' · ' + m.failed + ' échec(s)' : '');
        item.append(t, b, meta); list.appendChild(item);
      });
    } catch (e) { list.textContent = e.message; }
  }

  async function adminSend() {
    var title = $('pushTitle').value.trim(), body = $('pushBody').value.trim(), res = $('pushResult'), btn = $('pushSendBtn');
    res.style.color = '#B91C1C';
    if (!title || !body) { res.textContent = 'Titre et message obligatoires.'; return; }
    if (!confirm('Envoyer cette notification à tous les abonnés ?\n\n' + title + '\n' + body)) return;
    btn.disabled = true; res.style.color = '#6B7280'; res.textContent = 'Envoi en cours…';
    try {
      var r = await api('/api/admin/push/send', 'POST', { title: title, body: body, url: $('pushUrl').value });
      res.style.color = '#047857';
      res.textContent = r.recipients ? ('Envoyé : ' + r.delivered + ' reçu(s) sur ' + r.recipients + (r.failed ? ' (' + r.failed + ' échec(s))' : '') + '.') : "Aucun appareil abonné pour l'instant.";
      $('pushTitle').value = ''; $('pushBody').value = ''; updatePreview(); adminLoad();
    } catch (e) { res.style.color = '#B91C1C'; res.textContent = e.message; }
    btn.disabled = false;
  }

  function bind() {
    var b = $('pushBtn'); if (b) b.addEventListener('click', openDialog);
    if ($('pushTitle')) { $('pushTitle').addEventListener('input', updatePreview); $('pushBody').addEventListener('input', updatePreview); updatePreview(); }
    if ($('pushSendBtn')) $('pushSendBtn').addEventListener('click', adminSend);
  }

  window.PushUI = {
    adminLoad: adminLoad,
    afterLogin: function () {
      var b = $('pushBtn'); if (b) b.style.display = 'block';
      refreshButton();
      if (native) {
        nativeInit();
        nativePermission().then(function (p) { if (p === 'granted') PN.register(); }).catch(function () {});     // rattache l'appareil au compte connecté
      } else if (webSupported && Notification.permission === 'granted') {
        webSub().then(function (sub) {
          if (sub) api('/api/push/subscribe', 'POST', { subscription: sub.toJSON() }).catch(function () {});
        }).catch(function () {});
      }
    },
    afterLogout: function () { var b = $('pushBtn'); if (b) b.style.display = 'none'; closeDialog(); }
  };

  bind();
})();
