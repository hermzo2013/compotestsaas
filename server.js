import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/config.js', (_req, res) => res.sendFile(path.join(__dirname, 'config.js'), { headers: { 'Cache-Control': 'no-store' } }));
app.get('/api/health', (_req, res) => res.json({ ok: true, aiConfigured: Boolean(process.env.AI_API_KEY), authConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) }));

// Verify each access token with Supabase Auth. The anon key is public; the service-role key is never used here.
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
    const allowedEmails = (process.env.ALLOWED_USER_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    if (!allowedEmails.includes(String(user.email).toLowerCase())) return res.status(403).json({ error: 'Ce compte ne figure pas dans la liste des personnes autorisées.' });
    req.user = { id: user.id, email: user.email };
    next();
  } catch {
    return res.status(503).json({ error: 'Vérification de session indisponible. Réessaie.' });
  }
}
app.use('/api', (req, res, next) => req.path === '/health' ? next() : authenticate(req, res, next));

// Best-effort per-user daily caps. They reset when this free server restarts; provider limits remain the final guardrail.
const usage = new Map();
function underDailyLimit(req, res, next) {
  const limit = req.path === '/generate-questions' ? 5 : 10;
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
  if (!client) return res.status(503).json({ error: 'IA désactivée : ajoute une clé d’offre gratuite dans AI_API_KEY côté serveur. Aucune facturation n’est configurée par CompoTest.' });
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
        { role: 'system', content: `Tu aides à préparer des questionnaires pédagogiques. Matière : ${String(subject).slice(0,200)}. Réponds en français, avec prudence. Ne devine pas si l'énoncé manque d'informations : dans ce cas indique correct:null, confidence:0 et warning. Pour mcq, correct est un index d'option commençant à 0. Pour mcq_multi, correct est un tableau d'indices. Pour tf, correct est true ou false. Pour short, correct est une chaîne de réponse. confidence est une estimation entre 0 et 1, pas une garantie. Donne une explication concise et signale toute ambiguïté. Le JSON doit respecter cette forme : {"answers":[{"id":"...","correct":0,"explanation":"...","confidence":0.75,"warning":"..."}]}.` },
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
    res.status(502).json({ error: 'Échec de la génération IA ou quota gratuit épuisé. Réessaie plus tard.' });
  }
});

app.post('/api/generate-questions', underDailyLimit, async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA désactivée : ajoute une clé d’offre gratuite dans AI_API_KEY côté serveur. Aucune facturation n’est configurée par CompoTest.' });
  const { subject = 'Matière non précisée', title = 'Cours importé', sourceText, count = 20 } = req.body || {};
  const text = typeof sourceText === 'string' ? sourceText.trim() : '';
  const n = Number(count);
  if (text.length < 80) return res.status(400).json({ error: 'Le texte du cours est trop court. Importe un PDF et extrais son texte avant de générer les questions.' });
  if (text.length > 40000) return res.status(413).json({ error: 'Le texte est trop long pour une seule génération (maximum 40 000 caractères). Essaie avec un extrait plus court du cours.' });
  if (!Number.isInteger(n) || n < 1 || n > 100) return res.status(400).json({ error: 'Choisis un nombre de questions entre 1 et 100.' });
  try {
    const response = await client.chat.completions.create({
      model: modelName(), temperature: 0.2, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Tu es un assistant pédagogique. Génère exactement ${n} questions en français, uniquement à partir du contenu source fourni. N'ajoute pas de faits absents du cours. Si le contenu ne permet pas de soutenir une question ou sa réponse, ne l'invente pas; génère autant de questions fiables que possible et indique les limites dans le champ note. Mélange ces formats : mcq (une seule bonne réponse), mcq_multi (plusieurs bonnes réponses), tf (Vrai/Faux). Répartition souhaitée : environ un tiers de chaque format, sans obligation stricte si le contenu ne s'y prête pas. Pour mcq, options contient 4 choix et correct est l'index zéro-based de la bonne réponse. Pour mcq_multi, options contient 4 choix et correct est un tableau d'au moins 2 indices distincts. Pour tf, options doit être [] et correct est un booléen (true = Vrai). Chaque question doit être claire, sans ambiguïté, sans doublons et sans négation piège. L'explication doit justifier la réponse en se référant au cours. Réponds en JSON valide : {"questions":[{"type":"mcq|mcq_multi|tf","text":"...","options":["..."],"correct":0,"explanation":"...","source_excerpt":"courte citation/paraphrase fidèle au cours"}],"note":"..."}. Pour tf, correct est true ou false et options [].` },
        { role: 'user', content: JSON.stringify({ subject: String(subject).slice(0,200), title: String(title).slice(0,200), sourceText: text }) }
      ]
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('Le modèle n’a renvoyé aucun contenu.');
    const parsed = JSON.parse(content);
    const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
    const questions = rawQuestions.slice(0, n).map((q, i) => {
      const type = ['mcq','mcq_multi','tf'].includes(q.type) ? q.type : null;
      const text = String(q.text || '').trim().slice(0, 2000);
      const options = Array.isArray(q.options) ? q.options.slice(0, 8).map(x => String(x).slice(0, 500)) : [];
      let correct = q.correct;
      if (type === 'tf') { if (typeof correct !== 'boolean') return null; }
      else if (type === 'mcq') { if (!Number.isInteger(correct) || correct < 0 || correct >= options.length || options.length < 2) return null; }
      else if (type === 'mcq_multi') { if (!Array.isArray(correct) || correct.length < 2 || correct.some(x => !Number.isInteger(x) || x < 0 || x >= options.length) || options.length < 3) return null; correct = [...new Set(correct)]; }
      if (!type || !text) return null;
      return { id: `gen-${Date.now()}-${i}`, number: i + 1, type, text, options: type === 'tf' ? [] : options, correct, explanation: String(q.explanation || '').slice(0, 1500), sourceExcerpt: String(q.source_excerpt || '').slice(0, 500), source: 'ai-generated', confidence: null };
    }).filter(Boolean);
    if (!questions.length) return res.status(502).json({ error: 'Aucune question exploitable n’a été produite. Essaie avec un texte de cours plus complet.' });
    res.json({ questions, note: String(parsed.note || '').slice(0, 1000), model: modelName() });
  } catch (error) {
    console.error('Erreur génération de questions:', error?.message || error);
    res.status(502).json({ error: 'La génération a échoué ou le quota gratuit est épuisé. Vérifie la configuration de l’API et réessaie.' });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`CompoTest écoute sur le port ${port}`));
