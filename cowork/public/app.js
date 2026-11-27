'use strict';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const CW = window.cowork;

const S = {
  appInfo: null,
  settings: null,
  providerPresets: [],
  selectedPreset: 'mxgpt',
  loginPreset: 'openai',
  assignModelTarget: 'fast',
  updateInfo: null,
  updating: false,
  quickFolders: [],
  mode: 'copilot',
  think: 'low',
  chats: [],
  chat: null,
  messages: [],
  chatSearch: '',
  streaming: false,
  activeStreamId: null,
  pinnedFiles: [],
  cwd: '',
  searchActive: false,
  editor: null, // { path, name, absPath, editable, content, savedContent }
  notes: [],
  briefs: [],
  undo: [],
  panelOpen: false,
  panelTab: 'files',
  toolWebSearch: true,
  toolOsFiles: true,
  containerEnabled: true,
  containerStatus: null,
  activeContainerRunId: null,
  containerRunOutputs: {}, // runId -> live text
  graphView: null,
  graphData: null,
  graphExpanded: false,
  graphFilters: new Set(['code', 'doc', 'config', 'test', 'style', 'data', 'file', 'folder', 'package']),
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
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), ms);
}

// Inline modal prompt (Electron disables window.prompt)
function askText({ title, label, value = '', placeholder = '' }) {
  return new Promise((resolve) => {
    const modal = $('#promptModal');
    const inp = $('#promptModalInput');
    $('#promptModalTitle').textContent = title;
    $('#promptModalLabel').textContent = label;
    inp.value = value;
    inp.placeholder = placeholder;
    modal.hidden = false;
    setTimeout(() => { inp.focus(); inp.select(); }, 20);

    const finish = (val) => {
      modal.hidden = true;
      $('#promptOkBtn').onclick = null;
      $('#promptCancelBtn').onclick = null;
      $('#promptCancelX').onclick = null;
      inp.onkeydown = null;
      resolve(val);
    };
    $('#promptOkBtn').onclick = () => finish(inp.value.trim() || null);
    $('#promptCancelBtn').onclick = () => finish(null);
    $('#promptCancelX').onclick = () => finish(null);
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(inp.value.trim() || null); }
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    };
  });
}

// Lightweight safe Markdown renderer (hides raw file-actions / code-run / memory-save JSON blocks)
function renderMd(raw) {
  let src = String(raw || '')
    .replace(/```email-draft[\s\S]*?```/gi, '')
    .replace(/```file-actions[\s\S]*?```/gi, '')
    .replace(/```code-run[\s\S]*?```/gi, '')
    .replace(/```memory-save[\s\S]*?```/gi, '')
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
    if (!line.trim()) { closeLists(); continue; }
    closeLists();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeLists();
  return out.join('\n').replace(/\x00BLK(\d+)\x00/g, (_, i) => blocks[Number(i)] || '');
}

function updateGreeting() {
  const h = new Date().getHours();
  const base = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const name = S.settings?.username ? `, ${S.settings.username}` : '';
  $('#greeting').textContent = base + name;
}

function modeHintText(m) {
  const fast = (S.settings?.fastModel || 'lfm3:latest').replace(/:latest$/, '');
  const smart = (S.settings?.smartModel || 'inkling-2-mini:latest').replace(/:latest$/, '');
  const copB = (S.settings?.copilotBModel || 'nemotron-3.5-lightning').replace(/:latest$/, '');
  if (m === 'fast') return `Fast: ${fast} direct`;
  if (m === 'smart') return `Smart: ${smart} direct`;
  if (m === 'copilot_b') return `Copilot (B): ${copB} orchestrates · ${fast} & local tools`;
  return `Copilot: ${smart} orchestrates · ${fast} & local tools`;
}

function setMode(m) {
  S.mode = m;
  $('#modeControl').dataset.mode = m;
  $$('#modeSeg button').forEach((b) => {
    const on = b.dataset.mode === m;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  $('#modeHint').textContent = modeHintText(m);
  $('#topModel').textContent = m === 'fast' ? 'Fast' : m === 'smart' ? 'Smart' : m === 'copilot_b' ? 'Copilot (B)' : 'Copilot';
}

function setThink(t) {
  S.think = t;
  $$('#thinkSeg button').forEach((b) => b.classList.toggle('on', b.dataset.think === t));
}

function applyThemeUI(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  $('#themeIcon use').setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
  if (S.graphView) S.graphView.draw();
}

async function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyThemeUI(next);
  await CW.saveSettings({ theme: next });
}

// ---- Right Slide-Out Panel (identical to mx-GPT webapp)
const PANEL_META = {
  files: { title: 'OS Files & Editor', icon: '#i-folder' },
  graph: { title: 'Project Knowledge Graph', icon: '#i-graph' },
  container: { title: 'Container Sandbox', icon: '#i-box' },
  notes: { title: 'Notes & Local Tools', icon: '#i-book' },
  research: { title: 'Research Desk', icon: '#i-globe' },
  undo: { title: 'Undo History', icon: '#i-undo' },
};

function openPanel(tab, toggleIfSame = false) {
  if (toggleIfSame && S.panelOpen && S.panelTab === tab) {
    closePanel();
    return;
  }
  S.panelOpen = true;
  S.panelTab = tab;
  if (tab !== 'graph') {
    S.graphExpanded = false;
    $('#panel').classList.remove('graph-expanded');
  }
  $('#panel').classList.add('open');
  $('#panel').setAttribute('aria-hidden', 'false');
  const meta = PANEL_META[tab] || PANEL_META.files;
  $('#panelTitle').textContent = meta.title;
  $('#panelIcon use').setAttribute('href', meta.icon);

  $$('.top-actions .ghost-btn[data-panel]').forEach((b) => {
    b.classList.toggle('active', b.dataset.panel === tab);
  });
  $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));

  if (tab === 'files' && !S.editor) loadFiles(S.cwd);
  if (tab === 'graph') ensureGraphLoaded();
  if (tab === 'container') { loadContainerStatus(false); loadContainerHistory(); }
  if (tab === 'notes') loadNotes();
  if (tab === 'research') loadBriefs();
  if (tab === 'undo') loadUndo();
}

function closePanel() {
  S.panelOpen = false;
  S.graphExpanded = false;
  $('#panel').classList.remove('open', 'graph-expanded');
  $('#panel').setAttribute('aria-hidden', 'true');
  $$('.top-actions .ghost-btn[data-panel]').forEach((b) => b.classList.remove('active'));
}

// ---- Account & Connection Header/Footer State
function renderAccountUI() {
  const s = S.settings || {};
  let host = 'max.fyreflysystems.de';
  try { host = new URL(s.endpointUrl || 'https://max.fyreflysystems.de').host; } catch {}

  const preset = S.providerPresets.find((p) => p.id === s.providerPreset);
  const displayName = s.endpointType === 'mxgpt'
    ? (s.username ? `User ${s.username}` : 'mx-GPT')
    : (preset?.label || s.endpointType || 'Provider');

  $('#userName').textContent = displayName;
  $('#userAvatar').textContent = (displayName[0] || 'M').toUpperCase();
  $('#connLabel').textContent = host;
  $('#footProviderBtn').textContent = host;
  $('#modeHint').textContent = modeHintText(S.mode);
  updateGreeting();
}

function shouldShowLogin() {
  const s = S.settings || {};
  if (s.signedIn) return false;
  if (s.endpointType === 'ollama') return false;
  if (s.endpointType === 'mxgpt' && s.username && s.hasPassword) return false;
  if ((s.endpointType === 'openai' || s.endpointType === 'anthropic') && s.hasApiKey) return false;
  return true;
}

function showLoginScreen() {
  const s = S.settings || {};
  $('#loginUrl').value = s.endpointUrl && s.endpointType === 'mxgpt'
    ? s.endpointUrl
    : 'https://max.fyreflysystems.de';
  $('#loginUser').value = s.username || '';
  $('#loginPw').value = '';
  $('#loginErr').textContent = '';
  $('#lpErr').textContent = '';
  renderLoginProviderChips();
  selectLoginPreset(S.loginPreset || 'openai');
  $('#loginScreen').hidden = false;
  setTimeout(() => $('#loginUser').focus(), 40);
}

function hideLoginScreen() {
  $('#loginScreen').hidden = true;
}

function renderLoginProviderChips() {
  const wrap = $('#loginProviderChips');
  wrap.innerHTML = '';
  for (const p of S.providerPresets.filter((x) => x.id !== 'mxgpt')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prov-chip' + (S.loginPreset === p.id ? ' on' : '');
    btn.textContent = p.label;
    btn.onclick = () => selectLoginPreset(p.id);
    wrap.appendChild(btn);
  }
}

function selectLoginPreset(id) {
  const p = S.providerPresets.find((x) => x.id === id) || S.providerPresets[1];
  if (!p) return;
  S.loginPreset = p.id;
  $('#lpUrl').value = p.endpointUrl;
  $('#lpFast').value = p.fastModel || '';
  $('#lpSmart').value = p.smartModel || '';
  $('#lpKeyWrap').hidden = p.endpointType === 'ollama';
  renderLoginProviderChips();
}

async function checkConnectionQuiet() {
  try {
    const r = await CW.testEndpoint({});
    const host = new URL(r.endpointUrl).host;
    $('#connLabel').textContent = `${host} · ${r.latencyMs}ms`;
    $('#footProviderBtn').textContent = host;
  } catch {
    const t = S.settings?.endpointType || 'mxgpt';
    $('#connLabel').textContent = t === 'mxgpt' ? 'Not signed in — click' : 'Provider offline';
  }
}

// ---- Boot
async function boot() {
  if (!CW) throw new Error('Native Electron preload bridge unavailable');
  const [info, data, prov] = await Promise.all([
    CW.appInfo(),
    CW.getSettings(),
    CW.getProviderPresets(),
  ]);
  S.appInfo = info;
  S.settings = data.settings;
  S.providerPresets = prov?.presets || [];
  S.quickFolders = data.quickFolders || [];

  $('#appVersionBadge').textContent = `v${info.version || '1.3.0'}`;
  applyThemeUI(S.settings.theme || 'light');
  setMode(S.settings.defaultMode || 'copilot');
  setThink(S.settings.think || 'low');
  S.toolWebSearch = S.settings.toolWebSearch !== false;
  S.toolOsFiles = S.settings.toolOsFiles !== false;
  S.containerEnabled = S.settings.toolContainer !== false && S.settings.containerEnabled !== false;
  $('#webToggleBtn').classList.toggle('on', S.toolWebSearch);
  $('#filesToggleBtn').classList.toggle('on', S.toolOsFiles);
  $('#containerToggleBtn').classList.toggle('on', S.containerEnabled);
  $('#ctImage').value = S.settings.containerImage || 'python:3.12-slim';
  $('#ctNet').value = S.settings.containerNetwork || 'none';
  $('#ctMount').value = S.settings.containerMountMode || 'rw';
  renderAccountUI();
  renderWorkspaceUI();

  if (shouldShowLogin()) {
    showLoginScreen();
  }

  await Promise.all([loadChats(), loadFiles(''), loadNotes(), loadBriefs(), loadUndo()]);
  checkConnectionQuiet();
  checkUpdatesQuiet();
  loadContainerStatus(false);

  CW.onUpdateProgress((p) => renderUpdateProgress(p));
  CW.onContainerOutput((ev) => handleContainerOutputChunk(ev));
  CW.onMenuAction(({ action, payload }) => {
    if (action === 'new-task') newChat();
    else if (action === 'pick-folder') pickWorkspaceFolder();
    else if (action === 'open-settings') openSettings();
    else if (action === 'open-updates') openUpdatesModal();
    else if (action === 'set-mode') setMode(payload);
    else if (action === 'toggle-drawer') S.panelOpen ? closePanel() : openPanel(S.panelTab || 'files');
    else if (action === 'toggle-theme') toggleTheme();
  });

  // Drag & drop local files onto the window to pin them to chat
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    const res = await CW.pinDroppedFiles(files);
    if (res?.pinned?.length) {
      for (const p of res.pinned) {
        if (!S.pinnedFiles.includes(p)) S.pinnedFiles.push(p);
      }
      renderPinned();
      if (S.panelOpen && S.panelTab === 'files' && !S.editor) loadFiles(S.cwd);
      toast(`Pinned ${res.pinned.length} file${res.pinned.length > 1 ? 's' : ''}`);
    } else {
      toast('Tip: click + in the composer to attach files from any folder');
    }
  });

  // Global keyboard shortcuts (Ctrl+S saves active file in editor)
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      if (S.panelOpen && S.panelTab === 'files' && S.editor?.editable) {
        e.preventDefault();
        saveEditorFile();
      }
    }
  });
}

// ---- Workspace & OS Folder Navigation
function renderWorkspaceUI() {
  const ws = S.settings?.workspace || '';
  const base = ws.split(/[\\/]/).filter(Boolean).pop() || ws || '/';
  $('#wsTopLabel').textContent = base;
  $('#wsTopPill').title = `OS Folder: ${ws}`;
  $('#osPathInput').value = S.cwd ? `${ws.replace(/[\\/]+$/, '')}/${S.cwd}` : ws;

  const q = $('#wsQuick');
  q.innerHTML = '';
  for (const f of S.quickFolders) {
    const btn = document.createElement('button');
    btn.textContent = f.label;
    btn.title = f.path;
    btn.className = ws === f.path ? 'on' : '';
    btn.onclick = () => navigateOsTo(f.path);
    q.appendChild(btn);
  }
}

async function navigateOsTo(targetPath) {
  try {
    const res = await CW.navigateOs(targetPath);
    S.settings = res.settings;
    S.cwd = '';
    S.pinnedFiles = [];
    S.searchActive = false;
    $('#fileSearchInput').value = '';
    $('#fileSearchClearBtn').hidden = true;
    closeFileEditor(true);
    renderWorkspaceUI();
    renderPinned();
    await loadFiles('');
  } catch (e) {
    toast(e.message, 3500);
  }
}

async function pickWorkspaceFolder() {
  const res = await CW.pickFolder();
  if (res.canceled) return;
  S.settings = res.settings;
  S.cwd = '';
  S.pinnedFiles = [];
  closeFileEditor(true);
  renderWorkspaceUI();
  renderPinned();
  openPanel('files');
  await loadFiles('');
  toast(`Workspace → ${res.workspace}`);
}

// ---- Chats Sidebar (grouped like mx-GPT webapp)
function chatGroupLabel(ts) {
  const d = new Date(ts || 0);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startToday) return 'Today';
  if (d.getTime() >= startToday - 86400000) return 'Yesterday';
  return 'Earlier';
}

async function loadChats() {
  const d = await CW.listChats();
  S.chats = d.chats || [];
  renderChatList();
}

function renderChatList() {
  const list = $('#chatList');
  const q = S.chatSearch.trim().toLowerCase();
  const filtered = q ? S.chats.filter((c) => (c.title || '').toLowerCase().includes(q)) : S.chats;
  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = `<div class="sb-empty">${q ? 'No matching chats' : 'No conversations yet'}</div>`;
    return;
  }

  let lastGroup = '';
  for (const c of filtered) {
    const grp = chatGroupLabel(c.updated);
    if (grp !== lastGroup) {
      lastGroup = grp;
      const lbl = document.createElement('div');
      lbl.className = 'sb-label';
      lbl.textContent = grp;
      list.appendChild(lbl);
    }
    const row = document.createElement('div');
    row.className = 'chat-item' + (S.chat?.id === c.id ? ' active' : '');
    row.innerHTML = `<span class="ci-title">${esc(c.title)}</span><button class="ci-del" title="Delete chat"><svg><use href="#i-trash"/></svg></button>`;
    row.onclick = (e) => {
      if (e.target.closest('.ci-del')) return;
      openChat(c.id);
    };
    row.querySelector('.ci-del').onclick = async (e) => {
      e.stopPropagation();
      await CW.deleteChat(c.id);
      if (S.chat?.id === c.id) { S.chat = null; S.messages = []; renderMessages(); }
      loadChats();
    };
    list.appendChild(row);
  }
}

async function openChat(id) {
  const d = await CW.getChat(id);
  S.chat = d.chat;
  S.messages = d.chat.messages || [];
  $('#chatTitle').textContent = d.chat.title || 'New chat';
  if (d.chat.mode) setMode(d.chat.mode);
  renderMessages();
  renderChatList();
}

function newChat() {
  S.chat = null;
  S.messages = [];
  $('#chatTitle').textContent = 'New chat';
  renderMessages();
  renderChatList();
  $('#promptInput').focus();
}

// ---- Messages Rendering (exact mx-GPT webapp layout)
function renderPinned() {
  const bar = $('#pinnedBar');
  if (!S.pinnedFiles.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = S.pinnedFiles.map((p) =>
    `<span class="attach-pill"><svg style="width:14px;height:14px;color:var(--accent)"><use href="#i-file"/></svg><span title="${esc(p)}">${esc(p)}</span><button data-unpin="${esc(p)}" title="Remove"><svg style="width:12px;height:12px"><use href="#i-x"/></svg></button></span>`
  ).join('');
  $$('[data-unpin]', bar).forEach((b) => {
    b.onclick = () => {
      S.pinnedFiles = S.pinnedFiles.filter((x) => x !== b.dataset.unpin);
      renderPinned();
      if (S.panelOpen && S.panelTab === 'files' && !S.editor) loadFiles(S.cwd);
    };
  });
}

function renderCopilotPanel(msg) {
  if (!msg.plan && !(msg.workers && msg.workers.length)) return null;
  const panel = document.createElement('div');
  panel.className = 'subagents-panel';
  const workers = msg.workers || [];
  const running = workers.filter((w) => w.status === 'running').length;
  const done = workers.filter((w) => w.status === 'done' || w.ok).length;

  const head = document.createElement('div');
  head.className = 'subagents-header';
  head.innerHTML = `
    <span class="sa-h-icon"><svg><use href="#i-agents"/></svg></span>
    <span class="sa-h-title">${esc(msg.plan?.goal || 'Copilot Orchestration')}</span>
    <span class="sa-h-meta">${workers.length ? `${done}/${workers.length} fast workers${running ? ' · running' : ''}` : 'Smart direct'}</span>`;
  panel.appendChild(head);

  if (workers.length) {
    const grid = document.createElement('div');
    grid.className = 'subagents-grid';
    for (const w of workers) {
      const card = document.createElement('div');
      const isRun = w.status === 'running';
      const isErr = w.status === 'error' || w.ok === false;
      card.className = 'subagent-card' + (isRun ? ' running open' : isErr ? ' error' : '');
      const stat = isRun
        ? `<span class="sa-pill running">Running</span>`
        : isErr
          ? `<span class="sa-pill error">Failed</span>`
          : `<span class="sa-pill done">${w.elapsedMs ? (w.elapsedMs / 1000).toFixed(1) + 's' : 'Done'}${w.tokensPerSec ? ' · ' + w.tokensPerSec + ' t/s' : ''}</span>`;
      card.innerHTML = `
        <button type="button" class="subagent-head">
          <div class="subagent-top">
            <span class="subagent-role">${esc(w.label || 'Worker')}</span>
            <span class="subagent-model">${esc((w.model || 'fast').replace(/:latest$/, ''))}</span>
            ${stat}
          </div>
          <div class="subagent-task">${esc(w.task || '')}</div>
        </button>
        <div class="subagent-body" data-worker-body="${esc(w.id || '')}">${esc(w.brief || w.stream || w.error || 'Retrieving…')}</div>`;
      card.querySelector('.subagent-head').onclick = () => card.classList.toggle('open');
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
      <div class="ac-title">Email Draft Ready</div>
      <div class="row-gap">
        <button class="btn tiny" data-em="copy">Copy</button>
        <button class="btn tiny" data-em="open">Open in Mail</button>
        <button class="btn tiny" data-em="eml">Save .eml</button>
        <button class="btn tiny primary" data-em="edit">Edit in Studio</button>
      </div>
    </div>
    <div class="ac-row">
      <div class="ac-desc">
        ${draft.to ? `<div><b>To:</b> ${esc(draft.to)}</div>` : ''}
        <div><b>Subject:</b> ${esc(draft.subject || '(No subject)')}</div>
        <div class="ac-reason" style="white-space:pre-wrap;margin-top:5px;color:var(--text-2)">${esc((draft.body || '').slice(0, 300))}${(draft.body || '').length > 300 ? '…' : ''}</div>
      </div>
    </div>`;
  card.querySelector('[data-em="copy"]').onclick = () => {
    navigator.clipboard?.writeText(`To: ${draft.to || ''}\nSubject: ${draft.subject || ''}\n\n${draft.body || ''}`);
    toast('Email copied');
  };
  card.querySelector('[data-em="open"]').onclick = () => CW.openEmlInMail(draft);
  card.querySelector('[data-em="eml"]').onclick = async () => {
    const r = await CW.saveEml(draft);
    if (!r.canceled) toast(`Saved ${r.filePath}`);
  };
  card.querySelector('[data-em="edit"]').onclick = () => {
    loadDraftIntoStudio(draft);
    openPanel('email');
  };
  return card;
}

function renderFileActionsCard(actions) {
  const card = document.createElement('div');
  card.className = 'action-card';
  const pendingCount = actions.filter((a) => a.status === 'pending').length;
  card.innerHTML = `
    <div class="ac-head">
      <div class="ac-title">Proposed Local File Actions (${actions.length})</div>
      ${pendingCount > 0 ? `<button class="btn tiny primary" data-apply-all>Apply All (${pendingCount})</button>` : '<span class="ac-stat">Processed</span>'}
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
      <div class="row-gap"></div>`;
    const btns = row.querySelector('.row-gap');
    if (act.status === 'pending') {
      const appBtn = document.createElement('button');
      appBtn.className = 'btn tiny primary';
      appBtn.textContent = 'Apply';
      appBtn.onclick = async () => {
        appBtn.disabled = true;
        try {
          const r = await CW.executeFileAction(act);
          act.status = 'applied'; act.result = r.summary; act.undoId = r.undoId;
          toast(r.summary);
          loadFiles(S.cwd); loadUndo(); renderMessages();
        } catch (e) {
          act.status = 'error'; act.result = e.message;
          toast(e.message); renderMessages();
        }
      };
      const skBtn = document.createElement('button');
      skBtn.className = 'btn tiny';
      skBtn.textContent = 'Skip';
      skBtn.onclick = () => { act.status = 'skipped'; renderMessages(); };
      btns.append(appBtn, skBtn);
    } else if (act.status === 'applied') {
      const st = document.createElement('span');
      st.className = 'ac-stat'; st.textContent = 'Applied';
      btns.appendChild(st);
      if (act.undoId) {
        const uBtn = document.createElement('button');
        uBtn.className = 'btn tiny'; uBtn.textContent = 'Undo';
        uBtn.onclick = async () => {
          const r = await CW.undoFileAction(act.undoId);
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
          const r = await CW.executeFileAction(act);
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

function renderCodeRunsCard(runs) {
  const card = document.createElement('div');
  card.className = 'action-card';
  card.innerHTML = `<div class="ac-head"><div class="ac-title">Container Code Execution (${runs.length})</div><span class="cr-badge">/workspace mounted</span></div>`;

  for (const run of runs) {
    const box = document.createElement('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '6px';
    box.style.padding = '9px 10px';
    box.style.borderRadius = '10px';
    box.style.background = 'var(--code-bg)';

    const script = run.code || run.command || '';
    const liveOut = S.containerRunOutputs[run.id] ?? run.output ?? '';
    const isRunning = run.status === 'running';

    box.innerHTML = `
      <div class="ac-head">
        <div class="cr-badges">
          <b style="font-size:12.5px">${esc(run.title || 'Container Run')}</b>
          <span class="cr-badge">${esc(run.language || 'bash')}</span>
          <span class="cr-badge">${esc(run.image || 'python:3.12-slim')}</span>
          <span class="cr-badge">net:${esc(run.network || 'none')}</span>
          <span class="cr-badge">${esc(run.mountMode || 'rw')}</span>
        </div>
        <div class="row-gap">
          ${isRunning
            ? `<button class="btn tiny danger" data-cr-stop>Stop</button>`
            : `<button class="btn tiny primary" data-cr-run>${run.status === 'done' || run.status === 'error' ? 'Re-run' : 'Run in Container'}</button>`}
          ${liveOut ? `<button class="btn tiny" data-cr-send>Send Output</button>` : ''}
        </div>
      </div>
      ${run.reason ? `<div class="ac-reason">${esc(run.reason)}</div>` : ''}
      <pre class="cr-code">${esc(script)}</pre>
      ${run.status === 'done' ? `<span class="ac-stat">✓ Exit 0 (${run.elapsedMs ? (run.elapsedMs / 1000).toFixed(1) + 's' : 'done'})</span>` : ''}
      ${run.status === 'error' ? `<span class="ac-stat err">✗ Exit ${run.exitCode ?? 1}</span>` : ''}
      ${liveOut ? `<pre class="cr-term" data-term-id="${esc(run.id)}">${esc(liveOut)}</pre>` : ''}`;

    const runBtn = box.querySelector('[data-cr-run]');
    if (runBtn) {
      runBtn.onclick = async () => {
        run.status = 'running';
        S.containerRunOutputs[run.id] = '';
        renderMessages();
        try {
          const r = await CW.runInContainer({
            runId: run.id,
            title: run.title,
            language: run.language,
            code: run.code,
            command: run.command,
            image: run.image,
            network: run.network,
            mountMode: run.mountMode,
          });
          run.status = r.ok ? 'done' : 'error';
          run.exitCode = r.exitCode;
          run.elapsedMs = r.elapsedMs;
          run.output = [r.stdout, r.stderr].filter(Boolean).join('\n').trim() || '(no output)';
          S.containerRunOutputs[run.id] = run.output;
          loadContainerHistory();
          loadFiles(S.cwd);
          renderMessages();
        } catch (e) {
          run.status = 'error';
          run.output = e.message;
          S.containerRunOutputs[run.id] = e.message;
          toast(e.message, 4500);
          renderMessages();
        }
      };
    }

    const stopBtn = box.querySelector('[data-cr-stop]');
    if (stopBtn) {
      stopBtn.onclick = () => CW.stopContainerRun(run.id);
    }

    const sendBtn = box.querySelector('[data-cr-send]');
    if (sendBtn) {
      sendBtn.onclick = () => {
        const out = (S.containerRunOutputs[run.id] || run.output || '').slice(0, 6000);
        sendPrompt(`Here is the container execution output for "${run.title}" (exit ${run.exitCode ?? '?'}):\n\`\`\`\n${out}\n\`\`\`\nPlease analyze the result and suggest or take the next step.`);
      };
    }

    card.appendChild(box);
  }
  return card;
}

function isNearBottom(el, threshold = 100) {
  return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
}

function scrollFeedIfNearBottom(force = false) {
  const sc = $('#scrollArea');
  if (force || isNearBottom(sc, 110)) {
    sc.scrollTop = sc.scrollHeight;
  }
}

function renderMessages(forceScroll = true) {
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

    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.innerHTML = '<svg><use href="#i-star"/></svg>';
    el.appendChild(av);

    const body = document.createElement('div');
    body.className = 'msg-body';

    if (m.livePhase) {
      const ph = document.createElement('div');
      ph.className = 'loading-state' + (m.queuePos ? ' queued' : '');
      ph.innerHTML = `<span class="mini-spin"></span><span>${esc(m.livePhase)}</span>`;
      body.appendChild(ph);
    }

    const cp = renderCopilotPanel(m);
    if (cp) body.appendChild(cp);

    if (m.thinking) {
      const th = document.createElement('details');
      th.className = 'think-box';
      th.innerHTML = `<summary>Thinking (${m.thinking.length} chars)</summary><pre>${esc(m.thinking)}</pre>`;
      body.appendChild(th);
    }

    if (m.content) {
      const pr = document.createElement('div');
      pr.className = 'prose';
      pr.innerHTML = renderMd(m.content);
      body.appendChild(pr);
    }

    if (m.fileActions?.length) body.appendChild(renderFileActionsCard(m.fileActions));
    if (m.codeRuns?.length) body.appendChild(renderCodeRunsCard(m.codeRuns));
    if (m.graphReady) {
      const gb = document.createElement('div');
      gb.className = 'action-card';
      gb.innerHTML = `
        <div class="ac-head">
          <div class="ac-title">Project Knowledge Graph Mapped (${esc(m.graphReady.projectName || 'Workspace')})</div>
          <button class="btn tiny primary" data-open-graph>Open Interactive Graph</button>
        </div>
        <div class="ac-reason">${m.graphReady.stats?.fileCount || 0} files · ${m.graphReady.stats?.importEdges || 0} dependency links · ${m.graphReady.stats?.packageCount || 0} packages</div>`;
      gb.querySelector('[data-open-graph]').onclick = () => openPanel('graph');
      body.appendChild(gb);
    }

    if (m.sources?.length) {
      const sr = document.createElement('div');
      sr.className = 'sources';
      for (const s of m.sources.slice(0, 10)) {
        if (s.type === 'url' && s.url) {
          const b = document.createElement('button');
          b.className = 'src-chip';
          b.innerHTML = `<svg style="width:13px;height:13px;color:var(--accent)"><use href="#i-globe"/></svg><span>${esc(s.title || s.url)}</span>`;
          b.onclick = () => CW.openExternal(s.url);
          sr.appendChild(b);
        } else if (s.path) {
          const b = document.createElement('button');
          b.className = 'src-chip';
          b.innerHTML = `<svg style="width:13px;height:13px;color:var(--accent)"><use href="#i-file"/></svg><span>${esc(s.path)}</span>`;
          b.onclick = () => { openPanel('files'); openFileInEditor(s.path); };
          sr.appendChild(b);
        }
      }
      body.appendChild(sr);
    }

    if (!m.streaming && m.content) {
      const foot = document.createElement('div');
      foot.className = 'msg-foot-bar';
      const spd = m.usage?.tokensPerSec ? `${m.usage.tokensPerSec} t/s` : '';
      const modeLbl = m.mode === 'copilot_b' ? 'Copilot (B)' : (m.mode || 'copilot');
      const info = [modeLbl, m.model ? m.model.replace(/:latest$/, '') : '', spd].filter(Boolean).join(' · ');
      const span = document.createElement('span');
      span.textContent = info;
      const cpBtn = document.createElement('button');
      cpBtn.textContent = 'Copy';
      cpBtn.onclick = () => { navigator.clipboard?.writeText(m.content); toast('Copied'); };
      const svBtn = document.createElement('button');
      svBtn.textContent = 'Save Brief';
      svBtn.onclick = async () => {
        await CW.saveBrief({
          title: (m.plan?.goal || S.chat?.title || 'Research Brief').slice(0, 80),
          markdown: m.content,
          sources: m.sources || [],
        });
        toast('Saved to Research Desk');
        loadBriefs();
      };
      foot.append(span, cpBtn, svBtn);
      body.appendChild(foot);
    }

    el.appendChild(body);
    wrap.appendChild(el);
  }
  scrollFeedIfNearBottom(forceScroll);
}

// Create a dedicated, non-rebuilt DOM container for the active streaming turn (zero jitter!)
function mountLiveAssistantDom(initialPhase) {
  const wrap = $('#messages');
  $('#welcome').classList.add('hidden');
  const el = document.createElement('div');
  el.className = 'msg assistant';

  const av = document.createElement('div');
  av.className = 'msg-avatar';
  av.innerHTML = '<svg><use href="#i-star"/></svg>';
  el.appendChild(av);

  const body = document.createElement('div');
  body.className = 'msg-body';

  const phaseEl = document.createElement('div');
  phaseEl.className = 'loading-state';
  phaseEl.innerHTML = `<span class="mini-spin"></span><span class="phase-txt">${esc(initialPhase)}</span>`;
  body.appendChild(phaseEl);

  const planSlot = document.createElement('div');
  planSlot.hidden = true;
  body.appendChild(planSlot);

  const thinkEl = document.createElement('details');
  thinkEl.className = 'think-box';
  thinkEl.hidden = true;
  const thinkSummary = document.createElement('summary');
  thinkSummary.textContent = 'Thinking…';
  const thinkPre = document.createElement('pre');
  thinkEl.append(thinkSummary, thinkPre);
  body.appendChild(thinkEl);

  const proseEl = document.createElement('div');
  proseEl.className = 'prose';
  proseEl.hidden = true;
  body.appendChild(proseEl);

  const cardsSlot = document.createElement('div');
  cardsSlot.style.display = 'flex';
  cardsSlot.style.flexDirection = 'column';
  cardsSlot.style.gap = '10px';
  body.appendChild(cardsSlot);

  el.appendChild(body);
  wrap.appendChild(el);
  scrollFeedIfNearBottom(true);

  return {
    el,
    phaseEl,
    phaseTxt: phaseEl.querySelector('.phase-txt'),
    planSlot,
    thinkEl,
    thinkSummary,
    thinkPre,
    proseEl,
    cardsSlot,
  };
}

// ---- Send / Stream Cowork Turn (Zero-Jitter Incremental DOM)
async function sendPrompt(overrideText = null) {
  if (S.streaming) {
    if (S.chat?.id) CW.stopCowork(S.chat.id).catch(() => {});
    return;
  }
  const input = $('#promptInput');
  const prompt = (overrideText !== null ? overrideText : input.value).trim();
  if (!prompt) return;
  if (overrideText === null) { input.value = ''; input.style.height = 'auto'; }

  const streamId = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  S.activeStreamId = streamId;
  S.messages.push({ id: 'tmp-u', role: 'user', content: prompt });

  // Render existing messages + new user bubble once, then mount a stable live assistant DOM
  renderMessages(true);

  const initialPhase = S.mode === 'copilot_b'
    ? 'Copilot (B) planning…'
    : S.mode === 'copilot'
      ? 'Copilot planning…'
      : 'Connecting…';

  const assistant = {
    id: 'tmp-a',
    role: 'assistant',
    mode: S.mode,
    content: '',
    thinking: '',
    plan: null,
    workers: [],
    sources: [],
    fileActions: [],
    codeRuns: [],
    livePhase: initialPhase,
    queuePos: 0,
    streaming: true,
  };
  S.messages.push(assistant);
  const live = mountLiveAssistantDom(initialPhase);

  S.streaming = true;
  $('#sendBtn').classList.add('stop');
  $('#sendIcon use').setAttribute('href', '#i-stop');

  let proseTimer = null;
  const flushProse = () => {
    proseTimer = null;
    if (!assistant.content) return;
    const sc = $('#scrollArea');
    const stick = isNearBottom(sc, 110);
    live.proseEl.hidden = false;
    live.proseEl.innerHTML = renderMd(assistant.content);
    if (stick) sc.scrollTop = sc.scrollHeight;
  };
  const scheduleProse = () => {
    if (!proseTimer) proseTimer = setTimeout(flushProse, 75);
  };

  let thinkTimer = null;
  let pendingThink = '';
  const flushThink = () => {
    thinkTimer = null;
    if (!pendingThink) return;
    const chunk = pendingThink;
    pendingThink = '';
    live.thinkEl.hidden = false;
    live.thinkSummary.textContent = `Thinking (${assistant.thinking.length} chars)`;
    const preNearBot = isNearBottom(live.thinkPre, 40);
    live.thinkPre.append(document.createTextNode(chunk));
    if (preNearBot) live.thinkPre.scrollTop = live.thinkPre.scrollHeight;
  };

  const refreshPlanPanel = () => {
    const cp = renderCopilotPanel(assistant);
    live.planSlot.innerHTML = '';
    if (cp) {
      live.planSlot.hidden = false;
      live.planSlot.appendChild(cp);
    }
  };

  const off = CW.onCoworkEvent(({ streamId: sid, event: ev, data: d }) => {
    if (sid !== streamId) return;
    if (ev === 'chat' && d.chat) {
      S.chat = d.chat;
      $('#chatTitle').textContent = d.chat.title || 'New chat';
      loadChats();
    } else if (ev === 'phase') {
      assistant.queuePos = 0;
      assistant.livePhase = d.label || d.phase;
      live.phaseEl.hidden = false;
      live.phaseEl.className = 'loading-state';
      live.phaseTxt.textContent = assistant.livePhase;
    } else if (ev === 'queue') {
      if (d.acquired || !d.position) {
        assistant.queuePos = 0;
        assistant.livePhase = 'Preparing response…';
        live.phaseEl.className = 'loading-state';
      } else {
        assistant.queuePos = d.position;
        assistant.livePhase = `Queued #${d.position}${d.runningLabel ? ` · waiting for ${d.runningLabel}` : ''}`;
        live.phaseEl.className = 'loading-state queued';
      }
      live.phaseEl.hidden = false;
      live.phaseTxt.textContent = assistant.livePhase;
    } else if (ev === 'copilot_plan') {
      assistant.plan = d;
      refreshPlanPanel();
    } else if (ev === 'worker_start') {
      assistant.workers.push({ ...d, status: 'running', stream: '' });
      refreshPlanPanel();
    } else if (ev === 'worker_delta') {
      const w = assistant.workers.find((x) => x.id === d.id);
      if (w) {
        w.stream = (w.stream || '') + (d.delta || '');
        const bodyEl = live.planSlot.querySelector(`[data-worker-body="${CSS.escape(d.id)}"]`);
        if (bodyEl) bodyEl.textContent = w.stream;
      }
    } else if (ev === 'worker_done') {
      const w = assistant.workers.find((x) => x.id === d.id);
      if (w) { Object.assign(w, d, { status: d.ok ? 'done' : 'error' }); refreshPlanPanel(); }
    } else if (ev === 'thinking') {
      assistant.queuePos = 0;
      assistant.livePhase = 'Thinking…';
      live.phaseEl.hidden = false;
      live.phaseEl.className = 'loading-state';
      live.phaseTxt.textContent = 'Thinking…';
      const delta = d.delta || '';
      if (delta) {
        assistant.thinking += delta;
        pendingThink += delta;
        if (!thinkTimer) thinkTimer = setTimeout(flushThink, 90);
      }
    } else if (ev === 'text') {
      assistant.livePhase = '';
      live.phaseEl.hidden = true;
      assistant.content += d.delta || '';
      scheduleProse();
    } else if (ev === 'file_actions') {
      assistant.fileActions = d;
    } else if (ev === 'code_runs') {
      assistant.codeRuns = d;
    } else if (ev === 'graph_ready') {
      assistant.graphReady = d;
    } else if (ev === 'notes_saved') {
      loadNotes();
      toast(`Saved ${d.length} memory note${d.length > 1 ? 's' : ''}`);
    } else if (ev === 'sources') {
      assistant.sources = d;
    } else if (ev === 'done') {
      if (proseTimer) { clearTimeout(proseTimer); proseTimer = null; }
      if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
      Object.assign(assistant, d.message || {}, { streaming: false, livePhase: '' });
      renderMessages(false);
      loadChats();
    } else if (ev === 'error') {
      assistant.livePhase = '';
      assistant.streaming = false;
      assistant.content += `\n\n> **Error:** ${d.message}`;
      toast(d.message, 4500);
      renderMessages(false);
    }
  });

  try {
    await CW.runCowork({
      streamId,
      chatId: S.chat?.id || null,
      mode: S.mode,
      think: S.think,
      prompt,
      pinnedFiles: S.pinnedFiles,
      toolOverrides: {
        toolWebSearch: S.toolWebSearch,
        toolOsFiles: S.toolOsFiles,
        toolContainer: S.containerEnabled,
      },
    });
  } catch (e) {
    assistant.content += `\n\n> **Error:** ${e.message}`;
    toast(e.message, 4500);
  } finally {
    off();
    if (proseTimer) clearTimeout(proseTimer);
    if (thinkTimer) clearTimeout(thinkTimer);
    assistant.streaming = false;
    assistant.livePhase = '';
    S.streaming = false;
    S.activeStreamId = null;
    $('#sendBtn').classList.remove('stop');
    $('#sendIcon use').setAttribute('href', '#i-send');
    renderMessages(false);
  }
}

// ---- OS File Browser + Find + Live File Editor
function renderFileCrumbs() {
  const wrap = $('#fileCrumbs');
  wrap.innerHTML = '';
  const rootBtn = document.createElement('button');
  const wsName = (S.settings?.workspace || '/').split(/[\\/]/).filter(Boolean).pop() || '/';
  rootBtn.textContent = wsName;
  rootBtn.onclick = () => loadFiles('');
  wrap.appendChild(rootBtn);

  if (S.cwd) {
    const parts = S.cwd.split('/').filter(Boolean);
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      const target = acc;
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      const b = document.createElement('button');
      b.textContent = part;
      b.onclick = () => loadFiles(target);
      wrap.append(sep, b);
    }
  }
}

async function loadFiles(relPath = '') {
  try {
    const d = await CW.listFiles(relPath);
    S.cwd = d.path || '';
    S.searchActive = false;
    $('#fileSearchClearBtn').hidden = true;
    renderWorkspaceUI();
    renderFileCrumbs();

    const list = $('#fileList');
    list.innerHTML = '';
    if (!d.items.length) {
      list.innerHTML = '<div class="sb-empty" style="padding:24px;text-align:center">This folder is empty.</div>';
      return;
    }

    for (const it of d.items) {
      const row = document.createElement('div');
      row.className = 'file-row' + (it.isDir ? ' dir' : '');
      const pinned = S.pinnedFiles.includes(it.relPath);
      row.innerHTML = `
        <span class="file-ico"><svg><use href="${it.isDir ? '#i-folder' : '#i-file'}"/></svg></span>
        <span class="file-main">
          <span class="file-name" title="${esc(it.relPath)}">${esc(it.name)}</span>
        </span>
        ${it.isDir ? '' : `<span class="file-sub">${esc(it.sizeLabel)}</span>`}
        <span class="file-acts ${pinned ? 'pinned' : ''}">
          ${it.isDir ? '' : `<button data-act="pin" class="${pinned ? 'on' : ''}" title="${pinned ? 'Unpin' : 'Pin to chat'}"><svg><use href="#i-pin"/></svg></button>`}
          ${it.isDir ? '' : `<button data-act="edit" title="Edit file"><svg><use href="#i-edit"/></svg></button>`}
          <button data-act="rename" title="Rename"><svg><use href="#i-external"/></svg></button>
          <button data-act="del" class="danger" title="Move to safe trash"><svg><use href="#i-trash"/></svg></button>
        </span>`;

      row.onclick = (e) => {
        if (e.target.closest('.file-acts')) return;
        if (it.isDir) loadFiles(it.relPath);
        else openFileInEditor(it.relPath);
      };
      const pinBtn = row.querySelector('[data-act="pin"]');
      if (pinBtn) pinBtn.onclick = (e) => { e.stopPropagation(); togglePin(it.relPath); };
      const editBtn = row.querySelector('[data-act="edit"]');
      if (editBtn) editBtn.onclick = (e) => { e.stopPropagation(); openFileInEditor(it.relPath); };
      row.querySelector('[data-act="rename"]').onclick = (e) => { e.stopPropagation(); renameItem(it.relPath, it.name); };
      row.querySelector('[data-act="del"]').onclick = async (e) => {
        e.stopPropagation();
        try {
          const r = await CW.deleteFile(it.relPath);
          toast(r.summary);
          loadFiles(S.cwd); loadUndo();
        } catch (err) { toast(err.message); }
      };
      list.appendChild(row);
    }
  } catch (e) {
    $('#fileList').innerHTML = `<div class="sb-empty">Could not read folder: ${esc(e.message)}</div>`;
  }
}

function togglePin(relPath) {
  if (S.pinnedFiles.includes(relPath)) S.pinnedFiles = S.pinnedFiles.filter((x) => x !== relPath);
  else S.pinnedFiles.push(relPath);
  renderPinned();
  if (!S.editor && !S.searchActive) loadFiles(S.cwd);
  updateEditorPinBtn();
}

async function searchLocalFiles() {
  const q = $('#fileSearchInput').value.trim();
  if (!q) { loadFiles(S.cwd); return; }
  S.searchActive = true;
  $('#fileSearchClearBtn').hidden = false;
  $('#fileList').innerHTML = '<div class="sb-empty" style="padding:18px">Searching filenames &amp; file contents…</div>';
  try {
    const d = await CW.searchFiles({ query: q, relPath: S.cwd });
    const list = $('#fileList');
    list.innerHTML = `<div class="sb-label" style="padding:4px 8px 8px">${d.results.length} matches (scanned ${d.scanned} files)</div>`;
    for (const hit of d.results) {
      const row = document.createElement('div');
      row.className = 'file-row';
      const pinned = S.pinnedFiles.includes(hit.relPath);
      row.innerHTML = `
        <span class="file-ico"><svg><use href="#i-file"/></svg></span>
        <span class="file-main">
          <span class="file-name" title="${esc(hit.relPath)}">${esc(hit.relPath)}</span>
          ${hit.snippet ? `<span class="file-snip">${esc(hit.snippet)}</span>` : ''}
        </span>
        <span class="file-sub">${esc(hit.sizeLabel)}</span>
        <span class="file-acts ${pinned ? 'pinned' : ''}">
          <button data-act="pin" class="${pinned ? 'on' : ''}" title="Pin to chat"><svg><use href="#i-pin"/></svg></button>
          <button data-act="edit" title="Open in editor"><svg><use href="#i-edit"/></svg></button>
        </span>`;
      row.onclick = (e) => {
        if (e.target.closest('.file-acts')) return;
        openFileInEditor(hit.relPath);
      };
      row.querySelector('[data-act="pin"]').onclick = (e) => { e.stopPropagation(); togglePin(hit.relPath); searchLocalFiles(); };
      row.querySelector('[data-act="edit"]').onclick = (e) => { e.stopPropagation(); openFileInEditor(hit.relPath); };
      list.appendChild(row);
    }
  } catch (e) { toast(e.message); }
}

// ---- Live OS File Editor
function updateEditorStats() {
  const txt = $('#edTextarea').value;
  const lines = txt ? txt.split('\n').length : 0;
  $('#edStats').textContent = `${lines} lines · ${txt.length} chars`;
  const dirty = S.editor && S.editor.editable && txt !== S.editor.savedContent;
  $('#edDirtyDot').hidden = !dirty;
}

function updateEditorPinBtn() {
  if (!S.editor) return;
  const pinned = S.pinnedFiles.includes(S.editor.path);
  $('#edPinBtn').classList.toggle('primary', pinned);
}

async function openFileInEditor(relPath) {
  try {
    const f = await CW.readFileForEdit(relPath);
    S.editor = { ...f, savedContent: f.content };
    $('#filesBrowserView').hidden = true;
    $('#fileEditorView').hidden = false;
    $('#edFileName').textContent = f.name;
    $('#edFilePath').textContent = f.absPath;
    $('#edTextarea').value = f.content;
    $('#edTextarea').readOnly = !f.editable;
    $('#edSaveBtn').disabled = !f.editable;
    $('#edReadonlyNote').hidden = f.editable;
    updateEditorStats();
    updateEditorPinBtn();
  } catch (e) {
    toast(e.message, 4000);
  }
}

function closeFileEditor(force = false) {
  if (!force && S.editor?.editable && $('#edTextarea').value !== S.editor.savedContent) {
    toast('Closed without saving (use Undo or re-open)');
  }
  S.editor = null;
  $('#fileEditorView').hidden = true;
  $('#filesBrowserView').hidden = false;
}

async function saveEditorFile() {
  if (!S.editor || !S.editor.editable) return;
  const content = $('#edTextarea').value;
  try {
    const r = await CW.writeFile({ path: S.editor.path, content });
    S.editor.savedContent = content;
    updateEditorStats();
    loadUndo();
    toast(r.summary || `Saved ${S.editor.name}`);
  } catch (e) {
    toast(e.message, 4000);
  }
}

async function createNewFile() {
  const name = await askText({
    title: 'New File',
    label: `Create file inside /${S.cwd}`,
    placeholder: 'notes.md',
  });
  if (!name) return;
  const rel = S.cwd ? `${S.cwd}/${name}` : name;
  try {
    await CW.writeFile({ path: rel, content: '' });
    await loadFiles(S.cwd);
    loadUndo();
    openFileInEditor(rel);
    toast(`Created ${rel}`);
  } catch (e) { toast(e.message); }
}

async function createNewFolder() {
  const name = await askText({
    title: 'New Folder',
    label: `Create folder inside /${S.cwd}`,
    placeholder: 'project-docs',
  });
  if (!name) return;
  const rel = S.cwd ? `${S.cwd}/${name}` : name;
  try {
    await CW.mkdir(rel);
    await loadFiles(S.cwd);
    loadUndo();
    toast(`Created folder ${rel}`);
  } catch (e) { toast(e.message); }
}

async function renameItem(relPath, currentName) {
  const nextName = await askText({
    title: 'Rename',
    label: `Rename "${currentName}"`,
    value: currentName,
  });
  if (!nextName || nextName === currentName) return;
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  const to = dir ? `${dir}/${nextName}` : nextName;
  try {
    const r = await CW.renameFile({ from: relPath, to });
    toast(r.summary);
    if (S.editor && S.editor.path === relPath) {
      openFileInEditor(to);
    } else {
      loadFiles(S.cwd);
    }
    loadUndo();
  } catch (e) { toast(e.message); }
}

// ---- Persistent Memory Notes & Quick Local Tools
async function loadNotes() {
  try {
    const d = await CW.listNotes();
    S.notes = d.notes || [];
    const list = $('#notesList');
    list.innerHTML = S.notes.length ? '' : '<div class="muted-note">No saved memory notes yet. Add notes here or ask Copilot to "remember" something.</div>';
    for (const n of S.notes) {
      const card = document.createElement('div');
      card.className = 'saved-card';
      card.innerHTML = `
        <div class="sc-row"><b>${esc(n.title)}</b><button class="btn tiny danger">✕</button></div>
        <small style="white-space:pre-wrap;color:var(--text-2)">${esc(n.content.slice(0, 260))}${n.content.length > 260 ? '…' : ''}</small>
        ${n.tags?.length ? `<small>${esc(n.tags.join(' · '))}</small>` : ''}`;
      card.querySelector('button').onclick = async (e) => {
        e.stopPropagation();
        await CW.deleteNote(n.id);
        loadNotes();
      };
      list.appendChild(card);
    }
  } catch {}
}

// ---- Research Desk
async function loadBriefs() {
  const d = await CW.listBriefs();
  S.briefs = d.briefs || [];
  const list = $('#briefsList');
  list.innerHTML = S.briefs.length ? '' : '<div class="muted-note">Save any Copilot answer as a research brief or export to Markdown.</div>';
  for (const b of S.briefs) {
    const card = document.createElement('div');
    card.className = 'saved-card';
    card.innerHTML = `
      <div class="sc-row"><b>${esc(b.title)}</b><button class="btn tiny danger" data-del>✕</button></div>
      <small>${new Date(b.updatedAt).toLocaleString()}</small>
      <div class="row-gap" style="margin-top:4px">
        <button class="btn tiny" data-save-md>Save .md…</button>
      </div>`;
    card.querySelector('[data-del]').onclick = async () => { await CW.deleteBrief(b.id); loadBriefs(); };
    card.querySelector('[data-save-md]').onclick = async () => {
      const r = await CW.exportBriefMd(b);
      if (!r.canceled) { toast(`Saved ${r.filePath}`); loadFiles(S.cwd); }
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
    const d = await CW.researchSearch(q);
    out.innerHTML = '';
    if (d.wiki) {
      const w = document.createElement('div');
      w.className = 'saved-card';
      w.innerHTML = `<b>Wikipedia: ${esc(d.wiki.title)}</b><small>${esc(d.wiki.extract.slice(0, 200))}…</small>`;
      w.onclick = () => CW.openExternal(d.wiki.url);
      out.appendChild(w);
    }
    for (const r of d.results || []) {
      const c = document.createElement('div');
      c.className = 'saved-card';
      c.innerHTML = `<b>${esc(r.title)}</b><small>${esc(r.snippet.slice(0, 150))}</small>`;
      c.onclick = () => CW.openExternal(r.url);
      out.appendChild(c);
    }
    const askBtn = document.createElement('button');
    askBtn.className = 'btn tiny primary';
    askBtn.textContent = 'Run Copilot Deep Research';
    askBtn.onclick = () => { setMode('copilot'); sendPrompt(`Research "${q}" thoroughly and write a clear, cited executive brief.`); };
    out.appendChild(askBtn);
  } catch (e) {
    out.innerHTML = `<div class="muted-note">Search failed: ${esc(e.message)}</div>`;
  }
}

// ---- Undo Log
async function loadUndo() {
  const d = await CW.listUndo();
  S.undo = d.history || [];
  const cnt = $('#undoCount');
  cnt.textContent = String(S.undo.length);
  cnt.hidden = S.undo.length === 0;
  const list = $('#undoList');
  list.innerHTML = S.undo.length ? '' : '<div class="muted-note">No file operations recorded yet.</div>';
  for (const u of S.undo) {
    const card = document.createElement('div');
    card.className = 'saved-card';
    card.innerHTML = `<div class="sc-row"><b>${esc(u.summary)}</b><button class="btn tiny">Undo</button></div><small>${new Date(u.ts).toLocaleString()}</small>`;
    card.querySelector('button').onclick = async () => {
      try {
        const r = await CW.undoFileAction(u.id);
        toast(r.summary);
        loadUndo();
        if (S.editor) openFileInEditor(S.editor.path);
        else loadFiles(S.cwd);
      } catch (e) { toast(e.message); }
    };
    list.appendChild(card);
  }
}

// ---- Interactive Project Knowledge Graph Controller
function initGraphViewIfNeeded() {
  if (S.graphView || typeof window.KnowledgeGraphView !== 'function') return;
  const canvas = $('#graphCanvas');
  if (!canvas) return;
  S.graphView = new window.KnowledgeGraphView(canvas, {
    onSelect: (node, neighbors) => renderGraphInspector(node, neighbors),
    onOpenFile: (relPath) => {
      S.graphExpanded = false;
      $('#panel').classList.remove('graph-expanded');
      openPanel('files');
      openFileInEditor(relPath);
    },
  });
  window.addEventListener('resize', () => {
    if (S.panelOpen && S.panelTab === 'graph') S.graphView?.resize();
  });
}

async function ensureGraphLoaded() {
  initGraphViewIfNeeded();
  setTimeout(() => S.graphView?.resize(), 60);
  if (!S.graphData || S.graphData.workspace !== S.settings?.workspace) {
    await buildAndRenderGraph();
  } else {
    setTimeout(() => S.graphView?.fitToView(), 90);
  }
}

async function buildAndRenderGraph() {
  initGraphViewIfNeeded();
  $('#graphStats').textContent = 'Scanning workspace & building knowledge graph…';
  $('#graphBuildBtn').disabled = true;
  try {
    const g = await CW.buildGraph({ includePackages: true });
    S.graphData = g;
    const st = g.stats || {};
    $('#graphStats').textContent = `${g.projectName} · ${st.fileCount || 0} files · ${st.folderCount || 0} folders · ${st.importEdges || 0} links · ${st.packageCount || 0} pkgs · ${(st.totalLines || 0).toLocaleString()} lines (${g.elapsedMs}ms)`;
    $('#graphInspector').hidden = true;
    S.graphView?.resize();
    S.graphView?.setFilters(S.graphFilters);
    S.graphView?.setData(g);
  } catch (e) {
    $('#graphStats').textContent = `Graph build failed: ${e.message}`;
    toast(e.message, 4000);
  } finally {
    $('#graphBuildBtn').disabled = false;
  }
}

function renderGraphInspector(node, { incoming = [], outgoing = [] } = {}) {
  const box = $('#graphInspector');
  if (!node) { box.hidden = true; return; }
  box.hidden = false;
  $('#giTitle').textContent = node.label || node.id;
  $('#giPath').textContent = node.path || (node.kind === 'package' ? `Package ${node.version || ''}` : S.graphData?.workspace || '');

  const isFile = Boolean(node.path) && node.kind !== 'folder';
  $('#giEditBtn').hidden = !isFile;
  $('#giPinBtn').hidden = !isFile;
  $('#giEditBtn').onclick = () => {
    S.graphExpanded = false;
    $('#panel').classList.remove('graph-expanded');
    openPanel('files');
    openFileInEditor(node.path);
  };
  $('#giPinBtn').onclick = () => {
    if (!S.pinnedFiles.includes(node.path)) {
      S.pinnedFiles.push(node.path);
      renderPinned();
      toast(`Pinned ${node.path}`);
    }
  };
  $('#giAskBtn').onclick = () => {
    if (isFile && !S.pinnedFiles.includes(node.path)) {
      S.pinnedFiles.push(node.path);
      renderPinned();
    }
    S.graphExpanded = false;
    $('#panel').classList.remove('graph-expanded');
    const neighbors = [...outgoing.map((x) => x.node.path || x.node.label), ...incoming.map((x) => x.node.path || x.node.label)].slice(0, 8);
    setMode('copilot');
    sendPrompt(`Explain the role of "${node.path || node.label}" in this project (connected to: ${neighbors.join(', ') || 'none'}) and suggest any improvements.`);
  };

  const metaParts = [
    `<span class="gi-pill">${esc(node.kind || 'file')}</span>`,
    node.lines ? `<span class="gi-pill">${node.lines} lines</span>` : '',
    node.sizeLabel ? `<span class="gi-pill">${esc(node.sizeLabel)}</span>` : '',
    `<span class="gi-pill">${incoming.length} in · ${outgoing.length} out</span>`,
  ].filter(Boolean);
  $('#giMeta').innerHTML = metaParts.join('');

  const links = $('#giLinks');
  links.innerHTML = '';

  if (node.symbols?.length) {
    const grp = document.createElement('div');
    grp.className = 'gi-group';
    grp.innerHTML = `<span>Symbols:</span>` + node.symbols.slice(0, 10).map((s) => `<span class="gi-pill">${esc(s.kind)}:${esc(s.name)}</span>`).join('');
    links.appendChild(grp);
  }

  const addNeighborGroup = (label, list) => {
    if (!list.length) return;
    const grp = document.createElement('div');
    grp.className = 'gi-group';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    grp.appendChild(lbl);
    for (const item of list.slice(0, 12)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gi-link-btn';
      b.textContent = item.node.label;
      b.title = `${item.type}: ${item.node.path || item.node.label}`;
      b.onclick = () => S.graphView?.centerOnNode(item.node);
      grp.appendChild(b);
    }
    links.appendChild(grp);
  };
  addNeighborGroup('Imports / Links →', outgoing.filter((x) => x.type !== 'contains'));
  addNeighborGroup('Imported By ←', incoming.filter((x) => x.type !== 'contains'));
}

// ---- Container Sandbox Controller
async function loadContainerStatus(force = false) {
  const banner = $('#ctStatusBanner');
  const txt = $('#ctStatusText');
  try {
    const st = await CW.containerStatus({ force });
    S.containerStatus = st;
    if (st.available) {
      banner.className = 'ct-status ok';
      const info = st.activeRuntime === 'docker' ? st.docker : st.podman;
      txt.textContent = `✓ ${st.activeRuntime.toUpperCase()} ready (${info.serverVersion || info.version})`;
    } else {
      banner.className = 'ct-status err';
      txt.textContent = st.docker?.installed
        ? 'Docker installed — start Docker daemon to run containers'
        : 'Install Docker or Podman to execute code in containers';
    }
    const presetsWrap = $('#ctImagePresets');
    presetsWrap.innerHTML = '';
    for (const p of st.presets || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-btn';
      b.textContent = p.label;
      b.title = `${p.id} — ${p.desc}`;
      b.onclick = () => {
        $('#ctImage').value = p.id;
        $('#ctLang').value = p.lang;
      };
      presetsWrap.appendChild(b);
    }
  } catch (e) {
    banner.className = 'ct-status err';
    txt.textContent = `Container check error: ${e.message}`;
  }
}

function handleContainerOutputChunk(ev) {
  if (!ev || !ev.runId) return;
  const chunk = ev.chunk || '';
  S.containerRunOutputs[ev.runId] = (S.containerRunOutputs[ev.runId] || '') + chunk;

  // Live-update sandbox terminal if this is the active sandbox run
  if (ev.runId === S.activeContainerRunId) {
    const term = $('#ctTerminal');
    term.textContent = S.containerRunOutputs[ev.runId];
    term.scrollTop = term.scrollHeight;
  }

  // Live-update inline chat container card terminal if visible
  const inlineTerm = document.querySelector(`[data-term-id="${CSS.escape(ev.runId)}"]`);
  if (inlineTerm) {
    inlineTerm.textContent = S.containerRunOutputs[ev.runId];
    inlineTerm.scrollTop = inlineTerm.scrollHeight;
  }
}

async function runSandboxContainer() {
  const code = $('#ctCodeInput').value.trim();
  if (!code) { toast('Enter code or a shell command first'); return; }
  const runId = 'sb_' + Date.now().toString(36);
  S.activeContainerRunId = runId;
  S.containerRunOutputs[runId] = '';
  $('#ctTerminal').textContent = 'Starting container…\n';
  $('#ctRunMeta').textContent = 'Running…';
  $('#ctRunBtn').disabled = true;
  $('#ctStopBtn').hidden = false;

  try {
    const r = await CW.runInContainer({
      runId,
      title: `Sandbox (${$('#ctLang').value})`,
      language: $('#ctLang').value,
      code,
      image: $('#ctImage').value.trim() || 'python:3.12-slim',
      network: $('#ctNet').value,
      mountMode: $('#ctMount').value,
    });
    const combined = [r.stdout, r.stderr].filter(Boolean).join('\n').trim() || '(completed with no output)';
    $('#ctTerminal').textContent = combined;
    $('#ctRunMeta').textContent = `Exit ${r.exitCode} · ${(r.elapsedMs / 1000).toFixed(1)}s`;
    loadContainerHistory();
    loadFiles(S.cwd);
  } catch (e) {
    $('#ctTerminal').textContent = `Error: ${e.message}`;
    $('#ctRunMeta').textContent = 'Failed';
    toast(e.message, 4500);
  } finally {
    S.activeContainerRunId = null;
    $('#ctRunBtn').disabled = false;
    $('#ctStopBtn').hidden = true;
  }
}

async function loadContainerHistory() {
  try {
    const d = await CW.listContainerRuns();
    const list = $('#ctHistoryList');
    const runs = d.runs || [];
    list.innerHTML = runs.length ? '' : '<div class="muted-note">No container executions yet.</div>';
    for (const r of runs.slice(0, 15)) {
      const card = document.createElement('div');
      card.className = 'saved-card';
      card.innerHTML = `
        <div class="sc-row"><b>${esc(r.title || r.language)}</b><span class="ac-stat ${r.ok ? '' : 'err'}">${r.ok ? '✓ 0' : '✗ ' + r.exitCode}</span></div>
        <small>${esc(r.image)} · ${(r.elapsedMs / 1000).toFixed(1)}s · ${new Date(r.ts).toLocaleTimeString()}</small>`;
      card.onclick = () => {
        $('#ctLang').value = r.language || 'python';
        $('#ctImage').value = r.image || 'python:3.12-slim';
        $('#ctCodeInput').value = r.code || '';
        $('#ctTerminal').textContent = [r.stdout, r.stderr].filter(Boolean).join('\n').trim() || '(no output)';
        $('#ctRunMeta').textContent = `Exit ${r.exitCode} · ${(r.elapsedMs / 1000).toFixed(1)}s`;
      };
      list.appendChild(card);
    }
  } catch {}
}

// ---- Settings & Multi-Provider Modal
function syncProviderAuthUI(endpointType) {
  $('#authFields').style.display = endpointType === 'mxgpt' ? 'flex' : 'none';
  $('#apiKeyField').hidden = !(endpointType === 'openai' || endpointType === 'anthropic');
}

function renderProviderChips() {
  const wrap = $('#providerChips');
  wrap.innerHTML = '';
  for (const p of S.providerPresets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prov-chip' + (S.selectedPreset === p.id ? ' on' : '');
    btn.innerHTML = `${esc(p.label)}${p.badge ? ` <span class="prov-badge">${esc(p.badge)}</span>` : ''}`;
    btn.onclick = () => selectProviderPreset(p.id, true);
    wrap.appendChild(btn);
  }
}

function selectProviderPreset(presetId, fillFields = true) {
  const p = S.providerPresets.find((x) => x.id === presetId) || S.providerPresets[0];
  if (!p) return;
  S.selectedPreset = p.id;
  $('#providerHint').textContent = p.hint || '';
  if (fillFields) {
    $('#setEndpointType').value = p.endpointType;
    $('#setEndpointUrl').value = p.endpointUrl;
    if (p.fastModel) $('#setFastModel').value = p.fastModel;
    if (p.smartModel) $('#setSmartModel').value = p.smartModel;
  }
  syncProviderAuthUI($('#setEndpointType').value);
  renderProviderChips();
}

function renderFetchedModels(models) {
  const wrap = $('#fetchedModelsWrap');
  const list = $('#fetchedModelsList');
  if (!models || !models.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  list.innerHTML = '';
  for (const m of models.slice(0, 60)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fm-pill';
    btn.textContent = m.name;
    btn.onclick = () => {
      if (S.assignModelTarget === 'smart') {
        $('#setSmartModel').value = m.name;
        toast(`Smart model → ${m.name}`);
      } else if (S.assignModelTarget === 'copilot_b') {
        $('#setCopilotBModel').value = m.name;
        toast(`Copilot (B) model → ${m.name}`);
      } else {
        $('#setFastModel').value = m.name;
        toast(`Fast model → ${m.name}`);
      }
    };
    list.appendChild(btn);
  }
}

function setSettingsTab(tab) {
  $$('#settingsTabs button').forEach((b) => b.classList.toggle('active', b.dataset.stab === tab));
  $$('.stab-pane').forEach((p) => p.classList.toggle('active', p.dataset.spane === tab));
}

function openSettings(initialTab = 'providers') {
  const s = S.settings || {};
  S.selectedPreset = s.providerPreset || s.endpointType || 'mxgpt';
  $('#setEndpointType').value = s.endpointType || 'mxgpt';
  $('#setEndpointUrl').value = s.endpointUrl || 'https://max.fyreflysystems.de';
  $('#setUsername').value = s.username || '';
  $('#setPassword').value = '';
  $('#setPassword').placeholder = s.hasPassword ? '•••••••• (saved — leave blank to keep)' : 'Enter password';
  $('#setApiKey').value = '';
  $('#setApiKey').placeholder = s.hasApiKey ? '•••••••• (saved — leave blank to keep)' : 'sk-... (stored locally)';
  $('#setFastModel').value = s.fastModel || 'lfm3:latest';
  $('#setSmartModel').value = s.smartModel || 'inkling-2-mini:latest';
  $('#setCopilotBModel').value = s.copilotBModel || 'nemotron-3.5-lightning';
  // Tools tab
  $('#setToolWeb').checked = s.toolWebSearch !== false;
  $('#setToolOsFiles').checked = s.toolOsFiles !== false;
  $('#setToolContainer').checked = s.toolContainer !== false && s.containerEnabled !== false;
  $('#setToolGraph').checked = s.toolKnowledgeGraph !== false;
  $('#setToolGit').checked = s.toolGit !== false;
  $('#setToolSystem').checked = s.toolSystem !== false;
  $('#setToolCalc').checked = s.toolCalculator !== false;
  $('#setToolNotes').checked = s.toolNotes !== false;
  $('#setWebMaxResults').value = String(s.toolWebMaxResults || 5);
  $('#setWikiLang').value = s.toolWikiLang || 'en';
  $('#setWebFetchPages').checked = s.toolWebFetchPages !== false;
  $('#setWorkspace').value = s.workspace || '';
  $('#setAutoApprove').checked = !!s.autoApproveFileActions;
  // Container tab
  $('#setContainerRuntime').value = s.containerRuntime || 'auto';
  $('#setContainerImage').value = s.containerImage || 'python:3.12-slim';
  $('#setContainerNet').value = s.containerNetwork || 'none';
  $('#setContainerMount').value = s.containerMountMode || 'rw';
  $('#setContainerTimeout').value = String(s.containerTimeoutSec || 30);
  $('#setContainerMem').value = String(s.containerMemoryMb || 1024);
  $('#setAutoApproveContainer').checked = !!s.autoApproveContainerRuns;

  $('#fetchedModelsWrap').hidden = true;
  $('#testOut').hidden = true;
  selectProviderPreset(S.selectedPreset, false);
  setSettingsTab(initialTab);
  $('#settingsModal').hidden = false;
}

function collectSettingsForm() {
  const pw = $('#setPassword').value;
  const key = $('#setApiKey').value.trim();
  const containerOn = $('#setToolContainer').checked;
  return {
    endpointType: $('#setEndpointType').value,
    providerPreset: S.selectedPreset || $('#setEndpointType').value,
    endpointUrl: $('#setEndpointUrl').value.trim() || 'https://max.fyreflysystems.de',
    username: $('#setUsername').value.trim(),
    password: pw ? pw : '__KEEP__',
    apiKey: key ? key : '__KEEP__',
    fastModel: $('#setFastModel').value.trim() || 'lfm3:latest',
    smartModel: $('#setSmartModel').value.trim() || 'inkling-2-mini:latest',
    copilotBModel: $('#setCopilotBModel').value.trim() || 'nemotron-3.5-lightning',
    toolWebSearch: $('#setToolWeb').checked,
    toolWebFetchPages: $('#setWebFetchPages').checked,
    toolWebMaxResults: Math.max(2, Math.min(10, Number($('#setWebMaxResults').value) || 5)),
    toolWikiLang: $('#setWikiLang').value || 'en',
    toolOsFiles: $('#setToolOsFiles').checked,
    toolContainer: containerOn,
    containerEnabled: containerOn,
    toolKnowledgeGraph: $('#setToolGraph').checked,
    toolGit: $('#setToolGit').checked,
    toolSystem: $('#setToolSystem').checked,
    toolCalculator: $('#setToolCalc').checked,
    toolNotes: $('#setToolNotes').checked,
    workspace: $('#setWorkspace').value.trim(),
    autoApproveFileActions: $('#setAutoApprove').checked,
    containerRuntime: $('#setContainerRuntime').value || 'auto',
    containerImage: $('#setContainerImage').value.trim() || 'python:3.12-slim',
    containerNetwork: $('#setContainerNet').value,
    containerMountMode: $('#setContainerMount').value,
    containerTimeoutSec: Math.max(5, Math.min(180, Number($('#setContainerTimeout').value) || 30)),
    containerMemoryMb: Math.max(128, Math.min(8192, Number($('#setContainerMem').value) || 1024)),
    autoApproveContainerRuns: $('#setAutoApproveContainer').checked,
    signedIn: true,
  };
}

// ---- Gimel-style Built-in Updater
function fmtBytes(n) {
  if (!n) return '';
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function installKindLabel(kind) {
  if (kind === 'appimage') return 'Linux AppImage (auto-install & restart)';
  if (kind === 'win-portable') return 'Windows App (auto-install & restart)';
  if (kind === 'deb') return 'Linux .deb (pkexec install & restart)';
  if (kind === 'git') return 'Git Checkout (pull & restart)';
  return 'GitHub Release';
}

function updateSidebarUpdateBadge(info) {
  const btn = $('#openUpdatesBtn');
  const dot = $('#updDot');
  const ver = $('#appVersionBadge');
  if (!info) return;
  if (info.updateAvailable) {
    btn.classList.add('has-update');
    dot.hidden = false;
    $('#updBtnLabel').textContent = 'Update available';
    ver.textContent = `v${info.latestVersion}`;
  } else {
    btn.classList.remove('has-update');
    dot.hidden = true;
    $('#updBtnLabel').textContent = 'Updates';
    ver.textContent = `v${info.currentVersion || S.appInfo?.version || '1.3.1'}`;
  }
}

async function checkUpdatesQuiet() {
  try {
    const info = await CW.checkUpdate({ force: false });
    S.updateInfo = info;
    updateSidebarUpdateBadge(info);
    // Auto-install & restart on packaged releases when user enabled autoInstallUpdates
    const autoOn = S.settings?.autoInstallUpdates !== false;
    const isPackagedKind = info?.installKind === 'appimage' || info?.installKind === 'win-portable' || info?.installKind === 'deb';
    if (autoOn && info?.ok && info?.updateAvailable && info?.canAutoApply && isPackagedKind && !S.updating) {
      toast(`Update v${info.latestVersion} found — installing & restarting automatically…`, 4500);
      $('#updAutoInstallChk').checked = true;
      renderUpdateModal(info);
      $('#updatesModal').hidden = false;
      triggerInstallUpdate();
    }
  } catch {}
}

function renderUpdateModal(info) {
  const banner = $('#updBanner');
  $('#updCurVer').textContent = `v${info?.currentVersion || S.appInfo?.version || '—'}`;
  $('#updLatestVer').textContent = info?.ok ? `v${info.latestVersion}` : 'Unavailable';
  $('#updKind').textContent = installKindLabel(info?.installKind);
  $('#updAsset').textContent = info?.asset
    ? `${info.asset.name} (${fmtBytes(info.asset.size)})`
    : (info?.installKind === 'git' ? 'git pull --ff-only' : 'GitHub Releases');

  if (!info?.ok) {
    banner.className = 'upd-banner err';
    banner.textContent = info?.error || 'Could not reach GitHub Releases.';
  } else if (info.updateAvailable) {
    banner.className = 'upd-banner avail';
    banner.textContent = `New version available: ${info.releaseName || 'v' + info.latestVersion}`;
  } else {
    banner.className = 'upd-banner ok';
    banner.textContent = `You are up to date (v${info.currentVersion}).`;
  }

  const notesWrap = $('#updNotesWrap');
  if (info?.releaseNotes) {
    notesWrap.hidden = false;
    $('#updNotes').innerHTML = renderMd(info.releaseNotes);
  } else {
    notesWrap.hidden = true;
  }

  const installBtn = $('#updInstallBtn');
  installBtn.disabled = S.updating || !info?.ok || !info?.updateAvailable;
  installBtn.textContent = S.updating ? 'Installing & Restarting…' : 'Install & Restart';
}

function renderUpdateProgress(p) {
  $('#updProgressWrap').hidden = false;
  const pct = typeof p.percent === 'number' ? p.percent : 0;
  $('#updBarFill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  $('#updProgPct').textContent = `${pct}%`;
  if (p.phase === 'downloading') {
    const dl = p.total ? `${fmtBytes(p.downloaded)} / ${fmtBytes(p.total)}` : fmtBytes(p.downloaded);
    $('#updProgText').textContent = `Downloading update… (${dl})`;
  } else {
    $('#updProgText').textContent = p.message || p.phase || 'Updating…';
  }
}

async function runUpdateCheck(force = true) {
  const banner = $('#updBanner');
  banner.className = 'upd-banner';
  banner.textContent = 'Checking GitHub Releases (mxsp/mxgpt)…';
  $('#updCheckBtn').disabled = true;
  $('#updInstallBtn').disabled = true;
  try {
    const info = await CW.checkUpdate({ force });
    S.updateInfo = info;
    updateSidebarUpdateBadge(info);
    renderUpdateModal(info);
  } catch (e) {
    banner.className = 'upd-banner err';
    banner.textContent = `Check failed: ${e.message}`;
  } finally {
    $('#updCheckBtn').disabled = false;
  }
}

function openUpdatesModal() {
  $('#updProgressWrap').hidden = true;
  $('#updCmdHint').hidden = true;
  $('#updAutoInstallChk').checked = S.settings?.autoInstallUpdates !== false;
  $('#updatesModal').hidden = false;
  if (S.updateInfo) renderUpdateModal(S.updateInfo);
  runUpdateCheck(true);
}

async function triggerInstallUpdate() {
  if (S.updating) return;
  S.updating = true;
  $('#updInstallBtn').disabled = true;
  $('#updInstallBtn').textContent = 'Installing & Restarting…';
  $('#updCheckBtn').disabled = true;
  $('#updCmdHint').hidden = true;
  try {
    const res = await CW.applyUpdate();
    const banner = $('#updBanner');
    banner.className = 'upd-banner ok';
    banner.textContent = res.message || 'Update installed — restarting…';
    toast(res.message || 'Update installed — restarting…', 4500);
    if (res.commandHint) {
      $('#updCmdHint').hidden = false;
      $('#updCmdText').textContent = res.commandHint;
    }
  } catch (e) {
    const banner = $('#updBanner');
    banner.className = 'upd-banner err';
    banner.textContent = `Update failed: ${e.message}`;
    toast(e.message, 5000);
  } finally {
    S.updating = false;
    $('#updCheckBtn').disabled = false;
    $('#updInstallBtn').textContent = 'Install & Restart';
    $('#updInstallBtn').disabled = !S.updateInfo?.updateAvailable;
  }
}

async function doLogout() {
  const r = await CW.logout();
  S.settings = r.settings;
  $('#settingsModal').hidden = true;
  renderAccountUI();
  showLoginScreen();
  toast('Signed out');
}

// ---- Event Wiring
$('#collapseBtn').onclick = () => { $('#sidebar').classList.add('collapsed'); $('#expandBtn').hidden = false; };
$('#expandBtn').onclick = () => { $('#sidebar').classList.remove('collapsed'); $('#expandBtn').hidden = true; };
$('#newChatBtn').onclick = newChat;
$('#chatSearch').oninput = (e) => { S.chatSearch = e.target.value; renderChatList(); };
$('#themeBtn').onclick = toggleTheme;
$('#openSettingsBtn').onclick = openSettings;
$('#footProviderBtn').onclick = openSettings;
$('#footLoginBtn').onclick = showLoginScreen;
$('#logoutBtn').onclick = doLogout;
$('#settingsLogoutBtn').onclick = doLogout;
$('#openUpdatesBtn').onclick = openUpdatesModal;
$('#closeSettingsBtn').onclick = () => { $('#settingsModal').hidden = true; };
$('#closeUpdatesBtn').onclick = () => { if (!S.updating) $('#updatesModal').hidden = true; };

// Login screen wiring
$('#loginTabs').onclick = (e) => {
  const b = e.target.closest('button[data-ltab]');
  if (!b) return;
  const tab = b.dataset.ltab;
  $$('#loginTabs button').forEach((x) => x.classList.toggle('on', x.dataset.ltab === tab));
  $('#loginMxgptForm').hidden = tab !== 'mxgpt';
  $('#loginProviderForm').hidden = tab !== 'provider';
};
$('#loginPwEye').onclick = () => {
  const inp = $('#loginPw');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  inp.focus();
};
$('#lpKeyEye').onclick = () => {
  const inp = $('#lpKey');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  inp.focus();
};
$('#loginSkipBtn').onclick = () => { hideLoginScreen(); openPanel('files'); };

$('#loginMxgptForm').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#loginErr');
  const btn = $('#loginSubmitBtn');
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const r = await CW.login({
      endpointType: 'mxgpt',
      providerPreset: 'mxgpt',
      endpointUrl: $('#loginUrl').value.trim() || 'https://max.fyreflysystems.de',
      username: $('#loginUser').value.trim(),
      password: $('#loginPw').value,
      fastModel: 'lfm3:latest',
      smartModel: 'inkling-2-mini:latest',
    });
    S.settings = r.settings;
    renderAccountUI();
    hideLoginScreen();
    checkConnectionQuiet();
    toast(`Signed in to ${new URL(S.settings.endpointUrl).host}`);
  } catch (ex) {
    err.textContent = ex.message || 'Sign in failed';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Continue';
  }
};

$('#loginProviderForm').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#lpErr');
  const btn = $('#lpSubmitBtn');
  const preset = S.providerPresets.find((x) => x.id === S.loginPreset) || S.providerPresets[1];
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const r = await CW.login({
      endpointType: preset.endpointType,
      providerPreset: preset.id,
      endpointUrl: $('#lpUrl').value.trim() || preset.endpointUrl,
      apiKey: $('#lpKey').value.trim(),
      fastModel: $('#lpFast').value.trim() || preset.fastModel,
      smartModel: $('#lpSmart').value.trim() || preset.smartModel,
    });
    S.settings = r.settings;
    renderAccountUI();
    hideLoginScreen();
    checkConnectionQuiet();
    toast(`Connected to ${preset.label}`);
  } catch (ex) {
    err.textContent = ex.message || 'Connection failed';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect & Continue';
  }
};

// Topbar & Composer controls
$$('.top-actions .ghost-btn[data-panel]').forEach((b) => {
  b.onclick = () => openPanel(b.dataset.panel, true);
});
$('#panelClose').onclick = closePanel;
$('#wsTopPill').onclick = () => openPanel('files', false);
$('#webToggleBtn').onclick = async () => {
  S.toolWebSearch = !S.toolWebSearch;
  $('#webToggleBtn').classList.toggle('on', S.toolWebSearch);
  await CW.saveSettings({ toolWebSearch: S.toolWebSearch });
  toast(S.toolWebSearch ? 'Web Search enabled' : 'Web Search disabled');
};
$('#filesToggleBtn').onclick = async () => {
  S.toolOsFiles = !S.toolOsFiles;
  $('#filesToggleBtn').classList.toggle('on', S.toolOsFiles);
  await CW.saveSettings({ toolOsFiles: S.toolOsFiles });
  toast(S.toolOsFiles ? 'OS File Access enabled' : 'OS File Access disabled');
};
$('#containerToggleBtn').onclick = async () => {
  S.containerEnabled = !S.containerEnabled;
  $('#containerToggleBtn').classList.toggle('on', S.containerEnabled);
  await CW.saveSettings({ toolContainer: S.containerEnabled, containerEnabled: S.containerEnabled });
  toast(S.containerEnabled ? 'Container code execution enabled' : 'Container code execution paused');
};

// Knowledge Graph Controls
$('#graphBuildBtn').onclick = buildAndRenderGraph;
$('#graphFitBtn').onclick = () => S.graphView?.fitToView();
$('#graphZoomInBtn').onclick = () => S.graphView?.zoomBy(1.22);
$('#graphZoomOutBtn').onclick = () => S.graphView?.zoomBy(1 / 1.22);
$('#graphExpandBtn').onclick = () => {
  S.graphExpanded = !S.graphExpanded;
  $('#panel').classList.toggle('graph-expanded', S.graphExpanded);
  $('#graphExpandBtn').textContent = S.graphExpanded ? 'Shrink' : 'Expand';
  setTimeout(() => { S.graphView?.resize(); S.graphView?.fitToView(); }, 80);
};
$('#graphSearchInput').oninput = (e) => S.graphView?.setSearch(e.target.value);
$('#graphFilters').onclick = (e) => {
  const b = e.target.closest('button[data-kind]');
  if (!b) return;
  const k = b.dataset.kind;
  if (S.graphFilters.has(k)) S.graphFilters.delete(k);
  else S.graphFilters.add(k);
  b.classList.toggle('on', S.graphFilters.has(k));
  S.graphView?.setFilters(S.graphFilters);
};
$('#graphAiSummaryBtn').onclick = async () => {
  const box = $('#graphAiBox');
  box.hidden = false;
  box.innerHTML = 'Generating AI architectural summary…';
  $('#graphAiSummaryBtn').disabled = true;
  try {
    const r = await CW.summarizeGraph();
    box.innerHTML = renderMd(r.summary || 'No summary generated.');
  } catch (e) {
    box.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
  } finally {
    $('#graphAiSummaryBtn').disabled = false;
  }
};

// Container Sandbox Controls
$('#ctRefreshBtn').onclick = () => loadContainerStatus(true);
$('#ctLang').onchange = () => {
  const l = $('#ctLang').value;
  if (l === 'python') $('#ctImage').value = 'python:3.12-slim';
  else if (l === 'javascript') $('#ctImage').value = 'node:22-alpine';
  else if (l === 'bash') $('#ctImage').value = 'ubuntu:24.04';
};
$('#ctRunBtn').onclick = runSandboxContainer;
$('#ctStopBtn').onclick = () => {
  if (S.activeContainerRunId) CW.stopContainerRun(S.activeContainerRunId);
};
$('#ctSendOutBtn').onclick = () => {
  const out = ($('#ctTerminal').textContent || '').trim();
  if (!out || out.startsWith('Container output will stream')) {
    toast('Run something in the container first');
    return;
  }
  sendPrompt(`Analyze this container execution output from my workspace:\n\`\`\`\n${out.slice(0, 6000)}\n\`\`\``);
};
$('#attachFileBtn').onclick = async () => {
  const res = await CW.pickFiles();
  if (res.canceled) return;
  if (res.switchedWorkspace) {
    S.settings = res.settings;
    S.cwd = '';
    renderWorkspaceUI();
    loadFiles('');
  }
  for (const p of res.pinned || []) {
    if (!S.pinnedFiles.includes(p)) S.pinnedFiles.push(p);
  }
  renderPinned();
  toast(`Attached ${res.pinned.length} file${res.pinned.length > 1 ? 's' : ''}`);
};

$('#modeSeg').onclick = (e) => { const b = e.target.closest('button[data-mode]'); if (b) setMode(b.dataset.mode); };
$('#thinkSeg').onclick = (e) => { const b = e.target.closest('button[data-think]'); if (b) setThink(b.dataset.think); };
$('#sendBtn').onclick = () => sendPrompt();
$('#promptInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
});
$('#promptInput').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
});
$$('.starter').forEach((b) => {
  b.onclick = () => { setMode('copilot'); sendPrompt(b.dataset.prompt); };
});

// OS Files & Editor wiring
$('#osUpBtn').onclick = () => {
  if (S.cwd) {
    const parent = S.cwd.includes('/') ? S.cwd.slice(0, S.cwd.lastIndexOf('/')) : '';
    loadFiles(parent);
  } else {
    navigateOsTo('..');
  }
};
$('#osPathInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    navigateOsTo($('#osPathInput').value.trim());
  }
});
$('#wsPickBtn').onclick = pickWorkspaceFolder;
$('#refreshFilesBtn').onclick = () => loadFiles(S.cwd);
$('#fileSearchBtn').onclick = searchLocalFiles;
$('#fileSearchClearBtn').onclick = () => { $('#fileSearchInput').value = ''; loadFiles(S.cwd); };
$('#fileSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchLocalFiles(); });
$('#newFileBtn').onclick = createNewFile;
$('#newFolderBtn').onclick = createNewFolder;
$('#auditWsBtn').onclick = () => {
  setMode('copilot');
  sendPrompt(`Audit the folder "${S.cwd || '/'}" in my workspace and propose a clean organization plan using file-actions.`);
};

$('#edBackBtn').onclick = () => { closeFileEditor(); loadFiles(S.cwd); };
$('#edTextarea').oninput = updateEditorStats;
$('#edSaveBtn').onclick = saveEditorFile;
$('#edPinBtn').onclick = () => { if (S.editor) togglePin(S.editor.path); };
$('#edRenameBtn').onclick = () => { if (S.editor) renameItem(S.editor.path, S.editor.name); };
$('#edOpenOsBtn').onclick = () => { if (S.editor) CW.openFile(S.editor.path).catch((e) => toast(e.message)); };
$('#edRevealBtn').onclick = () => { if (S.editor) CW.revealFile(S.editor.path); };
$('#edAskAiBtn').onclick = () => {
  if (!S.editor) return;
  if (!S.pinnedFiles.includes(S.editor.path)) {
    S.pinnedFiles.push(S.editor.path);
    renderPinned();
    updateEditorPinBtn();
  }
  const inp = $('#promptInput');
  inp.value = `Review and help me improve "${S.editor.path}" (propose edits via file-actions if needed): `;
  inp.focus();
};

// Notes & Quick Local Tools / Research / Undo wiring
$('#saveNoteBtn').onclick = async () => {
  const title = $('#noteTitleInput').value.trim();
  const content = $('#noteContentInput').value.trim();
  if (!title && !content) { toast('Write a note title or content first'); return; }
  await CW.saveNote({
    title: title || content.slice(0, 48),
    tags: $('#noteTagsInput').value,
    content,
  });
  $('#noteTitleInput').value = '';
  $('#noteTagsInput').value = '';
  $('#noteContentInput').value = '';
  loadNotes();
  toast('Saved to Copilot memory');
};

$('#quickGitBtn').onclick = async () => {
  const out = $('#quickToolOut');
  out.hidden = false; out.textContent = 'Running git inspect…';
  try {
    const r = await CW.gitInspect('status');
    out.textContent = r.text;
  } catch (e) { out.textContent = e.message; }
};

$('#quickSysBtn').onclick = async () => {
  const out = $('#quickToolOut');
  out.hidden = false; out.textContent = 'Inspecting local system & dev runtimes…';
  try {
    const r = await CW.systemInfo();
    out.textContent = r.text;
  } catch (e) { out.textContent = e.message; }
};

$('#quickCalcBtn').onclick = async () => {
  const expr = await askText({
    title: 'Sandboxed JS Evaluator',
    label: 'JavaScript expression or snippet',
    placeholder: '(1024 * 64) / 3.14159',
  });
  if (!expr) return;
  const out = $('#quickToolOut');
  out.hidden = false;
  try {
    const r = await CW.calcJs(expr);
    out.textContent = r.text;
  } catch (e) { out.textContent = `Error: ${e.message}`; }
};

$('#resSearchBtn').onclick = quickResearch;
$('#resSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') quickResearch(); });
$('#refreshUndoBtn').onclick = loadUndo;

// Settings Tabs & Model Focus
$('#settingsTabs').onclick = (e) => {
  const b = e.target.closest('button[data-stab]');
  if (b) setSettingsTab(b.dataset.stab);
};
$('#setCopilotBModel').addEventListener('focus', () => {
  S.assignModelTarget = 'copilot_b';
  $$('#fmTarget button').forEach((x) => x.classList.toggle('on', x.dataset.target === 'copilot_b'));
});

// Settings & Providers Modal wiring
$('#resetDefaultProviderBtn').onclick = () => {
  selectProviderPreset('mxgpt', true);
  toast('Reset to default: https://max.fyreflysystems.de');
};
$('#fmTarget').onclick = (e) => {
  const b = e.target.closest('button[data-target]');
  if (!b) return;
  S.assignModelTarget = b.dataset.target;
  $$('#fmTarget button').forEach((x) => x.classList.toggle('on', x.dataset.target === S.assignModelTarget));
};
$('#setFastModel').addEventListener('focus', () => {
  S.assignModelTarget = 'fast';
  $$('#fmTarget button').forEach((x) => x.classList.toggle('on', x.dataset.target === 'fast'));
});
$('#setSmartModel').addEventListener('focus', () => {
  S.assignModelTarget = 'smart';
  $$('#fmTarget button').forEach((x) => x.classList.toggle('on', x.dataset.target === 'smart'));
});
$('#setEndpointType').onchange = () => {
  const t = $('#setEndpointType').value;
  syncProviderAuthUI(t);
  const matching = S.providerPresets.find((p) => p.endpointType === t);
  if (matching) {
    S.selectedPreset = matching.id;
    $('#providerHint').textContent = matching.hint || '';
    renderProviderChips();
  }
  if (t === 'mxgpt' && !$('#setEndpointUrl').value.includes('fyrefly')) $('#setEndpointUrl').value = 'https://max.fyreflysystems.de';
  else if (t === 'ollama' && $('#setEndpointUrl').value.includes('fyrefly')) $('#setEndpointUrl').value = 'http://127.0.0.1:11434';
  else if (t === 'anthropic' && !$('#setEndpointUrl').value.includes('anthropic')) $('#setEndpointUrl').value = 'https://api.anthropic.com';
  else if (t === 'openai' && ($('#setEndpointUrl').value.includes('fyrefly') || $('#setEndpointUrl').value.includes('11434'))) $('#setEndpointUrl').value = 'https://api.openai.com/v1';
};
$('#testConnBtn').onclick = async () => {
  const out = $('#testOut');
  out.hidden = false; out.className = 'test-out'; out.textContent = 'Testing connection & fetching models…';
  try {
    const r = await CW.testEndpoint(collectSettingsForm());
    out.className = 'test-out ok';
    out.textContent = `Connected to ${r.endpointUrl} (${r.latencyMs}ms) · ${r.models.length} model${r.models.length === 1 ? '' : 's'} available`;
    renderFetchedModels(r.models);
  } catch (e) {
    out.className = 'test-out err';
    out.textContent = `Connection failed: ${e.message}`;
    $('#fetchedModelsWrap').hidden = true;
  }
};
$('#saveSettingsBtn').onclick = async () => {
  try {
    const d = await CW.saveSettings(collectSettingsForm());
    S.settings = d.settings;
    S.cwd = '';
    S.toolWebSearch = S.settings.toolWebSearch !== false;
    S.toolOsFiles = S.settings.toolOsFiles !== false;
    S.containerEnabled = S.settings.toolContainer !== false && S.settings.containerEnabled !== false;
    $('#webToggleBtn').classList.toggle('on', S.toolWebSearch);
    $('#filesToggleBtn').classList.toggle('on', S.toolOsFiles);
    $('#containerToggleBtn').classList.toggle('on', S.containerEnabled);
    $('#ctImage').value = S.settings.containerImage || 'python:3.12-slim';
    $('#ctNet').value = S.settings.containerNetwork || 'none';
    $('#ctMount').value = S.settings.containerMountMode || 'rw';
    $('#settingsModal').hidden = true;
    hideLoginScreen();
    renderAccountUI();
    renderWorkspaceUI();
    loadFiles('');
    checkConnectionQuiet();
    toast('Settings saved');
  } catch (e) { toast(e.message); }
};

// Updater Modal wiring
$('#updCheckBtn').onclick = () => runUpdateCheck(true);
$('#updOpenGithubBtn').onclick = () => CW.openExternal(S.updateInfo?.releaseUrl || 'https://github.com/mxsp/mxgpt/releases');
$('#updCopyCmdBtn').onclick = () => { navigator.clipboard?.writeText($('#updCmdText').textContent || ''); toast('Command copied'); };
$('#updAutoInstallChk').onchange = async () => {
  const on = $('#updAutoInstallChk').checked;
  const r = await CW.saveSettings({ autoInstallUpdates: on });
  S.settings = r.settings;
  toast(on ? 'Auto-install & restart enabled' : 'Manual update install selected');
};
$('#updInstallBtn').onclick = () => triggerInstallUpdate();

boot().catch((e) => toast(`Startup error: ${e.message}`, 5000));
