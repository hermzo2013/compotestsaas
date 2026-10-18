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
app.get('/api/health', (_req, res) => res.json({ ok: true, aiConfigured: Boolean(process.env.AI_API_KEY) }));

async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Connecte-toi à CompoTest pour utiliser cette fonction.' });
  try {
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return res.status(401).json({ error: 'Session expirée.' });
    const user = await response.json();
    if (!user?.id) return res.status(401).json({ error: 'Session invalide.' });
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
    timeout: 120000
  });
}
const modelName = () => process.env.AI_MODEL || 'openai/gpt-oss-20b';

// ==========================================
// 1. EXTRACTION LOCALE (Corrigée)
// ==========================================
function extractQuestionsLocally(text) {
  // Normalisation : on s'assure qu'il y a un espace après le point des numéros (ex: "1.Quelle" -> "1. Quelle")
  let cleanText = text.replace(/(\d+[\.\)])([A-ZÀ-Ýa-z])/g, '$1 $2');
  
  // Regex plus souple pour les questions (1., Q1., 1), etc.)
  const qRegex = /^(?:Q\s*)?(\d{1,3})[\.\)]\s+(.+)$/i;
  // Regex pour les options (A., A), a. , etc.)
  const optRegex = /^([A-D])[\.\)]\s+(.+)$/i;

  const lines = cleanText.split('\n');
  let questions = [];
  let currentQ = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Détection du corrigé en bas de page (on arrête l'extraction)
    if (/^1\s*[A-D]/.test(line) && line.length < 50) break;

    const qMatch = line.match(qRegex);
    if (qMatch) {
      if (currentQ && currentQ.options.length > 0) questions.push(currentQ);
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
        
        // Détection des réponses marquées (ex: PDF avec ✓)
        if (optText.includes('✓') || optText.includes('Réponse correcte') || line.includes('✓')) {
          isCorrect = true;
          optText = optText.replace(/✓|Réponse correcte.*/gi, '').trim();
        }
        
        currentQ.options.push(optText);
        if (isCorrect) currentQ.correct = currentQ.options.length - 1;
      } else if (!line.match(/^Page\s+\d+/i)) {
        // Détection Vrai/Faux
        if (line.match(/Réponse correcte\s*:\s*(VRAI|FAUX)/i)) {
          currentQ.type = 'tf';
          currentQ.correct = line.toUpperCase().includes('VRAI');
        } else if (currentQ.options.length === 0) {
          // C'est la suite du texte de la question
          currentQ.text += ' ' + line;
        }
      }
    }
  }
  if (currentQ && currentQ.options.length > 0) questions.push(currentQ);

  // Gestion du tableau de corrigé (Fichier INFAS : "1B 11B 21A...")
  const gridMatch = text.match(/(\d{1,3}\s*[A-D][\s\n]*){5,}/g);
  if (gridMatch) {
    const answers = {};
    gridMatch.forEach(block => {
      const pairs = block.match(/(\d{1,3})\s*([A-D])/g);
      if(pairs) {
        pairs.forEach(p => {
          const m = p.match(/(\d{1,3})\s*([A-D])/);
          if(m) answers[m[1]] = m[2];
        });
      }
    });

    questions.forEach(q => {
      if (answers[q.number]) {
        const optIndex = answers[q.number].charCodeAt(0) - 65; // A=0, B=1
        if (optIndex >= 0 && optIndex < q.options.length) {
          q.correct = optIndex;
        }
      }
    });
  }

  // Fallback : si pas de corrigé, on met la réponse A par défaut pour que le test soit soumissible
  questions.forEach(q => { if (q.correct === null) q.correct = 0; });

  return questions;
}

// ==========================================
// 2. ROUTES
// ==========================================
app.post('/api/parse-existing-quiz', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Texte manquant' });
  const questions = extractQuestionsLocally(text);
  res.json({ questions });
});

app.post('/api/generate-post-test', async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA non configurée.' });
  
  const { subject, title, sourceText, count = 10 } = req.body;
  const text = sourceText.slice(0, 15000); // On limite pour éviter le Timeout
  const n = Math.min(count, 20);

  try {
    // On force le français et un format JSON très strict
    const prompt = `Tu es un professeur francophone. Crée un post-test de ${n} questions en FRANÇAIS basé sur le texte suivant.
    
    RÈGLES ABSOLUES :
    - Langue : Français uniquement.
    - Types : QCM (4 options), Vrai/Faux, ou texte à trous.
    - Ne recopie pas le cours. Formule des questions claires.
    
    Format JSON strict :
    {
      "questions": [
        {"type": "mcq", "text": "Question ?", "options": ["A", "B", "C", "D"], "correct": 0, "explanation": "Explication"}
      ]
    }`;

    const response = await client.chat.completions.create({
      model: modelName(), temperature: 0.3, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: text }
      ]
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    const questions = (parsed.questions || []).map((q, i) => ({
      id: `gen-${i}`, number: i + 1, 
      type: q.type || 'mcq', 
      text: q.text, 
      options: q.options || [], 
      correct: typeof q.correct === 'number' ? q.correct : 0, 
      explanation: q.explanation || ''
    }));

    res.json({ questions });
  } catch (error) {
    console.error('[post-test] Erreur:', error.message);
    res.status(502).json({ error: 'Erreur de génération : ' + error.message });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`Serveur sur port ${port}`));
