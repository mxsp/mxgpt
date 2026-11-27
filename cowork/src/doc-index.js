'use strict';

/**
 * Private Local Document Knowledge Base (Zero-Dependency BM25 + Stemmed Passage Search)
 *
 * Indexes non-code & project documents (PDF, DOCX, XLSX, CSV, MD, TXT, HTML, JSON)
 * into overlapping text chunks stored locally on disk so company workers can search
 * SOPs, policies, contracts, invoices & manuals with natural-language queries
 * completely offline with exact file & passage citations.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const localFiles = require('./local-files');
const storage = require('./storage');

const KB_DIR = path.join(storage.DATA_DIR, 'doc-kb');
fs.mkdirSync(KB_DIR, { recursive: true });

const INDEXABLE_EXTS = new Set([
  '.pdf', '.docx', '.xlsx', '.csv', '.tsv', '.md', '.txt', '.rst', '.rtf', '.html', '.htm', '.json', '.yaml', '.yml',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.mx-cowork-trash', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache',
]);

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were', 'have', 'has', 'had',
  'not', 'but', 'what', 'all', 'can', 'her', 'his', 'our', 'their', 'they', 'them', 'will', 'would',
  'about', 'into', 'over', 'after', 'also', 'how', 'when', 'where', 'which', 'who', 'why',
  'der', 'die', 'das', 'und', 'für', 'mit', 'von', 'ist', 'sind', 'war', 'ein', 'eine', 'einer', 'dem', 'den', 'des', 'auf', 'aus', 'bei',
]);

function stemToken(w) {
  let s = w.toLowerCase();
  if (s.length > 5 && s.endsWith('ings')) return s.slice(0, -4);
  if (s.length > 4 && s.endsWith('ing')) return s.slice(0, -3);
  if (s.length > 4 && s.endsWith('tion')) return s.slice(0, -3);
  if (s.length > 4 && s.endsWith('ed')) return s.slice(0, -2);
  if (s.length > 4 && s.endsWith('es')) return s.slice(0, -2);
  if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  if (s.length > 5 && s.endsWith('en')) return s.slice(0, -2);
  return s;
}

function tokenize(text) {
  const words = String(text || '')
    .toLowerCase()
    .match(/[a-z0-9äöüß]{2,}/gi) || [];
  const out = [];
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    out.push(stemToken(w));
  }
  return out;
}

function kbFileForWorkspace(workspace) {
  const hash = crypto.createHash('sha1').update(path.resolve(workspace)).digest('hex').slice(0, 14);
  return path.join(KB_DIR, `kb-${hash}.json`);
}

function chunkText(text, chunkSize = 850, overlap = 140) {
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const chunks = [];
  let pos = 0;
  let section = 1;
  while (pos < clean.length && chunks.length < 40) {
    let end = Math.min(clean.length, pos + chunkSize);
    if (end < clean.length) {
      const nl = clean.lastIndexOf('\n', end);
      if (nl > pos + chunkSize * 0.5) end = nl;
    }
    const piece = clean.slice(pos, end).trim();
    if (piece.length >= 25) {
      chunks.push({ section: section++, text: piece });
    }
    if (end >= clean.length) break;
    pos = Math.max(pos + 100, end - overlap);
  }
  return chunks;
}

function walkDocs(root, rel = '', acc = [], maxFiles = 220) {
  if (acc.length >= maxFiles) return acc;
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    if (acc.length >= maxFiles) break;
    if (ent.name.startsWith('.') && ent.name !== '.env.example') continue;
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walkDocs(root, childRel, acc, maxFiles);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (INDEXABLE_EXTS.has(ext)) {
        try {
          const st = fs.statSync(path.join(root, childRel));
          if (st.size > 0 && st.size <= 15 * 1024 * 1024) {
            acc.push({ relPath: childRel, absPath: path.join(root, childRel), mtimeMs: st.mtimeMs, size: st.size });
          }
        } catch {}
      }
    }
  }
  return acc;
}

async function indexWorkspaceDocs(workspace, { onProgress } = {}) {
  const ws = path.resolve(workspace || localFiles.getWorkspace());
  const files = walkDocs(ws);
  const chunks = [];
  let indexedFiles = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress?.({ current: i + 1, total: files.length, file: f.relPath });
    try {
      const txt = await localFiles.readTextContent(f.absPath, 60000);
      if (!txt || !txt.trim()) continue;
      const parts = chunkText(txt);
      if (!parts.length) continue;
      indexedFiles++;
      for (const p of parts) {
        const toks = tokenize(p.text + ' ' + f.relPath);
        const tf = {};
        for (const t of toks) tf[t] = (tf[t] || 0) + 1;
        chunks.push({
          id: `${f.relPath}#${p.section}`,
          path: f.relPath,
          section: p.section,
          text: p.text,
          len: toks.length,
          tf,
        });
      }
    } catch {}
  }

  const df = {};
  let totalLen = 0;
  for (const ch of chunks) {
    totalLen += ch.len;
    for (const term of Object.keys(ch.tf)) {
      df[term] = (df[term] || 0) + 1;
    }
  }

  const indexData = {
    workspace: ws,
    builtAt: Date.now(),
    fileCount: indexedFiles,
    chunkCount: chunks.length,
    avgLen: chunks.length ? totalLen / chunks.length : 1,
    df,
    chunks,
  };

  fs.writeFileSync(kbFileForWorkspace(ws), JSON.stringify(indexData), 'utf8');
  return {
    workspace: ws,
    builtAt: indexData.builtAt,
    fileCount: indexData.fileCount,
    chunkCount: indexData.chunkCount,
  };
}

function getIndexStats(workspace) {
  const ws = path.resolve(workspace || localFiles.getWorkspace());
  const fp = kbFileForWorkspace(ws);
  if (!fs.existsSync(fp)) return { indexed: false, workspace: ws, fileCount: 0, chunkCount: 0, builtAt: 0 };
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return {
      indexed: true,
      workspace: ws,
      fileCount: d.fileCount || 0,
      chunkCount: d.chunkCount || 0,
      builtAt: d.builtAt || 0,
    };
  } catch {
    return { indexed: false, workspace: ws, fileCount: 0, chunkCount: 0, builtAt: 0 };
  }
}

async function queryWorkspaceDocs(query, workspace, { topK = 6, autoBuild = true } = {}) {
  const ws = path.resolve(workspace || localFiles.getWorkspace());
  const fp = kbFileForWorkspace(ws);
  if (!fs.existsSync(fp)) {
    if (!autoBuild) return { hits: [], indexed: false };
    await indexWorkspaceDocs(ws);
  }
  let idx;
  try {
    idx = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return { hits: [], indexed: false };
  }

  const qToks = [...new Set(tokenize(query))];
  if (!qToks.length || !idx.chunks?.length) return { hits: [], indexed: true, fileCount: idx.fileCount, chunkCount: idx.chunkCount };

  const N = idx.chunks.length;
  const avgLen = idx.avgLen || 1;
  const k1 = 1.5;
  const b = 0.75;
  const qLower = String(query || '').toLowerCase().trim();

  const scored = [];
  for (const ch of idx.chunks) {
    let score = 0;
    for (const qt of qToks) {
      const f = ch.tf?.[qt] || 0;
      if (!f) continue;
      const docFreq = idx.df?.[qt] || 1;
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (ch.len / avgLen))));
    }
    if (qLower.length >= 4 && ch.text.toLowerCase().includes(qLower)) {
      score += 3.0;
    }
    if (score > 0) {
      scored.push({
        path: ch.path,
        section: ch.section,
        score: Number(score.toFixed(2)),
        snippet: ch.text.slice(0, 620),
      });
    }
  }

  scored.sort((a, b2) => b2.score - a.score);
  return {
    indexed: true,
    fileCount: idx.fileCount,
    chunkCount: idx.chunkCount,
    builtAt: idx.builtAt,
    hits: scored.slice(0, topK),
  };
}

module.exports = {
  indexWorkspaceDocs,
  getIndexStats,
  queryWorkspaceDocs,
};
