/* Révisio — notifications push : navigateur/PWA, Android, réglages, invitation,
   boîte « Mes notifications », suivi des ouvertures, panneau admin. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var cap = window.Capacitor;
  var PN = (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.PushNotifications) || null;
  var native = !!PN;
  var webSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  var supported = native || webSupported;

  var K = {
    token: 'revisio_fcm_token', prefs: 'revisio_push_prefs', sync: 'revisio_push_last_sync',
    promptAt: 'revisio_push_prompt_dismissed_at', visits: 'revisio_visits', quizzes: 'revisio_quizzes_done', seen: 'revisio_inbox_seen',
    settings: 'revisio_settings_cache'
  };
  var DAY = 86400000, SYNC_EVERY = 12 * 3600000, PROMPT_PAUSE = 7 * DAY;

  function apiBase() { return (typeof API_BASE !== 'undefined') ? API_BASE : ''; }
  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safePath(u) { return (typeof u === 'string' && /^\/(?!\/)\S{0,299}$/.test(u)) ? u : null; }

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

  // ---------- Réglage global des notifications (lecture publique) ----------
  // Cache 60 s côté navigateur. Si l'appel échoue, on considère que les notifications sont désactivées
  // (dégradation sûre : on ne montre pas le bouton si on ne sait pas).
  function cachedSettings() {
    try { var o = JSON.parse(load(K.settings) || 'null'); return o && (Date.now() - o.at < 60000) ? o : null; } catch (e) { return null; }
  }
  async function fetchSettings() {
    var c = cachedSettings(); if (c) return c;
    try {
      var res = await fetch(apiBase() + '/api/settings');
      var data = await res.json();
      var o = { at: Date.now(), notifications_enabled: !!data.notifications_enabled };
      store(K.settings, JSON.stringify(o));
      return o;
    } catch (e) {
      return { at: Date.now(), notifications_enabled: false };
    }
  }

  // ---------- Thème ----------
  function isDark() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  function pal() {
    return isDark()
      ? { bg: '#1F2937', fg: '#F3F4F6', mut: '#9CA3AF', line: '#374151', card: '#111827', ok: '#34D399', err: '#F87171', accent: '#10B981', ghost: '#374151', shadow: 'rgba(0,0,0,.6)' }
      : { bg: '#FFFFFF', fg: '#1F2937', mut: '#6B7280', line: '#E5E7EB', card: '#F9FAFB', ok: '#047857', err: '#B91C1C', accent: '#10B981', ghost: '#F3F4F6', shadow: 'rgba(0,0,0,.25)' };
  }
  function btnStyle(c, ghost) {
    return 'cursor:pointer;border-radius:10px;padding:9px 14px;font:700 14px system-ui,sans-serif;border:1px solid ' + (ghost ? c.line : c.accent) +
      ';background:' + (ghost ? c.ghost : c.accent) + ';color:' + (ghost ? c.fg : '#fff');
  }
  function fieldStyle(c) { return 'width:100%;box-sizing:border-box;margin:4px 0 8px;padding:8px 10px;border-radius:8px;border:1px solid ' + c.line + ';background:' + c.card + ';color:' + c.fg + ';font:14px system-ui,sans-serif'; }

  function toast(title, body) {
    var c = pal(), t = document.createElement('div');
    t.setAttribute('role', 'status');
    t.style.cssText = 'position:fixed;left:12px;right:12px;top:calc(12px + env(safe-area-inset-top,0px));z-index:10001;background:#064E3B;color:#fff;border-radius:14px;padding:12px 14px;box-shadow:0 8px 30px ' + c.shadow + ';font:14px/1.4 system-ui,sans-serif';
    var a = document.createElement('div'); a.style.fontWeight = '800'; a.textContent = title || 'Révisio';
    var b = document.createElement('div'); b.textContent = body || '';
    t.append(a, b); document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 6000);
  }

  // ---------- Compteurs ----------
  try {
    if (!sessionStorage.getItem('revisio_visit_counted')) {
      sessionStorage.setItem('revisio_visit_counted', '1');
      store(K.visits, String(Number(load(K.visits) || 0) + 1));
    }
  } catch (e) {}

  // ---------- Android ----------
  var pendingReg = null, nativeReady = false;

  function nativeInit() {
    if (nativeReady) return; nativeReady = true;
    PN.addListener('registration', function (t) {
      var token = t && t.value; if (!token) return;
      if (pendingReg) { var p = pendingReg; pendingReg = null; p.resolve(token); return; }
      store(K.token, token);
      api('/api/push/subscribe', 'POST', { fcm_token: token }).then(function () { store(K.sync, String(Date.now())); }).catch(function () {});
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
    store(K.token, token); store(K.sync, String(Date.now()));
    return { id: { fcm_token: token } };
  }

  // ---------- Navigateur ----------
  function b64ToBytes(b64) {
    var pad = '='.repeat((4 - b64.length % 4) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  async function webSub() { var reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); }

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
    store(K.sync, String(Date.now()));
    return { id: { endpoint: sub.endpoint } };
  }

  // ---------- Commun ----------
  async function permission() { return native ? nativePermission() : Notification.permission; }

  async function currentId() {
    if (native) { var t = load(K.token); return (t && (await nativePermission()) === 'granted') ? { fcm_token: t } : null; }
    var s = await webSub().catch(function () { return null; });
    return s ? { endpoint: s.endpoint } : null;
  }
  var idValue = function (id) { return id ? (id.fcm_token || id.endpoint) : ''; };

  async function enable(prefs) { return native ? nativeEnable(prefs) : webEnable(prefs); }

  async function disable() {
    var id = await currentId();
    if (!id) return;
    try { await api('/api/push/unsubscribe', 'POST', id); } catch (e) {}
    if (native) { try { await PN.unregister(); } catch (e) {} store(K.token, null); }
    else { var s = await webSub().catch(function () { return null; }); if (s) await s.unsubscribe(); }
    store(K.prefs, null);
  }

  function cachedPrefs(id) {
    try { var p = JSON.parse(load(K.prefs) || 'null'); return p && p.id === idValue(id) ? p : null; } catch (e) { return null; }
  }
  function cachePrefs(id, p) {
    store(K.prefs, JSON.stringify({ id: idValue(id), notify_quiz: p.notify_quiz !== false, notify_messages: p.notify_messages !== false,
      preferred_subjects: p.preferred_subjects || [], preferred_level: p.preferred_level || null, language: p.language || 'fr' }));
  }

  async function userLanguage() {
    var c = null; try { c = JSON.parse(load(K.prefs) || 'null'); } catch (e) {}
    if (c && c.language) return c.language;
    try {
      var s = await supabaseClient.auth.getSession();
      var l = s && s.data && s.data.session && s.data.session.user && s.data.session.user.user_metadata && s.data.session.user.user_metadata.language;
      if (l === 'fr' || l === 'en') return l;
    } catch (e) {}
    var n = (navigator.language || 'fr').slice(0, 2).toLowerCase();
    return n === 'en' ? 'en' : 'fr';
  }

  async function clearDelivered() {
    try {
      if (native) { await PN.removeAllDeliveredNotifications(); return; }
      if (!webSupported) return;
      var reg = await navigator.serviceWorker.ready;
      var list = await reg.getNotifications();
      list.forEach(function (n) { n.close(); });
    } catch (e) {}
  }

  async function trackOpen() {
    try {
      var q = new URLSearchParams(location.search);
      if (q.get('from') !== 'push') return;
      var mid = q.get('mid');
      if (!sessionStorage.getItem('revisio_click_' + mid) && /^[0-9a-f-]{36}$/i.test(mid || '')) {
        sessionStorage.setItem('revisio_click_' + mid, '1');
        await api('/api/push/click', 'POST', { mid: mid });
      }
      q.delete('from'); q.delete('mid');
      var qs = q.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (e) {}
  }

  // Met à jour l'état du bouton "Activer les notifications" en tenant compte du réglage global
  // et du rôle : un utilisateur normal ne voit jamais ce bouton (il reçoit l'invitation, gérée à part).
  async function refreshButton() {
    var btn = $('pushBtn'); if (!btn) return;
    var s = await fetchSettings();
    var show = s.notifications_enabled && window.__isAdmin === true;
    btn.style.display = show ? 'block' : 'none';
    if (!show) return;
    var on = false;
    if (supported && (await permission().catch(function () { return 'default'; })) === 'granted') on = !!(await currentId());
    btn.textContent = on ? '🔔 Notifications activées' : '🔔 Activer les notifications';
  }

  // ---------- Fenêtre de réglages ----------
  function closeDialog() { var d = $('pushDialog'); if (d) d.remove(); }
  var optionsCache = null;
  async function loadOptions() {
    if (optionsCache) return optionsCache;
    try { optionsCache = await api('/api/push/options'); } catch (e) { optionsCache = { subjects: [], levels: ['LICENCE 1', 'LICENCE 2', 'LICENCE 3'] }; }
    return optionsCache;
  }

  async function openDialog() {
    var s = await fetchSettings();
    if (!s.notifications_enabled) { alert("Les notifications ne sont pas activées par l'administrateur."); return; }
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
    var c = pal();
    var id = await currentId();
    var st = { notify_quiz: true, notify_messages: true, preferred_subjects: [], preferred_level: null, language: await userLanguage() };
    if (id) {
      var cached = cachedPrefs(id);
      if (cached) st = cached;
      else {
        try { var r = await api('/api/push/status', 'POST', id); if (r.subscribed) { st = Object.assign(st, r); cachePrefs(id, st); } } catch (e) {}
      }
    }
    var opts = await loadOptions();

    var ov = document.createElement('div'); ov.id = 'pushDialog';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
    var box = document.createElement('div');
    box.setAttribute('role', 'dialog');
    box.style.cssText = 'background:' + c.bg + ';color:' + c.fg + ';border:1px solid ' + c.line + ';border-radius:16px;padding:20px;max-width:400px;width:100%;max-height:90vh;overflow:auto;box-shadow:0 10px 40px ' + c.shadow + ';font-family:system-ui,sans-serif';
    var h = document.createElement('h3'); h.style.cssText = 'margin:0 0 12px;color:' + c.fg; h.textContent = '🔔 Notifications';
    box.appendChild(h);
    function check(label, checked) {
      var l = document.createElement('label'); l.style.cssText = 'display:flex;gap:10px;align-items:center;margin:8px 0;font-size:14px;cursor:pointer;color:' + c.fg;
      var i = document.createElement('input'); i.type = 'checkbox'; i.checked = checked; i.style.cssText = 'width:auto;margin:0';
      l.append(i, document.createTextNode(label)); return { el: l, input: i };
    }
    var cq = check('Nouveaux quiz', st.notify_quiz), cm = check("Messages de l'équipe", st.notify_messages);
    box.append(cq.el, cm.el);

    function label(text) { var l = document.createElement('div'); l.style.cssText = 'font-size:12px;font-weight:700;color:' + c.mut + ';margin:12px 0 2px'; l.textContent = text; return l; }
    box.appendChild(label('Niveau (facultatif)'));
    var lvl = document.createElement('select'); lvl.style.cssText = fieldStyle(c);
    [['', 'Tous les niveaux']].concat((opts.levels || []).map(function (l) { return [l, l]; })).forEach(function (p) { var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; lvl.appendChild(o); });
    lvl.value = st.preferred_level || ''; box.appendChild(lvl);

    box.appendChild(label('Matières (aucune cochée = toutes)'));
    var subjBox = document.createElement('div'); subjBox.style.cssText = 'max-height:130px;overflow:auto;border:1px solid ' + c.line + ';border-radius:8px;padding:4px 8px;background:' + c.card;
    var subjChecks = [];
    var all = Array.from(new Set((opts.subjects || []).concat(st.preferred_subjects || [])));
    if (!all.length) { var none = document.createElement('div'); none.style.cssText = 'font-size:13px;color:' + c.mut + ';padding:6px 0'; none.textContent = 'Aucune matière pour le moment.'; subjBox.appendChild(none); }
    all.forEach(function (s) { var k = check(s, (st.preferred_subjects || []).indexOf(s) !== -1); k.input.value = s; subjChecks.push(k.input); subjBox.appendChild(k.el); });
    box.appendChild(subjBox);

    box.appendChild(label('Langue des notifications'));
    var lang = document.createElement('select'); lang.style.cssText = fieldStyle(c);
    [['fr', 'Français'], ['en', 'English']].forEach(function (p) { var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; lang.appendChild(o); });
    lang.value = st.language || 'fr'; box.appendChild(lang);

    var msg = document.createElement('div'); msg.style.cssText = 'font-size:13px;font-weight:700;min-height:18px;margin:8px 0;color:' + c.fg; box.appendChild(msg);
    var bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:6px'; box.appendChild(bar);
    function btn(text, fn, ghost) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.style.cssText = btnStyle(c, ghost);
      b.onclick = async function () { b.disabled = true; try { await fn(); } catch (e) { msg.style.color = c.err; msg.textContent = e.message; } b.disabled = false; };
      bar.appendChild(b);
    }
    btn(id ? 'Enregistrer' : 'Activer', async function () {
      var prefs = {
        notify_quiz: cq.input.checked, notify_messages: cm.input.checked, language: lang.value,
        preferred_level: lvl.value || null,
        preferred_subjects: subjChecks.filter(function (i) { return i.checked; }).map(function (i) { return i.value; })
      };
      if (id) await api('/api/push/preferences', 'POST', Object.assign({}, id, prefs));
      else { var r = await enable(prefs); id = r.id; }
      cachePrefs(id, prefs);
      try { await supabaseClient.auth.updateUser({ data: { language: prefs.language } }); } catch (e) {}
      msg.style.color = c.ok; msg.textContent = 'Enregistré ✓'; refreshButton();
    });
    if (id) btn('Désactiver', async function () { await disable(); closeDialog(); refreshButton(); }, true);
    btn('Fermer', closeDialog, true);
    ov.appendChild(box); ov.addEventListener('click', function (e) { if (e.target === ov) closeDialog(); });
    document.body.appendChild(ov);
  }

  // ---------- Invitation ----------
  function dismissPrompt() { store(K.promptAt, String(Date.now())); var b = $('pushPromptBanner'); if (b) b.remove(); }

  var prompting = false;
  async function maybePrompt() {
    if (prompting) return;
    prompting = true;
    try {
      if (!supported || $('pushPromptBanner')) return;
      var s = await fetchSettings();
      if (!s.notifications_enabled) return;                       // réglage global désactivé : aucune invitation
      var pb = $('pushBtn'); if (!pb || pb.style.display === 'none') return;
      if (Date.now() - Number(load(K.promptAt) || 0) < PROMPT_PAUSE) return;
      if ((await permission()) !== 'default') return;
      if (await currentId()) return;
      if (!(Number(load(K.quizzes) || 0) >= 1 || Number(load(K.visits) || 0) >= 3)) return;
      var c = pal(), b = document.createElement('div');
      b.id = 'pushPromptBanner'; b.setAttribute('role', 'region'); b.setAttribute('aria-label', 'Activer les notifications');
      var lift = $('pwaInstallBanner') ? 84 : 12;
      b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(' + lift + 'px + env(safe-area-inset-bottom,0px));z-index:9998;max-width:460px;margin:0 auto;background:' + c.bg + ';color:' + c.fg + ';border:1px solid ' + c.line + ';border-radius:14px;padding:12px 14px;display:flex;gap:10px;align-items:center;box-shadow:0 8px 30px ' + c.shadow + ';font:14px/1.4 system-ui,sans-serif';
      var t = document.createElement('span'); t.style.flex = '1'; t.textContent = '🔔 Sois prévenu des nouveaux quiz et des messages de l’équipe.';
      var ok = document.createElement('button'); ok.type = 'button'; ok.textContent = 'Activer'; ok.style.cssText = btnStyle(c, false);
      ok.onclick = function () { dismissPrompt(); openDialog(); };
      var no = document.createElement('button'); no.type = 'button'; no.textContent = '✕'; no.setAttribute('aria-label', 'Plus tard'); no.style.cssText = 'background:transparent;border:0;color:' + c.mut + ';font-size:18px;cursor:pointer;padding:4px 6px';
      no.onclick = dismissPrompt;
      b.append(t, ok, no); document.body.appendChild(b);
    } catch (e) {} finally { prompting = false; }
  }

  // ---------- Mes notifications ----------
  function closeInbox() { var d = $('pushInbox'); if (d) d.remove(); }
  function fmtDate(iso) { try { return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return ''; } }

  async function fetchInbox() {
    var l = await userLanguage();
    return (await api('/api/push/inbox?lang=' + l)).notifications || [];
  }
  async function refreshBell() {
    var b = $('bellBtn'); if (!b) return;
    try {
      var list = await fetchInbox();
      var seen = Number(load(K.seen) || 0);
      var n = list.filter(function (x) { return new Date(x.created_at).getTime() > seen; }).length;
      var badge = $('bellBadge');
      if (badge) { badge.textContent = n > 9 ? '9+' : String(n); badge.style.display = n ? 'inline-block' : 'none'; }
    } catch (e) {}
  }
  async function openInbox() {
    closeInbox();
    var c = pal();
    var ov = document.createElement('div'); ov.id = 'pushInbox';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
    var box = document.createElement('div'); box.setAttribute('role', 'dialog');
    box.style.cssText = 'background:' + c.bg + ';color:' + c.fg + ';border:1px solid ' + c.line + ';border-radius:16px;padding:18px;max-width:440px;width:100%;max-height:85vh;overflow:auto;box-shadow:0 10px 40px ' + c.shadow + ';font-family:system-ui,sans-serif';
    var h = document.createElement('h3'); h.style.cssText = 'margin:0 0 10px;color:' + c.fg; h.textContent = '🔔 Mes notifications';
    var list = document.createElement('div'); list.textContent = 'Chargement…'; list.style.color = c.mut;
    var close = document.createElement('button'); close.type = 'button'; close.textContent = 'Fermer'; close.style.cssText = btnStyle(c, true) + ';margin-top:12px'; close.onclick = closeInbox;
    box.append(h, list, close); ov.appendChild(box); ov.addEventListener('click', function (e) { if (e.target === ov) closeInbox(); });
    document.body.appendChild(ov);
    try {
      var items = await fetchInbox();
      list.textContent = ''; list.style.color = c.fg;
      if (!items.length) { list.textContent = 'Aucune notification pour le moment.'; list.style.color = c.mut; }
      var seen = Number(load(K.seen) || 0);
      items.forEach(function (n) {
        var isNew = new Date(n.created_at).getTime() > seen;
        var row = document.createElement('div'); row.style.cssText = 'padding:10px 0;border-bottom:1px solid ' + c.line + ';cursor:pointer';
        var t = document.createElement('div'); t.style.cssText = 'font-weight:700'; t.textContent = (n.kind === 'quiz' ? '🆕 ' : '📣 ') + n.title + (isNew ? '  •' : '');
        var b = document.createElement('div'); b.style.cssText = 'font-size:14px'; b.textContent = n.body;
        var m = document.createElement('div'); m.style.cssText = 'font-size:11px;color:' + c.mut; m.textContent = fmtDate(n.created_at);
        row.append(t, b, m);
        row.onclick = function () { var u = safePath(n.url); closeInbox(); if (u) location.href = u; };
        list.appendChild(row);
      });
      if (items.length) store(K.seen, String(new Date(items[0].created_at).getTime()));
      refreshBell();
    } catch (e) { list.textContent = e.message; list.style.color = c.err; }
  }

  // ---------- Panneau admin ----------
  function updatePreview() {
    if (!$('pushTitle')) return;
    $('pushTitleCount').textContent = $('pushTitle').value.length + '/80';
    $('pushBodyCount').textContent = $('pushBody').value.length + '/300';
    $('pushPreviewTitle').textContent = $('pushTitle').value || 'Titre de la notification';
    $('pushPreviewBody').textContent = $('pushBody').value || 'Ton message apparaîtra ici.';
  }

  async function adminDelete(path, question) {
    if (!confirm(question)) return;
    try { await api(path, 'DELETE'); await adminLoad(); }
    catch (e) { var r = $('pushResult'); if (r) { r.style.color = '#B91C1C'; r.textContent = e.message; } }
  }

  async function adminLoad() {
    var list = $('pushHistory'); if (!list) return;
    try {
      var d = await api('/api/admin/push/history');
      $('pushSubCount').textContent = d.subscribers + ' appareil(s) abonné(s)' + (d.android !== undefined ? ' (' + d.web + ' web · ' + d.android + ' Android)' : '');
      list.textContent = '';
      var clear = $('pushClearBtn'); if (clear) clear.style.display = d.history.length ? 'inline-block' : 'none';
      if (!d.history.length) { list.textContent = 'Aucun envoi pour le moment.'; return; }
      d.history.forEach(function (m) {
        var item = document.createElement('div'); item.style.cssText = 'border-bottom:1px solid #E5E7EB;padding:8px 0;display:flex;gap:8px;align-items:flex-start';
        var txt = document.createElement('div'); txt.style.flex = '1';
        var t = document.createElement('div'); t.style.fontWeight = '700'; t.textContent = (m.kind === 'quiz' ? '🆕 ' : '📣 ') + m.title;
        var b = document.createElement('div'); b.textContent = m.body;
        var meta = document.createElement('div'); meta.style.cssText = 'font-size:11px;color:#6B7280';
        meta.textContent = fmtDate(m.created_at) + ' · ' + m.delivered + '/' + m.recipients + ' reçu(s)' + (m.failed ? ' · ' + m.failed + ' échec(s)' : '') + (m.click_count !== undefined ? ' · 👆 ' + m.click_count + ' ouverture(s)' : '');
        txt.append(t, b, meta);
        var del = document.createElement('button'); del.type = 'button'; del.textContent = '🗑️'; del.title = 'Supprimer cette notification de l’historique'; del.setAttribute('aria-label', 'Supprimer');
        del.style.cssText = 'background:transparent;border:0;cursor:pointer;font-size:16px;padding:2px 4px';
        del.onclick = function () { adminDelete('/api/admin/push/history/' + encodeURIComponent(m.id), 'Supprimer cette notification de l’historique ?'); };
        item.append(txt, del); list.appendChild(item);
      });
    } catch (e) { list.textContent = e.message; }
  }

  async function adminSend() {
    var title = $('pushTitle').value.trim(), body = $('pushBody').value.trim(), res = $('pushResult'), btn = $('pushSendBtn');
    res.style.color = '#B91C1C';
    if (!title || !body) { res.textContent = 'Titre et message obligatoires.'; return; }
    if (!confirm('Envoyer cette notification aux abonnés ?\n\n' + title + '\n' + body)) return;
    var payload = { title: title, body: body, url: $('pushUrl').value };
    var subj = $('pushSubject') && $('pushSubject').value.trim(); if (subj) payload.subject = subj;
    var lv = $('pushLevel') && $('pushLevel').value; if (lv) payload.level = lv;
    var te = $('pushTitleEn') && $('pushTitleEn').value.trim(), be = $('pushBodyEn') && $('pushBodyEn').value.trim();
    if (te || be) payload.translations = { en: { title: te || title, body: be || body } };
    btn.disabled = true; res.style.color = '#6B7280'; res.textContent = 'Envoi en cours…';
    try {
      var r = await api('/api/admin/push/send', 'POST', payload);
      res.style.color = '#047857';
      res.textContent = r.recipients ? ('Envoyé : ' + r.delivered + ' reçu(s) sur ' + r.recipients + (r.failed ? ' (' + r.failed + ' échec(s))' : '') + '.') : "Aucun appareil abonné ne correspond pour l'instant.";
      ['pushTitle', 'pushBody', 'pushSubject', 'pushTitleEn', 'pushBodyEn'].forEach(function (i) { if ($(i)) $(i).value = ''; });
      updatePreview(); adminLoad();
    } catch (e) { res.style.color = '#B91C1C'; res.textContent = e.message; }
    btn.disabled = false;
  }

  function bind() {
    var b = $('pushBtn'); if (b) b.addEventListener('click', openDialog);
    var bell = $('bellBtn'); if (bell) bell.addEventListener('click', openInbox);
    if ($('pushTitle')) { $('pushTitle').addEventListener('input', updatePreview); $('pushBody').addEventListener('input', updatePreview); updatePreview(); }
    if ($('pushSendBtn')) $('pushSendBtn').addEventListener('click', adminSend);
    if ($('pushClearBtn')) $('pushClearBtn').addEventListener('click', function () { adminDelete('/api/admin/push/history', 'Supprimer TOUT l’historique des notifications ? Cette action est définitive.'); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && $('pushBtn') && $('pushBtn').style.display !== 'none') clearDelivered(); });
  }

  var syncing = false;
  async function resync() {
    if (syncing || Date.now() - Number(load(K.sync) || 0) < SYNC_EVERY) return;
    syncing = true;
    try {
      if (native) { nativeInit(); if ((await nativePermission()) === 'granted') PN.register(); }
      else if (webSupported && Notification.permission === 'granted') {
        var sub = await webSub();
        if (sub) { await api('/api/push/subscribe', 'POST', { subscription: sub.toJSON() }); store(K.sync, String(Date.now())); }
      }
    } catch (e) {} finally { syncing = false; }
  }

  window.PushUI = {
    adminLoad: adminLoad,
    openInbox: openInbox,
    reloadSettings: function () {
      try { localStorage.removeItem(K.settings); } catch (e) {}
      refreshButton();
    },
    onQuizCompleted: function () {
      store(K.quizzes, String(Number(load(K.quizzes) || 0) + 1));
      setTimeout(maybePrompt, 1500);
    },
    afterLogin: function () {
      var b = $('pushBtn');
      var bell = $('bellBtn'); if (bell) bell.style.display = 'inline-flex';
      refreshButton(); refreshBell(); clearDelivered(); trackOpen(); resync();
      setTimeout(maybePrompt, 2500);
    },
    afterLogout: function () {
      var b = $('pushBtn'); if (b) b.style.display = 'none';
      var bell = $('bellBtn'); if (bell) bell.style.display = 'none';
      closeDialog(); closeInbox(); var p = $('pushPromptBanner'); if (p) p.remove();
    }
  };

  bind();

  if (typeof supabaseClient !== 'undefined' && supabaseClient.auth) {
    supabaseClient.auth.getSession().then(function (s) {
      if (s && s.data && s.data.session) window.PushUI.afterLogin();
    }).catch(function () {});
  }
})();
