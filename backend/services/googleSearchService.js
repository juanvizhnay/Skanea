import fetch from 'node-fetch';

const GOOGLE_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

function normalizeResults(json) {
  const items = Array.isArray(json && json.items) ? json.items : [];
  return items.slice(0, 10).map((it) => ({
    name: it.title,
    url: it.link,
    snippet: it.snippet,
    displayLink: it.displayLink,
    isLikely404: /404|not found|we couldn't find|page you were looking for/i.test(`${it.title} ${it.snippet}`),
    isSuspicious: /updates?\.com|docs?\.com/i.test(String(it.displayLink || ''))
  }));
}

export async function webSearchGoogle(query, options = {}) {
  const { count = 5, lr = 'lang_es', safe = 'active' } = options;
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey || !cx) {
    return { success: false, error: 'Faltan GOOGLE_SEARCH_API_KEY o GOOGLE_SEARCH_CX en .env' };
  }
  try {
    const url = new URL(GOOGLE_ENDPOINT);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('cx', cx);
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(count));
    url.searchParams.set('lr', lr);
    url.searchParams.set('safe', safe);

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { success: false, error: `Google CSE status ${resp.status}: ${text}` };
    }
    const json = await resp.json();
    let results = normalizeResults(json);
    // Filtro básico de falsos positivos y 404
    results = results.filter(r => !r.isLikely404 && !r.isSuspicious);
    // Asegurar formato y recorte al conteo deseado
    results = results.map(r => ({ name: r.name, url: r.url, snippet: r.snippet, displayLink: r.displayLink })).slice(0, count);
    return { success: true, results, raw: json };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export function formatResultsForPrompt(results) {
  if (!Array.isArray(results) || results.length === 0) return '';
  const lines = results.map((r, i) => `(${i + 1}) ${r.name}\n${r.url}\n${r.snippet}`);
  return `\n\n[RESULTADOS DE BUSQUEDA WEB]\n${lines.join('\n\n')}\n\n`;
}


