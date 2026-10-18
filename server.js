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
app.get('/api/health', (_req, res) => res.json({
  ok: true,
  aiConfigured: Boolean(process.env.AI_API_KEY),
  authConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
  adminConfigured: Boolean(process.env.ADMIN_EMAIL && process.env.SUPABASE_SERVICE_ROLE_KEY),
  aiModel: process.env.AI_MODEL || 'openai/gpt-oss-20b'
}));

async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Connecte-toi à CompoTest.' });
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
  if (!response.ok) throw new Error(body.msg || body.message || `Supabase Admin (${response.status})`);
  return body;
}

app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  try {
    const data = await supabaseAdmin('users?page=1&per_page=100');
    const users = (data.users || []).map(u => ({
      id: u.id, email: u.email || '', created_at: u.created_at, last_sign_in_at: u.last_sign_in_at,
      email_confirmed_at: u.email_confirmed_at, banned_until: u.banned_until,
      is_admin: String(u.email || '').toLowerCase() === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()
    }));
    res.json({ users });
  } catch (error) { res.status(502).json({ error: 'Impossible de charger les comptes.' }); }
});
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Adresse invalide.' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court.' });
  try {
    const user = await supabaseAdmin('users', { method: 'POST', body: JSON.stringify({
      email, password, email_confirm: true,
      app_metadata: { compotest_access: true, role: 'user' },
      user_metadata: { full_name: String(req.body?.name || '').trim().slice(0, 100) }
    }) });
    res.status(201).json({ user: { id: user.id, email: user.email } });
  } catch (error) { res.status(502).json({ error: 'Création impossible.' }); }
});
app.patch('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  try {
    await supabaseAdmin(`users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ ban_duration: req.body?.banned ? '876000h' : 'none' }) });
    res.json({ ok: true });
  } catch (error) { res.status(502).json({ error: 'Modification impossible.' }); }
});
app.patch('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  try {
    await supabaseAdmin(`users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ password: req.body?.password }) });
    res.json({ ok: true });
  } catch (error) { res.status(502).json({ error: 'Modification impossible.' }); }
});
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    await supabaseAdmin(`users/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (error) { res.status(502).json({ error: 'Suppression impossible.' }); }
});

const usage = new Map();
function underDailyLimit(req, res, next) {
  const limit = 50;
  const day = new Date().toISOString().slice(0, 10);
  const key = `${req.user.id}:${day}:${req.path}`;
  const used = usage.get(key) || 0;
  if (used >= limit) return res.status(429).json({ error: `Limite atteinte (${limit}/jour).` });
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
const modelName = () => process.env.AI_MODEL || 'openai/gpt-oss-20b';

function sanitizeText(text) {
  if (!text) return '';
  let t = String(text);
  t = t.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return t.trim();
}

// ==========================================
// LE CŒUR DE LA GÉNÉRATION "POST-TEST"
// ==========================================
app.post('/api/analyze-course', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA non configurée.' });
  
  const { subject = 'Matière', title = 'Cours', sourceText, count = 20 } = req.body || {};
  const text = sanitizeText(String(sourceText || '').trim());
  const n = Math.min(Number(count) || 20, 40);

  if (text.length < 100) return res.status(400).json({ error: 'Texte trop court.' });

  console.log(`[analyze] Début pour ${n} questions sur ${text.length} caractères.`);

  try {
    // ÉTAPE 1 : On extrait d'abord une liste structurée de concepts.
    // C'est ce qui empêche l'IA de recopier, car elle doit remplir un format.
    console.log('[analyze] Étape 1 : Extraction des concepts...');
    const extractionPrompt = `Analyse ce cours de "${subject}" et extrais les 20 à 30 concepts les plus importants.
    Pour chaque concept, donne une définition courte et précise (2 phrases max).
    Format JSON strict :
    {"concepts": [{"terme": "Nom du concept", "definition": "Définition claire"}]}`;

    const extractRes = await client.chat.completions.create({
      model: modelName(), temperature: 0.1, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: extractionPrompt },
        { role: 'user', content: text.slice(0, 25000) } // On limite pour ne pas surcharger
      ]
    });

    let concepts = [];
    try {
      const parsed = JSON.parse(extractRes.choices[0].message.content);
      concepts = parsed.concepts || [];
    } catch (e) { throw new Error("Format d'extraction invalide"); }

    if (concepts.length === 0) throw new Error("Aucun concept trouvé dans le cours.");
    console.log(`[analyze] ${concepts.length} concepts extraits.`);

    // ÉTAPE 2 : On génère les questions À PARTIR des concepts extraits (pas du texte brut).
    console.log('[analyze] Étape 2 : Génération du quiz (Post-Test)...');
    const generationPrompt = `Tu es un professeur qui crée un POST-TEST pour ses élèves à partir de la liste de concepts fournie.
    
    RÈGLES STRICTES :
    1. Tu ne dois JAMAIS copier le texte du cours. Tu dois formuler des questions claires.
    2. Types de questions : 40% "mcq" (QCM), 30% "mcq_multi" (QCM à choix multiples), 30% "tf" (Vrai/Faux).
    3. Pour les QCM, les 3 mauvaises réponses doivent être des concepts VOISINS issus de la liste.
    4. Pour les Vrai/Faux, la proposition fausse doit être subtile (changer un mot, inverser une cause).
    5. Ajoute une explication pédagogique pour chaque réponse.
    
    Format JSON strict :
    {"questions": [
      {"type": "mcq", "text": "Question ?", "options": ["A", "B", "C", "D"], "correct": 0, "explanation": "Pourquoi"},
      {"type": "mcq_multi", "text": "Question ?", "options": ["A", "B", "C", "D"], "correct": [0, 2], "explanation": "Pourquoi"},
      {"type": "tf", "text": "Affirmation.", "options": [], "correct": true, "explanation": "Pourquoi"}
    ]}`;

    const generateRes = await client.chat.completions.create({
      model: modelName(), temperature: 0.4, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: generationPrompt },
        { role: 'user', content: `Voici les concepts du cours : ${JSON.stringify(concepts)}. Génère exactement ${n} questions.` }
      ]
    });

    const parsedGen = JSON.parse(generateRes.choices[0].message.content);
    const rawQuestions = parsedGen.questions || [];

    // ÉTAPE 3 : Nettoyage final et formatage pour l'interface
    const questions = rawQuestions.map((q, i) => ({
      id: `posttest-${Date.now()}-${i}`,
      number: i + 1,
      type: q.type,
      text: q.text,
      options: q.options || [],
      correct: q.correct,
      explanation: q.explanation || 'Explication non fournie.',
      sourceExcerpt: 'Généré à partir des concepts du cours',
      source: 'ai-posttest',
      verified: true
    }));

    console.log(`[analyze] ✅ Post-Test prêt : ${questions.length} questions.`);
    res.json({ questions, concepts, coverage: `${questions.length}/${n}`, model: modelName() });

  } catch (error) {
    console.error('[analyze] Erreur:', error.message);
    res.status(502).json({ error: 'Génération échouée : ' + error.message });
  }
});

// Route pour répondre aux questions (si l'IA doit deviner les réponses d'un texte)
app.post('/api/answer-questions', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA désactivée.' });
  const { subject = 'Matière', questions } = req.body || {};
  if (!Array.isArray(questions) || !questions.length) return res.status(400).json({ error: 'Aucune question.' });

  try {
    const response = await client.chat.completions.create({
      model: modelName(), temperature: 0.1, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Réponds aux questions. JSON : {"answers":[{"id":"...","correct":...,"explanation":"..."}]}. mcq=index, mcq_multi=tableau, tf=booléen.` },
        { role: 'user', content: JSON.stringify({ subject, questions }) }
      ]
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    res.json({ answers: parsed.answers || [] });
  } catch (error) {
    res.status(502).json({ error: 'Échec.' });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`Serveur sur port ${port}`));
