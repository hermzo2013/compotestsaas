import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/config.js', (_req, res) => res.sendFile(path.join(__dirname, 'config.js'), { headers: { 'Cache-Control': 'no-store' } }));
app.get('/favicon.png', (_req, res) => res.sendFile(path.join(__dirname, 'favicon.png')));
app.get('/favicon.ico', (_req, res) => res.sendFile(path.join(__dirname, 'favicon.png')));
app.get('/site.jpg', (_req, res) => res.sendFile(path.join(__dirname, 'site.jpg')));
app.get('/site.png', (_req, res) => res.sendFile(path.join(__dirname, 'site.jpg')));
app.get('/logo.jpg', (_req, res) => res.sendFile(path.join(__dirname, 'site.jpg')));
app.get('/api/health', (_req, res) => res.json({ ok: true, aiConfigured: Boolean(process.env.AI_API_KEY), authConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY), adminConfigured: Boolean(process.env.ADMIN_EMAIL && process.env.SUPABASE_SERVICE_ROLE_KEY) }));

async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Connecte-toi à CompoTest.' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return res.status(503).json({ error: 'Supabase non configuré.' });
  try {
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return res.status(401).json({ error: 'Session expirée.' });
    const user = await response.json();
    if (!user?.id || !user?.email) return res.status(401).json({ error: 'Session invalide.' });
    const email = String(user.email).toLowerCase();
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const allowedEmails = (process.env.ALLOWED_USER_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const hasAppAccess = user.app_metadata?.compotest_access === true;
    if (email !== adminEmail && !allowedEmails.includes(email) && !hasAppAccess) return res.status(403).json({ error: 'Compte non autorisé.' });
    req.user = { id: user.id, email: user.email, isAdmin: Boolean(adminEmail && email === adminEmail) };
    next();
  } catch { return res.status(503).json({ error: 'Vérification indisponible.' }); }
}
app.use('/api', (req, res, next) => req.path === '/health' ? next() : authenticate(req, res, next));

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Réservé administrateur.' });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'Clé admin manquante.' });
  next();
}
async function supabaseAdmin(pathname, options = {}) {
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
  if (!response.ok) {
    const err = new Error(body.msg || body.message || body.error_description || body.error || `Supabase Admin (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return body;
}
app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  try {
    const data = await supabaseAdmin('users?page=1&per_page=100');
    const users = (data.users || []).map(u => ({
      id: u.id, email: u.email || '', created_at: u.created_at || null,
      last_sign_in_at: u.last_sign_in_at || null, email_confirmed_at: u.email_confirmed_at || null,
      banned_until: u.banned_until || null, is_admin: String(u.email || '').toLowerCase() === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()
    }));
    res.json({ users });
  } catch (error) { console.error(error.message); res.status(error.status || 502).json({ error: 'Impossible de charger les comptes.' }); }
});
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Adresse invalide.' });
  if (email === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()) return res.status(400).json({ error: 'Réservé admin.' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 min).' });
  try {
    const user = await supabaseAdmin('users', { method: 'POST', body: JSON.stringify({
      email, password, email_confirm: true,
      app_metadata: { compotest_access: true, role: 'user' },
      user_metadata: { full_name: String(req.body?.name || '').trim().slice(0, 100) }
    }) });
    res.status(201).json({ user: { id: user.id, email: user.email, created_at: user.created_at } });
  } catch (error) {
    const msg = /already|registered|exists/i.test(error.message) ? 'Compte existant.' : 'Création impossible.';
    res.status(error.status || 502).json({ error: msg });
  }
});
app.patch('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  const banned = req.body?.banned === true;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'ID invalide.' });
  try {
    const current = await supabaseAdmin(`users/${encodeURIComponent(id)}`);
    if (String(current.email || '').toLowerCase() === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()) return res.status(400).json({ error: 'Protégé.' });
    await supabaseAdmin(`users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ ban_duration: banned ? '876000h' : 'none' }) });
    res.json({ ok: true });
  } catch (error) { res.status(error.status || 502).json({ error: 'Modification impossible.' }); }
});
app.patch('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  const password = String(req.body?.password || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'ID invalide.' });
  if (password.length < 6) return res.status(400).json({ error: '6 caractères minimum.' });
  try {
    const current = await supabaseAdmin(`users/${encodeURIComponent(id)}`);
    if (String(current.email || '').toLowerCase() === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()) return res.status(400).json({ error: 'Utilise le bouton d’en-tête.' });
    await supabaseAdmin(`users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ password }) });
    res.json({ ok: true });
  } catch (error) { res.status(error.status || 502).json({ error: 'Modification impossible.' }); }
});
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'ID invalide.' });
  try {
    const user = await supabaseAdmin(`users/${encodeURIComponent(id)}`);
    if (String(user.email || '').toLowerCase() === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()) return res.status(400).json({ error: 'Protégé.' });
    await supabaseAdmin(`users/${encodeURIComponent(id)}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (error) { res.status(error.status || 502).json({ error: 'Suppression impossible.' }); }
});

const usage = new Map();
function underDailyLimit(req, res, next) {
  const limit = 50;
  const day = new Date().toISOString().slice(0, 10);
  const key = `${req.user.id}:${day}:${req.path}`;
  const used = usage.get(key) || 0;
  if (used >= limit) return res.status(429).json({ error: `Limite atteinte (${limit}/jour). Réessaie demain.` });
  usage.set(key, used + 1);
  next();
}
function aiClient() {
  if (!process.env.AI_API_KEY) return null;
  return new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
    timeout: 120000,
    maxRetries: 1
  });
}
const modelName = () => process.env.AI_MODEL || 'llama-3.1-8b-instant';

function sanitizeText(text) {
  if (!text) return '';
  let t = String(text);
  t = t.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    const normal = (trimmed.match(/[a-zA-ZÀ-ÿ0-9\s.,;:!?'"()\-]/g) || []).length;
    if (trimmed.length > 5 && normal / trimmed.length < 0.3) return '';
    return line;
  }).filter(Boolean).join('\n');
  t = t.replace(/[¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ]{8,}/g, '');
  t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  t = t.replace(/[\u2000-\u206F\uFFF0-\uFFFF]/g, '');
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// Analyse d'un cours rédigé → génère des questions
app.post('/api/analyze-course', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA non configurée. Ajoute AI_API_KEY dans Render.' });
  const { subject = 'Matière', title = 'Cours', sourceText, count = 20 } = req.body || {};
  const text = sanitizeText(String(sourceText || '').trim());
  const n = Number(count);

  if (text.length < 150) return res.status(400).json({ error: 'Texte trop court après nettoyage (min 150 caractères).' });
  if (text.length > 80000) return res.status(413).json({ error: 'Texte trop long (max 80 000 caractères).' });
  if (!Number.isInteger(n) || n < 1 || n > 100) return res.status(400).json({ error: 'Nombre entre 1 et 100.' });

  try {
    const systemPrompt = `Tu es un assistant pédagogique expert. Tu vas lire un cours en français et produire un questionnaire QCM complet.

MÉTHODE STRICTE :
1. Lis INTÉGRALEMENT le texte fourni.
2. Identifie TOUTES les notions testables : définitions, classifications, mécanismes, chiffres clés, exceptions, propriétés, valeurs seuils.
3. Génère EXACTEMENT ${n} questions couvrant un MAXIMUM de notions différentes.
4. Répartis les questions sur TOUT le texte. N'invente JAMAIS de faits.
5. Si le cours liste des éléments, génère une question par élément important.

TYPES :
- 40% "mcq" : 4 options, correct = index 0-3
- 30% "mcq_multi" : 4 options, correct = tableau d'au moins 2 indices
- 30% "tf" : options = [], correct = true ou false

FORMAT JSON STRICT :
{"questions":[{"type":"mcq","text":"...","options":["a","b","c","d"],"correct":0,"explanation":"...","source_excerpt":"..."}],"summary":"...","note":"..."}`;

    const response = await client.chat.completions.create({
      model: modelName(), temperature: 0.3, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Matière : ${String(subject).slice(0,200)}\nTitre : ${String(title).slice(0,200)}\n\nCOURS :\n"""\n${text}\n"""\n\nGénère ${n} questions.` }
      ]
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('Réponse IA vide.');
    const parsed = JSON.parse(content);
    const raw = Array.isArray(parsed.questions) ? parsed.questions : [];
    const questions = raw.map((q, i) => {
      const type = ['mcq','mcq_multi','tf'].includes(q.type) ? q.type : null;
      const text2 = String(q.text || '').trim().slice(0, 2000);
      const options = Array.isArray(q.options) ? q.options.slice(0, 8).map(x => String(x).slice(0, 500)) : [];
      let correct = q.correct;
      if (type === 'tf') { if (typeof correct !== 'boolean') return null; }
      else if (type === 'mcq') { if (!Number.isInteger(correct) || correct < 0 || correct >= options.length || options.length < 2) return null; }
      else if (type === 'mcq_multi') { if (!Array.isArray(correct) || correct.length < 2) return null; correct = [...new Set(correct)]; }
      if (!type || !text2) return null;
      return { id:`course-${Date.now()}-${i}`, number:i+1, type, text:text2, options: type==='tf'?[]:options, correct, explanation:String(q.explanation||'').slice(0,1500), sourceExcerpt:String(q.source_excerpt||'').slice(0,500), source:'ai-generated', confidence:null };
    }).filter(Boolean);
    if (!questions.length) throw new Error('Aucune question valide générée.');
    res.json({ questions, summary: String(parsed.summary || '').slice(0, 500), note: String(parsed.note || '').slice(0, 1000), coverage: `${questions.length}/${n}`, model: modelName() });
  } catch (error) {
    console.error('Erreur analyse:', error?.message || error);
    const isTimeout = /timeout|aborted/i.test(error?.message || '');
    const isQuota = /quota|rate.?limit|429/i.test(error?.message || '');
    res.status(502).json({ error: isTimeout ? 'L’IA a mis trop de temps.' : isQuota ? 'Quota IA dépassé.' : 'Analyse échouée : ' + (error?.message || 'inconnue') });
  }
});

app.post('/api/answer-questions', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA désactivée. Ajoute AI_API_KEY dans Render.' });
  const { subject = 'Matière', questions } = req.body || {};
  if (!Array.isArray(questions) || !questions.length || questions.length > 100) return res.status(400).json({ error: 'Entre 1 et 100 questions.' });
  const safeQuestions = questions.map((q, i) => ({
    id: String(q.id ?? i), number: q.number ?? null,
    type: ['tf','mcq','mcq_multi','short'].includes(q.type) ? q.type : 'short',
    text: String(q.text || '').slice(0, 3000),
    options: Array.isArray(q.options) ? q.options.slice(0, 12).map(x => String(x).slice(0, 500)) : []
  }));
  try {
    const response = await client.chat.completions.create({
      model: modelName(), temperature: 0.1, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Réponds aux questions. Format : {"answers":[{"id":"...","correct":...,"explanation":"...","confidence":0.75}]}. mcq=index, mcq_multi=tableau, tf=booléen, short=chaîne.` },
        { role: 'user', content: JSON.stringify({ questions: safeQuestions }) }
      ]
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('Réponse vide.');
    const parsed = JSON.parse(content);
    const allowed = new Set(safeQuestions.map(q => q.id));
    const answers = (Array.isArray(parsed.answers) ? parsed.answers : []).filter(a => allowed.has(String(a.id))).map(a => ({
      id: String(a.id), correct: a.correct ?? null,
      explanation: String(a.explanation || '').slice(0, 2000),
      confidence: Number.isFinite(Number(a.confidence)) ? Math.max(0, Math.min(1, Number(a.confidence))) : 0
    }));
    res.json({ answers, model: modelName() });
  } catch (error) {
    console.error('Erreur IA:', error?.message || error);
    res.status(502).json({ error: 'Échec IA.' });
  }
});

app.post('/api/generate-questions', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA désactivée. Ajoute AI_API_KEY dans Render.' });
  const { subject = 'Matière', title = 'Cours', sourceText, count = 20 } = req.body || {};
  const text = sanitizeText(String(sourceText || '').trim());
  const n = Number(count);
  if (text.length < 80) return res.status(400).json({ error: 'Texte trop court.' });
  if (text.length > 60000) return res.status(413).json({ error: 'Texte trop long.' });
  if (!Number.isInteger(n) || n < 1 || n > 100) return res.status(400).json({ error: 'Nombre invalide.' });

  try {
    const systemPrompt = `Génère ${n} questions QCM à partir du cours fourni.

Répartition : 40% mcq (4 options, correct=index), 30% mcq_multi (4 options, ≥2 corrects), 30% tf (options=[], correct=bool).

Lis TOUT le texte. Couvre un maximum de notions. N'invente rien.

Format JSON : {"questions":[{"type":"...","text":"...","options":[...],"correct":...,"explanation":"...","source_excerpt":"..."}],"note":"..."}`;

    const response = await client.chat.completions.create({
      model: modelName(), temperature: 0.3, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Cours :\n\n"""\n${text}\n"""\n\nGénère exactement ${n} questions.` }
      ]
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('Réponse vide.');
    const parsed = JSON.parse(content);
    const raw = Array.isArray(parsed.questions) ? parsed.questions : [];
    const questions = raw.map((q, i) => {
      const type = ['mcq','mcq_multi','tf'].includes(q.type) ? q.type : null;
      const text2 = String(q.text || '').trim().slice(0, 2000);
      const options = Array.isArray(q.options) ? q.options.slice(0, 8).map(x => String(x).slice(0, 500)) : [];
      let correct = q.correct;
      if (type === 'tf') { if (typeof correct !== 'boolean') return null; }
      else if (type === 'mcq') { if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) return null; }
      else if (type === 'mcq_multi') { if (!Array.isArray(correct) || correct.length < 2) return null; }
      if (!type || !text2) return null;
      return { id:`gen-${Date.now()}-${i}`, number:i+1, type, text:text2, options:type==='tf'?[]:options, correct, explanation:String(q.explanation||'').slice(0,1500), sourceExcerpt:String(q.source_excerpt||'').slice(0,500), source:'ai-generated', confidence:null };
    }).filter(Boolean);
    if (!questions.length) throw new Error('Aucune question générée.');
    res.json({ questions, note: String(parsed.note || '').slice(0, 1000), coverage: `${questions.length}/${n}`, model: modelName() });
  } catch (error) {
    console.error('Erreur génération:', error?.message || error);
    res.status(502).json({ error: 'Génération échouée.' });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`CompoTest écoute sur le port ${port}`));
