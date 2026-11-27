'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, SECRET } = require('./config');

const FILE = path.join(DATA_DIR, 'providers.json');
const PREFIX = 'prov:';
const KEY = crypto.scryptSync(SECRET, 'mxgpt-provider-keys', 32);

const PRESETS = {
  'opencode-go': {
    name: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    docs: 'https://opencode.ai/docs/console/go/',
    modelsUrl: 'https://opencode.ai/inference/go/v1/models',
    models: ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'glm-5.3-flash', 'kimi-k2.7-code', 'mimo-v2.5-pro', 'grok-4.7', 'gpt-6-luna', 'claude-haiku-5-5', 'gemini-4-argon', 'qwen3.7-max'],
  },
  'opencode-zen': {
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    docs: 'https://opencode.ai/docs/zen/',
    models: [],
  },
  gemini: {
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    docs: 'https://ai.google.dev/gemini-api/docs/openai',
    models: ['gemini-4-hydrogen', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: [] },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: [] },
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: [] },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: [] },
  mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', models: [] },
  xai: { name: 'xAI', baseUrl: 'https://api.x.ai/v1', models: [] },
  together: { name: 'Together', baseUrl: 'https://api.together.xyz/v1', models: [] },
  lmstudio: { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', models: [], noKey: true },
  vllm: { name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', models: [], noKey: true },
  custom: { name: 'Custom endpoint', baseUrl: '', models: [] },
};

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}
function decrypt(payload) {
  if (!payload) return '';
  try {
    const [v, iv, tag, data] = String(payload).split('.');
    if (v !== 'v1') return '';
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch { return ''; }
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { providers: Array.isArray(data.providers) ? data.providers : [] };
  } catch {
    return { providers: [] };
  }
}
function save(data) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function slug(name) {
  const base = String(name || 'provider').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'provider';
  const data = load();
  let id = base, n = 2;
  while (data.providers.some((p) => p.id === id)) id = `${base}-${n++}`;
  return id;
}

function keyHint(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `••••${key.slice(-4)}`;
}

function publicView(p) {
  const key = decrypt(p.apiKey);
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    models: p.models || [],
    modelsUrl: p.modelsUrl || '',
    enabled: p.enabled !== false,
    hasKey: !!key,
    keyHint: keyHint(key),
    noKey: !!p.noKey,
    created: p.created,
    updated: p.updated,
    lastCheck: p.lastCheck || null,
  };
}

function list() {
  return load().providers.map(publicView);
}

function get(id) {
  return load().providers.find((p) => p.id === id) || null;
}

function getWithKey(id) {
  const p = get(id);
  if (!p) return null;
  return { ...p, apiKey: decrypt(p.apiKey) };
}

function create({ name, baseUrl, apiKey = '', models = [], modelsUrl = '', noKey = false }) {
  if (!name || !baseUrl) throw Object.assign(new Error('Name and base URL are required'), { status: 400 });
  const data = load();
  const now = Date.now();
  const p = {
    id: slug(name),
    name: String(name).slice(0, 60),
    baseUrl: normalizeBase(baseUrl),
    apiKey: encrypt(apiKey),
    modelsUrl: modelsUrl ? normalizeBase(modelsUrl) : '',
    models: cleanModels(models),
    noKey: !!noKey,
    enabled: true,
    created: now,
    updated: now,
  };
  data.providers.push(p);
  save(data);
  return publicView(p);
}

function normalizeBase(url) {
  let u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

function cleanModels(models) {
  const arr = Array.isArray(models) ? models : String(models || '').split(/[\n,]+/);
  return [...new Set(arr.map((m) => String(m).trim()).filter(Boolean))].slice(0, 300);
}

function update(id, patch) {
  const data = load();
  const p = data.providers.find((x) => x.id === id);
  if (!p) return null;
  if (patch.name !== undefined) p.name = String(patch.name).slice(0, 60);
  if (patch.baseUrl !== undefined) p.baseUrl = normalizeBase(patch.baseUrl);
  if (patch.apiKey !== undefined && patch.apiKey !== '') p.apiKey = encrypt(patch.apiKey);
  if (patch.clearKey) p.apiKey = '';
  if (patch.models !== undefined) p.models = cleanModels(patch.models);
  if (patch.modelsUrl !== undefined) p.modelsUrl = patch.modelsUrl ? normalizeBase(patch.modelsUrl) : '';
  if (patch.enabled !== undefined) p.enabled = !!patch.enabled;
  p.updated = Date.now();
  save(data);
  return publicView(p);
}

function remove(id) {
  const data = load();
  const before = data.providers.length;
  data.providers = data.providers.filter((p) => p.id !== id);
  save(data);
  return data.providers.length < before;
}

async function fetchModels(provider) {
  const key = provider.apiKey || '';
  const headers = { accept: 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const base = normalizeBase(provider.baseUrl);
  const urls = [...new Set([provider.modelsUrl, `${base}/models`, `${base}/models?limit=1000`].filter(Boolean))];
  let lastErr = '';
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 200); } catch {}
        lastErr = `Model list failed (${res.status})${detail ? ': ' + detail : ''}`;
        continue;
      }
      const data = await res.json();
      const arr = Array.isArray(data) ? data
        : data.data || data.models || data.data?.models || data.result || data.items || [];
      const ids = arr.map((m) => (typeof m === 'string' ? m : m.id || m.name || m.model || m.slug)).filter(Boolean);
      const usable = ids.filter((id) => !/:cloud$/i.test(id) && !/embed/i.test(id));
      if (usable.length) return [...new Set(usable)].slice(0, 300);
      lastErr = 'The endpoint returned no models';
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(lastErr || 'Could not fetch models');
}

async function test(provider, model) {
  const key = provider.apiKey || '';
  const base = normalizeBase(provider.baseUrl);
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  if (/opencode/i.test(base)) headers['x-opencode-session'] = 'mxgpt-test';
  const chosen = model || (provider.models || [])[0];
  if (!chosen) throw new Error('Add at least one model first');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: chosen,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 8,
      stream: false,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 400); } catch {}
    throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
  }
  const data = await res.json().catch(() => ({}));
  const text = data.choices?.[0]?.message?.content;
  return { model: chosen, reply: typeof text === 'string' ? text.slice(0, 120) : '' };
}

function resolve(ref) {
  if (!String(ref || '').startsWith(PREFIX)) return null;
  const rest = String(ref).slice(PREFIX.length);
  const idx = rest.indexOf('/');
  if (idx < 1) return null;
  const id = rest.slice(0, idx);
  const model = rest.slice(idx + 1);
  const p = get(id);
  if (!p || p.enabled === false) return null;
  return { provider: getWithKey(id), model };
}

function modelEntries() {
  const out = [];
  for (const p of load().providers) {
    if (p.enabled === false) continue;
    for (const m of p.models || []) {
      out.push({
        name: `${PREFIX}${p.id}/${m}`,
        displayName: m,
        providerId: p.id,
        providerName: p.name,
        cloud: true,
        family: p.name,
        params: 'cloud',
        quant: '',
        context: 0,
        capabilities: ['completion', 'tools'],
      });
    }
  }
  return out;
}

module.exports = {
  PRESETS, list, get, getWithKey, create, update, remove,
  fetchModels, test, resolve, modelEntries, PREFIX, publicView,
};
