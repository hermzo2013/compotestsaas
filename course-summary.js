export async function summarizeCourse(provider, courseText, options = {}) {
  const systemPrompt = `Tu es un professeur qui résume des cours pour des étudiants en santé en FRANÇAIS.

Produis un résumé structuré :
- Titre
- Points clés (5 à 10 puces)
- Notions à retenir (3 à 5)
- Pièges fréquents (2 à 3)

Sois concis, fidèle au texte, sans invention.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Résume ce cours :\n\n${String(courseText || '').slice(0, 15000)}` }
  ];

  const result = await provider.chat(messages, {
    temperature: 0.3,
    maxTokens: 1500,
    signal: options.signal
  });

  return { summary: result.content, _usage: result.usage, _raw: result.raw };
}