import crypto from 'node:crypto';
import { childLogger } from '../../logger.js';

const log = childLogger('ai-security');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getMasterKey() {
  const raw = process.env.AI_MASTER_KEY;
  if (!raw) throw new Error('AI_MASTER_KEY manquante dans les variables d\'environnement.');
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch (e) {
    throw new Error('AI_MASTER_KEY invalide (doit être en base64).');
  }
  if (buf.length !== 32) {
    throw new Error(`AI_MASTER_KEY invalide : ${buf.length} octets au lieu de 32. Générer avec : node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`);
  }
  return buf;
}

/**
 * Chiffre une clé API avec AES-256-GCM.
 * @param {string} plaintext - La clé API en clair
 * @returns {{ encrypted: string, iv: string, tag: string }} - Tous en base64
 */
export function encryptApiKey(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') throw new Error('Clé API vide ou invalide.');
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

/**
 * Déchiffre une clé API.
 * @param {{ encrypted: string, iv: string, tag: string }} payload
 * @returns {string} - La clé API en clair
 */
export function decryptApiKey(payload) {
  if (!payload || !payload.encrypted || !payload.iv || !payload.tag) {
    throw new Error('Payload de clé chiffrée incomplet.');
  }
  const key = getMasterKey();
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const encrypted = Buffer.from(payload.encrypted, 'base64');
  if (iv.length !== IV_LENGTH) throw new Error('IV invalide.');
  if (tag.length !== TAG_LENGTH) throw new Error('Tag d\'authentification invalide.');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (e) {
    log.error({ err: e.message }, 'Échec de déchiffrement de la clé API');
    throw new Error('Impossible de déchiffrer la clé API (clé maître incorrecte ou données corrompues).');
  }
}

/**
 * Masque une clé API pour l'affichage : "AIza...abc1"
 */
export function maskApiKey(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return '';
  if (plaintext.length <= 8) return '••••••••';
  return `${plaintext.slice(0, 4)}...${plaintext.slice(-4)}`;
}

/**
 * Valide le format d'une clé API selon le fournisseur (validation légère, non exhaustive).
 *
 * Gemini accepte DEUX formats officiels :
 *   - Ancien : "AIza..." (39 caractères au total)
 *   - Nouveau : "AQ.Ab8..." (clés générées depuis Google AI Studio depuis mi-2026)
 */
export function validateApiKeyFormat(providerName, apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return { valid: false, error: 'Clé vide.' };
  // Retire espaces, retours à la ligne et caractères invisibles (copier-coller)
  const key = apiKey.replace(/[\s\u200B-\u200D\uFEFF\u00A0]/g, '');
  if (key.length < 10) return { valid: false, error: 'Clé trop courte.' };
  const patterns = {
    // Gemini : accepte "AIza..." (ancien) ET "AQ...." (nouveau format officiel)
    gemini: /^(AIza[0-9A-Za-z_-]{35}|AQ\.[0-9A-Za-z_.-]{20,})$/,
    groq: /^gsk_[0-9A-Za-z]{20,}$/,
    openrouter: /^sk-or-v1-[0-9a-f]{64}$/,
    cloudflare: /^[A-Za-z0-9_-]{40,}$/
  };
  const re = patterns[providerName];
  if (re && !re.test(key)) {
    const bad = [...key].filter(c => !/[0-9A-Za-z_.-]/.test(c)).map(c => 'U+' + c.codePointAt(0).toString(16));
    console.warn('[ai-security] clé rejetée', { provider: providerName, longueur: key.length, debut: key.slice(0, 3), caracteres_invalides: bad });
    return { valid: false, error: `Format de clé ${providerName} invalide.` };
  }
  return { valid: true };
}

/**
 * Génère une empreinte SHA-256 d'une clé (pour détecter les doublons sans stocker la clé).
 */
export function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex');
}

/**
 * Génère une clé maître (pour le développeur).
 */
export function generateMasterKey() {
  return crypto.randomBytes(32).toString('base64');
}
