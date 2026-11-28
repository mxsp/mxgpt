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
const officeExport = require('./office-export');

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
            .filter((a) => a && a.type && ['mkdir', 'write', 'create', 'patch', 'edit', 'write_docx', 'write_ics', 'move', 'rename', 'copy', 'delete'].includes(String(a.type).toLowerCase()))
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
              oldText: typeof (a.oldText ?? a.old_text) === 'string' ? String(a.oldText ?? a.old_text) : undefined,
              newText: typeof (a.newText ?? a.new_text) === 'string' ? String(a.newText ?? a.new_text) : undefined,
              replaceAll: Boolean(a.replaceAll || a.replace_all),
              title: a.title ? String(a.title) : undefined,
              start: a.start ? String(a.start) : undefined,
              durationMin: a.durationMin ? Number(a.durationMin) : undefined,
              location: a.location ? String(a.location) : undefined,
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
            cwd: item.cwd ? String(item.cwd).trim() : '',
            timeoutSec: item.timeoutSec || item.timeout_sec ? Number(item.timeoutSec || item.timeout_sec) : 0,
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

const READ_ONLY_TOOL_NAMES = new Set([
  'read_file',
  'list_dir',
  'search_files',
  'git_inspect',
  'inspect_spreadsheet',
  'list_servers',
  'read_server_logs',
]);

function buildNativeTools(toolsCfg, resolvedExecTarget = 'container') {
  const tools = [];
  if (toolsCfg.osFiles) {
    // ---- Read-only inspection tools (executed automatically in-turn)
    tools.push({
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file in the active workspace with line numbers (supports line ranges for large source files). Always read before patching.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path inside the workspace, e.g. src/app.js' },
            start_line: { type: 'integer', description: '1-based start line (default 1)' },
            end_line: { type: 'integer', description: '1-based end line (default start_line + 199)' },
          },
          required: ['path'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List files and folders inside a workspace directory.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative subdirectory path (empty string for workspace root)' },
          },
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Search filenames and file contents across the workspace with optional regex and file glob filters (returns exact line numbers).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search text, symbol name, or regex pattern' },
            path: { type: 'string', description: 'Optional relative subfolder to scope the search' },
            glob: { type: 'string', description: 'Optional file glob filter, e.g. "*.py", "src/**/*.js", "*.xlsx"' },
            regex: { type: 'boolean', description: 'Treat query as a regular expression (default false)' },
          },
          required: ['query'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'inspect_spreadsheet',
        description: 'Inspect an .xlsx or .csv file: returns all sheet names, column statistics (sum/avg/min/max), Excel formulas, and a row slice.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to .xlsx or .csv file' },
            sheet_index: { type: 'integer', description: '0-based sheet index (default 0)' },
            start_row: { type: 'integer', description: '0-based start row (default 0)' },
            max_rows: { type: 'integer', description: 'Max rows to return (default 60, max 150)' },
          },
          required: ['path'],
        },
      },
    });

    // ---- Surgical coding & Office write tools (recorded with 1-click Undo)
    tools.push({
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Surgically edit an existing text/code file by replacing an exact snippet (old_text -> new_text). Prefer this over write_file for existing files.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to existing file' },
            old_text: { type: 'string', description: 'Exact existing snippet to replace (include enough lines to be unique)' },
            new_text: { type: 'string', description: 'Replacement text' },
            replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
            reason: { type: 'string', description: 'Short explanation of the edit' },
          },
          required: ['path', 'old_text', 'new_text'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create a new text/code/config file or fully rewrite a small file in the active workspace (recorded with 1-click Undo).',
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
        description: 'Perform a workspace filesystem action (mkdir, write, patch, write_docx, write_ics, move, rename, copy, or delete).',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['mkdir', 'write', 'patch', 'write_docx', 'write_ics', 'move', 'rename', 'copy', 'delete'] },
            path: { type: 'string', description: 'Target relative path (for mkdir/write/patch/write_docx/write_ics/delete)' },
            from: { type: 'string', description: 'Source relative path (for move/rename/copy)' },
            to: { type: 'string', description: 'Destination relative path (for move/rename/copy)' },
            content: { type: 'string', description: 'File or Markdown contents (for write/write_docx/write_ics)' },
            old_text: { type: 'string', description: 'Exact text to replace (for patch)' },
            new_text: { type: 'string', description: 'Replacement text (for patch)' },
            title: { type: 'string', description: 'Document/event title (for write_docx/write_ics)' },
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
        description: 'Create or edit an .xlsx or .csv spreadsheet in the workspace. Supports Excel formulas (=SUM, =AVERAGE, =IF), A1 cell refs, set_range, add/rename/delete column, add/insert/delete row, sort_rows, and multi-sheet ops (add_sheet, rename_sheet).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to .xlsx or .csv file (created automatically if it does not exist)' },
            sheetIndex: { type: 'integer', description: '0-based sheet index (default 0)' },
            sheetName: { type: 'string', description: 'Initial sheet name when creating a new workbook' },
            summary: { type: 'string' },
            operations: {
              type: 'array',
              items: { type: 'object' },
              description: 'Operations: set_cell/set_formula ({op,cell|row,col,value}), set_range ({op,cell|startRow,startCol,values:[[]]}), add_column ({op,header,values}), rename_column ({op,col,header}), delete_column ({op,col}), add_row ({op,values}), insert_row ({op,row,values}), delete_row ({op,row}), sort_rows ({op,col,direction}), add_sheet ({op,name,rows}), rename_sheet ({op,sheetIndex,name})',
            },
          },
          required: ['path', 'operations'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'create_office_doc',
        description: 'Create or update a real Word document (.docx from Markdown), PowerPoint slide deck (.pptx), or Calendar Invite (.ics) directly in the workspace (with 1-click Undo).',
        parameters: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['docx', 'pptx', 'ics'], description: 'Office file format' },
            path: { type: 'string', description: 'Relative output path, e.g. reports/Q1-Summary.docx, deck.pptx, or invite.ics' },
            title: { type: 'string', description: 'Document, presentation, or meeting title' },
            subtitle: { type: 'string', description: 'Optional subtitle (for .pptx)' },
            slides: {
              type: 'array',
              items: { type: 'object' },
              description: 'Optional slide array [{title, bullets:[...]}] for .pptx (if omitted, Markdown headings split into slides)',
            },
            content: { type: 'string', description: 'Markdown body for .docx/.pptx, or description for .ics' },
            start: { type: 'string', description: 'ISO start datetime for .ics (optional)' },
            duration_min: { type: 'integer', description: 'Duration in minutes for .ics (default 30)' },
            location: { type: 'string', description: 'Meeting location or URL for .ics (optional)' },
            reason: { type: 'string' },
          },
          required: ['format', 'path'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'fill_docx_template',
        description: 'Fill {{placeholder}} tags inside an existing Word (.docx) template while preserving its original letterhead, logos, headers, footers, and styles.',
        parameters: {
          type: 'object',
          properties: {
            template_path: { type: 'string', description: 'Relative path to existing .docx template' },
            path: { type: 'string', description: 'Relative output .docx path' },
            replacements: { type: 'object', description: 'Key/value map of placeholder names (without braces) to replacement strings' },
            reason: { type: 'string' },
          },
          required: ['template_path', 'path', 'replacements'],
        },
      },
    });
  }
  if (toolsCfg.git) {
    tools.push({
      type: 'function',
      function: {
        name: 'git_inspect',
        description: 'Inspect local Git branch, status, recent commits, and diff in the active workspace.',
        parameters: {
          type: 'object',
          properties: {
            focus: { type: 'string', description: 'Optional focus, e.g. "diff" to include unified diff patch' },
          },
        },
      },
    });
  }
  if (toolsCfg.container) {
    tools.push({
      type: 'function',
      function: {
        name: 'run_code',
        description: `Execute Python (auto-uses workspace .venv if present), JavaScript (Node.js), Bash, or PowerShell on the preselected ${resolvedExecTarget === 'host' ? 'On-Machine Host' : 'Isolated Container'} environment in the workspace.`,
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short label for this execution' },
            language: { type: 'string', enum: ['python', 'javascript', 'bash', 'powershell'] },
            code: { type: 'string', description: 'Executable script or command' },
            cwd: { type: 'string', description: 'Optional relative subdirectory inside the workspace' },
            timeout_sec: { type: 'integer', description: 'Optional timeout in seconds (5-300, default 60 on host)' },
            reason: { type: 'string', description: 'Why this code should run' },
          },
          required: ['language', 'code'],
        },
      },
    });
    if (resolvedExecTarget === 'host') {
      tools.push({
        type: 'function',
        function: {
          name: 'start_server',
          description: 'Start a managed background dev server (e.g. Flask, FastAPI, Vite, Node HTTP server) in the workspace without blocking. Captures logs and listening URLs.',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Server label, e.g. "Flask API" or "Vite dev server"' },
              language: { type: 'string', enum: ['bash', 'python', 'javascript', 'powershell'] },
              command: { type: 'string', description: 'Command or script to launch the server' },
              cwd: { type: 'string', description: 'Optional relative subdirectory' },
            },
            required: ['command'],
          },
        },
      });
      tools.push({
        type: 'function',
        function: {
          name: 'list_servers',
          description: 'List currently managed background dev servers (IDs, status, listening URLs, PIDs).',
          parameters: { type: 'object', properties: {} },
        },
      });
      tools.push({
        type: 'function',
        function: {
          name: 'read_server_logs',
          description: 'Read recent stdout/stderr logs from a managed background server.',
          parameters: {
            type: 'object',
            properties: {
              server_id: { type: 'string', description: 'Server ID returned by start_server or list_servers' },
            },
            required: ['server_id'],
          },
        },
      });
      tools.push({
        type: 'function',
        function: {
          name: 'stop_server',
          description: 'Stop a running background dev server by ID.',
          parameters: {
            type: 'object',
            properties: {
              server_id: { type: 'string', description: 'Server ID to terminate' },
            },
            required: ['server_id'],
          },
        },
      });
    }
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

async function executeReadOnlyTool(tc, { workspace, onEvent }) {
  const name = String(tc?.name || '').toLowerCase();
  const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
  const id = storage.newId('rt');
  const startedAt = Date.now();
  const labelMap = {
    read_file: 'Read File',
    list_dir: 'List Folder',
    search_files: 'Search Workspace',
    git_inspect: 'Git Inspect',
    inspect_spreadsheet: 'Inspect Spreadsheet',
    list_servers: 'List Servers',
    read_server_logs: 'Server Logs',
  };
  const taskTitle = args.path || args.query || args.focus || args.server_id || labelMap[name] || name;
  onEvent?.('worker_start', {
    id,
    type: name,
    role: name === 'git_inspect' ? 'coder' : 'reader',
    label: labelMap[name] || name,
    model: 'local',
    task: String(taskTitle).slice(0, 180),
    startedAt,
  });

  try {
    let out = '';
    if (name === 'read_file') {
      const r = await localFiles.readFileLines(args.path || '', {
        startLine: args.start_line || args.startLine || 1,
        endLine: args.end_line || args.endLine || ((Number(args.start_line || args.startLine) || 1) + 199),
      }, workspace);
      out = `[File: ${r.path} | lines ${r.startLine}-${r.endLine} of ${r.totalLines} | ${r.sizeLabel}]\n${r.content}`;
    } else if (name === 'list_dir') {
      const r = await localFiles.listDir(args.path || '', workspace);
      out = `[Directory: ${r.path || '.'} (${r.items.length} items)]\n` +
        r.items.slice(0, 80).map((it) => `${it.isDir ? '[DIR] ' : '[FILE]'} ${it.relPath}${it.isDir ? '' : ` (${it.sizeLabel})`}`).join('\n');
    } else if (name === 'search_files') {
      const r = await localFiles.searchFiles({
        query: args.query || '',
        relPath: args.path || '',
        glob: args.glob || '',
        regex: Boolean(args.regex),
        maxResults: 15,
      }, workspace);
      out = `[Search "${args.query || ''}"${args.glob ? ` glob=${args.glob}` : ''}${args.regex ? ' (regex)' : ''}: ${r.results.length} matches across ${r.scanned} files]\n` +
        (r.results.length
          ? r.results.map((h) => {
              const lineStr = h.matches?.length
                ? '\n' + h.matches.map((m) => `    L${m.line}: ${m.text}`).join('\n')
                : (h.snippet ? ` — ${h.snippet}` : '');
              return `- ${h.relPath} (${h.sizeLabel})${lineStr}`;
            }).join('\n')
          : '(no matches)');
    } else if (name === 'list_servers') {
      const svs = containerRunner.listServers();
      out = svs.length
        ? svs.map((s) => `- [${s.id}] "${s.title}" status=${s.status} pid=${s.pid || '?'} urls=${s.urls.join(', ') || '(none)'}`).join('\n')
        : 'No managed background servers are currently tracked.';
    } else if (name === 'read_server_logs') {
      const lg = containerRunner.readServerLogs(args.server_id || args.serverId || '');
      out = `[Server ${lg.id} "${lg.title}" status=${lg.status} urls=${lg.urls.join(', ') || '(none)'}]\n${lg.logs || '(no logs yet)'}`;
    } else if (name === 'git_inspect') {
      const g = await localTools.gitInspect(workspace, args.focus || '');
      out = g.text.slice(0, 10000);
    } else if (name === 'inspect_spreadsheet') {
      const parsed = await localFiles.parseTableFile(args.path || '', workspace, { preserveFormulas: true });
      const sIdx = Math.max(0, Math.min((parsed.sheets?.length || 1) - 1, Number(args.sheet_index ?? args.sheetIndex) || 0));
      const sheet = parsed.sheets?.[sIdx] || { name: 'Sheet1', rows: parsed.rows || [] };
      const allSheetsList = (parsed.sheets || []).map((s, idx) => `[${idx}] "${s.name}" (${s.totalRows || s.rows?.length || 0} rows)`).join(', ');
      const startRow = Math.max(0, Number(args.start_row ?? args.startRow) || 0);
      const maxRows = Math.max(10, Math.min(150, Number(args.max_rows ?? args.maxRows) || 60));
      const slice = (sheet.rows || []).slice(startRow, startRow + maxRows);
      const colLetters = (sheet.rows?.[0] || slice[0] || []).map((_, i) => officeExport.colLetter(i));
      const formatted = slice.map((r, i) => {
        const rIdx = startRow + i;
        return `Row ${rIdx}${rIdx === 0 ? ' (Header)' : ''}: ` + r.map((v, cIdx) => `${colLetters[cIdx] || cIdx}${rIdx + 1}=${JSON.stringify(String(v ?? ''))}`).join(' | ');
      }).join('\n');
      const summary = officeExport.summarizeTable(sheet.rows || []);
      out = [
        `[Spreadsheet: ${parsed.path} | Sheets: ${allSheetsList}]`,
        `Active Sheet [${sIdx}] "${sheet.name}" (showing rows ${startRow}..${startRow + slice.length - 1} of ${sheet.totalRows || sheet.rows.length})`,
        summary,
        formatted.slice(0, 9500),
      ].filter(Boolean).join('\n\n');
    } else {
      out = `Unsupported read-only tool: ${name}`;
    }

    onEvent?.('worker_done', {
      id,
      ok: true,
      elapsedMs: Date.now() - startedAt,
      tokensPerSec: 0,
      summary: `${labelMap[name] || name}: ${String(taskTitle).slice(0, 80)}`,
      brief: out.slice(0, 600),
      citations: args.path ? [{ type: 'file', title: args.path, path: args.path }] : [],
    });
    return out;
  } catch (err) {
    onEvent?.('worker_done', {
      id,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: err.message,
      summary: `${labelMap[name] || name} failed`,
      citations: [],
    });
    return `Tool error (${name}): ${err.message}`;
  }
}

async function runChatWithReadTools({
  tier,
  model,
  systemPrompt,
  messages,
  images,
  tools,
  think,
  priority,
  workspace,
  mask,
  signal,
  onEvent,
  maxReadRounds = 5,
}) {
  let curMessages = [...messages];
  let totalElapsed = 0;
  let lastRes = null;

  for (let round = 0; round <= maxReadRounds; round++) {
    const res = await endpoint.chatCompletion({
      tier,
      model,
      systemPrompt,
      messages: curMessages,
      images: round === 0 ? images : [],
      tools,
      think,
      priority,
      signal,
      onEvent: (ev) => {
        if (ev.type === 'queue') onEvent('queue', ev);
        else if (ev.type === 'thinking') onEvent('thinking', { delta: ev.delta });
        else if (ev.type === 'text') onEvent('text', { delta: ev.delta });
      },
    });
    totalElapsed += res.elapsedMs || 0;
    lastRes = { ...res, elapsedMs: totalElapsed };

    const calls = Array.isArray(res.toolCalls) ? res.toolCalls : [];
    const readCalls = calls.filter((tc) => READ_ONLY_TOOL_NAMES.has(String(tc?.name || '').toLowerCase()));
    const actionCalls = calls.filter((tc) => !READ_ONLY_TOOL_NAMES.has(String(tc?.name || '').toLowerCase()));

    // Only continue the inner read loop when the model called read-only tools and hasn't emitted action tools yet
    if (!readCalls.length || actionCalls.length > 0 || round >= maxReadRounds || signal?.aborted) {
      return { res: lastRes, finalMessages: curMessages };
    }

    onEvent('phase', {
      phase: 'delegating',
      label: `Inspecting workspace (${readCalls.map((c) => c.name).join(', ')})…`,
    });

    const assistantToolCalls = readCalls.map((tc, idx) => ({
      id: tc.id || `call_rt_${round}_${idx}`,
      type: 'function',
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.args || {}),
      },
    }));
    curMessages.push({
      role: 'assistant',
      content: res.content ? mask(res.content) : null,
      tool_calls: assistantToolCalls,
    });

    for (let i = 0; i < readCalls.length; i++) {
      if (signal?.aborted) break;
      const resultText = await executeReadOnlyTool(readCalls[i], { workspace, onEvent });
      curMessages.push({
        role: 'tool',
        tool_call_id: assistantToolCalls[i].id,
        content: mask(resultText.slice(0, 12000)),
      });
    }
  }

  return { res: lastRes, finalMessages: curMessages };
}

async function mergeNativeToolCalls(toolCalls, blocks, toolsCfg, resolvedExecTarget = 'container') {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return blocks;
  const cfg = storage.getSettings();
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const name = String(tc?.name || '').toLowerCase();
    const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};

    if ((name === 'write_file' || name === 'edit_file' || name === 'file_action' || name === 'create_office_doc' || name === 'fill_docx_template') && toolsCfg.osFiles) {
      let type;
      if (name === 'write_file') type = 'write';
      else if (name === 'edit_file') type = 'patch';
      else if (name === 'fill_docx_template') type = 'fill_docx_template';
      else if (name === 'create_office_doc') {
        const fmt = String(args.format || 'docx').toLowerCase();
        type = fmt === 'ics' ? 'write_ics' : (fmt === 'pptx' ? 'write_pptx' : 'write_docx');
      } else type = String(args.type || 'write').toLowerCase();
      if (!['mkdir', 'write', 'create', 'patch', 'edit', 'write_docx', 'write_pptx', 'fill_docx_template', 'write_ics', 'move', 'rename', 'copy', 'delete'].includes(type)) continue;
      const act = {
        id: `act_${Date.now().toString(36)}_tc${i}`,
        type,
        path: args.path ? String(args.path) : '',
        from: args.from ? String(args.from) : '',
        to: args.to ? String(args.to) : '',
        templatePath: args.template_path || args.templatePath ? String(args.template_path || args.templatePath) : '',
        replacements: args.replacements && typeof args.replacements === 'object' ? args.replacements : undefined,
        content: typeof args.content === 'string' ? args.content : undefined,
        oldText: typeof (args.old_text ?? args.oldText) === 'string' ? String(args.old_text ?? args.oldText) : undefined,
        newText: typeof (args.new_text ?? args.newText) === 'string' ? String(args.new_text ?? args.newText) : undefined,
        replaceAll: Boolean(args.replace_all || args.replaceAll),
        title: args.title ? String(args.title) : undefined,
        subtitle: args.subtitle ? String(args.subtitle) : undefined,
        slides: Array.isArray(args.slides) ? args.slides : undefined,
        start: args.start ? String(args.start) : undefined,
        durationMin: args.duration_min || args.durationMin ? Number(args.duration_min || args.durationMin) : undefined,
        location: args.location ? String(args.location) : undefined,
        reason: String(args.reason || '').slice(0, 180),
        status: 'pending',
      };
      try {
        const d = await diffEngine.previewFileActionDiff(act);
        if (d) act.diff = d;
      } catch {}
      blocks.fileActions.push(act);
    } else if ((name === 'run_code' || name === 'start_server' || name === 'stop_server') && toolsCfg.container) {
      if (name === 'stop_server') {
        const sid = String(args.server_id || args.serverId || '').trim();
        if (!sid) continue;
        blocks.codeRuns.push({
          id: `run_${Date.now().toString(36)}_tc${i}`,
          title: `Stop server ${sid}`,
          language: 'bash',
          code: `# stop server ${sid}`,
          command: '',
          isServerOp: 'stop',
          serverId: sid,
          execTarget: 'host',
          reason: `Stop managed background server ${sid}`,
          status: 'pending',
          output: '',
        });
        continue;
      }
      const code = typeof args.code === 'string' ? args.code : (typeof args.command === 'string' ? args.command : '');
      if (!code.trim()) continue;
      const lang = String(args.language || (name === 'start_server' ? 'bash' : 'python')).toLowerCase();
      blocks.codeRuns.push({
        id: `run_${Date.now().toString(36)}_tc${i}`,
        title: String(args.title || (name === 'start_server' ? `Start server (${lang})` : `Run ${lang} ${resolvedExecTarget === 'host' ? 'on host' : 'in container'}`)).slice(0, 100),
        language: lang,
        image: String(args.image || containerRunner.defaultImageForLanguage(lang, cfg.containerImage)),
        code,
        command: name === 'start_server' ? code : '',
        isServerOp: name === 'start_server' ? 'start' : undefined,
        cwd: args.cwd ? String(args.cwd).trim() : '',
        timeoutSec: args.timeout_sec || args.timeoutSec ? Number(args.timeout_sec || args.timeoutSec) : 0,
        network: cfg.containerNetwork || 'none',
        mountMode: cfg.containerMountMode || 'rw',
        execTarget: name === 'start_server' ? 'host' : resolvedExecTarget,
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
        sheetName: args.sheetName ? String(args.sheetName).trim() : undefined,
        summary: String(args.summary || `${args.operations.length} spreadsheet edit(s)`).slice(0, 160),
        operations: args.operations.slice(0, 100),
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
  const all = Array.isArray(history) ? history.filter(Boolean) : [];
  const WINDOW = 12;
  const older = all.length > WINDOW ? all.slice(0, all.length - WINDOW) : [];
  const slice = all.slice(-WINDOW);
  const out = [];
  let seq = 0;

  if (older.length) {
    const digestLines = [];
    for (const m of older.slice(-16)) {
      if (m.isHarness) continue;
      const role = m.role === 'assistant' ? 'Assistant' : 'User';
      const snippet = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      const ops = [
        ...(m.fileActions || []).map((a) => `${a.type}:${a.path || a.to}`),
        ...(m.tableEdits || []).map((t) => `table:${t.path}`),
        ...(m.codeRuns || []).map((r) => `run:${r.title || r.language}(exit ${r.exitCode ?? '?'})`),
      ];
      if (snippet || ops.length) {
        digestLines.push(`- ${role}: ${snippet}${ops.length ? ` [${ops.join(', ')}]` : ''}`);
      }
    }
    if (digestLines.length) {
      out.push({
        role: 'user',
        content: mask(`[Earlier session digest — ${older.length} compacted messages]\n${digestLines.join('\n').slice(0, 2400)}`),
      });
    }
  }

  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    if (!m) continue;
    const isRecent = i >= slice.length - 4;
    const toolOutLimit = isRecent ? 3500 : 900;

    if (useNativeTools && m.role === 'assistant' && ((m.codeRuns?.length || 0) + (m.fileActions?.length || 0) + (m.tableEdits?.length || 0) > 0)) {
      const cleanTxt = String(m.content || '')
        .replace(/^Prepared \*\*\d+\*\* (?:file action|code run|spreadsheet edit)s?[^\n]*\n*/gim, '')
        .trim();
      const toolCalls = [];
      const toolResults = [];

      for (const a of m.fileActions || []) {
        const callId = `call_hist_${++seq}`;
        let fnName;
        let args;
        if (a.type === 'write') {
          fnName = 'write_file';
          args = { path: a.path || '', content: a.content || '', reason: a.reason || '' };
        } else if (a.type === 'patch' || a.type === 'edit') {
          fnName = 'edit_file';
          args = { path: a.path || '', old_text: a.oldText || '', new_text: a.newText || '', reason: a.reason || '' };
        } else if (a.type === 'write_docx' || a.type === 'write_ics') {
          fnName = 'create_office_doc';
          args = { format: a.type === 'write_ics' ? 'ics' : 'docx', path: a.path || '', title: a.title || '', content: a.content || '' };
        } else {
          fnName = 'file_action';
          args = { type: a.type, path: a.path || '', from: a.from || '', to: a.to || '', content: a.content, reason: a.reason || '' };
        }
        toolCalls.push({ id: callId, type: 'function', function: { name: fnName, arguments: mask(JSON.stringify(args)) } });
        toolResults.push({ role: 'tool', tool_call_id: callId, content: mask(`${a.status || 'applied'}: ${a.result || a.path || a.to || 'done'}`) });
      }
      for (const r of m.codeRuns || []) {
        const callId = `call_hist_${++seq}`;
        const args = { title: r.title || r.language, language: r.language || 'bash', code: r.code || r.command || '', reason: r.reason || '' };
        toolCalls.push({ id: callId, type: 'function', function: { name: 'run_code', arguments: mask(JSON.stringify(args)) } });
        toolResults.push({ role: 'tool', tool_call_id: callId, content: mask(`Exit ${r.exitCode ?? 0}:\n${String(r.output || '(no output)').slice(0, toolOutLimit)}`) });
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

  // Pull compact cached project Knowledge Graph, custom project instructions, and repo-native COWORK.md / .coworkrules
  let projectContextBlock = '';
  {
    const pParts = [];
    if (activeProject) {
      pParts.push(`Active Project: "${activeProject.name}" (${activeProject.path})`);
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
    }
    if (toolsCfg.osFiles) {
      try {
        const wsRules = await localFiles.loadWorkspaceRules(workspace);
        if (wsRules) {
          pParts.push(`Workspace Rules (${wsRules.file}):\n${wsRules.content}`);
        }
      } catch {}
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
          const parsed = await localFiles.parseTableFile(openFile.path, workspace, { preserveFormulas: true });
          const sIdx = Math.max(0, Math.min((parsed.sheets?.length || 1) - 1, Number(openFile.sheetIndex) || 0));
          const sheet = parsed.sheets?.[sIdx] || { name: 'Sheet1', rows: parsed.rows || [] };
          const allSheetsList = (parsed.sheets || []).map((s, idx) => `[${idx}] "${s.name}" (${s.totalRows || s.rows?.length || 0} rows)`).join(', ');
          const sampleRows = (sheet.rows || []).slice(0, 45);
          const colLetters = (sampleRows[0] || []).map((_, i) => officeExport.colLetter(i));
          const formatted = sampleRows.map((r, rIdx) =>
            `Row ${rIdx}${rIdx === 0 ? ' (Header)' : ''}: ` + r.map((v, cIdx) => `${colLetters[cIdx] || cIdx}${rIdx + 1}=${JSON.stringify(String(v ?? ''))}`).join(' | ')
          ).join('\n');
          const tableSummary = officeExport.summarizeTable(sheet.rows || []);
          const sel = openFile.selectedCell
            ? `User currently selected cell: ${openFile.selectedCell.colLetter || ''}${(openFile.selectedCell.row ?? 0) + 1} (row=${openFile.selectedCell.row}, col=${openFile.selectedCell.col}, value=${JSON.stringify(openFile.selectedCell.value ?? '')})`
            : '';
          viewParts.push([
            `CURRENTLY OPEN SPREADSHEET IN SIDEBAR: "${openFile.path}" (active sheet [${sIdx}] "${sheet.name}", ${sheet.totalRows || sheet.rows.length} rows × ${(sampleRows[0] || []).length} cols | All sheets: ${allSheetsList})`,
            sel,
            tableSummary,
            `Spreadsheet contents (first ${sampleRows.length} rows; 0-based row & col indices or A1 refs for edit_table):\n${formatted.slice(0, 7500)}`,
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
      activeViewContextBlock = `[Active Workspace View]\n${viewParts.join('\n\n')}\n[/Active Workspace View]`;
    }
  }

  const fileActionsHint = toolsCfg.osFiles
    ? `If proposing local OS file edits/creates/moves/renames/deletes, include a \`\`\`file-actions JSON array. Prefer {"type":"patch","path":"...","oldText":"exact snippet","newText":"replacement","reason":"..."} for surgical edits to existing code files; use "write" for new files, "write_docx" (with "title" & Markdown "content") for real Word .docx documents, "write_ics" for calendar invites, or "mkdir"|"move"|"rename"|"copy"|"delete".`
    : '';
  const tableEditsHint = toolsCfg.osFiles
    ? `When creating or updating .xlsx or .csv spreadsheets (especially the currently open spreadsheet in sidebar), output a \`\`\`table-edits JSON block so mx-Cowork animates your live cursor editing directly in the sidebar. Real Excel formulas starting with "=" (e.g. "=SUM(B2:B10)", "=AVERAGE(C2:C10)", "=IF(B2>100,\\"High\\",\\"Low\\")") are written as native Excel formulas!\n\`\`\`table-edits\n{"path":"relative/file.xlsx","sheetIndex":0,"summary":"short description","operations":[{"op":"set_cell","cell":"C2","value":"1450","note":"Fixed Q1"},{"op":"set_range","cell":"A10","values":[["Total","","=SUM(C2:C9)"]]},{"op":"add_column","header":"Margin %","values":["=ROUND((B2-C2)/B2*100,1)"]},{"op":"sort_rows","col":"C","direction":"desc"},{"op":"add_sheet","name":"Summary","rows":[["Metric","Value"],["Total","=SUM(Sheet1!C2:C9)"]]}]}\n\`\`\` (supported ops: set_cell, set_formula, set_range, add_column, rename_column, delete_column, add_row, insert_row, delete_row, sort_rows, add_sheet, rename_sheet).`
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
      ? `Code execution is ENABLED on the user's preselected standard environment: ON-MACHINE HOST (runs directly in ${workspace} via local python3 — auto-using workspace .venv if present — node, or ${process.platform === 'win32' ? 'PowerShell' : 'bash'}). When coding on the machine, verify edits by running tests, linters, typechecks, or scripts via \`\`\`code-run JSON block: {"title":"short label","language":"python"|"javascript"|"bash"|"powershell","cwd":"optional/subdir","timeoutSec":60,"code":"...","reason":"why"}. Use paths relative to ${workspace}; do NOT hardcode /workspace. On Linux with PEP 668 externally-managed Python, create a local venv (python3 -m venv .venv && .venv/bin/pip install ...) — subsequent python runs will automatically use .venv.`
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
    let directBlueprint = '';
    if (toolsCfg.osFiles) {
      try {
        const bp = await localFiles.projectBlueprint(workspace);
        directBlueprint = bp.text || '';
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
      `You are mx-Cowork, a context-aware local desktop AI copilot & coding/office coworker. Today: ${today}. Workspace: ${workspace}.`,
      directBlueprint ? `[Project Structure & Stack]\n${directBlueprint}\n[/Project Structure & Stack]` : '',
      globalCustomInstr,
      projectContextBlock,
      activeViewContextBlock,
      `Be crisp, structured, and actionable. Use Markdown.`,
      useNativeTools
        ? `Use the attached tools directly: inspect with read_file/list_dir/search_files/git_inspect/inspect_spreadsheet first, then make surgical edits with edit_file (prefer over write_file for existing files), run tests/scripts with run_code, update/create Excel/CSV with edit_table (supports real =SUM/=IF formulas & multi-sheet ops), or create Word/Calendar docs with create_office_doc.`
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

    let res;
    let activeMsgs = msgs;
    if (useNativeTools && nativeTools.length) {
      const loopOut = await runChatWithReadTools({
        tier: mode,
        model: chosenModel,
        systemPrompt: maskedSys,
        messages: msgs,
        images,
        tools: nativeTools,
        think: mode === 'fast' ? 'off' : think,
        priority: mode,
        workspace,
        mask,
        signal,
        onEvent,
      });
      res = loopOut.res;
      activeMsgs = loopOut.finalMessages;
    } else {
      res = await endpoint.chatCompletion({
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
    }

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
          ...activeMsgs,
          ...(partialTxt ? [{ role: 'assistant', content: mask(partialTxt) }] : []),
          {
            role: 'user',
            content: mask(
              `${thoughtHint ? `Your internal plan was:\n${thoughtHint}\n\n` : ''}${isFakePrepared ? 'You wrote plain text "Prepared 1 code run..." instead of calling a tool.' : (partialTxt ? `You wrote "${partialTxt}" but stopped without calling any tool.` : 'You stopped after thinking without writing a visible answer or tool call.')} Call edit_file / write_file / file_action / edit_table / create_office_doc / run_code RIGHT NOW (do NOT write "Prepared 1 code run..." as plain text).`
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
  let wsBlueprint = '';
  if (toolsCfg.osFiles) {
    try {
      const bp = await localFiles.projectBlueprint(workspace);
      wsBlueprint = bp.text || '';
      wsSnapshot = (bp.treeLines || []).slice(0, 35).join(', ');
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
    `You are mx-Cowork's ${orchestratorLabel} Orchestrator & Coding/Office Coworker. Today: ${today}. Workspace: ${workspace}.`,
    wsBlueprint ? `[Project Structure & Stack]\n${wsBlueprint}\n[/Project Structure & Stack]` : (wsSnapshot ? `Workspace top-level items: ${wsSnapshot}` : ''),
    globalCustomInstr,
    projectContextBlock,
    activeViewContextBlock,
    `Your local tools and fast worker models retrieved the evidence below. Synthesize a crisp, deeply helpful, accurate response using Markdown.`,
    `Cite web sources as Markdown links and reference local files by relative path.`,
    useNativeTools
      ? `Use the attached tools directly: inspect with read_file/list_dir/search_files/git_inspect/inspect_spreadsheet if you need exact lines or another sheet, make surgical code edits with edit_file (prefer over write_file for existing files), run tests/scripts with run_code, update/create Excel/CSV with edit_table (real =SUM/=IF formulas & multi-sheet ops), or create Word/Calendar docs with create_office_doc.`
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

  let finalRes;
  let activeSynthMsgs = synthMessages;
  if (useNativeTools && nativeTools.length) {
    const loopOut = await runChatWithReadTools({
      tier: 'smart',
      model: orchestratorModel,
      systemPrompt: maskedSynthSys,
      messages: synthMessages,
      images,
      tools: nativeTools,
      think,
      priority: 'smart',
      workspace,
      mask,
      signal,
      onEvent,
    });
    finalRes = loopOut.res;
    activeSynthMsgs = loopOut.finalMessages;
  } else {
    finalRes = await endpoint.chatCompletion({
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
  }

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
        ...activeSynthMsgs,
        ...(partialTxt ? [{ role: 'assistant', content: mask(partialTxt) }] : []),
        {
          role: 'user',
          content: mask(
            `${thoughtHint ? `Your internal plan was:\n${thoughtHint}\n\n` : ''}${isFakePrepared ? 'You wrote plain text "Prepared 1 code run..." instead of calling a tool.' : (partialTxt ? `You wrote "${partialTxt}" but stopped without calling any tool.` : 'You stopped after thinking without writing a visible answer or tool call.')} Call edit_file / write_file / file_action / edit_table / create_office_doc / run_code RIGHT NOW (do NOT write "Prepared 1 code run..." as plain text).`
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
  buildNativeTools,
  buildHistoryMessages,
  extractSpecialBlocks,
  executeReadOnlyTool,
  READ_ONLY_TOOL_NAMES,
};
