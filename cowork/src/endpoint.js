'use strict';

/**
 * Dual-mode LLM Endpoint Client:
 *   1. mx-GPT remote endpoint (https://max.fyreflysystems.de) — authenticates via
 *      POST /api/login, streams SSE via POST /api/chat, and auto-cleans ephemeral
 *      remote chats so the user's web sidebar stays tidy.
 *   2. Direct Ollama endpoint (http://127.0.0.1:11434 or LAN :11434/:11435) —
 *      streams NDJSON via POST /api/chat with Inkling thinking calibration and
 *      priority queue headers.
 */

const storage = require('./storage');

const USER_AGENT = 'Mozilla/5.0 (compatible; mx-Cowork/1.0)';

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
    throw new Error('Sign-in required: open Settings and enter your max.fyreflysystems.de username and password.');
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

async function mxgptFetch(cfg, path, opts = {}, retryAuth = true) {
  const cookie = await ensureMxgptAuth(cfg, false);
  const headers = {
    'user-agent': USER_AGENT,
    ...(opts.headers || {}),
  };
  if (cookie) headers.cookie = cookie;

  const res = await fetch(`${cfg.endpointUrl}${path}`, { ...opts, headers });
  if (res.status === 401 && retryAuth && cfg.username && cfg.password) {
    await ensureMxgptAuth(cfg, true);
    return mxgptFetch(cfg, path, opts, false);
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

async function testConnection(overrideCfg = null) {
  const cfg = { ...storage.getSettings(), ...(overrideCfg || {}) };
  if (overrideCfg?.password === '__KEEP__') cfg.password = storage.getSettings().password;
  if (!cfg.endpointUrl) throw new Error('Endpoint URL is required');

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

  // mx-GPT endpoint
  resetSession();
  const res = await mxgptFetch(cfg, '/api/models', { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const txt = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`mx-GPT HTTP ${res.status}: ${txt || res.statusText}`);
  }
  const data = await res.json();
  return {
    ok: true,
    endpointType: 'mxgpt',
    endpointUrl: cfg.endpointUrl,
    latencyMs: Date.now() - t0,
    models: (data.models || []).map((m) => ({
      name: m.name,
      displayName: m.displayName || m.name,
      mode: m.mode || '',
      params: m.params || '',
    })),
  };
}

/**
 * Run a single completion turn against the configured endpoint (mx-GPT or Ollama).
 * Streams tokens via onEvent({ type: 'queue'|'thinking'|'text', ... }).
 */
async function chatCompletion({
  tier = 'fast', // 'fast' | 'smart'
  model = '',
  systemPrompt = '',
  messages = [],
  think = 'off',
  priority = '',
  signal,
  onEvent,
}) {
  const cfg = storage.getSettings();
  const chosenModel = model || (tier === 'smart' ? cfg.smartModel : cfg.fastModel);
  const effectivePriority = priority || (tier === 'fast' ? 'fast' : 'smart');

  if (cfg.endpointType === 'ollama') {
    return chatViaOllama(cfg, {
      model: chosenModel,
      systemPrompt,
      messages,
      think,
      priority: effectivePriority,
      signal,
      onEvent,
    });
  }
  return chatViaMxgpt(cfg, {
    model: chosenModel,
    systemPrompt,
    messages,
    think,
    signal,
    onEvent,
  });
}

async function chatViaOllama(cfg, { model, systemPrompt, messages, think, priority, signal, onEvent }) {
  const fullMsgs = [];
  if (systemPrompt) fullMsgs.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    fullMsgs.push({ role: m.role, content: String(m.content || '') });
  }

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

async function chatViaMxgpt(cfg, { model, systemPrompt, messages, think, signal, onEvent }) {
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
  testConnection,
  chatCompletion,
  resetSession,
};
