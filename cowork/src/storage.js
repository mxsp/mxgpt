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
const GRAPHS_DIR = path.join(DATA_DIR, 'graphs');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const DRAFTS_FILE = path.join(DATA_DIR, 'email-drafts.json');
const RESEARCH_FILE = path.join(DATA_DIR, 'research-briefs.json');
const UNDO_FILE = path.join(DATA_DIR, 'file-undo.json');
const CONTAINER_RUNS_FILE = path.join(DATA_DIR, 'container-runs.json');
const NOTES_FILE = path.join(DATA_DIR, 'memory-notes.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage-log.json');
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');

fs.mkdirSync(CHATS_DIR, { recursive: true });
fs.mkdirSync(GRAPHS_DIR, { recursive: true });

function defaultWorkspace() {
  const docs = path.join(os.homedir(), 'Documents');
  try {
    if (fs.existsSync(docs) && fs.statSync(docs).isDirectory()) return docs;
  } catch {}
  return os.homedir();
}

const DEFAULT_SETTINGS = {
  endpointType: 'mxgpt', // 'mxgpt' | 'ollama' | 'openai' | 'anthropic'
  providerPreset: 'mxgpt',
  endpointUrl: 'https://max.fyreflysystems.de',
  username: '',
  password: '',
  apiKey: '',
  fastModel: 'lfm3:latest',
  smartModel: 'inkling-2-mini:latest',
  copilotBModel: 'nemotron-3.5-lightning',
  agentModel: 'lfm3:latest',
  graphMapperModel: 'lfm3:latest',
  customInstructions: '',
  defaultMode: 'copilot', // 'fast' | 'smart' | 'copilot' | 'copilot_b'
  think: 'low', // 'off' | 'low' | 'medium' | 'high'
  workspace: defaultWorkspace(),
  activeProjectId: '',
  theme: 'light',
  autoApproveFileActions: false,
  updateRepo: 'mxsp/mxgpt',
  autoInstallUpdates: true,
  signedIn: false,
  // Granular Tool & Capability Settings
  toolWebSearch: true,
  toolWebFetchPages: true,
  toolWebMaxResults: 5,
  toolWikiLang: 'en',
  toolOsFiles: true,
  toolContainer: true,
  toolKnowledgeGraph: true,
  toolGit: true,
  toolSystem: true,
  toolCalculator: true,
  toolNotes: true,
  // Container code execution defaults (safe by default)
  containerEnabled: true,
  containerRuntime: 'auto', // 'auto' | 'docker' | 'podman'
  containerImage: 'python:3.12-slim',
  containerNetwork: 'none', // 'none' | 'bridge'
  containerMountMode: 'rw', // 'rw' | 'ro'
  containerTimeoutSec: 30,
  containerMemoryMb: 1024,
  containerCpus: '2',
  autoApproveContainerRuns: false,
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
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  if (merged.copilotBModel === 'gpt-oss:20b') {
    merged.copilotBModel = 'nemotron-3.5-lightning';
  }
  return merged;
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
        projectId: c.projectId || '',
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

function createChat({ title = 'New coworker session', mode = 'copilot', projectId = '' } = {}) {
  return saveChat({
    id: newId('chat'),
    title,
    mode,
    projectId: projectId || getSettings().activeProjectId || '',
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

// ---- Container Run History
function listContainerRuns() {
  const arr = readJson(CONTAINER_RUNS_FILE, []);
  return Array.isArray(arr) ? arr : [];
}

function pushContainerRun(run) {
  const all = listContainerRuns();
  all.unshift({
    ts: Date.now(),
    ...run,
    stdout: String(run.stdout || '').slice(0, 16000),
    stderr: String(run.stderr || '').slice(0, 8000),
  });
  writeJson(CONTAINER_RUNS_FILE, all.slice(0, 40));
  return all[0];
}

// ---- Persistent Copilot Memory / Notes
function listNotes() {
  const arr = readJson(NOTES_FILE, []);
  return Array.isArray(arr) ? arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) : [];
}

function saveNote(note) {
  const all = listNotes();
  const now = Date.now();
  const id = note.id || newId('note');
  const tags = Array.isArray(note.tags)
    ? note.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
    : String(note.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8);
  const item = {
    id,
    title: String(note.title || 'Untitled note').trim().slice(0, 120),
    content: String(note.content || '').trim(),
    tags,
    createdAt: note.createdAt || now,
    updatedAt: now,
  };
  const idx = all.findIndex((x) => x.id === id);
  if (idx >= 0) all[idx] = { ...all[idx], ...item, createdAt: all[idx].createdAt || now };
  else all.unshift(item);
  writeJson(NOTES_FILE, all.slice(0, 200));
  return item;
}

function deleteNote(id) {
  const all = listNotes();
  const next = all.filter((x) => x.id !== id);
  writeJson(NOTES_FILE, next);
  return next.length !== all.length;
}

function searchNotes(query = '') {
  const all = listNotes();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return all;
  const terms = q.split(/\s+/).filter((t) => t.length >= 2);
  return all.filter((n) => {
    const hay = `${n.title} ${n.content} ${(n.tags || []).join(' ')}`.toLowerCase();
    return hay.includes(q) || terms.some((t) => hay.includes(t));
  });
}

// ---- First-Class Projects & Per-Project Knowledge Graph Cache
const PROJECT_COLORS = ['#c96442', '#2f855a', '#5b67ca', '#c07b18', '#0d9488', '#b85c7e'];

function listProjects() {
  const arr = readJson(PROJECTS_FILE, []);
  return Array.isArray(arr) ? arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) : [];
}

function getProject(id) {
  if (!id) return null;
  return listProjects().find((p) => p.id === id) || null;
}

function getActiveProject() {
  const s = getSettings();
  const all = listProjects();
  if (s.activeProjectId) {
    const found = all.find((p) => p.id === s.activeProjectId);
    if (found) return found;
  }
  // Match by current workspace path if any project matches
  const ws = path.resolve(s.workspace || defaultWorkspace());
  return all.find((p) => path.resolve(p.path || '') === ws) || null;
}

function saveProject(proj) {
  const all = listProjects();
  const now = Date.now();
  const resolvedPath = path.resolve(String(proj.path || getSettings().workspace || defaultWorkspace()).trim());
  const existing = proj.id
    ? all.find((x) => x.id === proj.id)
    : all.find((x) => path.resolve(x.path || '') === resolvedPath);

  const id = existing?.id || proj.id || newId('proj');
  const defaultName = path.basename(resolvedPath) || 'Workspace';
  const color = proj.color || existing?.color || PROJECT_COLORS[all.length % PROJECT_COLORS.length];

  const item = {
    id,
    name: String(proj.name ?? existing?.name ?? defaultName).trim() || defaultName,
    path: resolvedPath,
    color,
    description: String(proj.description ?? existing?.description ?? '').trim(),
    instructions: String(proj.instructions ?? existing?.instructions ?? '').trim(),
    autoMapGraph: proj.autoMapGraph !== undefined ? Boolean(proj.autoMapGraph) : (existing?.autoMapGraph !== false),
    autoAcceptEdits: proj.autoAcceptEdits !== undefined ? Boolean(proj.autoAcceptEdits) : Boolean(existing?.autoAcceptEdits),
    autoRunContainer: proj.autoRunContainer !== undefined ? Boolean(proj.autoRunContainer) : Boolean(existing?.autoRunContainer),
    containerImage: String(proj.containerImage ?? existing?.containerImage ?? getSettings().containerImage ?? 'python:3.12-slim').trim(),
    containerNetwork: (proj.containerNetwork ?? existing?.containerNetwork ?? getSettings().containerNetwork) === 'bridge' ? 'bridge' : 'none',
    containerMountMode: (proj.containerMountMode ?? existing?.containerMountMode ?? getSettings().containerMountMode) === 'ro' ? 'ro' : 'rw',
    lastGraphAt: proj.lastGraphAt ?? existing?.lastGraphAt ?? 0,
    graphStats: proj.graphStats ?? existing?.graphStats ?? null,
    aiSummary: proj.aiSummary ?? existing?.aiSummary ?? '',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  const idx = all.findIndex((x) => x.id === id);
  if (idx >= 0) all[idx] = item;
  else all.unshift(item);
  writeJson(PROJECTS_FILE, all.slice(0, 60));
  return item;
}

function deleteProject(id) {
  const all = listProjects();
  const next = all.filter((x) => x.id !== id);
  writeJson(PROJECTS_FILE, next);
  try { fs.unlinkSync(path.join(GRAPHS_DIR, `${id}.json`)); } catch {}
  if (getSettings().activeProjectId === id) {
    saveSettings({ activeProjectId: next[0]?.id || '' });
  }
  return next.length !== all.length;
}

function setActiveProject(id) {
  const p = getProject(id);
  if (!p) throw new Error('Project not found');
  saveSettings({
    activeProjectId: p.id,
    workspace: p.path,
    autoApproveFileActions: Boolean(p.autoAcceptEdits),
    autoApproveContainerRuns: Boolean(p.autoRunContainer),
    containerImage: p.containerImage || 'python:3.12-slim',
    containerNetwork: p.containerNetwork || 'none',
    containerMountMode: p.containerMountMode || 'rw',
  });
  return saveProject({ ...p, updatedAt: Date.now() });
}

function getProjectGraphCache(projectId) {
  if (!projectId || !/^[A-Za-z0-9_-]+$/.test(projectId)) return null;
  return readJson(path.join(GRAPHS_DIR, `${projectId}.json`), null);
}

function saveProjectGraphCache(projectId, graph) {
  if (!projectId || !/^[A-Za-z0-9_-]+$/.test(projectId)) return;
  writeJson(path.join(GRAPHS_DIR, `${projectId}.json`), graph);
}

// ---- Saved Multi-Provider Profiles (WebUI-style Providers & API Keys)
function listSavedProviders() {
  const arr = readJson(PROVIDERS_FILE, []);
  return Array.isArray(arr) ? arr : [];
}

function publicProviders() {
  return listSavedProviders().map((p) => ({
    ...p,
    hasApiKey: Boolean(p.apiKey),
    keyHint: p.apiKey ? `••••${String(p.apiKey).slice(-4)}` : '',
    apiKey: '',
    hasPassword: Boolean(p.password),
    password: '',
  }));
}

function saveProviderProfile(prof) {
  const all = listSavedProviders();
  const id = prof.id || newId('prov');
  const existing = all.find((x) => x.id === id);
  const cur = getSettings();
  const normUrl = String(prof.endpointUrl || '').trim().replace(/\/+$/, '');
  const sameActive = !existing && normUrl && normUrl === String(cur.endpointUrl || '').replace(/\/+$/, '') && (prof.endpointType || 'openai') === cur.endpointType;
  const item = {
    id,
    name: String(prof.name || 'Custom Provider').trim(),
    presetId: String(prof.presetId || 'custom_openai'),
    endpointType: String(prof.endpointType || 'openai'),
    endpointUrl: normUrl,
    username: String(prof.username ?? existing?.username ?? '').trim(),
    password: prof.password === '__KEEP__' ? (existing?.password || (sameActive ? cur.password : '')) : String(prof.password || ''),
    apiKey: prof.apiKey === '__KEEP__' ? (existing?.apiKey || (sameActive ? cur.apiKey : '')) : String(prof.apiKey || '').trim(),
    fastModel: String(prof.fastModel || existing?.fastModel || '').trim(),
    smartModel: String(prof.smartModel || existing?.smartModel || '').trim(),
    models: Array.isArray(prof.models) ? prof.models.slice(0, 120) : (existing?.models || []),
    updatedAt: Date.now(),
  };
  const idx = all.findIndex((x) => x.id === id);
  if (idx >= 0) all[idx] = item;
  else all.unshift(item);
  writeJson(PROVIDERS_FILE, all.slice(0, 30));
  return item;
}

function deleteProviderProfile(id) {
  const all = listSavedProviders();
  const next = all.filter((x) => x.id !== id);
  writeJson(PROVIDERS_FILE, next);
  return next.length !== all.length;
}

function activateProviderProfile(id) {
  const p = listSavedProviders().find((x) => x.id === id);
  if (!p) throw new Error('Provider profile not found');
  const patch = {
    endpointType: p.endpointType,
    providerPreset: p.presetId || p.endpointType,
    endpointUrl: p.endpointUrl,
    username: p.username || '',
    password: p.password || '',
    apiKey: p.apiKey || '',
    signedIn: true,
  };
  if (p.fastModel) {
    patch.fastModel = p.fastModel;
    patch.agentModel = p.fastModel;
    patch.graphMapperModel = p.fastModel;
  }
  if (p.smartModel) patch.smartModel = p.smartModel;
  return saveSettings(patch);
}

// ---- Token Usage Statistics (exact WebUI analytics model)
function recordUsage({
  chatId = '',
  chatTitle = '',
  model = '',
  role = 'main', // 'main' | 'worker' | 'planner' | 'graph'
  promptTokens = 0,
  evalTokens = 0,
  elapsedMs = 0,
  tokensPerSec = 0,
} = {}) {
  const pTok = Math.max(0, Math.round(Number(promptTokens) || 0));
  const eTok = Math.max(0, Math.round(Number(evalTokens) || 0));
  const ms = Math.max(0, Math.round(Number(elapsedMs) || 0));
  const tps = Number(tokensPerSec) || (eTok > 0 && ms > 0 ? Number((eTok / (ms / 1000)).toFixed(1)) : 0);
  if (!pTok && !eTok && !ms) return null;

  const log = readJson(USAGE_FILE, []);
  const arr = Array.isArray(log) ? log : [];
  const now = Date.now();
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const entry = {
    ts: now,
    day,
    chatId: String(chatId || ''),
    chatTitle: String(chatTitle || '').slice(0, 80),
    model: String(model || 'unknown'),
    role: String(role || 'main'),
    promptTokens: pTok,
    evalTokens: eTok,
    totalTokens: pTok + eTok,
    elapsedMs: ms,
    tokensPerSec: tps,
  };
  arr.push(entry);
  writeJson(USAGE_FILE, arr.slice(-2500));
  return entry;
}

function getUsageStats() {
  const log = readJson(USAGE_FILE, []);
  const arr = Array.isArray(log) ? log : [];
  const totals = {
    requests: 0,
    promptTokens: 0,
    evalTokens: 0,
    subagentTokens: 0,
    totalTokens: 0,
    totalMs: 0,
    avgTokensPerSec: 0,
  };
  let tpsSum = 0;
  let tpsCnt = 0;

  const byDayMap = new Map();
  const byModelMap = new Map();
  const byRoleMap = new Map();
  const byChatMap = new Map();

  for (const e of arr) {
    const p = Number(e.promptTokens) || 0;
    const ev = Number(e.evalTokens) || 0;
    const tot = p + ev;
    const ms = Number(e.elapsedMs) || 0;
    const isSub = e.role === 'worker' || e.role === 'graph';

    totals.requests++;
    totals.promptTokens += p;
    if (isSub) totals.subagentTokens += ev;
    else totals.evalTokens += ev;
    totals.totalTokens += tot;
    totals.totalMs += ms;
    if (e.tokensPerSec > 0) { tpsSum += e.tokensPerSec; tpsCnt++; }

    // By day
    const dk = e.day || 'unknown';
    const dObj = byDayMap.get(dk) || { day: dk, requests: 0, promptTokens: 0, evalTokens: 0, totalTokens: 0 };
    dObj.requests++; dObj.promptTokens += p; dObj.evalTokens += ev; dObj.totalTokens += tot;
    byDayMap.set(dk, dObj);

    // By model
    const mk = e.model || 'unknown';
    const mObj = byModelMap.get(mk) || { model: mk, requests: 0, promptTokens: 0, evalTokens: 0, totalTokens: 0, tpsSum: 0, tpsCnt: 0 };
    mObj.requests++; mObj.promptTokens += p; mObj.evalTokens += ev; mObj.totalTokens += tot;
    if (e.tokensPerSec > 0) { mObj.tpsSum += e.tokensPerSec; mObj.tpsCnt++; }
    byModelMap.set(mk, mObj);

    // By role
    const rk = e.role || 'main';
    const rObj = byRoleMap.get(rk) || { role: rk, requests: 0, promptTokens: 0, evalTokens: 0, totalTokens: 0, tpsSum: 0, tpsCnt: 0 };
    rObj.requests++; rObj.promptTokens += p; rObj.evalTokens += ev; rObj.totalTokens += tot;
    if (e.tokensPerSec > 0) { rObj.tpsSum += e.tokensPerSec; rObj.tpsCnt++; }
    byRoleMap.set(rk, rObj);

    // By chat
    if (e.chatId) {
      const cObj = byChatMap.get(e.chatId) || {
        id: e.chatId,
        title: e.chatTitle || 'Chat',
        model: mk,
        requests: 0,
        promptTokens: 0,
        evalTokens: 0,
        totalTokens: 0,
        lastTs: 0,
      };
      cObj.requests++; cObj.promptTokens += p; cObj.evalTokens += ev; cObj.totalTokens += tot;
      if (e.ts >= cObj.lastTs) { cObj.lastTs = e.ts; if (e.chatTitle) cObj.title = e.chatTitle; cObj.model = mk; }
      byChatMap.set(e.chatId, cObj);
    }
  }

  totals.avgTokensPerSec = tpsCnt ? Number((tpsSum / tpsCnt).toFixed(1)) : 0;

  return {
    totals,
    byDay: [...byDayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byModel: [...byModelMap.values()]
      .map((m) => ({
        model: m.model,
        requests: m.requests,
        promptTokens: m.promptTokens,
        evalTokens: m.evalTokens,
        totalTokens: m.totalTokens,
        avgTokensPerSec: m.tpsCnt ? Number((m.tpsSum / m.tpsCnt).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    byRole: [...byRoleMap.values()]
      .map((r) => ({
        role: r.role,
        requests: r.requests,
        promptTokens: r.promptTokens,
        evalTokens: r.evalTokens,
        totalTokens: r.totalTokens,
        avgTokensPerSec: r.tpsCnt ? Number((r.tpsSum / r.tpsCnt).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    byChat: [...byChatMap.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, 25),
  };
}

function resetUsageStats() {
  writeJson(USAGE_FILE, []);
  return { ok: true };
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
  listContainerRuns,
  pushContainerRun,
  listNotes,
  saveNote,
  deleteNote,
  searchNotes,
  listProjects,
  getProject,
  getActiveProject,
  saveProject,
  deleteProject,
  setActiveProject,
  getProjectGraphCache,
  saveProjectGraphCache,
  listSavedProviders,
  publicProviders,
  saveProviderProfile,
  deleteProviderProfile,
  activateProviderProfile,
  recordUsage,
  getUsageStats,
  resetUsageStats,
};
