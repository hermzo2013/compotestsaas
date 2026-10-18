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

// Middleware d'authentification (simplifié pour l'exemple, gardez votre logique Supabase)
async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Connecte-toi.' });
  // Ici, mettez votre logique de vérification Supabase
  req.user = { id: 'user-test' }; 
  next();
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
// 1. EXTRACTION LOCALE (Pour vos questionnaires PDF)
// ==========================================
function extractQuestionsLocally(text) {
  const lines = text.split('\n');
  let questions = [];
  let currentQ = null;
  
  // Regex pour détecter les questions (ex: "1. ", "Q1. ", "1) ")
  const qRegex = /^(?:Q\s*)?(\d{1,3})[.)]\s+(.+)$/i;
  // Regex pour détecter les options (ex: "A) ", "A. ")
  const optRegex = /^([A-D])[.)]\s+(.+)$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Détection d'un bloc de corrigé à la fin (ex: "1B 2B 3B" ou "1. B 2. B")
    if (/^1\s*[A-D]/.test(line) || /^1\s*[-:]\s*[A-D]/.test(line)) {
       // On arrête l'extraction des questions ici, le reste est le corrigé
       break; 
    }

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
        const optLetter = optMatch[1];
        let optText = optMatch[2].trim();
        let isCorrect = false;

        // Détection des réponses marquées (comme dans le PDF de Pharma)
        if (optText.includes('✓') || optText.includes('Réponse correcte') || line.includes('✓')) {
          isCorrect = true;
          optText = optText.replace(/✓|Réponse correcte.*/gi, '').trim();
        }

        currentQ.options.push(optText);
        if (isCorrect) {
          currentQ.correct = currentQ.options.length - 1;
        }
      } else if (!line.match(/^Page\s+\d+/i)) {
        // Si ce n'est pas une option, c'est la suite de la question (ou une réponse V/F)
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

  // Post-traitement pour le fichier INFAS (corrigé sous forme de tableau "1B 2B 3A...")
  // On cherche le bloc de corrigé à la fin du texte
  const corrigeBlockMatch = text.match(/1\s*B\s*11\s*B\s*21\s*A[\s\S]*/i); 
  if (corrigeBlockMatch) {
    // Extraction grossière de la grille (ex: "1B", "2A", "3C"...)
    const grid = corrigeBlockMatch[0].match(/(\d{1,3})\s*([A-D])/g);
    if (grid) {
      const answers = {};
      grid.forEach(item => {
        const match = item.match(/(\d{1,3})\s*([A-D])/);
        if (match) answers[parseInt(match[1])] = match[2];
      });
      
      // Application des réponses aux questions
      questions.forEach(q => {
        if (answers[q.number] && q.options.length > 0) {
          const correctLetter = answers[q.number];
          const optIndex = correctLetter.charCodeAt(0) - 65; // A=0, B=1...
          if (optIndex >= 0 && optIndex < q.options.length) {
            q.correct = optIndex;
          }
        }
      });
    }
  }

  // Filtrage : on ne garde que les questions avec au moins 2 options
  return questions.filter(q => q.options.length >= 2);
}

// ==========================================
// 2. ROUTE : EXTRAIRE UN QUESTIONNAIRE EXISTANT
// ==========================================
app.post('/api/parse-existing-quiz', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Texte manquant' });

  console.log(`[parse-existing] Analyse de ${text.length} caractères...`);
  const questions = extractQuestionsLocally(text);
  
  console.log(`[parse-existing] ${questions.length} questions extraites avec succès.`);
  res.json({ questions });
});

// ==========================================
// 3. ROUTE : GÉNÉRER UN POST-TEST (IA)
// ==========================================
app.post('/api/generate-post-test', async (req, res) => {
  const client = aiClient();
  if (!client) return res.status(503).json({ error: 'IA non configurée.' });
  
  const { subject, title, sourceText, count = 15 } = req.body;
  const text = sourceText.trim();
  const n = Math.min(count, 30);

  console.log(`[post-test] Début génération de ${n} questions...`);

  try {
    // Étape 1 : Extraction des concepts pour éviter le recopiage
    const extractionPrompt = `Extrait les 15 à 20 concepts clés de ce cours.
    Format JSON : {"concepts": [{"terme": "Nom", "definition": "Définition"}]}`;
    
    const extractRes = await client.chat.completions.create({
      model: modelName(), temperature: 0.1, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: extractionPrompt }, { role: 'user', content: text.slice(0, 20000) }]
    });
    
    const parsedExtract = JSON.parse(extractRes.choices[0].message.content);
    const concepts = parsedExtract.concepts || [];

    // Étape 2 : Génération des questions basées sur les concepts
    const generatePrompt = `Tu es un professeur. Crée un post-test de ${n} questions basé UNIQUEMENT sur ces concepts.
    RÈGLES : 
    1. Ne recopie JAMAIS le cours. Formule de vraies questions (Quel est..., Vrai ou Faux : ...).
    2. 40% "mcq" (4 options), 30% "mcq_multi", 30% "tf".
    3. Les mauvaises réponses doivent être des concepts VOISINS.
    Format JSON : {"questions": [{"type": "mcq", "text": "...", "options": ["A", "B", "C", "D"], "correct": 0, "explanation": "..."}]}`;

    const generateRes = await client.chat.completions.create({
      model: modelName(), temperature: 0.4, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: generatePrompt }, { role: 'user', content: JSON.stringify(concepts) }]
    });

    const parsedGen = JSON.parse(generateRes.choices[0].message.content);
    const questions = (parsedGen.questions || []).map((q, i) => ({
      id: `gen-${i}`,
      number: i + 1,
      type: q.type,
      text: q.text,
      options: q.options || [],
      correct: q.correct,
      explanation: q.explanation || '',
    }));

    console.log(`[post-test] ${questions.length} questions générées par l'IA.`);
    res.json({ questions });

  } catch (error) {
    console.error('[post-test] Erreur:', error.message);
    res.status(502).json({ error: 'Erreur de génération : ' + error.message });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`Serveur sur port ${port}`));
