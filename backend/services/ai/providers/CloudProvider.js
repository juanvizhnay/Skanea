import fetch from 'node-fetch';
import ProviderInterface from './ProviderInterface.js';

export default class CloudProvider extends ProviderInterface {
  constructor({ apiKey, baseUrl = 'https://api.openai.com/v1', model = null } = {}) {
    super();
    this.apiKey = apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = baseUrl;
    // Respeta exactamente la configuración existente; si OPENAI_MODEL es 'o3', se usará 'o3'
    this.defaultModel = model || process.env.OPENAI_MODEL || process.env.CLOUD_DEFAULT_MODEL || 'gpt-3.5-turbo';
  }

  async sendChat(messages, options = {}) {
    const model = options.model || this.defaultModel;
    const temperature = typeof options.temperature === 'number' ? options.temperature : 0.2;
    const maxTokens = Number(options.maxTokens || process.env.CLOUD_MAX_TOKENS || process.env.OPENAI_MAX_OUTPUT_TOKENS || 4096);
    const isResponsesApi = /^o3/i.test(String(model));
    const url = isResponsesApi ? `${this.baseUrl}/responses` : `${this.baseUrl}/chat/completions`;
    const payload = isResponsesApi
      ? (() => {
          const combined = (Array.isArray(messages) ? messages : [])
            .map((m) => `${m.role}: ${String(m.content ?? '')}`)
            .join('\n\n');
          const base = {
            model,
            input: [
              {
                role: 'user',
                content: [{ type: 'input_text', text: combined }],
              },
            ],
            // o3 / Responses API usa max_output_tokens
            max_output_tokens: maxTokens,
          };
          // Nota: o3 no soporta 'temperature'. No incluirlo para Responses API
          return base;
        })()
      : { model, messages, temperature, max_tokens: maxTokens, stream: false };
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      ...(isResponsesApi ? { 'OpenAI-Beta': 'assistants=v2, responses-2024-12-17' } : {}),
    };
    const t0 = Date.now();
    const controller = new AbortController();
    const timeoutMs = Number(process.env.CLOUD_TIMEOUT_MS || 60000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      // Adjuntar detalles para el log del servidor
      const err = new Error(`CloudProvider HTTP ${resp.status} ${url}: ${txt}`);
      err.httpStatus = resp.status;
      err.requestUrl = url;
      err.requestPayload = payload;
      err.headers = headers;
      err.httpStatus = resp.status;
      throw err;
    }
    const data = await resp.json();
    let content = '';
    let finish_reason = undefined;
    let tokens_used = undefined;
    if (isResponsesApi) {
      const tryList = [];
      tryList.push(data && data.output_text);
      tryList.push(Array.isArray(data?.output)
        ? data.output
            .flatMap((o) => Array.isArray(o?.content) ? o.content : [])
            .filter((c) => c && (c.type === 'output_text' || c.type === 'text'))
            .map((c) => c.text)
            .filter(Boolean)
            .join('\n')
        : '');
      tryList.push(data?.message?.content?.map?.((c) => c?.text).filter(Boolean).join('\n'));
      tryList.push(data?.choices?.[0]?.message?.content);
      content = tryList.find((x) => typeof x === 'string' && x.trim().length > 0) || '';
      // Intentar derivar finish_reason / tokens desde Responses API
      try {
        const status = data?.status || data?.response?.status;
        const incompleteReason = data?.incomplete_details?.reason || data?.response?.incomplete_details?.reason;
        if (status === 'incomplete' && incompleteReason === 'max_output_tokens') {
          finish_reason = 'length';
        } else if (status === 'incomplete' && incompleteReason) {
          finish_reason = String(incompleteReason);
        } else if (status === 'completed' || status === 'complete' || status === 'finished') {
          finish_reason = 'stop';
        }
      } catch {}
      try {
        const usage = data?.usage || data?.response?.usage || {};
        tokens_used = usage.output_text_tokens || usage.output_tokens || usage.completion_tokens || usage.total_tokens || undefined;
      } catch {}
    } else {
      content = data?.choices?.[0]?.message?.content || '';
      try { finish_reason = data?.choices?.[0]?.finish_reason || undefined; } catch {}
      try {
        const usage = data?.usage || {};
        tokens_used = usage.completion_tokens || usage.output_tokens || usage.total_tokens || undefined;
      } catch {}
    }
    const latencyMs = Date.now() - t0;
    try { console.log(`[CloudProvider] ${model} latency=${latencyMs}ms endpoint=${url}`); } catch {}
    return { content, model, provider: 'cloud', latencyMs, finish_reason, tokens_used };
  }
}


