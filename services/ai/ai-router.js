import { childLogger } from '../../logger.js';
import { createAiLogger } from './ai-logger.js';
import { createProvider } from './providers/index.js';
import {
  getProvider, getTaskRouting, getSettings, updateProviderStatus, loadAiConfig
} from './ai-config.js';
import { checkQuota, incrementQuota, suspendProvider, isQuotaError } from './ai-quota.js';
import { buildCacheKey, getCached, setCached } from './ai-cache.js';

const log = childLogger('ai-router');
const aiLog = createAiLogger();

/**
 * Résout l'ordre des fournisseurs à essayer pour une tâche donnée.
 * 1. Fournisseur primaire de la tâche (si configuré et activé)
 * 2. Fournisseur secondaire de la tâche
 * 3. Fournisseur marqué is_primary
 * 4. Fournisseur marqué is_secondary
 * 5. Tout autre fournisseur activé et connecté
 */
function resolveProviderOrder(taskName, config) {
  const enabled = config.providers.filter(p => p.enabled && p.status !== 'auth_error' && p.status !== 'disabled' && p.status !== 'not_configured');

  if (enabled.length === 0) return [];

  const routing = config.routing.find(r => r.task_name === taskName);
  const order = [];
  const push = (name) => {
    if (name && !order.includes(name)) {
      const p = enabled.find(x => x.provider_name === name);
      if (p) order.push(name);
    }
  };

  if (routing && routing.enabled !== false) {
    push(routing.primary_provider);
    push(routing.secondary_provider);
  }
  const primary = enabled.find(p => p.is_primary);
  if (primary) push(primary.provider_name);
  const secondary = enabled.find(p => p.is_secondary);
  if (secondary) push(secondary.provider_name);

  // Tous les autres (tri stable par provider_name)
  enabled.map(p => p.provider_name).sort().forEach(push);

  return order;
}

/**
 * Vérifie que la tâche nécessite la vision et que le fournisseur la supporte.
 */
function checkCapabilities(provider, requirements = {}) {
  if (requirements.vision && !provider.supportsVision()) {
    return { ok: false, reason: `le modèle ${provider.model} ne supporte pas les images` };
  }
  return { ok: true };
}

/**
 * Exécute une tâche IA avec routage automatique, fallback, cache, quotas.
 *
 * @param {Object} params
 * @param {string} params.taskName - Nom de la tâche (quiz_generation, document_analysis, ...)
 * @param {string} params.cacheKey - Optionnel, pour forcer une clé de cache
 * @param {Object} params.cachePayload - Payload à hasher pour la clé de cache
 * @param {number} params.cacheTtl - TTL du cache en secondes (défaut : settings.cache_ttl_seconds)
 * @param {boolean} params.useCache - Activer/désactiver le cache (défaut : true)
 * @param {Function} params.execute - async (provider, options) => result
 * @param {Object} params.requirements - { vision?: boolean }
 * @param {Object} params.options - Options à transmettre à execute()
 * @param {string} params.userId - ID utilisateur (pour les logs)
 */
export async function runTask(params) {
  const {
    taskName, cacheKey, cachePayload, cacheTtl, useCache = true,
    execute, requirements = {}, options = {}, userId
  } = params;

  if (typeof execute !== 'function') throw new Error('runTask : execute() manquant.');

  const startedAt = Date.now();
  const config = await loadAiConfig();
  const settings = config.settings;

  // 1) Cache
  let finalCacheKey = null;
  if (useCache && (cacheKey || cachePayload !== undefined)) {
    finalCacheKey = cacheKey || buildCacheKey(taskName, cachePayload, { ...options, _vision: !!requirements.vision });
    const cached = await getCached(finalCacheKey);
    if (cached) {
      aiLog.info('cache hit', { taskName, cacheKey: finalCacheKey.slice(0, 60) });
      return { ...cached, _cached: true };
    }
  }

  // 2) Ordre des fournisseurs
  const order = resolveProviderOrder(taskName, config);
  if (order.length === 0) {
    throw new Error('Aucun fournisseur IA activé. Configure au moins un fournisseur dans le panneau d\'administration.');
  }

  // 3) Boucle de fallback (max settings.max_fallback_attempts)
  const maxAttempts = Math.min(settings.max_fallback_attempts || 3, order.length);
  let lastError = null;
  let attempt = 0;

  for (const providerName of order) {
    if (attempt >= maxAttempts) break;
    attempt++;

    const providerConfig = config.providers.find(p => p.provider_name === providerName);
    if (!providerConfig) continue;

    // Vérification des capacités (vision)
    let provider;
    try {
      provider = createProvider(providerConfig);
    } catch (e) {
      log.warn({ provider: providerName, err: e.message }, 'instanciation impossible');
      lastError = e;
      continue;
    }

    const capCheck = checkCapabilities(provider, requirements);
    if (!capCheck.ok) {
      aiLog.warn('capacité insuffisante', { taskName, provider: providerName, reason: capCheck.reason });
      lastError = new Error(capCheck.reason);
      continue;
    }

    // Vérification du quota
    const quota = await checkQuota(providerName, settings);
    if (!quota.allowed) {
      aiLog.warn('quota dépassé', { taskName, provider: providerName, reason: quota.reason });
      if (quota.suspended) await suspendProvider(providerName, 30);
      lastError = new Error(quota.reason);
      continue;
    }

    // Appel
    const callStarted = Date.now();
    try {
      aiLog.info('appel IA', { taskName, provider: providerName, model: provider.model });
      const result = await execute(provider, options);
      const durationMs = Date.now() - callStarted;
      const usage = result && result._usage ? result._usage : {};

      // Mise à jour quota
      await incrementQuota(providerName, usage.totalTokens || 0);
      // Statut fournisseur OK
      if (providerConfig.status !== 'connected') {
        await updateProviderStatus(providerName, 'connected', null);
      }
      // Log persistant
      await aiLog.persist({
        userId, taskName, providerName, model: provider.model,
        promptTokens: usage.promptTokens || 0,
        completionTokens: usage.completionTokens || 0,
        totalTokens: usage.totalTokens || 0,
        durationMs, success: true
      });

      // Cache
      if (finalCacheKey && useCache) {
        const ttl = cacheTtl || settings.cache_ttl_seconds || 3600;
        const toCache = { ...result };
        delete toCache._raw; // Ne pas stocker la réponse brute (peut être volumineuse)
        await setCached(finalCacheKey, taskName, providerName, provider.model, toCache, ttl);
      }

      aiLog.info('succès', { taskName, provider: providerName, durationMs, tokens: usage.totalTokens || 0 });
      return { ...result, _provider: providerName, _model: provider.model, _durationMs: durationMs };

    } catch (err) {
      const durationMs = Date.now() - callStarted;
      const errMsg = String(err.message || err);
      aiLog.warn('échec fournisseur', { taskName, provider: providerName, err: errMsg.slice(0, 200) });

      await aiLog.persist({
        userId, taskName, providerName, model: provider.model,
        durationMs, success: false, errorMessage: errMsg.slice(0, 500)
      });

      if (isQuotaError(errMsg)) {
        await suspendProvider(providerName, 60);
        await updateProviderStatus(providerName, 'quota_exceeded', errMsg.slice(0, 500));
      } else if (/auth|401|403|invalid.*key|unauthorized/i.test(errMsg)) {
        await updateProviderStatus(providerName, 'auth_error', errMsg.slice(0, 500));
      }

      lastError = err;
      // Continue vers le fournisseur suivant
    }
  }

  // Aucun fournisseur n'a fonctionné
  throw new Error(
    `Tous les fournisseurs IA ont échoué pour la tâche "${taskName}". ` +
    `Dernière erreur : ${lastError ? String(lastError.message).slice(0, 300) : 'inconnue'}. ` +
    `Vérifie la configuration dans le panneau d'administration.`
  );
}

/**
 * Teste la connexion à un fournisseur et met à jour son statut.
 */
export async function testProviderConnection(providerName) {
  const config = await loadAiConfig(true);
  const providerConfig = config.providers.find(p => p.provider_name === providerName);
  if (!providerConfig) throw new Error(`Fournisseur inconnu : ${providerName}`);

  let provider;
  try {
    provider = createProvider(providerConfig);
  } catch (e) {
    log.warn({ provider: providerName, err: e.message }, 'instanciation du fournisseur impossible (test)');
    await updateProviderStatus(providerName, 'auth_error', e.message);
    return { ok: false, error: e.message };
  }

  const result = await provider.testConnection();
  if (!result.ok) log.warn({ provider: providerName, model: provider.model, err: String(result.error || '').slice(0, 400) }, 'test de connexion fournisseur échoué');
  if (result.ok) {
    await updateProviderStatus(providerName, 'connected', null);
  } else {
    await updateProviderStatus(providerName, 'auth_error', result.error || 'Échec du test');
  }
  return result;
}
