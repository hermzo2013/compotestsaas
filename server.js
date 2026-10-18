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
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return res.status(401).json({ error: 'Session expirée.' });
    const user = await response.json();

    // ✅ Double vérification : app_metadata.is_admin OU email admin dans env
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const isAdmin =
      user.app_metadata?.is_admin === true ||
      user.app_metadata?.role === 'admin' ||
      Boolean(adminEmail && user.email?.toLowerCase() === adminEmail);

    req.user = { id: user.id, email: user.email, isAdmin };
    next();
  } catch (e) {
    console.error('Auth error:', e);
    return res.status(503).json({ error: 'Vérification indisponible.' });
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
      last_sign_in: u.last_sign_in_at,
      banned: u.banned_until && new Date(u.banned_until) > new Date(),
      name: u.user_metadata?.full_name || u.email.split('@')[0],
      isAdmin: u.app_metadata?.is_admin === true || u.app_metadata?.role === 'admin'
    }));
    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
// ALGORITHME V9 : EXTRACTION ROBUSTE (PDF APLATIS)
// ==========================================
function parseQuizText(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];

  // ---------- 1. NORMALISATION ----------
  let text = rawText
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\u00A0/g, ' ')                    // espaces insécables
    .replace(/\r\n?/g, '\n')
    .replace(/Page\s+\d+(\s*\/\s*\d+)?/gi, ' ') // "Page 3 / 12"
    .replace(/[ \t]+/g, ' ');                   // espaces multiples

  // Normaliser apostrophes typographiques
  text = text.replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"');

  // Ajouter un espace après "Q1." / "14." / "1)" quand il manque
  // Ex: "Q1.La" -> "Q1. La" ; "14.La" -> "14. La"
  text = text.replace(/(^|[\s\.\(])((?:Q\s*)?\d{1,3})\s*([\.\)])\s*(?=[A-ZÀ-Ýa-z])/gi, '$1$2$3 ');
  // Ajouter un espace après "A-" / "B." / "C)" quand il manque
  // Ex: "A-Un" -> "A- Un"
  text = text.replace(/(^|[\s])[\(\[]?([A-Ea-e])\s*([\.\)\-])\s*(?=[A-ZÀ-Ýa-z0-9])/g, (m, pre, letter, punct) => {
    // Éviter de casser des mots comme "M." "Dr." etc. (on ne touche qu'aux A-E isolés)
    return `${pre}${letter.toUpperCase()}${punct} `;
  });

  // ---------- 2. DÉTECTION DES CORRIGÉS ----------
  // Cherche des séquences du type "1B 2B 3A" ou "1-B 2-B 3-A" ou "1:B, 2:C"
  const answerKey = {};
  const gridRegex = /(\d{1,3})\s*[-:\.\)]?\s*([A-Ea-e])\b/g;
  // On ne retient que les zones qui ressemblent à une grille (>= 4 paires consécutives)
  const gridZones = [];
  let m;
  const allMatches = [];
  while ((m = gridRegex.exec(text)) !== null) {
    allMatches.push({ num: parseInt(m[1]), letter: m[2].toUpperCase(), index: m.index, len: m[0].length });
  }
  // Grouper les paires rapprochées (< 40 caractères d'écart)
  let group = [];
  for (let i = 0; i < allMatches.length; i++) {
    if (group.length === 0) { group.push(allMatches[i]); continue; }
    const prev = group[group.length - 1];
    if (allMatches[i].index - (prev.index + prev.len) < 40) group.push(allMatches[i]);
    else {
      if (group.length >= 4) gridZones.push(group);
      group = [allMatches[i]];
    }
  }
  if (group.length >= 4) gridZones.push(group);

  gridZones.forEach(zone => {
    zone.forEach(p => { answerKey[p.num] = p.letter; });
  });

  // ---------- 3. DÉTECTION DU TYPE GLOBAL (V/F ou QCM) ----------
  const lowerText = text.toLowerCase();
  const trueFalseHint =
    /cochez\s+(la\s+)?(case\s+)?[ab]\b/i.test(text) ||
    /cochez\s+a\s+pour\s+vra/i.test(text) ||
    /vrai\s*\/\s*faux/i.test(lowerText) ||
    /répondez\s+par\s+vrai\s+ou\s+faux/i.test(lowerText) ||
    /qcm\s*:\s*vrai\s+ou\s+faux/i.test(lowerText);

  // ---------- 4. DÉCOUPAGE EN BLOCS DE QUESTIONS ----------
  // On supprime le corrigé final pour ne pas polluer le découpage
  if (gridZones.length) {
    gridZones.forEach(zone => {
      const start = zone[0].index;
      const end = zone[zone.length - 1].index + zone[zone.length - 1].len;
      text = text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
    });
  }

  // Un "début de question" = Q1. | Q 1. | 1. | 1) | Q1:
  // Attention : on exige que ce soit précédé d'un début de texte, d'un point, ou d'un espace important.
  // Pour éviter de matcher "14" dans "COVID-19", on exige que le numéro soit <= 200.
  const questionSplitRegex = /(?<=^|[\s\.;:\)\]])(Q\s*\d{1,3}|\d{1,3})\s*[\.\):]\s+(?=[A-ZÀ-Ý"«])/gi;

  // On va parcourir le texte et noter les positions de début de question
  const starts = [];
  let matchQ;
  const scanRegex = /(?:^|[\s\.;:\)\]])(Q\s*\d{1,3}|\d{1,3})\s*[\.\):]\s+/gi;
  while ((matchQ = scanRegex.exec(text)) !== null) {
    const numStr = matchQ[1].replace(/\D/g, '');
    const num = parseInt(numStr, 10);
    if (num >= 1 && num <= 200) {
      const idx = matchQ.index + matchQ[0].indexOf(matchQ[1]);
      starts.push({ index: idx, num, fullMatchEnd: matchQ.index + matchQ[0].length });
    }
  }

  // Fusionner les doublons rapprochés (même numéro qui apparaît 2x)
  const cleanStarts = [];
  for (const s of starts) {
    if (cleanStarts.length === 0) { cleanStarts.push(s); continue; }
    const prev = cleanStarts[cleanStarts.length - 1];
    if (s.num === prev.num && s.index - prev.index < 200) continue; // doublon
    if (s.index - prev.index < 30) continue; // trop proche, faux positif
    cleanStarts.push(s);
  }

  const questions = [];
  for (let i = 0; i < cleanStarts.length; i++) {
    const start = cleanStarts[i];
    const end = i + 1 < cleanStarts.length ? cleanStarts[i + 1].index : text.length;
    let block = text.slice(start.fullMatchEnd, end).trim();
    if (!block) continue;

    // ---------- 5. SÉPARATION ÉNONCÉ / OPTIONS ----------
    // On cherche les marqueurs d'options : "A.", "A-", "A)", "(A)", "a)", etc.
    // Attention à ne pas confondre avec le "a" de "il a" : on exige A-E majuscule OU (A) OU A.
    const optionSplitRegex = /(?<=^|[\s\.;:])([\(\[]?[A-E][\.\)\-\]])\s+/g;
    const optMatches = [];
    let mo;
    while ((mo = optionSplitRegex.exec(block)) !== null) {
      optMatches.push({
        index: mo.index,
        end: mo.index + mo[0].length,
        letter: mo[1].replace(/[^A-Ea-e]/g, '').toUpperCase()
      });
    }

    // Garde-fou : il faut au moins 2 options consécutives lettres distinctes
    // pour considérer que la question est un QCM
    let validOptions = [];
    if (optMatches.length >= 2) {
      // Vérifier que les lettres sont croissantes (A, B, C, D...) au moins au début
      // Sinon on considère que ce ne sont pas des options
      const letters = optMatches.map(o => o.letter);
      const firstLetters = letters.slice(0, 4);
      const expected = ['A', 'B', 'C', 'D'];
      let ok = true;
      for (let k = 0; k < Math.min(firstLetters.length, expected.length); k++) {
        if (firstLetters[k] !== expected[k]) { ok = false; break; }
      }
      if (ok && optMatches.length >= 2) {
        validOptions = optMatches;
      }
    }

    let qText, options;

    if (validOptions.length >= 2) {
      // QCM : on découpe
      qText = block.slice(0, validOptions[0].index).trim();
      options = [];
      for (let k = 0; k < validOptions.length; k++) {
        const optStart = validOptions[k].end;
        const optEnd = k + 1 < validOptions.length ? validOptions[k + 1].index : block.length;
        let optText = block.slice(optStart, optEnd).trim();
        optText = optText.replace(/[;\.]+$/, '').trim();
        if (optText) options.push(optText);
      }
    } else {
      // Pas d'options → Vrai/Faux par défaut
      qText = block.trim();
      options = ['Vrai', 'Faux'];
    }

    // ---------- 6. NETTOYAGE FINAL ----------
    qText = qText
      .replace(/\s+/g, ' ')
      .replace(/^[\-–—\.\s]+/, '')
      .replace(/[\s;]+$/, '')
      .trim();

    if (qText.length < 5) continue;

    // ---------- 7. CORRIGÉ ----------
    let correct = 0;
    let type = options.length === 2 && options[0] === 'Vrai' ? 'tf' : 'mcq';

    if (answerKey[start.num]) {
      const letter = answerKey[start.num]; // 'A', 'B', 'C'...
      if (type === 'tf') {
        // A = Vrai (0), B = Faux (1)
        correct = letter === 'A' ? 0 : 1;
      } else {
        const idx = letter.charCodeAt(0) - 65;
        if (idx >= 0 && idx < options.length) correct = idx;
      }
    } else if (trueFalseHint && options.length === 2) {
      type = 'tf';
    }

    questions.push({
      number: start.num,
      text: qText,
      options,
      correct,
      type
    });
  }

  // Si on n'a trouvé aucune question avec la méthode principale,
  // on tente une méthode de secours : chercher "Q1." explicitement
  if (questions.length === 0) {
    return fallbackParse(rawText);
  }

  return questions;
}

// Méthode de secours ultra-simple si la principale échoue
function fallbackParse(rawText) {
  const text = rawText.replace(/\s+/g, ' ');
  const parts = text.split(/(?=Q\s*\d{1,3}\s*[\.\):])/i).filter(p => p.trim());
  const questions = [];
  parts.forEach((p, i) => {
    const m = p.match(/^Q\s*(\d{1,3})\s*[\.\):]\s*(.*)/i);
    if (!m) return;
    const content = m[2].trim();
    if (content.length < 5) return;
    const optParts = content.split(/(?=[A-D][\.\)\-]\s)/i);
    let qText = optParts[0].trim();
    let options = optParts.slice(1).map(o => o.replace(/^[A-D][\.\)\-]\s*/i, '').trim()).filter(Boolean);
    const type = options.length >= 2 ? 'mcq' : 'tf';
    if (type === 'tf') options = ['Vrai', 'Faux'];
    questions.push({
      number: parseInt(m[1]),
      text: qText,
      options,
      correct: 0,
      type
    });
  });
  return questions;
}

// ==========================================
// ROUTES QUIZ
// ==========================================
app.post('/api/parse-existing-quiz', (req, res) => {
  try {
    const questions = parseQuizText(req.body?.text || '');
    if (!questions.length) {
      return res.json({ questions: [], message: 'Aucune question reconnue dans le texte.' });
    }
    res.json({ questions });
  } catch (e) {
    console.error('parse error:', e);
    res.status(500).json({ error: e.message });
  }
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
          content: `Génère ${count} questions en FRANÇAIS (QCM, V/F). Format strict: {"questions":[{"type":"mcq","text":"...","options":["A","B"],"correct":0,"explanation":"..."}]}`
        },
        { role: 'user', content: String(text || '').slice(0, 15000) }
      ]
    });
    res.json(JSON.parse(response.choices[0].message.content));
  } catch (e) {
    console.error('AI error:', e);
    res.status(502).json({ error: e.message });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`Serveur sur port ${port}`));
