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
app.get('/api/health', (_req, res) => res.json({ ok: true, aiConfigured: Boolean(process.env.AI_API_KEY), authConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY), adminConfigured: Boolean(process.env.ADMIN_EMAIL && process.env.SUPABASE_SERVICE_ROLE_KEY) }));

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
    if (email !== adminEmail && !allowedEmails.includes(email) && !hasAppAccess) return res.status(403).json({ error: 'Ce compte ne figure pas parmi les utilisateurs autorisés.' });
    req.user = { id: user.id, email: user.email, isAdmin: Boolean(adminEmail && email === adminEmail) };
    next();
  } catch {
    return res.status(503).json({ error: 'Vérification de session indisponible. Réessaie.' });
  }
}
app.use('/api', (req, res, next) => req.path === '/health' ? next() : authenticate(req, res, next));

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
  if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe provisoire doit contenir au moins 6 caractères.' });
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
app.patch('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  const password = String(req.body?.password || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Identifiant de compte invalide.' });
  if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  try {
    const current = await supabaseAdmin(`users/${encodeURIComponent(id)}`);
    if (String(current.email || '').toLowerCase() === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()) {
      return res.status(400).json({ error: 'Utilise le bouton « Changer mon mot de passe » dans l’en-tête.' });
    }
    await supabaseAdmin(`users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ password }) });
    res.json({ ok: true });
  } catch (error) {
    console.error('Admin reset password:', error.message);
    res.status(error.status || 502).json({ error: 'Impossible de modifier le mot de passe.' });
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

const usage = new Map();
function underDailyLimit(req, res, next) {
  const limit = 15;
  const day = new Date().toISOString().slice(0, 10);
  const key = `${req.user.id}:${day}:${req.path}`;
  const used = usage.get(key) || 0;
  if (used >= limit) return res.status(429).json({ error: `Limite gratuite atteinte (${limit} demandes/jour). Réessaie demain.` });
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

// ============ NOUVEAU : détection intelligente du type de document ============
// Renvoie { type: 'numbered'|'course'|'mixed', confidence: 0-1, hints: [...] }
function classifyDocument(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) return { type: 'course', confidence: 0.5, hints: ['Document très court'] };

  let numberedQuestions = 0;
  let optionsLike = 0;
  let headings = 0;
  let bulletLines = 0;
  let longParagraphs = 0;

  const numberPattern = /^\s*(?:[✓✔☑]\s*)?(\d{1,3})[.)]\s+\S/;
  const optionPattern = /^\s*([✓✔☑]\s*)?([A-H])[.)]\s+\S/;
  const headingPattern = /^(?:Chapitre|Partie|Section|Titre|I+\.|Article|[IVX]+\.)\s/i;
  const bulletPattern = /^\s*[-•*·]\s+\S/;

  for (const line of lines) {
    if (numberPattern.test(line)) numberedQuestions++;
    if (optionPattern.test(line)) optionsLike++;
    if (headingPattern.test(line)) headings++;
    if (bulletPattern.test(line)) bulletLines++;
    if (line.length > 200) longParagraphs++;
  }

  const total = lines.length;
  const numberedRatio = numberedQuestions / total;
  const optionsRatio = optionsLike / total;
  const paragraphRatio = longParagraphs / total;

  const hints = [];
  if (numberedQuestions > 0) hints.push(`${numberedQuestions} ligne(s) numérotée(s)`);
  if (optionsLike > 0) hints.push(`${optionsLike} option(s) A/B/C/D`);
  if (headings > 0) hints.push(`${headings} titre(s) de section`);

  // Document structuré en questions numérotées
  if (numberedRatio > 0.05 && optionsRatio > 0.05) {
    return { type: 'numbered', confidence: Math.min(1, numberedRatio * 10), hints };
  }
  // Document mixte (quelques questions perdues dans le cours)
  if (numberedQuestions > 2 && paragraphRatio > 0.3) {
    return { type: 'mixed', confidence: 0.7, hints };
  }
  // Cours rédigé classique
  return { type: 'course', confidence: paragraphRatio > 0.3 ? 0.9 : 0.6, hints };
}

app.post('/api/classify-document', underDailyLimit, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (text.length < 80) return res.status(400).json({ error: 'Texte trop court (minimum 80 caractères).' });
  if (text.length > 100000) return res.status(413).json({ error: 'Texte trop long (maximum 100 000 caractères).' });
  const result = classifyDocument(text);
  res.json(result);
});

// ============ NOUVEAU : analyse d'un cours sans questions numérotées ============
app.post('/api/analyze-course', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA désactivée : ajoute une clé dans AI_API_KEY côté serveur.' });
  const { subject = 'Matière non précisée', title = 'Cours analysé', sourceText, count = 20 } = req.body || {};
  const text = String(sourceText || '').trim();
  const n = Number(count);
  if (text.length < 150) return res.status(400).json({ error: 'Le texte est trop court pour être analysé (minimum 150 caractères).' });
  if (text.length > 80000) return res.status(413).json({ error: 'Le texte est trop long (maximum 80 000 caractères). Essaie avec un extrait plus court.' });
  if (!Number.isInteger(n) || n < 1 || n > 100) return res.status(400).json({ error: 'Choisis un nombre de questions entre 1 et 100.' });

  try {
    // Étape 1 : l'IA identifie les notions clés du cours
    const extraction = await client.chat.completions.create({
      model: modelName(), temperature: 0.1, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Tu es un expert pédagogique. Tu vas analyser un document de cours en français et en extraire TOUTES les notions importantes qui méritent d'être testées.

Tu dois identifier :
1. Les définitions et concepts clés
2. Les classifications et catégories
3. Les mécanismes et processus
4. Les chiffres, dates et valeurs importantes
5. Les exceptions et cas particuliers
6. Les relations de cause à effet
7. Les propriétés et fonctions

Pour CHAQUE notion, tu donnes :
- "topic" : titre court (5-10 mots)
- "detail" : explication fidèle au cours (2-4 phrases)
- "importance" : "haute" / "moyenne" / "basse"
- "section" : section du cours d'où elle vient (si identifiable)

Renvoie un JSON : {"notions":[{"topic":"...","detail":"...","importance":"haute","section":"..."}],"summary":"Résumé global du cours en 2-3 phrases","total_concepts":N}

IMPORTANT : Si le cours contient plus de ${Math.max(n*2, 30)} notions, tu peux te limiter aux ${Math.max(n*2, 30)} plus importantes. Si le cours est très court, retourne moins de notions — n'invente rien.` },
        { role: 'user', content: `Cours à analyser (${text.length} caractères) :\n\n"""\n${text}\n"""\n\nExtrait toutes les notions testables.` }
      ]
    });
    const extractionContent = extraction.choices?.[0]?.message?.content;
    if (!extractionContent) throw new Error('Extraction échouée.');
    const extracted = JSON.parse(extractionContent);
    const notions = Array.isArray(extracted.notions) ? extracted.notions.slice(0, 200) : [];
    if (!notions.length) return res.status(502).json({ error: 'Aucune notion exploitable détectée dans le cours.' });

    // Étape 2 : génération des questions à partir des notions
    const targetQuestions = Math.min(n, notions.length * 2);
    const generation = await client.chat.completions.create({
      model: modelName(), temperature: 0.3, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Tu es un assistant pédagogique. À partir des notions extraites d'un cours, génère exactement ${targetQuestions} questions en français.

Règles :
- Chaque question teste UNE seule notion claire
- Varie les formats : 40% mcq (4 options, 1 correct), 30% mcq_multi (4 options, ≥2 corrects), 30% tf (Vrai/Faux)
- Le texte des questions doit être autonome (compréhensible sans le cours)
- Les mauvaises réponses doivent être plausibles mais fausses
- Explication : 1-3 phrases justifiant la bonne réponse à partir du cours
- N'invente AUCUN fait absent des notions fournies
- Varie les notions testées : ne pose pas 2 questions sur la même notion sauf si elle est très riche

Format JSON :
{"questions":[{"type":"mcq|mcq_multi|tf","text":"...","options":["...","...","...","..."],"correct":0,"explanation":"...","source_notion":"..."}],"note":"..."}

Pour tf : options=[] et correct=true|false.` },
        { role: 'user', content: JSON.stringify({ subject: String(subject).slice(0,200), title: String(title).slice(0,200), notions }) }
      ]
    });
    const genContent = generation.choices?.[0]?.message?.content;
    if (!genContent) throw new Error('Génération échouée.');
    const parsed = JSON.parse(genContent);
    const raw = Array.isArray(parsed.questions) ? parsed.questions : [];

    const questions = raw.slice(0, targetQuestions).map((q, i) => {
      const type = ['mcq','mcq_multi','tf'].includes(q.type) ? q.type : null;
      const text = String(q.text || '').trim().slice(0, 2000);
      const options = Array.isArray(q.options) ? q.options.slice(0, 6).map(x => String(x).slice(0, 500)) : [];
      let correct = q.correct;
      if (type === 'tf') { if (typeof correct !== 'boolean') return null; }
      else if (type === 'mcq') { if (!Number.isInteger(correct) || correct < 0 || correct >= options.length || options.length < 2) return null; }
      else if (type === 'mcq_multi') { if (!Array.isArray(correct) || correct.length < 2 || correct.some(x => !Number.isInteger(x) || x < 0 || x >= options.length) || options.length < 3) return null; correct = [...new Set(correct)]; }
      if (!type || !text) return null;
      return {
        id: `course-${Date.now()}-${i}`,
        number: i + 1,
        type, text,
        options: type === 'tf' ? [] : options,
        correct,
        explanation: String(q.explanation || '').slice(0, 1500),
        sourceExcerpt: String(q.source_notion || '').slice(0, 500),
        source: 'ai-generated',
        confidence: null
      };
    }).filter(Boolean);

    if (!questions.length) return res.status(502).json({ error: 'Aucune question exploitable générée.' });

    res.json({
      questions,
      notions: notions.slice(0, 30),
      summary: String(extracted.summary || '').slice(0, 500),
      totalConcepts: Number(extracted.total_concepts) || notions.length,
      note: String(parsed.note || '').slice(0, 1000),
      coverage: `${questions.length} questions générées à partir de ${notions.length} notions détectées.`,
      model: modelName()
    });
  } catch (error) {
    console.error('Erreur analyse cours:', error?.message || error);
    res.status(502).json({ error: 'Analyse échouée. Vérifie la configuration ou réessaie.' });
  }
});

app.post('/api/answer-questions', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA désactivée.' });
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
        { role: 'system', content: `Tu réponds à des questions. Format : {"answers":[{"id":"...","correct":...,"explanation":"...","confidence":0.75,"warning":""}]}. Pour mcq correct=index, mcq_multi=tableau, tf=booléen, short=chaîne.` },
        { role: 'user', content: JSON.stringify({ questions: safeQuestions }) }
      ]
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('Réponse vide.');
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
    console.error('Erreur IA:', error?.message || error);
    res.status(502).json({ error: 'Échec IA.' });
  }
});

app.post('/api/generate-questions', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA désactivée.' });
  const { subject = 'Matière non précisée', title = 'Cours importé', sourceText, count = 20 } = req.body || {};
  const text = typeof sourceText === 'string' ? sourceText.trim() : '';
  const n = Number(count);
  if (text.length < 80) return res.status(400).json({ error: 'Le texte du cours est trop court.' });
  if (text.length > 60000) return res.status(413).json({ error: 'Le texte est trop long (max 60 000 caractères).' });
  if (!Number.isInteger(n) || n < 1 || n > 100) return res.status(400).json({ error: 'Nombre entre 1 et 100.' });

  try {
    const systemPrompt = `Tu génères des questions de quiz en français à partir d'un cours.

INSTRUCTIONS :
1. Lis TOUT le texte.
2. Identifie TOUTES les notions : définitions, classifications, mécanismes, chiffres, exceptions, causes/conséquences.
3. Génère ${n} questions couvrant un MAXIMUM de notions différentes.
4. Répartis sur tout le texte (début, milieu, fin).
5. Si le cours liste des éléments (ex. "3 types de..."), génère une question par élément important.
6. N'invente rien.

Types : 40% mcq (4 options, correct=index), 30% mcq_multi (4 options, ≥2 corrects), 30% tf (options=[], correct=bool).

Format JSON : {"questions":[{"type":"...","text":"...","options":[...],"correct":...,"explanation":"...","source_excerpt":"..."}],"note":"...","coverage_summary":"..."}`;

    const chunks = [];
    const maxChunkSize = 12000;
    if (text.length <= maxChunkSize) chunks.push(text);
    else {
      const paragraphs = text.split(/\n\s*\n/);
      let current = '';
      for (const p of paragraphs) {
        if ((current + '\n\n' + p).length > maxChunkSize && current.length > 0) {
          chunks.push(current); current = p;
        } else current = current ? current + '\n\n' + p : p;
      }
      if (current) chunks.push(current);
    }

    const perChunk = Math.ceil(n / chunks.length);
    const allQuestions = [];
    const notes = [];

    for (let ci = 0; ci < chunks.length; ci++) {
      const remaining = n - allQuestions.length;
      if (remaining <= 0) break;
      const chunkCount = Math.min(perChunk, remaining);
      const response = await client.chat.completions.create({
        model: modelName(), temperature: 0.3, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt.replace('${n}', chunkCount) },
          { role: 'user', content: `Cours (partie ${ci+1}/${chunks.length}) :\n\n"""\n${chunks[ci]}\n"""\n\nGénère exactement ${chunkCount} questions.` }
        ]
      });
      const content = response.choices?.[0]?.message?.content;
      if (!content) continue;
      const parsed = JSON.parse(content);
      const raw = Array.isArray(parsed.questions) ? parsed.questions : [];
      if (parsed.note) notes.push(`P${ci+1}: ${parsed.note}`);

      for (const q of raw) {
        const type = ['mcq','mcq_multi','tf'].includes(q.type) ? q.type : null;
        const text2 = String(q.text || '').trim().slice(0, 2000);
        const options = Array.isArray(q.options) ? q.options.slice(0, 8).map(x => String(x).slice(0, 500)) : [];
        let correct = q.correct;
        if (type === 'tf') { if (typeof correct !== 'boolean') continue; }
        else if (type === 'mcq') { if (!Number.isInteger(correct) || correct < 0 || correct >= options.length || options.length < 2) continue; }
        else if (type === 'mcq_multi') { if (!Array.isArray(correct) || correct.length < 2 || correct.some(x => !Number.isInteger(x) || x < 0 || x >= options.length) || options.length < 3) continue; correct = [...new Set(correct)]; }
        if (!type || !text2) continue;
        const dup = allQuestions.some(e => {
          const a = e.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          const b = text2.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          if (!a.length || !b.length) return false;
          const setB = new Set(b);
          const common = a.filter(w => setB.has(w)).length;
          return common / Math.max(a.length, b.length) > 0.8;
        });
        if (dup) continue;
        allQuestions.push({
          id: `gen-${Date.now()}-${allQuestions.length}`, number: allQuestions.length + 1,
          type, text: text2, options: type === 'tf' ? [] : options, correct,
          explanation: String(q.explanation || '').slice(0, 1500),
          sourceExcerpt: String(q.source_excerpt || '').slice(0, 500),
          source: 'ai-generated', confidence: null
        });
        if (allQuestions.length >= n) break;
      }
    }

    if (!allQuestions.length) return res.status(502).json({ error: 'Aucune question produite.' });
    res.json({ questions: allQuestions, note: notes.join(' '), coverage: `${allQuestions.length}/${n} questions sur ${chunks.length} passe(s).`, model: modelName() });
  } catch (error) {
    console.error('Erreur génération:', error?.message || error);
    res.status(502).json({ error: 'Génération échouée.' });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`CompoTest écoute sur le port ${port}`));
