import express, { Router } from 'express';

const MAX_TITLE = 80;
const MAX_BODY = 300;
const QUIZ_BATCH_DELAY = 60_000;      // regroupe les quiz créés dans la minute
const QUIZ_MIN_GAP = 5 * 60_000;      // au plus une alerte « nouveau quiz » toutes les 5 minutes
const ADMIN_COOLDOWN = 3_000;         // anti double-clic sur « Envoyer »
const DEAD_FCM = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const safeUrl = (u) => (typeof u === 'string' && /^\/(?!\/)\S{0,299}$/.test(u) ? u : '/');
const ZERO = { recipients: 0, delivered: 0, failed: 0 };
const add = (a, b) => ({ recipients: a.recipients + b.recipients, delivered: a.delivered + b.delivered, failed: a.failed + b.failed });
const must = (res) => { if (res.error) throw new Error(res.error.message || String(res.error)); return res; };

export function createPush({ env = process.env, clock = Date.now, supabase: injectedSupabase = null, messaging: injectedMessaging = null, webpush: injectedWebpush = null } = {}) {
  const router = Router();
  router.use(express.json({ limit: '20kb' }));

  const st = { sb: null, wp: null, msg: null, webOk: false, fcmOk: false };

  // Initialisation : chaque brique est facultative, un échec ne fait jamais tomber le serveur.
  const ready = (async () => {
    try {
      if (injectedSupabase) st.sb = injectedSupabase;
      else if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
        const { createClient } = await import('@supabase/supabase-js');
        st.sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      } else console.warn('[push] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absentes : notifications désactivées.');
    } catch (e) { console.error('[push] Supabase indisponible :', e.message); }

    if (injectedWebpush || (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY)) {
      try {
        const wp = injectedWebpush || (await import('web-push')).default;
        wp.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
        st.wp = wp; st.webOk = true;
      } catch (e) { console.error('[push] Web Push désactivé (clés VAPID / web-push) :', e.message); }
    } else console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY absentes : notifications web désactivées.');

    if (injectedMessaging) { st.msg = injectedMessaging; st.fcmOk = true; }
    else if (env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        let raw = String(env.FIREBASE_SERVICE_ACCOUNT).trim();
        if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
        const { initializeApp, cert, getApps } = await import('firebase-admin/app');
        const { getMessaging } = await import('firebase-admin/messaging');
        st.msg = getMessaging(getApps().length ? getApps()[0] : initializeApp({ credential: cert(JSON.parse(raw)) }));
        st.fcmOk = true;
      } catch (e) { console.error('[push] Firebase désactivé (FIREBASE_SERVICE_ACCOUNT / firebase-admin) :', e.message); }
    } else console.warn('[push] FIREBASE_SERVICE_ACCOUNT absent : notifications Android désactivées.');
  })();

  // ---------- Authentification ----------
  async function authUser(req, res, next) {
    await ready;
    if (!st.sb) return res.status(503).json({ error: 'Notifications non configurées sur le serveur.' });
    const h = String(req.headers.authorization || '');
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'Authentification requise.' });
    try {
      const { data, error } = await st.sb.auth.getUser(token);
      if (error || !data || !data.user) return res.status(401).json({ error: 'Session invalide ou expirée.' });
      req.pushUser = data.user;
      next();
    } catch (e) {
      console.error('[push] vérification du jeton :', e.message);
      res.status(503).json({ error: 'Service d\'authentification indisponible.' });
    }
  }

  function authAdmin(req, res, next) {
    authUser(req, res, () => {
      const u = req.pushUser;
      const adminEmail = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
      const isAdmin = u.app_metadata?.is_admin === true || u.app_metadata?.role === 'admin' || Boolean(adminEmail && String(u.email || '').toLowerCase() === adminEmail);
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      next();
    });
  }

  const run = (fn) => async (req, res) => {
    if (!st.webOk && !st.fcmOk) return res.status(503).json({ error: 'Notifications non configurées sur le serveur.' });
    try { await fn(req, res); } catch (e) { console.error('[push]', e.message); res.status(500).json({ error: 'Erreur serveur notifications.' }); }
  };

  const prefsOf = (b) => {
    const p = {};
    if (typeof b.notify_quiz === 'boolean') p.notify_quiz = b.notify_quiz;
    if (typeof b.notify_messages === 'boolean') p.notify_messages = b.notify_messages;
    return p;
  };
  // Un appareil est identifié par son jeton FCM (Android) ou par l'endpoint de son abonnement (navigateur).
  const idOf = (b) => (typeof b.fcm_token === 'string' && b.fcm_token ? { col: 'fcm_token', val: b.fcm_token }
    : (typeof b.endpoint === 'string' && b.endpoint ? { col: 'endpoint', val: b.endpoint } : null));

  // ---------- Utilisateur ----------
  router.get('/push/key', async (_req, res) => {
    await ready;
    res.json({ enabled: st.webOk, publicKey: st.webOk ? env.VAPID_PUBLIC_KEY : null, fcm: st.fcmOk });
  });

  router.post('/push/subscribe', authUser, run(async (req, res) => {
    const b = req.body || {};
    const uid = req.pushUser.id;
    if (typeof b.fcm_token === 'string' && b.fcm_token) {
      if (!st.fcmOk) return res.status(503).json({ error: 'Notifications Android non configurées sur le serveur.' });
      if (!/^[A-Za-z0-9_:.\-]{20,4096}$/.test(b.fcm_token)) return res.status(400).json({ error: 'Jeton invalide.' });
      must(await st.sb.from('push_subscriptions').upsert(
        { user_id: uid, fcm_token: b.fcm_token, platform: 'android', ...prefsOf(b) }, { onConflict: 'fcm_token' }));
      return res.json({ ok: true });
    }
    if (!st.webOk) return res.status(503).json({ error: 'Notifications web non configurées sur le serveur.' });
    const sub = b.subscription || {};
    const endpoint = String(sub.endpoint || '');
    const p256dh = String(sub.keys?.p256dh || '');
    const auth = String(sub.keys?.auth || '');
    if (!/^https:\/\/\S{10,2000}$/.test(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{20,30}$/.test(auth)) {
      return res.status(400).json({ error: 'Abonnement invalide.' });
    }
    must(await st.sb.from('push_subscriptions').upsert(
      { user_id: uid, endpoint, p256dh, auth, platform: 'web', ...prefsOf(b) }, { onConflict: 'endpoint' }));
    res.json({ ok: true });
  }));

  router.post('/push/unsubscribe', authUser, run(async (req, res) => {
    const id = idOf(req.body || {});
    if (!id) return res.status(400).json({ error: 'Abonnement manquant.' });
    must(await st.sb.from('push_subscriptions').delete().eq('user_id', req.pushUser.id).eq(id.col, id.val));
    res.json({ ok: true });
  }));

  router.post('/push/preferences', authUser, run(async (req, res) => {
    const id = idOf(req.body || {});
    const patch = prefsOf(req.body || {});
    if (!id || !Object.keys(patch).length) return res.status(400).json({ error: 'Préférences invalides.' });
    must(await st.sb.from('push_subscriptions').update(patch).eq('user_id', req.pushUser.id).eq(id.col, id.val));
    res.json({ ok: true });
  }));

  router.post('/push/status', authUser, run(async (req, res) => {
    const id = idOf(req.body || {});
    if (!id) return res.json({ subscribed: false });
    const { data } = must(await st.sb.from('push_subscriptions').select('notify_quiz,notify_messages')
      .eq('user_id', req.pushUser.id).eq(id.col, id.val).limit(1));
    res.json(data && data[0] ? { subscribed: true, notify_quiz: data[0].notify_quiz, notify_messages: data[0].notify_messages } : { subscribed: false });
  }));

  // ---------- Envoi ----------
  async function listTargets(prefCol, excludeUsers = new Set()) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data } = must(await st.sb.from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth,fcm_token')
        .eq(prefCol, true).order('id').range(from, from + 999));
      rows.push(...data);
      if (data.length < 1000) break;
    }
    const keep = rows.filter((r) => !excludeUsers.has(r.user_id));
    return {
      web: st.webOk ? keep.filter((r) => r.endpoint && r.p256dh && r.auth && !r.fcm_token) : [],
      android: st.fcmOk ? keep.filter((r) => r.fcm_token) : []
    };
  }

  const removeDead = async (ids) => {
    for (let i = 0; i < ids.length; i += 50) {
      await st.sb.from('push_subscriptions').delete().in('id', ids.slice(i, i + 50)).then(() => {}, () => {});
    }
  };

  async function sendWeb(rows, payload) {
    if (!rows.length) return ZERO;
    const body = JSON.stringify(payload);
    let delivered = 0, failed = 0;
    const dead = [];
    for (let i = 0; i < rows.length; i += 25) {
      await Promise.all(rows.slice(i, i + 25).map(async (r) => {
        try {
          await st.wp.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, body, { TTL: 86400, timeout: 10000 });
          delivered++;
        } catch (e) {
          failed++;
          if (e.statusCode === 404 || e.statusCode === 410) dead.push(r.id);
          else console.warn('[push] échec d\'envoi web :', e.statusCode || e.message);
        }
      }));
    }
    await removeDead(dead);
    return { recipients: rows.length, delivered, failed };
  }

  async function sendFcm(rows, payload) {
    if (!rows.length) return ZERO;
    let delivered = 0, failed = 0;
    const dead = [];
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      try {
        const res = await st.msg.sendEachForMulticast({
          tokens: chunk.map((r) => r.fcm_token),
          notification: { title: payload.title, body: payload.body },
          data: { url: String(payload.url || '/'), kind: String(payload.kind || ''), tag: String(payload.tag || '') },
          android: {
            priority: 'high',
            ttl: 86400000,
            notification: { channelId: 'revisio', icon: 'ic_stat_revisio', color: '#064E3B', ...(payload.tag ? { tag: String(payload.tag).slice(0, 64) } : {}) }
          }
        });
        res.responses.forEach((r, k) => {
          if (r.success) delivered++;
          else {
            failed++;
            const code = r.error && r.error.code;
            if (DEAD_FCM.has(code)) dead.push(chunk[k].id);
            else console.warn('[push] échec d\'envoi Android :', code || (r.error && r.error.message));
          }
        });
      } catch (e) {
        failed += chunk.length;
        console.error('[push] FCM indisponible :', e.message);
      }
    }
    await removeDead(dead);
    return { recipients: rows.length, delivered, failed };
  }

  async function broadcast(prefCol, payload, excludeUsers) {
    const t = await listTargets(prefCol, excludeUsers);
    return add(await sendWeb(t.web, payload), await sendFcm(t.android, payload));
  }

  async function logMessage(kind, p, createdBy, r) {
    const { error } = await st.sb.from('push_messages').insert({
      kind, title: p.title, body: p.body, url: p.url, created_by: createdBy || null,
      recipients: r.recipients, delivered: r.delivered, failed: r.failed
    });
    if (error) console.warn('[push] journal non enregistré :', error.message);
  }

  // ---------- Administrateur (le rôle est vérifié AVANT toute opération en base) ----------
  let lastAdminSend = 0;

  router.post('/admin/push/send', authAdmin, run(async (req, res) => {
    const title = clean(req.body?.title, MAX_TITLE);
    const body = clean(req.body?.body, MAX_BODY);
    if (!title || !body) return res.status(400).json({ error: 'Titre et message obligatoires.' });
    if (clock() - lastAdminSend < ADMIN_COOLDOWN) return res.status(429).json({ error: 'Patiente quelques secondes avant un nouvel envoi.' });
    lastAdminSend = clock();
    const payload = { title, body, url: safeUrl(req.body?.url), tag: `msg-${clock()}`, kind: 'message' };
    const result = await broadcast('notify_messages', payload);
    await logMessage('message', payload, req.pushUser.id, result);
    res.json({ ok: true, ...result });
  }));

  router.get('/admin/push/history', authAdmin, run(async (_req, res) => {
    const { data: history } = must(await st.sb.from('push_messages')
      .select('id,kind,title,body,url,recipients,delivered,failed,created_at').order('created_at', { ascending: false }).limit(20));
    const count = async (platform) => must(await st.sb.from('push_subscriptions').select('id', { count: 'exact', head: true }).eq('platform', platform)).count || 0;
    const web = await count('web');
    const android = await count('android');
    res.json({ subscribers: web + android, web, android, history });
  }));

  // ---------- Nouveaux quiz (regroupés pour éviter le spam) ----------
  let pending = [];
  let timer = null;
  let lastQuizSend = 0;

  async function flushQuizzes() {
    timer = null;
    const batch = pending;
    pending = [];
    if (!batch.length) return;
    await ready;
    if (!st.sb || (!st.webOk && !st.fcmOk)) return;
    lastQuizSend = clock();
    const authors = new Set(batch.map((q) => q.by).filter(Boolean));
    const payload = batch.length === 1
      ? { title: 'Nouveau quiz disponible', body: batch[0].title, url: '/?tab=library', tag: 'new-quiz', kind: 'quiz' }
      : {
          title: `${batch.length} nouveaux quiz disponibles`,
          body: batch.slice(0, 2).map((q) => q.title).join(' · ') + (batch.length > 2 ? '…' : ''),
          url: '/?tab=library', tag: 'new-quiz', kind: 'quiz'
        };
    const result = await broadcast('notify_quiz', payload, authors);
    await logMessage('quiz', payload, null, result);
  }

  function notifyNewQuiz(quiz, creatorId) {
    if (!quiz || !quiz.title) return;
    pending.push({ title: clean(quiz.title, MAX_TITLE), by: creatorId });
    if (timer) return;
    const delay = Math.max(QUIZ_BATCH_DELAY, lastQuizSend + QUIZ_MIN_GAP - clock());
    timer = setTimeout(() => flushQuizzes().catch((e) => console.error('[push] quiz :', e.message)), delay);
    timer.unref?.();
  }

  return { router, notifyNewQuiz, flushQuizzes, ready };
}
