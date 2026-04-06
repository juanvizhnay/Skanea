import fetch from 'node-fetch';

const BING_ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search';

function normalizeResults(json) {
  const webPages = json && json.webPages && Array.isArray(json.webPages.value) ? json.webPages.value : [];
  return webPages.slice(0, 5).map((item) => ({
    name: item.name,
    url: item.url,
    snippet: item.snippet,
    language: item.language,
    isFamilyFriendly: item.isFamilyFriendly,
    dateLastCrawled: item.dateLastCrawled,
    displayUrl: item.displayUrl
  }));
}

export async function webSearchBing(query, options = {}) {
  const { count = 5, mkt = 'es-ES', safeSearch = 'Moderate' } = options;
  const apiKey = process.env.BING_SEARCH_KEY || process.env.BING_API_KEY || process.env.AZURE_BING_KEY;
  if (!apiKey) {
    return { success: false, error: 'BING_SEARCH_KEY no configurada en .env' };
  }
  try {
    const url = new URL(BING_ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('mkt', mkt);
    url.searchParams.set('count', String(count));
    url.searchParams.set('safeSearch', safeSearch);

    const resp = await fetch(url.toString(), {
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey
      }
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { success: false, error: `Bing status ${resp.status}: ${text}` };
    }
    const json = await resp.json();
    const results = normalizeResults(json);
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


