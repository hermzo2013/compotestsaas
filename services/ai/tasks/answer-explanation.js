import { ExplanationSchema } from '../schemas/explanation.schema.js';
import { extractJson, validateResponse } from '../ai-validator.js';

export async function explainAnswer(provider, payload, options = {}) {
  const { question, studentAnswer, correctAnswer, context } = payload;

  const systemPrompt = `Tu es un correcteur pédagogique en FRANÇAIS pour des étudiants en santé.

Analyse la réponse de l'étudiant et renvoie un JSON strict :

{
  "is_correct": true/false,
  "correct_answer": "la bonne réponse",
  "explanation": "explication pédagogique structurée (2-4 phrases)",
  "pedagogical_hint": "conseil pour progresser (optionnel)",
  "similar_exercise": "exercice similaire proposé (optionnel)"
}

Règles :
- Compare la réponse de l'étudiant à la bonne réponse.
- Explique POURQUOI c'est correct ou incorrect.
- Ne sois pas condescendant.
- Renvoie UNIQUEMENT le JSON.`;

  const userContent = `Question : ${question}

Réponse de l'étudiant : ${studentAnswer}
Bonne réponse : ${correctAnswer}
${context ? `Contexte : ${context}` : ''}`;

  const result = await provider.chat(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
    { temperature: 0.3, maxTokens: 800, jsonMode: true, signal: options.signal }
  );

  const parsed = extractJson(result.content);
  if (!parsed) throw new Error('Réponse IA invalide : JSON introuvable.');

  const validation = validateResponse(ExplanationSchema, parsed);
  if (!validation.valid) throw new Error('Réponse IA invalide : ' + validation.errors.map(e => e.message).join('; '));

  return { ...validation.data, _usage: result.usage, _raw: result.raw };
}