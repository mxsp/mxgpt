'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
// Optional root of per-user sandboxes (e.g. /srv/mxusers with <uid>/mnt/state).
// When set on the host, the owner's Usage panel can break token use down per user.
const USERS_ROOT = (process.env.MXGPT_USERS_ROOT || '').replace(/\/+$/, '');
const PUBLIC_DIR = path.join(ROOT, 'public');
const WORKSPACE = path.resolve(process.env.FILES_ROOT || process.env.HOME || ROOT);
const SANDBOX = process.env.MXGPT_SANDBOX === '1';
const OLLAMA_SETTINGS_URL = (process.env.OLLAMA_SETTINGS_URL || '').replace(/\/+$/, '');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'chats'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const OLLAMA_DEFAULTS = {
  keepAlive: '30m',      // how long a model stays loaded: '5m' | '30m' | '1h' | 'forever' | 'unload'
  topP: 0.95,
  topK: 40,
  repeatPenalty: 1.1,
  numPredict: -1,        // -1 = let the model stop on its own
  numGpu: null,          // null = Ollama decides
  numThread: null,
  numBatch: null,
  seed: null,
};
// The only two local models exposed in the UI. Everything else on the Ollama
// host stays installed but hidden, so the picker is just Smart / Fast.
const LOCAL_MODES = {
  fast: {
    label: 'Fast',
    hint: 'LFM3 1.7B',
    model: process.env.MXGPT_FAST_MODEL || 'lfm3:latest',
  },
  smart: {
    label: 'Smart',
    hint: 'Inkling 26B',
    model: process.env.MXGPT_SMART_MODEL || 'inkling-2-mini:latest',
  },
};

const DEFAULTS = {
  model: process.env.DEFAULT_MODEL || '',
  customInstructions: '',
  persona: 'default',
  theme: 'light',
  filesRoot: WORKSPACE,
  numCtx: 32768,         // global context window; matches OLLAMA_CONTEXT_LENGTH
  temperature: 0.7,
  preferred: {},         // source id -> model name (remembered default per source)
  ollama: { ...OLLAMA_DEFAULTS },
};

function readConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...DEFAULTS, ...saved, ollama: { ...OLLAMA_DEFAULTS, ...(saved.ollama || {}) } };
  } catch {
    return { ...DEFAULTS, ollama: { ...OLLAMA_DEFAULTS } };
  }
}
function writeConfig(patch) {
  const current = readConfig();
  const next = { ...current, ...patch };
  if (patch.ollama) next.ollama = { ...current.ollama, ...patch.ollama };
  if (patch.preferred) next.preferred = { ...current.preferred, ...patch.preferred };
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
  return next;
}

// Global Ollama runtime options applied to local requests.
const OLLAMA_KEYS = {
  topP: 'top_p',
  topK: 'top_k',
  repeatPenalty: 'repeat_penalty',
  numPredict: 'num_predict',
  numGpu: 'num_gpu',
  numThread: 'num_thread',
  numBatch: 'num_batch',
  seed: 'seed',
};
function ollamaOptions(cfg = readConfig(), { allowRuntimeOverrides = !SANDBOX, model = '' } = {}) {
  const options = {
    temperature: Number(cfg.temperature ?? 0.7),
    // Lock num_ctx to global OLLAMA_CONTEXT_LENGTH (32768) unless LAN admin overrides,
    // and lock num_thread to 20 (all 20 physical cores across both NUMA sockets, zero HT)
    // so every client/container hits the exact same loaded runner with 1ms load time.
    num_ctx: 32768,
    num_thread: Number(process.env.MXGPT_NUM_THREAD || 20),
  };
  if (!allowRuntimeOverrides) return options;
  if (cfg.numCtx !== null && cfg.numCtx !== undefined && cfg.numCtx !== '') {
    const ctx = Number(cfg.numCtx);
    if (Number.isFinite(ctx) && ctx >= 2048) options.num_ctx = Math.round(ctx);
  }
  const extra = cfg.ollama || {};
  for (const [key, name] of Object.entries(OLLAMA_KEYS)) {
    const raw = extra[key];
    if (raw === '' || raw === null || raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) options[name] = n;
  }
  return options;
}
function ollamaKeepAlive(cfg = readConfig(), { allowRuntimeOverrides = !SANDBOX } = {}) {
  if (!allowRuntimeOverrides) return undefined;
  const k = cfg.ollama?.keepAlive;
  if (!k || k === 'default') return undefined;
  if (k === 'forever') return -1;
  if (k === 'unload') return 0;
  return k;
}

// ---- LAN access detection ---------------------------------------------------
function isPrivateLanIp(raw) {
  if (!raw) return false;
  const ip = String(raw).trim().replace(/^::ffff:/i, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (net.isIPv4(ip)) {
    return (
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
      ip.startsWith('169.254.')
    );
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    return low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80:');
  }
  return false;
}

function isLanRequest(req) {
  if (SANDBOX) return false;
  // Requests arriving through Cloudflare Tunnel or public gateway are NEVER LAN
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-mxgpt-public'] === '1') {
    return false;
  }
  const remote = (req.socket?.remoteAddress || '').replace(/^::ffff:/i, '');
  if (!isPrivateLanIp(remote)) return false;
  // If arriving via local port-80 reverse proxy (loopback), verify X-Forwarded-For is also LAN
  if ((remote === '127.0.0.1' || remote === '::1') && req.headers['x-forwarded-for']) {
    const hops = String(req.headers['x-forwarded-for']).split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length && !hops.every(isPrivateLanIp)) return false;
  }
  return true;
}

// ---- auth secret / password -------------------------------------------------
const SECRET_FILE = path.join(DATA_DIR, 'secret');
let SECRET;
try {
  SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} catch {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [algo, salt, hash] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const calc = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return calc.length === expected.length && crypto.timingSafeEqual(calc, expected);
  } catch {
    return false;
  }
}

const AUTH_REQUIRED = process.env.MXGPT_AUTH === 'on';
const initialPassword = process.env.MXGPT_PASSWORD || 'mxgpt';
if (AUTH_REQUIRED && !fs.existsSync(path.join(DATA_DIR, 'password'))) {
  fs.writeFileSync(path.join(DATA_DIR, 'password'), hashPassword(initialPassword), { mode: 0o600 });
}
function getPasswordHash() {
  return fs.readFileSync(path.join(DATA_DIR, 'password'), 'utf8').trim();
}
function setPassword(pw) {
  fs.writeFileSync(path.join(DATA_DIR, 'password'), hashPassword(pw), { mode: 0o600 });
}

// ---- numeric public users ---------------------------------------------------
// data/users.json: { "1001": { hash, role: "public", created } }
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function normalizeUser(id) {
  const s = String(id == null ? '' : id).trim();
  return /^\d{3,12}$/.test(s) ? s : '';
}
function readUsers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function writeUsers(users) {
  const tmp = `${USERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
  try { fs.chmodSync(USERS_FILE, 0o600); } catch {}
}
function getUser(id) {
  const key = normalizeUser(id);
  return key ? (readUsers()[key] || null) : null;
}
function verifyUser(id, password) {
  const user = getUser(id);
  if (!user || typeof user.hash !== 'string') return false;
  return verifyPassword(password, user.hash);
}
function addUser(id, password, meta = {}) {
  const key = normalizeUser(id);
  if (!key) throw new Error('User number must be 3-12 digits');
  if (!password || String(password).length < 6) throw new Error('Password must be at least 6 characters');
  const users = readUsers();
  users[key] = {
    hash: hashPassword(String(password)),
    role: 'public',
    created: Date.now(),
    ...meta,
  };
  writeUsers(users);
  return { id: key, role: users[key].role, created: users[key].created };
}
function removeUser(id) {
  const key = normalizeUser(id);
  const users = readUsers();
  if (!key || !users[key]) return false;
  delete users[key];
  writeUsers(users);
  return true;
}
function listUsers() {
  return Object.entries(readUsers())
    .map(([id, u]) => ({ id, role: u.role || 'public', created: u.created || null, name: u.name || '' }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

module.exports = {
  ROOT,
  DATA_DIR,
  USERS_ROOT,
  PUBLIC_DIR,
  WORKSPACE,
  SANDBOX,
  OLLAMA_SETTINGS_URL,
  PORT: Number(process.env.PORT || 8088),
  HOST: process.env.HOST || '0.0.0.0',
  OLLAMA_URL: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  SECRET,
  AUTH_REQUIRED,
  readConfig,
  writeConfig,
  ollamaOptions,
  LOCAL_MODES,
  ollamaKeepAlive,
  OLLAMA_DEFAULTS,
  isPrivateLanIp,
  isLanRequest,
  hashPassword,
  verifyPassword,
  getPasswordHash,
  setPassword,
  normalizeUser,
  getUser,
  verifyUser,
  addUser,
  removeUser,
  listUsers,
  VERSION: require('../package.json').version,
};
