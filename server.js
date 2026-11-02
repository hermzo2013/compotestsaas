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

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

// ==========================================
// 🔍 LOG DE TOUTES LES REQUÊTES
// ==========================================
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} | Origin: ${req.headers.origin || 'no origin'}`);
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
// 🛡️ FIX #4 : RATE LIMITING
// ==========================================
// Limiteur global sur /api/* (sauf /api/health qui doit toujours répondre pour UptimeRobot)
const globalApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 requêtes par IP par minute
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/health', // ← exclut /api/health
  message: { error: 'Trop de requêtes, réessaie dans une minute.' }
});

// Limiteur strict sur les routes IA (consomme des tokens Groq)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,             // 10 requêtes IA par IP par minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes IA, réessaie dans une minute.' }
});

// Application des limiteurs (ordre : global, puis strict pour les routes IA)
app.use('/api', globalApiLimiter);
app.use('/api/generate-post-test', aiLimiter);
app.use('/api/parse-existing-quiz', aiLimiter);

// ==========================================
// 🛡️ ROUTE HEALTH CHECK (pour UptimeRobot)
// ==========================================
// ⏰ FIX #5 : Documentation UptimeRobot / cron-job.org :
//   - URL à pinger : GET https://compotestsaas.onrender.com/api/health
//   - Intervalle : toutes les 14 minutes
//   - Fenêtre active : 04h00 → 23h59 GMT (le serveur est en veille 00h-04h)
//   - Timeout : 30 s
//   - Alertes si statut ≠ 200
app.get('/api/health', (req, res) => {
  const now = new Date();
  const hourUTC = now.getUTCHours();
  const isSleeping = hourUTC >= 0 && hourUTC < 4;
  if (isSleeping) {
    console.log(`[${new Date().toISOString()}] 😴 Health check ignoré (veille programmée, ${hourUTC}h UTC)`);
    return res.status(503).send('Service en veille programmée (00h-04h GMT)');
  }
  console.log(`[${new Date().toISOString()}] ✅ Health check OK (${hourUTC}h UTC)`);
  res.status(200).send('OK');
});

// ==========================================
// FICHIERS STATIQUES
// ==========================================
// ==========================================
// PWA : service worker et manifeste (en-têtes dédiés)
// ==========================================
// Le service worker ne doit jamais être mis en cache longtemps, sinon une mise à jour de l'app n'arrive pas.
app.get('/sw.js', (_req, res) => {
  res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
  res.type('application/javascript').sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/manifest.json', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'manifest.json'));
});

// Sécurité : express.static(__dirname) publie tout le dossier. On bloque au moins le code serveur et les scripts de build.
app.use((req, res, next) => {
  if (/^\/(server\.js|package(-lock)?\.json|node_modules\/|generate-icons\.js|optimize-images\.js)/i.test(req.path)) return res.sendStatus(404);
  next();
});

// index:false -> '/' est servi par la route plus bas (sans cache). setHeaders -> index.html et config.js ne sont jamais mis en cache
// (avant, express.static répondait en premier avec 1 jour de cache et les routes « no-cache » ci-dessous n'étaient jamais atteintes).
app.use(express.static(__dirname, {
  maxAge: '1d',
  index: false,
  setHeaders: (res, filePath) => {
    if (/[\\/](index\.html|config\.js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// ← FIX #3 : Cache-Control no-cache sur index.html (force le rechargement après déploiement)
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
    console.error('Auth error:', e);
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
app.get('/api/quizzes', async (req, res) => {
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes?select=*&order=created_at.desc`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }
    });
    if (!response.ok) throw new Error('Erreur Supabase GET');
    const data = await response.json();
    res.json({ quizzes: data });
  } catch (e) {
    console.error('Erreur GET quizzes:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// MIDDLEWARE D'AUTHENTIFICATION POUR LE RESTE DE /api
// ==========================================
app.use('/api', authenticate);

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
    const data = await supabaseAdmin('users?page=1&per_page=100');
    const users = (data.users || []).map(u => ({
      id: u.id, email: u.email, created_at: u.created_at,
      banned: u.banned_until && new Date(u.banned_until) > new Date(),
      name: u.user_metadata?.full_name || u.email.split('@')[0],
      isAdmin: u.app_metadata?.is_admin === true || u.app_metadata?.role === 'admin'
    }));
    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const firstName = String(req.body?.firstName || '').trim();
  const lastName = String(req.body?.lastName || '').trim();
  let email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const niveau = String(req.body?.niveau || '').trim();
  if (!firstName || !lastName) return res.status(400).json({ error: 'Nom et prénom requis.' });
  if (!email) {
    const slug = `${firstName}.${lastName}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9.]/g, '');
    email = `${slug}@comptest.local`;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email invalide.' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 min).' });
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

app.patch('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  try {
    const pwd = String(req.body?.password || '');
    if (pwd.length < 6) return res.status(400).json({ error: 'Mot de passe trop court.' });
    await supabaseAdmin(`users/${req.params.id}`, { method: 'PUT', body: JSON.stringify({ password: pwd }) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
  try {
    await supabaseAdmin(`users/${req.params.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ban_duration: req.body.banned ? '876000h' : 'none' })
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
  try {
    const isAdmin = req.body.is_admin === true;
    const current = await supabaseAdmin(`users/${req.params.id}`);
    const app_metadata = { ...(current.app_metadata || {}), is_admin: isAdmin };
    await supabaseAdmin(`users/${req.params.id}`, { method: 'PUT', body: JSON.stringify({ app_metadata }) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    await supabaseAdmin(`users/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
// (l'ancienne fonction parseQuizText a été remplacée par quiz-parser.js)

app.post('/api/parse-existing-quiz', (req, res) => {
  try {
    const text = req.body?.text || '';
    let result;
    try {
      result = detectAndParse(text, parseQuizText);
    } catch (err) {
      // La détection des consignes ne doit JAMAIS empêcher l'import : retour à l'extraction d'origine
      console.error('Détection des consignes ignorée :', err.message);
      result = { questions: parseQuizText(text) };
    }
    const { questions, ...meta } = result;
    res.json({ questions: questions.length ? questions : [], ...meta, message: questions.length ? undefined : 'Aucune question reconnue.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-post-test', async (req, res) => {
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
      // Validation des consignes / blocs fournis par l'IA + complément déterministe (sans jamais bloquer la génération)
      try { finalizeAiResult(parsed, text); } catch (err) { console.error('finalizeAiResult ignoré :', err.message); }
    }
    res.json(parsed);
  } catch (e) {
    console.error('Erreur API IA :', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ==========================================
// ROUTES QUIZ (CRÉATION, MODIFICATION, SUPPRESSION)
// ==========================================
// Champs optionnels des modes NORMAL / QPQ (colonnes ajoutées par quiz_qpq_schema.sql).
// Ils ne sont transmis à Supabase QUE s'ils sont fournis : tant que le client ne les envoie pas, rien ne change.
function pickQuizExtras(body) {
  const out = {};
  const { display_mode, blocks, seconds_per_question } = body || {};
  if (display_mode !== undefined) {
    if (!['NORMAL', 'QPQ'].includes(display_mode)) return { error: 'display_mode invalide (NORMAL ou QPQ).' };
    out.display_mode = display_mode;
  }
  if (blocks !== undefined) {
    if (!Array.isArray(blocks) || blocks.length > 100) return { error: 'blocks doit être un tableau (100 max).' };
    out.blocks = blocks.map(b => ({
      id: String(b && b.id),
      title: String((b && b.title) || '').slice(0, 160),
      case_block: b && b.case_block ? String(b.case_block).slice(0, 8000) : null
    }));
  }
  if (body && body.time_limit_seconds !== undefined) {
    const n = Number(body.time_limit_seconds);
    if (!Number.isInteger(n) || n < 60 || n > 28800) return { error: 'time_limit_seconds doit être un entier entre 60 et 28800.' };
    out.time_limit_seconds = n;
  }
  if (body && body.scoring !== undefined) {
    const sc = body.scoring;
    if (sc !== null && (typeof sc !== 'object' || Array.isArray(sc))) return { error: 'scoring doit être un objet.' };
    if (sc) {
      const clean = {};
      for (const k of ['correct', 'wrong', 'blank']) if (sc[k] !== undefined) { const v = Number(sc[k]); if (!Number.isFinite(v) || Math.abs(v) > 100) return { error: `scoring.${k} invalide.` }; clean[k] = v; }
      out.scoring = clean;
    } else out.scoring = null;
  }
  if (seconds_per_question !== undefined) {
    const n = Number(seconds_per_question);
    if (!Number.isInteger(n) || n < 10 || n > 900) return { error: 'seconds_per_question doit être un entier entre 10 et 900.' };
    out.seconds_per_question = n;
  }
  return { extras: out };
}

app.post('/api/quizzes', async (req, res) => {
  const { title, subject, level, questions } = req.body;
  if (!title || !questions || !Array.isArray(questions) || questions.length === 0) return res.status(400).json({ error: 'Titre et questions requis.' });
  const ex = pickQuizExtras(req.body);
  if (ex.error) return res.status(400).json({ error: ex.error });
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes`, {
      method: 'POST',
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({
        title: String(title).slice(0, 200),
        subject: String(subject || 'Général').slice(0, 200),
        level: level || null,
        questions,
        ...ex.extras,
        created_by: req.user.id
      })
    });
    if (!response.ok) { const err = await response.text(); throw new Error(`Erreur Supabase POST: ${err}`); }
    const data = await response.json(); res.json({ quiz: data[0] });
  } catch (e) { console.error('Erreur POST quizzes:', e.message); res.status(500).json({ error: e.message }); }
});

app.patch('/api/quizzes/:id', requireAdmin, async (req, res) => {
  const { questions, level } = req.body;
  const updates = {};
  if (questions !== undefined) {
    if (!Array.isArray(questions) || questions.length === 0) return res.status(400).json({ error: 'Tableau de questions requis.' });
    updates.questions = questions;
  }
  if (level !== undefined) {
    const validLevels = ['LICENCE 1', 'LICENCE 2', 'LICENCE 3'];
    if (!validLevels.includes(level)) return res.status(400).json({ error: 'Niveau invalide.' });
    updates.level = level;
  }
  const ex = pickQuizExtras(req.body);
  if (ex.error) return res.status(400).json({ error: ex.error });
  Object.assign(updates, ex.extras);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Aucune modification fournie.' });
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes?id=eq.${req.params.id}`, {
      method: 'PATCH',
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(updates)
    });
    if (!response.ok) { const err = await response.text(); throw new Error(`Erreur Supabase PATCH: ${err}`); }
    const data = await response.json(); res.json({ quiz: data[0] });
  } catch (e) { console.error('Erreur PATCH quizzes:', e.message); res.status(500).json({ error: e.message }); }
});

app.put('/api/quizzes/:id', requireAdmin, async (req, res) => {
  const { questions, level } = req.body;
  const updates = {};
  if (questions !== undefined) {
    if (!Array.isArray(questions) || questions.length === 0) return res.status(400).json({ error: 'Tableau de questions requis.' });
    updates.questions = questions;
  }
  if (level !== undefined) {
    const validLevels = ['LICENCE 1', 'LICENCE 2', 'LICENCE 3'];
    if (!validLevels.includes(level)) return res.status(400).json({ error: 'Niveau invalide.' });
    updates.level = level;
  }
  const ex = pickQuizExtras(req.body);
  if (ex.error) return res.status(400).json({ error: ex.error });
  Object.assign(updates, ex.extras);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Aucune modification fournie.' });
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes?id=eq.${req.params.id}`, {
      method: 'PATCH',
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(updates)
    });
    if (!response.ok) { const err = await response.text(); throw new Error(`Erreur Supabase PATCH: ${err}`); }
    const data = await response.json(); res.json({ quiz: data[0] });
  } catch (e) { console.error('Erreur PUT quizzes:', e.message); res.status(500).json({ error: e.message }); }
});

app.delete('/api/quizzes/:id', requireAdmin, async (req, res) => {
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes?id=eq.${req.params.id}`, {
      method: 'DELETE',
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }
    });
    if (!response.ok) throw new Error('Erreur Supabase DELETE');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 🚀 DÉMARRAGE
// ==========================================
app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Serveur démarré sur le port ${port}`);
  console.log(`🌐 Environnement: ${process.env.NODE_ENV || 'development'}`);
});
