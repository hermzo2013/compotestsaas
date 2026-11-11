import crypto from 'node:crypto';
import { childLogger } from '../../logger.js';

const log = childLogger('ai-cache');

function headers() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  };
}
function base() {
  return String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
}

/**
 * Construit une clé de cache stable à partir de la tâche + du contenu + des paramètres.
 */
export function buildCacheKey(taskName, payload, extra = {}) {
  const normalized = {
    task: taskName,
    payload: typeof payload === 'string' ? payload.trim().slice(0, 20000) : JSON.stringify(payload || {}).slice(0, 20000),
    extra: Object.keys(extra).sort().reduce((acc, k) => { acc[k] = extra[k]; return acc; }, {})
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return `${taskName}:${hash}`;
}

/**
 * Cherche une réponse en cache. Renvoie null si absente ou expirée.
 */
export async function getCached(cacheKey) {
  try {
    const url = `${base()}/rest/v1/ai_cache?select=response,hit_count&cache_key=eq.${encodeURIComponent(cacheKey)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows.length) return null;
    // Incrémente le compteur de hits en tâche de fond
    fetch(`${base()}/rest/v1/ai_cache?cache_key=eq.${encodeURIComponent(cacheKey)}`, {
      method: 'PATCH',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify({ hit_count: (rows[0].hit_count || 0) + 1 })
    }).catch(() => {});
    return rows[0].response;
  } catch (e) {
    log.warn({ err: e.message }, 'lecture du cache IA impossible');
    return null;
  }
}

/**
 * Enregistre une réponse en cache.
 */
export async function setCached(cacheKey, taskName, providerName, model, response, ttlSeconds = 3600) {
  try {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const res = await fetch(`${base()}/rest/v1/ai_cache`, {
      method: 'POST',
      headers: { ...headers(), Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        cache_key: cacheKey,
        task_name: taskName,
        provider_name: providerName,
        model: model || null,
        response,
        expires_at: expiresAt
      })
    });
    return res.ok;
  } catch (e) {
    log.warn({ err: e.message }, 'écriture du cache IA impossible');
    return false;
  }
}

/**
 * Purge le cache d'une tâche (admin).
 */
export async function purgeCacheByTask(taskName) {
  try {
    const url = `${base()}/rest/v1/ai_cache?task_name=eq.${encodeURIComponent(taskName)}`;
    const res = await fetch(url, { method: 'DELETE', headers: headers() });
    return res.ok;
  } catch (e) {
    log.warn({ err: e.message }, 'purge du cache IA impossible');
    return false;
  }
}

/**
 * Purge tout le cache (admin).
 */
export async function purgeAllCache() {
  try {
    const url = `${base()}/rest/v1/ai_cache?id=not.is.null`;
    const res = await fetch(url, { method: 'DELETE', headers: headers() });
    return res.ok;
  } catch (e) {
    log.warn({ err: e.message }, 'purge totale du cache IA impossible');
    return false;
  }
}