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
    timeout: 90000,
    maxRetries: 4
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

// ======================================================================
//  GÉNÉRATION DE QUIZ v2 — JSON Schema strict + few-shot + validation
// ======================================================================

// ---------- Utilitaires ----------
const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const wordsOf = (s) => norm(s).split(' ').filter(Boolean);

function ngrams(ws, n) {
  const set = new Set();
  for (let i = 0; i + n <= ws.length; i++) set.add(ws.slice(i, i + n).join(' '));
  return set;
}
// part des n-grammes de `text` présents dans `source` (0 = rien de commun, 1 = recopie totale)
function overlap(text, source, n = 3) {
  const a = ngrams(wordsOf(text), n);
  if (!a.size) return 0;
  const b = ngrams(wordsOf(source), n);
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Découpage, quotas, glossaire ----------
function splitIntoChunks(text, nChunks) {
  const lines = text.split('\n').flatMap(l => (l.length > 1200 ? l.split(/(?<=[.!?])\s+/) : [l]));
  const target = Math.ceil(text.length / nChunks);
  const chunks = [];
  let cur = [], len = 0;
  for (const line of lines) {
    if (cur.length && len >= target && chunks.length < nChunks - 1) {
      chunks.push(cur.join('\n')); cur = []; len = 0;
    }
    cur.push(line); len += line.length + 1;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  if (chunks.length > 1 && chunks[chunks.length - 1].length < 300) {
    const last = chunks.pop();
    chunks[chunks.length - 1] += '\n' + last;
  }
  return chunks;
}

// répartit n questions entre les sections, proportionnellement à leur longueur
function allocate(n, chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0) || 1;
  const raw = chunks.map(c => (n * c.length) / total);
  const base = raw.map(Math.floor);
  let left = n - base.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - base[i], i]).sort((a, b) => b[0] - a[0]).slice(0, left).forEach(([, i]) => base[i]++);
  return base;
}

// 40 % QCM, 30 % QCM multi, 20 % V/F (moitié FAUX), 10 % trous
function buildTypePlan(n) {
  const nMcq = Math.round(n * 0.4), nMulti = Math.round(n * 0.3), nTf = Math.round(n * 0.2);
  const nCloze = Math.max(0, n - nMcq - nMulti - nTf);
  const plan = [
    ...Array.from({ length: nMcq }, () => ({ type: 'mcq' })),
    ...Array.from({ length: nMulti }, () => ({ type: 'mcq_multi' })),
    ...Array.from({ length: nTf }, (_, i) => ({ type: 'tf', expected: i % 2 === 1 })),
    ...Array.from({ length: nCloze }, () => ({ type: 'cloze' }))
  ];
  return shuffled(plan).slice(0, n);
}

// termes "Terme : définition" du cours → réservoir de distracteurs
function buildGlossary(text, max = 60) {
  const terms = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:[-•·*o]\s+)?([^:\n]{3,70}?)\s*:\s*\S/);
    if (!m) continue;
    const term = m[1].trim();
    if (term.split(/\s+/).length <= 8) terms.set(norm(term), term);
  }
  return [...terms.values()].slice(0, max);
}

// ---------- Schéma JSON strict (l'ordre des champs est volontaire) ----------
const QUESTION_ITEM = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['mcq', 'mcq_multi', 'tf', 'cloze'] },
    concept: { type: 'string' },
    source_excerpt: { type: 'string' },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    correct_indices: { type: 'array', items: { type: 'integer' } },
    tf_answer: { type: 'boolean' },
    cloze_answer: { type: 'string' },
    explanation: { type: 'string' }
  },
  required: ['type', 'concept', 'source_excerpt', 'question', 'options', 'correct_indices', 'tf_answer', 'cloze_answer', 'explanation'],
  additionalProperties: false
};
const QUIZ_SCHEMA = {
  type: 'object',
  properties: { questions: { type: 'array', items: QUESTION_ITEM } },
  required: ['questions'],
  additionalProperties: false
};

// ---------- Few-shot (forme uniquement) ----------
const SRC_IMMUNOGENICITE = "Immunogénicité: Capacité d'un Ag à induire une RI, qui se manifeste par la production d'anticorps spécifiques, de lymphocytes T sensibilisés, et de cytokines.";
const SRC_IMMUNITE = "L'immunité repose sur : Reconnaissance et tolérance du soi: Ce qui appartient à l'organisme. Rejet du non-soi: Ce qui est étranger à l'organisme.";
const SRC_VOIES = "Voies d'administration: Intradermique, sous-cutanée, intramusculaire, intraveineuse.";

const FEWSHOT = [
  { type: 'mcq', concept: 'Immunogénicité', source_excerpt: SRC_IMMUNOGENICITE,
    question: "Que désigne le terme « immunogénicité » ?",
    options: ["La capacité d'un antigène à induire une réponse immunitaire", "La reconnaissance et la tolérance du soi", "Le rejet de tout ce qui est étranger à l'organisme", "La capacité d'un anticorps à se fixer sur son antigène"],
    correct_indices: [0], tf_answer: false, cloze_answer: '',
    explanation: "L'immunogénicité est la capacité d'un antigène à induire une réponse immunitaire (anticorps spécifiques, lymphocytes T sensibilisés, cytokines). Les autres propositions décrivent d'autres notions." },
  { type: 'mcq', concept: 'Fondements de l\'immunité', source_excerpt: SRC_IMMUNITE,
    question: "Sur quoi repose le concept d'immunité ?",
    options: ["Sur la tolérance du soi et le rejet du non-soi", "Sur le rejet du soi et la tolérance du non-soi", "Sur la seule production d'anticorps spécifiques", "Sur la reconnaissance du non-soi et la production de cytokines"],
    correct_indices: [0], tf_answer: false, cloze_answer: '',
    explanation: "L'immunité repose sur la tolérance du soi (ce qui appartient à l'organisme) et le rejet du non-soi (ce qui lui est étranger). Inverser les deux notions est une erreur classique." },
  { type: 'mcq_multi', concept: "Manifestations de l'immunogénicité", source_excerpt: SRC_IMMUNOGENICITE,
    question: "Quelles manifestations traduisent l'immunogénicité d'un antigène ?",
    options: ["Production d'anticorps spécifiques", "Production de lymphocytes T sensibilisés", "Production de cytokines", "Tolérance du soi"],
    correct_indices: [0, 1, 2], tf_answer: false, cloze_answer: '',
    explanation: "L'immunogénicité se manifeste par des anticorps spécifiques, des lymphocytes T sensibilisés et des cytokines. La tolérance du soi relève de la définition de l'immunité." },
  { type: 'tf', concept: 'Immunogénicité', source_excerpt: SRC_IMMUNOGENICITE,
    question: "Vrai ou Faux : L'immunogénicité se manifeste par la production d'anticorps spécifiques, de lymphocytes B sensibilisés et de cytokines.",
    options: [], correct_indices: [], tf_answer: false, cloze_answer: '',
    explanation: "Faux : ce sont des lymphocytes T sensibilisés, et non des lymphocytes B, qui participent aux manifestations de l'immunogénicité." },
  { type: 'tf', concept: 'Immunité', source_excerpt: SRC_IMMUNITE,
    question: "Vrai ou Faux : Le rejet du non-soi, c'est-à-dire de ce qui est étranger à l'organisme, fait partie des fondements de l'immunité.",
    options: [], correct_indices: [], tf_answer: true, cloze_answer: '',
    explanation: "Vrai : l'immunité repose à la fois sur la tolérance du soi et sur le rejet du non-soi." },
  { type: 'cloze', concept: "Voies d'administration", source_excerpt: SRC_VOIES,
    question: "Complétez : Les voies d'administration d'un antigène comprennent les voies intradermique, sous-cutanée, intramusculaire et ____.",
    options: [], correct_indices: [], tf_answer: false, cloze_answer: 'intraveineuse',
    explanation: "Les quatre voies d'administration citées sont intradermique, sous-cutanée, intramusculaire et intraveineuse." }
];

const SYSTEM_PROMPT = `Tu es un enseignant-concepteur de QCM pour des étudiants en santé. Tu transformes un EXTRAIT de cours en questions d'entraînement.

PRINCIPE CENTRAL — chaque question se construit en 3 temps, dans l'ordre des champs JSON :
1) "concept" : la notion testée (2 à 6 mots).
2) "source_excerpt" : la phrase EXACTE du cours (1 à 2 phrases, copiée mot pour mot) qui contient la réponse. C'est le SEUL endroit où tu recopies le cours.
3) "question" : une question que tu RÉDIGES toi-même en reformulant. Une note de cours "Terme : définition" devient une question qui demande le terme ou la définition. La phrase du cours n'apparaît jamais dans "question".

FORMES PAR TYPE :
- mcq : "question" finit par « ? ». 4 options, UNE seule correcte (correct_indices = 1 élément). Formes possibles : "Que désigne … ?", "Quel est le rôle de … ?", "Sur quoi repose … ?", "Quelle est la différence entre A et B ?", "Dans quel cas … ?", "Combien de … ?", "Parmi les propositions suivantes, laquelle décrit … ?".
- mcq_multi : "question" finit par « ? ». 4 options, 2 ou 3 correctes ("Quelles sont …", "Parmi les propositions suivantes, lesquelles … ?").
- tf : "Vrai ou Faux : <affirmation>". options = []. Renseigne tf_answer. Si la réponse attendue est FAUX : change UN SEUL élément de la phrase du cours (un mot, un chiffre, une négation, une inversion cause/conséquence, un terme voisin). L'affirmation reste plausible, jamais absurde. L'explication donne la formulation correcte.
- cloze : "Complétez : <phrase reformulée contenant exactement un ____>". cloze_answer = le mot ou groupe de mots (4 mots max) retiré, qui figure dans source_excerpt. options = [].

DISTRACTEURS (mcq, mcq_multi) :
- Prends-les dans le cours : notions voisines de l'extrait ou "TERMES D'AUTRES PARTIES DU COURS", propriété attribuée au mauvais concept, inversion, confusion classique entre notions proches.
- Même longueur, même style, même forme grammaticale que la bonne réponse. Jamais "toutes les réponses" ni "aucune".
- Jamais d'option absurde ou inventée hors du sujet.

RÈGLES :
- N'invente rien : tout doit être justifié par l'extrait.
- Une question = une notion. Aucun doublon : varie les notions et les formulations.
- Questions autonomes : jamais "selon l'extrait / le passage / le texte".
- Le cours contient des fautes de frappe et abréviations (apostrophes manquantes, Ag, RI…) : corrige-les dans "question" et dans les options.
- "explanation" : 1 à 3 phrases justifiant la bonne réponse. Ne cite jamais un numéro ou une lettre d'option (les options sont mélangées après coup).
- Champs inutilisés : options = [], correct_indices = [], tf_answer = false, cloze_answer = "".
- Réponds uniquement par un JSON {"questions":[...]} contenant exactement les questions demandées, dans l'ordre demandé.

EXEMPLES (pour la FORME uniquement — ne réutilise jamais leur contenu) :
${JSON.stringify({ questions: FEWSHOT })}`;

const slotLabel = (s, i) => s.type === 'tf'
  ? `${i + 1}. tf — réponse attendue : ${s.expected ? 'VRAI' : 'FAUX (modifie UN seul élément de la phrase du cours : un mot, un chiffre, une négation, une inversion)'}`
  : `${i + 1}. ${s.type}`;

function buildMessages({ subject, title, chunk, idx, total, slots, glossary, feedback }) {
  const user = [
    `Matière : ${subject}`,
    `Cours : ${title} (partie ${idx + 1}/${total})`,
    '',
    'EXTRAIT DU COURS :',
    '"""',
    chunk.slice(0, 7000),
    '"""',
    '',
    glossary.length ? `TERMES D'AUTRES PARTIES DU COURS (utilisables comme distracteurs) :\n${glossary.map(t => `- ${t}`).join('\n')}\n` : '',
    `QUESTIONS À PRODUIRE (exactement ${slots.length}, dans cet ordre) :`,
    ...slots.map(slotLabel),
    feedback ? `\nTA TENTATIVE PRÉCÉDENTE A ÉTÉ PARTIELLEMENT REJETÉE. Corrige ces défauts :\n${feedback}` : ''
  ].filter(x => x !== '').join('\n');
  return [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }];
}

// ---------- Appel Groq ----------
let schemaSupported = true;
async function callModel(client, messages) {
  const model = modelName();
  const base = {
    model,
    messages,
    temperature: Number(process.env.AI_TEMPERATURE ?? 0.4),
    max_completion_tokens: 4000
  };
  if (/gpt-oss/i.test(model)) base.reasoning_effort = process.env.AI_REASONING || 'low';

  let resp;
  if (schemaSupported) {
    try {
      resp = await client.chat.completions.create({
        ...base,
        response_format: { type: 'json_schema', json_schema: { name: 'quiz_questions', strict: true, schema: QUIZ_SCHEMA } }
      });
    } catch (e) {
      if (e?.status === 400 && /json_schema|response_format|structured|schema/i.test(String(e.message))) {
        schemaSupported = false;
        console.warn('[quiz] json_schema refusé, repli sur json_object :', e.message);
      } else throw e;
    }
  }
  if (!resp) resp = await client.chat.completions.create({ ...base, response_format: { type: 'json_object' } });

  const content = resp.choices?.[0]?.message?.content || '';
  const clean = content.replace(/^```(?:json)?|```$/gim, '').trim();
  const parsed = JSON.parse(clean);
  return Array.isArray(parsed.questions) ? parsed.questions : [];
}

// ---------- Validation ----------
const BAD_START = /^(?:Définition|Introduction|Résumé|Conclusion|Structure|Fonction|Description|Notion|Concept|Conditions|Modalités|Voies|Exemple|Remarque)(?![\p{L}])/iu;

function validateItem(item, slot, chunk) {
  const fail = (why) => ({ ok: false, why });
  if (!item || typeof item !== 'object') return fail('élément invalide');
  const type = slot.type;
  let q = String(item.question || '').trim();
  const excerpt = String(item.source_excerpt || '').trim();
  const expl = String(item.explanation || '').trim();
  const concept = String(item.concept || '').trim();
  const shortQ = `"${q.slice(0, 50)}…"`;

  if (!concept) return fail('concept manquant');
  if (excerpt.split(/\s+/).length < 3 || overlap(excerpt, chunk, 2) < 0.8)
    return fail(`source_excerpt doit être copié EXACTEMENT depuis le cours (question ${shortQ})`);
  if (expl.length < 20) return fail(`explication trop courte (question ${shortQ})`);
  if (q.length < 15 || q.length > 450) return fail(`longueur de question invalide (${shortQ})`);
  if (BAD_START.test(q)) return fail(`la question ressemble à un titre du cours (${shortQ}) : rédige une vraie question`);
  if (/\b(extrait|passage|ci-dessus)\b/i.test(q)) return fail(`la question mentionne "l'extrait" (${shortQ})`);
  if (/\b(option|réponse|proposition)\s+[A-D1-4]\b/i.test(expl)) return fail(`l'explication cite un numéro d'option (${shortQ})`);

  let options = [], correct;
  if (type === 'mcq' || type === 'mcq_multi') {
    if (!/\?\s*$/.test(q)) return fail(`la question doit finir par « ? » (${shortQ})`);
    if ((q.match(/:/g) || []).length > 1) return fail(`trop de « : », on dirait une recopie (${shortQ})`);
    if (overlap(q, chunk, 3) > 0.6 || (norm(q).length > 40 && norm(chunk).includes(norm(q))))
      return fail(`la question recopie le cours (${shortQ}) : reformule-la`);
    const opts = (Array.isArray(item.options) ? item.options : []).map(o => String(o).trim()).filter(Boolean);
    if (opts.length !== 4) return fail(`il faut exactement 4 options (${shortQ})`);
    if (new Set(opts.map(norm)).size !== 4) return fail(`options en double (${shortQ})`);
    if (opts.some(o => o.length > 300)) return fail(`option trop longue (${shortQ})`);
    const idxs = [...new Set((Array.isArray(item.correct_indices) ? item.correct_indices : []).filter(i => Number.isInteger(i) && i >= 0 && i < 4))];
    if (type === 'mcq' && idxs.length !== 1) return fail(`mcq : un seul index correct attendu (${shortQ})`);
    if (type === 'mcq_multi' && (idxs.length < 2 || idxs.length > 3)) return fail(`mcq_multi : 2 ou 3 index corrects attendus (${shortQ})`);
    // mélange des options pour éviter le biais de position de la bonne réponse
    const order = shuffled([0, 1, 2, 3]);
    options = order.map(i => opts[i]);
    const newCorrect = idxs.map(c => order.indexOf(c)).sort((a, b) => a - b);
    correct = type === 'mcq' ? newCorrect[0] : newCorrect;
  } else if (type === 'tf') {
    if (!/^Vrai ou Faux\s*:\s*\S/i.test(q)) return fail(`doit commencer par "Vrai ou Faux :" (${shortQ})`);
    if (typeof item.tf_answer !== 'boolean' || item.tf_answer !== slot.expected)
      return fail(`tf_answer doit valoir ${slot.expected} pour cette question (${shortQ})`);
    if (!slot.expected && overlap(q.replace(/^Vrai ou Faux\s*:/i, ''), chunk, 3) > 0.95)
      return fail(`affirmation FAUSSE identique au cours (${shortQ}) : modifie un élément`);
    correct = item.tf_answer;
  } else if (type === 'cloze') {
    if (!/^Complétez\s*:/i.test(q)) return fail(`doit commencer par "Complétez :" (${shortQ})`);
    if ((q.match(/_{3,}/g) || []).length !== 1) return fail(`exactement un trou ____ attendu (${shortQ})`);
    q = q.replace(/_{3,}/g, '____');
    const ans = String(item.cloze_answer || '').trim();
    if (!ans || ans.split(/\s+/).length > 4) return fail(`cloze_answer vide ou trop long (${shortQ})`);
    if (!norm(excerpt).includes(norm(ans))) return fail(`la réponse du trou doit figurer dans source_excerpt (${shortQ})`);
    correct = ans;
  } else return fail('type inconnu');

  return {
    ok: true,
    value: {
      type, concept, text: q, options, correct,
      explanation: expl.slice(0, 1500),
      sourceExcerpt: excerpt.slice(0, 500),
      source: 'ai-v2-schema', verified: true
    }
  };
}

function isDuplicate(v, seen) {
  const key = norm(v.concept), ex = norm(v.sourceExcerpt), toks = wordsOf(v.text);
  return seen.some(s => s.key === key || s.ex === ex || jaccard(s.toks, toks) >= 0.6);
}

// ---------- Génération pour une section (avec retry ciblé) ----------
async function generateForChunk({ client, chunk, idx, total, slots, glossary, subject, title, seen, stats }) {
  const accepted = [];
  const pending = [...slots];
  let feedback = '';

  for (let attempt = 1; attempt <= 3 && pending.length; attempt++) {
    stats.calls++;
    let items = [];
    try {
      items = await callModel(client, buildMessages({ subject, title, chunk, idx, total, slots: pending, glossary, feedback }));
    } catch (e) {
      stats.lastError = e?.message || String(e);
      console.error(`[quiz] section ${idx + 1} tentative ${attempt} : ${stats.lastError}`);
      continue;
    }
    const rejects = [];
    for (const item of items) {
      let si = pending.findIndex(s => s.type === item?.type && (s.type !== 'tf' || s.expected === item.tf_answer));
      if (si < 0) si = pending.findIndex(s => s.type === item?.type);
      if (si < 0) { rejects.push(`type inattendu ou en trop : "${item?.type}"`); stats.rejected++; continue; }
      const r = validateItem(item, pending[si], chunk);
      if (!r.ok) { rejects.push(r.why); stats.rejected++; console.log(`[quiz] ❌ s${idx + 1} : ${r.why}`); continue; }
      if (isDuplicate(r.value, seen)) { rejects.push(`doublon de notion : "${r.value.concept}"`); stats.rejected++; continue; }
      seen.push({ key: norm(r.value.concept), ex: norm(r.value.sourceExcerpt), toks: wordsOf(r.value.text) });
      accepted.push({ ...r.value, chunkIndex: idx });
      pending.splice(si, 1);
    }
    feedback = rejects.slice(0, 5).map(r => `- ${r}`).join('\n');
    console.log(`[quiz] section ${idx + 1} tentative ${attempt} : ${accepted.length}/${slots.length} validées`);
  }
  return { accepted, pending };
}

async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ---------- Route ----------
async function analyzeCourse(req, res) {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA non configurée. Ajoute AI_API_KEY dans Render.' });
  const { subject = 'Matière', title = 'Cours', sourceText, count = 20 } = req.body || {};
  const text = sanitizeText(String(sourceText || '').trim());
  const n = Math.max(1, Math.min(Number(count) || 20, 40));
  if (text.length < 150) return res.status(400).json({ error: 'Texte trop court après nettoyage.' });
  if (text.length > 60000) return res.status(413).json({ error: 'Texte trop long (max 60 000 caractères).' });

  const t0 = Date.now();
  const nChunks = Math.max(1, Math.min(14, Math.max(Math.ceil(n / 4), Math.ceil(text.length / 6000)), Math.floor(text.length / 800)));
  const chunks = splitIntoChunks(text, nChunks);
  const plan = buildTypePlan(n);
  const counts = allocate(n, chunks);
  const fullGlossary = buildGlossary(text);
  const seen = [];
  const stats = { calls: 0, rejected: 0, lastError: '' };
  console.log(`[analyze-course] ${text.length} car. · ${n} questions · ${chunks.length} sections · modèle ${modelName()}`);

  let cursor = 0;
  const jobs = [];
  chunks.forEach((chunk, i) => {
    const slots = plan.slice(cursor, cursor + counts[i]);
    cursor += counts[i];
    if (!slots.length) return;
    const nc = norm(chunk);
    const glossary = fullGlossary.filter(t => !nc.includes(norm(t))).slice(0, 25);
    jobs.push(() => generateForChunk({ client, chunk, idx: i, total: chunks.length, slots, glossary, subject, title, seen, stats }));
  });

  try {
    const results = await runPool(jobs, Number(process.env.AI_CONCURRENCY || 2));
    const questions = results.flatMap(r => r.accepted).map((q, i) => ({
      ...q,
      id: `diane-${Date.now()}-${i}`,
      number: i + 1,
      confidence: 0.9
    }));
    if (!questions.length) {
      throw new Error(`Aucune question valide.${stats.lastError ? ' Dernière erreur IA : ' + stats.lastError : ''}`);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[analyze-course] ✅ ${questions.length}/${n} questions · ${stats.calls} appels · ${stats.rejected} rejets · ${secs}s`);
    res.json({
      questions,
      concepts: questions.map(q => ({ concept: q.concept, type: '', detail: q.sourceExcerpt })).slice(0, 20),
      summary: '',
      coverage: `${questions.length}/${n}`,
      verified: questions.length,
      rejected: stats.rejected,
      model: modelName()
    });
  } catch (error) {
    console.error('=== ERREUR analyze-course ===', error?.message);
    res.status(502).json({ error: 'Analyse échouée : ' + (error?.message || 'inconnue') });
  }
}
app.post('/api/analyze-course', underDailyLimit, analyzeCourse);
app.post('/api/generate-questions', underDailyLimit, analyzeCourse);

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

app.listen(port, '0.0.0.0', () => {
  console.log(`CompoTest écoute sur le port ${port}`);
  console.log(`Modèle IA : ${modelName()}`);
  console.log(`Clé IA présente : ${Boolean(process.env.AI_API_KEY)}`);
});
