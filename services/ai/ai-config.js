import { childLogger } from '../../logger.js';

const log = childLogger('ai-config');

const CACHE_TTL_MS = 60_000; // 1 minute : les changements admin sont vus rapidement

let configCache = null;
let configCacheAt = 0;

function supabaseHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  };
}

async function supabaseGet(path) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('SUPABASE_URL manquante.');
  const res = await fetch(`${base}/rest/v1/${path}`, { headers: supabaseHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase GET ${path} : ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function supabasePatch(path, body) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const res = await fetch(`${base}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase PATCH ${path} : ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Charge toute la configuration IA (fournisseurs, routage, réglages).
 * @param {boolean} force - Ignore le cache
 */
export async function loadAiConfig(force = false) {
  if (!force && configCache && Date.now() - configCacheAt < CACHE_TTL_MS) {
    return configCache;
  }
  try {
    const [providers, routing, settings] = await Promise.all([
      supabaseGet('ai_providers?select=*&order=provider_name'),
      supabaseGet('ai_task_routing?select=*&order=task_name'),
      supabaseGet('ai_settings?select=*&id=eq.1')
    ]);
    configCache = {
      providers: Array.isArray(providers) ? providers : [],
      routing: Array.isArray(routing) ? routing : [],
      settings: (settings && settings[0]) || {
        free_only_mode: true,
        global_daily_limit: 500,
        per_user_daily_limit: 50,
        max_fallback_attempts: 3,
        cache_ttl_seconds: 3600
      }
    };
    configCacheAt = Date.now();
    return configCache;
  } catch (e) {
    log.error({ err: e.message }, 'chargement de la configuration IA impossible');
    // Fallback : configuration par variables d'environnement (ancien système)
    return {
      providers: [
        {
          provider_name: 'groq',
          enabled: Boolean(process.env.AI_API_KEY),
          is_primary: false,
          is_secondary: false,
          model: process.env.AI_MODEL || 'llama-3.3-70b-versatile',
          base_url: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
          status: process.env.AI_API_KEY ? 'configured' : 'not_configured',
          _legacy_env_key: process.env.AI_API_KEY || null
        }
      ],
      routing: [],
      settings: {
        free_only_mode: true,
        global_daily_limit: 500,
        per_user_daily_limit: 50,
        max_fallback_attempts: 3,
        cache_ttl_seconds: 3600
      }
    };
  }
}

/**
 * Invalide le cache (appelé après modification admin).
 */
export function invalidateAiConfig() {
  configCache = null;
  configCacheAt = 0;
}

/**
 * Récupère un fournisseur par nom.
 */
export async function getProvider(providerName, force = false) {
  const cfg = await loadAiConfig(force);
  return cfg.providers.find(p => p.provider_name === providerName) || null;
}

/**
 * Récupère les réglages globaux.
 */
export async function getSettings(force = false) {
  const cfg = await loadAiConfig(force);
  return cfg.settings;
}

/**
 * Récupère la configuration de routage pour une tâche.
 */
export async function getTaskRouting(taskName, force = false) {
  const cfg = await loadAiConfig(force);
  return cfg.routing.find(r => r.task_name === taskName) || null;
}

/**
 * Met à jour le statut d'un fournisseur en base.
 */
export async function updateProviderStatus(providerName, status, errorMessage = null) {
  try {
    const update = {
      status,
      last_check_at: new Date().toISOString(),
      last_error: errorMessage
    };
    await supabasePatch(`ai_providers?provider_name=eq.${encodeURIComponent(providerName)}`, update);
    invalidateAiConfig();
  } catch (e) {
    log.warn({ provider: providerName, err: e.message }, 'mise à jour du statut fournisseur impossible');
  }
}

/**
 * Met à jour un fournisseur (admin).
 */
export async function updateProvider(providerName, patch) {
  const data = await supabasePatch(`ai_providers?provider_name=eq.${encodeURIComponent(providerName)}`, patch);
  invalidateAiConfig();
  return data && data[0];
}

/**
 * Met à jour le routage d'une tâche (admin).
 */
export async function updateTaskRouting(taskName, patch) {
  const data = await supabasePatch(`ai_task_routing?task_name=eq.${encodeURIComponent(taskName)}`, patch);
  invalidateAiConfig();
  return data && data[0];
}

/**
 * Met à jour les réglages globaux (admin).
 */
export async function updateSettings(patch) {
  const data = await supabasePatch('ai_settings?id=eq.1', patch);
  invalidateAiConfig();
  return data && data[0];
}

/**
 * Ajoute une entrée de log IA.
 */
export async function logAiCall(entry) {
  try {
    const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
    await fetch(`${base}/rest/v1/ai_logs`, {
      method: 'POST',
      headers: supabaseHeaders(),
      body: JSON.stringify({
        user_id: entry.userId || null,
        task_name: entry.taskName,
        provider_name: entry.providerName,
        model: entry.model || null,
        prompt_tokens: entry.promptTokens || 0,
        completion_tokens: entry.completionTokens || 0,
        total_tokens: entry.totalTokens || 0,
        duration_ms: entry.durationMs || 0,
        success: Boolean(entry.success),
        error_message: entry.errorMessage || null
      })
    });
  } catch (e) {
    log.warn({ err: e.message }, 'journalisation IA impossible');
  }
}