import { GeminiProvider } from './gemini.provider.js';
import { GroqProvider } from './groq.provider.js';
import { OpenRouterProvider } from './openrouter.provider.js';
import { CloudflareProvider } from './cloudflare.provider.js';
import { decryptApiKey } from '../ai-security.js';

const PROVIDER_CLASSES = {
  gemini: GeminiProvider,
  groq: GroqProvider,
  openrouter: OpenRouterProvider,
  cloudflare: CloudflareProvider
};

export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_CLASSES);

/**
 * Instancie un fournisseur à partir de sa config (clé déchiffrée).
 * @param {Object} providerConfig - Ligne de la table ai_providers
 * @returns {BaseProvider}
 */
export function createProvider(providerConfig) {
  const Cls = PROVIDER_CLASSES[providerConfig.provider_name];
  if (!Cls) throw new Error(`Fournisseur inconnu : ${providerConfig.provider_name}`);

  let apiKey = null;
  if (providerConfig.api_key_encrypted && providerConfig.api_key_iv && providerConfig.api_key_tag) {
    apiKey = decryptApiKey({
      encrypted: providerConfig.api_key_encrypted,
      iv: providerConfig.api_key_iv,
      tag: providerConfig.api_key_tag
    });
  } else if (providerConfig._legacy_env_key) {
    apiKey = providerConfig._legacy_env_key;
  }

  if (!apiKey) throw new Error(`Clé API manquante pour ${providerConfig.provider_name}.`);

  return new Cls({ ...providerConfig, apiKey });
}

export { GeminiProvider, GroqProvider, OpenRouterProvider, CloudflareProvider };