import { Router } from 'express';
import webpush from 'web-push';

const MAX_TITLE = 80;
const MAX_BODY = 300;
const QUIZ_BATCH_DELAY = 60_000;
const QUIZ_MIN_GAP = 5 * 60_000;
const ADMIN_COOLDOWN = 3_000;
const DEAD_FCM = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
const TARGETS = {
  web: { table: 'push_subscriptions', col: 'endpoint' },
  android: { table: 'push_fcm_tokens', col: 'token' }
};

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const safeUrl = (u) => (typeof u === 'string' && /^\/(?!\/)\S{0,299}$/.test(u) ? u : '/');
const add = (a, b) => ({ recipients: a.recipients + b.recipients, delivered: a.delivered + b.delivered, failed: a.failed + b.failed });
const ZERO = { recipients: 0, delivered: 0, failed: 0 };

export function createPush({ requireAdmin, env = process.env, http = fetch, sender = webpush, fcm = null, clock = Date.now } = {}) {
  const router = Router();

  // ---------- Web Push (navigateurs, PWA) ----------
  let enabled = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
  if (enabled) {
    try {
      sender.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    } catch (e) {
      console.error('[push] clés VAPID invalides, notifications web désactivées :', e.message);
      enabled = false;
    }
  } else {
    console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY absentes : notifications web désactivées.');
  }

  // ---------- Firebase Cloud Messaging (application Android) ----------
  let fcmOk = Boolean(fcm || env.FIREBASE_SERVICE_ACCOUNT);
  const fcmReady = (async () => {
    if (fcm) return fcm;
    if (!env.FIREBASE_SERVICE_ACCOUNT) return null;
    try {
      let raw = String(env.FIREBASE_SERVICE_ACCOUNT).trim();
      if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
      const { initializeApp, cert, getApps } = await import('firebase-admin/app');
      const { getMessaging } = await import('firebase-admin/messaging');
      const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(JSON.parse(raw)) });
      return getMessaging(app);
    } catch (e) {
      console.error('[push] Firebase désactivé (FIREBASE_SERVICE_ACCOUNT / firebase-admin) :', e.message);
      fcmOk = false;
      return null;
    }
  })();
  if (!fcmOk) console.warn('[push] FIREBASE_SERVICE_ACCOUNT absent : notifications Android désactivées.');

  const base = () => String(env.SUPABASE_URL || '').replace(/\/$/, '');

  async function db(pathAndQuery, { method = 'GET', body, prefer, withCount = false } = {}) {
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await http(`${base()}/rest/v1/${pathAndQuery}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Supabase ${method} ${pathAndQuery.split('?')[0]} : ${res.status} ${await res.text()}`);
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!withCount) return data;
    const range = res.headers.get('content-range') || '';
    return { data, count: Number(range.split('/')[1]) || 0 };
  }

  async function listRows(table, select, filter) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const rows = await db(`${table}?select=${select}&${filter}&order=id&limit=1000&offset=${offset}`);
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }
  const listSubs = (filter) => (enabled ? listRows('push_subscriptions', 'id,endpoint,p256dh,auth,user_id', filter) : Promise.resolve([]));
  const listTokens = (filter) => (fcmOk
    ? listRows('push_fcm_tokens', 'id,token,user_id', filter).catch((e) => { console.warn('[push] jetons Android illisibles :', e.message); return []; })
    : Promise.resolve([]));

  const removeIds = async (table, ids) => {
    for (let i = 0; i < ids.length; i += 50) {
      await db(`${table}?id=in.(${ids.slice(i, i + 50).join(',')})`, { method: 'DELETE' }).catch(() => {});
    }
  };

  async function deliverWeb(subs, payload) {
    if (!subs.length) return ZERO;
    const body = JSON.stringify(payload);
    let delivered = 0;
    let failed = 0;
    const dead = [];
    for (let i = 0; i < subs.length; i += 25) {
      await Promise.all(subs.slice(i, i + 25).map(async (s) => {
        try {
          await sender.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 86400, timeout: 10000 });
          delivered++;
        } catch (e) {
          failed++;
          if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.id);
          else console.warn('[push] échec d\'envoi web :', e.statusCode || e.message);
        }
      }));
    }
    await removeIds('push_subscriptions', dead);
    return { recipients: subs.length, delivered, failed };
  }

  async function deliverFcm(tokens, payload) {
    if (!tokens.length) return ZERO;
    const messaging = await fcmReady;
    if (!messaging) return { recipients: tokens.length, delivered: 0, failed: tokens.length };
    let delivered = 0;
    let failed = 0;
    const dead = [];
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      try {
        const res = await messaging.sendEachForMulticast({
          tokens: chunk.map((t) => t.token),
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
    await removeIds('push_fcm_tokens', dead);
    return { recipients: tokens.length, delivered, failed };
  }

  async function broadcast(filter, payload, excludeUsers = new Set()) {
    const subs = (await listSubs(filter)).filter((s) => !excludeUsers.has(s.user_id));
    const tokens = (await listTokens(filter)).filter((t) => !excludeUsers.has(t.user_id));
    return add(await deliverWeb(subs, payload), await deliverFcm(tokens, payload));
  }

  async function logMessage(kind, p, createdBy, r) {
    await db('push_messages', {
      method: 'POST',
      prefer: 'return=minimal',
      body: { kind, title: p.title, body: p.body, url: p.url, created_by: createdBy || null, recipients: r.recipients, delivered: r.delivered, failed: r.failed }
    }).catch((e) => console.warn('[push] journal non enregistré :', e.message));
  }

  const guard = (fn) => async (req, res) => {
    if (!enabled && !fcmOk) return res.status(503).json({ error: 'Notifications non configurées sur le serveur.' });
    try { await fn(req, res); } catch (e) { console.error('[push]', e.message); res.status(500).json({ error: 'Erreur serveur notifications.' }); }
  };

  // Cible d'une requête : appareil Android (jeton FCM) ou navigateur (abonnement web)
  const target = (req) => {
    const b = req.body || {};
    return typeof b.fcm_token === 'string' && b.fcm_token
      ? { ...TARGETS.android, value: b.fcm_token }
      : { ...TARGETS.web, value: String(b.endpoint || '') };
  };
  const prefsOf = (b) => {
    const p = {};
    if (typeof b.notify_quiz === 'boolean') p.notify_quiz = b.notify_quiz;
    if (typeof b.notify_messages === 'boolean') p.notify_messages = b.notify_messages;
    return p;
  };
  const filterOf = (t, userId) => `${t.table}?${t.col}=eq.${encodeURIComponent(t.value)}&user_id=eq.${encodeURIComponent(userId)}`;

  // ---------- Utilisateur ----------
  router.get('/push/key', async (_req, res) => { await fcmReady; res.json({ enabled, fcm: fcmOk, publicKey: enabled ? env.VAPID_PUBLIC_KEY : null }); });

  router.post('/push/subscribe', guard(async (req, res) => {
    const b = req.body || {};
    const ua = clean(req.headers['user-agent'], 200);
    if (typeof b.fcm_token === 'string' && b.fcm_token) {
      if (!fcmOk) return res.status(503).json({ error: 'Notifications Android non configurées sur le serveur.' });
      if (!/^[A-Za-z0-9_:.\-]{20,4096}$/.test(b.fcm_token)) return res.status(400).json({ error: 'Jeton invalide.' });
      await db('push_fcm_tokens?on_conflict=token', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: { user_id: req.user.id, token: b.fcm_token, user_agent: ua, ...prefsOf(b) }
      });
      return res.json({ ok: true });
    }
    if (!enabled) return res.status(503).json({ error: 'Notifications web non configurées sur le serveur.' });
    const sub = b.subscription || {};
    const endpoint = String(sub.endpoint || '');
    const p256dh = String(sub.keys?.p256dh || '');
    const auth = String(sub.keys?.auth || '');
    if (!/^https:\/\/\S{10,2000}$/.test(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{20,30}$/.test(auth)) {
      return res.status(400).json({ error: 'Abonnement invalide.' });
    }
    await db('push_subscriptions?on_conflict=endpoint', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      body: { user_id: req.user.id, endpoint, p256dh, auth, user_agent: ua, ...prefsOf(b) }
    });
    res.json({ ok: true });
  }));

  router.post('/push/status', guard(async (req, res) => {
    const t = target(req);
    if (!t.value) return res.json({ subscribed: false });
    const rows = await db(`${filterOf(t, req.user.id)}&select=notify_quiz,notify_messages`);
    res.json(rows[0] ? { subscribed: true, ...rows[0] } : { subscribed: false });
  }));

  router.post('/push/preferences', guard(async (req, res) => {
    const t = target(req);
    const patch = prefsOf(req.body || {});
    if (!t.value || !Object.keys(patch).length) return res.status(400).json({ error: 'Préférences invalides.' });
    await db(filterOf(t, req.user.id), { method: 'PATCH', prefer: 'return=minimal', body: patch });
    res.json({ ok: true });
  }));

  router.post('/push/unsubscribe', guard(async (req, res) => {
    const t = target(req);
    if (!t.value) return res.status(400).json({ error: 'Abonnement manquant.' });
    await db(filterOf(t, req.user.id), { method: 'DELETE' });
    res.json({ ok: true });
  }));

  // ---------- Administrateur ----------
  let lastAdminSend = 0;

  router.post('/admin/push/send', requireAdmin, guard(async (req, res) => {
    const title = clean(req.body?.title, MAX_TITLE);
    const body = clean(req.body?.body, MAX_BODY);
    if (!title || !body) return res.status(400).json({ error: 'Titre et message obligatoires.' });
    if (clock() - lastAdminSend < ADMIN_COOLDOWN) return res.status(429).json({ error: 'Patiente quelques secondes avant un nouvel envoi.' });
    lastAdminSend = clock();
    const payload = { title, body, url: safeUrl(req.body?.url), tag: `msg-${clock()}`, kind: 'message' };
    const result = await broadcast('notify_messages=eq.true', payload);
    await logMessage('message', payload, req.user.id, result);
    res.json({ ok: true, ...result });
  }));

  router.get('/admin/push/history', requireAdmin, guard(async (_req, res) => {
    const history = await db('push_messages?select=id,kind,title,body,url,recipients,delivered,failed,created_at&order=created_at.desc&limit=20');
    const web = enabled ? (await db('push_subscriptions?select=id&limit=1', { prefer: 'count=exact', withCount: true })).count : 0;
    const android = fcmOk ? (await db('push_fcm_tokens?select=id&limit=1', { prefer: 'count=exact', withCount: true }).catch(() => ({ count: 0 }))).count : 0;
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
    lastQuizSend = clock();
    const authors = new Set(batch.map((q) => q.by).filter(Boolean));
    const payload = batch.length === 1
      ? { title: 'Nouveau quiz disponible', body: batch[0].title, url: '/?tab=library', tag: 'new-quiz', kind: 'quiz' }
      : {
          title: `${batch.length} nouveaux quiz disponibles`,
          body: batch.slice(0, 2).map((q) => q.title).join(' · ') + (batch.length > 2 ? '…' : ''),
          url: '/?tab=library', tag: 'new-quiz', kind: 'quiz'
        };
    const result = await broadcast('notify_quiz=eq.true', payload, authors);
    await logMessage('quiz', payload, null, result);
  }

  function notifyNewQuiz(quiz, creatorId) {
    if ((!enabled && !fcmOk) || !quiz || !quiz.title) return;
    pending.push({ title: clean(quiz.title, MAX_TITLE), by: creatorId });
    if (timer) return;
    const delay = Math.max(QUIZ_BATCH_DELAY, lastQuizSend + QUIZ_MIN_GAP - clock());
    timer = setTimeout(() => flushQuizzes().catch((e) => console.error('[push] quiz :', e.message)), delay);
    timer.unref?.();
  }

  return { router, notifyNewQuiz, flushQuizzes };
}
