import { childLogger } from '../../logger.js';

const log = childLogger('ai-quota');

function headers() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
}
function base() {
  return String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
}

function periodStart(periodType) {
  const now = new Date();
  if (periodType === 'hourly') {
    now.setUTCMinutes(0, 0, 0);
  } else if (periodType === 'daily') {
    now.setUTCHours(0, 0, 0, 0);
  } else if (periodType === 'monthly') {
    now.setUTCDate(1);
    now.setUTCHours(0, 0, 0, 0);
  }
  return now.toISOString();
}

/**
 * Récupère (ou crée) la ligne de quota pour un fournisseur / une période.
 */
async function ensureQuotaRow(providerName, periodType, limits = {}) {
  const start = periodStart(periodType);
  const url = `${base()}/rest/v1/ai_quotas?provider_name=eq.${encodeURIComponent(providerName)}&period_type=eq.${periodType}&period_start=eq.${encodeURIComponent(start)}&select=*`;
  const res = await fetch(url, { headers: headers() });
  const rows = res.ok ? await res.json() : [];
  if (rows.length) return rows[0];

  const insertRes = await fetch(`${base()}/rest/v1/ai_quotas`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      provider_name: providerName,
      period_type: periodType,
      period_start: start,
      limit_requests: limits.requests || null,
      limit_tokens: limits.tokens || null
    })
  });
  if (!insertRes.ok) {
    const text = await insertRes.text().catch(() => '');
    throw new Error(`Création quota impossible : ${insertRes.status} ${text.slice(0, 200)}`);
  }
  const data = await insertRes.json();
  return data[0];
}

/**
 * Vérifie si un fournisseur peut être utilisé (quota non dépassé, non suspendu).
 * @returns {Promise<{allowed:boolean, reason?:string, suspended?:boolean}>}
 */
export async function checkQuota(providerName, settings = {}) {
  try {
    const daily = await ensureQuotaRow(providerName, 'daily');
    const hourly = await ensureQuotaRow(providerName, 'hourly');

    const now = Date.now();
    if (daily.suspended_until && new Date(daily.suspended_until).getTime() > now) {
      return { allowed: false, reason: 'fournisseur temporairement suspendu (quota épuisé)', suspended: true };
    }
    if (daily.limit_requests && daily.requests_count >= daily.limit_requests) {
      return { allowed: false, reason: `limite quotidienne atteinte (${daily.requests_count}/${daily.limit_requests})` };
    }
    if (daily.limit_tokens && daily.tokens_count >= daily.limit_tokens) {
      return { allowed: false, reason: `limite de tokens quotidienne atteinte (${daily.tokens_count}/${daily.limit_tokens})` };
    }
    if (hourly.limit_requests && hourly.requests_count >= hourly.limit_requests) {
      return { allowed: false, reason: `limite horaire atteinte (${hourly.requests_count}/${hourly.limit_requests})` };
    }

    // Limite globale (tous fournisseurs confondus)
    if (settings.global_daily_limit) {
      const url = `${base()}/rest/v1/ai_quotas?period_type=eq.daily&period_start=eq.${encodeURIComponent(periodStart('daily'))}&select=requests_count`;
      const res = await fetch(url, { headers: headers() });
      if (res.ok) {
        const rows = await res.json();
        const total = rows.reduce((sum, r) => sum + (r.requests_count || 0), 0);
        if (total >= settings.global_daily_limit) {
          return { allowed: false, reason: `limite globale quotidienne atteinte (${total}/${settings.global_daily_limit})` };
        }
      }
    }

    return { allowed: true };
  } catch (e) {
    log.warn({ provider: providerName, err: e.message }, 'vérification du quota impossible (autorisé par défaut)');
    return { allowed: true };
  }
}

/**
 * Incrémente les compteurs de quota après un appel réussi.
 */
export async function incrementQuota(providerName, tokensUsed = 0) {
  try {
    for (const periodType of ['hourly', 'daily']) {
      const row = await ensureQuotaRow(providerName, periodType);
      await fetch(`${base()}/rest/v1/ai_quotas?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { ...headers(), Prefer: 'return=minimal' },
        body: JSON.stringify({
          requests_count: (row.requests_count || 0) + 1,
          tokens_count: (row.tokens_count || 0) + tokensUsed
        })
      });
    }
  } catch (e) {
    log.warn({ provider: providerName, err: e.message }, 'incrément de quota impossible');
  }
}

/**
 * Suspend temporairement un fournisseur (ex. quota épuisé détecté côté API).
 */
export async function suspendProvider(providerName, minutes = 60) {
  try {
    const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    for (const periodType of ['hourly', 'daily']) {
      const row = await ensureQuotaRow(providerName, periodType);
      await fetch(`${base()}/rest/v1/ai_quotas?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { ...headers(), Prefer: 'return=minimal' },
        body: JSON.stringify({ suspended_until: until })
      });
    }
    log.warn({ provider: providerName, minutes }, 'fournisseur suspendu');
  } catch (e) {
    log.warn({ provider: providerName, err: e.message }, 'suspension impossible');
  }
}

/**
 * Renvoie l'état des quotas (admin).
 */
export async function getQuotaState(providerName) {
  try {
    const daily = await ensureQuotaRow(providerName, 'daily');
    const hourly = await ensureQuotaRow(providerName, 'hourly');
    return { daily, hourly };
  } catch (e) {
    return { daily: null, hourly: null, error: e.message };
  }
}

/**
 * Réinitialise manuellement le quota d'un fournisseur (admin).
 */
export async function resetQuota(providerName) {
  try {
    const url = `${base()}/rest/v1/ai_quotas?provider_name=eq.${encodeURIComponent(providerName)}`;
    await fetch(url, {
      method: 'PATCH',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify({ requests_count: 0, tokens_count: 0, suspended_until: null })
    });
    return true;
  } catch (e) {
    log.warn({ provider: providerName, err: e.message }, 'réinitialisation du quota impossible');
    return false;
  }
}

/**
 * Vérifie si une erreur de quota est détectée dans un message d'erreur fournisseur.
 */
export function isQuotaError(errorMessage) {
  const msg = String(errorMessage || '').toLowerCase();
  return /quota|rate.?limit|429|too many requests|exceeded|resource.?exhausted/.test(msg);
}