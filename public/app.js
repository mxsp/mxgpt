/* mx-GPT — front-end */
(() => {
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const timeAgo = (ts) => {
  const d = Date.now() - ts, m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const fmtSize = (n) => (!n ? '0 B' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const PROVIDER_PREFIX = 'prov:';
const modelShort = (ref) => {
  if (!ref) return '';
  let out = ref;
  if (ref.startsWith(PROVIDER_PREFIX)) {
    const rest = ref.slice(PROVIDER_PREFIX.length);
    const i = rest.indexOf('/');
    out = i < 0 ? rest : rest.slice(i + 1);
  }
  return out.replace(/^models\//, '');
};
const sameModel = (a, b) => !!a && !!b && (a === b || modelShort(a) === modelShort(b));
const modelProvider = (ref) => S.models.find((m) => m.name === ref)?.providerName || '';

const S = {
  chats: [],
  models: [],
  subagentModels: [],
  providers: [],
  presets: {},
  personas: [],
  persona: 'default',
  notes: [],
  settings: {},
  capabilities: { owner: true, files: true, browser: true, liveBrowser: false, settings: true, providers: true, ollamaSettings: false, ollamaEnvDaemon: false, gatewayAuth: false, lan: false },
  authRequired: false,
  chat: null,
  messages: [],
  runs: new Map(),
  unread: new Set(),
  expandedTools: new Set(),
  expandedSubagents: new Set(),
  streaming: false,
  abort: null,
  model: '',
  useSubagents: false,
  useTools: false,
  useWeb: true,
  useFiles: false,
  thinkEffort: 'low',
  mode: 'fast',
  modes: {},
  attachments: [],
  panel: null,
  panelTab: 'preview',
  artifacts: new Map(),
  activeArtifact: null,
  activeFile: null,
  fileTab: 'preview',
  fileContent: {},
  files: { path: '', entries: [], hidden: false, results: null, loading: false },
  browser: { history: [], index: -1, data: null, loading: false, tab: 'reader', url: '', title: '' },
  theme: 'light',
  booted: false,
};

/* ---------------------------------------------------------------- api */
async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const res = await fetch(path, init);
  if (res.status === 401) { location.href = '/login'; throw new Error('Not signed in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
  return data;
}
function toast(msg, ms = 2200, onClick = null) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('clickable', !!onClick);
  t.onclick = onClick ? () => { t.classList.remove('on', 'clickable'); t.onclick = null; onClick(); } : null;
  t.classList.add('on');
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.classList.remove('on', 'clickable'); t.onclick = null; }, ms);
}

/* ---------------------------------------------------------------- boot */
async function boot() {
  try {
    const b = await api('/api/bootstrap');
    S.chats = b.chats || [];
    S.models = b.models || [];
    S.modes = b.modes || {};
    S.subagentModels = b.subagentModels || [];
    S.providers = b.providers || [];
    S.presets = b.presets || {};
    S.personas = b.personas || [];
    S.settings = b.settings || {};
    S.persona = b.settings?.persona || 'default';
    S.preferred = b.settings?.preferred || {};
    S.authRequired = !!b.authRequired;
    S.theme = localStorage.getItem('mxgpt-theme') || b.settings?.theme || 'light';
    const savedModel = b.settings?.model || '';
    const savedVisible = S.models.some((m) => m.name === savedModel);
    S.mode = (S.models.find((m) => m.name === savedModel) || {}).mode || localStorage.getItem('mxgpt-mode') || 'fast';
    const modeDefault = S.models.find((m) => m.mode === S.mode);
    S.model = savedVisible
      ? savedModel
      : (modeDefault?.name || S.models.find((m) => m.capabilities?.includes('completion'))?.name || S.models[0]?.name || '');
    S.files.root = b.filesRoot;
    S.version = b.version;
    S.user = b.user?.name || 'You';
    S.capabilities = { ...S.capabilities, ...(b.capabilities || {}) };
    S.browser.tab = S.capabilities.liveBrowser ? 'live' : 'reader';
    const savedTools = localStorage.getItem('mxgpt-use-tools');
    S.useTools = savedTools === null ? false : savedTools === '1';
    const savedSub = localStorage.getItem('mxgpt-use-subagents');
    S.useSubagents = S.subagentModels.length > 0 && (savedSub === null ? false : savedSub === '1');
    const savedWeb = localStorage.getItem('mxgpt-use-web');
    S.useWeb = savedWeb === null ? true : savedWeb === '1';
    const subBtn = $('#subagentsToggle');
    if (subBtn) {
      if (!S.subagentModels.length) {
        subBtn.hidden = true;
      } else {
        const names = S.subagentModels.map((m) => `${m.name} (${m.params || '<3B'})`).join(', ');
        subBtn.title = `Subagents powered by sub-3B models: ${names}`;
      }
    }
    const savedEffort = localStorage.getItem('mxgpt-think-effort') || 'low';
    S.thinkEffort = ['off', 'low', 'medium', 'high'].includes(savedEffort) ? savedEffort : 'low';
    const tc = document.getElementById('thinkControl');
    if (tc) {
      const setEff = (v) => {
        S.thinkEffort = v;
        tc.querySelectorAll('.think-seg button').forEach((btn) => btn.classList.toggle('on', btn.dataset.v === v));
        localStorage.setItem('mxgpt-think-effort', v);
      };
      setEff(S.thinkEffort);
      tc.querySelectorAll('.think-seg button').forEach((btn) => btn.addEventListener('click', () => setEff(btn.dataset.v)));
    }
    const mc = document.getElementById('modeControl');
    if (mc) {
      mc.hidden = !S.models.some((m) => m.mode);
      mc.dataset.mode = S.mode;
      mc.querySelectorAll('.mode-seg button').forEach((btn) => btn.addEventListener('click', () => setLocalMode(btn.dataset.mode)));
    }
    const savedFiles = localStorage.getItem('mxgpt-use-files');
    S.useFiles = savedFiles === null ? false : savedFiles === '1';
    if (!S.capabilities.files) {
      S.useFiles = false;
      document.querySelectorAll('[data-panel="files"]').forEach((el) => el.remove());
      document.querySelectorAll('[data-tool="files"]').forEach((el) => el.remove());
      document.querySelectorAll('[data-prompt*="workspace" i]').forEach((el) => el.remove());
    }
    if (!S.capabilities.browser) document.querySelectorAll('[data-panel="browser"]').forEach((el) => el.remove());
    if (localStorage.getItem('mxgpt-sb-collapsed') === '1') setSidebarCollapsed(true);
    applyTheme();
    renderSidebar();
    renderModel();
    updatePersonaPill();
    $('#greeting').textContent = greeting();
    $('#footHost').textContent = `${S.capabilities.lan ? 'LAN access' : 'Private sandbox'}${b.version ? ' · v' + b.version : ''}`;
    $('#userName').textContent = S.user;
    $('#userAvatar').textContent = (S.user.replace(/^User\s+/i, '')[0] || 'K').toUpperCase();
    const uSub = $('#userSub');
    if (uSub) uSub.textContent = S.capabilities.ollamaSettings ? 'LAN · Ollama control' : (S.capabilities.gatewayAuth ? 'Sandboxed container' : 'Local workspace');
    S.booted = true;
    const serverRuns = b.activeRuns || [];
    await Promise.all(serverRuns.map((sr) => attachToServerRun(sr)));
    const last = localStorage.getItem('mxgpt-chat');
    if (last && S.chats.some((c) => c.id === last)) await openChat(last);
    else showWelcome();
    updateWorkPill();
    renderSidebar();
    autosize();
    $('#input').focus();
  } catch (e) {
    console.error(e);
    document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:0;display:grid;place-items:center;background:var(--bg);z-index:999"><div style="text-align:center;font-family:var(--font-ui)"><b>Could not reach the server</b><p style="color:var(--muted);font-size:13px">${esc(e.message)}</p><button onclick="location.reload()" class="btn primary">Retry</button></div></div>`);
  }
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  const btn = $('#themeBtn');
  if (btn) btn.innerHTML = icon(S.theme === 'dark' ? 'sun' : 'moon');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', S.theme === 'dark' ? '#262624' : '#faf9f5');
}

/* ---------------------------------------------------------------- sidebar */
function setSidebarCollapsed(collapsed) {
  $('#sidebar').classList.toggle('collapsed', !!collapsed);
  const exp = $('#expandBtn');
  if (exp) exp.hidden = !collapsed;
  localStorage.setItem('mxgpt-sb-collapsed', collapsed ? '1' : '0');
}

function groupChats(chats) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const pinned = chats.filter((c) => c.pinned);
  const rest = chats.filter((c) => !c.pinned);
  const groups = [
    ['Today', (c) => c.updated >= startToday],
    ['Yesterday', (c) => c.updated >= startToday - 864e5 && c.updated < startToday],
    ['Previous 7 days', (c) => c.updated >= startToday - 7 * 864e5 && c.updated < startToday - 864e5],
    ['Older', (c) => c.updated < startToday - 7 * 864e5],
  ];
  const out = [];
  if (pinned.length) out.push(['Pinned', pinned]);
  for (const [label, test] of groups) {
    const items = rest.filter(test);
    if (items.length) out.push([label, items]);
  }
  return out;
}

function renderSidebar() {
  const list = $('#chatList');
  list.innerHTML = '';
  if (!S.chats.length) {
    list.innerHTML = '<div class="sb-empty">No conversations yet.</div>';
    return;
  }
  for (const [label, chats] of groupChats(S.chats)) {
    const h = document.createElement('div');
    h.className = 'sb-label';
    h.textContent = label;
    list.appendChild(h);
    for (const c of chats) {
      const el = document.createElement('div');
      const run = S.runs.get(c.id);
      const running = !!run;
      const unread = S.unread.has(c.id);
      el.className = 'chat-item' + (S.chat?.id === c.id ? ' active' : '') + (running ? ' working' : '');
      el.dataset.id = c.id;
      el.innerHTML = `${c.pinned ? `<svg class="ci-pin"><use href="#i-pin"/></svg>` : ''}<span class="ci-title"></span>${running ? `<span class="ci-work" title="${esc(phaseLabel(run.phase, run.queue))}">${'<i></i>'.repeat(3)}<span class="ci-time"></span></span><button class="ci-stop" type="button" title="Stop">${icon('stop')}</button>` : unread ? '<span class="ci-unread" title="Finished — open to read"></span>' : ''}<button class="ci-more" title="More">${icon('more')}</button>`;
      el.querySelector('.ci-title').textContent = c.title || 'New chat';
      el.title = running ? `${c.title || 'New chat'} — ${phaseLabel(run.phase, run.queue)}` : c.title || '';
      el.addEventListener('click', (e) => {
        if (e.target.closest('.ci-more') || e.target.closest('.ci-stop')) return;
        openChat(c.id);
        closeMobileSidebar();
      });
      const stopBtn = el.querySelector('.ci-stop');
      if (stopBtn) {
        stopBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          stopStreaming(c.id);
        });
      }
      el.querySelector('.ci-more').addEventListener('click', (e) => {
        e.stopPropagation();
        chatMenu(c, e.currentTarget);
      });
      list.appendChild(el);
    }
  }
}

async function loadChats(q = '') {
  try {
    const data = await api('/api/chats' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    S.chats = data.chats || [];
    renderSidebar();
  } catch (e) { console.error(e); }
}

function upsertChat(chat) {
  const meta = { id: chat.id, title: chat.title, updated: chat.updated || Date.now(), model: chat.model, pinned: !!chat.pinned, persona: chat.persona || '', messageCount: chat.messageCount, preview: chat.preview };
  const i = S.chats.findIndex((c) => c.id === chat.id);
  if (i >= 0) S.chats[i] = { ...S.chats[i], ...meta };
  else S.chats.unshift(meta);
  renderSidebar();
}

function chatMenu(chat, anchor) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.innerHTML = `
    <button class="pop-item" data-a="pin">${icon('pin')} ${chat.pinned ? 'Unpin' : 'Pin to top'}</button>
    <button class="pop-item" data-a="rename">${icon('edit')} Rename</button>
    <button class="pop-item" data-a="export-md">${icon('download')} Export Markdown</button>
    <button class="pop-item" data-a="export-json">${icon('code')} Export JSON</button>
    <div class="pop-sep"></div>
    <button class="pop-item danger" data-a="delete">${icon('trash')} Delete</button>`;
  document.body.appendChild(pop);
  positionPopover(pop, anchor);
  pop.addEventListener('click', async (e) => {
    const a = e.target.closest('.pop-item')?.dataset.a;
    if (!a) return;
    closePopover();
    if (a === 'pin') {
      await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: { pinned: !chat.pinned } });
      if (S.chat?.id === chat.id) S.chat.pinned = !chat.pinned;
      await loadChats();
    } else if (a === 'rename') {
      const name = prompt('Rename conversation', chat.title || '');
      if (name && name.trim()) {
        await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: { title: name.trim() } });
        if (S.chat?.id === chat.id) { S.chat.title = name.trim(); $('#chatTitle').textContent = name.trim(); }
        const run = S.runs.get(chat.id);
        if (run) run.chat.title = name.trim();
        await loadChats();
      }
    } else if (a === 'export-md' || a === 'export-json') {
      const fmt = a === 'export-json' ? 'json' : 'md';
      const a2 = document.createElement('a');
      a2.href = `/api/chats/${chat.id}/export?format=${fmt}`;
      a2.download = `${(chat.title || 'chat').replace(/[^\w -]+/g, '').slice(0, 50)}.${fmt}`;
      document.body.appendChild(a2); a2.click(); a2.remove();
    } else if (a === 'delete') {
      if (!confirm(`Delete “${chat.title}”? This cannot be undone.`)) return;
      const run = S.runs.get(chat.id);
      if (run) { run.controller?.abort(); S.runs.delete(chat.id); }
      S.unread.delete(chat.id);
      await api(`/api/chats/${chat.id}`, { method: 'DELETE' });
      if (S.chat?.id === chat.id) { S.chat = null; S.messages = []; localStorage.removeItem('mxgpt-chat'); showWelcome(); }
      await loadChats();
      toast('Conversation deleted');
    }
  });
}

/* ---------------------------------------------------------------- chat */
function updatePersonaPill() {
  const pill = $('#personaBtn');
  if (!pill) return;
  const pid = S.chat?.persona || S.persona || 'default';
  const p = S.personas.find((x) => x.id === pid) || { name: 'Default' };
  const hasCustom = !!(S.chat?.systemPrompt && S.chat.systemPrompt.trim());
  $('#personaLabel').textContent = hasCustom ? `${p.name} + custom` : p.name;
  pill.classList.toggle('custom', pid !== 'default' || hasCustom);
}

async function openChat(id) {
  const prevChatId = S.chat?.id;
  if (prevChatId && prevChatId !== id && S.panel === 'artifact') closePanel();
  S.unread.delete(id);
  const run = S.runs.get(id);
  if (run) {
    S.chat = run.chat;
    S.messages = run.messages;
    S.model = run.chat.model || S.model;
    localStorage.setItem('mxgpt-chat', id);
    $('#chatTitle').textContent = run.chat.title || 'New chat';
    renderModel();
    updatePersonaPill();
    renderMessages();
    updateComposer();
    updateWorkPill();
    renderSidebar();
    scrollBottom(true);
    return;
  }
  try {
    const { chat } = await api(`/api/chats/${id}`);
    S.chat = chat;
    S.messages = chat.messages || [];
    S.model = chat.model || S.model;
    localStorage.setItem('mxgpt-chat', id);
    $('#chatTitle').textContent = chat.title || 'New chat';
    renderModel();
    updatePersonaPill();
    renderMessages();
    updateComposer();
    updateWorkPill();
    renderSidebar();
    scrollBottom(true);
  } catch (e) { toast(e.message); }
}

function showWelcome() {
  if (S.panel === 'artifact') closePanel();
  S.chat = null; S.messages = [];
  $('#welcome').classList.remove('hidden');
  $('#chatTitle').textContent = 'New chat';
  $('#messages').innerHTML = '';
  $('#greeting').textContent = greeting();
  updatePersonaPill();
  updateComposer();
  updateWorkPill();
  renderSidebar();
  scrollBottom(true);
}

function renderMessages() {
  const wrap = $('#messages');
  wrap.innerHTML = '';
  $('#welcome').classList.toggle('hidden', S.messages.length > 0);
  if (!S.messages.length) return;
  for (const m of S.messages) wrap.appendChild(messageEl(m));
  enhance(wrap);
}

function loadingHTML(model, queue = null) {
  const name = modelShort(model) || 'model';
  if (queue && queue.position > 0) {
    const waitingOn = queue.runningLabel ? ` · waiting for ${esc(queue.runningLabel)}` : ' · waiting for active turn';
    return `<div class="loading-state queued"><span class="loading-mark">${icon('clock')}</span><span class="loading-text"><b>Queued #${queue.position}</b>${waitingOn}<span class="loading-dots"><i>.</i><i>.</i><i>.</i></span></span></div>`;
  }
  return `<div class="loading-state"><span class="loading-mark">${icon('star')}</span><span class="loading-text">Preparing <b>${esc(name)}</b><span class="loading-dots"><i>.</i><i>.</i><i>.</i></span></span></div>`;
}

function thinkingEl(msg) {
  const th = document.createElement('div');
  const open = msg.streaming && !msg.content;
  th.className = 'thinking' + (open ? ' open' : '');
  const label = msg.streaming
    ? (msg.content ? thoughtLabel(msg) : liveThinkLabel(msg))
    : thoughtLabel(msg);
  th.innerHTML = `<button class="thinking-toggle">${icon('star')}<span class="th-lbl">${esc(label)}</span><svg class="chev"><use href="#i-chevron-right"/></svg></button><div class="thinking-body"></div>`;
  th.querySelector('.thinking-toggle').addEventListener('click', () => {
    th.dataset.userToggled = '1';
    th.classList.toggle('open');
  });
  th.querySelector('.thinking-body').textContent = msg.thinking;
  return th;
}

function liveThinkLabel(msg) {
  if (!msg._thinkStart) return 'Thinking…';
  const s = Math.max(1, Math.round((Date.now() - msg._thinkStart) / 1000));
  return `Thinking… ${s}s`;
}

function autoOpenArtifact(msg) {
  const arts = collectArtifacts(msg.content || '', msg.id, false);
  if (!arts.length) return;
  for (const a of arts) S.artifacts.set(a.id, a);
  const last = arts[arts.length - 1];
  if (msg._artUserClosed) return;
  S.activeArtifact = last.id;
  S.panel = 'artifact';
  // Switch smoothly to Preview when done unless user explicitly chose Code tab
  if (!msg._artUserPickedTab) S.panelTab = 'preview';
  showPanelOpen();
  $$('.top-actions .ghost-btn').forEach((b) => b.classList.remove('active'));
  renderPanel();
}

function refreshArtifactCode() {
  const art = S.artifacts.get(S.activeArtifact);
  if (!art) return;
  const wrap = document.querySelector('.artifact-code');
  const codeEl = wrap?.querySelector('code');
  if (codeEl) {
    const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 90;
    codeEl.textContent = art.code;
    if (nearBottom) wrap.scrollTop = wrap.scrollHeight;
  }
  const titleEl = $('#panelTitle');
  if (titleEl && art.title) titleEl.textContent = art.title;
  const metaEl = document.querySelector('#panelTabs .art-meta-right');
  if (metaEl) {
    const kind = { html: 'HTML', svg: 'SVG', jsx: 'React', tsx: 'React', react: 'React', mermaid: 'Diagram' }[art.lang] || 'Artifact';
    metaEl.innerHTML = `${art.streaming ? `<span class="art-live-pill"><i></i>Building…</span>` : ''}<span>${kind} · ${art.lines || 0} lines · ${fmtSize(art.code.length)}</span>`;
  }
}

function thoughtLabel(msg) {
  const s = Math.round((msg.thinkingMs || 0) / 1000);
  if (!s) return 'Thought for a moment';
  if (s < 60) return `Thought for ${s}s`;
  return `Thought for ${Math.floor(s / 60)}m ${s % 60}s`;
}

function messageEl(msg) {
  if (msg.role === 'user') {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.dataset.id = msg.id;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msg.content;
    if (msg.attachments?.length) {
      const row = document.createElement('div');
      row.className = 'attach-row';
      row.style.marginTop = '6px';
      for (const a of msg.attachments) {
        const p = document.createElement('span');
        p.className = 'attach-pill';
        p.innerHTML = `${icon(/^image/.test(a.mime || '') ? 'image' : 'file')}<span></span>`;
        p.querySelector('span').textContent = a.name;
        row.appendChild(p);
      }
      bubble.appendChild(row);
    }
    el.appendChild(bubble);
    if (!String(msg.id || '').startsWith('tmp-')) {
      const uacts = document.createElement('div');
      uacts.className = 'user-acts';
      uacts.innerHTML = `<button data-ua="copy" title="Copy message">${icon('copy')}</button><button data-ua="edit" title="Edit &amp; resend">${icon('edit')}</button>`;
      uacts.addEventListener('click', (e) => {
        const ua = e.target.closest('button')?.dataset.ua;
        if (ua === 'copy') { copyText(msg.content); toast('Copied'); }
        if (ua === 'edit') startEditUserMessage(el, msg);
      });
      el.appendChild(uacts);
    }
    return el;
  }

  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.dataset.id = msg.id;
  const av = document.createElement('div');
  av.className = 'msg-avatar';
  av.innerHTML = icon('star');
  const body = document.createElement('div');
  body.className = 'msg-body';

  if (msg.thinking) body.appendChild(thinkingEl(msg));
  if (msg.subagents?.length) body.appendChild(subagentsEl(msg.subagents, !!msg.content));
  if (msg.tools?.length) body.appendChild(toolsEl(msg.tools));

  const prose = document.createElement('div');
  prose.className = 'prose';
  const curRun = msg.streaming ? S.runs.get(S.chat?.id) : null;
  if (msg.content) prose.innerHTML = renderMarkdown(msg.content, msg.id, !!msg.streaming);
  else if (!msg.thinking && !msg.tools?.length && !msg.subagents?.length && msg.streaming) prose.innerHTML = loadingHTML(msg.model, curRun?.queue || null);
  body.appendChild(prose);
  if (msg.sources?.length) body.appendChild(sourcesEl(msg.sources));
  if (msg.error) {
    const n = document.createElement('div');
    n.className = 'notice';
    n.textContent = msg.error;
    body.appendChild(n);
  }

  if (!msg.streaming) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `
      <button class="act" data-act="copy" title="Copy">${icon('copy')}</button>
      <button class="act" data-act="retry" title="Regenerate with current model &amp; thinking">${icon('refresh')}</button>
      <button class="act ${msg.feedback === 'up' ? 'on' : ''}" data-act="up" title="Good response">${icon('thumbs-up')}</button>
      <button class="act ${msg.feedback === 'down' ? 'on' : ''}" data-act="down" title="Bad response">${icon('thumbs-down')}</button>`;
    actions.addEventListener('click', async (e) => {
      const btn = e.target.closest('.act');
      const act = btn?.dataset.act;
      if (!act) return;
      if (act === 'copy') { copyText(msg.content); toast('Copied'); }
      if (act === 'up' || act === 'down') {
        const next = msg.feedback === act ? null : act;
        msg.feedback = next;
        actions.querySelectorAll('[data-act="up"],[data-act="down"]').forEach((b) => b.classList.toggle('on', b.dataset.act === next));
        if (S.chat) {
          api(`/api/chats/${S.chat.id}/messages/${msg.id}/feedback`, { method: 'POST', body: { feedback: next } }).catch(() => {});
        }
      }
      if (act === 'retry') regenerate(msg);
    });
    body.appendChild(actions);
    if (msg.model) {
      const foot = document.createElement('div');
      foot.className = 'msg-foot';
      const bits = [modelShort(msg.model)];
      if (modelProvider(msg.model)) bits.push(modelProvider(msg.model));
      if (msg.think && msg.think !== 'off') bits.push(`think: ${msg.think}`);
      if (msg.usage?.tokensPerSec) bits.push(`${msg.usage.tokensPerSec} tok/s`);
      if (msg.usage?.evalTokens) bits.push(`${msg.usage.evalTokens} tok`);
      if (msg.stopped) bits.push('stopped');
      foot.textContent = bits.join(' · ');
      body.appendChild(foot);
    }
  }

  el.appendChild(av);
  el.appendChild(body);
  return el;
}

function startEditUserMessage(el, msg) {
  if (activeRun() || !S.chat) return;
  el.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'edit-box';
  box.innerHTML = `<textarea></textarea><div class="edit-acts"><button class="btn tiny" data-cancel>Cancel</button><button class="btn tiny primary" data-send>Save &amp; resend</button></div>`;
  const ta = box.querySelector('textarea');
  ta.value = msg.content || '';
  el.appendChild(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const submit = async () => {
    const next = ta.value.trim();
    if (!next) return;
    const idx = S.messages.findIndex((m) => m.id === msg.id);
    if (idx < 0) return;
    msg.content = next;
    S.messages.splice(idx + 1);
    renderMessages();
    await streamAssistant({ content: next, editMessageId: msg.id });
  };
  box.querySelector('[data-cancel]').addEventListener('click', () => renderMessages());
  box.querySelector('[data-send]').addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') renderMessages();
  });
}

function sourcesEl(list) {
  const box = document.createElement('div');
  box.className = 'sources';
  const label = document.createElement('span');
  label.className = 'src-label';
  label.textContent = 'Sources';
  box.appendChild(label);
  list.forEach((src, i) => {
    const a = document.createElement('a');
    a.className = 'src-chip';
    a.href = src.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = `${src.title}\n${src.url}`;
    a.innerHTML = `<span class="src-num">${i + 1}</span><span class="src-title"></span>`;
    let host = src.url;
    try { host = new URL(src.url).hostname.replace(/^www\./, ''); } catch {}
    a.querySelector('.src-title').textContent = host;
    box.appendChild(a);
  });
  return box;
}

function toolsEl(list) {
  const wrap = document.createElement('div');
  wrap.className = 'tool-wrap';
  const row = document.createElement('div');
  row.className = 'tool-row';
  wrap.appendChild(row);
  for (const t of list) {
    const chip = document.createElement('button');
    chip.className = 'tool-chip' + (t.status === 'error' ? ' error' : '');
    chip.dataset.toolId = t.id;
    const label = toolLabel(t);
    chip.innerHTML = `${icon(toolIcon(t.name))}<span class="tc-label"></span><span class="tc-state"></span>`;
    chip.querySelector('.tc-label').textContent = label;
    chip.querySelector('.tc-state').textContent = t.status === 'running' ? '' : t.status === 'error' ? 'failed' : '';
    if (t.status === 'running') chip.querySelector('.tc-state').innerHTML = '<span class="mini-spin"></span>';
    chip.title = 'Click to inspect tool details';
    chip.addEventListener('click', () => {
      if (S.expandedTools.has(t.id)) S.expandedTools.delete(t.id);
      else S.expandedTools.add(t.id);
      const nt = toolsEl(list);
      wrap.replaceWith(nt);
    });
    row.appendChild(chip);

    if (S.expandedTools.has(t.id)) {
      const det = document.createElement('div');
      det.className = 'tool-detail';
      const head = document.createElement('div');
      head.className = 'tool-detail-head';
      head.innerHTML = `<span><b>${esc(t.name)}</b> · ${esc(t.status || 'ok')}</span>`;
      if (['browse_url', 'deep_research', 'wiki_lookup'].includes(t.name) && (t.meta?.url || t.args?.url)) {
        const ob = document.createElement('button');
        ob.className = 'btn tiny';
        ob.textContent = 'Open in Browser';
        ob.addEventListener('click', (ev) => { ev.stopPropagation(); openBrowser(t.meta?.url || t.args?.url, t.meta); });
        head.appendChild(ob);
      }
      det.appendChild(head);
      const pre = document.createElement('div');
      const parts = [];
      if (t.args && Object.keys(t.args).length) parts.push(`Args:\n${JSON.stringify(t.args, null, 2)}`);
      if (t.output) parts.push(`Output:\n${t.output}`);
      else if (t.summary) parts.push(`Summary:\n${t.summary}`);
      pre.textContent = parts.join('\n\n') || '(running…)';
      det.appendChild(pre);
      wrap.appendChild(det);
    }
  }
  return wrap;
}

function subagentsEl(list, hasMainContent = false) {
  const panel = document.createElement('div');
  panel.className = 'subagents-panel';

  const total = list.length;
  const runningCount = list.filter((s) => s.status === 'running').length;
  const queuedCount = list.filter((s) => s.status === 'queued').length;
  const doneCount = list.filter((s) => s.status === 'ok').length;
  const errCount = list.filter((s) => s.status === 'error').length;
  const activeCount = runningCount + queuedCount;
  const totalSec = list.reduce((a, s) => a + (s.elapsedMs || 0), 0) / 1000;
  const speeds = list.map((s) => s.tokensPerSec).filter((v) => v > 0);
  const avgSpd = speeds.length ? (speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1) : '';

  const headerTitle = activeCount > 0
    ? (total === 1
        ? (queuedCount ? 'Subagent queued…' : 'Subagent working…')
        : `Subagents · ${doneCount}/${total} done${runningCount ? `, ${runningCount} running` : ''}${queuedCount ? `, ${queuedCount} queued` : ''}`)
    : (total === 1
        ? (errCount ? 'Subagent failed' : 'Subagent completed')
        : `${total} subagents ${errCount ? `(${doneCount} ok, ${errCount} failed)` : 'completed'}`);

  const headerMeta = [
    totalSec > 0 && activeCount === 0 ? `${totalSec.toFixed(1)}s` : '',
    avgSpd && activeCount === 0 ? `${avgSpd} t/s` : '',
  ].filter(Boolean).join(' · ');

  const anyOpen = list.some((s) => {
    if (S.expandedSubagents.has(s.id)) return true;
    if (S.expandedSubagents.has('closed:' + s.id)) return false;
    return s.status === 'running' || (!hasMainContent && s.status !== 'queued' && total === 1);
  });

  const head = document.createElement('div');
  head.className = 'subagents-header' + (activeCount > 0 ? ' active' : '');
  head.innerHTML = `
    <span class="sa-h-icon">${activeCount > 0 ? '<span class="mini-spin"></span>' : icon('agents')}</span>
    <span class="sa-h-title">${esc(headerTitle)}</span>
    ${headerMeta ? `<span class="sa-h-meta">${esc(headerMeta)}</span>` : ''}
    <button type="button" class="sa-h-toggle">${anyOpen ? 'Collapse all' : 'Expand all'}</button>`;
  head.querySelector('.sa-h-toggle').addEventListener('click', () => {
    const expand = !anyOpen;
    for (const s of list) {
      if (expand) { S.expandedSubagents.add(s.id); S.expandedSubagents.delete('closed:' + s.id); }
      else { S.expandedSubagents.delete(s.id); S.expandedSubagents.add('closed:' + s.id); }
    }
    renderMessages();
  });
  panel.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'subagents-grid' + (total > 1 ? ' multi' : '');

  for (const s of list) {
    const isRunning = s.status === 'running';
    const isQueued = s.status === 'queued';
    const isErr = s.status === 'error';
    const isOpen = S.expandedSubagents.has(s.id)
      || (!S.expandedSubagents.has('closed:' + s.id) && (isRunning || (!hasMainContent && !isQueued && total === 1)));
    const roleKey = String(s.role || 'general').toLowerCase();

    const card = document.createElement('div');
    card.className = 'subagent-card'
      + (isRunning ? ' running' : isQueued ? ' queued' : isErr ? ' error' : ' done')
      + (isOpen ? ' open' : '');
    card.dataset.subId = s.id;

    const dur = s.elapsedMs ? `${(s.elapsedMs / 1000).toFixed(1)}s` : '';
    const spd = s.tokensPerSec ? `${s.tokensPerSec} t/s` : '';
    const statHtml = isRunning
      ? `<span class="sa-pill running"><span class="mini-spin"></span>Running</span>`
      : isQueued
        ? `<span class="sa-pill queued">Queued${s.queuePos ? ` #${s.queuePos}` : ''}</span>`
        : isErr
          ? `<span class="sa-pill error">Failed</span>`
          : `<span class="sa-pill done">✓ ${esc([dur, spd].filter(Boolean).join(' · ') || 'Done')}</span>`;

    card.innerHTML = `
      ${isRunning ? '<div class="sa-progress"></div>' : ''}
      <button type="button" class="subagent-head">
        <div class="subagent-top">
          <span class="subagent-role" data-role="${esc(roleKey)}">${esc(s.roleLabel || s.role || 'Agent')}</span>
          ${s.model ? `<span class="subagent-model">${esc(modelShort(s.model))}${s.params ? ' · ' + esc(s.params) : ''}</span>` : ''}
          <span class="subagent-meta">${statHtml}</span>
          <svg class="subagent-chev"><use href="#i-chevron-right"/></svg>
        </div>
        <div class="subagent-task"></div>
      </button>
      <div class="subagent-body">
        ${s.tools?.length ? `<div class="subagent-tools">${s.tools.map((t) => `<span class="sa-tool ${t.status === 'error' ? 'err' : t.status === 'running' ? 'run' : ''}">${icon(toolIcon(t.name))}${esc(t.name)}${t.status === 'running' ? '…' : t.status === 'error' ? ' ✕' : ' ✓'}</span>`).join('')}</div>` : ''}
        <div class="subagent-out prose"></div>
        ${s.content && !isRunning ? `<div class="subagent-foot"><button type="button" class="sa-copy">${icon('copy')}<span>Copy output</span></button></div>` : ''}
      </div>`;

    card.querySelector('.subagent-task').textContent = s.task || '';
    const outEl = card.querySelector('.subagent-out');
    if (s.error) {
      outEl.textContent = `Error: ${s.error}${s.content ? '\n\n' + s.content : ''}`;
    } else if (s.content) {
      outEl.innerHTML = renderMarkdown(s.content, 'sub-' + s.id, isRunning);
    } else {
      outEl.innerHTML = `<span class="sa-placeholder">${isQueued ? 'Waiting in fast priority queue…' : isRunning ? 'Generating response…' : '(no output)'}</span>`;
    }

    const cp = card.querySelector('.sa-copy');
    if (cp) {
      cp.addEventListener('click', (e) => {
        e.stopPropagation();
        copyText(s.content || '');
        toast('Subagent output copied');
      });
    }

    card.querySelector('.subagent-head').addEventListener('click', () => {
      const nowOpen = !card.classList.contains('open');
      card.classList.toggle('open', nowOpen);
      if (nowOpen) { S.expandedSubagents.add(s.id); S.expandedSubagents.delete('closed:' + s.id); }
      else { S.expandedSubagents.delete(s.id); S.expandedSubagents.add('closed:' + s.id); }
    });
    grid.appendChild(card);
  }
  panel.appendChild(grid);
  return panel;
}

function toolIcon(name) {
  return {
    web_search: 'search',
    deep_research: 'spark',
    browse_url: 'globe',
    wiki_lookup: 'book',
    calculate: 'calc',
    get_datetime: 'clock',
    run_js: 'code',
    save_note: 'book',
    list_notes: 'book',
    read_note: 'book',
    list_files: 'folder',
    search_files: 'search',
    read_file: 'file',
    write_file: 'edit',
    edit_file: 'edit',
    delegate_subagent: 'agents',
    delegate_parallel: 'agents',
  }[name] || 'wrench';
}
function toolLabel(t) {
  if (t.summary) return t.summary;
  if (t.name === 'web_search') return `Searching “${t.args?.query || ''}”`;
  if (t.name === 'deep_research') return `Researching “${t.args?.query || ''}”`;
  if (t.name === 'browse_url') return t.args?.url || 'Opening page';
  if (t.name === 'wiki_lookup') return `Wikipedia “${t.args?.topic || ''}”`;
  if (t.name === 'calculate') return `Calculating ${t.args?.expression || ''}`;
  if (t.name === 'get_datetime') return `Checking time${t.args?.timezone ? ` (${t.args.timezone})` : ''}`;
  if (t.name === 'run_js') return 'Running JavaScript';
  if (t.name === 'save_note') return `Saving note “${t.args?.title || ''}”`;
  if (t.name === 'list_notes') return 'Listing notes';
  if (t.name === 'read_note') return `Reading note “${t.args?.title || ''}”`;
  if (t.name === 'list_files') return `Listing /${t.args?.path || ''}`;
  if (t.name === 'search_files') return `Searching files “${t.args?.query || ''}”`;
  if (t.name === 'read_file') return `Reading ${t.args?.path || ''}`;
  if (t.name === 'write_file') return `Writing ${t.args?.path || ''}`;
  if (t.name === 'edit_file') return `Editing ${t.args?.path || ''}`;
  if (t.name === 'delegate_subagent') return `Delegating (${t.args?.role || 'general'})…`;
  if (t.name === 'delegate_parallel') return `Running ${t.args?.tasks?.length || 2} subagents…`;
  return t.name;
}

async function regenerate(msg) {
  if (activeRun() || !S.chat) return;
  const idx = S.messages.findIndex((m) => m.id === msg.id);
  if (idx < 0) return;
  S.messages.splice(idx);
  renderMessages();
  await streamAssistant({ regenerate: true, fromMessageId: msg.id });
}

function scrollBottom(force = false) {
  const area = $('#scrollArea');
  const near = area.scrollHeight - area.scrollTop - area.clientHeight < 220;
  if (force || near) requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; });
}

/* ---------------------------------------------------------------- markdown */
const marked = window.marked;
marked.setOptions({ gfm: true, breaks: true });
const renderer = new marked.Renderer();

function codeInfo(lang) {
  const m = String(lang || '').match(/^\s*([\w+-]*)\s*(.*)$/);
  return { lang: (m?.[1] || '').toLowerCase(), extra: m?.[2] || '' };
}
const ART_LANGS = new Set(['html', 'htm', 'svg', 'jsx', 'tsx', 'react', 'mermaid']);

function isArtifactBlock(lang, code, isStreaming = false) {
  if (lang === 'artifact') return true;
  if (!ART_LANGS.has(lang)) return false;
  return isStreaming ? code.length > 24 : code.length > 60;
}

renderer.code = function (tokenOrCode, maybeLang) {
  const text = typeof tokenOrCode === 'object' ? tokenOrCode.text : tokenOrCode;
  const rawLang = typeof tokenOrCode === 'object' ? tokenOrCode.lang : maybeLang;
  const { lang } = codeInfo(rawLang);
  if (isArtifactBlock(lang, text, currentMessageStreaming)) {
    return `<div data-art-slot="${esc(currentMessageId)}:${artifactCounter++}"></div>`;
  }
  const label = lang || 'text';
  return `<div class="codeblock"><div class="code-head"><span class="code-lang">${esc(label)}</span><button class="code-copy" data-copy>${icon('copy')}<span>Copy</span></button></div><pre><code class="language-${esc(label)}">${esc(text)}</code></pre></div>`;
};

renderer.link = function (tokenOrHref, title, text) {
  const t = typeof tokenOrHref === 'object' ? tokenOrHref : { href: tokenOrHref, title, text };
  return `<a href="${esc(t.href)}" target="_blank" rel="noopener noreferrer"${t.title ? ` title="${esc(t.title)}"` : ''}>${t.text}</a>`;
};

let currentMessageId = 'x';
let currentMessageStreaming = false;
let artifactCounter = 0;
let pendingArtifacts = [];

function guessArtifactLang(code) {
  if (/<svg[\s>]/i.test(code) && !/<html/i.test(code)) return 'svg';
  if (/^\s*(graph|flowchart|sequenceDiagram|classDiagram|gantt|pie|stateDiagram)/m.test(code)) return 'mermaid';
  if (/React|useState|useEffect|<\/[A-Z]/.test(code) && !/<html/i.test(code)) return 'jsx';
  return 'html';
}

function artifactTitle(code, lang) {
  const t = code.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1].trim()) return t[1].replace(/\s+/g, ' ').trim().slice(0, 70);
  const h = code.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h) {
    const clean = h[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (clean) return clean.slice(0, 70);
  }
  if (lang === 'svg') return 'SVG graphic';
  if (lang === 'mermaid') return 'Diagram';
  if (['jsx', 'tsx', 'react'].includes(lang)) {
    const m = code.match(/(?:function|const)\s+([A-Z]\w+)/);
    return m ? m[1] : 'React component';
  }
  return 'Interactive web page';
}

function collectArtifacts(text, msgId, isStreaming = false) {
  const found = [];
  const src = String(text || '');
  const lines = src.split('\n');
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let info = '';
  let buf = [];
  let artIdx = 0;

  const flush = (closed) => {
    const code = buf.join('\n');
    const { lang, extra } = codeInfo(info);
    const isExplicit = lang === 'artifact';
    const kind = isExplicit ? guessArtifactLang(code) : lang;
    if (isArtifactBlock(lang, code, isStreaming)) {
      const titleM = extra.match(/title=(?:"([^"]+)"|'([^']+)'|(\S+))/);
      const trimmed = code.trim();
      found.push({
        id: `${msgId}:${artIdx++}`,
        lang: kind,
        code: trimmed,
        lines: trimmed ? trimmed.split('\n').length : 0,
        streaming: !closed && isStreaming,
        complete: closed,
        title: titleM ? (titleM[1] || titleM[2] || titleM[3]) : artifactTitle(code, kind),
      });
    }
  };

  for (const line of lines) {
    if (!inFence) {
      const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (m) {
        inFence = true;
        fenceChar = m[1][0];
        fenceLen = m[1].length;
        info = m[2] || '';
        buf = [];
      }
    } else {
      const closeRe = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);
      if (closeRe.test(line)) {
        flush(true);
        inFence = false;
        buf = [];
      } else {
        buf.push(line);
      }
    }
  }
  if (inFence) flush(false);
  return found;
}

function renderMarkdown(text, msgId, isStreaming = false) {
  currentMessageId = msgId;
  currentMessageStreaming = !!isStreaming;
  artifactCounter = 0;
  pendingArtifacts = collectArtifacts(text, msgId, !!isStreaming);
  for (const a of pendingArtifacts) S.artifacts.set(a.id, a);
  let html;
  try { html = marked.parse(text, { renderer }); } catch { html = `<p>${esc(text)}</p>`; }
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

function enhance(root, highlight = true) {
  // artifact placeholders → cards
  for (const slot of $$('[data-art-slot]', root)) {
    const key = slot.dataset.artSlot;
    const art = S.artifacts.get(key);
    if (!art) { slot.remove(); continue; }
    slot.replaceWith(artifactCard(art));
  }
  // code copy buttons
  for (const btn of $$('[data-copy]', root)) {
    btn.addEventListener('click', () => {
      const code = btn.closest('.codeblock')?.querySelector('code')?.textContent || '';
      copyText(code);
      btn.querySelector('span').textContent = 'Copied';
      setTimeout(() => (btn.querySelector('span').textContent = 'Copy'), 1400);
    });
  }
  // syntax highlight (skipped during streaming to avoid flicker)
  if (highlight) {
    for (const code of $$('pre code', root)) {
      try { if (window.hljs) window.hljs.highlightElement(code); } catch {}
    }
  }
  // links
  for (const a of $$('a[href]', root)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
}

function artifactCard(art) {
  const el = document.createElement('button');
  el.className = 'art-card' + (art.streaming ? ' building' : '');
  el.dataset.artifact = art.id;
  const kind = { html: 'HTML', svg: 'SVG', jsx: 'React', tsx: 'React', react: 'React', mermaid: 'Diagram' }[art.lang] || 'Artifact';
  el.innerHTML = `<span class="art-icon">${icon(art.lang === 'mermaid' ? 'spark' : 'code')}</span>
    <span class="art-info"><span class="art-title"></span><span class="art-meta"></span></span>
    <span class="art-open">${art.streaming ? 'Live' : 'Preview'} ${icon('chevron-right')}</span>`;
  el.querySelector('.art-title').textContent = art.title;
  const lineStr = art.lines ? `${art.lines} lines · ` : '';
  el.querySelector('.art-meta').textContent = art.streaming
    ? `Building ${kind} · ${lineStr}${fmtSize(art.code.length)}`
    : `${kind} · ${lineStr}${fmtSize(art.code.length)}`;
  el.addEventListener('click', () => openArtifact(art.id, art.streaming ? 'code' : 'preview'));
  return el;
}

function copyText(t) {
  navigator.clipboard?.writeText(t).catch(() => {
    const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  });
}

/* ---------------------------------------------------------------- sending */
const activeRun = () => (S.chat ? S.runs.get(S.chat.id) : null);
const bgRuns = () => [...S.runs.values()].filter((r) => r.chatId !== S.chat?.id);
const fmtElapsed = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function updateComposer() {
  const run = activeRun();
  S.streaming = !!run;
  const btn = $('#sendBtn');
  btn.classList.toggle('stop', !!run);
  btn.innerHTML = icon(run ? 'stop' : 'send');
  btn.title = run ? 'Stop this chat' : 'Send';
}
function workDots() { return '<span class="wp-dots"><i></i><i></i><i></i></span>'; }
function syncDocTitle() {
  document.title = S.runs.size ? `(${S.runs.size} working) mx-GPT` : 'mx-GPT';
}
function updateRunTimes() {
  const now = Date.now();
  const pill = $('#workPill');
  if (pill && !pill.hidden) {
    const r = activeRun();
    const t = pill.querySelector('.wp-time');
    if (r && t) t.textContent = fmtElapsed(now - r.startedAt);
  }
  for (const el of $$('.chat-item.working')) {
    const r = S.runs.get(el.dataset.id);
    const t = el.querySelector('.ci-time');
    if (r && t) t.textContent = fmtElapsed(now - r.startedAt);
  }
  const active = activeRun();
  if (active?.assistant?._thinkStart && !active.assistant.content) {
    const lbl = $('#messages .msg.assistant:last-child .thinking .th-lbl');
    if (lbl) lbl.textContent = liveThinkLabel(active.assistant);
  }
}
setInterval(() => { if (S.runs.size) updateRunTimes(); }, 1000);
function phaseLabel(phase, queue = null) {
  if (phase === 'queued' || (queue && queue.position > 0)) {
    return `Queued #${queue?.position || 1}…`;
  }
  return {
    loading: 'Preparing…',
    thinking: 'Thinking…',
    subagents: 'Running subagents…',
    tools: 'Using tools…',
    artifact: 'Building artifact…',
    writing: 'Writing…',
  }[phase] || 'Working…';
}
function updateWorkPill() {
  syncDocTitle();
  const el = $('#workPill');
  if (!el) return;
  const run = activeRun();
  if (!run) { el.hidden = true; el.innerHTML = ''; el.onclick = null; return; }
  el.hidden = false;
  el.className = 'work-pill' + (run.phase === 'queued' ? ' queued' : '');
  el.innerHTML = `${workDots()}<span class="wp-label">${esc(phaseLabel(run.phase, run.queue).replace(/…$/, ''))}</span><span class="wp-time"></span>`;
  el.querySelector('.wp-time').textContent = fmtElapsed(Date.now() - run.startedAt);
  el.title = run.queue?.runningLabel
    ? `Queued #${run.queue.position} behind ${run.queue.runningLabel}`
    : 'This chat is generating — you can safely switch chats while it runs';
  el.onclick = null;
}

function autosize() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
}

async function ensureChat() {
  if (S.chat) return S.chat;
  const { chat } = await api('/api/chats', { method: 'POST', body: { model: S.model, persona: S.persona } });
  S.chat = chat;
  S.messages = [];
  localStorage.setItem('mxgpt-chat', chat.id);
  upsertChat(chat);
  updatePersonaPill();
  return chat;
}

async function send() {
  if (activeRun()) return;
  const input = $('#input');
  const raw = input.value.trim();
  if (!raw && !S.attachments.length) return;
  const content = raw || 'Please inspect the attached file(s).';
  try {
    await ensureChat();
  } catch (e) { toast(e.message); return; }

  const userMsg = {
    id: 'tmp-u-' + Date.now(), role: 'user', content, ts: Date.now(),
    attachments: S.attachments.map((a) => ({ ...a })),
  };
  S.messages.push(userMsg);
  const assistant = {
    id: 'tmp-a-' + Date.now(), role: 'assistant', content: '', thinking: '', tools: [], subagents: [],
    ts: Date.now(), model: S.model, think: S.thinkEffort, streaming: true,
  };
  S.messages.push(assistant);

  input.value = '';
  autosize();
  const attachments = S.attachments;
  S.attachments = [];
  renderAttachments();
  $('#welcome').classList.add('hidden');
  renderMessages();
  scrollBottom(true);
  const run = { chatId: S.chat.id, chat: S.chat, messages: S.messages, assistant, controller: null, startedAt: Date.now() };
  await streamAssistant({ run, content, userMsg, assistant, attachments });
}

async function attachToServerRun(sr) {
  if (!sr?.chatId || S.runs.has(sr.chatId)) return;
  let chat;
  try {
    const d = await api(`/api/chats/${sr.chatId}`);
    chat = d.chat;
  } catch {
    chat = { id: sr.chatId, title: sr.title || 'New chat', model: sr.model || '', messages: [] };
  }
  const messages = [...(chat.messages || [])];
  const assistant = {
    id: 'tmp-a-' + Date.now(), role: 'assistant', content: '', thinking: '', tools: [], subagents: [],
    ts: sr.startedAt || Date.now(), model: sr.model || chat.model, think: sr.think || 'off', streaming: true,
  };
  messages.push(assistant);
  const run = {
    chatId: sr.chatId,
    chat,
    messages,
    assistant,
    model: sr.model || chat.model,
    phase: sr.phase || 'loading',
    controller: null,
    startedAt: sr.startedAt || Date.now(),
  };
  S.runs.set(sr.chatId, run);
  if (S.chat?.id === sr.chatId) {
    S.chat = run.chat;
    S.messages = run.messages;
  }
  // Fire-and-forget the SSE stream so boot() finishes immediately
  consumeRunStream({ run, attachUrl: `/api/chats/${sr.chatId}/stream` });
}

async function streamAssistant({ content = '', userMsg = null, assistant = null, attachments = [], regenerate = false, fromMessageId = null, editMessageId = null, run = null } = {}) {
  const chat = run?.chat || S.chat;
  if (!chat) return;
  if (!run) run = { chatId: chat.id, chat, messages: S.messages, model: S.model || chat.model, phase: 'loading', startedAt: Date.now() };
  const chosenModel = S.model || chat.model;
  run.model = chosenModel;
  run.phase = run.phase || 'loading';
  if (!assistant) {
    assistant = { id: 'tmp-a-' + Date.now(), role: 'assistant', content: '', thinking: '', tools: [], subagents: [], ts: Date.now(), model: chosenModel, think: S.thinkEffort, streaming: true };
    run.messages.push(assistant);
    if (S.chat?.id === run.chatId) renderMessages();
  }
  if (!Array.isArray(assistant.subagents)) assistant.subagents = [];
  run.assistant = assistant;
  return consumeRunStream({
    run,
    userMsg,
    fetchOpts: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: run.chatId,
        content,
        model: chosenModel,
        attachments,
        useSubagents: S.useSubagents,
        useTools: S.useTools,
        useWeb: S.useWeb,
        useFiles: S.useFiles,
        think: S.thinkEffort,
        persona: chat.persona || S.persona || '',
        regenerate,
        fromMessageId,
        editMessageId,
      }),
    },
  });
}

async function consumeRunStream({ run, userMsg = null, fetchOpts = null, attachUrl = null }) {
  const chat = run.chat;
  const assistant = run.assistant;
  const isActive = () => S.chat?.id === run.chatId;
  let aborted = false;
  const controller = new AbortController();
  run.controller = controller;
  S.runs.set(run.chatId, run);
  updateComposer();
  updateWorkPill();
  renderSidebar();

  let renderQueued = false;
  const queueRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      if (!isActive()) return;
      const el = $(`#messages .msg[data-id="${CSS.escape(assistant.id)}"]`);
      if (!el) { renderMessages(); return; }
      const bodyEl = el.querySelector('.msg-body');
      const prose = bodyEl.querySelector('.prose');
      if (assistant.thinking) {
        let th = bodyEl.querySelector('.thinking');
        if (!th) { th = thinkingEl(assistant); bodyEl.insertBefore(th, bodyEl.firstChild); }
        else {
          th.querySelector('.thinking-body').textContent = assistant.thinking;
          const lbl = th.querySelector('.th-lbl');
          if (lbl) lbl.textContent = assistant.content ? thoughtLabel(assistant) : liveThinkLabel(assistant);
          if (assistant.content && !th.dataset.userToggled) th.classList.remove('open');
        }
      }
      if (assistant.subagents?.length) {
        const ns = subagentsEl(assistant.subagents, !!assistant.content);
        const old = bodyEl.querySelector('.subagents-panel') || bodyEl.querySelector('.subagents-box');
        if (old) old.replaceWith(ns);
        else {
          const anchor = bodyEl.querySelector('.tool-wrap') || bodyEl.querySelector('.tool-row') || prose;
          bodyEl.insertBefore(ns, anchor);
        }
      }
      if (assistant.tools.length) {
        const nt = toolsEl(assistant.tools);
        const tr = bodyEl.querySelector('.tool-wrap') || bodyEl.querySelector('.tool-row');
        if (tr) tr.replaceWith(nt); else bodyEl.insertBefore(nt, prose);
      }
      if (assistant.content) {
        prose.innerHTML = renderMarkdown(assistant.content, assistant.id, !!assistant.streaming);
        enhance(prose, false);
        if (pendingArtifacts.length) {
          const latestArt = pendingArtifacts[pendingArtifacts.length - 1];
          if (!assistant._artOpened && !assistant._artUserClosed) {
            assistant._artOpened = true;
            assistant._artCompleted = !latestArt.streaming;
            S.activeArtifact = latestArt.id;
            S.panel = 'artifact';
            S.panelTab = latestArt.streaming ? 'code' : 'preview';
            showPanelOpen();
            $$('.top-actions .ghost-btn').forEach((b) => b.classList.remove('active'));
            renderPanel();
          } else if (S.panel === 'artifact' && S.activeArtifact === latestArt.id) {
            if (!latestArt.streaming && !assistant._artCompleted) {
              // Artifact closing fence arrived: transition smoothly to live Preview!
              assistant._artCompleted = true;
              if (!assistant._artUserPickedTab) S.panelTab = 'preview';
              renderPanel();
            } else if (S.panelTab === 'code') {
              refreshArtifactCode();
            }
          }
        }
      } else if (!assistant.thinking && !assistant.tools.length && !assistant.subagents?.length) {
        prose.innerHTML = loadingHTML(assistant.model, run.queue || null);
      }
      scrollBottom();
    }, 60);
  };

  try {
    const res = await fetch(attachUrl || '/api/chat', { ...(fetchOpts || {}), signal: controller.signal });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    while (!done) {
      const r = await reader.read();
      if (r.done) break;
      buffer += decoder.decode(r.value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseSSE(raw);
        if (!ev) continue;
        const data = safeJSON(ev.data);
        if (ev.event === 'idle') {
          done = true;
          if (isActive()) await openChat(run.chatId);
          break;
        } else if (ev.event === 'snapshot') {
          if (data.chat) {
            Object.assign(chat, data.chat);
            if (isActive()) { $('#chatTitle').textContent = data.chat.title; updatePersonaPill(); }
            upsertChat(chat);
          }
          if (data.assistant) {
            Object.assign(assistant, data.assistant);
            assistant.streaming = true;
          }
          if (data.phase) run.phase = data.phase;
          if (data.queue !== undefined) run.queue = data.queue;
          if (data.startedAt) run.startedAt = data.startedAt;
          updateWorkPill();
          if (isActive()) renderMessages();
        } else if (ev.event === 'queue') {
          if (data?.acquired || !data?.position) {
            run.queue = null;
            if (run.phase === 'queued') run.phase = 'loading';
          } else {
            run.queue = data;
            run.phase = 'queued';
          }
          updateWorkPill();
          renderSidebar();
          queueRender();
        } else if (ev.event === 'phase') {
          run.phase = data.phase || run.phase;
          if (run.phase !== 'queued') run.queue = null;
          updateWorkPill();
        } else if (ev.event === 'chat') {
          if (data.chat) {
            Object.assign(chat, data.chat);
            if (isActive()) { $('#chatTitle').textContent = data.chat.title; updatePersonaPill(); }
            upsertChat(chat);
          }
          if (data.userMessage && userMsg) {
            userMsg.id = data.userMessage.id;
            if (isActive()) {
              const el = $('#messages .msg.user[data-id^="tmp-u-"]');
              if (el) el.dataset.id = userMsg.id;
            }
          }
        } else if (ev.event === 'loading') {
          run.phase = 'loading';
          updateWorkPill();
        } else if (ev.event === 'start') {
          assistant.id = data.id;
          if (data.think !== undefined) assistant.think = data.think;
          if (isActive()) {
            const el = $('#messages .msg.assistant[data-id^="tmp-a-"]');
            if (el) el.dataset.id = data.id;
          }
        } else if (ev.event === 'thinking') {
          if (!assistant._thinkStart) assistant._thinkStart = Date.now();
          assistant.thinking += data.delta || '';
          const th = isActive() ? $('#messages .msg.assistant:last-child .thinking-body') : null;
          if (th) th.textContent = assistant.thinking;
          else queueRender();
        } else if (ev.event === 'text') {
          if (assistant._thinkStart && !assistant.thinkingMs) {
            assistant.thinkingMs = Date.now() - assistant._thinkStart;
          }
          assistant.content += data.delta || '';
          queueRender();
        } else if (ev.event === 'subagent') {
          run.phase = 'subagents';
          updateWorkPill();
          if (!Array.isArray(assistant.subagents)) assistant.subagents = [];
          const existing = assistant.subagents.find((x) => x.id === data.id);
          if (existing) Object.assign(existing, data, { content: data.content || existing.content || '', tools: data.tools?.length ? data.tools : (existing.tools || []) });
          else assistant.subagents.push({ ...data, content: data.content || '', tools: data.tools || [] });
          queueRender();
        } else if (ev.event === 'subagent_delta') {
          const s = (assistant.subagents || []).find((x) => x.id === data.id);
          if (s) {
            s.content = (s.content || '') + (data.delta || '');
            const outEl = isActive() ? $(`.subagent-card[data-sub-id="${CSS.escape(data.id)}"] .subagent-out`) : null;
            if (outEl) { outEl.innerHTML = renderMarkdown(s.content, 'sub-' + s.id, true); outEl.scrollTop = outEl.scrollHeight; }
            else queueRender();
          }
        } else if (ev.event === 'subagent_tool') {
          const s = (assistant.subagents || []).find((x) => x.id === data.id);
          if (s && data.tool) {
            s.tools = s.tools || [];
            const idx2 = s.tools.findIndex((x) => x.name === data.tool.name && x.status === 'running');
            if (idx2 >= 0) s.tools[idx2] = data.tool;
            else s.tools.push(data.tool);
            queueRender();
          }
        } else if (ev.event === 'subagent_done') {
          const s = (assistant.subagents || []).find((x) => x.id === data.id);
          if (s) {
            s.status = data.ok ? 'ok' : 'error';
            s.content = data.content || s.content;
            s.elapsedMs = data.elapsedMs || 0;
            s.evalTokens = data.evalTokens || 0;
            s.tokensPerSec = data.tokensPerSec || 0;
            s.error = data.error || '';
            if (data.tools) s.tools = data.tools;
            queueRender();
          }
        } else if (ev.event === 'tool') {
          run.phase = 'tools';
          updateWorkPill();
          assistant.tools.push({ id: data.id, name: data.name, args: data.args, status: 'running', ts: Date.now() });
          queueRender();
        } else if (ev.event === 'tool_result') {
          const t = assistant.tools.find((x) => x.id === data.id);
          if (t) { t.status = data.ok ? 'ok' : 'error'; t.summary = data.summary; t.output = data.output || ''; t.meta = data.meta; }
          queueRender();
          if (isActive() && (data.meta?.type === 'page' || data.meta?.type === 'research') && data.meta.url && S.capabilities.browser) {
            openBrowser(data.meta.url);
          }
        } else if (ev.event === 'done') {
          assistant.streaming = false;
          Object.assign(assistant, data.message || {});
          assistant.streaming = false;
          if (data.chat) {
            Object.assign(chat, data.chat);
            if (isActive()) $('#chatTitle').textContent = data.chat.title;
            upsertChat(chat);
          }
          if (isActive()) autoOpenArtifact(assistant);
          done = true;
        } else if (ev.event === 'stopped') {
          assistant.streaming = false;
          assistant.stopped = true;
          Object.assign(assistant, data.message || {});
          assistant.streaming = false;
          done = true;
        } else if (ev.event === 'error') {
          assistant.streaming = false;
          assistant.error = data.message;
          done = true;
          toast(`${isActive() ? '' : (chat.title || 'Chat') + ': '}${data.message}`, 4000);
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') { aborted = true; }
    else { assistant.error = e.message; toast(e.message, 4000); }
    assistant.streaming = false;
  } finally {
    if (aborted) {
      assistant.stopped = true;
    }
    assistant.streaming = false;
    if (S.runs.get(run.chatId) === run) S.runs.delete(run.chatId);
    if (isActive()) {
      updateComposer();
      renderMessages();
      scrollBottom();
      localStorage.setItem('mxgpt-chat', run.chatId);
      S.unread.delete(run.chatId);
    } else if (!aborted) {
      S.unread.add(run.chatId);
      toast(`Finished “${chat.title || 'chat'}” — click to open`, 4500, () => openChat(run.chatId));
    }
    updateWorkPill();
    await loadChats();
    renderSidebar();
  }
}

function parseSSE(raw) {
  const lines = raw.split('\n');
  let event = 'message', data = '';
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  return { event, data };
}
function safeJSON(s) { try { return JSON.parse(s); } catch { return {}; } }

async function stopStreaming(chatId = S.chat?.id) {
  const run = chatId ? S.runs.get(chatId) : activeRun();
  if (!run) return;
  api('/api/chat/stop', { method: 'POST', body: { chatId: run.chatId } }).catch(() => {});
  run.controller?.abort();
}

/* ---------------------------------------------------------------- attachments */
function renderAttachments() {
  const row = $('#attachRow');
  row.innerHTML = '';
  for (const a of S.attachments) {
    const p = document.createElement('span');
    p.className = 'attach-pill';
    p.innerHTML = `${icon(/^image/.test(a.mime) ? 'image' : 'file')}<span></span><button title="Remove">${icon('x')}</button>`;
    p.querySelector('span').textContent = a.name;
    p.querySelector('button').addEventListener('click', () => {
      S.attachments = S.attachments.filter((x) => x !== a);
      renderAttachments();
    });
    row.appendChild(p);
  }
}

function safeName(name) {
  return name.replace(/[^\w.\- ()]+/g, '_').slice(0, 120) || 'file';
}

async function uploadFiles(fileList, targetDir = 'uploads') {
  for (const file of fileList) {
    try {
      const rel = `${targetDir}/${Date.now()}-${safeName(file.name)}`;
      const res = await fetch(`/api/files/raw?path=${encodeURIComponent(rel)}`, { method: 'PUT', body: file });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Upload failed'); }
      S.attachments.push({ name: file.name, path: rel, mime: file.type || 'application/octet-stream', size: file.size });
    } catch (e) { toast(`Could not upload ${file.name}: ${e.message}`); }
  }
  renderAttachments();
  if (S.panel === 'files') loadFiles(S.files.path);
}

/* ---------------------------------------------------------------- panel */
function openPanel(tab) {
  if (tab === 'artifact' && !S.activeArtifact) {
    const first = S.artifacts.values().next().value;
    if (first) S.activeArtifact = first.id;
  }
  if (S.panel === tab) { closePanel(); return; }
  S.panel = tab;
  S.panelTab = tab === 'browser' ? S.browser.tab : 'preview';
  renderPanel();
  $('#panel').classList.add('open');
  $('#panel').setAttribute('aria-hidden', 'false');
  $$('.top-actions .ghost-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === tab));
  if (tab === 'files' && !S.files.entries.length) loadFiles(S.files.path);
  if (tab === 'notes') loadNotes();
  if (tab === 'browser') { if (S.capabilities.liveBrowser && S.browser.session && !S.browser.es) connectLive(S.browser.session); renderPanel(); }
}
function closePanel(byUser = false) {
  if (byUser && S.panel === 'artifact') {
    const run = activeRun();
    if (run?.assistant) run.assistant._artUserClosed = true;
  }
  S.panel = null;
  if (S.browser.es) { S.browser.es.close(); S.browser.es = null; }
  $('#panel').classList.remove('open');
  $('#panel').setAttribute('aria-hidden', 'true');
  $$('.top-actions .ghost-btn').forEach((b) => b.classList.remove('active'));
}
function togglePanel(tab) {
  if (S.panel === tab) closePanel(); else { if (!S.panel) { S.panel = null; } openPanel(tab); }
}

function panelHeader(title, iconName, actions = []) {
  $('#panelTitle').textContent = title;
  $('#panelIcon').innerHTML = icon(iconName);
  const wrap = $('#panelActions');
  wrap.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'icon-btn'; b.title = a.title; b.innerHTML = icon(a.icon);
    b.addEventListener('click', a.onClick);
    wrap.appendChild(b);
  }
}

function renderPanel() {
  if (!S.panel) return;
  const tabs = $('#panelTabs');
  if (S.panel === 'artifact') return renderArtifactPanel(tabs);
  if (S.panel === 'file') return renderFilePanel(tabs);
  tabs.className = 'panel-tabs';
  tabs.innerHTML = '';
  if (S.panel === 'notes') return renderNotesPanel(tabs);
  if (S.panel === 'files') return renderFilesPanel(tabs);
  if (S.panel === 'browser') return renderBrowserPanel(tabs);
}

/* ---------------------------------------------------------------- notes / memory */
async function loadNotes() {
  try {
    const d = await api('/api/notes');
    S.notes = d.notes || [];
    if (S.panel === 'notes') renderPanel();
  } catch (e) { toast(e.message); }
}

function renderNotesPanel(tabs) {
  tabs.className = 'panel-tabs';
  tabs.innerHTML = '';
  panelHeader('Notes & Memory', 'book', [
    { title: 'Refresh', icon: 'refresh', onClick: () => loadNotes() },
  ]);
  const body = $('#panelBody');
  body.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'note-form';
  form.innerHTML = `
    <input id="noteTitle" placeholder="Note title (e.g. Coding preferences)">
    <textarea id="noteContent" placeholder="Write something for mx-GPT to remember across chats…"></textarea>
    <div style="display:flex;gap:6px;align-items:center">
      <input id="noteTags" placeholder="Tags (comma-separated, optional)" style="flex:1">
      <button class="btn tiny primary" id="noteSaveBtn">Save note</button>
    </div>`;
  form.querySelector('#noteSaveBtn').addEventListener('click', async () => {
    const title = form.querySelector('#noteTitle').value.trim();
    const content = form.querySelector('#noteContent').value.trim();
    const tags = form.querySelector('#noteTags').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!title || !content) { toast('Title and content are required'); return; }
    try {
      await api('/api/notes', { method: 'POST', body: { title, content, tags } });
      form.querySelector('#noteTitle').value = '';
      form.querySelector('#noteContent').value = '';
      form.querySelector('#noteTags').value = '';
      toast('Note saved');
      await loadNotes();
    } catch (e) { toast(e.message, 3500); }
  });
  body.appendChild(form);

  const list = document.createElement('div');
  list.className = 'notes-list';
  if (!S.notes.length) {
    list.innerHTML = '<div class="panel-empty"><div class="pe-icon">' + icon('book') + '</div><p>No saved notes yet.<br>Add one above or ask mx-GPT to remember something with <b>Tools</b> enabled.</p></div>';
  } else {
    for (const n of S.notes) {
      const card = document.createElement('div');
      card.className = 'note-card';
      card.innerHTML = `<div class="note-card-head"><b></b><div style="display:flex;gap:4px">
        <button class="icon-btn" style="width:24px;height:24px" data-a="insert" title="Insert into composer">${icon('plus')}</button>
        <button class="icon-btn" style="width:24px;height:24px" data-a="del" title="Delete note">${icon('trash')}</button>
      </div></div><p></p>${n.tags?.length ? `<div class="note-tags">${n.tags.map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</div>` : ''}`;
      card.querySelector('b').textContent = n.title;
      card.querySelector('p').textContent = n.content;
      card.querySelector('[data-a="insert"]').addEventListener('click', () => {
        const inp = $('#input');
        inp.value = (inp.value ? inp.value + '\n\n' : '') + `[Note: ${n.title}]\n${n.content}`;
        autosize(); inp.focus();
        toast('Inserted note into prompt');
      });
      card.querySelector('[data-a="del"]').addEventListener('click', async () => {
        if (!confirm(`Delete note “${n.title}”?`)) return;
        await api(`/api/notes/${n.id}`, { method: 'DELETE' });
        await loadNotes();
        toast('Note deleted');
      });
      list.appendChild(card);
    }
  }
  body.appendChild(list);
}

/* ---------------------------------------------------------------- artifacts */
function openArtifact(id, preferredTab = null) {
  const art = S.artifacts.get(id);
  S.activeArtifact = id;
  S.panel = 'artifact';
  S.panelTab = preferredTab || (art?.streaming ? 'code' : 'preview');
  showPanelOpen();
  $$('.top-actions .ghost-btn').forEach((b) => b.classList.remove('active'));
  renderPanel();
}

function renderArtifactPanel(tabs) {
  const art = S.artifacts.get(S.activeArtifact);
  const body = $('#panelBody');
  if (!art) {
    panelHeader('Artifact', 'code', []);
    tabs.className = 'panel-tabs';
    body.innerHTML = '<div class="artifact-empty">No artifact open. Generate something visual and it will appear here.</div>';
    return;
  }
  const kind = { html: 'HTML', svg: 'SVG', jsx: 'React', tsx: 'React', react: 'React', mermaid: 'Diagram' }[art.lang] || 'Artifact';
  panelHeader(art.title, 'code', [
    { title: 'Copy code', icon: 'copy', onClick: () => { copyText(art.code); toast('Artifact code copied'); } },
    { title: 'Download', icon: 'download', onClick: () => downloadArtifact(art) },
    { title: 'Open in new tab', icon: 'external', onClick: () => openArtifactTab(art) },
    { title: 'Refresh preview', icon: 'refresh', onClick: () => renderPanel() },
  ]);
  tabs.className = 'panel-tabs show';
  tabs.innerHTML = `<button class="panel-tab ${S.panelTab !== 'code' ? 'active' : ''}" data-t="preview">Preview</button><button class="panel-tab ${S.panelTab === 'code' ? 'active' : ''}" data-t="code">Code</button><span class="art-meta-right">${art.streaming ? '<span class="art-live-pill"><i></i>Building…</span>' : ''}<span>${kind} · ${art.lines || 0} lines · ${fmtSize(art.code.length)}</span></span>`;
  $$('.panel-tab', tabs).forEach((b) => b.addEventListener('click', () => {
    S.panelTab = b.dataset.t;
    const run = activeRun();
    if (run?.assistant) run.assistant._artUserPickedTab = true;
    renderPanel();
  }));
  body.innerHTML = '';
  if (S.panelTab === 'code') {
    const div = document.createElement('div');
    div.className = 'artifact-code';
    div.innerHTML = `<pre><code></code></pre>`;
    div.querySelector('code').textContent = art.code;
    if (!art.streaming) {
      try { if (window.hljs) window.hljs.highlightElement(div.querySelector('code')); } catch {}
    }
    body.appendChild(div);
    if (art.streaming) div.scrollTop = div.scrollHeight;
  } else {
    const frame = document.createElement('iframe');
    frame.className = 'artifact-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-popups-to-escape-sandbox');
    frame.srcdoc = artifactDoc(art);
    body.appendChild(frame);
  }
}

function artifactDoc(art) {
  const origin = location.origin;
  const code = art.code;
  const base = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank">`;
  if (art.lang === 'html' || art.lang === 'htm') {
    if (/<html[\s>]/i.test(code)) return code;
    return `<!doctype html><html><head>${base}<style>body{font-family:Inter,system-ui,sans-serif;margin:0;padding:24px;color:#1f1e1d;background:#fff}</style></head><body>${code}</body></html>`;
  }
  if (art.lang === 'svg') {
    return `<!doctype html><html><head>${base}<style>html,body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf9f5}svg{max-width:92vw;max-height:88vh;height:auto}</style></head><body>${code}</body></html>`;
  }
  if (art.lang === 'mermaid') {
    return `<!doctype html><html><head>${base}<style>body{margin:0;padding:20px;background:#fff;font-family:Inter,system-ui,sans-serif}</style><script src="${origin}/vendor/mermaid.min.js"><\/script></head><body><pre class="mermaid">${esc(code)}</pre><script>mermaid.initialize({startOnLoad:true,theme:'neutral',securityLevel:'loose'});<\/script></body></html>`;
  }
  if (['jsx', 'tsx', 'react'].includes(art.lang)) {
    let js = code
      .replace(/^\s*import\s+[^\n]+$/gm, '')
      .replace(/export\s+default\s+/g, '');
    const usesRoot = /createRoot|ReactDOM\.render/.test(js);
    const m = js.match(/function\s+([A-Z]\w+)\s*\(/) || js.match(/const\s+([A-Z]\w+)\s*=/) || js.match(/class\s+([A-Z]\w+)\s+extends/);
    const comp = m ? m[1] : 'App';
    const mount = usesRoot ? '' : `
      const __root = ReactDOM.createRoot(document.getElementById('root'));
      __root.render(React.createElement(${comp}));`;
    return `<!doctype html><html><head>${base}<style>html,body{margin:0;padding:0;background:#fff;color:#1f1e1d;font-family:Inter,system-ui,sans-serif}#root{min-height:100vh}</style>
      <script src="${origin}/vendor/react.js"><\/script><script src="${origin}/vendor/react-dom.js"><\/script><script src="${origin}/vendor/babel.min.js"><\/script></head>
      <body><div id="root"></div>
      <script>window.addEventListener('error',function(e){var p=document.createElement('pre');p.style.cssText='color:#b2412f;padding:16px;white-space:pre-wrap;font:12px monospace';p.textContent=String(e.message||e);document.body.appendChild(p);});<\/script>
      <script type="text/babel" data-presets="react">${js}
      ${mount}
      <\/script></body></html>`;
  }
  return code;
}

function downloadArtifact(art) {
  const ext = { html: 'html', svg: 'svg', jsx: 'jsx', tsx: 'tsx', react: 'jsx', mermaid: 'mmd' }[art.lang] || 'txt';
  const blob = new Blob([art.code], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(art.title || 'artifact').replace(/[^\w -]+/g, '').trim() || 'artifact'}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function openArtifactTab(art) {
  const type = art.lang === 'svg' ? 'image/svg+xml' : 'text/html';
  const content = art.lang === 'html' || art.lang === 'svg' ? artifactDoc(art) : artifactDoc(art);
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ---------------------------------------------------------------- files */
async function loadFiles(path, hidden = S.files.hidden) {
  S.files.loading = true;
  try {
    const data = await api(`/api/files?path=${encodeURIComponent(path || '')}&hidden=${hidden ? 1 : 0}`);
    S.files.path = data.path;
    S.files.entries = data.entries;
    S.files.parent = data.parent;
    S.files.hidden = hidden;
    S.files.results = null;
  } catch (e) { toast(e.message); }
  S.files.loading = false;
  if (S.panel === 'files') renderPanel();
}

function renderFilesPanel(tabs) {
  tabs.className = 'panel-tabs';
  tabs.innerHTML = '';
  panelHeader('Files', 'folder', [
    { title: 'Upload files', icon: 'upload', onClick: () => $('#panelUpload').click() },
    { title: S.files.hidden ? 'Hide dotfiles' : 'Show dotfiles', icon: 'spark', onClick: () => loadFiles(S.files.path, !S.files.hidden) },
    { title: 'New folder', icon: 'plus', onClick: newFolder },
    { title: 'Refresh', icon: 'refresh', onClick: () => loadFiles(S.files.path) },
  ]);
  const body = $('#panelBody');
  body.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'files-toolbar';
  const crumbs = document.createElement('div');
  crumbs.className = 'crumbs';
  const rootBtn = document.createElement('button');
  rootBtn.textContent = '~';
  rootBtn.title = S.files.root || 'workspace';
  rootBtn.addEventListener('click', () => loadFiles(''));
  crumbs.appendChild(rootBtn);
  (S.files.path || '').split('/').filter(Boolean).forEach((part, i, arr) => {
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '/'; crumbs.appendChild(sep);
    const b = document.createElement('button'); b.textContent = part;
    b.addEventListener('click', () => loadFiles(arr.slice(0, i + 1).join('/')));
    crumbs.appendChild(b);
  });
  bar.appendChild(crumbs);
  body.appendChild(bar);

  const search = document.createElement('div');
  search.className = 'files-search';
  search.innerHTML = `<input type="search" placeholder="Find files in this workspace…">`;
  const input = search.querySelector('input');
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = input.value.trim();
    if (!q) { S.files.results = null; renderPanel(); return; }
    try {
      const data = await api(`/api/files/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(S.files.path)}`);
      S.files.results = data.results;
      renderPanel();
      // keep the search text after re-render
      const el = $('.files-search input');
      if (el) { el.value = q; el.focus(); }
    } catch (err) { toast(err.message); }
  });
  body.appendChild(search);

  const list = document.createElement('div');
  list.className = 'files-list';
  list.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('text/mx-path')) { e.preventDefault(); list.classList.add('drop-target'); }
  });
  list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
  list.addEventListener('drop', (e) => {
    const from = e.dataTransfer.getData('text/mx-path');
    list.classList.remove('drop-target');
    if (!from) return;
    e.preventDefault();
    moveFile(from, S.files.path);
  });
  const entries = S.files.results || S.files.entries;
  if (S.files.loading) {
    list.innerHTML = '<div class="files-empty"><span class="mini-spin"></span></div>';
  } else if (!entries?.length) {
    list.innerHTML = `<div class="files-empty">${S.files.results ? 'No matching files' : 'This folder is empty'}</div>`;
  } else {
    for (const entry of entries) {
      list.appendChild(fileRow(entry));
    }
  }
  body.appendChild(list);
}

function fileRow(entry) {
  const row = document.createElement('div');
  row.className = 'file-row' + (entry.dir ? ' dir' : '');
  const ic = entry.dir ? 'folder' : /^image/.test(entry.mime) ? 'image' : /pdf$/.test(entry.mime) ? 'pdf' : 'file';
  row.innerHTML = `<span class="file-ico">${icon(ic)}</span><span class="file-name"></span><span class="file-sub">${entry.dir ? 'folder' : fmtSize(entry.size)}</span>
    <span class="file-acts">
      ${entry.dir ? '' : `<button data-a="attach" title="Attach to chat">${icon('plus')}</button>`}
      <button data-a="download" title="Download">${icon('download')}</button>
      <button data-a="rename" title="Rename">${icon('edit')}</button>
      <button data-a="delete" title="Delete">${icon('trash')}</button>
    </span>`;
  row.querySelector('.file-name').textContent = entry.name;
  row.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.a;
    if (act) { e.stopPropagation(); fileAction(act, entry); return; }
    if (entry.dir) loadFiles(entry.path);
    else openFilePanel(entry);
  });
  // drag & drop to move files into folders
  if (!entry.dir) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/mx-path', entry.path);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
  } else {
    row.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('text/mx-path')) { e.preventDefault(); e.stopPropagation(); row.classList.add('drop-target'); }
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (e) => {
      const from = e.dataTransfer.getData('text/mx-path');
      row.classList.remove('drop-target');
      if (!from) return;
      e.preventDefault(); e.stopPropagation();
      moveFile(from, entry.path);
    });
  }
  return row;
}

async function moveFile(from, destDir) {
  const name = from.split('/').pop();
  const to = (destDir ? destDir + '/' : '') + name;
  if (from === to) return;
  try {
    await api('/api/files/rename', { method: 'POST', body: { from, to } });
    toast(`Moved ${name} → /${destDir}`);
    loadFiles(S.files.path);
  } catch (e) { toast(e.message, 3500); }
}

async function fileAction(act, entry) {
  if (act === 'attach') {
    S.attachments.push({ name: entry.name, path: entry.path, mime: entry.mime, size: entry.size });
    renderAttachments();
    toast(`Attached ${entry.name}`);
  } else if (act === 'download') {
    const a = document.createElement('a');
    a.href = `/api/files/raw?path=${encodeURIComponent(entry.path)}&download=1`;
    a.download = entry.name; a.click();
  } else if (act === 'rename') {
    const name = prompt('New name', entry.name);
    if (!name || name === entry.name) return;
    const dir = entry.path.split('/').slice(0, -1).join('/');
    await api('/api/files/rename', { method: 'POST', body: { from: entry.path, to: (dir ? dir + '/' : '') + name } });
    loadFiles(S.files.path);
  } else if (act === 'delete') {
    if (!confirm(`Delete “${entry.name}”?`)) return;
    await api('/api/files/delete', { method: 'POST', body: { path: entry.path } });
    loadFiles(S.files.path);
    toast('Deleted');
  }
}

async function newFolder() {
  const name = prompt('New folder name');
  if (!name) return;
  await api('/api/files/mkdir', { method: 'POST', body: { path: (S.files.path ? S.files.path + '/' : '') + name } });
  loadFiles(S.files.path);
}

/* ---- context side-screen: preview files (html / svg / md / text / image / pdf) ---- */
function fileKind(e) {
  const ext = (e.name.split('.').pop() || '').toLowerCase();
  if (/^image/.test(e.mime) && !/svg/.test(e.mime)) return 'image';
  if (/svg/.test(e.mime) || ext === 'svg') return 'svg';
  if (/pdf/.test(e.mime) || ext === 'pdf') return 'pdf';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['md', 'markdown'].includes(ext)) return 'md';
  return 'text';
}
function openFilePanel(entry) {
  S.activeFile = entry;
  S.fileTab = 'preview';
  S.panel = 'file';
  $('#panel').classList.add('open');
  $('#panel').setAttribute('aria-hidden', 'false');
  $$('.top-actions .ghost-btn').forEach((b) => b.classList.remove('active'));
  renderPanel();
}
async function loadFileContent(entry) {
  try {
    const d = await api(`/api/files/text?path=${encodeURIComponent(entry.path)}`);
    S.fileContent[entry.path] = d.content;
  } catch (e) {
    S.fileContent[entry.path] = null;
    S.fileError = e.message;
  }
  if (S.panel === 'file' && S.activeFile?.path === entry.path) renderPanel();
}
function wrapHtmlFile(code) {
  const base = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank">`;
  if (/<html[\s>]/i.test(code)) return code;
  return `<!doctype html><html><head>${base}<style>body{font-family:Inter,system-ui,sans-serif;margin:0;padding:24px;color:#1f1e1d;background:#fff}</style></head><body>${code}</body></html>`;
}
function renderFilePanel(tabs) {
  const e = S.activeFile;
  const body = $('#panelBody');
  if (!e) { tabs.className = 'panel-tabs'; body.innerHTML = '<div class="artifact-empty">No file open.</div>'; return; }
  const kind = fileKind(e);
  const ic = { html: 'code', svg: 'image', md: 'file', text: 'file', image: 'image', pdf: 'pdf' }[kind] || 'file';
  panelHeader(e.name, ic, [
    { title: 'Back to files', icon: 'arrow-left', onClick: () => { S.panel = 'files'; $$('.top-actions .ghost-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === 'files')); renderPanel(); } },
    { title: 'Attach to chat', icon: 'plus', onClick: () => { S.attachments.push({ name: e.name, path: e.path, mime: e.mime, size: e.size }); renderAttachments(); toast('Attached to chat'); } },
    { title: 'Download', icon: 'download', onClick: () => { const a = document.createElement('a'); a.href = `/api/files/raw?path=${encodeURIComponent(e.path)}&download=1`; a.download = e.name; a.click(); } },
    { title: 'Open raw in new tab', icon: 'external', onClick: () => window.open(`/api/files/raw?path=${encodeURIComponent(e.path)}`, '_blank') },
    { title: 'Reload', icon: 'refresh', onClick: () => { delete S.fileContent[e.path]; renderPanel(); } },
  ]);
  const textKind = ['html', 'svg', 'md', 'text'].includes(kind);
  const content = S.fileContent[e.path];
  tabs.className = 'panel-tabs';
  tabs.innerHTML = '';
  if (kind === 'html' || kind === 'svg') {
    tabs.className = 'panel-tabs show';
    tabs.innerHTML = `<button class="panel-tab ${S.fileTab !== 'code' ? 'active' : ''}" data-t="preview">Preview</button><button class="panel-tab ${S.fileTab === 'code' ? 'active' : ''}" data-t="code">Code</button>`;
  } else if (kind === 'md') {
    tabs.className = 'panel-tabs show';
    tabs.innerHTML = `<button class="panel-tab ${S.fileTab !== 'code' ? 'active' : ''}" data-t="preview">Rendered</button><button class="panel-tab ${S.fileTab === 'code' ? 'active' : ''}" data-t="code">Raw</button>`;
  }
  $$('.panel-tab', tabs).forEach((b) => b.addEventListener('click', () => { S.fileTab = b.dataset.t; renderPanel(); }));
  body.innerHTML = '';
  if (textKind && content === undefined) {
    body.innerHTML = '<div class="browser-loading"><span class="mini-spin"></span> Loading file…</div>';
    loadFileContent(e);
    return;
  }
  if (textKind && content === null) {
    body.innerHTML = `<div class="artifact-empty">${esc(S.fileError || 'Could not read file')}</div>`;
    return;
  }
  if (kind === 'image') {
    const img = document.createElement('img'); img.className = 'preview-img'; img.style.margin = '16px'; img.src = `/api/files/raw?path=${encodeURIComponent(e.path)}`;
    body.appendChild(img); return;
  }
  if (kind === 'pdf') {
    const f = document.createElement('iframe'); f.className = 'artifact-frame'; f.src = `/api/files/raw?path=${encodeURIComponent(e.path)}`;
    body.appendChild(f); return;
  }
  if (S.fileTab === 'code' || kind === 'text') {
    const div = document.createElement('div'); div.className = 'artifact-code';
    div.innerHTML = '<pre><code></code></pre>';
    div.querySelector('code').textContent = content;
    try { if (window.hljs) window.hljs.highlightElement(div.querySelector('code')); } catch {}
    body.appendChild(div); return;
  }
  if (kind === 'md') {
    const div = document.createElement('div'); div.className = 'file-prose prose';
    div.innerHTML = renderMarkdown(content, 'file:' + e.path);
    body.appendChild(div); enhance(div); return;
  }
  // html / svg live preview
  const frame = document.createElement('iframe');
  frame.className = 'artifact-frame';
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-popups-to-escape-sandbox');
  frame.srcdoc = kind === 'svg'
    ? `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf9f5}svg{max-width:92vw;max-height:88vh;height:auto}</style></head><body>${content}</body></html>`
    : wrapHtmlFile(content);
  body.appendChild(frame);
}

function previewFile(entry) {
  const body = $('#modalRoot');
  const isImg = /^image/.test(entry.mime) && !/svg/.test(entry.mime);
  const isPdf = /pdf/.test(entry.mime);
  const modal = document.createElement('div');
  modal.className = 'modal-root on';
  modal.innerHTML = `<div class="modal-scrim"></div><div class="modal wide">
    <h2></h2><p class="sub"></p><div class="pv"></div>
    <div class="modal-foot"><button class="btn" data-close>Close</button><button class="btn primary" data-attach>Attach to chat</button></div></div>`;
  modal.querySelector('h2').textContent = entry.name;
  modal.querySelector('.sub').textContent = `${entry.mime} · ${fmtSize(entry.size)}`;
  const pv = modal.querySelector('.pv');
  const close = () => modal.remove();
  modal.querySelector('[data-close]').addEventListener('click', close);
  modal.querySelector('.modal-scrim').addEventListener('click', close);
  modal.querySelector('[data-attach]').addEventListener('click', () => {
    S.attachments.push({ name: entry.name, path: entry.path, mime: entry.mime, size: entry.size });
    renderAttachments(); close(); toast('Attached to chat');
  });
  if (isImg) {
    const img = document.createElement('img'); img.className = 'preview-img';
    img.src = `/api/files/raw?path=${encodeURIComponent(entry.path)}`;
    pv.appendChild(img);
  } else if (isPdf) {
    const f = document.createElement('iframe'); f.className = 'preview-pdf';
    f.src = `/api/files/raw?path=${encodeURIComponent(entry.path)}`;
    pv.appendChild(f);
  } else {
    api(`/api/files/text?path=${encodeURIComponent(entry.path)}`).then((d) => {
      const pre = document.createElement('pre'); pre.className = 'preview-body'; pre.textContent = d.content;
      pv.appendChild(pre);
    }).catch((e) => { pv.innerHTML = `<div class="files-empty">${esc(e.message)}</div>`; });
  }
  document.body.appendChild(modal);
}

/* ---------------------------------------------------------------- browser */
function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}
function showPanelOpen() {
  $('#panel').classList.add('open');
  $('#panel').setAttribute('aria-hidden', 'false');
}
function openBrowser(url, preset = null) {
  S.panel = 'browser';
  showPanelOpen();
  const target = normalizeUrl(preset?.url || url || S.browser.url || 'https://example.com');
  if (!S.capabilities.liveBrowser) {
    loadReaderPage(target);
  } else {
    startLive(target);
  }
}
async function loadReaderPage(url) {
  url = normalizeUrl(url) || 'https://example.com';
  S.browser.tab = 'reader';
  S.browser.url = url;
  S.browser.loading = true;
  S.browser.error = null;
  S.browser.data = null;
  if (S.panel === 'browser') renderPanel();
  try {
    const d = await api('/api/browse', { method: 'POST', body: { url, screenshot: false } });
    S.browser.data = d;
    S.browser.url = d.url || url;
    S.browser.title = d.title || url;
    S.browser.loading = false;
  } catch (e) {
    S.browser.loading = false;
    S.browser.error = e.message;
  }
  if (S.panel === 'browser') renderPanel();
}
async function startLive(url) {
  if (!S.capabilities.liveBrowser) return loadReaderPage(url);
  url = normalizeUrl(url) || 'https://example.com';
  closeLive();
  S.browser.loading = true; S.browser.error = null; S.browser.session = null; S.browser.tab = 'live';
  if (S.panel === 'browser') renderPanel();
  try {
    const d = await api('/api/browser/open', { method: 'POST', body: { url } });
    S.browser.session = d.session; S.browser.url = d.url; S.browser.title = d.title; S.browser.loading = false;
    connectLive(d.session);
    if (S.panel === 'browser') renderPanel();
  } catch (e) {
    S.browser.loading = false; S.browser.error = e.message;
    if (S.panel === 'browser') renderPanel();
  }
}
function connectLive(session) {
  if (S.browser.es) { S.browser.es.close(); }
  const es = new EventSource('/api/browser/events?session=' + encodeURIComponent(session));
  S.browser.es = es;
  es.onmessage = (m) => {
    let d; try { d = JSON.parse(m.data); } catch { return; }
    if (d.type === 'frame') {
      const img = document.getElementById('liveFrame');
      if (img) img.src = 'data:image/jpeg;base64,' + d.data;
    } else if (d.type === 'nav') {
      S.browser.url = d.url; S.browser.title = d.title;
      const u = document.getElementById('browserUrl');
      if (u && document.activeElement !== u) u.value = d.url;
      const t = document.getElementById('browserTitle');
      if (t) t.textContent = d.title || '';
    } else if (d.type === 'error') { toast(d.message || 'Browser error'); }
  };
}
function closeLive() {
  if (S.browser.es) { S.browser.es.close(); S.browser.es = null; }
  if (S.browser.session) {
    const s = S.browser.session; S.browser.session = null;
    api('/api/browser/close', { method: 'POST', body: { session: s } }).catch(() => {});
  }
}
function sendInput(ev) {
  if (!S.browser.session) return;
  fetch('/api/browser/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: S.browser.session, ...ev }) }).catch(() => {});
}
function liveNav(action, url) {
  if (!S.browser.session) { startLive(url || S.browser.url); return; }
  const path = { back: '/api/browser/back', forward: '/api/browser/forward', reload: '/api/browser/reload', nav: '/api/browser/nav' }[action];
  api(path, { method: 'POST', body: { session: S.browser.session, url } }).catch((e) => toast(e.message));
}

function renderBrowserPanel(tabs) {
  const canLive = !!S.capabilities.liveBrowser;
  panelHeader('Browser', 'globe', canLive ? [
    { title: 'Back', icon: 'arrow-left', onClick: () => liveNav('back') },
    { title: 'Forward', icon: 'arrow-right', onClick: () => liveNav('forward') },
    { title: 'Reload', icon: 'refresh', onClick: () => liveNav('reload') },
  ] : [
    { title: 'Reload', icon: 'refresh', onClick: () => S.browser.url && loadReaderPage(S.browser.url) },
    { title: 'Open in new tab', icon: 'external', onClick: () => S.browser.url && window.open(S.browser.url, '_blank') },
  ]);
  if (canLive) {
    tabs.className = 'panel-tabs show';
    tabs.innerHTML = `<button class="panel-tab ${S.browser.tab !== 'reader' ? 'active' : ''}" data-t="live">Live</button><button class="panel-tab ${S.browser.tab === 'reader' ? 'active' : ''}" data-t="reader">Reader</button>`;
    $$('.panel-tab', tabs).forEach((b) => b.addEventListener('click', () => { S.browser.tab = b.dataset.t; renderPanel(); }));
  } else {
    S.browser.tab = 'reader';
    tabs.className = 'panel-tabs';
    tabs.innerHTML = '';
  }

  const body = $('#panelBody');
  body.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'browser-bar';
  bar.innerHTML = `<span class="url-wrap">${icon('globe')}<input id="browserUrl" type="text" spellcheck="false" placeholder="Enter a URL (https://…)"></span><button class="go">Go</button>`;
  const input = bar.querySelector('input');
  input.value = S.browser.url || '';
  const go = () => (canLive && S.browser.tab !== 'reader' ? liveNav('nav', input.value) : loadReaderPage(input.value));
  bar.querySelector('.go').addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  body.appendChild(bar);

  if (S.browser.loading) {
    body.insertAdjacentHTML('beforeend', `<div class="browser-loading"><span class="mini-spin"></span> ${canLive && S.browser.tab !== 'reader' ? 'Opening page in a real browser…' : 'Fetching readable page…'}</div>`);
    return;
  }
  if (S.browser.error) {
    body.insertAdjacentHTML('beforeend', `<div class="browser-blank" style="color:#b2412f">${esc(S.browser.error)}<br><br><button class="btn" id="retryLive">Retry</button></div>`);
    body.querySelector('#retryLive')?.addEventListener('click', () => go());
    return;
  }
  if (!canLive || S.browser.tab === 'reader') {
    if (!S.browser.url) {
      body.insertAdjacentHTML('beforeend', `<div class="browser-blank">${icon('globe')}<br>Enter a URL above to read any public web page here, or enable <b>Web</b> in chat.</div>`);
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'browser-body';
    const renderReader = (d) => {
      wrap.innerHTML = '';
      const meta = document.createElement('div');
      meta.className = 'browser-meta';
      meta.innerHTML = `<h3></h3><div class="u"></div>`;
      meta.querySelector('h3').textContent = d.title || d.url || S.browser.url;
      meta.querySelector('.u').textContent = d.url || S.browser.url;
      wrap.appendChild(meta);
      const t = document.createElement('div');
      t.className = 'browser-text';
      t.textContent = d.text || '(no readable text found)';
      wrap.appendChild(t);
      if (d.links?.length) {
        const lh = document.createElement('div');
        lh.className = 'browser-links-head';
        lh.textContent = `Links (${Math.min(d.links.length, 25)})`;
        wrap.appendChild(lh);
        const ll = document.createElement('div');
        ll.className = 'browser-links';
        for (const l of d.links.slice(0, 25)) {
          const a = document.createElement('a');
          a.className = 'browser-link';
          a.href = l.url;
          a.innerHTML = `<b></b><span></span>`;
          a.querySelector('b').textContent = l.text || l.url;
          a.querySelector('span').textContent = l.url;
          a.addEventListener('click', (ev) => { ev.preventDefault(); loadReaderPage(l.url); });
          ll.appendChild(a);
        }
        wrap.appendChild(ll);
      }
    };
    body.appendChild(wrap);
    if (S.browser.data && S.browser.data.url === S.browser.url) {
      renderReader(S.browser.data);
    } else {
      wrap.innerHTML = '<div class="browser-loading"><span class="mini-spin"></span> Loading readable text…</div>';
      api('/api/browse', { method: 'POST', body: { url: S.browser.url, screenshot: false } })
        .then((d) => { S.browser.data = d; renderReader(d); })
        .catch((e) => { wrap.innerHTML = `<div class="browser-blank" style="color:#b2412f">${esc(e.message)}</div>`; });
    }
    return;
  }
  // live interactive viewport
  const meta = document.createElement('div');
  meta.className = 'browser-meta';
  meta.innerHTML = `<h3 id="browserTitle"></h3><div class="u">Click, scroll, type and drag — it's a real browser.</div>`;
  meta.querySelector('#browserTitle').textContent = S.browser.title || '';
  body.appendChild(meta);
  const vp = document.createElement('div');
  vp.className = 'live-viewport';
  vp.tabIndex = 0;
  vp.innerHTML = `<img id="liveFrame" alt="" draggable="false"><div class="live-badge">LIVE</div>`;
  body.appendChild(vp);
  attachLiveControls(vp);
}

function attachLiveControls(vp) {
  const rect = () => vp.getBoundingClientRect();
  const toPage = (e) => {
    const r = rect();
    return { x: (e.clientX - r.left) * (1280 / r.width), y: (e.clientY - r.top) * (800 / r.height) };
  };
  let dragging = false, lastHover = 0;
  vp.addEventListener('pointerdown', (e) => {
    vp.focus(); vp.setPointerCapture(e.pointerId);
    dragging = true;
    const p = toPage(e);
    sendInput({ kind: 'mouse', action: 'down', ...p, button: 'left', buttons: 1, clickCount: 1 });
  });
  vp.addEventListener('pointermove', (e) => {
    const p = toPage(e);
    if (dragging) sendInput({ kind: 'mouse', action: 'move', ...p, button: 'left', buttons: 1 });
    else { const now = Date.now(); if (now - lastHover > 50) { lastHover = now; sendInput({ kind: 'mouse', action: 'move', ...p, buttons: 0 }); } }
  });
  const up = (e) => { if (!dragging) return; dragging = false; const p = toPage(e); sendInput({ kind: 'mouse', action: 'up', ...p, button: 'left', buttons: 0, clickCount: 1 }); };
  vp.addEventListener('pointerup', up);
  vp.addEventListener('pointercancel', up);
  vp.addEventListener('dblclick', (e) => { const p = toPage(e); sendInput({ kind: 'mouse', action: 'down', ...p, button: 'left', buttons: 1, clickCount: 2 }); sendInput({ kind: 'mouse', action: 'up', ...p, button: 'left', buttons: 0, clickCount: 2 }); });
  vp.addEventListener('wheel', (e) => { e.preventDefault(); const p = toPage(e); sendInput({ kind: 'mouse', action: 'wheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY }); }, { passive: false });
  vp.addEventListener('contextmenu', (e) => e.preventDefault());
  vp.addEventListener('keydown', (e) => {
    const special = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'];
    if (special.includes(e.key)) {
      e.preventDefault();
      sendInput({ kind: 'key', action: 'down', key: e.key, code: e.code });
      sendInput({ kind: 'key', action: 'up', key: e.key, code: e.code });
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      sendInput({ kind: 'key', action: 'down', key: e.key, code: e.code, text: e.key });
      sendInput({ kind: 'key', action: 'up', key: e.key, code: e.code });
    }
  });
}

/* ---------------------------------------------------------------- model picker */
function updateThinkSupport() {
  const tc = $('#thinkControl');
  if (!tc) return;
  const m = S.models.find((x) => x.name === S.model);
  const localNoThink = m && !m.cloud && Array.isArray(m.capabilities) && m.capabilities.length > 0 && !m.capabilities.includes('thinking');
  tc.classList.toggle('unsupported', !!localNoThink);
  tc.title = localNoThink
    ? `${modelShort(S.model)} does not support thinking mode.`
    : 'Controls reasoning depth for models that support thinking. Off is fastest.';
}

function renderModel() {
  const m = S.models.find((x) => x.name === S.model);
  $('#modelLabel').textContent = m?.mode
    ? (m.modeHint || modelShort(S.model))
    : (modelShort(S.model) || 'select model');
  $('#topModel').textContent = S.model ? (m?.cloud ? (m.providerName || 'cloud') : (m?.params || S.model)) : 'local';
  $$('.tool-toggle').forEach((b) => {
    const t = b.dataset.tool;
    b.classList.toggle('on', t === 'web' ? S.useWeb : t === 'files' ? S.useFiles : t === 'subagents' ? S.useSubagents : S.useTools);
  });
  const mc = $('#modeControl');
  if (mc) {
    if (m?.mode) S.mode = m.mode;
    mc.dataset.mode = S.mode;
    mc.classList.toggle('cloud', !!m && !!m.cloud);
    mc.querySelectorAll('.mode-seg button').forEach((b) => {
      const on = b.dataset.mode === S.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    mc.title = m?.mode
      ? `${m.modeLabel} — ${m.modeHint}. Click Fast or Smart to switch local models.`
      : 'Switch to a local model with Fast or Smart.';
  }
  updateThinkSupport();
}

// Switch between the two exposed local models without opening the picker.
function setLocalMode(mode) {
  if (!mode) return;
  const target = S.models.find((m) => m.mode === mode);
  if (!target) { toast(`The ${mode} model is not installed on this server.`); return; }
  if (S.mode === mode && S.model === target.name) return;
  S.mode = mode;
  S.model = target.name;
  S.preferred = { ...(S.preferred || {}), local: target.name };
  localStorage.setItem('mxgpt-mode', mode);
  if (S.chat) { S.chat.model = target.name; api(`/api/chats/${S.chat.id}`, { method: 'PATCH', body: { model: target.name } }).catch(() => {}); }
  api('/api/settings', { method: 'POST', body: { model: target.name, preferred: { local: target.name } } }).catch(() => {});
  renderModel();
  toast(mode === 'smart' ? 'Smart mode — Inkling 26B. Slower, better reasoning.' : 'Fast mode — LFM3 1.7B. Instant replies.');
}

function providerIcon(id, name) {
  const k = (id || '') + ' ' + (name || '');
  if (/gemini|google/i.test(k)) return 'spark';
  if (/opencode/i.test(k)) return 'code';
  if (/local|ollama/i.test(k)) return 'star';
  return 'globe';
}

function buildSources() {
  const sources = [];
  const prefOf = (id) => S.preferred?.[id] || '';
  const local = S.models.filter((m) => !m.cloud);
  sources.push({ id: 'local', name: 'Local', sub: 'Ollama on this server', icon: 'star', models: local, pref: prefOf('local') });
  const byProv = new Map();
  for (const m of S.models) {
    if (!m.cloud) continue;
    if (!byProv.has(m.providerId)) byProv.set(m.providerId, { id: m.providerId, name: m.providerName, sub: 'Cloud API', icon: providerIcon(m.providerId, m.providerName), models: [], pref: prefOf(m.providerId) });
    byProv.get(m.providerId).models.push(m);
  }
  for (const p of S.providers) {
    if (byProv.has(p.id)) sources.push(byProv.get(p.id));
    else if (p.enabled) sources.push({ id: p.id, name: p.name, sub: 'Cloud API · no models yet', icon: providerIcon(p.id, p.name), models: [], pref: prefOf(p.id) });
  }
  return sources;
}

function modelMenu(anchor) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'popover model-pop';
  let source = null;
  let query = '';

  const draw = () => {
    const sources = buildSources();
    if (!source) {
      pop.innerHTML = `<div class="pop-label">Choose a source</div><div class="model-list"></div>
        <div class="pop-sep"></div><button class="pop-item" data-manage>${icon('settings')} Providers &amp; API keys</button>`;
      const list = pop.querySelector('.model-list');
      for (const s of sources) {
        const b = document.createElement('button');
        b.className = 'source-row';
        b.innerHTML = `<span class="src-ico">${icon(s.icon)}</span><span class="src-main"><b></b><small></small></span><span class="src-count">${s.models.length}</span>${icon('chevron-right')}`;
        b.querySelector('b').textContent = s.name;
        b.querySelector('small').textContent = s.pref
          ? `Default · ${modelShort(s.pref)}`
          : s.sub;
        b.addEventListener('click', async () => {
          source = s; query = ''; draw();
          if (s.id !== 'local' && !s._fetched) {
            s._fetched = true;
            try {
              await api(`/api/providers/${s.id}/refresh`, { method: 'POST' });
              await syncModels();
              const ns = buildSources().find((x) => x.id === s.id);
              if (ns) { ns._fetched = true; source = ns; }
              draw();
            } catch (e) { /* keep cached models */ }
          }
        });
        list.appendChild(b);
      }
      if (!S.models.length) list.insertAdjacentHTML('beforeend', '<div class="files-empty">No models yet. Start Ollama or add a provider.</div>');
      pop.querySelector('[data-manage]').addEventListener('click', () => { closePopover(); openSettings('providers'); });
    } else {
      const items = source.models.filter((m) => !query || (m.displayName || m.name).toLowerCase().includes(query));
      // the source's remembered default floats to the top
      items.sort((a, b) => (sameModel(b.name, source.pref) ? 1 : 0) - (sameModel(a.name, source.pref) ? 1 : 0));
      pop.innerHTML = `<div class="mp-head"><button class="icon-btn" data-back>${icon('arrow-left')}</button><span class="mp-title"></span></div>
        <div class="mp-search"><input type="search" placeholder="Filter models…"></div>
        <div class="model-list"></div>`;
      pop.querySelector('.mp-title').textContent = source.name;
      const input = pop.querySelector('.mp-search input');
      input.value = query;
      input.addEventListener('input', () => { query = input.value.toLowerCase(); draw(); input.focus(); });
      pop.querySelector('[data-back]').addEventListener('click', () => { source = null; draw(); });
      const list = pop.querySelector('.model-list');
      for (const m of items) {
        const b = document.createElement('button');
        b.className = 'model-opt' + (m.name === S.model ? ' active' : '');
        b.innerHTML = `<span class="mo-main"><b></b><small></small><span class="badges"></span></span>${sameModel(m.name, S.model) ? icon('check') : ''}`;
        b.querySelector('b').textContent = m.cloud ? modelShort(m.name) : (m.displayName || m.name);
        b.querySelector('small').textContent = m.cloud ? 'cloud' : [m.params, m.quant].filter(Boolean).join(' · ');
        const badges = b.querySelector('.badges');
        if (sameModel(m.name, source.pref)) {
          const d = document.createElement('span'); d.className = 'badge def'; d.textContent = 'default'; badges.appendChild(d);
        }
        if (S.subagentModels.some((sm) => sm.name === m.name)) {
          const sb = document.createElement('span'); sb.className = 'badge hot'; sb.textContent = 'subagent <3B'; badges.appendChild(sb);
        }
        for (const c of (m.capabilities || []).filter((c) => c !== 'completion')) {
          const s = document.createElement('span'); s.className = 'badge' + (c === 'tools' ? ' hot' : ''); s.textContent = c; badges.appendChild(s);
        }
        b.addEventListener('click', () => {
          S.model = m.name;
          if (m.mode) { S.mode = m.mode; localStorage.setItem('mxgpt-mode', m.mode); }
          S.preferred = { ...(S.preferred || {}), [source.id]: m.name };
          if (S.chat) { S.chat.model = m.name; api(`/api/chats/${S.chat.id}`, { method: 'PATCH', body: { model: m.name } }).catch(() => {}); }
          api('/api/settings', { method: 'POST', body: { model: m.name, preferred: { [source.id]: m.name } } }).catch(() => {});
          renderModel();
          closePopover();
        });
        list.appendChild(b);
      }
      if (!items.length) list.innerHTML = `<div class="files-empty">${source.models.length ? 'No match' : 'No models in this source yet.'}</div>`;
      else list.insertAdjacentHTML('beforeend', `<div class="mp-hint">${source.pref ? `Default for ${esc(source.name)}: <b>${esc(modelShort(source.pref))}</b>` : 'Your pick becomes the default for this source.'}</div>`);
      setTimeout(() => input.focus(), 0);
    }
    positionPopover(pop, anchor, 'top');
  };

  document.body.appendChild(pop);
  draw();
}

function positionPopover(pop, anchor, side = 'bottom') {
  const r = anchor.getBoundingClientRect();
  pop.style.visibility = 'hidden';
  pop.style.left = '0px'; pop.style.top = '0px';
  const pr = pop.getBoundingClientRect();
  let left = Math.min(r.left, window.innerWidth - pr.width - 12);
  left = Math.max(12, left);
  let top = side === 'top' ? r.top - pr.height - 8 : r.bottom + 8;
  if (top + pr.height > window.innerHeight - 12) top = Math.max(12, r.top - pr.height - 8);
  if (top < 12) top = 12;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  pop.style.visibility = '';
  setTimeout(() => {
    const close = (e) => { if (!pop.contains(e.target) && e.target !== anchor) { closePopover(); document.removeEventListener('mousedown', close); } };
    document.addEventListener('mousedown', close);
  }, 0);
}
function closePopover() { $$('.popover').forEach((p) => p.remove()); }

/* ---------------------------------------------------------------- modals */
function openSettings(tab = 'general') {
  if (tab === 'ollama' && !S.capabilities.ollamaSettings) tab = 'general';
  const m = document.createElement('div');
  m.className = 'modal-root on';
  const tabBtns = [
    '<button data-t="general">General</button>',
    '<button data-t="usage">Usage</button>',
    S.capabilities.ollamaSettings ? '<button data-t="ollama">Ollama (LAN)</button>' : '',
    '<button data-t="providers">Providers &amp; API keys</button>',
  ].join('');
  m.innerHTML = `<div class="modal-scrim"></div><div class="modal wide">
    <h2>Settings</h2><p class="sub">Your assistant, your hardware, your keys.</p>
    <div class="settings-tabs">${tabBtns}</div>
    <div id="setBody"></div>
    <div class="modal-foot"><button class="btn" data-close>Close</button></div>
  </div>`;
  const close = () => m.remove();
  m.querySelector('[data-close]').addEventListener('click', close);
  m.querySelector('.modal-scrim').addEventListener('click', close);
  const body = m.querySelector('#setBody');
  const tabs = [...m.querySelectorAll('.settings-tabs button')];
  const show = (t) => {
    tabs.forEach((b) => b.classList.toggle('active', b.dataset.t === t));
    body.innerHTML = '';
    if (t === 'providers') renderProvidersPanel(body, () => show('providers'));
    else if (t === 'usage') renderUsagePanel(body, close, () => show('usage'));
    else if (t === 'ollama' && S.capabilities.ollamaSettings) renderOllamaPanel(body, () => show('ollama'));
    else renderGeneralPanel(body, close);
  };
  tabs.forEach((b) => b.addEventListener('click', () => show(b.dataset.t)));
  document.body.appendChild(m);
  show(tab);
}

function modelOptions(selected) {
  const groups = new Map();
  for (const m of S.models) {
    const key = m.providerName || 'On this server';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.entries()].map(([label, items]) =>
    `<optgroup label="${esc(label)}">${items.map((x) => `<option value="${esc(x.name)}" ${x.name === selected ? 'selected' : ''}>${esc(x.displayName || x.name)}${x.cloud ? '' : x.params ? ' · ' + esc(x.params) : ''}</option>`).join('')}</optgroup>`
  ).join('');
}

function renderGeneralPanel(body, close) {
  const cfg = S.settings;
  const el = document.createElement('div');
  const personaOpts = (S.personas || []).map((p) =>
    `<option value="${esc(p.id)}" ${(cfg.persona || 'default') === p.id ? 'selected' : ''}>${esc(p.name)} — ${esc(p.desc)}</option>`
  ).join('');
  const canChangePw = S.authRequired && !S.capabilities.gatewayAuth;
  el.innerHTML = `
    <div class="row">
      <label class="field"><span>Default model</span><select id="setModel">${modelOptions(S.model)}</select></label>
      <label class="field"><span>Default persona</span><select id="setPersona">${personaOpts}</select></label>
    </div>
    <label class="field"><span>Custom instructions</span><textarea id="setInstr" placeholder="How should mx-GPT respond? Tone, language, expertise, things to avoid…"></textarea>
    <div class="hint">Applied to every new message across chats.</div></label>
    ${S.capabilities.ollamaSettings ? '<div class="hint settings-note">Ollama daemon settings, model management, and runtime options are available in the <b>Ollama (LAN)</b> tab.</div>' : ''}
    ${canChangePw ? `<div class="divider"></div>
    <label class="field"><span>Change password</span><div class="row"><input id="pwCur" type="password" placeholder="Current password"><input id="pwNew" type="password" placeholder="New password"></div></label>` : ''}
    <div class="settings-actions">
      <button class="btn primary" id="saveBtn">Save changes</button>
      <span class="hint" style="margin:0">${S.capabilities.gatewayAuth ? 'Signed in via gateway' : (S.authRequired ? '' : 'No password · open to your local network')}</span>
      ${S.authRequired ? '<button class="btn ghost danger-text" id="logoutBtn">Sign out</button>' : ''}
    </div>
    <div class="hint settings-meta">Workspace: <code>${esc(S.files.root || '~')}</code><br>mx-GPT v${esc(S.version || '1.0')} · ${S.models.filter((x) => !x.cloud).length} local models · ${S.providers.length} cloud provider${S.providers.length === 1 ? '' : 's'}</div>`;
  el.querySelector('#setInstr').value = cfg.customInstructions || '';
  body.appendChild(el);
  el.querySelector('#saveBtn').addEventListener('click', async () => {
    try {
      const patch = {
        model: el.querySelector('#setModel').value,
        persona: el.querySelector('#setPersona').value,
        customInstructions: el.querySelector('#setInstr').value,
      };
      S.settings = await api('/api/settings', { method: 'POST', body: patch });
      S.model = patch.model;
      S.persona = patch.persona;
      renderModel();
      updatePersonaPill();
      toast('Settings saved');
      const cur = el.querySelector('#pwCur')?.value, next = el.querySelector('#pwNew')?.value;
      if (cur && next) {
        await api('/api/password', { method: 'POST', body: { current: cur, next } });
        toast('Password changed — signing in again'); setTimeout(() => (location.href = '/login'), 900);
      }
      close();
    } catch (e) { toast(e.message, 3500); }
  });
  el.querySelector('#logoutBtn')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.href = '/login';
  });
  setTimeout(() => el.querySelector('#setInstr')?.focus(), 60);
}

function renderUsagePanel(body, close, rerender) {
  const el = document.createElement('div');
  el.className = 'usage-panel';
  body.appendChild(el);

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (n) => {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  };
  const dur = (ms) => {
    const s = Math.round((Number(ms) || 0) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  };
  const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const userLabel = (id) => (id === 'owner' ? 'Admin (owner)' : `User ${id}`);

  const draw = async () => {
    el.innerHTML = `<div class="hint" style="margin:0 0 12px"><span class="mini-spin"></span> Reading token usage…</div>`;
    let data;
    try { data = await api('/api/usage'); }
    catch (e) { el.innerHTML = `<div class="usage-empty">Could not load usage: ${esc(e.message)}</div>`; return; }

    const t = data.totals || {};
    const models = data.byModel || [];
    const chats = data.byChat || [];
    const users = data.users || [];
    const userRows = users.map((u) => `\n      <tr>\n        <td class=\"m\">${esc(userLabel(u.id))}</td>\n        <td class=\"num\">${fmt(u.chats)}</td>\n        <td class=\"num\">${fmt(u.requests)}</td>\n        <td class=\"num\">${fmt(u.promptTokens)}</td>\n        <td class=\"num\">${fmt(u.evalTokens + (u.subagentTokens || 0))}</td>\n        <td class=\"num\"><b>${fmt(u.totalTokens)}</b></td>\n        <td class=\"num\">${u.avgTokensPerSec ? u.avgTokensPerSec + ' t/s' : '—'}</td>\n      </tr>`).join('');

    // Last 14 days, zero-filled.
    const byDay = new Map((data.byDay || []).map((d) => [d.day, d]));
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      days.push(byDay.get(key) || { day: key, totalTokens: 0, promptTokens: 0, evalTokens: 0, requests: 0 });
    }
    const peak = Math.max(1, ...days.map((d) => d.totalTokens));
    const bars = days.map((d) => {
      const h = d.totalTokens ? Math.max(3, Math.round((d.totalTokens / peak) * 100)) : 0;
      const tip = `${dayLabel(d.day)} — ${fmt(d.totalTokens)} tokens · ${d.requests} request${d.requests === 1 ? '' : 's'}`;
      return `<div class="usage-bar" title="${esc(tip)}"><div class="usage-bar-fill" style="height:${h}%"></div><span>${dayLabel(d.day).split(' ')[1]}</span></div>`;
    }).join('');

    const modelRows = models.length ? models.map((m) => `
      <tr>
        <td class="m" title="${esc(m.model)}">${esc(m.model)}</td>
        <td class="num">${fmt(m.requests)}</td>
        <td class="num">${fmt(m.promptTokens)}</td>
        <td class="num">${fmt(m.evalTokens)}</td>
        <td class="num"><b>${fmt(m.totalTokens)}</b></td>
        <td class="num">${m.avgTokensPerSec ? m.avgTokensPerSec + ' t/s' : '—'}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="usage-empty">No local or cloud replies recorded yet.</td></tr>';

    const chatRows = chats.slice(0, 15).map((c) => `
      <tr class="usage-chat-row" data-chat="${esc(c.id)}" title="Open chat">
        <td class="usage-chat-title">${esc(c.title || 'Untitled')}</td>
        <td class="m">${esc(c.model || '—')}</td>
        <td class="num">${fmt(c.requests)}</td>
        <td class="num">${fmt(c.promptTokens)}</td>
        <td class="num">${fmt(c.evalTokens)}</td>
        <td class="num"><b>${fmt(c.totalTokens)}</b></td>
      </tr>`).join('');

    el.innerHTML = `
      <div class="usage-cards">
        <div class="usage-card"><span>Requests</span><b>${fmt(t.requests)}</b><small>${chats.length} chat${chats.length === 1 ? '' : 's'}</small></div>
        <div class="usage-card"><span>Prompt tokens</span><b>${fmt(t.promptTokens)}</b><small>sent to the model</small></div>
        <div class="usage-card"><span>Completion tokens</span><b>${fmt(t.evalTokens + (t.subagentTokens || 0))}</b><small>${t.subagentTokens ? `${fmt(t.subagentTokens)} from subagents` : 'generated'}</small></div>
        <div class="usage-card"><span>Avg speed</span><b>${t.avgTokensPerSec ? t.avgTokensPerSec : '—'}</b><small>${t.avgTokensPerSec ? 'tokens / second' : 'no replies yet'}</small></div>
      </div>
      <div class="hint" style="margin:-6px 0 14px">Total generation time ${dur(t.totalMs)} · ${fmt(t.totalTokens)} tokens all-in.</div>

      <div class="ol-section">
        <h3><span>Tokens per day</span><span class="badge">last 14 days</span></h3>
        <div class="usage-bars">${bars}</div>
      </div>

      <div class="ol-section">
        <h3><span>By model</span></h3>
        <table class="usage-table">
          <thead><tr><th>Model</th><th class="num">Req</th><th class="num">Prompt</th><th class="num">Completion</th><th class="num">Total</th><th class="num">Speed</th></tr></thead>
          <tbody>${modelRows}</tbody>
        </table>
      </div>

      ${users.length ? `<div class="ol-section">
        <h3><span>By user</span><span class="badge">${users.length} account${users.length === 1 ? '' : 's'}</span></h3>
        <table class="usage-table">
          <thead><tr><th>User</th><th class="num">Chats</th><th class="num">Req</th><th class="num">Prompt</th><th class="num">Completion</th><th class="num">Total</th><th class="num">Speed</th></tr></thead>
          <tbody>${userRows || '<tr><td colspan="7" class="usage-empty">No per-user usage yet.</td></tr>'}</tbody>
        </table>
      </div>` : ''}

      <div class="ol-section">
        <h3><span>By chat</span><button class="btn tiny" id="usageRefresh">Refresh</button></h3>
        ${chats.length ? `<table class="usage-table">
          <thead><tr><th>Chat</th><th>Model</th><th class="num">Req</th><th class="num">Prompt</th><th class="num">Completion</th><th class="num">Total</th></tr></thead>
          <tbody>${chatRows}</tbody>
        </table>` : '<div class="usage-empty">Send a message and your token usage will show up here.</div>'}
      </div>`;

    el.querySelector('#usageRefresh')?.addEventListener('click', draw);
    el.querySelectorAll('.usage-chat-row').forEach((row) => row.addEventListener('click', () => {
      const id = row.dataset.chat;
      if (!id) return;
      close();
      openChat(id);
    }));
  };

  draw();
}

function renderOllamaPanel(body, rerender) {
  const cfg = S.settings || {};
  const o = cfg.ollama || {};
  const val = (v, d) => (v === null || v === undefined || v === '' ? d : v);
  const fmtGb = (b) => (b ? (b / 1073741824).toFixed(1) + ' GB' : '0 GB');
  const el = document.createElement('div');
  el.className = 'ollama-panel';
  el.innerHTML = `
    <div class="ollama-status" id="olStatus"><span class="mini-spin"></span><span>Checking the Ollama server…</span></div>

    <div class="ol-section" id="olModelsSec">
      <h3><span>Models &amp; Memory</span><span class="badge hot">LAN Only</span></h3>
      <div id="olLoadedWrap" style="margin-bottom:10px"></div>
      <div class="ol-pull-row">
        <input id="olPullName" placeholder="Pull model from Ollama registry (e.g. qwen3:8b, llama3.2:3b)">
        <button class="btn primary tiny" id="olPullBtn" style="height:36px">Pull</button>
      </div>
      <div class="ol-pull-log" id="olPullLog"></div>
      <div id="olInstalledWrap"></div>
    </div>

    ${S.capabilities.ollamaEnvDaemon ? `
    <div class="ol-section" id="olDaemonSec">
      <h3><span>Ollama Server Environment (<code>ollama.env</code>)</span><button class="btn tiny" id="olRestartOnly">Restart Ollama</button></h3>
      <div id="olEnvFields" class="hint">Loading server environment…</div>
      <div class="settings-actions" style="margin-top:12px">
        <button class="btn primary tiny" id="olEnvSaveRestart" style="height:32px">Save &amp; Restart Ollama</button>
        <button class="btn tiny" id="olEnvSave" style="height:32px">Save env only</button>
      </div>
    </div>` : ''}

    <div class="ol-section">
      <h3><span>Per-Request Inference Defaults</span></h3>
      <p class="provider-intro" style="margin-bottom:10px">Applied to local Ollama chat requests from this LAN host. Leave Context Window on <b>Auto</b> to match <code>OLLAMA_CONTEXT_LENGTH</code> without forcing model reloads.</p>
      <div class="field">
        <span>Context window</span>
        <div class="ctx-presets">
          <button type="button" class="chip" data-ctx="">Auto (server)</button>
          ${[8192, 16384, 32768, 65536, 131072].map((n) => `<button type="button" class="chip" data-ctx="${n}">${n / 1024}k</button>`).join('')}
        </div>
        <div class="ctx-row"><input id="olCtx" type="number" min="2048" max="262144" step="1024" placeholder="server default" value="${cfg.numCtx ?? ''}"><span class="hint" style="margin:0">tokens (blank = server default)</span></div>
      </div>

      <div class="row">
        <label class="field"><span>Temperature</span><input id="olTemp" type="number" min="0" max="2" step="0.1" value="${val(cfg.temperature, 0.7)}"></label>
        <label class="field"><span>Top P</span><input id="olTopP" type="number" min="0" max="1" step="0.05" value="${val(o.topP, 0.95)}"></label>
      </div>
      <div class="row">
        <label class="field"><span>Top K</span><input id="olTopK" type="number" min="0" max="500" step="1" value="${val(o.topK, 40)}"></label>
        <label class="field"><span>Repeat penalty</span><input id="olRepeat" type="number" min="0" max="3" step="0.05" value="${val(o.repeatPenalty, 1.1)}"></label>
      </div>
      <div class="row">
        <label class="field"><span>Max reply tokens</span><input id="olPredict" type="number" min="-1" step="256" value="${val(o.numPredict, -1)}"><div class="hint">−1 = let the model decide</div></label>
        <label class="field"><span>Keep model in memory</span><select id="olKeep">
          ${[['default', 'Server default'], ['5m', '5 minutes'], ['30m', '30 minutes'], ['1h', '1 hour'], ['12h', '12 hours'], ['forever', 'Forever (-1)'], ['unload', 'Unload after reply']].map(([v, l]) => `<option value="${v}" ${String(val(o.keepAlive, 'default')) === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
      </div>

      <details class="ollama-advanced">
        <summary>Advanced</summary>
        <div class="row">
          <label class="field"><span>GPU layers <code>num_gpu</code></span><input id="olGpu" type="number" step="1" placeholder="auto" value="${o.numGpu ?? ''}"></label>
          <label class="field"><span>CPU threads <code>num_thread</code></span><input id="olThread" type="number" min="1" step="1" placeholder="auto" value="${o.numThread ?? ''}"></label>
        </div>
        <div class="row">
          <label class="field"><span>Batch size <code>num_batch</code></span><input id="olBatch" type="number" min="1" step="1" placeholder="auto" value="${o.numBatch ?? ''}"></label>
          <label class="field"><span>Seed <code>seed</code></span><input id="olSeed" type="number" step="1" placeholder="random" value="${o.seed ?? ''}"></label>
        </div>
      </details>

      <div class="settings-actions">
        <button class="btn primary" id="olSave">Save defaults</button>
        <button class="btn ghost" id="olReset">Reset defaults</button>
      </div>
    </div>`;
  body.appendChild(el);

  const status = el.querySelector('#olStatus');
  const loadedWrap = el.querySelector('#olLoadedWrap');
  const instWrap = el.querySelector('#olInstalledWrap');

  const refreshInfo = () => api('/api/ollama/info').then((d) => {
    if (!d.ok) {
      status.className = 'ollama-status bad';
      status.innerHTML = `<b>Ollama offline</b><span>${esc(d.url || '')} · ${esc(d.error || '')}</span>`;
      return;
    }
    const h = d.host;
    const memPct = h ? Math.min(100, Math.round((h.memUsedBytes / h.memTotalBytes) * 100)) : 0;
    status.className = 'ollama-status good';
    status.innerHTML = `<b>Ollama v${esc(d.version)} · ${esc(h?.hostname || '')}</b>
      <span>${esc(d.url || '')}${h ? ` · ${h.cpus} threads · load ${h.loadavg.join(', ')} · RAM ${fmtGb(h.memUsedBytes)} / ${fmtGb(h.memTotalBytes)} (${memPct}%)` : ''}</span>
      ${h ? `<div class="ol-meter"><i style="width:${memPct}%"></i></div>` : ''}`;

    if (d.loaded?.length) {
      loadedWrap.innerHTML = `<div class="hint" style="margin:0 0 6px"><b>Loaded in memory (${d.loaded.length})</b></div>` + d.loaded.map((m) => `
        <div class="ol-model-item">
          <div><b>${esc(m.name)}</b><small>${fmtGb(m.size)}${m.sizeVram ? ' · VRAM ' + fmtGb(m.sizeVram) : ''}${m.context ? ' · ' + Math.round(m.context / 1024) + 'k ctx' : ''}</small></div>
          <button class="btn tiny" data-unload="${esc(m.name)}">Unload</button>
        </div>`).join('');
      loadedWrap.querySelectorAll('[data-unload]').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await api('/api/ollama/unload', { method: 'POST', body: { model: b.dataset.unload } });
          toast(`Unloaded ${b.dataset.unload}`);
          refreshInfo();
        } catch (e) { toast(e.message, 3500); b.disabled = false; }
      }));
    } else {
      loadedWrap.innerHTML = '<div class="hint" style="margin:0">No model currently loaded in memory.</div>';
    }

    instWrap.innerHTML = (d.installed || []).map((m) => `
      <div class="ol-model-item">
        <div><b>${esc(m.name)}</b><small>${fmtGb(m.size)}${m.params ? ' · ' + esc(m.params) : ''}${m.quant ? ' · ' + esc(m.quant) : ''}${m.capabilities?.length ? ' · ' + m.capabilities.filter((c) => c !== 'completion').join(', ') : ''}</small></div>
        <button class="btn tiny danger-text" data-del="${esc(m.name)}">Delete</button>
      </div>`).join('') || '<div class="hint">No local models installed.</div>';
    instWrap.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Delete local model “${b.dataset.del}” from disk?`)) return;
      b.disabled = true;
      try {
        await api('/api/ollama/models', { method: 'DELETE', body: { model: b.dataset.del } });
        toast(`Deleted ${b.dataset.del}`);
        await syncModels();
        refreshInfo();
      } catch (e) { toast(e.message, 3500); b.disabled = false; }
    }));
  }).catch((e) => {
    status.className = 'ollama-status bad';
    status.textContent = e.message;
  });
  refreshInfo();

  // Pull model with live SSE progress
  const pullBtn = el.querySelector('#olPullBtn');
  const pullInp = el.querySelector('#olPullName');
  const pullLog = el.querySelector('#olPullLog');
  const doPull = async () => {
    const model = pullInp.value.trim();
    if (!model) return;
    pullBtn.disabled = true;
    pullLog.textContent = `Pulling ${model}…`;
    try {
      const res = await fetch('/api/ollama/pull', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/^data:\s*/, '').trim();
          buf = buf.slice(idx + 2);
          if (!line) continue;
          const ev = safeJSON(line);
          if (ev.error) throw new Error(ev.error);
          if (ev.done) pullLog.textContent = `Pulled ${model} successfully.`;
          else if (ev.total && ev.completed) pullLog.textContent = `${ev.status || 'downloading'} · ${Math.round((ev.completed / ev.total) * 100)}%`;
          else if (ev.status) pullLog.textContent = ev.status;
        }
      }
      pullInp.value = '';
      await syncModels();
      refreshInfo();
      toast(`Pulled ${model}`);
    } catch (e) {
      pullLog.textContent = `Error: ${e.message}`;
      toast(e.message, 4000);
    } finally {
      pullBtn.disabled = false;
    }
  };
  pullBtn.addEventListener('click', doPull);
  pullInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doPull(); });

  // Load & save host ollama.env (LAN-only daemon)
  if (S.capabilities.ollamaEnvDaemon) {
    const envWrap = el.querySelector('#olEnvFields');
    api('/api/ollama/env').then((d) => {
      if (!d.ok) { envWrap.textContent = d.error || 'Could not load ollama.env'; return; }
      envWrap.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${(d.fields || []).map((f) => {
        const v = d.values?.[f.key] ?? '';
        const ctl = f.type === 'select'
          ? `<select data-env="${esc(f.key)}">${f.options.map((opt) => `<option value="${esc(opt)}" ${opt === v ? 'selected' : ''}>${opt === '' ? '(default)' : esc(opt)}</option>`).join('')}</select>`
          : `<input data-env="${esc(f.key)}" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(v)}">`;
        return `<label class="field" style="margin:0"><span>${esc(f.label)}</span>${ctl}<div class="hint">${esc(f.hint)}</div></label>`;
      }).join('')}</div>`;
    }).catch((e) => { envWrap.textContent = e.message; });

    const saveEnv = async (restart) => {
      const values = {};
      envWrap.querySelectorAll('[data-env]').forEach((inp) => { values[inp.dataset.env] = inp.value.trim(); });
      try {
        const d = await api('/api/ollama/env', { method: 'POST', body: { values, restart } });
        if (!d.ok) throw new Error(d.error || 'Save failed');
        toast(restart ? 'Saved ollama.env & restarted Ollama' : 'Saved ollama.env');
        refreshInfo();
      } catch (e) { toast(e.message, 4000); }
    };
    el.querySelector('#olEnvSave')?.addEventListener('click', () => saveEnv(false));
    el.querySelector('#olEnvSaveRestart')?.addEventListener('click', () => saveEnv(true));
    el.querySelector('#olRestartOnly')?.addEventListener('click', async () => {
      try {
        const d = await api('/api/ollama/restart', { method: 'POST' });
        toast(d.ok ? 'Ollama restarted' : 'Restart failed', 3500);
        refreshInfo();
      } catch (e) { toast(e.message, 4000); }
    });
  }

  el.querySelectorAll('[data-ctx]').forEach((b) => b.addEventListener('click', () => {
    el.querySelector('#olCtx').value = b.dataset.ctx;
    el.querySelectorAll('[data-ctx]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  const markChips = () => {
    const raw = el.querySelector('#olCtx').value.trim();
    el.querySelectorAll('[data-ctx]').forEach((x) => x.classList.toggle('on', x.dataset.ctx === raw));
  };
  markChips();
  el.querySelector('#olCtx').addEventListener('input', markChips);

  const num = (sel, def) => {
    const raw = el.querySelector(sel).value.trim();
    if (raw === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  };

  el.querySelector('#olSave').addEventListener('click', async () => {
    const ctxRaw = el.querySelector('#olCtx').value.trim();
    const ctx = ctxRaw === '' ? null : num('#olCtx', null);
    if (ctx !== null && (ctx < 2048 || ctx > 262144)) { toast('Context window must be 2k–256k tokens (or blank for server default)', 3500); return; }
    try {
      S.settings = await api('/api/settings', {
        method: 'POST',
        body: {
          numCtx: ctx,
          temperature: num('#olTemp', 0.7),
          ollama: {
            topP: num('#olTopP', 0.95),
            topK: num('#olTopK', 40),
            repeatPenalty: num('#olRepeat', 1.1),
            numPredict: num('#olPredict', -1),
            keepAlive: el.querySelector('#olKeep').value,
            numGpu: el.querySelector('#olGpu').value.trim() === '' ? null : num('#olGpu', null),
            numThread: el.querySelector('#olThread').value.trim() === '' ? null : num('#olThread', null),
            numBatch: el.querySelector('#olBatch').value.trim() === '' ? null : num('#olBatch', null),
            seed: el.querySelector('#olSeed').value.trim() === '' ? null : num('#olSeed', null),
          },
        },
      });
      toast('Ollama defaults saved');
    } catch (e) { toast(e.message, 3500); }
  });

  el.querySelector('#olReset').addEventListener('click', async () => {
    try {
      S.settings = await api('/api/settings', {
        method: 'POST',
        body: {
          numCtx: null,
          temperature: 0.7,
          ollama: { topP: 0.95, topK: 40, repeatPenalty: 1.1, numPredict: -1, keepAlive: 'default', numGpu: null, numThread: null, numBatch: null, seed: null },
        },
      });
      toast('Restored Ollama defaults');
      rerender();
    } catch (e) { toast(e.message, 3500); }
  });
}

async function syncModels() {
  try {
    const d = await api('/api/models');
    S.models = d.models || [];
    if (!S.models.some((m) => m.name === S.model) && S.models.length) S.model = S.models[0].name;
    renderModel();
  } catch (e) { console.error(e); }
}

async function renderProvidersPanel(body, rerender) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<p class="provider-intro">Connect any OpenAI-compatible API — OpenCode Go, OpenRouter, OpenAI, Groq, a local vLLM, and more. Keys are encrypted with AES-256-GCM on the server and are never sent back to the browser.</p>
    <div id="provList"><div class="files-empty"><span class="mini-spin"></span></div></div>
    <div class="divider"></div>
    <h3 class="settings-h3">Add a provider</h3>
    <div id="provForm"></div>`;
  body.appendChild(wrap);
  const listEl = wrap.querySelector('#provList');
  const formEl = wrap.querySelector('#provForm');
  let editing = null;

  try {
    const data = await api('/api/providers');
    S.providers = data.providers || [];
    if (data.presets) S.presets = data.presets;
  } catch (e) { listEl.innerHTML = `<div class="files-empty">${esc(e.message)}</div>`; }

  const drawList = () => {
    listEl.innerHTML = '';
    if (!S.providers.length) {
      listEl.innerHTML = '<div class="provider-empty">No cloud providers yet. Add OpenCode Go below and paste your API key — models load automatically.</div>';
      return;
    }
    for (const p of S.providers) {
      const card = document.createElement('div');
      card.className = 'provider-card';
      card.innerHTML = `<div class="pc-top"><div class="pc-name"><b></b><span class="badge${p.hasKey ? ' hot' : ''}"></span></div><span class="pc-count"></span></div>
        <div class="pc-url"></div>
        <div class="pc-actions">
          <button data-a="refresh" class="btn tiny">${icon('refresh')} Fetch all models</button>
          <button data-a="test" class="btn tiny">${icon('check')} Test</button>
          <button data-a="edit" class="btn tiny">${icon('edit')} Edit</button>
          <button data-a="delete" class="btn tiny danger-text">${icon('trash')} Remove</button>
        </div>`;
      card.querySelector('.pc-name b').textContent = p.name;
      const badge = card.querySelector('.pc-name .badge');
      badge.textContent = p.hasKey ? `key ${p.keyHint}` : (p.noKey ? 'no key' : 'no key set');
      card.querySelector('.pc-count').textContent = `${p.models.length} model${p.models.length === 1 ? '' : 's'}`;
      card.querySelector('.pc-url').textContent = p.baseUrl + (p.modelsUrl ? `  ·  catalog: ${p.modelsUrl}` : '');
      card.addEventListener('click', async (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (!a) return;
        if (a === 'refresh') {
          const btn = e.target.closest('button');
          btn.disabled = true; btn.innerHTML = '<span class="mini-spin"></span> Fetching…';
          try {
            const d = await api(`/api/providers/${p.id}/refresh`, { method: 'POST' });
            applyProvider(d.provider);
            await syncModels();
            toast(`${d.found} models loaded from ${p.name}`);
            rerender();
          } catch (err) { toast(err.message, 5000); btn.disabled = false; btn.innerHTML = `${icon('refresh')} Fetch all models`; }
        } else if (a === 'test') {
          try {
            const d = await api(`/api/providers/${p.id}/test`, { method: 'POST', body: {} });
            toast(`${p.name} · ${d.model} → “${d.reply || 'ok'}”`, 4000);
          } catch (err) { toast(err.message, 6000); }
        } else if (a === 'edit') {
          editing = p;
          drawForm();
          formEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (a === 'delete') {
          if (!confirm(`Remove ${p.name}? The stored key will be deleted.`)) return;
          await api(`/api/providers/${p.id}`, { method: 'DELETE' });
          applyProvider(null, p.id);
          await syncModels();
          toast('Provider removed'); rerender();
        }
      });
      listEl.appendChild(card);
    }
  };

  function applyProvider(p, removedId) {
    if (removedId) { S.providers = S.providers.filter((x) => x.id !== removedId); return; }
    if (!p) return;
    const i = S.providers.findIndex((x) => x.id === p.id);
    if (i >= 0) S.providers[i] = p; else S.providers.push(p);
  }

  function drawForm() {
    const presets = S.presets || {};
    const first = editing?.id || (presets['opencode-go'] ? 'opencode-go' : 'custom');
    const match = Object.entries(presets).find(([, v]) => v.baseUrl && editing && v.baseUrl === editing.baseUrl);
    const presetKey = editing ? (match ? match[0] : 'custom') : (presets['opencode-go'] ? 'opencode-go' : 'custom');
    const preset = presets[presetKey] || {};
    formEl.innerHTML = `
      <div class="row">
        <label class="field"><span>Preset</span><select id="pPreset">${Object.entries(presets).map(([k, v]) => `<option value="${k}" ${k === presetKey ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Name</span><input id="pName" placeholder="OpenCode Go"></label>
      </div>
      <label class="field"><span>Base URL</span><input id="pUrl" placeholder="https://opencode.ai/zen/go/v1"><div class="hint">The OpenAI-compatible root, usually ending in <code>/v1</code>.</div></label>
      <div class="row">
        <label class="field"><span>API key</span><input id="pKey" type="password" autocomplete="off" placeholder="Paste key — stored encrypted"><div class="hint" id="pKeyHint"></div></label>
        <label class="field"><span>Model catalog URL <em style="font-weight:400;color:var(--muted)">(optional)</em></span><input id="pModelsUrl" placeholder="https://…/models"><div class="hint">Used to discover the full model list.</div></label>
      </div>
      <label class="field"><span>Models</span><textarea id="pModels" placeholder="One model id per line"></textarea><div class="hint">Fetched automatically when you save; you can also paste ids.</div></label>
      <div class="settings-actions">
        <button class="btn primary" id="pSave">${editing ? 'Save provider' : 'Add provider'}</button>
        ${editing ? '<button class="btn" id="pCancel">Cancel</button>' : ''}
        <span class="hint" style="margin:0">Keys never leave this server.</span>
      </div>`;
    const name = formEl.querySelector('#pName');
    const url = formEl.querySelector('#pUrl');
    const key = formEl.querySelector('#pKey');
    const models = formEl.querySelector('#pModels');
    const modelsUrl = formEl.querySelector('#pModelsUrl');
    const keyHint = formEl.querySelector('#pKeyHint');
    if (editing) {
      name.value = editing.name; url.value = editing.baseUrl; models.value = (editing.models || []).join('\n');
      modelsUrl.value = editing.modelsUrl || '';
      keyHint.textContent = editing.hasKey ? `A key is already stored (${editing.keyHint}). Leave blank to keep it.` : 'No key stored yet.';
      key.placeholder = editing.hasKey ? 'Leave blank to keep the stored key' : 'Paste key — stored encrypted';
    } else {
      name.value = preset.name || ''; url.value = preset.baseUrl || ''; models.value = (preset.models || []).join('\n');
      modelsUrl.value = preset.modelsUrl || '';
    }
    formEl.querySelector('#pPreset').addEventListener('change', (e) => {
      const v = S.presets[e.target.value] || {};
      name.value = v.name || ''; url.value = v.baseUrl || ''; models.value = (v.models || []).join('\n');
      modelsUrl.value = v.modelsUrl || '';
      key.focus();
    });
    formEl.querySelector('#pCancel')?.addEventListener('click', () => { editing = null; drawForm(); });
    formEl.querySelector('#pSave').addEventListener('click', async () => {
      const payload = {
        name: name.value.trim() || 'Custom endpoint',
        baseUrl: url.value.trim(),
        models: models.value,
        modelsUrl: modelsUrl.value.trim(),
        noKey: !key.value && !editing?.hasKey,
      };
      if (key.value.trim()) payload.apiKey = key.value.trim();
      if (!payload.baseUrl) { toast('Base URL is required'); return; }
      const btn = formEl.querySelector('#pSave');
      btn.disabled = true; btn.innerHTML = '<span class="mini-spin"></span> Saving…';
      try {
        if (editing) {
          const d = await api(`/api/providers/${editing.id}`, { method: 'PATCH', body: payload });
          applyProvider(d.provider);
          if (key.value.trim()) {
            try {
              const r = await api(`/api/providers/${editing.id}/refresh`, { method: 'POST' });
              applyProvider(r.provider);
              toast(`${r.found} models loaded`);
            } catch (e) { toast('Saved key, but model fetch failed: ' + e.message, 5000); }
          }
        } else {
          const d = await api('/api/providers', { method: 'POST', body: payload });
          applyProvider(d.provider);
          toast(d.warning || `${d.provider.name} connected${d.provider.models.length ? ' · ' + d.provider.models.length + ' models' : ''}`, d.warning ? 5000 : 2600);
          editing = null;
        }
        await syncModels();
        const reactivate = document.querySelector('.modal-root.on');
        if (reactivate) rerender();
      } catch (e) { toast(e.message, 6000); btn.disabled = false; btn.innerHTML = editing ? 'Save provider' : 'Add provider'; }
    });
  }

  drawList();
  drawForm();
  if (!S.providers.length) listEl.innerHTML = '<div class="provider-empty">No cloud providers yet. Add OpenCode Go below and paste your API key — models load automatically.</div>';
}

/* ---------------------------------------------------------------- persona & shortcuts */
function personaMenu(anchor) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.width = '270px';
  const activeId = S.chat?.persona || S.persona || 'default';
  pop.innerHTML = `<div class="pop-label">Assistant persona</div>` +
    (S.personas || []).map((p) => `<button class="pop-item" data-p="${esc(p.id)}" style="${p.id === activeId ? 'background:var(--accent-soft);font-weight:500' : ''}">
      <span style="flex:1"><b>${esc(p.name)}</b><br><small style="color:var(--muted);font-size:11px">${esc(p.desc)}</small></span>
      ${p.id === activeId ? icon('check') : ''}
    </button>`).join('') +
    `<div class="pop-sep"></div><button class="pop-item" data-custom>${icon('edit')} Per-chat system prompt…</button>`;
  document.body.appendChild(pop);
  positionPopover(pop, anchor, 'bottom');
  pop.addEventListener('click', async (e) => {
    const pBtn = e.target.closest('[data-p]');
    if (pBtn) {
      const pid = pBtn.dataset.p;
      closePopover();
      S.persona = pid;
      if (S.chat) {
        S.chat.persona = pid;
        await api(`/api/chats/${S.chat.id}`, { method: 'PATCH', body: { persona: pid } }).catch(() => {});
      }
      updatePersonaPill();
      toast(`Persona: ${S.personas.find((x) => x.id === pid)?.name || pid}`);
      return;
    }
    if (e.target.closest('[data-custom]')) {
      closePopover();
      openChatPromptModal();
    }
  });
}

function openChatPromptModal() {
  const m = document.createElement('div');
  m.className = 'modal-root on';
  m.innerHTML = `<div class="modal-scrim"></div><div class="modal">
    <h2>Per-chat system prompt</h2>
    <p class="sub">Extra instructions applied only to this conversation.</p>
    <label class="field"><span>System instructions</span><textarea id="chatSysInp" placeholder="e.g. Answer in German, format outputs as tables, act as a Linux kernel reviewer…"></textarea></label>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="saveChatSys">Save</button></div>
  </div>`;
  const ta = m.querySelector('#chatSysInp');
  ta.value = S.chat?.systemPrompt || '';
  const close = () => m.remove();
  m.querySelector('[data-close]').addEventListener('click', close);
  m.querySelector('.modal-scrim').addEventListener('click', close);
  m.querySelector('#saveChatSys').addEventListener('click', async () => {
    try {
      await ensureChat();
      const val = ta.value.trim();
      S.chat.systemPrompt = val;
      await api(`/api/chats/${S.chat.id}`, { method: 'PATCH', body: { systemPrompt: val } });
      updatePersonaPill();
      toast(val ? 'Chat system prompt saved' : 'Chat system prompt cleared');
      close();
    } catch (e) { toast(e.message, 3500); }
  });
  document.body.appendChild(m);
  setTimeout(() => ta.focus(), 40);
}

function openShortcutsModal() {
  const m = document.createElement('div');
  m.className = 'modal-root on';
  m.innerHTML = `<div class="modal-scrim"></div><div class="modal">
    <h2>Keyboard shortcuts</h2>
    <p class="sub">Work faster across chats and panels.</p>
    <div class="shortcut-grid">
      <span>New chat</span><kbd>⌘ / Ctrl + K</kbd>
      <span>Send message</span><kbd>Enter</kbd>
      <span>New line in message</span><kbd>Shift + Enter</kbd>
      <span>Stop generation</span><kbd>⌘ / Ctrl + .</kbd>
      <span>Close panel / modal</span><kbd>Esc</kbd>
      <span>Show shortcuts</span><kbd>⌘ / Ctrl + /</kbd>
    </div>
    <div class="modal-foot"><button class="btn primary" data-close>Done</button></div>
  </div>`;
  const close = () => m.remove();
  m.querySelector('[data-close]').addEventListener('click', close);
  m.querySelector('.modal-scrim').addEventListener('click', close);
  document.body.appendChild(m);
}

function setupVoiceInput() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('#micBtn');
  if (!SR || !btn) return;
  btn.hidden = false;
  let rec = null;
  let listening = false;
  btn.addEventListener('click', () => {
    if (listening && rec) { rec.stop(); return; }
    rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    const inp = $('#input');
    const base = inp.value ? inp.value + ' ' : '';
    rec.onstart = () => { listening = true; btn.classList.add('listening'); btn.title = 'Listening… click to stop'; };
    rec.onresult = (ev) => {
      const txt = [...ev.results].map((r) => r[0].transcript).join('');
      inp.value = base + txt;
      autosize();
    };
    rec.onerror = (ev) => { if (ev.error !== 'aborted') toast(`Voice error: ${ev.error}`); };
    rec.onend = () => { listening = false; btn.classList.remove('listening'); btn.title = 'Voice input'; };
    rec.start();
  });
}

/* ---------------------------------------------------------------- mobile */
function openMobileSidebar() { $('#sidebar').classList.add('mobile-open'); $('#scrim').classList.add('on'); }
function closeMobileSidebar() { $('#sidebar').classList.remove('mobile-open'); $('#scrim').classList.remove('on'); }

/* ---------------------------------------------------------------- wire-up */
function wire() {
  $('#newChat').addEventListener('click', () => {
    showWelcome(); $('#input').focus(); localStorage.removeItem('mxgpt-chat'); closeMobileSidebar(); });
  $('#menuBtn').addEventListener('click', openMobileSidebar);
  $('#scrim').addEventListener('click', closeMobileSidebar);
  $('#collapseBtn').addEventListener('click', () => setSidebarCollapsed(true));
  $('#expandBtn')?.addEventListener('click', () => setSidebarCollapsed(false));
  $('#personaBtn')?.addEventListener('click', (e) => personaMenu(e.currentTarget));
  $('#shortcutsBtn')?.addEventListener('click', openShortcutsModal);
  $('#importChatBtn')?.addEventListener('click', () => $('#importPicker').click());
  $('#importPicker')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const { chat } = await api('/api/chats/import', { method: 'POST', body: parsed });
      await loadChats();
      await openChat(chat.id);
      toast(`Imported “${chat.title}”`);
    } catch (err) { toast(`Import failed: ${err.message}`, 4000); }
  });
  $('#themeBtn').addEventListener('click', () => {
    S.theme = S.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('mxgpt-theme', S.theme);
    applyTheme();
    api('/api/settings', { method: 'POST', body: { theme: S.theme } }).catch(() => {});
  });
  $('#userBtn').addEventListener('click', (e) => {
    closePopover();
    const pop = document.createElement('div');
    pop.className = 'popover';
    const items = [];
    if (S.capabilities.settings) items.push(`<button class="pop-item" data-a="settings">${icon('settings')} Settings</button>`);
    if (S.capabilities.ollamaSettings) items.push(`<button class="pop-item" data-a="ollama">${icon('cpu')} Ollama Settings (LAN)</button>`);
    if (S.capabilities.providers) items.push(`<button class="pop-item" data-a="providers">${icon('globe')} Providers &amp; API keys</button>`);
    if (S.capabilities.files) items.push(`<button class="pop-item" data-a="files">${icon('folder')} Open workspace</button>`);
    items.push(`<button class="pop-item" data-a="notes">${icon('book')} Notes &amp; Memory</button>`);
    if (S.authRequired) items.push(`<div class="pop-sep"></div><button class="pop-item danger" data-a="logout">${icon('logout')} Sign out</button>`);
    pop.innerHTML = items.join('');
    document.body.appendChild(pop);
    positionPopover(pop, e.currentTarget, 'top');
    pop.addEventListener('click', async (e2) => {
      const a = e2.target.closest('.pop-item')?.dataset.a;
      if (!a) return;
      closePopover();
      if (a === 'settings') openSettings();
      if (a === 'ollama') openSettings('ollama');
      if (a === 'providers') openSettings('providers');
      if (a === 'files') openPanel('files');
      if (a === 'notes') openPanel('notes');
      if (a === 'logout') { await api('/api/logout', { method: 'POST' }).catch(() => {}); location.href = '/login'; }
    });
  });
  $('#modelBtn').addEventListener('click', (e) => modelMenu(e.currentTarget));
  $('#sendBtn').addEventListener('click', () => (activeRun() ? stopStreaming() : send()));
  $('#panelClose').addEventListener('click', () => closePanel(true));
  $('#panelScrim').addEventListener('click', () => closePanel(true));

  $$('.tool-toggle').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.tool;
    if (t === 'web') { S.useWeb = !S.useWeb; localStorage.setItem('mxgpt-use-web', S.useWeb ? '1' : '0'); }
    else if (t === 'files') { S.useFiles = !S.useFiles; localStorage.setItem('mxgpt-use-files', S.useFiles ? '1' : '0'); }
    else if (t === 'subagents') { S.useSubagents = !S.useSubagents; localStorage.setItem('mxgpt-use-subagents', S.useSubagents ? '1' : '0'); }
    else { S.useTools = !S.useTools; localStorage.setItem('mxgpt-use-tools', S.useTools ? '1' : '0'); }
    b.classList.toggle('on', t === 'web' ? S.useWeb : t === 'files' ? S.useFiles : t === 'subagents' ? S.useSubagents : S.useTools);
    if (t === 'web' && S.useWeb) toast('Web access on — search, browse & Wikipedia');
    if (t === 'files' && S.useFiles) toast('File access on — search, read & edit workspace');
    if (t === 'tools') toast(S.useTools ? 'Built-in tools on — calc, JS runner, time & notes' : 'Built-in tools off');
    if (t === 'subagents') toast(S.useSubagents ? `Subagents on (${S.subagentModels.map((m) => m.name).join(', ')})` : 'Subagents off');
  }));

  $$('.top-actions .ghost-btn').forEach((b) => b.addEventListener('click', () => togglePanel(b.dataset.panel)));

  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); uploadFiles(files); }
  });

  $('#attachBtn').addEventListener('click', () => $('#filePicker').click());
  $('#filePicker').addEventListener('change', (e) => { uploadFiles([...e.target.files]); e.target.value = ''; });
  $('#panelUpload').addEventListener('change', (e) => { uploadFiles([...e.target.files], S.files.path || ''); e.target.value = ''; });

  const comp = $('#composer');
  comp.addEventListener('dragover', (e) => { e.preventDefault(); comp.classList.add('dragging'); });
  comp.addEventListener('dragleave', () => comp.classList.remove('dragging'));
  comp.addEventListener('drop', (e) => {
    e.preventDefault(); comp.classList.remove('dragging');
    if (e.dataTransfer.files?.length) uploadFiles([...e.dataTransfer.files]);
  });

  $('#chatSearch').addEventListener('input', debounce((e) => loadChats(e.target.value.trim()), 220));
  $$('.suggestions button').forEach((b) => b.addEventListener('click', () => {
    input.value = b.dataset.prompt || '';
    autosize(); input.focus();
  }));

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); showWelcome(); input.focus(); }
    if ((e.metaKey || e.ctrlKey) && e.key === '.') { if (activeRun()) { e.preventDefault(); stopStreaming(); } }
    if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); openShortcutsModal(); }
    if (e.key === 'Escape') {
      closePopover();
      if ($('.modal-root.on')) $('.modal-root.on').remove();
      else if (S.panel) closePanel();
    }
  });

  $('#messages').addEventListener('click', (e) => {
    const card = e.target.closest('[data-artifact]');
    if (card) openArtifact(card.dataset.artifact);
  });

  setupVoiceInput();
  setupDragDrop();
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---- global drag & drop: drop files anywhere to attach ---- */
function setupDragDrop() {
  const overlay = document.createElement('div');
  overlay.className = 'drop-overlay';
  overlay.innerHTML = `<div class="drop-card">${icon('upload')}<b>Drop files to attach</b><span>They upload to your workspace and join the next message.</span></div>`;
  document.body.appendChild(overlay);
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.classList.add('on'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove('on'); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; overlay.classList.remove('on');
    if (e.dataTransfer.files?.length) uploadFiles([...e.dataTransfer.files]);
  });
}

wire();
boot();
})();
