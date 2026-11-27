'use strict';

/**
 * Interactive Project Knowledge Graph Analyzer for mx-Cowork.
 *
 * Scans the active local OS workspace and extracts a typed graph:
 *  - Nodes: folder, code, doc, config, data, test, style, package
 *  - Edges: imports, contains, depends_on, links_to
 *  - Symbols: exported functions, classes, components, routes, Markdown headings
 *  - Metrics: hub centrality, top hubs, circular imports, orphan files, language stats
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const localFiles = require('./local-files');
const endpoint = require('./endpoint');
const storage = require('./storage');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.mx-cowork-trash',
  '__pycache__', '.venv', 'venv', 'env', 'dist', 'build', 'out', '.next',
  '.nuxt', '.cache', 'coverage', 'target', 'vendor', '.idea', '.vscode',
  '$RECYCLE.BIN', 'System Volume Information',
]);

const CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.sql',
]);
const STYLE_EXTS = new Set(['.css', '.scss', '.sass', '.less', '.html', '.htm', '.vue', '.svelte']);
const DOC_EXTS = new Set(['.md', '.markdown', '.txt', '.rst', '.pdf', '.docx', '.odt']);
const CONFIG_EXTS = new Set(['.json', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.env', '.dockerfile']);
const DATA_EXTS = new Set(['.csv', '.tsv', '.xml', '.xlsx', '.sqlite', '.db']);

function classifyFile(relPath, ext) {
  const lower = relPath.toLowerCase();
  const base = path.basename(lower);
  if (/(^|\/)(__tests__|tests?|spec)\b|\.(test|spec)\.[a-z0-9]+$/i.test(lower)) return 'test';
  if (base === 'dockerfile' || base.startsWith('docker-compose') || CONFIG_EXTS.has(ext)) return 'config';
  if (CODE_EXTS.has(ext)) return 'code';
  if (STYLE_EXTS.has(ext)) return 'style';
  if (DOC_EXTS.has(ext)) return 'doc';
  if (DATA_EXTS.has(ext)) return 'data';
  return 'file';
}

function extractSymbols(text, ext) {
  const syms = [];
  const add = (name, kind) => {
    const clean = String(name || '').trim();
    if (!clean || clean.length > 64) return;
    if (!syms.some((s) => s.name === clean)) syms.push({ name: clean, kind });
  };

  if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(ext)) {
    for (const m of text.matchAll(/(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) add(m[1], 'fn');
    for (const m of text.matchAll(/(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) add(m[1], 'class');
    for (const m of text.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) add(m[1], 'export');
    for (const m of text.matchAll(/(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g)) add(`${m[1].toUpperCase()} ${m[2]}`, 'route');
    for (const m of text.matchAll(/ipcMain\.handle\s*\(\s*['"`]([^'"`]+)['"`]/g)) add(`ipc:${m[1]}`, 'route');
  } else if (ext === '.py') {
    for (const m of text.matchAll(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) add(m[1], 'fn');
    for (const m of text.matchAll(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) add(m[1], 'class');
  } else if (ext === '.go') {
    for (const m of text.matchAll(/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/gm)) add(m[1], 'fn');
    for (const m of text.matchAll(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/gm)) add(m[1], 'type');
  } else if (ext === '.rs') {
    for (const m of text.matchAll(/(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1], 'fn');
    for (const m of text.matchAll(/(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1], 'struct');
  } else if (ext === '.md' || ext === '.markdown') {
    for (const m of text.matchAll(/^#{1,2}\s+(.+)$/gm)) add(m[1].replace(/[#*`]/g, '').trim(), 'heading');
  }

  return syms.slice(0, 14);
}

function extractRawRefs(text, ext) {
  const localSpecs = [];
  const externalPkgs = [];
  const docLinks = [];

  if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte'].includes(ext)) {
    const patterns = [
      /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const spec = m[1].trim();
        if (!spec || spec.startsWith('http://') || spec.startsWith('https://')) continue;
        if (spec.startsWith('.') || spec.startsWith('/')) localSpecs.push(spec);
        else {
          const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          if (pkg && !pkg.startsWith('node:')) externalPkgs.push(pkg);
        }
      }
    }
  } else if (ext === '.py') {
    for (const m of text.matchAll(/^\s*from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z_][A-Za-z0-9_.]*)\s+import\b/gm)) {
      const mod = m[1].trim();
      if (mod.startsWith('.')) localSpecs.push(mod);
      else localSpecs.push('py:' + mod);
    }
    for (const m of text.matchAll(/^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)/gm)) {
      localSpecs.push('py:' + m[1].trim());
    }
  } else if (ext === '.md' || ext === '.markdown') {
    for (const m of text.matchAll(/\[[^\]]+\]\(([^)#\s]+)\)/g)) {
      const target = m[1].trim();
      if (!/^https?:|^mailto:/i.test(target)) docLinks.push(target);
    }
    for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      docLinks.push(m[1].trim());
    }
  } else if (ext === '.html' || ext === '.htm') {
    for (const m of text.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
      const target = m[1].trim();
      if (!/^https?:|^data:|^#/i.test(target)) localSpecs.push(target);
    }
  } else if (ext === '.c' || ext === '.cpp' || ext === '.h' || ext === '.hpp') {
    for (const m of text.matchAll(/^\s*#include\s+"([^"]+)"/gm)) localSpecs.push('./' + m[1].trim());
  }

  return { localSpecs, externalPkgs, docLinks };
}

function resolveFileTarget(fromRel, spec, fileSet) {
  const fromDir = path.posix.dirname(fromRel);
  const baseDir = fromDir === '.' ? '' : fromDir;

  // Python import resolution
  if (spec.startsWith('py:')) {
    const dotted = spec.slice(3).replace(/\./g, '/');
    const cands = [
      `${dotted}.py`,
      `${dotted}/__init__.py`,
      baseDir ? `${baseDir}/${dotted}.py` : '',
      baseDir ? `${baseDir}/${dotted}/__init__.py` : '',
    ].filter(Boolean);
    for (const c of cands) {
      const norm = path.posix.normalize(c).replace(/^\/+/, '');
      if (fileSet.has(norm)) return norm;
    }
    return null;
  }

  if (spec.startsWith('.') && !spec.startsWith('./') && !spec.startsWith('../')) {
    // Python relative import like .utils or ..core
    const dots = spec.match(/^\.+/)[0].length;
    const rest = spec.slice(dots).replace(/\./g, '/');
    const up = '../'.repeat(Math.max(0, dots - 1));
    const joined = path.posix.normalize(path.posix.join(baseDir, up, rest));
    for (const c of [`${joined}.py`, `${joined}/__init__.py`]) {
      const clean = c.replace(/^\/+/, '');
      if (fileSet.has(clean)) return clean;
    }
    return null;
  }

  // Standard relative or root-relative path
  const cleanSpec = spec.replace(/[?#].*$/, '');
  const joined = cleanSpec.startsWith('/')
    ? cleanSpec.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(baseDir, cleanSpec));

  const tryList = [
    joined,
    `${joined}.js`, `${joined}.ts`, `${joined}.jsx`, `${joined}.tsx`, `${joined}.mjs`, `${joined}.cjs`,
    `${joined}.py`, `${joined}.md`, `${joined}.json`, `${joined}.css`,
    `${joined}/index.js`, `${joined}/index.ts`, `${joined}/index.jsx`, `${joined}/index.tsx`,
  ];
  for (const cand of tryList) {
    const c = cand.replace(/^\.\//, '');
    if (fileSet.has(c)) return c;
  }

  // Fallback: basename match for wikilinks like [[COWORK]]
  const lowerTarget = cleanSpec.toLowerCase();
  for (const f of fileSet) {
    const b = path.posix.basename(f).toLowerCase();
    const stem = b.replace(/\.[^.]+$/, '');
    if (b === lowerTarget || stem === lowerTarget) return f;
  }
  return null;
}

async function buildProjectGraph(baseDir = localFiles.getWorkspace(), opts = {}) {
  const root = path.resolve(baseDir);
  const maxFiles = Math.min(800, Number(opts.maxFiles || 420));
  const includePackages = opts.includePackages !== false;
  const startedAt = Date.now();

  const files = [];
  const folderSet = new Set();

  async function walk(dir, depth) {
    if (depth > 7 || files.length >= maxFiles) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const d of entries) {
      if (files.length >= maxFiles) break;
      if (d.name.startsWith('.') && d.name !== '.env.example') continue;
      if (d.isDirectory()) {
        if (IGNORE_DIRS.has(d.name)) continue;
        const full = path.join(dir, d.name);
        const rel = path.relative(root, full).replace(/\\/g, '/');
        folderSet.add(rel);
        await walk(full, depth + 1);
      } else {
        const full = path.join(dir, d.name);
        const rel = path.relative(root, full).replace(/\\/g, '/');
        let st;
        try { st = await fsp.stat(full); } catch { continue; }
        const ext = path.extname(d.name).toLowerCase();
        files.push({
          rel,
          abs: full,
          name: d.name,
          ext,
          size: st.size,
          sizeLabel: localFiles.formatBytes(st.size),
          mtime: st.mtimeMs,
          kind: classifyFile(rel, ext),
          folder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
        });
      }
    }
  }

  await walk(root, 0);

  const fileSet = new Set(files.map((f) => f.rel));
  const nodesMap = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const langCounts = {};

  const addNode = (node) => {
    if (!nodesMap.has(node.id)) nodesMap.set(node.id, node);
  };
  const addEdge = (source, target, type) => {
    if (!source || !target || source === target) return;
    const k = `${source}|${target}|${type}`;
    if (edgeKeys.has(k)) return;
    edgeKeys.add(k);
    edges.push({ source, target, type });
  };

  // Root project node
  const rootName = path.basename(root) || root;
  addNode({
    id: 'dir:.',
    label: rootName,
    kind: 'folder',
    path: '',
    isRoot: true,
    size: 0,
    lines: 0,
    symbols: [],
  });

  // Folder nodes (only folders that contain at least 1 file or child folder)
  for (const folder of [...folderSet].sort()) {
    const id = `dir:${folder}`;
    addNode({
      id,
      label: path.posix.basename(folder),
      kind: 'folder',
      path: folder,
      size: 0,
      lines: 0,
      symbols: [],
    });
    const parent = path.posix.dirname(folder);
    addEdge(parent === '.' ? 'dir:.' : `dir:${parent}`, id, 'contains');
  }

  let totalLines = 0;
  const packageSet = new Set();

  // Analyze each file
  for (const f of files) {
    const fileId = `file:${f.rel}`;
    const langKey = f.ext || '(other)';
    langCounts[langKey] = (langCounts[langKey] || 0) + 1;

    let lines = 0;
    let symbols = [];
    let text = '';

    const readable = f.size <= 512 * 1024 && (
      CODE_EXTS.has(f.ext) || STYLE_EXTS.has(f.ext) || f.ext === '.md' || f.ext === '.markdown' ||
      f.ext === '.json' || f.ext === '.txt' || f.ext === '.yml' || f.ext === '.yaml' || f.ext === '.toml'
    );

    if (readable) {
      try {
        text = await fsp.readFile(f.abs, 'utf8');
        lines = text ? text.split(/\r?\n/).length : 0;
        totalLines += lines;
        symbols = extractSymbols(text, f.ext);
      } catch {}
    }

    addNode({
      id: fileId,
      label: f.name,
      kind: f.kind,
      path: f.rel,
      ext: f.ext,
      folder: f.folder,
      size: f.size,
      sizeLabel: f.sizeLabel,
      lines,
      symbols,
    });

    const parentFolderId = f.folder ? `dir:${f.folder}` : 'dir:.';
    if (nodesMap.has(parentFolderId)) {
      addEdge(parentFolderId, fileId, 'contains');
    }

    if (!text) continue;

    // Extract manifest dependencies
    if (includePackages && f.name === 'package.json') {
      try {
        const pkg = JSON.parse(text);
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        for (const dep of Object.keys(deps).slice(0, 25)) {
          const pid = `pkg:${dep}`;
          packageSet.add(dep);
          addNode({ id: pid, label: dep, kind: 'package', path: '', version: String(deps[dep]), symbols: [] });
          addEdge(fileId, pid, 'depends_on');
        }
      } catch {}
    } else if (includePackages && f.name === 'requirements.txt') {
      for (const line of text.split(/\r?\n/).slice(0, 25)) {
        const m = line.trim().match(/^([A-Za-z0-9._-]+)/);
        if (m && !line.trim().startsWith('#')) {
          const dep = m[1];
          const pid = `pkg:${dep}`;
          packageSet.add(dep);
          addNode({ id: pid, label: dep, kind: 'package', path: '', symbols: [] });
          addEdge(fileId, pid, 'depends_on');
        }
      }
    }

    // Extract imports & doc links
    const refs = extractRawRefs(text, f.ext);
    for (const spec of refs.localSpecs) {
      const targetRel = resolveFileTarget(f.rel, spec, fileSet);
      if (targetRel) addEdge(fileId, `file:${targetRel}`, 'imports');
    }
    for (const link of refs.docLinks) {
      const targetRel = resolveFileTarget(f.rel, link, fileSet);
      if (targetRel) addEdge(fileId, `file:${targetRel}`, 'links_to');
    }
    if (includePackages) {
      for (const dep of refs.externalPkgs.slice(0, 12)) {
        if (packageSet.has(dep)) {
          addEdge(fileId, `pkg:${dep}`, 'depends_on');
        }
      }
    }
  }

  // Compute node degree & hub scores (prioritizing semantic imports/links over folder containment)
  const inDeg = new Map();
  const outDeg = new Map();
  const semEdges = [];
  for (const e of edges) {
    outDeg.set(e.source, (outDeg.get(e.source) || 0) + 1);
    inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
    if (e.type === 'imports' || e.type === 'links_to') semEdges.push(e);
  }

  // Detect 2-node circular imports
  const semSet = new Set(semEdges.map((e) => `${e.source}->${e.target}`));
  const circular = [];
  for (const e of semEdges) {
    if (semSet.has(`${e.target}->${e.source}`) && e.source < e.target) {
      circular.push([e.source.replace(/^file:/, ''), e.target.replace(/^file:/, '')]);
    }
  }

  const nodes = [...nodesMap.values()].map((n) => {
    const ind = inDeg.get(n.id) || 0;
    const outd = outDeg.get(n.id) || 0;
    return {
      ...n,
      inDegree: ind,
      outDegree: outd,
      degree: ind + outd,
    };
  });

  const fileNodes = nodes.filter((n) => n.id.startsWith('file:'));
  const topHubs = [...fileNodes]
    .sort((a, b) => (b.inDegree * 2 + b.outDegree) - (a.inDegree * 2 + a.outDegree) || (b.lines - a.lines))
    .slice(0, 10)
    .map((n) => ({
      id: n.id,
      path: n.path,
      label: n.label,
      kind: n.kind,
      inDegree: n.inDegree,
      outDegree: n.outDegree,
      lines: n.lines,
    }));

  const topLanguages = Object.entries(langCounts)
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    workspace: root,
    projectName: rootName,
    builtAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      fileCount: fileNodes.length,
      folderCount: nodes.filter((n) => n.kind === 'folder').length,
      packageCount: nodes.filter((n) => n.kind === 'package').length,
      importEdges: semEdges.length,
      totalLines,
      circularCount: circular.length,
    },
    topHubs,
    circular,
    topLanguages,
    nodes,
    edges,
  };
}

function summarizeGraphForAI(graph) {
  if (!graph || !graph.stats) return '';
  const lines = [
    `Project Knowledge Graph: ${graph.projectName} (${graph.workspace})`,
    `Stats: ${graph.stats.fileCount} files, ${graph.stats.folderCount} folders, ${graph.stats.packageCount} packages, ${graph.stats.importEdges} import/link edges, ${graph.stats.totalLines} lines of code.`,
    `Languages: ${(graph.topLanguages || []).map((l) => `${l.ext} (${l.count})`).join(', ')}`,
  ];
  if (graph.topHubs?.length) {
    lines.push('Core Hub Files (most connected):');
    for (const h of graph.topHubs.slice(0, 8)) {
      lines.push(`  - ${h.path} [${h.kind}, ${h.lines} lines, ${h.inDegree} incoming, ${h.outDegree} outgoing]`);
    }
  }
  const importList = (graph.edges || [])
    .filter((e) => e.type === 'imports' || e.type === 'links_to')
    .slice(0, 35)
    .map((e) => `  ${e.source.replace(/^file:/, '')} -> ${e.target.replace(/^file:/, '')}`);
  if (importList.length) {
    lines.push('Key Dependency Edges:\n' + importList.join('\n'));
  }
  if (graph.aiSummary) {
    lines.push(`AI Summary (Fast Model): ${graph.aiSummary}`);
  }
  if (graph.aiClusters?.length) {
    lines.push('Architectural Clusters:\n' + graph.aiClusters.map((c) => `  - ${c.name}: ${c.description} [${(c.files || []).slice(0, 6).join(', ')}]`).join('\n'));
  }
  if (graph.circular?.length) {
    lines.push('Circular Imports: ' + graph.circular.map((p) => `${p[0]} <-> ${p[1]}`).join(', '));
  }
  return lines.join('\n');
}

function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cand = fenced ? fenced[1].trim() : raw;
  const s = cand.indexOf('{');
  const e = cand.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(cand.slice(s, e + 1)); } catch {}
  }
  return null;
}

/**
 * Enrich a structural project graph using the configured FAST model (e.g. lfm3:latest)
 * to infer architectural clusters, per-file roles, conceptual cross-file links,
 * and a concise project summary, then persist to the project's graph cache.
 */
async function mapProjectWithFastModel({ projectId = '', workspace = '', useFastModel = true, onProgress } = {}) {
  const proj = projectId ? storage.getProject(projectId) : storage.getActiveProject();
  const targetDir = path.resolve(workspace || proj?.path || localFiles.getWorkspace());

  onProgress?.({ phase: 'scanning', message: `Scanning ${path.basename(targetDir)}…` });
  const graph = await buildProjectGraph(targetDir, { includePackages: true });
  graph.projectId = proj?.id || '';

  if (proj) {
    storage.saveProjectGraphCache(proj.id, graph);
    storage.saveProject({
      ...proj,
      lastGraphAt: graph.builtAt,
      graphStats: graph.stats,
    });
  }

  if (!useFastModel || !graph.stats.fileCount) {
    return graph;
  }

  const cfg = storage.getSettings();
  const fastModel = cfg.graphMapperModel || cfg.fastModel || 'lfm3:latest';
  onProgress?.({ phase: 'mapping', message: `Mapping semantics with Fast model (${fastModel.replace(/:latest$/, '')})…` });

  // Build ultra-compact digest so the Fast model responds in ~1-3 seconds
  const fileNodes = graph.nodes.filter((n) => n.id.startsWith('file:'));
  const topFiles = [...fileNodes]
    .sort((a, b) => (b.inDegree * 2 + b.outDegree) - (a.inDegree * 2 + a.outDegree) || (b.lines - a.lines))
    .slice(0, 22);

  const digestLines = [
    `Project: ${graph.projectName} (${graph.stats.fileCount} files, ${graph.stats.totalLines} lines)`,
    `Languages: ${(graph.topLanguages || []).map((l) => `${l.ext}:${l.count}`).join(', ')}`,
    `Top Files & Symbols:`,
    ...topFiles.map((n) => {
      const syms = (n.symbols || []).slice(0, 5).map((s) => s.name).join(', ');
      return `  - ${n.path} [${n.kind}, ${n.lines}L]${syms ? ` :: ${syms}` : ''}`;
    }),
    `Static Links:`,
    ...(graph.edges || [])
      .filter((e) => e.type === 'imports' || e.type === 'links_to')
      .slice(0, 24)
      .map((e) => `  ${e.source.replace(/^file:/, '')} -> ${e.target.replace(/^file:/, '')}`),
  ];

  const sys = `You are a fast codebase mapper building a Project Knowledge Graph.
Return ONLY valid JSON with this exact shape:
{
  "summary": "2 concise sentences explaining what this project does and how it is structured.",
  "clusters": [
    { "name": "Cluster Name", "description": "Short 8-word purpose", "files": ["rel/path1", "rel/path2"] }
  ],
  "roles": {
    "rel/path1": "Short 6-10 word role of this file"
  },
  "links": [
    { "from": "rel/pathA", "to": "rel/pathB", "label": "2-3 word relation" }
  ]
}
Rules: max 5 clusters, max 16 file roles, max 10 conceptual links. Use exact relative paths from the input.`;

  try {
    const res = await endpoint.chatCompletion({
      tier: 'fast',
      model: fastModel,
      systemPrompt: sys,
      messages: [{ role: 'user', content: digestLines.join('\n') }],
      think: 'off',
      priority: 'fast',
    });

    storage.recordUsage({
      model: res.model || fastModel,
      role: 'graph',
      promptTokens: res.usage?.promptTokens || Math.round(digestLines.join('\n').length / 4),
      evalTokens: res.usage?.evalTokens || Math.round((res.content || '').length / 4),
      elapsedMs: res.elapsedMs || 0,
      tokensPerSec: res.usage?.tokensPerSec || 0,
    });

    const parsed = parseJsonLoose(res.content);
    if (parsed && typeof parsed === 'object') {
      graph.aiSummary = String(parsed.summary || '').trim();
      graph.aiClusters = Array.isArray(parsed.clusters)
        ? parsed.clusters.slice(0, 6).map((c) => ({
            name: String(c.name || 'Module').slice(0, 40),
            description: String(c.description || '').slice(0, 120),
            files: Array.isArray(c.files) ? c.files.map(String) : [],
          }))
        : [];
      graph.mappedByModel = res.model || fastModel;
      graph.mappedAt = Date.now();
      graph.mappedMs = res.elapsedMs || 0;

      // Apply per-file AI roles & cluster tags
      const rolesMap = (parsed.roles && typeof parsed.roles === 'object') ? parsed.roles : {};
      const clusterByPath = new Map();
      for (const c of graph.aiClusters) {
        for (const f of c.files) clusterByPath.set(f, c.name);
      }

      const fileIdByPath = new Map();
      for (const n of graph.nodes) {
        if (!n.path) continue;
        fileIdByPath.set(n.path, n.id);
        if (rolesMap[n.path]) n.aiRole = String(rolesMap[n.path]).slice(0, 140);
        if (clusterByPath.has(n.path)) n.cluster = clusterByPath.get(n.path);
      }

      // Add conceptual semantic links returned by the Fast model
      if (Array.isArray(parsed.links)) {
        const existingKeys = new Set(graph.edges.map((e) => `${e.source}|${e.target}`));
        for (const l of parsed.links.slice(0, 12)) {
          const src = fileIdByPath.get(String(l.from || ''));
          const dst = fileIdByPath.get(String(l.to || ''));
          if (src && dst && src !== dst && !existingKeys.has(`${src}|${dst}`)) {
            existingKeys.add(`${src}|${dst}`);
            graph.edges.push({
              source: src,
              target: dst,
              type: 'semantic',
              label: String(l.label || 'related').slice(0, 32),
            });
          }
        }
        graph.stats.totalEdges = graph.edges.length;
        graph.stats.semanticEdges = graph.edges.filter((e) => e.type === 'semantic').length;
      }

      if (proj) {
        storage.saveProjectGraphCache(proj.id, graph);
        storage.saveProject({
          ...proj,
          lastGraphAt: graph.mappedAt,
          graphStats: graph.stats,
          aiSummary: graph.aiSummary,
        });
      }
    }
  } catch (err) {
    graph.aiError = err.message || 'Fast model mapping skipped';
  }

  onProgress?.({ phase: 'done', message: `Mapped ${graph.stats.fileCount} files` });
  return graph;
}

module.exports = {
  buildProjectGraph,
  mapProjectWithFastModel,
  summarizeGraphForAI,
};
