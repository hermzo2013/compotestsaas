import express from 'express';
import { z } from 'zod';
import { ai } from '../services/ai/index.js';
import { childLogger } from '../logger.js';

const log = childLogger('ai-routes');

/**
 * Crée le routeur IA.
 * @param {Object} deps
 * @param {Function} deps.authenticate - Middleware d'authentification (req.user)
 * @param {Function} deps.requireAdmin - Middleware admin
 * @param {Function} deps.validate - Middleware de validation Zod
 * @param {Function} deps.limiter - Factory de rate limiter
 */
export function createAiRouter({ authenticate, requireAdmin, validate, limiter }) {
  const router = express.Router();

  // Rate limiters dédiés
  const aiTestLimiter = limiter({ max: 5, message: { error: 'Trop de tests de connexion, réessaie dans une minute.' } });
  const aiAdminLimiter = limiter({ max: 30, message: { error: 'Trop de requêtes admin IA, réessaie dans une minute.' } });
  const aiPublicLimiter = limiter({ max: 10, message: { error: 'Trop de requêtes IA, réessaie dans une minute.' } });

  // ===================================================================
  // SCHÉMAS ZOD
  // ===================================================================
  const ProviderName = z.enum(['gemini', 'groq', 'openrouter', 'cloudflare']);

  const SaveKeySchema = z.object({
    provider: ProviderName,
    apiKey: z.string().min(10).max(500),
    accountId: z.string().max(200).optional().nullable(),
    baseUrl: z.string().url().max(300).optional().nullable(),
    model: z.string().max(200).optional().nullable()
  });

  const ToggleSchema = z.object({
    provider: ProviderName,
    enabled: z.boolean()
  });

  const SetPrimarySchema = z.object({
    provider: ProviderName,
    role: z.enum(['primary', 'secondary', 'none'])
  });

  const RoutingSchema = z.object({
    task: z.string().min(1).max(100),
    primary_provider: ProviderName.nullable(),
    secondary_provider: ProviderName.nullable(),
    model_override: z.string().max(200).nullable().optional(),
    enabled: z.boolean().optional()
  });

  const SettingsSchema = z.object({
    free_only_mode: z.boolean().optional(),
    global_daily_limit: z.number().int().min(1).max(100000).optional(),
    per_user_daily_limit: z.number().int().min(1).max(10000).optional(),
    max_fallback_attempts: z.number().int().min(1).max(10).optional(),
    cache_ttl_seconds: z.number().int().min(0).max(86400).optional()
  });

  const PublicGenerateSchema = z.object({
    text: z.string().min(10).max(50000),
    count: z.number().int().min(1).max(100).optional().default(50)
  });

  const PublicAssistantSchema = z.object({
    question: z.string().min(3).max(2000),
    context: z.object({ course: z.string().max(10000).optional() }).optional()
  });

  const PublicExplainSchema = z.object({
    question: z.string().min(3).max(2000),
    studentAnswer: z.string().max(2000),
    correctAnswer: z.string().max(2000),
    context: z.string().max(2000).optional()
  });

  // ===================================================================
  // MIDDLEWARE : admin only
  // ===================================================================
  function adminOnly(req, res, next) {
    if (!req.user || !req.user.isAdmin) {
      return res.status(403).json({ error: 'Réservé administrateur.' });
    }
    next();
  }

  // ===================================================================
  // ROUTES ADMIN — Configuration des fournisseurs
  // ===================================================================

  /**
   * GET /api/admin/ai/providers
   * Liste tous les fournisseurs (clés masquées).
   */
  router.get('/admin/ai/providers',
    authenticate, adminOnly, aiAdminLimiter,
    async (_req, res) => {
      try {
        const config = await ai.loadConfig(true);
        const providers = config.providers.map(p => ({
          provider_name: p.provider_name,
          enabled: p.enabled,
          is_primary: p.is_primary,
          is_secondary: p.is_secondary,
          model: p.model,
          base_url: p.base_url,
          account_id: p.account_id,
          status: p.status,
          has_api_key: Boolean(p.api_key_encrypted),
          last_check_at: p.last_check_at,
          last_error: p.last_error,
          updated_at: p.updated_at,
          // Ne JAMAIS renvoyer la clé ni ses fragments chiffrés
          extra_config: p.extra_config || {}
        }));
        res.json({ providers });
      } catch (e) {
        log.error({ err: e.message }, 'GET /admin/ai/providers');
        res.status(500).json({ error: e.message });
      }
    }
  );

  /**
   * POST /api/admin/ai/providers/key
   * Enregistre (ou remplace) la clé API d'un fournisseur.
   * Valide d'abord la clé auprès du fournisseur.
   */
  router.post('/admin/ai/providers/key',
    authenticate, adminOnly, aiAdminLimiter,
    validate(SaveKeySchema),
    async (req, res) => {
      const { provider, apiKey, accountId, baseUrl, model } = req.body;
      try {
        // 1) Validation de format
        const fmt = ai.validateApiKeyFormat(provider, apiKey);
        if (!fmt.valid) return res.status(400).json({ error: fmt.error });

        // 2) Cloudflare exige un accountId
        if (provider === 'cloudflare' && !accountId) {
          return res.status(400).json({ error: 'Cloudflare : account_id requis.' });
        }

        // 3) Chiffrement
        const enc = ai.encryptApiKey(apiKey);

        // 4) Sauvegarde (avec statut "configured", pas encore "connected")
        await ai.updateProvider(provider, {
          api_key_encrypted: enc.encrypted,
          api_key_iv: enc.iv,
          api_key_tag: enc.tag,
          account_id: accountId || null,
          base_url: baseUrl || null,
          model: model || null,
          enabled: true,
          status: 'configured',
          last_error: null
        });

        // 5) Test de connexion immédiat
        const test = await ai.testProviderConnection(provider);

        if (test.ok) {
          res.json({
            ok: true,
            provider,
            status: 'connected',
            masked_key: ai.maskApiKey(apiKey),
            model: test.model || model || null,
            available_models: test.models ? test.models.slice(0, 30) : undefined
          });
        } else {
          // La clé est enregistrée mais le test a échoué : on informe sans supprimer
          res.status(400).json({
            ok: false,
            provider,
            status: 'auth_error',
            error: test.error || 'La clé a été enregistrée mais le test de connexion a échoué.',
            masked_key: ai.maskApiKey(apiKey)
          });
        }
      } catch (e) {
        log.error({ err: e.message, provider }, 'POST /admin/ai/providers/key');
        res.status(500).json({ error: e.message });
      }
    }
  );

  /**
   * POST /api/admin/ai/providers/toggle
   * Active/désactive un fournisseur.
   */
  router.post('/admin/ai/providers/toggle',
    authenticate, adminOnly, aiAdminLimiter,
    validate(ToggleSchema),
    async (req, res) => {
      const { provider, enabled } = req.body;
      try {
        await ai.updateProvider(provider, {
          enabled,
          status: enabled ? 'configured' : 'disabled'
        });
        res.json({ ok: true, provider, enabled });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  /**
   * POST /api/admin/ai/providers/set-primary
   * Définit le fournisseur principal ou secondaire.
   */
  router.post('/admin/ai/providers/set-primary',
    authenticate, adminOnly, aiAdminLimiter,
    validate(SetPrimarySchema),
    async (req, res) => {
      const { provider, role } = req.body;
      try {
        const config = await ai.loadConfig(true);
        // Retire l'ancien titulaire du rôle
        const updates = [];
        for (const p of config.providers) {
          if (role === 'primary' && p.is_primary && p.provider_name !== provider) {
            updates.push(ai.updateProvider(p.provider_name, { is_primary: false }));
          }
          if (role === 'secondary' && p.is_secondary && p.provider_name !== provider) {
            updates.push(ai.updateProvider(p.provider_name, { is_secondary: false }));
          }
        }
        await Promise.all(updates);
        // Applique le nouveau rôle
        const patch = {};
        if (role === 'primary') { patch.is_primary = true; patch.is_secondary = false; }
        else if (role === 'secondary') { patch.is_secondary = true; patch.is_primary = false; }
        else { patch.is_primary = false; patch.is_secondary = false; }
        await ai.updateProvider(provider, patch);
        res.json({ ok: true, provider, role });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  /**
   * POST /api/admin/ai/providers/test
   * Teste la connexion à un fournisseur.
   */
  router.post('/admin/ai/providers/test',
    authenticate, adminOnly, aiTestLimiter,
    validate(z.object({ provider: ProviderName })),
    async (req, res) => {
      try {
        const result = await ai.testProviderConnection(req.body.provider);
        res.json(result);
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    }
  );

  /**
   * GET /api/admin/ai/providers/status
   * Statut temps réel de tous les fournisseurs.
   */
  router.get('/admin/ai/providers/status',
    authenticate, adminOnly, aiAdminLimiter,
    async (_req, res) => {
      try {
        const config = await ai.loadConfig(true);
        const statuses = await Promise.all(config.providers.map(async p => {
          const quota = await ai.getQuotaState(p.provider_name);
          return {
            provider_name: p.provider_name,
            status: p.status,
            enabled: p.enabled,
            is_primary: p.is_primary,
            is_secondary: p.is_secondary,
            model: p.model,
            has_api_key: Boolean(p.api_key_encrypted),
            last_check_at: p.last_check_at,
            last_error: p.last_error,
            quota: {
              daily_requests: quota.daily?.requests_count || 0,
              daily_limit: quota.daily?.limit_requests || null,
              daily_tokens: quota.daily?.tokens_count || 0,
              hourly_requests: quota.hourly?.requests_count || 0,
              suspended_until: quota.daily?.suspended_until || null
            }
          };
        }));
        res.json({ providers: statuses });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  // ===================================================================
  // ROUTES ADMIN — Attribution des tâches
  // ===================================================================

  /**
   * GET /api/admin/ai/routing
   */
  router.get('/admin/ai/routing',
    authenticate, adminOnly, aiAdminLimiter,
    async (_req, res) => {
      try {
        const config = await ai.loadConfig(true);
        res.json({ routing: config.routing });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  /**
   * POST /api/admin/ai/routing
   */
  router.post('/admin/ai/routing',
    authenticate, adminOnly, aiAdminLimiter,
    validate(RoutingSchema),
    async (req, res) => {
      const { task, primary_provider, secondary_provider, model_override, enabled } = req.body;
      try {
        const patch = { primary_provider, secondary_provider };
        if (model_override !== undefined) patch.model_override = model_override;
        if (enabled !== undefined) patch.enabled = enabled;
        const updated = await ai.updateTaskRouting(task, patch);
        res.json({ ok: true, routing: updated });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  // ===================================================================
  // ROUTES ADMIN — Réglages globaux
  // ===================================================================

  router.get('/admin/ai/settings',
    authenticate, adminOnly, aiAdminLimiter,
    async (_req, res) => {
      try {
        const settings = await ai.getSettings(true);
        res.json({ settings });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  router.post('/admin/ai/settings',
    authenticate, adminOnly, aiAdminLimiter,
    validate(SettingsSchema),
    async (req, res) => {
      try {
        const updated = await ai.updateSettings(req.body);
        res.json({ ok: true, settings: updated });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  // ===================================================================
  // ROUTES ADMIN — Quotas et cache
  // ===================================================================

  router.post('/admin/ai/quota/reset',
    authenticate, adminOnly, aiAdminLimiter,
    validate(z.object({ provider: ProviderName })),
    async (req, res) => {
      try {
        const ok = await ai.resetQuota(req.body.provider);
        res.json({ ok });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  router.post('/admin/ai/cache/purge',
    authenticate, adminOnly, aiAdminLimiter,
    validate(z.object({ task: z.string().max(100).optional() })),
    async (req, res) => {
      try {
        const ok = req.body.task
          ? await ai.purgeCacheByTask(req.body.task)
          : await ai.purgeAllCache();
        res.json({ ok });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  // ===================================================================
  // ROUTES PUBLIQUES (utilisateurs authentifiés)
  // ===================================================================

  /**
   * POST /api/ai/generate-quiz
   * Génère un quiz à partir de texte.
   */
  router.post('/ai/generate-quiz',
    authenticate, aiPublicLimiter,
    validate(PublicGenerateSchema),
    async (req, res) => {
      try {
        const { text, count } = req.body;
        const result = await ai.generateQuiz(text, { count, userId: req.user.id });
        res.json(result);
      } catch (e) {
        log.error({ err: e.message }, 'POST /ai/generate-quiz');
        res.status(502).json({ error: e.message });
      }
    }
  );

  /**
   * POST /api/ai/assistant
   * Assistant pédagogique.
   */
  router.post('/ai/assistant',
    authenticate, aiPublicLimiter,
    validate(PublicAssistantSchema),
    async (req, res) => {
      try {
        const { question, context } = req.body;
        const result = await ai.pedagogicalAssistant(question, context || {}, { userId: req.user.id });
        res.json(result);
      } catch (e) {
        log.error({ err: e.message }, 'POST /ai/assistant');
        res.status(502).json({ error: e.message });
      }
    }
  );

  /**
   * POST /api/ai/explain-answer
   * Correction + explication d'une réponse.
   */
  router.post('/ai/explain-answer',
    authenticate, aiPublicLimiter,
    validate(PublicExplainSchema),
    async (req, res) => {
      try {
        const payload = {
          question: req.body.question,
          studentAnswer: req.body.studentAnswer,
          correctAnswer: req.body.correctAnswer,
          context: req.body.context
        };
        const result = await ai.explainAnswer(payload, { userId: req.user.id });
        res.json(result);
      } catch (e) {
        log.error({ err: e.message }, 'POST /ai/explain-answer');
        res.status(502).json({ error: e.message });
      }
    }
  );

  /**
   * POST /api/ai/summarize-course
   */
  router.post('/ai/summarize-course',
    authenticate, aiPublicLimiter,
    validate(z.object({ text: z.string().min(50).max(50000) })),
    async (req, res) => {
      try {
        const result = await ai.summarizeCourse(req.body.text, { userId: req.user.id });
        res.json(result);
      } catch (e) {
        log.error({ err: e.message }, 'POST /ai/summarize-course');
        res.status(502).json({ error: e.message });
      }
    }
  );

  /**
   * POST /api/ai/analyze-progress
   */
  router.post('/ai/analyze-progress',
    authenticate, aiPublicLimiter,
    validate(z.object({ history: z.array(z.any()).min(1).max(200) })),
    async (req, res) => {
      try {
        const result = await ai.analyzeStudentProgress(req.body.history, { userId: req.user.id });
        res.json(result);
      } catch (e) {
        log.error({ err: e.message }, 'POST /ai/analyze-progress');
        res.status(502).json({ error: e.message });
      }
    }
  );

  return router;
}