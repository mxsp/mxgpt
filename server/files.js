'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { WORKSPACE } = require('./config');

const MIME = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.html': 'text/html',
  '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.cjs': 'text/javascript', '.jsx': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
  '.json': 'application/json', '.jsonl': 'application/jsonl', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.toml': 'text/toml', '.xml': 'application/xml', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.py': 'text/x-python', '.rb': 'text/x-ruby', '.go': 'text/x-go', '.rs': 'text/x-rust', '.java': 'text/x-java',
  '.c': 'text/x-c', '.h': 'text/x-c', '.cpp': 'text/x-c++', '.sh': 'text/x-sh', '.bash': 'text/x-sh',
  '.sql': 'text/x-sql', '.log': 'text/plain', '.ini': 'text/plain', '.conf': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

const TEXTY = /^(text\/|application\/(json|xml|javascript|x-)|image\/svg)/;
const SENSITIVE = /(^|\/)(\.ssh|\.gnupg|\.aws|\.password-store|\.kube|\.docker\/config\.json)(\/|$)/;

class FileError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

function resolveSafe(rel) {
  const clean = String(rel || '').replace(/\\/g, '/');
  const abs = path.resolve(WORKSPACE, '.' + path.sep + clean);
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) throw new FileError('Path is outside the workspace', 403);
  const relCheck = path.relative(WORKSPACE, abs).replace(/\\/g, '/');
  if (SENSITIVE.test(relCheck) || SENSITIVE.test('/' + relCheck)) throw new FileError('That location is protected', 403);
  return abs;
}

function relOf(abs) {
  return path.relative(WORKSPACE, abs).replace(/\\/g, '/');
}

function mimeOf(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

function isTextMime(mime) {
  return TEXTY.test(mime) || mime === 'application/octet-stream' && false;
}

async function list(rel = '', { showHidden = false } = {}) {
  const abs = resolveSafe(rel);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!showHidden && e.name.startsWith('.')) continue;
    if (SENSITIVE.test(path.posix.join(rel || '', e.name))) continue;
    let st;
    try { st = await fsp.stat(path.join(abs, e.name)); } catch { continue; }
    out.push({
      name: e.name,
      path: path.posix.join(rel || '', e.name).replace(/^\/+/, ''),
      dir: st.isDirectory(),
      size: st.size,
      mtime: st.mtimeMs,
      mime: st.isDirectory() ? 'inode/directory' : mimeOf(e.name),
    });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: rel || '', parent: rel ? path.posix.dirname(rel || '') : null, entries: out, root: WORKSPACE };
}

async function readText(rel) {
  const abs = resolveSafe(rel);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw new FileError('That is a directory');
  if (st.size > 2_000_000) throw new FileError('File is too large to read as text (>2 MB)', 413);
  const buf = await fsp.readFile(abs);
  if (buf.includes(0)) throw new FileError('File appears to be binary');
  return buf.toString('utf8');
}

async function write(rel, content) {
  const abs = resolveSafe(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
  return relOf(abs);
}

async function mkdir(rel) {
  const abs = resolveSafe(rel);
  await fsp.mkdir(abs, { recursive: true });
  return relOf(abs);
}

async function rename(from, to) {
  const a = resolveSafe(from);
  const b = resolveSafe(to);
  await fsp.mkdir(path.dirname(b), { recursive: true });
  await fsp.rename(a, b);
  return relOf(b);
}

async function remove(rel) {
  const abs = resolveSafe(rel);
  if (abs === WORKSPACE) throw new FileError('Cannot delete the workspace root');
  await fsp.rm(abs, { recursive: true, force: true });
  return true;
}

async function stat(rel) {
  const abs = resolveSafe(rel);
  const st = await fsp.stat(abs);
  return { ...st, abs, rel: relOf(abs), mime: st.isDirectory() ? 'inode/directory' : mimeOf(abs) };
}

async function search(rel, query, limit = 100) {
  const root = resolveSafe(rel || '');
  const needle = String(query || '').toLowerCase();
  const hits = [];
  async function walk(dir, depth) {
    if (hits.length >= limit || depth > 6) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= limit) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const abs = path.join(dir, e.name);
      const relPath = relOf(abs);
      if (e.name.toLowerCase().includes(needle)) {
        const st = await fsp.stat(abs).catch(() => null);
        if (st) hits.push({ name: e.name, path: relPath, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, mime: st.isDirectory() ? 'inode/directory' : mimeOf(e.name) });
      }
      if (e.isDirectory()) await walk(abs, depth + 1);
    }
  }
  await walk(root, 0);
  return hits;
}

module.exports = { resolveSafe, list, readText, write, mkdir, rename, remove, stat, search, mimeOf, isTextMime, FileError, relOf };
