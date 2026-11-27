'use strict';
const { OLLAMA_URL } = require('./config');

async function ollamaFetch(path, opts = {}) {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}${path}`, opts);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const reason = e.cause?.code || e.cause?.message || e.message;
    const err = new Error(`Can't reach Ollama at ${OLLAMA_URL} (${reason}). Is the Ollama service running?`);
    err.cause = e;
    throw err;
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch {}
    const err = new Error(`Ollama ${res.status}: ${detail || res.statusText}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res;
}

let _modelsCache = null;
let _modelsCacheAt = 0;
const MODELS_CACHE_TTL = 30_000;

async function listModels({ fresh = false } = {}) {
  if (!fresh && _modelsCache && Date.now() - _modelsCacheAt < MODELS_CACHE_TTL) {
    return _modelsCache;
  }
  const res = await ollamaFetch('/api/tags', { signal: AbortSignal.timeout(5000) });
  const data = await res.json();
  const models = (data.models || [])
    .filter((m) => !m.remote_model && (m.size || 0) > 1_000_000 && !/:cloud$/i.test(m.name))
    .map((m) => ({
      name: m.name,
      size: m.size,
      modified: m.modified_at,
      family: m.details?.family || '',
      params: m.details?.parameter_size || '',
      quant: m.details?.quantization_level || '',
      context: m.details?.context_length || 0,
      capabilities: m.capabilities || [],
    }));
  models.sort((a, b) => a.name.localeCompare(b.name));
  _modelsCache = models;
  _modelsCacheAt = Date.now();
  return models;
}

function invalidateModelsCache() {
  _modelsCache = null;
  _modelsCacheAt = 0;
}

function normalizeToolCalls(calls) {
  return (calls || []).map((c, i) => {
    let args = c.function?.arguments ?? c.arguments ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = { input: args }; }
    }
    return { id: c.id || `call_${Date.now()}_${i}`, name: c.function?.name || c.name || 'unknown', args };
  });
}

/**
 * Stateful splitter for inline <think>...</think> tags when a model outputs
 * reasoning inside content rather than a dedicated thinking field.
 */
function createThinkSplitter(onChunk) {
  const OPEN = '<think>';
  const CLOSE = '</think>';
  let inThink = false;
  let pending = '';
  let sawAny = false;
  let trimAfterClose = false;

  const emit = (type, text) => {
    if (!text) return;
    if (type === 'text' && trimAfterClose) {
      text = text.replace(/^\s+/, '');
      if (!text) return;
      trimAfterClose = false;
    }
    onChunk(type, text);
  };

  function partialSuffixLen(str, tag) {
    const max = Math.min(str.length, tag.length - 1);
    for (let len = max; len > 0; len--) {
      if (str.endsWith(tag.slice(0, len))) return len;
    }
    return 0;
  }

  return {
    push(chunk) {
      if (!chunk) return;
      pending += chunk;
      while (pending.length) {
        if (!inThink) {
          const idx = pending.indexOf(OPEN);
          if (idx >= 0) {
            if (idx > 0) emit('text', pending.slice(0, idx));
            pending = pending.slice(idx + OPEN.length);
            inThink = true;
            sawAny = true;
            continue;
          }
          // Only look for <think> near the start or anywhere if not yet closed
          const keep = partialSuffixLen(pending, OPEN);
          const safe = pending.slice(0, pending.length - keep);
          if (safe) {
            emit('text', safe);
            sawAny = true;
          }
          pending = pending.slice(pending.length - keep);
          break;
        } else {
          const idx = pending.indexOf(CLOSE);
          if (idx >= 0) {
            if (idx > 0) emit('thinking', pending.slice(0, idx));
            pending = pending.slice(idx + CLOSE.length);
            inThink = false;
            trimAfterClose = true;
            continue;
          }
          const keep = partialSuffixLen(pending, CLOSE);
          const safe = pending.slice(0, pending.length - keep);
          if (safe) emit('thinking', safe);
          pending = pending.slice(pending.length - keep);
          break;
        }
      }
    },
    flush() {
      if (pending) {
        emit(inThink ? 'thinking' : 'text', pending);
        pending = '';
      }
    },
    get sawAny() { return sawAny; },
  };
}

function resolveThinkValue(think, capabilities = [], model = '') {
  const hasCaps = Array.isArray(capabilities) && capabilities.length > 0;
  if (hasCaps && !capabilities.includes('thinking')) return undefined;
  const isInkling = /^inkling/i.test(String(model || ''));
  if (isInkling) {
    // Inkling 2 Mini's native `false`/`none` still emits lengthy hidden reasoning tokens
    // (~30-60s blank wait). Mapping Off/Low -> native `minimal` gives immediate streaming,
    // short crisp reasoning, and ~1.6x faster total response time with zero quality loss.
    if (think === false || think === 'off' || think === 'none' || think === 'minimal') return 'minimal';
    if (think === 'low') return 'minimal';
    if (think === 'medium') return 'low';
    if (think === 'high' || think === true || think === 'on') return 'high';
    if (think === 'max') return 'max';
    return 'minimal';
  }
  if (think === false || think === 'off' || think === 'none') return false;
  if (['minimal', 'low', 'medium', 'high', 'max'].includes(think)) return think;
  if (think === true || think === 'on') return true;
  return false;
}

async function postChatWithThinkFallback(body, signal, extraHeaders = {}) {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  try {
    return await ollamaFetch('/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Graceful fallback if a specific model rejects string think levels or think=false
    if (err.status === 400 && /think/i.test(err.message || '') && body.think !== undefined) {
      const retry = { ...body };
      if (typeof body.think === 'string') {
        retry.think = true;
      } else if (body.think === false) {
        // Some models (e.g. gpt-oss on certain templates) require a level instead of false
        delete retry.think;
      } else {
        delete retry.think;
      }
      return ollamaFetch('/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(retry),
        signal,
      });
    }
    throw err;
  }
}

/**
 * Stream a chat completion from Ollama.
 * onEvent({type:'queue'|'thinking'|'text', ...}) is called for every chunk.
 * Resolves with the full assistant message.
 */
async function streamChat({ model, messages, tools, signal, options = {}, keepAlive, think = 'off', capabilities = [], user = '', priority = '', onEvent }) {
  const body = { model, messages, stream: true, options };
  const thinkVal = resolveThinkValue(think, capabilities, model);
  if (thinkVal !== undefined) body.think = thinkVal;
  if (keepAlive !== undefined) body.keep_alive = keepAlive;
  if (tools && tools.length) body.tools = tools;

  const extraHeaders = { 'x-mx-queue-events': '1' };
  if (user) extraHeaders['x-mx-user'] = String(user).slice(0, 64);
  if (priority) extraHeaders['x-mx-priority'] = String(priority).slice(0, 24);

  const res = await postChatWithThinkFallback(body, signal, extraHeaders);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = '';
  let toolCalls = [];
  let meta = {};
  let doneReason = 'stop';

  const splitter = createThinkSplitter((type, delta) => {
    if (type === 'thinking') {
      thinking += delta;
      onEvent?.({ type: 'thinking', delta });
    } else {
      content += delta;
      onEvent?.({ type: 'text', delta });
    }
  });

  const handleLine = (line) => {
    if (!line.trim()) return;
    let chunk;
    try { chunk = JSON.parse(line); } catch { return; }
    if (chunk._mx_queue) {
      onEvent?.({ type: 'queue', ...chunk._mx_queue });
      return;
    }
    if (chunk.error) throw new Error(chunk.error);
    const msg = chunk.message || {};
    if (msg.thinking) {
      thinking += msg.thinking;
      onEvent?.({ type: 'thinking', delta: msg.thinking });
    }
    if (msg.content) {
      splitter.push(msg.content);
    }
    if (msg.tool_calls) {
      toolCalls = toolCalls.concat(normalizeToolCalls(msg.tool_calls));
    }
    if (chunk.done) {
      const evalCount = chunk.eval_count || 0;
      const evalDurSec = (chunk.eval_duration || 0) / 1e9;
      meta = {
        promptTokens: chunk.prompt_eval_count || 0,
        evalTokens: evalCount,
        totalMs: Math.round((chunk.total_duration || 0) / 1e6),
        loadMs: Math.round((chunk.load_duration || 0) / 1e6),
        evalMs: Math.round((chunk.eval_duration || 0) / 1e6),
        tokensPerSec: evalDurSec > 0.05 ? Math.round((evalCount / evalDurSec) * 10) / 10 : 0,
      };
      doneReason = chunk.done_reason || 'stop';
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleLine(buffer);
  splitter.flush();

  return { role: 'assistant', content, thinking, tool_calls: toolCalls, doneReason, meta };
}

async function complete({ model, messages, options = {}, keepAlive, signal }) {
  const body = { model, messages, stream: false, options };
  if (keepAlive !== undefined) body.keep_alive = keepAlive;
  const res = await ollamaFetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json();
  return data.message || { role: 'assistant', content: '' };
}

async function version() {
  const res = await ollamaFetch('/api/version');
  return (await res.json()).version || 'unknown';
}

async function ps() {
  const res = await ollamaFetch('/api/ps');
  const data = await res.json();
  return (data.models || []).map((m) => ({
    name: m.name,
    size: m.size,
    sizeVram: m.size_vram,
    context: m.context_length || m.details?.context_length || 0,
    expiresAt: m.expires_at,
  }));
}

async function unloadModel(model) {
  await ollamaFetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 }),
  });
  return { ok: true, model };
}

async function deleteModel(model) {
  await ollamaFetch('/api/delete', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  invalidateModelsCache();
  return { ok: true, model };
}

async function ensureModel(model) {
  const res = await ollamaFetch('/api/show', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  return res.json();
}

module.exports = {
  listModels,
  invalidateModelsCache,
  streamChat,
  complete,
  ensureModel,
  normalizeToolCalls,
  createThinkSplitter,
  version,
  ps,
  unloadModel,
  deleteModel,
};
