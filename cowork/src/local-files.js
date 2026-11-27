'use strict';

/**
 * Cross-platform local file search, document text extraction (.txt/.md/.code/.pdf/.docx/.xlsx),
 * folder auditing, and undoable file management (Linux + Windows).
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const storage = require('./storage');
const officeExport = require('./office-export');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.mx-cowork-trash',
  '__pycache__', '.venv', 'venv', 'dist', 'build', '.cache',
  '$RECYCLE.BIN', 'System Volume Information', 'AppData',
]);

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.ini', '.cfg', '.conf',
  '.yml', '.yaml', '.toml', '.xml', '.html', '.htm', '.css', '.scss', '.svg',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.bat', '.ps1', '.sql', '.eml',
]);

const OFFICE_EXTS = new Set(['.docx', '.xlsx', '.pptx', '.odt']);

function quickFolders() {
  const home = os.homedir();
  const candidates = [
    { label: 'Home', path: home },
    { label: 'Desktop', path: path.join(home, 'Desktop') },
    { label: 'Documents', path: path.join(home, 'Documents') },
    { label: 'Downloads', path: path.join(home, 'Downloads') },
  ];
  if (process.platform === 'win32') {
    for (const drv of ['C:\\', 'D:\\', 'E:\\']) {
      if (fs.existsSync(drv)) candidates.push({ label: drv.slice(0, 2), path: drv });
    }
  } else {
    candidates.push({ label: '/', path: '/' });
  }
  return candidates.filter((c) => {
    try { return fs.existsSync(c.path) && fs.statSync(c.path).isDirectory(); } catch { return false; }
  });
}

function navigateOsFolder(targetPath) {
  const cur = getWorkspace();
  let next;
  if (targetPath === '..') {
    next = path.dirname(cur);
  } else {
    let raw = String(targetPath || '').trim();
    if (raw === '~' || raw.startsWith('~/')) {
      raw = path.join(os.homedir(), raw.slice(1));
    }
    next = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cur, raw);
  }
  if (!fs.existsSync(next) || !fs.statSync(next).isDirectory()) {
    throw new Error(`Folder not found: ${next}`);
  }
  storage.saveSettings({ workspace: next });
  return next;
}

async function readFileForEdit(relPath, baseDir = getWorkspace()) {
  const target = resolveSafe(relPath, baseDir);
  const st = await fsp.stat(target.abs);
  if (st.isDirectory()) throw new Error('Path is a directory');
  const ext = path.extname(target.abs).toLowerCase();
  const isOfficeOrPdf = ext === '.pdf' || OFFICE_EXTS.has(ext);
  let editable = false;
  let content = '';
  if (isOfficeOrPdf) {
    content = await readTextContent(target.abs, 120000);
    editable = false;
  } else if (st.size <= 2 * 1024 * 1024) {
    const buf = await fsp.readFile(target.abs);
    const sample = buf.subarray(0, Math.min(2048, buf.length));
    const hasNul = sample.includes(0);
    if (!hasNul || TEXT_EXTS.has(ext)) {
      content = buf.toString('utf8');
      editable = true;
    } else {
      content = `[Binary file (${ext || 'unknown'}, ${formatBytes(st.size)}) — use "Open in OS" to view]`;
      editable = false;
    }
  } else {
    content = await readTextContent(target.abs, 120000);
    editable = false;
  }
  return {
    path: target.rel,
    name: path.basename(target.abs),
    absPath: target.abs,
    ext,
    size: st.size,
    sizeLabel: formatBytes(st.size),
    editable,
    content,
  };
}

function getWorkspace() {
  const ws = storage.getSettings().workspace || os.homedir();
  return path.resolve(ws);
}

function resolveSafe(relPath = '', baseDir = getWorkspace()) {
  const root = path.resolve(baseDir);
  const cleaned = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(root, cleaned);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }
  return { root, abs, rel: rel.replace(/\\/g, '/') };
}

// ---- Pure-JS ZIP XML text extractor for .docx / .xlsx / .pptx / .odt
function extractZipXmlText(buf) {
  const texts = [];
  let offset = 0;
  const maxEntries = 80;
  let seen = 0;
  while (offset + 30 < buf.length && seen < maxEntries) {
    // Local file header signature: PK\x03\x04
    if (buf.readUInt32LE(offset) !== 0x04034b50) {
      const next = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), offset + 1);
      if (next < 0) break;
      offset = next;
      continue;
    }
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    seen++;

    const wantXml = /^(word\/document\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|ppt\/slides\/slide\d+\.xml|content\.xml)$/i.test(name);
    if (wantXml && compSize > 0 && dataStart + compSize <= buf.length) {
      try {
        const rawSlice = buf.subarray(dataStart, dataStart + compSize);
        const xmlBuf = method === 8 ? zlib.inflateRawSync(rawSlice) : method === 0 ? rawSlice : null;
        if (xmlBuf) {
          const xml = xmlBuf.toString('utf8');
          const stripped = xml
            .replace(/<\/(w:p|p|row|tr|a:p|text:p)>/gi, '\n')
            .replace(/<\/(w:tc|td|t|si)>/gi, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          if (stripped) texts.push(stripped);
        }
      } catch {}
    }
    offset = dataStart + (compSize > 0 ? compSize : 1);
  }
  return texts.join('\n\n').slice(0, 120000);
}

// ---- Pure-JS PDF text extractor (works on Windows + Linux with zero external tools)
function extractPdfText(buf) {
  const raw = buf.toString('latin1');
  const pieces = [];
  const extractStream = (str) => {
    for (const m of str.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g)) {
      pieces.push(m[1].replace(/\\([()\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, ' '));
    }
    for (const m of str.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
      const inner = [...m[1].matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)]
        .map((x) => x[1].replace(/\\([()\\])/g, '$1'))
        .join('');
      if (inner) pieces.push(inner);
    }
  };
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(raw)) && pieces.length < 3000) {
    const chunk = Buffer.from(m[1], 'latin1');
    try {
      extractStream(zlib.inflateSync(chunk).toString('latin1'));
    } catch {
      extractStream(m[1]);
    }
  }
  const out = pieces.join(' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return out.length > 10 ? out.slice(0, 120000) : '[PDF binary content — no plain text streams found]';
}

async function readTextContent(absPath, maxChars = 40000) {
  const st = await fsp.stat(absPath);
  if (st.isDirectory()) throw new Error('Path is a directory');
  if (st.size > 15 * 1024 * 1024) throw new Error('File exceeds 15 MB preview limit');
  const ext = path.extname(absPath).toLowerCase();

  if (ext === '.pdf') {
    const buf = await fsp.readFile(absPath);
    return extractPdfText(buf).slice(0, maxChars);
  }
  if (OFFICE_EXTS.has(ext)) {
    const buf = await fsp.readFile(absPath);
    const txt = extractZipXmlText(buf);
    return (txt || '[No readable text found in document]').slice(0, maxChars);
  }
  const buf = await fsp.readFile(absPath);
  // Check for binary NUL bytes
  const sample = buf.subarray(0, Math.min(2048, buf.length));
  if (!TEXT_EXTS.has(ext) && sample.includes(0)) {
    return `[Binary file (${ext || 'unknown'}, ${formatBytes(st.size)})]`;
  }
  return buf.toString('utf8').slice(0, maxChars);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function listDir(relPath = '', baseDir = getWorkspace()) {
  const { root, abs, rel } = resolveSafe(relPath, baseDir);
  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const items = [];
  for (const d of dirents) {
    if (d.name === '.mx-cowork-trash') continue;
    const full = path.join(abs, d.name);
    let size = 0;
    let mtime = 0;
    try {
      const st = await fsp.stat(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {}
    items.push({
      name: d.name,
      relPath: rel ? `${rel}/${d.name}` : d.name,
      isDir: d.isDirectory(),
      ext: d.isDirectory() ? '' : path.extname(d.name).toLowerCase(),
      size,
      sizeLabel: d.isDirectory() ? '' : formatBytes(size),
      mtime,
    });
  }
  items.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { workspace: root, path: rel, items };
}

async function searchFiles({ query = '', relPath = '', maxResults = 35, includeContent = true } = {}, baseDir = getWorkspace()) {
  const { root, abs } = resolveSafe(relPath, baseDir);
  const q = String(query || '').trim().toLowerCase();
  const terms = q.split(/\s+/).filter((t) => t.length >= 2);
  const hits = [];
  let scanned = 0;
  const MAX_SCAN = 1800;

  async function walk(dir, depth) {
    if (depth > 6 || scanned >= MAX_SCAN || hits.length >= maxResults * 2) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const d of entries) {
      if (scanned >= MAX_SCAN) break;
      if (d.isDirectory()) {
        if (IGNORE_DIRS.has(d.name) || d.name.startsWith('.')) continue;
        await walk(path.join(dir, d.name), depth + 1);
        continue;
      }
      scanned++;
      const full = path.join(dir, d.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      const ext = path.extname(d.name).toLowerCase();
      let st;
      try { st = await fsp.stat(full); } catch { continue; }

      let score = 0;
      let snippet = '';
      const lowerRel = rel.toLowerCase();
      if (!q) {
        score = 1;
      } else {
        if (lowerRel.includes(q)) score += 10;
        for (const t of terms) {
          if (lowerRel.includes(t)) score += 4;
        }
        const canSearchText = includeContent && st.size <= 3 * 1024 * 1024 && (TEXT_EXTS.has(ext) || OFFICE_EXTS.has(ext) || ext === '.pdf');
        if (canSearchText) {
          try {
            const text = await readTextContent(full, 60000);
            const lower = text.toLowerCase();
            let firstIdx = -1;
            if (lower.includes(q)) {
              score += 12;
              firstIdx = lower.indexOf(q);
            }
            for (const t of terms) {
              const idx = lower.indexOf(t);
              if (idx >= 0) {
                score += 3;
                if (firstIdx < 0) firstIdx = idx;
              }
            }
            if (firstIdx >= 0) {
              const start = Math.max(0, firstIdx - 90);
              const end = Math.min(text.length, firstIdx + 220);
              snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
            }
          } catch {}
        }
      }

      if (score > 0) {
        hits.push({
          relPath: rel,
          name: d.name,
          ext,
          size: st.size,
          sizeLabel: formatBytes(st.size),
          mtime: st.mtimeMs,
          score,
          snippet,
        });
      }
    }
  }

  await walk(abs, 0);
  hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return {
    workspace: root,
    query,
    scanned,
    results: hits.slice(0, maxResults),
  };
}

async function folderOverview(relPath = '', baseDir = getWorkspace()) {
  const { root, abs, rel } = resolveSafe(relPath, baseDir);
  const byExt = {};
  const allFiles = [];
  const topDirs = [];
  let totalBytes = 0;
  let scanned = 0;
  const MAX_SCAN = 2500;

  try {
    const top = await fsp.readdir(abs, { withFileTypes: true });
    for (const d of top) {
      if (d.isDirectory() && !IGNORE_DIRS.has(d.name)) topDirs.push(d.name);
    }
  } catch {}

  async function walk(dir, depth) {
    if (depth > 4 || scanned >= MAX_SCAN) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (scanned >= MAX_SCAN) break;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (IGNORE_DIRS.has(d.name) || d.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else {
        scanned++;
        try {
          const st = await fsp.stat(full);
          const ext = path.extname(d.name).toLowerCase() || '(no ext)';
          totalBytes += st.size;
          byExt[ext] = byExt[ext] || { count: 0, bytes: 0 };
          byExt[ext].count++;
          byExt[ext].bytes += st.size;
          allFiles.push({
            relPath: path.relative(root, full).replace(/\\/g, '/'),
            size: st.size,
            sizeLabel: formatBytes(st.size),
            mtime: st.mtimeMs,
          });
        } catch {}
      }
    }
  }

  await walk(abs, 0);
  const extSummary = Object.entries(byExt)
    .map(([ext, v]) => ({ ext, count: v.count, bytes: v.bytes, sizeLabel: formatBytes(v.bytes) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
  const largest = [...allFiles].sort((a, b) => b.size - a.size).slice(0, 12);
  const recent = [...allFiles].sort((a, b) => b.mtime - a.mtime).slice(0, 15);

  return {
    workspace: root,
    path: rel,
    totalFiles: allFiles.length,
    totalBytes,
    totalSizeLabel: formatBytes(totalBytes),
    topDirs: topDirs.slice(0, 25),
    byExtension: extSummary,
    largest,
    recent,
  };
}

// ---- Undoable file management operations
async function executeFileAction(action, baseDir = getWorkspace()) {
  const type = String(action?.type || '').toLowerCase();
  const root = path.resolve(baseDir);

  if (type === 'mkdir') {
    const target = resolveSafe(action.path || action.to, root);
    await fsp.mkdir(target.abs, { recursive: true });
    const undo = storage.pushUndo({ type: 'mkdir', path: target.rel, workspace: root, summary: `Created folder ${target.rel}` });
    return { ok: true, summary: `Created folder ${target.rel}`, undoId: undo.id };
  }

  if (type === 'write' || type === 'create') {
    const target = resolveSafe(action.path || action.to, root);
    await fsp.mkdir(path.dirname(target.abs), { recursive: true });
    let hadPrev = false;
    let prevBackup = '';
    if (fs.existsSync(target.abs)) {
      hadPrev = true;
      const trashDir = path.join(root, '.mx-cowork-trash');
      await fsp.mkdir(trashDir, { recursive: true });
      prevBackup = path.join(trashDir, `bak_${Date.now()}_${path.basename(target.abs)}`);
      await fsp.copyFile(target.abs, prevBackup);
    }
    await fsp.writeFile(target.abs, String(action.content ?? ''), 'utf8');
    const undo = storage.pushUndo({
      type: 'write',
      path: target.rel,
      hadPrev,
      prevBackup,
      workspace: root,
      summary: `${hadPrev ? 'Updated' : 'Created'} ${target.rel}`,
    });
    return { ok: true, summary: `${hadPrev ? 'Updated' : 'Created'} ${target.rel}`, undoId: undo.id };
  }

  if (type === 'move' || type === 'rename') {
    const from = resolveSafe(action.from || action.path, root);
    const to = resolveSafe(action.to, root);
    if (!fs.existsSync(from.abs)) throw new Error(`Source not found: ${from.rel}`);
    await fsp.mkdir(path.dirname(to.abs), { recursive: true });
    await fsp.rename(from.abs, to.abs);
    const undo = storage.pushUndo({
      type: 'move',
      from: from.rel,
      to: to.rel,
      workspace: root,
      summary: `Moved ${from.rel} → ${to.rel}`,
    });
    return { ok: true, summary: `Moved ${from.rel} → ${to.rel}`, undoId: undo.id };
  }

  if (type === 'copy') {
    const from = resolveSafe(action.from || action.path, root);
    const to = resolveSafe(action.to, root);
    if (!fs.existsSync(from.abs)) throw new Error(`Source not found: ${from.rel}`);
    await fsp.mkdir(path.dirname(to.abs), { recursive: true });
    await fsp.copyFile(from.abs, to.abs);
    const undo = storage.pushUndo({
      type: 'copy',
      to: to.rel,
      workspace: root,
      summary: `Copied ${from.rel} → ${to.rel}`,
    });
    return { ok: true, summary: `Copied ${from.rel} → ${to.rel}`, undoId: undo.id };
  }

  if (type === 'delete') {
    const target = resolveSafe(action.path || action.from, root);
    if (!fs.existsSync(target.abs)) throw new Error(`Not found: ${target.rel}`);
    const trashDir = path.join(root, '.mx-cowork-trash');
    await fsp.mkdir(trashDir, { recursive: true });
    const trashPath = path.join(trashDir, `del_${Date.now()}_${path.basename(target.abs)}`);
    await fsp.rename(target.abs, trashPath);
    const undo = storage.pushUndo({
      type: 'delete',
      path: target.rel,
      trashPath,
      workspace: root,
      summary: `Moved ${target.rel} to safe trash`,
    });
    return { ok: true, summary: `Moved ${target.rel} to safe trash (undoable)`, undoId: undo.id };
  }

  throw new Error(`Unsupported file action: ${type}`);
}

async function undoFileAction(undoId) {
  const entry = storage.popUndo(undoId);
  if (!entry) throw new Error('Undo record not found');
  const root = entry.workspace || getWorkspace();

  if (entry.type === 'move') {
    const cur = resolveSafe(entry.to, root);
    const orig = resolveSafe(entry.from, root);
    await fsp.mkdir(path.dirname(orig.abs), { recursive: true });
    await fsp.rename(cur.abs, orig.abs);
    return { ok: true, summary: `Restored ${entry.to} → ${entry.from}` };
  }
  if (entry.type === 'delete') {
    const orig = resolveSafe(entry.path, root);
    await fsp.mkdir(path.dirname(orig.abs), { recursive: true });
    await fsp.rename(entry.trashPath, orig.abs);
    return { ok: true, summary: `Restored ${entry.path} from trash` };
  }
  if (entry.type === 'copy') {
    const created = resolveSafe(entry.to, root);
    await fsp.rm(created.abs, { force: true });
    return { ok: true, summary: `Removed copied file ${entry.to}` };
  }
  if (entry.type === 'write') {
    const target = resolveSafe(entry.path, root);
    if (entry.hadPrev && entry.prevBackup && fs.existsSync(entry.prevBackup)) {
      await fsp.copyFile(entry.prevBackup, target.abs);
      await fsp.rm(entry.prevBackup, { force: true });
      return { ok: true, summary: `Reverted ${entry.path} to previous version` };
    }
    await fsp.rm(target.abs, { force: true });
    return { ok: true, summary: `Removed created file ${entry.path}` };
  }
  if (entry.type === 'mkdir') {
    const target = resolveSafe(entry.path, root);
    await fsp.rmdir(target.abs);
    return { ok: true, summary: `Removed empty folder ${entry.path}` };
  }
  throw new Error(`Cannot undo action type: ${entry.type}`);
}

async function readFileContent(relPath, maxChars = 120000, baseDir = getWorkspace()) {
  const { abs, rel } = resolveSafe(relPath, baseDir);
  const st = await fsp.stat(abs);
  const content = await readTextContent(abs, maxChars);
  return {
    path: rel,
    absPath: abs,
    name: path.basename(abs),
    size: st.size,
    sizeLabel: formatBytes(st.size),
    content,
  };
}

async function parseTableFile(relPath, baseDir = getWorkspace()) {
  const { abs, rel } = resolveSafe(relPath, baseDir);
  const name = path.basename(abs);
  const ext = path.extname(name).toLowerCase();
  if (ext === '.xlsx') {
    const buf = await fsp.readFile(abs);
    const parsed = officeExport.parseXlsxBuffer(buf);
    const sheets = parsed.sheets || [{ name: 'Sheet1', rows: [['']] }];
    return {
      path: rel,
      name,
      ext,
      editable: true,
      delimiter: ',',
      sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.slice(0, 600), totalRows: s.rows.length })),
      rows: sheets[0].rows.slice(0, 600),
      totalRows: sheets[0].rows.length,
    };
  }
  const raw = await fsp.readFile(abs, 'utf8');
  const parsed = officeExport.parseCsvText(raw);
  return {
    path: rel,
    name,
    ext,
    editable: true,
    delimiter: parsed.delimiter,
    sheets: [{ name: name.replace(/\.[^.]+$/, '') || 'Data', rows: parsed.rows.slice(0, 600), totalRows: parsed.rows.length }],
    rows: parsed.rows.slice(0, 600),
    totalRows: parsed.rows.length,
  };
}

async function saveTableFile({ path: relPath, rows, sheets, sheetIndex = 0, delimiter = ',' }, baseDir = getWorkspace()) {
  const root = path.resolve(baseDir);
  const target = resolveSafe(relPath, root);
  await fsp.mkdir(path.dirname(target.abs), { recursive: true });

  let hadPrev = false;
  let prevBackup = '';
  if (fs.existsSync(target.abs)) {
    hadPrev = true;
    const trashDir = path.join(root, '.mx-cowork-trash');
    await fsp.mkdir(trashDir, { recursive: true });
    prevBackup = path.join(trashDir, `bak_${Date.now()}_${path.basename(target.abs)}`);
    await fsp.copyFile(target.abs, prevBackup);
  }

  const ext = path.extname(target.abs).toLowerCase();
  if (ext === '.xlsx') {
    let allSheets = Array.isArray(sheets) && sheets.length
      ? sheets.map((s) => ({ name: s.name || 'Sheet1', rows: s.rows || [['']] }))
      : null;
    if (!allSheets && hadPrev) {
      try {
        const prevParsed = officeExport.parseXlsxBuffer(await fsp.readFile(target.abs));
        allSheets = prevParsed.sheets;
      } catch {}
    }
    if (!allSheets || !allSheets.length) allSheets = [{ name: 'Sheet1', rows: rows || [['']] }];
    if (Array.isArray(rows)) {
      const idx = Math.max(0, Math.min(allSheets.length - 1, Number(sheetIndex) || 0));
      allSheets[idx] = { name: allSheets[idx].name || `Sheet${idx + 1}`, rows };
    }
    const buf = officeExport.buildXlsxBuffer(allSheets);
    await fsp.writeFile(target.abs, buf);
  } else {
    const csvStr = officeExport.serializeCsv(rows || [], ext === '.tsv' ? '\t' : (delimiter || ','));
    await fsp.writeFile(target.abs, csvStr, 'utf8');
  }

  const undo = storage.pushUndo({
    type: 'write',
    path: target.rel,
    hadPrev,
    prevBackup,
    workspace: root,
    summary: `Updated spreadsheet ${target.rel}`,
  });
  return { ok: true, path: target.rel, summary: `Saved ${target.rel}`, undoId: undo.id };
}

async function listOfficeFiles(baseDir = getWorkspace(), maxFiles = 40) {
  const root = path.resolve(baseDir);
  const OFFICE_LIST_EXTS = new Set(['.xlsx', '.csv', '.tsv', '.docx', '.pdf', '.pptx', '.odt', '.ods']);
  const found = [];
  let scanned = 0;

  async function walk(dir, depth) {
    if (depth > 4 || found.length >= maxFiles || scanned >= 1200) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (found.length >= maxFiles || scanned >= 1200) break;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (IGNORE_DIRS.has(d.name) || d.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else {
        scanned++;
        const ext = path.extname(d.name).toLowerCase();
        if (OFFICE_LIST_EXTS.has(ext)) {
          try {
            const st = await fsp.stat(full);
            found.push({
              name: d.name,
              relPath: path.relative(root, full).replace(/\\/g, '/'),
              ext,
              size: st.size,
              sizeLabel: formatBytes(st.size),
              mtime: st.mtimeMs,
            });
          } catch {}
        }
      }
    }
  }
  await walk(root, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

module.exports = {
  quickFolders,
  getWorkspace,
  navigateOsFolder,
  resolveSafe,
  listDir,
  readTextContent,
  readFileContent,
  readFileForEdit,
  parseTableFile,
  saveTableFile,
  listOfficeFiles,
  searchFiles,
  folderOverview,
  executeFileAction,
  undoFileAction,
  formatBytes,
};
