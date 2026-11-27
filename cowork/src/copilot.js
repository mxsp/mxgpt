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
const diffEngine = require('./diff-engine');
const piiShield = require('./pii-shield');
const docIndex = require('./doc-index');

const ROLE_META = {
  web_research: { role: 'researcher', label: 'Web Search' },
  web_fetch: { role: 'researcher', label: 'Page Reader' },
  file_search: { role: 'files', label: 'OS File Search' },
  file_read: { role: 'reader', label: 'Doc Reader' },
  doc_kb: { role: 'reader', label: 'Private Doc KB' },
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

async function extractSpecialBlocks(markdown, toolsCfg, stdExecTarget = '') {
  let fileActions = [];
  let tableEdits = [];
  let codeRuns = [];
  let savedNotes = [];
  let savedTasks = [];
  const text = String(markdown || '');
  const cfg = storage.getSettings();
  const activeProj = storage.getActiveProject();
  const resolvedTarget = (stdExecTarget === 'host' || stdExecTarget === 'container')
    ? stdExecTarget
    : ((activeProj?.codeExecutionTarget || cfg.codeExecutionTarget) === 'host' ? 'host' : 'container');

  if (toolsCfg.osFiles) {
    const actionsMatch = text.match(/```file-actions\s*\n([\s\S]*?)```/i);
    if (actionsMatch) {
      try {
        const arr = JSON.parse(actionsMatch[1].trim());
        if (Array.isArray(arr)) {
          const rawActs = arr
            .filter((a) => a && a.type && ['mkdir', 'write', 'create', 'move', 'rename', 'copy', 'delete'].includes(String(a.type).toLowerCase()))
            .slice(0, 30);
          for (let i = 0; i < rawActs.length; i++) {
            const a = rawActs[i];
            const act = {
              id: `act_${Date.now().toString(36)}_${i}`,
              type: String(a.type).toLowerCase(),
              path: a.path ? String(a.path) : '',
              from: a.from ? String(a.from) : '',
              to: a.to ? String(a.to) : '',
              content: typeof a.content === 'string' ? a.content : undefined,
              reason: String(a.reason || '').slice(0, 180),
              status: 'pending',
            };
            try {
              const d = await diffEngine.previewFileActionDiff(act);
              if (d) act.diff = d;
            } catch {}
            fileActions.push(act);
          }
        }
      } catch {}
    }

    for (const m of text.matchAll(/```table-edits\s*\n([\s\S]*?)```/gi)) {
      try {
        const parsed = JSON.parse(m[1].trim());
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (!item || !item.path || !Array.isArray(item.operations) || !item.operations.length) continue;
          tableEdits.push({
            id: `tbl_${Date.now().toString(36)}_${tableEdits.length}`,
            path: String(item.path).trim(),
            sheetIndex: Math.max(0, Number(item.sheetIndex) || 0),
            summary: String(item.summary || `${item.operations.length} spreadsheet edit(s)`).slice(0, 160),
            operations: item.operations.slice(0, 80),
            status: 'pending',
          });
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
            title: String(item.title || `Run ${lang} ${resolvedTarget === 'host' ? 'on host' : 'in container'}`).slice(0, 100),
            language: lang,
            image: String(item.image || containerRunner.defaultImageForLanguage(lang, cfg.containerImage)),
            code: typeof item.code === 'string' ? item.code : '',
            command: typeof item.command === 'string' ? item.command : '',
            network: item.network === 'bridge' ? 'bridge' : (cfg.containerNetwork || 'none'),
            mountMode: item.mountMode === 'ro' ? 'ro' : (cfg.containerMountMode || 'rw'),
            execTarget: resolvedTarget,
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

  for (const m of text.matchAll(/```action-items\s*\n([\s\S]*?)```/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && (item.title || item.task)) {
          savedTasks.push({
            title: String(item.title || item.task).trim().slice(0, 200),
            owner: String(item.owner || '').trim().slice(0, 60),
            due: String(item.due || item.dueDate || '').trim().slice(0, 32),
            priority: ['high', 'med', 'low'].includes(item.priority) ? item.priority : 'med',
          });
        }
      }
    } catch {}
  }

  return {
    fileActions,
    tableEdits: tableEdits.slice(0, 6),
    codeRuns: codeRuns.slice(0, 8),
    savedNotes: savedNotes.slice(0, 5),
    savedTasks: savedTasks.slice(0, 20),
  };
}

function buildNativeTools(toolsCfg, resolvedExecTarget = 'container') {
  const tools = [];
  if (toolsCfg.osFiles) {
    tools.push({
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a text/code/config file in the active workspace (recorded with 1-click Undo).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path inside the workspace, e.g. app.py or src/index.js' },
            content: { type: 'string', description: 'Complete file contents' },
            reason: { type: 'string', description: 'Short explanation of the change' },
          },
          required: ['path', 'content'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'file_action',
        description: 'Perform a workspace filesystem action (mkdir, write, move, rename, copy, or delete).',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['mkdir', 'write', 'move', 'rename', 'copy', 'delete'] },
            path: { type: 'string', description: 'Target relative path (for mkdir/write/delete)' },
            from: { type: 'string', description: 'Source relative path (for move/rename/copy)' },
            to: { type: 'string', description: 'Destination relative path (for move/rename/copy)' },
            content: { type: 'string', description: 'File contents (for write)' },
            reason: { type: 'string' },
          },
          required: ['type'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'edit_table',
        description: 'Update cells, rows, or columns in an .xlsx or .csv spreadsheet in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to .xlsx or .csv file' },
            sheetIndex: { type: 'integer', description: '0-based sheet index' },
            summary: { type: 'string' },
            operations: {
              type: 'array',
              items: { type: 'object' },
              description: 'List of set_cell / add_column / add_row operations',
            },
          },
          required: ['path', 'operations'],
        },
      },
    });
  }
  if (toolsCfg.container) {
    tools.push({
      type: 'function',
      function: {
        name: 'run_code',
        description: `Execute Python, JavaScript (Node.js), or Bash code on the preselected ${resolvedExecTarget === 'host' ? 'On-Machine Host' : 'Isolated Container'} environment in the workspace.`,
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short label for this execution' },
            language: { type: 'string', enum: ['python', 'javascript', 'bash'] },
            code: { type: 'string', description: 'Executable script or command' },
            reason: { type: 'string', description: 'Why this code should run' },
          },
          required: ['language', 'code'],
        },
      },
    });
  }
  if (toolsCfg.notes) {
    tools.push({
      type: 'function',
      function: {
        name: 'save_memory',
        description: 'Save a persistent user preference or project note.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'content'],
        },
      },
    });
  }
  return tools;
}

async function mergeNativeToolCalls(toolCalls, blocks, toolsCfg, resolvedExecTarget = 'container') {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return blocks;
  const cfg = storage.getSettings();
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const name = String(tc?.name || '').toLowerCase();
    const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};

    if ((name === 'write_file' || name === 'file_action') && toolsCfg.osFiles) {
      const type = name === 'write_file' ? 'write' : String(args.type || 'write').toLowerCase();
      if (!['mkdir', 'write', 'create', 'move', 'rename', 'copy', 'delete'].includes(type)) continue;
      const act = {
        id: `act_${Date.now().toString(36)}_tc${i}`,
        type,
        path: args.path ? String(args.path) : '',
        from: args.from ? String(args.from) : '',
        to: args.to ? String(args.to) : '',
        content: typeof args.content === 'string' ? args.content : undefined,
        reason: String(args.reason || '').slice(0, 180),
        status: 'pending',
      };
      try {
        const d = await diffEngine.previewFileActionDiff(act);
        if (d) act.diff = d;
      } catch {}
      blocks.fileActions.push(act);
    } else if (name === 'run_code' && toolsCfg.container) {
      const code = typeof args.code === 'string' ? args.code : (typeof args.command === 'string' ? args.command : '');
      if (!code.trim()) continue;
      const lang = String(args.language || 'python').toLowerCase();
      blocks.codeRuns.push({
        id: `run_${Date.now().toString(36)}_tc${i}`,
        title: String(args.title || `Run ${lang} ${resolvedExecTarget === 'host' ? 'on host' : 'in container'}`).slice(0, 100),
        language: lang,
        image: String(args.image || containerRunner.defaultImageForLanguage(lang, cfg.containerImage)),
        code,
        command: '',
        network: cfg.containerNetwork || 'none',
        mountMode: cfg.containerMountMode || 'rw',
        execTarget: resolvedExecTarget,
        reason: String(args.reason || '').slice(0, 180),
        status: 'pending',
        output: '',
      });
    } else if (name === 'edit_table' && toolsCfg.osFiles) {
      if (!args.path || !Array.isArray(args.operations) || !args.operations.length) continue;
      blocks.tableEdits.push({
        id: `tbl_${Date.now().toString(36)}_tc${i}`,
        path: String(args.path).trim(),
        sheetIndex: Math.max(0, Number(args.sheetIndex) || 0),
        summary: String(args.summary || `${args.operations.length} spreadsheet edit(s)`).slice(0, 160),
        operations: args.operations.slice(0, 80),
        status: 'pending',
      });
    } else if (name === 'save_memory' && toolsCfg.notes) {
      if (args.title || args.content) {
        blocks.savedNotes.push({
          title: String(args.title || 'Saved note').slice(0, 120),
          content: String(args.content || '').trim(),
          tags: Array.isArray(args.tags) ? args.tags : [],
        });
      }
    }
  }
  blocks.fileActions = blocks.fileActions.slice(0, 30);
  blocks.codeRuns = blocks.codeRuns.slice(0, 8);
  blocks.tableEdits = blocks.tableEdits.slice(0, 6);
  blocks.savedNotes = blocks.savedNotes.slice(0, 5);
  return blocks;
}

function summarizeBlocksMarkdown(blocks) {
  const parts = [];
  if (blocks.fileActions?.length) {
    const names = blocks.fileActions.map((a) => `\`${a.path || a.to || a.from}\``).join(', ');
    parts.push(`Prepared **${blocks.fileActions.length}** file action${blocks.fileActions.length > 1 ? 's' : ''}: ${names}.`);
  }
  if (blocks.codeRuns?.length) {
    const labels = blocks.codeRuns.map((r) => `**${r.title || r.language}**`).join(', ');
    parts.push(`Prepared **${blocks.codeRuns.length}** code run${blocks.codeRuns.length > 1 ? 's' : ''}: ${labels}.`);
  }
  if (blocks.tableEdits?.length) {
    const names = blocks.tableEdits.map((t) => `\`${t.path}\``).join(', ');
    parts.push(`Prepared **${blocks.tableEdits.length}** spreadsheet edit${blocks.tableEdits.length > 1 ? 's' : ''} for ${names}.`);
  }
  return parts.join('\n\n');
}

function buildHistoryMessages(history, useNativeTools, mask) {
  const slice = (history || []).slice(-12);
  const out = [];
  let seq = 0;

  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    if (!m) continue;

    if (useNativeTools && m.role === 'assistant' && ((m.codeRuns?.length || 0) + (m.fileActions?.length || 0) + (m.tableEdits?.length || 0) > 0)) {
      const cleanTxt = String(m.content || '')
        .replace(/^Prepared \*\*\d+\*\* (?:file action|code run|spreadsheet edit)s?[^\n]*\n*/gim, '')
        .trim();
      const toolCalls = [];
      const toolResults = [];

      for (const a of m.fileActions || []) {
        const callId = `call_hist_${++seq}`;
        const fnName = a.type === 'write' ? 'write_file' : 'file_action';
        const args = fnName === 'write_file'
          ? { path: a.path || '', content: a.content || '', reason: a.reason || '' }
          : { type: a.type, path: a.path || '', from: a.from || '', to: a.to || '', content: a.content, reason: a.reason || '' };
        toolCalls.push({ id: callId, type: 'function', function: { name: fnName, arguments: mask(JSON.stringify(args)) } });
        toolResults.push({ role: 'tool', tool_call_id: callId, content: mask(`${a.status || 'applied'}: ${a.result || a.path || a.to || 'done'}`) });
      }
      for (const r of m.codeRuns || []) {
        const callId = `call_hist_${++seq}`;
        const args = { title: r.title || r.language, language: r.language || 'bash', code: r.code || r.command || '', reason: r.reason || '' };
        toolCalls.push({ id: callId, type: 'function', function: { name: 'run_code', arguments: mask(JSON.stringify(args)) } });
        toolResults.push({ role: 'tool', tool_call_id: callId, content: mask(`Exit ${r.exitCode ?? 0}:\n${String(r.output || '(no output)').slice(0, 3500)}`) });
      }
      for (const t of m.tableEdits || []) {
        const callId = `call_hist_${++seq}`;
        const args = { path: t.path, sheetIndex: t.sheetIndex || 0, summary: t.summary || '', operations: t.operations || [] };
        toolCalls.push({ id: callId, type: 'function', function: { name: 'edit_table', arguments: mask(JSON.stringify(args)) } });
        toolResults.push({ role: 'tool', tool_call_id: callId, content: mask(`${t.status || 'applied'}: ${t.result || t.path}`) });
      }

      out.push({ role: 'assistant', content: cleanTxt ? mask(cleanTxt) : null, tool_calls: toolCalls });
      // If the very next message is the Harness feedback for these exact tool calls, fold its text into the tool response instead of duplicating as a user message!
      const next = slice[i + 1];
      if (next && next.role === 'user' && (next.isHarness || /^(Code execution (finished|failed)|Code executed on |File actions applied automatically)/i.test(String(next.content || '').trim()))) {
        if (toolResults.length === 1 && !m.codeRuns?.[0]?.output) {
          toolResults[0].content = mask(String(next.content || '').slice(0, 3500));
        }
        i++; // skip redundant harness user bubble since tool response already carries the output
      }
      out.push(...toolResults);
      continue;
    }

    const fm = formatHistoryMessage(m);
    out.push({ role: fm.role, content: mask(fm.content) });
  }
  return out;
}

function formatHistoryMessage(m) {
  let txt = String(m?.content || '').trim();
  if (m?.role === 'assistant') {
    txt = txt.replace(/^Prepared \*\*\d+\*\* (?:file action|code run|spreadsheet edit)s?[^\n]*\n*/gim, '').trim();
    const notes = [];
    for (const a of m.fileActions || []) {
      notes.push(`Completed ${a.type} ${a.path || a.to || a.from} (${a.status || 'done'}).`);
    }
    for (const r of m.codeRuns || []) {
      notes.push(`Executed ${r.language || 'code'} "${r.title || ''}" (exit ${r.exitCode ?? '?'}).`);
    }
    if (notes.length) txt = [txt, notes.join(' ')].filter(Boolean).join('\n');
  }
  return { role: m?.role === 'assistant' ? 'assistant' : 'user', content: txt || '(done)' };
}

function isPrematureIntentStop(content, toolCalls = []) {
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return false;
  const txt = String(content || '').trim();
  if (!txt) return true;
  if (/```(?:file-actions|code-run|table-edits)\b/i.test(txt)) return false;
  // Catch models mimicking synthetic tool text ("Prepared 1 code run..." or "[Tool run_code ...]") without actually calling a tool!
  if (/^(?:Prepared\s+\*{0,2}\d+\*{0,2}\s+(?:code run|file action|spreadsheet edit)|\[Tool\s+)/i.test(txt)) return true;
  if (txt.length > 360) return false;
  // Detect short narration-only stops like "Ich baue jetzt eine Flask-App und starte sie im Hintergrund." or "Let me create app.py and run it."
  const announcesAction = /\b(ich (baue|erstelle|starte|führe|fuehre|schreibe|lege|mache|prüfe|pruefe|installiere|öffne|oeffne)|erstelle jetzt|baue jetzt|starte jetzt|lass mich|let me|i['’]ll|i will|now i['’]?ll|now i will|going to (create|build|write|run|start|launch|install|inspect)|creating|building|starting|launching|running)\b/i.test(txt);
  const looksComplete = /\b(http:\/\/|https:\/\/|localhost:\d+|fertig|erfolgreich gestartet|läuft auf|laeuft auf|is now running|successfully started|completed)\b/i.test(txt);
  return announcesAction && !looksComplete;
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
  if (t.osFiles) types.push('file_search', 'file_read', 'doc_kb', 'folder_audit');
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

async function runDelegatedWorker(task, { workspace, fastModel, toolsCfg, mask = (s) => s, signal, onEvent }) {
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
    } else if (task.type === 'doc_kb') {
      const q = String(task.query || task.focus || '').trim();
      const res = await docIndex.queryWorkspaceDocs(q, workspace, { topK: 6, autoBuild: true });
      rawEvidence = (res.hits || []).map((h, i) =>
        `[${i + 1}] ${h.path} (section ${h.section}, score ${h.score})\n${h.snippet}`
      ).join('\n\n');
      for (const h of res.hits || []) citations.push({ type: 'file', path: h.path });
      localSummary = `${(res.hits || []).length} KB passages (${res.fileCount || 0} indexed docs)`;
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
    const directPassTypes = new Set(['file_read', 'file_search', 'doc_kb', 'project_graph', 'git_inspect', 'system_info', 'calc_js', 'memory_recall']);
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
        { role: 'user', content: mask(`Focus: ${task.focus || task.query || task.path}\n\nRaw Retrieved Data:\n${rawEvidence}`) },
      ],
      think: 'off',
      priority: 'subagent',
      signal,
      onEvent: (ev) => {
        if (ev.type === 'text' && ev.delta) onEvent('worker_delta', { id, delta: ev.delta });
        else if (ev.type === 'queue') onEvent('queue', ev);
      },
    });

    storage.recordUsage({
      chatId: task._chatId || '',
      chatTitle: task._chatTitle || '',
      model: fastRes.model || fastModel,
      role: 'worker',
      tier: 'fast',
      promptTokens: fastRes.usage?.promptTokens || Math.round(rawEvidence.length / 4),
      evalTokens: fastRes.usage?.evalTokens || Math.round((fastRes.content || '').length / 4),
      elapsedMs: fastRes.elapsedMs || 0,
      tokensPerSec: fastRes.usage?.tokensPerSec || 0,
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
  chatId = '',
  chatTitle = '',
  prompt = '',
  history = [],
  pinnedFiles = [],
  images = [],
  activeContext = null,
  piiShieldOverride = undefined,
  toolOverrides = {},
  stdExecTarget = '',
  autoAcceptEdits = undefined,
  autoRunCode = undefined,
  isHarness = false,
  think = 'low',
  signal,
  onEvent,
}) {
  const cfg = storage.getSettings();
  const toolsCfg = resolveEnabledTools(cfg, toolOverrides);

  // Enforce 2-Tier Usage Limits unless Overboost (Energy) is active (Overboost removes all limits)
  if (!cfg.overboostEnabled && mode !== 'fast') {
    const lim = storage.getUsageLimitsStatus().smart;
    if (!lim.allowed) {
      const fmtReset = (ms) => {
        const mins = Math.max(1, Math.ceil(ms / 60000));
        const d = Math.floor(mins / 1440);
        const h = Math.floor((mins % 1440) / 60);
        const m = mins % 60;
        if (d > 0) return `${d}d ${h}h`;
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
      };
      if (lim.exceededWeekly) {
        throw new Error(`Smart tier weekly limit reached (${lim.usedWeekly.toLocaleString()} / ${lim.limitWeekly.toLocaleString()} tokens). Resets in ~${fmtReset(lim.resetWeeklyInMs)}. Switch to Fast mode (unlimited) or enable Overboost in Settings.`);
      }
      throw new Error(`Smart tier 4-hour limit reached (${lim.used4h.toLocaleString()} / ${lim.limit4h.toLocaleString()} tokens). Resets in ~${fmtReset(lim.reset4hInMs)}. Switch to Fast mode (unlimited) or enable Overboost in Settings.`);
    }
  }
  const guardModel = (m, fallback) => {
    const clean = String(m || fallback || '').trim();
    if (!cfg.overboostEnabled && /^opencode-go\//i.test(clean)) {
      return fallback;
    }
    return clean;
  };
  const activeProject = storage.getActiveProject();
  const workspace = activeProject?.path || localFiles.getWorkspace();
  const today = new Date().toISOString().slice(0, 10);
  const shieldOn = piiShieldOverride !== undefined ? Boolean(piiShieldOverride) : Boolean(cfg.piiShieldEnabled);
  const shield = shieldOn ? piiShield.createShieldContext(cfg.piiCustomTerms || '') : null;
  const mask = (txt) => (shield ? shield.redact(txt) : String(txt ?? ''));
  const unmask = (txt) => (shield ? shield.restore(txt) : String(txt ?? ''));

  // Pull compact cached project Knowledge Graph & custom project instructions
  let projectContextBlock = '';
  if (activeProject) {
    const pParts = [`Active Project: "${activeProject.name}" (${activeProject.path})`];
    if (activeProject.instructions) pParts.push(`Project Instructions:\n${activeProject.instructions}`);
    if (toolsCfg.knowledgeGraph) {
      const cachedGraph = storage.getProjectGraphCache(activeProject.id);
      if (cachedGraph) {
        const gLines = [];
        if (cachedGraph.aiSummary) gLines.push(`Summary: ${cachedGraph.aiSummary}`);
        if (cachedGraph.aiClusters?.length) {
          gLines.push('Clusters: ' + cachedGraph.aiClusters.map((c) => `${c.name} (${c.description})`).join(' | '));
        }
        if (cachedGraph.topHubs?.length) {
          gLines.push('Core Hubs: ' + cachedGraph.topHubs.slice(0, 8).map((h) => h.path).join(', '));
        }
        if (gLines.length) pParts.push(`Cached Project Knowledge Graph:\n${gLines.join('\n')}`);
      }
    }
    projectContextBlock = pParts.join('\n');
  }

  // Deep Context Awareness: know every Office doc in the project AND the exact file/spreadsheet open in the right sidebar!
  let activeViewContextBlock = '';
  if (toolsCfg.osFiles) {
    const viewParts = [];
    try {
      const officeDocs = await localFiles.listOfficeFiles(workspace, 24);
      if (officeDocs.length) {
        viewParts.push('Office & Data Documents in Active Project:\n' + officeDocs.map((f) => `- ${f.relPath} (${f.ext.slice(1).toUpperCase()}, ${f.sizeLabel})`).join('\n'));
      }
    } catch {}

    const openFile = activeContext?.openFile;
    if (openFile && openFile.path) {
      onEvent('copilot_cursor', {
        phase: 'reading',
        path: openFile.path,
        label: `Reading ${openFile.name || openFile.path}…`,
        row: openFile.selectedCell?.row ?? 0,
        col: openFile.selectedCell?.col ?? 0,
      });

      const isTab = /\.(xlsx|csv|tsv)$/i.test(openFile.path);
      if (isTab) {
        try {
          const parsed = await localFiles.parseTableFile(openFile.path, workspace);
          const sIdx = Math.max(0, Math.min((parsed.sheets?.length || 1) - 1, Number(openFile.sheetIndex) || 0));
          const sheet = parsed.sheets?.[sIdx] || { name: 'Sheet1', rows: parsed.rows || [] };
          const sampleRows = (sheet.rows || []).slice(0, 45);
          const colLetters = (sampleRows[0] || []).map((_, i) => {
            let s = ''; let n = i + 1;
            while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
            return s;
          });
          const formatted = sampleRows.map((r, rIdx) =>
            `Row ${rIdx}${rIdx === 0 ? ' (Header)' : ''}: ` + r.map((v, cIdx) => `${colLetters[cIdx] || cIdx}${rIdx + 1}=${JSON.stringify(String(v ?? ''))}`).join(' | ')
          ).join('\n');
          const sel = openFile.selectedCell
            ? `User currently selected cell: ${openFile.selectedCell.colLetter || ''}${(openFile.selectedCell.row ?? 0) + 1} (row=${openFile.selectedCell.row}, col=${openFile.selectedCell.col}, value=${JSON.stringify(openFile.selectedCell.value ?? '')})`
            : '';
          viewParts.push([
            `CURRENTLY OPEN SPREADSHEET IN SIDEBAR: "${openFile.path}" (sheet "${sheet.name}", sheetIndex=${sIdx}, ${sheet.rows.length} rows × ${(sampleRows[0] || []).length} cols)`,
            sel,
            `Spreadsheet contents (0-based row & col indices for table-edits):\n${formatted.slice(0, 7500)}`,
          ].filter(Boolean).join('\n'));
        } catch {}
      } else {
        try {
          const txt = await localFiles.readTextContent(localFiles.resolveSafe(openFile.path, workspace).abs, 6000);
          viewParts.push(`CURRENTLY OPEN FILE IN SIDEBAR: "${openFile.path}"\n${txt}`);
        } catch {}
      }
    }

    if (viewParts.length) {
      activeViewContextBlock = `<active_workspace_view>\n${viewParts.join('\n\n')}\n</active_workspace_view>`;
    }
  }

  const fileActionsHint = toolsCfg.osFiles
    ? `If proposing local OS file edits/creates/moves/renames/deletes, include a \`\`\`file-actions JSON array: [{"type":"mkdir"|"write"|"move"|"rename"|"copy"|"delete","path":"...","from":"...","to":"...","content":"...","reason":"..."}].`
    : '';
  const tableEditsHint = toolsCfg.osFiles
    ? `When updating or adding cells, rows, or columns in an .xlsx or .csv spreadsheet (especially the currently open spreadsheet in sidebar), output a \`\`\`table-edits JSON block so mx-Cowork animates your live cursor editing each cell directly in the sidebar:\n\`\`\`table-edits\n{"path":"relative/file.xlsx","sheetIndex":0,"summary":"short description","operations":[{"op":"set_cell","row":1,"col":2,"value":"1450","note":"Fixed Q1"},{"op":"add_column","header":"Margin %","values":["32%","28%"],"note":"Computed margin"},{"op":"add_row","values":["Total","","4200","30%"],"note":"Added totals"}]}\n\`\`\` (row=0 is header row, col=0 is column A).`
    : '';
  const resolvedExecTarget = (stdExecTarget === 'host' || stdExecTarget === 'container')
    ? stdExecTarget
    : ((activeProject?.codeExecutionTarget || cfg.codeExecutionTarget) === 'host' ? 'host' : 'container');
  const effAutoEdits = autoAcceptEdits !== undefined
    ? Boolean(autoAcceptEdits)
    : (activeProject ? Boolean(activeProject.autoAcceptEdits) : Boolean(cfg.autoApproveFileActions));
  const effAutoCode = autoRunCode !== undefined
    ? Boolean(autoRunCode)
    : (activeProject ? Boolean(activeProject.autoRunContainer) : Boolean(cfg.autoApproveContainerRuns));

  const codeRunHint = toolsCfg.container
    ? (resolvedExecTarget === 'host'
      ? `Code execution is ENABLED on the user's preselected standard environment: ON-MACHINE HOST (runs directly in ${workspace} via local python3, node, or ${process.platform === 'win32' ? 'PowerShell' : 'bash'}). When executing Python, Node.js, or Shell code on the workspace helps verify, test, compute, create .xlsx/.pdf/.docx files, or automate, include a \`\`\`code-run JSON block: {"title":"short label","language":"python"|"javascript"|"bash","code":"...","reason":"why"}. Use paths relative to the working directory (${workspace}); do NOT hardcode /workspace. On Linux with PEP 668 externally-managed Python, use a local venv (python3 -m venv .venv && .venv/bin/pip install ...) or pip install --break-system-packages.`
      : `Code execution is ENABLED on the user's preselected standard environment: ISOLATED CONTAINER (Docker/Podman mounted at /workspace; default image ${cfg.containerImage || 'python:3.12-slim'}). When executing Python, Node.js, or Shell code on the workspace helps verify, test, compute, create .xlsx/.pdf/.docx files, or automate, include a \`\`\`code-run JSON block: {"title":"short label","language":"python"|"javascript"|"bash","image":"python:3.12-slim","code":"...","reason":"why"}.`)
    : '';
  const noNativeToolHint = `CRITICAL: Do NOT call native function tools (none are attached) and NEVER stop after internal reasoning with an empty reply. Always output your complete final Markdown answer and any fenced \`\`\`code-run, \`\`\`file-actions, or \`\`\`table-edits blocks directly in one response.`;
  const autoModeHint = (effAutoEdits || effAutoCode)
    ? `AUTO MODE IS ACTIVE (${[effAutoCode ? `auto-run code on ${resolvedExecTarget.toUpperCase()}` : '', effAutoEdits ? 'auto-apply file & spreadsheet edits with 1-click Undo' : ''].filter(Boolean).join(' + ')}): emit executable \`\`\`code-run, \`\`\`file-actions, and \`\`\`table-edits blocks directly — they execute automatically right after your response.`
    : '';
  const memoryHint = toolsCfg.notes
    ? `If the user explicitly asks you to remember a preference, fact, or project note for future sessions, include a \`\`\`memory-save JSON block: {"title":"short title","content":"fact to remember","tags":["tag"]}.`
    : '';
  const artifactHint = `When creating interactive dashboards, web apps, charts, diagrams, or visual UI mockups, output a complete self-contained fenced \`\`\`html, \`\`\`svg, \`\`\`jsx, or \`\`\`mermaid code block so mx-Cowork opens it automatically in the live Artifact Preview Canvas.`;
  const globalCustomInstr = cfg.customInstructions ? `User Custom Instructions:\n${cfg.customInstructions}` : '';
  const supportsNativeTools = (m) => cfg.endpointType === 'openai' || /^opencode-go\//i.test(String(m || ''));
  let workerModel = guardModel(cfg.agentModel || cfg.fastModel, 'lfm3:latest');
  // On remote OpenAI/OpenCode Go endpoints, never send local Ollama tags like "lfm3:latest" for workers
  if (cfg.endpointType === 'openai' && /:latest$/i.test(workerModel)) {
    const fallbackRemote = (mode === 'copilot_b' ? cfg.copilotBModel : cfg.smartModel) || cfg.fastModel;
    if (fallbackRemote && !/:latest$/i.test(fallbackRemote)) workerModel = fallbackRemote;
  }

  // ---- Direct Fast or Smart modes
  if (mode === 'fast' || mode === 'smart') {
    const chosenModel = mode === 'fast'
      ? guardModel(cfg.fastModel, 'lfm3:latest')
      : guardModel(cfg.smartModel, 'inkling-2-mini:latest');
    const useNativeTools = supportsNativeTools(chosenModel);
    const nativeTools = useNativeTools ? buildNativeTools(toolsCfg, resolvedExecTarget) : [];
    onEvent('phase', { phase: 'preparing', label: `${mode === 'fast' ? 'Fast' : 'Smart'} · ${chosenModel.replace(/:latest$/, '')}` });
    let directWsSnapshot = '';
    if (toolsCfg.osFiles) {
      try {
        const ls = await localFiles.listDir('', workspace);
        directWsSnapshot = ls.items.slice(0, 35).map((it) => (it.isDir ? `${it.name}/` : it.name)).join(', ');
      } catch {}
    }
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
      `You are mx-Cowork, a context-aware local desktop AI copilot. Today: ${today}. Workspace: ${workspace}.`,
      directWsSnapshot ? `Workspace top-level items: ${directWsSnapshot}` : '',
      globalCustomInstr,
      projectContextBlock,
      activeViewContextBlock,
      `Be crisp, structured, and actionable. Use Markdown.`,
      useNativeTools
        ? `Use the attached tools (write_file, file_action, run_code, edit_table, save_memory) directly whenever creating/editing files or running code, and also write a clear Markdown explanation.`
        : noNativeToolHint,
      artifactHint,
      tableEditsHint,
      fileActionsHint,
      codeRunHint,
      autoModeHint,
      memoryHint,
    ].filter(Boolean).join('\n');

    const userContent = ctxParts.length ? `${ctxParts.join('\n\n')}\n\nUser request:\n${prompt}` : prompt;
    const msgs = [
      ...buildHistoryMessages(history, useNativeTools, mask),
      { role: 'user', content: mask(userContent) },
    ];
    const maskedSys = mask(sys);
    if (shield && shield.summary().total > 0) {
      onEvent('shield', shield.summary());
    }

    let res = await endpoint.chatCompletion({
      tier: mode,
      model: chosenModel,
      systemPrompt: maskedSys,
      messages: msgs,
      images,
      tools: nativeTools,
      think: mode === 'fast' ? 'off' : think,
      priority: mode,
      signal,
      onEvent: (ev) => {
        if (ev.type === 'queue') onEvent('queue', ev);
        else if (ev.type === 'thinking') onEvent('thinking', { delta: ev.delta });
        else if (ev.type === 'text') onEvent('text', { delta: ev.delta });
      },
    });

    // Guard against reasoning-only cutoffs OR premature narration-only stops ("Ich baue jetzt..." without calling any tool!)
    if (isPrematureIntentStop(res.content, res.toolCalls) && !signal?.aborted) {
      onEvent('phase', { phase: 'synthesizing', label: 'Executing planned action…' });
      const thoughtHint = String(res.thinking || '').trim().slice(0, 1200);
      const rawPartial = String(res.content || '').trim();
      const isFakePrepared = /^Prepared\s+\*{0,2}\d+\*{0,2}\s+(?:code run|file action|spreadsheet edit)/i.test(rawPartial);
      const partialTxt = isFakePrepared ? '' : rawPartial;
      const recoverRes = await endpoint.chatCompletion({
        tier: mode,
        model: chosenModel,
        systemPrompt: maskedSys,
        messages: [
          ...msgs,
          ...(partialTxt ? [{ role: 'assistant', content: mask(partialTxt) }] : []),
          {
            role: 'user',
            content: mask(
              `${thoughtHint ? `Your internal plan was:\n${thoughtHint}\n\n` : ''}${isFakePrepared ? 'You wrote plain text "Prepared 1 code run..." instead of calling a tool.' : (partialTxt ? `You wrote "${partialTxt}" but stopped without calling any tool.` : 'You stopped after thinking without writing a visible answer or tool call.')} Call write_file / file_action / run_code RIGHT NOW (do NOT write "Prepared 1 code run..." as plain text).`
            ),
          },
        ],
        tools: nativeTools,
        toolChoice: nativeTools.length ? 'required' : 'auto',
        think: 'off',
        priority: mode,
        signal,
        onEvent: (ev) => {
          if (ev.type === 'text') onEvent('text', { delta: ev.delta });
        },
      });
      res = {
        ...recoverRes,
        content: [partialTxt, recoverRes.content].filter(Boolean).join('\n\n'),
        thinking: [res.thinking, recoverRes.thinking].filter(Boolean).join('\n'),
        toolCalls: [...(res.toolCalls || []), ...(recoverRes.toolCalls || [])],
        elapsedMs: (res.elapsedMs || 0) + (recoverRes.elapsedMs || 0),
      };
    }

    let finalContent = unmask(res.content);
    const finalThinking = unmask(res.thinking);

    storage.recordUsage({
      chatId,
      chatTitle,
      model: res.model || chosenModel,
      role: 'main',
      tier: mode === 'fast' ? 'fast' : 'smart',
      promptTokens: res.usage?.promptTokens || Math.round((sys.length + userContent.length) / 4),
      evalTokens: res.usage?.evalTokens || Math.round(((finalContent || '').length + (finalThinking || '').length) / 4),
      elapsedMs: res.elapsedMs || 0,
      tokensPerSec: res.usage?.tokensPerSec || 0,
    });

    const blocks = await extractSpecialBlocks(finalContent, toolsCfg, resolvedExecTarget);
    await mergeNativeToolCalls(res.toolCalls, blocks, toolsCfg, resolvedExecTarget);
    const { fileActions, tableEdits, codeRuns, savedNotes, savedTasks } = blocks;
    let wasAutoSynthesized = false;
    if (!finalContent.trim() && (fileActions.length || codeRuns.length || tableEdits.length)) {
      finalContent = summarizeBlocksMarkdown(blocks);
      wasAutoSynthesized = true;
      onEvent('text', { delta: finalContent });
    }
    if (fileActions.length) onEvent('file_actions', fileActions);
    if (tableEdits.length) onEvent('table_edits', tableEdits);
    if (codeRuns.length) onEvent('code_runs', codeRuns);

    return {
      content: finalContent,
      thinking: finalThinking,
      model: res.model,
      mode,
      usage: res.usage,
      shieldSummary: shield ? shield.summary() : null,
      plan: null,
      workers: [],
      sources: [],
      fileActions,
      tableEdits,
      codeRuns,
      savedNotes,
      savedTasks,
      wasAutoSynthesized,
    };
  }

  // ---- COPILOT (Smart) or COPILOT (B) (nemotron-3.5-lightning) Orchestrator -> Fast Workers -> Synthesis
  const isCopilotB = mode === 'copilot_b';
  const orchestratorModel = isCopilotB
    ? guardModel(cfg.copilotBModel, 'nemotron-3.5-lightning')
    : guardModel(cfg.smartModel, 'inkling-2-mini:latest');
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

  if (isHarness || trivial || !allowedTypes.length) {
    plan = { goal: isHarness ? 'Continue from execution result' : 'Direct response', direct: true, outputType: 'answer', tasks: [] };
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
      activeContext?.openFile?.path ? `Currently open file in user's sidebar (already loaded in context): ${activeContext.openFile.path}` : '',
      pinnedFiles?.length ? `Pinned files: ${pinnedFiles.join(', ')}` : '',
      `User request: ${prompt}`,
    ].filter(Boolean).join('\n');

    try {
      const planRes = await endpoint.chatCompletion({
        tier: 'smart',
        model: orchestratorModel,
        systemPrompt: plannerSys,
        messages: [{ role: 'user', content: mask(plannerPrompt) }],
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
      const r = await runDelegatedWorker({ ...t, _chatId: chatId, _chatTitle: chatTitle }, {
        workspace,
        fastModel: workerModel,
        toolsCfg,
        mask,
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
  const useNativeTools = supportsNativeTools(orchestratorModel);
  const nativeTools = useNativeTools ? buildNativeTools(toolsCfg, resolvedExecTarget) : [];

  const synthSys = [
    `You are mx-Cowork's ${orchestratorLabel} Orchestrator. Today: ${today}. Workspace: ${workspace}.`,
    wsSnapshot ? `Workspace top-level items: ${wsSnapshot}` : '',
    globalCustomInstr,
    projectContextBlock,
    activeViewContextBlock,
    `Your local tools and fast worker models retrieved the evidence below. Synthesize a crisp, deeply helpful, accurate response using Markdown.`,
    `Cite web sources as Markdown links and reference local files by relative path.`,
    useNativeTools
      ? `Use the attached tools (write_file, file_action, run_code, edit_table, save_memory) directly whenever creating/editing files or running code, and also write a clear Markdown explanation.`
      : noNativeToolHint,
    artifactHint,
    tableEditsHint,
    fileActionsHint,
    codeRunHint,
    autoModeHint,
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
    ...buildHistoryMessages(history, useNativeTools, mask),
    { role: 'user', content: mask(synthPromptParts.join('\n\n')) },
  ];
  const maskedSynthSys = mask(synthSys);
  if (shield && shield.summary().total > 0) {
    onEvent('shield', shield.summary());
  }

  let finalRes = await endpoint.chatCompletion({
    tier: 'smart',
    model: orchestratorModel,
    systemPrompt: maskedSynthSys,
    messages: synthMessages,
    images,
    tools: nativeTools,
    think,
    priority: 'smart',
    signal,
    onEvent: (ev) => {
      if (ev.type === 'queue') onEvent('queue', ev);
      else if (ev.type === 'thinking') onEvent('thinking', { delta: ev.delta });
      else if (ev.type === 'text') onEvent('text', { delta: ev.delta });
    },
  });

  // Guard against reasoning-only cutoffs OR premature narration-only stops in Copilot synthesis
  if (isPrematureIntentStop(finalRes.content, finalRes.toolCalls) && !signal?.aborted) {
    onEvent('phase', { phase: 'synthesizing', label: 'Executing planned action…' });
    const thoughtHint = String(finalRes.thinking || '').trim().slice(0, 1200);
    const rawPartial = String(finalRes.content || '').trim();
    const isFakePrepared = /^Prepared\s+\*{0,2}\d+\*{0,2}\s+(?:code run|file action|spreadsheet edit)/i.test(rawPartial);
    const partialTxt = isFakePrepared ? '' : rawPartial;
    const recoverRes = await endpoint.chatCompletion({
      tier: 'smart',
      model: orchestratorModel,
      systemPrompt: maskedSynthSys,
      messages: [
        ...synthMessages,
        ...(partialTxt ? [{ role: 'assistant', content: mask(partialTxt) }] : []),
        {
          role: 'user',
          content: mask(
            `${thoughtHint ? `Your internal plan was:\n${thoughtHint}\n\n` : ''}${isFakePrepared ? 'You wrote plain text "Prepared 1 code run..." instead of calling a tool.' : (partialTxt ? `You wrote "${partialTxt}" but stopped without calling any tool.` : 'You stopped after thinking without writing a visible answer or tool call.')} Call write_file / file_action / run_code RIGHT NOW (do NOT write "Prepared 1 code run..." as plain text).`
          ),
        },
      ],
      tools: nativeTools,
      toolChoice: nativeTools.length ? 'required' : 'auto',
      think: 'off',
      priority: 'smart',
      signal,
      onEvent: (ev) => {
        if (ev.type === 'text') onEvent('text', { delta: ev.delta });
      },
    });
    finalRes = {
      ...recoverRes,
      content: [partialTxt, recoverRes.content].filter(Boolean).join('\n\n'),
      thinking: [finalRes.thinking, recoverRes.thinking].filter(Boolean).join('\n'),
      toolCalls: [...(finalRes.toolCalls || []), ...(recoverRes.toolCalls || [])],
      elapsedMs: (finalRes.elapsedMs || 0) + (recoverRes.elapsedMs || 0),
    };
  }

  let finalContent = unmask(finalRes.content);
  const finalThinking = unmask(finalRes.thinking);

  storage.recordUsage({
    chatId,
    chatTitle,
    model: finalRes.model || orchestratorModel,
    role: 'main',
    tier: 'smart',
    promptTokens: finalRes.usage?.promptTokens || Math.round((synthSys.length + synthPromptParts.join('\n').length) / 4),
    evalTokens: finalRes.usage?.evalTokens || Math.round(((finalContent || '').length + (finalThinking || '').length) / 4),
    elapsedMs: finalRes.elapsedMs || 0,
    tokensPerSec: finalRes.usage?.tokensPerSec || 0,
  });

  const blocks = await extractSpecialBlocks(finalContent, toolsCfg, resolvedExecTarget);
  await mergeNativeToolCalls(finalRes.toolCalls, blocks, toolsCfg, resolvedExecTarget);
  const { fileActions, tableEdits, codeRuns, savedNotes, savedTasks } = blocks;
  let wasAutoSynthesized = false;
  if (!finalContent.trim() && (fileActions.length || codeRuns.length || tableEdits.length)) {
    finalContent = summarizeBlocksMarkdown(blocks);
    wasAutoSynthesized = true;
    onEvent('text', { delta: finalContent });
  }
  if (fileActions.length) onEvent('file_actions', fileActions);
  if (tableEdits.length) onEvent('table_edits', tableEdits);
  if (codeRuns.length) onEvent('code_runs', codeRuns);
  if (allSources.length) onEvent('sources', allSources);

  return {
    content: finalContent,
    thinking: finalThinking,
    model: finalRes.model,
    mode,
    usage: finalRes.usage,
    shieldSummary: shield ? shield.summary() : null,
    plan,
    workers: workerResults,
    sources: allSources,
    fileActions,
    tableEdits,
    codeRuns,
    savedNotes,
    savedTasks,
    wasAutoSynthesized,
  };
}

module.exports = {
  runCoworkTurn,
};
