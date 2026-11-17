import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import { detectAndParse, finalizeAiResult } from './instruction-detector.js';
import { parseQuizText } from './quiz-parser.js';
import { createPush } from './push.js';
import { logger } from './logger.js';
import {
  validate, createQuizSchema, updateQuizSchema, quizIdParam, userIdParam, quizzesQuerySchema, extrasOf,
  adminCreateUserSchema, adminPasswordSchema, adminStatusSchema, adminRoleSchema, generateSchema, parseExistingSchema,
  adminSettingsSchema
} from './schemas.js';
// ← AI ENGINE : imports
import { createAiRouter } from './routes/ai.routes.js';
import { ai } from './services/ai/index.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.set('trust proxy', (ip) => ip === '127.0.0.1' || ip.startsWith('10.') || ip === '::1'); // 🔒 trust proxy sécurisé
const SITE_URL = (process.env.SITE_URL || 'https://compotestsaas.onrender.com').replace(/\/+$/, '');
app.use(express.json({ limit: '10mb' }));

// ==========================================
// 🔒 SÉCURITÉ : FORCER LE HTTPS EN PRODUCTION
// ==========================================
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https' && req.path !== '/api/health') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

// ==========================================
// JOURNAL DES REQUÊTES
// ==========================================
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const url = req.originalUrl.split('?')[0];
    if (!url.startsWith('/api') && res.statusCode < 500) return;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : (url === '/api/health' ? 'debug' : 'info');
    logger[level]({ method: req.method, path: url, status: res.statusCode, ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6), origin: req.headers.origin || null, ip: req.ip }, 'requête');
  });
  next();
});

// ==========================================
// CORS SÉCURISÉ
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
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, x-client-info, X-Requested-With');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ==========================================
// CONTENT SECURITY POLICY (CSP)
// ==========================================
app.use((req, res, next) => {
  res.header(
    'Content-Security-Policy',
    "default-src 'self'; " +
    // 'wasm-unsafe-eval' : WebAssembly de Tesseract (OCR). Pas de 'unsafe-eval' : aucun eval() dans l'application.
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://compotestsaas.onrender.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; " +          // unpkg : boxicons.min.css
    "font-src 'self' https://fonts.gstatic.com https://unpkg.com data:; " +                          // unpkg : polices boxicons
    "img-src 'self' data: blob: https:; " +
    "media-src 'self' https: blob:; " +
    // jsdelivr + tessdata : worker/core/données de langue de Tesseract et fichiers .map ; blob:/data: : images traitées par l'OCR
    "connect-src 'self' https://drumtgglrtmubdvkpwvl.supabase.co https://compotestsaas.onrender.com https://cdn.jsdelivr.net https://tessdata.projectnaptha.com https://cdnjs.cloudflare.com https://unpkg.com wss: blob: data:; " +
    "worker-src 'self' blob:; " +                                                                    // Tesseract crée son worker depuis un blob
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com; " +
    "frame-ancestors 'self'; " +
    "object-src 'none'; " +
    "base-uri 'self';"
  );
  // En-têtes de sécurité complémentaires
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'SAMEORIGIN');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.header('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=()');
  next();
});

// ==========================================
// RATE LIMITING
// ==========================================
const limiter = (opts) => rateLimit({ windowMs: 60 * 1000, standardHeaders: true, legacyHeaders: false, ...opts });
const tooMany = (what) => ({ error: `Trop de requêtes${what ? ` ${what}` : ''}, réessaie dans quelques instants.` });

const globalApiLimiter = limiter({ max: Number(process.env.API_RATE_PER_MIN || 60), skip: (req) => req.originalUrl.split('?')[0] === '/api/health', message: { error: 'Trop de requêtes, réessaie dans une minute.' } });
const aiLimiter = limiter({ max: 10, message: { error: 'Trop de requêtes IA, réessaie dans une minute.' } });
const generateLimiter = limiter({ max: Number(process.env.AI_RATE_PER_MIN || 5), message: tooMany('IA') });
const generateUserLimiter = limiter({ windowMs: 60 * 60 * 1000, max: Number(process.env.AI_RATE_PER_HOUR || 30), keyGenerator: (req) => req.user?.id || req.ip, message: { error: 'Limite horaire de génération IA atteinte, réessaie plus tard.' } });
const adminUsersLimiter = limiter({ max: 30, keyGenerator: (req) => req.user?.id || req.ip, message: tooMany('(administration)') });
const adminUsersWriteLimiter = limiter({ max: 10, skip: (req) => req.method === 'GET', keyGenerator: (req) => `w:${req.user?.id || req.ip}`, message: tooMany('(administration)') });
const pushSubscribeLimiter = limiter({ max: Number(process.env.PUSH_SUBSCRIBE_LIMIT || 5), message: { error: 'Trop de tentatives d\'activation, réessaie dans une minute.' } });
const quizWriteLimiter = limiter({ max: 10, keyGenerator: (req) => req.user?.id || req.ip, message: { error: 'Trop de modifications de quiz, réessaie dans une minute.' } }); // 🔒 Rate limit écriture quiz
const broadcastLimiter = limiter({ max: 5, windowMs: 60 * 60 * 1000, keyGenerator: (req) => req.user?.id || req.ip, message: { error: 'Trop de notifications envoyées, réessaie dans une heure.' } });

app.use('/api', globalApiLimiter);
app.use('/api/generate-post-test', generateLimiter);
app.use('/api/parse-existing-quiz', aiLimiter);

// ==========================================
// HEALTH CHECK
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
// COMPRESSION (brotli / gzip) + ETag pour les fichiers texte
// ==========================================
// Les fichiers texte (HTML, JS, JSON…) sont compressés une seule fois puis gardés en mémoire (recalculés si le
// fichier change). Le navigateur reçoit ~5x moins d'octets et revalide par ETag (304 sans corps si inchangé).
const COMPRESSIBLE = /\.(html|js|css|json|svg|xml|txt|webmanifest)$/i;
const compressedCache = new Map();
function loadCompressed(filePath) {
  const st = fs.statSync(filePath);
  const cached = compressedCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  const raw = fs.readFileSync(filePath);
  const big = raw.length > 1024;
  const entry = {
    mtimeMs: st.mtimeMs, size: st.size, raw,
    tag: crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 16),
    br: big ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : null,
    gz: big ? zlib.gzipSync(raw, { level: 9 }) : null
  };
  compressedCache.set(filePath, entry);
  return entry;
}
function serveFile(req, res, filePath, headers = {}) {
  const ae = String(req.headers['accept-encoding'] || '');
  const wantsBr = /\bbr\b/.test(ae), wantsGz = /\bgzip\b/.test(ae);
  if (!COMPRESSIBLE.test(filePath) || (!wantsBr && !wantsGz)) return res.sendFile(filePath, { headers });
  let e;
  try { e = loadCompressed(filePath); } catch { return res.sendFile(filePath, { headers }); }
  const enc = wantsBr && e.br ? 'br' : (wantsGz && e.gz ? 'gzip' : null);
  const body = enc === 'br' ? e.br : enc === 'gzip' ? e.gz : e.raw;
  const etag = `W/"${e.tag}${enc ? '-' + enc : ''}"`;
  res.set({ Vary: 'Accept-Encoding', ETag: etag, ...headers });
  if (enc) res.set('Content-Encoding', enc);
  if (!res.get('Content-Type')) res.type(path.extname(filePath));
  const inm = String(req.headers['if-none-match'] || '').split(',').map((v) => v.trim());
  if (res.statusCode === 200 && inm.includes(etag)) return res.status(304).end();
  res.set('Content-Length', String(body.length));
  return req.method === 'HEAD' ? res.end() : res.end(body);
}

// ==========================================
// FICHIERS STATIQUES
// ==========================================
app.get('/sw.js', (req, res) => {
  serveFile(req, res, path.join(__dirname, 'sw.js'), { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/', 'Content-Type': 'application/javascript; charset=utf-8' });
});
app.get('/manifest.json', (req, res) => {
  serveFile(req, res, path.join(__dirname, 'manifest.json'), { 'Cache-Control': 'no-cache', 'Content-Type': 'application/manifest+json; charset=utf-8' });
});

// ==========================================
// 📄 PAGES LÉGALES
// ==========================================
app.get('/confidentialite', (req, res) => serveFile(req, res, path.join(__dirname, 'public', 'confidentialite.html'), { 'Cache-Control': 'public, max-age=3600' }));
app.get('/conditions', (req, res) => serveFile(req, res, path.join(__dirname, 'public', 'conditions.html'), { 'Cache-Control': 'public, max-age=3600' }));

app.use((req, res, next) => {
  if (/^\/(server\.js|package(-lock)?\.json|node_modules\/|generate-icons\.js|optimize-images\.js|services\/|routes\/|migrations\/)/i.test(req.path)) return next(); // jamais servis (liste blanche) : tombe sur la page 404
  next();
});

// Liste blanche : seuls les fichiers nécessaires au navigateur sont servis. Le reste du dossier du projet
// (code serveur, scripts SQL, guides, google-services.json, android/, tests/, …) n'est jamais exposé.
// Un nouveau fichier front (ex. /mon-module.js) doit être ajouté ici ; tout ce qui est dans icons/ et public/ est public.
const PUBLIC_FILES = new Set([
  'index.html', 'config.js', 'sw.js', 'manifest.json', 'offline.html',
  'favicon.png', 'favicon.ico', 'site.png', 'og-image.png', 'Revisio.apk',
  'a11y.js', 'admin-extras.js', 'community-voice.js', 'consent.js', 'dark-mode.js', 'download-android.js',
  'global-search.js', 'html-quiz-parser.js', 'table-quiz.js', 'pdf-export.js', 'progress.js', 'push-client.js', 'question-comments.js',
  'resume-quiz.js', 'ui-extras.js'
]);
const PUBLIC_DIRS = ['icons/', 'public/'];
function isPublicAsset(reqPath) {
  let rel;
  try { rel = decodeURIComponent(reqPath); } catch { return false; }
  if (rel.includes('\0') || rel.includes('\\') || rel.split('/').includes('..')) return false;
  rel = rel.replace(/^\/+/, '');
  return PUBLIC_FILES.has(rel) || PUBLIC_DIRS.some((d) => rel.startsWith(d) && rel.length > d.length);
}
const staticHandler = express.static(__dirname, {
  maxAge: '1d',
  index: false,
  dotfiles: 'ignore',
  setHeaders: (res, filePath) => {
    if (/[\\/](index\.html|config\.js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    else if (/\.(png|jpe?g|webp|ico|svg|woff2?)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800'); // images : 7 jours
  }
});
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && isPublicAsset(req.path) && COMPRESSIBLE.test(req.path)) {
    const file = path.resolve(__dirname, decodeURIComponent(req.path).replace(/^\/+/, ''));
    if (file.startsWith(__dirname + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const base = path.basename(file);
      const cache = base === 'index.html' ? 'no-cache' : base === 'config.js' ? 'no-store' : 'public, max-age=86400';
      return serveFile(req, res, file, { 'Cache-Control': cache });
    }
  }
  next();
});
app.use((req, res, next) => (isPublicAsset(req.path) ? staticHandler(req, res, next) : next()));

const noCacheHeaders = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0'
};
app.get('/', (req, res) => serveFile(req, res, path.join(__dirname, 'index.html'), { 'Cache-Control': 'no-cache' }));
app.get('/index.html', (req, res) => serveFile(req, res, path.join(__dirname, 'index.html'), { 'Cache-Control': 'no-cache' }));
app.get('/favicon.png', (_req, res) => res.sendFile(path.join(__dirname, 'favicon.png')));
app.get('/favicon.ico', (_req, res) => {
  res.sendFile(path.join(__dirname, 'favicon.ico'), (err) => {
    if (err && !res.headersSent) res.type('image/png').sendFile(path.join(__dirname, 'favicon.png')); // favicon.ico absent : on sert le PNG
  });
});
app.get('/config.js', (_req, res) => res.sendFile(path.join(__dirname, 'config.js'), { headers: { 'Cache-Control': 'no-store' } }));

// ==========================================
// SEO : robots.txt + sitemap.xml
// ==========================================
const fileDate = (...p) => { try { return fs.statSync(path.join(__dirname, ...p)).mtime; } catch { return new Date(); } };
app.get('/robots.txt', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600').type('text/plain')
    .send(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (_req, res) => {
  const pages = [
    { loc: '/', date: fileDate('index.html'), priority: '1.0' },
    { loc: '/confidentialite', date: fileDate('public', 'confidentialite.html'), priority: '0.3' },
    { loc: '/conditions', date: fileDate('public', 'conditions.html'), priority: '0.3' }
  ];
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    pages.map((p) => `  <url><loc>${SITE_URL}${p.loc}</loc><lastmod>${p.date.toISOString().slice(0, 10)}</lastmod><priority>${p.priority}</priority></url>`).join('\n') +
    '\n</urlset>\n';
  res.set('Cache-Control', 'public, max-age=3600').type('application/xml').send(xml);
});

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
// MIDDLEWARE AUTH POUR LE RESTE DE /api
// ==========================================
const push = createPush();
app.use('/api/push/subscribe', pushSubscribeLimiter);
app.use('/api', push.router);

// Route admin : toggle reminders
app.post('/api/admin/settings/reminders', async (req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Auth requise.' });
  try {
    const u = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!u.ok) return res.status(401).json({ error: 'Session invalide.' });
    const user = await u.json();
    const adminEmail = String(process.env.ADMIN_EMAIL || '').toLowerCase();
    const isAdmin = user.app_metadata?.is_admin === true || user.app_metadata?.role === 'admin' || (adminEmail && user.email?.toLowerCase() === adminEmail);
    if (!isAdmin) return res.status(403).json({ error: 'Réservé admin.' });
    const enabled = !!req.body.enabled;
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1`, {
      method: 'PATCH',
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminders_enabled: enabled })
    });
    if (!r.ok) throw new Error('Erreur PATCH app_settings');
    res.json({ ok: true, reminders_enabled: enabled });
  } catch (e) { next(e); }
});

app.use('/api', authenticate);
app.use('/api/generate-post-test', generateUserLimiter);
app.use('/api/admin/users', adminUsersLimiter, adminUsersWriteLimiter);

// ==========================================
// ← AI ENGINE : montage du routeur IA
// ==========================================
const aiRouter = createAiRouter({ authenticate, requireAdmin, validate, limiter });
app.use('/api', aiRouter);
logger.info('Révisio AI Engine monté sur /api');

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

app.get('/api/me', authenticate, async (req, res) => {
  try {
    const r = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/admin/users/${req.user.id}`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    if (!r.ok) throw new Error('Utilisateur introuvable.');
    const u = await r.json();
    res.json({
      id: u.id,
      email: u.email,
      name: u.user_metadata?.full_name || u.email.split('@')[0]
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
// ROUTE PUSH BROADCAST SÉCURISÉE
// ==========================================
app.post('/api/push/broadcast', broadcastLimiter, async (req, res) => {
  const { title, body, url } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'Titre et message requis.' });
  if (String(title).length > 80) return res.status(400).json({ error: 'Titre trop long (80 max).' });
  if (String(body).length > 300) return res.status(400).json({ error: 'Message trop long (300 max).' });
  try {
    const sent = await push.broadcast({ title: String(title), body: String(body), url: url || '/' });
    res.json({ ok: true, sent });
  } catch (e) {
    logger.error({ err: e.message }, 'push broadcast');
    res.status(500).json({ error: 'Envoi impossible.' });
  }
});

// ==========================================
// IA — ANCIENNE ROUTE (conservée en fallback)
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

// ==========================================
// ← AI ENGINE : nouvelle route principale de génération
// ==========================================
app.post('/api/generate-post-test', validate(generateSchema), async (req, res) => {
  const { text, count = 50 } = req.body;

  try {
    const result = await ai.generateQuiz(text, { count, userId: req.user?.id });
    if (!result || !Array.isArray(result.questions) || result.questions.length === 0) {
      throw new Error('Le moteur IA n\'a renvoyé aucune question.');
    }
    try { finalizeAiResult(result, text); } catch (err) { logger.warn({ err: err.message }, 'finalizeAiResult ignoré'); }
    logger.info({ provider: result._provider, questions: result.questions.length, cached: !!result._cached }, 'génération IA (moteur)');
    return res.json(result);
  } catch (engineError) {
    logger.warn({ err: engineError.message }, 'moteur IA indisponible, bascule sur l\'ancien client Groq');
  }

  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA non configurée (aucun fournisseur actif).' });
  try {
    const response = await client.chat.completions.create({
      model: modelName(), temperature: 0.4, max_tokens: 8000, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Tu es un expert en création de quiz pédagogiques en FRANÇAIS.

Ta mission est d'analyser le texte fourni par l'utilisateur et de déterminer s'il s'agit :
1. D'UN QUESTIONNAIRE DÉJÀ EXISTANT (il contient des questions numérotées, des choix multiples, des Vrai/Faux, etc.)
2. D'UN COURS RÉDIGÉ (du texte explicatif sans questions explicites)

RÈGLES STRICTES :

**CAS 1 : Si le texte contient DÉJÀ des questions**
- Tu DOIS extraire et conserver TOUTES les questions existantes.
- Conserve leurs options et, si le texte mentionne les réponses, conserve-les.
- Si les réponses ne sont pas mentionnées, mets "correct": 0 par défaut.

**CAS 2 : Si le texte est un COURS RÉDIGÉ**
- Génère ${count} nouvelles questions.

**FORMAT DE SORTIE OBLIGATOIRE (JSON valide) :**
{"questions":[{"type":"mcq","text":"...","options":["A","B","C","D"],"correct":0,"explanation":"..."}]}

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
    logger.info({ provider: 'groq-legacy', questions: parsed.questions?.length }, 'génération IA (fallback Groq)');
    res.json(parsed);
  } catch (e) {
    logger.error({ err: e.message }, 'erreur API IA (fallback aussi en échec)');
    res.status(502).json({ error: e.message });
  }
});

// ==========================================
// ROUTES QUIZ
// ==========================================
const sbHeaders = (extra = {}) => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, ...extra });

app.post('/api/quizzes', quizWriteLimiter, validate(createQuizSchema), async (req, res) => {
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
app.patch('/api/quizzes/:id', quizWriteLimiter, requireAdmin, validate(quizIdParam, 'params'), validate(updateQuizSchema), (req, res) => updateQuiz(req, res, 'PATCH'));
app.put('/api/quizzes/:id', quizWriteLimiter, requireAdmin, validate(quizIdParam, 'params'), validate(updateQuizSchema), (req, res) => updateQuiz(req, res, 'PUT'));

app.delete('/api/quizzes/:id', quizWriteLimiter, requireAdmin, validate(quizIdParam, 'params'), async (req, res) => {
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes?id=eq.${req.params.id}`, { method: 'DELETE', headers: sbHeaders() });
    if (!response.ok) throw new Error('Erreur Supabase DELETE');
    invalidateQuizCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// ERREURS
// ==========================================
app.use('/api', (_req, res) => res.status(404).json({ error: 'Route introuvable.' }));

// 🔒 Filtre pour ne pas exposer la clé service role dans les erreurs
// ==========================================
// 404 : page personnalisée (navigateur) ou JSON (API)
// ==========================================
app.use((req, res) => {
  if (req.path === '/api' || req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route introuvable.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(404).type('text/plain').send('Introuvable');
  res.status(404);
  if (!req.accepts('html')) return res.type('text/plain').send('Introuvable');
  const file = path.join(__dirname, 'public', '404.html');
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
  if (!fs.existsSync(file)) return res.set(headers).type('html').send('<!doctype html><html lang="fr"><meta charset="utf-8"><title>Page introuvable — Révisio</title><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;text-align:center;padding:48px 16px"><h1>404</h1><p>Page introuvable.</p><a href="/">Retour à l\'accueil</a></body></html>');
  return serveFile(req, res, file, headers);
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const msg = String(err?.message || '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (key && msg.includes(key)) {
    logger.error({ path: req.originalUrl.split('?')[0] }, 'erreur contenant la clé service role, réponse filtrée');
    return res.status(500).json({ error: 'Erreur interne.' });
  }
  next(err);
});

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

// Cron : rappel inactif quotidien à 10h GMT
if (process.env.NODE_ENV !== 'test') {
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() === 10) {
      try { await push.sendReminderToInactive(); }
      catch (e) { logger.warn({ err: e.message }, 'rappel inactif'); }
    }
  }, 3600_000).unref();
}
