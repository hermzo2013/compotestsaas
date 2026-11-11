import { extractJson } from '../ai-validator.js';

export async function analyzeStudentProgress(provider, historyData, options = {}) {
  if (!Array.isArray(historyData) || historyData.length === 0) {
    throw new Error('Aucune donnée d\'historique disponible.');
  }

  const systemPrompt = `Tu es un analyste pédagogique en FRANÇAIS.

Analyse les résultats d'un étudiant et renvoie un JSON :

{
  "strengths": ["point fort 1", "..."],
  "weaknesses": ["point faible 1", "..."],
  "recommendations": ["recommandation 1", "..."],
  "overall_trend": "improving|stable|declining"
}

Règles :
- Base-toi UNIQUEMENT sur les données fournies.
- N'invente aucun chiffre.
- Sois concret et bienveillant.
- Renvoie UNIQUEMENT le JSON.`;

  const summary = historyData.slice(-20).map(h => ({
    title: h.title,
    score: h.score,
    date: h.date
  }));

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Historique (derniers quiz) :\n${JSON.stringify(summary, null, 2)}` }
  ];

  const result = await provider.chat(messages, {
    temperature: 0.3,
    maxTokens: 1000,
    jsonMode: true,
    signal: options.signal
  });

  const parsed = extractJson(result.content);
  if (!parsed) throw new Error('Réponse IA invalide : JSON introuvable.');
  return { ...parsed, _usage: result.usage, _raw: result.raw };
}