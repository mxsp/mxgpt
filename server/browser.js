'use strict';
const dns = require('dns').promises;
const net = require('net');

const PRIVATE = [
  [/^10\./, 'private'], [/^127\./, 'loopback'], [/^0\./, 'this-host'],
  [/^169\.254\./, 'link-local'], [/^192\.168\./, 'private'],
  [/^172\.(1[6-9]|2\d|3[01])\./, 'private'],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 'cgnat'],
];

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return PRIVATE.some(([re]) => re.test(ip));
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  }
  return false;
}

async function validateUrl(input) {
  let u;
  try { u = new URL(input); } catch { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are supported');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Local network URLs are blocked');
  }
  if (net.isIP(host) && isPrivateIp(host)) throw new Error('Private network URLs are blocked');
  if (!net.isIP(host)) {
    let addrs = [];
    try { addrs = await dns.lookup(host, { all: true }); } catch { throw new Error(`Could not resolve ${host}`); }
    if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('That hostname points to a private address');
  }
  return u;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br|header|footer|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

async function fetchFallback(url, signal) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: signal || AbortSignal.timeout(25000),
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const type = res.headers.get('content-type') || '';
  if (!/text\/html|text\/plain|application\/xhtml/.test(type)) {
    return { url: res.url || url, title: url, text: `[${type || 'binary'} content: ${res.headers.get('content-length') || '?'} bytes]`, links: [], via: 'fetch' };
  }
  const html = (await res.text()).slice(0, 3_000_000);
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const links = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= 80) break;
    try {
      const abs = new URL(decodeEntities(m[1]), res.url || url).href;
      if (!/^https?:/.test(abs) || seen.has(abs)) continue;
      seen.add(abs);
      links.push({ url: abs, text: stripTags(m[2]).slice(0, 120) });
    } catch {}
  }
  return { url: res.url || url, title: titleM ? stripTags(titleM[1]) : url, text: htmlToText(html).slice(0, 30000), links, via: 'fetch' };
}

// ---------------- Playwright (optional) ----------------
let playwright = null;
let pwBrowser = null;
let pwUnavailable = false;
let lastUse = 0;

async function getBrowser() {
  if (pwUnavailable) return null;
  if (pwBrowser && pwBrowser.isConnected()) return pwBrowser;
  if (!playwright) {
    try { playwright = require('playwright'); } catch { pwUnavailable = true; return null; }
  }
  try {
    pwBrowser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
    });
    lastUse = Date.now();
    return pwBrowser;
  } catch (e) {
    console.error('[browser] launch failed:', e.message);
    pwUnavailable = true;
    return null;
  }
}

async function readPage(input, { screenshot = true, signal } = {}) {
  const u = await validateUrl(input);
  const browser = await getBrowser();
  if (!browser) return fetchFallback(u.href, signal);

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    javaScriptEnabled: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(900);
    const data = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const links = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        if (links.length >= 80) break;
        try {
          const href = new URL(a.getAttribute('href'), location.href).href;
          if (!/^https?:/.test(href) || seen.has(href)) continue;
          seen.add(href);
          links.push({ url: href, text: (a.innerText || a.title || href).trim().slice(0, 120) });
        } catch {}
      }
      return { title: document.title, text, links, url: location.href };
    });
    let png = null;
    if (screenshot) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
      png = buf.toString('base64');
    }
    lastUse = Date.now();
    return { ...data, text: (data.text || '').slice(0, 30000), screenshot: png ? `data:image/jpeg;base64,${png}` : null, via: 'chromium' };
  } finally {
    await context.close().catch(() => {});
  }
}

// ---------------- result cache ----------------
const SEARCH_CACHE = new Map();
const SEARCH_CACHE_TTL = 5 * 60 * 1000;
function cacheGet(key) {
  const v = SEARCH_CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.t > SEARCH_CACHE_TTL) { SEARCH_CACHE.delete(key); return null; }
  return v.v;
}
function cacheSet(key, v) {
  if (SEARCH_CACHE.size > 200) {
    const first = SEARCH_CACHE.keys().next().value;
    SEARCH_CACHE.delete(first);
  }
  SEARCH_CACHE.set(key, { t: Date.now(), v });
}

function cleanResultUrl(raw) {
  let link = decodeEntities(String(raw || '').trim());
  try {
    const u = new URL(link);
    // Bing redirect wrapper
    if (/bing\.com$/i.test(u.hostname) && /^\/ck\//.test(u.pathname)) {
      const enc = u.searchParams.get('u');
      if (enc && /^a1/.test(enc)) {
        const b = enc.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(b, 'base64').toString('utf8');
        if (/^https?:/.test(decoded)) link = decoded;
      }
    }
    // DuckDuckGo redirect wrapper
    const uddg = link.match(/[?&]uddg=([^&]+)/);
    if (uddg) link = decodeURIComponent(uddg[1]);
  } catch {}
  return link;
}

function dedupeResults(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (!r || !r.url || !/^https?:/.test(r.url)) continue;
    let key = r.url;
    try {
      const u = new URL(r.url);
      key = (u.hostname.replace(/^www\./, '') + u.pathname).toLowerCase().replace(/\/$/, '');
    } catch {}
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: String(r.title || r.url).slice(0, 160),
      url: r.url,
      snippet: String(r.snippet || '').slice(0, 320),
    });
  }
  return out;
}

function parseBingRSS(xml) {
  const out = [];
  const items = String(xml || '').match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const raw of items) {
    const getTag = (tag) => {
      const m = raw.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      if (!m) return '';
      let v = m[1].trim();
      v = v.replace(/^<!\[CDATA\[/i, '').replace(/\]\]>$/i, '');
      return decodeEntities(v).trim();
    };
    const title = stripTags(getTag('title'));
    const link = cleanResultUrl(getTag('link'));
    const desc = stripTags(getTag('description'));
    if (!title || !/^https?:/.test(link)) continue;
    out.push({ title, url: link, snippet: desc });
  }
  return out;
}

async function searchBingRSS(q) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&setlang=en`;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'accept': 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const raw = parseBingRSS(xml);
  const junk = /dict\.|linguee|thesaurus|wordreference|merriam-webster|dictionary\.|collinsdictionary|spielaffe|bubbleshooter|sortvisualizer|xhamster|pornhub|xnxx|leo\.org|pons\.com|langenscheidt|dict\.cc/i;
  return raw.filter((r) => !junk.test(r.url));
}

async function searchWikipedia(q, limit = 8) {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=${limit}&namespace=0&format=json`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'mx-GPT/1.1 (self-hosted assistant)', accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const arr = await res.json();
  const titles = arr?.[1] || [];
  const descs = arr?.[2] || [];
  const urls = arr?.[3] || [];
  const out = [];
  for (let i = 0; i < titles.length; i++) {
    out.push({
      title: titles[i],
      url: urls[i],
      snippet: descs[i] || '',
    });
  }
  return out;
}

async function searchGoogleNewsRSS(q, limit = 6) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'accept': 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const out = [];
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const raw of items) {
    const getTag = (tag) => {
      const m = raw.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      if (!m) return '';
      let v = m[1].trim().replace(/^<!\[CDATA\[/i, '').replace(/\]\]>$/i, '');
      return decodeEntities(v).trim();
    };
    const title = stripTags(getTag('title'));
    const link = getTag('link');
    const desc = stripTags(getTag('description'));
    if (!title || !/^https?:/.test(link)) continue;
    out.push({ title, url: link, snippet: desc });
    if (out.length >= limit) break;
  }
  return out;
}

async function searchWeb(query, limit = 6) {
  const q = String(query || '').trim().slice(0, 400);
  if (!q) throw new Error('query is required');
  const cacheKey = `${q}::${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const collected = [];
  let lastErr;

  // 1. Bing RSS (reliable, no JS)
  try {
    const r = await searchBingRSS(q);
    if (r.length) collected.push(...r);
  } catch (e) { lastErr = e; }

  // 2. Wikipedia fallback for factual queries
  const wikiQueries = [q];
  const simplified = q.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => !/^(how|to|a|an|the|in|on|of|for|with|and|or|is|are|do|does|what|why|when|where|can|could|should|would|please|me|my|your)$/i.test(w)).join(' ');
  if (simplified && simplified !== q.toLowerCase()) wikiQueries.push(simplified);
  for (const wq of wikiQueries) {
    if (collected.length >= 3) break;
    try {
      const r = await searchWikipedia(wq, Math.max(limit, 6));
      if (r.length) collected.push(...r);
    } catch (e) { lastErr = e; }
  }

  if (collected.length < 3) {
    try {
      const r = await searchGoogleNewsRSS(q, Math.max(limit, 6));
      if (r.length) collected.push(...r);
    } catch (e) { lastErr = e; }
  }
  const junk = /dict\.|linguee|thesaurus|wordreference|merriam-webster|dictionary\.|collinsdictionary|spielaffe|bubbleshooter|sortvisualizer|xhamster|pornhub|xnxx|leo\.org|pons\.com|langenscheidt|dict\.cc/i;
  const cleaned = collected.filter((r) => !junk.test(r.url));
  const final = dedupeResults(cleaned.length ? cleaned : collected).slice(0, limit);
  if (!final.length) throw new Error(`Web search failed: ${lastErr?.message || 'no results'}`);
  cacheSet(cacheKey, final);
  return final;
}

function cleanBingUrl(href) {
  let link = decodeEntities(href);
  try {
    const u = new URL(link, 'https://www.bing.com');
    const enc = u.searchParams.get('u');
    if (enc && /^a1/.test(enc)) {
      const b = enc.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(b, 'base64').toString('utf8');
      if (/^https?:/.test(decoded)) link = decoded;
    } else link = u.href;
  } catch {}
  return link;
}

function parseBing(html) {
  const out = [];
  const blocks = html.split(/<li class="b_algo"/i).slice(1);
  for (const raw of blocks) {
    const block = raw.slice(0, 6000);
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = cleanBingUrl(a[1]);
    if (!/^https?:/.test(url) || /bing\.com\/ck\//.test(url)) continue;
    if (/dict\.|linguee|thesaurus|wordreference|merriam-webster|dictionary\.|collinsdictionary/i.test(url)) continue;
    const snip = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    out.push({ title: stripTags(a[2]).slice(0, 160), url, snippet: snip ? stripTags(snip[1]).slice(0, 320) : '' });
  }
  return out;
}

function parseMojeek(html) {
  const out = [];
  for (const raw of html.split(/<li[^>]*class="[^"]*results-standard[^"]*"/i).slice(1)) {
    const a = raw.match(/<a[^>]*class="title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const p = raw.match(/<p[^>]*class="s"[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title: stripTags(a[2]), url: decodeEntities(a[1]), snippet: p ? stripTags(p[1]) : '' });
  }
  return out;
}

function parseDDG(html) {
  const out = [];
  const blocks = html.split(/class="result__body"|class="result-link"/).slice(1);
  for (const block of blocks) {
    const a = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]*href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    let link = decodeEntities(a[1]);
    const uddg = link.match(/[?&]uddg=([^&]+)/);
    if (uddg) link = decodeURIComponent(uddg[1]);
    if (!/^https?:/.test(link)) continue;
    const sn = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    out.push({ title: stripTags(a[2]), url: link, snippet: sn ? stripTags(sn[1]) : '' });
  }
  return out;
}

module.exports = { readPage, searchWeb, validateUrl, htmlToText, isPrivateIp };
