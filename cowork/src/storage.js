'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function getConfigDir() {
  if (process.env.MX_COWORK_DATA) return path.resolve(process.env.MX_COWORK_DATA);
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'mx-cowork');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'mx-cowork');
}

const DATA_DIR = getConfigDir();
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DRAFTS_FILE = path.join(DATA_DIR, 'email-drafts.json');
const RESEARCH_FILE = path.join(DATA_DIR, 'research-briefs.json');
const UNDO_FILE = path.join(DATA_DIR, 'file-undo.json');

fs.mkdirSync(CHATS_DIR, { recursive: true });

function defaultWorkspace() {
  const docs = path.join(os.homedir(), 'Documents');
  try {
    if (fs.existsSync(docs) && fs.statSync(docs).isDirectory()) return docs;
  } catch {}
  return os.homedir();
}

const DEFAULT_SETTINGS = {
  endpointType: 'mxgpt', // 'mxgpt' | 'ollama' | 'openai' | 'anthropic'
  providerPreset: 'mxgpt', // 'mxgpt' | 'ollama' | 'openai' | 'openrouter' | 'groq' | 'gemini' | 'mistral' | 'lmstudio' | 'custom_openai' | 'anthropic'
  endpointUrl: 'https://max.fyreflysystems.de',
  username: '',
  password: '',
  apiKey: '',
  fastModel: 'lfm3:latest',
  smartModel: 'inkling-2-mini:latest',
  defaultMode: 'copilot', // 'fast' | 'smart' | 'copilot'
  think: 'low', // 'off' | 'low' | 'medium' | 'high'
  workspace: defaultWorkspace(),
  theme: 'light',
  autoApproveFileActions: false,
  emailSignature: '',
  updateRepo: 'mxsp/mxgpt',
  signedIn: false,
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function getSettings() {
  const saved = readJson(SETTINGS_FILE, {});
  return { ...DEFAULT_SETTINGS, ...saved };
}

function saveSettings(patch = {}) {
  const cur = getSettings();
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if ((k === 'password' || k === 'apiKey') && v === '__KEEP__') continue;
    if (k in DEFAULT_SETTINGS) next[k] = v;
  }
  if (next.endpointUrl) next.endpointUrl = String(next.endpointUrl).trim().replace(/\/+$/, '');
  if (next.workspace) next.workspace = path.resolve(String(next.workspace).trim());
  writeJson(SETTINGS_FILE, next);
  return next;
}

function publicSettings() {
  const s = getSettings();
  return {
    ...s,
    hasPassword: Boolean(s.password),
    password: '',
    hasApiKey: Boolean(s.apiKey),
    apiKey: '',
  };
}

function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

// ---- Chats
function listChats() {
  try {
    const files = fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith('.json'));
    const items = [];
    for (const f of files) {
      const c = readJson(path.join(CHATS_DIR, f), null);
      if (!c || !c.id) continue;
      items.push({
        id: c.id,
        title: c.title || 'New task',
        mode: c.mode || 'copilot',
        updated: c.updated || c.created || 0,
        messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
      });
    }
    items.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    return items;
  } catch {
    return [];
  }
}

function getChat(id) {
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return readJson(path.join(CHATS_DIR, `${id}.json`), null);
}

function saveChat(chat) {
  if (!chat.id) chat.id = newId('chat');
  chat.updated = Date.now();
  if (!chat.created) chat.created = chat.updated;
  writeJson(path.join(CHATS_DIR, `${chat.id}.json`), chat);
  return chat;
}

function createChat({ title = 'New coworker session', mode = 'copilot' } = {}) {
  return saveChat({
    id: newId('chat'),
    title,
    mode,
    created: Date.now(),
    updated: Date.now(),
    messages: [],
  });
}

function deleteChat(id) {
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return false;
  const fp = path.join(CHATS_DIR, `${id}.json`);
  try {
    fs.unlinkSync(fp);
    return true;
  } catch {
    return false;
  }
}

// ---- Email Drafts
function listDrafts() {
  const arr = readJson(DRAFTS_FILE, []);
  return Array.isArray(arr) ? arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) : [];
}

function saveDraft(draft) {
  const all = listDrafts();
  const now = Date.now();
  const id = draft.id || newId('mail');
  const item = {
    id,
    to: String(draft.to || '').trim(),
    cc: String(draft.cc || '').trim(),
    subject: String(draft.subject || '').trim(),
    body: String(draft.body || ''),
    tone: String(draft.tone || 'professional'),
    createdAt: draft.createdAt || now,
    updatedAt: now,
  };
  const idx = all.findIndex((x) => x.id === id);
  if (idx >= 0) all[idx] = { ...all[idx], ...item, createdAt: all[idx].createdAt || now };
  else all.unshift(item);
  writeJson(DRAFTS_FILE, all.slice(0, 100));
  return item;
}

function deleteDraft(id) {
  const all = listDrafts();
  const next = all.filter((x) => x.id !== id);
  writeJson(DRAFTS_FILE, next);
  return next.length !== all.length;
}

// ---- Research Briefs
function listResearch() {
  const arr = readJson(RESEARCH_FILE, []);
  return Array.isArray(arr) ? arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) : [];
}

function saveResearch(brief) {
  const all = listResearch();
  const now = Date.now();
  const item = {
    id: brief.id || newId('res'),
    title: String(brief.title || 'Research brief').trim(),
    query: String(brief.query || '').trim(),
    markdown: String(brief.markdown || ''),
    sources: Array.isArray(brief.sources) ? brief.sources : [],
    createdAt: brief.createdAt || now,
    updatedAt: now,
  };
  const idx = all.findIndex((x) => x.id === item.id);
  if (idx >= 0) all[idx] = { ...all[idx], ...item, createdAt: all[idx].createdAt || now };
  else all.unshift(item);
  writeJson(RESEARCH_FILE, all.slice(0, 100));
  return item;
}

function deleteResearch(id) {
  const all = listResearch();
  const next = all.filter((x) => x.id !== id);
  writeJson(RESEARCH_FILE, next);
  return next.length !== all.length;
}

// ---- File Undo Log
function listUndo() {
  const arr = readJson(UNDO_FILE, []);
  return Array.isArray(arr) ? arr : [];
}

function pushUndo(entry) {
  const all = listUndo();
  all.unshift({ id: newId('undo'), ts: Date.now(), ...entry });
  writeJson(UNDO_FILE, all.slice(0, 100));
  return all[0];
}

function popUndo(id) {
  const all = listUndo();
  const idx = all.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  const [entry] = all.splice(idx, 1);
  writeJson(UNDO_FILE, all);
  return entry;
}

module.exports = {
  DATA_DIR,
  getSettings,
  saveSettings,
  publicSettings,
  newId,
  listChats,
  getChat,
  saveChat,
  createChat,
  deleteChat,
  listDrafts,
  saveDraft,
  deleteDraft,
  listResearch,
  saveResearch,
  deleteResearch,
  listUndo,
  pushUndo,
  popUndo,
};
