import { BaseProvider } from './base.provider.js';
import { GoogleGenAI } from '@google/genai';

const DEFAULT_MODEL = 'gemini-2.5-flash'; // ⚠️ 'gemini-3.8-flash' n'existe probablement pas
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.model = config.model || DEFAULT_MODEL;
    this.baseUrl = (config.base_url || DEFAULT_BASE).replace(/\/$/, '');
  }

  /**
   * Construit un client GoogleGenAI à la demande (la clé peut changer après un update en base).
   */
  _client() {
    return new GoogleGenAI({ apiKey: this.apiKey });
  }

  /**
   * Convertit le format "messages" (OpenAI-like) vers le format attendu par
   * ai.models.generateContent({ contents: Content[] }).
   */
  _toGeminiContents(messages) {
    const contents = [];
    for (const m of messages) {
      if (m.role === 'system') continue; // géré séparément via systemInstruction
      const parts = [];
      if (typeof m.content === 'string') {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === 'text') parts.push({ text: c.text });
          else if (c.type === 'image_url') {
            const imgUrl = c.image_url && c.image_url.url;
            if (imgUrl && imgUrl.startsWith('data:')) {
              const match = imgUrl.match(/^data:([^;]+);base64,(.+)$/);
              if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
            } else if (imgUrl) {
              parts.push({ fileData: { mimeType: 'image/jpeg', fileUri: imgUrl } });
            }
          }
        }
      }
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
    }
    return contents;
  }

  async chat(messages, options = {}) {
    const model = options.model || this.model;
    const ai = this._client();

    // systemInstruction : concatène tous les messages système en un seul bloc
    const systemText = messages
      .filter(m => m.role === 'system')
      .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n\n');

    const config = {};
    if (systemText) config.systemInstruction = { parts: [{ text: systemText }] };
    if (options.temperature !== undefined) config.temperature = options.temperature;
    if (options.maxTokens !== undefined) config.maxOutputTokens = options.maxTokens;
    if (options.jsonMode) config.responseMimeType = 'application/json';

    try {
      const response = await ai.models.generateContent({
        model,
        contents: this._toGeminiContents(messages),
        config: Object.keys(config).length ? config : undefined,
        // Le SDK ne gère pas les AbortSignal nativement sur generateContent dans toutes les versions ;
        // on transmet si disponible.
        ...(options.signal ? { signal: options.signal } : {})
      });

      const content = response.text || '';
      const usageMeta = response.usageMetadata || {};
      return {
        content,
        usage: {
          promptTokens: usageMeta.promptTokenCount || 0,
          completionTokens: usageMeta.candidatesTokenCount || 0,
          totalTokens: usageMeta.totalTokenCount || 0
        },
        raw: response
      };
    } catch (e) {
      // Le SDK lève des ApiError avec .message / .status
      const msg = e && e.message ? e.message : String(e);
      throw new Error(`Gemini : ${this.sanitizeError(msg)}`);
    }
  }

  async testConnection() {
    try {
      const ai = this._client();
      // Un mini appel generateContent est le test le plus fiable : il vérifie
      // à la fois la clé ET que le modèle existe.
      const response = await ai.models.generateContent({
        model: this.model,
        contents: 'ping',
        config: { maxOutputTokens: 1, temperature: 0 }
      });
      // Si on arrive ici sans exception, la clé et le modèle sont valides.
      return {
        ok: true,
        model: this.model,
        models: await this.listModels() // best-effort
      };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      return { ok: false, error: this.sanitizeError(msg) };
    }
  }

  supportsVision() {
    return /gemini-(1\.5|2\.0|2\.5|3\.|pro|flash)/i.test(this.model);
  }

  /**
   * Liste les modèles disponibles. Le SDK JS @google/genai n'expose pas
   * une méthode `ai.models.list()` documentée de façon stable dans toutes
   * les versions ; on garde l'appel REST direct (qui fonctionne toujours
   * avec x-goog-api-key) et on retombe sur [this.model] en cas d'échec.
   */
  async listModels() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { 'x-goog-api-key': this.apiKey }
      });
      if (!res.ok) return [this.model];
      const data = await res.json();
      return (data.models || []).map(m => m.name.replace(/^models\//, ''));
    } catch (e) {
      return [this.model];
    }
  }
}