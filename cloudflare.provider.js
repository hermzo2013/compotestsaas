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
      const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/models/search`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data.errors ? data.errors.map(e => e.message).join('; ') : `HTTP ${res.status}`;
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