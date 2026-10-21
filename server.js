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

app.use(express.static(__dirname, { maxAge: '1d' }));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/favicon.png', (_req, res) => res.sendFile(path.join(__dirname, 'favicon.png')));
app.get('/config.js', (_req, res) => res.sendFile(path.join(__dirname, 'config.js'), { headers: { 'Cache-Control': 'no-store' } }));

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
  const firstName = String(req.body?.firstName || '').trim();
  const lastName = String(req.body?.lastName || '').trim();
  let email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!firstName || !lastName) {
    return res.status(400).json({ error: 'Nom et prénom requis.' });
  }

  if (!email) {
    const slug = `${firstName}.${lastName}`
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9.]/g, '');
    email = `${slug}@comptest.local`;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email invalide.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Mot de passe trop court (6 min).' });
  }

  try {
    const fullName = `${firstName} ${lastName}`;
    const user = await supabaseAdmin('users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        app_metadata: { compotest_access: true },
        user_metadata: { full_name: fullName }
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

function aiClient() {
  if (!process.env.AI_API_KEY) return null;
  return new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
    timeout: 120000
  });
}
const modelName = () => process.env.AI_MODEL || 'openai/gpt-oss-20b';

// ==========================================
// EXTRACTION REGEX — Amélioration pour "A : vrai"
// ==========================================
function parseQuizText(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  
  let text = rawText
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/Page\s+\d+(\s*\/\s*\d+)?/gi, ' ')
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[ \t]+/g, ' ');

  const multiHint = /(cochez\s+(la|les)\s+(ou\s+les\s+)?(bonnes?\s+)?(réponses?|cases?)|plusieurs\s+réponses?|choix\s+multiples?|\(?\bQCM\s+multi\b\)?)/i.test(text);
  const shortHint = /(réponse\s+courte|texte\s+à\s+trous|complétez|répondez\s+par\s+un\s+mot)/i.test(text);
  const trueFalseHint = /(vrai\s*\/\s*faux|répondez\s+par\s+vrai\s+ou\s+faux|A\s*:\s*vrai\s+B\s*:\s*faux)/i.test(text);

  // Normalisation : A :, A., A), A-
  text = text.replace(/(^|[\s])[\(\[]?([A-Ea-e])\s*([\.\)\-:])\s*(?=[A-ZÀ-Ýa-z0-9])/g, (m, pre, letter, punct) => `${pre}${letter.toUpperCase()}${punct} `);

  const candidateRegex = /(?:^|[\s\.;:\)\]])(Q\s*(\d{1,3})|\d{1,3})\s*[\-\.\):]\s+/gi;
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

  const questions = [];
  for (let i = 0; i < bestSeq.length; i++) {
    const start = bestSeq[i];
    const end = i + 1 < bestSeq.length ? bestSeq[i + 1].startIdx : text.length;
    let block = text.slice(start.textStart, end).trim();
    if (!block) continue;

    // Regex pour trouver les options : A :, B :, etc.
    const optionSplitRegex = /(?<=^|[\s\.;:])([\(\[]?[A-Ea-e][\.\)\-\:]\s*)/g;
    const optMatches = [];
    let mo;
    while ((mo = optionSplitRegex.exec(block)) !== null) {
      optMatches.push({ index: mo.index, end: mo.index + mo[0].length, letter: mo[1].replace(/[^A-Ea-e]/g, '').toUpperCase() });
    }

    let validOptions = [];
    if (optMatches.length >= 2) {
      const letters = optMatches.map(o => o.letter);
      const expected = ['A', 'B', 'C', 'D', 'E'];
      let ok = true;
      for (let k = 0; k < Math.min(letters.length, expected.length); k++) {
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
      if (/vrai\s*\/\s*faux/i.test(block) || trueFalseHint) {
        qText = block.trim();
        options = ['Vrai', 'Faux'];
      } else {
        continue;
      }
    }

    qText = qText.replace(/\s+/g, ' ').replace(/^[\-–—\.\s]+/, '').replace(/[\s;]+$/, '').trim();
    if (qText.length < 8) continue;

    let type = 'mcq';
    if (options.length === 2 && options[0] === 'Vrai' && options[1] === 'Faux') {
      type = 'tf';
    } else if (shortHint && validOptions.length === 0) {
      type = 'short';
    } else if (multiHint && validOptions.length >= 2) {
      type = 'mcq_multi';
    }

    if (type === 'short') options = [];

    // Pas de grille de correction → on met 0 par défaut
    questions.push({ number: start.num, text: qText, options, correct: type === 'mcq_multi' ? [0] : 0, type });
  }

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
    const optParts = content.split(/(?=[A-Da-d][\.\)\-]\s)/i);
    let qText = optParts[0].trim();
    let options = optParts.slice(1).map(o => o.replace(/^[A-Da-d][\.\)\-]\s*/i, '').trim()).filter(Boolean);
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
      model: modelName(),
      temperature: 0.4,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Tu es un générateur de quiz pédagogiques en FRANÇAIS. À partir du texte fourni, génère ${count} questions.

Tu DOIS répartir les questions entre CES 4 TYPES (varie-les pour un bon entraînement) :
1. "mcq" : question à choix unique (une seule bonne réponse). "correct" est un ENTIER (index 0-based de la bonne option).
2. "mcq_multi" : QCM avec PLUSIEURS bonnes réponses (2 minimum). "correct" est un TABLEAU d'entiers triés (ex. [0, 2]).
3. "tf" : Vrai/Faux. "options" = ["Vrai", "Faux"]. "correct" = 0 (Vrai) ou 1 (Faux).
4. "short" : réponse courte en texte libre (1 à 3 mots). Pas d'"options". "correct" est une CHAÎNE (la réponse attendue, en minuscules).

Répartition indicative : ~50% mcq, ~20% mcq_multi, ~20% tf, ~10% short.

Règles :
- Chaque question doit être claire, non ambiguë, en français.
- Fournis TOUJOURS une "explanation" courte (1-2 phrases) qui aide à comprendre la réponse (sert d'indice ET de correction).
- Pour "mcq" et "mcq_multi", fournis 4 options pertinentes (A, B, C, D).
- Pour "short", la réponse attendue doit être EXACTEMENT ce que l'utilisateur taperait (1-3 mots).

Tu DOIS répondre UNIQUEMENT en JSON valide, avec ce format exact :
{"questions":[
  {"type":"mcq","text":"...","options":["A","B","C","D"],"correct":0,"explanation":"..."},
  {"type":"mcq_multi","text":"...","options":["A","B","C","D"],"correct":[0,2],"explanation":"..."},
  {"type":"tf","text":"...","options":["Vrai","Faux"],"correct":0,"explanation":"..."},
  {"type":"short","text":"...","correct":"mot","explanation":"..."}
]}`
        },
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
  } catch (e) {
    console.error('Erreur API IA :', e.message);
    res.status(502).json({ error: e.message });
  }
});

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

app.post('/api/quizzes', async (req, res) => {
  const { title, subject, questions } = req.body;
  if (!title || !questions || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Titre et questions requis.' });
  }
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        title: String(title).slice(0, 200),
        subject: String(subject || 'Général').slice(0, 200),
        questions: questions,
        created_by: req.user.id
      })
    });
    
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Erreur Supabase POST: ${err}`);
    }
    
    const data = await response.json();
    res.json({ quiz: data[0] });
  } catch (e) {
    console.error('Erreur POST quizzes:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/quizzes/:id', requireAdmin, async (req, res) => {
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes?id=eq.${req.params.id}`, {
      method: 'DELETE',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    if (!response.ok) throw new Error('Erreur Supabase DELETE');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(port, '0.0.0.0', () => console.log(`Serveur sur port ${port}`));
