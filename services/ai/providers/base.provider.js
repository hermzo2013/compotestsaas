/**
 * Classe de base pour tous les fournisseurs d'IA.
 * Chaque fournisseur doit implémenter :
 *   - chat(messages, options) → { content, usage, raw }
 *   - testConnection() → { ok, model, error? }
 *   - supportsVision() → boolean
 *   - listModels() → string[]
 */
export class BaseProvider {
  constructor(config) {
    this.name = config.provider_name;
    this.config = config;
    this.model = config.model;
    this.baseUrl = config.base_url;
    this.apiKey = config.apiKey; // décryptée au moment de l'instanciation
    this.accountId = config.account_id;
  }

  /**
   * Envoie une requête de chat.
   * @param {Array<{role:string, content:string|Array}>} messages
   * @param {Object} options - { model, temperature, maxTokens, jsonMode, signal }
   * @returns {Promise<{content:string, usage:{promptTokens:number,completionTokens:number,totalTokens:number}, raw:Object}>}
   */
  async chat(messages, options = {}) {
    throw new Error(`chat() non implémenté pour ${this.name}`);
  }

  /**
   * Teste la connexion au fournisseur.
   * @returns {Promise<{ok:boolean, model?:string, error?:string}>}
   */
  async testConnection() {
    throw new Error(`testConnection() non implémenté pour ${this.name}`);
  }

  /**
   * Indique si le fournisseur supporte les images (vision).
   */
  supportsVision() {
    return false;
  }

  /**
   * Liste les modèles disponibles (approximatif si l'API ne le permet pas).
   */
  async listModels() {
    return this.model ? [this.model] : [];
  }

  /**
   * Nettoie la réponse brute pour ne jamais exposer la clé API.
   */
  sanitizeError(error) {
    const msg = error && error.message ? String(error.message) : String(error);
    return msg.replace(this.apiKey || '', '[clé masquée]');
  }
}