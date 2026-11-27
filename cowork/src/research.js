'use strict';

/**
 * Local Research Engine — DuckDuckGo HTML search (cached 5m), Wikipedia API (EN/DE),
 * and clean readable-text web page fetcher. Runs natively on the local machine
 * with zero external dependencies.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const searchCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function decodeHtml(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  return decodeHtml(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cleanDdgUrl(href) {
  const raw = decodeHtml(href || '');
  try {
    if (raw.includes('uddg=')) {
      const u = new URL(raw.startsWith('//') ? 'https:' + raw : raw.startsWith('/') ? 'https://duckduckgo.com' + raw : raw);
      const target = u.searchParams.get('uddg');
      if (target) return target;
    }
  } catch {}
  if (raw.startsWith('//')) return 'https:' + raw;
  return raw;
}

async function webSearch(query, maxResults = 6) {
  const q = String(query || '').trim();
  if (!q) return [];
  const key = `${q.toLowerCase()}|${maxResults}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.items;

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9,de;q=0.8' },
    signal: AbortSignal.timeout(12000),
  });
  const html = await res.text();

  const items = [];
  const seen = new Set();
  const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>)?/gi;
  let m;
  while ((m = blockRe.exec(html)) && items.length < maxResults) {
    const link = cleanDdgUrl(m[1]);
    if (!/^https?:\/\//i.test(link) || seen.has(link)) continue;
    seen.add(link);
    items.push({
      title: stripTags(m[2]),
      url: link,
      snippet: stripTags(m[3] || m[4] || ''),
    });
  }

  searchCache.set(key, { ts: Date.now(), items });
  if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
  return items;
}

async function wikiLookup(topic, lang = 'en') {
  const q = String(topic || '').trim();
  if (!q) return null;
  const host = lang === 'de' ? 'de.wikipedia.org' : 'en.wikipedia.org';
  try {
    const searchUrl = `https://${host}/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=1&namespace=0&format=json`;
    const sr = await fetch(searchUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
    const data = await sr.json();
    const title = data?.[1]?.[0];
    if (!title) return null;
    const sumUrl = `https://${host}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const r2 = await fetch(sumUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!r2.ok) return null;
    const s = await r2.json();
    return {
      title: s.title || title,
      url: s.content_urls?.desktop?.page || `https://${host}/wiki/${encodeURIComponent(title)}`,
      extract: String(s.extract || '').slice(0, 3000),
    };
  } catch {
    return null;
  }
}

async function fetchPageText(url, maxChars = 7000) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('Invalid URL');
  const res = await fetch(target, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (/text\/plain|application\/json/i.test(ctype)) {
    return { url: res.url || target, title: target, text: raw.slice(0, maxChars) };
  }
  const titleM = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? stripTags(titleM[1]) : target;
  const cleaned = raw
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeHtml(cleaned)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
    .slice(0, maxChars);
  return { url: res.url || target, title, text };
}

module.exports = {
  webSearch,
  wikiLookup,
  fetchPageText,
};
