// Traductions côté serveur pour les notifications automatiques (nouveaux quiz). Langue par défaut : français.
export const SUPPORTED_LANGS = ['fr', 'en'];
export const DEFAULT_LANG = 'fr';

const DICT = {
  fr: {
    'quiz.one.title': 'Nouveau quiz disponible',
    'quiz.many.title': '{n} nouveaux quiz disponibles'
  },
  en: {
    'quiz.one.title': 'New quiz available',
    'quiz.many.title': '{n} new quizzes available'
  }
};

export const normLang = (l) => {
  const v = String(l || '').toLowerCase().slice(0, 2);
  return SUPPORTED_LANGS.includes(v) ? v : DEFAULT_LANG;
};

export function t(lang, key, vars = {}) {
  const s = (DICT[normLang(lang)] || DICT[DEFAULT_LANG])[key] || DICT[DEFAULT_LANG][key] || key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}
