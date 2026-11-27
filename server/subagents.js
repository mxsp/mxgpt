'use strict';
const crypto = require('crypto');
const ollama = require('./ollama');

const MAX_PARAM_B = 3.0; // strictly sub-3B parameter models (< 3B)

const ROLES = {
  coder: {
    id: 'coder',
    label: 'Coder',
    prompt: 'You are a fast coding subagent (<3B parameters) assisting a lead AI model. Write clean, accurate, minimal code or debug findings. Use tools when helpful to verify logic. Return a concise, self-contained technical result.',
    tools: ({ useFiles }) => ['run_js', 'calculate', ...(useFiles ? ['list_files', 'search_files', 'read_file'] : [])],
    temperature: 0.2,
  },
  researcher: {
    id: 'researcher',
    label: 'Researcher',
    prompt: 'You are a fast research subagent (<3B parameters) assisting a lead AI model. Gather accurate facts using your web tools when available, cite URLs, and return a tight bulleted brief with zero filler.',
    tools: ({ useWeb }) => (useWeb ? ['web_search', 'wiki_lookup', 'browse_url'] : ['get_datetime']),
    temperature: 0.3,
  },
  analyst: {
    id: 'analyst',
    label: 'Analyst',
    prompt: 'You are a fast analytical subagent (<3B parameters) assisting a lead AI model. Use calculate, run_js, and get_datetime to verify numbers, analyze data, and return concise structured findings.',
    tools: () => ['calculate', 'run_js', 'get_datetime'],
    temperature: 0.2,
  },
  summarizer: {
    id: 'summarizer',
    label: 'Summarizer',
    prompt: 'You are a fast summarization and extraction subagent (<3B parameters) assisting a lead AI model. Distill the provided context or files into crisp, accurate bullet points with no fluff.',
    tools: ({ useFiles }) => ['list_notes', 'read_note', ...(useFiles ? ['read_file'] : [])],
    temperature: 0.3,
  },
  general: {
    id: 'general',
    label: 'Helper',
    prompt: 'You are a fast helper subagent (<3B parameters) assisting a lead AI model. Complete the assigned subtask directly, accurately, and concisely.',
    tools: () => ['calculate', 'get_datetime', 'run_js'],
    temperature: 0.4,
  },
};

function parseParamBillions(paramStr) {
  const s = String(paramStr || '').trim().toUpperCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([BMK])$/);
  if (!m) return null;
  const val = Number(m[1]);
  if (!Number.isFinite(val) || val <= 0) return null;
  if (m[2] === 'B') return val;
  if (m[2] === 'M') return val / 1000;
  if (m[2] === 'K') return val / 1_000_000;
  return null;
}

function isSub3BModel(m) {
  if (!m || m.cloud) return false;
  if (/embed|rerank|whisper|tts/i.test(m.name || '')) return false;
  if (Array.isArray(m.capabilities) && m.capabilities.length && !m.capabilities.includes('completion')) return false;
  const b = parseParamBillions(m.params);
  if (b !== null) return b > 0 && b < MAX_PARAM_B;
  // Fallback if parameter_size metadata is absent: < 2.6 GB GGUF size
  return (m.size || 0) > 1_000_000 && (m.size || 0) < 2_600_000_000;
}

async function listSub3BModels() {
  let models = [];
  try { models = await ollama.listModels(); } catch { return []; }
  return models
    .filter(isSub3BModel)
    .map((m) => ({
      ...m,
      paramB: parseParamBillions(m.params),
    }))
    .sort((a, b) => (a.paramB || 9) - (b.paramB || 9) || a.name.localeCompare(b.name));
}

function pickModelForRole(roleId, requestedModel, available) {
  if (!available.length) return null;
  if (requestedModel) {
    const exact = available.find((m) => m.name === requestedModel || m.name.startsWith(requestedModel + ':'));
    if (exact) return exact;
  }
  // Prefer the prewarmed Fast model (lfm3:latest) so subagents start in ~1ms at ~27 tok/s
  // without loading a cold model or thrashing RAM/CPU.
  const fastPref = process.env.MXGPT_FAST_MODEL || 'lfm3:latest';
  const warmFast = available.find((m) => m.name === fastPref || /^lfm3/i.test(m.name));
  const isCoder = (m) => /coder|code|starcoder|codellama/i.test(m.name);
  if (roleId === 'coder') {
    return available.find(isCoder) || warmFast || available[0];
  }
  return warmFast || available.find((m) => !isCoder(m)) || available[0];
}

function newSubId() {
  return 'sub_' + Date.now().toString(36) + '_' + crypto.randomBytes(2).toString('hex');
}

/**
 * Run a single sub-3B parameter subagent with focused tools and streaming progress.
 */
async function runSubagent({
  id = newSubId(),
  role = 'general',
  task = '',
  context = '',
  model = '',
  useWeb = false,
  useFiles = false,
  owner = 'owner',
  signal,
  toolsModule,
  onProgress,
}) {
  const cleanTask = String(task || '').trim();
  if (!cleanTask) throw new Error('Subagent task is required');

  const available = await listSub3BModels();
  if (!available.length) {
    throw new Error('No sub-3B local models (<3B parameters) are installed in Ollama. Pull one such as qwen2.5:1.5b or qwen2.5-coder:1.5b.');
  }

  const roleKey = ROLES[String(role || '').toLowerCase()] ? String(role).toLowerCase() : 'general';
  const roleCfg = ROLES[roleKey];
  const chosen = pickModelForRole(roleKey, model, available);
  const startedAt = Date.now();

  const supportsTools = !chosen.capabilities?.length || chosen.capabilities.includes('tools');
  const allowedToolNames = supportsTools && toolsModule
    ? roleCfg.tools({ useWeb, useFiles }).filter((n) => n !== 'delegate_subagent' && n !== 'delegate_parallel')
    : [];
  const toolDefs = allowedToolNames.length && toolsModule ? toolsModule.defsFor(allowedToolNames) : [];

  onProgress?.({
    type: 'start',
    id,
    role: roleKey,
    roleLabel: roleCfg.label,
    task: cleanTask.slice(0, 240),
    model: chosen.name,
    params: chosen.params || (chosen.paramB ? `${chosen.paramB}B` : '<3B'),
    startedAt,
  });

  const userPrompt = context && String(context).trim()
    ? `Task:\n${cleanTask}\n\nContext:\n${String(context).trim().slice(0, 12000)}`
    : cleanTask;

  const messages = [
    { role: 'system', content: roleCfg.prompt },
    { role: 'user', content: userPrompt },
  ];

  const subTools = [];
  let fullContent = '';
  let evalTokens = 0;
  let lastTokSec = 0;
  const MAX_ROUNDS = 4;

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const finalRound = round === MAX_ROUNDS;
      const result = await ollama.streamChat({
        model: chosen.name,
        messages: finalRound
          ? [...messages, { role: 'system', content: 'Provide your final concise answer now without calling more tools.' }]
          : messages,
        tools: finalRound ? [] : toolDefs,
        options: {
          temperature: roleCfg.temperature,
          num_ctx: 32768,
          num_predict: 1200,
          num_thread: Number(process.env.MXGPT_NUM_THREAD || 20),
        },
        keepAlive: -1,
        think: 'off',
        capabilities: chosen.capabilities || [],
        user: owner,
        priority: 'subagent',
        signal,
        onEvent: (ev) => {
          if (ev.type === 'queue') {
            onProgress?.({ type: 'queue', id, position: ev.position || 0, acquired: !!ev.acquired, runningLabel: ev.runningLabel || '' });
          } else if (ev.type === 'text' && ev.delta) {
            fullContent += ev.delta;
            onProgress?.({ type: 'delta', id, delta: ev.delta });
          }
        },
      });
      evalTokens += result.meta?.evalTokens || 0;
      if (result.meta?.tokensPerSec) lastTokSec = result.meta.tokensPerSec;

      if (!result.tool_calls?.length || finalRound) break;

      messages.push({
        role: 'assistant',
        content: result.content || '',
        tool_calls: result.tool_calls.map((tc) => ({ function: { name: tc.name, arguments: tc.args } })),
      });

      for (const call of result.tool_calls) {
        if (signal?.aborted) break;
        if (!allowedToolNames.includes(call.name)) {
          messages.push({ role: 'tool', tool_name: call.name, content: `Tool not available to ${roleCfg.label} subagent.` });
          continue;
        }
        const entry = { name: call.name, args: call.args, status: 'running' };
        subTools.push(entry);
        onProgress?.({ type: 'tool', id, tool: entry });
        try {
          const out = await toolsModule.execute(call.name, call.args || {}, { owner, isSubagent: true });
          entry.status = 'ok';
          entry.summary = String(out.text || '').slice(0, 140);
          messages.push({ role: 'tool', tool_name: call.name, content: String(out.text || '').slice(0, 8000) });
        } catch (err) {
          entry.status = 'error';
          entry.summary = err.message;
          messages.push({ role: 'tool', tool_name: call.name, content: `Tool error: ${err.message}` });
        }
        onProgress?.({ type: 'tool', id, tool: entry });
      }
      if (signal?.aborted) break;
    }

    const elapsedMs = Date.now() - startedAt;
    const finalRes = {
      id,
      ok: true,
      role: roleKey,
      roleLabel: roleCfg.label,
      task: cleanTask.slice(0, 240),
      model: chosen.name,
      params: chosen.params || (chosen.paramB ? `${chosen.paramB}B` : '<3B'),
      content: fullContent.trim() || '(no output)',
      tools: subTools,
      elapsedMs,
      evalTokens,
      tokensPerSec: lastTokSec,
    };
    onProgress?.({ type: 'done', ...finalRes });
    return finalRes;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const failRes = {
      id,
      ok: false,
      role: roleKey,
      roleLabel: roleCfg.label,
      task: cleanTask.slice(0, 240),
      model: chosen.name,
      params: chosen.params || '<3B',
      error: err.message || 'Subagent failed',
      content: fullContent.trim(),
      tools: subTools,
      elapsedMs,
    };
    onProgress?.({ type: 'done', ...failRes });
    throw err;
  }
}

/**
 * Run 1-4 independent sub-3B subagent tasks cleanly through the inference queue.
 * Emits all cards immediately (queued -> running -> ok) so the UI shows the full
 * subtask plan right away while executing without CPU thread contention.
 */
async function runParallelSubagents({ tasks = [], useWeb = false, useFiles = false, owner = 'owner', signal, toolsModule, onProgress }) {
  const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.task).slice(0, 4);
  if (!list.length) throw new Error('At least one subtask is required');

  const available = await listSub3BModels();
  const prepared = list.map((t) => {
    const id = newSubId();
    const roleKey = ROLES[String(t.role || '').toLowerCase()] ? String(t.role).toLowerCase() : 'general';
    const roleCfg = ROLES[roleKey];
    const chosen = pickModelForRole(roleKey, t.model || '', available);
    return { t, id, roleKey, roleCfg, chosen };
  });

  // Pre-announce all subagents as queued so the UI renders the full grid immediately
  if (prepared.length > 1) {
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      onProgress?.({
        type: 'queued',
        id: p.id,
        role: p.roleKey,
        roleLabel: p.roleCfg.label,
        task: String(p.t.task || '').trim().slice(0, 240),
        model: p.chosen?.name || '',
        params: p.chosen?.params || (p.chosen?.paramB ? `${p.chosen.paramB}B` : '<3B'),
        position: i + 1,
      });
    }
  }

  const results = new Array(prepared.length);
  // Single-slot local CPU runs fastest when subagents execute sequentially through the
  // priority lane (~27 tok/s each with zero thread thrashing).
  for (let idx = 0; idx < prepared.length; idx++) {
    if (signal?.aborted) break;
    const p = prepared[idx];
    try {
      results[idx] = await runSubagent({
        id: p.id,
        role: p.roleKey,
        task: p.t.task,
        context: p.t.context || '',
        model: p.t.model || '',
        useWeb,
        useFiles,
        owner,
        signal,
        toolsModule,
        onProgress,
      });
    } catch (err) {
      results[idx] = {
        id: p.id,
        ok: false,
        role: p.roleKey,
        roleLabel: p.roleCfg.label,
        task: String(p.t.task || '').slice(0, 200),
        error: err.message,
      };
    }
  }
  return results.filter(Boolean);
}

module.exports = {
  ROLES,
  MAX_PARAM_B,
  parseParamBillions,
  isSub3BModel,
  listSub3BModels,
  pickModelForRole,
  runSubagent,
  runParallelSubagents,
};
