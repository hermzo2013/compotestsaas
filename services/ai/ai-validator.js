import { z } from 'zod';

/**
 * Valide une réponse IA selon un schéma Zod.
 * @returns {{valid:boolean, data?:any, errors?:Array<{path:string,message:string}>}}
 */
export function validateResponse(schema, data) {
  const r = schema.safeParse(data);
  if (r.success) return { valid: true, data: r.data };
  return {
    valid: false,
    errors: r.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
  };
}

/**
 * Tente de réparer une réponse IA courante (JSON invalide, champs manquants).
 */
export function repairQuizResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (!Array.isArray(parsed.questions)) return parsed;

  parsed.questions = parsed.questions.map(q => {
    if (!q || typeof q !== 'object') return q;
    // Type par défaut
    if (!q.type) q.type = Array.isArray(q.correct) && q.correct.length > 1 ? 'mcq_multi' : 'mcq';
    // Vrai/Faux : forcer les options
    if (q.type === 'tf' && (!Array.isArray(q.options) || q.options.length !== 2)) {
      q.options = ['Vrai', 'Faux'];
    }
    // mcq_multi : correct doit être un tableau
    if (q.type === 'mcq_multi' && !Array.isArray(q.correct)) {
      q.correct = [q.correct].filter(x => x !== undefined);
    }
    // mcq : correct doit être un entier
    if (q.type === 'mcq' && Array.isArray(q.correct)) {
      q.correct = q.correct.length ? q.correct[0] : 0;
    }
    // Texte
    if (typeof q.text !== 'string') q.text = String(q.text || '');
    // Options
    if (q.type !== 'short' && (!Array.isArray(q.options) || q.options.length < 2)) {
      q.options = Array.isArray(q.options) ? q.options : [];
    }
    // Explanation
    if (typeof q.explanation !== 'string') q.explanation = '';
    return q;
  });

  return parsed;
}

/**
 * Extrait le JSON d'une réponse IA (supporte ```json ... ``` ou JSON brut).
 */
export function extractJson(content) {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  // Bloc de code markdown
  const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (blockMatch) text = blockMatch[1].trim();
  // Tentative directe
  try { return JSON.parse(text); } catch (e) {}
  // Cherche le premier { ... } équilibré
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch (e) { return null; }
      }
    }
  }
  return null;
}