'use strict';

/**
 * mx-Cowork 3-Mode Orchestration Engine:
 *   - fast:    Direct Fast model (lfm3:latest, ~27 tok/s)
 *   - smart:   Direct Smart model (inkling-2-mini:latest, ~5.8 tok/s)
 *   - copilot: Smart orchestrator plans & synthesizes; delegates heavy retrieval,
 *              file scanning, web reading, and distillation to Fast model + native tools.
 */

const endpoint = require('./endpoint');
const localFiles = require('./local-files');
const research = require('./research');
const emailMod = require('./email');
const storage = require('./storage');

const ROLE_META = {
  web_research: { role: 'researcher', label: 'Web Retrieval' },
  file_search: { role: 'files', label: 'File Search' },
  file_read: { role: 'reader', label: 'Doc Reader' },
  folder_audit: { role: 'organizer', label: 'Folder Audit' },
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

function extractSpecialBlocks(markdown) {
  let emailDraft = null;
  let fileActions = [];
  const text = String(markdown || '');

  const mailMatch = text.match(/```email-draft\s*\n([\s\S]*?)```/i);
  if (mailMatch) {
    try {
      const obj = JSON.parse(mailMatch[1].trim());
      if (obj && (obj.body || obj.subject)) {
        emailDraft = {
          to: String(obj.to || '').trim(),
          cc: String(obj.cc || '').trim(),
          subject: String(obj.subject || '').trim(),
          tone: String(obj.tone || 'professional').trim(),
          body: emailMod.appendSignature(String(obj.body || '').trim()),
        };
      }
    } catch {}
  }

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

  return { emailDraft, fileActions };
}

function heuristicPlan(userPrompt, pinnedFiles = []) {
  const text = String(userPrompt || '').trim();
  const tasks = [];
  let outputType = 'answer';

  if (/^(hi|hey|hello|hallo|moin|thanks|thank you|danke|ok)\b[\s!?.]*$/i.test(text)) {
    return { goal: 'Quick reply', direct: true, outputType: 'answer', tasks: [] };
  }

  const wantsEmail = /\b(email|e-mail|mail|draft|reply|write to|send to|schreib.*mail|antwort.*mail|nachricht an)\b/i.test(text);
  const wantsOrganize = /\b(organize|sort|clean ?up|rename|move|group|categorize|aufräumen|sortieren|umbenennen|verschieben|create (a )?file|save (to|as) file)\b/i.test(text);
  const wantsWeb = /\b(research|search (the )?web|look ?up|latest|news|current|compare|market|competitor|trend|202[5-9]|url|https?:\/\/|wiki|recherchier|aktuell)\b/i.test(text);
  const wantsFiles = /\b(file|files|folder|document|pdf|docx|notes|contract|invoice|report|workspace|directory|find in|search my|datei|ordner|dokument)\b/i.test(text);

  if (wantsEmail) outputType = 'email';
  else if (wantsOrganize) outputType = 'file_ops';
  else if (wantsWeb) outputType = 'research';

  for (const pf of pinnedFiles.slice(0, 2)) {
    tasks.push({ type: 'file_read', path: pf, focus: text.slice(0, 160) });
  }
  if (wantsWeb) {
    tasks.push({ type: 'web_research', query: text.slice(0, 160), focus: text.slice(0, 160) });
  }
  if (wantsOrganize) {
    tasks.push({ type: 'folder_audit', path: '', focus: text.slice(0, 160) });
  } else if (wantsFiles && !pinnedFiles.length) {
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

async function runDelegatedWorker(task, { workspace, fastModel, signal, onEvent }) {
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
        research.webSearch(q, 5).catch(() => []),
        research.wikiLookup(q, 'en').catch(() => null),
      ]);
      const pages = [];
      for (const hit of ddg.slice(0, 2)) {
        try {
          const p = await research.fetchPageText(hit.url, 4500);
          pages.push(p);
        } catch {}
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
    } else {
      rawEvidence = String(task.focus || task.query || '');
      localSummary = 'Direct fast analysis';
    }

    if (!rawEvidence.trim()) {
      const emptyBrief = 'No matching local files or web results were found for this subtask.';
      onEvent('worker_done', {
        id,
        ok: true,
        elapsedMs: Date.now() - startedAt,
        tokensPerSec: 0,
        summary: localSummary,
        brief: emptyBrief,
        citations,
      });
      return { id, label: meta.label, role: meta.role, task: title, brief: emptyBrief, citations };
    }

    // Short retrieved snippets (<= 1200 chars) are already compact — pass directly to Smart
    // without wasting a distillation round-trip; delegate heavy docs/web pages to Fast (~27 t/s).
    if (rawEvidence.length <= 1200 && (task.type === 'file_read' || task.type === 'file_search')) {
      const elapsedMs = Date.now() - startedAt;
      onEvent('worker_done', {
        id,
        ok: true,
        elapsedMs,
        tokensPerSec: 0,
        summary: `${localSummary} (direct fast pass)`,
        brief: rawEvidence,
        citations,
      });
      return { id, label: meta.label, role: meta.role, task: title, brief: rawEvidence, citations, elapsedMs };
    }

    // Delegate heavy distillation / extraction to FAST model (lfm3:latest @ ~27 tok/s)!
    const distillSys = `You are a fast retrieval & extraction worker feeding a senior Smart orchestrator.
Distill the raw source data into a tight, factual, high-signal bullet brief (max 220 words).
- Preserve exact filenames, paths, numbers, dates, names, and URLs.
- Omit fluff, ads, navigation chrome, and speculation.
- If the source data contains nothing relevant, say so plainly.`;

    const fastRes = await endpoint.chatCompletion({
      tier: 'fast',
      model: fastModel,
      systemPrompt: distillSys,
      messages: [
        {
          role: 'user',
          content: `Focus: ${task.focus || task.query || task.path}\n\nRaw Retrieved Data:\n${rawEvidence}`,
        },
      ],
      think: 'off',
      priority: 'subagent',
      signal,
      onEvent: (ev) => {
        if (ev.type === 'text' && ev.delta) {
          onEvent('worker_delta', { id, delta: ev.delta });
        } else if (ev.type === 'queue') {
          onEvent('queue', ev);
        }
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
      id,
      ok: false,
      elapsedMs,
      error: err.message,
      summary: localSummary,
      citations,
    });
    return {
      id,
      label: meta.label,
      role: meta.role,
      task: title,
      brief: `Worker error: ${err.message}`,
      citations,
      error: err.message,
    };
  }
}

async function runCoworkTurn({
  mode = 'copilot', // 'fast' | 'smart' | 'copilot'
  prompt = '',
  history = [],
  pinnedFiles = [],
  activeDraft = null,
  think = 'low',
  signal,
  onEvent,
}) {
  const cfg = storage.getSettings();
  const workspace = localFiles.getWorkspace();
  const today = new Date().toISOString().slice(0, 10);

  // ---- Direct Fast or Smart modes
  if (mode === 'fast' || mode === 'smart') {
    onEvent('phase', { phase: 'preparing', label: mode === 'fast' ? 'Fast model (LFM3 1.7B)' : 'Smart model (Inkling 26B)' });
    const ctxParts = [];
    for (const rel of (pinnedFiles || []).slice(0, 3)) {
      try {
        const abs = localFiles.resolveSafe(rel, workspace).abs;
        const txt = await localFiles.readTextContent(abs, 5000);
        ctxParts.push(`[Pinned file: ${rel}]\n${txt}`);
      } catch {}
    }
    if (activeDraft && (activeDraft.subject || activeDraft.body)) {
      ctxParts.push(`[Active Email Draft]\nTo: ${activeDraft.to || ''}\nSubject: ${activeDraft.subject || ''}\n${activeDraft.body || ''}`);
    }

    const sys = [
      `You are mx-Cowork, a local desktop coworker for research, email drafting, and file management. Today: ${today}. Workspace: ${workspace}.`,
      `Be crisp, structured, and actionable. Use Markdown.`,
      `If drafting an email, also include a \`\`\`email-draft JSON block with keys: to, cc, subject, tone, body.`,
      `If proposing local file changes (mkdir, write, move, rename, copy, delete), include a \`\`\`file-actions JSON array of objects with keys: type, path/from/to, content (for write), reason.`,
    ].join('\n');

    const userContent = ctxParts.length ? `${ctxParts.join('\n\n')}\n\nUser request:\n${prompt}` : prompt;
    const msgs = [
      ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userContent },
    ];

    const res = await endpoint.chatCompletion({
      tier: mode,
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

    const { emailDraft, fileActions } = extractSpecialBlocks(res.content);
    if (emailDraft) onEvent('email_draft', emailDraft);
    if (fileActions.length) onEvent('file_actions', fileActions);

    return {
      content: res.content,
      thinking: res.thinking,
      model: res.model,
      mode,
      usage: res.usage,
      plan: null,
      workers: [],
      sources: [],
      emailDraft,
      fileActions,
    };
  }

  // ---- COPILOT MODE: Smart Orchestrator -> Fast Delegated Workers -> Smart Synthesis!
  onEvent('phase', { phase: 'planning', label: 'Smart Orchestrator planning tasks…' });

  let wsSnapshot = '';
  try {
    const ls = await localFiles.listDir('', workspace);
    wsSnapshot = ls.items.slice(0, 30).map((it) => (it.isDir ? `${it.name}/` : it.name)).join(', ');
  } catch {}

  const trivial = /^(hi|hey|hello|hallo|moin|thanks|thank you|danke|ok|test)\b[\s!?.]*$/i.test(prompt.trim());
  let plan = null;

  if (trivial) {
    plan = { goal: 'Quick reply', direct: true, outputType: 'answer', tasks: [] };
  } else {
    // Stage 1: Smart Orchestrator creates a tight delegation plan
    const plannerSys = `You are the Smart Orchestrator of mx-Cowork. Decide which retrieval/research/file tasks to delegate to fast worker models (<2B) before you synthesize the final answer.
Return ONLY valid JSON:
{
  "goal": "brief 1-line objective",
  "direct": false,
  "outputType": "answer" | "email" | "research" | "file_ops",
  "tasks": [
    { "type": "web_research" | "file_search" | "file_read" | "folder_audit", "query": "...", "path": "...", "focus": "what to extract" }
  ]
}
Rules:
- Set "direct": true and "tasks": [] ONLY if no local files, folder inspection, or web research are needed.
- Max 3 tasks. Use relative paths from workspace. Do NOT schedule redundant file_search + file_read if exact filenames are already visible in Top-level items.
- Delegate ALL web searching, file searching, PDF/DOCX reading, and folder auditing to tasks so the fast model distills them for you.`;

    const plannerPrompt = [
      `Today: ${today}`,
      `Workspace: ${workspace}`,
      wsSnapshot ? `Top-level items: ${wsSnapshot}` : '',
      pinnedFiles?.length ? `Pinned files: ${pinnedFiles.join(', ')}` : '',
      activeDraft?.subject || activeDraft?.body ? `Active email draft subject: "${activeDraft.subject || '(untitled)'}"` : '',
      `User request: ${prompt}`,
    ].filter(Boolean).join('\n');

    try {
      const planRes = await endpoint.chatCompletion({
        tier: 'smart',
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
              .filter((t) => t && ['web_research', 'file_search', 'file_read', 'folder_audit'].includes(t.type))
              .slice(0, 4)
          : [];
        plan = {
          goal: String(parsed.goal || prompt.slice(0, 90)),
          direct: Boolean(parsed.direct) && validTasks.length === 0,
          outputType: ['answer', 'email', 'research', 'file_ops'].includes(parsed.outputType) ? parsed.outputType : 'answer',
          tasks: validTasks,
          plannerModel: planRes.model,
          plannerMs: planRes.elapsedMs,
        };
      }
    } catch (e) {
      if (signal?.aborted) throw e;
    }

    if (!plan) {
      plan = heuristicPlan(prompt, pinnedFiles);
    }
    // Always ensure pinned files are read if user pinned them
    for (const pf of (pinnedFiles || []).slice(0, 2)) {
      if (!plan.tasks.some((t) => t.type === 'file_read' && t.path === pf)) {
        plan.tasks.unshift({ type: 'file_read', path: pf, focus: prompt.slice(0, 140) });
        plan.direct = false;
      }
    }
    plan.tasks = plan.tasks.slice(0, 4);
  }

  onEvent('copilot_plan', plan);

  // Stage 2: Execute delegated retrieval/extraction tasks on Fast model + local OS tools!
  const workerResults = [];
  const allSources = [];
  const seenSrc = new Set();

  if (plan.tasks.length) {
    onEvent('phase', { phase: 'delegating', label: `Fast workers running ${plan.tasks.length} retrieval task${plan.tasks.length > 1 ? 's' : ''}…` });
    for (const t of plan.tasks) {
      if (signal?.aborted) break;
      const r = await runDelegatedWorker(t, {
        workspace,
        fastModel: cfg.fastModel,
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

  // Stage 3: Smart Orchestrator synthesizes the distilled worker briefs into final answer + actions!
  onEvent('phase', { phase: 'synthesizing', label: 'Smart Orchestrator synthesizing…' });

  const synthSys = [
    `You are mx-Cowork's Smart Orchestrator. Today: ${today}. Workspace: ${workspace}.`,
    `Your fast worker models already retrieved and distilled the evidence below. Synthesize a clear, executive-grade, accurate response using Markdown.`,
    `Cite web sources as Markdown links and reference local files by relative path.`,
    plan.outputType === 'email'
      ? `IMPORTANT: Because this is an email task, include a \`\`\`email-draft JSON block containing {"to":"","cc":"","subject":"","tone":"professional","body":"..."} so the Email Studio loads it automatically, plus a short note.`
      : `If the user asks for an email draft, include a \`\`\`email-draft JSON block with keys: to, cc, subject, tone, body.`,
    plan.outputType === 'file_ops'
      ? `IMPORTANT: Because this is a file management task, include a \`\`\`file-actions JSON array of proposed operations (each object: {"type":"mkdir"|"write"|"move"|"rename"|"copy"|"delete", "from":"rel/a", "to":"rel/b", "path":"rel/p", "content":"...", "reason":"why"}). Use exact relative paths from the folder audit.`
      : `If proposing local file operations (organize, rename, move, create, delete), include a \`\`\`file-actions JSON array with type, from/to/path, content (if write), and reason.`,
  ].join('\n');

  const briefBlocks = workerResults.map((w, i) =>
    `### Worker ${i + 1}: ${w.label} (${w.task})\n${w.brief}`
  ).join('\n\n');

  const synthPromptParts = [];
  if (activeDraft && (activeDraft.subject || activeDraft.body)) {
    synthPromptParts.push(`[Current Email Draft]\nTo: ${activeDraft.to || ''}\nSubject: ${activeDraft.subject || ''}\n${activeDraft.body || ''}`);
  }
  if (briefBlocks) {
    synthPromptParts.push(`[Distilled Evidence from Fast Workers]\n${briefBlocks}`);
  }
  synthPromptParts.push(`[User Request]\n${prompt}`);

  const synthMessages = [
    ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: synthPromptParts.join('\n\n') },
  ];

  const finalRes = await endpoint.chatCompletion({
    tier: 'smart',
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

  const { emailDraft, fileActions } = extractSpecialBlocks(finalRes.content);
  if (emailDraft) onEvent('email_draft', emailDraft);
  if (fileActions.length) onEvent('file_actions', fileActions);
  if (allSources.length) onEvent('sources', allSources);

  return {
    content: finalRes.content,
    thinking: finalRes.thinking,
    model: finalRes.model,
    mode: 'copilot',
    usage: finalRes.usage,
    plan,
    workers: workerResults,
    sources: allSources,
    emailDraft,
    fileActions,
  };
}

module.exports = {
  runCoworkTurn,
};
