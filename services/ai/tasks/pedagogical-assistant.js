export async function pedagogicalAssistant(provider, question, context = {}, options = {}) {
  const systemPrompt = `Tu es un assistant pédagogique bienveillant pour des étudiants en santé (Révisio).

Règles :
- Réponds en FRANÇAIS, de façon claire et structurée.
- Explique les notions difficiles avec des exemples concrets.
- Si le contexte fourni ne contient pas l'information, dis-le honnêtement et propose une piste.
- N'invente JAMAIS de cours, de chapitre ou de référence inexistante.
- Sois concis (max 400 mots) sauf demande explicite de développement.
- Utilise des listes à puces pour les étapes.`;

  const contextText = context && context.course ? `\n\nContexte disponible (cours de l'utilisateur) :\n${String(context.course).slice(0, 8000)}` : '';

  const messages = [
    { role: 'system', content: systemPrompt + contextText },
    { role: 'user', content: String(question || '').slice(0, 2000) }
  ];

  const result = await provider.chat(messages, {
    temperature: 0.6,
    maxTokens: 1500,
    signal: options.signal
  });

  return {
    answer: result.content,
    _usage: result.usage,
    _raw: result.raw
  };
}