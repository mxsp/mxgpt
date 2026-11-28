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
const WORKFLOWS_FILE = path.join(DATA_DIR, 'workflows.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

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
  // Container & On-Machine code execution defaults
  codeExecutionTarget: 'container', // 'container' | 'host'
  containerEnabled: true,
  containerRuntime: 'auto', // 'auto' | 'docker' | 'podman'
  containerImage: 'python:3.12-slim',
  containerNetwork: 'none', // 'none' | 'bridge'
  containerMountMode: 'rw', // 'rw' | 'ro'
  containerTimeoutSec: 30,
  containerMemoryMb: 1024,
  containerCpus: '2',
  autoApproveContainerRuns: false,
  // 2-Tier Token Usage Limits (Fast = Unlimited; Smart = 4h & Weekly caps; Overboost removes all limits)
  smartLimit4h: 150000,
  smartLimitWeekly: 2000000,
  overboostEnabled: false,
  // Company Worker Productivity & Privacy Defaults (v1.6.0)
  piiShieldEnabled: false,
  piiCustomTerms: '',
  globalHotkey: 'Alt+Space',
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
  if (next.workspace) next.workspace = normalizeLocalPath(next.workspace);
  if (next.codeExecutionTarget !== 'host') next.codeExecutionTarget = 'container';
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

function moveChatToProject(chatId, projectId = '') {
  const c = getChat(chatId);
  if (!c) return null;
  c.projectId = String(projectId || '');
  return saveChat(c);
}

function reorderProjects(orderedIds = []) {
  const all = listProjects();
  const byId = new Map(all.map((p) => [p.id, p]));
  const next = [];
  for (const id of orderedIds) {
    const p = byId.get(id);
    if (p) { next.push(p); byId.delete(id); }
  }
  for (const p of byId.values()) next.push(p);
  writeJson(PROJECTS_FILE, next);
  return next;
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

function normalizeLocalPath(inputPath) {
  let raw = String(inputPath || '').trim();
  // Strip accidental surrounding quotes from copied Windows/Linux paths
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = path.join(os.homedir(), raw.slice(1));
  }
  return path.resolve(raw || defaultWorkspace());
}

function pathsEqual(a, b) {
  const pa = path.resolve(String(a || ''));
  const pb = path.resolve(String(b || ''));
  return process.platform === 'win32' ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

function getActiveProject() {
  const s = getSettings();
  const all = listProjects();
  if (s.activeProjectId) {
    const found = all.find((p) => p.id === s.activeProjectId);
    if (found) return found;
  }
  const ws = path.resolve(s.workspace || defaultWorkspace());
  return all.find((p) => p.path && pathsEqual(p.path, ws)) || null;
}

function saveProject(proj) {
  const all = listProjects();
  const now = Date.now();
  const resolvedPath = normalizeLocalPath(proj.path || getSettings().workspace || defaultWorkspace());
  // Ensure the project directory exists so File Manager never hits ENOENT
  try { fs.mkdirSync(resolvedPath, { recursive: true }); } catch {}
  const existing = proj.id
    ? all.find((x) => x.id === proj.id)
    : all.find((x) => x.path && pathsEqual(x.path, resolvedPath));

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
    codeExecutionTarget: (proj.codeExecutionTarget ?? existing?.codeExecutionTarget ?? getSettings().codeExecutionTarget) === 'host' ? 'host' : 'container',
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
    codeExecutionTarget: p.codeExecutionTarget === 'host' ? 'host' : (p.codeExecutionTarget === 'container' ? 'container' : (getSettings().codeExecutionTarget || 'container')),
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

// ---- Token Usage Statistics & 2-Tier Limits (Fast = Unlimited; Smart = 4h + Daily limits)
function recordUsage({
  chatId = '',
  chatTitle = '',
  model = '',
  role = 'main', // 'main' | 'worker' | 'planner' | 'graph'
  tier = '', // 'fast' | 'smart'
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

  const inferredTier = tier === 'fast' || tier === 'smart'
    ? tier
    : (role === 'worker' || role === 'graph' ? 'fast' : 'smart');

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
    tier: inferredTier,
    promptTokens: pTok,
    evalTokens: eTok,
    totalTokens: pTok + eTok,
    elapsedMs: ms,
    tokensPerSec: tps,
  };
  arr.push(entry);
  writeJson(USAGE_FILE, arr.slice(-4000));
  return entry;
}

function getUsageLimitsStatus() {
  const cfg = getSettings();
  const log = readJson(USAGE_FILE, []);
  const arr = Array.isArray(log) ? log : [];
  const now = Date.now();
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  const limit4h = Math.max(0, Math.round(Number(cfg.smartLimit4h ?? 150000)));
  const limitWeekly = Math.max(0, Math.round(Number(cfg.smartLimitWeekly ?? 2000000)));

  let fastTotalTokens = 0;
  let fastRequests = 0;
  let smart4h = 0;
  let smartWeekly = 0;
  let oldest4hTs = 0;
  let oldestWeeklyTs = 0;

  for (const e of arr) {
    const tot = Number(e.totalTokens) || ((Number(e.promptTokens) || 0) + (Number(e.evalTokens) || 0));
    const ts = Number(e.ts) || 0;
    const isFast = e.tier === 'fast' || e.role === 'worker' || e.role === 'graph';
    if (isFast) {
      fastTotalTokens += tot;
      fastRequests++;
      continue;
    }
    if (now - ts <= FOUR_HOURS) {
      smart4h += tot;
      if (!oldest4hTs || ts < oldest4hTs) oldest4hTs = ts;
    }
    if (now - ts <= SEVEN_DAYS) {
      smartWeekly += tot;
      if (!oldestWeeklyTs || ts < oldestWeeklyTs) oldestWeeklyTs = ts;
    }
  }

  const overboost = Boolean(cfg.overboostEnabled);
  const exceeded4h = !overboost && limit4h > 0 && smart4h >= limit4h;
  const exceededWeekly = !overboost && limitWeekly > 0 && smartWeekly >= limitWeekly;

  return {
    overboost,
    fast: {
      unlimited: true,
      totalTokens: fastTotalTokens,
      requests: fastRequests,
    },
    smart: {
      unlimited: overboost,
      overboost,
      limit4h: overboost ? 0 : limit4h,
      used4h: smart4h,
      remaining4h: overboost ? null : (limit4h > 0 ? Math.max(0, limit4h - smart4h) : null),
      pct4h: overboost ? 0 : (limit4h > 0 ? Math.min(100, Math.round((smart4h / limit4h) * 100)) : 0),
      reset4hInMs: overboost ? 0 : (oldest4hTs ? Math.max(0, (oldest4hTs + FOUR_HOURS) - now) : 0),
      limitWeekly: overboost ? 0 : limitWeekly,
      usedWeekly: smartWeekly,
      remainingWeekly: overboost ? null : (limitWeekly > 0 ? Math.max(0, limitWeekly - smartWeekly) : null),
      pctWeekly: overboost ? 0 : (limitWeekly > 0 ? Math.min(100, Math.round((smartWeekly / limitWeekly) * 100)) : 0),
      resetWeeklyInMs: overboost ? 0 : (oldestWeeklyTs ? Math.max(0, (oldestWeeklyTs + SEVEN_DAYS) - now) : 0),
      exceeded4h,
      exceededWeekly,
      allowed: overboost || (!exceeded4h && !exceededWeekly),
    },
  };
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
    limits: getUsageLimitsStatus(),
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

// ---- Reusable Slash Workflows (/meeting-notes, /weekly-update, custom team playbooks)
const BUILTIN_WORKFLOWS = [
  {
    id: 'wf_meeting_notes',
    slug: 'meeting-notes',
    title: 'Meeting Notes → Decisions & Action Items',
    description: 'Turn raw meeting notes or transcript into Decisions, Risks, and structured Action Items saved to Project Tasks.',
    builtin: true,
    prompt: 'Analyze the meeting notes / transcript below. Produce:\n1. **Executive Summary** (3 bullets)\n2. **Key Decisions Made**\n3. **Open Questions & Risks**\n4. **Action Items Table** (Task | Owner | Due Date | Priority)\nAlso output an ```action-items JSON array block so mx-Cowork saves every action item to the Project Tasks board:\n```action-items\n[{"title":"...","owner":"...","due":"YYYY-MM-DD","priority":"high|med|low"}]\n```\n\nNotes:\n',
  },
  {
    id: 'wf_weekly_update',
    slug: 'weekly-update',
    title: 'Weekly Status Update',
    description: 'Inspect project Git commits, workspace files & notes to draft a crisp Friday executive status update.',
    builtin: true,
    prompt: 'Inspect my project Git commits, recent workspace activity, and saved notes, then write a concise executive Weekly Status Update with sections: **Highlights Shipped**, **In Progress**, **Blockers / Risks**, and **Next Week Priorities**. Keep it clear and ready to send to management or export as Word/PDF.',
  },
  {
    id: 'wf_rewrite',
    slug: 'rewrite',
    title: 'Polish Business Writing',
    description: 'Rewrite pasted text into clear, confident, polite corporate communication.',
    builtin: true,
    prompt: 'Rewrite the text below so it is clear, concise, polite, and professional (preserve the original language and facts; output only the polished version plus 1 short note on key improvements):\n\n',
  },
  {
    id: 'wf_translate',
    slug: 'translate',
    title: 'Business Translate (DE ↔ EN)',
    description: 'Natural professional German ↔ English translation preserving tone, tables & formatting.',
    builtin: true,
    prompt: 'Translate the text below naturally between German and English (if German → English, if English → German; preserve Markdown formatting, numbers, and business tone):\n\n',
  },
  {
    id: 'wf_audit_data',
    slug: 'audit-data',
    title: 'Audit Spreadsheet / CSV Data',
    description: 'Inspect pinned CSV/XLSX data for duplicates, missing values, anomalies & KPI table.',
    builtin: true,
    prompt: 'Audit the pinned CSV / Excel dataset (or find the latest spreadsheet in my workspace). Check for duplicate rows, missing/malformed values, outliers, and totals. Provide a Markdown KPI summary table ready for Excel export and propose any cleanup steps.',
  },
  {
    id: 'wf_report',
    slug: 'report',
    title: 'Executive Report (Word / PDF Ready)',
    description: 'Draft a structured business report with headings & tables ready for 1-click .docx or .pdf export.',
    builtin: true,
    prompt: 'Draft a polished, executive-ready report with clear Markdown headings, concise bullet points, and summary tables (formatted cleanly for 1-click Word .docx and PDF export) on the following topic:\n\n',
  },
  {
    id: 'wf_action_items',
    slug: 'action-items',
    title: 'Extract Action Items to Task Board',
    description: 'Pull every commitment, owner & deadline from pasted text or pinned docs into Project Tasks.',
    builtin: true,
    prompt: 'Extract every concrete task, owner, and deadline from the text or pinned documents below. Present a concise checklist AND output an ```action-items JSON array block (`[{"title":"...","owner":"...","due":"YYYY-MM-DD","priority":"high|med|low"}]`) so mx-Cowork adds them straight to the Tasks board:\n\n',
  },
  {
    id: 'wf_compare',
    slug: 'compare',
    title: 'Compare Two Documents',
    description: 'Explain substantive differences, risks & changed numbers/clauses between two versions.',
    builtin: true,
    prompt: 'Compare the two pinned or named documents thoroughly. Summarize: 1) **Substantive Changes**, 2) **Added Clauses / Items**, 3) **Removed Clauses / Items**, and 4) **Risks or Numbers Changed** in a clean comparison table:\n\n',
  },
];

function listWorkflows() {
  const custom = readJson(WORKFLOWS_FILE, []);
  const customArr = Array.isArray(custom) ? custom : [];
  return [...customArr, ...BUILTIN_WORKFLOWS];
}

function saveWorkflow(wf) {
  const custom = readJson(WORKFLOWS_FILE, []);
  const arr = Array.isArray(custom) ? custom : [];
  const slug = String(wf.slug || wf.title || 'custom')
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'custom';
  const item = {
    id: wf.id && !String(wf.id).startsWith('wf_') ? wf.id : newId('cwf'),
    slug,
    title: String(wf.title || `/${slug}`).trim().slice(0, 80),
    description: String(wf.description || '').trim().slice(0, 180),
    prompt: String(wf.prompt || '').trim(),
    builtin: false,
    updatedAt: Date.now(),
  };
  const idx = arr.findIndex((x) => x.id === item.id || x.slug === item.slug);
  if (idx >= 0) arr[idx] = item;
  else arr.unshift(item);
  writeJson(WORKFLOWS_FILE, arr.slice(0, 60));
  return item;
}

function deleteWorkflow(id) {
  const custom = readJson(WORKFLOWS_FILE, []);
  const arr = Array.isArray(custom) ? custom : [];
  const next = arr.filter((x) => x.id !== id);
  writeJson(WORKFLOWS_FILE, next);
  return next.length !== arr.length;
}

// ---- Lightweight Project Action Items / Tasks
function listTasks(projectId = '') {
  const arr = readJson(TASKS_FILE, []);
  const all = Array.isArray(arr) ? arr : [];
  const filtered = projectId ? all.filter((t) => !t.projectId || t.projectId === projectId) : all;
  return filtered.sort((a, b) => Number(Boolean(a.done)) - Number(Boolean(b.done)) || (b.updatedAt || 0) - (a.updatedAt || 0));
}

function saveTask(task) {
  const all = readJson(TASKS_FILE, []);
  const arr = Array.isArray(all) ? all : [];
  const now = Date.now();
  const id = task.id || newId('tsk');
  const item = {
    id,
    title: String(task.title || '').trim().slice(0, 200),
    owner: String(task.owner || '').trim().slice(0, 60),
    due: String(task.due || '').trim().slice(0, 32),
    priority: ['high', 'med', 'low'].includes(task.priority) ? task.priority : 'med',
    done: Boolean(task.done),
    projectId: String(task.projectId ?? getSettings().activeProjectId ?? ''),
    source: String(task.source || '').slice(0, 120),
    createdAt: task.createdAt || now,
    updatedAt: now,
  };
  if (!item.title) return null;
  const idx = arr.findIndex((x) => x.id === id);
  if (idx >= 0) arr[idx] = { ...arr[idx], ...item, createdAt: arr[idx].createdAt || now };
  else arr.unshift(item);
  writeJson(TASKS_FILE, arr.slice(0, 300));
  return item;
}

function toggleTask(id) {
  const all = readJson(TASKS_FILE, []);
  const arr = Array.isArray(all) ? all : [];
  const item = arr.find((x) => x.id === id);
  if (!item) return null;
  item.done = !item.done;
  item.updatedAt = Date.now();
  writeJson(TASKS_FILE, arr);
  return item;
}

function deleteTask(id) {
  const all = readJson(TASKS_FILE, []);
  const arr = Array.isArray(all) ? all : [];
  const next = arr.filter((x) => x.id !== id);
  writeJson(TASKS_FILE, next);
  return next.length !== arr.length;
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
  moveChatToProject,
  reorderProjects,
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
  getUsageLimitsStatus,
  getUsageStats,
  resetUsageStats,
  listWorkflows,
  saveWorkflow,
  deleteWorkflow,
  listTasks,
  saveTask,
  toggleTask,
  deleteTask,
};
