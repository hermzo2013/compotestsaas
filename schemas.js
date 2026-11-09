import { z } from 'zod';

// ---------- Utilitaires ----------
export const firstMessage = (err) => err.issues[0]?.message || 'Données invalides.';

/** Middleware : valide req[source] avec un schéma Zod ; renvoie 400 { error, details } sinon. */
export function validate(schema, source = 'body', message = null) {
  return (req, res, next) => {
    const r = schema.safeParse(req[source] ?? {});
    if (!r.success) {
      return res.status(400).json({
        error: message || firstMessage(r.error),
        details: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      });
    }
    req[source] = r.data;
    next();
  };
}

const msg = (m) => ({ errorMap: () => ({ message: m }) });
const LEVELS = ['LICENCE 1', 'LICENCE 2', 'LICENCE 3'];

// ---------- Identifiants dans l'URL ----------
export const quizIdParam = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Identifiant invalide.') });
export const userIdParam = z.object({ id: z.string().uuid('Identifiant invalide.') });

// ---------- Quiz ----------
const EXTRA_KEYS = ['display_mode', 'blocks', 'time_limit_seconds', 'scoring', 'seconds_per_question'];

const quizExtras = {
  display_mode: z.enum(['NORMAL', 'QPQ'], msg('display_mode invalide (NORMAL ou QPQ).')).optional(),
  blocks: z.array(z.any(), { invalid_type_error: 'blocks doit être un tableau (100 max).' })
    .max(100, 'blocks doit être un tableau (100 max).')
    .transform((arr) => arr.map((b) => ({
      id: String(b && b.id),
      title: String((b && b.title) || '').slice(0, 160),
      case_block: b && b.case_block ? String(b.case_block).slice(0, 8000) : null
    }))).optional(),
  time_limit_seconds: z.coerce.number(msg('time_limit_seconds doit être un entier entre 60 et 28800.'))
    .int('time_limit_seconds doit être un entier entre 60 et 28800.')
    .min(60, 'time_limit_seconds doit être un entier entre 60 et 28800.')
    .max(28800, 'time_limit_seconds doit être un entier entre 60 et 28800.').optional(),
  scoring: z.any().superRefine((sc, ctx) => {
    if (sc === null) return;
    if (typeof sc !== 'object' || Array.isArray(sc)) return ctx.addIssue({ code: 'custom', message: 'scoring doit être un objet.' });
    for (const k of ['correct', 'wrong', 'blank']) {
      if (sc[k] === undefined) continue;
      const v = Number(sc[k]);
      if (!Number.isFinite(v) || Math.abs(v) > 100) return ctx.addIssue({ code: 'custom', message: `scoring.${k} invalide.` });
    }
  }).transform((sc) => {
    if (sc === null) return null;
    const out = {};
    for (const k of ['correct', 'wrong', 'blank']) if (sc[k] !== undefined) out[k] = Number(sc[k]);
    return out;
  }).optional(),
  seconds_per_question: z.coerce.number(msg('seconds_per_question doit être un entier entre 10 et 900.'))
    .int('seconds_per_question doit être un entier entre 10 et 900.')
    .min(10, 'seconds_per_question doit être un entier entre 10 et 900.')
    .max(900, 'seconds_per_question doit être un entier entre 10 et 900.').optional()
};

/** Champs optionnels des modes NORMAL / QPQ, déjà validés, à transmettre à Supabase. */
export const extrasOf = (data) => Object.fromEntries(EXTRA_KEYS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));

const REQUIRED = 'Titre et questions requis.';
export const createQuizSchema = z.object({
  title: z.string({ required_error: REQUIRED, invalid_type_error: REQUIRED }).trim().min(1, REQUIRED),
  subject: z.any().optional(),
  level: z.any().optional(),
  questions: z.array(z.any(), { required_error: REQUIRED, invalid_type_error: REQUIRED }).min(1, REQUIRED),
  ...quizExtras
}).passthrough();

export const updateQuizSchema = z.object({
  questions: z.array(z.any(), { invalid_type_error: 'Tableau de questions requis.' }).min(1, 'Tableau de questions requis.').optional(),
  level: z.enum(LEVELS, msg('Niveau invalide.')).optional(),
  ...quizExtras
}).passthrough().refine((b) => b.questions !== undefined || b.level !== undefined || EXTRA_KEYS.some((k) => b[k] !== undefined), {
  message: 'Aucune modification fournie.'
});

export const quizzesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
}).passthrough();

// ---------- Administration des comptes ----------
export const adminCreateUserSchema = z.object({
  firstName: z.any().transform((v) => String(v || '').trim()),
  lastName: z.any().transform((v) => String(v || '').trim()),
  email: z.any().transform((v) => String(v || '').trim().toLowerCase()),
  password: z.any().transform((v) => String(v || '')),
  niveau: z.any().transform((v) => String(v || '').trim())
}).superRefine((b, ctx) => {
  if (!b.firstName || !b.lastName) return ctx.addIssue({ code: 'custom', message: 'Nom et prénom requis.' });
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return ctx.addIssue({ code: 'custom', message: 'Email invalide.' });
  if (b.password.length < 6) return ctx.addIssue({ code: 'custom', message: 'Mot de passe trop court (6 min).' });
});
export const adminPasswordSchema = z.object({
  password: z.any().transform((v) => String(v || ''))
}).refine((b) => b.password.length >= 6, { message: 'Mot de passe trop court.' });
export const adminStatusSchema = z.object({ banned: z.any().transform(Boolean) });
export const adminRoleSchema = z.object({ is_admin: z.any().transform((v) => v === true) });

// ---------- IA ----------
const textField = z.any().transform((v) => (v == null ? '' : String(v)));
export const generateSchema = z.object({
  text: textField,
  count: z.coerce.number().int('Nombre de questions invalide (1 à 100).').min(1, 'Nombre de questions invalide (1 à 100).')
    .max(100, 'Nombre de questions invalide (1 à 100).').default(50)
});
export const parseExistingSchema = z.object({ text: textField });

// ---------- Notifications ----------
const lang = z.enum(['fr', 'en'], msg('Langue invalide.'));
const level = z.enum(LEVELS, msg('Niveau invalide.')).nullable();
const subjects = z.array(z.string().trim().min(1).max(80), msg('Matières invalides.')).max(30, 'Matières invalides.');
const prefShape = {
  notify_quiz: z.boolean().optional(),
  notify_messages: z.boolean().optional(),
  preferred_subjects: subjects.optional(),
  preferred_level: level.optional(),
  language: lang.optional()
};
const PREF_KEYS = Object.keys(prefShape);
const hasPref = (b) => PREF_KEYS.some((k) => b[k] !== undefined);

const fcmToken = z.string().regex(/^[A-Za-z0-9_:.\-]{20,4096}$/, 'Jeton invalide.');
const endpointStr = z.string().regex(/^https:\/\/\S{10,2000}$/, 'Abonnement invalide.');

export const pushSubscribeSchema = z.object({
  fcm_token: fcmToken.optional(),
  subscription: z.object({
    endpoint: endpointStr,
    keys: z.object({
      p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/, 'Abonnement invalide.'),
      auth: z.string().regex(/^[A-Za-z0-9_-]{20,30}$/, 'Abonnement invalide.')
    }, msg('Abonnement invalide.'))
  }, msg('Abonnement invalide.')).optional(),
  ...prefShape
}).refine((b) => b.fcm_token || b.subscription, { message: 'Abonnement invalide.' });

const deviceId = { fcm_token: z.string().min(20).max(4096).optional(), endpoint: z.string().min(10).max(2000).optional() };
export const pushDeviceSchema = z.object(deviceId).refine((b) => b.fcm_token || b.endpoint, { message: 'Abonnement manquant.' });
export const pushStatusSchema = z.object(deviceId);
export const pushPreferencesSchema = z.object({ ...deviceId, ...prefShape })
  .refine((b) => b.fcm_token || b.endpoint, { message: 'Préférences invalides.' })
  .refine(hasPref, { message: 'Préférences invalides.' });

const translation = z.object({ title: z.string().max(500).optional(), body: z.string().max(2000).optional() });
export const pushSendSchema = z.object({
  title: z.string({ required_error: 'Titre et message obligatoires.', invalid_type_error: 'Titre et message obligatoires.' }),
  body: z.string({ required_error: 'Titre et message obligatoires.', invalid_type_error: 'Titre et message obligatoires.' }),
  url: z.any().optional(),
  subject: z.string().trim().max(80).optional().nullable(),
  level: z.enum(LEVELS, msg('Niveau invalide.')).optional().nullable(),
  translations: z.object({ en: translation.optional() }).optional()
}).passthrough();
export const pushClickSchema = z.object({ mid: z.string().uuid('Identifiant invalide.') });
export const pushInboxQuery = z.object({ lang: z.string().max(10).optional() }).passthrough();
export const pushHistoryIdParam = z.object({ id: z.string().uuid('Identifiant invalide.') });
