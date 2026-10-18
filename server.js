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
    const isAdmin =
      user.app_metadata?.is_admin === true ||
      user.app_metadata?.role === 'admin' ||
      Boolean(adminEmail && user.email?.toLowerCase() === adminEmail);

    req.user = { id: user.id, email: user.email, isAdmin };
    next();
  } catch (e) {
    console.error('Auth error:', e);
    return res.status(503).json({ error: 'Vérification indisponible. Vérifiez les variables Render.' });
  }
}
app.use('/api', authenticate);

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Réservé administrateur.' });
  next();
}

// ==========================================
// SUPABASE ADMIN
// ==========================================
async function supabaseAdmin(pathname, options = {}) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY manquante sur Render.");
  }
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

// ==========================================
// ROUTES ADMIN
// ==========================================
app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  try {
    const data = await supabaseAdmin('users?page=1&per_page=100');
    const users = (data.users || []).map(u => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      banned: u.banned_until && new Date(u.banned_until) > new Date(),
      name: u.user_metadata?.full_name || u.email.split('@')[0],
      isAdmin: u.app_metadata?.is_admin === true || u.app_metadata?.role === 'admin'
    }));
    res.json({ users });
  } catch (e) { 
    console.error('Erreur Admin Users:', e);
    res.status(500).json({ error: e.message }); 
  }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Email invalide.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Mot de passe trop court (6 min).' });
  try {
    const user = await supabaseAdmin('users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        app_metadata: { compotest_access: true },
        user_metadata: { full_name: req.body.name || email.split('@')[0] }
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

// ✅ NOUVELLE ROUTE : Attribution de rôle
app.patch('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
  try {
    const isAdmin = req.body.is_admin === true;
    // On met à jour les app_metadata pour définir le rôle admin
    const current = await supabaseAdmin(`users/${req.params.id}`);
    const app_metadata = { ...(current.app_metadata || {}), is_admin: isAdmin };
    
    await supabaseAdmin(`users/${req.params.id}`, {
      method: 'PUT',
      body: JSON.stringify({ app_metadata })
    });
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
// IA & EXTRACTION (V10 inchangé)
// ==========================================
function aiClient() {
  if (!process.env.AI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.AI_API_KEY, baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1', timeout: 120000 });
}
const modelName = () => process.env.AI_MODEL || 'openai/gpt-oss-20b';

function parseQuizText(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  let text = rawText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').replace(/\u00A0/g, ' ').replace(/\r\n?/g, '\n').replace(/Page\s+\d+(\s*\/\s*\d+)?/gi, ' ').replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/[ \t]+/g, ' ');
  text = text.replace(/(^|[\s\.\(;:])((?:Q\s*)?\d{1,3})\s*([\.\):])\s*(?=[A-ZÀ-Ýa-z])/gi, '$1$2$3 ');
  text = text.replace(/(^|[\s])[\(\[]?([A-Ea-e])\s*([\.\)\-])\s*(?=[A-ZÀ-Ýa-z0-9])/g, (m, pre, letter, punct) => `${pre}${letter.toUpperCase()}${punct} `);

  const candidateRegex = /(?:^|[\s\.;:\)\]])(Q\s*(\d{1,3})|\d{1,3})\s*[\.\):]\s+/gi;
  const candidates = [];
  let mCand;
  while ((mCand = candidateRegex.exec(text)) !== null) {
    const fullNum = mCand[1].replace(/\D/g, '');
    const num = parseInt(fullNum, 10);
    const hasQ = /^Q/i.test(mCand[1]);
    const startIdx = mCand.index + mCand[0].indexOf(mCand[1]);
    const textStart = mCand.index + mCand[0].length;
    if (num >= 1 && num <= 200) candidates.push({ num, hasQ, startIdx, textStart });
  }

  const withQ = candidates.filter(c => c.hasQ);
  let pool = withQ.length >= 3 ? withQ : candidates;

  const sequences = [];
  let currentSeq = [];
  for (const c of pool) {
    if (currentSeq.length === 0) { currentSeq.push(c); continue; }
    const prev = currentSeq[currentSeq.length - 1];
    if (c.num === prev.num) continue;
    if (c.num === prev.num + 1 || (c.num > prev.num + 1 && c.num <= prev.num + 5)) {
      currentSeq.push(c);
    } else {
      if (currentSeq.length >= 3) sequences.push(currentSeq);
      currentSeq = [c];
    }
  }
  if (currentSeq.length >= 3) sequences.push(currentSeq);
  sequences.sort((a, b) => b.length - a.length);
  const bestSeq = sequences[0] || pool;
  if (!bestSeq.length) return fallbackParse(rawText);

  const firstQStart = bestSeq[0].startIdx;
  const beforeFirstQ = text.slice(0, firstQStart);
  const trueFalseHint = /cochez\s+(a|la\s+case\s+a)\s+pour\s+(les\s+)?(affirmations?\s+)?vra/i.test(beforeFirstQ + ' ' + text.slice(firstQStart, firstQStart + 500)) || /vrai\s*\/\s*faux/i.test(beforeFirstQ) || /répondez\s+par\s+vrai\s+ou\s+faux/i.test(beforeFirstQ);

  const questions = [];
  for (let i = 0; i < bestSeq.length; i++) {
    const start = bestSeq[i];
    const end = i + 1 < bestSeq.length ? bestSeq[i + 1].startIdx : text.length;
    let block = text.slice(start.textStart, end).trim();
    if (!block) continue;

    const optionSplitRegex = /(?<=^|[\s\.;:])([\(\[]?[A-E][\.\)\-\]])\s+/g;
    const optMatches = [];
    let mo;
    while ((mo = optionSplitRegex.exec(block)) !== null) {
      optMatches.push({ index: mo.index, end: mo.index + mo[0].length, letter: mo[1].replace(/[^A-Ea-e]/g, '').toUpperCase() });
    }

    let validOptions = [];
    if (optMatches.length >= 2) {
      const letters = optMatches.map(o => o.letter);
      const expected = ['A', 'B', 'C', 'D'];
      let ok = true;
      for (let k = 0; k < Math.min(letters.slice(0, 4).length, expected.length); k++) {
        if (letters[k] !== expected[k]) { ok = false; break; }
      }
      if (ok) validOptions = optMatches;
    }

    let qText, options;
    if (validOptions.length >= 2) {
      qText = block.slice(0, validOptions[0].index).trim();
      options = [];
      for (let k = 0; k < validOptions.length; k++) {
        const optStart = validOptions[k].end;
        const optEnd = k + 1 < validOptions.length ? validOptions[k + 1].index : block.length;
        let optText = block.slice(optStart, optEnd).trim().replace(/[;\.]+$/, '').trim();
        if (optText) options.push(optText);
      }
    } else {
      qText = block.trim();
      options = ['Vrai', 'Faux'];
    }

    qText = qText.replace(/\s+/g, ' ').replace(/^[\-–—\.\s]+/, '').replace(/[\s;]+$/, '').trim();
    if (qText.length < 8 || /^\d+\s*[-:]?\s*[A-E](\s+\d+\s*[-:]?\s*[A-E]){2,}/i.test(qText)) continue;

    let type = (options.length === 2 && options[0] === 'Vrai') ? 'tf' : 'mcq';
    if (trueFalseHint && validOptions.length === 0) type = 'tf';

    questions.push({ number: start.num, text: qText, options, correct: 0, type });
  }

  const answerKey = {};
  const gridRegex = /(\d{1,3})\s*[-:\.\)]?\s*([A-Ea-e])\b/g;
  const allMatches = [];
  let mg;
  while ((mg = gridRegex.exec(text)) !== null) allMatches.push({ num: parseInt(mg[1]), letter: mg[2].toUpperCase(), index: mg.index, len: mg[0].length });
  
  let group = [];
  const gridZones = [];
  for (let i = 0; i < allMatches.length; i++) {
    if (group.length === 0) { group.push(allMatches[i]); continue; }
    const prev = group[group.length - 1];
    if (allMatches[i].index - (prev.index + prev.len) < 30) group.push(allMatches[i]);
    else { if (group.length >= 4) gridZones.push(group); group = [allMatches[i]]; }
  }
  if (group.length >= 4) gridZones.push(group);
  gridZones.forEach(zone => zone.forEach(p => { answerKey[p.num] = p.letter; }));

  questions.forEach(q => {
    const letter = answerKey[q.number];
    if (!letter) return;
    if (q.type === 'tf') q.correct = letter === 'A' ? 0 : 1;
    else { const idx = letter.charCodeAt(0) - 65; if (idx >= 0 && idx < q.options.length) q.correct = idx; }
  });

  return questions;
}

function fallbackParse(rawText) {
  const text = rawText.replace(/\s+/g, ' ');
  const parts = text.split(/(?=Q\s*\d{1,3}\s*[\.\):])/i).filter(p => p.trim());
  const questions = [];
  parts.forEach(p => {
    const m = p.match(/^Q\s*(\d{1,3})\s*[\.\):]\s*(.*)/i);
    if (!m) return;
    const content = m[2].trim();
    if (content.length < 5) return;
    const optParts = content.split(/(?=[A-D][\.\)\-]\s)/i);
    let qText = optParts[0].trim();
    let options = optParts.slice(1).map(o => o.replace(/^[A-D][\.\)\-]\s*/i, '').trim()).filter(Boolean);
    const type = options.length >= 2 ? 'mcq' : 'tf';
    if (type === 'tf') options = ['Vrai', 'Faux'];
    questions.push({ number: parseInt(m[1]), text: qText, options, correct: 0, type });
  });
  return questions;
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
        { role: 'system', content: `Génère ${count} questions en FRANÇAIS (QCM, V/F). Format strict: {"questions":[{"type":"mcq","text":"...","options":["A","B"],"correct":0,"explanation":"..."}]}` },
        { role: 'user', content: String(text || '').slice(0, 15000) }
      ]
    });
    res.json(JSON.parse(response.choices[0].message.content));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(port, '0.0.0.0', () => console.log(`Serveur sur port ${port}`));
