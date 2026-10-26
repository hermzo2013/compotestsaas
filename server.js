import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

// ==========================================
// 🔍 LOG DE TOUTES LES REQUÊTES (POUR DEBUG)
// ==========================================
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ==========================================
// ✅ CORS — DOIT ÊTRE AVANT LES ROUTES /api
// ==========================================
const ALLOWED_ORIGINS = [
  'https://comptestsaas.onrender.com',
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
// FICHIERS STATIQUES
// ==========================================
app.use(express.static(__dirname, { maxAge: '1d' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/favicon.png', (_req, res) => res.sendFile(path.join(__dirname, 'favicon.png')));
app.get('/config.js', (_req, res) => res.sendFile(path.join(__dirname, 'config.js'), { headers: { 'Cache-Control': 'no-store' } }));

// ==========================================
// AUTHENTIFICATION
// ==========================================
async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Connecte-toi.' });
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      throw new Error("Variables Supabase manquantes sur le serveur.");
    }
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
// ⚠️ CETTE ROUTE DOIT ÊTRE AVANT app.use('/api', authenticate)
app.get('/api/quizzes', async (req, res) => {
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes?select=*&order=created_at.desc`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
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
        user_metadata: { full_name: `${firstName} ${lastName}` }
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
function parseQuizText(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  let text = rawText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').replace(/\u00A0/g, ' ').replace(/\r\n?/g, '\n').replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/[ \t]+/g, ' ');
  const answerKey = {};
  const gridRegex = /Q(\d{1,3})\s+(VRAI|FAUX|[A-Ea-e](?:[\s\.\,][A-Ea-e])*)/gi;
  let mGrid;
  while ((mGrid = gridRegex.exec(rawText)) !== null) {
    const qNum = parseInt(mGrid[1]);
    const val = mGrid[2].toUpperCase();
    if (val === 'VRAI') answerKey[qNum] = { type: 'tf', correct: 0 };
    else if (val === 'FAUX') answerKey[qNum] = { type: 'tf', correct: 1 };
    else {
      const letters = val.match(/[A-E]/g);
      if (letters) {
        const indices = letters.map(l => l.charCodeAt(0) - 65);
        answerKey[qNum] = { type: indices.length > 1 ? 'mcq_multi' : 'mcq', correct: indices.length > 1 ? indices : indices[0] };
      }
    }
  }
  const parts = text.split(/(?:^|\n)\s*(?:\*\s*)?(?:Q\s*)?(\d{1,3})\s*[\/\.\)\-\:]\s*\*?\s+/i);
  const questions = [];
  for (let i = 1; i < parts.length; i += 2) {
    const num = parseInt(parts[i]);
    let content = parts[i + 1] ? parts[i + 1].trim() : '';
    if (!content || content.replace(/[^a-zA-Z]/g, '').length < 5) continue;
    if (/^[A-Z]\.\s/.test(content)) continue;
    let qText = content, options = [], type = 'mcq', correct = 0;
    if (content.includes('\n-') || content.includes(' - ')) {
      const firstDash = content.search(/(?:\n|\s)-\s/);
      qText = content.substring(0, firstDash).trim();
      const optionsText = content.substring(firstDash).trim();
      const rawOptions = optionsText.split(/(?:\n|\s)-\s/).filter(o => o.trim().length > 0);
      let correctIndices = [];
      rawOptions.forEach((opt, idx) => {
        if (opt.includes('✓')) correctIndices.push(idx);
        let cleanOpt = opt.replace('✓', '').replace(/:\s*Non$/i, '').trim();
        if (cleanOpt) options.push(cleanOpt);
      });
      if (correctIndices.length > 0) {
        correct = correctIndices.length > 1 ? correctIndices : correctIndices[0];
        type = correctIndices.length > 1 ? 'mcq_multi' : 'mcq';
      } else type = options.length > 2 ? 'mcq_multi' : 'mcq';
    } else if (/[\:\-]\s*\*?(Vrai|Faux)\*?\s*$/i.test(content)) {
      const match = content.match(/(.*?)\s*[\:\-]\s*\*?(Vrai|Faux)\*?\s*$/i);
      qText = match[1].trim();
      type = 'tf'; options = ['Vrai', 'Faux']; correct = match[2].toLowerCase() === 'vrai' ? 0 : 1;
    } else if (content.includes(':') && (content.includes('✓') || !content.includes('\n'))) {
      const colonIndex = content.lastIndexOf(':');
      if (colonIndex > 0) {
        qText = content.substring(0, colonIndex).trim();
        let answer = content.substring(colonIndex + 1).replace('✓', '').trim();
        if (answer.length > 0 && answer.length < 100) { options = [answer]; type = 'mcq'; correct = 0; }
      }
    }
    if (options.length === 0) {
      const optionRegex = /(?:^|\s)([a-eA-E])\s*[\)\:\-\.]\s+/g;
      const matches = [...content.matchAll(optionRegex)];
      if (matches.length >= 2) {
        qText = content.substring(0, matches[0].index).trim();
        for (let j = 0; j < matches.length; j++) {
          const start = matches[j].index + matches[j][0].length;
          const end = (j + 1 < matches.length) ? matches[j + 1].index : content.length;
          let optText = content.substring(start, end).trim().replace(/[;\.]+$/, '').trim();
          if (optText) options.push(optText);
        }
      } else { type = 'tf'; options = ['Vrai', 'Faux']; }
    }
    if (answerKey[num]) { type = answerKey[num].type; correct = answerKey[num].correct; }
    qText = qText.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    if (qText.length > 5) questions.push({ number: num, text: qText, options: options.length > 0 ? options : ['Vrai', 'Faux'], correct, type });
  }
  const uniqueQuestions = []; const seenNumbers = new Set();
  for (const q of questions) { if (!seenNumbers.has(q.number)) { seenNumbers.add(q.number); uniqueQuestions.push(q); } }
  return uniqueQuestions;
}

app.post('/api/parse-existing-quiz', (req, res) => {
  try {
    const questions = parseQuizText(req.body?.text || '');
    res.json({ questions: questions.length ? questions : [], message: questions.length ? undefined : 'Aucune question reconnue.' });
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
        { role: 'system', content: `Tu es un générateur de quiz pédagogiques en FRANÇAIS. À partir du texte fourni, génère ${count} questions.\n\nTu DOIS répartir les questions entre CES 4 TYPES :\n1. "mcq" : question à choix unique. "correct" est un ENTIER.\n2. "mcq_multi" : QCM avec PLUSIEURS bonnes réponses. "correct" est un TABLEAU d'entiers.\n3. "tf" : Vrai/Faux. "options" = ["Vrai", "Faux"]. "correct" = 0 ou 1.\n4. "short" : réponse courte (1 à 3 mots). Pas d'"options". "correct" est une CHAÎNE.\n\nRépartition : ~50% mcq, ~20% mcq_multi, ~20% tf, ~10% short.\nFournis TOUJOURS une "explanation" courte.\nRéponds UNIQUEMENT en JSON valide :\n{"questions":[{"type":"mcq","text":"...","options":["A","B","C","D"],"correct":0,"explanation":"..."}]}` },
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
    }
    res.json(parsed);
  } catch (e) { console.error('Erreur API IA :', e.message); res.status(502).json({ error: e.message }); }
});

app.post('/api/quizzes', async (req, res) => {
  const { title, subject, questions } = req.body;
  if (!title || !questions || !Array.isArray(questions) || questions.length === 0) return res.status(400).json({ error: 'Titre et questions requis.' });
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes`, {
      method: 'POST',
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ title: String(title).slice(0, 200), subject: String(subject || 'Général').slice(0, 200), questions, created_by: req.user.id })
    });
    if (!response.ok) { const err = await response.text(); throw new Error(`Erreur Supabase POST: ${err}`); }
    const data = await response.json(); res.json({ quiz: data[0] });
  } catch (e) { console.error('Erreur POST quizzes:', e.message); res.status(500).json({ error: e.message }); }
});

app.put('/api/quizzes/:id', requireAdmin, async (req, res) => {
  const { questions } = req.body;
  if (!Array.isArray(questions) || questions.length === 0) return res.status(400).json({ error: 'Tableau de questions requis.' });
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes?id=eq.${req.params.id}`, {
      method: 'PATCH',
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ questions })
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

app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Serveur démarré sur le port ${port}`);
  console.log(`🌐 Environnement: ${process.env.NODE_ENV || 'development'}`);
});
