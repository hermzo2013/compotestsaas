import { BaseProvider } from './base.provider.js';

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_BASE = 'https://api.groq.com/openai/v1';

export class GroqProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.model = config.model || DEFAULT_MODEL;
    this.baseUrl = (config.base_url || DEFAULT_BASE).replace(/\/$/, '');
  }

  async chat(messages, options = {}) {
    const model = options.model || this.model;
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model,
      messages,
      temperature: options.temperature !== undefined ? options.temperature : 0.4
    };
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options.jsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body),
      signal: options.signal
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
      throw new Error(`Groq ${res.status} : ${this.sanitizeError(errMsg)}`);
    }

    const content = (data.choices && data.choices[0] && data.choices[0].message)
      ? data.choices[0].message.content || ''
      : '';
    const usage = data.usage || {};
    return {
      content,
      usage: {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0
      },
      raw: data
    };
  }

  async testConnection() {
    try {
      const url = `${this.baseUrl}/models`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${this.apiKey}` } });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
        return { ok: false, error: this.sanitizeError(msg) };
      }
      const data = await res.json();
      const models = (data.data || []).map(m => m.id);
      return { ok: true, model: this.model, models };
    } catch (e) {
      return { ok: false, error: this.sanitizeError(e.message) };
    }
  }

  supportsVision() {
    return /vision|llava|llama-3\.2-11b-vision|llama-3\.2-90b-vision/i.test(this.model);
  }

  async listModels() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
      if (!res.ok) return [this.model];
      const data = await res.json();
      return (data.data || []).map(m => m.id);
    } catch (e) {
      return [this.model];
    }
  }
}