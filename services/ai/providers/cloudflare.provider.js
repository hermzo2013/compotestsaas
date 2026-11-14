import { BaseProvider } from './base.provider.js';

const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export class CloudflareProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.model = config.model || DEFAULT_MODEL;
    this.accountId = config.account_id;
  }

  buildUrl() {
    if (!this.accountId) throw new Error('Cloudflare : account_id manquant.');
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run/${this.model}`;
  }

  async chat(messages, options = {}) {
    const url = this.buildUrl();
    const body = {
      messages,
      max_tokens: options.maxTokens !== undefined ? options.maxTokens : 1024,
      temperature: options.temperature !== undefined ? options.temperature : 0.4
    };
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
    if (!res.ok || (data.success === false)) {
      const errs = data.errors ? data.errors.map(e => e.message).join('; ') : `HTTP ${res.status}`;
      throw new Error(`Cloudflare ${res.status} : ${this.sanitizeError(errs)}`);
    }

    const result = data.result || {};
    const content = typeof result.response === 'string' ? result.response
      : (result.response && result.response.content) || '';
    const usage = result.usage || {};
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
      if (!this.accountId) return { ok: false, error: 'account_id manquant.' };
      // Test réel : un mini appel d'inférence (POST /ai/run/<modèle>), comme chat().
      // L'ancien test (GET /ai/models/search) est refusé par certains types de jetons
      // ("Method not allowed for this authentication scheme").
      const res = await fetch(this.buildUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        const msg = data.errors && data.errors.length
          ? data.errors.map(e => `${e.message}${e.code ? ' (code ' + e.code + ')' : ''}`).join('; ')
          : `HTTP ${res.status}`;
        return { ok: false, error: this.sanitizeError(msg) };
      }
      return { ok: true, model: this.model };
    } catch (e) {
      return { ok: false, error: this.sanitizeError(e.message) };
    }
  }

  supportsVision() {
    return /llava|vision|uform|stable-diffusion/i.test(this.model);
  }

  async listModels() {
    return [this.model];
  }
}