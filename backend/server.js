import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch, { FormData, Blob } from 'node-fetch';
import path from 'path';
import fs from 'fs';
import nodeCrypto from 'crypto';
import authRoutes from './routes/authRoutes.js';
import modelRoutes from './routes/modelRoutes.js';
import { sendChatRouted } from './services/ai/router.js';
import subscriptionRoutes from './routes/subscriptionRoutes.js';
import workspaceRoutes from './routes/workspaceRoutes.js';
import conversationRoutes from './routes/conversationRoutes.js';
import messageRoutes from './routes/messageRoutes.js';
import transcriptionRoutes from './routes/transcriptionRoutes.js';
import exportRoutes from './routes/exportRoutes.js';
import connectorRoutes from './routes/connectorRoutes.js';
import publicGoogleOAuth from './routes/publicGoogleOAuth.js';
import metaRoutes from './routes/metaRoutes.js';
import metaWebhook from './routes/metaWebhook.js';
import exportService from './services/exportService.js';
import imageService from './services/imageService.js';
import { webSearchGoogle, formatResultsForPrompt as formatSearchResultsForPrompt } from './services/googleSearchService.js';
import { connectMongoDB } from './config/mongodb.js';
import Message from './models/message.js';
import jwt from 'jsonwebtoken';
import { decryptFromBase64, encryptToBase64 } from './utils/crypto.js';
import authenticateToken from './middleware/auth.js';
// Intent: por ahora no necesitamos DB aquí; la ejecución vendrá luego

dotenv.config();

const app = express();
// Usar un secreto consistente para firmar y verificar JWT incluso si falta la env var
const JWT_SECRET = process.env.JWT_SECRET || 'skanea_secret';

// Configuración CORS para entornos de desarrollo (acepta 5173/5174 y 127.0.0.1)
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174'
];

const corsOptions = {
  origin: (origin, callback) => {
    // Permitir solicitudes sin origin (por ejemplo, herramientas como curl o test locales)
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true,
  exposedHeaders: [
    'x-ai-provider','x-ai-model','x-ai-latency-ms',
    'x-md-pre-len','x-md-post-len','x-md-pre-fences','x-md-post-fences','x-md-hint-links'
  ],
};

app.use(cors(corsOptions));
// Responder preflights antes que las rutas (evita chocar con middlewares protegidos)
app.options('*', cors(corsOptions));
app.use(express.json());

// Rutas de autenticación
app.use('/api/auth', authRoutes);
// Rutas de suscripciones
app.use('/api/subscriptions', authenticateToken, subscriptionRoutes);
// Rutas de MongoDB (historial de conversaciones)
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api', modelRoutes);
// Rutas de transcripción
app.use('/api/transcription', transcriptionRoutes);
// Rutas de exportación
app.use('/api', exportRoutes);
// Rutas de conectores (OAuth y callbacks)
// IMPORTANTE: montar primero las rutas públicas (callback) y luego las protegidas
app.use('/api/connectors', publicGoogleOAuth);
app.use('/api/connectors', authenticateToken, connectorRoutes);
// Meta API
app.use('/api/meta', authenticateToken, metaRoutes);
// Webhook público Meta
app.use('/api', express.json({ type: '*/*' }), metaWebhook);

// --- Utilidades de red y cache en memoria (para precios/noticias) ---
const REALTIME_CACHE_TTL = parseInt(process.env.REALTIME_CACHE_TTL || '45', 10) * 1000; // ms
const DEFAULT_TIMEOUT_MS = parseInt(process.env.REALTIME_TIMEOUT_MS || '8000', 10);
const realtimeCache = new Map(); // key -> { expires: number, value: any }

function getCache(key) {
  const entry = realtimeCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { realtimeCache.delete(key); return null; }
  return entry.value;
}

function setCache(key, value, ttlMs = REALTIME_CACHE_TTL) {
  realtimeCache.set(key, { value, expires: Date.now() + ttlMs });
}

// --- Utilidades de finalización de texto para markdown y listas ---
function isDebugMarkdown(req) {
  try {
    if (String(process.env.DEBUG_MARKDOWN || '') === '1') return true;
    if (String(req?.headers?.['x-debug-markdown'] || '').toLowerCase() === '1') return true;
    if (String(req?.query?.debug_markdown || '') === '1') return true;
  } catch {}
  return false;
}
function mdLog(req, ...args) {
  try { if (isDebugMarkdown(req)) console.log('[MD]', ...args); } catch {}
}
function hasOpenCodeFence(text) {
  try {
    const s = String(text || '');
    const matches = s.match(/```/g);
    const count = matches ? matches.length : 0;
    return (count % 2) === 1;
  } catch { return false; }
}

function endsWithOpenList(text) {
  try {
    const s = String(text || '').replace(/\s+$/,'');
    if (!s) return false;
    if (s.endsWith(':')) return true;
    // Línea final con viñeta sin contenido
    const tail = s.split(/\r?\n/).pop() || '';
    if (/^\s*[-*]\s*$/.test(tail)) return true;
    if (/^\s*\d+\.\s*$/.test(tail)) return true;
    return false;
  } catch { return false; }
}

function endsWithDanglingBackslash(text) {
  try {
    const s = String(text || '');
    return /\\\s*$/.test(s);
  } catch { return false; }
}

function normalizeFinalText(text) {
  let out = String(text || '');
  // Cerrar cerca de código abierta
  if (hasOpenCodeFence(out)) out += "\n```";
  // Si termina con ':' sugiere primer item
  if (out.replace(/\s+$/,'').endsWith(':')) out += "\n- …";
  // Cortar barra invertida suelta al final
  if (endsWithDanglingBackslash(out)) out = out.replace(/\\\s*$/, '');
  return out;
}

function deriveTruncationFlags(content, finishReason) {
  const openFence = hasOpenCodeFence(content);
  const openList = endsWithOpenList(content);
  const fr = String(finishReason || '').toLowerCase();
  const truncated = openFence || openList || (fr && fr !== 'stop');
  return { openFence, openList, truncated };
}

// Intenta concatenar evitando repeticiones al inicio del nuevo fragmento
function mergeNonRepeating(base, addition) {
  const a = String(base || '');
  let b = String(addition || '');
  if (!b) return a;
  const tail = a.slice(Math.max(0, a.length - 400));
  // Si el nuevo fragmento empieza repitiendo parte del tail, recorta
  for (let k = Math.min(tail.length, 200); k >= 32; k -= 8) {
    const sub = tail.slice(tail.length - k);
    if (b.startsWith(sub)) { b = b.slice(k); break; }
  }
  return a + b;
}

// Selección de preset/calidad/velocidad por headers
function selectReplyConfig(req, preferLocalModel) {
  const preset = String(req.headers['x-reply-preset'] || '').toLowerCase();
  const hintMax = parseInt(String(req.headers['x-max-tokens'] || ''), 10);
  const base = (p) => ({
    temperature: p.temperature,
    maxTokens: p.maxTokens,
    continueMaxAttempts: p.continueMaxAttempts,
  });
  const presets = {
    fast: base({ temperature: 0.2, maxTokens: 2048, continueMaxAttempts: 1 }),
    balanced: base({ temperature: 0.2, maxTokens: 3072, continueMaxAttempts: 2 }),
    quality: base({ temperature: 0.25, maxTokens: 8192, continueMaxAttempts: 3 })
  };
  let chosen = presets.fast; // Cambiado a fast por defecto para mejor velocidad
  if (preset && presets[preset]) chosen = presets[preset];
  // Permitir override por header
  if (Number.isFinite(hintMax) && hintMax > 0) {
    chosen = { ...chosen, maxTokens: hintMax };
  }
  // Ajustar para modelos locales (num_predict mucho más bajo)
  if (preferLocalModel) {
    const localCap = Number(process.env.LOCAL_LLM_MAX_TOKENS || 768);
    chosen = { ...chosen, maxTokens: Math.min(chosen.maxTokens, localCap) };
  }
  // Límite superior global
  const hardCap = Number(process.env.REPLY_MAX_TOKENS || 4096);
  chosen = { ...chosen, maxTokens: Math.min(chosen.maxTokens, hardCap) };
  return {
    temperatureWanted: chosen.temperature,
    maxTokensWanted: chosen.maxTokens,
    continueMaxAttempts: chosen.continueMaxAttempts
  };
}

// Quitar bloques de código "accidentales" cuando la respuesta son enlaces/listas
function demoteAccidentalCodeBlocks(text, userPrompt, hintIsLinks) {
  try {
    let out = String(text || '');
    const needDemoteByPrompt = /(enlaces?|links?|urls?|documentaci[oó]n|resultados?)\b/i.test(String(userPrompt || ''));
    if (!/```/.test(out)) return out;
    function isMostlyLinksOrList(s) {
      const lines = String(s || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
      if (lines.length === 0) return false;
      let urlLines = 0, bullets = 0, codeSignals = 0;
      const codeRe = /(\{|\}|;|\bclass\b|\bdef\b|\bfunction\b|=>|console\.log|import\s+|package\s+|#include|using\s+|public\s+|private\s+|^\s*from\s+\w+\s+import\s+)/i;
      for (const l of lines) {
        if (/https?:\/\//i.test(l)) urlLines++;
        if (/^(?:[-*]|\d+\.)\s/.test(l)) bullets++;
        if (codeRe.test(l)) codeSignals++;
      }
      const nonEmpty = lines.length;
      const ratio = (urlLines + bullets) / nonEmpty;
      // Nota: mdLog requiere req; se llamará en el punto de uso fuera del helper si hace falta
      return ratio >= 0.55 && codeSignals <= 1;
    }
    let replacedClosed = 0;
    out = out.replace(/```\s*([a-z0-9_+\-]*)[ \t]*\r?\n([\s\S]*?)```/gi, (m, langRaw, body) => {
      const lang = String(langRaw || '').toLowerCase().trim();
      const looksLikeLinks = isMostlyLinksOrList(body);
      // Si el lenguaje es python/js/java/etc y el cuerpo es mayormente enlaces/listas, quitar cercas
      const isLangCodey = /^(python|py|javascript|js|ts|typescript|java|c\+\+|cpp|c|go|rust|ruby|php|bash|sh|shell|powershell|swift|kotlin)$/.test(lang);
      const shouldDemote = (looksLikeLinks && (hintIsLinks || needDemoteByPrompt)) || (looksLikeLinks && isLangCodey);
      // mdLog(req, 'closed-fence', { lang, looksLikeLinks, isLangCodey, hintIsLinks, needDemoteByPrompt, shouldDemote });
      if (shouldDemote) {
        replacedClosed++;
        return body; // quitar cercas
      }
      return m;
    });
    // Manejar cerca ABIERTA (sin cierre) al final del texto
    if (hasOpenCodeFence(out)) {
      out = out.replace(/```[ \t]*([a-z0-9_+\-]*)[^\n]*\n([\s\S]*)$/i, (m, langRaw, body) => {
        const lang = String(langRaw || '').toLowerCase().trim();
        const looksLikeLinks = isMostlyLinksOrList(body);
        const isLangCodey = /^(python|py|javascript|js|ts|typescript|java|c\+\+|cpp|c|go|rust|ruby|php|bash|sh|shell|powershell|swift|kotlin)$/.test(lang);
        const shouldDemote = (looksLikeLinks && (hintIsLinks || needDemoteByPrompt)) || (looksLikeLinks && isLangCodey);
        // mdLog(req, 'open-fence', { lang, looksLikeLinks, isLangCodey, hintIsLinks, needDemoteByPrompt, shouldDemote });
        if (shouldDemote) return body; // quitar apertura; no habrá cierre añadido luego
        return m;
      });
    }
    // mdLog(req, 'demote-summary', { replacedClosed, hasOpenFenceAfter: hasOpenCodeFence(out) });
    return out;
  } catch { return text; }
}

// Si el primer renglón es solo el nombre de un lenguaje ("python", "js"...) y el cuerpo es lista/enlaces, quitar esa etiqueta
function stripLeadingLanguageLabel(text) {
  try {
    const s = String(text || '');
    const lines = s.split(/\r?\n/);
    if (lines.length < 2) return s;
    const first = (lines[0] || '').trim().replace(/^`+|`+$/g, '').toLowerCase();
    const isLang = /^(python|py|javascript|js|ts|typescript|java|c\+\+|cpp|c|go|rust|ruby|php|bash|sh|shell|powershell|swift|kotlin)$/.test(first);
    if (!isLang) return s;
    const rest = lines.slice(1).join('\n');
    const restLines = rest.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    if (restLines.length === 0) return s;
    let urlOrBullet = 0;
    for (const l of restLines) {
      if (/https?:\/\//i.test(l)) urlOrBullet++;
      if (/^(?:[-*]|\d+\.)\s/.test(l)) urlOrBullet++;
    }
    const ratio = urlOrBullet / restLines.length;
    if (ratio >= 0.5) return rest; // quitar etiqueta de lenguaje
    return s;
  } catch { return text; }
}

// Forzar texto plano cuando el usuario pidió enlaces/URLs/documentación.
// El objetivo es evitar que respuestas con listas de enlaces queden dentro de
// bloques de código etiquetados como "```python" solo por la palabra "python" en el prompt.
function enforcePlainTextForLinkAnswers(text, userPrompt) {
  try {
    const wantsLinks = /(enlaces?|links?|urls?|documentaci[oó]n|fuentes?|resultados?)/i.test(String(userPrompt || ''));
    if (!wantsLinks) return text;
    let out = String(text || '');
    // 1) Desencerrar cualquier bloque de código cerrado devolviendo solo el cuerpo
    out = out.replace(/```[ \t]*[a-z0-9_+\-]*[^\n]*\r?\n([\s\S]*?)```/gi, '$1');
    // 2) Quitar aperturas/cierres restantes (por si quedaron cercas abiertas)
    out = out.replace(/```[ \t]*[a-z0-9_+\-]*[^\n]*\r?\n?/gi, '');
    out = out.replace(/```/g, '');
    // 3) Quitar una etiqueta de lenguaje suelta al inicio si está presente
    out = stripLeadingLanguageLabel(out);
    return out;
  } catch { return text; }
}

async function fetchWithTimeoutAndRetry(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1) {
  const attempt = async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(t);
      return r;
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  };
  try {
    let r = await attempt();
    if (!r.ok && retries > 0) {
      r = await attempt();
    }
    return r;
  } catch (e) {
    if (retries > 0) return attempt();
    throw e;
  }
}

function formatUtcTime(tsMs) {
  try {
    const d = new Date(tsMs);
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
  } catch { return 'UTC'; }
}

// Ruta protegida de ejemplo
app.get('/api/protected', authenticateToken, (req, res) => {
  res.json({ message: 'Acceso permitido solo con JWT', user: req.user });
});

// Endpoint de búsqueda web con Google CSE
app.post('/api/websearch', authenticateToken, async (req, res) => {
  try {
    const { query, count, mode } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ success: false, message: 'query es requerido' });
    }
    const forcedMode = mode || req.headers['x-websearch-mode'] || req.query.mode;
    const result = await webSearchGoogle(query.trim(), { count: count || 5 });
    if (!result.success) return res.status(400).json(result);
    if (String(forcedMode || '').toLowerCase() === 'simple') {
      const items = Array.isArray(result?.raw?.items) ? result.raw.items : [];
      const top = (count || 5);
      return res.json({ success: true, mode: 'simple', results: items.slice(0, top) });
    }
    return res.json({ success: true, results: result.results });
  } catch (err) {
    console.error('websearch error', err);
    return res.status(500).json({ success: false, message: 'Error en websearch' });
  }
});

// Precio cripto gratis (CoinGecko)
app.get('/api/price/crypto', async (req, res) => {
  try {
    const id = String(req.query.asset || 'bitcoin').toLowerCase();
    const vs = String(req.query.vs || 'usd').toLowerCase();
    const cacheKey = `crypto:${id}:${vs}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(vs)}`;
    const r = await fetchWithTimeoutAndRetry(url, { headers: { 'Accept': 'application/json' } });
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (!r.ok || !j || !j[id] || typeof j[id][vs] === 'undefined') {
      return res.status(502).json({ success: false, message: 'No se pudo obtener precio en este momento. Intenta nuevamente en unos segundos.' });
    }
    const payload = { success: true, asset: id, vs, price: j[id][vs], source: 'CoinGecko', ts: Date.now() };
    setCache(cacheKey, payload);
    return res.json(payload);
  } catch (e) {
    console.error('crypto price error', e);
    return res.status(500).json({ success: false, message: 'Error obteniendo precio' });
  }
});

// Precio fiat gratis (exchangerate.host)
app.get('/api/price/fiat', async (req, res) => {
  try {
    const base = String(req.query.base || 'USD').toUpperCase();
    const vs = String(req.query.vs || 'EUR').toUpperCase();
    const cacheKey = `fiat:${base}:${vs}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    const url = `https://api.exchangerate.host/latest?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(vs)}`;
    const r = await fetchWithTimeoutAndRetry(url, {});
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (!r.ok || !j || !j.rates || typeof j.rates[vs] === 'undefined') {
      // Segundo intento: endpoint convert (exchangerate.host)
      try {
        const url2 = `https://api.exchangerate.host/convert?from=${encodeURIComponent(base)}&to=${encodeURIComponent(vs)}`;
        const r2 = await fetchWithTimeoutAndRetry(url2, {});
        let j2 = null;
        try { j2 = await r2.json(); } catch { j2 = null; }
        if (r2.ok && j2 && typeof j2.result === 'number') {
          const payload2 = { success: true, base, vs, rate: j2.result, source: 'exchangerate.host', ts: Date.now() };
          setCache(cacheKey, payload2);
          return res.json(payload2);
        }
      } catch {}
      // Tercer intento: Frankfurter (gratis)
      try {
        const url3 = `https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(vs)}`;
        const r3 = await fetchWithTimeoutAndRetry(url3, {});
        let j3 = null;
        try { j3 = await r3.json(); } catch { j3 = null; }
        if (r3.ok && j3 && j3.rates && typeof j3.rates[vs] !== 'undefined') {
          const payload3 = { success: true, base, vs, rate: j3.rates[vs], source: 'frankfurter.app', ts: Date.now() };
          setCache(cacheKey, payload3);
          return res.json(payload3);
        }
      } catch {}
      // Cuarto intento: open.er-api.com (obtener base y derivar)
      try {
        const url4 = `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`;
        const r4 = await fetchWithTimeoutAndRetry(url4, {});
        let j4 = null;
        try { j4 = await r4.json(); } catch { j4 = null; }
        if (r4.ok && j4 && j4.rates && typeof j4.rates[vs] !== 'undefined') {
          const payload4 = { success: true, base, vs, rate: j4.rates[vs], source: 'open.er-api.com', ts: Date.now() };
          setCache(cacheKey, payload4);
          return res.json(payload4);
        }
      } catch {}
      return res.status(502).json({ success: false, message: 'No se pudo obtener tipo de cambio en este momento. Intenta nuevamente en unos segundos.' });
    }
    const payload = { success: true, base, vs, rate: j.rates[vs], source: 'exchangerate.host', ts: Date.now() };
    setCache(cacheKey, payload);
    return res.json(payload);
  } catch (e) {
    console.error('fiat price error', e);
    return res.status(500).json({ success: false, message: 'Error obteniendo tipo de cambio' });
  }
});

// Noticias gratis (Google News RSS)
app.get('/api/news', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ success: false, message: 'q es requerido' });
    const hl = String(req.query.hl || 'es-419');
    const ceid = String(req.query.ceid || 'US:es-419');
    const cacheKey = `news:${hl}:${ceid}:${q}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${encodeURIComponent(hl)}&gl=US&ceid=${encodeURIComponent(ceid)}`;
    const r = await fetchWithTimeoutAndRetry(url, {}, DEFAULT_TIMEOUT_MS);
    const xml = await r.text();
    // Parseo básico sin dependencias
    const items = Array.from(xml.matchAll(/<item>[\s\S]*?<\/item>/g)).map(m => m[0]);
    const parsed = items.slice(0, 10).map(x => ({
      title: (x.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || x.match(/<title>(.*?)<\/title>/) || [,''])[1],
      link: (x.match(/<link>(.*?)<\/link>/) || [,''])[1],
      pubDate: (x.match(/<pubDate>(.*?)<\/pubDate>/) || [,''])[1]
    })).filter(i => i.link);
    const payload = { success: true, query: q, results: parsed, source: 'Google News RSS', ts: Date.now() };
    setCache(cacheKey, payload);
    return res.json(payload);
  } catch (e) {
    console.error('news error', e);
    return res.status(500).json({ success: false, message: 'Error obteniendo noticias' });
  }
});

// Función para detectar el formato usado anteriormente en el historial
function detectPreviousFormat(historial) {
  if (!Array.isArray(historial) || historial.length === 0) return null;

  // Buscar en los mensajes anteriores del usuario
  for (let i = historial.length - 1; i >= 0; i--) {
    const message = historial[i];
    if (message.role === 'user') {
      const exportReq = detectExportRequestInternal(message.content);
      if (exportReq.shouldExport) {
        return exportReq.format;
      }
    }
  }
  return null;
}

// Función interna para detectar exportación (sin historial)
function detectExportRequestInternal(text) {
  // PRIORIDAD 1: Detectar formato específico primero
  const formatMatch = text.match(/\b(pdf|docx|word|pptx|ppt|power\s*point|powerpoint|presentacion|presentación|txt|texto|csv|excel|excell|xlsx|hoja|calculo|cálculo|spreadsheet|planilla)\b/i);

  if (formatMatch) {
    let format = formatMatch[0].toLowerCase();

    if (format === 'word') format = 'docx';
    if (format === 'ppt' || /power\s*point/.test(format) || format === 'powerpoint' || format === 'presentacion' || format === 'presentación') format = 'pptx';
    if (format === 'texto') format = 'txt';
    if (format === 'excel' || format === 'excell' || format === 'hoja' || format === 'calculo' || format === 'cálculo' || format === 'spreadsheet' || format === 'planilla') format = 'xlsx';

    return {
      shouldExport: true,
      format,
      filename: 'documento_skanea',
      originalText: text
    };
  }

  return { shouldExport: false };
}

// Función para detectar solicitudes de exportación
function detectExportRequest(text, historial = null) {
  // PRIORIDAD 1 (ahora primero): Detectar formato específico SIEMPRE que lo mencionen
  const formatMatch = text.match(/\b(pdf|docx|word|pptx|ppt|power\s*point|powerpoint|txt|texto|csv|excel|excell|xlsx|hoja|calculo|cálculo|spreadsheet|planilla)\b/i);

  if (formatMatch) {
    let format = formatMatch[0].toLowerCase();

    if (format === 'word') format = 'docx';
    if (format === 'ppt' || /power\s*point/.test(format) || format === 'powerpoint') format = 'pptx';
    if (format === 'texto') format = 'txt';
    if (format === 'excel' || format === 'excell' || format === 'hoja' || format === 'calculo' || format === 'cálculo' || format === 'spreadsheet' || format === 'planilla') format = 'xlsx';

    return { shouldExport: true, format, filename: 'documento_skanea', originalText: text };
  }

  // PRIORIDAD 2: Preguntas de ANÁLISIS/LECTURA (solo si NO especifican formato)
  const analysisQuery = /(de\s+que\s+trata|de\s+qué\s+trata|que\s+contiene|qué\s+contiene|resumen|resume|resúmelo|resumelo|analiza|analizar|lee|leer|de\s+que\s+va|de\s+qué\s+va)\b/i;
  if (analysisQuery.test(text)) {
    return { shouldExport: false, isAnalysis: true };
  }

  // PRIORIDAD 2: Detectar solicitudes ambiguas que necesitan sugerencias
  const ambiguousRequests = [
    /\b(fichero|archivo)\s+(con\s+)?datos?\b/i,
    /\bexporta\s+(esto\s+)?(como\s+)?tabla\b/i,
    /\b(dame|hazme|genera|crea)\s+(un\s+)?(fichero|archivo|documento|reporte)\b(?!\s+(pdf|docx|word|pptx|powerpoint|txt|texto|csv|excel|excell|xlsx))/i,
    /\btabla\s+(con\s+)?(datos?|información|info)\b/i,
    /\b(necesito|quiero)\s+(un\s+)?(archivo|documento|fichero)\b(?!\s+(pdf|docx|word|pptx|powerpoint|txt|texto|csv|excel|excell|xlsx))/i,
    /\b(quiero|necesito|dame|hazme|genera|crea)\s+(un\s+|una\s+)?(presentacion|presentación)\b(?!\s+(en\s+)?(powerpoint|pptx))/i
  ];

  for (const pattern of ambiguousRequests) {
    if (pattern.test(text)) {
      return {
        shouldExport: false,
        needsSuggestion: true,
        originalText: text,
        suggestedFormats: ['xlsx', 'csv', 'pdf'],
        message: '¿En qué formato te gustaría el archivo? Puedo generarlo como:'
      };
    }
  }

  // PRIORIDAD 3: Detectar solicitudes de continuación/cambio en conversaciones
  // IMPORTANTE: Solo aplicar si hay mensajes previos (no es el primer mensaje)
  // El historial incluye el mensaje actual del usuario, así que necesitamos al menos 2 mensajes
  // (1 user anterior + 1 assistant O 2+ users) para que sea una continuación real
  const userMessages = Array.isArray(historial) ? historial.filter(m => m.role === 'user') : [];
  const assistantMessages = Array.isArray(historial) ? historial.filter(m => m.role === 'assistant') : [];

  // Tiene historial real solo si:
  // - Hay al menos 1 assistant (significa que ya hubo interacción previa)
  // - O hay más de 1 user (el actual + otro anterior)
  const hasConversationHistory = assistantMessages.length > 0 || userMessages.length > 1;

  if (hasConversationHistory) {
  const continuationPatterns = [
    /\b(y\s+)?(ahora|también|luego|después)\s+(puedes?|podrías?|me\s+puedes?)\s+(generar|crear|hacer|dar)\b/i,
    /\b(y\s+)?(ahora|también|después)\s+(puede\s+ser|hazlo|haz\s+uno)\s+(sobre|de|del|con)\b/i,
    /\b(y\s+)?(dámelo|damelo|hazlo|haz\s+uno)\s+(ahora|también|después)?\s+(sobre|de|del|con|en)\b/i,
    /\b(y\s+)?(otro|otra|uno)\s+(sobre|de|del|con)\b/i,
    /\b(y\s+)?(ahora|también|después)\s+(uno)\s+(sobre|de|del|con)\b/i,
    /\b(puede\s+ser|hazme\s+uno|haz\s+uno)\s+(sobre|de|del|con)\b/i,
    /\b(hazla|házla|creala|créala|generala|genérala|solo\s+hazla|solo\s+hazlo|solo\s+hacerla|solo\s+hacerlo)\b/i
  ];

  for (const pattern of continuationPatterns) {
    if (pattern.test(text)) {
      // Si es una continuación, usar el formato detectado en el historial
      const previousFormat = detectPreviousFormat(historial);
      const format = previousFormat || 'xlsx'; // Por defecto xlsx si no se encuentra formato previo

      return {
        shouldExport: true,
        format: format,
        filename: 'documento_skanea',
        originalText: text,
        isContinuation: true
      };
    }
    }
  } else {
  }

  // PRIORIDAD 4: Detectar respuestas directas de formato (cuando responden a una sugerencia)
  const formatResponsePatterns = [
    /^(xlsx|excel)$/i,
    /^(csv)$/i,
    /^(pdf)$/i,
    /^(docx|word)$/i,
    /^(pptx|ppt|power\s*point|powerpoint|presentacion|presentación)$/i,
    /^(txt|texto)$/i,
    /\b(prefiero|quiero|elige|elijo|uso)\s+(xlsx|excel|csv|pdf|docx|word|pptx|powerpoint|txt|texto)\b/i,
    /^(el\s+)?(xlsx|excel|csv|pdf|docx|word|pptx|ppt|power\s*point|powerpoint|txt|texto)(\s+por\s+favor)?$/i
  ];

  for (const pattern of formatResponsePatterns) {
    const match = text.match(pattern);
    if (match) {
      let format = (match[2] || match[1]).toLowerCase(); // Obtener el formato de cualquier grupo capturado
      if (format === 'excel' || format === 'excell') format = 'xlsx';
      if (format === 'word') format = 'docx';
      if (format === 'ppt' || /power\s*point/.test(format) || format === 'powerpoint' || format === 'presentacion' || format === 'presentación') format = 'pptx';
      if (format === 'texto') format = 'txt';

      return {
        shouldExport: true,
        format: format,
        filename: 'documento_skanea',
        originalText: text,
        isFormatResponse: true
      };
    }
  }

  // PRIORIDAD 5: Diferenciar entre "analizar/leer" y "generar archivo"
  const analysisPatterns = [
    /de\s+que\s+trata/i,
    /de\s+qué\s+trata/i,
    /\b(resumen|resume|resúmelo|resumelo|analiza|analizar|lee|leer|que\s+contiene|qué\s+contiene)\b/i
  ];
  if (analysisPatterns.some(p => p.test(text))) {
    return { shouldExport: false }; // No exportar; el flujo de lectura/resumen debe manejar esto
  }

  // PRIORIDAD 6: Solicitud genérica de crear archivo sin formato → pedir formato (no forzar XLSX)
  const fileCommandPatterns = [
    /\b(genera|generar|crea|crear|haz|hacer|exporta|exportar|convierte|convertir)\b[\s\S]*\b(archivo|documento|presentacion|presentación|pdf|docx|word|pptx|power\s*point|powerpoint|txt|texto|csv|excel|excell|xlsx)\b/i,
    /\b(archivo|documento|presentacion|presentación)\b[\s\S]*\b(genera|generar|crea|crear|haz|hacer|exporta|exportar|convierte|convertir)\b/i
  ];
  if (fileCommandPatterns.some(p => p.test(text))) {
    return {
      shouldExport: false,
      needsSuggestion: true,
      originalText: text,
      suggestedFormats: ['pptx', 'pdf', 'xlsx', 'csv'],
      message: '¿En qué formato deseas el archivo? Puedo generarlo como:'
    };
  }

  return { shouldExport: false };
}

// Detección robusta: cuándo hacer búsqueda web
function shouldWebSearch(text, historial = []) {
  const t = String(text || '').toLowerCase();
  const history = Array.isArray(historial) ? historial.map(m => String(m.content || '')).join(' ') : '';
  const all = `${t} ${history}`;

  // Forzar búsqueda con tags explícitas
  if (/(\[web\]|\[internet\]|@web|@internet)/i.test(all)) return true;
  // Heurística directa: rankings por año
  try { if (isRankingQuery(t)) return true; } catch {}

  let score = 0;
  const addIf = (re, pts) => { if (re.test(all)) score += pts; };

  // Intención explícita
  addIf(/\b(busca|buscar|investiga|investigar|averigua|averiguar)\b/i, 3);
  addIf(/\b(en\s+(internet|la\s+web|google|online))\b/i, 2);
  addIf(/\b(notici(as)?|titulares?)\b/i, 2);
  addIf(/\b(últim[ao]s\s+\d{0,2}?\s*(d[ií]as|semanas|horas)|hoy|ayer|esta\s+semana|en\s+vivo|ahora)\b/i, 2);
  addIf(/\b(fuentes?|enlaces?|links?|urls?|c[ií]tame|c[ií]tar|con\s+enlace)\b/i, 3);
  addIf(/\b(anunciaron|anuncio|lanzaron|lanzamiento|presentaron|presentaci[oó]n|release|ruptura|rumores?)\b/i, 2);
  addIf(/\b(precio\s+actual|cotizaci[oó]n|tipo\s+de\s+cambio|clima\s+de\s+hoy|resultado\s+del\s+partido)\b/i, 2);
  addIf(/\b(mejores?\s+\d{4}|ranking\s+\d{4}|top\s+\d{4})\b/i, 3);
  // Refuerzo: año + intención de ranking en cualquier orden
  addIf(/\b(ranking|mejores|top)\b.*\b20\d{2}\b/i, 5);
  addIf(/\b20\d{2}\b.*\b(ranking|mejores|top)\b/i, 5);
  addIf(/\b20\d{2}\b/i, 1);
  addIf(/\b(site:|inurl:|intitle:)\S+/i, 3);

  // Preguntas comparativas/abiertas suelen requerir corroboración
  addIf(/\b(qu[eé]\s+(pasa|pas[oó]|anunci[oó]|public[oó]|dij[oó])\b)/i, 1);

  // Umbral
  return score >= 3;
}

// Extrae un conteo deseado (e.g., 3, 5, 10) de la solicitud
function extractDesiredCountFromText(text, fallback = 5) {
  const t = String(text || '').toLowerCase();
  const m = t.match(/\b(\d{1,2})\b\s*(urls?|enlaces?|links?)?/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0 && n <= 20) return n;
  }
  return fallback;
}

// Detecta peticiones del tipo "solo URLs" (sin resumen)
function isLinkOnlyRequest(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(solo|sólo|solo\s+lista|lista\s+de|devuelve\s+solo|solo\s+devuelve)\b/i.test(t) && /(urls?|enlaces?|links?)\b/i.test(t)) return true;
  if (/^\s*(dame|devu(elv|él)veme|lista|entrega)\b.*(urls?|enlaces?|links?)\b/i.test(t)) return true;
  return false;
}

// Construye una query limpia para Google a partir del texto del usuario
function buildWebQueryFromText(text) {
  const raw = String(text || '');
  // 1) Preferir frases entre comillas (curvas o rectas)
  const quoted = raw.match(/["“”«»'‘’](.+?)["“”«»'‘’]/);
  if (quoted && quoted[1]) return quoted[1].trim();
  // 2) Eliminar palabras de control
  const cleaned = raw
    .replace(/\b(busca|buscar|investiga|investigar|averigua|averiguar|en\s+la\s+web|en\s+internet|devuelve|solo|sólo|urls?|enlaces?|links?|válidas?|oficial(es)?|repositorios?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || raw.trim();
}

// Filtra resultados hacia dominios más confiables cuando el usuario pide "oficial" o "medios"
function filterResultsByIntent(text, results) {
  const t = String(text || '').toLowerCase();
  const wantsOfficial = /(oficial|repositorio\s+oficial|sitio\s+oficial)/i.test(t);
  const wantsMedia = /(medio(s)?|prensa|news|noticias)/i.test(t);
  if (!wantsOfficial && !wantsMedia) return results;
  const officialDomains = [
    'ai.meta.com', 'about.fb.com', 'meta.ai',
    'openai.com', 'blog.google', 'developers.google.com', 'ai.google',
    'github.com', 'gitlab.com', 'arxiv.org', 'huggingface.co',
    'pytorch.org', 'tensorflow.org', 'microsoft.com', 'azure.microsoft.com'
  ];
  const mediaDomains = [
    'theverge.com', 'techcrunch.com', 'wired.com', 'theguardian.com',
    'nytimes.com', 'wsj.com', 'ft.com', 'bloomberg.com', 'reuters.com'
  ];
  const allowed = new Set([...(wantsOfficial ? officialDomains : []), ...(wantsMedia ? mediaDomains : [])]);
  const filtered = results.filter(r => {
    try {
      const u = new URL(r.url);
      const okHost = Array.from(allowed).some(d => u.hostname.endsWith(d));
      if (!okHost) return false;
      if (wantsOfficial) {
        if (u.hostname.endsWith('huggingface.co')) {
          if (!/^(\/meta-llama|\/facebookresearch)(\/|$)/i.test(u.pathname)) return false;
        }
        if (u.hostname.endsWith('github.com')) {
          if (!/^(\/meta-llama|\/facebookresearch)\//i.test(u.pathname)) return false;
        }
      }
      return true;
    } catch { return false; }
  });
  return filtered.length > 0 ? filtered : results;
}

// Deriva dominios oficiales a partir de marcas mencionadas en el prompt
function deriveBrandDomains(text) {
  const t = String(text || '').toLowerCase();
  const out = [];
  if (/(meta|llama)\b/.test(t)) out.push('ai.meta.com', 'about.fb.com', 'meta.ai', 'facebook.com', 'huggingface.co', 'github.com/meta-llama', 'github.com/facebookresearch');
  if (/openai\b/.test(t)) out.push('openai.com', 'platform.openai.com', 'openai.com/blog', 'github.com/openai');
  if (/google\b/.test(t)) out.push('ai.google', 'blog.google', 'developers.google.com');
  if (/microsoft\b/.test(t)) out.push('blogs.microsoft.com', 'microsoft.com', 'azure.microsoft.com');
  return Array.from(new Set(out));
}

// Reordena priorizando dominios oficiales (derivados) y de medios
function rankAndFilterResults(text, results) {
  const brandDomains = deriveBrandDomains(text);
  const mediaDomains = ['theverge.com','techcrunch.com','wired.com','bloomberg.com','reuters.com','ft.com','theguardian.com'];
  function score(url) {
    try {
      const h = new URL(url).hostname;
      if (brandDomains.some(d => h.endsWith(d))) return 100;
      if (/(github|gitlab)\.com$/.test(h)) return 90;
      if (mediaDomains.some(d => h.endsWith(d))) return 80;
      if (/huggingface\.co$/.test(h)) return 70;
      if (/arxiv\.org$/.test(h)) return 65;
      return 10;
    } catch { return 0; }
  }
  return [...results].sort((a, b) => score(b.url) - score(a.url));
}

// Valida URLs con HEAD rápido; si falla HEAD, intenta GET con range pequeño
async function validateUrls(results, desired = 5) {
  const limited = Array.isArray(results) ? results.slice(0, Math.max(desired * 3, desired)) : [];
  const whitelist = [
    'about.fb.com','ai.meta.com','meta.ai','datacamp.com','github.com','gitlab.com',
    'huggingface.co','arxiv.org','openai.com','blog.google','developers.google.com',
    'microsoft.com','azure.microsoft.com','theverge.com','techcrunch.com','wired.com','reuters.com','bloomberg.com','ft.com'
  ];
  const TRUSTED = [
    { host: 'github.com', pathPrefix: /^(\/meta-llama|\/facebookresearch)\//i },
    { host: 'huggingface.co', pathPrefix: /^(\/meta-llama|\/facebookresearch)(\/|$)/i },
    { host: 'ai.meta.com', pathPrefix: /^\// },
    { host: 'about.fb.com', pathPrefix: /^\// }
  ];
  function isTrusted(url) {
    try {
      const u = new URL(url);
      return TRUSTED.some(t => (u.hostname === t.host || u.hostname.endsWith('.' + t.host)) && t.pathPrefix.test(u.pathname));
    } catch { return false; }
  }
  async function check(u) {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 5000);
    try {
      if (isTrusted(u)) { clearTimeout(to); return true; }
      const h = new URL(u).hostname;
      let r = await fetch(u, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'Skanea/1.0' }, signal: controller.signal });
      const acceptable = r.ok || (r.status >= 300 && r.status < 400) || (r.status < 500 && [401,403,405,406,429].includes(r.status));
      if (!acceptable) {
        // GET mínima
        r = await fetch(u, { method: 'GET', headers: { 'Range': 'bytes=0-64', 'User-Agent': 'Skanea/1.0' }, redirect: 'follow', signal: controller.signal });
      }
      clearTimeout(to);
      return r.ok || (whitelist.some(d => h.endsWith(d)) && r.status < 500) || (r.status >= 300 && r.status < 400);
    } catch {
      clearTimeout(to);
      // En caso de fallo de red, confiar si el host es de la whitelist
      try { const h = new URL(u).hostname; return whitelist.some(d => h.endsWith(d)); } catch { return false; }
    }
  }
  const checks = await Promise.allSettled(limited.map(x => check(x.url)));
  const valids = [];
  for (let i = 0; i < checks.length && valids.length < desired; i++) {
    if (checks[i].status === 'fulfilled' && checks[i].value) valids.push(limited[i]);
  }
  return valids.length > 0 ? valids.slice(0, desired) : limited.slice(0, desired);
}

// Excluir redes sociales salvo que el usuario las pida
function excludeSocialUnlessRequested(text, results) {
  const t = String(text || '').toLowerCase();
  const wantsSocial = /(video|youtube|twitter|x\.com|linkedin|facebook|tiktok|reddit)/i.test(t);
  if (wantsSocial) return results;
  const banned = ['twitter.com','x.com','linkedin.com','facebook.com','youtube.com','youtu.be','tiktok.com','reddit.com'];
  return results.filter(r => {
    try { const h = new URL(r.url).hostname; return !banned.some(d => h.endsWith(d)); } catch { return false; }
  });
}

// Filtra hosts y rutas irrelevantes/conocidas por ruido
function filterBadHosts(results, text) {
  const t = String(text || '').toLowerCase();
  const keepHfMeta = /(meta|llama)\b/.test(t);
  return results.filter(r => {
    try {
      const u = new URL(r.url);
      const host = u.hostname;
      const path = u.pathname || '';
      // Eliminar Hugging Face Spaces salvo que sea la organización meta-llama
      if (host.endsWith('huggingface.co')) {
        if (/^\/spaces\//i.test(path)) return false;
        if (keepHfMeta) {
          if (!/^\/(meta-llama|facebookresearch)\//i.test(path)) return false;
        }
      }
      // Quitar blogs aleatorios no técnicos conocidos por ruido
      if (host.endsWith('apidog.com')) return false;
      if (host.endsWith('athento.com')) return false;
      if (host.includes('megaton')) return false;
      return true;
    } catch { return false; }
  });
}

// Extraer tokens clave de la consulta para medir relevancia
function extractCoreTokens(text) {
  const raw = String(text || '');
  const quoted = raw.match(/["“”«»'‘’](.+?)["“”«»'‘’]/);
  const base = (quoted && quoted[1]) ? quoted[1] : raw;
  const stop = new Set(['en','la','el','de','del','y','o','a','que','con','para','por','las','los','una','un','solo','sólo','urls','enlaces','links','release','notes']);
  return base
    .toLowerCase()
    .replace(/[^a-z0-9\.\-\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w && w.length > 2 && !stop.has(w));
}

function filterByRelevance(results, tokens) {
  if (!Array.isArray(results) || results.length === 0) return [];
  const tok = Array.isArray(tokens) ? tokens : [];
  function rel(r) {
    const hay = `${r.name || ''} ${r.snippet || ''}`.toLowerCase();
    let s = 0;
    for (const t of tok) { if (hay.includes(t)) s += 1; }
    if (/\b\d+\.\d+\b/.test(r.name || '')) s += 1;
    return s;
  }
  const scored = results.map(r => ({ r, s: rel(r) }));
  const min = tok.length >= 2 ? 2 : 1;
  const filtered = scored.filter(x => x.s >= min).sort((a, b) => b.s - a.s).map(x => x.r);
  return filtered; // si queda vacío, forzará reintento estricto
}

// Extrae el tema principal (tokens) con heurísticas
function extractPrimaryTopicTokens(text) {
  const raw = String(text || '');
  const tokens = new Set();
  // 1) Frases entre comillas
  const quoted = raw.match(/["“”«»'‘’]([^"“”«»'‘’]+)["“”«»'‘’]/);
  if (quoted && quoted[1]) {
    quoted[1].split(/\s+/).forEach(w => { if (w.length > 2) tokens.add(w.toLowerCase()); });
  }
  // 2) Marcas conocidas
  const brands = ['llama','meta','openai','google','microsoft','anthropic'];
  for (const b of brands) if (new RegExp(`\\b${b}\\b`, 'i').test(raw)) tokens.add(b);
  // 3) Versiones tipo 3.2, 2.1.1
  const ver = raw.match(/\b\d+(?:\.\d+){1,2}\b/);
  if (ver) tokens.add(ver[0]);
  // 4) Palabras del núcleo del query limpio
  const core = buildWebQueryFromText(raw).toLowerCase().replace(/[^a-z0-9\.\-\s]/g,' ').split(/\s+/);
  const stop = new Set(['release','notes','latest','ultimas','últimas','news','update','updates']);
  core.forEach(w => { if (w && w.length > 2 && !stop.has(w)) tokens.add(w); });
  return Array.from(tokens);
}

function refineQueryWithTopic(q, topicTokens) {
  const toks = Array.isArray(topicTokens) ? topicTokens : [];
  if (toks.length === 0) return q;
  const main = toks.slice(0, 3).join(' ');
  return `${q} intitle:"${main}" allintext:${toks.join(' ')}`;
}

// Detección de consultas tipo ranking + año (e.g., "ranking 2024 mejores ...")
function isRankingQuery(text) {
  const t = String(text || '').toLowerCase();
  const hasYear = /(20\d{2})/.test(t);
  const hasRanking = /(ranking|mejores|top|best)/i.test(t);
  return hasYear && hasRanking;
}

// Verifica si el último mensaje del asistente pidió explícitamente confirmación
function didLastAssistantAskForConfirmation(historial) {
  try {
    if (!Array.isArray(historial) || historial.length === 0) return false;
    for (let i = historial.length - 1; i >= 0; i--) {
      const m = historial[i];
      const role = String(m && m.role || '').toLowerCase();
      if (role === 'assistant' || role === 'bot') {
        const txt = String(m.content || '').toLowerCase();
        // Patrones típicos que usamos en confirmaciones
        const confirmRe = /(¿\s*(confirmas|deseas|quieres)\b|responde\s+"?s[ií]"?|responde\s+si\b|responde\s+"?no"?|¿continu(o|ó)|¿procedo|¿lo\s+hago|¿descargo|¿agendo|¿programo)/i;
        if (confirmRe.test(txt)) return true;
        return false;
      }
    }
  } catch {}
  return false;
}

// ¿El texto es una confirmación breve (sí/no/ok)?
function isBareConfirmation(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  const yes = /^(si|sí|sip|ok|dale|hazlo|confirmo|claro|de\s*acuerdo)\b/.test(t);
  const no = /^(no|cancel|cancela|nope|nah)\b/.test(t);
  // Evitar frases largas que solo empiezan con estas palabras
  const fewTokens = t.split(/\s+/).length <= 3;
  return (yes || no) && fewTokens;
}

// Extrae del historial la última consulta del usuario que parezca ser la verdadera búsqueda
function extractQueryFromHistory(historial) {
  try {
    if (!Array.isArray(historial) || historial.length === 0) return null;
    for (let i = historial.length - 1; i >= 0; i--) {
      const m = historial[i];
      const role = String(m && m.role || '').toLowerCase();
      if (role === 'user') {
        const c = String(m.content || '').trim();
        if (!c) continue;
        if (isBareConfirmation(c)) continue;
        if (c.length < 4) continue;
        return c;
      }
    }
  } catch {}
  return null;
}

function formatResultsForChat(results, query, desired) {
  const header = `Esto es lo que encontré para "${query}". Aquí tienes ${Math.min(results.length, desired)} enlace(s):`;
  // Evitar sufijos entre paréntesis al final (p.ej., "(NASA)") que confunden al copiar
  function cleanTitle(t) {
    const s = String(t || '').trim();
    // Solo quitar paréntesis finales completos al final de la cadena
    return s.replace(/\s*\([^()]{1,40}\)\s*$/,'').trim();
  }
  const body = results
    .slice(0, desired)
    .map((r, i) => `${i + 1}. ${cleanTitle(r.name || r.url)} — ${r.url}`)
    .join('\n');
  return `${header}\n\n${body}`;
}

// Función para detectar solicitudes de generación de imagen
function detectImageRequest(text) {
  // Filtro negativo: si la intención es ANALIZAR/LEER/EXPLICAR una imagen o documento,
  // no debemos disparar generación de imágenes, aunque el texto contenga la palabra "imagen".
  const analysisIntent = /(de\s+que\s+trata|de\s+qué\s+trata|que\s*dice|qué\s*dice|que\s*contiene|qué\s*contiene|analiza|analizar|lee|leer|descríbelo|describelo|describe|explica|interpreta|resumen|resúmelo|resumelo|qué\s*hay\s+en\s+la\s*imagen|esta\s+imagen[\s\S]*de\s+que\s+trata)/i;
  if (analysisIntent.test(text)) {
    return { shouldGenerate: false };
  }

  // Si viene marcado por el frontend con instrucciones de OCR, evitar generación de imágenes
  // para que el flujo responda con análisis en texto.
  if (/\[(INSTRUCCION|INDICACION)\]|analiza\s+el\s+texto\s+extra/i.test(text)) {
    return { shouldGenerate: false };
  }

  const imageKeywords = [
    // Patrones básicos de solicitud de imagen
    /\b(genera|generar|crea|crear|haz|hacer|dame|dibuja|dibujar|quiero)\b.*\b(imagen|foto|picture|dibujo|ilustración|ilustracion)\b/i,

    // Patrones específicos de imagen
    /\b(imagen|foto|picture|dibujo|ilustración|ilustracion)\s+(de|del|sobre|con)\b/i,

    // Patrones de "una imagen de..."
    /\buna\s+(imagen|foto|picture|dibujo|ilustración|ilustracion)\s+(de|del|sobre|con)\b/i,

    // Patrones visuales
    /\b(visual|gráfico|grafico|arte|artwork|painting|pintura)\b.*\b(de|del|sobre|con)\b/i,

    // Patrones directos
    /\b(imagina|visualiza|representa)\b.*\ben\s*(imagen|foto|dibujo)\b/i,

    // Patrones de solicitud + descripción visual
    /\b(quiero ver|muéstrame|enséñame|enseñame)\b.*\b(como|cómo|imagen|foto)\b/i,

    // Patrones conversacionales mejorados
    /\b(ahora|también|luego)\s+(puedes|podrías|me\s+puedes)\s+(dar|generar|crear|hacer)\b.*\b(imagen|foto|dibujo)\b/i,
    /\b(me\s+puedes|puedes)\s+(generar|crear|hacer|dar)\b.*\b(imagen|foto|dibujo)\b/i,
    /\b(generando|creando|haciendo)\s+(un|una)\s+\w+/i, // "generando un perrito..."

    // Patrones de descripción directa (cuando describe lo que quiere sin mencionar "imagen")
    /\b(un|una)\s+(perro|perrito|gato|gatito|animal|persona|casa|paisaje|objeto)\s+(de|con|que|gordito|pequeño|grande|bonito|lindo)\b/i,
    /\b(perro|perrito|gato|gatito|animal|persona|mascota)\s+(gordito|pequeño|grande|bonito|lindo|peludo|negro|blanco|café|gris)\b/i,

    // Patrones de contexto visual (cuando mencionan características visuales)
    /\b(pelaje|pelo|color|textura|ojos|orejas)\s+(corto|largo|negro|blanco|café|gris|azul|verde)\b/i,
    /\b(sosteniendo|con|que\s+tiene)\s+(un|una)\s+(cartel|letrero|papel|objeto)\b/i
  ];

  for (const pattern of imageKeywords) {
    const match = text.match(pattern);
    if (match) {
      // Extraer el prompt limpio para la imagen
      let prompt = text;

      // Limpiar palabras de comando para obtener solo la descripción
      prompt = prompt
        .replace(/\b(genera|generar|crea|crear|haz|hacer|dame|dibuja|dibujar|quiero|puedes|podr[ií]as)\b/gi, ' ')
        .replace(/\b(imagen|foto|picture|dibujo|ilustración|ilustracion)\b/gi, ' ')
        .replace(/\b(de|del|sobre|con|en|a|al|para|y|e)\b/gi, ' ')
        .replace(/\b(un|una|el|la|los|las|mi|mis|tu|tus|su|sus)\b/gi, ' ')
        .replace(/\b(sub[ie]r|s[uú]belo|subelo|subirlo|subirla|subirlos|subirlas)\b/gi, ' ')
        .replace(/\b(google\s+)?drive\b/gi, ' ')
        .replace(/\s+/g, ' ').trim();

      // Si el prompt está muy vacío, usar el texto original
      if (prompt.length < 10) {
        prompt = text;
      }

      // Generar nombre de archivo basado en el prompt (excluyendo palabras de comando)
      let filename = 'imagen_skanea';
      if (prompt.length > 0) {
        // Palabras que no deben aparecer en el nombre del archivo
        const stopWords = ['generame', 'generarme', 'generar', 'crear', 'crearme', 'creando', 'haciendo', 'escribiendo', 'redactando', 'redactado', 'redactame', 'haz', 'escribe', 'redacta', 'genera', 'creado', 'creada', 'creados', 'creadas', 'crearme', 'dame', 'hazme', 'hacerme', 'escribeme', 'escribeme', 'escribir', 'escribirme', 'hacer', 'archivo', 'documento', 'texto', 'sobre', 'acerca', 'del', 'de', 'la', 'el', 'un', 'una', 'por', 'para', 'con', 'en', 'que', 'me', 'te', 'se', 'le', 'nos', 'les', 'quiero', 'necesito', 'puedes', 'podes', 'los', 'las', 'desde', 'hasta', 'entre', 'y', 'o', 'pero'];

        const tokens = prompt.toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w && w.length > 2 && !/^\d+$/.test(w) && !stopWords.includes(w))
          .slice(0, 4);
        if (tokens.length > 0) {
          filename = tokens.join('_');
        }
      }

      return {
        shouldGenerate: true,
        prompt: prompt,
        filename: filename,
        originalText: text
      };
    }
  }

  return { shouldGenerate: false };
}

// Detección de intención para conectores (primer MVP sin ejecución)
function detectConnectorIntent(text) {
  if (!text || typeof text !== 'string') return { matched: false };
  const t = text.toLowerCase();
  // Gmail - buscar
  const gmailSearchRe = /(busca|buscar|encuentra|encontrar)\s+(en\s+mi\s+)?gmail\b/;
  if (gmailSearchRe.test(t)) {
    const fromMatch = t.match(/de\s+([a-záéíóúñ0-9_.+-]+@[^\s]+|[a-záéíóúñ]+)\b/);
    const hasPdf = /(pdfs?|adjuntos?\s+pdfs?)/.test(t);
    const hasAttach = /(adjunto|adjuntos)/.test(t) || hasPdf;
    const timeMatch = t.match(/(esta\s+semana|hoy|ayer|anteayer|mañana|el\s+lunes|el\s+martes|el\s+miércoles|el\s+jueves|el\s+viernes|el\s+sábado|el\s+domingo|de\s+esta\s+semana|de\s+la\s+semana\s+pasada)/);
    const params = {
      provider: 'gmail',
      intent: 'email.search',
      from: fromMatch ? fromMatch[1] : null,
      hasAttachments: hasAttach,
      attachmentType: hasPdf ? 'pdf' : null,
      timeRange: timeMatch ? timeMatch[1] : null
    };
    const pieces = [];
    if (params.from) pieces.push(`remitente: ${params.from}`);
    if (params.attachmentType) pieces.push(`adjunto: ${params.attachmentType}`);
    if (params.timeRange) pieces.push(`rango: ${params.timeRange}`);
    const summary = pieces.length > 0 ? pieces.join(', ') : 'sin filtros adicionales';
    return {
      matched: true,
      needsConfirmation: true,
      intent: 'email.search',
      params,
      confirmMessage: `Entendido. Puedo buscar en tu Gmail (${summary}). ¿Deseas que lo haga ahora? Responde "sí" para continuar o "no" para cancelar.`
    };
  }

  // Gmail - enviar
  const gmailSendRe = /(envía|enviar|manda|mandar|redacta|redactar)\s+(un\s+)?(correo|email)\b/;
  if (gmailSendRe.test(t)) {
    const toMatch = t.match(/a\s+([a-z0-9_.+-]+@[^\s,;]+)/);
    const ccMatch = t.match(/cc\s+a\s+([a-z0-9_.+-]+@[^\s,;]+)/);
    const subjectMatch = t.match(/asunto\s+["'“”']([^"'“”']+)["'“”']/);
    const quotedBody = t.match(/'(.*?)'|"(.*?)"/);
    const body = subjectMatch ? t.replace(subjectMatch[0], '') : (quotedBody ? (quotedBody[1] || quotedBody[2]) : null);
    const params = {
      provider: 'gmail',
      intent: 'email.send',
      to: toMatch ? toMatch[1] : null,
      cc: ccMatch ? ccMatch[1] : null,
      subject: subjectMatch ? subjectMatch[1] : null,
      body: body
    };
    const confirmFields = [];
    if (params.to) confirmFields.push(`para: ${params.to}`);
    if (params.cc) confirmFields.push(`cc: ${params.cc}`);
    if (params.subject) confirmFields.push(`asunto: ${params.subject}`);
    return {
      matched: true,
      needsConfirmation: true,
      intent: 'email.send',
      params,
      confirmMessage: `Voy a preparar un correo${confirmFields.length ? ` (${confirmFields.join(', ')})` : ''}. ¿Confirmas el envío? Responde "sí" y lo enviaré; responde "solo borrador" para dejarlo listo sin enviar.`
    };
  }

  // Calendar - crear
  const calCreateRe = /(crea|crear)\s+(un\s+)?evento\b|agénd(a|alo|ar)/;
  if (calCreateRe.test(t)) {
    // Título: comillas o frases "que se llame X", "llamado X", "título X"
    const quotedTitle = t.match(/["'“”]([^"'“”]+)["'“”]/);
    const namePhrase1 = t.match(/se\s+llame\s+([a-z0-9áéíóúñ\s]+?)(?:\s+y\s+|\s*,|$)/i);
    const namePhrase2 = t.match(/llamado\s+([a-z0-9áéíóúñ\s]+?)(?:\s+y\s+|\s*,|$)/i);
    const namePhrase3 = t.match(/t[íi]tulo\s+(?:de\s+)?([a-z0-9áéíóúñ\s]+?)(?:\s+y\s+|\s*,|$)/i);
    let titleCandidate = (quotedTitle && quotedTitle[1]) || (namePhrase1 && namePhrase1[1]) || (namePhrase2 && namePhrase2[1]) || (namePhrase3 && namePhrase3[1]) || null;
    if (titleCandidate) titleCandidate = titleCandidate.trim();

    // Extraer fecha base (soporta "del" y "de") y hora suelta
    const timeMatch = t.match(/(hoy|mañana|pasado\s+mañana|\d{1,2}\s*(am|pm)|\d{1,2}:\d{2}|\d{1,2}\s+de\s+[a-záéíóúñ]+\s+(?:de\s+|del\s+)?\d{4})/);
    const dateOnlyRe = /(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+(?:de\s+|del\s+)?(\d{4})/i;
    const months = { enero:0,febrero:1,marzo:2,abril:3,mayo:4,junio:5,julio:6,agosto:7,septiembre:8,setiembre:8,octubre:9,noviembre:10,diciembre:11 };
    const dm = t.match(dateOnlyRe);
    let whenBase = null;
    if (dm) {
      const day = parseInt(dm[1], 10);
      const mk = dm[2].toLowerCase().replace(/á/g,'a').replace(/é/g,'e').replace(/í/g,'i').replace(/ó/g,'o').replace(/ú/g,'u').replace(/ñ/g,'n');
      const m = months[mk];
      const year = parseInt(dm[3], 10);
      if (m !== undefined) {
        const pad = (n)=>String(n).padStart(2,'0');
        whenBase = `${year}-${pad(m+1)}-${pad(day)}`;
      }
    } else if (/\bhoy\b/i.test(t)) {
      const d = new Date(); const pad = (n)=>String(n).padStart(2,'0');
      whenBase = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    } else if (/\bmañana\b/i.test(t)) {
      const d = new Date(); const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate()+1); const pad = (n)=>String(n).padStart(2,'0');
      whenBase = `${dd.getFullYear()}-${pad(dd.getMonth()+1)}-${pad(dd.getDate())}`;
    }
    const people = [...t.matchAll(/[a-z0-9_.+-]+@[^\s,;]+/g)].map(m => m[0]);
    const params = {
      provider: 'gcalendar',
      intent: 'calendar.create',
      title: titleCandidate || 'Evento',
      when: timeMatch ? timeMatch[1] : null,
      whenBase: whenBase,
      attendees: people
    };
    const hasHour = /(\d{1,2})(?::\d{2})?\s*(am|pm)/i.test(t);
    const confirm = hasHour
      ? `Crearé un evento "${params.title}"${params.when ? ` (${params.when})` : ''}${params.attendees && params.attendees.length ? ` con ${params.attendees.join(', ')}` : ''}. ¿Confirmas?`
      : `Crearé un evento "${params.title}"${whenBase ? ` (${whenBase})` : (params.when ? ` (${params.when})` : '')}. ¿Es todo el día o a qué hora (HH:mm)?`;
    return {
      matched: true,
      needsConfirmation: true,
      intent: 'calendar.create',
      params,
      confirmMessage: confirm
    };
  }

  // Calendar - listar
  const calListRe = /(lista|listar|muestra|mostrar|ver)\s+(mis\s+)?eventos\b/;
  if (calListRe.test(t)) {
    const range = t.match(/(hoy|mañana|esta\s+semana|viernes|lunes|martes|miércoles|jueves|sábado|domingo|\d{1,2}:\d{2}\s*(a|hasta)\s*\d{1,2}:\d{2})/);
    return {
      matched: true,
      needsConfirmation: false,
      intent: 'calendar.list',
      params: { provider: 'gcalendar', range: range ? range[1] : null },
      confirmMessage: `Puedo listar tus eventos${range ? ` para ${range[1]}` : ''}. ¿Deseas que lo haga?`
    };
  }

  // Drive - listar archivos (evitar dispararlo si el usuario dice "sí"/"hazlo" o está pidiendo cálculo/columna)
  const driveListRe = /(lista|listar|muestra|mostrar|ver|cu[aá]les?\s+(son|hay)|qu[eé]\s+archivos|dame|dime|decirme|cu[aá]ntos)\s+(?:son\s+)?(?:los\s+)?(?:mis\s+)?archivos\s+(?:recientes?\s+)?(?:en\s+)?(?:de\s+)?(?:mi\s+)?drive\b/;
  if (driveListRe.test(t)) {
    // Si el mensaje es de confirmación o instrucción de análisis, no activar lista
    if (/^(s[ií]|ok|dale|hazlo|continu[aá])\b/.test(t) || /(media|promedio|columna|nota|calcula)/i.test(t)) {
      return { matched: false };
    }
    return {
      matched: true,
      needsConfirmation: true,
      intent: 'drive.list',
      params: { limit: 10 },
      confirmMessage: '¿Listo para listar tus 10 archivos más recientes en Google Drive?'
    };
  }

  // Drive - buscar por tipo/mime (pdf/docx/pptx/xlsx/csv/imágenes)
  const driveSearchTypeRe = /(busca|buscar|encuentra|encontrar)\s+(archivos?|documentos?)\s+(?:de\s+)?([a-záéíóúñ\s]+)\s+(en|de|del)\s+(mi\s+)?drive\b/;
  const driveTypeMap = {
    'pdf': 'application/pdf',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'word': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'powerpoint': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'presentacion': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'presentación': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'excel': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'csv': 'text/csv',
    'txt': 'text/plain',
    'texto': 'text/plain',
    'imagenes': 'image/',
    'imágenes': 'image/',
    'imagen': 'image/'
  };
  const mType = t.match(driveSearchTypeRe);
  if (mType) {
    const key = (mType[3] || '').toLowerCase().trim().replace(/\s+/g,' ');
    const mime = driveTypeMap[key] || null;
    return {
      matched: true,
      needsConfirmation: true,
      intent: 'drive.search',
      params: { mime, label: key, limit: 10 },
      confirmMessage: `¿Busco en tu Drive archivos ${key} recientes?`
    };
  }

  // Drive - listar contenido de una carpeta por nombre
  const driveFolderContentRe = /(contenido|lista|listar|muestra|mostrar|ver)\s+(de\s+)?la\s+carpeta\s+["'“”‘’]([^"'“”‘’]+)["'“”‘’]\s+(en|de|del)\s+(mi\s+)?drive\b/i;
  const mFolder = t.match(driveFolderContentRe);
  if (mFolder) {
    const folderName = (mFolder[3] || '').trim();
    return {
      matched: true,
      needsConfirmation: true,
      intent: 'drive.folder_list',
      params: { name: folderName, limit: 50 },
      confirmMessage: `¿Listo para listar el contenido de la carpeta "${folderName}" en tu Google Drive?`
    };
  }

  // Drive - buscar por nombre (evitar conflicto con "crear carpeta/archivo")
  const driveSearchNameQuoted = /["'“”‘’]([^"'“”‘’]+)["'“”‘’][\s\S]*?(en|de|del)\s+(mi\s+)?drive\b/;
  // APLICAR RESTRICCIÓN: solo disparar si dicen "archivo llamado X" O si X tiene extensión conocida
  const driveSearchNamePlain = /archivo\s+(?:llamado\s+([a-z0-9_\-\.\s]+)|([a-z0-9_\-\.]+\.(?:txt|csv|xlsx|pdf|docx|pptx)))\s+(?:en|de|del)\s+(mi\s+)?drive\b/i;
  let mNameQ = t.match(driveSearchNameQuoted);
  let mNameP = t.match(driveSearchNamePlain);
  if (mNameQ || mNameP) {
    // Si el usuario habla de crear carpeta/archivo, no dispares búsqueda
    if (!/(crea|crear)\s+(una\s+)?carpeta\b/i.test(t) && !/(crea|crear|genera|generar|haz|hacer)\b[\s\S]*\barchivo\b/i.test(t) && !(/\bcarpeta\b/i.test(t) && /(contenido|lista|listar|muestra|mostrar|ver)\b/i.test(t))) {
      const fname = (mNameQ ? mNameQ[1] : mNameP[1] || '').trim();
      const analyzeVerb = /(saca|calcula|calcular|obt[ée]n|obten|analiza|analizar|lee|leer|extrae|extraer|resume|resumen|promedio|media|maxim(?:o|a)|m[íi]nim(?:o|a)|minim(?:o|a)|trata|contenido|contiene)/i;
      if (!analyzeVerb.test(t)) {
        return {
          matched: true,
          needsConfirmation: true,
          intent: 'drive.search_name',
          params: { filename: fname, limit: 10 },
          confirmMessage: `¿Busco en tu Drive archivos llamados "${fname}"?`
        };
      }
    }
  }

  // Drive - crear archivo de texto
  const driveCreateRe = /(crea|crear)\s+(un\s+)?(archivo|documento|fichero)\s+(en\s+)?(mi\s+)?drive\b/;
  if (driveCreateRe.test(t)) {
    const quoted = t.match(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/);
    const namePhrase = t.match(/(que\s+se\s+llame|llamado|nombre)\s+([a-z0-9áéíóúñ\s\.\-_]+)/i);
    const name = quoted ? quoted[1] : (namePhrase ? namePhrase[2].trim() : null);
    const folderQuoted = t.match(/en\s+la\s+carpeta\s+["'“”‘’]([^"'“”‘’]+)["'“”‘’]/);
    const folderPlain = t.match(/en\s+la\s+carpeta\s+([a-z0-9áéíóúñ\s\.\-_]+)/i);
    const folder = folderQuoted ? folderQuoted[1].trim() : (folderPlain ? folderPlain[1].trim() : null);
    const contentMatch = [...t.matchAll(/["'“”]([^"'“”]+)["'“”]/g)];
    const content = contentMatch && contentMatch.length > 1 ? contentMatch[1][1] : null;
    return {
      matched: true,
      needsConfirmation: true,
      intent: 'drive.create',
      params: { name: name || 'archivo_skanea.txt', content: content || null, folder: folder || null },
      confirmMessage: `Voy a crear ${name ? `el archivo "${name}"` : 'un archivo de texto'}${folder ? ` en la carpeta "${folder}"` : ''} en tu Google Drive.${content ? ' Con contenido incluido.' : ''} ¿Confirmas?`
    };
  }

  // Drive - crear carpeta
  const driveCreateFolderRe = /(crea|crear)\s+(una\s+)?carpeta\b/;
  if (driveCreateFolderRe.test(t)) {
    const quoted = t.match(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/);
    const namePhrase = t.match(/carpeta\s+(llamada\s+|que\s+se\s+llame\s+)?([a-z0-9áéíóúñ\s\.\-_]+)/i);
    const name = quoted ? quoted[1].trim() : (namePhrase ? namePhrase[2].trim() : null);
    const parentQuoted = t.match(/(en|dentro\s+de)\s+la\s+carpeta\s+["'“”‘’]([^"'“”‘’]+)["'“”‘’]/i);
    const parentPlain = t.match(/(en|dentro\s+de)\s+la\s+carpeta\s+([a-z0-9áéíóúñ\s\.\-_]+)/i);
    const parent = parentQuoted ? parentQuoted[2].trim() : (parentPlain ? parentPlain[2].trim() : null);
    // Detectar si también piden un archivo y contenido en la misma frase
    const contentMatches = [...t.matchAll(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/g)].map(m => m[1]);
    let postFile = null;
    if (/\barchivo\b/i.test(t)) {
      const content = contentMatches.length >= 2 ? contentMatches[1] : null;
      postFile = { name: 'archivo_skanea.txt', content };
    }
    return {
      matched: true,
      needsConfirmation: true,
      intent: 'drive.create_folder',
      params: { name: name || 'carpeta_skanea', parent: parent || null, postFile },
      confirmMessage: `Voy a crear la carpeta ${name ? `"${name}"` : '"carpeta_skanea"'}${parent ? ` dentro de "${parent}"` : ''} en tu Google Drive${postFile ? ' y luego crearé un archivo TXT dentro' : ''}. ¿Confirmas?`
    };
  }

  // Drive - analizar/leer archivo por nombre y operar (promedio, etc.)
  const driveAnalyzeCtx = /(en\s+mi\s+drive|en\s+drive|de\s+mi\s+drive|del\s+drive)\b/;
  const driveAnalyzeVerb = /(saca|calcula|calcular|obtén|obten|analiza|analizar|lee|leer|extrae|extraer|resume|resumen|promedio|media|maxim(o|a)|mínim(o|a)|minim(o|a)|trata|contenido|contiene)/;
  if (driveAnalyzeCtx.test(t) && driveAnalyzeVerb.test(t)) {
    const quoted = t.match(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/);
    // Requiere comillas para identificar el nombre del archivo
    const fname = quoted ? quoted[1].trim() : null;
    const folderQuoted = t.match(/en\s+la\s+carpeta\s+["'“”‘’]([^"'“”‘’]+)["'“”‘’]/);
    const folderPlain = t.match(/en\s+la\s+carpeta\s+([a-z0-9áéíóúñ\s\.\-_]+)/i);
    const folder = folderQuoted ? folderQuoted[1].trim() : (folderPlain ? folderPlain[1].trim() : null);
    const askedAvg = /(promedio|media)\b/i.test(text);
    return {
      matched: true,
      needsConfirmation: fname ? false : true,
      intent: 'drive.analyze',
      params: { filename: fname || null, doAverage: askedAvg === true, folder: folder || null },
      confirmMessage: fname
        ? (askedAvg
            ? `¿Calculo el promedio a partir de "${fname}"${folder ? ` en la carpeta "${folder}"` : ''} en tu Drive?`
            : `¿Leo "${fname}"${folder ? ` en la carpeta "${folder}"` : ''} en tu Drive y te cuento de qué trata?`)
        : 'No pude identificar el nombre exacto del archivo en tu Drive. Por favor envía el nombre entre comillas, por ejemplo: "mi_archivo.docx"'
    };
  }

  // Evitar que un "sí hazlo" genérico dispare drive.list si venimos de analyze/choose
  if (/^\s*(s[ií]|dale|hazlo|ok|de\s+acuerdo)\b/.test(t)) {
    return { matched: false };
  }

  // Confirmación adicional cuando detectemos fecha sin hora
  if (calCreateRe.test(t)) {
    const hasHour = /(\d{1,2})(?::\d{2})?\s*(am|pm)/i.test(t);
    const hasDate = /\d{1,2}\s+de\s+[a-záéíóúñ]+\s+(?:de\s+|del\s+)?\d{4}/i.test(t);
    if (hasDate && !hasHour) {
      return {
        matched: true,
        needsConfirmation: true,
        intent: 'calendar.create',
        params: { askTime: true },
        confirmMessage: '¿El evento es de todo el día o a qué hora quieres que inicie?'
      };
    }
  }

  // WhatsApp - enviar
  const waRe = /(whatsapp|wsp)\b.*(manda|enviar|envía|enviale|envíale)\b|manda\b.*\bwhatsapp/;
  if (waRe.test(t)) {
    const to = t.match(/\+?\d{7,15}/);
    const quoted = t.match(/'(.*?)'|"(.*?)"/);
    const text = quoted ? (quoted[1] || quoted[2]) : null;
    return {
      matched: true,
      needsConfirmation: true,
      intent: 'whatsapp.send',
      params: { to: to ? to[0] : null, text },
      confirmMessage: `Enviaré por WhatsApp${to ? ` a ${to[0]}` : ''}${text ? `: "${text}"` : ''}. ¿Confirmas?`
    };
  }

  // Instagram - post
  const igRe = /(publica|publicar|sube|subir)\s+(en\s+)?instagram\b/;
  if (igRe.test(t)) {
    const url = text.match(/https?:[^\s]+/i);
    const captionMatch = t.match(/caption\s+["'“”]([^"'“”]+)["'“”]|['"]([^'"“”]+)['"]/);
    const caption = captionMatch ? (captionMatch[1] || captionMatch[2]) : null;
    return {
      matched: true,
      needsConfirmation: true,
      intent: 'instagram.post',
      params: { image_url: url ? url[0] : null, caption },
      confirmMessage: `Publicaré en Instagram${caption ? ` con el caption "${caption}"` : ''}${url ? ` la imagen ${url[0]}` : ''}. ¿Confirmas?`
    };
  }

  return { matched: false };
}

// Utilidad robusta para parsear fechas/horas en español → rango
function parseWhenToDateRange(whenStr) {
  if (!whenStr || typeof whenStr !== 'string') return null;
  const DEFAULT_EVENT_MINUTES = parseInt(process.env.DEFAULT_EVENT_MINUTES || '60', 10);
  const sRaw = whenStr.trim();
  const s = sRaw.toLowerCase();
  const now = new Date();
  const months = {
    'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4, 'junio': 5,
    'julio': 6, 'agosto': 7, 'septiembre': 8, 'setiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11
  };

  const pad = (n) => String(n).padStart(2, '0');
  const fmtLocal = (y, m, d, hh, mm) => `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00`;

  const containsAllDay = /(todo\s+el\s+d[ií]a)/i.test(sRaw);

  // Hoy / Mañana / Pasado mañana (con y sin hora)
  if (/^hoy\b/.test(s)) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Detectar hora si viene ("hoy 15:00" o "hoy 3pm")
    const timeMatch = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    if (!timeMatch || containsAllDay) {
      const start = `${day.getFullYear()}-${pad(day.getMonth()+1)}-${pad(day.getDate())}`;
      const endD = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
      const end = `${endD.getFullYear()}-${pad(endD.getMonth()+1)}-${pad(endD.getDate())}`;
    return { allDay: true, startDate: start, endDate: end };
  }
    let hh = parseInt(timeMatch[1], 10);
    const mm = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3] ? timeMatch[3].toLowerCase() : null;
    if (ampm) { if (ampm === 'pm' && hh < 12) hh += 12; if (ampm === 'am' && hh === 12) hh = 0; }
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    const startLocal = fmtLocal(day.getFullYear(), day.getMonth()+1, day.getDate(), hh, mm);
    const endDate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm + DEFAULT_EVENT_MINUTES);
    const endLocal = fmtLocal(endDate.getFullYear(), endDate.getMonth()+1, endDate.getDate(), endDate.getHours(), endDate.getMinutes());
    return { allDay: false, startDateTime: startLocal, endDateTime: endLocal };
  }

  if (/^mañana\b/.test(s)) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timeMatch = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    if (!timeMatch || containsAllDay) {
      const start = `${day.getFullYear()}-${pad(day.getMonth()+1)}-${pad(day.getDate())}`;
      const endD = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
      const end = `${endD.getFullYear()}-${pad(endD.getMonth()+1)}-${pad(endD.getDate())}`;
    return { allDay: true, startDate: start, endDate: end };
    }
    let hh = parseInt(timeMatch[1], 10);
    const mm = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3] ? timeMatch[3].toLowerCase() : null;
    if (ampm) { if (ampm === 'pm' && hh < 12) hh += 12; if (ampm === 'am' && hh === 12) hh = 0; }
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    const startLocal = fmtLocal(day.getFullYear(), day.getMonth()+1, day.getDate(), hh, mm);
    const endDate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm + DEFAULT_EVENT_MINUTES);
    const endLocal = fmtLocal(endDate.getFullYear(), endDate.getMonth()+1, endDate.getDate(), endDate.getHours(), endDate.getMinutes());
    return { allDay: false, startDateTime: startLocal, endDateTime: endLocal };
  }

  // Formato ISO local: YYYY-MM-DD [HH:mm]
  const isoRe = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2})(?::(\d{2}))?)?$/;
  const iso = s.match(isoRe);
  if (iso) {
    const year = parseInt(iso[1], 10);
    const month = parseInt(iso[2], 10) - 1;
    const day = parseInt(iso[3], 10);
    const hasTime = typeof iso[4] !== 'undefined';
    if (!hasTime) {
      const pad = (n) => String(n).padStart(2, '0');
      const start = `${year}-${pad(month+1)}-${pad(day)}`;
      const endD = new Date(year, month, day + 1);
      const end = `${endD.getFullYear()}-${pad(endD.getMonth()+1)}-${pad(endD.getDate())}`;
      return { allDay: true, startDate: start, endDate: end };
    }
    let hour = parseInt(iso[4] || '0', 10);
    let minute = parseInt(iso[5] || '0', 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    const pad = (n) => String(n).padStart(2, '0');
    const startLocal = `${year}-${pad(month+1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;
    const endDate = new Date(year, month, day, hour, minute + DEFAULT_EVENT_MINUTES);
    const endLocal = `${endDate.getFullYear()}-${pad(endDate.getMonth()+1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00`;
    return { allDay: false, startDateTime: startLocal, endDateTime: endLocal };
  }

  // Ej: 31 de agosto del 2025 [opcional hora 3pm | 15:00] [opcional "todo el día"]
  const dateRe = /(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+(?:de\s+|del\s+)?(\d{4})(?:[^0-9a-z]+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i;
  const m = s.match(dateRe);
  if (m) {
    const day = parseInt(m[1], 10);
    const monthKey = m[2]
      .toLowerCase()
      .replace(/á/g, 'a')
      .replace(/é/g, 'e')
      .replace(/í/g, 'i')
      .replace(/ó/g, 'o')
      .replace(/ú/g, 'u')
      .replace(/ñ/g, 'n');
    const month = months[monthKey];
    if (month === undefined) return null;
    const year = parseInt(m[3], 10);
    let hour = m[4] ? parseInt(m[4], 10) : null;
    const minute = m[5] ? parseInt(m[5], 10) : 0;
    const ampm = m[6] ? m[6].toLowerCase() : null;
    if (hour !== null && ampm) {
      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
    }
    if (containsAllDay || hour === null) {
      const start = `${year}-${pad(month+1)}-${pad(day)}`;
      const endD = new Date(year, month, day + 1);
      const end = `${endD.getFullYear()}-${pad(endD.getMonth()+1)}-${pad(endD.getDate())}`;
      return { allDay: true, startDate: start, endDate: end };
    }
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    const startLocal = fmtLocal(year, month+1, day, hour, minute);
    const endDate = new Date(year, month, day, hour, minute + DEFAULT_EVENT_MINUTES);
    const endLocal = fmtLocal(endDate.getFullYear(), endDate.getMonth()+1, endDate.getDate(), endDate.getHours(), endDate.getMinutes());
    return { allDay: false, startDateTime: startLocal, endDateTime: endLocal };
  }

  // Hora simple "18:00" o "6 pm" sin fecha → hoy
  const timeOnly = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (timeOnly) {
    let hour = parseInt(timeOnly[1], 10);
    const minute = timeOnly[2] ? parseInt(timeOnly[2], 10) : 0;
    const ampm = timeOnly[3] ? timeOnly[3].toLowerCase() : null;
    if (ampm) { if (ampm === 'pm' && hour < 12) hour += 12; if (ampm === 'am' && hour === 12) hour = 0; }
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    const startLocal = fmtLocal(now.getFullYear(), now.getMonth()+1, now.getDate(), hour, minute);
    const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute + DEFAULT_EVENT_MINUTES);
    const endLocal = fmtLocal(endDate.getFullYear(), endDate.getMonth()+1, endDate.getDate(), endDate.getHours(), endDate.getMinutes());
    return { allDay: false, startDateTime: startLocal, endDateTime: endLocal };
  }

  return null;
}

// Endpoint para preguntas a OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Cache simple por usuario para preservar el CONTENIDO y el PROMPT de exportaciones recientes
// lastExportByUser mantiene el último para compatibilidad; recentExportsByUser guarda hasta 10
// Estructura de cada item: { format, filename, filePath, content, ts, requestPrompt }
const lastExportByUser = new Map();
const recentExportsByUser = new Map();
// Memoria corta para el último análisis de Drive (para follow-ups del usuario)
// Estructura: { file: { id, name, mimeType }, mime: string, fullText: string, ts: number }
const lastDriveAnalyzeByUser = new Map();

function sanitizeForExport(raw, targetFormat) {
  try {
    if (!raw || typeof raw !== 'string') return raw || '';
    let s = raw;
    // Extraer primer bloque entre ``` si existe
    const fence = s.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
    if (fence && fence[1]) s = fence[1];
    // Quitar líneas de instrucciones o confirmaciones de UI
    const dropPatterns = [
      /instrucciones?\s+para\s+subir/i,
      /google\s*drive/i,
      /descarg(a|arlo|arla|arlos|arlas|ar)/i,
      /bot[óo]n/i,
      /he\s+creado\s+tu\s+archivo/i,
      /tamb[ií]en\s+lo\s+he\s+subido/i,
      /id:/i
    ];
    const lines = s.split(/\r?\n/).filter(line => !dropPatterns.some(re => re.test(line)));
    s = lines.join('\n').trim();
    if (/csv/i.test(String(targetFormat))) {
      // Si hay un bloque que parece CSV, aíslarlo (líneas con comas)
      const csvLines = s.split(/\r?\n/).filter(l => /,/.test(l) && /[a-zA-Z0-9]/.test(l));
      if (csvLines.length >= 2) return csvLines.join('\n');
    }
    return s;
  } catch { return raw || ''; }
}
// Cache simple para respuestas comunes (mejora velocidad)
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

app.post('/preguntar', async (req, res) => {
  const t0 = Date.now();
  const { pregunta, historial, conversationId } = req.body;
  const modelOverrideHeader = String(req.headers['x-model-override'] || '').trim();
  const preferLocalModel = modelOverrideHeader && !modelOverrideHeader.toLowerCase().startsWith('cloud:');

  // 🔍 Leer header de auto-save
  const autoSaveFiles = req.headers['x-auto-save-files'] === 'true';

  if (!pregunta) return res.status(400).send('Falta la pregunta');

  // Detectar intenciones de conectores ANTES del cache (Drive/Calendar/etc no deben cachearse)
  const connectorIntent = detectConnectorIntent(pregunta);
  const isConnectorRequest = connectorIntent && connectorIntent.matched;

  // Cache para preguntas simples sin historial (excluir peticiones de conectores)
  const isSimpleQuestion = !historial || historial.length === 0;
  const cacheKey = (isSimpleQuestion && !isConnectorRequest) ? pregunta.toLowerCase().trim() : null;

  if (cacheKey && responseCache.has(cacheKey)) {
    const cached = responseCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return res.json(cached.response);
    }
    responseCache.delete(cacheKey);
  }

  // Autenticación OPCIONAL: si traen Authorization, intentar decodificar
  let authUserId = null;
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (token) {
      const payload = jwt.verify(token, JWT_SECRET);
      authUserId = payload && payload.id ? payload.id : null;
    }
  } catch (_) {}

  // 0.a2 Si hay una acción pendiente de calendar.create y el usuario responde una hora o "todo el día",
  // ejecutar creando el evento con esa hora
  if (authUserId) {
    try {
      const dbmod = await import('./config/db.js');
      const pool = dbmod.default;
      const paRes = await pool.query(
        `SELECT * FROM pending_actions WHERE user_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`,
        [authUserId]
      );
      let action = paRes.rows.length > 0 ? paRes.rows[0] : null;
      // Soporte para mensajes editados: si llega una elección (número o nombre citado)
      // y no hay acción actual o no es del tipo correcto, intenta recuperar la
      // última pendiente de 'drive.analyze_choose'.
      const maybeChoiceEarly = /^\s*\d{1,2}\s*$/.test(String(pregunta||'').trim()) || /^(opcion|opción|numero|número)\s*\d{1,2}\s*$/i.test(String(pregunta||'').trim()) || /^(elige|elijo)\s*\d{1,2}\s*$/i.test(String(pregunta||'').trim()) || /^\s*["'“”‘’][^"'“”‘’]+["'“”‘’]\s*$/.test(String(pregunta||'').trim());
      if ((!action || action.intent !== 'drive.analyze_choose') && maybeChoiceEarly) {
        try {
          const alt = await pool.query(
            `SELECT * FROM pending_actions WHERE user_id=$1 AND status='pending' AND intent='drive.analyze_choose' ORDER BY created_at DESC LIMIT 1`,
            [authUserId]
          );
          if (alt.rows.length > 0) { action = alt.rows[0]; console.log('[Follow-up] recovered analyze_choose pending via edit:', action.id); }
        } catch {}
      }
      // Si el mensaje actual es claramente una exportación nueva, no consumas la acción pendiente
      try {
        const peek = detectExportRequest(String(pregunta || ''), historial);
        if (peek && peek.shouldExport) {
          action = null; // saltar manejo de pendientes; dejar que el flujo de exportación continúe abajo
        }
      } catch {}
      if (action) {
        console.log('[Follow-up] pending action found:', { id: action.id, intent: action.intent });
        // Follow-up: drive.analyze_choose → el usuario elige entre varias coincidencias
        if (action.intent === 'drive.analyze_choose') {
          const t = String(pregunta || '').trim();
          console.log('[Drive][choose-analyze] incoming choice message:', t);
          const p = typeof action.params === 'string' ? JSON.parse(action.params || '{}') : (action.params || {});
          const candidates = Array.isArray(p.candidates) ? p.candidates : [];
          console.log('[Drive][choose-analyze] candidates count:', candidates.length);
          if (candidates.length === 0) {
            await pool.query(`UPDATE pending_actions SET status='cancelled', updated_at=NOW() WHERE id=$1`, [action.id]);
            return res.json({ respuesta: 'No tengo candidatos guardados para elegir. Vuelve a pedir la lectura indicando el nombre.' });
          }
          let chosen = null;
          const mNum = t.match(/^\s*(?:opcion|opción|numero|número|elige|elijo)?\s*(\d{1,2})\s*$/i);
          if (mNum) {
            const idx = parseInt(mNum[1], 10) - 1;
            if (idx >= 0 && idx < candidates.length) chosen = candidates[idx];
          }
          if (!chosen) {
            const q = t.match(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/);
            const name = (q ? q[1] : t).trim().toLowerCase();
            chosen = candidates.find(c => String(c.name || '').toLowerCase() === name);
          }
          console.log('[Drive][choose-analyze] chosen:', chosen ? chosen.name : null);
          if (!chosen) {
            const list = candidates.map((f,i)=>`${i+1}. ${f.name} (${f.mimeType || 'desconocido'})`).join('\n');
            return res.json({ respuesta: `No entendí tu elección. Indícame el número del archivo:\n${list}` });
          }
          const conRes = await pool.query(
            `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
            [authUserId]
          );
          if (conRes.rows.length === 0) {
            return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
          }
          const conn = conRes.rows[0];
          let accessToken = null;
          try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
          const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
            ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
            : null;
          // Si el elegido es una carpeta, listar su contenido en lugar de descargar
          if (chosen.mimeType === 'application/vnd.google-apps.folder') {
            async function listFolder(token) {
              const q = `'${chosen.id}' in parents and trashed = false`;
              const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,size)&pageSize=100&orderBy=modifiedTime desc`;
              return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            }
            let lr = await listFolder(accessToken);
            if (lr.status === 401 && refreshToken) {
              const ref = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken })
              });
              const jj = await ref.json();
              if (ref.ok && jj.access_token) { accessToken = jj.access_token; lr = await listFolder(accessToken); }
            }
            if (!lr.ok) {
              const txt = await lr.text().catch(()=> '');
              return res.json({ respuesta: `No pude listar la carpeta "${chosen.name}" (${lr.status}). ${txt || ''}` });
            }
            const body = await lr.json().catch(()=>({}));
            const files = Array.isArray(body.files) ? body.files : [];
            await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
            if (files.length === 0) return res.json({ respuesta: `La carpeta "${chosen.name}" está vacía o no hay elementos visibles.` });
            const lines = files.map((f,i)=> `${i+1}. ${f.name} (${f.mimeType || 'desconocido'}) — ${new Date(f.modifiedTime).toLocaleString()}`).join('\n');
            return res.json({ respuesta: `Contenido de "${chosen.name}" (${files.length} elemento(s)):\n${lines}` });
          }

          async function driveDownload(token) {
            return fetch(`https://www.googleapis.com/drive/v3/files/${chosen.id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
          }
          let dl = await driveDownload(accessToken);
          if (dl.status === 401 && refreshToken) {
            const ref = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken })
            });
            const jj = await ref.json();
            if (ref.ok && jj.access_token) {
              accessToken = jj.access_token;
              const enc = encryptToBase64(accessToken);
              await pool.query(`UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, updated_at=NOW() WHERE id=$3`, [enc.ciphertextB64, enc.ivB64, conn.id]);
              dl = await driveDownload(accessToken);
            }
          }
          if (!dl.ok) {
            const txt = await dl.text().catch(()=> '');
            return res.json({ respuesta: `No pude descargar "${chosen.name}" (${dl.status}). ${txt || ''}` });
          }
          const nodeBuf = Buffer.from(await dl.arrayBuffer());
          const mime = chosen.mimeType || 'application/octet-stream';
          const urlMap = { 'application/pdf': '/extract/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '/extract/docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '/extract/xlsx', 'text/plain': '/extract/txt', 'text/csv': '/extract/csv', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '/extract/pptx' };
          const endpoint = urlMap[mime] || (mime.startsWith('text/') ? '/extract/txt' : null);
          if (!endpoint) {
            return res.json({ respuesta: `Por ahora no puedo leer este tipo de archivo (${mime}).` });
          }
          const EX_HOST = process.env.SK_EXTRACT_HOST || '127.0.0.1';
          const EX_PORT = process.env.SK_EXTRACT_PORT || '8001';
          const form = new FormData();
          form.append('file', new Blob([nodeBuf], { type: mime }), chosen.name);
          const exUrl = `http://${EX_HOST}:${EX_PORT}${endpoint}`;
          console.log('[Drive][choose-analyze] posting to extractor:', exUrl, 'filename:', chosen.name, 'mime:', mime, 'size:', nodeBuf.length);
          const exResp = await fetch(exUrl, { method: 'POST', body: form });
          if (!exResp.ok) {
            const txt = await exResp.text().catch(()=> '');
            return res.json({ respuesta: `No pude extraer contenido de "${chosen.name}" (${exResp.status}). ${txt || ''}` });
          }
          const ex = await exResp.json();
          const fullText = ex.full_text || '';
          try { lastDriveAnalyzeByUser.set(authUserId, { file: { id: chosen.id, name: chosen.name, mimeType: chosen.mimeType }, mime, fullText, ts: Date.now() }); } catch {}
          if (!fullText.trim()) {
            return res.json({ respuesta: `No encontré texto utilizable en "${chosen.name}".` });
          }
          if (p && p.doAverage === true) {
            const numbers = Array.from(fullText.matchAll(/[-+]?\d*\.?\d+/g)).map(m => parseFloat(m[0])).filter(n => Number.isFinite(n));
            if (numbers.length === 0) {
              return res.json({ respuesta: `Leí "${chosen.name}" pero no encontré números para calcular promedio.` });
            }
            const avg = numbers.reduce((a,b)=>a+b,0) / numbers.length;
            await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
            return res.json({ respuesta: `Promedio de ${numbers.length} valores en "${chosen.name}": ${avg}` });
          }
          await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
          return res.json({ respuesta: `Contenido de "${chosen.name}":\n\n${fullText}` });
        }
        // Follow-up: drive.analyze → usuario responde con el nombre del archivo
        if (action.intent === 'drive.analyze') {
          const t = String(pregunta || '');
          const p = typeof action.params === 'string' ? JSON.parse(action.params || '{}') : (action.params || {});
          const q = t.match(/["'“”]([^"'“”]+)["'“”]/);
          const plain = t.match(/([a-z0-9_\-\.]+\.(txt|csv|xlsx|pdf|docx|pptx))\b/i);
          const parsedName = q ? q[1].trim() : (plain ? plain[1].trim() : null);
          const targetName = parsedName || (p && p.filename ? String(p.filename).trim() : null);
          if (targetName) {
            const conRes = await pool.query(
              `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
              [authUserId]
            );
            if (conRes.rows.length === 0) {
              return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
            }
            const conn = conRes.rows[0];
            let accessToken = null;
            try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
            const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
              ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
              : null;

            const hasExt = /\.(txt|csv|xlsx|pdf|docx|pptx)$/i.test(targetName);
            async function driveSearchByName(token) {
              const safe = targetName.replace(/'/g, "\\'");
              const qq = hasExt ? `name = '${safe}' and trashed = false` : `name contains '${safe}' and trashed = false`;
              const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(qq)}&fields=files(id,name,mimeType,modifiedTime,size)&pageSize=10&orderBy=modifiedTime desc`;
              return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            }
            let r = await driveSearchByName(accessToken);
            if (r.status === 401 && refreshToken) {
              const ref = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken })
              });
              const jj = await ref.json();
              if (ref.ok && jj.access_token) {
                accessToken = jj.access_token;
                const enc = encryptToBase64(accessToken);
                await pool.query(`UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, updated_at=NOW() WHERE id=$3`, [enc.ciphertextB64, enc.ivB64, conn.id]);
                r = await driveSearchByName(accessToken);
              }
            }
            if (!r.ok) {
              const txt = await r.text().catch(()=> '');
              return res.json({ respuesta: `No pude buscar por nombre (${r.status}). ${txt || ''}` });
            }
            const files = (await r.json()).files || [];
            if (files.length === 0) {
              return res.json({ respuesta: 'No pude identificar el nombre exacto del archivo en tu Drive. Por favor envía el nombre entre comillas, por ejemplo: "mi_archivo.docx"' });
            }
            if (!hasExt && files.length > 1) {
              const list = files.map((f,i)=>`${i+1}. ${f.name} (${f.mimeType || 'desconocido'}) — ${new Date(f.modifiedTime).toLocaleString()}`).join('\n');
              await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
              await pool.query(
                `INSERT INTO pending_actions (user_id, intent, params, status, confirm_message, expires_at)
                 VALUES ($1,'drive.analyze_choose',$2::jsonb,'pending','Indica el número del archivo que debo leer.', NOW() + INTERVAL '15 minutes')`,
                [authUserId, JSON.stringify({ candidates: files, doAverage: p.doAverage === true })]
              );
              return res.json({ respuesta: `Encontré ${files.length} coincidencias para "${targetName}":\n${list}\n\nResponde con el número (1-${files.length}) o escribe el nombre exacto.` });
            }
            const file = files[0];
            async function driveDownload(token) {
              return fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
            }
            let dl = await driveDownload(accessToken);
            if (dl.status === 401 && refreshToken) {
              const ref = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken })
              });
              const jj = await ref.json();
              if (ref.ok && jj.access_token) {
                accessToken = jj.access_token;
                const enc = encryptToBase64(accessToken);
                await pool.query(`UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, updated_at=NOW() WHERE id=$3`, [enc.ciphertextB64, enc.ivB64, conn.id]);
                dl = await driveDownload(accessToken);
              }
            }
            if (!dl.ok) {
              const txt = await dl.text().catch(()=> '');
              return res.json({ respuesta: `No pude descargar "${file.name}" (${dl.status}). ${txt || ''}` });
            }
            const nodeBuf = Buffer.from(await dl.arrayBuffer());
            const mime = file.mimeType || 'application/octet-stream';
            const urlMap = {
              'application/pdf': '/extract/pdf',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '/extract/docx',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '/extract/xlsx',
              'text/plain': '/extract/txt',
              'text/csv': '/extract/csv',
              'application/vnd.openxmlformats-officedocument.presentationml.presentation': '/extract/pptx'
            };
            const endpoint = urlMap[mime] || (mime.startsWith('text/') ? '/extract/txt' : null);
            if (!endpoint) {
              return res.json({ respuesta: `Por ahora no puedo leer este tipo de archivo (${mime}).` });
            }
            const EX_HOST = process.env.SK_EXTRACT_HOST || '127.0.0.1';
            const EX_PORT = process.env.SK_EXTRACT_PORT || '8001';
            const form = new FormData();
            form.append('file', new Blob([nodeBuf], { type: mime }), file.name);
            const exUrl = `http://${EX_HOST}:${EX_PORT}${endpoint}`;
            console.log('[Drive][followup-analyze] posting to extractor:', exUrl, 'filename:', file.name, 'mime:', mime, 'size:', nodeBuf.length);
            const exResp = await fetch(exUrl, { method: 'POST', body: form });
            if (!exResp.ok) {
              const txt = await exResp.text().catch(()=> '');
              return res.json({ respuesta: `No pude extraer contenido de "${file.name}" (${exResp.status}). ${txt || ''}` });
            }
            const ex = await exResp.json();
            const fullText = ex.full_text || '';
            try { lastDriveAnalyzeByUser.set(authUserId, { file: { id: file.id, name: file.name, mimeType: file.mimeType }, mime, fullText, ts: Date.now() }); } catch {}
            if (!fullText.trim()) {
              return res.json({ respuesta: `No encontré texto utilizable en "${file.name}".` });
            }
            const wantsAvg = p && p.doAverage === true;
            if (wantsAvg) {
              const numbers = Array.from(fullText.matchAll(/[-+]?\d*\.?\d+/g)).map(m => parseFloat(m[0])).filter(n => Number.isFinite(n));
              if (numbers.length === 0) {
                return res.json({ respuesta: `Leí "${file.name}" pero no encontré números para calcular promedio.` });
              }
              const avg = numbers.reduce((a,b)=>a+b,0) / numbers.length;
              await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
              return res.json({ respuesta: `Promedio de ${numbers.length} valores en "${file.name}": ${avg}` });
            }
            await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
            return res.json({ respuesta: `Contenido de "${file.name}":\n\n${fullText}` });
          }
        }
        if (action.intent === 'calendar.create') {
          const t = String(pregunta || '');
          const allDayAns = /(todo\s+el\s+d[ií]a)/i.test(t);
          const timeColon = t.match(/\b(\d{1,2}):(\d{2})\b/);
          const timeAmPm = t.match(/\b(\d{1,2})\s*(am|pm)\b/i);
          if (allDayAns || timeColon || timeAmPm) {
            const p = typeof action.params === 'string' ? JSON.parse(action.params || '{}') : action.params;
            const baseDate = p.whenBase || p.when || '';
            let whenFinal = baseDate;
            if (timeColon) {
              const hour = timeColon[1];
              const minute = timeColon[2];
              whenFinal = `${baseDate} ${hour}:${minute}`.trim();
            } else if (timeAmPm) {
              const hour = timeAmPm[1];
              const ampm = timeAmPm[2].toLowerCase();
              whenFinal = `${baseDate} ${hour}:00 ${ampm}`.trim();
            } else if (allDayAns) {
              whenFinal = `${baseDate} todo el día`.trim();
            }
            const newParams = { ...p, title: p.title || 'Evento', when: whenFinal };
            // Claim atómico para evitar duplicados (usar 'confirmed' que está permitido por el CHECK)
            const claimed = await pool.query(
              `UPDATE pending_actions SET status='confirmed', updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING id`,
              [action.id]
            );
            if (claimed.rows.length === 0) {
              return res.json({ respuesta: 'Esta acción ya fue procesada.' });
            }
            // Ejecutar creación reutilizando la lógica existente
            const conRes = await pool.query(
              `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
              [authUserId]
            );
            if (conRes.rows.length === 0) {
              return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
            }
            const conn = conRes.rows[0];
            let accessToken = null;
            try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
            const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
              ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
              : null;
            const TZ = process.env.DEFAULT_TZ || 'America/Guayaquil';
            // Parsear robustamente con duración por defecto
            const range = parseWhenToDateRange(newParams.when || '') || (function(){
              // Intentar extraer yyyy-mm-dd y hh:mm
              const m = newParams.when.match(/(\d{1,2})\s+de\s+[a-záéíóúñ]+\s+(?:de\s+|del\s+)?(\d{4})\s+(\d{1,2}):(\d{2})/i);
              if (!m) return null;
              // Reusar parseWhenToDateRange ya maneja esto; si no, construir manual
              return parseWhenToDateRange(newParams.when);
            })();
            let startObj, endObj;
            if (range && range.startDate && range.endDate) {
              startObj = { date: range.startDate };
              endObj = { date: range.endDate };
            } else if (range && range.startDateTime && range.endDateTime) {
              startObj = { dateTime: range.startDateTime, timeZone: TZ };
              endObj = { dateTime: range.endDateTime, timeZone: TZ };
            } else {
              return res.json({ respuesta: 'No pude interpretar la fecha/hora. Dime, por ejemplo: 15:00 o "todo el día".' });
            }
            const body = {
              summary: newParams.title,
              start: startObj,
              end: endObj,
              attendees: Array.isArray(newParams.attendees) ? newParams.attendees.map(e => ({ email: e })) : undefined
            };
            console.log('[Calendar][confirm-followup] intent=calendar.create params=', { title: newParams.title, when: newParams.when, attendees: newParams.attendees });
            console.log('[Calendar][confirm-followup] parsedRange=', range);
            console.log('[Calendar][confirm-followup] requestBody=', body);
            let calResp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
              body: JSON.stringify(body)
            });
            if (calResp.status === 401 && refreshToken) {
              const ref = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  client_id: process.env.GOOGLE_CLIENT_ID || '',
                  client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
                  grant_type: 'refresh_token',
                  refresh_token: refreshToken
                })
              });
              const refJson = await ref.json();
              if (ref.ok && refJson.access_token) {
                accessToken = refJson.access_token;
                const enc = encryptToBase64(accessToken);
                await pool.query(
                  `UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, token_expires_at=NOW()+($3||' seconds')::interval, updated_at=NOW() WHERE id=$4`,
                  [enc.ciphertextB64, enc.ivB64, String(refJson.expires_in || 3600), conn.id]
                );
                calResp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
                  body: JSON.stringify(body)
                });
              }
            }
            const calJson = await calResp.json();
            console.log('[Calendar][confirm-followup] googleStatus=', calResp.status, 'response=', calJson);
            if (!calResp.ok) {
              try { await pool.query(`UPDATE pending_actions SET status='pending', updated_at=NOW() WHERE id=$1`, [action.id]); } catch {}
              return res.json({ respuesta: `No pude crear el evento (${calResp.status}). ${calJson.error?.message || ''}` });
            }
            await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
            const link = calJson.htmlLink || '';
            return res.json({ respuesta: `El evento \"${newParams.title}\" ha sido creado para ${newParams.when}. ${link ? 'Enlace: ' + link : 'No recibí link de Google, pero el evento debería estar visible en tu calendario.'}` });
          }
        }
      }
    } catch (err) {
      console.error('[Calendar][confirm-followup] error', err);
    }
  }

  // 0.a Confirmación simple "sí/no" para ejecutar/cancelar última acción pendiente
  const lowerText = String(pregunta || '').trim().toLowerCase();
  const isYes = /^(si|sí|sip|ok|dale|hazlo|confirmo)\b/.test(lowerText);
  const isNo = /^(no|cancel|cancela|nope|nah)\b/.test(lowerText);
  // Ejecutar confirmaciones siempre que haya acción pendiente, sin depender del historial del frontend
  if (authUserId && (isYes || isNo)) {
    try {
      const dbmod = await import('./config/db.js');
      const pool = dbmod.default;
      const paRes = await pool.query(
        `SELECT * FROM pending_actions WHERE user_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`,
        [authUserId]
      );
      if (paRes.rows.length === 0) {
        return res.json({ respuesta: 'No tengo una acción pendiente para confirmar.' });
      }
      const action = paRes.rows[0];
      if (isNo) {
        await pool.query(`UPDATE pending_actions SET status='cancelled', updated_at=NOW() WHERE id=$1`, [action.id]);
        return res.json({ respuesta: 'Entendido, cancelé la acción.' });
      }

      // Ejecutar acciones
      if (action.intent === 'email.search') {
        // Obtener conector Google
        const conRes = await pool.query(
          `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
          [authUserId]
        );
        if (conRes.rows.length === 0) {
          return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
        }
        const conn = conRes.rows[0];
        let accessToken = null;
        try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
        const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
          ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
          : null;

        const paramsObj = (action.params && typeof action.params === 'object') ? action.params : (() => { try { return JSON.parse(action.params || '{}'); } catch { return {}; } })();
        const queryParts = [];
        if (paramsObj.from) queryParts.push(`from:${paramsObj.from}`);
        if (paramsObj.hasAttachments) queryParts.push('has:attachment');
        if (paramsObj.attachmentType === 'pdf') queryParts.push('filename:pdf');
        if (paramsObj.timeRange && /semana/.test(paramsObj.timeRange)) queryParts.push('newer_than:7d');
        const gmailQuery = queryParts.join(' ');

        async function gmailList(token) {
          return fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${encodeURIComponent(gmailQuery)}`, {
            headers: { Authorization: `Bearer ${token}` }
          });
        }

        let listResp = await gmailList(accessToken);
        if (listResp && listResp.status === 401 && refreshToken) {
          const ref = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID || '',
              client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
              grant_type: 'refresh_token',
              refresh_token: refreshToken
            })
          });
          const refJson = await ref.json();
          if (ref.ok && refJson.access_token) {
            accessToken = refJson.access_token;
            const enc = encryptToBase64(accessToken);
            await pool.query(
              `UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, token_expires_at=NOW()+($3||' seconds')::interval, updated_at=NOW() WHERE id=$4`,
              [enc.ciphertextB64, enc.ivB64, String(refJson.expires_in || 3600), conn.id]
            );
            listResp = await gmailList(accessToken);
          }
        }

        if (!listResp.ok) {
          const err = await listResp.text();
          return res.json({ respuesta: `No pude consultar Gmail (${listResp.status}). ${err}` });
        }
        const list = await listResp.json();
        const ids = (list.messages || []).map(m => m.id).slice(0, 5);
        if (ids.length === 0) {
          await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
          return res.json({ respuesta: 'No encontré correos que coincidan con tus filtros.' });
        }
        const details = [];
        for (const id of ids) {
          const dResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject`, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          const dj = await dResp.json();
          const headers = (dj.payload && dj.payload.headers) || [];
          const subject = (headers.find(h => h.name === 'Subject') || {}).value || '(sin asunto)';
          details.push({ id, subject, snippet: dj.snippet });
        }
        // Marcar esta acción como ejecutada y crear la siguiente acción pendiente para adjuntos
        await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
        await pool.query(
          `INSERT INTO pending_actions (user_id, intent, params, status, confirm_message, expires_at)
           VALUES ($1,'email.attachments', jsonb_build_object('messageIds', $2::jsonb),'pending','¿Descargo y resumo los PDFs adjuntos?', NOW() + INTERVAL '15 minutes')`,
          [authUserId, JSON.stringify(ids)]
        );
        const lines = details.map((d, i) => `${i + 1}. ${d.subject}`).join('\n');
        return res.json({ respuesta: `Encontré ${details.length} correo(s):\n${lines}\n\n¿Descargo y resumo los PDFs adjuntos? Respóndeme.` });
      }

      if (action.intent === 'calendar.create') {
        // Crear evento en Google Calendar
        const conRes = await pool.query(
          `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
          [authUserId]
        );
        if (conRes.rows.length === 0) {
          return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
        }
        const conn = conRes.rows[0];
        let accessToken = null;
        try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
        const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
          ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
          : null;
        const p = typeof action.params === 'string' ? JSON.parse(action.params || '{}') : action.params;
        // Claim atómico para evitar duplicados (usar 'confirmed')
        const claimed = await pool.query(
          `UPDATE pending_actions SET status='confirmed', updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING id`,
          [action.id]
        );
        if (claimed.rows.length === 0) {
          return res.json({ respuesta: 'Esta acción ya fue procesada.' });
        }
        if (p.whenBase && (!p.when || /(hoy|mañana)/i.test(p.when))) {
          p.when = p.whenBase;
        }
        if (p.whenBase && (!p.when || /(hoy|mañana)/i.test(p.when))) {
          p.when = p.whenBase;
        }
        const range = parseWhenToDateRange(p.when || '');
        const TZ = process.env.DEFAULT_TZ || 'America/Guayaquil';
        let startObj, endObj;
        if (range && range.startDate && range.endDate) {
          startObj = { date: range.startDate };
          endObj = { date: range.endDate };
        } else if (range && range.startDateTime && range.endDateTime) {
          startObj = { dateTime: range.startDateTime, timeZone: TZ };
          endObj = { dateTime: range.endDateTime, timeZone: TZ };
        } else {
          // Fallback: evento de día completo hoy
          const today = new Date();
          const pad = (n) => String(n).padStart(2, '0');
          const startDate = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
          const endDateObj = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
          const endDate = `${endDateObj.getFullYear()}-${pad(endDateObj.getMonth()+1)}-${pad(endDateObj.getDate())}`;
          startObj = { date: startDate };
          endObj = { date: endDate };
        }
        const body = {
          summary: p.title || 'Evento',
          start: startObj,
          end: endObj,
          attendees: Array.isArray(p.attendees) ? p.attendees.map(e => ({ email: e })) : undefined
        };
        console.log('[Calendar][confirm-yes] intent=calendar.create params=', { title: p.title || 'Evento', when: p.when, attendees: p.attendees });
        console.log('[Calendar][confirm-yes] parsedRange=', range);
        console.log('[Calendar][confirm-yes] requestBody=', body);
        let calResp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(body)
        });
        if (calResp.status === 401 && refreshToken) {
          // refrescar token y reintentar
          const ref = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID || '',
              client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
              grant_type: 'refresh_token',
              refresh_token: refreshToken
            })
          });
          const refJson = await ref.json();
          if (ref.ok && refJson.access_token) {
            accessToken = refJson.access_token;
            const enc = encryptToBase64(accessToken);
            await pool.query(
              `UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, token_expires_at=NOW()+($3||' seconds')::interval, updated_at=NOW() WHERE id=$4`,
              [enc.ciphertextB64, enc.ivB64, String(refJson.expires_in || 3600), conn.id]
            );
            calResp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
              body: JSON.stringify(body)
            });
          }
        }
        const calJson = await calResp.json();
        console.log('[Calendar][confirm-yes] googleStatus=', calResp.status, 'response=', calJson);
        if (!calResp.ok) {
          try { await pool.query(`UPDATE pending_actions SET status='pending', updated_at=NOW() WHERE id=$1`, [action.id]); } catch {}
          return res.json({ respuesta: `No pude crear el evento (${calResp.status}). ${calJson.error?.message || ''}` });
        }
        await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
        const link = calJson.htmlLink || '';
        return res.json({ respuesta: `¡Sí! El evento \"${p.title || 'Evento'}\" ha sido creado para ${p.when || 'la fecha indicada'}. ${link ? 'Enlace: ' + link : 'No recibí link de Google, pero el evento debería estar visible en tu calendario.'}` });
      }

      // Drive: listar archivos recientes
      if (action.intent === 'drive.list') {
        const conRes = await pool.query(
          `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
          [authUserId]
        );
        if (conRes.rows.length === 0) {
          return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
        }
        const conn = conRes.rows[0];
        let accessToken = null;
        try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
        const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
          ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
          : null;
        async function driveList(token) {
          return fetch('https://www.googleapis.com/drive/v3/files?pageSize=10&orderBy=modifiedTime desc&fields=files(id,name,mimeType,modifiedTime,owners(emailAddress))', {
            headers: { Authorization: `Bearer ${token}` }
          });
        }
        let dResp = await driveList(accessToken);
        if (dResp && dResp.status === 401 && refreshToken) {
          const ref = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID || '',
              client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
              grant_type: 'refresh_token',
              refresh_token: refreshToken
            })
          });
          const refJson = await ref.json();
          if (ref.ok && refJson.access_token) {
            accessToken = refJson.access_token;
            const enc = encryptToBase64(accessToken);
            await pool.query(
              `UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, token_expires_at=NOW()+($3||' seconds')::interval, updated_at=NOW() WHERE id=$4`,
              [enc.ciphertextB64, enc.ivB64, String(refJson.expires_in || 3600), conn.id]
            );
            dResp = await driveList(accessToken);
          }
        }
        const json = await dResp.json();
        if (!dResp.ok) {
          return res.json({ respuesta: `No pude listar Drive (${dResp.status}). ${json.error?.message || ''}` });
        }
        await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
        const files = Array.isArray(json.files) ? json.files : [];
        if (files.length === 0) return res.json({ respuesta: 'Tu Drive no tiene archivos recientes visibles con los permisos actuales.' });
        const lines = files.map(f => `• ${f.name} (${f.mimeType}) — ${new Date(f.modifiedTime).toLocaleString()}`).join('\n');
        return res.json({ respuesta: `Aquí tienes tus últimos ${files.length} archivo(s):\n${lines}` });
      }

      // Drive: buscar por tipo/mime
      if (action.intent === 'drive.search') {
        const conRes = await pool.query(
          `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
          [authUserId]
        );
        if (conRes.rows.length === 0) {
          return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
        }
        const conn = conRes.rows[0];
        let accessToken = null;
        try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
        const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
          ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
          : null;
        const p = (action.params && typeof action.params === 'object') ? action.params : (()=>{ try{ return JSON.parse(action.params||'{}'); } catch { return {}; } })();
        const limit = Math.max(1, Math.min(50, parseInt(p.limit || '10', 10)));
        async function driveSearch(token) {
          let q = `trashed = false`;
          if (p.mime) {
            if (p.mime.endsWith('/')) {
              q += ` and mimeType contains '${p.mime.replace(/'/g, "\\'")}'`;
            } else {
              q += ` and mimeType = '${p.mime.replace(/'/g, "\\'")}'`;
            }
          }
          const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,size)&pageSize=${limit}&orderBy=modifiedTime desc`;
          return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        }
        let r = await driveSearch(accessToken);
        if (r.status === 401 && refreshToken) {
          const ref = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken })
          });
          const jj = await ref.json();
          if (ref.ok && jj.access_token) {
            accessToken = jj.access_token;
            const enc = encryptToBase64(accessToken);
            await pool.query(`UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, updated_at=NOW() WHERE id=$3`, [enc.ciphertextB64, enc.ivB64, conn.id]);
            r = await driveSearch(accessToken);
          }
        }
        if (!r.ok) {
          const txt = await r.text().catch(()=> '');
          return res.json({ respuesta: `No pude buscar en Drive (${r.status}). ${txt || ''}` });
        }
        const body = await r.json().catch(()=>({}));
        const files = Array.isArray(body.files) ? body.files : [];
        await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
        if (files.length === 0) return res.json({ respuesta: `No encontré archivos ${p.label || ''} en tu Drive.` });
        const lines = files.map(f => `• ${f.name} (${f.mimeType}) — ${new Date(f.modifiedTime).toLocaleString()}`).join('\n');
        return res.json({ respuesta: `Encontré ${files.length} archivo(s)${p.label?` ${p.label}`:''}:\n+${lines}` });
      }

      // Drive: buscar por nombre
      if (action.intent === 'drive.search_name') {
        const conRes = await pool.query(
          `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
          [authUserId]
        );
        if (conRes.rows.length === 0) {
          return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
        }
        const conn = conRes.rows[0];
        let accessToken = null;
        try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
        const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
          ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
          : null;
        const p = (action.params && typeof action.params === 'object') ? action.params : (()=>{ try{ return JSON.parse(action.params||'{}'); } catch { return {}; } })();
        const fname = (p.filename || '').trim();
        if (!fname) {
          return res.json({ respuesta: 'Dime el nombre exacto entre comillas. Ej: "notas.txt"' });
        }
        async function driveSearchByName(token) {
          const q = `name = '${fname.replace(/'/g, "\\'")}' and trashed = false`;
          const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,size)&pageSize=10&orderBy=modifiedTime desc`;
          return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        }
        let r = await driveSearchByName(accessToken);
        if (r.status === 401 && refreshToken) {
          const ref = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken })
          });
          const jj = await ref.json();
          if (ref.ok && jj.access_token) {
            accessToken = jj.access_token;
            const enc = encryptToBase64(accessToken);
            await pool.query(`UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, updated_at=NOW() WHERE id=$3`, [enc.ciphertextB64, enc.ivB64, conn.id]);
            r = await driveSearchByName(accessToken);
          }
        }
        if (!r.ok) {
          const txt = await r.text().catch(()=> '');
          return res.json({ respuesta: `No pude buscar por nombre (${r.status}). ${txt || ''}` });
        }
        const body = await r.json().catch(()=>({}));
        const files = Array.isArray(body.files) ? body.files : [];
        await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
        if (files.length === 0) return res.json({ respuesta: `No encontré archivos llamados "${fname}".` });
        const lines = files.map(f => `• ${f.name} (${f.mimeType}) — ${new Date(f.modifiedTime).toLocaleString()}`).join('\n');
        return res.json({ respuesta: `Coincidencias para "${fname}":\n${lines}` });
      }
      // Drive: crear archivo de texto (MIME text/plain), opcionalmente en carpeta
      if (action.intent === 'drive.create') {
        const conRes = await pool.query(
          `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
          [authUserId]
        );
        if (conRes.rows.length === 0) {
          return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
        }
        const conn = conRes.rows[0];
        let accessToken = null;
        try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
        const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
          ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
          : null;
        const p = typeof action.params === 'string' ? JSON.parse(action.params || '{}') : action.params;

        // Resolver carpeta destino si viene indicada por nombre
        let parentId = null;
        if (p.folder) {
          const folderName = String(p.folder).trim();
          async function findFolder(token) {
            const q = `name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
            const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`;
            return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          }
          let fr = await findFolder(accessToken);
          if (fr.status === 401 && refreshToken) {
            const ref = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken }) });
            const jj = await ref.json();
            if (ref.ok && jj.access_token) { accessToken = jj.access_token; fr = await findFolder(accessToken); }
          }
          if (fr.ok) {
            const fj = await fr.json().catch(()=>({}));
            const folder = Array.isArray(fj.files) && fj.files.length > 0 ? fj.files[0] : null;
            parentId = folder ? folder.id : null;
          }
        }

        const metaObj = { name: p.name || 'archivo_skanea.txt', mimeType: 'text/plain' };
        if (parentId) metaObj.parents = [parentId];
        const boundary = 'skanea_boundary_' + Date.now();
        const delimiter = `\r\n--${boundary}\r\n`;
        const closeDelim = `\r\n--${boundary}--`;
        const body =
          delimiter +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(metaObj) +
          delimiter +
          'Content-Type: text/plain\r\n\r\n' +
          (p.content || 'Archivo creado por Skanea') +
          closeDelim;
        async function driveCreate(token) {
          return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body
          });
        }
        let cResp = await driveCreate(accessToken);
        if (cResp && cResp.status === 401 && refreshToken) {
          const ref = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID || '',
              client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
              grant_type: 'refresh_token',
              refresh_token: refreshToken
            })
          });
          const refJson = await ref.json();
          if (ref.ok && refJson.access_token) {
            accessToken = refJson.access_token;
            const enc = encryptToBase64(accessToken);
            await pool.query(
              `UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, token_expires_at=NOW()+($3||' seconds')::interval, updated_at=NOW() WHERE id=$4`,
              [enc.ciphertextB64, enc.ivB64, String(refJson.expires_in || 3600), conn.id]
            );
            cResp = await driveCreate(accessToken);
          }
        }
        const cj = await cResp.json();
        if (!cResp.ok) {
          return res.json({ respuesta: `No pude crear el archivo (${cResp.status}). ${cj.error?.message || ''}` });
        }
        await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
        return res.json({ respuesta: `Archivo creado: ${cj.name || metaObj.name} (id: ${cj.id || 'desconocido'})${parentId ? ` en carpeta (${p.folder})` : ''}.` });
      }

      // Drive: listar contenido de carpeta
      if (action.intent === 'drive.folder_list') {
        const conRes = await pool.query(
          `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
          [authUserId]
        );
        if (conRes.rows.length === 0) {
          return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
        }
        const conn = conRes.rows[0];
        let accessToken = null;
        try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
        const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
          ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
          : null;
        const p = typeof action.params === 'string' ? JSON.parse(action.params || '{}') : action.params;

        async function findFolder(token) {
          const q = `name = '${String(p.name||'').replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
          const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`;
          return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        }
        let fr = await findFolder(accessToken);
        if (fr.status === 401 && refreshToken) {
          const ref = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken }) });
          const jj = await ref.json();
          if (ref.ok && jj.access_token) { accessToken = jj.access_token; fr = await findFolder(accessToken); }
        }
        if (!fr.ok) {
          const txt = await fr.text().catch(()=> '');
          return res.json({ respuesta: `No pude localizar la carpeta (${fr.status}). ${txt || ''}` });
        }
        const fj = await fr.json().catch(()=>({}));
        const folder = Array.isArray(fj.files) && fj.files.length > 0 ? fj.files[0] : null;
        if (!folder) {
          return res.json({ respuesta: `No encontré la carpeta "${p.name}" en tu Drive.` });
        }

        async function listFolder(token) {
          const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folder.id}' in parents and trashed = false`)}&fields=files(id,name,mimeType,modifiedTime,size)&pageSize=${Math.max(1, Math.min(100, parseInt(p.limit||'50',10)))}&orderBy=modifiedTime desc`;
          return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        }
        let lr = await listFolder(accessToken);
        if (lr.status === 401 && refreshToken) {
          const ref = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken }) });
          const jj = await ref.json();
          if (ref.ok && jj.access_token) { accessToken = jj.access_token; lr = await listFolder(accessToken); }
        }
        if (!lr.ok) {
          const txt = await lr.text().catch(()=> '');
          return res.json({ respuesta: `No pude listar la carpeta (${lr.status}). ${txt || ''}` });
        }
        const body = await lr.json().catch(()=>({}));
        const files = Array.isArray(body.files) ? body.files : [];
        await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
        if (files.length === 0) return res.json({ respuesta: `La carpeta "${p.name}" está vacía o no hay elementos visibles.` });
        const lines = files.map((f,i)=> `${i+1}. ${f.name} (${f.mimeType || 'desconocido'}) — ${new Date(f.modifiedTime).toLocaleString()}`).join('\n');
        return res.json({ respuesta: `Contenido de "${p.name}" (${files.length} elemento(s)):\n${lines}` });
      }
      // Drive: crear carpeta (opcionalmente dentro de otra carpeta)
      if (action.intent === 'drive.create_folder') {
        const conRes = await pool.query(
          `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
          [authUserId]
        );
        if (conRes.rows.length === 0) {
          return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
        }
        const conn = conRes.rows[0];
        let accessToken = null;
        try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
        const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
          ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
          : null;

        const p = typeof action.params === 'string' ? JSON.parse(action.params || '{}') : action.params;

        // Resolver carpeta padre si se indicó
        let parentId = null;
        if (p.parent) {
          const parentName = String(p.parent).trim();
          async function findParent(token) {
            const q = `name = '${parentName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
            const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`;
            return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          }
          let pr = await findParent(accessToken);
          if (pr.status === 401 && refreshToken) {
            const ref = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken }) });
            const jj = await ref.json();
            if (ref.ok && jj.access_token) { accessToken = jj.access_token; pr = await findParent(accessToken); }
          }
          if (pr.ok) {
            const pj = await pr.json().catch(()=>({}));
            const parentFolder = Array.isArray(pj.files) && pj.files.length > 0 ? pj.files[0] : null;
            parentId = parentFolder ? parentFolder.id : null;
          }
        }

        // Crear la carpeta
        async function createFolder(token) {
          const meta = { name: p.name || 'carpeta_skanea', mimeType: 'application/vnd.google-apps.folder' };
          if (parentId) meta.parents = [parentId];
          return fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(meta)
          });
        }
        let cr = await createFolder(accessToken);
        if (cr.status === 401 && refreshToken) {
          const ref = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken }) });
          const jj = await ref.json();
          if (ref.ok && jj.access_token) { accessToken = jj.access_token; cr = await createFolder(accessToken); }
        }
        const cj = await cr.json().catch(()=>({}));
        if (!cr.ok) {
          return res.json({ respuesta: `No pude crear la carpeta (${cr.status}). ${cj.error?.message || ''}` });
        }
        await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
        // Si solicitaron crear un archivo luego de la carpeta
        if (p.postFile && cj && cj.id) {
          try {
            const meta = { name: p.postFile.name || 'archivo_skanea.txt', mimeType: 'text/plain', parents: [cj.id] };
            const boundary = 'skanea_boundary_' + Date.now();
            const delimiter = `\r\n--${boundary}\r\n`;
            const closeDelim = `\r\n--${boundary}--`;
            const body =
              delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
              delimiter + 'Content-Type: text/plain\r\n\r\n' + (p.postFile.content || 'Archivo creado por Skanea') +
              closeDelim;
            await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
              body
            });
            return res.json({ respuesta: `Carpeta creada: ${cj.name || p.name}. También creé el archivo TXT dentro.` });
          } catch {
            return res.json({ respuesta: `Carpeta creada: ${cj.name || p.name}. No pude crear el archivo dentro.` });
          }
        }
        return res.json({ respuesta: `Carpeta creada: ${cj.name || p.name} (id: ${cj.id || 'desconocido'})${parentId ? ` dentro de (${p.parent})` : ''}.` });
      }

      // Drive: analizar/leer archivo por nombre y responder con operación simple
      if (action.intent === 'drive.analyze') {
        const dbmod = await import('./config/db.js');
        const pool = dbmod.default;
        const conRes = await pool.query(
          `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
          [authUserId]
        );
        if (conRes.rows.length === 0) {
          return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
        }
        const conn = conRes.rows[0];
        let accessToken = null;
        try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
        const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
          ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
          : null;

        const p = typeof action.params === 'string' ? JSON.parse(action.params || '{}') : (action.params || {});
        const targetName = (p.filename || '').trim();
        if (!targetName) {
          return res.json({ respuesta: 'Necesito el nombre del archivo. Por ejemplo: "notas.txt"' });
        }

        async function driveSearch(token) {
          let q = `name = '${targetName.replace(/'/g, "\\'")}' and trashed = false`;
          if (p.folder) {
            // Buscar carpeta primero
            const fq = `name = '${String(p.folder).replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
            const furl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(fq)}&fields=files(id,name)&pageSize=1`;
            const fr = await fetch(furl, { headers: { Authorization: `Bearer ${token}` } });
            if (fr.ok) {
              const fj = await fr.json().catch(()=>({}));
              const folder = Array.isArray(fj.files) && fj.files.length > 0 ? fj.files[0] : null;
              if (folder) q = `name = '${targetName.replace(/'/g, "\\'")}' and '${folder.id}' in parents and trashed = false`;
            }
          }
          const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=5&orderBy=modifiedTime desc`;
          return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        }
        let ls = await driveSearch(accessToken);
        if (ls.status === 401 && refreshToken) {
          const ref = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID,
              client_secret: process.env.GOOGLE_CLIENT_SECRET,
              grant_type: 'refresh_token',
              refresh_token: refreshToken
            })
          });
          if (ref.ok) {
            const j = await ref.json();
            accessToken = j.access_token;
            try {
              const { default: pool2 } = await import('./config/db.js');
              const enc = encryptToBase64(accessToken);
              await pool2.query(`UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, updated_at=NOW() WHERE id=$3`, [enc.ciphertextB64, enc.ivB64, conn.id]);
            } catch {}
            ls = await driveSearch(accessToken);
          }
        }
        if (!ls.ok) {
          const txt = await ls.text().catch(()=> '');
          return res.json({ respuesta: `No pude buscar el archivo en Drive (${ls.status}). ${txt || ''}` });
        }
        const found = (await ls.json()).files || [];
        if (found.length === 0) {
          return res.json({ respuesta: `No encontré "${targetName}" en tu Drive.` });
        }
        const file = found[0];

        // Descargar contenido
        async function driveDownload(token) {
          return fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
            headers: { Authorization: `Bearer ${token}` }
          });
        }
        let dl = await driveDownload(accessToken);
        if (dl.status === 401 && refreshToken) {
          const ref = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID,
              client_secret: process.env.GOOGLE_CLIENT_SECRET,
              grant_type: 'refresh_token',
              refresh_token: refreshToken
            })
          });
          if (ref.ok) {
            const j = await ref.json();
            accessToken = j.access_token;
            try {
              const { default: pool2 } = await import('./config/db.js');
              const enc = encryptToBase64(accessToken);
              await pool2.query(`UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, updated_at=NOW() WHERE id=$3`, [enc.ciphertextB64, enc.ivB64, conn.id]);
            } catch {}
            dl = await driveDownload(accessToken);
          }
        }
        if (!dl.ok) {
          const txt = await dl.text().catch(()=> '');
          return res.json({ respuesta: `No pude descargar "${file.name}" (${dl.status}). ${txt || ''}` });
        }
        const buffer = await dl.arrayBuffer();
        const nodeBuf = Buffer.from(buffer);

        // Enviar al servicio local de extracción según MIME
        const mime = file.mimeType || 'application/octet-stream';
        const urlMap = {
          'application/pdf': '/extract/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '/extract/docx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '/extract/xlsx',
          'text/plain': '/extract/txt',
          'text/csv': '/extract/csv',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation': '/extract/pptx'
        };
        const endpoint = urlMap[mime] || (mime.startsWith('text/') ? '/extract/txt' : null);
        if (!endpoint) {
          return res.json({ respuesta: `Por ahora no puedo leer este tipo de archivo (${mime}).` });
        }

        const EX_HOST = process.env.SK_EXTRACT_HOST || '127.0.0.1';
        const EX_PORT = process.env.SK_EXTRACT_PORT || '8001';
        const form = new FormData();
        form.append('file', new Blob([nodeBuf], { type: mime }), file.name);
        const exUrl = `http://${EX_HOST}:${EX_PORT}${endpoint}`;
        console.log('[Drive][analyze] posting to extractor:', exUrl, 'filename:', file.name, 'mime:', mime, 'size:', nodeBuf.length);
        const exResp = await fetch(exUrl, { method: 'POST', body: form });
        if (!exResp.ok) {
          const txt = await exResp.text().catch(()=> '');
          return res.json({ respuesta: `No pude extraer contenido de "${file.name}" (${exResp.status}). ${txt || ''}` });
        }
        const ex = await exResp.json();
        const fullText = ex.full_text || '';
        if (!fullText.trim()) {
          return res.json({ respuesta: `No encontré texto utilizable en "${file.name}".` });
        }

        // Heurística simple: si pides “promedio” o “media”, calcular promedio de números en el texto
        const wantsAvg = (p && p.doAverage === true) || /(promedio|media)\b/.test(p.originalText || pregunta || '');
        if (wantsAvg) {
          const numbers = Array.from(fullText.matchAll(/[-+]?\d*\.?\d+/g)).map(m => parseFloat(m[0])).filter(n => Number.isFinite(n));
          if (numbers.length === 0) {
            return res.json({ respuesta: `Leí "${file.name}" pero no encontré números para calcular promedio.` });
          }
          const avg = numbers.reduce((a,b)=>a+b,0) / numbers.length;
          await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
          return res.json({ respuesta: `Promedio de ${numbers.length} valores en "${file.name}": ${avg}` });
        }

        // Si no es promedio, devolver el contenido completo
        await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
        return res.json({ respuesta: `Contenido de "${file.name}":\n\n${fullText}` });
      }

      // Adjuntos: descargar listado de PDFs (MVP)
      if (action.intent === 'email.attachments') {
        const dbmod = await import('./config/db.js');
        const pool = dbmod.default;
        const connRes = await pool.query(
          `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
          [authUserId]
        );
        if (connRes.rows.length === 0) {
          return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
        }
        const conn = connRes.rows[0];
        let accessToken = null;
        try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
        const paramsObj = (action.params && typeof action.params === 'object') ? action.params : (() => { try { return JSON.parse(action.params || '{}'); } catch { return {}; } })();
        const ids = Array.isArray(paramsObj.messageIds) ? paramsObj.messageIds : [];
        const found = [];
        for (const id of ids) {
          const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!msgResp.ok) continue;
          const msg = await msgResp.json();
          // navegar partes recursivamente
          function collect(parts) {
            if (!parts) return;
            for (const p of parts) {
              if (p.filename && p.body && p.body.attachmentId && /pdf/i.test(p.mimeType || '')) {
                found.push({ id, filename: p.filename, attachmentId: p.body.attachmentId });
              }
              if (p.parts) collect(p.parts);
            }
          }
          collect((msg.payload && msg.payload.parts) || []);
        }
        await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
        if (found.length === 0) {
          return res.json({ respuesta: 'No encontré PDFs adjuntos en esos correos.' });
        }
        const list = found.map((a, i) => `${i + 1}. ${a.filename}`).join('\n');
        // Crear siguiente pendiente: descarga + resumen de adjuntos
        await pool.query(
          `INSERT INTO pending_actions (user_id, intent, params, status, confirm_message, expires_at)
           VALUES ($1,'email.attachments_download', $2::jsonb, 'pending', '¿Descargo y resumo los PDFs ahora?', NOW() + INTERVAL '15 minutes')`,
          [authUserId, JSON.stringify({ attachments: found })]
        );
        return res.json({ respuesta: `Descubrí ${found.length} PDF(s):\n${list}\n\n¿Deseas que los descargue y resuma ahora? Responde "sí" para continuar.` });
      }

      // Fallback
      return res.json({ respuesta: 'Acción confirmada. Estoy implementando esta operación.' });
    } catch (e) {
      console.error('Confirmación/ejecución error:', e);
      return res.status(500).send('Error ejecutando acción');
    }
  }

  // 0) Detección de intención para conectores: devolver confirmación antes de llamar a OpenAI
  // 0.a3 Manejo global de elección numérica para drive.analyze_choose (soporta mensajes editados)
  if (authUserId) {
    const raw = String(pregunta || '').trim();
    // Considerar como "elección" solo si el mensaje es SOLO un número (o variantes claras),
    // o si el mensaje es SOLO un nombre entre comillas. Evita colisiones con frases como
    // "crear un excel con los números del 1 al 10".
    const onlyNumber = /^\s*(?:op(?:ci[oó]n)?\s*)?(\d{1,2})\s*$|^\s*(?:elige|elijo)\s*\d{1,2}\s*$/i.test(raw);
    const onlyQuoted = /^\s*["'“”‘’][^"'“”‘’]+["'“”‘’]\s*$/.test(raw);
    const isChoice = onlyNumber || onlyQuoted;
    // Si había una acción pendiente de listar Drive, pero el usuario ahora pide promedio/columna o confirma, cancélala
    try {
      if (/(media|promedio|columna|nota|calcula)/i.test(raw) || /^\s*s[ií]\b/i.test(raw)) {
        const dbmod = await import('./config/db.js');
        const pool = dbmod.default;
        const lastList = await pool.query(`SELECT * FROM pending_actions WHERE user_id=$1 AND status='pending' AND intent='drive.list' ORDER BY created_at DESC LIMIT 1`, [authUserId]);
        if (lastList.rows.length > 0) {
          await pool.query(`UPDATE pending_actions SET status='cancelled', updated_at=NOW() WHERE id=$1`, [lastList.rows[0].id]);
          console.log('[Follow-up] cancelled stale drive.list pending action:', lastList.rows[0].id);
        }
      }
    } catch {}

    if (isChoice) {
      try {
        const dbmod = await import('./config/db.js');
        const pool = dbmod.default;
        const alt = await pool.query(
          `SELECT * FROM pending_actions WHERE user_id=$1 AND status='pending' AND intent='drive.analyze_choose' ORDER BY created_at DESC LIMIT 1`,
          [authUserId]
        );
        if (alt.rows.length > 0) {
          // Reusar la misma lógica que arriba: parsear elección y ejecutar
          const action = alt.rows[0];
          const p = typeof action.params === 'string' ? JSON.parse(action.params || '{}') : (action.params || {});
          const candidates = Array.isArray(p.candidates) ? p.candidates : [];
          let chosen = null;
          const mNum = raw.match(/\b(\d{1,2})\b/);
          if (mNum) { const idx = parseInt(mNum[1], 10) - 1; if (idx >= 0 && idx < candidates.length) chosen = candidates[idx]; }
          if (!chosen) {
            const q = raw.match(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/);
            const name = (q ? q[1] : raw).trim().toLowerCase();
            chosen = candidates.find(c => String(c.name || '').toLowerCase() === name);
          }
          if (chosen) {
            // Ejecutar igual que en el handler principal
            const conRes = await pool.query(
              `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
              [authUserId]
            );
            if (conRes.rows.length === 0) return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
            const conn = conRes.rows[0];
            let accessToken = null; try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
            const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv) : null;
            async function driveDownload(token) { return fetch(`https://www.googleapis.com/drive/v3/files/${chosen.id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } }); }
            let dl = await driveDownload(accessToken);
            if (dl.status === 401 && refreshToken) {
              const ref = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken }) });
              const jj = await ref.json();
              if (ref.ok && jj.access_token) { accessToken = jj.access_token; const enc = encryptToBase64(accessToken); await pool.query(`UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, updated_at=NOW() WHERE id=$3`, [enc.ciphertextB64, enc.ivB64, conn.id]); dl = await driveDownload(accessToken); }
            }
            if (!dl.ok) { const txt = await dl.text().catch(()=> ''); return res.json({ respuesta: `No pude descargar "${chosen.name}" (${dl.status}). ${txt || ''}` }); }
            const nodeBuf = Buffer.from(await dl.arrayBuffer());
            const mime = chosen.mimeType || 'application/octet-stream';
            const urlMap = { 'application/pdf': '/extract/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '/extract/docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '/extract/xlsx', 'text/plain': '/extract/txt', 'text/csv': '/extract/csv', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '/extract/pptx' };
            const endpoint = urlMap[mime] || (mime.startsWith('text/') ? '/extract/txt' : null);
            if (!endpoint) return res.json({ respuesta: `Por ahora no puedo leer este tipo de archivo (${mime}).` });
            const EX_HOST = process.env.SK_EXTRACT_HOST || '127.0.0.1'; const EX_PORT = process.env.SK_EXTRACT_PORT || '8001';
            const form = new FormData(); form.append('file', new Blob([nodeBuf], { type: mime }), chosen.name);
            const exUrl = `http://${EX_HOST}:${EX_PORT}${endpoint}`; console.log('[Drive][choice-global] posting to extractor:', exUrl, 'filename:', chosen.name, 'mime:', mime, 'size:', nodeBuf.length);
            const exResp = await fetch(exUrl, { method: 'POST', body: form });
            if (!exResp.ok) { const txt = await exResp.text().catch(()=> ''); return res.json({ respuesta: `No pude extraer contenido de "${chosen.name}" (${exResp.status}). ${txt || ''}` }); }
            const ex = await exResp.json(); const fullText = ex.full_text || '';
            if (!fullText.trim()) return res.json({ respuesta: `No encontré texto utilizable en "${chosen.name}".` });
            if (p && p.doAverage === true) {
              const numbers = Array.from(fullText.matchAll(/[-+]?\d*\.?\d+/g)).map(m => parseFloat(m[0])).filter(n => Number.isFinite(n));
              if (numbers.length === 0) return res.json({ respuesta: `Leí "${chosen.name}" pero no encontré números para calcular promedio.` });
              const avg = numbers.reduce((a,b)=>a+b,0) / numbers.length;
              await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
              return res.json({ respuesta: `Promedio de ${numbers.length} valores en "${chosen.name}": ${avg}` });
            }
            await pool.query(`UPDATE pending_actions SET status='executed', updated_at=NOW() WHERE id=$1`, [action.id]);
            return res.json({ respuesta: `Contenido de "${chosen.name}":\n\n${fullText}` });
          }
        } else {
          // Fallback: usar la última acción analyze_choose reciente aunque ya esté ejecutada/cancelada
          try {
            const lastAny = await pool.query(
              `SELECT * FROM pending_actions WHERE user_id=$1 AND intent='drive.analyze_choose' ORDER BY created_at DESC LIMIT 1`,
              [authUserId]
            );
            if (lastAny.rows.length > 0) {
              const action = lastAny.rows[0];
              const p = typeof action.params === 'string' ? JSON.parse(action.params || '{}') : (action.params || {});
              const candidates = Array.isArray(p.candidates) ? p.candidates : [];
              let chosen = null;
              const mNum = raw.match(/\b(\d{1,2})\b/);
              if (mNum) { const idx = parseInt(mNum[1], 10) - 1; if (idx >= 0 && idx < candidates.length) chosen = candidates[idx]; }
              if (!chosen) {
                const q = raw.match(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/);
                const name = (q ? q[1] : raw).trim().toLowerCase();
                chosen = candidates.find(c => String(c.name || '').toLowerCase() === name);
              }
              if (chosen) {
                const conRes = await pool.query(
                  `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
                  [authUserId]
                );
                if (conRes.rows.length === 0) return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
                const conn = conRes.rows[0];
                let accessToken = null; try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
                const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv) : null;
                async function driveDownload(token) { return fetch(`https://www.googleapis.com/drive/v3/files/${chosen.id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } }); }
                let dl = await driveDownload(accessToken);
                if (dl.status === 401 && refreshToken) {
                  const ref = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken }) });
                  const jj = await ref.json();
                  if (ref.ok && jj.access_token) { accessToken = jj.access_token; const enc = encryptToBase64(accessToken); await pool.query(`UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, updated_at=NOW() WHERE id=$3`, [enc.ciphertextB64, enc.ivB64, conn.id]); dl = await driveDownload(accessToken); }
                }
                if (!dl.ok) { const txt = await dl.text().catch(()=> ''); return res.json({ respuesta: `No pude descargar "${chosen.name}" (${dl.status}). ${txt || ''}` }); }
                const nodeBuf = Buffer.from(await dl.arrayBuffer());
                const mime = chosen.mimeType || 'application/octet-stream';
                const urlMap = { 'application/pdf': '/extract/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '/extract/docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '/extract/xlsx', 'text/plain': '/extract/txt', 'text/csv': '/extract/csv', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '/extract/pptx' };
                const endpoint = urlMap[mime] || (mime.startsWith('text/') ? '/extract/txt' : null);
                if (!endpoint) return res.json({ respuesta: `Por ahora no puedo leer este tipo de archivo (${mime}).` });
                const EX_HOST = process.env.SK_EXTRACT_HOST || '127.0.0.1'; const EX_PORT = process.env.SK_EXTRACT_PORT || '8001';
                const form = new FormData(); form.append('file', new Blob([nodeBuf], { type: mime }), chosen.name);
                const exUrl = `http://${EX_HOST}:${EX_PORT}${endpoint}`; console.log('[Drive][choice-global-fallback] posting to extractor:', exUrl, 'filename:', chosen.name, 'mime:', mime, 'size:', nodeBuf.length);
                const exResp = await fetch(exUrl, { method: 'POST', body: form });
                if (!exResp.ok) { const txt = await exResp.text().catch(()=> ''); return res.json({ respuesta: `No pude extraer contenido de "${chosen.name}" (${exResp.status}). ${txt || ''}` }); }
                const ex = await exResp.json(); const fullText = ex.full_text || '';
                if (!fullText.trim()) return res.json({ respuesta: `No encontré texto utilizable en "${chosen.name}".` });
                if (p && p.doAverage === true) {
                  const numbers = Array.from(fullText.matchAll(/[-+]?\d*\.?\d+/g)).map(m => parseFloat(m[0])).filter(n => Number.isFinite(n));
                  if (numbers.length === 0) return res.json({ respuesta: `Leí "${chosen.name}" pero no encontré números para calcular promedio.` });
                  const avg = numbers.reduce((a,b)=>a+b,0) / numbers.length;
                  return res.json({ respuesta: `Promedio de ${numbers.length} valores en "${chosen.name}": ${avg}` });
                }
                return res.json({ respuesta: `Contenido de "${chosen.name}":\n\n${fullText}` });
              }
            }
          } catch {}
        }
      } catch {}
    }
  }

  // 0) Detección de intención para conectores: devolver confirmación antes de llamar a OpenAI
  // (ya detectado al inicio para evitar cache, reutilizar la variable connectorIntent)
  const detected = connectorIntent;
  if (detected.matched) {
    // Ejecución directa para drive.analyze cuando ya tenemos el nombre del archivo
    if (detected.intent === 'drive.analyze' && detected.params && detected.params.filename && authUserId) {
      try {
        const { default: pool } = await import('./config/db.js');
        const conRes = await pool.query(
          `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
          [authUserId]
        );
        if (conRes.rows.length === 0) {
          return res.json({ respuesta: 'No encuentro tu conector de Google. Conéctalo en Ajustes.' });
        }
        const conn = conRes.rows[0];
        let accessToken = null;
        try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
        const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
          ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
          : null;

        const p = detected.params || {};
        const targetName = String(p.filename || '').trim();
        const hasExt = /\.(txt|csv|xlsx|pdf|docx|pptx)$/i.test(targetName);
        async function driveSearch(token) {
          const safe = targetName.replace(/'/g, "\\'");
          const q = hasExt ? `name = '${safe}' and trashed = false` : `name contains '${safe}' and trashed = false`;
          const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=5&orderBy=modifiedTime desc`;
          return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        }
        let ls = await driveSearch(accessToken);
        if (ls.status === 401 && refreshToken) {
          const ref = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID || '',
              client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
              grant_type: 'refresh_token',
              refresh_token: refreshToken
            })
          });
          const j = await ref.json().catch(()=>({}));
          if (ref.ok && j.access_token) {
            accessToken = j.access_token;
            try {
              const enc = encryptToBase64(accessToken);
              await pool.query(`UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, updated_at=NOW() WHERE id=$3`, [enc.ciphertextB64, enc.ivB64, conn.id]);
            } catch {}
            ls = await driveSearch(accessToken);
          }
        }
        if (!ls.ok) {
          const txt = await ls.text().catch(()=> '');
          return res.json({ respuesta: `No pude buscar el archivo en Drive (${ls.status}). ${txt || ''}` });
        }
        const found = (await ls.json().catch(()=>({ files: [] }))).files || [];
        if (found.length === 0) {
          return res.json({ respuesta: `No encontré "${targetName}" en tu Drive.` });
        }
        if (!hasExt && found.length > 1) {
          const list = found.map((f,i)=>`${i+1}. ${f.name} (${f.mimeType || 'desconocido'}) — ${new Date(f.modifiedTime).toLocaleString()}`).join('\n');
          // Guardar candidatos para elección
          try {
            await pool.query(
              `INSERT INTO pending_actions (user_id, intent, params, status, confirm_message, expires_at)
               VALUES ($1,'drive.analyze_choose',$2::jsonb,'pending','Indica el número del archivo que debo leer.', NOW() + INTERVAL '15 minutes')`,
              [authUserId, JSON.stringify({ candidates: found, doAverage: p.doAverage === true })]
            );
          } catch {}
          return res.json({ respuesta: `Encontré ${found.length} coincidencias para "${targetName}":\n${list}\n\nResponde con el número (1-${found.length}) o escribe el nombre exacto.` });
        }
        const file = found[0];
        async function driveDownload(token) {
          return fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
        }
        let dl = await driveDownload(accessToken);
        if (dl.status === 401 && refreshToken) {
          const ref = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID || '',
              client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
              grant_type: 'refresh_token',
              refresh_token: refreshToken
            })
          });
          const j = await ref.json().catch(()=>({}));
          if (ref.ok && j.access_token) {
            accessToken = j.access_token;
            try {
              const enc = encryptToBase64(accessToken);
              await pool.query(`UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, updated_at=NOW() WHERE id=$3`, [enc.ciphertextB64, enc.ivB64, conn.id]);
            } catch {}
            dl = await driveDownload(accessToken);
          }
        }
        if (!dl.ok) {
          const txt = await dl.text().catch(()=> '');
          return res.json({ respuesta: `No pude descargar "${file.name}" (${dl.status}). ${txt || ''}` });
        }
        const nodeBuf = Buffer.from(await dl.arrayBuffer());
        const mime = file.mimeType || 'application/octet-stream';
        const urlMap = {
          'application/pdf': '/extract/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '/extract/docx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '/extract/xlsx',
          'text/plain': '/extract/txt',
          'text/csv': '/extract/csv',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation': '/extract/pptx'
        };
        const endpoint = urlMap[mime] || (mime.startsWith('text/') ? '/extract/txt' : null);
        if (!endpoint) return res.json({ respuesta: `Por ahora no puedo leer este tipo de archivo (${mime}).` });
        const EX_HOST = process.env.SK_EXTRACT_HOST || '127.0.0.1';
        const EX_PORT = process.env.SK_EXTRACT_PORT || '8001';
        const form = new FormData();
        form.append('file', new Blob([nodeBuf], { type: mime }), file.name);
        const exUrl = `http://${EX_HOST}:${EX_PORT}${endpoint}`;
        console.log('[Drive][direct-analyze] posting to extractor:', exUrl, 'filename:', file.name, 'mime:', mime, 'size:', nodeBuf.length);
        const exResp = await fetch(exUrl, { method: 'POST', body: form });
        if (!exResp.ok) {
          const txt = await exResp.text().catch(()=> '');
          return res.json({ respuesta: `No pude extraer contenido de "${file.name}" (${exResp.status}). ${txt || ''}` });
        }
        const ex = await exResp.json().catch(async ()=>({ full_text: await exResp.text().catch(()=> '') }));
        const fullText = ex.full_text || '';
        try { lastDriveAnalyzeByUser.set(authUserId, { file: { id: file.id, name: file.name, mimeType: file.mimeType }, mime, fullText, ts: Date.now() }); } catch {}
        if (!fullText.trim()) {
          return res.json({ respuesta: `No encontré texto utilizable en "${file.name}".` });
        }
        if (p && p.doAverage === true) {
          const numbers = Array.from(fullText.matchAll(/[-+]?\d*\.?\d+/g)).map(m => parseFloat(m[0])).filter(n => Number.isFinite(n));
          if (numbers.length === 0) return res.json({ respuesta: `Leí "${file.name}" pero no encontré números para calcular promedio.` });
          const avg = numbers.reduce((a,b)=>a+b,0) / numbers.length;
          return res.json({ respuesta: `Promedio de ${numbers.length} valores en "${file.name}": ${avg}` });
        }
        return res.json({ respuesta: `Contenido de "${file.name}":\n\n${fullText}` });
      } catch (e) {
        console.error('[Drive][direct-analyze] error:', e);
        return res.json({ respuesta: 'Ocurrió un error leyendo tu archivo de Drive.' });
      }
    }
    if (authUserId) {
      try {
        // Guardar acción pendiente solo si conocemos el usuario
        const result = await import('./config/db.js');
        const pool = result.default;
        const insert = await pool.query(
          `INSERT INTO pending_actions (user_id, intent, params, status, confirm_message, expires_at)
           VALUES ($1,$2,$3,'pending',$4, NOW() + INTERVAL '15 minutes')
           RETURNING id`,
          [authUserId, detected.intent, JSON.stringify(detected.params), detected.confirmMessage]
        );
        return res.json({ respuesta: detected.confirmMessage, intent: detected.intent, params: detected.params, pendingActionId: insert.rows[0].id });
      } catch (e) {
        console.error('Error guardando pending_action', e);
        return res.json({ respuesta: detected.confirmMessage, intent: detected.intent, params: detected.params });
      }
    }
    // Si no hay usuario autenticado, devolver solo la confirmación
    return res.json({ respuesta: detected.confirmMessage || '¿Deseas que lo haga?', intent: detected.intent, params: detected.params });
  }

  // 0.b Intents de tiempo real (cripto/fiat/noticias) → responder directo sin LLM
  function detectRealtimeIntent(text) {
    const raw = String(text || '').trim();
    const t = raw.toLowerCase();
    const COIN_MAP = { btc: 'bitcoin', xbt: 'bitcoin', eth: 'ethereum', sol: 'solana', ada: 'cardano', doge: 'dogecoin', bnb: 'binancecoin', xrp: 'ripple', matic: 'matic-network' };
    const pairRe = /\b([a-z]{2,10})\s*(?:\/|en|a)\s*([a-z]{3,5})\b/;
    const ALLOWED_VS = new Set(['usd','eur','ars','mxn','cop','clp','inr','brl','gbp','jpy','uyu','ves','pen','crc','bob','nio','pyg','hnl','dof','cad','aud','chf']);
    const m = t.match(pairRe);
    const wantsPrice = /(precio|cotizaci[oó]n|cu[aá]nto\s+vale|en\s+cu[aá]nto)/i.test(raw);
    const wantsNews = /(noticias|titulares|últimas\s+noticias|ultimas\s+noticias)/i.test(t) || /(hoy|24h|\b\d+\s*h\b)/i.test(t);

    // Priorizar NOTICIAS para evitar falsos positivos con pares o palabras como "a"/"en"
    if (wantsNews) {
      let topic = null;
      const q1 = raw.match(/["“”'‘’]([^"“”'‘’]+)["“”'‘’]/);
      if (q1 && q1[1]) topic = q1[1];
      if (!topic) {
        const q2 = raw.match(/noticias(?:\s+de|\s+sobre)?\s+(.+?)(?:\s+hoy|\s+24h|$)/i);
        if (q2 && q2[1]) topic = q2[1].trim();
      }
      topic = topic || raw.replace(/(últimas|ultimas|noticias|hoy|24h|de|sobre|por\s+favor|dame|mu[eé]strame)/gi,'').trim();
      if (topic && topic.length > 1) return { kind: 'news', params: { q: topic } };
    }
    // Si el texto parece una instrucción de datos/tablas, NO activar realtime
    const isDataInstruction = /(media|promedio|calcula(r)?|saca|columna|fila|tabla|hoja|excel|excell|csv|xlsx|nota[s]?|promediar)/i.test(raw);
    if (isDataInstruction) return { kind: null };

    // Cripto (evitar falsos positivos como "cerrada" → "ada" usando límites de palabra)
    const mentionsCoin = /\b(btc|xbt|bitcoin|eth|ethereum|solana|sol|doge|dogecoin|cardano|ada|bnb|binancecoin|xrp|ripple|matic|matic\-network)\b/i.test(raw);
    if (mentionsCoin && (wantsPrice || m)) {
      let asset = 'bitcoin';
      for (const k of Object.keys(COIN_MAP)) {
        if (new RegExp(`\\b${k}\\b`, 'i').test(raw) || new RegExp(`\\b${COIN_MAP[k]}\\b`, 'i').test(raw)) { asset = COIN_MAP[k]; break; }
      }
      let vs = 'usd';
      if (m) {
        const left = m[1];
        const right = (m[2] || '').toLowerCase();
        if (COIN_MAP[left]) asset = COIN_MAP[left];
        if (ALLOWED_VS.has(right)) vs = right; // evita confundir "a hora"/"ahora" con divisa
      } else {
        const vsM = raw.match(/\b(en|a)\s+([a-z]{3})\b/i);
        if (vsM && ALLOWED_VS.has(vsM[2].toLowerCase())) vs = vsM[2].toLowerCase();
      }
      return { kind: 'crypto', params: { asset, vs } };
    }
    // Fiat (sin usar m directamente para evitar falsos positivos)
    if (!isDataInstruction && (/(tipo\s+de\s+cambio|cambio|cu[aá]nto\s+est[aá]|precio\s+del\s+d[oó]lar|d[oó]lar\s+en|\b(euro|eur)\b[^\n]*\b(d[oó]lar|usd)\b|\b(d[oó]lar|usd)\b[^\n]*\b(euro|eur)\b)/i.test(raw) || /\b([a-z]{3})\s*(?:\/|en|a)\s*([a-z]{3})\b/i.test(raw))) {
      const fxM = raw.match(/\b([a-z]{3})\s*(?:\/|en|a)\s*([a-z]{3})\b/i);
      if (fxM) {
        const base = fxM[1].toUpperCase();
        const vs = fxM[2].toUpperCase();
        if (ALLOWED_VS.has(base.toLowerCase()) && ALLOWED_VS.has(vs.toLowerCase())) {
          console.log('[detectRealtimeIntent][fiat] patternMatch', { base, vs });
          return { kind: 'fiat', params: { base, vs } };
        }
      }
      // Soportar frases como "¿cuánto está el euro en dólares?"
      if (/cu[aá]nto\s+est[aá]/i.test(raw) && /\ben\b/i.test(raw)) {
        const hasEuro = /(\beuro(s)?\b|\beur\b)/i.test(raw);
        const hasUsd = /(\bd[oó]lar(es)?\b|\busd\b)/i.test(raw);
        if (hasEuro && hasUsd) {
          console.log('[detectRealtimeIntent][fiat] phraseMatch EUR->USD');
          return { kind: 'fiat', params: { base: 'EUR', vs: 'USD' } };
        }
      }
    }
    return { kind: null };
  }

  async function respondCrypto(asset, vs) {
    try {
      const PORT = process.env.PORT || 10000;
      const r = await fetch(`http://localhost:${PORT}/api/price/crypto?asset=${encodeURIComponent(asset)}&vs=${encodeURIComponent(vs)}`);
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.message || 'No disponible');
      const tsStr = formatUtcTime(j.ts);
      const pair = `${(asset || '').toUpperCase()} / ${(vs || '').toUpperCase()}`;
      const text = `${pair}: ${j.price} ${vs.toUpperCase()}\n\nFuente: ${j.source || 'CoinGecko'}, ${tsStr}`;
      return res.json({ respuesta: text, intent: 'price.crypto', data: { asset: j.asset, vs: j.vs, price: j.price }, fuente: j.source || 'CoinGecko', ts: j.ts });
    } catch (e) {
      try {
        // Fallback directo a CoinGecko
        const id = String(asset || 'bitcoin').toLowerCase();
        const qvs = String(vs || 'usd').toLowerCase();
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(qvs)}`;
        const rr = await fetchWithTimeoutAndRetry(url, { headers: { 'Accept': 'application/json' } }, DEFAULT_TIMEOUT_MS, 0);
        const jj = await rr.json().catch(() => null);
        if (rr.ok && jj && jj[id] && typeof jj[id][qvs] !== 'undefined') {
          const payload = { success: true, asset: id, vs: qvs, price: jj[id][qvs], source: 'CoinGecko', ts: Date.now() };
          setCache(`crypto:${id}:${qvs}`, payload);
          const tsStr = formatUtcTime(payload.ts);
          const pair = `${String(asset).toUpperCase()} / ${String(vs).toUpperCase()}`;
          const text = `${pair}: ${payload.price} ${String(vs).toUpperCase()}\n\nFuente: ${payload.source}, ${tsStr}`;
          return res.json({ respuesta: text, intent: 'price.crypto', data: { asset: payload.asset, vs: payload.vs, price: payload.price }, fuente: payload.source, ts: payload.ts });
        }
        const fallback = getCache(`crypto:${String(asset).toLowerCase()}:${String(vs).toLowerCase()}`);
        if (fallback && fallback.success) {
          const tsStr = formatUtcTime(fallback.ts);
          const pair = `${String(asset).toUpperCase()} / ${String(vs).toUpperCase()}`;
          const text = `${pair}: ${fallback.price} ${String(vs).toUpperCase()}\n\nFuente: ${fallback.source || 'CoinGecko'}, ${tsStr}`;
          return res.json({ respuesta: text, intent: 'price.crypto', data: { asset: fallback.asset, vs: fallback.vs, price: fallback.price }, fuente: fallback.source || 'CoinGecko', ts: fallback.ts });
        }
      } catch {}
      return res.json({ respuesta: 'No pude obtener el precio cripto ahora mismo. Intenta de nuevo en unos segundos.' });
    }
  }

  async function respondFiat(base, vs) {
    try {
      const PORT = process.env.PORT || 10000;
      console.log('[respondFiat] start', { base, vs });
      const r = await fetch(`http://localhost:${PORT}/api/price/fiat?base=${encodeURIComponent(base)}&vs=${encodeURIComponent(vs)}`);
      const j = await r.json();
      if (!r.ok || !j.success) { console.warn('[respondFiat] internal endpoint failed', { status: r.status, body: j }); throw new Error(j.message || 'No disponible'); }
      const tsStr = formatUtcTime(j.ts);
      const pair = `${(base || '').toUpperCase()} / ${(vs || '').toUpperCase()}`;
      const text = `${pair}: ${j.rate} ${vs.toUpperCase()}\n\nFuente: ${j.source || 'exchangerate.host'}, ${tsStr}`;
      return res.json({ respuesta: text, intent: 'price.fiat', data: { base: j.base, vs: j.vs, rate: j.rate }, fuente: j.source || 'exchangerate.host', ts: j.ts });
    } catch (e) {
      console.error('[respondFiat] error', e && e.message);
      try {
        // Fallback directo a exchangerate.host
        const b = String(base || 'USD').toUpperCase();
        const qvs = String(vs || 'EUR').toUpperCase();
        const url = `https://api.exchangerate.host/latest?base=${encodeURIComponent(b)}&symbols=${encodeURIComponent(qvs)}`;
        const rr = await fetchWithTimeoutAndRetry(url, {}, DEFAULT_TIMEOUT_MS, 0);
        const jj = await rr.json().catch(() => null);
        if (rr.ok && jj && jj.rates && typeof jj.rates[qvs] !== 'undefined') {
          console.log('[respondFiat] fallback latest ok');
          const payload = { success: true, base: b, vs: qvs, rate: jj.rates[qvs], source: 'exchangerate.host', ts: Date.now() };
          setCache(`fiat:${b}:${qvs}`, payload);
          const tsStr = formatUtcTime(payload.ts);
          const pair = `${b} / ${qvs}`;
          const text = `${pair}: ${payload.rate} ${qvs}\n\nFuente: ${payload.source}, ${tsStr}`;
          return res.json({ respuesta: text, intent: 'price.fiat', data: { base: payload.base, vs: payload.vs, rate: payload.rate }, fuente: payload.source, ts: payload.ts });
        }
        // Segundo intento: endpoint convert
        const url2 = `https://api.exchangerate.host/convert?from=${encodeURIComponent(b)}&to=${encodeURIComponent(qvs)}`;
        const rr2 = await fetchWithTimeoutAndRetry(url2, {}, DEFAULT_TIMEOUT_MS, 0);
        const jj2 = await rr2.json().catch(() => null);
        if (rr2.ok && jj2 && typeof jj2.result === 'number') {
          console.log('[respondFiat] fallback convert ok');
          const payload = { success: true, base: b, vs: qvs, rate: jj2.result, source: 'exchangerate.host', ts: Date.now() };
          setCache(`fiat:${b}:${qvs}`, payload);
          const tsStr = formatUtcTime(payload.ts);
          const pair = `${b} / ${qvs}`;
          const text = `${pair}: ${payload.rate} ${qvs}\n\nFuente: ${payload.source}, ${tsStr}`;
          return res.json({ respuesta: text, intent: 'price.fiat', data: { base: payload.base, vs: payload.vs, rate: payload.rate }, fuente: payload.source, ts: payload.ts });
        }
        const fallback = getCache(`fiat:${String(base).toUpperCase()}:${String(vs).toUpperCase()}`);
        if (fallback && fallback.success) {
          console.log('[respondFiat] using cache');
          const tsStr = formatUtcTime(fallback.ts);
          const pair = `${String(base).toUpperCase()} / ${String(vs).toUpperCase()}`;
          const text = `${pair}: ${fallback.rate} ${String(vs).toUpperCase()}\n\nFuente: ${fallback.source || 'exchangerate.host'}, ${tsStr}`;
          return res.json({ respuesta: text, intent: 'price.fiat', data: { base: fallback.base, vs: fallback.vs, rate: fallback.rate }, fuente: 'exchangerate.host', ts: fallback.ts });
        }
      } catch {}
      return res.json({ respuesta: 'No pude obtener el tipo de cambio ahora mismo. Intenta de nuevo en unos segundos.' });
    }
  }

  async function respondNews(q) {
    try {
      const PORT = process.env.PORT || 10000;
      const r = await fetch(`http://localhost:${PORT}/api/news?q=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.message || 'No disponible');
      const tsStr = formatUtcTime(j.ts || Date.now());
      if (!Array.isArray(j.results) || j.results.length === 0) {
        return res.json({ respuesta: `No encontré noticias recientes para "${q}".`, intent: 'news', data: { query: q, results: [] }, fuente: 'Google News RSS', ts: j.ts || Date.now() });
      }
      const list = j.results.slice(0,5).map((it, i) => `${i+1}. ${it.title} — ${it.link}`).join('\n');
      const text = `Últimas noticias sobre "${q}":\n\n${list}\n\nFuente: Google News RSS, ${tsStr}`;
      return res.json({ respuesta: text, intent: 'news', data: { query: q, results: j.results }, fuente: 'Google News RSS', ts: j.ts || Date.now() });
    } catch (e) {
      try {
        const fallback = getCache(`news:es-419:US:es-419:${String(q).trim()}`);
        if (fallback && fallback.success) {
          const list = (fallback.results || []).slice(0,5).map((it, i) => `${i+1}. ${it.title} — ${it.link}`).join('\n');
          const tsStr = formatUtcTime(fallback.ts || Date.now());
          const text = `Últimas noticias sobre "${q}":\n\n${list}\n\nFuente: Google News RSS, ${tsStr}`;
          return res.json({ respuesta: text, intent: 'news', data: { query: q, results: fallback.results }, fuente: 'Google News RSS', ts: fallback.ts || Date.now() });
        }
        // Fallback directo a Google News RSS desde aquí si el endpoint interno falló
        const hl = 'es-419';
        const ceid = 'US:es-419';
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(String(q).trim())}&hl=${encodeURIComponent(hl)}&gl=US&ceid=${encodeURIComponent(ceid)}`;
        const rr = await fetchWithTimeoutAndRetry(url, {}, DEFAULT_TIMEOUT_MS, 0);
        const xml = await rr.text();
        const items = Array.from(xml.matchAll(/<item>[\s\S]*?<\/item>/g)).map(m => m[0]);
        const parsed = items.slice(0, 10).map(x => ({
          title: (x.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || x.match(/<title>(.*?)<\/title>/) || [,''])[1],
          link: (x.match(/<link>(.*?)<\/link>/) || [,''])[1],
          pubDate: (x.match(/<pubDate>(.*?)<\/pubDate>/) || [,''])[1]
        })).filter(i => i.link);
        if (parsed.length > 0) {
          const payload = { success: true, query: q, results: parsed, source: 'Google News RSS', ts: Date.now() };
          setCache(`news:${hl}:${ceid}:${String(q).trim()}`, payload);
          const list = parsed.slice(0,5).map((it, i) => `${i+1}. ${it.title} — ${it.link}`).join('\n');
          const tsStr = formatUtcTime(payload.ts);
          const text = `Últimas noticias sobre "${q}":\n\n${list}\n\nFuente: Google News RSS, ${tsStr}`;
          return res.json({ respuesta: text, intent: 'news', data: { query: q, results: parsed }, fuente: 'Google News RSS', ts: payload.ts });
        }
      } catch {}
      return res.json({ respuesta: 'No pude obtener noticias en este momento. Intenta de nuevo en unos segundos.' });
    }
  }

  try {
    const rt = detectRealtimeIntent(pregunta);
    if (rt.kind === 'crypto') {
      return await respondCrypto(rt.params.asset, rt.params.vs);
    }
    if (rt.kind === 'fiat') {
      return await respondFiat(rt.params.base, rt.params.vs);
    }
    if (rt.kind === 'news') {
      return await respondNews(rt.params.q);
    }
  } catch (_) {}

  // Detectar si es una solicitud de exportación
  // Si el texto es vacío o solo "?", o si hay acción pendiente de Drive, no intentes exportar: prioriza lectura
  const isEmptyOrQuestionOnly = !String(pregunta || '').trim() || /^\s*\?+\s*$/.test(String(pregunta||''));

  // Evitar conflictos con acciones pendientes (drive.*) cuando el texto es vacío/"?"
  const exportRequest = isEmptyOrQuestionOnly ? { shouldExport: false } : detectExportRequest(pregunta, historial);

  // Heurística: detectar solicitudes que pidan buscar en la web (función robusta)
  // IMPORTANTE: si ya detectamos un intent de conector (gdrive/gmail/etc.), NO activar websearch
  const connectorDetected = false; // Ya consumido arriba; forzar bypass
  // Si estamos ante una solicitud clara de exportación, PRIORIDAD a exportar y desactivar websearch
  const looksLikeExportFollowup = (() => {
    try {
      const t = String(pregunta || '').toLowerCase();
      if (/\b(xlsx|excel|csv|pdf|docx|pptx|power\s*point|presentaci[oó]n|hoja|tabla|planilla)\b/.test(t)) return true;
      if (/\b(lo\s+mismo|los\s+mis?mos|las\s+mis?mas|mismo\s+contenido|misma\s+(tabla|hoja|info|informaci[oó]n))\b/.test(t)) return true;
      return false;
    } catch { return false; }
  })();
  const needsWebSearch = connectorDetected ? false : (looksLikeExportFollowup ? false : shouldWebSearch(pregunta, historial));

  // Si necesita sugerencias, devolverlas como respuesta normal
  if (exportRequest.needsSuggestion) {
    const suggestionMessage = `${exportRequest.message}\n• **PowerPoint (.pptx)** - Para presentaciones\n• **Excel (.xlsx)** - Para datos y cálculos\n• **CSV (.csv)** - Para datos simples\n• **PDF (.pdf)** - Para documentos finales\n\n¿Cuál prefieres?`;

    return res.json({
      response: suggestionMessage
    });
  }

  // Detectar si es una solicitud de imagen SOLO si NO es exportación NI es análisis
  let imageRequest = { shouldGenerate: false };
  if (!exportRequest.shouldExport && !exportRequest.isAnalysis) {
    imageRequest = detectImageRequest(pregunta);
  }

  try {
    // Regla: si el usuario acaba de pedir "solo usa la columna X", y tenemos un análisis de Drive reciente,
    // reutilizar ese contenido y aplicar el filtro solicitado sin pedir subir archivo.
    if (/(\bsolo|\bsólo).*\bcolumna\b|\bno\s+uses.*\bcolumna\b/i.test(String(pregunta||'')) && authUserId) {
      const last = lastDriveAnalyzeByUser.get(authUserId);
      if (last && last.fullText && last.fullText.trim()) {
        console.log('[Drive][followup-columns] detected, using cached text len=', last.fullText.length, 'file=', last.file?.name);
        const t = String(pregunta||'').toLowerCase();
        const excludeLineCol = /no\s+uses\s+los?\s+n[uú]meros?\s+de\s+la\s+columna\s+l[ií]nea/.test(t) || /no\s+uses\s+la\s+columna\s+l[ií]nea/.test(t);
        const onlyColMatch = t.match(/solo\s+usa\s+la\s+columna\s+([a-z0-9_]+)/);
        const lines = last.fullText.split(/\r?\n/).filter(Boolean);
        // CSV simple: primera línea cabeceras
        let values = [];
        try {
          const sep = /\t/.test(lines[0]||'') ? /\t/ : /,|;/;
          const headers = (lines[0] || '').split(sep).map(s=>s.trim().toLowerCase());
          const idxLinea = headers.findIndex(h => /linea|línea/.test(h));
          const idxNota = headers.findIndex(h => /nota(s)?|calif(icaci[oó]n)?|puntuaci[oó]n|puntaje|puntos/.test(h));
          let targetIdx = idxNota >= 0 ? idxNota : (onlyColMatch ? headers.findIndex(h => h === onlyColMatch[1]) : -1);
          if (excludeLineCol && idxLinea >= 0 && targetIdx === -1) {
            // Si piden excluir columna línea y no especifican cuál usar, intenta usar "nota"
            targetIdx = idxNota;
          }
          // Si hay solo dos columnas y una es "línea", usar la otra
          if (targetIdx === -1 && headers.length === 2 && idxLinea !== -1) {
            targetIdx = idxLinea === 0 ? 1 : 0;
          }
          // Fallback: elegir la primera columna numérica que NO sea "línea"
          if (targetIdx === -1) {
            let bestIdx = -1; let bestCount = -1;
            for (let j = 0; j < headers.length; j++) {
              if (j === idxLinea) continue;
              let count = 0;
              for (let i = 1; i < Math.min(lines.length, 100); i++) {
                const cols = (lines[i] || '').split(sep);
                const raw = (cols[j] || '').toString().replace(/\"/g,'').trim();
                if (/^[-+]?\d+(?:[\.,]\d+)?$/.test(raw)) count++;
              }
              if (count > bestCount) { bestCount = count; bestIdx = j; }
            }
            if (bestIdx >= 0 && bestCount >= 1) targetIdx = bestIdx;
          }
          console.log('[Drive][followup-columns] headers=', headers, 'idxLinea=', idxLinea, 'idxNota=', idxNota, 'targetIdx=', targetIdx);
          if (targetIdx >= 0) {
            // Parseo tolerante: extrae el primer número plausible de la celda
            const parseFlexibleNumber = (cell) => {
              const raw = (cell || '').toString().replace(/\"/g,'').trim();
              const match = raw.match(/[-+]?\d+(?:[.,]\d+)?/);
              if (!match) return NaN;
              const normalized = match[0].replace(',', '.');
              const n = parseFloat(normalized);
              return Number.isFinite(n) ? n : NaN;
            };
            for (let i = 1; i < lines.length; i++) {
              const cols = lines[i].split(sep);
              const n = parseFlexibleNumber(cols[targetIdx]);
              if (Number.isFinite(n)) values.push(n);
            }
          } else {
            // Súper-fallback: usar todos los números de columnas distintas a "línea"
            const parseFlexibleNumber = (cell) => {
              const raw = (cell || '').toString().replace(/\"/g,'').trim();
              const match = raw.match(/[-+]?\d+(?:[.,]\d+)?/);
              if (!match) return NaN;
              const normalized = match[0].replace(',', '.');
              const n = parseFloat(normalized);
              return Number.isFinite(n) ? n : NaN;
            };
            for (let i = 1; i < lines.length; i++) {
              const cols = lines[i].split(sep);
              for (let j = 0; j < cols.length; j++) {
                if (j === idxLinea) continue;
                const n = parseFlexibleNumber(cols[j]);
                if (Number.isFinite(n)) values.push(n);
              }
            }
          }
          console.log('[Drive][followup-columns] extracted values=', values.length);
          if (values.length > 0) {
            const avg = values.reduce((a,b)=>a+b,0) / values.length;
            return res.json({ respuesta: `Promedio de ${values.length} valores en "${last.file?.name || 'archivo'}": ${avg}` });
          }
        } catch {}
        // Si no se pudo parsear, continúa con flujo normal
      }
    }

    // Confirmación corta ("sí/hazlo") tras una instrucción de media en el historial → usa el último análisis de Drive
    if (/^\s*(s[ií]|ok|dale|hazlo|contin[uú]a|de\s+acuerdo)\b/i.test(String(pregunta||'')) && authUserId) {
      try {
        const last = lastDriveAnalyzeByUser.get(authUserId);
        if (last && last.fullText && last.fullText.trim() && Array.isArray(historial)) {
          const recentUserText = [...historial].reverse().slice(0,6).map(m => String(m.content||'').toLowerCase());
          const hadAvgIntent = recentUserText.some(t => /(media|promedio)\b/.test(t));
          if (hadAvgIntent) {
            const lines = last.fullText.split(/\r?\n/).filter(Boolean);
            const sep = /\t/.test(lines[0]||'') ? /\t/ : /,|;/;
            const headers = (lines[0] || '').split(sep).map(s=>s.trim().toLowerCase());
            const idxLinea = headers.findIndex(h => /linea|línea/.test(h));
            // Preferir columna nota/calificación
            let idxNota = headers.findIndex(h => /nota|calif(icaci[oó]n)?|puntuaci[oó]n/.test(h));
            if (idxNota < 0) {
              // fallback: primera columna numérica que no sea "línea"
              for (let j=0;j<headers.length;j++) {
                if (j === idxLinea) continue;
                const sample = (lines[1]||'').split(sep)[j] || '';
                if (/^\s*[-+]?\d+(?:[\.,]\d+)?\s*$/.test(String(sample))) { idxNota = j; break; }
              }
            }
            if (idxNota >= 0) {
              const values = [];
              for (let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(sep);
                if (idxLinea >= 0 && i === 1 && /^\s*linea|línea\s*$/i.test(headers[idxLinea]||'')) {
                  // ya excluimos por índice; no usar
                }
                const raw = (cols[idxNota] || '').toString().replace(/\"/g,'').trim();
                const num = parseFloat(raw.replace(',','.'));
                if (Number.isFinite(num)) values.push(num);
              }
              if (values.length > 0) {
                const avg = values.reduce((a,b)=>a+b,0) / values.length;
                return res.json({ respuesta: `Promedio de ${values.length} valores en "${last.file?.name || 'archivo'}": ${avg}` });
              }
            }
          }
        }
      } catch {}
    }
    // Si requiere búsqueda web, obtener contexto y prepender al system
    let webContext = '';
    let webPrettyForFallback = null;
    const preSystemMessages = [];
    if (needsWebSearch) {
      const desired = extractDesiredCountFromText(pregunta, 5);
      const baseQuery = isBareConfirmation(pregunta) ? (extractQueryFromHistory(historial) || pregunta) : pregunta;
      const q = buildWebQueryFromText(baseQuery);
      const forcedSimple = String(req.headers['x-websearch-mode'] || '').toLowerCase() === 'simple' || isLinkOnlyRequest(pregunta);
      let primaryQuery = q;
      // Heurística especial: rankings por año
      if (isRankingQuery(baseQuery)) {
        const year = (baseQuery.match(/(20\d{2})/) || [,''])[1] || '';
        const mediaBoost = '(site:theverge.com OR site:techradar.com OR site:wired.com OR site:theguardian.com OR site:nytimes.com OR site:reuters.com)';
        primaryQuery = `${q} ${year ? `intitle:${year}` : ''} (ranking OR mejores OR top) ${mediaBoost}`.trim();
      }
      const s = await webSearchGoogle(primaryQuery, { count: Math.max(desired, 5) });
      if (s && s.success) {
        if (forcedSimple && s.raw && Array.isArray(s.raw.items)) {
          const top = s.raw.items.slice(0, desired).map((it, i) => `${i + 1}. ${it.title || it.link} — ${it.link}`);
          const pretty = top.join('\n');
          return res.json({ respuesta: pretty, intent: 'websearch.simple', data: { results: s.raw.items.slice(0, desired).map(it => ({ title: it.title, url: it.link })) } });
        }
        if (s.results && s.results.length > 0) {
        let pipeline = excludeSocialUnlessRequested(pregunta, s.results);
        pipeline = filterBadHosts(pipeline, pregunta);
        pipeline = rankAndFilterResults(pregunta, pipeline);
        pipeline = filterByRelevance(pipeline, extractCoreTokens(pregunta));
        const validated = await validateUrls(pipeline, desired);
          if (!validated || validated.length === 0) {
            const items = Array.isArray(s.raw?.items) ? s.raw.items.slice(0, desired) : s.results.slice(0, desired);
            const pretty = items.map((it, i) => `${i + 1}. ${(it.title || it.name || it.url)} — ${(it.link || it.url)}`).join('\n');
            return res.json({ respuesta: pretty, intent: 'websearch.simple', data: { results: items.map(it => ({ title: it.title || it.name, url: it.link || it.url })) } });
          }
            pipeline = validated;
        webContext = formatSearchResultsForPrompt(pipeline);
        const pretty = formatResultsForChat(pipeline, q, desired);
        webPrettyForFallback = pretty;
        if (isLinkOnlyRequest(pregunta)) {
            return res.json({ respuesta: pretty, intent: 'websearch.simple', data: { results: pipeline.map((r) => ({ title: r.name, url: r.url })) } });
        }
        if (!OPENAI_API_KEY) {
            return res.json({ respuesta: pretty, intent: 'websearch.simple', data: { results: pipeline.map((r) => ({ title: r.name, url: r.url })) } });
        }
        preSystemMessages.push({ role: 'system', content: `Contexto de enlaces para citar en la respuesta:\n${pretty}` });
        }
      }
    }

    // Construir el array de mensajes para OpenAI
    let messages = [];
    let systemContent = [
      'Eres Skanea, un asistente de IA inteligente y versátil.',
      'Cuando te pregunten quién eres o qué puedes hacer, responde con entusiasmo mencionando tus capacidades principales:',
      '- Análisis de archivos: PDFs, DOCX, XLSX, CSV, TXT, imágenes',
      '- Generación de archivos: PDF, DOCX, PPTX, XLSX, CSV, TXT',
      '- Programación y código en múltiples lenguajes',
      '- Matemáticas con LaTeX',
      '- Escritura creativa y análisis de textos',
      '- Búsqueda web y consulta de fuentes',
      'TIENES LA CAPACIDAD COMPLETA DE LEER Y ANALIZAR ARCHIVOS: PDFs, documentos Word (DOCX), hojas Excel (XLSX), archivos CSV, archivos de texto (TXT) e imágenes.',
      'Cuando un usuario sube archivos, puedes ver y acceder a todo su contenido extraído. Analiza, resume, responde preguntas y ayuda basándote en el contenido de los archivos.',
      'Si el usuario pide código, SIEMPRE devuelve los fragmentos dentro de bloques de código con triple comilla invertida (```), indicando el lenguaje (por ejemplo ```java).',
      'Cuando el usuario solicite matemáticas, usa notación LaTeX en línea \\(...\\) y en bloque \\[...\\] para fórmulas. Evita imágenes; devuelve el LaTeX como texto.',
      'Sé útil, preciso y creativo en tus respuestas.'
    ];

    // Si el usuario pidió buscar, refuerza el comportamiento del modelo para no negar capacidad
    if (needsWebSearch) {
      systemContent.push(
        'TIENES CAPACIDAD DE USAR BÚSQUEDA WEB a través de un conector. Cuando el usuario diga "busca", "investiga" o pida URLs/fuentes, NO digas que no puedes navegar. Devuelve el número de enlaces solicitado y cita las fuentes. Si el usuario dice "solo URLs", responde únicamente con la lista de enlaces, uno por línea, sin texto adicional.'
      );
    }

    if (webContext) {
      systemContent.push('Cuando haya contexto de búsqueda web disponible, úsalo para responder; cita las fuentes entre paréntesis con su URL. Si existen discrepancias, indícalas.');
      systemContent.push(webContext);
    }

    // Función para validar y limpiar texto OCR
    const validateOCRText = (text) => {
      if (!text || typeof text !== 'string') return text;
      // Mucho más permisivo: preferimos conservar el texto para que el modelo lo interprete
      // Considerar “válido” si hay cualquier letra/numero/puntuación básica
      const trimmed = String(text).trim();
      if (!trimmed) return text;
      // Si contiene signos de matemáticas, dígitos o palabras clave, aceptar siempre
      if (/(raiz|raíz|sqrt|√|cuadrad|\d|\+|\-|\*|\/|\^|\(|\)|\?|¡|¿)/i.test(trimmed)) return trimmed;
      // Solo en casos extremos de puro ruido (muy largo y sin espacios) sugerir mejora; en los demás, devolver tal cual
      const isExtreme = /[A-Za-z]{80,}/.test(trimmed) && !/\s/.test(trimmed);
      if (isExtreme) {
        console.log('[OCR VALIDATION] Texto OCR extremadamente compacto; devolviendo sin bloquear');
      }
      return trimmed;
    };

    // Refuerzo global si hay contexto OCR en la pregunta o el historial
    // Solo considerar mensajes del usuario para evitar contaminar con respuestas previas del asistente
    const joinedHistory = Array.isArray(historial) ? historial.filter(m => m && m.role === 'user').map(m => String(m.content || '')).join('\n\n') : '';
    const ocrMarkersRe = /\[(ARCHIVO\s+ADJUNTO|ARCHIVO\s+RECIENTE)[^\]]*\]/i;
    const hasOcrMarkers = ocrMarkersRe.test(pregunta) || ocrMarkersRe.test(joinedHistory);

    // Validar y limpiar contenido OCR en el historial
    if (hasOcrMarkers && Array.isArray(historial)) {
      historial.forEach(msg => {
        if (msg.content && typeof msg.content === 'string') {
          const originalContent = msg.content;
          msg.content = msg.content.replace(/\[(ARCHIVO\s+ADJUNTO[^\]]*)\]([^[]*)/gi, (match, header, content) => {
            const cleanedContent = validateOCRText(content);
            return `[${header}]${cleanedContent}`;
          });
          if (originalContent !== msg.content) {
            console.log('[OCR VALIDATION] Contenido OCR limpiado en historial');
          }
        }
      });
    }

    if (hasOcrMarkers) {
      console.log('[OCR MARKERS] detectados en el prompt del usuario. Se instruye al modelo a usar el texto extraído.');
      systemContent.push(
        'Cuando veas etiquetas como [ARCHIVO ADJUNTO] o [ARCHIVO RECIENTE], trátalas como texto extraído de imágenes/documentos. Responde sobre ese contenido directamente. Evita frases como "no pude extraer el texto" salvo que realmente esté vacío; si no hay texto utilizable, pide una imagen más clara. No infieras números ni asumas cálculos si no aparecen explícitamente.'
      );
    }


    // Si el texto del usuario es vacío o solo signos de interrogación y hay marcadores de adjuntos en historial,
    // fuerza instrucción explícita para analizar adjuntos como fuente principal.
    const isEmptyOrQuestionOnly = !String(pregunta || '').trim() || /^\s*\?+\s*$/.test(String(pregunta||''));
    if (isEmptyOrQuestionOnly && hasOcrMarkers) {
      // Sin forzar escenarios de raíz ni pedir números: deja que el modelo interprete el contenido extraído
    }

    // Si los adjuntos traen detecciones de UI (opción seleccionada), pídele al modelo que las use.
    systemContent.push(
      'Si el contexto incluye información de interfaz (por ejemplo, opción seleccionada detectada en la imagen), utilízala para responder directamente preguntas como "¿cuál respuesta está seleccionada?" o "¿qué opción marcada se ve?" y devuélvela claramente.'
    );

    // Si es una solicitud de exportación, agregar instrucciones específicas
    if (exportRequest.shouldExport) {
      if (exportRequest.isFormatResponse) {
        // Es una respuesta a una sugerencia de formato, usar historial para obtener la solicitud original
        systemContent = [
          'Eres un asistente inteligente que responde en español.',
          'El usuario ha elegido un formato para generar un archivo que había solicitado anteriormente.',
          'Basándote en la conversación anterior, genera ÚNICAMENTE el contenido que irá dentro del archivo.',
          'IMPORTANTE: NO incluyas saludos, explicaciones o menciones sobre crear archivos.',
          'SOLO proporciona el contenido puro y completo que debe ir en el archivo solicitado.',
          'El contenido debe ser detallado, bien estructurado y apropiado para el formato elegido.',
          'Ejemplo: Si anteriormente pidió datos de estudiantes y ahora eligió Excel, genera los datos en formato de tabla.'
        ];
      } else {
      systemContent = [
        'Eres un asistente inteligente que responde en español.',
        'El usuario ha solicitado generar contenido para un archivo. Tu tarea es generar ÚNICAMENTE el contenido que irá dentro del archivo.',
        'IMPORTANTE: NO incluyas saludos, explicaciones o menciones sobre crear archivos.',
        'SOLO proporciona el contenido puro y completo que debe ir en el archivo solicitado.',
        'El contenido debe ser detallado, bien estructurado y apropiado para el formato solicitado.',
        'Ejemplo: Si piden un resumen de Blancanieves, solo escribe el resumen completo, nada más.'
      ];
      }
    }

    // Instrucción de identidad neutra para cualquier modelo
    systemContent.push(
      'IDENTIDAD: No te presentes como ChatGPT, OpenAI, Mistral u otro proveedor. Preséntate como Skanea o como un asistente de IA de Skanea. Evita mencionar marcas/modelos salvo que el usuario lo pida explícitamente.'
    );

    // Si es una solicitud de imagen, agregar instrucciones específicas
    if (imageRequest.shouldGenerate) {
      systemContent = [
        'Eres un asistente inteligente que responde en español.',
        'IDENTIDAD: No te presentes como ChatGPT, OpenAI, Mistral u otro proveedor. Preséntate como Skanea o como un asistente de IA de Skanea. Evita mencionar marcas/modelos salvo que el usuario lo pida explícitamente.',
        'TIENES LA CAPACIDAD COMPLETA DE GENERAR IMÁGENES usando IA.',
        'Cuando el usuario solicite una imagen, foto, dibujo o ilustración, confirma que puedes hacerlo.',
        'Puedes generar imágenes de cualquier tema: personas, animales, paisajes, objetos, conceptos abstractos, etc.',
        'Responde de manera entusiasta confirmando que crearás la imagen solicitada.',
        'Ejemplo: "¡Por supuesto! Voy a generar esa imagen para ti."',
        'NUNCA digas que no puedes generar imágenes. SIEMPRE confirma que sí puedes hacerlo.'
      ];
    }

    // Verificar si el frontend envió un system prompt (instrucciones de formato)
    let historialToUse = Array.isArray(historial) ? [...historial] : [];
    const frontendHasSystemPrompt = historialToUse.length > 0 && historialToUse[0]?.role === 'system';

    // SIEMPRE usar el system prompt completo de Skanea
    let finalSystemContent = systemContent.join(' ');

    // Si el frontend envió instrucciones de formato, AGREGARLAS al system prompt de Skanea
    if (frontendHasSystemPrompt) {
      const frontendInstructions = historialToUse[0].content;
      finalSystemContent = finalSystemContent + ' ' + frontendInstructions;
      // Remover el system prompt del frontend del historial para evitar duplicación
      historialToUse = historialToUse.slice(1);
    }

    messages.push({
      role: 'system',
      content: finalSystemContent
    });

    // inyectar mensajes de sistema generados por la búsqueda ANTES del historial
    if (preSystemMessages.length > 0) {
      messages.push(...preSystemMessages);
    }

    if (historialToUse.length > 0) {
      // Usar el historial enviado por el frontend
      // Normalizar escapes de LaTeX para que lleguen como una sola barra
      messages = messages.concat(historialToUse.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: typeof m.content === 'string' ? m.content.replace(/\\\\/g, '\\') : m.content
      })));
    }

    // SIEMPRE agregar la pregunta actual al final (sea con historial o sin él)
    messages.push({ role: 'user', content: pregunta });

    // Si se prefiere modelo local (override), recortar mensajes y simplificar sistema para acelerar
    if (preferLocalModel) {
      try {
        const sysIdx = messages.findIndex((m) => m.role === 'system');
        if (sysIdx >= 0) {
          messages[sysIdx] = { role: 'system', content: 'Eres un asistente que responde en español de forma breve y útil.' };
        }
        const head = sysIdx >= 0 ? [messages[sysIdx]] : [];
        const tail = messages
          .filter((_, i) => i !== sysIdx)
          .filter((m) => m.role !== 'system')
          .slice(-6);
        messages = head.concat(tail);
      } catch {}
    }

    // Señal explícita al modelo cuando la petición es SOLO URLs (para evitar prosa)
    if (needsWebSearch && isLinkOnlyRequest(pregunta)) {
      messages.push({ role: 'system', content: 'RESUELVE CON SOLO URLs, una por línea, sin descripciones.' });
    }
    // Enrutar a proveedor local o cloud manteniendo la interfaz
    let aiResponse = '';
    let aiProvider = null;
    let aiModel = null;
    let aiFinishReason = null;
    let aiTokensUsed = null;
    const replyCfg = selectReplyConfig(req, preferLocalModel);
    const maxTokensWanted = replyCfg.maxTokensWanted;
    const temperatureWanted = replyCfg.temperatureWanted;
    const continueMaxAttempts = replyCfg.continueMaxAttempts;

    const tAI = Date.now();
    try {
      const override = String(req.headers['x-model-override'] || '').trim();
      const routed = await sendChatRouted({ userId: authUserId, messages, options: { temperature: temperatureWanted, overrideModel: override || undefined, maxTokens: maxTokensWanted } });
      aiResponse = routed?.content || '';
      aiFinishReason = routed?.finish_reason || null;
      aiTokensUsed = routed?.tokens_used || null;
      // Anotar meta mínima para depurar proveedor/modelo
      if (routed && (routed.provider || routed.model)) {
        aiProvider = String(routed.provider || '');
        aiModel = String(routed.model || '');
        res.setHeader('x-ai-provider', aiProvider);
        res.setHeader('x-ai-model', aiModel);
        if (routed.latencyMs) res.setHeader('x-ai-latency-ms', String(routed.latencyMs));
      }
    } catch (e) {
      console.error('[IA Router] error:', e && e.message);
      if (e && e.requestUrl) console.error('→ URL:', e.requestUrl);
      if (e && e.headers) console.error('→ Headers:', JSON.stringify(e.headers));
      if (e && e.requestPayload) console.error('→ Payload:', JSON.stringify(e.requestPayload).slice(0, 2000));
      // Fallback rápido a cloud si local no responde y tenemos API key
      try {
        const override = String(req.headers['x-model-override'] || '').trim();
        const wantedLocal = override && !override.toLowerCase().startsWith('cloud:');
        if (wantedLocal && process.env.OPENAI_API_KEY) {
          const { sendChatRouted } = await import('./services/ai/router.js');
          const routed = await sendChatRouted({ userId: authUserId, messages, options: { temperature: temperatureWanted, overrideModel: 'cloud:o3', maxTokens: maxTokensWanted } });
          aiResponse = routed?.content || '';
          aiProvider = routed?.provider || 'cloud';
          aiModel = routed?.model || 'o3';
          aiFinishReason = routed?.finish_reason || null;
          aiTokensUsed = routed?.tokens_used || null;
          res.setHeader('x-ai-provider', aiProvider);
          res.setHeader('x-ai-model', aiModel);
          return res.json({ respuesta: aiResponse, provider: aiProvider, model: aiModel });
        }
      } catch {}
      if (needsWebSearch && webPrettyForFallback) {
        return res.json({ respuesta: webPrettyForFallback, intent: 'websearch.simple' });
      }
      return res.status(500).send('No se pudo obtener respuesta de IA.');
    }

    // Auto-continuación en servidor si la respuesta parece truncada o finish_reason ≠ stop
    let continued = false;
    let parts = 1;
    try {
      let flags = deriveTruncationFlags(aiResponse, aiFinishReason);
      const override = String(req.headers['x-model-override'] || '').trim();
      let attempts = 0;
      while ((flags.truncated || aiFinishReason && String(aiFinishReason).toLowerCase() !== 'stop') && attempts < continueMaxAttempts) {
        attempts++;
        continued = true;
        // Construir mensajes de continuación
        const contMessages = [];
        for (const m of messages) contMessages.push(m);
        contMessages.push({ role: 'assistant', content: aiResponse });
        contMessages.push({ role: 'user', content: 'Continúa exactamente donde te quedaste. No repitas. Si estabas en un bloque de código, continúa y cierra con ``` al final.' });
        const routed2 = await sendChatRouted({ userId: authUserId, messages: contMessages, options: { temperature: temperatureWanted, overrideModel: override || undefined, maxTokens: maxTokensWanted } });
        const add = routed2?.content || '';
        if (!add || add.trim().length === 0) break;
        aiResponse = mergeNonRepeating(aiResponse, add);
        aiFinishReason = routed2?.finish_reason || aiFinishReason;
        aiTokensUsed = (aiTokensUsed || 0) + (routed2?.tokens_used || 0);
        parts += 1;
        flags = deriveTruncationFlags(aiResponse, aiFinishReason);
        // Si ya no se ve truncado, salir
        if (!flags.truncated) break;
      }
    } catch (e) {
      console.warn('[AI][auto-continue] fallo durante continuación:', e && e.message);
    }
    // Normalización final para seguridad de markdown
    // 1) Demover bloques de código accidentales si la respuesta es lista/enlaces (evita ```python por palabra clave en prompt)
    const hintIsLinks = isLinkOnlyRequest(pregunta) || /\b(enlaces?|links?|urls?|documentaci[oó]n)\b/i.test(String(pregunta||''));
    const dbgEnabled = isDebugMarkdown(req);
    const preLenDbg = aiResponse.length;
    const preHasFenceDbg = /```/.test(aiResponse);
    mdLog(req, 'pre-demote-len', preLenDbg, 'prompt:', String(pregunta||'').slice(0,160));
    aiResponse = demoteAccidentalCodeBlocks(aiResponse, pregunta, hintIsLinks);
    const postLenDbg = aiResponse.length;
    const postHasFenceDbg = /```/.test(aiResponse);
    mdLog(req, 'post-demote-len', postLenDbg, 'openFence:', hasOpenCodeFence(aiResponse));
    // 2) Quitar etiquetas de lenguaje en primera línea (p.ej. "python") si lo que sigue son enlaces/listas
    aiResponse = stripLeadingLanguageLabel(aiResponse);
    // 2.b) En respuestas cuyo objetivo son enlaces/URLs, eliminar cualquier cerca de código restante
    if (hintIsLinks) aiResponse = enforcePlainTextForLinkAnswers(aiResponse, pregunta);
    // 3) Balancear y terminar listas/backslash
    aiResponse = normalizeFinalText(aiResponse);
    const finalFlags = deriveTruncationFlags(aiResponse, 'stop');
    const finalPayloadMeta = {
      text: aiResponse,
      finish_reason: 'stop',
      truncated: finalFlags.truncated === true ? true : false,
      open_code_fence: finalFlags.openFence,
      open_list: finalFlags.openList,
      continued: continued || undefined,
      parts: continued ? parts : undefined,
      complete: !finalFlags.truncated,
      tokens_used: aiTokensUsed || undefined
    };

    // Flag para evitar enviar respuesta duplicada
    let responseSent = false;

    // Si es una solicitud de imagen, generar la imagen
    if (imageRequest.shouldGenerate) {
      try {
        // Generar la imagen usando el servicio de imágenes
        const imageResult = await imageService.generateImage(
          imageRequest.prompt,
          imageRequest.filename,
          conversationId,  // Pasar el ID de la conversación
          autoSaveFiles // Pasar el flag de auto-save
        );

        if (imageResult.success) {
          // 📦 Usar FileMetadata si está disponible
          const metadata = imageResult.metadata;

          // Crear URL de descarga ABSOLUTA
          const PORT = process.env.PORT || 10000;

          // Ahora internalName y displayName son iguales (sin ID)
          // El ID solo se usa para tracking interno
          const filename = metadata ? metadata.displayName : (imageResult.displayName || path.basename(imageResult.filePath));
          const fileId = metadata?.fileId || null;
          // Agregar fileId a la URL para distinguir archivos con mismo nombre en diferentes conversaciones
          const downloadUrl = fileId
            ? `http://localhost:${PORT}/api/download/${filename}?fileId=${fileId}`
            : `http://localhost:${PORT}/api/download/${filename}`;

          // Mensaje personalizado según si auto-save está activado
          let chatResponse;
          const actionWord = autoSaveFiles ? 'abrir' : 'descargar';

          if (imageResult.message.includes('Hugging Face')) {
            chatResponse = `¡Perfecto! He generado una imagen basada en tu descripción: "${imageRequest.prompt}" usando Hugging Face (gratuito). Puedes ver el preview arriba y ${actionWord} la imagen completa usando el botón de abajo.`;
          } else if (imageResult.message.includes('placeholder')) {
            chatResponse = `He creado una imagen placeholder para tu descripción: "${imageRequest.prompt}". Los servicios de IA están temporalmente no disponibles, pero puedes ${actionWord} esta imagen de ejemplo.`;
          } else {
            chatResponse = `¡Perfecto! He generado una imagen basada en tu descripción: "${imageRequest.prompt}". Puedes ver el preview arriba y ${actionWord} la imagen completa usando el botón de abajo.`;
          }

          const archivoResponse = {
            nombre: filename,  // Nombre limpio (sin ID)
            downloadName: filename, // Mismo nombre (sin ID)
            formato: 'IMAGE',
            url: downloadUrl,
            mensaje: imageResult.message,
            filePath: imageResult.filePath,
            preview: imageResult.previewDataUrl,
            width: imageResult.width,
            height: imageResult.height,
            size: imageResult.size,
            isImage: true,
            fileId: metadata?.fileId // ID solo para tracking interno
          };

          // Si auto-save está activado, agregar la ruta local
          // Si está desactivado, la imagen ya está en memoria (buffer)
          let fileBufferForMongo = null;
          if (autoSaveFiles) {
            archivoResponse.localPath = imageResult.filePath;
          } else {
            // La imagen ya está en memoria (buffer), NO se guardó en disco
            if (imageResult.buffer) {
              fileBufferForMongo = imageResult.buffer;
            } else {
              console.error('[MONGO-SAVE-IMAGE] No se encontró buffer en imageResult');
            }
          }

          const responseWithImage = {
            respuesta: chatResponse,
            archivo: archivoResponse  // NO incluye fileBuffer, solo metadata
          };

          // Si la solicitud incluye subir a Drive, hazlo aquí mismo
          const uploadToDriveReImg = /\b(sub(e|ir|irlo|irla|irlos|irlas|elo|elos)|súb(e|elo|elos)|subelo|súbelo)\b[\s\S]*\b(google\s+)?drive\b/i;
          if (uploadToDriveReImg.test(pregunta) && authUserId) {
            try {
              const result = await import('./config/db.js');
              const pool = result.default;
              const conRes = await pool.query(
                `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
                [authUserId]
              );
              if (conRes.rows.length > 0) {
                const conn = conRes.rows[0];
                let accessToken = null;
                try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
                const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
                  ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
                  : null;
                // Detectar mime de imagen
                const ext = (filename || '').split('.').pop().toLowerCase();
                const mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
                const stat = fs.statSync(imageResult.filePath);
                const totalSize = stat.size;
                async function startResumable(token) {
                  // Usar filename (nombre limpio) para subir a Drive
                  const meta = { name: filename, mimeType: mime };
                  return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,md5Checksum,size', {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${token}`,
                      'Content-Type': 'application/json; charset=UTF-8',
                      'X-Upload-Content-Type': mime,
                      'X-Upload-Content-Length': String(totalSize)
                    },
                    body: JSON.stringify(meta)
                  });
                }
                let start = await startResumable(accessToken);
                if (start && start.status === 401 && refreshToken) {
                  const ref = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken }) });
                  const refJson = await ref.json();
                  if (ref.ok && refJson.access_token) {
                    accessToken = refJson.access_token;
                    const enc = encryptToBase64(accessToken);
                    await pool.query(`UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, token_expires_at=NOW()+($3||' seconds')::interval, updated_at=NOW() WHERE id=$4`, [enc.ciphertextB64, enc.ivB64, String(refJson.expires_in || 3600), conn.id]);
                    start = await startResumable(accessToken);
                  }
                }
                const location = start.headers.get('location') || start.headers.get('Location');
                if (location) {
                  const fh = await fs.promises.open(imageResult.filePath, 'r');
                  const buffer = await fs.promises.readFile(imageResult.filePath);
                  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Length': String(buffer.length), 'Content-Type': mime, 'Content-Range': `bytes 0-${buffer.length-1}/${buffer.length}` };
                  const upResp = await fetch(location, { method: 'PUT', headers, body: buffer });
                  const body = await upResp.json().catch(()=>({}));
                  console.log('[Drive][image-upload] status=', upResp.status, 'name=', body.name, 'id=', body.id);
                  responseWithImage.drive = { uploaded: upResp.ok, id: body.id, name: body.name };
                  if (upResp.ok) {
                    responseWithImage.respuesta = `${chatResponse}\n\nTambién la subí a tu Drive: ${body.name || imageResult.filename}${body.id ? ` (id: ${body.id})` : ''}.`;
                  }
                }
              }
            } catch (e) {
              console.warn('[Drive][image-upload] error', e && e.message);
            }
          }

          // Guardar en MongoDB ANTES de enviar respuesta (solo si auto-save está desactivado)
          if (!autoSaveFiles && fileBufferForMongo && conversationId) {
            // Extraer email del token JWT
            let userEmail = 'system';
            try {
              const token = req.headers.authorization?.split(' ')[1];
              if (token) {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                userEmail = decoded.email || decoded.id || 'system';
              }
            } catch (jwtError) {
              console.warn('No se pudo extraer email del token, usando "system"');
            }

            try {
              const messageData = {
                content: chatResponse,
                conversationId: conversationId,
                sender: userEmail,
                role: 'assistant',
                generatedFile: {
                  nombre: archivoResponse.nombre,
                  downloadName: archivoResponse.downloadName,
                  formato: archivoResponse.formato,
                  url: archivoResponse.url,
                  mensaje: archivoResponse.mensaje,
                  fileId: archivoResponse.fileId,
                  fileBuffer: fileBufferForMongo,
                  preview: archivoResponse.preview,
                  width: archivoResponse.width,
                  height: archivoResponse.height,
                  size: archivoResponse.size,
                  createdAt: new Date()
                }
              };

              const message = new Message(messageData);
              const savedMessage = await message.save();

              // Agregar el _id a la respuesta para que el frontend pueda actualizar el mensaje local
              responseWithImage._id = savedMessage._id.toString();

            } catch (dbError) {
              console.error('[MONGO] Error al guardar mensaje de imagen:', dbError.message);
            }
          }

          // Enviar respuesta al frontend
          res.json(responseWithImage);
          responseSent = true;

          return;
        } else {
          console.error('Error al generar imagen:', imageResult.error);
          // Si falla la generación, devolver solo la respuesta de texto
          return res.json({
            respuesta: `Lo siento, no pude generar la imagen solicitada: "${imageRequest.prompt}". Error: ${imageResult.error}`
          });
        }
      } catch (imageError) {
        console.error('Error en generación de imagen:', imageError);
        // Si falla la generación, devolver solo la respuesta de texto
        return res.json({
          respuesta: `Lo siento, ocurrió un error al generar la imagen solicitada: "${imageRequest.prompt}".`
        });
      }
    }

    // Si es una solicitud de exportación (también soporta frases mixtas: "... en PDF y súbelo a mi drive"), generar el archivo
    if (exportRequest.shouldExport) {
      try {
        // Generar el archivo usando el servicio de exportación
        // Filtro antifallo: si la respuesta del modelo fue una negativa típica, generar contenido de respaldo
        let contentForExport = aiResponse || '';

        // Caso especial: si piden números para CSV/XLSX, generar la secuencia directamente
        try {
          const askingNumbers = /(n[uú]meros?)/i.test(String(pregunta||''));
          const wantsTabular = /^(csv|xlsx)$/i.test(String(exportRequest.format||'')) || /(csv|excel|excell|xlsx|tabla|hoja|planilla)/i.test(String(pregunta||''));
          if (wantsTabular && askingNumbers) {
            const t = String(pregunta||'');
            let nums = [];
            // Rangos: "del 1 al 8", "1-8", "1 a 8", "1 hasta 8"
            const mRange = t.match(/(?:del\s+)?(\d+)\s*(?:-|al|a|hasta|–|—)\s*(\d+)/i);
            if (mRange) {
              const a = parseInt(mRange[1], 10);
              const b = parseInt(mRange[2], 10);
              if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
                const start = Math.min(a, b);
                const end = Math.max(a, b);
                for (let i = start; i <= end; i++) nums.push(i);
              }
            }
            // Listas explícitas: "1, 3, 5" o "1 3 5"
            if (nums.length === 0) {
              const found = Array.from(t.matchAll(/\b\d+\b/g)).map(m => parseInt(m[0], 10)).filter(n => Number.isFinite(n));
              if (found.length >= 3) {
                // Evitar casos de rango (1 y 8 solamente)
                nums = found;
              }
            }
            // Si no encontró en el prompt pero el usuario pidió "mismos", reutilizar lista previa (si existe)
            if (nums.length === 0 && authUserId && /\b(mismas?|mismos?|lo\s+mismo)\b/i.test(String(pregunta||''))) {
              const list = recentExportsByUser.get(authUserId) || [];
              // Si mencionan "del primer archivo" o ordinal, tomarlo explícitamente
              let src = null;
              const tlow = String(pregunta||'').toLowerCase();
              const refFirst = /\bdel\s+primer(?:o|a)?(?:\s+(archivo|fichero|documento))?\b/.test(tlow);
              const ordMatch = tlow.match(/\b(primer|primero|segundo|tercero|cuarto|quinto)\b/);
              if (refFirst) {
                src = list.length > 0 ? list[list.length - 1] : null;
              } else if (ordMatch) {
                const ordMap = { 'primer': 1, 'primero': 1, 'segundo': 2, 'tercero': 3, 'cuarto': 4, 'quinto': 5 };
                const pos = ordMap[ordMatch[1]] || 1;
                const idx = Math.max(0, list.length - pos);
                src = list[idx] || null;
              }
              // Si no especificaron ordinal, preferir la tabla más reciente (csv/xlsx)
              if (!src) {
                src = list.find(it => it && typeof it.content === 'string' && /^(xlsx|csv)$/i.test(it.format))
                  || lastExportByUser.get(authUserId);
              }
              if (src && src.content && src.content.trim()) {
                const lines = src.content.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
                const allNum = lines.length >= 1 && lines.every(l => /^[-+]?\d+(?:[\.,]\d+)?$/.test(l));
                if (allNum) nums = lines.map(n => Number(String(n).replace(',', '.')));
              }
            }

            if (nums.length > 0) {
              contentForExport = nums.join('\n');
              console.log('[export][numbers] contenido generado desde rango/lista:', nums.length, 'elementos');
            }
          }
        } catch (_) {}
        // Reutilizar contenido SOLO cuando lo pidan explícitamente
        // Acepta formas como: "lo mismo", "los mismos", "las mismas notas",
        // "mismo contenido", "igual que antes/el anterior". Evita el uso de
        // "igual" como sinónimo de "también" (p. ej., "e igual subirlo a mi drive").
        if (authUserId) {
          const t = String(pregunta || '').toLowerCase();
          const reuseExplicit = /\b(lo\s+mismo|los\s+mis?mos|las\s+mis?mas|misma?\s+(info(?:rmaci[oó]n)?|notas?|tabla|hoja|contenido)|mismo\s+contenido)\b/.test(t)
            || /\bigual\s+que\s+(antes|el\s+anterior|arriba|previo)\b/.test(t)
            || /\blo\s+mismo\s+que\b/.test(t);
          // Si es explícito, reutilizar SIEMPRE.
          // Admite referencias como: "del primer archivo", "del anterior a la presentación", o "del xlsx".
          if (reuseExplicit) {
            let picked = null;
            // Soporta: "del primer archivo", "del primero", "del primer documento"
            const refFirst = /\bdel\s+primer(?:o|a)?(?:\s+(archivo|fichero|documento))?\b/.test(t);
            // Soporta referencias por tipo
            const refXlsx = /\bdel\s+(xlsx|excel)\b/.test(t);
            const refCsv = /\bdel\s+csv\b/.test(t);
            // Soporta ordinal explícito básico (primer/segundo/tercero)
            const ordMatch = t.match(/\b(primer|primero|segundo|tercero|cuarto|quinto)\b/);
            if (authUserId) {
              const list = recentExportsByUser.get(authUserId) || [];
              if (refFirst) {
                picked = list.length > 0 ? list[list.length - 1] : null; // el más antiguo de los últimos 10
              } else if (refXlsx || refCsv) {
                picked = list.find(it => (refXlsx && it.format === 'xlsx') || (refCsv && it.format === 'csv')) || null;
              } else if (ordMatch) {
                const ordMap = { 'primer': 1, 'primero': 1, 'segundo': 2, 'tercero': 3, 'cuarto': 4, 'quinto': 5 };
                const pos = ordMap[ordMatch[1]] || 1;
                // Elegir por orden cronológico de la conversación (1 = más antiguo de la ventana)
                const idx = Math.max(0, list.length - pos);
                picked = list[idx] || null;
              }
              if (!picked) picked = lastExportByUser.get(authUserId) || null;
            }
            const source = picked && picked.content && picked.content.trim() ? picked : lastExportByUser.get(authUserId);
            if (source && typeof source.content === 'string' && source.content.trim()) {
              contentForExport = source.content;
              // Adjuntar el prompt original como nota invisible (solo para heurísticas internas)
              try { contentForExport.__sourcePrompt = source.requestPrompt || null; } catch {}
              console.log('[export][context] reutilizando contenido de', source.filename || 'desconocido');
            }
          }
        }
        const refusalRe = /(no\s+(tengo|tenemos)\s+la\s+capacidad|no\s+puedo\s+(crear|generar|hacer)|no\s+cuento\s+con\s+la\s+capacidad)/i;
        const isTabularFormat = /^(csv|xlsx)$/i.test(String(exportRequest.format||''));
        const linesNow = String(contentForExport||'').split(/\r?\n/).filter(l => l.trim());
        const looksNumericList = linesNow.length >= 2 && linesNow.every(l => /^\s*[-+]?\d+(?:[\.,]\d+)?\s*$/.test(l));
        // Para CSV/XLSX de números, no hacer fallback por longitud; conservar lista
        const shouldDoFallback = refusalRe.test(contentForExport) || (!isTabularFormat && contentForExport.replace(/\s+/g,' ').length < 80);
        if (shouldDoFallback && !(isTabularFormat && looksNumericList)) {
          try {
            const altSys = 'Eres un generador de contenidos concisos en español. Devuelve SOLO texto del contenido final, con títulos y secciones claras. Nada de disculpas.';
            const altUser = `Genera contenido estructurado para un archivo ${exportRequest.format.toUpperCase()} sobre: ${pregunta}. Estructura con títulos y párrafos (no listas vacías).`;
            const rr = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
              body: JSON.stringify({ model: 'gpt-3.5-turbo', temperature: 0.4, messages: [ { role: 'system', content: altSys }, { role: 'user', content: altUser } ] })
            });
            const jj = await rr.json();
            if (rr.ok && jj && jj.choices && jj.choices[0]) {
              contentForExport = jj.choices[0].message.content || contentForExport;
              console.log('[export][fallback] contenido alternativo aplicado');
            }
          } catch (e) {
            console.warn('[export][fallback] error generando contenido alternativo', e && e.message);
          }
        }
        // Limpiar de frases de UI/instrucciones, pero si es lista numérica, no tocar
        try {
          const isTabular = /^(csv|xlsx)$/i.test(String(exportRequest.format||''));
          const lns = String(contentForExport||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
          const allNumeric = lns.length >= 1 && lns.every(l => /^[-+]?\d+(?:[\.,]\d+)?$/.test(l));
          if (!(isTabular && allNumeric)) {
        contentForExport = sanitizeForExport(contentForExport, exportRequest.format);
          }
        } catch { contentForExport = sanitizeForExport(contentForExport, exportRequest.format); }
        const exportResult = await exportService.export(
          exportRequest.format,
          contentForExport,
          // Derivar nombre desde la solicitud purgada de verbos como "súbelo a mi drive"
          exportRequest.filename,
          pregunta, // Pasar la solicitud actual del usuario
          historial, // Pasar TODO el historial de conversación
          conversationId, // Pasar el ID de la conversación
          autoSaveFiles // Pasar el flag de auto-save
        );


        if (exportResult.success) {
          // 📦 Usar FileMetadata si está disponible
          const metadata = exportResult.metadata;

          // Crear URL de descarga ABSOLUTA
          const PORT = process.env.PORT || 10000;

          // Ahora internalName y displayName son iguales (sin ID)
          // El ID solo se usa para tracking interno
          const filename = metadata ? metadata.displayName : path.basename(exportResult.filePath);
          const fileId = metadata?.fileId || null;
          // Agregar fileId a la URL para distinguir archivos con mismo nombre en diferentes conversaciones
          const downloadUrl = fileId
            ? `http://localhost:${PORT}/api/download/${filename}?fileId=${fileId}`
            : `http://localhost:${PORT}/api/download/${filename}`;

          // Mensaje personalizado según si auto-save está activado
          const chatResponse = autoSaveFiles
            ? `¡Perfecto! He generado tu archivo ${exportRequest.format.toUpperCase()} con el contenido solicitado. Puedes abrirlo usando el botón de abajo.`
            : `¡Perfecto! He generado tu archivo ${exportRequest.format.toUpperCase()} con el contenido solicitado. Puedes descargarlo usando el botón de abajo.`;

          // 🔍 Construir respuesta con metadata completa
          const archivoResponse = {
            nombre: filename, // Nombre limpio (sin ID)
            downloadName: filename, // Mismo nombre (sin ID)
            formato: exportRequest.format.toUpperCase(),
            url: downloadUrl,
            mensaje: exportResult.message,
            fileId: metadata?.fileId // ID solo para tracking interno de la app
          };

          // Si auto-save está activado, agregar la ruta local del archivo
          // Si está desactivado, el archivo ya está en memoria (buffer)
          let fileBufferForMongo = null;
          if (autoSaveFiles) {
            archivoResponse.localPath = exportResult.filePath;
          } else {
            // El archivo ya está en memoria (buffer), NO se guardó en disco
            if (exportResult.buffer) {
              fileBufferForMongo = exportResult.buffer;
            } else {
              console.error('[MONGO-SAVE] No se encontró buffer en exportResult');
            }
          }

          const responseWithFile = {
            respuesta: chatResponse,
            archivo: archivoResponse  // NO incluye fileBuffer, solo metadata
          };
          // Guardar último contenido exportado para continuidad (por usuario)
          try {
            const item = { format: exportRequest.format, filename: filename, filePath: exportResult.filePath, content: contentForExport, ts: Date.now(), requestPrompt: String(pregunta || '') };
            lastExportByUser.set(authUserId, item);
            const list = recentExportsByUser.get(authUserId) || [];
            list.unshift(item);
            while (list.length > 10) list.pop();
            recentExportsByUser.set(authUserId, list);
          } catch {}

          // Si el usuario pide además "sube a mi drive" en la misma frase (variantes comunes)
          const uploadToDriveRe = /\b(sub(e|ir|irlo|irla|irlos|irlas|elo|elos)|súb(e|elo|elos)|subelo|súbelo|coloca|pon|poner|guarda|guardar)\b[\s\S]*\b(google\s+)?drive\b/i;
          const folderMention = String(pregunta || '').match(/carpeta\s+["'“”‘’]([^"'“”‘’]+)["'“”‘’]\s+(en|de|del)\s+(mi\s+)?drive/i) || String(pregunta || '').match(/en\s+mi\s+carpeta\s+["'“”‘’]([^"'“”‘’]+)["'“”‘’]/i);
          const targetFolderName = folderMention ? (folderMention[1] || '').trim() : null;
          const wantsDriveUpload = uploadToDriveRe.test(pregunta) || !!targetFolderName;
          let uploadedOnlyToDrive = wantsDriveUpload; // Si pide Drive, marcarlo ANTES de intentar
          let uploadedMeta = null;
          if (wantsDriveUpload) {
            try {
              const result = await import('./config/db.js');
              const pool = result.default;
              const conRes = await pool.query(
                `SELECT * FROM user_connectors WHERE user_id=$1 AND provider='google' AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
                [authUserId]
              );
              if (conRes.rows.length === 0) {
                console.warn('[Drive][export+upload] no connector');
              } else {
                const conn = conRes.rows[0];
                let accessToken = null;
                try { accessToken = decryptFromBase64(conn.access_token_encrypted, conn.access_token_iv); } catch {}
                const refreshToken = conn.refresh_token_encrypted && conn.refresh_token_iv
                  ? decryptFromBase64(conn.refresh_token_encrypted, conn.refresh_token_iv)
                  : null;
                const filePathAbs = exportResult.filePath;
                const fileNameOnly = filename;
                const mimeMap = { PDF: 'application/pdf', DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', TXT: 'text/plain' };
                const mimeType = mimeMap[exportRequest.format.toUpperCase()] || 'application/octet-stream';
                // Para formatos binarios (pptx, docx, xlsx, pdf) usar subida RESUMABLE CHUNKED
                const stat = fs.statSync(filePathAbs);
                const totalSize = stat.size;
                const chunkSize = 8 * 1024 * 1024; // 8MB (múltiplo de 256KB)
                // Resolver carpeta destino si fue indicada
                let parentId = null;
                if (targetFolderName) {
                  async function findFolder(token) {
                    const q = `name = '${targetFolderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
                    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`;
                    return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
                  }
                  let fr = await findFolder(accessToken);
                  if (fr.status === 401 && refreshToken) {
                    const ref = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken }) });
                    const jj = await ref.json();
                    if (ref.ok && jj.access_token) { accessToken = jj.access_token; fr = await findFolder(accessToken); }
                  }
                  if (fr.ok) {
                    const fj = await fr.json().catch(()=>({}));
                    const folder = Array.isArray(fj.files) && fj.files.length > 0 ? fj.files[0] : null;
                    parentId = folder ? folder.id : null;
                  }
                }
                // Construir metadata con carpeta (si procede)
                async function startResumable(token) {
                  const meta = parentId ? { name: fileNameOnly, mimeType, parents: [parentId] } : { name: fileNameOnly, mimeType };
                  return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,md5Checksum,size', {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${token}`,
                      'Content-Type': 'application/json; charset=UTF-8',
                      'X-Upload-Content-Type': mimeType,
                      'X-Upload-Content-Length': String(totalSize)
                    },
                    body: JSON.stringify(meta)
                  });
                }
                let start = await startResumable(accessToken);
                if (start && start.status === 401 && refreshToken) {
                  const ref = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                      client_id: process.env.GOOGLE_CLIENT_ID || '',
                      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
                      grant_type: 'refresh_token',
                      refresh_token: refreshToken
                    })
                  });
                  const refJson = await ref.json();
                  if (ref.ok && refJson.access_token) {
                    accessToken = refJson.access_token;
                    const enc = encryptToBase64(accessToken);
                    await pool.query(
                      `UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, token_expires_at=NOW()+($3||' seconds')::interval, updated_at=NOW() WHERE id=$4`,
                      [enc.ciphertextB64, enc.ivB64, String(refJson.expires_in || 3600), conn.id]
                    );
                    start = await startResumable(accessToken);
                  }
                }
                console.log('[Drive] upload init: local size:', totalSize, 'mime:', mimeType);
                if (!start.ok) {
                  const errTxt = await start.text();
                  console.warn('[Drive][export+upload] start resumable failed', start.status, errTxt);
                }
                let location = start.headers.get('location') || start.headers.get('Location');
                if (!location) {
                  const errTxt = await start.text().catch(()=>'');
                  console.warn('[Drive][export+upload] missing Location header', errTxt);
                }
                // Subir por chunks
                let offset = 0;
                const md5 = nodeCrypto.createHash('md5');
                const fh = await fs.promises.open(filePathAbs, 'r');
                let upResp = null;
                try {
                  while (offset < totalSize) {
                    const remaining = totalSize - offset;
                    const currentSize = Math.min(chunkSize, remaining);
                    const buffer = Buffer.allocUnsafe(currentSize);
                    const { bytesRead } = await fh.read(buffer, 0, currentSize, offset);
                    const endByte = offset + bytesRead - 1;
                    // actualizar hash local
                    md5.update(buffer.subarray(0, bytesRead));
                    const headers = {
                      Authorization: `Bearer ${accessToken}`,
                      'Content-Length': String(bytesRead),
                      'Content-Type': mimeType,
                      'Content-Range': `bytes ${offset}-${endByte}/${totalSize}`
                    };
                    upResp = await fetch(location, { method: 'PUT', headers, body: buffer.subarray(0, bytesRead) });
                    if (upResp.status === 401 && refreshToken) {
                      // refrescar y reintentar MISMO chunk
                      const ref = await fetch('https://oauth2.googleapis.com/token', {
                        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', grant_type: 'refresh_token', refresh_token: refreshToken })
                      });
                      const refJson = await ref.json();
                      if (ref.ok && refJson.access_token) {
                        accessToken = refJson.access_token;
                        const enc = encryptToBase64(accessToken);
                        await pool.query(`UPDATE user_connectors SET access_token_encrypted=$1, access_token_iv=$2, token_expires_at=NOW()+($3||' seconds')::interval, updated_at=NOW() WHERE id=$4`, [enc.ciphertextB64, enc.ivB64, String(refJson.expires_in || 3600), conn.id]);
                        // re-obtener Location por si expiró la sesión y REINICIAR offset
                        start = await startResumable(accessToken);
                        location = start.headers.get('location') || start.headers.get('Location');
                        offset = 0; // reiniciar desde 0 para evitar descuadre
                        continue; // reintenta desde el principio
                      }
                    }
                    if (upResp.status === 308) {
                      // 308 Resume Incomplete → avanzar al Range devuelto
                      const range = upResp.headers.get('Range') || upResp.headers.get('range');
                      if (range && /bytes=\d+-\d+/.test(range)) {
                        const endStr = range.split('-')[1];
                        const serverEnd = parseInt(endStr, 10);
                        offset = serverEnd + 1;
                      } else {
                        offset = endByte + 1;
                      }
                      continue;
                    }
                    if (upResp.ok) {
                      // subida completa
                      break;
                    }
                    // Error real
                    const errTxt = await upResp.text();
                    let msg = errTxt;
                    try { const j = JSON.parse(errTxt); msg = j.error?.message || errTxt; } catch {}
                    console.warn('[Drive][export+upload] chunk upload error', upResp.status, msg);
                    break;
                  }
                } finally {
                  await fh.close().catch(()=>{});
                }
                let upPayload = null;
                const upText = await upResp.text();
                try { upPayload = JSON.parse(upText); } catch { upPayload = null; }
                if (upResp.ok && upPayload) {
                  // Validar tamaño si Drive lo mandó
                  if (upPayload.size && Number(upPayload.size) !== totalSize) {
                    console.warn('[Drive] size mismatch', upPayload.size, totalSize);
                  }
                  try {
                    const localMd5 = md5.digest('hex');
                    if (upPayload.md5Checksum && upPayload.md5Checksum !== localMd5) {
                      console.warn('[Drive] md5 mismatch', { drive: upPayload.md5Checksum, local: localMd5 });
                    }
                  } catch {}
                  // Metadata de archivo subido exitosamente
                  uploadedMeta = { id: upPayload.id || 'desconocido', name: upPayload.name || fileNameOnly };
                  // Borrar archivo local para ahorrar espacio
                  try { fs.unlinkSync(filePathAbs); } catch {}
                } else if (!upResp.ok) {
                  responseWithFile.respuesta += `\n\nNo pude subir a Drive (${upResp.status}).`;
                }
              }
            } catch (e) {
              console.error('[Drive][export+upload] error', e);
            }
          }

          // Si se pidió subir a Drive y fue exitoso, NO enviar descarga local
          if (uploadedOnlyToDrive && uploadedMeta) {
            const driveLink = `https://drive.google.com/file/d/${uploadedMeta.id}/view`;
            const driveOnlyResponse = {
              respuesta: `¡Perfecto! He generado tu archivo ${exportRequest.format.toUpperCase()} y lo subí a tu Drive: [${uploadedMeta.name}](${driveLink})`,
              archivo: null
            };
            return res.json(driveOnlyResponse);
          }

          // Si pidió Drive pero falló, avisar
          if (uploadedOnlyToDrive && !uploadedMeta) {
            const driveErrorResponse = {
              respuesta: `⚠️ **Error:** Generé el archivo ${exportRequest.format.toUpperCase()} pero no pude subirlo a tu Google Drive.\n\n**Posibles causas:**\n- Tu sesión de Google expiró (reconecta en Ajustes)\n- No tienes permisos de Drive\n\nPor favor, reconecta tu cuenta de Google Drive en Ajustes e intenta nuevamente.`,
              archivo: null
            };
            return res.json(driveErrorResponse);
          }

          // Guardar en MongoDB ANTES de enviar respuesta (solo si auto-save está desactivado)
          if (!autoSaveFiles && fileBufferForMongo && conversationId) {
            // Extraer email del token JWT
            let userEmail = 'system';
            try {
              const token = req.headers.authorization?.split(' ')[1];
              if (token) {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                userEmail = decoded.email || decoded.id || 'system';
              }
            } catch (jwtError) {
              console.warn('No se pudo extraer email del token, usando "system"');
            }

            try {
              const messageData = {
                content: chatResponse,
                conversationId: conversationId,
                sender: userEmail,
                role: 'assistant',
                generatedFile: {
                  nombre: archivoResponse.nombre,
                  downloadName: archivoResponse.downloadName,
                  formato: archivoResponse.formato,
                  url: archivoResponse.url,
                  mensaje: archivoResponse.mensaje,
                  fileId: archivoResponse.fileId,
                  fileBuffer: fileBufferForMongo,
                  createdAt: new Date()
                }
              };

              const message = new Message(messageData);
              const savedMessage = await message.save();

              // Agregar el _id a la respuesta para que el frontend pueda actualizar el mensaje local
              responseWithFile._id = savedMessage._id.toString();

            } catch (dbError) {
              console.error('[MONGO] Error al guardar mensaje:', dbError.message);
            }
          }

          // Enviar respuesta al frontend
          res.json(responseWithFile);
          responseSent = true;

          return;
        } else {
          console.error('Error al generar archivo:', exportResult.error);
          // Si falla la exportación, devolver solo la respuesta de texto
          return res.json({
            respuesta: aiResponse + `\n\n⚠️ **Error:** No se pudo generar el archivo ${exportRequest.format.toUpperCase()}. ${exportResult.error}`
          });
        }
      } catch (exportError) {
        console.error('Error en exportación:', exportError);
        // Si falla la exportación, devolver solo la respuesta de texto
        return res.json({
          respuesta: aiResponse + `\n\n⚠️ **Error:** No se pudo generar el archivo solicitado.`
        });
      }
    }

    // Respuesta normal sin archivo (incluye metadatos y payload solicitado por el cliente)
    // Solo enviar si no se envió respuesta previamente (evitar doble envío)
    if (!responseSent) {
      // Adjuntar headers de depuración de markdown si están activados
      if (dbgEnabled) {
        try {
          res.setHeader('x-md-pre-len', String(preLenDbg));
          res.setHeader('x-md-post-len', String(postLenDbg));
          res.setHeader('x-md-pre-fences', preHasFenceDbg ? '1' : '0');
          res.setHeader('x-md-post-fences', postHasFenceDbg ? '1' : '0');
          res.setHeader('x-md-hint-links', hintIsLinks ? '1' : '0');
          console.log('[MD][headers]', {
            preLenDbg,
            postLenDbg,
            preHasFenceDbg,
            postHasFenceDbg,
            hintIsLinks
          });
        } catch {}
      }
      res.setHeader('x-ai-usage-tokens', String(aiTokensUsed || ''));
      res.setHeader('x-ai-attempts', String(parts));
      const finalResponse = {
        respuesta: aiResponse,
        provider: aiProvider || undefined,
        model: aiModel || undefined,
        meta: finalPayloadMeta
      };

      // Guardar en cache si es pregunta simple
      if (cacheKey && isSimpleQuestion) {
        responseCache.set(cacheKey, {
          response: finalResponse,
          timestamp: Date.now()
        });
        // Limpiar cache antiguo (mantener máximo 50 entradas)
        if (responseCache.size > 50) {
          const firstKey = responseCache.keys().next().value;
          responseCache.delete(firstKey);
        }
      }

      res.json(finalResponse);
    }
  } catch (err) {
    console.error('Error /preguntar:', err.message);
    try {
      if (needsWebSearch && webPrettyForFallback) {
        return res.json({ respuesta: webPrettyForFallback, intent: 'websearch.simple' });
      }
    } catch {}
    res.status(500).send('Error con OpenAI');
  }
});

const PORT = process.env.PORT || 10000;

// 📚 Rutas de Biblioteca Local
const { exec } = await import('child_process');
const { promisify } = await import('util');
const execPromise = promisify(exec);

// Obtener la ruta de la biblioteca (por defecto en Documentos del usuario)
function getLibraryPath() {
  // 1. Primero revisar si hay configuración guardada por el usuario
  const configPath = path.join(process.cwd(), 'library-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.libraryPath && fs.existsSync(config.libraryPath)) {
        return config.libraryPath;
      }
    } catch (err) {
      console.warn('Error leyendo library-config.json:', err.message);
    }
  }

  // 2. Revisar variable de entorno (para usuarios avanzados)
  const customPath = process.env.SKANEA_LIBRARY_PATH;
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  // 3. Ruta por defecto: Documentos/Skanea
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const defaultPath = path.join(homeDir, 'Documents', 'Skanea');

  // Crear la carpeta si no existe
  if (!fs.existsSync(defaultPath)) {
    fs.mkdirSync(defaultPath, { recursive: true });
  }

  return defaultPath;
}

// Abrir la carpeta de biblioteca
app.post('/api/library/open', authenticateToken, async (req, res) => {
  try {
    const libraryPath = getLibraryPath();
    // Solo Windows por ahora
    const command = `explorer "${libraryPath}"`;

    await execPromise(command);
    res.json({ success: true, path: libraryPath });
  } catch (error) {
    console.error('Error al abrir biblioteca:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cambiar la ubicación de la biblioteca
app.post('/api/library/change-path', authenticateToken, async (req, res) => {
  try {
    const currentPath = getLibraryPath();

    // Crear un script PowerShell temporal para abrir el diálogo de selección de carpeta
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $folderBrowser = New-Object System.Windows.Forms.FolderBrowserDialog
      $folderBrowser.Description = "Selecciona la nueva ubicación para guardar archivos de Skanea"
      $folderBrowser.SelectedPath = "${currentPath.replace(/\\/g, '\\\\')}"
      $folderBrowser.ShowNewFolderButton = $true

      $result = $folderBrowser.ShowDialog()
      if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $folderBrowser.SelectedPath
      }
    `;

    // Guardar script temporal
    const tempScriptPath = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'skanea_select_folder.ps1');
    fs.writeFileSync(tempScriptPath, psScript, 'utf8');

    // Ejecutar PowerShell
    const { stdout } = await execPromise(`powershell -ExecutionPolicy Bypass -File "${tempScriptPath}"`);

    // Limpiar script temporal
    try {
      fs.unlinkSync(tempScriptPath);
    } catch {}

    const selectedPath = stdout.trim();

    if (selectedPath) {
      // Guardar la nueva ruta en un archivo de configuración local
      const configPath = path.join(process.cwd(), 'library-config.json');
      const config = { libraryPath: selectedPath };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

      // Crear la carpeta si no existe
      if (!fs.existsSync(selectedPath)) {
        fs.mkdirSync(selectedPath, { recursive: true });
      }

      res.json({
        success: true,
        newPath: selectedPath,
        message: 'Ubicación actualizada correctamente. Reinicia Skanea para aplicar los cambios.'
      });
    } else {
      res.json({
        success: false,
        message: 'No se seleccionó ninguna carpeta'
      });
    }
  } catch (error) {
    console.error('Error al cambiar biblioteca:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Estado de salud simple
let mongoReady = false;

// Endpoint de salud global (no bloquea por DB)
app.get('/api/health', async (req, res) => {
  try {
    let pgReady = false;
    try {
      const dbmod = await import('./config/db.js');
      const pool = dbmod.default;
      const r = await pool.query('SELECT 1');
      pgReady = r && r.rowCount >= 0;
    } catch { pgReady = false; }
    return res.json({ ok: true, server: 'up', mongo: mongoReady, postgres: pgReady, ts: Date.now() });
  } catch {
    return res.status(200).json({ ok: true, server: 'up', mongo: mongoReady, ts: Date.now() });
  }
});

// Iniciar el servidor inmediatamente para evitar ERR_CONNECTION_REFUSED en clientes
app.listen(PORT, () => console.log(`Servidor Skanea backend escuchando en puerto ${PORT}`));

// Conectar a MongoDB con reintentos en background (no bloquea el arranque)
async function connectMongoWithRetry(maxRetries = 20, delayMs = 1500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await connectMongoDB();
      mongoReady = true;
      if (process.env.REQUEST_LOGS === '1') console.log('[Mongo] Conectado');
      return;
    } catch (err) {
      mongoReady = false;
      if (process.env.REQUEST_LOGS === '1') console.warn(`[Mongo] intento ${attempt}/${maxRetries} fallido:`, err && err.message);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  if (process.env.REQUEST_LOGS === '1') console.error('[Mongo] No se pudo conectar tras varios intentos. Continuando sin Mongo.');
}

connectMongoWithRetry().catch(()=>{});

// Job para limpiar archivos temporales de MongoDB (cada 1 minuto)
setInterval(async () => {
  if (!mongoReady) return;

  try {
    const fourMinutesAgo = new Date(Date.now() - 4 * 60 * 1000);

    const result = await Message.updateMany(
      {
        'generatedFile.fileBuffer': { $exists: true },
        'generatedFile.createdAt': { $lt: fourMinutesAgo }
      },
      {
        $unset: { 'generatedFile.fileBuffer': '' }
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`[CLEANUP] Eliminados ${result.modifiedCount} buffers expirados de MongoDB`);
    }
  } catch (error) {
    console.error('[CLEANUP] Error al limpiar buffers:', error.message);
  }
}, 60000); // Cada 1 minuto
