import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// ← FIX #4 : import express-rate-limit
import rateLimit from 'express-rate-limit';
// Détection des consignes écrites dans les sujets (type de réponse, études de cas, QPQ, temps)
import { detectAndParse, finalizeAiResult } from './instruction-detector.js';
import { parseQuizText } from './quiz-parser.js';   // extracteur v2 (remplace l'ancienne fonction parseQuizText de ce fichier)
import { createPush } from './push.js';
import { logger } from './logger.js';
import {
  validate, createQuizSchema, updateQuizSchema, quizIdParam, userIdParam, quizzesQuerySchema, extrasOf,
  adminCreateUserSchema, adminPasswordSchema, adminStatusSchema, adminRoleSchema, generateSchema, parseExistingSchema,
  adminSettingsSchema
} from './schemas.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.set('trust proxy', 1);   // Render place un proxy devant l'application : sans cela, tous les visiteurs partagent la même « IP » pour les limiteurs
app.use(express.json({ limit: '10mb' }));

// ==========================================
// 🔍 JOURNAL DES REQUÊTES (JSON structuré, une ligne par requête API)
// ==========================================
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const url = req.originalUrl.split('?')[0];
    if (!url.startsWith('/api') && res.statusCode < 500) return;   // pas de ligne pour chaque fichier statique
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : (url === '/api/health' ? 'debug' : 'info');
    logger[level]({ method: req.method, path: url, status: res.statusCode, ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6), origin: req.headers.origin || null, ip: req.ip }, 'requête');
  });
  next();
});

// ==========================================
// ✅ CORS
// ==========================================
const ALLOWED_ORIGINS = [
  'https://compotestsaas.onrender.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'ionic://localhost',
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  } else if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, x-client-info, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ==========================================
// 🛡️ RATE LIMITING
// ==========================================
const limiter = (opts) => rateLimit({ windowMs: 60 * 1000, standardHeaders: true, legacyHeaders: false, ...opts });
const tooMany = (what) => ({ error: `Trop de requêtes${what ? ` ${what}` : ''}, réessaie dans quelques instants.` });

// Limiteur global sur /api/* (sauf /api/health qui doit toujours répondre pour UptimeRobot)
const globalApiLimiter = limiter({ max: Number(process.env.API_RATE_PER_MIN || 60), skip: (req) => req.originalUrl.split('?')[0] === '/api/health', message: { error: 'Trop de requêtes, réessaie dans une minute.' } });
// Extraction de questions (sans IA) : inchangé
const aiLimiter = limiter({ max: 10, message: { error: 'Trop de requêtes IA, réessaie dans une minute.' } });
// Génération par IA (consomme des tokens) : plus strict, par IP puis par utilisateur
const generateLimiter = limiter({ max: Number(process.env.AI_RATE_PER_MIN || 5), message: tooMany('IA') });
const generateUserLimiter = limiter({ windowMs: 60 * 60 * 1000, max: Number(process.env.AI_RATE_PER_HOUR || 30), keyGenerator: (req) => req.user?.id || req.ip, message: { error: 'Limite horaire de génération IA atteinte, réessaie plus tard.' } });
// Comptes (création, mot de passe, bannissement…) : lecture 30/min, écriture 10/min, par administrateur
const adminUsersLimiter = limiter({ max: 30, keyGenerator: (req) => req.user?.id || req.ip, message: tooMany('(administration)') });
const adminUsersWriteLimiter = limiter({ max: 10, skip: (req) => req.method === 'GET', keyGenerator: (req) => `w:${req.user?.id || req.ip}`, message: tooMany('(administration)') });
// Enregistrement d'appareil pour les notifications : 5 par minute et par IP (réglable : PUSH_SUBSCRIBE_LIMIT)
const pushSubscribeLimiter = limiter({ max: Number(process.env.PUSH_SUBSCRIBE_LIMIT || 5), message: { error: 'Trop de tentatives d\'activation, réessaie dans une minute.' } });

app.use('/api', globalApiLimiter);
app.use('/api/generate-post-test', generateLimiter);
app.use('/api/parse-existing-quiz', aiLimiter);

// ==========================================
// 🛡️ ROUTE HEALTH CHECK (pour UptimeRobot)
// ==========================================
app.get('/api/health', (req, res) => {
  const now = new Date();
  const hourUTC = now.getUTCHours();
  const isSleeping = hourUTC >= 0 && hourUTC < 4;
  if (isSleeping) {
    logger.debug({ hourUTC }, 'health check ignoré (veille programmée)');
    return res.status(503).send('Service en veille programmée (00h-04h GMT)');
  }
  res.status(200).send('OK');
});

// ==========================================
// FICHIERS STATIQUES
// ==========================================
app.get('/sw.js', (_req, res) => {
  res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
  res.type('application/javascript').sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/manifest.json', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'manifest.json'));
});

app.use((req, res, next) => {
  if (/^\/(server\.js|package(-lock)?\.json|node_modules\/|generate-icons\.js|optimize-images\.js)/i.test(req.path)) return res.sendStatus(404);
  next();
});

app.use(express.static(__dirname, {
  maxAge: '1d',
  index: false,
  setHeaders: (res, filePath) => {
    if (/[\\/](index\.html|config\.js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

const noCacheHeaders = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0'
};
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html'), { headers: noCacheHeaders }));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html'), { headers: noCacheHeaders }));
app.get('/favicon.png', (_req, res) => res.sendFile(path.join(__dirname, 'favicon.png')));
app.get('/config.js', (_req, res) => res.sendFile(path.join(__dirname, 'config.js'), { headers: { 'Cache-Control': 'no-store' } }));

// ==========================================
// AUTHENTIFICATION
// ==========================================
async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Connecte-toi.' });
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) throw new Error("Variables Supabase manquantes.");
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return res.status(401).json({ error: 'Session expirée.' });
    const user = await response.json();
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const isAdmin = user.app_metadata?.is_admin === true || user.app_metadata?.role === 'admin' || Boolean(adminEmail && user.email?.toLowerCase() === adminEmail);
    req.user = { id: user.id, email: user.email, isAdmin };
    next();
  } catch (e) {
    logger.error({ err: e.message }, 'erreur de vérification du jeton');
    return res.status(503).json({ error: 'Vérification indisponible.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Réservé administrateur.' });
  next();
}

// ==========================================
// ROUTES PUBLIQUES (SANS AUTHENTIFICATION)
// ==========================================
const QUIZ_CACHE_TTL = 5 * 60 * 1000;
const quizCache = new Map();
const invalidateQuizCache = () => quizCache.clear();

async function fetchQuizzes({ page, limit }) {
  const key = limit ? `${page}:${limit}` : 'all';
  const hit = quizCache.get(key);
  if (hit && Date.now() - hit.at < QUIZ_CACHE_TTL) return hit.body;
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const paginated = Boolean(limit);
  const qs = 'select=*&order=created_at.desc' + (paginated ? `&limit=${limit}&offset=${(page - 1) * limit}` : '');
  const response = await fetch(`${base}/rest/v1/quizzes?${qs}`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...(paginated ? { Prefer: 'count=exact' } : {})
    }
  });
  if (!response.ok) throw new Error('Erreur Supabase GET');
  const data = await response.json();
  let body = { quizzes: data };
  if (paginated) {
    const total = Number((response.headers.get('content-range') || '').split('/')[1]);
    const t = Number.isFinite(total) ? total : (page - 1) * limit + data.length;
    body = { quizzes: data, page, limit, total: t, hasMore: page * limit < t };
  }
  quizCache.set(key, { at: Date.now(), body });
  if (quizCache.size > 200) quizCache.delete(quizCache.keys().next().value);
  return body;
}

app.get('/api/quizzes', validate(quizzesQuerySchema, 'query', 'Paramètres de pagination invalides (page ≥ 1, limit de 1 à 100).'), async (req, res) => {
  try {
    const { page, limit } = req.query;
    const paginated = page !== undefined || limit !== undefined;
    const body = await fetchQuizzes(paginated ? { page: page || 1, limit: limit || 20 } : {});
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    res.json(body);
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/quizzes');
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// RÉGLAGE GLOBAL DES NOTIFICATIONS (PUBLIC EN LECTURE)
// ==========================================
// Lisible sans authentification : push-client.js et index.html doivent savoir si les
// notifications sont activées pour tous (l'admin bascule via /api/admin/settings/notifications).
// Si la table app_settings n'existe pas encore, on renvoie false (dégradation douce).
app.get('/api/settings', async (_req, res) => {
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const r = await fetch(`${base}/rest/v1/app_settings?select=notifications_enabled&id=eq.1`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }
    });
    if (!r.ok) throw new Error('Erreur Supabase GET app_settings');
    const rows = await r.json();
    res.set('Cache-Control', 'no-store');
    res.json({ notifications_enabled: !!(rows[0] && rows[0].notifications_enabled) });
  } catch (e) {
    logger.warn({ err: e.message }, 'GET /api/settings');
    res.json({ notifications_enabled: false });
  }
});

// ==========================================
// MIDDLEWARE D'AUTHENTIFICATION POUR LE RESTE DE /api
// ==========================================
const push = createPush();
app.use('/api/push/subscribe', pushSubscribeLimiter);
app.use('/api', push.router);

app.use('/api', authenticate);
app.use('/api/generate-post-test', generateUserLimiter);
app.use('/api/admin/users', adminUsersLimiter, adminUsersWriteLimiter);

// ==========================================
// ROUTES ADMIN
// ==========================================
async function supabaseAdmin(pathname, options = {}) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY manquante.");
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const response = await fetch(`${base}/auth/v1/admin/${pathname}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.msg || body.message || 'Erreur Supabase Admin');
  return body;
}

app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  try {
    const data = await supabaseAdmin('users?page=1&per_page=1000');
    const users = (data.users || []).map(u => ({
      id: u.id, email: u.email, created_at: u.created_at,
      banned: u.banned_until && new Date(u.banned_until) > new Date(),
      name: u.user_metadata?.full_name || u.email.split('@')[0],
      isAdmin: u.app_metadata?.is_admin === true || u.app_metadata?.role === 'admin'
    }));
    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users', requireAdmin, validate(adminCreateUserSchema), async (req, res) => {
  const { firstName, lastName, password, niveau } = req.body;
  let email = req.body.email;
  if (!email) {
    const slug = `${firstName}.${lastName}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9.]/g, '');
    email = `${slug}@comptest.local`;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email invalide.' });
  try {
    const user = await supabaseAdmin('users', {
      method: 'POST',
      body: JSON.stringify({
        email, password, email_confirm: true,
        app_metadata: { compotest_access: true },
        user_metadata: { full_name: `${firstName} ${lastName}`, niveau }
      })
    });
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:id/password', requireAdmin, validate(userIdParam, 'params'), validate(adminPasswordSchema), async (req, res) => {
  try {
    await supabaseAdmin(`users/${req.params.id}`, { method: 'PUT', body: JSON.stringify({ password: req.body.password }) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:id/status', requireAdmin, validate(userIdParam, 'params'), validate(adminStatusSchema), async (req, res) => {
  try {
    await supabaseAdmin(`users/${req.params.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ban_duration: req.body.banned ? '876000h' : 'none' })
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:id/role', requireAdmin, validate(userIdParam, 'params'), validate(adminRoleSchema), async (req, res) => {
  try {
    const isAdmin = req.body.is_admin;
    const current = await supabaseAdmin(`users/${req.params.id}`);
    const app_metadata = { ...(current.app_metadata || {}), is_admin: isAdmin };
    await supabaseAdmin(`users/${req.params.id}`, { method: 'PUT', body: JSON.stringify({ app_metadata }) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', requireAdmin, validate(userIdParam, 'params'), async (req, res) => {
  try {
    await supabaseAdmin(`users/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function restCount(query) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const response = await fetch(`${base}/rest/v1/${query}`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, Prefer: 'count=exact' }
  });
  if (!response.ok) throw new Error('Erreur Supabase (comptage)');
  return Number((response.headers.get('content-range') || '').split('/')[1]) || 0;
}
let statsCache = null;
app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  try {
    if (!statsCache || Date.now() - statsCache.at > 60_000) {
      let total = 0, banned = 0;
      for (let page = 1; page <= 20; page++) {
        const data = await supabaseAdmin(`users?page=${page}&per_page=1000`);
        const list = data.users || [];
        total += list.length;
        banned += list.filter(u => u.banned_until && new Date(u.banned_until) > new Date()).length;
        if (list.length < 1000) break;
      }
      const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
      const [quizTotal, quizWeek] = await Promise.all([
        restCount('quizzes?select=id&limit=1'),
        restCount(`quizzes?select=id&limit=1&created_at=gte.${encodeURIComponent(weekAgo)}`)
      ]);
      const notifications = await push.getStats().catch((e) => { logger.warn({ err: e.message }, 'statistiques notifications indisponibles'); return { messages: 0, delivered: 0, last7days: 0, clicks: 0, subscribers: 0 }; });
      statsCache = { at: Date.now(), body: { users: { total, banned }, quizzes: { total: quizTotal, thisWeek: quizWeek }, notifications, generatedAt: new Date().toISOString() } };
    }
    res.json(statsCache.body);
  } catch (e) { logger.error({ err: e.message }, 'GET /api/admin/stats'); res.status(500).json({ error: e.message }); }
});

// Bascule du réglage global des notifications (admin uniquement)
app.post('/api/admin/settings/notifications', requireAdmin, validate(adminSettingsSchema), async (req, res) => {
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const r = await fetch(`${base}/rest/v1/app_settings?id=eq.1`, {
      method: 'PATCH',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({ notifications_enabled: req.body.enabled, updated_at: new Date().toISOString() })
    });
    if (!r.ok) throw new Error('Erreur Supabase PATCH app_settings');
    push.invalidateSettings?.();
    statsCache = null;
    res.json({ notifications_enabled: req.body.enabled });
  } catch (e) {
    logger.error({ err: e.message }, 'POST /api/admin/settings/notifications');
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// IA
// ==========================================
function aiClient() {
  if (!process.env.AI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.AI_API_KEY, baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1', timeout: 120000 });
}
const modelName = () => process.env.AI_MODEL || 'openai/gpt-oss-20b';

// ==========================================
// EXTRACTION
// ==========================================
app.post('/api/parse-existing-quiz', validate(parseExistingSchema), (req, res) => {
  try {
    const text = req.body?.text || '';
    let result;
    try {
      result = detectAndParse(text, parseQuizText);
    } catch (err) {
      logger.warn({ err: err.message }, 'détection des consignes ignorée');
      result = { questions: parseQuizText(text) };
    }
    const { questions, ...meta } = result;
    res.json({ questions: questions.length ? questions : [], ...meta, message: questions.length ? undefined : 'Aucune question reconnue.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-post-test', validate(generateSchema), async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA non configurée.' });
  const { text, count = 50 } = req.body;
  try {
    const response = await client.chat.completions.create({
      model: modelName(), temperature: 0.4, max_tokens: 8000, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Tu es un expert en création de quiz pédagogiques en FRANÇAIS.

Ta mission est d'analyser le texte fourni par l'utilisateur et de déterminer s'il s'agit :
1. D'UN QUESTIONNAIRE DÉJÀ EXISTANT (il contient des questions numérotées, des choix multiples, des Vrai/Faux, etc.)
2. D'UN COURS RÉDIGÉ (du texte explicatif sans questions explicites)

RÈGLES STRICTES :

**CAS 1 : Si le texte contient DÉJÀ des questions (ex: "1. Quelle est...", "Q1 :", "Vrai ou Faux", "a) ... b) ...")**
- Tu DOIS extraire et conserver TOUTES les questions existantes.
- Conserve leurs options (A, B, C, D...) et, si le texte mentionne les réponses (soulignées, en gras, avec "Réponse:", etc.), conserve-les.
- Si les réponses ne sont pas mentionnées, mets "correct": 0 par défaut (l'admin pourra les corriger).
- Tu peux ajouter quelques questions supplémentaires de compréhension UNIQUEMENT si le texte contient aussi des passages de cours explicatifs.
- Les questions d'origine doivent être présentes à 100%.
- CONSIGNES DU SUJET : si le sujet précise le nombre de réponses attendues (ex : "QCM à réponse unique", "QCU", "QRU", "une seule réponse", "QCD" (Vrai/Faux ou A/B), "2 réponses maximum", "QRM", "QCM à réponses multiples", "une ou plusieurs réponses", "cochez la ou les bonnes réponses", "3 réponses au maximum"...), ajoute à chaque question concernée "max_select" (entier : 1 = réponse unique ou QCD (choix dichotomique Vrai/Faux ou A/B : 2 options, 1 réponse), n = n réponses maximum ; pour "plusieurs réponses" sans nombre, mets le nombre d'options). Une consigne s'applique aux questions qui suivent jusqu'à la prochaine consigne. SANS consigne dans le texte, n'ajoute PAS "max_select".
- ÉTUDES DE CAS : si le sujet contient des cas ou dossiers (ex : "Étude de cas", "Cas clinique", "Dossier", "Dossier progressif", "Situation clinique", "Observation", "Les questions 4 à 6 se rapportent à ce cas"...), ne recopie PAS l'énoncé dans chaque question : ajoute à la racine un tableau "blocks":[{"id":"b1","title":"Étude de cas 1","case_block":"énoncé complet recopié tel quel"}] et mets "block_id":"b1" sur chaque question qui s'y rapporte. SANS cas dans le texte, n'ajoute ni "blocks" ni "block_id".
- MODE ET TEMPS : si le sujet indique un fonctionnement question par question (ex : "pas de retour en arrière", "dossier progressif", "une question à la fois"), ajoute "display_mode":"QPQ" ; s'il indique un temps par question, ajoute "seconds_per_question" (en secondes).

**CAS 2 : Si le texte est un COURS RÉDIGÉ (sans questions)**
- Génère ${count} nouvelles questions en respectant cette répartition :
  * ~50% "mcq" (choix unique, "correct" = ENTIER)
  * ~20% "mcq_multi" (plusieurs bonnes réponses, "correct" = TABLEAU d'entiers)
  * ~20% "tf" (Vrai/Faux, "options" = ["Vrai", "Faux"], "correct" = 0 ou 1)
  * ~10% "short" (réponse courte, "correct" = CHAÎNE, pas d'options)
- Fournis TOUJOURS une "explanation" courte.

**FORMAT DE SORTIE OBLIGATOIRE (JSON valide) :**
{"questions":[{"type":"mcq","text":"...","options":["A","B","C","D"],"correct":0,"explanation":"..."}]}
(Champs optionnels, uniquement s'ils sont justifiés par le texte : "max_select" et "block_id" dans une question ; "blocks", "display_mode", "seconds_per_question" à la racine.)

Analyse d'abord silencieusement le texte, puis renvoie UNIQUEMENT le JSON.` },
        { role: 'user', content: String(text || '').slice(0, 15000) }
      ]
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    if (parsed.questions && Array.isArray(parsed.questions)) {
      parsed.questions = parsed.questions.map(q => {
        if (!q.type) q.type = 'mcq';
        if (q.type === 'tf' && (!q.options || q.options.length !== 2)) q.options = ['Vrai', 'Faux'];
        if (q.type === 'mcq_multi' && !Array.isArray(q.correct)) q.correct = [q.correct].filter(x => x !== undefined);
        if (q.type === 'short' && !q.explanation) q.explanation = '';
        return q;
      });
      try { finalizeAiResult(parsed, text); } catch (err) { logger.warn({ err: err.message }, 'finalizeAiResult ignoré'); }
    }
    res.json(parsed);
  } catch (e) {
    logger.error({ err: e.message }, 'erreur API IA');
    res.status(502).json({ error: e.message });
  }
});

// ==========================================
// ROUTES QUIZ (CRÉATION, MODIFICATION, SUPPRESSION)
// ==========================================
const sbHeaders = (extra = {}) => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, ...extra });

app.post('/api/quizzes', validate(createQuizSchema), async (req, res) => {
  const { title, subject, level, questions } = req.body;
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes`, {
      method: 'POST',
      headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: JSON.stringify({
        title: String(title).slice(0, 200),
        subject: String(subject || 'Général').slice(0, 200),
        level: level || null,
        questions,
        ...extrasOf(req.body),
        created_by: req.user.id
      })
    });
    if (!response.ok) { const err = await response.text(); throw new Error(`Erreur Supabase POST: ${err}`); }
    const data = await response.json();
    invalidateQuizCache();
    push.notifyNewQuiz(data[0], req.user.id);
    res.json({ quiz: data[0] });
  } catch (e) { logger.error({ err: e.message }, 'POST /api/quizzes'); res.status(500).json({ error: e.message }); }
});

async function updateQuiz(req, res, label) {
  const { questions, level } = req.body;
  const updates = {};
  if (questions !== undefined) updates.questions = questions;
  if (level !== undefined) updates.level = level;
  Object.assign(updates, extrasOf(req.body));
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes?id=eq.${req.params.id}`, {
      method: 'PATCH',
      headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: JSON.stringify(updates)
    });
    if (!response.ok) { const err = await response.text(); throw new Error(`Erreur Supabase PATCH: ${err}`); }
    const data = await response.json();
    invalidateQuizCache();
    res.json({ quiz: data[0] });
  } catch (e) { logger.error({ err: e.message }, `${label} /api/quizzes/:id`); res.status(500).json({ error: e.message }); }
}
app.patch('/api/quizzes/:id', requireAdmin, validate(quizIdParam, 'params'), validate(updateQuizSchema), (req, res) => updateQuiz(req, res, 'PATCH'));
app.put('/api/quizzes/:id', requireAdmin, validate(quizIdParam, 'params'), validate(updateQuizSchema), (req, res) => updateQuiz(req, res, 'PUT'));

app.delete('/api/quizzes/:id', requireAdmin, validate(quizIdParam, 'params'), async (req, res) => {
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes?id=eq.${req.params.id}`, { method: 'DELETE', headers: sbHeaders() });
    if (!response.ok) throw new Error('Erreur Supabase DELETE');
    invalidateQuizCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 🧯 ERREURS
// ==========================================
app.use('/api', (_req, res) => res.status(404).json({ error: 'Route introuvable.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse.' });
  const status = Number(err && err.status);
  if (status >= 400 && status < 500) return res.status(status).json({ error: 'Requête invalide.' });
  logger.error({ err: { message: err && err.message, stack: err && err.stack }, method: req.method, path: req.originalUrl.split('?')[0] }, 'erreur non gérée');
  res.status(500).json({ error: 'Une erreur interne est survenue' });
});

if (process.env.NODE_ENV !== 'test') {
  process.on('unhandledRejection', (reason) => logger.error({ err: reason && reason.message ? reason.message : String(reason) }, 'promesse rejetée non gérée'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'exception non interceptée');
    setTimeout(() => process.exit(1), 500).unref();
  });
}

export { app, push };

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, '0.0.0.0', () => {
    logger.info({ port, env: process.env.NODE_ENV || 'development' }, 'Serveur démarré');
  });
}
