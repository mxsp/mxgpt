'use strict';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const S = {
  settings: null,
  quickFolders: [],
  mode: 'copilot',
  think: 'low',
  chats: [],
  chat: null,
  messages: [],
  streaming: false,
  abortCtrl: null,
  pinnedFiles: [],
  cwd: '',
  drafts: [],
  activeDraftId: null,
  briefs: [],
  undo: [],
  drawerTab: 'files',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

// Lightweight safe Markdown renderer (hides raw email-draft / file-actions JSON blocks cleanly)
function renderMd(raw) {
  let src = String(raw || '')
    .replace(/```email-draft[\s\S]*?```/gi, '')
    .replace(/```file-actions[\s\S]*?```/gi, '')
    .trim();
  if (!src) return '';

  const blocks = [];
  src = src.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/gi, (_, lang, code) => {
    const idx = blocks.length;
    blocks.push(`<pre><code class="lang-${esc(lang)}">${esc(code.trimEnd())}</code></pre>`);
    return `\x00BLK${idx}\x00`;
  });

  const lines = src.split(/\r?\n/);
  const out = [];
  let inUl = false;
  let inOl = false;
  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };

  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  for (const line of lines) {
    if (/^\x00BLK\d+\x00$/.test(line.trim())) {
      closeLists();
      out.push(line.trim());
      continue;
    }
    const hm = line.match(/^(#{1,3})\s+(.+)$/);
    if (hm) {
      closeLists();
      out.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`);
      continue;
    }
    const ulm = line.match(/^\s*[-*•]\s+(.+)$/);
    if (ulm) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${inline(ulm[1])}</li>`);
      continue;
    }
    const olm = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olm) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${inline(olm[1])}</li>`);
      continue;
    }
    if (!line.trim()) {
      closeLists();
      continue;
    }
    closeLists();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeLists();

  return out.join('\n').replace(/\x00BLK(\d+)\x00/g, (_, i) => blocks[Number(i)] || '');
}

const MODE_HINTS = {
  fast: 'Fast: LFM3 1.7B direct (~27 t/s) · instant answers & quick edits',
  smart: 'Smart: Inkling 26B direct · deep reasoning & writing',
  copilot: 'Copilot: Smart plans & synthesizes · Fast delegates file/web retrieval',
};

function setMode(m) {
  S.mode = m;
  $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#modeHint').textContent = MODE_HINTS[m] || '';
}

function setThink(t) {
  S.think = t;
  $$('#thinkSeg button').forEach((b) => b.classList.toggle('on', b.dataset.think === t));
}

function setDrawerTab(tab) {
  S.drawerTab = tab;
  $('#app').classList.remove('drawer-closed');
  $$('#drawerTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
  if (tab === 'files') loadFiles(S.cwd);
  if (tab === 'email') loadDrafts();
  if (tab === 'research') loadBriefs();
  if (tab === 'undo') loadUndo();
}

// ---- Boot & Settings
async function boot() {
  const data = await api('/api/settings');
  S.settings = data.settings;
  S.quickFolders = data.quickFolders || [];
  document.documentElement.dataset.theme = S.settings.theme || 'light';
  setMode(S.settings.defaultMode || 'copilot');
  setThink(S.settings.think || 'low');
  renderWorkspaceBox();
  await Promise.all([loadChats(), loadFiles(''), loadDrafts(), loadBriefs(), loadUndo()]);
  checkConnectionQuiet();
}

function renderWorkspaceBox() {
  const ws = S.settings?.workspace || '';
  $('#wsPath').textContent = ws;
  $('#wsPath').title = ws;
  const q = $('#wsQuick');
  q.innerHTML = '';
  for (const f of S.quickFolders) {
    const btn = document.createElement('button');
    btn.textContent = f.label;
    btn.title = f.path;
    btn.onclick = async () => {
      await api('/api/settings', { method: 'POST', body: { workspace: f.path } });
      S.settings.workspace = f.path;
      S.cwd = '';
      S.pinnedFiles = [];
      renderWorkspaceBox();
      renderPinned();
      loadFiles('');
      toast(`Workspace → ${f.label}`);
    };
    q.appendChild(btn);
  }
}

async function checkConnectionQuiet() {
  const pill = $('#connPill');
  const lbl = $('#connLabel');
  try {
    const r = await api('/api/endpoint/test', { method: 'POST', body: {} });
    pill.className = 'conn-pill ok';
    const host = new URL(r.endpointUrl).host;
    lbl.textContent = `${host} · ${r.latencyMs}ms`;
  } catch (e) {
    pill.className = 'conn-pill err';
    lbl.textContent = S.settings?.username ? 'Endpoint error — click' : 'Sign in to endpoint';
  }
}

// ---- Chats
async function loadChats() {
  const d = await api('/api/chats');
  S.chats = d.chats || [];
  const list = $('#chatList');
  list.innerHTML = '';
  for (const c of S.chats) {
    const row = document.createElement('div');
    row.className = 'chat-row' + (S.chat?.id === c.id ? ' active' : '');
    const icon = c.mode === 'fast' ? '⚡' : c.mode === 'smart' ? '◆' : '✦';
    row.innerHTML = `<span class="cr-mode">${icon}</span><span class="cr-title">${esc(c.title)}</span><button class="cr-del" title="Delete">✕</button>`;
    row.onclick = (e) => {
      if (e.target.closest('.cr-del')) return;
      openChat(c.id);
    };
    row.querySelector('.cr-del').onclick = async (e) => {
      e.stopPropagation();
      await api(`/api/chats/${c.id}`, { method: 'DELETE' });
      if (S.chat?.id === c.id) { S.chat = null; S.messages = []; renderMessages(); }
      loadChats();
    };
    list.appendChild(row);
  }
}

async function openChat(id) {
  const d = await api(`/api/chats/${id}`);
  S.chat = d.chat;
  S.messages = d.chat.messages || [];
  if (d.chat.mode) setMode(d.chat.mode);
  renderMessages();
  loadChats();
}

function newChat() {
  S.chat = null;
  S.messages = [];
  renderMessages();
  loadChats();
  $('#promptInput').focus();
}

// ---- Rendering Messages & Coworker Cards
function renderPinned() {
  const bar = $('#pinnedBar');
  if (!S.pinnedFiles.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = S.pinnedFiles.map((p) =>
    `<span class="pin-chip">📄 ${esc(p)} <button data-unpin="${esc(p)}">×</button></span>`
  ).join('');
  $$('[data-unpin]', bar).forEach((b) => {
    b.onclick = () => {
      S.pinnedFiles = S.pinnedFiles.filter((x) => x !== b.dataset.unpin);
      renderPinned();
      loadFiles(S.cwd);
    };
  });
}

function renderCopilotPanel(msg) {
  if (!msg.plan && !(msg.workers && msg.workers.length)) return null;
  const panel = document.createElement('div');
  panel.className = 'copilot-panel';
  const workers = msg.workers || [];
  const running = workers.filter((w) => w.status === 'running').length;
  const done = workers.filter((w) => w.status === 'done' || w.ok).length;

  const head = document.createElement('div');
  head.className = 'cp-head';
  head.innerHTML = `
    <span class="cp-title">✦ Copilot Plan: ${esc(msg.plan?.goal || 'Orchestrating')}</span>
    <span class="cp-flow">${workers.length ? `Smart → ${workers.length} Fast worker${workers.length > 1 ? 's' : ''} (${done}/${workers.length} done${running ? ', running' : ''}) → Smart` : 'Smart direct'}</span>`;
  panel.appendChild(head);

  if (workers.length) {
    const grid = document.createElement('div');
    grid.className = 'cp-grid';
    for (const w of workers) {
      const card = document.createElement('div');
      const isRun = w.status === 'running';
      const isErr = w.status === 'error' || w.ok === false;
      card.className = 'worker-card' + (isRun ? ' running open' : isErr ? ' error' : '');
      const stat = isRun
        ? `<span class="wk-stat"><span class="spin"></span>Running</span>`
        : isErr
          ? `<span class="wk-stat err">Failed</span>`
          : `<span class="wk-stat done">✓ ${w.elapsedMs ? (w.elapsedMs / 1000).toFixed(1) + 's' : 'Done'}${w.tokensPerSec ? ' · ' + w.tokensPerSec + ' t/s' : ''}</span>`;
      card.innerHTML = `
        <div class="wk-head">
          <span class="wk-role" data-role="${esc(w.role || 'analyst')}">${esc(w.label || 'Worker')}</span>
          <span class="wk-model">${esc((w.model || 'lfm3').replace(/:latest$/, ''))}</span>
          ${stat}
        </div>
        <div class="wk-task">${esc(w.task || '')}</div>
        <div class="wk-body">${esc(w.brief || w.stream || w.error || 'Retrieving…')}</div>`;
      card.querySelector('.wk-head').onclick = () => card.classList.toggle('open');
      grid.appendChild(card);
    }
    panel.appendChild(grid);
  }
  return panel;
}

function renderEmailCard(draft) {
  const card = document.createElement('div');
  card.className = 'action-card';
  card.innerHTML = `
    <div class="ac-head">
      <div class="ac-title">✉️ Email Draft Ready</div>
      <div class="pane-btns">
        <button class="mini-btn" data-em="copy">Copy</button>
        <button class="mini-btn" data-em="eml">Export .eml</button>
        <button class="mini-btn primary" data-em="edit">Open in Email Studio</button>
      </div>
    </div>
    <div class="ac-row">
      <div class="ac-desc">
        ${draft.to ? `<div><b>To:</b> ${esc(draft.to)}</div>` : ''}
        <div><b>Subject:</b> ${esc(draft.subject || '(No subject)')}</div>
        <div class="ac-reason" style="white-space:pre-wrap;margin-top:6px;color:var(--text-2)">${esc((draft.body || '').slice(0, 320))}${(draft.body || '').length > 320 ? '…' : ''}</div>
      </div>
    </div>`;
  card.querySelector('[data-em="copy"]').onclick = () => {
    navigator.clipboard?.writeText(`To: ${draft.to || ''}\nSubject: ${draft.subject || ''}\n\n${draft.body || ''}`);
    toast('Email copied');
  };
  card.querySelector('[data-em="eml"]').onclick = () => downloadEml(draft);
  card.querySelector('[data-em="edit"]').onclick = () => {
    loadDraftIntoStudio(draft);
    setDrawerTab('email');
  };
  return card;
}

function renderFileActionsCard(actions) {
  const card = document.createElement('div');
  card.className = 'action-card';
  const pendingCount = actions.filter((a) => a.status === 'pending').length;
  card.innerHTML = `
    <div class="ac-head">
      <div class="ac-title">🗂 Proposed File Actions (${actions.length})</div>
      ${pendingCount > 0 ? `<button class="mini-btn primary" data-apply-all>Apply All (${pendingCount})</button>` : '<span class="ac-stat">Processed</span>'}
    </div>`;

  for (const act of actions) {
    const row = document.createElement('div');
    row.className = 'ac-row';
    const desc = act.from && act.to
      ? `<code>${esc(act.from)}</code> → <code>${esc(act.to)}</code>`
      : `<code>${esc(act.path || act.to || act.from || '')}</code>`;
    row.innerHTML = `
      <span class="ac-verb ${esc(act.type)}">${esc(act.type)}</span>
      <div class="ac-desc">
        <div>${desc}</div>
        ${act.reason ? `<div class="ac-reason">${esc(act.reason)}</div>` : ''}
        ${act.result ? `<div class="ac-reason">${esc(act.result)}</div>` : ''}
      </div>
      <div class="pane-btns"></div>`;
    const btns = row.querySelector('.pane-btns');
    if (act.status === 'pending') {
      const appBtn = document.createElement('button');
      appBtn.className = 'mini-btn primary';
      appBtn.textContent = 'Apply';
      appBtn.onclick = async () => {
        appBtn.disabled = true;
        try {
          const r = await api('/api/files/action', { method: 'POST', body: act });
          act.status = 'applied'; act.result = r.summary; act.undoId = r.undoId;
          toast(r.summary);
          loadFiles(S.cwd); loadUndo(); renderMessages();
        } catch (e) {
          act.status = 'error'; act.result = e.message;
          toast(e.message); renderMessages();
        }
      };
      const skBtn = document.createElement('button');
      skBtn.className = 'mini-btn';
      skBtn.textContent = 'Skip';
      skBtn.onclick = () => { act.status = 'skipped'; renderMessages(); };
      btns.append(appBtn, skBtn);
    } else if (act.status === 'applied') {
      const st = document.createElement('span');
      st.className = 'ac-stat'; st.textContent = '✓ Applied';
      btns.appendChild(st);
      if (act.undoId) {
        const uBtn = document.createElement('button');
        uBtn.className = 'mini-btn'; uBtn.textContent = 'Undo';
        uBtn.onclick = async () => {
          const r = await api('/api/files/undo', { method: 'POST', body: { id: act.undoId } });
          act.status = 'pending'; act.undoId = null; act.result = r.summary;
          toast(r.summary); loadFiles(S.cwd); loadUndo(); renderMessages();
        };
        btns.appendChild(uBtn);
      }
    } else if (act.status === 'skipped') {
      btns.innerHTML = '<span style="font-size:11px;color:var(--muted)">Skipped</span>';
    } else if (act.status === 'error') {
      btns.innerHTML = '<span class="ac-stat err">Failed</span>';
    }
    card.appendChild(row);
  }

  const allBtn = card.querySelector('[data-apply-all]');
  if (allBtn) {
    allBtn.onclick = async () => {
      allBtn.disabled = true;
      for (const act of actions) {
        if (act.status !== 'pending') continue;
        try {
          const r = await api('/api/files/action', { method: 'POST', body: act });
          act.status = 'applied'; act.result = r.summary; act.undoId = r.undoId;
        } catch (e) {
          act.status = 'error'; act.result = e.message;
        }
      }
      toast('Applied file actions');
      loadFiles(S.cwd); loadUndo(); renderMessages();
    };
  }
  return card;
}

function renderMessages() {
  const wrap = $('#messages');
  $('#welcome').classList.toggle('hidden', S.messages.length > 0);
  wrap.innerHTML = '';

  for (const m of S.messages) {
    const el = document.createElement('div');
    el.className = `msg ${m.role}`;
    if (m.role === 'user') {
      el.innerHTML = `<div class="bubble">${esc(m.content)}</div>`;
      wrap.appendChild(el);
      continue;
    }

    const modeCls = m.mode || 'copilot';
    const spd = m.usage?.tokensPerSec ? `${m.usage.tokensPerSec} t/s` : '';
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = `<span class="mode-tag ${esc(modeCls)}">${esc(modeCls)}</span>${m.model ? `<span>${esc(m.model.replace(/:latest$/, ''))}</span>` : ''}${spd ? `<span>· ${esc(spd)}</span>` : ''}`;
    el.appendChild(meta);

    if (m.livePhase) {
      const ph = document.createElement('div');
      ph.className = 'live-phase' + (m.queuePos ? ' queued' : '');
      ph.innerHTML = `<span class="spin"></span><span>${esc(m.livePhase)}</span>`;
      el.appendChild(ph);
    }

    const cp = renderCopilotPanel(m);
    if (cp) el.appendChild(cp);

    if (m.thinking) {
      const th = document.createElement('details');
      th.className = 'think-box';
      th.innerHTML = `<summary>Reasoning (${m.thinking.length} chars)</summary><pre>${esc(m.thinking)}</pre>`;
      el.appendChild(th);
    }

    if (m.content) {
      const pr = document.createElement('div');
      pr.className = 'prose';
      pr.innerHTML = renderMd(m.content);
      el.appendChild(pr);
    }

    if (m.emailDraft) el.appendChild(renderEmailCard(m.emailDraft));
    if (m.fileActions?.length) el.appendChild(renderFileActionsCard(m.fileActions));

    if (m.sources?.length) {
      const sr = document.createElement('div');
      sr.className = 'sources-row';
      for (const s of m.sources.slice(0, 10)) {
        if (s.type === 'url' && s.url) {
          const a = document.createElement('a');
          a.className = 'src-pill'; a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
          a.innerHTML = `🌐 <span>${esc(s.title || s.url)}</span>`;
          sr.appendChild(a);
        } else if (s.path) {
          const b = document.createElement('button');
          b.className = 'src-pill';
          b.innerHTML = `📄 <span>${esc(s.path)}</span>`;
          b.onclick = () => { setDrawerTab('files'); previewFile(s.path); };
          sr.appendChild(b);
        }
      }
      el.appendChild(sr);
    }

    if (!m.streaming && m.content) {
      const bar = document.createElement('div');
      bar.className = 'msg-bar';
      const cpBtn = document.createElement('button');
      cpBtn.className = 'mini-btn'; cpBtn.textContent = 'Copy';
      cpBtn.onclick = () => { navigator.clipboard?.writeText(m.content); toast('Copied'); };
      const svBtn = document.createElement('button');
      svBtn.className = 'mini-btn'; svBtn.textContent = 'Save as Research Brief';
      svBtn.onclick = async () => {
        await api('/api/research/briefs', {
          method: 'POST',
          body: { title: (m.plan?.goal || S.chat?.title || 'Research Brief').slice(0, 80), markdown: m.content, sources: m.sources || [] },
        });
        toast('Saved to Research Desk');
        loadBriefs();
      };
      bar.append(cpBtn, svBtn);
      el.appendChild(bar);
    }

    wrap.appendChild(el);
  }
  const feed = $('#feed');
  feed.scrollTop = feed.scrollHeight;
}

// ---- Send / Stream Cowork Turn
async function sendPrompt(overrideText = null) {
  if (S.streaming) {
    if (S.chat?.id) api('/api/cowork/stop', { method: 'POST', body: { chatId: S.chat.id } }).catch(() => {});
    S.abortCtrl?.abort();
    return;
  }
  const input = $('#promptInput');
  const prompt = (overrideText !== null ? overrideText : input.value).trim();
  if (!prompt) return;
  if (overrideText === null) { input.value = ''; input.style.height = 'auto'; }

  S.messages.push({ id: 'tmp-u', role: 'user', content: prompt });
  const assistant = {
    id: 'tmp-a',
    role: 'assistant',
    mode: S.mode,
    content: '',
    thinking: '',
    plan: null,
    workers: [],
    sources: [],
    emailDraft: null,
    fileActions: [],
    livePhase: S.mode === 'copilot' ? 'Smart Orchestrator planning…' : 'Connecting…',
    queuePos: 0,
    streaming: true,
  };
  S.messages.push(assistant);
  S.streaming = true;
  S.abortCtrl = new AbortController();
  $('#sendBtn').classList.add('stop');
  $('#sendBtn').textContent = 'Stop ■';
  renderMessages();

  const activeDraft = ($('#mailSubject').value || $('#mailBody').value)
    ? { to: $('#mailTo').value, cc: $('#mailCc').value, subject: $('#mailSubject').value, body: $('#mailBody').value }
    : null;

  let renderTimer = null;
  const scheduleRender = () => {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; renderMessages(); }, 70);
  };

  try {
    const res = await fetch('/api/cowork/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: S.chat?.id || null,
        mode: S.mode,
        think: S.think,
        prompt,
        pinnedFiles: S.pinnedFiles,
        activeDraft,
      }),
      signal: S.abortCtrl.signal,
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    const handleBlock = (raw) => {
      let ev = '';
      const dl = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) dl.push(line.slice(5).trim());
      }
      if (!ev || !dl.length) return;
      let d;
      try { d = JSON.parse(dl.join('\n')); } catch { return; }

      if (ev === 'chat' && d.chat) {
        S.chat = d.chat;
        loadChats();
      } else if (ev === 'phase') {
        assistant.queuePos = 0;
        assistant.livePhase = d.label || d.phase;
        scheduleRender();
      } else if (ev === 'queue') {
        if (d.acquired || !d.position) {
          assistant.queuePos = 0;
          assistant.livePhase = 'Preparing response…';
        } else {
          assistant.queuePos = d.position;
          assistant.livePhase = `Queued #${d.position}${d.runningLabel ? ` · waiting for ${d.runningLabel}` : ''}`;
        }
        scheduleRender();
      } else if (ev === 'copilot_plan') {
        assistant.plan = d;
        scheduleRender();
      } else if (ev === 'worker_start') {
        assistant.workers.push({ ...d, status: 'running', stream: '' });
        scheduleRender();
      } else if (ev === 'worker_delta') {
        const w = assistant.workers.find((x) => x.id === d.id);
        if (w) { w.stream = (w.stream || '') + (d.delta || ''); scheduleRender(); }
      } else if (ev === 'worker_done') {
        const w = assistant.workers.find((x) => x.id === d.id);
        if (w) { Object.assign(w, d, { status: d.ok ? 'done' : 'error' }); scheduleRender(); }
      } else if (ev === 'thinking') {
        assistant.queuePos = 0;
        assistant.livePhase = 'Thinking…';
        assistant.thinking += d.delta || '';
        scheduleRender();
      } else if (ev === 'text') {
        assistant.livePhase = '';
        assistant.content += d.delta || '';
        scheduleRender();
      } else if (ev === 'email_draft_saved' || ev === 'email_draft') {
        assistant.emailDraft = d;
        loadDraftIntoStudio(d);
        loadDrafts();
        scheduleRender();
      } else if (ev === 'file_actions') {
        assistant.fileActions = d;
        scheduleRender();
      } else if (ev === 'sources') {
        assistant.sources = d;
        scheduleRender();
      } else if (ev === 'done') {
        Object.assign(assistant, d.message || {}, { streaming: false, livePhase: '' });
        renderMessages();
        loadChats();
      } else if (ev === 'error') {
        assistant.livePhase = '';
        assistant.streaming = false;
        assistant.content += `\n\n> **Error:** ${d.message}`;
        toast(d.message, 4000);
        renderMessages();
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        handleBlock(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
      }
    }
    if (buf.trim()) handleBlock(buf);
  } catch (e) {
    if (e.name !== 'AbortError') {
      assistant.content += `\n\n> **Error:** ${e.message}`;
      toast(e.message, 4000);
    }
  } finally {
    assistant.streaming = false;
    assistant.livePhase = '';
    S.streaming = false;
    S.abortCtrl = null;
    $('#sendBtn').classList.remove('stop');
    $('#sendBtn').textContent = 'Send ↑';
    renderMessages();
  }
}

// ---- Files Pane
async function loadFiles(relPath = '') {
  try {
    const d = await api(`/api/files/list?path=${encodeURIComponent(relPath)}`);
    S.cwd = d.path || '';
    $('#fileCrumb').textContent = '/' + S.cwd;
    const list = $('#fileList');
    list.innerHTML = '';

    if (S.cwd) {
      const parent = S.cwd.includes('/') ? S.cwd.slice(0, S.cwd.lastIndexOf('/')) : '';
      const up = document.createElement('div');
      up.className = 'f-item';
      up.innerHTML = `<span>↩</span><span class="f-name">..</span>`;
      up.onclick = () => loadFiles(parent);
      list.appendChild(up);
    }

    for (const it of d.items) {
      const row = document.createElement('div');
      row.className = 'f-item';
      const pinned = S.pinnedFiles.includes(it.relPath);
      row.innerHTML = `
        <span>${it.isDir ? '📁' : '📄'}</span>
        <span class="f-name" title="${esc(it.relPath)}">${esc(it.name)}</span>
        ${it.isDir ? '' : `<span class="f-size">${esc(it.sizeLabel)}</span><button class="f-pin ${pinned ? 'on' : ''}">${pinned ? 'Pinned' : 'Pin'}</button>`}`;
      row.onclick = (e) => {
        if (e.target.closest('.f-pin')) return;
        if (it.isDir) loadFiles(it.relPath);
        else previewFile(it.relPath);
      };
      const pinBtn = row.querySelector('.f-pin');
      if (pinBtn) {
        pinBtn.onclick = (e) => {
          e.stopPropagation();
          togglePin(it.relPath);
        };
      }
      list.appendChild(row);
    }
  } catch (e) {
    $('#fileList').innerHTML = `<div class="muted-note">Could not read folder: ${esc(e.message)}</div>`;
  }
}

function togglePin(relPath) {
  if (S.pinnedFiles.includes(relPath)) S.pinnedFiles = S.pinnedFiles.filter((x) => x !== relPath);
  else S.pinnedFiles.push(relPath);
  renderPinned();
  loadFiles(S.cwd);
}

async function searchLocalFiles() {
  const q = $('#fileSearchInput').value.trim();
  if (!q) { loadFiles(S.cwd); return; }
  $('#fileList').innerHTML = '<div class="muted-note">Searching files &amp; contents…</div>';
  try {
    const d = await api(`/api/files/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(S.cwd)}`);
    const list = $('#fileList');
    list.innerHTML = `<div class="muted-note" style="padding:2px 6px">${d.results.length} matches (scanned ${d.scanned} files)</div>`;
    for (const hit of d.results) {
      const box = document.createElement('div');
      const pinned = S.pinnedFiles.includes(hit.relPath);
      box.innerHTML = `
        <div class="f-item">
          <span>📄</span>
          <span class="f-name" title="${esc(hit.relPath)}">${esc(hit.relPath)}</span>
          <span class="f-size">${esc(hit.sizeLabel)}</span>
          <button class="f-pin ${pinned ? 'on' : ''}">${pinned ? 'Pinned' : 'Pin'}</button>
        </div>
        ${hit.snippet ? `<div class="f-snip">${esc(hit.snippet)}</div>` : ''}`;
      box.querySelector('.f-item').onclick = (e) => {
        if (e.target.closest('.f-pin')) return;
        previewFile(hit.relPath);
      };
      box.querySelector('.f-pin').onclick = (e) => { e.stopPropagation(); togglePin(hit.relPath); };
      list.appendChild(box);
    }
  } catch (e) {
    toast(e.message);
  }
}

async function previewFile(relPath) {
  try {
    const d = await api(`/api/files/read?path=${encodeURIComponent(relPath)}`);
    $('#filePreview').hidden = false;
    $('#fpName').textContent = d.path;
    $('#fpBody').textContent = d.content;
    $('#fpPinBtn').onclick = () => togglePin(d.path);
  } catch (e) {
    toast(e.message);
  }
}

// ---- Email Studio
function loadDraftIntoStudio(d) {
  S.activeDraftId = d.id || null;
  $('#mailTo').value = d.to || '';
  $('#mailCc').value = d.cc || '';
  $('#mailSubject').value = d.subject || '';
  $('#mailBody').value = d.body || '';
}

async function loadDrafts() {
  const d = await api('/api/email/drafts');
  S.drafts = d.drafts || [];
  const list = $('#draftsList');
  list.innerHTML = S.drafts.length ? '' : '<div class="muted-note">No saved drafts yet. Ask Copilot to draft an email!</div>';
  for (const dr of S.drafts) {
    const card = document.createElement('div');
    card.className = 'saved-card';
    card.innerHTML = `<div class="sc-row"><b>${esc(dr.subject || '(No subject)')}</b><button class="mini-btn danger">✕</button></div><small>${esc(dr.to || 'No recipient')} · ${new Date(dr.updatedAt).toLocaleDateString()}</small>`;
    card.onclick = (e) => { if (!e.target.closest('button')) loadDraftIntoStudio(dr); };
    card.querySelector('button').onclick = async (e) => {
      e.stopPropagation();
      await api(`/api/email/drafts/${dr.id}`, { method: 'DELETE' });
      loadDrafts();
    };
    list.appendChild(card);
  }
}

async function downloadEml(draft) {
  const r = await fetch('/api/email/eml', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = ((draft.subject || 'email-draft').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48) || 'email-draft') + '.eml';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---- Research Desk
async function loadBriefs() {
  const d = await api('/api/research/briefs');
  S.briefs = d.briefs || [];
  const list = $('#briefsList');
  list.innerHTML = S.briefs.length ? '' : '<div class="muted-note">Save any Copilot research output here or export it to your workspace.</div>';
  for (const b of S.briefs) {
    const card = document.createElement('div');
    card.className = 'saved-card';
    card.innerHTML = `
      <div class="sc-row"><b>${esc(b.title)}</b><button class="mini-btn danger" data-del>✕</button></div>
      <small>${new Date(b.updatedAt).toLocaleString()}</small>
      <div class="pane-btns" style="margin-top:4px">
        <button class="mini-btn" data-save-md>Save .md to Workspace</button>
        <button class="mini-btn" data-mail>Draft Email</button>
      </div>`;
    card.querySelector('[data-del]').onclick = async () => {
      await api(`/api/research/briefs/${b.id}`, { method: 'DELETE' });
      loadBriefs();
    };
    card.querySelector('[data-save-md]').onclick = async () => {
      const slug = b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'research-brief';
      const rel = `${slug}.md`;
      const r = await api('/api/files/action', { method: 'POST', body: { type: 'write', path: rel, content: `# ${b.title}\n\n${b.markdown}\n` } });
      toast(r.summary);
      loadFiles(S.cwd); loadUndo();
    };
    card.querySelector('[data-mail]').onclick = () => {
      loadDraftIntoStudio({ subject: b.title, body: b.markdown });
      setDrawerTab('email');
    };
    list.appendChild(card);
  }
}

async function quickResearch() {
  const q = $('#resSearchInput').value.trim();
  if (!q) return;
  const out = $('#resLive');
  out.innerHTML = '<div class="muted-note">Searching DuckDuckGo + Wikipedia…</div>';
  try {
    const d = await api(`/api/research/search?q=${encodeURIComponent(q)}`);
    out.innerHTML = '';
    if (d.wiki) {
      const w = document.createElement('div');
      w.className = 'saved-card';
      w.innerHTML = `<b>Wikipedia: ${esc(d.wiki.title)}</b><small>${esc(d.wiki.extract.slice(0, 220))}…</small>`;
      w.onclick = () => window.open(d.wiki.url, '_blank');
      out.appendChild(w);
    }
    for (const r of d.results || []) {
      const c = document.createElement('div');
      c.className = 'saved-card';
      c.innerHTML = `<b>${esc(r.title)}</b><small>${esc(r.snippet.slice(0, 160))}</small>`;
      c.onclick = () => window.open(r.url, '_blank');
      out.appendChild(c);
    }
    const askBtn = document.createElement('button');
    askBtn.className = 'mini-btn primary';
    askBtn.textContent = '✦ Run full Copilot Deep Research on this';
    askBtn.onclick = () => { setMode('copilot'); sendPrompt(`Research "${q}" thoroughly and write a clear, cited executive brief.`); };
    out.appendChild(askBtn);
  } catch (e) {
    out.innerHTML = `<div class="muted-note">Search failed: ${esc(e.message)}</div>`;
  }
}

// ---- Undo Log
async function loadUndo() {
  const d = await api('/api/files/undo');
  S.undo = d.history || [];
  const cnt = $('#undoCount');
  cnt.textContent = String(S.undo.length);
  cnt.hidden = S.undo.length === 0;
  const list = $('#undoList');
  list.innerHTML = S.undo.length ? '' : '<div class="muted-note">No file operations recorded yet.</div>';
  for (const u of S.undo) {
    const card = document.createElement('div');
    card.className = 'saved-card';
    card.innerHTML = `<div class="sc-row"><b>${esc(u.summary)}</b><button class="mini-btn">Undo</button></div><small>${new Date(u.ts).toLocaleString()}</small>`;
    card.querySelector('button').onclick = async () => {
      try {
        const r = await api('/api/files/undo', { method: 'POST', body: { id: u.id } });
        toast(r.summary);
        loadUndo(); loadFiles(S.cwd);
      } catch (e) { toast(e.message); }
    };
    list.appendChild(card);
  }
}

// ---- Settings Modal
function openSettings() {
  const s = S.settings || {};
  $('#setEndpointType').value = s.endpointType || 'mxgpt';
  $('#setEndpointUrl').value = s.endpointUrl || 'https://max.fyreflysystems.de';
  $('#setUsername').value = s.username || '';
  $('#setPassword').value = '';
  $('#setPassword').placeholder = s.hasPassword ? '•••••••• (saved — leave blank to keep)' : 'Enter password';
  $('#setFastModel').value = s.fastModel || 'lfm3:latest';
  $('#setSmartModel').value = s.smartModel || 'inkling-2-mini:latest';
  $('#setWorkspace').value = s.workspace || '';
  $('#setSignature').value = s.emailSignature || '';
  $('#setAutoApprove').checked = !!s.autoApproveFileActions;
  $('#authFields').style.display = ($('#setEndpointType').value === 'mxgpt') ? 'flex' : 'none';
  $('#testOut').hidden = true;
  $('#settingsModal').hidden = false;
}

function collectSettingsForm() {
  const pw = $('#setPassword').value;
  return {
    endpointType: $('#setEndpointType').value,
    endpointUrl: $('#setEndpointUrl').value.trim(),
    username: $('#setUsername').value.trim(),
    password: pw ? pw : '__KEEP__',
    fastModel: $('#setFastModel').value.trim() || 'lfm3:latest',
    smartModel: $('#setSmartModel').value.trim() || 'inkling-2-mini:latest',
    workspace: $('#setWorkspace').value.trim(),
    emailSignature: $('#setSignature').value,
    autoApproveFileActions: $('#setAutoApprove').checked,
  };
}

// ---- Event Wiring
$('#modeSeg').onclick = (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setMode(b.dataset.mode);
};
$('#thinkSeg').onclick = (e) => {
  const b = e.target.closest('button[data-think]');
  if (b) setThink(b.dataset.think);
};
$('#drawerTabs').onclick = (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setDrawerTab(b.dataset.tab);
};
$('#toggleDrawerBtn').onclick = () => $('#app').classList.toggle('drawer-closed');
$('#newChatBtn').onclick = newChat;
$('#themeBtn').onclick = async () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  await api('/api/settings', { method: 'POST', body: { theme: next } });
};
$('#openSettingsBtn').onclick = openSettings;
$('#connPill').onclick = openSettings;
$('#wsEditBtn').onclick = openSettings;
$('#closeSettingsBtn').onclick = () => { $('#settingsModal').hidden = true; };
$('#setEndpointType').onchange = () => {
  const isMxgpt = $('#setEndpointType').value === 'mxgpt';
  $('#authFields').style.display = isMxgpt ? 'flex' : 'none';
  if (isMxgpt && !$('#setEndpointUrl').value.includes('fyrefly')) $('#setEndpointUrl').value = 'https://max.fyreflysystems.de';
  if (!isMxgpt && $('#setEndpointUrl').value.includes('fyrefly')) $('#setEndpointUrl').value = 'http://127.0.0.1:11434';
};
$('#testConnBtn').onclick = async () => {
  const out = $('#testOut');
  out.hidden = false; out.className = 'test-out'; out.textContent = 'Testing connection…';
  try {
    const r = await api('/api/endpoint/test', { method: 'POST', body: collectSettingsForm() });
    out.className = 'test-out ok';
    out.textContent = `Connected to ${r.endpointUrl} (${r.latencyMs}ms) · ${r.models.length} models available: ${r.models.map((m) => m.name).slice(0, 5).join(', ')}`;
  } catch (e) {
    out.className = 'test-out err';
    out.textContent = `Connection failed: ${e.message}`;
  }
};
$('#saveSettingsBtn').onclick = async () => {
  try {
    const d = await api('/api/settings', { method: 'POST', body: collectSettingsForm() });
    S.settings = d.settings;
    S.cwd = '';
    $('#settingsModal').hidden = true;
    renderWorkspaceBox();
    loadFiles('');
    checkConnectionQuiet();
    toast('Settings saved');
  } catch (e) { toast(e.message); }
};

$('#sendBtn').onclick = () => sendPrompt();
$('#promptInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
});
$('#promptInput').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px';
});
$$('.starter').forEach((b) => {
  b.onclick = () => { setMode('copilot'); sendPrompt(b.dataset.prompt); };
});

$('#refreshFilesBtn').onclick = () => loadFiles(S.cwd);
$('#fileSearchBtn').onclick = searchLocalFiles;
$('#fileSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchLocalFiles(); });
$('#fpCloseBtn').onclick = () => { $('#filePreview').hidden = true; };
$('#auditWsBtn').onclick = () => {
  setMode('copilot');
  sendPrompt(`Audit the folder "${S.cwd || '/'}" in my workspace and propose a clean organization plan using file-actions.`);
};

$('#newDraftBtn').onclick = () => loadDraftIntoStudio({});
$('#saveDraftBtn').onclick = async () => {
  const d = await api('/api/email/drafts', {
    method: 'POST',
    body: { id: S.activeDraftId, to: $('#mailTo').value, cc: $('#mailCc').value, subject: $('#mailSubject').value, body: $('#mailBody').value },
  });
  S.activeDraftId = d.draft.id;
  loadDrafts();
  toast('Draft saved');
};
$('#copyMailBtn').onclick = () => {
  navigator.clipboard?.writeText(`To: ${$('#mailTo').value}\nSubject: ${$('#mailSubject').value}\n\n${$('#mailBody').value}`);
  toast('Copied email');
};
$('#mailtoBtn').onclick = () => {
  const u = `mailto:${encodeURIComponent($('#mailTo').value)}?cc=${encodeURIComponent($('#mailCc').value)}&subject=${encodeURIComponent($('#mailSubject').value)}&body=${encodeURIComponent($('#mailBody').value)}`;
  window.open(u, '_blank');
};
$('#exportEmlBtn').onclick = () => downloadEml({
  to: $('#mailTo').value, cc: $('#mailCc').value, subject: $('#mailSubject').value, body: $('#mailBody').value,
});
$$('[data-refine]').forEach((b) => {
  b.onclick = async () => {
    const body = $('#mailBody').value.trim();
    if (!body) { toast('Write or generate an email body first'); return; }
    b.disabled = true;
    const orig = b.textContent;
    b.textContent = '…';
    try {
      const r = await api('/api/email/refine', {
        method: 'POST',
        body: {
          action: b.dataset.refine,
          tier: S.mode === 'smart' ? 'smart' : 'fast',
          draft: { to: $('#mailTo').value, subject: $('#mailSubject').value, body },
        },
      });
      if (r.subject) $('#mailSubject').value = r.subject;
      if (r.body) $('#mailBody').value = r.body;
      toast(`Refined (${r.usage?.tokensPerSec ? r.usage.tokensPerSec + ' t/s' : 'done'})`);
    } catch (e) { toast(e.message, 4000); }
    finally { b.disabled = false; b.textContent = orig; }
  };
});

$('#resSearchBtn').onclick = quickResearch;
$('#resSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') quickResearch(); });
$('#refreshUndoBtn').onclick = loadUndo;

boot().catch((e) => toast(`Startup error: ${e.message}`, 5000));
