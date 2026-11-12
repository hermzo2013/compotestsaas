import { BaseProvider } from './base.provider.js';

const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.model = config.model || DEFAULT_MODEL;
    this.baseUrl = (config.base_url || DEFAULT_BASE).replace(/\/$/, '');
  }

  async chat(messages, options = {}) {
    const model = options.model || this.model;
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

    // Conversion du format OpenAI (messages) vers Gemini (contents + systemInstruction)
    const systemParts = [];
    const contents = [];
    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push({ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
        continue;
      }
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

    const body = { contents };
    if (systemParts.length) body.systemInstruction = { parts: systemParts };
    const generationConfig = {};
    if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
    if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
    if (options.jsonMode) generationConfig.responseMimeType = 'application/json';
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

    // Authentification via header x-goog-api-key (méthode officielle recommandée par Google)
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey
      },
      body: JSON.stringify(body),
      signal: options.signal
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
      throw new Error(`Gemini ${res.status} : ${this.sanitizeError(errMsg)}`);
    }

    const candidate = data.candidates && data.candidates[0];
    const content = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map(p => p.text || '').join('')
      : '';

    const usageMeta = data.usageMetadata || {};
    return {
      content,
      usage: {
        promptTokens: usageMeta.promptTokenCount || 0,
        completionTokens: usageMeta.candidatesTokenCount || 0,
        totalTokens: usageMeta.totalTokenCount || 0
      },
      raw: data
    };
  }

  async testConnection() {
    try {
      const url = `${this.baseUrl}/models`;
      const res = await fetch(url, {
        headers: { 'x-goog-api-key': this.apiKey }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
        return { ok: false, error: this.sanitizeError(msg) };
      }
      const data = await res.json();
      const models = (data.models || []).map(m => m.name.replace(/^models\//, ''));
      return { ok: true, model: this.model, models };
    } catch (e) {
      return { ok: false, error: this.sanitizeError(e.message) };
    }
  }

  supportsVision() {
    return /gemini-(1\.5|2\.0|2\.5|3\.|pro|flash)/i.test(this.model);
  }

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