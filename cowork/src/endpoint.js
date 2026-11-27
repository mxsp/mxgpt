'use strict';

/**
 * Multi-Provider LLM Endpoint Client for mx-Cowork:
 *
 *   1. mx-GPT Remote Endpoint (DEFAULT: https://max.fyreflysystems.de)
 *      Cookie auth (/api/login), SSE streaming (/api/chat), ephemeral chat cleanup.
 *   2. Direct Ollama Endpoint (Localhost / LAN)
 *      NDJSON streaming (/api/chat) with Inkling thinking calibration & queue priority headers.
 *   3. OpenAI & OpenAI-Compatible Providers
 *      OpenAI, OpenRouter, Groq, Google Gemini (OpenAI compat), Mistral, LM Studio, Custom.
 *      Bearer auth, /models discovery, SSE /chat/completions streaming (content + reasoning_content).
 *   4. Anthropic Claude API
 *      Native /v1/messages SSE streaming with x-api-key & anthropic-version headers.
 */

const storage = require('./storage');

const USER_AGENT = 'Mozilla/5.0 (compatible; mx-Cowork/1.2)';

const PROVIDER_PRESETS = [
  {
    id: 'mxgpt',
    label: 'mx-GPT (Default)',
    badge: 'Default',
    endpointType: 'mxgpt',
    endpointUrl: 'https://max.fyreflysystems.de',
    fastModel: 'lfm3:latest',
    smartModel: 'inkling-2-mini:latest',
    copilotBModel: 'nemotron-3.5-lightning',
    authMode: 'login',
    hint: 'Default hosted mx-GPT server at https://max.fyreflysystems.de (LFM3 Fast · Inkling Smart · nemotron-3.5-lightning Copilot B).',
  },
  {
    id: 'opencode_go',
    label: 'OpenCode Go',
    badge: 'Go',
    endpointType: 'openai',
    endpointUrl: 'https://opencode.ai/zen/go/v1',
    fastModel: 'glm-5.3-flash',
    smartModel: 'deepseek-v4.1-flash',
    authMode: 'apikey',
    hint: 'OpenCode Go (direct https://opencode.ai/zen/go/v1 — or sign in to https://max.fyreflysystems.de to use the proxied OpenCode Go models with no extra key).',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    endpointType: 'openai',
    endpointUrl: 'https://api.openai.com/v1',
    fastModel: 'gpt-4o-mini',
    smartModel: 'gpt-4o',
    authMode: 'apikey',
    hint: 'Official OpenAI API. Uses your OpenAI API key.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    endpointType: 'anthropic',
    endpointUrl: 'https://api.anthropic.com',
    fastModel: 'claude-3-5-haiku-latest',
    smartModel: 'claude-sonnet-4-20250514',
    authMode: 'apikey',
    hint: 'Anthropic Claude native Messages API (Haiku for Fast workers, Sonnet for Smart).',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    endpointType: 'openai',
    endpointUrl: 'https://openrouter.ai/api/v1',
    fastModel: 'openai/gpt-4o-mini',
    smartModel: 'anthropic/claude-3.5-sonnet',
    authMode: 'apikey',
    hint: 'OpenRouter unified API — mix any Fast & Smart model across providers.',
  },
  {
    id: 'groq',
    label: 'Groq',
    endpointType: 'openai',
    endpointUrl: 'https://api.groq.com/openai/v1',
    fastModel: 'llama-3.1-8b-instant',
    smartModel: 'llama-3.3-70b-versatile',
    authMode: 'apikey',
    hint: 'Ultra-fast Groq inference (Llama 3.1 8B Fast + Llama 3.3 70B Smart).',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    endpointType: 'openai',
    endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    fastModel: 'gemini-2.5-flash',
    smartModel: 'gemini-2.5-pro',
    authMode: 'apikey',
    hint: 'Google Gemini via its OpenAI-compatible endpoint (AI Studio API key).',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    endpointType: 'openai',
    endpointUrl: 'https://api.mistral.ai/v1',
    fastModel: 'mistral-small-latest',
    smartModel: 'mistral-large-latest',
    authMode: 'apikey',
    hint: 'Mistral AI API (Mistral Small Fast + Mistral Large Smart).',
  },
  {
    id: 'ollama',
    label: 'Direct Ollama',
    endpointType: 'ollama',
    endpointUrl: 'http://127.0.0.1:11434',
    fastModel: 'lfm3:latest',
    smartModel: 'inkling-2-mini:latest',
    authMode: 'none',
    hint: 'Local or LAN Ollama server (no API key required).',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    endpointType: 'openai',
    endpointUrl: 'http://127.0.0.1:1234/v1',
    fastModel: 'local-model',
    smartModel: 'local-model',
    authMode: 'apikey-optional',
    hint: 'Local LM Studio / llama.cpp / vLLM OpenAI-compatible server.',
  },
  {
    id: 'custom_openai',
    label: 'Custom OpenAI-Compat',
    endpointType: 'openai',
    endpointUrl: 'https://api.example.com/v1',
    fastModel: '',
    smartModel: '',
    authMode: 'apikey-optional',
    hint: 'Any OpenAI-compatible API endpoint (Together, DeepSeek, LiteLLM, vLLM, etc.).',
  },
];

let sessionCookie = '';
let sessionKey = ''; // endpointUrl + username

function cookieHeaderFromRes(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const pairs = [];
  for (const raw of setCookies) {
    const first = String(raw || '').split(';')[0].trim();
    if (first && first.includes('=')) pairs.push(first);
  }
  return pairs.join('; ');
}

function resetSession() {
  sessionCookie = '';
  sessionKey = '';
}

function normalizeOpenAIBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/i, '');
  return u;
}

function normalizeAnthropicBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/v1\/messages$/i, '').replace(/\/v1$/i, '');
  return u;
}

async function ensureMxgptAuth(cfg, force = false) {
  const key = `${cfg.endpointUrl}|${cfg.username}`;
  if (!force && sessionCookie && sessionKey === key) return sessionCookie;
  if (!cfg.username || !cfg.password) {
    // Some local/LAN mx-GPT instances have AUTH_REQUIRED=0, try unauthenticated first
    const probe = await fetch(`${cfg.endpointUrl}/api/models`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (probe.ok) {
      sessionCookie = '';
      sessionKey = key;
      return '';
    }
    throw new Error(`Sign-in required: open Settings and enter your ${cfg.endpointUrl} username and password.`);
  }

  const res = await fetch(`${cfg.endpointUrl}/api/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    let msg = `Login failed (HTTP ${res.status})`;
    try {
      const d = await res.json();
      if (d?.error) msg = d.error;
    } catch {}
    throw new Error(msg);
  }
  const cookie = cookieHeaderFromRes(res);
  sessionCookie = cookie;
  sessionKey = key;
  return cookie;
}

async function mxgptFetch(cfg, reqPath, opts = {}, retryAuth = true) {
  const cookie = await ensureMxgptAuth(cfg, false);
  const headers = {
    'user-agent': USER_AGENT,
    ...(opts.headers || {}),
  };
  if (cookie) headers.cookie = cookie;

  const res = await fetch(`${cfg.endpointUrl}${reqPath}`, { ...opts, headers });
  if (res.status === 401 && retryAuth && cfg.username && cfg.password) {
    await ensureMxgptAuth(cfg, true);
    return mxgptFetch(cfg, reqPath, opts, false);
  }
  return res;
}

function resolveInklingThink(model, think) {
  const isInkling = /^inkling/i.test(String(model || ''));
  if (!isInkling) {
    if (think === 'off' || think === false) return false;
    if (['low', 'medium', 'high', 'max'].includes(think)) return think;
    return false;
  }
  // Inkling 2 Mini's native minimal avoids the hidden-thinking stall on false/none
  if (think === 'off' || think === false || think === 'low' || think === 'minimal') return 'minimal';
  if (think === 'medium') return 'low';
  if (think === 'high' || think === 'max') return think;
  return 'minimal';
}

function openAIHeaders(cfg) {
  const h = {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
  };
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  if (/opencode\.ai|\/opencode\/v1/i.test(cfg.endpointUrl || '')) {
    h['x-opencode-session'] = `mxcw-${Date.now().toString(36)}`;
  }
  if (/openrouter\.ai/i.test(cfg.endpointUrl || '')) {
    h['HTTP-Referer'] = 'https://github.com/mxsp/mxgpt';
    h['X-Title'] = 'mx-Cowork';
  }
  return h;
}

function anthropicHeaders(cfg) {
  const h = {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    'anthropic-version': '2023-06-01',
  };
  if (cfg.apiKey) {
    h['x-api-key'] = cfg.apiKey;
    if (/opencode\.ai|\/opencode\/v1/i.test(cfg.endpointUrl || '')) {
      h.authorization = `Bearer ${cfg.apiKey}`;
    }
  }
  if (/opencode\.ai|\/opencode\/v1/i.test(cfg.endpointUrl || '')) {
    h['x-opencode-session'] = `mxcw-${Date.now().toString(36)}`;
  }
  return h;
}

async function testConnection(overrideCfg = null) {
  const saved = storage.getSettings();
  const cfg = { ...saved, ...(overrideCfg || {}) };
  if (overrideCfg?.password === '__KEEP__') cfg.password = saved.password;
  if (overrideCfg?.apiKey === '__KEEP__') cfg.apiKey = saved.apiKey;
  if (!cfg.endpointUrl) throw new Error('Endpoint URL is required');
  cfg.endpointUrl = String(cfg.endpointUrl).trim().replace(/\/+$/, '');

  const t0 = Date.now();

  if (cfg.endpointType === 'ollama') {
    const res = await fetch(`${cfg.endpointUrl}/api/tags`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.models || []).map((m) => ({
      name: m.name,
      params: m.details?.parameter_size || '',
      size: m.size || 0,
    }));
    return {
      ok: true,
      endpointType: 'ollama',
      endpointUrl: cfg.endpointUrl,
      latencyMs: Date.now() - t0,
      models,
    };
  }

  if (cfg.endpointType === 'openai') {
    const base = normalizeOpenAIBase(cfg.endpointUrl);
    const res = await fetch(`${base}/models`, {
      headers: openAIHeaders(cfg),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      const txt = (await res.text().catch(() => '')).slice(0, 240);
      throw new Error(`OpenAI-compatible HTTP ${res.status}: ${txt || res.statusText}`);
    }
    const data = await res.json();
    const rawList = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const models = rawList
      .map((m) => ({
        name: m.id || m.name || '',
        displayName: m.name || m.id || '',
      }))
      .filter((m) => m.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      ok: true,
      endpointType: 'openai',
      endpointUrl: base,
      latencyMs: Date.now() - t0,
      models,
    };
  }

  if (cfg.endpointType === 'anthropic') {
    if (!cfg.apiKey) throw new Error('Anthropic API key is required');
    const base = normalizeAnthropicBase(cfg.endpointUrl || 'https://api.anthropic.com');
    const res = await fetch(`${base}/v1/models?limit=40`, {
      headers: anthropicHeaders(cfg),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      const txt = (await res.text().catch(() => '')).slice(0, 240);
      throw new Error(`Anthropic HTTP ${res.status}: ${txt || res.statusText}`);
    }
    const data = await res.json();
    const models = (data.data || []).map((m) => ({
      name: m.id,
      displayName: m.display_name || m.id,
    }));
    return {
      ok: true,
      endpointType: 'anthropic',
      endpointUrl: base,
      latencyMs: Date.now() - t0,
      models,
    };
  }

  // Default: mx-GPT remote endpoint (https://max.fyreflysystems.de)
  resetSession();
  const res = await mxgptFetch(cfg, '/api/models', { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const txt = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`mx-GPT HTTP ${res.status}: ${txt || res.statusText}`);
  }
  const data = await res.json();
  const overboost = Boolean(saved.overboostEnabled);
  const rawModels = Array.isArray(data.models) ? data.models : [];
  const filteredModels = overboost
    ? rawModels
    : rawModels.filter((m) => !(/^opencode-go\//i.test(m.name || '') || m.providerId === 'opencode-go'));
  return {
    ok: true,
    endpointType: 'mxgpt',
    endpointUrl: cfg.endpointUrl,
    latencyMs: Date.now() - t0,
    overboost,
    models: filteredModels.map((m) => ({
      name: m.name,
      displayName: m.displayName || m.name,
      mode: m.mode || '',
      params: m.params || '',
      providerId: m.providerId || '',
      providerName: m.providerName || '',
      cloud: Boolean(m.cloud),
    })),
  };
}

/**
 * Run a single completion turn against the configured provider
 * (mx-GPT default, Ollama, OpenAI-compatible, or Anthropic).
 * Streams tokens via onEvent({ type: 'queue'|'thinking'|'text', ... }).
 */
async function chatCompletion({
  tier = 'fast', // 'fast' | 'smart'
  model = '',
  systemPrompt = '',
  messages = [],
  images = [],
  tools = [],
  toolChoice = 'auto',
  think = 'off',
  priority = '',
  signal,
  onEvent,
}) {
  const cfg = storage.getSettings();
  const chosenModel = model || (tier === 'smart' ? cfg.smartModel : cfg.fastModel);
  const effectivePriority = priority || (tier === 'fast' ? 'fast' : 'smart');
  const cleanImages = Array.isArray(images)
    ? images.filter((i) => i && i.data).slice(0, 4)
    : [];

  if (cfg.endpointType === 'ollama') {
    return chatViaOllama(cfg, {
      model: chosenModel,
      systemPrompt,
      messages,
      images: cleanImages,
      think,
      priority: effectivePriority,
      signal,
      onEvent,
    });
  }
  if (cfg.endpointType === 'openai') {
    // OpenCode Go routes MiniMax models through Anthropic-compatible /v1/messages
    const isOpencodeGo = /opencode\.ai\/zen\/go/i.test(cfg.endpointUrl || '');
    if (isOpencodeGo && /^minimax/i.test(chosenModel)) {
      const goBase = String(cfg.endpointUrl).replace(/\/v1\/?$/, '');
      return chatViaAnthropic({ ...cfg, endpointUrl: goBase }, {
        model: chosenModel,
        systemPrompt,
        messages,
        images: cleanImages,
        think,
        signal,
        onEvent,
      });
    }
    return chatViaOpenAI(cfg, {
      model: chosenModel,
      systemPrompt,
      messages,
      images: cleanImages,
      tools,
      toolChoice,
      think,
      signal,
      onEvent,
    });
  }
  if (cfg.endpointType === 'anthropic') {
    return chatViaAnthropic(cfg, {
      model: chosenModel,
      systemPrompt,
      messages,
      images: cleanImages,
      think,
      signal,
      onEvent,
    });
  }
  // Models prefixed with "opencode-go/" on mx-GPT route through the proxied /opencode/v1 endpoint on max.fyreflysystems.de
  if (/^opencode-go\//i.test(chosenModel)) {
    return chatViaMxgptOpencodeProxy(cfg, {
      model: chosenModel.replace(/^opencode-go\//i, ''),
      systemPrompt,
      messages,
      images: cleanImages,
      tools,
      toolChoice,
      think,
      signal,
      onEvent,
    });
  }
  return chatViaMxgpt(cfg, {
    model: chosenModel,
    systemPrompt,
    messages,
    images: cleanImages,
    think,
    signal,
    onEvent,
  });
}

async function chatViaOpenAI(cfg, { model, systemPrompt, messages, images = [], tools = [], toolChoice = 'auto', think = 'off', signal, onEvent }) {
  const base = normalizeOpenAIBase(cfg.endpointUrl);
  const fullMsgs = [];
  if (systemPrompt) fullMsgs.push({ role: 'system', content: systemPrompt });
  messages.forEach((m, idx) => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const isLastUser = idx === messages.length - 1 && role === 'user' && images.length > 0;
    if (isLastUser) {
      fullMsgs.push({
        role,
        content: [
          { type: 'text', text: String(m.content || '') },
          ...images.map((im) => ({
            type: 'image_url',
            image_url: { url: `data:${im.mimeType || 'image/png'};base64,${im.data}` },
          })),
        ],
      });
    } else {
      fullMsgs.push({ role, content: String(m.content || '') });
    }
  });

  const body = {
    model,
    messages: fullMsgs,
    stream: true,
    temperature: 0.4,
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  if (think && think !== 'off') {
    body.reasoning_effort = think === 'max' ? 'high' : think;
  }

  const t0 = Date.now();
  let firstTokenAt = 0;
  let res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: openAIHeaders(cfg),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok && (res.status === 400 || res.status === 422) && (body.reasoning_effort || body.tools)) {
    const retryBody = { ...body };
    delete retryBody.reasoning_effort;
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: openAIHeaders(cfg),
      body: JSON.stringify(retryBody),
      signal,
    });
    if (!res.ok && (res.status === 400 || res.status === 422) && retryBody.tools) {
      delete retryBody.tools;
      delete retryBody.tool_choice;
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: openAIHeaders(cfg),
        body: JSON.stringify(retryBody),
        signal,
      });
    }
  }
  if (!res.ok) {
    const errTxt = (await res.text().catch(() => '')).slice(0, 350);
    throw new Error(`Provider HTTP ${res.status}: ${errTxt || res.statusText}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let thinking = '';
  const rawToolCalls = [];
  let promptTokens = 0;
  let evalTokens = 0;
  let chunks = 0;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(payload); } catch { return; }
    if (obj.error) {
      throw new Error(obj.error.message || JSON.stringify(obj.error));
    }
    const delta = obj.choices?.[0]?.delta || obj.choices?.[0]?.message || {};
    const rDelta = delta.reasoning_content || delta.reasoning || delta.thinking || '';
    if (rDelta) {
      if (!firstTokenAt) firstTokenAt = Date.now();
      thinking += rDelta;
      chunks++;
      onEvent?.({ type: 'thinking', delta: rDelta });
    }
    if (delta.content) {
      if (!firstTokenAt) firstTokenAt = Date.now();
      content += delta.content;
      chunks++;
      onEvent?.({ type: 'text', delta: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const [i, tc] of delta.tool_calls.entries()) {
        const idx = tc.index ?? i;
        rawToolCalls[idx] = rawToolCalls[idx] || { id: '', name: '', arguments: '' };
        if (tc.id) rawToolCalls[idx].id = tc.id;
        if (tc.function?.name) rawToolCalls[idx].name += tc.function.name;
        if (tc.function?.arguments) rawToolCalls[idx].arguments += tc.function.arguments;
      }
      if (!firstTokenAt) firstTokenAt = Date.now();
      chunks++;
    }
    if (obj.usage) {
      promptTokens = obj.usage.prompt_tokens || promptTokens;
      evalTokens = obj.usage.completion_tokens || evalTokens;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) handleLine(buf);

  const toolCalls = rawToolCalls.filter((c) => c && c.name).map((c, i) => {
    let args = {};
    try { args = JSON.parse(c.arguments || '{}'); } catch { args = {}; }
    return { id: c.id || `tc_${Date.now().toString(36)}_${i}`, name: c.name, args };
  });

  const elapsedMs = Date.now() - t0;
  const genSec = Math.max(0.05, (Date.now() - (firstTokenAt || t0)) / 1000);
  const estTokens = evalTokens || Math.max(chunks, Math.round((content.length + thinking.length) / 4));
  const tokensPerSec = estTokens > 0 ? Number((estTokens / genSec).toFixed(1)) : 0;

  return {
    content: content.trim(),
    thinking: thinking.trim(),
    toolCalls,
    model,
    elapsedMs,
    usage: { promptTokens, evalTokens: estTokens, tokensPerSec },
  };
}

async function chatViaAnthropic(cfg, { model, systemPrompt, messages, images = [], signal, onEvent }) {
  if (!cfg.apiKey) throw new Error('Anthropic API key is required (open Settings).');
  const base = normalizeAnthropicBase(cfg.endpointUrl || 'https://api.anthropic.com');

  // Anthropic requires strictly alternating user/assistant messages starting with user
  const cleanMsgs = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const text = String(m.content || '').trim();
    if (!text) continue;
    if (cleanMsgs.length && cleanMsgs[cleanMsgs.length - 1].role === role) {
      cleanMsgs[cleanMsgs.length - 1].content += '\n\n' + text;
    } else {
      cleanMsgs.push({ role, content: text });
    }
  }
  if (!cleanMsgs.length || cleanMsgs[0].role !== 'user') {
    cleanMsgs.unshift({ role: 'user', content: 'Hello.' });
  }
  if (images.length && cleanMsgs[cleanMsgs.length - 1].role === 'user') {
    const last = cleanMsgs[cleanMsgs.length - 1];
    last.content = [
      ...images.map((im) => ({
        type: 'image',
        source: { type: 'base64', media_type: im.mimeType || 'image/png', data: im.data },
      })),
      { type: 'text', text: String(last.content || '') },
    ];
  }

  const body = {
    model,
    max_tokens: 4096,
    stream: true,
    messages: cleanMsgs,
  };
  if (systemPrompt) body.system = systemPrompt;

  const t0 = Date.now();
  let firstTokenAt = 0;
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: anthropicHeaders(cfg),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const errTxt = (await res.text().catch(() => '')).slice(0, 350);
    throw new Error(`Anthropic HTTP ${res.status}: ${errTxt || res.statusText}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let thinking = '';
  let promptTokens = 0;
  let evalTokens = 0;

  const handleBlock = (raw) => {
    let evName = '';
    const dataLines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) evName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let obj;
    try { obj = JSON.parse(dataLines.join('\n')); } catch { return; }

    if (evName === 'error' || obj.type === 'error') {
      throw new Error(obj.error?.message || 'Anthropic stream error');
    }
    if (obj.type === 'message_start' && obj.message?.usage) {
      promptTokens = obj.message.usage.input_tokens || promptTokens;
    } else if (obj.type === 'content_block_delta') {
      const d = obj.delta || {};
      if (d.type === 'thinking_delta' && d.thinking) {
        if (!firstTokenAt) firstTokenAt = Date.now();
        thinking += d.thinking;
        onEvent?.({ type: 'thinking', delta: d.thinking });
      } else if (d.type === 'text_delta' && d.text) {
        if (!firstTokenAt) firstTokenAt = Date.now();
        content += d.text;
        onEvent?.({ type: 'text', delta: d.text });
      }
    } else if (obj.type === 'message_delta' && obj.usage) {
      evalTokens = obj.usage.output_tokens || evalTokens;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      handleBlock(buf.slice(0, sep));
      buf = buf.slice(sep + 2);
    }
  }
  if (buf.trim()) handleBlock(buf);

  const elapsedMs = Date.now() - t0;
  const genSec = Math.max(0.05, (Date.now() - (firstTokenAt || t0)) / 1000);
  const estTokens = evalTokens || Math.round((content.length + thinking.length) / 4);
  const tokensPerSec = estTokens > 0 ? Number((estTokens / genSec).toFixed(1)) : 0;

  return {
    content: content.trim(),
    thinking: thinking.trim(),
    model,
    elapsedMs,
    usage: { promptTokens, evalTokens: estTokens, tokensPerSec },
  };
}

async function chatViaOllama(cfg, { model, systemPrompt, messages, images = [], think, priority, signal, onEvent }) {
  const fullMsgs = [];
  if (systemPrompt) fullMsgs.push({ role: 'system', content: systemPrompt });
  messages.forEach((m, idx) => {
    const item = { role: m.role, content: String(m.content || '') };
    if (idx === messages.length - 1 && m.role === 'user' && images.length > 0) {
      item.images = images.map((im) => im.data);
    }
    fullMsgs.push(item);
  });

  const body = {
    model,
    messages: fullMsgs,
    stream: true,
    keep_alive: -1,
    think: resolveInklingThink(model, think),
    options: {
      num_ctx: 32768,
      num_thread: 20,
      temperature: 0.4,
    },
  };

  const t0 = Date.now();
  const res = await fetch(`${cfg.endpointUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      'x-mx-queue-events': '1',
      'x-mx-user': cfg.username || 'cowork',
      'x-mx-priority': priority,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const errTxt = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Ollama HTTP ${res.status}: ${errTxt}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let thinking = '';
  let evalTokens = 0;
  let promptTokens = 0;
  let tokensPerSec = 0;

  const processLine = (line) => {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj._mx_queue) {
      onEvent?.({ type: 'queue', ...obj._mx_queue });
      return;
    }
    if (obj.error) throw new Error(obj.error);
    const msg = obj.message || {};
    if (msg.thinking) {
      thinking += msg.thinking;
      onEvent?.({ type: 'thinking', delta: msg.thinking });
    }
    if (msg.content) {
      content += msg.content;
      onEvent?.({ type: 'text', delta: msg.content });
    }
    if (obj.done) {
      evalTokens = obj.eval_count || 0;
      promptTokens = obj.prompt_eval_count || 0;
      const dur = (obj.eval_duration || 0) / 1e9;
      if (evalTokens && dur > 0) tokensPerSec = Number((evalTokens / dur).toFixed(1));
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      processLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) processLine(buf);

  return {
    content: content.trim(),
    thinking: thinking.trim(),
    model,
    elapsedMs: Date.now() - t0,
    usage: { promptTokens, evalTokens, tokensPerSec },
  };
}

async function chatViaMxgptOpencodeProxy(cfg, { model, systemPrompt, messages, images = [], tools = [], toolChoice = 'auto', think, signal, onEvent }) {
  const t0 = Date.now();
  const fullMsgs = [];
  if (systemPrompt) fullMsgs.push({ role: 'system', content: systemPrompt });
  messages.forEach((m, idx) => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const isLastUser = idx === messages.length - 1 && role === 'user' && images.length > 0;
    if (isLastUser) {
      fullMsgs.push({
        role,
        content: [
          { type: 'text', text: String(m.content || '') },
          ...images.map((im) => ({
            type: 'image_url',
            image_url: { url: `data:${im.mimeType || 'image/png'};base64,${im.data}` },
          })),
        ],
      });
    } else {
      fullMsgs.push({ role, content: String(m.content || '') });
    }
  });

  const body = {
    model,
    messages: fullMsgs,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  if (think && think !== 'off') {
    body.reasoning_effort = think === 'max' ? 'high' : think;
  }

  const doPost = (payload) => mxgptFetch(cfg, '/opencode/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-opencode-session': `mxcw-${Date.now().toString(36)}`,
    },
    body: JSON.stringify(payload),
    signal,
  });

  let res = await doPost(body);
  if (!res.ok && (res.status === 400 || res.status === 422) && (body.reasoning_effort || body.tools)) {
    const retryBody = { ...body };
    delete retryBody.reasoning_effort;
    res = await doPost(retryBody);
    if (!res.ok && (res.status === 400 || res.status === 422) && retryBody.tools) {
      delete retryBody.tools;
      delete retryBody.tool_choice;
      res = await doPost(retryBody);
    }
  }
  if (!res.ok) {
    const txt = (await res.text().catch(() => '')).slice(0, 350);
    throw new Error(`OpenCode Go proxy HTTP ${res.status}: ${txt || res.statusText}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let thinking = '';
  const rawToolCalls = [];
  let promptTokens = 0;
  let evalTokens = 0;

  const processLine = (line) => {
    const t = line.trim();
    if (!t || !t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(payload); } catch { return; }
    if (obj.error) throw new Error(obj.error.message || String(obj.error));
    const delta = obj.choices?.[0]?.delta || obj.choices?.[0]?.message || {};
    const r = delta.reasoning_content || delta.reasoning || delta.thinking || '';
    if (r) {
      thinking += r;
      onEvent?.({ type: 'thinking', delta: r });
    }
    const c = typeof delta.content === 'string' ? delta.content : '';
    if (c) {
      content += c;
      onEvent?.({ type: 'text', delta: c });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const [i, tc] of delta.tool_calls.entries()) {
        const idx = tc.index ?? i;
        rawToolCalls[idx] = rawToolCalls[idx] || { id: '', name: '', arguments: '' };
        if (tc.id) rawToolCalls[idx].id = tc.id;
        if (tc.function?.name) rawToolCalls[idx].name += tc.function.name;
        if (tc.function?.arguments) rawToolCalls[idx].arguments += tc.function.arguments;
      }
    }
    if (obj.usage) {
      promptTokens = obj.usage.prompt_tokens || promptTokens;
      evalTokens = obj.usage.completion_tokens || evalTokens;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      processLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) processLine(buf);

  const toolCalls = rawToolCalls.filter((c) => c && c.name).map((c, i) => {
    let args = {};
    try { args = JSON.parse(c.arguments || '{}'); } catch { args = {}; }
    return { id: c.id || `tc_${Date.now().toString(36)}_${i}`, name: c.name, args };
  });

  const elapsedMs = Date.now() - t0;
  const sec = elapsedMs / 1000;
  const tokensPerSec = evalTokens > 0 && sec > 0.2 ? Math.round((evalTokens / sec) * 10) / 10 : 0;
  return {
    content: content.trim(),
    thinking: thinking.trim(),
    toolCalls,
    model: `opencode-go/${model}`,
    elapsedMs,
    usage: { promptTokens, evalTokens, tokensPerSec },
  };
}

async function chatViaMxgpt(cfg, { model, systemPrompt, messages, images = [], think, signal, onEvent }) {
  const t0 = Date.now();
  // Create a temporary remote chat with custom systemPrompt so we get clean,
  // isolated coworker turns with zero cross-contamination, then delete it in finally.
  const createRes = await mxgptFetch(cfg, '/api/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: '__mx_cowork_tmp',
      model,
      systemPrompt: systemPrompt || '',
    }),
    signal,
  });
  if (!createRes.ok) {
    const txt = (await createRes.text().catch(() => '')).slice(0, 250);
    throw new Error(`mx-GPT chat init failed (${createRes.status}): ${txt}`);
  }
  const created = await createRes.json();
  const remoteChatId = (created.chat || created).id;

  // Pack conversation context cleanly into the single user turn
  let promptText = '';
  if (messages.length === 1) {
    promptText = String(messages[0].content || '');
  } else {
    const lines = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const m = messages[i];
      lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 2500)}`);
    }
    const last = messages[messages.length - 1];
    promptText = `<conversation_history>\n${lines.join('\n\n')}\n</conversation_history>\n\n${String(last?.content || '')}`;
  }

  let content = '';
  let thinking = '';
  let usage = { promptTokens: 0, evalTokens: 0, tokensPerSec: 0 };

  const onAbort = () => {
    mxgptFetch(cfg, '/api/chat/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: remoteChatId }),
    }).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const chatRes = await mxgptFetch(cfg, '/api/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        chatId: remoteChatId,
        model,
        content: promptText,
        ...(images.length ? { images: images.map((im) => im.data) } : {}),
        useWeb: false,
        useTools: false,
        useSubagents: false,
        useFiles: false,
        think: think || 'off',
      }),
      signal,
    });
    if (!chatRes.ok) {
      const txt = (await chatRes.text().catch(() => '')).slice(0, 300);
      throw new Error(`mx-GPT chat failed (${chatRes.status}): ${txt}`);
    }

    const reader = chatRes.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    const handleBlock = (raw) => {
      let evName = '';
      const dataLines = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) evName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!evName || !dataLines.length) return;
      let data;
      try { data = JSON.parse(dataLines.join('\n')); } catch { return; }

      if (evName === 'queue') {
        onEvent?.({ type: 'queue', ...data });
      } else if (evName === 'thinking') {
        const delta = data.delta || '';
        if (delta) {
          thinking += delta;
          onEvent?.({ type: 'thinking', delta });
        }
      } else if (evName === 'text') {
        const delta = data.delta || '';
        if (delta) {
          content += delta;
          onEvent?.({ type: 'text', delta });
        }
      } else if (evName === 'done') {
        if (data.usage) {
          usage = {
            promptTokens: data.usage.promptTokens || 0,
            evalTokens: data.usage.evalTokens || 0,
            tokensPerSec: data.usage.tokensPerSec || 0,
          };
        }
        if (!content && data.message?.content) content = data.message.content;
      } else if (evName === 'error') {
        throw new Error(data.message || 'Remote endpoint error');
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        handleBlock(block);
      }
    }
    if (buf.trim()) handleBlock(buf);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Clean up ephemeral remote chat quietly in background
    mxgptFetch(cfg, `/api/chats/${remoteChatId}`, { method: 'DELETE' }).catch(() => {});
  }

  return {
    content: content.trim(),
    thinking: thinking.trim(),
    model,
    elapsedMs: Date.now() - t0,
    usage,
  };
}

module.exports = {
  PROVIDER_PRESETS,
  testConnection,
  chatCompletion,
  resetSession,
};
