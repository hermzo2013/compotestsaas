import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/config.js', (_req, res) => res.sendFile(path.join(__dirname, 'config.js'), { headers: { 'Cache-Control': 'no-store' } }));
app.get('/api/health', (_req, res) => res.json({ ok: true, aiConfigured: Boolean(process.env.AI_API_KEY), authConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY), adminConfigured: Boolean(process.env.ADMIN_EMAIL && process.env.SUPABASE_SERVICE_ROLE_KEY) }));

// Verify access tokens with Supabase Auth. The service-role key is only used by server-side admin routes.
async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Connecte-toi à CompoTest pour utiliser cette fonction.' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return res.status(503).json({ error: 'Authentification Supabase non configurée côté serveur.' });
  try {
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return res.status(401).json({ error: 'Session expirée. Reconnecte-toi.' });
    const user = await response.json();
    if (!user?.id || !user?.email) return res.status(401).json({ error: 'Session utilisateur invalide.' });
    const email = String(user.email).toLowerCase();
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const allowedEmails = (process.env.ALLOWED_USER_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const hasAppAccess = user.app_metadata?.compotest_access === true;
    if (email !== adminEmail && !allowedEmails.includes(email) && !hasAppAccess) return res.status(403).json({ error: 'Ce compte ne figure pas parmi les utilisateurs autorisés par l’administrateur.' });
    req.user = { id: user.id, email: user.email, isAdmin: Boolean(adminEmail && email === adminEmail) };
    next();
  } catch {
    return res.status(503).json({ error: 'Vérification de session indisponible. Réessaie.' });
  }
}
app.use('/api', (req, res, next) => req.path === '/health' ? next() : authenticate(req, res, next));

// Administration des comptes. La clé service_role reste exclusivement côté serveur (Render Environment).
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Accès réservé à l’administrateur CompoTest.' });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'La clé administrative Supabase manque dans les variables Render.' });
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
    const err = new Error(body.msg || body.message || body.error_description || body.error || `Supabase Admin API (${response.status})`);
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
  } catch (error) {
    console.error('Admin list users:', error.message);
    res.status(error.status || 502).json({ error: 'Impossible de charger les comptes Supabase.' });
  }
});
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  if (email === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()) return res.status(400).json({ error: 'Cette adresse est réservée au compte administrateur.' });
  if (password.length < 12) return res.status(400).json({ error: 'Le mot de passe provisoire doit contenir au moins 12 caractères.' });
  try {
    const user = await supabaseAdmin('users', { method: 'POST', body: JSON.stringify({
      email, password, email_confirm: true,
      app_metadata: { compotest_access: true, role: 'user' },
      user_metadata: { full_name: String(req.body?.name || '').trim().slice(0, 100) }
    }) });
    res.status(201).json({ user: { id: user.id, email: user.email, created_at: user.created_at } });
  } catch (error) {
    console.error('Admin create user:', error.message);
    const msg = /already|registered|exists/i.test(error.message) ? 'Un compte existe déjà avec cette adresse.' : 'Création impossible. Vérifie les paramètres Supabase et réessaie.';
    res.status(error.status || 502).json({ error: msg });
  }
});
app.patch('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  const banned = req.body?.banned === true;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Identifiant de compte invalide.' });
  try {
    const current = await supabaseAdmin(`users/${encodeURIComponent(id)}`);
    if (String(current.email || '').toLowerCase() === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()) return res.status(400).json({ error: 'Le compte administrateur ne peut pas être désactivé ici.' });
    await supabaseAdmin(`users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ ban_duration: banned ? '876000h' : 'none' }) });
    res.json({ ok: true });
  } catch (error) {
    console.error('Admin update user:', error.message);
    res.status(error.status || 502).json({ error: 'Impossible de modifier le statut du compte.' });
  }
});
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Identifiant de compte invalide.' });
  try {
    const user = await supabaseAdmin(`users/${encodeURIComponent(id)}`);
    if (String(user.email || '').toLowerCase() === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()) return res.status(400).json({ error: 'Le compte administrateur ne peut pas être supprimé ici.' });
    await supabaseAdmin(`users/${encodeURIComponent(id)}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Admin delete user:', error.message);
    res.status(error.status || 502).json({ error: 'Impossible de supprimer ce compte.' });
  }
});

// Best-effort per-user daily caps. They reset when this free server restarts; provider limits remain the final guardrail.
const usage = new Map();
function underDailyLimit(req, res, next) {
  const limit = req.path === '/generate-questions' ? 5 : 10;
  const day = new Date().toISOString().slice(0, 10);
  const key = `${req.user.id}:${day}:${req.path}`;
  const used = usage.get(key) || 0;
  if (used >= limit) return res.status(429).json({ error: `Limite gratuite atteinte (${limit} demande(s) par jour pour cette fonction). Réessaie demain.` });
  usage.set(key, used + 1);
  next();
}
function aiClient() {
  if (!process.env.AI_API_KEY) return null;
  return new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1'
  });
}
const modelName = () => process.env.AI_MODEL || 'openai/gpt-oss-20b';

app.post('/api/answer-questions', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA désactivée : ajoute une clé d’offre gratuite dans AI_API_KEY côté serveur. Aucune facturation n’est configurée par CompoTest.' });
  const { subject = 'Matière non précisée', questions } = req.body || {};
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 100) return res.status(400).json({ error: 'Fournis entre 1 et 100 questions.' });
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
        { role: 'system', content: `Tu aides à préparer des questionnaires pédagogiques. Matière : ${String(subject).slice(0,200)}. Réponds en français, avec prudence. Ne devine pas si l'énoncé manque d'informations : dans ce cas indique correct:null, confidence:0 et warning. Pour mcq, correct est un index d'option commençant à 0. Pour mcq_multi, correct est un tableau d'indices. Pour tf, correct est true ou false. Pour short, correct est une chaîne de réponse. confidence est une estimation entre 0 et 1, pas une garantie. Donne une explication concise et signale toute ambiguïté. Le JSON doit respecter cette forme : {"answers":[{"id":"...","correct":0,"explanation":"...","confidence":0.75,"warning":"..."}]}.` },
        { role: 'user', content: JSON.stringify({ questions: safeQuestions }) }
      ]
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('Le modèle n’a renvoyé aucun contenu.');
    const parsed = JSON.parse(content);
    const allowed = new Set(safeQuestions.map(q => q.id));
    const answers = (Array.isArray(parsed.answers) ? parsed.answers : []).filter(a => allowed.has(String(a.id))).map(a => ({
      id: String(a.id), correct: a.correct ?? null,
      explanation: String(a.explanation || '').slice(0, 2000),
      confidence: Number.isFinite(Number(a.confidence)) ? Math.max(0, Math.min(1, Number(a.confidence))) : 0,
      warning: String(a.warning || '').slice(0, 1000)
    }));
    res.json({ answers, model: modelName() });
  } catch (error) {
    console.error('Erreur API IA:', error?.message || error);
    res.status(502).json({ error: 'Échec de la génération IA ou quota gratuit épuisé. Réessaie plus tard.' });
  }
});

app.post('/api/generate-questions', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA désactivée : ajoute une clé d’offre gratuite dans AI_API_KEY côté serveur. Aucune facturation n’est configurée par CompoTest.' });
  const { subject = 'Matière non précisée', title = 'Cours importé', sourceText, count = 20 } = req.body || {};
  const text = typeof sourceText === 'string' ? sourceText.trim() : '';
  const n = Number(count);
  if (text.length < 80) return res.status(400).json({ error: 'Le texte du cours est trop court. Importe un PDF et extrais son texte avant de générer les questions.' });
  if (text.length > 40000) return res.status(413).json({ error: 'Le texte est trop long pour une seule génération (maximum 40 000 caractères). Essaie avec un extrait plus court du cours.' });
  if (!Number.isInteger(n) || n < 1 || n > 100) return res.status(400).json({ error: 'Choisis un nombre de questions entre 1 et 100.' });
  try {
    const response = await client.chat.completions.create({
      model: modelName(), temperature: 0.2, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Tu es un assistant pédagogique. Génère exactement ${n} questions en français, uniquement à partir du contenu source fourni. N'ajoute pas de faits absents du cours. Si le contenu ne permet pas de soutenir une question ou sa réponse, ne l'invente pas; génère autant de questions fiables que possible et indique les limites dans le champ note. Mélange ces formats : mcq (une seule bonne réponse), mcq_multi (plusieurs bonnes réponses), tf (Vrai/Faux). Répartition souhaitée : environ un tiers de chaque format, sans obligation stricte si le contenu ne s'y prête pas. Pour mcq, options contient 4 choix et correct est l'index zéro-based de la bonne réponse. Pour mcq_multi, options contient 4 choix et correct est un tableau d'au moins 2 indices distincts. Pour tf, options doit être [] et correct est un booléen (true = Vrai). Chaque question doit être claire, sans ambiguïté, sans doublons et sans négation piège. L'explication doit justifier la réponse en se référant au cours. Réponds en JSON valide : {"questions":[{"type":"mcq|mcq_multi|tf","text":"...","options":["..."],"correct":0,"explanation":"...","source_excerpt":"courte citation/paraphrase fidèle au cours"}],"note":"..."}. Pour tf, correct est true ou false et options [].` },
        { role: 'user', content: JSON.stringify({ subject: String(subject).slice(0,200), title: String(title).slice(0,200), sourceText: text }) }
      ]
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('Le modèle n’a renvoyé aucun contenu.');
    const parsed = JSON.parse(content);
    const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
    const questions = rawQuestions.slice(0, n).map((q, i) => {
      const type = ['mcq','mcq_multi','tf'].includes(q.type) ? q.type : null;
      const text = String(q.text || '').trim().slice(0, 2000);
      const options = Array.isArray(q.options) ? q.options.slice(0, 8).map(x => String(x).slice(0, 500)) : [];
      let correct = q.correct;
      if (type === 'tf') { if (typeof correct !== 'boolean') return null; }
      else if (type === 'mcq') { if (!Number.isInteger(correct) || correct < 0 || correct >= options.length || options.length < 2) return null; }
      else if (type === 'mcq_multi') { if (!Array.isArray(correct) || correct.length < 2 || correct.some(x => !Number.isInteger(x) || x < 0 || x >= options.length) || options.length < 3) return null; correct = [...new Set(correct)]; }
      if (!type || !text) return null;
      return { id: `gen-${Date.now()}-${i}`, number: i + 1, type, text, options: type === 'tf' ? [] : options, correct, explanation: String(q.explanation || '').slice(0, 1500), sourceExcerpt: String(q.source_excerpt || '').slice(0, 500), source: 'ai-generated', confidence: null };
    }).filter(Boolean);
    if (!questions.length) return res.status(502).json({ error: 'Aucune question exploitable n’a été produite. Essaie avec un texte de cours plus complet.' });
    res.json({ questions, note: String(parsed.note || '').slice(0, 1000), model: modelName() });
  } catch (error) {
    console.error('Erreur génération de questions:', error?.message || error);
    res.status(502).json({ error: 'La génération a échoué ou le quota gratuit est épuisé. Vérifie la configuration de l’API et réessaie.' });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`CompoTest écoute sur le port ${port}`));
