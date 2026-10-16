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
  } catch (error) { res.status(error.status || 502).json({ error: 'Impossible de charger les comptes.' }); }
});
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Adresse invalide.' });
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
    await supabaseAdmin(`users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ password }) });
    res.json({ ok: true });
  } catch (error) { res.status(error.status || 502).json({ error: 'Modification impossible.' }); }
});
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'ID invalide.' });
  try {
    await supabaseAdmin(`users/${encodeURIComponent(id)}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (error) { res.status(error.status || 502).json({ error: 'Suppression impossible.' }); }
});

const usage = new Map();
function underDailyLimit(req, res, next) {
  const limit = 100;
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
    timeout: 60000,
    maxRetries: 1
  });
}
const modelName = () => process.env.AI_MODEL || 'openai/gpt-oss-20b';

// Sanitize texte
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
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// Vérifie que le texte est bien une VRAIE question
function estVraieQuestion(txt) {
  if (!txt || txt.length < 15) return false;
  const t = String(txt).trim();

  // Doit finir par "?" OU commencer par une amorce
  const finitParQuestion = /\?\s*$/.test(t);
  const commenceParAmorce = /^(Complétez|Cochez|Indiquez|Vrai ou Faux|Quel|Quelle|Quels|Quelles|Que|Qui|Où|Quand|Comment|Pourquoi|Combien|Parmi|Identifiez|Sélectionnez|Choisissez|Lequel|Laquelle|Lesquels|Lesquelles|Définissez|Citez|Donnez|Expliquez|Nommez|Associez)\b/i.test(t);

  if (!finitParQuestion && !commenceParAmorce) return false;

  // Rejeter si ça ressemble à une recopie (ex : commence par "Définition", "Résumé", "Introduction")
  if (/^(Définition|Introduction|Résumé|Conclusion|Structure|Fonction|Description|Notion|Concept|Conditions|Modalités|Voies|Exemple|Remarque)\s/i.test(t)) return false;

  // Rejeter si ça contient des ":" multiples (recopie de définition)
  const colonCount = (t.match(/:/g) || []).length;
  if (colonCount >= 2 && !finitParQuestion) return false;

  // Rejeter si c'est juste une phrase déclarative longue
  if (t.length > 200 && !finitParQuestion) return false;

  return true;
}

// Rejeter si c'est une recopie du cours
function estRecopiage(questionText, coursText) {
  if (!questionText || !coursText) return false;
  const q = String(questionText).toLowerCase().trim().slice(0, 100);
  const c = String(coursText).toLowerCase();
  // Si les 60 premiers caractères de la question apparaissent tels quels dans le cours
  if (q.length < 30) return false;
  const snippet = q.slice(0, 60);
  if (c.includes(snippet)) return true;
  // Ou si la question n'a ni "?" ni amorce
  if (!/\?/.test(questionText) && !/^(Quel|Quelle|Que|Comment|Pourquoi|Combien|Vrai|Faux|Complétez|Cochez|Indiquez|Parmi|Identifiez|Définissez|Citez|Donnez|Nommez)/i.test(questionText)) return true;
  return false;
}

// ============ GÉNÉRATION D'UNE SEULE QUESTION ============
async function generateOneQuestion(client, context, usedTopics) {
  const { text, subject, desiredType, concepts } = context;

  // Extrait un passage aléatoire du cours pour cette question
  const passages = text.split(/\n\n+/).filter(p => p.trim().length > 100);
  if (!passages.length) return null;
  const passage = passages[Math.floor(Math.random() * passages.length)];

  // Extrait 2-3 concepts comme contexte
  const conceptsList = concepts.slice(0, 15).map(c => `- ${c.concept} : ${c.detail}`).join('\n');

  const typeInstructions = {
    mcq: `Type "mcq" : QCM à 4 options, UNE seule correcte.
- "options" : 4 chaînes de caractères
- "correct" : index de la bonne option (0 à 3)`,
    mcq_multi: `Type "mcq_multi" : QCM à 4 options, au moins 2 correctes.
- "options" : 4 chaînes de caractères
- "correct" : tableau d'au moins 2 indices (ex. [0, 2])`,
    tf: `Type "tf" : Vrai ou Faux.
- "options" : []
- "correct" : true ou false
- IMPORTANT : la version FAUSSE doit être une variation subtile du cours (mot changé, chiffre inversé), JAMAIS absurde`,
    cloze: `Type "cloze" : Texte à trous.
- "text" : une phrase du cours avec UN mot remplacé par "____"
- "options" : []
- "correct" : le mot manquant`
  };

  const systemPrompt = `Tu es un générateur de questions de quiz. Tu produis UNE SEULE question à la fois au format JSON.

⚠️ INTERDICTION ABSOLUE DE RECOPIER LE COURS ⚠️
Le champ "text" doit être une VRAIE QUESTION, PAS une phrase du cours recopiée.

❌ INTERDIT :
- "L'immunité repose sur : Reconnaissance et tolérance du soi."
- "Immunogénicité: Capacité d'un Ag à induire une RI."
- "Définition Les anticorps sont..."

✅ OBLIGATOIRE :
- "Sur quoi repose le concept d'immunité ?"
- "Que désigne le terme immunogénicité ?"
- "Complétez : Les anticorps sont des ____ appelées immunoglobulines."
- "Vrai ou Faux : L'immunogénicité désigne l'absence de réponse immunitaire."

RÈGLE DE FORME :
Le champ "text" DOIT :
- soit finir par " ?"
- soit commencer par : Quel/Quelle/Quels/Quelles, Que, Comment, Pourquoi, Combien, Vrai ou Faux, Complétez, Cochez, Indiquez, Parmi, Identifiez, Définissez, Citez, Donnez, Nommez, Associez

Tu ne génères QU'UNE SEULE question.

${typeInstructions[desiredType]}

Le champ "explanation" justifie la réponse (1-2 phrases).
Le champ "source_excerpt" cite la phrase du cours dont vient la question.

FORMAT JSON STRICT (rien d'autre, pas de texte avant/après) :
{"question":{"type":"${desiredType}","text":"...","options":[...],"correct":...,"explanation":"...","source_excerpt":"..."}}`;

  const response = await client.chat.completions.create({
    model: modelName(),
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Matière : ${subject}

Passage du cours (source pour cette question) :
"""
${passage.slice(0, 2500)}
"""

Liste des concepts déjà extraits du cours (pour référence) :
${conceptsList}

Génère UNE SEULE question de type "${desiredType}".` }
    ]
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    const q = parsed.question;
    if (!q || !q.text) return null;

    // VALIDATION STRICTE
    if (!estVraieQuestion(q.text)) {
      console.log(`[generateOne] ❌ Question rejetée (forme) : "${String(q.text).slice(0, 80)}..."`);
      return null;
    }
    if (estRecopiage(q.text, text)) {
      console.log(`[generateOne] ❌ Question rejetée (recopiage) : "${String(q.text).slice(0, 80)}..."`);
      return null;
    }

    // Vérifie le type
    if (q.type !== desiredType) return null;

    // Valide selon le type
    const options = Array.isArray(q.options) ? q.options.slice(0, 6).map(x => String(x).slice(0, 500)) : [];
    let correct = q.correct;
    if (desiredType === 'tf') { if (typeof correct !== 'boolean') return null; }
    else if (desiredType === 'cloze') { if (typeof correct !== 'string' || !correct.trim()) return null; }
    else if (desiredType === 'mcq') { if (!Number.isInteger(correct) || correct < 0 || correct >= options.length || options.length < 2) return null; }
    else if (desiredType === 'mcq_multi') { if (!Array.isArray(correct) || correct.length < 2) return null; correct = [...new Set(correct)]; }

    return {
      type: q.type,
      text: String(q.text).trim().slice(0, 2000),
      options: desiredType === 'tf' || desiredType === 'cloze' ? [] : options,
      correct,
      explanation: String(q.explanation || '').slice(0, 1500),
      sourceExcerpt: String(q.source_excerpt || '').slice(0, 500),
      source: 'ai-diane-strict',
      verified: true
    };
  } catch (e) {
    console.error('[generateOne] Parse error:', e.message);
    return null;
  }
}

// ============ EXTRACTION DES CONCEPTS ============
async function extractConcepts(client, text, subject) {
  const systemPrompt = `Tu extrais les concepts fondamentaux d'un cours pour préparer un quiz.

Pour chaque concept :
- "concept" : nom court (3-8 mots)
- "type" : "définition" | "classification" | "mécanisme" | "chiffre" | "exception"
- "detail" : explication fidèle (2-4 phrases)

Extrait 20-40 concepts. N'invente rien.

FORMAT JSON : {"concepts":[{"concept":"...","type":"...","detail":"..."}],"summary":"..."}`;

  const response = await client.chat.completions.create({
    model: modelName(), temperature: 0.2, response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Matière : ${subject}\n\nCOURS :\n"""\n${text.slice(0, 30000)}\n"""\n\nExtrait les concepts.` }
    ]
  });
  const content = response.choices?.[0]?.message?.content;
  if (!content) return { concepts: [], summary: '' };
  try { return JSON.parse(content); } catch(e) { return { concepts: [], summary: '' }; }
}

// ============ ROUTE PRINCIPALE ============
app.post('/api/analyze-course', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA non configurée. Ajoute AI_API_KEY dans Render.' });
  const { subject = 'Matière', title = 'Cours', sourceText, count = 20 } = req.body || {};
  const text = sanitizeText(String(sourceText || '').trim());
  const n = Math.min(Number(count) || 20, 40);

  if (text.length < 150) return res.status(400).json({ error: 'Texte trop court après nettoyage.' });
  if (text.length > 60000) return res.status(413).json({ error: 'Texte trop long (max 60 000 caractères).' });

  console.log(`[analyze-course] ${text.length} caractères · ${n} questions · modèle: ${modelName()}`);

  try {
    // Passe 1 : concepts
    console.log('[analyze-course] Passe 1 : extraction concepts...');
    const extraction = await extractConcepts(client, text, subject);
    const concepts = Array.isArray(extraction.concepts) ? extraction.concepts : [];
    console.log(`[analyze-course] ✅ ${concepts.length} concepts extraits`);

    // Passe 2 : génération question par question
    const typesPool = [];
    for (let i = 0; i < n; i++) {
      if (i % 10 < 4) typesPool.push('mcq');
      else if (i % 10 < 7) typesPool.push('mcq_multi');
      else if (i % 10 < 9) typesPool.push('tf');
      else typesPool.push('cloze');
    }

    const questions = [];
    const maxAttempts = n * 3;
    let attempts = 0;
    while (questions.length < n && attempts < maxAttempts) {
      const desiredType = typesPool[questions.length];
      const q = await generateOneQuestion(client, { text, subject, desiredType, concepts }, []);
      attempts++;
      if (q) {
        q.id = `diane-${Date.now()}-${questions.length}`;
        q.number = questions.length + 1;
        q.confidence = 0.9;
        questions.push(q);
        console.log(`[analyze-course] ✅ Q${questions.length}/${n} (${q.type}) : "${q.text.slice(0, 70)}..."`);
      } else {
        console.log(`[analyze-course] 🔄 Tentative ${attempts} échouée, on réessaie...`);
      }
    }

    if (!questions.length) throw new Error('Aucune question valide après plusieurs tentatives.');

    console.log(`[analyze-course] ✅ ${questions.length}/${n} questions finales (${attempts} tentatives)`);

    res.json({
      questions,
      concepts: concepts.slice(0, 20),
      summary: String(extraction.summary || '').slice(0, 500),
      coverage: `${questions.length}/${n}`,
      verified: questions.length,
      rejected: attempts - questions.length,
      model: modelName()
    });
  } catch (error) {
    console.error('=== ERREUR analyze-course ===');
    console.error(error?.message);
    res.status(502).json({ error: 'Analyse échouée : ' + (error?.message || 'inconnue') });
  }
});

// ============ RÉSOUDRE RÉPONSES MANQUANTES ============
app.post('/api/answer-questions', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA désactivée.' });
  const { subject = 'Matière', questions } = req.body || {};
  if (!Array.isArray(questions) || !questions.length || questions.length > 100) return res.status(400).json({ error: 'Entre 1 et 100 questions.' });

  const safeQuestions = questions.map((q, i) => ({
    id: String(q.id ?? i),
    type: ['tf','mcq','mcq_multi','short','cloze'].includes(q.type) ? q.type : 'short',
    text: String(q.text || '').slice(0, 3000),
    options: Array.isArray(q.options) ? q.options.slice(0, 12).map(x => String(x).slice(0, 500)) : []
  }));

  try {
    const response = await client.chat.completions.create({
      model: modelName(), temperature: 0.1, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Réponds aux questions. Format : {"answers":[{"id":"...","correct":...,"explanation":"..."}]}. mcq=index, mcq_multi=tableau, tf=booléen, short/cloze=chaîne.` },
        { role: 'user', content: JSON.stringify({ subject, questions: safeQuestions }) }
      ]
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('Réponse vide.');
    const parsed = JSON.parse(content);
    const allowed = new Set(safeQuestions.map(q => q.id));
    const answers = (Array.isArray(parsed.answers) ? parsed.answers : []).filter(a => allowed.has(String(a.id))).map(a => ({
      id: String(a.id), correct: a.correct ?? null,
      explanation: String(a.explanation || '').slice(0, 2000),
      confidence: 0.7
    }));
    res.json({ answers, model: modelName() });
  } catch (error) {
    console.error('[answer-questions] Erreur:', error?.message);
    res.status(502).json({ error: 'Échec IA : ' + (error?.message || 'inconnue') });
  }
});

// ============ ALIAS generate-questions ============
app.post('/api/generate-questions', underDailyLimit, async (req, res) => {
  // Redirige vers analyze-course
  req.url = '/analyze-course';
  return app._router.handle(req, res, () => {});
});

app.listen(port, '0.0.0.0', () => {
  console.log(`CompoTest écoute sur le port ${port}`);
  console.log(`Modèle IA : ${modelName()}`);
  console.log(`Clé IA présente : ${Boolean(process.env.AI_API_KEY)}`);
});
