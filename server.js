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
app.get('/site.jpg', (_req, res) => res.sendFile(path.join(__dirname, 'site.jpg')));

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  aiConfigured: Boolean(process.env.AI_API_KEY),
  authConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
  aiModel: process.env.AI_MODEL || 'openai/gpt-oss-20b'
}));

// ==========================================
// MIDDLEWARE D'AUTHENTIFICATION (Corrigé)
// ==========================================
async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return res.status(401).json({ error: 'Connecte-toi à CompoTest pour utiliser cette fonction.' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return res.status(503).json({ error: 'Supabase non configuré côté serveur.' });
  }

  try {
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { 
        apikey: process.env.SUPABASE_ANON_KEY, 
        Authorization: `Bearer ${token}` 
      }
    });

    if (!response.ok) {
      return res.status(401).json({ error: 'Session expirée ou invalide. Reconnecte-toi.' });
    }

    const user = await response.json();
    if (!user?.id || !user?.email) {
      return res.status(401).json({ error: 'Session utilisateur invalide.' });
    }

    req.user = { id: user.id, email: user.email };
    next();
  } catch (error) {
    console.error('Erreur Auth:', error);
    return res.status(503).json({ error: 'Vérification de session indisponible.' });
  }
}

// Applique l'authentification à toutes les routes /api sauf /health
app.use('/api', (req, res, next) => req.path === '/health' ? next() : authenticate(req, res, next));

// ==========================================
// IA (Groq)
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
// EXTRACTION LOCALE (Questionnaires existants)
// ==========================================
function extractQuestionsLocally(text) {
  const lines = text.split('\n');
  let questions = [];
  let currentQ = null;
  
  const qRegex = /^(?:Q\s*)?(\d{1,3})[.)]\s+(.+)$/i;
  const optRegex = /^([A-D])[.)]\s+(.+)$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (/^1\s*[A-D]/.test(line) || /^1\s*[-:]\s*[A-D]/.test(line)) break;

    const qMatch = line.match(qRegex);
    if (qMatch) {
      if (currentQ) questions.push(currentQ);
      currentQ = {
        number: parseInt(qMatch[1]),
        text: qMatch[2].trim(),
        options: [],
        correct: null,
        type: 'mcq'
      };
      continue;
    }

    if (currentQ) {
      const optMatch = line.match(optRegex);
      if (optMatch) {
        let optText = optMatch[2].trim();
        let isCorrect = false;
        if (optText.includes('✓') || optText.includes('Réponse correcte') || line.includes('✓')) {
          isCorrect = true;
          optText = optText.replace(/✓|Réponse correcte.*/gi, '').trim();
        }
        currentQ.options.push(optText);
        if (isCorrect) currentQ.correct = currentQ.options.length - 1;
      } else if (!line.match(/^Page\s+\d+/i)) {
        if (line.match(/Réponse correcte\s*:\s*(VRAI|FAUX)/i)) {
          currentQ.type = 'tf';
          currentQ.correct = line.toUpperCase().includes('VRAI');
        } else {
          currentQ.text += ' ' + line;
        }
      }
    }
  }
  if (currentQ) questions.push(currentQ);

  const corrigeBlockMatch = text.match(/1\s*B\s*11\s*B\s*21\s*A[\s\S]*/i); 
  if (corrigeBlockMatch) {
    const grid = corrigeBlockMatch[0].match(/(\d{1,3})\s*([A-D])/g);
    if (grid) {
      const answers = {};
      grid.forEach(item => {
        const match = item.match(/(\d{1,3})\s*([A-D])/);
        if (match) answers[parseInt(match[1])] = match[2];
      });
      questions.forEach(q => {
        if (answers[q.number] && q.options.length > 0) {
          const optIndex = answers[q.number].charCodeAt(0) - 65;
          if (optIndex >= 0 && optIndex < q.options.length) q.correct = optIndex;
        }
      });
    }
  }
  return questions.filter(q => q.options.length >= 2);
}

// ==========================================
// ROUTES
// ==========================================
app.post('/api/parse-existing-quiz', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Texte manquant' });
  console.log(`[parse-existing] Analyse de ${text.length} caractères...`);
  const questions = extractQuestionsLocally(text);
  console.log(`[parse-existing] ${questions.length} questions extraites.`);
  res.json({ questions });
});

app.post('/api/generate-post-test', async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA non configurée.' });
  
  const { subject, title, sourceText, count = 15 } = req.body;
  const text = sourceText.trim();
  const n = Math.min(count, 30);

  console.log(`[post-test] Début génération de ${n} questions...`);

  try {
    const extractionPrompt = `Extrait les 15 à 20 concepts clés de ce cours. Format JSON : {"concepts": [{"terme": "Nom", "definition": "Définition"}]}`;
    const extractRes = await client.chat.completions.create({
      model: modelName(), temperature: 0.1, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: extractionPrompt }, { role: 'user', content: text.slice(0, 20000) }]
    });
    const concepts = JSON.parse(extractRes.choices[0].message.content).concepts || [];

    const generatePrompt = `Tu es un professeur. Crée un post-test de ${n} questions basé sur ces concepts. RÈGLES : 1. Ne recopie pas. Formule de vraies questions. 2. 40% "mcq", 30% "mcq_multi", 30% "tf". Format JSON : {"questions": [{"type": "mcq", "text": "...", "options": ["A", "B", "C", "D"], "correct": 0, "explanation": "..."}]}`;
    const generateRes = await client.chat.completions.create({
      model: modelName(), temperature: 0.4, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: generatePrompt }, { role: 'user', content: JSON.stringify(concepts) }]
    });

    const questions = (JSON.parse(generateRes.choices[0].message.content).questions || []).map((q, i) => ({
      id: `gen-${i}`, number: i + 1, type: q.type, text: q.text, options: q.options || [], correct: q.correct, explanation: q.explanation || ''
    }));

    console.log(`[post-test] ${questions.length} questions générées.`);
    res.json({ questions });
  } catch (error) {
    console.error('[post-test] Erreur:', error.message);
    res.status(502).json({ error: 'Erreur de génération : ' + error.message });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`Serveur sur port ${port}`));
