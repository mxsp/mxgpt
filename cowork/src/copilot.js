'use strict';

/**
 * mx-Cowork 4-Mode Local Copilot Engine:
 *   - fast:      Direct Fast model (lfm3:latest)
 *   - smart:     Direct Smart model (inkling-2-mini:latest)
 *   - copilot:   Smart model orchestrates & synthesizes; delegates retrieval/tools to Fast workers
 *   - copilot_b: Copilot (B) using nemotron-3.5-lightning (configurable) as orchestrator + Fast workers
 *
 * Strictly obeys per-tool Settings (Web Search, OS Files, Container, Knowledge Graph,
 * Git Inspector, System Info, JS Calculator, Persistent Memory Notes).
 */

const endpoint = require('./endpoint');
const localFiles = require('./local-files');
const research = require('./research');
const storage = require('./storage');
const knowledgeGraph = require('./knowledge-graph');
const containerRunner = require('./container-runner');
const localTools = require('./local-tools');

const ROLE_META = {
  web_research: { role: 'researcher', label: 'Web Search' },
  web_fetch: { role: 'researcher', label: 'Page Reader' },
  file_search: { role: 'files', label: 'OS File Search' },
  file_read: { role: 'reader', label: 'Doc Reader' },
  folder_audit: { role: 'organizer', label: 'Folder Audit' },
  project_graph: { role: 'analyst', label: 'Knowledge Graph' },
  git_inspect: { role: 'coder', label: 'Git Inspector' },
  system_info: { role: 'analyst', label: 'System Info' },
  calc_js: { role: 'coder', label: 'JS Evaluator' },
  memory_recall: { role: 'summarizer', label: 'Memory Recall' },
  fast_extract: { role: 'analyst', label: 'Fast Analyst' },
};

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  return null;
}

function extractSpecialBlocks(markdown, toolsCfg) {
  let fileActions = [];
  let codeRuns = [];
  let savedNotes = [];
  const text = String(markdown || '');
  const cfg = storage.getSettings();

  if (toolsCfg.osFiles) {
    const actionsMatch = text.match(/```file-actions\s*\n([\s\S]*?)```/i);
    if (actionsMatch) {
      try {
        const arr = JSON.parse(actionsMatch[1].trim());
        if (Array.isArray(arr)) {
          fileActions = arr
            .filter((a) => a && a.type && ['mkdir', 'write', 'create', 'move', 'rename', 'copy', 'delete'].includes(String(a.type).toLowerCase()))
            .slice(0, 30)
            .map((a, i) => ({
              id: `act_${Date.now().toString(36)}_${i}`,
              type: String(a.type).toLowerCase(),
              path: a.path ? String(a.path) : '',
              from: a.from ? String(a.from) : '',
              to: a.to ? String(a.to) : '',
              content: typeof a.content === 'string' ? a.content : undefined,
              reason: String(a.reason || '').slice(0, 180),
              status: 'pending',
            }));
        }
      } catch {}
    }
  }

  if (toolsCfg.container) {
    for (const m of text.matchAll(/```code-run\s*\n([\s\S]*?)```/gi)) {
      try {
        const parsed = JSON.parse(m[1].trim());
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (!item || (!item.code && !item.command)) continue;
          const lang = String(item.language || (item.command ? 'bash' : 'python')).toLowerCase();
          codeRuns.push({
            id: `run_${Date.now().toString(36)}_${codeRuns.length}`,
            title: String(item.title || `Run ${lang} in container`).slice(0, 100),
            language: lang,
            image: String(item.image || containerRunner.defaultImageForLanguage(lang, cfg.containerImage)),
            code: typeof item.code === 'string' ? item.code : '',
            command: typeof item.command === 'string' ? item.command : '',
            network: item.network === 'bridge' ? 'bridge' : (cfg.containerNetwork || 'none'),
            mountMode: item.mountMode === 'ro' ? 'ro' : (cfg.containerMountMode || 'rw'),
            reason: String(item.reason || '').slice(0, 180),
            status: 'pending',
            output: '',
          });
        }
      } catch {}
    }
  }

  if (toolsCfg.notes) {
    for (const m of text.matchAll(/```memory-save\s*\n([\s\S]*?)```/gi)) {
      try {
        const parsed = JSON.parse(m[1].trim());
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item && (item.title || item.content)) {
            savedNotes.push({
              title: String(item.title || 'Saved note').slice(0, 120),
              content: String(item.content || '').trim(),
              tags: item.tags || [],
            });
          }
        }
      } catch {}
    }
  }

  return { fileActions, codeRuns: codeRuns.slice(0, 8), savedNotes: savedNotes.slice(0, 5) };
}

function resolveEnabledTools(cfg, overrides = {}) {
  return {
    webSearch: overrides.toolWebSearch !== undefined ? Boolean(overrides.toolWebSearch) : cfg.toolWebSearch !== false,
    webFetchPages: cfg.toolWebFetchPages !== false,
    webMaxResults: Math.max(2, Math.min(10, Number(cfg.toolWebMaxResults || 5))),
    wikiLang: cfg.toolWikiLang || 'en',
    osFiles: overrides.toolOsFiles !== undefined ? Boolean(overrides.toolOsFiles) : cfg.toolOsFiles !== false,
    container: overrides.toolContainer !== undefined
      ? Boolean(overrides.toolContainer)
      : (cfg.toolContainer !== false && cfg.containerEnabled !== false),
    knowledgeGraph: cfg.toolKnowledgeGraph !== false,
    git: cfg.toolGit !== false,
    system: cfg.toolSystem !== false,
    calculator: cfg.toolCalculator !== false,
    notes: cfg.toolNotes !== false,
  };
}

function allowedTaskTypes(t) {
  const types = [];
  if (t.webSearch) types.push('web_research', 'web_fetch');
  if (t.osFiles) types.push('file_search', 'file_read', 'folder_audit');
  if (t.knowledgeGraph) types.push('project_graph');
  if (t.git) types.push('git_inspect');
  if (t.system) types.push('system_info');
  if (t.calculator) types.push('calc_js');
  if (t.notes) types.push('memory_recall');
  return types;
}

function heuristicPlan(userPrompt, pinnedFiles = [], toolsCfg) {
  const text = String(userPrompt || '').trim();
  const tasks = [];
  let outputType = 'answer';

  if (/^(hi|hey|hello|hallo|moin|thanks|thank you|danke|ok)\b[\s!?.]*$/i.test(text)) {
    return { goal: 'Quick reply', direct: true, outputType: 'answer', tasks: [] };
  }

  const urlMatch = text.match(/https?:\/\/[^\s)>"']+/i);
  const wantsOrganize = /\b(organize|sort|clean ?up|rename|move|group|categorize|aufräumen|sortieren|umbenennen|verschieben|create (a )?file|edit .*file|save (to|as) file)\b/i.test(text);
  const wantsGraph = /\b(knowledge graph|map (this |my |the )?project|project map|architecture|dependency|dependencies|how .* files? connect|graph|module map|codebase map)\b/i.test(text);
  const wantsGit = /\b(git|commit|branch|diff|status|repo history|recent changes|pull request|changelog)\b/i.test(text);
  const wantsSys = /\b(system info|cpu|ram|memory|disk space|what (tools|runtimes|versions)|installed on my (computer|machine|pc))\b/i.test(text);
  const wantsNotes = /\b(my notes|remember|recall|saved memory|what did i save|note about)\b/i.test(text);
  const wantsWeb = /\b(research|search (the )?web|look ?up|latest|news|current|compare|market|competitor|trend|202[5-9]|wiki|recherchier|aktuell)\b/i.test(text);
  const wantsFiles = /\b(file|files|folder|document|pdf|docx|notes|contract|invoice|report|workspace|directory|find in|search my|datei|ordner|dokument)\b/i.test(text);

  if (wantsOrganize) outputType = 'file_ops';
  else if (wantsWeb || urlMatch) outputType = 'research';

  if (toolsCfg.osFiles) {
    for (const pf of pinnedFiles.slice(0, 2)) {
      tasks.push({ type: 'file_read', path: pf, focus: text.slice(0, 160) });
    }
  }
  if (toolsCfg.webSearch && urlMatch) {
    tasks.push({ type: 'web_fetch', query: urlMatch[0], focus: text.slice(0, 160) });
  } else if (toolsCfg.webSearch && wantsWeb) {
    tasks.push({ type: 'web_research', query: text.slice(0, 160), focus: text.slice(0, 160) });
  }
  if (toolsCfg.knowledgeGraph && wantsGraph) {
    tasks.push({ type: 'project_graph', path: '', focus: text.slice(0, 160) });
  }
  if (toolsCfg.git && wantsGit) {
    tasks.push({ type: 'git_inspect', path: '', focus: text.slice(0, 160) });
  }
  if (toolsCfg.system && wantsSys) {
    tasks.push({ type: 'system_info', query: '', focus: text.slice(0, 160) });
  }
  if (toolsCfg.notes && wantsNotes) {
    tasks.push({ type: 'memory_recall', query: text.slice(0, 100), focus: text.slice(0, 160) });
  }
  if (toolsCfg.osFiles && wantsOrganize) {
    tasks.push({ type: 'folder_audit', path: '', focus: text.slice(0, 160) });
  } else if (toolsCfg.osFiles && wantsFiles && !pinnedFiles.length && !wantsGraph) {
    const q = text.replace(/\b(find|search|look|for|my|in|the|files|folder|documents|workspace|please|can you|summarize)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    tasks.push({ type: 'file_search', query: q.slice(0, 80) || text.slice(0, 60), path: '', focus: text.slice(0, 160) });
  }

  return {
    goal: text.slice(0, 100),
    direct: tasks.length === 0,
    outputType,
    tasks: tasks.slice(0, 4),
  };
}

async function runDelegatedWorker(task, { workspace, fastModel, toolsCfg, signal, onEvent }) {
  const id = storage.newId('wrk');
  const meta = ROLE_META[task.type] || ROLE_META.fast_extract;
  const startedAt = Date.now();
  const title = task.query || task.path || task.focus || meta.label;

  onEvent('worker_start', {
    id,
    type: task.type,
    role: meta.role,
    label: meta.label,
    model: fastModel,
    task: String(title).slice(0, 200),
    startedAt,
  });

  const citations = [];
  let rawEvidence = '';
  let localSummary = '';

  try {
    if (task.type === 'web_research') {
      const q = String(task.query || task.focus || '').trim();
      const [ddg, wiki] = await Promise.all([
        research.webSearch(q, toolsCfg.webMaxResults).catch(() => []),
        research.wikiLookup(q, toolsCfg.wikiLang).catch(() => null),
      ]);
      const pages = [];
      if (toolsCfg.webFetchPages) {
        for (const hit of ddg.slice(0, 2)) {
          try {
            const p = await research.fetchPageText(hit.url, 4500);
            pages.push(p);
          } catch {}
        }
      }
      for (const hit of ddg) citations.push({ type: 'url', title: hit.title, url: hit.url });
      if (wiki) citations.push({ type: 'url', title: `Wikipedia: ${wiki.title}`, url: wiki.url });

      const parts = [];
      if (wiki) parts.push(`[Wikipedia: ${wiki.title} (${wiki.url})]\n${wiki.extract}`);
      if (ddg.length) {
        parts.push('[Search Results]\n' + ddg.map((h, i) => `${i + 1}. ${h.title} (${h.url})\n   ${h.snippet}`).join('\n'));
      }
      for (const p of pages) {
        parts.push(`[Page: ${p.title} (${p.url})]\n${p.text}`);
      }
      rawEvidence = parts.join('\n\n').slice(0, 14000);
      localSummary = `${ddg.length} web results, ${pages.length} pages read`;
    } else if (task.type === 'web_fetch') {
      const url = String(task.query || task.path || '').trim();
      const page = await research.fetchPageText(url, 12000);
      citations.push({ type: 'url', title: page.title || url, url: page.url || url });
      rawEvidence = `[Web Page: ${page.title} (${page.url})]\n${page.text}`;
      localSummary = `Fetched ${page.title || url}`;
    } else if (task.type === 'file_search') {
      const res = await localFiles.searchFiles({ query: task.query || '', relPath: task.path || '', maxResults: 12 }, workspace);
      const topFiles = res.results.slice(0, 4);
      const parts = [`Workspace: ${res.workspace} (scanned ${res.scanned} files, ${res.results.length} matches)`];
      for (const hit of res.results) {
        citations.push({ type: 'file', title: hit.relPath, path: hit.relPath });
        parts.push(`- ${hit.relPath} (${hit.sizeLabel})${hit.snippet ? ` — "${hit.snippet}"` : ''}`);
      }
      for (const hit of topFiles.slice(0, 2)) {
        try {
          const full = localFiles.resolveSafe(hit.relPath, workspace).abs;
          const txt = await localFiles.readTextContent(full, 4000);
          parts.push(`\n[Excerpt of ${hit.relPath}]\n${txt}`);
        } catch {}
      }
      rawEvidence = parts.join('\n').slice(0, 14000);
      localSummary = `${res.results.length} matches across ${res.scanned} files`;
    } else if (task.type === 'file_read') {
      const target = localFiles.resolveSafe(task.path || '', workspace);
      const txt = await localFiles.readTextContent(target.abs, 14000);
      citations.push({ type: 'file', title: target.rel, path: target.rel });
      rawEvidence = `[File: ${target.rel}]\n${txt}`;
      localSummary = `Read ${target.rel} (${txt.length} chars)`;
    } else if (task.type === 'project_graph') {
      const graph = await knowledgeGraph.buildProjectGraph(workspace);
      rawEvidence = knowledgeGraph.summarizeGraphForAI(graph).slice(0, 14000);
      localSummary = `Mapped ${graph.stats.fileCount} files, ${graph.stats.importEdges} links, ${graph.stats.packageCount} pkgs`;
      for (const h of (graph.topHubs || []).slice(0, 5)) {
        citations.push({ type: 'file', title: h.path, path: h.path });
      }
      onEvent('graph_ready', { stats: graph.stats, projectName: graph.projectName });
    } else if (task.type === 'folder_audit') {
      const ov = await localFiles.folderOverview(task.path || '', workspace);
      const dirList = await localFiles.listDir(task.path || '', workspace);
      const lines = [
        `Folder: ${ov.workspace}${ov.path ? '/' + ov.path : ''}`,
        `Total files: ${ov.totalFiles} (${ov.totalSizeLabel})`,
        `Subfolders: ${ov.topDirs.join(', ') || '(none)'}`,
        `By extension: ${ov.byExtension.map((e) => `${e.ext}: ${e.count} (${e.sizeLabel})`).join(', ')}`,
        'Top-level items:\n' + dirList.items.slice(0, 60).map((it) => `  ${it.isDir ? '[DIR]' : '[FILE]'} ${it.relPath} ${it.sizeLabel}`).join('\n'),
        'Recent files:\n' + ov.recent.slice(0, 15).map((f) => `  ${f.relPath} (${f.sizeLabel})`).join('\n'),
      ];
      rawEvidence = lines.join('\n').slice(0, 14000);
      localSummary = `Audited ${ov.totalFiles} files (${ov.totalSizeLabel})`;
    } else if (task.type === 'git_inspect') {
      const g = await localTools.gitInspect(workspace, task.focus || task.query || '');
      rawEvidence = g.text.slice(0, 14000);
      localSummary = g.isRepo ? `Git branch ${g.branch || 'HEAD'}` : 'Not a Git repo';
    } else if (task.type === 'system_info') {
      const si = await localTools.systemInfo(workspace);
      rawEvidence = si.text;
      localSummary = `${si.platform} · ${si.runtimes.length} runtimes`;
    } else if (task.type === 'calc_js') {
      const c = localTools.evalSandboxedJs(task.query || task.focus || '');
      rawEvidence = c.text;
      localSummary = 'Evaluated JS expression';
    } else if (task.type === 'memory_recall') {
      const mem = localTools.recallNotes(task.query || '');
      rawEvidence = mem.text;
      localSummary = `${mem.notes.length} memory notes found`;
    } else {
      rawEvidence = String(task.focus || task.query || '');
      localSummary = 'Direct fast analysis';
    }

    if (!rawEvidence.trim()) {
      const emptyBrief = 'No matching data was found for this subtask.';
      onEvent('worker_done', {
        id, ok: true, elapsedMs: Date.now() - startedAt, tokensPerSec: 0, summary: localSummary, brief: emptyBrief, citations,
      });
      return { id, label: meta.label, role: meta.role, task: title, brief: emptyBrief, citations };
    }

    // Compact structured tool results pass directly to Orchestrator without extra latency
    const directPassTypes = new Set(['file_read', 'file_search', 'project_graph', 'git_inspect', 'system_info', 'calc_js', 'memory_recall']);
    if (rawEvidence.length <= 2600 && directPassTypes.has(task.type)) {
      const elapsedMs = Date.now() - startedAt;
      onEvent('worker_done', {
        id, ok: true, elapsedMs, tokensPerSec: 0, summary: `${localSummary} (direct)`, brief: rawEvidence, citations,
      });
      return { id, label: meta.label, role: meta.role, task: title, brief: rawEvidence, citations, elapsedMs };
    }

    // Heavy raw documents/web pages -> Fast worker distillation (~27 t/s)
    const distillSys = `You are a fast retrieval & extraction worker feeding a senior Copilot orchestrator.
Distill the raw source data into a tight, factual, high-signal bullet brief (max 220 words).
- Preserve exact filenames, paths, numbers, dates, names, and URLs.
- Omit fluff, ads, and speculation.`;

    const fastRes = await endpoint.chatCompletion({
      tier: 'fast',
      model: fastModel,
      systemPrompt: distillSys,
      messages: [
        { role: 'user', content: `Focus: ${task.focus || task.query || task.path}\n\nRaw Retrieved Data:\n${rawEvidence}` },
      ],
      think: 'off',
      priority: 'subagent',
      signal,
      onEvent: (ev) => {
        if (ev.type === 'text' && ev.delta) onEvent('worker_delta', { id, delta: ev.delta });
        else if (ev.type === 'queue') onEvent('queue', ev);
      },
    });

    const elapsedMs = Date.now() - startedAt;
    onEvent('worker_done', {
      id,
      ok: true,
      elapsedMs,
      tokensPerSec: fastRes.usage?.tokensPerSec || 0,
      evalTokens: fastRes.usage?.evalTokens || 0,
      summary: localSummary,
      brief: fastRes.content,
      citations,
    });

    return {
      id,
      label: meta.label,
      role: meta.role,
      task: title,
      brief: fastRes.content,
      citations,
      elapsedMs,
      tokensPerSec: fastRes.usage?.tokensPerSec || 0,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    onEvent('worker_done', {
      id, ok: false, elapsedMs, error: err.message, summary: localSummary, citations,
    });
    return {
      id, label: meta.label, role: meta.role, task: title, brief: `Worker error: ${err.message}`, citations, error: err.message,
    };
  }
}

async function runCoworkTurn({
  mode = 'copilot', // 'fast' | 'smart' | 'copilot' | 'copilot_b'
  prompt = '',
  history = [],
  pinnedFiles = [],
  toolOverrides = {},
  think = 'low',
  signal,
  onEvent,
}) {
  const cfg = storage.getSettings();
  const toolsCfg = resolveEnabledTools(cfg, toolOverrides);
  const workspace = localFiles.getWorkspace();
  const today = new Date().toISOString().slice(0, 10);

  const fileActionsHint = toolsCfg.osFiles
    ? `If proposing local OS file edits/creates/moves/renames/deletes, include a \`\`\`file-actions JSON array: [{"type":"mkdir"|"write"|"move"|"rename"|"copy"|"delete","path":"...","from":"...","to":"...","content":"...","reason":"..."}].`
    : '';
  const codeRunHint = toolsCfg.container
    ? `Container execution is ENABLED (isolated Docker/Podman container mounted at /workspace; default image ${cfg.containerImage || 'python:3.12-slim'}). When executing Python, Node.js, or Shell code on the workspace helps verify, test, compute, or automate, include a \`\`\`code-run JSON block: {"title":"short label","language":"python"|"javascript"|"bash","image":"python:3.12-slim","code":"...","reason":"why"}.`
    : '';
  const memoryHint = toolsCfg.notes
    ? `If the user explicitly asks you to remember a preference, fact, or project note for future sessions, include a \`\`\`memory-save JSON block: {"title":"short title","content":"fact to remember","tags":["tag"]}.`
    : '';

  // ---- Direct Fast or Smart modes
  if (mode === 'fast' || mode === 'smart') {
    const chosenModel = mode === 'fast' ? cfg.fastModel : cfg.smartModel;
    onEvent('phase', { phase: 'preparing', label: `${mode === 'fast' ? 'Fast' : 'Smart'} · ${chosenModel.replace(/:latest$/, '')}` });
    const ctxParts = [];
    if (toolsCfg.osFiles) {
      for (const rel of (pinnedFiles || []).slice(0, 3)) {
        try {
          const abs = localFiles.resolveSafe(rel, workspace).abs;
          const txt = await localFiles.readTextContent(abs, 5000);
          ctxParts.push(`[Pinned file: ${rel}]\n${txt}`);
        } catch {}
      }
    }

    const sys = [
      `You are mx-Cowork, a local desktop AI copilot. Today: ${today}. Workspace: ${workspace}.`,
      `Be crisp, structured, and actionable. Use Markdown.`,
      fileActionsHint,
      codeRunHint,
      memoryHint,
    ].filter(Boolean).join('\n');

    const userContent = ctxParts.length ? `${ctxParts.join('\n\n')}\n\nUser request:\n${prompt}` : prompt;
    const msgs = [
      ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userContent },
    ];

    const res = await endpoint.chatCompletion({
      tier: mode,
      model: chosenModel,
      systemPrompt: sys,
      messages: msgs,
      think: mode === 'fast' ? 'off' : think,
      priority: mode,
      signal,
      onEvent: (ev) => {
        if (ev.type === 'queue') onEvent('queue', ev);
        else if (ev.type === 'thinking') onEvent('thinking', { delta: ev.delta });
        else if (ev.type === 'text') onEvent('text', { delta: ev.delta });
      },
    });

    const { fileActions, codeRuns, savedNotes } = extractSpecialBlocks(res.content, toolsCfg);
    if (fileActions.length) onEvent('file_actions', fileActions);
    if (codeRuns.length) onEvent('code_runs', codeRuns);

    return {
      content: res.content,
      thinking: res.thinking,
      model: res.model,
      mode,
      usage: res.usage,
      plan: null,
      workers: [],
      sources: [],
      fileActions,
      codeRuns,
      savedNotes,
    };
  }

  // ---- COPILOT (Smart) or COPILOT (B) (nemotron-3.5-lightning) Orchestrator -> Fast Workers -> Synthesis
  const isCopilotB = mode === 'copilot_b';
  const orchestratorModel = isCopilotB
    ? (cfg.copilotBModel || 'nemotron-3.5-lightning')
    : (cfg.smartModel || 'inkling-2-mini:latest');
  const orchestratorLabel = isCopilotB
    ? `Copilot (B) · ${orchestratorModel.replace(/:latest$/, '')}`
    : `Copilot · ${orchestratorModel.replace(/:latest$/, '')}`;

  onEvent('phase', { phase: 'planning', label: `${orchestratorLabel} planning…` });

  let wsSnapshot = '';
  if (toolsCfg.osFiles) {
    try {
      const ls = await localFiles.listDir('', workspace);
      wsSnapshot = ls.items.slice(0, 30).map((it) => (it.isDir ? `${it.name}/` : it.name)).join(', ');
    } catch {}
  }

  const allowedTypes = allowedTaskTypes(toolsCfg);
  const trivial = /^(hi|hey|hello|hallo|moin|thanks|thank you|danke|ok|test)\b[\s!?.]*$/i.test(prompt.trim());
  let plan = null;

  if (trivial || !allowedTypes.length) {
    plan = { goal: 'Direct response', direct: true, outputType: 'answer', tasks: [] };
  } else {
    const plannerSys = `You are the Orchestrator of mx-Cowork (${orchestratorLabel}). Decide which local tools & fast workers to invoke before synthesizing your final answer.
Enabled task types ONLY: ${allowedTypes.join(', ')}
Return ONLY valid JSON:
{
  "goal": "brief 1-line objective",
  "direct": false,
  "outputType": "answer" | "research" | "file_ops",
  "tasks": [
    { "type": "<one of enabled types>", "query": "...", "path": "...", "focus": "what to extract" }
  ]
}
Rules:
- Set "direct": true and "tasks": [] ONLY if no tools/files/web/git/graph/system inspection are needed.
- Max 3 tasks. Use ONLY enabled task types.
- Use "project_graph" for project mapping/architecture/dependencies, "git_inspect" for git status/commits/diffs, "system_info" for OS/hardware/installed runtimes, "calc_js" for exact math/data computation, "web_fetch" when a URL is provided, "memory_recall" for saved user notes.`;

    const plannerPrompt = [
      `Today: ${today}`,
      `Workspace: ${workspace}`,
      wsSnapshot ? `Top-level items: ${wsSnapshot}` : '',
      pinnedFiles?.length ? `Pinned files: ${pinnedFiles.join(', ')}` : '',
      `User request: ${prompt}`,
    ].filter(Boolean).join('\n');

    try {
      const planRes = await endpoint.chatCompletion({
        tier: 'smart',
        model: orchestratorModel,
        systemPrompt: plannerSys,
        messages: [{ role: 'user', content: plannerPrompt }],
        think: 'off',
        priority: 'smart',
        signal,
        onEvent: (ev) => {
          if (ev.type === 'queue') onEvent('queue', ev);
        },
      });
      const parsed = extractJsonObject(planRes.content);
      if (parsed && typeof parsed === 'object') {
        const validTasks = Array.isArray(parsed.tasks)
          ? parsed.tasks
              .filter((t) => t && allowedTypes.includes(t.type))
              .slice(0, 4)
          : [];
        plan = {
          goal: String(parsed.goal || prompt.slice(0, 90)),
          direct: Boolean(parsed.direct) && validTasks.length === 0,
          outputType: ['answer', 'research', 'file_ops'].includes(parsed.outputType) ? parsed.outputType : 'answer',
          tasks: validTasks,
          plannerModel: planRes.model,
          plannerMs: planRes.elapsedMs,
        };
      }
    } catch (e) {
      if (signal?.aborted) throw e;
    }

    if (!plan) {
      plan = heuristicPlan(prompt, pinnedFiles, toolsCfg);
    }
    if (toolsCfg.osFiles) {
      for (const pf of (pinnedFiles || []).slice(0, 2)) {
        if (!plan.tasks.some((t) => t.type === 'file_read' && t.path === pf)) {
          plan.tasks.unshift({ type: 'file_read', path: pf, focus: prompt.slice(0, 140) });
          plan.direct = false;
        }
      }
    }
    plan.tasks = plan.tasks.slice(0, 4);
  }

  onEvent('copilot_plan', plan);

  // Stage 2: Execute delegated local tools & fast workers
  const workerResults = [];
  const allSources = [];
  const seenSrc = new Set();

  if (plan.tasks.length) {
    onEvent('phase', { phase: 'delegating', label: `Running ${plan.tasks.length} tool/worker task${plan.tasks.length > 1 ? 's' : ''}…` });
    for (const t of plan.tasks) {
      if (signal?.aborted) break;
      const r = await runDelegatedWorker(t, {
        workspace,
        fastModel: cfg.fastModel,
        toolsCfg,
        signal,
        onEvent,
      });
      workerResults.push(r);
      for (const c of r.citations || []) {
        const k = c.url || c.path || c.title;
        if (k && !seenSrc.has(k)) {
          seenSrc.add(k);
          allSources.push(c);
        }
      }
    }
  }

  if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

  // Stage 3: Orchestrator synthesizes final response + action cards
  onEvent('phase', { phase: 'synthesizing', label: `${orchestratorLabel} synthesizing…` });

  const synthSys = [
    `You are mx-Cowork's ${orchestratorLabel} Orchestrator. Today: ${today}. Workspace: ${workspace}.`,
    `Your local tools and fast worker models retrieved the evidence below. Synthesize a crisp, deeply helpful, accurate response using Markdown.`,
    `Cite web sources as Markdown links and reference local files by relative path.`,
    fileActionsHint,
    codeRunHint,
    memoryHint,
  ].filter(Boolean).join('\n');

  const briefBlocks = workerResults.map((w, i) =>
    `### Worker ${i + 1}: ${w.label} (${w.task})\n${w.brief}`
  ).join('\n\n');

  const synthPromptParts = [];
  if (briefBlocks) {
    synthPromptParts.push(`[Retrieved Evidence from Local Tools & Fast Workers]\n${briefBlocks}`);
  }
  synthPromptParts.push(`[User Request]\n${prompt}`);

  const synthMessages = [
    ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: synthPromptParts.join('\n\n') },
  ];

  const finalRes = await endpoint.chatCompletion({
    tier: 'smart',
    model: orchestratorModel,
    systemPrompt: synthSys,
    messages: synthMessages,
    think,
    priority: 'smart',
    signal,
    onEvent: (ev) => {
      if (ev.type === 'queue') onEvent('queue', ev);
      else if (ev.type === 'thinking') onEvent('thinking', { delta: ev.delta });
      else if (ev.type === 'text') onEvent('text', { delta: ev.delta });
    },
  });

  const { fileActions, codeRuns, savedNotes } = extractSpecialBlocks(finalRes.content, toolsCfg);
  if (fileActions.length) onEvent('file_actions', fileActions);
  if (codeRuns.length) onEvent('code_runs', codeRuns);
  if (allSources.length) onEvent('sources', allSources);

  return {
    content: finalRes.content,
    thinking: finalRes.thinking,
    model: finalRes.model,
    mode,
    usage: finalRes.usage,
    plan,
    workers: workerResults,
    sources: allSources,
    fileActions,
    codeRuns,
    savedNotes,
  };
}

module.exports = {
  runCoworkTurn,
};
