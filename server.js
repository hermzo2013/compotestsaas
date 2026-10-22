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

// ==========================================
// AUTHENTIFICATION & ADMIN
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

  if (!firstName || !lastName) return res.status(400).json({ error: 'Nom et prénom requis.' });
  if (!email) {
    const slug = `${firstName}.${lastName}`.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9.]/g, '');
    email = `${slug}@comptest.local`;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email invalide.' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 min).' });

  try {
    const fullName = `${firstName} ${lastName}`;
    const user = await supabaseAdmin('users', {
      method: 'POST',
      body: JSON.stringify({
        email, password, email_confirm: true,
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
  return new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
    timeout: 120000
  });
}
const modelName = () => process.env.AI_MODEL || 'openai/gpt-oss-20b';

// ==========================================
// FONCTION UNIVERSELLE D'EXTRACTION DE QUIZ
// ==========================================
// Pipeline en 4 étapes :
//   1. Nettoyage et normalisation
//   2. Extraction du corrigé (grille de réponses)
//   3. Découpage intelligent (tokenisation des questions + options)
//   4. Assemblage et détection du type
// ==========================================
function parseQuizText(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];

  // ==========================================
  // ÉTAPE 1 : NETTOYAGE ET NORMALISATION
  // ==========================================
  let text = rawText
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  text = text
    .replace(/EVALUATION\s+DE\s+SANTE\s+PUBLIQUE/gi, '')
    .replace(/Cible\s*:.*$/gim, '')
    .replace(/Temps\s*:.*$/gim, '')
    .replace(/Instruction\s*:.*$/gim, '')
    .replace(/Barème\s*:.*$/gim, '')
    .replace(/={2,}\s*Page\s*\d+\s*={2,}/gi, '')
    .replace(/Page\s+\d+(\s*\/\s*\d+)?/gi, '');

  // ==========================================
  // ÉTAPE 2 : EXTRACTION DU CORRIGÉ (GRILLE DE RÉPONSES)
  // ==========================================
  const answerKey = {};

  // --- Format "Q<num> <réponse>" (moderne) ---
  const modernGridRegex = /Q\s*(\d{1,3})\s+(VRAI|FAUX|TRUE|FALSE|[A-Ea-e](?:\s*[\s\.\,;]\s*[A-Ea-e])*)/gi;
  let mGrid;
  while ((mGrid = modernGridRegex.exec(rawText)) !== null) {
    const qNum = parseInt(mGrid[1]);
    const val = mGrid[2].trim().toUpperCase();
    registerAnswer(answerKey, qNum, val);
  }

  // --- Format "1A 2B 3C" (classique) ou "1-A", "1:A", "(1)A" ---
  const classicGridRegex = /(?:\(|\[)?\b(\d{1,3})\b(?:\)|\])?\s*[\-:\.]?\s*([A-Ea-e])\b/g;
  const classicMatches = [];
  let mClassic;
  while ((mClassic = classicGridRegex.exec(rawText)) !== null) {
    classicMatches.push({
      num: parseInt(mClassic[1]),
      letter: mClassic[2].toUpperCase(),
      index: mClassic.index,
      len: mClassic[0].length
    });
  }

  // Filtre : garder uniquement les séquences adjacentes (au moins 4 paires)
  const zones = [];
  let zone = [];
  for (let i = 0; i < classicMatches.length; i++) {
    const cur = classicMatches[i];
    if (zone.length === 0) { zone.push(cur); continue; }
    const prev = zone[zone.length - 1];
    if (cur.index - (prev.index + prev.len) < 40 && cur.num >= prev.num && cur.num <= prev.num + 3) {
      zone.push(cur);
    } else {
      if (zone.length >= 4) zones.push(zone);
      zone = [cur];
    }
  }
  if (zone.length >= 4) zones.push(zone);

  zones.forEach(z => {
    z.forEach(item => {
      if (!answerKey[item.num]) answerKey[item.num] = { type: null, correct: null };
      const cur = answerKey[item.num];
      const idx = item.letter.charCodeAt(0) - 65;
      if (cur.correct === null) cur.correct = idx;
      else if (Array.isArray(cur.correct)) { if (!cur.correct.includes(idx)) cur.correct.push(idx); }
      else if (cur.correct !== idx) cur.correct = [cur.correct, idx].sort((a,b)=>a-b);
    });
  });

  function registerAnswer(map, num, val) {
    if (!map[num]) map[num] = { type: null, correct: null };
    const entry = map[num];
    if (val === 'VRAI' || val === 'TRUE') { entry.type = 'tf'; entry.correct = 0; return; }
    if (val === 'FAUX' || val === 'FALSE') { entry.type = 'tf'; entry.correct = 1; return; }
    const letters = val.match(/[A-E]/g);
    if (letters) {
      const indices = letters.map(l => l.charCodeAt(0) - 65);
      entry.type = indices.length > 1 ? 'mcq_multi' : 'mcq';
      entry.correct = indices.length > 1 ? indices.sort((a,b)=>a-b) : indices[0];
    }
  }

  // ==========================================
  // ÉTAPE 3 : DÉCOUPAGE INTELLIGENT (TOKENISATION)
  // ==========================================
  const questionStartPatterns = [
    /(?:^|\n)\s*(?:Q(?:uestion)?|Item|N[°o]\.?|#)\s*(\d{1,3})\s*[:\.\)\-]?\s+/gi,
    /(?:^|\n)\s*[A-Z]+[\-\.]\d+(?:[\-\.][A-Z0-9]+)*\s*[:\.\)]?\s+/gi,
    /(?:^|\n)\s*[\(\[]?(\d{1,4})[\)\]]?\s*[:\.\)\-]\s+/gi,
    /(?:^|\n)\s*(\d{1,3})(?:er|°|[①-⑳]|[❶-❿])\s*[\.\):\-]?\s+/gi,
    /(?:^|\n)\s*[\(\[]?([IVX]+)[\)\]]?\s*[\.\):\-]\s+/gi,
    /(?:^|\n)\s*[\(\[]?((?:\d{1,2}|[IVX]{1,4}|[A-Z])(?:[\-\.][A-Z0-9]{1,3}){1,4})[\)\]]?\s*[\.\):\-]\s+/gi
  ];

  const starts = [];
  questionStartPatterns.forEach(re => {
    let m;
    while ((m = re.exec(text)) !== null) {
      const rawNum = m[1];
      let num;
      if (/^\d+$/.test(rawNum)) num = parseInt(rawNum, 10);
      else if (/^[IVX]+$/.test(rawNum)) num = romanToInt(rawNum);
      else if (/^[A-Za-z]$/.test(rawNum)) num = rawNum.toUpperCase().charCodeAt(0) - 64;
      else num = starts.length + 1;
      starts.push({ index: m.index, contentStart: m.index + m[0].length, num });
    }
  });

  starts.sort((a, b) => a.index - b.index || a.contentStart - b.contentStart);
  const uniqueStarts = [];
  let lastEnd = -1;
  starts.forEach(s => {
    if (s.contentStart <= lastEnd) return;
    if (s.index < lastEnd) return;
    uniqueStarts.push(s);
    lastEnd = s.contentStart;
  });

  const questions = [];
  for (let i = 0; i < uniqueStarts.length; i++) {
    const start = uniqueStarts[i];
    const end = (i + 1 < uniqueStarts.length) ? uniqueStarts[i + 1].index : text.length;
    let block = text.slice(start.contentStart, end).trim();
    if (!block) continue;

    if (/^[\s\dA-E\|\.,;]+$/i.test(block)) continue;
    if (block.replace(/[^a-zA-Z]/g, '').length < 5) continue;

    // Séparation énoncé / options
    const optionMarkers = [
      /(?:^|\n|\s)[\(\[]?([A-Ea-e])[\)\]]?\s*[\.\):\-]\s+/g,
      /(?:^|\n|\s)([ⓐ-ⓩⒶ-Ⓩ])\s+/g,
      /(?:^|\n|\s)([①-⑳])\s+/g,
      /(?:^|\n|\s)([☐□○◯])\s*/g
    ];

    const optionMatches = [];
    optionMarkers.forEach(re => {
      let m;
      while ((m = re.exec(block)) !== null) {
        optionMatches.push({ index: m.index, end: m.index + m[0].length, marker: m[1] });
      }
    });
    optionMatches.sort((a, b) => a.index - b.index);

    const validOptions = [];
    let expectedCode = 65;
    optionMatches.forEach(om => {
      const code = (om.marker && om.marker.length === 1) ? om.marker.charCodeAt(0) : 0;
      if (validOptions.length === 0 || code === 0 || code === expectedCode) {
        validOptions.push(om);
        if (code === expectedCode) expectedCode++;
      }
    });

    let qText = block;
    let options = [];

    if (validOptions.length >= 2) {
      qText = block.slice(0, validOptions[0].index).trim();
      for (let j = 0; j < validOptions.length; j++) {
        const s = validOptions[j].end;
        const e = (j + 1 < validOptions.length) ? validOptions[j + 1].index : block.length;
        let optText = block.slice(s, e).trim().replace(/^[\-–—\s]+/, '').replace(/[;\.]+$/, '').trim();
        if (optText) options.push(optText);
      }
    }

    if (options.length === 0 && /\b(vrai|faux|oui|non|exact|inexact)\b/i.test(qText)) {
      options = ['Vrai', 'Faux'];
    }

    qText = qText.replace(/\s+/g, ' ').replace(/^[\-–—\.\s]+/, '').trim();
    if (qText.length < 5) continue;

    // Détection du type
    let type = options.length > 0 ? 'mcq' : 'tf';
    if (options.length === 2) {
      const o0 = options[0].toLowerCase();
      const o1 = options[1].toLowerCase();
      if ((o0.includes('vrai') && o1.includes('faux')) ||
          (o0.includes('oui') && o1.includes('non')) ||
          (o0.includes('exact') && o1.includes('inexact'))) {
        type = 'tf';
        options = ['Vrai', 'Faux'];
      }
    }

    let correct = 0;
    if (answerKey[start.num]) {
      const entry = answerKey[start.num];
      if (entry.type) type = entry.type;
      if (entry.correct !== null) correct = entry.correct;
    } else if (options.length > 2) {
      type = 'mcq_multi';
      correct = [0];
    }

    if (type === 'mcq_multi' && !Array.isArray(correct)) correct = [correct];
    if (type !== 'mcq_multi' && Array.isArray(correct)) correct = correct[0] ?? 0;

    questions.push({
      number: start.num,
      text: qText,
      options: options.length > 0 ? options : ['Vrai', 'Faux'],
      correct: correct,
      type: type
    });
  }

  return questions;
}

// Convertit un chiffre romain en entier
function romanToInt(str) {
  const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let result = 0;
  const s = str.toUpperCase();
  for (let i = 0; i < s.length; i++) {
    const cur = map[s[i]];
    const next = map[s[i + 1]];
    if (next && cur < next) result -= cur;
    else result += cur;
  }
  return result || 0;
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

// ==========================================
// ROUTES API QUIZ
// ==========================================
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

Tu DOIS répartir les questions entre CES 4 TYPES :
1. "mcq" : question à choix unique. "correct" est un ENTIER.
2. "mcq_multi" : QCM avec PLUSIEURS bonnes réponses. "correct" est un TABLEAU d'entiers.
3. "tf" : Vrai/Faux. "options" = ["Vrai", "Faux"]. "correct" = 0 ou 1.
4. "short" : réponse courte (1 à 3 mots). Pas d'"options". "correct" est une CHAÎNE.

Répartition : ~50% mcq, ~20% mcq_multi, ~20% tf, ~10% short.
Fournis TOUJOURS une "explanation" courte.
Réponds UNIQUEMENT en JSON valide :
{"questions":[{"type":"mcq","text":"...","options":["A","B","C","D"],"correct":0,"explanation":"..."}]}`
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

// ==========================================
// ROUTES BIBLIOTHÈQUE (Supabase REST)
// ==========================================
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

app.put('/api/quizzes/:id', requireAdmin, async (req, res) => {
  const { questions } = req.body;
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Tableau de questions requis.' });
  }
  try {
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/rest/v1/quizzes?id=eq.${req.params.id}`, {
      method: 'PATCH',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ questions })
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Erreur Supabase PATCH: ${err}`);
    }
    const data = await response.json();
    res.json({ quiz: data[0] });
  } catch (e) {
    console.error('Erreur PUT quizzes:', e.message);
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
