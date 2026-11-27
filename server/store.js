'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, USERS_ROOT } = require('./config');

const CHATS_DIR = path.join(DATA_DIR, 'chats');
const INDEX_FILE = path.join(DATA_DIR, 'chats.json');
const locks = new Map();

function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  }).catch(() => {});
  return next;
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function writeIndex(list) {
  atomicWrite(INDEX_FILE, list);
}

function newId() {
  return 'c' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function pathFor(id) {
  return path.join(CHATS_DIR, `${id}.json`);
}

function ownedBy(meta, owner) {
  return owner === undefined || owner === null || (meta.owner || 'owner') === owner;
}

function listChats(owner) {
  return readIndex()
    .filter((c) => ownedBy(c, owner))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0));
}

function getChat(id, owner) {
  try {
    const chat = JSON.parse(fs.readFileSync(pathFor(id), 'utf8'));
    return ownedBy(chat, owner) ? chat : null;
  } catch {
    return null;
  }
}

function createChat({ title = 'New chat', model = '', owner = 'owner', persona = '', systemPrompt = '', messages = [] } = {}) {
  return withLock('index', () => {
    const now = Date.now();
    const chat = {
      id: newId(),
      title,
      model,
      owner,
      pinned: false,
      persona: persona || '',
      systemPrompt: systemPrompt || '',
      created: now,
      updated: now,
      messages: Array.isArray(messages) ? messages : [],
    };
    atomicWrite(pathFor(chat.id), chat);
    const index = readIndex();
    index.push({
      id: chat.id,
      owner,
      title: chat.title,
      model: chat.model,
      pinned: false,
      persona: chat.persona,
      created: now,
      updated: now,
      messageCount: chat.messages.length,
      preview: previewOf(chat),
    });
    writeIndex(index);
    return chat;
  });
}

function saveChat(chat) {
  return withLock(chat.id, () => {
    chat.updated = Date.now();
    atomicWrite(pathFor(chat.id), chat);
    return withLock('index', () => {
      let index = readIndex();
      const i = index.findIndex((c) => c.id === chat.id);
      const meta = {
        id: chat.id,
        owner: chat.owner || 'owner',
        title: chat.title,
        model: chat.model,
        pinned: !!chat.pinned,
        persona: chat.persona || '',
        created: chat.created,
        updated: chat.updated,
        messageCount: chat.messages.length,
        preview: previewOf(chat),
      };
      if (i >= 0) index[i] = meta;
      else index.push(meta);
      writeIndex(index);
      return meta;
    });
  });
}

function previewOf(chat) {
  const firstUser = (chat.messages || []).find((m) => m.role === 'user');
  const lastAssistant = [...(chat.messages || [])].reverse().find((m) => m.role === 'assistant');
  const text = lastAssistant?.content || firstUser?.content || '';
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 140);
}

function updateChat(id, patch, owner) {
  return withLock(id, () => {
    const chat = getChat(id, owner);
    if (!chat) return null;
    Object.assign(chat, patch);
    atomicWrite(pathFor(id), chat);
    return withLock('index', () => {
      const index = readIndex();
      const meta = index.find((c) => c.id === id);
      if (meta) {
        Object.assign(meta, {
          title: chat.title,
          model: chat.model,
          pinned: !!chat.pinned,
          persona: chat.persona || '',
          updated: patch.pinned !== undefined && Object.keys(patch).length === 1 ? meta.updated : Date.now(),
        });
        writeIndex(index);
      }
      return chat;
    });
  });
}

function deleteChat(id, owner) {
  return withLock(id, () => {
    if (owner !== undefined && !getChat(id, owner)) return false;
    try { fs.unlinkSync(pathFor(id)); } catch {}
    return withLock('index', () => {
      writeIndex(readIndex().filter((c) => c.id !== id));
      return true;
    });
  });
}

// Aggregate token usage from every assistant message this user owns.
// Sources: message.usage (per reply) + message.subagents[].evalTokens.
// ---- token usage ----------------------------------------------------------
// Read every chat JSON in a data dir (same layout as this app's DATA_DIR).
function readChatsFrom(dir, owner) {
  let index;
  try { index = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8')); } catch { return []; }
  if (!Array.isArray(index)) index = Array.isArray(index?.chats) ? index.chats : [];
  const out = [];
  for (const meta of index) {
    if (!meta || !meta.id || !ownedBy(meta, owner)) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, 'chats', `${meta.id}.json`), 'utf8'))); } catch {}
  }
  return out;
}

function blankUsage() {
  return { requests: 0, chats: 0, promptTokens: 0, evalTokens: 0, subagentTokens: 0, totalTokens: 0, totalMs: 0, evalSeconds: 0 };
}

function addUsage(row, m) {
  const pt = Math.max(0, Number(m.usage.promptTokens) || 0);
  const et = Math.max(0, Number(m.usage.evalTokens) || 0);
  const ms = Math.max(0, Number(m.usage.totalMs) || 0);
  const tps = Number(m.usage.tokensPerSec) || 0;
  const sub = (m.subagents || []).reduce((n, s) => n + (Number(s.evalTokens) || 0), 0);
  row.requests += 1;
  row.promptTokens += pt;
  row.evalTokens += et;
  row.subagentTokens += sub;
  row.totalTokens += pt + et + sub;
  row.totalMs += ms;
  row.evalSeconds += tps > 0 ? et / tps : 0;
}

function finishUsage(row) {
  return {
    ...row,
    avgTokensPerSec: row.evalSeconds > 0.2 ? Math.round((row.evalTokens / row.evalSeconds) * 10) / 10 : 0,
  };
}

function summarizeUsage(chats) {
  const dayKey = (ts) => {
    const d = new Date(ts || Date.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const totals = blankUsage();
  const byModel = new Map();
  const byDay = new Map();
  const byOwner = new Map();
  const byChat = [];

  for (const chat of chats) {
    const ownerKey = chat.owner || 'owner';
    if (!byOwner.has(ownerKey)) byOwner.set(ownerKey, blankUsage());
    const ownerRow = byOwner.get(ownerKey);
    const chatRow = { id: chat.id, title: chat.title || 'Untitled', model: chat.model || '', updated: chat.updated || 0, ...blankUsage() };

    for (const m of chat.messages || []) {
      if (m.role !== 'assistant' || !m.usage) continue;
      const model = m.model || chat.model || 'unknown';
      const day = dayKey(m.ts || chat.updated || Date.now());

      addUsage(totals, m);
      addUsage(ownerRow, m);
      if (!byModel.has(model)) byModel.set(model, { model, ...blankUsage() });
      addUsage(byModel.get(model), m);
      if (!byDay.has(day)) byDay.set(day, { day, ...blankUsage() });
      addUsage(byDay.get(day), m);
      addUsage(chatRow, m);
    }

    if (chatRow.requests) {
      totals.chats += 1;
      ownerRow.chats += 1;
      byChat.push(chatRow);
    }
  }

  return {
    totals: finishUsage(totals),
    byModel: [...byModel.values()].map((r) => ({ ...finishUsage(r), model: r.model })).sort((a, b) => b.totalTokens - a.totalTokens),
    byDay: [...byDay.values()].map((r) => ({ ...finishUsage(r), day: r.day })).sort((a, b) => a.day.localeCompare(b.day)),
    byChat: byChat.map((r) => ({ ...finishUsage(r), id: r.id, title: r.title, model: r.model, updated: r.updated })).sort((a, b) => b.totalTokens - a.totalTokens),
    byOwner,
  };
}

// Aggregate token usage for one owner from this instance's data dir.
function usageStats(owner) {
  const { totals, byModel, byDay, byChat } = summarizeUsage(readChatsFrom(DATA_DIR, owner));
  return { totals, byModel, byDay, byChat };
}

// Owner-only: one row per user, merging this instance's chats with each
// per-user sandbox under USERS_ROOT/<uid>/mnt/state (containers run with auth
// off, so their chats are attributed to the numeric user id).
function usagePerUser() {
  const merged = new Map();
  const keys = ['requests', 'chats', 'promptTokens', 'evalTokens', 'subagentTokens', 'totalTokens', 'totalMs', 'evalSeconds'];
  const merge = (id, row) => {
    if (!merged.has(id)) merged.set(id, blankUsage());
    const t = merged.get(id);
    for (const k of keys) t[k] += Number(row[k]) || 0;
  };

  for (const [id, row] of summarizeUsage(readChatsFrom(DATA_DIR)).byOwner) merge(id, row);

  if (USERS_ROOT) {
    let entries = [];
    try { entries = fs.readdirSync(USERS_ROOT, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
      const dir = path.join(USERS_ROOT, e.name, 'mnt', 'state');
      if (!fs.existsSync(path.join(dir, 'chats.json'))) continue;
      for (const row of summarizeUsage(readChatsFrom(dir)).byOwner.values()) merge(e.name, row);
    }
  }

  return [...merged.entries()]
    .map(([id, row]) => ({ id, ...finishUsage(row) }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

function searchChats(q, owner) {
  const needle = String(q || '').toLowerCase().trim();
  if (!needle) return listChats(owner);
  return listChats(owner).filter((c) => {
    if ((c.title || '').toLowerCase().includes(needle)) return true;
    const chat = getChat(c.id, owner);
    return chat?.messages?.some((m) => String(m.content || '').toLowerCase().includes(needle));
  });
}

module.exports = {
  listChats,
  getChat,
  createChat,
  saveChat,
  updateChat,
  deleteChat,
  searchChats,
  usageStats,
  usagePerUser,
  newId,
  atomicWrite,
};
