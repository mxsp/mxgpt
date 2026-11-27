'use strict';
const crypto = require('crypto');
const { SECRET, AUTH_REQUIRED, getPasswordHash, verifyPassword, getUser, verifyUser } = require('./config');

const COOKIE = 'mxgpt_sid';
const MAX_AGE = 60 * 60 * 24 * 30;

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function makeToken(sub) {
  const payload = Buffer.from(JSON.stringify({ sub: String(sub || 'owner'), iat: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Returns { sub, role, name } or null.
function session(req) {
  if (!AUTH_REQUIRED) return { sub: 'owner', role: 'owner', name: 'owner' };
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = sign(payload);
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!(Date.now() - data.iat < MAX_AGE * 1000)) return null;
    const sub = String(data.sub || '');
    if (sub === 'owner') return { sub: 'owner', role: 'owner', name: 'owner' };
    const user = getUser(sub);
    if (!user) return null;
    return { sub, role: user.role === 'owner' ? 'owner' : 'public', name: user.name || sub };
  } catch {
    return null;
  }
}

function isAuthed(req) {
  return !!session(req);
}

function checkPassword(password) {
  if (!AUTH_REQUIRED) return true;
  try { return verifyPassword(password, getPasswordHash()); } catch { return false; }
}

// Numeric account -> its stored password; no username -> owner password.
function authenticate(username, password) {
  const id = String(username == null ? '' : username).trim();
  if (id) {
    if (!/^\d{3,12}$/.test(id)) return null;
    return verifyUser(id, password) ? { sub: id, role: 'public' } : null;
  }
  return checkPassword(password) ? { sub: 'owner', role: 'owner' } : null;
}

function setCookieHeader(sub = 'owner', secure = false) {
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`;
  return `${COOKIE}=${makeToken(sub)}; ${flags}`;
}
function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// simple per-IP login throttle
const attempts = new Map();
function throttle(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, reset: now + 60_000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 60_000; }
  rec.count++;
  attempts.set(ip, rec);
  return rec.count <= 10;
}

module.exports = {
  session, isAuthed, checkPassword, authenticate, AUTH_REQUIRED,
  setCookieHeader, clearCookieHeader, parseCookies, throttle, COOKIE,
};
