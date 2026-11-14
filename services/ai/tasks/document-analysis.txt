import { extractJson } from '../ai-validator.js';

const SYSTEM_PROMPT = `Tu es un expert en analyse de documents pédagogiques en FRANÇAIS.

Analyse le contenu fourni (texte extrait d'un PDF ou d'une image) et renvoie un JSON structuré :

{
  "text": "texte complet extrait et nettoyé",
  "questions": [
    {
      "number": 1,
      "text": "énoncé de la question",
      "options": ["A", "B", "C", "D"],
      "correct": 0,
      "type": "mcq",
      "explanation": "..."
    }
  ],
  "warnings": ["avertissement 1", "..."]
}

Règles :
- Si le document contient déjà des questions numérotées, conserve-les TOUTES avec leurs options.
- Détecte les bonnes réponses (soulignées, en gras, marquées ✓).
- Préserve la numérotation d'origine.
- N'invente aucune question.
- Renvoie UNIQUEMENT le JSON.`;

export async function analyzeDocument(provider, content, options = {}) {
  const isImage = options.isImage === true;

  const userContent = isImage
    ? [
        { type: 'text', text: 'Analyse cette image de sujet d\'examen et extrais toutes les questions.' },
        { type: 'image_url', image_url: { url: options.imageDataUrl } }
      ]
    : `Analyse ce document et extrais toutes les questions :\n\n${String(content || '').slice(0, 30000)}`;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent }
  ];

  const result = await provider.chat(messages, {
    temperature: 0.2,
    maxTokens: 8000,
    jsonMode: true,
    signal: options.signal
  });

  const parsed = extractJson(result.content);
  if (!parsed) throw new Error('Réponse IA invalide : JSON introuvable.');

  return {
    ...parsed,
    _usage: result.usage,
    _raw: result.raw
  };
}