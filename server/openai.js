'use strict';
const { createThinkSplitter } = require('./ollama');

function normalizeMessages(messages) {
  return (messages || []).map((m) => {
    if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const img of m.images) {
        const b64 = typeof img === 'string' ? img : img.data;
        const mime = (typeof img === 'object' && img.mime) ? img.mime : 'image/jpeg';
        parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
      }
      const { images, ...rest } = m;
      return { ...rest, content: parts };
    }
    return m;
  });
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

async function fetchCompletion(url, headers, body, signal, providerName, baseUrl) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`Can't reach ${providerName} at ${baseUrl} (${e.cause?.code || e.message})`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const raw = await res.text();
      try {
        const j = JSON.parse(raw);
        detail = j.error?.message || j.message || raw;
      } catch { detail = raw; }
    } catch {}
    const err = new Error(`${providerName} error ${res.status}${detail ? ': ' + String(detail).slice(0, 400) : ''}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res;
}

/**
 * Stream an OpenAI-compatible chat completion.
 * Returns { content, thinking, tool_calls:[{id,name,args}], meta:{...} }
 */
async function streamChat({ baseUrl, apiKey, model, messages, tools, signal, options = {}, think = 'off', onEvent, providerName = 'Provider', sessionId = '' }) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (/opencode/i.test(baseUrl)) headers['x-opencode-session'] = sessionId || 'mxgpt-' + Date.now().toString(36);

  const body = {
    model,
    messages: normalizeMessages(messages),
    stream: true,
  };
  if (tools && tools.length) body.tools = tools;
  if (options.temperature !== undefined) body.temperature = Number(options.temperature);
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  if (think && think !== 'off') {
    body.reasoning_effort = think === 'max' ? 'high' : think;
  }

  let res;
  try {
    res = await fetchCompletion(url, headers, body, signal, providerName, baseUrl);
  } catch (err) {
    // Retry without reasoning_effort if the remote model/provider doesn't support it
    if ((err.status === 400 || err.status === 422) && body.reasoning_effort !== undefined && /reasoning|effort|think|unsupported|unknown|invalid/i.test(err.message || '')) {
      const retry = { ...body };
      delete retry.reasoning_effort;
      res = await fetchCompletion(url, headers, retry, signal, providerName, baseUrl);
    } else {
      throw err;
    }
  }

  const startedAt = Date.now();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = '';
  const calls = [];
  let meta = {};

  const splitter = createThinkSplitter((type, delta) => {
    if (type === 'thinking') {
      thinking += delta;
      onEvent?.({ type: 'thinking', delta });
    } else {
      content += delta;
      onEvent?.({ type: 'text', delta });
    }
  });

  const handleData = (raw) => {
    const line = raw.trim();
    if (!line || line === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(line); } catch { return; }
    if (chunk.error) throw new Error(chunk.error.message || String(chunk.error));
    const choice = chunk.choices?.[0] || {};
    const delta = choice.delta || choice.message || {};
    const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
    if (reasoning) {
      thinking += reasoning;
      onEvent?.({ type: 'thinking', delta: reasoning });
    }
    const text = textOf(delta.content);
    if (text) {
      splitter.push(text);
    }
    for (const [i, tc] of (delta.tool_calls || []).entries()) {
      const idx = tc.index ?? i;
      calls[idx] = calls[idx] || { id: '', name: '', args: '' };
      if (tc.id) calls[idx].id = tc.id;
      if (tc.function?.name) calls[idx].name += tc.function.name;
      if (tc.function?.arguments) calls[idx].args += tc.function.arguments;
    }
    if (chunk.usage) {
      const evalTokens = chunk.usage.completion_tokens || 0;
      const elapsedSec = (Date.now() - startedAt) / 1000;
      meta = {
        promptTokens: chunk.usage.prompt_tokens || 0,
        evalTokens,
        totalMs: Date.now() - startedAt,
        tokensPerSec: evalTokens > 0 && elapsedSec > 0.2 ? Math.round((evalTokens / elapsedSec) * 10) / 10 : 0,
      };
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) line = line.slice(5);
      handleData(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleData(buffer.replace(/^data:/, ''));
  splitter.flush();

  const toolCalls = calls.filter(Boolean).map((c, i) => {
    let args = {};
    try { args = JSON.parse(c.args || '{}'); } catch { args = { input: c.args }; }
    return { id: c.id || `call_${Date.now()}_${i}`, name: c.name, args };
  });

  return { role: 'assistant', content, thinking, tool_calls: toolCalls, meta };
}

module.exports = { streamChat };
