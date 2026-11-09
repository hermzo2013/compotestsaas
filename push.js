import express, { Router } from 'express';
import { childLogger } from './logger.js';
import { normLang, t } from './i18n.js';
import {
  validate, pushSubscribeSchema, pushDeviceSchema, pushStatusSchema, pushPreferencesSchema,
  pushSendSchema, pushClickSchema, pushHistoryIdParam
} from './schemas.js';

const log = childLogger('push');

const MAX_TITLE = 80;
const MAX_BODY = 300;
const QUIZ_BATCH_DELAY = 60_000;      // regroupe les quiz créés dans la minute
const QUIZ_MIN_GAP = 5 * 60_000;      // au plus une alerte « nouveau quiz » toutes les 5 minutes
const ADMIN_COOLDOWN = 3_000;         // anti double-clic sur « Envoyer »
const OPTIONS_TTL = 5 * 60_000;
const LEVELS = ['LICENCE 1', 'LICENCE 2', 'LICENCE 3'];
const DEAD_FCM = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const safeUrl = (u) => (typeof u === 'string' && /^\/(?!\/)\S{0,299}$/.test(u) ? u : '/');
const norm = (s) => String(s || '').trim().toLowerCase();
const ZERO = { recipients: 0, delivered: 0, failed: 0 };
const add = (a, b) => ({ recipients: a.recipients + b.recipients, delivered: a.delivered + b.delivered, failed: a.failed + b.failed });
const must = (res) => { if (res.error) throw new Error(res.error.message || String(res.error)); return res; };
// Ajoute ?from=push&mid=<id> (suivi des ouvertures) à un lien interne
const track = (url, mid) => (mid ? `${url}${url.includes('?') ? '&' : '?'}from=push&mid=${mid}` : url);

export function createPush({ env = process.env, clock = Date.now, supabase: injectedSupabase = null, messaging: injectedMessaging = null, webpush: injectedWebpush = null } = {}) {
  const router = Router();
  router.use(express.json({ limit: '20kb' }));

  const st = { sb: null, wp: null, msg: null, webOk: false, fcmOk: false, v2: null, v2At: 0 };

  // Initialisation : chaque brique est facultative, un échec ne fait jamais tomber le serveur.
  const ready = (async () => {
    try {
      if (injectedSupabase) st.sb = injectedSupabase;
      else if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
        const { createClient } = await import('@supabase/supabase-js');
        st.sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      } else log.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absentes : notifications désactivées.');
    } catch (e) { log.error({ err: e.message }, 'Supabase indisponible'); }

    if (injectedWebpush || (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY)) {
      try {
        const wp = injectedWebpush || (await import('web-push')).default;
        wp.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
        st.wp = wp; st.webOk = true;
      } catch (e) { log.error({ err: e.message }, 'Web Push désactivé (clés VAPID / web-push)'); }
    } else log.warn('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY absentes : notifications web désactivées.');

    if (injectedMessaging) { st.msg = injectedMessaging; st.fcmOk = true; }
    else if (env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        let raw = String(env.FIREBASE_SERVICE_ACCOUNT).trim();
        if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
        const { initializeApp, cert, getApps } = await import('firebase-admin/app');
        const { getMessaging } = await import('firebase-admin/messaging');
        st.msg = getMessaging(getApps().length ? getApps()[0] : initializeApp({ credential: cert(JSON.parse(raw)) }));
        st.fcmOk = true;
      } catch (e) { log.error({ err: e.message }, 'Firebase désactivé (FIREBASE_SERVICE_ACCOUNT / firebase-admin)'); }
    } else log.warn('FIREBASE_SERVICE_ACCOUNT absent : notifications Android désactivées.');
  })();

  // Les nouvelles colonnes (langue, matières, clics…) arrivent avec supabase-improvements.sql.
  // Tant qu'il n'est pas exécuté, tout continue de fonctionner comme avant (mode « v1 »).
  async function schema() {
    if (st.v2 && st.v2.subs && st.v2.msgs) return st.v2;
    if (st.v2 && clock() - st.v2At < 5 * 60_000) return st.v2;
    const probe = async (table, cols) => !(await st.sb.from(table).select(cols).limit(1)).error;
    st.v2 = { subs: await probe('push_subscriptions', 'language,preferred_subjects,preferred_level'), msgs: await probe('push_messages', 'click_count,translations') };
    st.v2At = clock();
    if (!st.v2.subs || !st.v2.msgs) log.warn(st.v2, 'Colonnes manquantes : exécutez supabase-improvements.sql (fonctionnement réduit en attendant)');
    return st.v2;
  }

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
      log.error({ err: e.message }, 'vérification du jeton');
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

  const run = (fn, { needChannel = true } = {}) => async (req, res) => {
    if (needChannel && !st.webOk && !st.fcmOk) return res.status(503).json({ error: 'Notifications non configurées sur le serveur.' });
    try { await fn(req, res); } catch (e) { log.error({ err: e.message, path: req.path }, 'erreur route notifications'); res.status(500).json({ error: 'Erreur serveur notifications.' }); }
  };

  const PREF_COLS = ['notify_quiz', 'notify_messages', 'preferred_subjects', 'preferred_level', 'language'];
  const V2_SUB_COLS = ['preferred_subjects', 'preferred_level', 'language'];
  const prefsOf = (b, sch) => {
    const p = {};
    for (const k of PREF_COLS) {
      if (b[k] === undefined) continue;
      if (V2_SUB_COLS.includes(k) && !sch.subs) continue;
      p[k] = k === 'preferred_subjects' ? [...new Set(b[k].map((s) => s.trim()))] : b[k];
    }
    return p;
  };
  // Un appareil est identifié par son jeton FCM (Android) ou par l'endpoint de son abonnement (navigateur).
  const idOf = (b) => (b.fcm_token ? { col: 'fcm_token', val: b.fcm_token } : (b.endpoint ? { col: 'endpoint', val: b.endpoint } : null));

  // ---------- Utilisateur ----------
  router.get('/push/key', async (_req, res) => {
    await ready;
    res.json({ enabled: st.webOk, publicKey: st.webOk ? env.VAPID_PUBLIC_KEY : null, fcm: st.fcmOk });
  });

  router.post('/push/subscribe', authUser, validate(pushSubscribeSchema), run(async (req, res) => {
    const b = req.body;
    const sch = await schema();
    const base = { user_id: req.pushUser.id, ...prefsOf(b, sch) };
    if (b.fcm_token) {
      if (!st.fcmOk) return res.status(503).json({ error: 'Notifications Android non configurées sur le serveur.' });
      must(await st.sb.from('push_subscriptions').upsert({ ...base, fcm_token: b.fcm_token, platform: 'android' }, { onConflict: 'fcm_token' }));
      return res.json({ ok: true });
    }
    if (!st.webOk) return res.status(503).json({ error: 'Notifications web non configurées sur le serveur.' });
    const s = b.subscription;
    must(await st.sb.from('push_subscriptions').upsert(
      { ...base, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, platform: 'web' }, { onConflict: 'endpoint' }));
    res.json({ ok: true });
  }));

  router.post('/push/unsubscribe', authUser, validate(pushDeviceSchema), run(async (req, res) => {
    const id = idOf(req.body);
    must(await st.sb.from('push_subscriptions').delete().eq('user_id', req.pushUser.id).eq(id.col, id.val));
    res.json({ ok: true });
  }, { needChannel: false }));

  router.post('/push/preferences', authUser, validate(pushPreferencesSchema), run(async (req, res) => {
    const id = idOf(req.body);
    const patch = prefsOf(req.body, await schema());
    if (Object.keys(patch).length) {
      must(await st.sb.from('push_subscriptions').update(patch).eq('user_id', req.pushUser.id).eq(id.col, id.val));
    }
    res.json({ ok: true });
  }, { needChannel: false }));

  router.post('/push/status', authUser, validate(pushStatusSchema), run(async (req, res) => {
    const id = idOf(req.body);
    if (!id) return res.json({ subscribed: false });
    const sch = await schema();
    const cols = 'notify_quiz,notify_messages' + (sch.subs ? ',preferred_subjects,preferred_level,language' : '');
    const { data } = must(await st.sb.from('push_subscriptions').select(cols).eq('user_id', req.pushUser.id).eq(id.col, id.val).limit(1));
    res.json(data && data[0] ? { subscribed: true, ...data[0] } : { subscribed: false });
  }, { needChannel: false }));

  // Matières et niveaux proposés dans les réglages (tirés des quiz existants)
  let optionsCache = null;
  router.get('/push/options', authUser, run(async (_req, res) => {
    if (!optionsCache || clock() - optionsCache.at > OPTIONS_TTL) {
      const { data } = must(await st.sb.from('quizzes').select('subject').limit(5000));
      const subjects = [...new Set((data || []).map((r) => String(r.subject || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
      optionsCache = { at: clock(), body: { subjects: subjects.slice(0, 100), levels: LEVELS } };
    }
    res.json(optionsCache.body);
  }, { needChannel: false }));

  // Les 10 dernières notifications envoyées (page « Mes notifications »)
  router.get('/push/inbox', authUser, run(async (req, res) => {
    const lang = normLang(req.query.lang);
    const sch = await schema();
    const { data } = must(await st.sb.from('push_messages')
      .select('id,kind,title,body,url,created_at' + (sch.msgs ? ',translations' : ''))
      .order('created_at', { ascending: false }).limit(10));
    res.json({
      notifications: (data || []).map((m) => {
        const tr = m.translations && m.translations[lang];
        return { id: m.id, kind: m.kind, title: (tr && tr.title) || m.title, body: (tr && tr.body) || m.body, url: safeUrl(m.url), created_at: m.created_at };
      })
    });
  }, { needChannel: false }));

  // Suivi des ouvertures de notification
  router.post('/push/click', authUser, validate(pushClickSchema), run(async (req, res) => {
    const sch = await schema();
    if (sch.msgs) must(await st.sb.rpc('increment_push_click', { p_id: req.body.mid }));
    res.json({ ok: true });
  }, { needChannel: false }));

  // ---------- Envoi ----------
  async function listTargets(prefCol) {
    const sch = await schema();
    const cols = 'id,user_id,endpoint,p256dh,auth,fcm_token' + (sch.subs ? ',language,preferred_subjects,preferred_level' : '');
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data } = must(await st.sb.from('push_subscriptions').select(cols).eq(prefCol, true).order('id').range(from, from + 999));
      rows.push(...data);
      if (data.length < 1000) break;
    }
    return rows.filter((r) => (r.fcm_token ? st.fcmOk : (st.webOk && r.endpoint && r.p256dh && r.auth)));
  }

  // L'abonné accepte-t-il cette matière / ce niveau ? (aucune préférence = tout)
  function accepts(row, { subject, level }) {
    const subs = Array.isArray(row.preferred_subjects) ? row.preferred_subjects : [];
    if (subject && subs.length && !subs.some((s) => norm(s) === norm(subject))) return false;
    if (level && row.preferred_level && row.preferred_level !== level) return false;
    return true;
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
          else log.warn({ status: e.statusCode, err: e.message }, 'échec d\'envoi web');
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
          data: { url: String(payload.url || '/'), kind: String(payload.kind || ''), tag: String(payload.tag || ''), mid: String(payload.mid || '') },
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
            else log.warn({ code, err: r.error && r.error.message }, 'échec d\'envoi Android');
          }
        });
      } catch (e) {
        failed += chunk.length;
        log.error({ err: e.message }, 'FCM indisponible');
      }
    }
    await removeDead(dead);
    return { recipients: rows.length, delivered, failed };
  }

  // Regroupe les destinataires par contenu identique (langue, quiz concernés) puis envoie un lot par groupe
  async function sendGrouped(rows, build) {
    const groups = new Map();
    for (const r of rows) {
      const p = build(r);
      if (!p) continue;
      const key = `${p.title}\u0000${p.body}\u0000${p.url}`;
      if (!groups.has(key)) groups.set(key, { payload: p, web: [], android: [] });
      groups.get(key)[r.fcm_token ? 'android' : 'web'].push(r);
    }
    let total = ZERO;
    for (const g of groups.values()) total = add(total, add(await sendWeb(g.web, g.payload), await sendFcm(g.android, g.payload)));
    return total;
  }

  // Journal : la ligne est créée AVANT l'envoi pour pouvoir suivre les clics (mid), puis complétée
  async function openLog(kind, p, createdBy, translations) {
    const sch = await schema();
    const row = { kind, title: p.title, body: p.body, url: p.url, created_by: createdBy || null, ...(sch.msgs && translations ? { translations } : {}) };
    const { data, error } = await st.sb.from('push_messages').insert(row).select('id').single();
    if (error) { log.warn({ err: error.message }, 'journal non enregistré'); return null; }
    return data.id;
  }
  async function closeLog(mid, r) {
    if (!mid) return;
    const { error } = await st.sb.from('push_messages').update({ recipients: r.recipients, delivered: r.delivered, failed: r.failed }).eq('id', mid);
    if (error) log.warn({ err: error.message }, 'journal non complété');
  }

  // ---------- Administrateur (le rôle est vérifié AVANT toute opération en base) ----------
  let lastAdminSend = 0;

  router.post('/admin/push/send', authAdmin, validate(pushSendSchema), run(async (req, res) => {
    const title = clean(req.body.title, MAX_TITLE);
    const body = clean(req.body.body, MAX_BODY);
    if (!title || !body) return res.status(400).json({ error: 'Titre et message obligatoires.' });
    if (clock() - lastAdminSend < ADMIN_COOLDOWN) return res.status(429).json({ error: 'Patiente quelques secondes avant un nouvel envoi.' });
    lastAdminSend = clock();
    const url = safeUrl(req.body.url);
    const target = { subject: clean(req.body.subject, 80) || null, level: req.body.level || null };
    const en = req.body.translations?.en;
    const translations = en && (clean(en.title, MAX_TITLE) || clean(en.body, MAX_BODY))
      ? { en: { title: clean(en.title, MAX_TITLE) || title, body: clean(en.body, MAX_BODY) || body } } : null;
    const mid = await openLog('message', { title, body, url }, req.pushUser.id, translations);
    const tag = `msg-${clock()}`;
    const rows = (await listTargets('notify_messages')).filter((r) => accepts(r, target));
    const result = await sendGrouped(rows, (r) => {
      const tr = translations && normLang(r.language) === 'en' ? translations.en : null;
      return { title: tr ? tr.title : title, body: tr ? tr.body : body, url: track(url, mid), tag, kind: 'message', mid };
    });
    await closeLog(mid, result);
    res.json({ ok: true, ...result });
  }));

  router.get('/admin/push/history', authAdmin, run(async (_req, res) => {
    const sch = await schema();
    const { data: history } = must(await st.sb.from('push_messages')
      .select('id,kind,title,body,url,recipients,delivered,failed,created_at' + (sch.msgs ? ',click_count' : ''))
      .order('created_at', { ascending: false }).limit(20));
    const count = async (platform) => must(await st.sb.from('push_subscriptions').select('id', { count: 'exact', head: true }).eq('platform', platform)).count || 0;
    const web = await count('web');
    const android = await count('android');
    res.json({ subscribers: web + android, web, android, history });
  }, { needChannel: false }));

  // Suppression de l'historique (tout, ou une seule notification)
  router.delete('/admin/push/history', authAdmin, run(async (_req, res) => {
    const { count } = must(await st.sb.from('push_messages').delete({ count: 'exact' }).not('id', 'is', null));
    log.info({ deleted: count }, 'historique des notifications supprimé');
    res.json({ ok: true, deleted: count ?? null });
  }, { needChannel: false }));

  router.delete('/admin/push/history/:id', authAdmin, validate(pushHistoryIdParam, 'params'), run(async (req, res) => {
    must(await st.sb.from('push_messages').delete().eq('id', req.params.id));
    res.json({ ok: true });
  }, { needChannel: false }));

  // Statistiques pour le tableau de bord admin
  async function getStats() {
    await ready;
    if (!st.sb) return { messages: 0, delivered: 0, last7days: 0, clicks: 0, subscribers: 0 };
    const sch = await schema();
    const { data } = must(await st.sb.from('push_messages').select('delivered,created_at' + (sch.msgs ? ',click_count' : '')).limit(10000));
    const since = clock() - 7 * 86400_000;
    const rows = data || [];
    const subs = must(await st.sb.from('push_subscriptions').select('id', { count: 'exact', head: true })).count || 0;
    return {
      messages: rows.length,
      delivered: rows.reduce((a, r) => a + (r.delivered || 0), 0),
      last7days: rows.filter((r) => new Date(r.created_at).getTime() >= since).length,
      clicks: rows.reduce((a, r) => a + (r.click_count || 0), 0),
      subscribers: subs
    };
  }

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
    const first = { title: t('fr', batch.length === 1 ? 'quiz.one.title' : 'quiz.many.title', { n: batch.length }), body: batch.slice(0, 2).map((q) => q.title).join(' · ') + (batch.length > 2 ? '…' : ''), url: '/?tab=library' };
    const mid = await openLog('quiz', first, null, null);
    const rows = await listTargets('notify_quiz');
    const result = await sendGrouped(rows, (r) => {
      const mine = batch.filter((q) => q.by !== r.user_id && accepts(r, q));      // l'auteur n'est pas notifié de son propre quiz
      if (!mine.length) return null;
      const lang = normLang(r.language);
      return {
        title: t(lang, mine.length === 1 ? 'quiz.one.title' : 'quiz.many.title', { n: mine.length }),
        body: mine.slice(0, 2).map((q) => q.title).join(' · ') + (mine.length > 2 ? '…' : ''),
        url: track('/?tab=library', mid), tag: 'new-quiz', kind: 'quiz', mid
      };
    });
    await closeLog(mid, result);
  }

  function notifyNewQuiz(quiz, creatorId) {
    if (!quiz || !quiz.title) return;
    pending.push({ id: quiz.id, title: clean(quiz.title, MAX_TITLE), subject: clean(quiz.subject, 80) || null, level: quiz.level || null, by: creatorId });
    if (timer) return;
    const delay = Math.max(QUIZ_BATCH_DELAY, lastQuizSend + QUIZ_MIN_GAP - clock());
    timer = setTimeout(() => flushQuizzes().catch((e) => log.error({ err: e.message }, 'envoi nouveaux quiz')), delay);
    timer.unref?.();
  }

  return { router, notifyNewQuiz, flushQuizzes, getStats, ready };
}
