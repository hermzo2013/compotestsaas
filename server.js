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
    timeout: 120000
  });
}
const modelName = () => process.env.AI_MODEL || 'openai/gpt-oss-20b';

// ==========================================
// ALGORITHME D'EXTRACTION (Version Bloc)
// ==========================================
function parseQuizText(text) {
  // Nettoyage de base
  let clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
  clean = clean.replace(/Page\s+\d+/gi, ' ');
  
  // Séparation des blocs de questions (ex: "1. ", "Q1. ", "1) ")
  // On cherche un chiffre suivi d'un point ou d'une parenthèse
  let blocks = clean.split(/(?=(?:Q\s*)?\d{1,3}[\.\)]\s)/i);
  
  let questions = [];

  for (let block of blocks) {
    block = block.trim();
    if (!block) continue;
    
    // On vérifie si le bloc commence bien par un numéro
    const matchNum = block.match(/^(?:Q\s*)?(\d{1,3})[\.\)]\s(.*)/i);
    if (!matchNum) continue;
    
    let num = parseInt(matchNum[1]);
    let content = matchNum[2];

    // Maintenant, on sépare le texte de la question des options (A, B, C, D)
    // L'option commence par "A)" ou "A." (avec un espace avant si possible)
    let parts = content.split(/(?=\s[A-D][\.\)]\s)/i);
    
    let qText = parts[0].trim();
    let options = [];
    
    // Si on a trouvé des options
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) {
        let optText = parts[i].replace(/^\s*[A-D][\.\)]\s/i, '').trim();
        if (optText) options.push(optText);
      }
    }

    // Détection Vrai/Faux (si pas d'options A-B-C-D trouvées)
    let type = 'mcq';
    if (options.length === 0) {
      type = 'tf'; // Par défaut si aucune option n'est trouvée, c'est sûrement un V/F ou question ouverte
      if (qText.toLowerCase().includes('vrai') && qText.toLowerCase().includes('faux')) {
        options = ['Vrai', 'Faux'];
      } else {
        options = ['Vrai', 'Faux']; // Fallback
      }
    }

    // On nettoie le texte de la question (au cas où il reste des résidus)
    qText = qText.replace(/\s+/g, ' ');

    if (qText.length > 5) {
      questions.push({
        number: num,
        text: qText,
        options: options,
        correct: 0, // Par défaut la première option, sera corrigé si le corrigé est trouvé
        type: options.length === 2 && options[0] === 'Vrai' ? 'tf' : 'mcq'
      });
    }
  }

  // Gestion du corrigé (Fichier INFAS : "1B 2B 3A...")
  const gridMatch = text.match(/(?:1\s*[A-D][\s\n]*){3,}/i);
  if (gridMatch) {
    const answers = {};
    const pairs = gridMatch[0].match(/(\d{1,3})\s*([A-D])/gi);
    if(pairs) {
      pairs.forEach(p => {
        const m = p.match(/(\d{1,3})\s*([A-D])/i);
        if(m) answers[parseInt(m[1])] = m[2].toUpperCase();
      });
    }

    questions.forEach(q => {
      if (answers[q.number]) {
        const optIndex = answers[q.number].charCodeAt(0) - 65; // A=0, B=1
        if (optIndex >= 0 && optIndex < q.options.length) {
          q.correct = optIndex;
        }
      }
    });
  }

  return questions;
}

// ==========================================
// ROUTES
// ==========================================
app.post('/api/parse-existing-quiz', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Texte manquant' });
  
  const questions = parseQuizText(text);
  console.log(`[extract] ${questions.length} questions trouvées.`);
  
  if (questions.length === 0) {
    return res.status(400).json({ error: 'Aucun format de question reconnu. Essayez de copier le texte dans la zone.' });
  }
  
  res.json({ questions });
});

app.post('/api/generate-post-test', async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA non configurée.' });
  
  const { subject, title, sourceText, count = 20 } = req.body;
  const text = sourceText.slice(0, 18000);
  const n = Math.min(count, 50); // Max 50 questions

  try {
    const prompt = `Tu es un professeur francophone. Crée un post-test de ${n} questions en FRANÇAIS basé sur le texte suivant.
    
    RÈGLES ABSOLUES :
    - Langue : Français uniquement.
    - Mix de types : 25% QCD (Vrai/Faux), 25% QCM (choix multiples), 25% QCU (choix unique), 25% Texte à trous.
    - Ne recopie pas le cours. Formule des questions claires et pédagogiques.
    - Les options de réponse doivent être réalistes.
    
    Format JSON strict :
    {
      "questions": [
        {"type": "mcq", "text": "Question ?", "options": ["Option 1", "Option 2", "Option 3", "Option 4"], "correct": 0, "explanation": "Explication"},
        {"type": "tf", "text": "Affirmation ?", "options": ["Vrai", "Faux"], "correct": 1, "explanation": "Explication"}
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
