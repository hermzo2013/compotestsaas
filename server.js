import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/config.js', (_req, res) => res.sendFile(path.join(__dirname, 'config.js'), { headers: { 'Cache-Control': 'no-store' } }));

// ==========================================
// AUTH & ADMIN
// ==========================================
async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Connecte-toi.' });
  try {
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return res.status(401).json({ error: 'Session expirée.' });
    const user = await response.json();
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    req.user = { 
      id: user.id, 
      email: user.email, 
      isAdmin: Boolean(adminEmail && user.email.toLowerCase() === adminEmail) 
    };
    next();
  } catch { return res.status(503).json({ error: 'Vérification indisponible.' }); }
}
app.use('/api', authenticate);

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Réservé administrateur.' });
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
  if (!response.ok) throw new Error(body.msg || body.message || 'Erreur Supabase Admin');
  return body;
}

// Routes Admin
app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  try {
    const data = await supabaseAdmin('users?page=1&per_page=100');
    const users = (data.users || []).map(u => ({
      id: u.id, email: u.email, created_at: u.created_at,
      last_sign_in: u.last_sign_in_at, banned: u.banned_until && new Date(u.banned_until) > new Date(),
      name: u.user_metadata?.full_name || u.email.split('@')[0]
    }));
    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim();
  if (!email.includes('@')) return res.status(400).json({ error: 'Email invalide.' });
  try {
    const user = await supabaseAdmin('users', { method: 'POST', body: JSON.stringify({
      email, password, email_confirm: true,
      app_metadata: { compotest_access: true },
      user_metadata: { full_name: name || email.split('@')[0] }
    }) });
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  try {
    await supabaseAdmin(`users/${req.params.id}`, { method: 'PUT', body: JSON.stringify({ password: req.body.password }) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
  try {
    await supabaseAdmin(`users/${req.params.id}`, { method: 'PUT', body: JSON.stringify({ ban_duration: req.body.banned ? '876000h' : 'none' }) });
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
// IA & QUESTIONS (inchangé)
// ==========================================
function aiClient() {
  if (!process.env.AI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.AI_API_KEY, baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1', timeout: 120000 });
}
const modelName = () => process.env.AI_MODEL || 'openai/gpt-oss-20b';

function parseQuizText(text) {
  let clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').replace(/Page\s+\d+/gi, ' ');
  let blocks = clean.split(/(?=(?:Q\s*)?\d{1,3}[\.\)]\s)/i);
  let questions = [];
  for (let block of blocks) {
    block = block.trim();
    if (!block) continue;
    const matchNum = block.match(/^(?:Q\s*)?(\d{1,3})[\.\)]\s(.*)/i);
    if (!matchNum) continue;
    let num = parseInt(matchNum[1]);
    let content = matchNum[2];
    let parts = content.split(/(?=\s[A-D][\.\)]\s)/i);
    let qText = parts[0].trim();
    let options = [];
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) {
        let optText = parts[i].replace(/^\s*[A-D][\.\)]\s/i, '').trim();
        if (optText) options.push(optText);
      }
    }
    if (options.length === 0) options = ['Vrai', 'Faux'];
    if (qText.length > 5) questions.push({ number: num, text: qText, options: options, correct: 0, type: options.length === 2 && options[0] === 'Vrai' ? 'tf' : 'mcq' });
  }
  return questions;
}

app.post('/api/parse-existing-quiz', (req, res) => {
  const questions = parseQuizText(req.body.text);
  res.json({ questions });
});

app.post('/api/generate-post-test', async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA non configurée.' });
  const { text, count = 50 } = req.body;
  try {
    const response = await client.chat.completions.create({
      model: modelName(), temperature: 0.4, max_tokens: 8000, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Génère ${count} questions en FRANÇAIS (QCM, V/F). Format: {"questions":[{"type":"mcq","text":"...","options":["A","B"],"correct":0,"explanation":"..."}]}` },
        { role: 'user', content: text.slice(0, 15000) }
      ]
    });
    res.json(JSON.parse(response.choices[0].message.content));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(port, '0.0.0.0', () => console.log(`Serveur sur port ${port}`));
