import { QuizResponseSchema } from '../schemas/quiz.schema.js';
import { validateResponse, repairQuizResponse, extractJson } from '../ai-validator.js';

const SYSTEM_PROMPT = `Tu es un expert en création de quiz pédagogiques en FRANÇAIS pour des étudiants en santé.

Ta mission est d'analyser le texte fourni et de déterminer s'il s'agit :
1. D'UN QUESTIONNAIRE DÉJÀ EXISTANT (questions numérotées, choix multiples, Vrai/Faux)
2. D'UN COURS RÉDIGÉ (texte explicatif sans questions)

RÈGLES STRICTES :

CAS 1 (questionnaire existant) :
- Extrais TOUTES les questions existantes.
- Conserve leurs options et, si le texte les mentionne (soulignées, en gras, "Réponse:", ✓), conserve-les.
- Si les réponses ne sont pas mentionnées, mets "correct": 0 par défaut.
- Si le sujet précise "QCM à réponse unique", ajoute "max_select": 1. Si "plusieurs réponses", ajoute "max_select" au nombre d'options.
- Les études de cas : ajoute "blocks" à la racine et "block_id" sur chaque question concernée.
- Mode QPQ : si le sujet indique "pas de retour en arrière", "dossier progressif", ajoute "display_mode": "QPQ".

CAS 2 (cours rédigé) :
- Génère environ {count} questions en respectant :
  * ~50% "mcq" (choix unique)
  * ~20% "mcq_multi" (plusieurs bonnes réponses)
  * ~20% "tf" (Vrai/Faux)
  * ~10% "short" (réponse courte)
- Fournis TOUJOURS une "explanation" courte.

FORMAT DE SORTIE OBLIGATOIRE (JSON valide) :
{"questions":[{"type":"mcq","text":"...","options":["A","B","C","D"],"correct":0,"explanation":"..."}]}

Analyse silencieusement le texte, puis renvoie UNIQUEMENT le JSON.`;

export async function generateQuiz(provider, text, options = {}) {
  const count = options.count || 50;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT.replace('{count}', count) },
    { role: 'user', content: String(text || '').slice(0, 15000) }
  ];

  const result = await provider.chat(messages, {
    temperature: 0.4,
    maxTokens: 8000,
    jsonMode: true,
    signal: options.signal
  });

  let parsed = extractJson(result.content);
  if (!parsed) {
    throw new Error('Réponse IA invalide : JSON introuvable dans la réponse.');
  }

  parsed = repairQuizResponse(parsed);
  const validation = validateResponse(QuizResponseSchema, parsed);
  if (!validation.valid) {
    const details = validation.errors.slice(0, 5).map(e => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`Réponse IA invalide : ${details}`);
  }

  return {
    ...validation.data,
    _usage: result.usage,
    _raw: result.raw
  };
}