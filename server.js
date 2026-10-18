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

// ... (Le middleware d'authentification et les routes Admin restent identiques) ...
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
    req.user = { id: user.id, email: user.email, isAdmin: Boolean(adminEmail && user.email.toLowerCase() === adminEmail) };
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
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.msg || body.message || 'Erreur Supabase Admin');
  return body;
}

app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  try {
    const data = await supabaseAdmin('users?page=1&per_page=100');
    const users = (data.users || []).map(u => ({
      id: u.id, email: u.email, created_at: u.created_at, last_sign_in: u.last_sign_in_at, banned: u.banned_until && new Date(u.banned_until) > new Date(), name: u.user_metadata?.full_name || u.email.split('@')[0]
    }));
    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  try {
    const user = await supabaseAdmin('users', { method: 'POST', body: JSON.stringify({ email, password: req.body.password, email_confirm: true, app_metadata: { compotest_access: true }, user_metadata: { full_name: req.body.name || email.split('@')[0] } }) });
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  try { await supabaseAdmin(`users/${req.params.id}`, { method: 'PUT', body: JSON.stringify({ password: req.body.password }) }); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
  try { await supabaseAdmin(`users/${req.params.id}`, { method: 'PUT', body: JSON.stringify({ ban_duration: req.body.banned ? '876000h' : 'none' }) }); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try { await supabaseAdmin(`users/${req.params.id}`, { method: 'DELETE' }); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// IA
function aiClient() {
  if (!process.env.AI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.AI_API_KEY, baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1', timeout: 120000 });
}
const modelName = () => process.env.AI_MODEL || 'openai/gpt-oss-20b';

// ==========================================
// ALGORITHME V9 : MACHINE À ÉTATS
// ==========================================
function parseQuizText(text) {
  // Nettoyage basique
  let clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').replace(/Page\s+\d+/gi, ' ');
  // Ajout d'espaces pour séparer les Q, les numéros et les options
  clean = clean.replace(/((?:Q\s*)?\d{1,3}[\.\)])([A-ZÀ-Ýa-z])/gi, '$1 $2');
  clean = clean.replace(/([A-D][\.\)\-])([A-ZÀ-Ýa-z])/gi, '$1 $2');

  let questions = [];
  // On sépare en blocs de texte pour analyser ligne par ligne
  let lines = clean.split('\n');
  let currentMode = 'UNKNOWN'; // 'TF', 'QCM', ou 'UNKNOWN'
  let currentQ = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;

    // 1. DÉTECTION DE LA CONSIGNE (Machine à états)
    if (/QCD|Cochez A pour les.*VRAIES|Ecrire A pour les.*VRAIES/i.test(line)) {
      currentMode = 'TF';
      continue;
    }
    if (/QCM|Cochez les bonnes réponses|choix multiples/i.test(line)) {
      currentMode = 'QCM';
      continue;
    }

    // 2. DÉTECTION DU DÉBUT D'UNE QUESTION
    const qMatch = line.match(/^(?:Q\s*)?(\d{1,3})[\.\)]\s(.*)/i);
    if (qMatch) {
      if (currentQ) questions.push(currentQ); // Sauvegarde la question précédente
      
      let qText = qMatch[2];
      let options = [];
      
      // On cherche si des options sont collées sur la même ligne (ex: A. texte B. texte)
      let parts = qText.split(/(?=\s[A-D][\.\)\-]\s)/i);
      qText = parts[0].trim();
      if (parts.length > 1) {
        for (let j = 1; j < parts.length; j++) {
          options.push(parts[j].replace(/^\s*[A-D][\.\)\-]\s/i, '').trim());
        }
      }

      currentQ = {
        number: parseInt(qMatch[1]),
        text: qText,
        options: options,
        correct: 0, 
        type: currentMode === 'TF' ? 'tf' : 'mcq' // Par défaut selon la consigne
      };
      continue;
    }

    // 3. DÉTECTION DES OPTIONS (si on est déjà dans une question)
    if (currentQ) {
      const optMatch = line.match(/^([A-D])[\.\)\-]\s(.*)/i);
      if (optMatch) {
        currentQ.options.push(optMatch[2].trim());
      } else if (/Vrai|Faux/i.test(line) && currentQ.options.length === 0) {
        // Si c'est une ligne avec juste Vrai/Faux
        currentQ.options = ['Vrai', 'Faux'];
        currentQ.type = 'tf';
      } else {
        // C'est la suite du texte de la question
        currentQ.text += ' ' + line;
      }
    }
  }
  if (currentQ) questions.push(currentQ);

  // 4. NETTOYAGE FINAL ET ATTRIBUTION DES TYPES
  questions.forEach(q => {
    // Si on a trouvé des options A, B, C, on force le type QCM
    if (q.options.length >= 2) {
      q.type = 'mcq';
    } 
    // Si la consigne était Vrai/Faux mais qu'on n'a pas d'options, on met Vrai/Faux
    else if (q.type === 'tf') {
      q.options = ['Vrai', 'Faux'];
    } 
    // Fallback si on a rien trouvé
    else {
      q.type = 'short';
      q.options = [];
    }
  });

  // 5. CORRIGÉ
  const gridMatch = text.match(/(?:1\s*[-:]?\s*[A-D][\s\n]*){3,}/i);
  if (gridMatch) {
    const answers = {};
    const pairs = gridMatch[0].match(/(\d{1,3})\s*[-:]?\s*([A-D])/gi);
    if(pairs) pairs.forEach(p => { const m = p.match(/(\d{1,3})\s*[-:]?\s*([A-D])/i); if(m) answers[parseInt(m[1])] = m[2].toUpperCase(); });
    questions.forEach(q => {
      if (answers[q.number] && q.type === 'mcq') {
        const optIndex = answers[q.number].charCodeAt(0) - 65;
        if (optIndex >= 0 && optIndex < q.options.length) q.correct = optIndex;
      }
    });
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
