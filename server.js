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
  const limit = req.path === '/generate-questions' ? 10 : 10;
  const day = new Date().toISOString().slice(0, 10);
  const key = `${req.user.id}:${day}:${req.path}`;
  const used = usage.get(key) || 0;
  if (used >= limit) return res.status(429).json({ error: `Limite gratuite atteinte (${limit} demande(s) par jour pour cette fonction). Réessaie demain.` });
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

app.post('/api/answer-questions', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA désactivée : ajoute une clé dans AI_API_KEY côté serveur.' });
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
        { role: 'system', content: `Tu aides à préparer des questionnaires. Matière : ${String(subject).slice(0,200)}. Réponds en français. Pour mcq, correct = index zéro-based. Pour mcq_multi, correct = tableau d'indices. Pour tf, correct = booléen. Pour short, correct = chaîne. confidence entre 0 et 1. Format : {"answers":[{"id":"...","correct":...,"explanation":"...","confidence":0.75,"warning":"..."}]}.` },
        { role: 'user', content: JSON.stringify({ questions: safeQuestions }) }
      ]
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('Le modèle n’a renvoyé aucun contenu.');
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
    console.error('Erreur API IA:', error?.message || error);
    res.status(502).json({ error: 'Échec de la génération IA ou quota épuisé.' });
  }
});

// Génération améliorée : multi-passes + vérification de couverture
app.post('/api/generate-questions', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA désactivée : ajoute une clé dans AI_API_KEY côté serveur.' });
  const { subject = 'Matière non précisée', title = 'Cours importé', sourceText, count = 20 } = req.body || {};
  const text = typeof sourceText === 'string' ? sourceText.trim() : '';
  const n = Number(count);
  if (text.length < 80) return res.status(400).json({ error: 'Le texte du cours est trop court (minimum 80 caractères).' });
  if (text.length > 60000) return res.status(413).json({ error: 'Le texte est trop long (maximum 60 000 caractères).' });
  if (!Number.isInteger(n) || n < 1 || n > 100) return res.status(400).json({ error: 'Choisis un nombre de questions entre 1 et 100.' });

  try {
    const systemPrompt = `Tu es un assistant pédagogique expert. Tu vas générer des questions de quiz à partir d'un texte de cours en français.

INSTRUCTIONS CRITIQUES :
1. Lis ATTENTIVEMENT tout le texte fourni, du début à la fin.
2. Identifie TOUTES les notions importantes : définitions, classifications, mécanismes, chiffres clés, exceptions, exemples, propriétés, fonctions, causes et conséquences.
3. Génère exactement ${n} questions couvrant un MAXIMUM de notions différentes. Ne répète pas deux fois la même notion.
4. Répartis les questions sur tout le texte (début, milieu, fin) — ne te concentre pas sur les premiers paragraphes.
5. Si le texte contient des listes, des tableaux ou des énumérations, tu DOIS générer au moins une question par élément important.
6. N'invente JAMAIS de faits absents du cours. Si tu manques de matière pour ${n} questions, génère moins et signale-le dans "note".

TYPES DE QUESTIONS :
- "mcq" : QCM 1 bonne réponse (4 options, correct = index 0-3)
- "mcq_multi" : QCM plusieurs bonnes réponses (4 options, correct = tableau d'au moins 2 indices)
- "tf" : Vrai/Faux (options = [], correct = true/false)
Répartition : 40% mcq, 30% mcq_multi, 30% tf.

POUR CHAQUE QUESTION :
- text : énoncé clair, précis, sans ambiguïté, sans piège
- options : 4 propositions (sauf tf = [])
- correct : bonne réponse selon le type
- explanation : 1-3 phrases justifiant la réponse en citant le cours
- source_excerpt : courte phrase du cours dont la question est tirée (10-25 mots)

FORMAT JSON OBLIGATOIRE :
{"questions":[{"type":"mcq","text":"...","options":["a","b","c","d"],"correct":0,"explanation":"...","source_excerpt":"..."}],"note":"...","coverage_summary":"Résumé des parties du cours couvertes"}`;

    // Découpe le texte en morceaux si trop long (max ~12000 chars par passe)
    const chunks = [];
    const maxChunkSize = 12000;
    if (text.length <= maxChunkSize) {
      chunks.push(text);
    } else {
      // Découpe intelligente par paragraphes
      const paragraphs = text.split(/\n\s*\n/);
      let current = '';
      for (const p of paragraphs) {
        if ((current + '\n\n' + p).length > maxChunkSize && current.length > 0) {
          chunks.push(current);
          current = p;
        } else {
          current = current ? current + '\n\n' + p : p;
        }
      }
      if (current) chunks.push(current);
    }

    // Répartit le nombre de questions sur les chunks
    const questionsPerChunk = Math.ceil(n / chunks.length);
    const allQuestions = [];
    const coverageNotes = [];

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const remaining = n - allQuestions.length;
      if (remaining <= 0) break;
      const chunkCount = Math.min(questionsPerChunk, remaining);

      const userPrompt = `Cours complet (partie ${ci + 1}/${chunks.length}) :

"""
${chunk}
"""

Génère exactement ${chunkCount} questions en respectant les instructions système.`;

      const response = await client.chat.completions.create({
        model: modelName(), temperature: 0.3, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      });

      const content = response.choices?.[0]?.message?.content;
      if (!content) continue;
      const parsed = JSON.parse(content);
      const raw = Array.isArray(parsed.questions) ? parsed.questions : [];
      if (parsed.note) coverageNotes.push(`Partie ${ci + 1}: ${parsed.note}`);

      for (const q of raw) {
        const type = ['mcq','mcq_multi','tf'].includes(q.type) ? q.type : null;
        const text = String(q.text || '').trim().slice(0, 2000);
        const options = Array.isArray(q.options) ? q.options.slice(0, 8).map(x => String(x).slice(0, 500)) : [];
        let correct = q.correct;
        if (type === 'tf') { if (typeof correct !== 'boolean') continue; }
        else if (type === 'mcq') { if (!Number.isInteger(correct) || correct < 0 || correct >= options.length || options.length < 2) continue; }
        else if (type === 'mcq_multi') { if (!Array.isArray(correct) || correct.length < 2 || correct.some(x => !Number.isInteger(x) || x < 0 || x >= options.length) || options.length < 3) continue; correct = [...new Set(correct)]; }
        if (!type || !text) continue;
        // Anti-doublon simple
        const dup = allQuestions.some(existing => {
          const a = existing.text.toLowerCase();
          const b = text.toLowerCase();
          // Similarité grossière : si 80% des mots sont communs, c'est un doublon
          const wa = new Set(a.split(/\s+/).filter(w => w.length > 3));
          const wb = new Set(b.split(/\s+/).filter(w => w.length > 3));
          if (wa.size === 0 || wb.size === 0) return false;
          let common = 0;
          for (const w of wa) if (wb.has(w)) common++;
          return common / Math.max(wa.size, wb.size) > 0.8;
        });
        if (dup) continue;

        allQuestions.push({
          id: `gen-${Date.now()}-${allQuestions.length}`,
          number: allQuestions.length + 1,
          type, text,
          options: type === 'tf' ? [] : options,
          correct,
          explanation: String(q.explanation || '').slice(0, 1500),
          sourceExcerpt: String(q.source_excerpt || '').slice(0, 500),
          source: 'ai-generated',
          confidence: null
        });
        if (allQuestions.length >= n) break;
      }
    }

    if (!allQuestions.length) return res.status(502).json({ error: 'Aucune question exploitable n’a été produite. Essaie avec un texte plus structuré ou plus long.' });

    res.json({
      questions: allQuestions,
      note: coverageNotes.join(' ') || '',
      coverage: `Générées : ${allQuestions.length}/${n} questions sur ${chunks.length} passe(s).`,
      model: modelName()
    });
  } catch (error) {
    console.error('Erreur génération:', error?.message || error);
    res.status(502).json({ error: 'La génération a échoué. Vérifie la configuration ou réessaie.' });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`CompoTest écoute sur le port ${port}`));
