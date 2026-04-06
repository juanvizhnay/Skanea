import fetch from 'node-fetch';
import ProviderInterface from './ProviderInterface.js';
import os from 'os';

// Local llama.cpp-compatible HTTP server
// Expects endpoint like: POST http://127.0.0.1:8080/v1/chat/completions
// body: { model, messages, temperature }

export default class LocalProvider extends ProviderInterface {
  constructor({ baseUrl = process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434/v1', model = process.env.LOCAL_LLM_DEFAULT_MODEL || 'mistral:instruct' } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.defaultModel = model;
  }

  async health() {
    try {
      const r = await fetch(`${this.baseUrl.replace(/\/$/, '')}/models`, { method: 'GET' });
      return r.ok;
    } catch (_) {
      return false;
    }
  }

  async sendChat(messages, options = {}) {
    const model = options.model || this.defaultModel;
    const temperature = typeof options.temperature === 'number' ? options.temperature : 0.2;
    const url = `${this.baseUrl}/chat/completions`;
    const threads = Number(process.env.LOCAL_LLM_THREADS || 0) || Math.max(2, Math.floor((os.cpus()?.length || 4) / 2));
    const ctx = Number(process.env.LOCAL_LLM_CTX || 1024);
    const maxPredict = Number(options.maxTokens || process.env.LOCAL_LLM_MAX_TOKENS || 768);
    const body = { model, messages, temperature, options: { num_ctx: ctx, num_predict: maxPredict, num_thread: threads }, keep_alive: '30m', stream: false };
    const t0 = Date.now();
    const controller = new AbortController();
    const timeoutMs = Number(process.env.LOCAL_TIMEOUT_MS || 45000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      const err = new Error(`LocalProvider HTTP ${resp.status}: ${txt}`);
      err.httpStatus = resp.status;
      throw err;
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
    let finish_reason = undefined;
    let tokens_used = undefined;
    try { finish_reason = data?.choices?.[0]?.finish_reason || undefined; } catch {}
    try {
      const usage = data?.usage || {};
      tokens_used = usage.completion_tokens || usage.output_tokens || usage.total_tokens || undefined;
    } catch {}
    const latencyMs = Date.now() - t0;
    try { console.log(`[LocalProvider] ${model} latency=${latencyMs}ms ctx=${ctx} predict=${maxPredict} threads=${threads}`); } catch {}
    return { content, model: options.model || this.defaultModel, provider: 'local', latencyMs, finish_reason, tokens_used };
  }
}


