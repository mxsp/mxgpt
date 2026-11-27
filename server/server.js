'use strict';
const http = require('http');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { URL } = require('url');

const config = require('./config');
const store = require('./store');
const auth = require('./auth');
const ollama = require('./ollama');
const tools = require('./tools');
const files = require('./files');
const notes = require('./notes');
const subagents = require('./subagents');
const browser = require('./browser');
const providers = require('./providers');
const openai = require('./openai');
const live = require('./browser-live');

const { PORT, HOST, PUBLIC_DIR, VERSION } = config;
const activeRuns = new Map();

function broadcastRun(run, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...run.subscribers]) {
    if (res.writableEnded || res.destroyed) {
      run.subscribers.delete(res);
      continue;
    }
    try { res.write(payload); } catch { run.subscribers.delete(res); }
  }
}

function attachRunSubscriber(run, res, { sendSnapshot = false } = {}) {
  try { res.socket?.setNoDelay?.(true); } catch {}
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) { clearInterval(heartbeat); return; }
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 15000);

  const detach = () => {
    clearInterval(heartbeat);
    run.subscribers.delete(res);
  };
  res.on('close', detach);
  res.on('error', detach);
  run.subscribers.add(res);

  if (sendSnapshot) {
    try {
      res.write(`event: snapshot\ndata: ${JSON.stringify({
        chat: { id: run.chatId, title: run.title, model: run.model, persona: run.persona || '' },
        userMessage: run.userMessage,
        assistant: run.assistant,
        phase: run.phase,
        queue: run.queue || null,
        startedAt: run.startedAt,
      })}\n\n`);
    } catch { detach(); return; }
  }
  if (run.finished && run.finalEvent) {
    try {
      res.write(`event: ${run.finalEvent.event}\ndata: ${JSON.stringify(run.finalEvent.data)}\n\n`);
      res.end();
    } catch {}
    detach();
  }
}

function listActiveRuns(owner) {
  const out = [];
  for (const r of activeRuns.values()) {
    if (owner !== undefined && owner !== null && r.owner !== owner) continue;
    if (r.finished) continue;
    out.push({
      chatId: r.chatId,
      title: r.title,
      model: r.model,
      think: r.think,
      phase: r.phase,
      queue: r.queue || null,
      startedAt: r.startedAt,
    });
  }
  return out;
}

function detectOpenArtifact(text) {
  const re = /```([^\n]*)\n/g;
  let m, inBlock = false, blockIsArt = false;
  while ((m = re.exec(text))) {
    if (!inBlock) {
      inBlock = true;
      const lang = (m[1] || '').trim().split(/\s+/)[0].toLowerCase();
      blockIsArt = ['artifact', 'html', 'htm', 'svg', 'jsx', 'tsx', 'react', 'mermaid'].includes(lang);
    } else {
      inBlock = false;
      blockIsArt = false;
    }
  }
  return inBlock && blockIsArt;
}

let HAS_PLAYWRIGHT = false;
try {
  require.resolve('playwright');
  HAS_PLAYWRIGHT = true;
} catch {}

const PERSONAS = {
  default: {
    id: 'default',
    name: 'Default',
    desc: 'Warm, direct, well-structured assistant',
    prompt: '',
  },
  coder: {
    id: 'coder',
    name: 'Coder',
    desc: 'Senior engineer focused on clean, working code',
    prompt: 'Act as a pragmatic senior software engineer. Favor clean, idiomatic, runnable code with minimal boilerplate. Explain trade-offs briefly and point out edge cases.',
  },
  researcher: {
    id: 'researcher',
    name: 'Researcher',
    desc: 'Deep synthesis with structured analysis and citations',
    prompt: 'Act as a rigorous research analyst. Organize answers with clear headings, compare multiple perspectives, distinguish verified facts from assumptions, and cite sources clearly.',
  },
  writer: {
    id: 'writer',
    name: 'Writer',
    desc: 'Clear, engaging prose and editorial polish',
    prompt: 'Act as a skilled writer and editor. Craft crisp, vivid prose with natural rhythm and clarity. Avoid cliches and filler.',
  },
  tutor: {
    id: 'tutor',
    name: 'Tutor',
    desc: 'Step-by-step explanations with intuitive examples',
    prompt: 'Act as a patient, encouraging tutor. Break concepts into clear steps, use concrete analogies and examples, and highlight common pitfalls.',
  },
  concise: {
    id: 'concise',
    name: 'Concise',
    desc: 'Ultra-brief, straight to the point',
    prompt: 'Be maximally concise. Answer directly in as few words or bullet points as possible without sacrificing accuracy. Skip preamble and sign-offs.',
  },
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    req.on('error', reject);
  });
}
function clientIp(req) {
  const remote = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if (remote === '127.0.0.1' || remote === '::1') {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (/^[0-9a-f.:]{3,45}$/i.test(cf)) return cf;
  }
  return remote;
}

async function serveStatic(res, filePath, { cache = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const type = TYPES[ext] || 'application/octet-stream';
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    const etag = `W/${stat.size}-${Math.floor(stat.mtimeMs)}`;
    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'cache-control': cache ? 'public, max-age=86400' : 'no-cache',
      etag,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    text(res, 404, 'Not found');
  }
}

function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return 'https://example.com';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// ---------------------------------------------------------------- models
async function allModels() {
  let local = [];
  try { local = await ollama.listModels(); } catch (e) { console.error('[models]', e.message); }
  // Only expose the configured Smart / Fast models; every other local model is
  // still installed on the host but hidden from the picker.
  const byName = new Map(local.map((m) => [m.name, m]));
  const modes = [];
  for (const [key, def] of Object.entries(config.LOCAL_MODES)) {
    const m = byName.get(def.model);
    if (m) modes.push({ ...m, mode: key, modeLabel: def.label, modeHint: def.hint, displayName: `${def.label} — ${def.hint}` });
    else modes.push({
      name: def.model,
      params: def.hint,
      quant: '',
      size: 0,
      capabilities: ['completion'],
      mode: key,
      modeLabel: def.label,
      modeHint: def.hint,
      displayName: `${def.label} — ${def.hint}`,
    });
  }
  // Always expose the two modes, even while Ollama is busy loading a model and
  // /api/tags is slow or failing — the picker must never lose Smart / Fast.
  return modes.concat(providers.modelEntries());
}

function remoteSupportsVision(modelId) {
  return /gemini|gpt-4o|gpt-4\.1|gpt-5|gpt-6|claude|qwen.*vl|pixtral|vision|gemma-4|grok-4|kimi-k2\.7|omni/i.test(String(modelId || ''));
}

// ---------------------------------------------------------------- PDF text helper
async function extractPdfText(absPath) {
  // Try pdftotext if available on host
  const viaCli = await new Promise((resolve) => {
    execFile('pdftotext', ['-layout', absPath, '-'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout || !stdout.trim()) return resolve(null);
      resolve(stdout.trim());
    });
  });
  if (viaCli) return viaCli.slice(0, 120000);

  // Pure-JS fallback for basic uncompressed / FlateDecode PDFs
  try {
    const buf = await fsp.readFile(absPath);
    const raw = buf.toString('latin1');
    const pieces = [];
    const extractFromStream = (str) => {
      for (const m of str.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g)) {
        pieces.push(m[1].replace(/\\([()\\])/g, '$1').replace(/\\n/g, '\n'));
      }
      for (const m of str.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
        const inner = [...m[1].matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)]
          .map((x) => x[1].replace(/\\([()\\])/g, '$1'))
          .join('');
        if (inner) pieces.push(inner);
      }
    };
    const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let sm;
    while ((sm = streamRe.exec(raw)) && pieces.length < 2000) {
      const chunk = Buffer.from(sm[1], 'latin1');
      try {
        const inflated = zlib.inflateSync(chunk).toString('latin1');
        extractFromStream(inflated);
      } catch {
        extractFromStream(sm[1]);
      }
    }
    const textOut = pieces.join(' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
    return textOut.length > 20 ? textOut.slice(0, 120000) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- system prompt
// Compact, cache-friendly system prompt: every extra token costs ~40-50 ms TTFT on CPU.
function systemPrompt({ useWeb, useFiles, useCalcTools, useNoteTools, useSubagents, subagentModels = [], persona, chatSystemPrompt, owner }) {
  const cfg = config.readConfig();
  const today = new Date().toISOString().slice(0, 10);
  const parts = [
    `You are mx-GPT, a concise, helpful private AI assistant. Today: ${today}. Use Markdown; put self-contained visual outputs in a single \`html\`, \`svg\`, \`jsx\`, or \`mermaid\` code block for live preview. Never invent facts or URLs.`,
  ];
  const activePersona = PERSONAS[persona || cfg.persona || 'default'];
  if (activePersona && activePersona.prompt) {
    parts.push(activePersona.prompt);
  }
  if (useSubagents && subagentModels.length) {
    parts.push(`Subagents (<3B): delegate_subagent or delegate_parallel (roles: coder, researcher, analyst, summarizer, general) for parallel/offloaded subtasks, then synthesize.`);
  }
  if (useCalcTools) {
    parts.push(`Utility tools: calculate, get_datetime, run_js (sandbox).`);
  }
  if (useNoteTools) {
    const userNotes = notes.list(owner).slice(0, 6);
    parts.push(`Notes tools: save_note, list_notes, read_note.${userNotes.length ? ` Saved notes: ${userNotes.map((n) => n.title).join(', ')}.` : ''}`);
  }
  if (useWeb) {
    parts.push(`Web tools: web_search, deep_research, browse_url, wiki_lookup. Cite opened URLs as Markdown links; don't repeat identical calls.`);
  }
  if (useFiles) {
    parts.push(`Workspace tools: list_files, search_files, read_file, edit_file, write_file (relative paths; write only when asked).`);
  }
  if (chatSystemPrompt && chatSystemPrompt.trim()) {
    parts.push(`<chat_instructions>\n${chatSystemPrompt.trim()}\n</chat_instructions>`);
  }
  if (cfg.customInstructions && cfg.customInstructions.trim()) {
    parts.push(`<user_instructions>\n${cfg.customInstructions.trim()}\n</user_instructions>`);
  }
  return parts.join('\n\n');
}

// Fast zero-latency per-group tool routing for local CPU models:
// Every unused tool schema costs ~100-150 prompt tokens (~5-7s TTFT on Smart model).
// Groups are monotonically sticky within a chat once used, preserving Ollama KV checkpoints!
function historyUsedAny(history, names) {
  return (history || []).some((m) => (m.tools || []).some((t) => names.includes(t.name)));
}

function promptNeedsWeb(content, history = []) {
  if (historyUsedAny(history, ['web_search', 'deep_research', 'browse_url', 'wiki_lookup'])) return true;
  const text = String(content || '').trim();
  if (!text) return false;
  if (/https?:\/\/|\b[a-z0-9-]+\.(com|org|net|de|io|ai|dev|gov|edu|co\.uk)\b/i.test(text)) return true;
  if (/\b(search\s+(the\s+web|online|for)|google|bing|browse|deep\s+research|look\s?up|wiki|wikipedia|news|latest|newest|recent|today|tonight|yesterday|this\s+(week|month|year)|current(ly)?|right\s+now|as\s+of|live\s+(price|score|data|status)|stock\s+price|weather|forecast|standings|release\s+date|changelog|202[5-9]|203\d|who\s+is\s+the\s+(current|new|president|ceo|prime)|who\s+won|what\s+happened|fact.?check|find\s+online|aktuell|heute|nachrichten|wetter|suche\s+im\s+web|recherchiere)\b/i.test(text)) {
    return true;
  }
  return false;
}

function promptNeedsCalcTools(content, history = []) {
  if (historyUsedAny(history, ['calculate', 'get_datetime', 'run_js'])) return true;
  const text = String(content || '').trim();
  if (!text) return false;
  if (/\d\s*[\+\-\*\/\^%]\s*\d|\b(calculate|compute|sqrt|factorial|compound\s+interest|convert\s+\d|berechne|rechnen)\b/i.test(text)) return true;
  if (/\b(what\s+(time|day|date)|current\s+time|today'?s\s+date|timezone|uhrzeit|welcher\s+tag|welches\s+datum)\b/i.test(text)) return true;
  if (/\b(run|execute|eval|test)\s+(this\s+|the\s+)?(js|javascript|code|script|snippet)\b/i.test(text)) return true;
  return false;
}

function promptNeedsNotes(content, history = []) {
  if (historyUsedAny(history, ['save_note', 'list_notes', 'read_note'])) return true;
  const text = String(content || '').trim();
  if (!text) return false;
  return /\b(note|notes|notiz|notizen|remember\s+that|don'?t\s+forget|merk\s+dir|save\s+(this|that)\s+to\s+memory|my\s+memory|saved\s+notes?)\b/i.test(text);
}

function promptNeedsSubagents(content, history = []) {
  if (historyUsedAny(history, ['delegate_subagent', 'delegate_parallel'])) return true;
  const text = String(content || '').trim();
  if (!text) return false;
  return /\b(subagent|sub-agent|delegate|in\s+parallel|parallel\s+(research|analysis|tasks?|workers?)|spawn\s+(an?\s+)?agent|multi-?agent)\b/i.test(text);
}

// Per-chat sticky tool groups (in-memory) so follow-up turns keep a stable prefix for Ollama KV checkpoints.
const chatToolGroups = new Map();

function makeTitle(content) {
  const clean = String(content || '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  const words = clean.split(' ').slice(0, 9).join(' ');
  const t = words.length > 58 ? words.slice(0, 55).trimEnd() + '…' : words;
  return t.charAt(0).toUpperCase() + t.slice(1).replace(/[.,;:!?]+$/, '');
}

// ---------------------------------------------------------------- attachments
async function buildAttachmentContext(attachments, supportsVision, isRemote) {
  const blocks = [];
  const images = [];
  for (const a of attachments || []) {
    try {
      const st = await files.stat(a.path);
      if (st.size > 10 * 1024 * 1024) { blocks.push(`[Attachment ${a.name}: too large]`); continue; }
      const mime = a.mime || st.mime;
      if (/^image\//.test(mime) && !/svg/.test(mime)) {
        if (supportsVision && st.size < 6 * 1024 * 1024) {
          const buf = await fsp.readFile(st.abs);
          const b64 = buf.toString('base64');
          images.push(isRemote ? { data: b64, mime } : b64);
          blocks.push(`[Attached image: ${a.name}]`);
        } else {
          blocks.push(`[Attached image ${a.name} (${Math.round(st.size / 1024)} KB) — this model cannot view images]`);
        }
      } else if (/pdf$/i.test(mime) || /\.pdf$/i.test(a.name)) {
        const extracted = await extractPdfText(st.abs);
        if (extracted) {
          blocks.push(`<file name="${a.name}" type="pdf">\n${extracted}\n</file>`);
        } else {
          blocks.push(`[Attached PDF: ${a.name} (${Math.round(st.size / 1024)} KB) — could not extract text (may be scanned images)]`);
        }
      } else if (/^(text\/|application\/(json|xml|javascript))/.test(mime) || /\.(md|txt|csv|tsv|log|py|js|mjs|cjs|ts|tsx|jsx|json|jsonl|yaml|yml|html|css|sh|toml|sql|go|rs|java|c|cpp|h|ini|conf|env|xml|svg)$/i.test(a.name)) {
        if (st.size > 500_000) { blocks.push(`[Attachment ${a.name}: too large to inline]`); continue; }
        const body = await fsp.readFile(st.abs, 'utf8');
        blocks.push(`<file name="${a.name}">\n${body.slice(0, 120000)}\n</file>`);
      } else {
        blocks.push(`[Attached file: ${a.name} (${mime}, ${Math.round(st.size / 1024)} KB)]`);
      }
    } catch {
      blocks.push(`[Attachment missing: ${a.name}]`);
    }
  }
  return { blocks, images };
}

// ---------------------------------------------------------------- chat stream
async function handleChat(req, res, body, session, { isLan = false } = {}) {
  try { res.socket?.setNoDelay?.(true); } catch {}
  const isOwner = !session || session.role === 'owner';
  const {
    chatId,
    content = '',
    model,
    attachments = [],
    useWeb = false,
    useTools = true,
    useSubagents = true,
    regenerate = false,
    editMessageId = null,
    fromMessageId = null,
    persona = '',
  } = body || {};
  const useFiles = isOwner ? !!body?.useFiles : false;
  const rawThink = body?.think === 'med' ? 'medium' : body?.think;
  const think = ['off', 'low', 'medium', 'high', 'max'].includes(rawThink) ? rawThink : 'low';

  if (!chatId) return json(res, 400, { error: 'chatId is required' });
  if (!regenerate && typeof content !== 'string') return json(res, 400, { error: 'content is required' });

  let chat = store.getChat(chatId, session?.sub);
  if (!chat) return json(res, 404, { error: 'Chat not found' });
  const cfg = config.readConfig();
  const modelName = model || chat.model || cfg.model;
  if (!modelName) return json(res, 400, { error: 'No model selected' });

  const remote = providers.resolve(modelName);
  let caps = [];
  if (!remote) {
    try { caps = (await ollama.listModels()).find((m) => m.name === modelName)?.capabilities || []; } catch {}
  }
  const supportsVision = remote ? remoteSupportsVision(remote.model) : caps.includes('vision');
  const supportsTools = remote ? true : (caps.includes('tools') || caps.length === 0);

  let userMessage;
  if (editMessageId) {
    const idx = chat.messages.findIndex((m) => m.id === editMessageId && m.role === 'user');
    if (idx < 0) return json(res, 404, { error: 'Message not found' });
    chat.messages[idx].content = content;
    chat.messages[idx].ts = Date.now();
    chat.messages[idx].edited = true;
    chat.messages = chat.messages.slice(0, idx + 1);
    userMessage = chat.messages[idx];
    if (idx === 0) chat.title = makeTitle(content);
  } else if (regenerate) {
    if (fromMessageId) {
      const idx = chat.messages.findIndex((m) => m.id === fromMessageId);
      if (idx >= 0) chat.messages = chat.messages.slice(0, idx);
    } else {
      while (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'assistant') {
        chat.messages.pop();
      }
    }
    userMessage = [...chat.messages].reverse().find((m) => m.role === 'user');
    if (!userMessage) return json(res, 400, { error: 'Nothing to regenerate' });
  } else {
    const effectiveContent = content.trim() || (attachments.length ? 'Please inspect the attached file(s).' : '');
    if (!effectiveContent) return json(res, 400, { error: 'Message cannot be empty' });
    userMessage = {
      id: store.newId(),
      role: 'user',
      content: effectiveContent,
      ts: Date.now(),
      model: modelName,
      attachments: (attachments || []).map((a) => ({ name: a.name, path: a.path, mime: a.mime, size: a.size })),
    };
    if (!chat.title || chat.title === 'New chat') chat.title = makeTitle(effectiveContent);
    chat.messages.push(userMessage);
  }

  if (activeRuns.has(chatId) && !activeRuns.get(chatId).finished) {
    return json(res, 409, { error: 'This chat is already generating a response' });
  }

  chat.model = modelName;
  if (persona && PERSONAS[persona]) chat.persona = persona;
  await store.saveChat(chat);

  const startedAt = Date.now();
  const effectiveThink = (!remote && caps.length && !caps.includes('thinking')) ? 'off' : think;
  const assistant = {
    id: store.newId(),
    role: 'assistant',
    content: '',
    thinking: '',
    think: effectiveThink,
    ts: Date.now(),
    model: modelName,
    tools: [],
    subagents: [],
    stopped: false,
  };

  const run = {
    chatId: chat.id,
    owner: session?.sub || 'owner',
    title: chat.title,
    persona: chat.persona || '',
    model: modelName,
    think: effectiveThink,
    startedAt,
    phase: 'loading',
    controller: new AbortController(),
    userMessage,
    assistant,
    subscribers: new Set(),
    finished: false,
    finalEvent: null,
  };
  activeRuns.set(chatId, run);
  attachRunSubscriber(run, res, { sendSnapshot: false });

  const setPhase = (next) => {
    if (run.phase === next) return;
    run.phase = next;
    broadcastRun(run, 'phase', { phase: next });
  };
  const send = (event, data) => broadcastRun(run, event, data);
  const finishRun = (event, data) => {
    run.finished = true;
    run.finalEvent = { event, data };
    broadcastRun(run, event, data);
    for (const sub of [...run.subscribers]) {
      try { if (!sub.writableEnded) sub.end(); } catch {}
    }
    run.subscribers.clear();
    setTimeout(() => { if (activeRuns.get(chatId) === run) activeRuns.delete(chatId); }, 1500);
  };

  send('chat', { chat: { id: chat.id, title: chat.title, model: chat.model, persona: chat.persona || '' }, userMessage });
  send('start', { id: assistant.id, ts: assistant.ts, model: modelName, think: effectiveThink });
  send('loading', { model: modelName });

  let firstThinkingAt = 0;
  let thinkingMs = 0;
  const controller = run.controller;

  // Run generation detached from the initial HTTP socket so switching chats,
  // closing/refreshing the tab, or switching models never aborts background work.
  (async () => {
    try {
      const { blocks, images } = await buildAttachmentContext(userMessage.attachments, supportsVision, !!remote);
      const modelContent = blocks.length ? `${userMessage.content}\n\n${blocks.join('\n\n')}` : userMessage.content;

      const priorMessages = chat.messages.slice(0, -1);
      const prevGroups = chatToolGroups.get(chatId) || {};
      const wantWeb = !!useWeb && supportsTools && (remote || prevGroups.web || promptNeedsWeb(userMessage.content, priorMessages));
      const wantCalc = !!useTools && supportsTools && (remote || prevGroups.calc || promptNeedsCalcTools(userMessage.content, priorMessages));
      const wantNotes = !!useTools && supportsTools && (remote || prevGroups.notes || promptNeedsNotes(userMessage.content, priorMessages));
      const wantSubagents = !!useSubagents && supportsTools && (remote || prevGroups.subagents || promptNeedsSubagents(userMessage.content, priorMessages));

      const sub3BModels = wantSubagents ? await subagents.listSub3BModels() : [];
      const subagentsActive = wantSubagents && sub3BModels.length > 0;
      if (!remote) {
        chatToolGroups.set(chatId, { web: wantWeb, calc: wantCalc, notes: wantNotes, subagents: subagentsActive });
        if (chatToolGroups.size > 200) chatToolGroups.delete(chatToolGroups.keys().next().value);
      }

      const history = priorMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content || '' }));
      const messages = [
        {
          role: 'system',
          content: systemPrompt({
            useWeb: wantWeb,
            useFiles,
            useCalcTools: wantCalc,
            useNoteTools: wantNotes,
            useSubagents: subagentsActive,
            subagentModels: sub3BModels,
            persona: chat.persona || '',
            chatSystemPrompt: chat.systemPrompt || '',
            owner: session?.sub || 'owner',
          }),
        },
        ...history,
        { role: 'user', content: modelContent, ...(images.length ? { images } : {}) },
      ];

      const toolNames = [];
      if (wantCalc) toolNames.push('calculate', 'get_datetime', 'run_js');
      if (wantNotes) toolNames.push('save_note', 'list_notes', 'read_note');
      if (subagentsActive) toolNames.push('delegate_subagent', 'delegate_parallel');
      if (wantWeb) toolNames.push('web_search', 'wiki_lookup', 'deep_research', 'browse_url');
      if (useFiles && supportsTools) toolNames.push('list_files', 'search_files', 'read_file', 'edit_file', 'write_file');
      const toolDefs = tools.defsFor(toolNames);

      const sources = [];
      const allowRuntimeOverrides = isLan && isOwner && !config.SANDBOX;
      const options = config.ollamaOptions(cfg, { allowRuntimeOverrides, model: modelName });
      const keepAlive = config.ollamaKeepAlive(cfg, { allowRuntimeOverrides });
      const MAX_ROUNDS = 8;
      let round = 0;
      let promptTokens = 0, evalTokens = 0, lastTokSec = 0;

      while (round < MAX_ROUNDS) {
        round++;
        const finalRound = round === MAX_ROUNDS;
        const callMessages = finalRound
          ? [...messages, { role: 'system', content: 'Tool budget exhausted. Do not call any more tools. Answer the user now with the information you already gathered, and say clearly what you could not confirm.' }]
          : messages;
        const onEvent = (e) => {
          if (e.type === 'queue') {
            if (e.acquired || !e.position) {
              run.queue = null;
              setPhase('loading');
              send('queue', { position: 0, acquired: true });
            } else {
              run.queue = {
                position: e.position,
                queuedTotal: e.queuedTotal || e.position,
                runningLabel: e.runningLabel || '',
              };
              setPhase('queued');
              send('queue', run.queue);
            }
            return;
          }
          if (run.queue) {
            run.queue = null;
            send('queue', { position: 0, acquired: true });
          }
          if (e.type === 'thinking') {
            if (!firstThinkingAt) firstThinkingAt = Date.now();
            assistant.thinking += e.delta;
            setPhase('thinking');
          } else if (e.type === 'text') {
            if (firstThinkingAt && !thinkingMs) {
              thinkingMs = Date.now() - firstThinkingAt;
              assistant.thinkingMs = thinkingMs;
            }
            assistant.content += e.delta;
            setPhase(detectOpenArtifact(assistant.content) ? 'artifact' : 'writing');
          }
          send(e.type, { delta: e.delta });
        };
        const result = remote
          ? await openai.streamChat({
              baseUrl: remote.provider.baseUrl,
              apiKey: remote.provider.apiKey,
              model: remote.model,
              providerName: remote.provider.name,
              sessionId: chatId,
              messages: callMessages,
              tools: finalRound ? [] : toolDefs,
              options: { temperature: options.temperature },
              think: effectiveThink,
              signal: controller.signal,
              onEvent,
            })
          : await ollama.streamChat({
              model: modelName,
              messages: callMessages,
              tools: finalRound ? [] : toolDefs,
              options,
              keepAlive,
              think: effectiveThink,
              capabilities: caps,
              user: session?.sub || 'owner',
              signal: controller.signal,
              onEvent,
            });
        // stream complete
        assistant.thinkingMs = thinkingMs || assistant.thinkingMs || 0;
        promptTokens += result.meta?.promptTokens || 0;
        evalTokens += result.meta?.evalTokens || 0;
        if (result.meta?.tokensPerSec) lastTokSec = result.meta.tokensPerSec;

        if (!result.tool_calls.length || finalRound) break;

        if (remote) {
          messages.push({
            role: 'assistant',
            content: result.content || null,
            tool_calls: result.tool_calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } })),
          });
        } else {
          messages.push({
            role: 'assistant',
            content: result.content || '',
            tool_calls: result.tool_calls.map((tc) => ({ function: { name: tc.name, arguments: tc.args } })),
          });
        }

        setPhase('tools');
        const onSubagentProgress = (ev) => {
          if (ev.type === 'queued') {
            setPhase('subagents');
            let entry = assistant.subagents.find((s) => s.id === ev.id);
            if (!entry) {
              entry = {
                id: ev.id,
                role: ev.role,
                roleLabel: ev.roleLabel,
                task: ev.task,
                model: ev.model,
                params: ev.params,
                status: 'queued',
                queuePos: ev.position || 1,
                content: '',
                tools: [],
                startedAt: 0,
              };
              assistant.subagents.push(entry);
            }
            send('subagent', entry);
          } else if (ev.type === 'start') {
            setPhase('subagents');
            let entry = assistant.subagents.find((s) => s.id === ev.id);
            if (entry) {
              entry.status = 'running';
              entry.queuePos = 0;
              entry.model = ev.model || entry.model;
              entry.params = ev.params || entry.params;
              entry.startedAt = ev.startedAt;
            } else {
              entry = {
                id: ev.id,
                role: ev.role,
                roleLabel: ev.roleLabel,
                task: ev.task,
                model: ev.model,
                params: ev.params,
                status: 'running',
                queuePos: 0,
                content: '',
                tools: [],
                startedAt: ev.startedAt,
              };
              assistant.subagents.push(entry);
            }
            send('subagent', entry);
          } else if (ev.type === 'queue') {
            const entry = assistant.subagents.find((s) => s.id === ev.id);
            if (entry) {
              if (ev.acquired || !ev.position) {
                entry.status = 'running';
                entry.queuePos = 0;
              } else {
                entry.status = 'queued';
                entry.queuePos = ev.position;
              }
              send('subagent', entry);
            }
          } else if (ev.type === 'delta') {
            const entry = assistant.subagents.find((s) => s.id === ev.id);
            if (entry) entry.content += ev.delta || '';
            send('subagent_delta', { id: ev.id, delta: ev.delta || '' });
          } else if (ev.type === 'tool') {
            const entry = assistant.subagents.find((s) => s.id === ev.id);
            if (entry) {
              const i = entry.tools.findIndex((t) => t === ev.tool || (t.name === ev.tool.name && t.status === 'running'));
              if (i >= 0) entry.tools[i] = { ...ev.tool };
              else entry.tools.push({ ...ev.tool });
            }
            send('subagent_tool', { id: ev.id, tool: ev.tool });
          } else if (ev.type === 'done') {
            const entry = assistant.subagents.find((s) => s.id === ev.id);
            if (entry) {
              entry.status = ev.ok ? 'ok' : 'error';
              entry.content = ev.content || entry.content;
              entry.elapsedMs = ev.elapsedMs || 0;
              entry.evalTokens = ev.evalTokens || 0;
              entry.tokensPerSec = ev.tokensPerSec || 0;
              entry.error = ev.error || '';
              if (ev.tools) entry.tools = ev.tools;
            }
            send('subagent_done', {
              id: ev.id,
              ok: !!ev.ok,
              content: ev.content || '',
              elapsedMs: ev.elapsedMs || 0,
              evalTokens: ev.evalTokens || 0,
              tokensPerSec: ev.tokensPerSec || 0,
              error: ev.error || '',
              tools: ev.tools || [],
            });
          }
        };
        for (const call of result.tool_calls) {
          if (controller.signal.aborted) break;
          const toolEntry = { id: call.id, name: call.name, args: call.args, status: 'running', ts: Date.now() };
          assistant.tools.push(toolEntry);
          send('tool', { id: call.id, name: call.name, args: call.args, chatId });
          let out;
          try {
            out = await tools.execute(call.name, call.args || {}, {
              owner: session?.sub || 'owner',
              useWeb,
              useFiles,
              signal: controller.signal,
              onSubagentProgress,
            });
            toolEntry.status = 'ok';
            toolEntry.summary = summarizeTool(call.name, call.args || {}, out);
            toolEntry.output = String(out.text || '').slice(0, 4000);
            if (out.meta) {
              const { screenshot, ...rest } = out.meta;
              toolEntry.meta = rest;
              collectSources(sources, out.meta);
            }
            if (remote) messages.push({ role: 'tool', tool_call_id: call.id, content: out.text });
            else messages.push({ role: 'tool', content: out.text, tool_name: call.name });
            send('tool_result', { id: call.id, ok: true, summary: toolEntry.summary, output: toolEntry.output, meta: out.meta || null });
          } catch (err) {
            toolEntry.status = 'error';
            toolEntry.summary = err.message;
            toolEntry.output = `Error: ${err.message}`;
            if (remote) messages.push({ role: 'tool', tool_call_id: call.id, content: `Tool error: ${err.message}` });
            else messages.push({ role: 'tool', content: `Tool error: ${err.message}`, tool_name: call.name });
            send('tool_result', { id: call.id, ok: false, summary: err.message, output: toolEntry.output });
          }
        }
        if (controller.signal.aborted) break;
      }

      if (controller.signal.aborted && !assistant.content && !assistant.tools.length) assistant.stopped = true;
      if (!thinkingMs && firstThinkingAt) assistant.thinkingMs = Math.min(Date.now() - firstThinkingAt, 600000);
      if (sources.length) assistant.sources = sources.slice(0, 12);
      if (!assistant.content.trim() && assistant.tools.length) {
        assistant.content = 'I gathered some information but ran out of room to finish the answer. Ask me to continue and I will pick up from the sources above.';
      }
      assistant.usage = {
        promptTokens,
        evalTokens,
        tokensPerSec: lastTokSec,
        totalMs: Date.now() - startedAt,
      };
      // Reload latest chat metadata (e.g. if user renamed/pinned while generating)
      const latest = store.getChat(chat.id, session?.sub) || chat;
      latest.messages = [...chat.messages, assistant];
      latest.model = modelName;
      await store.saveChat(latest);
      finishRun('done', {
        message: assistant,
        chat: { id: latest.id, title: latest.title, model: latest.model, persona: latest.persona || '', pinned: !!latest.pinned, updated: latest.updated },
        usage: assistant.usage,
      });
    } catch (err) {
      const aborted = err.name === 'AbortError' || controller.signal.aborted;
      assistant.stopped = aborted;
      if (assistant.content || assistant.thinking || assistant.tools.length) {
        const latest = store.getChat(chat.id, session?.sub) || chat;
        latest.messages = [...chat.messages, assistant];
        await store.saveChat(latest).catch(() => {});
      }
      if (!aborted) {
        console.error('[chat]', err);
        finishRun('error', { message: err.message || 'The model request failed' });
      } else {
        finishRun('stopped', { message: assistant });
      }
    }
  })();
}

function collectSources(bucket, meta) {
  if (!meta) return;
  const items = [
    ...(meta.sources || []),
    ...(meta.results || []),
    ...(meta.type === 'page' && meta.url ? [{ title: meta.title, url: meta.url }] : []),
  ];
  for (const item of items) {
    if (!item?.url) continue;
    if (bucket.some((s) => s.url === item.url)) continue;
    bucket.push({ title: String(item.title || item.url).slice(0, 140), url: item.url });
    if (bucket.length >= 12) break;
  }
}

function summarizeTool(name, args, out) {
  if (name === 'web_search') return `Searched “${args.query}”`;
  if (name === 'deep_research') return `Researched “${args.query}” · ${out.meta?.sources?.length || 0} sources`;
  if (name === 'browse_url') return out.meta?.title || args.url;
  if (name === 'wiki_lookup') return `Wikipedia: ${out.meta?.title || args.topic}`;
  if (name === 'calculate') return out.text || `Calculated ${args.expression}`;
  if (name === 'get_datetime') return `Time (${out.meta?.timezone || 'UTC'})`;
  if (name === 'run_js') return `Ran JS (${out.meta?.elapsedMs ?? 0}ms)`;
  if (name === 'save_note') return `Saved note “${args.title}”`;
  if (name === 'list_notes') return `Listed notes (${out.meta?.count ?? 0})`;
  if (name === 'read_note') return `Read note “${out.meta?.title || args.title}”`;
  if (name === 'list_files') return `Listed /${args.path || ''}`;
  if (name === 'read_file') return `Read ${args.path}`;
  if (name === 'write_file') return `Wrote ${args.path}`;
  if (name === 'edit_file') return `Edited ${args.path}`;
  if (name === 'search_files') return `Searched files “${args.query}” (${out.meta?.count ?? 0})`;
  if (name === 'delegate_subagent') return `Subagent (${args.role || 'general'} · ${out.meta?.model || '<3B'})`;
  if (name === 'delegate_parallel') return `Parallel subagents (${out.meta?.succeeded ?? 0}/${out.meta?.count ?? 0})`;
  return name;
}

// ---------------------------------------------------------------- host stats (LAN-only)
function hostStats() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    hostname: os.hostname(),
    cpus: os.cpus().length,
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    memTotalBytes: totalMem,
    memUsedBytes: totalMem - freeMem,
    uptimeSec: Math.round(os.uptime()),
  };
}

async function proxyOllamaSettings(res, targetPath, method = 'GET', bodyObj = null) {
  if (!config.OLLAMA_SETTINGS_URL) {
    return json(res, 501, { ok: false, error: 'Host Ollama settings daemon is not configured on this instance' });
  }
  try {
    const init = {
      method,
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(25000),
    };
    if (bodyObj !== null && method !== 'GET') init.body = JSON.stringify(bodyObj);
    const up = await fetch(`${config.OLLAMA_SETTINGS_URL}${targetPath}`, init);
    const data = await up.json().catch(() => ({ ok: false, error: `HTTP ${up.status}` }));
    return json(res, up.status, data);
  } catch (e) {
    return json(res, 502, { ok: false, error: `Ollama settings service unavailable: ${e.message}` });
  }
}

// ---------------------------------------------------------------- router
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method;

  // ---- public
  if (pathname === '/login' && method === 'GET') {
    if (!config.AUTH_REQUIRED || auth.isAuthed(req)) { res.writeHead(302, { location: '/' }); return res.end(); }
    return serveStatic(res, path.join(PUBLIC_DIR, 'login.html'));
  }
  if (pathname === '/api/login' && method === 'POST') {
    if (!config.AUTH_REQUIRED) return json(res, 200, { ok: true, authRequired: false });
    const ip = clientIp(req);
    if (!auth.throttle(ip)) return json(res, 429, { error: 'Too many attempts. Wait a minute.' });
    const body = await readBody(req);
    const username = String(body?.username == null ? '' : body.username).trim();
    const fromCloudflare = !!req.headers['cf-connecting-ip'];
    if (!username && fromCloudflare) {
      await new Promise((r) => setTimeout(r, 350));
      return json(res, 401, { error: 'Use your user number to sign in' });
    }
    const account = body?.password ? auth.authenticate(username, body.password) : null;
    if (!account) {
      await new Promise((r) => setTimeout(r, 350));
      return json(res, 401, { error: username ? 'Wrong user number or password' : 'Incorrect password' });
    }
    const secure = fromCloudflare || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('set-cookie', auth.setCookieHeader(account.sub, secure));
    return json(res, 200, { ok: true, role: account.role });
  }
  if (pathname === '/api/health') return json(res, 200, { ok: true, version: VERSION });
  if (pathname.startsWith('/vendor/') || pathname.startsWith('/fonts/') ||
      pathname === '/styles.css' || pathname === '/app.js' ||
      pathname === '/favicon.ico' || pathname === '/favicon.svg') {
    return serveStatic(res, path.join(PUBLIC_DIR, pathname), { cache: pathname.startsWith('/vendor/') || pathname.startsWith('/fonts/') });
  }
  if (pathname === '/manifest.webmanifest') return serveStatic(res, path.join(PUBLIC_DIR, 'manifest.webmanifest'));

  const session = auth.session(req);
  if (!session) {
    if (pathname.startsWith('/api/')) return json(res, 401, { error: 'Not signed in' });
    res.writeHead(302, { location: '/login' });
    return res.end();
  }
  const isOwner = session.role === 'owner';
  const isLan = config.isLanRequest(req);
  const canOllamaSettings = isLan && isOwner && !config.SANDBOX;
  const gatewayUser = String(req.headers['x-forwarded-user'] || '').trim();
  const capabilities = {
    owner: isOwner,
    files: isOwner,
    browser: isOwner,
    liveBrowser: isOwner && HAS_PLAYWRIGHT,
    settings: isOwner,
    providers: isOwner,
    ollamaSettings: canOllamaSettings,
    ollamaEnvDaemon: canOllamaSettings && !!config.OLLAMA_SETTINGS_URL,
    gatewayAuth: !!gatewayUser,
    lan: isLan,
  };

  // Public accounts on direct host are chat-only: no filesystem, browser, settings or API keys.
  if (!isOwner && /^\/api\/(files|browse|browser|settings|password|providers|ollama)(\/|$)/.test(pathname)) {
    return json(res, 403, { error: 'Not available for this account' });
  }
  // Ollama settings endpoints are STRICTLY LAN-only.
  if (/^\/api\/ollama(\/|$)/.test(pathname) && !canOllamaSettings) {
    return json(res, 403, { error: 'Ollama settings are restricted to LAN access only' });
  }

  if (pathname === '/') return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  if (pathname === '/api/logout' && method === 'POST') {
    res.setHeader('set-cookie', auth.clearCookieHeader());
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/me') {
    const displayName = gatewayUser ? `User ${gatewayUser}` : (isOwner ? 'You' : `User ${session.sub}`);
    return json(res, 200, {
      name: displayName,
      authed: true,
      role: session.role,
      capabilities,
      version: VERSION,
    });
  }

  // ---- bootstrap
  if (pathname === '/api/bootstrap' && method === 'GET') {
    const cfg = config.readConfig();
    let models = [];
    try { models = await allModels(); } catch (e) { console.error('[models]', e.message); }
    const usable = models.filter((m) => !m.capabilities.length || m.capabilities.includes('completion'));
    const visible = isOwner ? usable : usable.filter((m) => !m.cloud);
    const fallback = visible.find((m) => !m.cloud && m.capabilities.includes('completion') && !/embed/i.test(m.name)) || visible[0];
    const displayName = gatewayUser
      ? `User ${gatewayUser}`
      : (isOwner ? (process.env.USER_NAME || os.hostname().split('.')[0] || 'You') : `User ${session.sub}`);
    const sub3B = await subagents.listSub3BModels();
    return json(res, 200, {
      chats: store.listChats(session.sub),
      activeRuns: listActiveRuns(session.sub),
      models: visible,
      modes: config.LOCAL_MODES,
      subagentModels: sub3B.map((m) => ({ name: m.name, params: m.params, paramB: m.paramB, size: m.size })),
      providers: isOwner ? providers.list() : [],
      presets: isOwner ? providers.PRESETS : {},
      personas: Object.values(PERSONAS),
      notesCount: notes.list(session.sub).length,
      settings: {
        model: cfg.model || fallback?.name || '',
        customInstructions: isOwner ? cfg.customInstructions : '',
        persona: cfg.persona || 'default',
        theme: cfg.theme,
        temperature: cfg.temperature,
        numCtx: canOllamaSettings ? cfg.numCtx : null,
        ollama: canOllamaSettings ? cfg.ollama : undefined,
        preferred: isOwner ? cfg.preferred : {},
      },
      filesRoot: isOwner ? (cfg.filesRoot || config.WORKSPACE) : null,
      user: { name: displayName },
      capabilities,
      authRequired: config.AUTH_REQUIRED || !!gatewayUser,
      version: VERSION,
    });
  }

  // ---- models
  if (pathname === '/api/models' && method === 'GET') {
    try { return json(res, 200, { models: await allModels() }); }
    catch (e) { return json(res, 502, { error: e.message }); }
  }

  // ---- settings
  if (pathname === '/api/settings' && method === 'GET') {
    const cfg = config.readConfig();
    if (!canOllamaSettings) {
      const { ollama: _o, numCtx: _c, ...safe } = cfg;
      return json(res, 200, safe);
    }
    return json(res, 200, cfg);
  }
  if (pathname === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'Invalid body' });
    if (!canOllamaSettings && (body.ollama !== undefined || body.numCtx !== undefined)) {
      return json(res, 403, { error: 'Ollama runtime settings require LAN access' });
    }
    const allowed = {};
    for (const k of ['model', 'customInstructions', 'persona', 'theme', 'temperature', 'numCtx', 'ollama', 'preferred']) {
      if (body[k] !== undefined) allowed[k] = body[k];
    }
    if (allowed.persona !== undefined && !PERSONAS[allowed.persona]) {
      allowed.persona = 'default';
    }
    if (allowed.numCtx !== undefined) {
      if (allowed.numCtx === null || allowed.numCtx === '' || allowed.numCtx === 0) {
        allowed.numCtx = null;
      } else {
        const n = Number(allowed.numCtx);
        if (!Number.isFinite(n) || n < 2048 || n > 262144) return json(res, 400, { error: 'Context window must be between 2k and 256k tokens' });
        allowed.numCtx = Math.round(n);
      }
    }
    if (allowed.temperature !== undefined) {
      const t = Number(allowed.temperature);
      if (!Number.isFinite(t) || t < 0 || t > 2) return json(res, 400, { error: 'Temperature must be between 0 and 2' });
      allowed.temperature = t;
    }
    if (allowed.ollama !== undefined) {
      if (typeof allowed.ollama !== 'object' || Array.isArray(allowed.ollama)) return json(res, 400, { error: 'Invalid Ollama settings' });
      const keep = ['keepAlive', 'topP', 'topK', 'repeatPenalty', 'numPredict', 'numGpu', 'numThread', 'numBatch', 'seed'];
      const patch = {};
      for (const k of keep) {
        if (allowed.ollama[k] === undefined) continue;
        if (k === 'keepAlive') {
          const v = String(allowed.ollama[k]);
          patch[k] = /^-?\d+$/.test(v) ? Number(v) : v;
        } else {
          const raw = allowed.ollama[k];
          if (raw === '' || raw === null) { patch[k] = null; continue; }
          const n = Number(raw);
          if (Number.isFinite(n)) patch[k] = n;
        }
      }
      allowed.ollama = patch;
    }
    if (allowed.preferred !== undefined) {
      if (typeof allowed.preferred !== 'object' || Array.isArray(allowed.preferred)) return json(res, 400, { error: 'Invalid preferred models' });
      const patch = {};
      for (const [source, name] of Object.entries(allowed.preferred)) {
        if (typeof source !== 'string' || typeof name !== 'string') continue;
        patch[String(source).slice(0, 80)] = name.slice(0, 200);
      }
      allowed.preferred = patch;
    }
    return json(res, 200, config.writeConfig(allowed));
  }

  // ---- LAN-ONLY Ollama server management
  if (pathname === '/api/ollama/info' && method === 'GET') {
    const cfg = config.readConfig();
    try {
      const [version, loaded, installed] = await Promise.all([ollama.version(), ollama.ps(), ollama.listModels()]);
      return json(res, 200, {
        ok: true,
        url: config.OLLAMA_URL,
        version,
        loaded,
        installed,
        host: hostStats(),
        envDaemon: !!config.OLLAMA_SETTINGS_URL,
        options: config.ollamaOptions(cfg, { allowRuntimeOverrides: true }),
        keepAlive: config.ollamaKeepAlive(cfg, { allowRuntimeOverrides: true }),
      });
    } catch (e) {
      return json(res, 200, {
        ok: false,
        url: config.OLLAMA_URL,
        error: e.message,
        host: hostStats(),
        envDaemon: !!config.OLLAMA_SETTINGS_URL,
        options: config.ollamaOptions(cfg, { allowRuntimeOverrides: true }),
        keepAlive: config.ollamaKeepAlive(cfg, { allowRuntimeOverrides: true }),
      });
    }
  }
  if (pathname === '/api/ollama/env' && method === 'GET') {
    return proxyOllamaSettings(res, '/api/settings', 'GET');
  }
  if (pathname === '/api/ollama/env' && method === 'POST') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, error: 'Invalid body' });
    return proxyOllamaSettings(res, '/api/settings', 'POST', body);
  }
  if (pathname === '/api/ollama/restart' && method === 'POST') {
    return proxyOllamaSettings(res, '/api/restart', 'POST', {});
  }
  if (pathname === '/api/ollama/unload' && method === 'POST') {
    const body = await readBody(req);
    if (!body?.model) return json(res, 400, { error: 'model is required' });
    try { return json(res, 200, await ollama.unloadModel(String(body.model))); }
    catch (e) { return json(res, 502, { error: e.message }); }
  }
  if (pathname === '/api/ollama/models' && method === 'DELETE') {
    const body = await readBody(req);
    if (!body?.model) return json(res, 400, { error: 'model is required' });
    try { return json(res, 200, await ollama.deleteModel(String(body.model))); }
    catch (e) { return json(res, 502, { error: e.message }); }
  }
  if (pathname === '/api/ollama/pull' && method === 'POST') {
    const body = await readBody(req);
    const modelName = String(body?.model || '').trim();
    if (!modelName || modelName.length > 160 || /\s/.test(modelName)) {
      return json(res, 400, { error: 'Valid model name is required (e.g. llama3.2:3b)' });
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const up = await fetch(`${config.OLLAMA_URL}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelName, stream: true }),
        signal: controller.signal,
      });
      if (!up.ok) {
        const msg = (await up.text().catch(() => up.statusText)).slice(0, 300);
        res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
        return res.end();
      }
      const reader = up.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) res.write(`data: ${line}\n\n`);
        }
      }
      if (buf.trim()) res.write(`data: ${buf.trim()}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (e) {
      if (e.name !== 'AbortError') res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    }
    return res.end();
  }

  if (pathname === '/api/password' && method === 'POST') {
    if (!config.AUTH_REQUIRED) return json(res, 400, { error: 'Password sign-in is disabled on this instance' });
    const body = await readBody(req);
    if (!body?.current || !auth.checkPassword(body.current)) return json(res, 403, { error: 'Current password is wrong' });
    if (!body.next || String(body.next).length < 4) return json(res, 400, { error: 'New password is too short' });
    config.setPassword(String(body.next));
    res.setHeader('set-cookie', auth.clearCookieHeader());
    return json(res, 200, { ok: true });
  }

  // ---- notes / memory
  if (pathname === '/api/notes' && method === 'GET') {
    const q = url.searchParams.get('q') || '';
    return json(res, 200, { notes: q ? notes.search(q, session.sub) : notes.list(session.sub) });
  }
  if (pathname === '/api/notes' && method === 'POST') {
    const body = await readBody(req);
    try {
      const saved = notes.save(body || {}, session.sub);
      return json(res, 200, { note: saved });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  const noteMatch = pathname.match(/^\/api\/notes\/([A-Za-z0-9_-]+)$/);
  if (noteMatch && method === 'DELETE') {
    const ok = notes.remove(noteMatch[1], session.sub);
    return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Note not found' });
  }

  // ---- providers / API keys
  if (pathname === '/api/providers' && method === 'GET') {
    return json(res, 200, { providers: providers.list(), presets: providers.PRESETS });
  }
  if (pathname === '/api/providers' && method === 'POST') {
    const body = await readBody(req);
    try {
      const created = providers.create({
        name: body?.name || 'Custom endpoint',
        baseUrl: body?.baseUrl,
        apiKey: body?.apiKey || '',
        models: body?.models || [],
        modelsUrl: body?.modelsUrl || '',
        noKey: !!body?.noKey,
      });
      let warning = null;
      try {
        const found = await providers.fetchModels(providers.getWithKey(created.id));
        if (found.length) providers.update(created.id, { models: found });
      } catch (e) { warning = `Saved, but could not fetch the model list: ${e.message}`; }
      const fresh = providers.list().find((p) => p.id === created.id);
      return json(res, 200, { provider: fresh, warning });
    } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }
  const provMatch = pathname.match(/^\/api\/providers\/([a-z0-9-]+)(\/(test|refresh))?$/);
  if (provMatch) {
    const id = provMatch[1];
    const action = provMatch[3];
    if (method === 'GET' && !action) {
      const p = providers.get(id);
      if (!p) return json(res, 404, { error: 'Provider not found' });
      return json(res, 200, { provider: providers.publicView(p) });
    }
    if (method === 'PATCH' && !action) {
      const body = await readBody(req);
      const p = providers.update(id, body || {});
      if (!p) return json(res, 404, { error: 'Provider not found' });
      return json(res, 200, { provider: p });
    }
    if (method === 'DELETE' && !action) {
      const ok = providers.remove(id);
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Provider not found' });
    }
    if (method === 'POST' && action === 'refresh') {
      const p = providers.getWithKey(id);
      if (!p) return json(res, 404, { error: 'Provider not found' });
      try {
        const found = await providers.fetchModels(p);
        const updated = providers.update(id, { models: found });
        return json(res, 200, { provider: updated, found: found.length });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (method === 'POST' && action === 'test') {
      const body = await readBody(req).catch(() => null);
      const p = providers.getWithKey(id);
      if (!p) return json(res, 404, { error: 'Provider not found' });
      try {
        const result = await providers.test(p, body?.model);
        providers.update(id, {});
        return json(res, 200, { ok: true, ...result });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }
  }

  // ---- token usage statistics (per signed-in user)
  if (pathname === '/api/usage' && method === 'GET') {
    const payload = { ok: true, ...store.usageStats(session.sub) };
    if (isOwner && config.USERS_ROOT) payload.users = store.usagePerUser();
    return json(res, 200, payload);
  }

  // ---- chats
  if (pathname === '/api/chats' && method === 'GET') {
    return json(res, 200, { chats: store.searchChats(url.searchParams.get('q') || '', session.sub) });
  }
  if (pathname === '/api/chats' && method === 'POST') {
    const body = await readBody(req);
    const cfg = config.readConfig();
    return json(res, 200, {
      chat: await store.createChat({
        model: body?.model || cfg.model,
        persona: body?.persona || cfg.persona || '',
        systemPrompt: typeof body?.systemPrompt === 'string' ? body.systemPrompt.slice(0, 8000) : '',
        owner: session.sub,
      }),
    });
  }
  if (pathname === '/api/chats/import' && method === 'POST') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.messages)) return json(res, 400, { error: 'Invalid chat JSON (messages array required)' });
    const cleanMsgs = body.messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(0, 500)
      .map((m) => ({
        id: store.newId(),
        role: m.role,
        content: m.content.slice(0, 200000),
        thinking: typeof m.thinking === 'string' ? m.thinking.slice(0, 200000) : '',
        ts: Number(m.ts) || Date.now(),
        model: typeof m.model === 'string' ? m.model.slice(0, 120) : '',
      }));
    const chat = await store.createChat({
      title: String(body.title || 'Imported chat').slice(0, 120),
      model: String(body.model || config.readConfig().model || ''),
      persona: typeof body.persona === 'string' && PERSONAS[body.persona] ? body.persona : '',
      systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt.slice(0, 8000) : '',
      messages: cleanMsgs,
      owner: session.sub,
    });
    return json(res, 200, { chat });
  }
  const fbMatch = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/messages\/([A-Za-z0-9_-]+)\/feedback$/);
  if (fbMatch && method === 'POST') {
    const chat = store.getChat(fbMatch[1], session.sub);
    if (!chat) return json(res, 404, { error: 'Chat not found' });
    const msg = chat.messages.find((m) => m.id === fbMatch[2]);
    if (!msg) return json(res, 404, { error: 'Message not found' });
    const body = await readBody(req);
    const val = ['up', 'down', null, ''].includes(body?.feedback) ? (body.feedback || null) : null;
    msg.feedback = val;
    await store.saveChat(chat);
    return json(res, 200, { ok: true, feedback: val });
  }
  const chatMatch = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)(\/export)?$/);
  if (chatMatch) {
    const id = chatMatch[1];
    const chat = store.getChat(id, session.sub);
    if (!chat) return json(res, 404, { error: 'Chat not found' });
    if (chatMatch[2] && method === 'GET') {
      const fmt = url.searchParams.get('format') || 'md';
      const safeFile = (chat.title || 'chat').replace(/[^\w -]/g, '').slice(0, 60) || 'chat';
      if (fmt === 'json') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${safeFile}.json"`,
        });
        return res.end(JSON.stringify(chat, null, 2));
      }
      const md = chatToMarkdown(chat);
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${safeFile}.md"`,
      });
      return res.end(md);
    }
    if (method === 'GET') return json(res, 200, { chat });
    if (method === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      if (typeof body?.title === 'string') patch.title = body.title.slice(0, 200);
      if (typeof body?.model === 'string') patch.model = body.model;
      if (typeof body?.pinned === 'boolean') patch.pinned = body.pinned;
      if (typeof body?.persona === 'string' && (body.persona === '' || PERSONAS[body.persona])) patch.persona = body.persona;
      if (typeof body?.systemPrompt === 'string') patch.systemPrompt = body.systemPrompt.slice(0, 8000);
      return json(res, 200, { chat: await store.updateChat(id, patch, session.sub) });
    }
    if (method === 'DELETE') { await store.deleteChat(id, session.sub); return json(res, 200, { ok: true }); }
  }

  // ---- background runs & live re-attach
  if (pathname === '/api/runs' && method === 'GET') {
    return json(res, 200, { runs: listActiveRuns(session.sub) });
  }
  const streamMatch = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/stream$/);
  if (streamMatch && method === 'GET') {
    const cid = streamMatch[1];
    const run = activeRuns.get(cid);
    if (!run || (session.sub && run.owner !== session.sub)) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      res.write(`event: idle\ndata: {}\n\n`);
      return res.end();
    }
    attachRunSubscriber(run, res, { sendSnapshot: true });
    return;
  }

  // ---- chat completion (SSE)
  if (pathname === '/api/chat' && method === 'POST') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'Invalid body' });
    return handleChat(req, res, body, session, { isLan });
  }
  if (pathname === '/api/chat/stop' && method === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (!isOwner && !store.getChat(body?.chatId, session.sub)) return json(res, 404, { error: 'Chat not found' });
    const r = activeRuns.get(body?.chatId);
    if (r) r.controller.abort();
    return json(res, 200, { ok: true });
  }

  // ---- files
  if (pathname === '/api/files' && method === 'GET') {
    try {
      const dir = await files.list(url.searchParams.get('path') || '', { showHidden: url.searchParams.get('hidden') === '1' });
      return json(res, 200, dir);
    } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }
  if (pathname === '/api/files/text' && method === 'GET') {
    try { return json(res, 200, { path: url.searchParams.get('path'), content: await files.readText(url.searchParams.get('path') || '') }); }
    catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }
  if (pathname === '/api/files/raw' && method === 'GET') {
    try {
      const st = await files.stat(url.searchParams.get('path') || '');
      if (st.isDirectory()) return json(res, 400, { error: 'That is a directory' });
      const download = url.searchParams.get('download') === '1';
      res.writeHead(200, {
        'content-type': st.mime,
        'content-length': st.size,
        'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${path.basename(st.rel).replace(/"/g, '')}"`,
        'cache-control': 'private, max-age=60',
      });
      return fs.createReadStream(st.abs).pipe(res);
    } catch (e) { return json(res, e.status || 404, { error: e.message }); }
  }
  if (pathname === '/api/files/raw' && (method === 'PUT' || method === 'POST')) {
    try {
      const rel = url.searchParams.get('path') || '';
      const abs = files.resolveSafe(rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(abs);
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
      return json(res, 200, { ok: true, path: rel, size: (await fsp.stat(abs)).size });
    } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }
  if (pathname === '/api/files/mkdir' && method === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, { ok: true, path: await files.mkdir(body?.path || '') }); }
    catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }
  if (pathname === '/api/files/rename' && method === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, { ok: true, path: await files.rename(body?.from, body?.to) }); }
    catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }
  if (pathname === '/api/files/delete' && method === 'POST') {
    const body = await readBody(req);
    try { await files.remove(body?.path); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }
  if (pathname === '/api/files/search' && method === 'GET') {
    try { return json(res, 200, { results: await files.search(url.searchParams.get('path') || '', url.searchParams.get('q') || '') }); }
    catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }

  // ---- browser / search
  if (pathname === '/api/browse' && method === 'POST') {
    const body = await readBody(req);
    if (!body?.url) return json(res, 400, { error: 'url is required' });
    try {
      const page = await browser.readPage(body.url, { screenshot: body.screenshot !== false });
      return json(res, 200, page);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (pathname === '/api/search' && method === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, { results: await browser.searchWeb(body?.query || '') }); }
    catch (e) { return json(res, 502, { error: e.message }); }
  }

  // ---- live interactive browser
  if (pathname === '/api/browser/open' && method === 'POST') {
    if (!HAS_PLAYWRIGHT) return json(res, 501, { error: 'Live browser is not installed in this sandbox; use Reader mode.' });
    const body = await readBody(req);
    try { return json(res, 200, await live.open(normalizeUrl(body?.url || 'https://example.com'))); }
    catch (e) { return json(res, 502, { error: e.message }); }
  }
  if (pathname === '/api/browser/events' && method === 'GET') {
    const id = url.searchParams.get('session');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    const ok = await live.subscribe(id, res);
    if (!ok) { res.write(`data: ${JSON.stringify({ type: 'error', message: 'session expired' })}\n\n`); res.end(); }
    return;
  }
  if (pathname === '/api/browser/nav' && method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, await live.navigate(b?.session, normalizeUrl(b?.url || ''))); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (pathname === '/api/browser/back' && method === 'POST') { const b = await readBody(req); try { return json(res, 200, await live.back(b?.session)); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (pathname === '/api/browser/forward' && method === 'POST') { const b = await readBody(req); try { return json(res, 200, await live.forward(b?.session)); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (pathname === '/api/browser/reload' && method === 'POST') { const b = await readBody(req); try { return json(res, 200, await live.reload(b?.session)); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (pathname === '/api/browser/close' && method === 'POST') { const b = await readBody(req); await live.close(b?.session); return json(res, 200, { ok: true }); }
  if (pathname === '/api/browser/input' && method === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, await live.input(b?.session, b || {})); } catch (e) { return json(res, 400, { error: e.message }); }
  }

  return json(res, 404, { error: 'Not found' });
}

function chatToMarkdown(chat) {
  const lines = [`# ${chat.title}`, '', `_${new Date(chat.created).toLocaleString()}_`, ''];
  for (const m of chat.messages) {
    if (m.role === 'user') lines.push(`## You`, '', m.content, '');
    else if (m.role === 'assistant') {
      lines.push(`## mx-GPT${m.model ? ` (${m.model})` : ''}`, '');
      if (m.thinking) lines.push('<details><summary>Thinking</summary>', '', m.thinking, '', '</details>', '');
      for (const t of m.tools || []) lines.push(`> 🔧 ${t.name} — ${t.summary || t.status}`, '');
      lines.push(m.content || '_No response_', '');
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- startup
const server = http.createServer((req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  route(req, res).catch((err) => {
    console.error('[request]', req.method, req.url, err);
    if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Server error' });
    else if (!res.writableEnded) res.end();
  });
});
server.headersTimeout = 0;
server.requestTimeout = 0;
server.timeout = 0;

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  mx-GPT ${VERSION}`);
    console.log(`  → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`  workspace: ${config.WORKSPACE}`);
    console.log(`  ollama:    ${config.OLLAMA_URL}`);
    console.log(`  sandbox:   ${config.SANDBOX ? 'yes (public container)' : 'no (host)'}`);
    console.log(`  browser:   ${HAS_PLAYWRIGHT ? 'live + reader' : 'reader only'}\n`);
    setTimeout(async () => {
      for (const p of providers.list()) {
        if (!p.enabled || p.models.length) continue;
        try {
          const found = await providers.fetchModels(providers.getWithKey(p.id));
          providers.update(p.id, { models: found });
          console.log(`  [provider] ${p.name}: ${found.length} models`);
        } catch (e) {
          console.error(`  [provider] ${p.name}: ${e.message}`);
        }
      }
    }, 1200);
  });
}

function shutdown() {
  console.log('Shutting down…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server };
