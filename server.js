import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' })); // Augmenté pour les grosses réponses

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/config.js', (_req, res) => res.sendFile(path.join(__dirname, 'config.js'), { headers: { 'Cache-Control': 'no-store' } }));
app.get('/api/health', (_req, res) => res.json({ ok: true, aiConfigured: Boolean(process.env.AI_API_KEY) }));

async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Connecte-toi.' });
  try {
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return res.status(401).json({ error: 'Session expirée.' });
    const user = await response.json();
    req.user = { id: user.id, email: user.email };
    next();
  } catch { return res.status(503).json({ error: 'Vérification indisponible.' }); }
}
app.use('/api', (req, res, next) => req.path === '/health' ? next() : authenticate(req, res, next));

function aiClient() {
  if (!process.env.AI_API_KEY) return null;
  return new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
    timeout: 180000
  });
}
const modelName = () => process.env.AI_MODEL || 'openai/gpt-oss-20b';

// ==========================================
// 1. EXTRACTION LOCALE
// ==========================================
function parseQuizText(text) {
  let clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').replace(/Page\s+\d+/gi, ' ');
  let blocks = clean.split(/(?=(?:Q\s*)?\d{1,3}[\.\)]\s)/i);
  let questions = [];

  for (let block of blocks) {
    block = block.trim();
    if (!block) continue;
    const matchNum = block.match(/^(?:Q\s*)?(\d{1,3})[\.\)]\s(.*)/i);
    if (!matchNum) continue;
    
    let num = parseInt(matchNum[1]);
    let content = matchNum[2];
    let parts = content.split(/(?=\s[A-D][\.\)]\s)/i);
    let qText = parts[0].trim();
    let options = [];
    
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) {
        let optText = parts[i].replace(/^\s*[A-D][\.\)]\s/i, '').trim();
        if (optText) options.push(optText);
      }
    }

    if (options.length === 0) {
      options = ['Vrai', 'Faux'];
    }

    if (qText.length > 5) {
      questions.push({
        number: num, text: qText, options: options, correct: 0,
        type: options.length === 2 && options[0] === 'Vrai' ? 'tf' : 'mcq'
      });
    }
  }
  return questions;
}

// ==========================================
// 2. IA GENERATION (Forcée à 50 Q)
// ==========================================
app.post('/api/generate-post-test', async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA non configurée.' });
  
  const { subject, title, sourceText } = req.body;
  const text = sourceText.slice(0, 15000);
  const n = 50; // ON FORCE À 50

  try {
    // Prompt EXTRÊMEMENT strict pour forcer la génération complète
    const prompt = `Tu es un professeur. Génère EXACTEMENT ${n} questions en FRANÇAIS.
    (Si tu ne génères pas ${n} questions, la requête échouera).
    
    Répartition imposée :
    - 15 QCM (choix unique)
    - 15 QCD (Vrai/Faux)
    - 10 QCU (choix multiple / texte à trous)
    - 10 Questions courtes
    
    Format JSON STRICT (pas de texte avant ou après) :
    {"questions":[
      {"type":"mcq","text":"...","options":["A","B","C","D"],"correct":0,"explanation":"..."},
      {"type":"tf","text":"...","options":["Vrai","Faux"],"correct":0,"explanation":"..."}
    ]}`;

    const response = await client.chat.completions.create({
      model: modelName(), 
      temperature: 0.4, 
      max_tokens: 8000, // Force une réponse très longue
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `Voici le texte : ${text}` }
      ]
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    const questions = (parsed.questions || []).map((q, i) => ({
      id: `gen-${i}`, number: i + 1, 
      type: q.type || 'mcq', 
      text: q.text, 
      options: q.options || ['Vrai', 'Faux'], 
      correct: typeof q.correct === 'number' ? q.correct : 0, 
      explanation: q.explanation || ''
    }));

    if (questions.length === 0) throw new Error("L'IA n'a pas généré de questions.");

    res.json({ questions });
  } catch (error) {
    console.error('[post-test] Erreur:', error.message);
    res.status(502).json({ error: 'Erreur de génération : ' + error.message });
  }
});

app.post('/api/parse-existing-quiz', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Texte manquant' });
  const questions = parseQuizText(text);
  res.json({ questions });
});

app.listen(port, '0.0.0.0', () => console.log(`Serveur sur port ${port}`));
