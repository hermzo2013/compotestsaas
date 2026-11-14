import { childLogger } from '../../logger.js';
import { logAiCall } from './ai-config.js';

const log = childLogger('ai-engine');

/**
 * Wrapper de journalisation : log structuré Pino + entrée en base ai_logs.
 * Ne logge JAMAIS la clé API ni le contenu complet du prompt.
 */
export function createAiLogger() {
  return {
    info(event, data = {}) {
      log.info(sanitize(data), event);
    },
    warn(event, data = {}) {
      log.warn(sanitize(data), event);
    },
    error(event, data = {}) {
      log.error(sanitize(data), event);
    },
    /**
     * Persiste un appel IA en base.
     */
    async persist(entry) {
      try {
        await logAiCall(entry);
      } catch (e) {
        log.warn({ err: e.message }, 'persistance du log IA impossible');
      }
    }
  };
}

function sanitize(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  for (const key of ['apiKey', 'api_key', 'authorization', 'Authorization', 'prompt']) {
    if (out[key] !== undefined) out[key] = '[masqué]';
  }
  if (typeof out.error === 'string' && out.error.length > 300) out.error = out.error.slice(0, 300) + '…';
  return out;
}

export const aiLogger = createAiLogger();