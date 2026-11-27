'use strict';
const vm = require('vm');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const files = require('./files');
const notes = require('./notes');
const subagents = require('./subagents');
const { readPage, searchWeb } = require('./browser');

const TOOL_DEFS = {
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web; returns titles, URLs, snippets.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  deep_research: {
    type: 'function',
    function: {
      name: 'deep_research',
      description: 'Search and read top 2-4 web sources in one call for research/comparisons.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          sources: { type: 'integer' },
        },
        required: ['query'],
      },
    },
  },
  browse_url: {
    type: 'function',
    function: {
      name: 'browse_url',
      description: 'Open an http(s) URL and read its text.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  wiki_lookup: {
    type: 'function',
    function: {
      name: 'wiki_lookup',
      description: 'Get Wikipedia summary for a topic.',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string' }, lang: { type: 'string' } },
        required: ['topic'],
      },
    },
  },
  calculate: {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate math or convert units (e.g. "100 km to mi", "72 F to C").',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    },
  },
  get_datetime: {
    type: 'function',
    function: {
      name: 'get_datetime',
      description: 'Current date/time in a timezone or date math.',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string' },
          date: { type: 'string' },
          add_days: { type: 'number' },
          diff_with: { type: 'string' },
        },
      },
    },
  },
  run_js: {
    type: 'function',
    function: {
      name: 'run_js',
      description: 'Run isolated JavaScript (no net/fs, 2.5s limit) for data/math/code checks.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code'],
      },
    },
  },
  save_note: {
    type: 'function',
    function: {
      name: 'save_note',
      description: 'Save a persistent user note/memory.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'content'],
      },
    },
  },
  list_notes: {
    type: 'function',
    function: {
      name: 'list_notes',
      description: 'List or search saved notes.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
    },
  },
  read_note: {
    type: 'function',
    function: {
      name: 'read_note',
      description: 'Read a saved note by title or id.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
    },
  },
  list_files: {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in a workspace folder.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 workspace file (optional start_line/end_line).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
        },
        required: ['path'],
      },
    },
  },
  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a workspace file when asked.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  edit_file: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Search-and-replace in an existing workspace file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          find: { type: 'string' },
          replace: { type: 'string' },
          all: { type: 'boolean' },
        },
        required: ['path', 'find', 'replace'],
      },
    },
  },
  search_files: {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search workspace filenames and text contents.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'boolean' },
        },
        required: ['query'],
      },
    },
  },
  delegate_subagent: {
    type: 'function',
    function: {
      name: 'delegate_subagent',
      description: 'Delegate one subtask to a fast <3B local subagent (coder|researcher|analyst|summarizer|general).',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['coder', 'researcher', 'analyst', 'summarizer', 'general'] },
          task: { type: 'string' },
          context: { type: 'string' },
          model: { type: 'string' },
        },
        required: ['task'],
      },
    },
  },
  delegate_parallel: {
    type: 'function',
    function: {
      name: 'delegate_parallel',
      description: 'Run 2-4 independent subtasks on fast <3B local subagents.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: ['coder', 'researcher', 'analyst', 'summarizer', 'general'] },
                task: { type: 'string' },
                context: { type: 'string' },
              },
              required: ['task'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  },
};

function defsFor(names) {
  return names.map((n) => TOOL_DEFS[n]).filter(Boolean);
}

function prettySize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1_048_576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1_048_576).toFixed(1) + ' MB';
}

// ---------------- safe calculator & unit converter ----------------
const UNIT_GROUPS = {
  length: {
    m: 1, meter: 1, meters: 1, metre: 1, metres: 1,
    km: 1000, kilometer: 1000, kilometers: 1000,
    cm: 0.01, mm: 0.001, um: 1e-6, nm: 1e-9,
    mi: 1609.344, mile: 1609.344, miles: 1609.344,
    yd: 0.9144, yard: 0.9144, yards: 0.9144,
    ft: 0.3048, foot: 0.3048, feet: 0.3048,
    in: 0.0254, inch: 0.0254, inches: 0.0254,
    nmi: 1852,
  },
  mass: {
    kg: 1, kilogram: 1, kilograms: 1,
    g: 0.001, gram: 0.001, grams: 0.001,
    mg: 1e-6, t: 1000, tonne: 1000, tonnes: 1000,
    lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, pounds: 0.45359237,
    oz: 0.028349523125, ounce: 0.028349523125, ounces: 0.028349523125,
  },
  volume: {
    l: 1, liter: 1, liters: 1, litre: 1, litres: 1,
    ml: 0.001, cl: 0.01, dl: 0.1, m3: 1000,
    gal: 3.785411784, gallon: 3.785411784, gallons: 3.785411784,
    qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, cups: 0.2365882365,
    floz: 0.0295735295625, tbsp: 0.01478676478125, tsp: 0.00492892159375,
  },
  data: {
    b: 1, byte: 1, bytes: 1, bit: 0.125, bits: 0.125,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5,
  },
  time: {
    ms: 0.001, s: 1, sec: 1, second: 1, seconds: 1,
    min: 60, minute: 60, minutes: 60,
    h: 3600, hr: 3600, hour: 3600, hours: 3600,
    d: 86400, day: 86400, days: 86400,
    wk: 604800, week: 604800, weeks: 604800,
    yr: 31557600, year: 31557600, years: 31557600,
  },
  speed: {
    'm/s': 1, mps: 1, 'km/h': 1 / 3.6, kmh: 1 / 3.6, kph: 1 / 3.6,
    mph: 0.44704, kn: 0.514444, knot: 0.514444, knots: 0.514444,
  },
};

function tryUnitConversion(raw) {
  const m = String(raw).trim().match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z°/0-9 ]+?)\s+(?:to|in|->)\s+([a-zA-Z°/0-9 ]+)$/i);
  if (!m) return null;
  const val = Number(m[1]);
  const from = m[2].trim().toLowerCase().replace(/\s+/g, '').replace(/^°/, '');
  const to = m[3].trim().toLowerCase().replace(/\s+/g, '').replace(/^°/, '');
  const tempAlias = { c: 'c', celsius: 'c', f: 'f', fahrenheit: 'f', k: 'k', kelvin: 'k' };
  if (tempAlias[from] && tempAlias[to]) {
    const f = tempAlias[from], t = tempAlias[to];
    let c = f === 'c' ? val : f === 'f' ? (val - 32) * (5 / 9) : val - 273.15;
    let out = t === 'c' ? c : t === 'f' ? c * (9 / 5) + 32 : c + 273.15;
    return `${val} ${m[2].trim()} = ${Number(out.toPrecision(10))} ${m[3].trim()}`;
  }
  for (const group of Object.values(UNIT_GROUPS)) {
    if (group[from] !== undefined && group[to] !== undefined) {
      const out = (val * group[from]) / group[to];
      return `${val} ${m[2].trim()} = ${Number(out.toPrecision(10))} ${m[3].trim()}`;
    }
  }
  return null;
}

function evalMath(raw) {
  const conv = tryUnitConversion(raw);
  if (conv) return conv;

  let expr = String(raw || '').trim();
  if (!expr || expr.length > 400) throw new Error('Expression is empty or too long');
  // Convert percentage like "15% of 240"
  expr = expr.replace(/(\d+(?:\.\d+)?)%\s+of\s+/gi, '($1/100)*');
  expr = expr.replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');
  // Convert factorial e.g. 5! or (3+2)!
  expr = expr.replace(/(\d+)!/g, 'fact($1)');
  // Replace ^ with **
  expr = expr.replace(/\^/g, '**');
  // Validate characters strictly before running in isolated VM
  const stripped = expr.replace(/\b(sqrt|cbrt|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|log|log10|log2|ln|exp|abs|round|floor|ceil|trunc|sign|min|max|pow|hypot|fact|pi|e|tau)\b/gi, '');
  if (/[^0-9+\-*/().,\s_eE]/.test(stripped)) {
    throw new Error('Unsupported tokens in math expression');
  }
  const fact = (n) => {
    if (!Number.isInteger(n) || n < 0 || n > 170) throw new Error('Factorial requires integer 0..170');
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  };
  const ctx = Object.create(null);
  Object.assign(ctx, {
    sqrt: Math.sqrt, cbrt: Math.cbrt, sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    log: Math.log10, log10: Math.log10, log2: Math.log2, ln: Math.log, exp: Math.exp,
    abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc,
    sign: Math.sign, min: Math.min, max: Math.max, pow: Math.pow, hypot: Math.hypot,
    fact, pi: Math.PI, PI: Math.PI, e: Math.E, E: Math.E, tau: Math.PI * 2,
  });
  const result = vm.runInNewContext(`(${expr})`, ctx, {
    timeout: 500,
    contextCodeGeneration: { strings: false, wasm: false },
  });
  if (typeof result !== 'number' || Number.isNaN(result)) throw new Error('Expression did not evaluate to a valid number');
  const formatted = Number.isInteger(result) ? String(result) : String(Number(result.toPrecision(12)));
  return `${raw} = ${formatted}`;
}

function runSandboxedJs(code) {
  const src = String(code || '');
  if (!src.trim()) throw new Error('code is required');
  if (src.length > 20000) throw new Error('Code too long (max 20 KB)');

  const logs = [];
  const pushLog = (level, args) => {
    if (logs.length >= 200) return;
    const line = args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    logs.push(level === 'log' ? line : `[${level}] ${line}`);
  };

  // Run inside an isolated VM context with codeGeneration disabled (blocks Function/eval escapes)
  const sandbox = Object.create(null);
  sandbox.console = Object.freeze({
    log: (...a) => pushLog('log', a),
    info: (...a) => pushLog('log', a),
    warn: (...a) => pushLog('warn', a),
    error: (...a) => pushLog('error', a),
  });
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  const started = Date.now();
  const value = vm.runInContext(src, context, { timeout: 2500 });
  const elapsedMs = Date.now() - started;

  let formattedVal = '';
  if (value !== undefined) {
    try { formattedVal = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
    catch { formattedVal = String(value); }
  }
  const parts = [];
  if (logs.length) parts.push(`Output:\n${logs.join('\n')}`);
  if (formattedVal) parts.push(`Result:\n${formattedVal}`);
  const text = (parts.join('\n\n') || '(ran with no output)').slice(0, 12000);
  return { text, elapsedMs, logCount: logs.length };
}

async function wikiLookup(topic, lang = 'en') {
  const cleanLang = /^[a-z]{2,3}$/i.test(String(lang || 'en')) ? String(lang).toLowerCase() : 'en';
  const headers = { 'user-agent': 'mx-GPT/1.1 (self-hosted assistant)', accept: 'application/json' };
  const tryTitle = async (t) => {
    const url = `https://${cleanLang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/\s+/g, '_'))}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const d = await res.json();
    if (d.type === 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found') return null;
    return d;
  };
  let data = await tryTitle(topic);
  if (!data) {
    const searchUrl = `https://${cleanLang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(topic)}&limit=3&format=json`;
    const sr = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(12000) });
    if (sr.ok) {
      const arr = await sr.json();
      const first = arr?.[1]?.[0];
      if (first) data = await tryTitle(first);
    }
  }
  if (!data) throw new Error(`No Wikipedia article found for "${topic}"`);
  const pageUrl = data.content_urls?.desktop?.page || `https://${cleanLang}.wikipedia.org/wiki/${encodeURIComponent(data.title || topic)}`;
  const desc = data.description ? ` (${data.description})` : '';
  return {
    text: `${data.title}${desc}\nURL: ${pageUrl}\n\n${data.extract || '(no summary available)'}`,
    meta: { type: 'page', title: data.title, url: pageUrl, via: 'wikipedia' },
  };
}

async function searchFilesContent(rel, query, includeContent = true, limit = 40) {
  const root = files.resolveSafe(rel || '');
  const needle = String(query || '').toLowerCase();
  if (!needle) throw new Error('query is required');
  const hits = [];

  async function walk(dir, depth) {
    if (hits.length >= limit || depth > 6) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= limit) return;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      const relPath = files.relOf(abs);
      if (e.isDirectory()) {
        if (e.name.toLowerCase().includes(needle)) hits.push({ path: relPath + '/', match: '(directory name)' });
        await walk(abs, depth + 1);
        continue;
      }
      if (e.name.toLowerCase().includes(needle)) {
        hits.push({ path: relPath, match: '(filename match)' });
      }
      if (includeContent) {
        try {
          const st = await fsp.stat(abs);
          if (st.size > 500_000) continue;
          const buf = await fsp.readFile(abs);
          if (buf.includes(0)) continue; // skip binary
          const lines = buf.toString('utf8').split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < limit; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              hits.push({ path: relPath, line: i + 1, match: lines[i].trim().slice(0, 180) });
              break; // first match per file to keep output concise
            }
          }
        } catch {}
      }
    }
  }
  await walk(root, 0);
  return hits;
}

async function execute(name, args = {}, ctx = {}) {
  const owner = ctx.owner || 'owner';
  switch (name) {
    case 'web_search': {
      if (!args.query) throw new Error('query is required');
      const results = await searchWeb(args.query);
      const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
      return {
        text: `Search results for "${args.query}":\n\n${lines.join('\n\n')}`,
        meta: { type: 'search', query: args.query, results },
      };
    }
    case 'deep_research': {
      if (!args.query) throw new Error('query is required');
      const results = await searchWeb(args.query, 8);
      const count = Math.min(Math.max(Number(args.sources) || 3, 2), 4);
      const picks = [];
      const hosts = new Set();
      for (const r of results) {
        try {
          const host = new URL(r.url).hostname.replace(/^www\./, '');
          if (hosts.has(host)) continue;
          hosts.add(host);
          picks.push(r);
        } catch {}
        if (picks.length >= count) break;
      }
      const sources = [];
      for (let i = 0; i < picks.length; i++) {
        try {
          const page = await readPage(picks[i].url, { screenshot: i === 0 });
          sources.push({
            title: page.title || picks[i].title,
            url: page.url || picks[i].url,
            excerpt: String(page.text || '').replace(/\s+/g, ' ').slice(0, 2600),
            screenshot: page.screenshot || null,
          });
        } catch (e) {
          sources.push({ title: picks[i].title, url: picks[i].url, excerpt: `(could not open: ${e.message})` });
        }
      }
      const digest = sources.map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.excerpt.slice(0, 2400)}`).join('\n\n---\n\n');
      const list = results.slice(0, 6).map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${r.snippet}`).join('\n');
      return {
        text: `Research digest for "${args.query}"\n\nSearch results:\n${list}\n\nSources opened and read:\n\n${digest}`.slice(0, 16000),
        meta: {
          type: 'research',
          query: args.query,
          url: sources[0]?.url,
          title: sources[0]?.title,
          screenshot: sources[0]?.screenshot || null,
          sources: sources.map((s) => ({ title: s.title, url: s.url })),
          results: results.slice(0, 6),
        },
      };
    }
    case 'browse_url': {
      if (!args.url) throw new Error('url is required');
      const page = await readPage(args.url, { screenshot: args.screenshot !== false });
      const linkText = (page.links || []).slice(0, 25).map((l) => `- [${l.text || l.url}](${l.url})`).join('\n');
      return {
        text: `Page: ${page.title}\nURL: ${page.url}\n\n${page.text}\n\nLinks:\n${linkText}`.slice(0, 32000),
        meta: { type: 'page', url: page.url, title: page.title, screenshot: page.screenshot || null, via: page.via, links: (page.links || []).slice(0, 40) },
      };
    }
    case 'wiki_lookup': {
      if (!args.topic) throw new Error('topic is required');
      return wikiLookup(args.topic, args.lang || 'en');
    }
    case 'calculate': {
      if (!args.expression) throw new Error('expression is required');
      const out = evalMath(args.expression);
      return { text: out, meta: { type: 'calc', expression: args.expression, result: out } };
    }
    case 'get_datetime': {
      const tz = args.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const base = args.date ? new Date(args.date) : new Date();
      if (Number.isNaN(base.getTime())) throw new Error(`Invalid date: ${args.date}`);
      const target = Number.isFinite(Number(args.add_days))
        ? new Date(base.getTime() + Number(args.add_days) * 86400000)
        : base;
      let formatted;
      try {
        formatted = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          dateStyle: 'full',
          timeStyle: 'long',
        }).format(target);
      } catch {
        throw new Error(`Unknown timezone: ${tz}`);
      }
      const lines = [
        `Date/Time (${tz}): ${formatted}`,
        `ISO 8601 (UTC): ${target.toISOString()}`,
        `Unix timestamp: ${Math.floor(target.getTime() / 1000)}`,
      ];
      if (args.diff_with) {
        const other = new Date(args.diff_with);
        if (Number.isNaN(other.getTime())) throw new Error(`Invalid diff_with date: ${args.diff_with}`);
        const diffMs = other.getTime() - target.getTime();
        const diffDays = (diffMs / 86400000).toFixed(2);
        lines.push(`Difference to ${other.toISOString()}: ${diffDays} days (${Math.round(diffMs / 3600000)} hours)`);
      }
      return { text: lines.join('\n'), meta: { type: 'datetime', timezone: tz, iso: target.toISOString() } };
    }
    case 'run_js': {
      const out = runSandboxedJs(args.code);
      return { text: out.text, meta: { type: 'code', elapsedMs: out.elapsedMs, logCount: out.logCount } };
    }
    case 'save_note': {
      const n = notes.save({ title: args.title, content: args.content, tags: args.tags || [] }, owner);
      return { text: `Saved note "${n.title}" (id: ${n.id})`, meta: { type: 'note', id: n.id, title: n.title } };
    }
    case 'list_notes': {
      const list = args.query ? notes.search(args.query, owner) : notes.list(owner);
      const lines = list.map((n) => `- ${n.title}${n.tags?.length ? ` [${n.tags.join(', ')}]` : ''} — ${n.content.slice(0, 90).replace(/\s+/g, ' ')}`);
      return { text: lines.length ? `Saved notes (${list.length}):\n${lines.join('\n')}` : 'No saved notes yet.', meta: { type: 'notes', count: list.length } };
    }
    case 'read_note': {
      const n = notes.find(args.title || args.id, owner);
      if (!n) throw new Error(`Note not found: ${args.title || args.id}`);
      return { text: `# ${n.title}\n${n.tags?.length ? `Tags: ${n.tags.join(', ')}\n` : ''}\n${n.content}`, meta: { type: 'note', id: n.id, title: n.title } };
    }
    case 'list_files': {
      const dir = await files.list(args.path || '');
      const lines = dir.entries.map((e) => `${e.dir ? '📁' : '📄'} ${e.path}${e.dir ? '/' : `  (${prettySize(e.size)})`}`);
      return {
        text: `Contents of /${dir.path}:\n${lines.join('\n') || '(empty)'}`,
        meta: { type: 'files', path: dir.path, entries: dir.entries },
      };
    }
    case 'read_file': {
      if (!args.path) throw new Error('path is required');
      const content = await files.readText(args.path);
      let slice = content;
      let header = `Contents of ${args.path}`;
      if (args.start_line || args.end_line) {
        const lines = content.split(/\r?\n/);
        const s = Math.max(1, Number(args.start_line) || 1);
        const e = Math.min(lines.length, Number(args.end_line) || lines.length);
        slice = lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join('\n');
        header += ` (lines ${s}-${e} of ${lines.length})`;
      }
      return { text: `${header}:\n\n${slice}`.slice(0, 32000), meta: { type: 'file', path: args.path } };
    }
    case 'write_file': {
      if (!args.path) throw new Error('path is required');
      if (typeof args.content !== 'string') throw new Error('content is required');
      if (args.content.length > 300_000) throw new Error('File is too large (max 300 KB)');
      await files.write(args.path, args.content);
      return { text: `Wrote ${args.content.length} bytes to ${args.path}`, meta: { type: 'file_written', path: args.path } };
    }
    case 'edit_file': {
      if (!args.path || typeof args.find !== 'string' || typeof args.replace !== 'string') {
        throw new Error('path, find, and replace are required');
      }
      const existing = await files.readText(args.path);
      if (!existing.includes(args.find)) throw new Error(`Text to find was not present in ${args.path}`);
      let count = 0;
      const updated = args.all
        ? existing.split(args.find).join((() => { count = existing.split(args.find).length - 1; return args.replace; })())
        : (count = 1, existing.replace(args.find, args.replace));
      await files.write(args.path, updated);
      return { text: `Edited ${args.path} (${count} replacement${count === 1 ? '' : 's'})`, meta: { type: 'file_written', path: args.path, count } };
    }
    case 'search_files': {
      if (!args.query) throw new Error('query is required');
      const hits = await searchFilesContent(args.path || '', args.query, args.content !== false);
      const lines = hits.map((h) => `${h.path}${h.line ? `:${h.line}` : ''}  ${h.match}`);
      return {
        text: lines.length ? `Matches for "${args.query}" (${hits.length}):\n${lines.join('\n')}` : `No matches found for "${args.query}"`,
        meta: { type: 'file_search', query: args.query, count: hits.length },
      };
    }
    case 'delegate_subagent': {
      if (ctx.isSubagent) throw new Error('Subagents cannot recursively spawn subagents');
      const res = await subagents.runSubagent({
        role: args.role || 'general',
        task: args.task,
        context: args.context || '',
        model: args.model || '',
        useWeb: !!ctx.useWeb,
        useFiles: !!ctx.useFiles,
        owner,
        signal: ctx.signal,
        toolsModule: { defsFor, execute },
        onProgress: ctx.onSubagentProgress,
      });
      return {
        text: `[Subagent ${res.roleLabel} · ${res.model} · ${(res.elapsedMs / 1000).toFixed(1)}s]\n${res.content}`.slice(0, 14000),
        meta: { type: 'subagent', subagentId: res.id, role: res.role, model: res.model, elapsedMs: res.elapsedMs },
      };
    }
    case 'delegate_parallel': {
      if (ctx.isSubagent) throw new Error('Subagents cannot recursively spawn subagents');
      const results = await subagents.runParallelSubagents({
        tasks: args.tasks || [],
        useWeb: !!ctx.useWeb,
        useFiles: !!ctx.useFiles,
        owner,
        signal: ctx.signal,
        toolsModule: { defsFor, execute },
        onProgress: ctx.onSubagentProgress,
      });
      const text = results.map((r, i) =>
        r.ok
          ? `### Subagent ${i + 1} (${r.roleLabel} · ${r.model} · ${(r.elapsedMs / 1000).toFixed(1)}s)\nTask: ${r.task}\n\n${r.content}`
          : `### Subagent ${i + 1} (${r.role || 'general'}) — FAILED\nError: ${r.error}`
      ).join('\n\n---\n\n');
      return {
        text: text.slice(0, 20000),
        meta: { type: 'subagents_parallel', count: results.length, succeeded: results.filter((r) => r.ok).length },
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { defsFor, execute, TOOL_DEFS };
