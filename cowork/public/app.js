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
  graphTreeEdges: true,
  graphFilters: new Set(['code', 'doc', 'config', 'test', 'style', 'data', 'file', 'folder', 'package']),
  projects: [],
  activeProject: null,
  editingProjectId: null,
  artifacts: new Map(),
  activeArtifactId: null,
  artifactTab: 'preview',
  artifactUserPickedTab: false,
  savedProviders: [],
  attachedImages: [], // { id, name, mimeType, data }
  piiShield: false,
  workflows: [],
  slashIndex: 0,
  tasks: [],
  quickClipText: '',
  lastCompare: null,
  editorTable: null,
  editorTableMode: false,
  activeStreams: new Map(), // streamId -> per-chat live stream state (supports concurrent multi-model runs!)
  viewingTempStreamId: null,
  expandedProjects: new Set(),
  automations: [],
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

// ---- Artifact Extraction & Display Canvas (identical to mx-GPT browser app)
const ARTIFACT_LANGS = new Set(['html', 'htm', 'svg', 'jsx', 'tsx', 'react', 'mermaid']);

function artifactKindLabel(lang) {
  const l = String(lang || '').toLowerCase();
  if (l === 'svg') return 'SVG Graphic';
  if (l === 'mermaid') return 'Mermaid Diagram';
  if (l === 'jsx' || l === 'tsx' || l === 'react') return 'React Component';
  return 'Interactive HTML';
}

function deriveArtifactTitle(lang, code, explicitTitle = '') {
  if (explicitTitle && explicitTitle.trim()) return explicitTitle.trim().slice(0, 72);
  const src = String(code || '');
  const l = String(lang || '').toLowerCase();
  const commentTitle = src.match(/(?:<!--\s*title:\s*([^-\n]+?)-->|\/\/\s*title:\s*([^\n]+))/i);
  if (commentTitle) return (commentTitle[1] || commentTitle[2] || '').trim().slice(0, 72);
  if (l === 'html' || l === 'htm') {
    const tm = src.match(/<title[^>]*>([^<]{2,80})<\/title>/i);
    if (tm) return tm[1].trim();
    const hm = src.match(/<h[12][^>]*>([^<]{2,80})<\/h[12]>/i);
    if (hm) return hm[1].trim();
  }
  if (l === 'jsx' || l === 'tsx' || l === 'react') {
    const fm = src.match(/(?:export\s+default\s+)?(?:function|const|class)\s+([A-Z][A-Za-z0-9_]{1,40})/);
    if (fm) return fm[1];
  }
  if (l === 'mermaid') {
    const mm = src.match(/^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|mindmap|timeline)/im);
    if (mm) return `Diagram (${mm[1]})`;
  }
  return artifactKindLabel(l);
}

function isArtifactCandidate(lang, code, streaming) {
  const l = String(lang || '').toLowerCase();
  if (!ARTIFACT_LANGS.has(l)) return false;
  const trimmed = String(code || '').trim();
  if (l === 'html' || l === 'htm') {
    if (!trimmed.includes('<')) return false;
    return streaming ? trimmed.length >= 20 : trimmed.length >= 40;
  }
  return streaming ? trimmed.length >= 12 : trimmed.length >= 20;
}

function extractArtifactsFromText(raw, keyPrefix = 'msg', isStreaming = false) {
  const src = String(raw || '');
  const list = [];
  const closedRe = /```([a-z0-9_-]+)([^\n]*)\r?\n([\s\S]*?)```/gi;
  let m;
  let idx = 0;
  let lastIndex = 0;

  while ((m = closedRe.exec(src)) !== null) {
    lastIndex = closedRe.lastIndex;
    const lang = (m[1] || '').toLowerCase();
    const info = (m[2] || '').trim();
    const code = (m[3] || '').trimEnd();
    if (!isArtifactCandidate(lang, code, false)) continue;
    const titleMatch = info.match(/title=["']([^"']+)["']/i);
    const id = `${keyPrefix}_art_${idx++}`;
    list.push({
      id,
      lang,
      title: deriveArtifactTitle(lang, code, titleMatch?.[1] || ''),
      code,
      streaming: false,
      start: m.index,
      end: closedRe.lastIndex,
    });
  }

  // Also detect an in-progress (unclosed) artifact fence while streaming
  if (isStreaming) {
    const tail = src.slice(lastIndex);
    const openRe = /```([a-z0-9_-]+)([^\n]*)\r?\n([\s\S]*)$/i;
    const om = tail.match(openRe);
    if (om) {
      const lang = (om[1] || '').toLowerCase();
      const info = (om[2] || '').trim();
      const code = om[3] || '';
      if (ARTIFACT_LANGS.has(lang) && isArtifactCandidate(lang, code, true)) {
        const titleMatch = info.match(/title=["']([^"']+)["']/i);
        const id = `${keyPrefix}_art_${idx++}`;
        list.push({
          id,
          lang,
          title: deriveArtifactTitle(lang, code, titleMatch?.[1] || ''),
          code,
          streaming: true,
          start: lastIndex + om.index,
          end: src.length,
        });
      }
    }
  }
  return list;
}

function renderArtifactCardHtml(art) {
  const lines = (art.code || '').split('\n').length;
  const active = S.panelOpen && S.panelTab === 'artifact' && S.activeArtifactId === art.id;
  const meta = art.streaming
    ? `Building ${artifactKindLabel(art.lang)} · ${lines} lines…`
    : `${artifactKindLabel(art.lang)} · ${lines} lines · click to open`;
  const cta = art.streaming ? 'Live' : (active ? 'Open' : 'Preview');
  return `<button type="button" class="art-card${art.streaming ? ' building' : ''}" data-art-id="${esc(art.id)}">
    <span class="art-icon"><svg><use href="#i-code"/></svg></span>
    <span class="art-info">
      <span class="art-title">${esc(art.title)}</span>
      <span class="art-meta">${esc(meta)}</span>
    </span>
    <span class="art-open">${esc(cta)}</span>
  </button>`;
}

function buildArtifactHtml(art) {
  if (!art) return '';
  const lang = String(art.lang || 'html').toLowerCase();
  const code = String(art.code || '');
  const dark = document.documentElement.dataset.theme === 'dark';

  if (lang === 'html' || lang === 'htm') {
    if (/<!doctype|<html[\s>]/i.test(code)) return code;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1a1917; background: #ffffff; line-height: 1.5; }
</style>
</head>
<body>${code}</body>
</html>`;
  }

  if (lang === 'svg') {
    return `<!doctype html>
<html>
<head><meta charset="utf-8" /><style>
  html, body { margin: 0; width: 100%; height: 100%; display: grid; place-items: center; background: ${dark ? '#1c1b19' : '#faf9f5'}; overflow: auto; padding: 16px; box-sizing: border-box; }
  svg { max-width: 100%; max-height: 100%; height: auto; }
</style></head>
<body>${code}</body>
</html>`;
  }

  if (lang === 'mermaid') {
    const safeSrc = code.replace(/<\/script>/gi, '<\\/script>');
    return `<!doctype html>
<html>
<head><meta charset="utf-8" /><style>
  html, body { margin: 0; min-height: 100%; display: grid; place-items: center; background: ${dark ? '#1c1b19' : '#ffffff'}; color: ${dark ? '#f2f0e9' : '#1c1b19'}; font-family: system-ui, sans-serif; padding: 20px; box-sizing: border-box; }
  #diagram { max-width: 100%; }
  #fallback { display: none; white-space: pre-wrap; font-family: monospace; font-size: 12px; padding: 14px; border-radius: 10px; background: rgba(128,128,128,.12); max-width: 92vw; overflow: auto; }
</style></head>
<body>
<div id="diagram"></div>
<pre id="fallback"></pre>
<script type="module">
  const src = ${JSON.stringify(safeSrc)};
  const fb = document.getElementById('fallback');
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
    const mermaid = mod.default;
    mermaid.initialize({ startOnLoad: false, theme: ${JSON.stringify(dark ? 'dark' : 'default')}, securityLevel: 'loose' });
    const { svg } = await mermaid.render('mxgpt_mmd', src);
    document.getElementById('diagram').innerHTML = svg;
  } catch (err) {
    fb.style.display = 'block';
    fb.textContent = 'Mermaid preview note: ' + (err?.message || err) + '\\n\\n' + src;
  }
</script>
</body>
</html>`;
  }

  // React / JSX / TSX
  const transformed = code
    .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?/g, '')
    .replace(/export\s+default\s+function\s+([A-Za-z0-9_]+)/, 'function $1')
    .replace(/export\s+default\s+class\s+([A-Za-z0-9_]+)/, 'class $1')
    .replace(/export\s+default\s+/, 'const __DefaultExport = ');
  const fnMatch = code.match(/export\s+default\s+(?:function|class)\s+([A-Za-z0-9_]+)/)
    || code.match(/(?:function|const|class)\s+(App|Component|Dashboard|Chart|Demo|Main)\b/);
  const mountName = fnMatch ? fnMatch[1] : '__DefaultExport';
  const safeJsx = transformed.replace(/<\/script>/gi, '<\\/script>');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js" crossorigin></script>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; padding: 18px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #ffffff; color: #1a1917; }
  #err { display: none; margin: 12px; padding: 12px; border-radius: 8px; background: #fef2f2; color: #b91c1c; font-family: monospace; font-size: 12px; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="root"></div>
<pre id="err"></pre>
<script>
  window.onerror = function(msg) {
    var e = document.getElementById('err');
    e.style.display = 'block';
    e.textContent = String(msg);
  };
</script>
<script type="text/babel" data-presets="react,typescript">
  const { useState, useEffect, useMemo, useRef, useCallback, useReducer, Fragment } = React;
  try {
    ${safeJsx}
    const Target = typeof ${mountName} !== 'undefined' ? ${mountName} : (typeof App !== 'undefined' ? App : null);
    if (Target) {
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Target));
    } else {
      throw new Error('Could not find default React component (export default function App() { ... })');
    }
  } catch (err) {
    const e = document.getElementById('err');
    e.style.display = 'block';
    e.textContent = err && err.stack ? err.stack : String(err);
  }
</script>
</body>
</html>`;
}

function renderArtifactPane() {
  const art = S.activeArtifactId ? S.artifacts.get(S.activeArtifactId) : null;
  const empty = $('#artEmpty');
  const frame = $('#artFrame');
  const codeWrap = $('#artCodeWrap');
  const codeEl = $('#artCodeEl');
  const metaRight = $('#artMetaRight');

  $$('#artTabs button').forEach((b) => b.classList.toggle('active', b.dataset.arttab === S.artifactTab));

  if (!art) {
    empty.hidden = false;
    frame.hidden = true;
    codeWrap.hidden = true;
    metaRight.innerHTML = '';
    if (S.panelTab === 'artifact') $('#panelTitle').textContent = 'Artifact';
    return;
  }

  empty.hidden = true;
  if (S.panelTab === 'artifact') $('#panelTitle').textContent = art.title || 'Artifact';
  const lineCount = (art.code || '').split('\n').length;
  metaRight.innerHTML = art.streaming
    ? `<span class="art-live-pill"><i></i>Building · ${lineCount} lines</span>`
    : `<span>${esc(art.lang.toUpperCase())} · ${lineCount} lines</span>`;

  if (S.artifactTab === 'code' || art.streaming) {
    frame.hidden = true;
    codeWrap.hidden = false;
    const stick = isNearBottom(codeWrap, 90);
    codeEl.textContent = art.code || '';
    if (art.streaming && stick) codeWrap.scrollTop = codeWrap.scrollHeight;
  } else {
    codeWrap.hidden = true;
    frame.hidden = false;
    const doc = buildArtifactHtml(art);
    if (frame.dataset.renderedId !== art.id || frame.dataset.renderedLen !== String(art.code.length)) {
      frame.dataset.renderedId = art.id;
      frame.dataset.renderedLen = String(art.code.length);
      frame.srcdoc = doc;
    }
  }
}

function openArtifact(art, preferredTab = null, { isAuto = false } = {}) {
  if (!art) return;
  S.artifacts.set(art.id, art);
  S.activeArtifactId = art.id;
  if (preferredTab) S.artifactTab = preferredTab;
  else S.artifactTab = art.streaming ? 'code' : 'preview';
  if (!isAuto) S.artifactUserPickedTab = false;
  openPanel('artifact', false);
  renderArtifactPane();
}

// Lightweight safe Markdown renderer (hides raw tool JSON blocks & replaces Artifact blocks with live cards)
function renderMd(raw, opts = {}) {
  const { msgKey = '', isStreaming = false } = opts;
  let src = String(raw || '')
    .replace(/```email-draft[\s\S]*?```/gi, '')
    .replace(/```file-actions[\s\S]*?```/gi, '')
    .replace(/```code-run[\s\S]*?```/gi, '')
    .replace(/```memory-save[\s\S]*?```/gi, '')
    .replace(/```action-items[\s\S]*?```/gi, '')
    .trim();
  if (!src) return '';

  const blocks = [];
  if (msgKey) {
    const arts = extractArtifactsFromText(src, msgKey, isStreaming);
    if (arts.length) {
      // Replace from back to front so offsets stay exact
      for (let i = arts.length - 1; i >= 0; i--) {
        const art = arts[i];
        S.artifacts.set(art.id, art);
        const idx = blocks.length;
        blocks.push(renderArtifactCardHtml(art));
        src = src.slice(0, art.start) + `\n\x00BLK${idx}\x00\n` + src.slice(art.end);
      }
    }
  }

  src = src.replace(/```([a-z0-9_-]*)[^\n]*\n([\s\S]*?)```/gi, (_, lang, code) => {
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
  const agent = (S.settings?.agentModel || S.settings?.fastModel || 'lfm3:latest').replace(/:latest$/, '');
  const smart = (S.settings?.smartModel || 'inkling-2-mini:latest').replace(/:latest$/, '');
  const copB = (S.settings?.copilotBModel || 'nemotron-3.5-lightning').replace(/:latest$/, '');
  if (m === 'fast') return `Fast: ${fast} direct`;
  if (m === 'smart') return `Smart: ${smart} direct`;
  if (m === 'copilot_b') return `Copilot (B): ${copB} orchestrates · ${agent} workers & local tools`;
  return `Copilot: ${smart} orchestrates · ${agent} workers & local tools`;
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
  artifact: { title: 'Artifact', icon: '#i-code' },
  files: { title: 'OS Files & Editor', icon: '#i-folder' },
  graph: { title: 'Project Knowledge Graph', icon: '#i-graph' },
  container: { title: 'Container Sandbox', icon: '#i-box' },
  notes: { title: 'Tasks, Notes & Tools', icon: '#i-book' },
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

  if (tab === 'artifact') renderArtifactPane();
  if (tab === 'files' && !S.editor) loadFiles(S.cwd);
  if (tab === 'graph') ensureGraphLoaded();
  if (tab === 'container') { loadContainerStatus(false); loadContainerHistory(); }
  if (tab === 'notes') { loadTasks(); loadAutomations(); loadNotes(); }
  if (tab === 'research') { loadKbStats(); loadBriefs(); }
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
  const [info, data, prov, projData] = await Promise.all([
    CW.appInfo(),
    CW.getSettings(),
    CW.getProviderPresets(),
    CW.listProjects(),
  ]);
  S.appInfo = info;
  S.settings = data.settings;
  S.providerPresets = prov?.presets || [];
  S.quickFolders = data.quickFolders || [];
  S.projects = projData?.projects || [];
  S.activeProject = projData?.activeProject || null;

  $('#appVersionBadge').textContent = `v${info.version || '1.6.0'}`;
  applyThemeUI(S.settings.theme || 'light');
  setMode(S.settings.defaultMode || 'copilot');
  setThink(S.settings.think || 'low');
  S.toolWebSearch = S.settings.toolWebSearch !== false;
  S.toolOsFiles = S.settings.toolOsFiles !== false;
  S.containerEnabled = S.settings.toolContainer !== false && S.settings.containerEnabled !== false;
  S.piiShield = Boolean(S.settings.piiShieldEnabled);
  $('#webToggleBtn').classList.toggle('on', S.toolWebSearch);
  $('#filesToggleBtn').classList.toggle('on', S.toolOsFiles);
  $('#containerToggleBtn').classList.toggle('on', S.containerEnabled);
  $('#shieldToggleBtn').classList.toggle('on', S.piiShield);
  $('#ctImage').value = S.settings.containerImage || 'python:3.12-slim';
  $('#ctNet').value = S.settings.containerNetwork || 'none';
  $('#ctMount').value = S.settings.containerMountMode || 'rw';
  renderAccountUI();
  renderProjectsList();
  renderWorkspaceUI();
  renderAutoAcceptPill();

  if (shouldShowLogin()) {
    showLoginScreen();
  }

  await Promise.all([loadChats(), loadFiles(''), loadNotes(), loadTasks(), loadWorkflows(), loadAutomations(), loadKbStats(), loadBriefs(), loadUndo()]);
  checkConnectionQuiet();
  checkUpdatesQuiet();
  loadContainerStatus(false);

  // Single persistent global Cowork stream router (allows multiple chats & models to run simultaneously!)
  CW.onCoworkEvent((pkt) => handleGlobalCoworkEvent(pkt));
  CW.onAutomationEvent((info) => {
    loadAutomations();
    loadBriefs();
    if (info?.type === 'ran') toast(`Automation finished: ${info.automation?.name}`);
    else if (info?.type === 'error') toast(`Automation failed: ${info.error}`, 4500);
  });
  CW.onKbProgress((p) => {
    const el = $('#kbStatus');
    if (el) el.textContent = `Indexing ${p.current}/${p.total}: ${p.file}`;
  });
  $('#ctExecTarget').value = S.settings.codeExecutionTarget || 'container';
  syncCodeExecTargetUI();

  CW.onUpdateProgress((p) => renderUpdateProgress(p));
  CW.onContainerOutput((ev) => handleContainerOutputChunk(ev));
  CW.onGraphProgress((p) => {
    const pill = $('#graphMappingPill');
    const txt = $('#graphMappingTxt');
    if (p.phase === 'done') {
      pill.hidden = true;
    } else {
      pill.hidden = false;
      txt.textContent = p.message || 'Mapping graph…';
    }
  });

  // If an active project has Auto-Map enabled and no recent graph, map quietly with Fast model
  if (S.activeProject?.autoMapGraph && !shouldShowLogin()) {
    const cached = await CW.getCachedGraph(S.activeProject.id).catch(() => ({ graph: null }));
    if (cached?.graph) {
      S.graphData = cached.graph;
    } else {
      triggerBackgroundGraphMap(S.activeProject);
    }
  }
  CW.onMenuAction(({ action, payload }) => {
    if (action === 'new-task') newChat();
    else if (action === 'pick-folder') pickWorkspaceFolder();
    else if (action === 'open-settings') openSettings();
    else if (action === 'open-updates') openUpdatesModal();
    else if (action === 'open-compare') openCompareModal();
    else if (action === 'quick-ask-clipboard') showQuickClipBar(payload?.text || '');
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

// ---- First-Class Projects & Per-Project Workspace Controls
function renderAutoAcceptPill() {
  const on = S.activeProject
    ? Boolean(S.activeProject.autoAcceptEdits)
    : Boolean(S.settings?.autoApproveFileActions);
  const pill = $('#autoAcceptTopPill');
  pill.classList.toggle('on', on);
  pill.textContent = on ? 'Auto-Edit: ON' : 'Auto-Edit: Off';
}

function isChatStreaming(chatId) {
  if (!chatId) return false;
  for (const st of S.activeStreams.values()) {
    if (st.chatId === chatId) return true;
  }
  return false;
}

function getStreamForCurrentView() {
  if (S.chat?.id) {
    for (const st of S.activeStreams.values()) {
      if (st.chatId === S.chat.id) return st;
    }
  }
  if (S.viewingTempStreamId) {
    return S.activeStreams.get(S.viewingTempStreamId) || null;
  }
  return null;
}

function updateSendButtonState() {
  const curStream = getStreamForCurrentView();
  const busy = Boolean(curStream);
  $('#sendBtn').classList.toggle('stop', busy);
  $('#sendIcon use').setAttribute('href', busy ? '#i-stop' : '#i-send');
  $('#sendBtn').title = busy ? 'Stop generating in this chat' : 'Send (Enter)';
}

function createChatRowEl(c) {
  const row = document.createElement('div');
  const active = S.chat?.id === c.id;
  const live = isChatStreaming(c.id);
  row.className = 'chat-item' + (active ? ' active' : '');
  row.draggable = true;
  row.dataset.chatId = c.id;
  row.innerHTML = `${live ? '<span class="chat-live-dot" title="Generating…"></span>' : ''}<span class="ci-title">${esc(c.title)}</span><button class="ci-del" title="Delete chat"><svg><use href="#i-trash"/></svg></button>`;

  row.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-mxcw-chat', c.id);
    e.dataTransfer.setData('text/plain', c.id);
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    $$('.drag-over').forEach((x) => x.classList.remove('drag-over'));
  });
  row.onclick = (e) => {
    if (e.target.closest('.ci-del')) return;
    openChat(c.id);
  };
  row.querySelector('.ci-del').onclick = async (e) => {
    e.stopPropagation();
    if (isChatStreaming(c.id)) CW.stopCowork(c.id).catch(() => {});
    await CW.deleteChat(c.id);
    if (S.chat?.id === c.id) { S.chat = null; S.messages = []; renderMessages(); updateSendButtonState(); }
    loadChats();
  };
  return row;
}

function renderProjectsList() {
  const list = $('#projectsList');
  list.innerHTML = '';
  const q = S.chatSearch.trim().toLowerCase();
  if (S.activeProject?.id) S.expandedProjects.add(S.activeProject.id);

  if (!S.projects.length) {
    list.innerHTML = '<div class="proj-empty">Click <b>+ Add</b> or drop a folder here to organize project chats &amp; Knowledge Graphs.</div>';
    return;
  }

  for (const p of S.projects) {
    const active = S.activeProject?.id === p.id;
    const projChats = S.chats.filter((c) => c.projectId === p.id && (!q || (c.title || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)));
    const isOpen = S.expandedProjects.has(p.id) || Boolean(q && projChats.length);

    const group = document.createElement('div');
    group.className = 'proj-group' + (isOpen ? ' open' : '');
    group.draggable = true;
    group.dataset.projId = p.id;

    const row = document.createElement('div');
    row.className = 'proj-item' + (active ? ' active' : '');
    const badges = [
      p.graphStats?.fileCount ? `${p.graphStats.fileCount} files` : p.path.split(/[\\/]/).slice(-1)[0],
      p.autoAcceptEdits ? 'auto-edit' : '',
    ].filter(Boolean).join(' · ');

    row.innerHTML = `
      <span class="proj-chev"><svg><use href="#i-chevron-right"/></svg></span>
      <span class="proj-dot" style="background:${esc(p.color || '#c96442')}"></span>
      <span class="proj-meta">
        <span class="proj-name" title="${esc(p.path)}">${esc(p.name)}</span>
        <span class="proj-sub">${esc(badges)}</span>
      </span>
      <span class="proj-cnt" title="${projChats.length} chat(s)">${projChats.length}</span>
      <button type="button" class="proj-act-btn" data-pact="newchat" title="New chat inside ${esc(p.name)}"><svg><use href="#i-plus"/></svg></button>
      <button type="button" class="proj-act-btn" data-pact="settings" title="Project workspace settings"><svg><use href="#i-settings"/></svg></button>`;

    row.onclick = (e) => {
      if (e.target.closest('.proj-act-btn')) return;
      if (active) {
        if (S.expandedProjects.has(p.id)) S.expandedProjects.delete(p.id);
        else S.expandedProjects.add(p.id);
        renderProjectsList();
      } else {
        S.expandedProjects.add(p.id);
        selectProjectById(p.id);
      }
    };
    row.querySelector('[data-pact="newchat"]').onclick = async (e) => {
      e.stopPropagation();
      S.expandedProjects.add(p.id);
      if (S.activeProject?.id !== p.id) await selectProjectById(p.id, true);
      newChat(p.id);
    };
    row.querySelector('[data-pact="settings"]').onclick = (e) => {
      e.stopPropagation();
      openProjectModal(p);
    };

    // Drag project to reorder OR drop a chat onto this project to move it inside!
    group.addEventListener('dragstart', (e) => {
      if (e.target.closest('.chat-item')) return;
      group.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-mxcw-project', p.id);
    });
    group.addEventListener('dragend', () => {
      group.classList.remove('dragging');
      $$('.drag-over').forEach((x) => x.classList.remove('drag-over'));
    });
    group.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      group.classList.add('drag-over');
    });
    group.addEventListener('dragleave', (e) => {
      if (!group.contains(e.relatedTarget)) group.classList.remove('drag-over');
    });
    group.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      group.classList.remove('drag-over');
      const chatId = e.dataTransfer.getData('application/x-mxcw-chat');
      const dragProjId = e.dataTransfer.getData('application/x-mxcw-project');
      if (chatId) {
        const res = await CW.moveChatToProject({ chatId, projectId: p.id });
        S.chats = res.chats || S.chats;
        if (S.chat?.id === chatId) S.chat.projectId = p.id;
        S.expandedProjects.add(p.id);
        renderSidebarTree();
        toast(`Moved chat → ${p.name}`);
      } else if (dragProjId && dragProjId !== p.id) {
        const ids = S.projects.map((x) => x.id).filter((id) => id !== dragProjId);
        const targetIdx = ids.indexOf(p.id);
        ids.splice(targetIdx >= 0 ? targetIdx : ids.length, 0, dragProjId);
        const r = await CW.reorderProjects(ids);
        S.projects = r.projects || S.projects;
        renderSidebarTree();
      }
    });

    const chatsWrap = document.createElement('div');
    chatsWrap.className = 'proj-chats';
    if (!projChats.length) {
      chatsWrap.innerHTML = '<div class="proj-chat-empty">Drop a chat here or click +</div>';
    } else {
      for (const c of projChats) {
        chatsWrap.appendChild(createChatRowEl(c));
      }
    }

    group.append(row, chatsWrap);
    list.appendChild(group);
  }
}

function renderSidebarTree() {
  renderProjectsList();
  renderChatList();
}

async function selectProjectById(id, quiet = false) {
  try {
    const r = await CW.selectProject(id);
    S.activeProject = r.activeProject;
    S.projects = r.projects || S.projects;
    S.settings = r.settings;
    S.cwd = '';
    S.pinnedFiles = [];
    closeFileEditor(true);
    $('#ctImage').value = S.settings.containerImage || 'python:3.12-slim';
    $('#ctNet').value = S.settings.containerNetwork || 'none';
    $('#ctMount').value = S.settings.containerMountMode || 'rw';
    S.expandedProjects.add(id);
    renderSidebarTree();
    renderWorkspaceUI();
    renderAutoAcceptPill();
    renderPinned();
    loadFiles('');
    loadTasks();
    loadKbStats();

    if (r.cachedGraph) {
      S.graphData = r.cachedGraph;
      if (S.panelOpen && S.panelTab === 'graph') renderGraphData(r.cachedGraph);
    } else {
      S.graphData = null;
    }

    if (!quiet) toast(`Project → ${S.activeProject.name}`);
    if (S.activeProject.autoMapGraph) {
      const stale = !r.cachedGraph || (Date.now() - (r.cachedGraph.mappedAt || r.cachedGraph.builtAt || 0) > 5 * 60 * 1000);
      if (stale) triggerBackgroundGraphMap(S.activeProject);
    }
  } catch (e) {
    toast(e.message, 4000);
  }
}

async function triggerBackgroundGraphMap(project) {
  try {
    const res = await CW.mapGraphFast({ projectId: project?.id || '', useFastModel: true });
    if (res?.graph) {
      S.graphData = res.graph;
      if (res.projects) S.projects = res.projects;
      if (res.activeProject) S.activeProject = res.activeProject;
      renderProjectsList();
      if (S.panelOpen && S.panelTab === 'graph') renderGraphData(res.graph);
    }
  } catch {}
}

function openProjectModal(proj = null) {
  S.editingProjectId = proj?.id || null;
  $('#projModalTitle').textContent = proj ? `Project Settings · ${proj.name}` : 'New Project';
  $('#projNameInput').value = proj?.name || '';
  $('#projColorInput').value = proj?.color || '#c96442';
  $('#projPathInput').value = proj?.path || S.settings?.workspace || '';
  $('#projAutoMapChk').checked = proj ? proj.autoMapGraph !== false : true;
  $('#projAutoAcceptChk').checked = proj ? Boolean(proj.autoAcceptEdits) : false;
  $('#projAutoContainerChk').checked = proj ? Boolean(proj.autoRunContainer) : false;
  $('#projContainerImgInput').value = proj?.containerImage || S.settings?.containerImage || 'python:3.12-slim';
  $('#projContainerNetInput').value = proj?.containerNetwork || S.settings?.containerNetwork || 'none';
  $('#projContainerMountInput').value = proj?.containerMountMode || S.settings?.containerMountMode || 'rw';
  $('#projInstrInput').value = proj?.instructions || '';
  $('#deleteProjectBtn').hidden = !proj;
  $('#projectModal').hidden = false;
  setTimeout(() => $('#projNameInput').focus(), 30);
}

// ---- Workspace & OS Folder Navigation
function renderWorkspaceUI() {
  const ws = S.settings?.workspace || '';
  const base = S.activeProject?.name || ws.split(/[\\/]/).filter(Boolean).pop() || ws || '/';
  $('#wsTopLabel').textContent = base;
  $('#wsTopPill').title = S.activeProject
    ? `Project: ${S.activeProject.name} (${ws})`
    : `OS Folder: ${ws}`;
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
  renderSidebarTree();
}

function renderChatList() {
  const list = $('#chatList');
  const q = S.chatSearch.trim().toLowerCase();
  const projectIds = new Set(S.projects.map((p) => p.id));
  // Show chats not assigned to any existing project in the General Chats section
  const unassigned = S.chats.filter((c) => !c.projectId || !projectIds.has(c.projectId));
  const filtered = q ? unassigned.filter((c) => (c.title || '').toLowerCase().includes(q)) : unassigned;
  list.innerHTML = '';

  const hdr = document.createElement('div');
  hdr.className = 'sb-label';
  hdr.textContent = 'General Chats';
  list.appendChild(hdr);

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'sb-empty';
    empty.textContent = q ? 'No matching general chats' : 'Drop a chat here to unassign from a project';
    list.appendChild(empty);
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
    list.appendChild(createChatRowEl(c));
  }
}

function reattachActiveStreamDom(st) {
  if (!st) return;
  const live = mountLiveAssistantDom(st.assistant.livePhase || 'Working…');
  st.live = live;
  if (!st.assistant.livePhase) live.phaseEl.hidden = true;
  if (st.assistant.queuePos) live.phaseEl.className = 'loading-state queued';
  if (st.assistant.plan || st.assistant.workers?.length) {
    const cp = renderCopilotPanel(st.assistant);
    if (cp) { live.planSlot.hidden = false; live.planSlot.appendChild(cp); }
  }
  if (st.assistant.thinking) {
    live.thinkEl.hidden = false;
    live.thinkSummary.textContent = `Thinking (${st.assistant.thinking.length} chars)`;
    live.thinkPre.textContent = st.assistant.thinking;
    live.thinkPre.scrollTop = live.thinkPre.scrollHeight;
  }
  if (st.assistant.content) {
    live.proseEl.hidden = false;
    live.proseEl.innerHTML = renderMd(st.assistant.content, { msgKey: st.streamId, isStreaming: true });
  }
  scrollFeedIfNearBottom(true);
}

async function openChat(id) {
  // Detach live DOM pointers on any background streams without stopping them!
  for (const st of S.activeStreams.values()) st.live = null;
  S.viewingTempStreamId = null;

  const d = await CW.getChat(id);
  S.chat = d.chat;
  // If this chat belongs to a project, quietly activate that project so workspace & graph stay in sync
  if (d.chat.projectId && S.activeProject?.id !== d.chat.projectId && S.projects.some((p) => p.id === d.chat.projectId)) {
    await selectProjectById(d.chat.projectId, true);
  }
  S.messages = [...(d.chat.messages || [])];
  $('#chatTitle').textContent = d.chat.title || 'New chat';
  if (d.chat.mode) setMode(d.chat.mode);

  const activeSt = [...S.activeStreams.values()].find((x) => x.chatId === id);
  renderMessages(true);
  if (activeSt) {
    reattachActiveStreamDom(activeSt);
  }
  renderSidebarTree();
  updateSendButtonState();
}

function newChat(projectIdOverride = undefined) {
  for (const st of S.activeStreams.values()) st.live = null;
  S.viewingTempStreamId = null;
  const pid = typeof projectIdOverride === 'string' ? projectIdOverride : undefined;
  S.chat = pid !== undefined ? { id: null, projectId: pid } : null;
  S.messages = [];
  $('#chatTitle').textContent = 'New chat';
  renderMessages(true);
  renderSidebarTree();
  updateSendButtonState();
  $('#promptInput').focus();
}

// ---- Messages Rendering (exact mx-GPT webapp layout)
function renderPinned() {
  const bar = $('#pinnedBar');
  if (!S.pinnedFiles.length && !S.attachedImages.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  const filePills = S.pinnedFiles.map((p) =>
    `<span class="attach-pill"><svg style="width:14px;height:14px;color:var(--accent)"><use href="#i-file"/></svg><span title="${esc(p)}">${esc(p)}</span><button data-unpin="${esc(p)}" title="Remove"><svg style="width:12px;height:12px"><use href="#i-x"/></svg></button></span>`
  ).join('');
  const imgPills = S.attachedImages.map((im) =>
    `<span class="img-attach-pill"><img src="data:${esc(im.mimeType)};base64,${im.data}" alt="screenshot" /><span>${esc(im.name)}</span><button data-unimg="${esc(im.id)}" title="Remove screenshot"><svg style="width:12px;height:12px"><use href="#i-x"/></svg></button></span>`
  ).join('');
  bar.innerHTML = filePills + imgPills;
  $$('[data-unpin]', bar).forEach((b) => {
    b.onclick = () => {
      S.pinnedFiles = S.pinnedFiles.filter((x) => x !== b.dataset.unpin);
      renderPinned();
      if (S.panelOpen && S.panelTab === 'files' && !S.editor) loadFiles(S.cwd);
    };
  });
  $$('[data-unimg]', bar).forEach((b) => {
    b.onclick = () => {
      S.attachedImages = S.attachedImages.filter((x) => x.id !== b.dataset.unimg);
      renderPinned();
    };
  });
}

function renderDiffLinesHtml(diff) {
  if (!diff) return '';
  if (diff.identical) return '<div class="muted-note" style="padding:10px">Files are identical (0 changes).</div>';
  const rows = (diff.lines || []).map((l) => {
    if (l.type === 'sep') return `<div class="diff-line sep">${esc(l.text)}</div>`;
    const sign = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ';
    return `<div class="diff-line ${esc(l.type)}"><span class="ln">${l.oldLine ?? ''}</span><span class="ln">${l.newLine ?? ''}</span><span class="sg">${sign}</span><span>${esc(l.text)}</span></div>`;
  }).join('');
  return rows || '<div class="muted-note" style="padding:10px">No visible diff lines.</div>';
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
        ${act.diff ? `<details class="diff-box"><summary><span>${act.diff.exists ? 'Diff Preview' : 'New File Preview'}</span><span class="diff-stat-add">+${act.diff.added || 0}</span><span class="diff-stat-del">−${act.diff.removed || 0}</span></summary><div class="diff-viewer">${renderDiffLinesHtml(act.diff)}</div></details>` : ''}
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

    const isHost = (run.execTarget || S.settings?.codeExecutionTarget) === 'host';
    box.innerHTML = `
      <div class="ac-head">
        <div class="cr-badges">
          <b style="font-size:12.5px">${esc(run.title || 'Code Run')}</b>
          <span class="cr-badge${isHost ? ' host' : ''}">${isHost ? 'HOST (On-Machine)' : 'CONTAINER'}</span>
          <span class="cr-badge">${esc(run.language || 'bash')}</span>
          ${isHost ? '' : `<span class="cr-badge">${esc(run.image || 'python:3.12-slim')}</span><span class="cr-badge">net:${esc(run.network || 'none')}</span>`}
        </div>
        <div class="row-gap">
          ${isRunning
            ? `<button class="btn tiny danger" data-cr-stop>Stop</button>`
            : `<button class="btn tiny primary" data-cr-run>${run.status === 'done' || run.status === 'error' ? 'Re-run' : (isHost ? 'Run on Host' : 'Run in Container')}</button>
               <button class="btn tiny" data-cr-toggle-target title="Switch between Container and On-Machine Host execution">${isHost ? 'Use Container' : 'Run on Host'}</button>`}
          ${liveOut ? `<button class="btn tiny" data-cr-send>Send Output</button>` : ''}
        </div>
      </div>
      ${run.reason ? `<div class="ac-reason">${esc(run.reason)}</div>` : ''}
      <pre class="cr-code">${esc(script)}</pre>
      ${run.status === 'done' ? `<span class="ac-stat">✓ Exit 0 (${run.elapsedMs ? (run.elapsedMs / 1000).toFixed(1) + 's' : 'done'})</span>` : ''}
      ${run.status === 'error' ? `<span class="ac-stat err">✗ Exit ${run.exitCode ?? 1}</span>` : ''}
      ${liveOut ? `<pre class="cr-term" data-term-id="${esc(run.id)}">${esc(liveOut)}</pre>` : ''}`;

    const togTargetBtn = box.querySelector('[data-cr-toggle-target]');
    if (togTargetBtn) {
      togTargetBtn.onclick = () => {
        run.execTarget = isHost ? 'container' : 'host';
        renderMessages(false);
      };
    }

    const runBtn = box.querySelector('[data-cr-run]');
    if (runBtn) {
      runBtn.onclick = async () => {
        run.status = 'running';
        S.containerRunOutputs[run.id] = '';
        renderMessages(false);
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
            execTarget: run.execTarget || S.settings?.codeExecutionTarget || 'container',
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

  for (let mi = 0; mi < S.messages.length; mi++) {
    const m = S.messages[mi];
    const msgKey = m.id || `m_${mi}`;
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
      pr.innerHTML = renderMd(m.content, { msgKey, isStreaming: Boolean(m.streaming) });
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

    if (m.shieldSummary?.total > 0) {
      const sh = document.createElement('div');
      sh.className = 'shield-pill';
      sh.innerHTML = `<svg><use href="#i-shield"/></svg><span>Privacy Shield masked ${m.shieldSummary.total} sensitive item${m.shieldSummary.total === 1 ? '' : 's'} &amp; restored locally</span>`;
      body.appendChild(sh);
    }

    if (!m.streaming && m.content) {
      const foot = document.createElement('div');
      foot.className = 'msg-foot-bar';
      const spd = m.usage?.tokensPerSec ? `${m.usage.tokensPerSec} t/s` : '';
      const modeLbl = m.mode === 'copilot_b' ? 'Copilot (B)' : (m.mode || 'copilot');
      const info = [modeLbl, m.model ? m.model.replace(/:latest$/, '') : '', spd].filter(Boolean).join(' · ');
      const span = document.createElement('span');
      span.textContent = info;
      const docTitle = (m.plan?.goal || S.chat?.title || 'mx-Cowork Report').slice(0, 80);

      const cpBtn = document.createElement('button');
      cpBtn.textContent = 'Copy';
      cpBtn.onclick = () => { navigator.clipboard?.writeText(m.content); toast('Copied'); };

      const docxBtn = document.createElement('button');
      docxBtn.textContent = 'Word';
      docxBtn.title = 'Export as formatted Microsoft Word (.docx)';
      docxBtn.onclick = async () => {
        try {
          const r = await CW.exportDocx({ title: docTitle, markdown: m.content });
          if (!r.canceled) toast(`Exported Word → ${r.filePath}`);
        } catch (e) { toast(e.message, 4000); }
      };

      const xlsxBtn = document.createElement('button');
      xlsxBtn.textContent = 'Excel';
      xlsxBtn.title = 'Export tables as Excel workbook (.xlsx)';
      xlsxBtn.onclick = async () => {
        try {
          const r = await CW.exportXlsx({ title: docTitle, markdown: m.content });
          if (!r.canceled) toast(`Exported Excel → ${r.filePath}`);
        } catch (e) { toast(e.message, 4000); }
      };

      const pdfBtn = document.createElement('button');
      pdfBtn.textContent = 'PDF';
      pdfBtn.title = 'Export as print-ready PDF';
      pdfBtn.onclick = async () => {
        try {
          const r = await CW.exportPdf({ title: docTitle, markdown: m.content });
          if (!r.canceled) toast(`Exported PDF → ${r.filePath}`);
        } catch (e) { toast(e.message, 4000); }
      };

      const svBtn = document.createElement('button');
      svBtn.textContent = 'Save Brief';
      svBtn.onclick = async () => {
        await CW.saveBrief({
          title: docTitle,
          markdown: m.content,
          sources: m.sources || [],
        });
        toast('Saved to Research Desk');
        loadBriefs();
      };
      foot.append(span, cpBtn, docxBtn, xlsxBtn, pdfBtn, svBtn);
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

// ---- Concurrent Multi-Model Stream Router (switching chats/tabs never interrupts or mixes streams!)
function isViewingStream(st) {
  if (!st) return false;
  if (st.chatId) return S.chat?.id === st.chatId;
  return S.viewingTempStreamId === st.streamId;
}

function syncStreamArtifacts(st, isStillStreaming) {
  if (!isViewingStream(st)) return;
  const msgKey = isStillStreaming ? st.streamId : (st.assistant.id || st.streamId);
  const arts = extractArtifactsFromText(st.assistant.content, msgKey, isStillStreaming);
  if (!arts.length) return;
  for (const a of arts) S.artifacts.set(a.id, a);
  const latest = arts[arts.length - 1];

  if (latest.streaming) {
    if (st.autoOpenedArtId !== latest.id) {
      st.autoOpenedArtId = latest.id;
      S.artifactUserPickedTab = false;
      openArtifact(latest, 'code', { isAuto: true });
    } else if (S.panelOpen && S.panelTab === 'artifact' && S.activeArtifactId === latest.id) {
      renderArtifactPane();
    }
  } else if (!st.completedArtIds.has(latest.id)) {
    st.completedArtIds.add(latest.id);
    const wasStreamingThis = Boolean(st.autoOpenedArtId);
    st.autoOpenedArtId = latest.id;
    if (wasStreamingThis) {
      S.activeArtifactId = latest.id;
      if (!S.artifactUserPickedTab) S.artifactTab = 'preview';
      openPanel('artifact', false);
      renderArtifactPane();
    } else {
      openArtifact(latest, 'preview', { isAuto: true });
    }
  }
}

function flushStreamProse(st) {
  st.proseTimer = null;
  if (!st.assistant.content || !isViewingStream(st) || !st.live?.el?.isConnected) return;
  const sc = $('#scrollArea');
  const stick = isNearBottom(sc, 110);
  st.live.proseEl.hidden = false;
  st.live.proseEl.innerHTML = renderMd(st.assistant.content, { msgKey: st.streamId, isStreaming: true });
  syncStreamArtifacts(st, true);
  if (stick) sc.scrollTop = sc.scrollHeight;
}

function flushStreamThink(st) {
  st.thinkTimer = null;
  if (!st.pendingThink) return;
  const chunk = st.pendingThink;
  st.pendingThink = '';
  if (!isViewingStream(st) || !st.live?.el?.isConnected) return;
  st.live.thinkEl.hidden = false;
  st.live.thinkSummary.textContent = `Thinking (${st.assistant.thinking.length} chars)`;
  const preNearBot = isNearBottom(st.live.thinkPre, 40);
  st.live.thinkPre.append(document.createTextNode(chunk));
  if (preNearBot) st.live.thinkPre.scrollTop = st.live.thinkPre.scrollHeight;
}

function refreshStreamPlanPanel(st) {
  if (!isViewingStream(st) || !st.live?.el?.isConnected) return;
  const cp = renderCopilotPanel(st.assistant);
  st.live.planSlot.innerHTML = '';
  if (cp) {
    st.live.planSlot.hidden = false;
    st.live.planSlot.appendChild(cp);
  }
}

function handleGlobalCoworkEvent({ streamId: sid, event: ev, data: d }) {
  const st = S.activeStreams.get(sid);
  if (!st) return;
  const viewing = isViewingStream(st);
  const live = viewing && st.live?.el?.isConnected ? st.live : null;

  if (ev === 'chat' && d.chat) {
    st.chatId = d.chat.id;
    if (viewing) {
      S.chat = d.chat;
      S.viewingTempStreamId = null;
      $('#chatTitle').textContent = d.chat.title || 'New chat';
    }
    loadChats();
  } else if (ev === 'phase') {
    st.assistant.queuePos = 0;
    st.assistant.livePhase = d.label || d.phase;
    if (live) {
      live.phaseEl.hidden = false;
      live.phaseEl.className = 'loading-state';
      live.phaseTxt.textContent = st.assistant.livePhase;
    }
  } else if (ev === 'queue') {
    if (d.acquired || !d.position) {
      st.assistant.queuePos = 0;
      st.assistant.livePhase = 'Preparing response…';
      if (live) live.phaseEl.className = 'loading-state';
    } else {
      st.assistant.queuePos = d.position;
      st.assistant.livePhase = `Queued #${d.position}${d.runningLabel ? ` · waiting for ${d.runningLabel}` : ''}`;
      if (live) live.phaseEl.className = 'loading-state queued';
    }
    if (live) {
      live.phaseEl.hidden = false;
      live.phaseTxt.textContent = st.assistant.livePhase;
    }
  } else if (ev === 'shield') {
    st.assistant.shieldSummary = d;
    if (viewing && d?.total > 0) {
      toast(`Privacy Shield masked ${d.total} sensitive item${d.total === 1 ? '' : 's'} locally`);
    }
  } else if (ev === 'copilot_plan') {
    st.assistant.plan = d;
    refreshStreamPlanPanel(st);
  } else if (ev === 'worker_start') {
    st.assistant.workers.push({ ...d, status: 'running', stream: '' });
    refreshStreamPlanPanel(st);
  } else if (ev === 'worker_delta') {
    const w = st.assistant.workers.find((x) => x.id === d.id);
    if (w) {
      w.stream = (w.stream || '') + (d.delta || '');
      if (live) {
        const bodyEl = live.planSlot.querySelector(`[data-worker-body="${CSS.escape(d.id)}"]`);
        if (bodyEl) bodyEl.textContent = w.stream;
      }
    }
  } else if (ev === 'worker_done') {
    const w = st.assistant.workers.find((x) => x.id === d.id);
    if (w) { Object.assign(w, d, { status: d.ok ? 'done' : 'error' }); refreshStreamPlanPanel(st); }
  } else if (ev === 'thinking') {
    st.assistant.queuePos = 0;
    st.assistant.livePhase = 'Thinking…';
    if (live) {
      live.phaseEl.hidden = false;
      live.phaseEl.className = 'loading-state';
      live.phaseTxt.textContent = 'Thinking…';
    }
    const delta = d.delta || '';
    if (delta) {
      st.assistant.thinking += delta;
      st.pendingThink += delta;
      if (!st.thinkTimer) st.thinkTimer = setTimeout(() => flushStreamThink(st), 90);
    }
  } else if (ev === 'text') {
    st.assistant.livePhase = '';
    if (live) live.phaseEl.hidden = true;
    st.assistant.content += d.delta || '';
    if (!st.proseTimer) st.proseTimer = setTimeout(() => flushStreamProse(st), 75);
  } else if (ev === 'file_actions') {
    st.assistant.fileActions = d;
  } else if (ev === 'code_runs') {
    st.assistant.codeRuns = d;
  } else if (ev === 'graph_ready') {
    st.assistant.graphReady = d;
  } else if (ev === 'notes_saved') {
    loadNotes();
    toast(`Saved ${d.length} memory note${d.length > 1 ? 's' : ''}`);
  } else if (ev === 'tasks_saved') {
    loadTasks();
    toast(`Added ${d.length} action item${d.length > 1 ? 's' : ''} to Tasks`);
  } else if (ev === 'sources') {
    st.assistant.sources = d;
  } else if (ev === 'done') {
    if (st.proseTimer) { clearTimeout(st.proseTimer); st.proseTimer = null; }
    if (st.thinkTimer) { clearTimeout(st.thinkTimer); st.thinkTimer = null; }
    Object.assign(st.assistant, d.message || {}, { streaming: false, livePhase: '' });
    S.activeStreams.delete(sid);
    if (isViewingStream(st)) {
      if (!S.messages.includes(st.assistant)) {
        // Reload from persisted chat so message history is 100% authoritative
        openChat(st.chatId).then(() => syncStreamArtifacts(st, false));
      } else {
        renderMessages(false);
        syncStreamArtifacts(st, false);
      }
      updateSendButtonState();
    } else {
      toast(`Finished: ${d.chat?.title || 'Background chat'}`);
    }
    loadChats();
  } else if (ev === 'stopped') {
    if (st.proseTimer) clearTimeout(st.proseTimer);
    if (st.thinkTimer) clearTimeout(st.thinkTimer);
    st.assistant.streaming = false;
    st.assistant.livePhase = '';
    S.activeStreams.delete(sid);
    if (isViewingStream(st)) {
      renderMessages(false);
      updateSendButtonState();
    }
    loadChats();
  } else if (ev === 'error') {
    if (st.proseTimer) clearTimeout(st.proseTimer);
    if (st.thinkTimer) clearTimeout(st.thinkTimer);
    st.assistant.livePhase = '';
    st.assistant.streaming = false;
    st.assistant.content += `\n\n> **Error:** ${d.message}`;
    S.activeStreams.delete(sid);
    toast(d.message, 5000);
    if (isViewingStream(st)) {
      renderMessages(false);
      updateSendButtonState();
    }
    loadChats();
  }
}

// ---- Send / Stream Cowork Turn (Concurrent Multi-Model Safe!)
async function sendPrompt(overrideText = null) {
  const curStream = getStreamForCurrentView();
  if (curStream) {
    if (curStream.chatId) CW.stopCowork(curStream.chatId).catch(() => {});
    return;
  }
  const input = $('#promptInput');
  const prompt = (overrideText !== null ? overrideText : input.value).trim();
  if (!prompt) return;
  hideSlashMenu();
  $('#quickClipBar').hidden = true;
  if (overrideText === null) { input.value = ''; input.style.height = 'auto'; }

  const streamId = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const imagesToSend = S.attachedImages.map(({ mimeType, data, name }) => ({ mimeType, data, name }));
  const pinnedToSend = [...S.pinnedFiles];
  const targetChatId = S.chat?.id || null;
  const targetProjectId = S.chat?.projectId !== undefined ? S.chat.projectId : (S.activeProject?.id || '');
  const chosenMode = S.mode;
  const chosenThink = S.think;
  const shieldOn = S.piiShield;

  // Clear attached screenshots after capturing them for this turn
  if (S.attachedImages.length) {
    S.attachedImages = [];
    renderPinned();
  }

  const userMsg = { id: 'tmp-u-' + streamId, role: 'user', content: prompt };
  S.messages.push(userMsg);
  renderMessages(true);

  const initialPhase = chosenMode === 'copilot_b'
    ? 'Copilot (B) planning…'
    : chosenMode === 'copilot'
      ? 'Copilot planning…'
      : 'Connecting…';

  const assistant = {
    id: 'tmp-a-' + streamId,
    role: 'assistant',
    mode: chosenMode,
    content: '',
    thinking: '',
    plan: null,
    workers: [],
    sources: [],
    fileActions: [],
    codeRuns: [],
    shieldSummary: null,
    livePhase: initialPhase,
    queuePos: 0,
    streaming: true,
  };
  S.messages.push(assistant);
  const live = mountLiveAssistantDom(initialPhase);

  const st = {
    streamId,
    chatId: targetChatId,
    projectId: targetProjectId,
    userMsg,
    assistant,
    live,
    proseTimer: null,
    thinkTimer: null,
    pendingThink: '',
    autoOpenedArtId: null,
    completedArtIds: new Set(),
  };
  S.activeStreams.set(streamId, st);
  if (!targetChatId) S.viewingTempStreamId = streamId;
  updateSendButtonState();
  renderSidebarTree();

  // Fire concurrently — user can immediately switch to another chat/project and launch another model!
  CW.runCowork({
    streamId,
    chatId: targetChatId,
    projectId: targetProjectId,
    mode: chosenMode,
    think: chosenThink,
    prompt,
    pinnedFiles: pinnedToSend,
    images: imagesToSend,
    piiShield: shieldOn,
    toolOverrides: {
      toolWebSearch: S.toolWebSearch,
      toolOsFiles: S.toolOsFiles,
      toolContainer: S.containerEnabled,
    },
  }).catch((e) => {
    if (S.activeStreams.has(streamId)) {
      handleGlobalCoworkEvent({ streamId, event: 'error', data: { message: e.message } });
    }
  });
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

function renderEditorTable(filterText = '') {
  const tbl = S.editorTable;
  const grid = $('#edTableGrid');
  if (!tbl || !tbl.rows?.length) {
    grid.innerHTML = '<tbody><tr><td style="color:var(--muted);padding:12px">No table rows found.</td></tr></tbody>';
    $('#edTableStats').textContent = '0 rows';
    return;
  }
  const q = filterText.trim().toLowerCase();
  const [header, ...bodyRows] = tbl.rows;
  const filtered = q ? bodyRows.filter((r) => r.some((c) => String(c || '').toLowerCase().includes(q))) : bodyRows;
  const visible = filtered.slice(0, 250);
  $('#edTableStats').textContent = `${filtered.length} / ${bodyRows.length} rows · ${header.length} cols`;
  grid.innerHTML = `<thead><tr>${header.map((h) => `<th title="${esc(h)}">${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${visible.map((r) => `<tr>${header.map((_, i) => `<td title="${esc(r[i] ?? '')}">${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

function setEditorTableMode(on) {
  S.editorTableMode = Boolean(on && S.editorTable);
  $('#edTableWrap').hidden = !S.editorTableMode;
  $('#edTextarea').hidden = S.editorTableMode;
  $('#edTableToggleBtn').classList.toggle('primary', S.editorTableMode);
  $('#edTableToggleBtn').innerHTML = `<svg><use href="#i-table"/></svg>${S.editorTableMode ? 'Raw Text' : 'Table'}`;
}

async function openFileInEditor(relPath) {
  try {
    const f = await CW.readFileForEdit(relPath);
    S.editor = { ...f, savedContent: f.content };
    S.editorTable = null;
    S.editorTableMode = false;
    $('#filesBrowserView').hidden = true;
    $('#fileEditorView').hidden = false;
    $('#edFileName').textContent = f.name;
    $('#edFilePath').textContent = f.absPath;
    $('#edTextarea').value = f.content;
    $('#edTextarea').readOnly = !f.editable;
    $('#edSaveBtn').disabled = !f.editable;
    $('#edReadonlyNote').hidden = f.editable;

    const isTabular = /\.(csv|tsv|xlsx)$/i.test(f.name || '');
    $('#edTableToggleBtn').hidden = !isTabular;
    $('#edExportXlsxBtn').hidden = !isTabular;
    $('#edTableWrap').hidden = true;
    $('#edTextarea').hidden = false;
    $('#edTableFilter').value = '';

    if (isTabular) {
      try {
        const tbl = await CW.parseTableFile(relPath);
        if (tbl?.rows?.length) {
          S.editorTable = tbl;
          renderEditorTable('');
          setEditorTableMode(true);
        }
      } catch {}
    }

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
  S.editorTable = null;
  S.editorTableMode = false;
  $('#edTableWrap').hidden = true;
  $('#edTextarea').hidden = false;
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
    if (S.activeProject?.autoMapGraph) {
      CW.mapGraphFast({ projectId: S.activeProject.id, useFastModel: false }).then((res) => {
        if (res?.graph) {
          S.graphData = res.graph;
          if (S.panelOpen && S.panelTab === 'graph') renderGraphData(res.graph);
        }
      }).catch(() => {});
    }
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
  if (S.graphData && S.graphData.workspace === S.settings?.workspace) {
    renderGraphData(S.graphData);
    setTimeout(() => S.graphView?.fitToView(), 90);
    return;
  }
  if (S.activeProject) {
    const cached = await CW.getCachedGraph(S.activeProject.id).catch(() => ({ graph: null }));
    if (cached?.graph && cached.graph.workspace === S.settings?.workspace) {
      S.graphData = cached.graph;
      renderGraphData(cached.graph);
      return;
    }
  }
  await buildAndRenderGraph(true);
}

function renderGraphData(g) {
  if (!g) return;
  const st = g.stats || {};
  const mappedNote = g.mappedByModel
    ? ` · Fast AI (${g.mappedByModel.replace(/:latest$/, '')})`
    : '';
  $('#graphStats').textContent = `${g.projectName} · ${st.fileCount || 0} files · ${st.importEdges || 0} imports${st.semanticEdges ? ` + ${st.semanticEdges} AI links` : ''} · ${st.packageCount || 0} pkgs · ${(st.totalLines || 0).toLocaleString()} lines${mappedNote}`;

  // Fast-model summary box
  const aiBox = $('#graphAiBox');
  if (g.aiSummary) {
    aiBox.hidden = false;
    aiBox.innerHTML = `<b style="font-size:11px;color:var(--accent-ink);text-transform:uppercase;letter-spacing:.05em">Fast Model Map</b><div style="margin-top:3px">${esc(g.aiSummary)}</div>`;
  } else {
    aiBox.hidden = true;
  }

  // Clickable Cluster & Core Hub spotlight bar
  const bar = $('#graphClustersBar');
  const clusters = g.aiClusters || [];
  const hubs = (g.topHubs || []).slice(0, 5);
  if (clusters.length || hubs.length) {
    bar.hidden = false;
    bar.innerHTML = '';
    for (const c of clusters) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gc-pill';
      b.textContent = `◈ ${c.name}`;
      b.title = c.description || c.name;
      b.onclick = () => {
        S.graphView?.setClusterFocus(c.name);
        $$('.gc-pill', bar).forEach((x) => x.classList.toggle('on', x === b && S.graphView?.activeCluster === c.name));
      };
      bar.appendChild(b);
    }
    for (const h of hubs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gc-pill';
      b.textContent = `● ${h.label}`;
      b.title = `Core Hub: ${h.path} (${h.inDegree} in · ${h.outDegree} out)`;
      b.onclick = () => S.graphView?.centerOnNode(h.id);
      bar.appendChild(b);
    }
  } else {
    bar.hidden = true;
  }

  $('#graphInspector').hidden = true;
  S.graphView?.resize();
  S.graphView?.setShowTreeEdges(S.graphTreeEdges);
  S.graphView?.setFilters(S.graphFilters);
  S.graphView?.setData(g);
}

async function buildAndRenderGraph(useFastModel = true) {
  initGraphViewIfNeeded();
  $('#graphStats').textContent = useFastModel
    ? 'Scanning workspace & mapping semantics with Fast model…'
    : 'Scanning workspace…';
  $('#graphBuildBtn').disabled = true;
  try {
    const res = await CW.mapGraphFast({
      projectId: S.activeProject?.id || '',
      useFastModel,
    });
    const g = res.graph;
    S.graphData = g;
    if (res.projects) S.projects = res.projects;
    if (res.activeProject) S.activeProject = res.activeProject;
    renderProjectsList();
    renderGraphData(g);
    if (g.aiError && useFastModel) {
      toast(`Structural graph built (Fast model note: ${g.aiError})`, 3500);
    }
  } catch (e) {
    $('#graphStats').textContent = `Graph map failed: ${e.message}`;
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
  const roleEl = $('#giRole');
  if (node.aiRole) {
    roleEl.hidden = false;
    roleEl.textContent = node.aiRole;
  } else {
    roleEl.hidden = true;
  }

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
    node._cluster ? `<span class="gi-pill">${esc(node._cluster)}</span>` : '',
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
      b.textContent = item.label ? `${item.node.label} (${item.label})` : item.node.label;
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

function syncCodeExecTargetUI() {
  const isHost = $('#ctExecTarget')?.value === 'host';
  $('#ctImage').hidden = isHost;
  $('#ctNet').hidden = isHost;
  $('#ctMount').hidden = isHost;
  $('#ctImagePresets').hidden = isHost;
  const lbl = $('#ctRunBtnLabel');
  if (lbl) lbl.textContent = isHost ? 'Run on Host (On-Machine)' : 'Run in Container';
}

async function runSandboxContainer() {
  const code = $('#ctCodeInput').value.trim();
  if (!code) { toast('Enter code or a shell command first'); return; }
  const execTarget = $('#ctExecTarget')?.value || 'container';
  const runId = 'sb_' + Date.now().toString(36);
  S.activeContainerRunId = runId;
  S.containerRunOutputs[runId] = '';
  $('#ctTerminal').textContent = execTarget === 'host' ? 'Running on local host…\n' : 'Starting container…\n';
  $('#ctRunMeta').textContent = 'Running…';
  $('#ctRunBtn').disabled = true;
  $('#ctStopBtn').hidden = false;

  try {
    const r = await CW.runInContainer({
      runId,
      title: `${execTarget === 'host' ? 'Host' : 'Container'} (${$('#ctLang').value})`,
      language: $('#ctLang').value,
      code,
      execTarget,
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
      } else if (S.assignModelTarget === 'agent') {
        $('#setAgentModel').value = m.name;
        toast(`Subagent / Worker model → ${m.name}`);
      } else if (S.assignModelTarget === 'graph') {
        $('#setGraphMapperModel').value = m.name;
        toast(`Graph Mapper model → ${m.name}`);
      } else {
        $('#setFastModel').value = m.name;
        toast(`Fast model → ${m.name}`);
      }
    };
    list.appendChild(btn);
  }
}

// ---- Saved Provider Profiles (WebUI-aligned)
async function loadSavedProviders() {
  const list = $('#savedProvidersList');
  if (!list) return;
  try {
    const d = await CW.listProviders();
    S.savedProviders = d.providers || [];
    list.innerHTML = '';
    if (!S.savedProviders.length) {
      list.innerHTML = '<div class="muted-note">No saved provider profiles yet. Configure an endpoint above and click "+ Save as Reusable Provider Profile" to switch between providers in 1 click.</div>';
      return;
    }
    const curUrl = (S.settings?.endpointUrl || '').replace(/\/+$/, '');
    const curType = S.settings?.endpointType || 'mxgpt';

    for (const p of S.savedProviders) {
      const isActive = curType === p.endpointType && curUrl === (p.endpointUrl || '').replace(/\/+$/, '');
      const card = document.createElement('div');
      card.className = 'provider-card';
      const badges = [
        `<span class="badge-pill">${esc(p.endpointType)}</span>`,
        isActive ? '<span class="badge-pill hot">Active</span>' : '',
        (p.hasApiKey || p.hasPassword) ? '<span class="badge-pill ok">Credentials saved</span>' : '',
        p.models?.length ? `<span class="badge-pill">${p.models.length} models</span>` : '',
      ].filter(Boolean).join(' ');

      card.innerHTML = `
        <div class="pc-top">
          <div class="pc-name"><b>${esc(p.name)}</b> ${badges}</div>
        </div>
        <div class="pc-url">${esc(p.endpointUrl)}${p.fastModel || p.smartModel ? ` · ${esc([p.fastModel, p.smartModel].filter(Boolean).join(' / '))}` : ''}</div>
        <div class="pc-actions">
          ${isActive ? '' : '<button type="button" class="btn tiny primary" data-pact="activate">Activate</button>'}
          <button type="button" class="btn tiny" data-pact="refresh">Fetch Models</button>
          <button type="button" class="btn tiny" data-pact="load">Load into Form</button>
          <button type="button" class="btn tiny danger" data-pact="delete">Remove</button>
        </div>`;

      const actBtn = card.querySelector('[data-pact="activate"]');
      if (actBtn) {
        actBtn.onclick = async () => {
          actBtn.disabled = true;
          try {
            const r = await CW.activateProvider(p.id);
            S.settings = r.settings;
            openSettings('providers');
            renderAccountUI();
            checkConnectionQuiet();
            toast(`Switched active provider → ${p.name}`);
          } catch (e) { toast(e.message, 4000); }
        };
      }
      card.querySelector('[data-pact="refresh"]').onclick = async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        b.textContent = 'Fetching…';
        try {
          const r = await CW.refreshProvider(p.id);
          renderFetchedModels(r.models);
          toast(`${p.name}: ${r.found} models (${r.latencyMs}ms)`);
          loadSavedProviders();
        } catch (err) {
          toast(`Fetch failed: ${err.message}`, 4000);
          b.disabled = false;
          b.textContent = 'Fetch Models';
        }
      };
      card.querySelector('[data-pact="load"]').onclick = () => {
        S.selectedPreset = p.presetId || p.endpointType;
        $('#setEndpointType').value = p.endpointType;
        $('#setEndpointUrl').value = p.endpointUrl;
        $('#setUsername').value = p.username || '';
        $('#setPassword').value = '';
        $('#setApiKey').value = '';
        if (p.fastModel) $('#setFastModel').value = p.fastModel;
        if (p.smartModel) $('#setSmartModel').value = p.smartModel;
        syncProviderAuthUI(p.endpointType);
        renderProviderChips();
        toast(`Loaded "${p.name}" into form`);
      };
      card.querySelector('[data-pact="delete"]').onclick = async () => {
        await CW.deleteProvider(p.id);
        loadSavedProviders();
        toast(`Removed profile "${p.name}"`);
      };
      list.appendChild(card);
    }
  } catch (e) {
    list.innerHTML = `<div class="muted-note">Could not load saved providers: ${esc(e.message)}</div>`;
  }
}

// ---- Token Usage Statistics Dashboard (WebUI-identical)
function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 10_000) return (v / 1_000).toFixed(1) + 'k';
  return v.toLocaleString();
}

function roleDisplayName(role) {
  if (role === 'main') return 'Main / Copilot';
  if (role === 'worker') return 'Subagent Worker';
  if (role === 'graph') return 'Graph Mapper';
  if (role === 'planner') return 'Planner';
  return role || 'Main';
}

async function renderUsagePanel() {
  const root = $('#usagePanelRoot');
  if (!root) return;
  root.innerHTML = '<div class="muted-note">Loading token usage statistics…</div>';
  try {
    const u = await CW.getUsage();
    const t = u?.totals || { requests: 0, promptTokens: 0, evalTokens: 0, subagentTokens: 0, totalTokens: 0, totalMs: 0, avgTokensPerSec: 0 };

    // Build last 14 calendar days
    const dayMap = new Map((u.byDay || []).map((d) => [d.day, d]));
    const days = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      const rec = dayMap.get(key) || { day: key, requests: 0, totalTokens: 0 };
      days.push({ ...rec, label: `${dt.getMonth() + 1}/${dt.getDate()}` });
    }
    const maxDay = Math.max(1, ...days.map((d) => d.totalTokens));

    const barsHtml = days.map((d) => {
      const pct = d.totalTokens > 0 ? Math.max(4, Math.round((d.totalTokens / maxDay) * 100)) : 2;
      const tip = `${d.day}: ${d.totalTokens.toLocaleString()} tokens (${d.requests} req)`;
      return `<div class="usage-bar" title="${esc(tip)}">
        <div class="usage-bar-fill" style="height:${pct}%;${d.totalTokens === 0 ? 'opacity:.16' : ''}"></div>
        <span>${esc(d.label)}</span>
      </div>`;
    }).join('');

    const modelRows = (u.byModel || []).length
      ? u.byModel.map((m) => `<tr>
          <td class="m" title="${esc(m.model)}">${esc(m.model)}</td>
          <td class="num">${m.requests}</td>
          <td class="num">${fmtTok(m.promptTokens)}</td>
          <td class="num">${fmtTok(m.evalTokens)}</td>
          <td class="num"><b>${fmtTok(m.totalTokens)}</b></td>
          <td class="num">${m.avgTokensPerSec ? m.avgTokensPerSec + ' t/s' : '—'}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:12px">No model usage recorded yet. Send a prompt to start tracking tokens.</td></tr>';

    const roleRows = (u.byRole || []).length
      ? u.byRole.map((r) => `<tr>
          <td>${esc(roleDisplayName(r.role))}</td>
          <td class="num">${r.requests}</td>
          <td class="num">${fmtTok(r.promptTokens)}</td>
          <td class="num">${fmtTok(r.evalTokens)}</td>
          <td class="num"><b>${fmtTok(r.totalTokens)}</b></td>
          <td class="num">${r.avgTokensPerSec ? r.avgTokensPerSec + ' t/s' : '—'}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:10px">No role breakdown yet.</td></tr>';

    const chatRows = (u.byChat || []).length
      ? u.byChat.map((c) => `<tr class="usage-chat-row" data-usage-chat="${esc(c.id)}">
          <td class="m" title="${esc(c.title)}">${esc(c.title)}</td>
          <td class="m">${esc((c.model || '').replace(/:latest$/, ''))}</td>
          <td class="num">${c.requests}</td>
          <td class="num"><b>${fmtTok(c.totalTokens)}</b></td>
        </tr>`).join('')
      : '<tr><td colspan="4" style="color:var(--muted);text-align:center;padding:10px">No per-chat usage recorded yet.</td></tr>';

    const lim = u?.limits || { fast: { unlimited: true, totalTokens: 0, requests: 0 }, smart: { limit4h: 150000, used4h: 0, pct4h: 0, reset4hInMs: 0, limitDaily: 500000, usedDaily: 0, pctDaily: 0, resetDailyInMs: 0 } };
    const fmtReset = (ms) => {
      if (!ms || ms <= 0) return 'ready';
      const mins = Math.ceil(ms / 60000);
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h > 0 ? `resets in ~${h}h ${m}m` : `resets in ~${m}m`;
    };
    const barCls = (pct) => (pct >= 100 ? 'hit' : pct >= 80 ? 'warn' : 'ok');

    root.innerHTML = `
      <div class="pane-head-row" style="margin-bottom:10px">
        <span class="muted-note" style="margin:0">2-Tier Token Telemetry &amp; Limits — Fast tier is unlimited; Smart tier enforces rolling 4-hour &amp; daily caps.</span>
        <div class="row-gap">
          <button type="button" class="btn tiny" id="usageRefreshBtn">Refresh</button>
        </div>
      </div>

      <div class="limit-grid">
        <div class="limit-card unlimited">
          <div class="limit-top"><span>Fast Tier</span><span class="badge-pill ok">Unlimited</span></div>
          <div class="limit-val">${fmtTok(lim.fast.totalTokens)} used</div>
          <div class="limit-bar"><div class="limit-fill ok" style="width:100%"></div></div>
          <div class="limit-sub">${lim.fast.requests} reqs · No cap (Fast, Workers, Graph)</div>
        </div>
        <div class="limit-card">
          <div class="limit-top"><span>Smart · 4-Hour Window</span><span>${lim.smart.limit4h > 0 ? lim.smart.pct4h + '%' : 'Off'}</span></div>
          <div class="limit-val">${fmtTok(lim.smart.used4h)} / ${lim.smart.limit4h > 0 ? fmtTok(lim.smart.limit4h) : '∞'}</div>
          <div class="limit-bar"><div class="limit-fill ${barCls(lim.smart.pct4h)}" style="width:${lim.smart.pct4h}%"></div></div>
          <div class="limit-sub">${lim.smart.exceeded4h ? 'Limit reached · ' : ''}${fmtReset(lim.smart.reset4hInMs)}</div>
        </div>
        <div class="limit-card">
          <div class="limit-top"><span>Smart · Daily Limit</span><span>${lim.smart.limitDaily > 0 ? lim.smart.pctDaily + '%' : 'Off'}</span></div>
          <div class="limit-val">${fmtTok(lim.smart.usedDaily)} / ${lim.smart.limitDaily > 0 ? fmtTok(lim.smart.limitDaily) : '∞'}</div>
          <div class="limit-bar"><div class="limit-fill ${barCls(lim.smart.pctDaily)}" style="width:${lim.smart.pctDaily}%"></div></div>
          <div class="limit-sub">${lim.smart.exceededDaily ? 'Limit reached · ' : ''}${fmtReset(lim.smart.resetDailyInMs)}</div>
        </div>
      </div>

      <div class="usage-cards">
        <div class="usage-card">
          <span>Total Tokens</span>
          <b>${fmtTok(t.totalTokens)}</b>
          <small>${fmtTok(t.promptTokens)} in · ${fmtTok(t.evalTokens + t.subagentTokens)} out</small>
        </div>
        <div class="usage-card">
          <span>Requests</span>
          <b>${t.requests.toLocaleString()}</b>
          <small>${t.avgTokensPerSec ? t.avgTokensPerSec + ' t/s avg' : 'No speed data yet'}</small>
        </div>
        <div class="usage-card">
          <span>Main Output</span>
          <b>${fmtTok(t.evalTokens)}</b>
          <small>Direct &amp; Copilot answers</small>
        </div>
        <div class="usage-card">
          <span>Workers &amp; Graph</span>
          <b>${fmtTok(t.subagentTokens)}</b>
          <small>Subagents &amp; Fast mapper</small>
        </div>
      </div>

      <div class="usage-sec">
        <h3><span>Last 14 Days</span><span style="font-weight:400;font-size:11px;color:var(--muted)">Tokens per day</span></h3>
        <div class="usage-bars">${barsHtml}</div>
      </div>

      <div class="usage-sec">
        <h3>By Model</h3>
        <table class="usage-table">
          <thead><tr><th>Model</th><th class="num">Reqs</th><th class="num">Prompt</th><th class="num">Output</th><th class="num">Total</th><th class="num">Speed</th></tr></thead>
          <tbody>${modelRows}</tbody>
        </table>
      </div>

      <div class="usage-sec">
        <h3>By Agent Role</h3>
        <table class="usage-table">
          <thead><tr><th>Role</th><th class="num">Reqs</th><th class="num">Prompt</th><th class="num">Output</th><th class="num">Total</th><th class="num">Speed</th></tr></thead>
          <tbody>${roleRows}</tbody>
        </table>
      </div>

      <div class="usage-sec" style="margin-bottom:0">
        <h3><span>Recent Chats</span><span style="font-weight:400;font-size:11px;color:var(--muted)">Click a chat to open</span></h3>
        <table class="usage-table">
          <thead><tr><th>Chat</th><th>Last Model</th><th class="num">Reqs</th><th class="num">Total Tokens</th></tr></thead>
          <tbody>${chatRows}</tbody>
        </table>
      </div>`;

    $('#usageRefreshBtn', root).onclick = () => renderUsagePanel();
    $$('[data-usage-chat]', root).forEach((row) => {
      row.onclick = () => {
        const cid = row.dataset.usageChat;
        if (!cid) return;
        $('#settingsModal').hidden = true;
        openChat(cid);
      };
    });
  } catch (e) {
    root.innerHTML = `<div class="muted-note">Failed to load usage stats: ${esc(e.message)}</div>`;
  }
}

function setSettingsTab(tab) {
  $$('#settingsTabs button').forEach((b) => b.classList.toggle('active', b.dataset.stab === tab));
  $$('.stab-pane').forEach((p) => p.classList.toggle('active', p.dataset.spane === tab));
  if (tab === 'providers') loadSavedProviders();
  if (tab === 'usage') renderUsagePanel();
}

function openSettings(initialTab = 'models') {
  const tab = typeof initialTab === 'string' ? initialTab : 'models';
  const s = S.settings || {};
  S.selectedPreset = s.providerPreset || s.endpointType || 'mxgpt';
  // Tab 1: Models & Agent Role Routing
  $('#setFastModel').value = s.fastModel || 'lfm3:latest';
  $('#setSmartModel').value = s.smartModel || 'inkling-2-mini:latest';
  $('#setCopilotBModel').value = s.copilotBModel || 'nemotron-3.5-lightning';
  $('#setAgentModel').value = s.agentModel || s.fastModel || 'lfm3:latest';
  $('#setGraphMapperModel').value = s.graphMapperModel || s.fastModel || 'lfm3:latest';
  $('#setDefaultMode').value = s.defaultMode || 'copilot';
  $('#setDefaultThink').value = s.think || 'low';
  $('#setSmartLimit4h').value = String(s.smartLimit4h ?? 150000);
  $('#setSmartLimitDaily').value = String(s.smartLimitDaily ?? 500000);
  $('#setCustomInstr').value = s.customInstructions || '';
  // Tab 2: Providers & API Keys
  $('#setEndpointType').value = s.endpointType || 'mxgpt';
  $('#setEndpointUrl').value = s.endpointUrl || 'https://max.fyreflysystems.de';
  $('#setUsername').value = s.username || '';
  $('#setPassword').value = '';
  $('#setPassword').placeholder = s.hasPassword ? '•••••••• (saved — leave blank to keep)' : 'Enter password';
  $('#setApiKey').value = '';
  $('#setApiKey').placeholder = s.hasApiKey ? '•••••••• (saved — leave blank to keep)' : 'sk-... (stored locally)';
  // Tab 4: Tools & Privacy
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
  $('#setPiiShield').checked = !!s.piiShieldEnabled;
  $('#setPiiCustomTerms').value = s.piiCustomTerms || '';
  $('#setGlobalHotkey').value = s.globalHotkey || 'Alt+Space';
  // Tab 5: Code Execution (Container & Host)
  $('#setCodeExecTarget').value = s.codeExecutionTarget || 'container';
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
  setSettingsTab(tab);
  $('#settingsModal').hidden = false;
}

function collectSettingsForm() {
  const pw = $('#setPassword').value;
  const key = $('#setApiKey').value.trim();
  const containerOn = $('#setToolContainer').checked;
  const fastModel = $('#setFastModel').value.trim() || 'lfm3:latest';
  return {
    endpointType: $('#setEndpointType').value,
    providerPreset: S.selectedPreset || $('#setEndpointType').value,
    endpointUrl: $('#setEndpointUrl').value.trim() || 'https://max.fyreflysystems.de',
    username: $('#setUsername').value.trim(),
    password: pw ? pw : '__KEEP__',
    apiKey: key ? key : '__KEEP__',
    fastModel,
    smartModel: $('#setSmartModel').value.trim() || 'inkling-2-mini:latest',
    copilotBModel: $('#setCopilotBModel').value.trim() || 'nemotron-3.5-lightning',
    agentModel: $('#setAgentModel').value.trim() || fastModel,
    graphMapperModel: $('#setGraphMapperModel').value.trim() || fastModel,
    defaultMode: $('#setDefaultMode').value || 'copilot',
    think: $('#setDefaultThink').value || 'low',
    smartLimit4h: Math.max(0, Math.round(Number($('#setSmartLimit4h').value) || 0)),
    smartLimitDaily: Math.max(0, Math.round(Number($('#setSmartLimitDaily').value) || 0)),
    customInstructions: $('#setCustomInstr').value.trim(),
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
    piiShieldEnabled: $('#setPiiShield').checked,
    piiCustomTerms: $('#setPiiCustomTerms').value.trim(),
    globalHotkey: $('#setGlobalHotkey').value.trim() || 'Alt+Space',
    codeExecutionTarget: $('#setCodeExecTarget').value || 'container',
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
$('#newChatBtn').onclick = () => newChat();
$('#chatSearch').oninput = (e) => { S.chatSearch = e.target.value; renderSidebarTree(); };
$('#themeBtn').onclick = toggleTheme;
$('#openSettingsBtn').onclick = () => openSettings('models');
$('#footProviderBtn').onclick = () => openSettings('providers');
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

// Projects & Auto-Accept Edits Wiring
$('#addProjectBtn').onclick = () => openProjectModal(null);
$('#closeProjectModalBtn').onclick = () => { $('#projectModal').hidden = true; };
$('#cancelProjectBtn').onclick = () => { $('#projectModal').hidden = true; };
$('#projBrowsePathBtn').onclick = async () => {
  const r = await CW.pickProjectPath();
  if (r.canceled) return;
  $('#projPathInput').value = r.path;
  if (!$('#projNameInput').value.trim()) $('#projNameInput').value = r.suggestedName || '';
};
$('#saveProjectBtn').onclick = async () => {
  const pPath = $('#projPathInput').value.trim();
  if (!pPath) { toast('Choose a local project folder path first'); return; }
  try {
    const res = await CW.saveProject({
      id: S.editingProjectId || undefined,
      name: $('#projNameInput').value.trim(),
      color: $('#projColorInput').value,
      path: pPath,
      autoMapGraph: $('#projAutoMapChk').checked,
      autoAcceptEdits: $('#projAutoAcceptChk').checked,
      autoRunContainer: $('#projAutoContainerChk').checked,
      containerImage: $('#projContainerImgInput').value.trim() || 'python:3.12-slim',
      containerNetwork: $('#projContainerNetInput').value,
      containerMountMode: $('#projContainerMountInput').value,
      instructions: $('#projInstrInput').value.trim(),
      activate: true,
    });
    S.projects = res.projects || [];
    S.activeProject = res.activeProject;
    S.settings = res.settings;
    S.cwd = '';
    S.graphData = null;
    $('#projectModal').hidden = true;
    renderProjectsList();
    renderWorkspaceUI();
    renderAutoAcceptPill();
    loadFiles('');
    toast(`Project "${S.activeProject.name}" ready`);
    if (S.activeProject.autoMapGraph) {
      triggerBackgroundGraphMap(S.activeProject);
    }
  } catch (e) { toast(e.message, 4000); }
};
$('#deleteProjectBtn').onclick = async () => {
  if (!S.editingProjectId) return;
  const r = await CW.deleteProject(S.editingProjectId);
  S.projects = r.projects || [];
  S.activeProject = r.activeProject;
  S.settings = r.settings;
  $('#projectModal').hidden = true;
  renderSidebarTree();
  renderWorkspaceUI();
  renderAutoAcceptPill();
  toast('Project removed from sidebar (local files untouched)');
};
$('#autoAcceptTopPill').onclick = async () => {
  const cur = S.activeProject
    ? Boolean(S.activeProject.autoAcceptEdits)
    : Boolean(S.settings?.autoApproveFileActions);
  const r = await CW.toggleAutoAcceptEdits(!cur);
  S.activeProject = r.activeProject || S.activeProject;
  S.settings = r.settings;
  if (S.activeProject) {
    const idx = S.projects.findIndex((x) => x.id === S.activeProject.id);
    if (idx >= 0) S.projects[idx] = S.activeProject;
  }
  renderProjectsList();
  renderAutoAcceptPill();
  toast(r.autoAcceptEdits ? 'Auto-Accept Edits enabled (with 1-click Undo)' : 'Auto-Accept Edits turned off');
};

// Knowledge Graph Controls
$('#graphBuildBtn').onclick = () => buildAndRenderGraph(true);
$('#graphLayoutSeg').onclick = (e) => {
  const b = e.target.closest('button[data-layout]');
  if (!b) return;
  $$('#graphLayoutSeg button').forEach((x) => x.classList.toggle('on', x === b));
  S.graphView?.applyLayout(b.dataset.layout);
};
$('#graphTreeEdgesBtn').onclick = () => {
  S.graphTreeEdges = !S.graphTreeEdges;
  $('#graphTreeEdgesBtn').textContent = S.graphTreeEdges ? 'Folders: On' : 'Folders: Off';
  S.graphView?.setShowTreeEdges(S.graphTreeEdges);
};
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

// Artifact Canvas Toolbar & Inline Artifact Card Click Delegation
$('#messages').addEventListener('click', (e) => {
  const card = e.target.closest('.art-card[data-art-id]');
  if (!card) return;
  const art = S.artifacts.get(card.dataset.artId);
  if (art) openArtifact(art, art.streaming ? 'code' : 'preview');
});

$('#artTabs').onclick = (e) => {
  const b = e.target.closest('button[data-arttab]');
  if (!b) return;
  S.artifactTab = b.dataset.arttab;
  S.artifactUserPickedTab = true;
  renderArtifactPane();
};

$('#artCopyBtn').onclick = () => {
  const art = S.activeArtifactId ? S.artifacts.get(S.activeArtifactId) : null;
  if (!art) return;
  navigator.clipboard?.writeText(art.code || '');
  toast('Artifact code copied');
};

$('#artSaveBtn').onclick = async () => {
  const art = S.activeArtifactId ? S.artifacts.get(S.activeArtifactId) : null;
  if (!art) return;
  try {
    const r = await CW.saveArtifact(art);
    if (!r.canceled) toast(`Saved ${r.filePath}`);
  } catch (e) { toast(e.message); }
};

$('#artOpenExtBtn').onclick = async () => {
  const art = S.activeArtifactId ? S.artifacts.get(S.activeArtifactId) : null;
  if (!art) return;
  try {
    await CW.openArtifactInBrowser(buildArtifactHtml(art));
    toast('Opened artifact in OS browser');
  } catch (e) { toast(e.message); }
};

$('#artRefreshBtn').onclick = () => {
  const art = S.activeArtifactId ? S.artifacts.get(S.activeArtifactId) : null;
  if (!art) return;
  const frame = $('#artFrame');
  frame.dataset.renderedId = '';
  frame.dataset.renderedLen = '';
  S.artifactTab = 'preview';
  renderArtifactPane();
  toast('Preview refreshed');
};

// Settings Tabs & Model Focus
$('#settingsTabs').onclick = (e) => {
  const b = e.target.closest('button[data-stab]');
  if (b) setSettingsTab(b.dataset.stab);
};
const bindModelFocus = (sel, target) => {
  $(sel).addEventListener('focus', () => {
    S.assignModelTarget = target;
    $$('#fmTarget button').forEach((x) => x.classList.toggle('on', x.dataset.target === target));
  });
};
bindModelFocus('#setFastModel', 'fast');
bindModelFocus('#setSmartModel', 'smart');
bindModelFocus('#setCopilotBModel', 'copilot_b');
bindModelFocus('#setAgentModel', 'agent');
bindModelFocus('#setGraphMapperModel', 'graph');

// Save current Provider form as Reusable Profile
$('#saveAsProfileBtn').onclick = async () => {
  const preset = S.providerPresets.find((x) => x.id === S.selectedPreset);
  const suggested = preset?.label || $('#setEndpointType').value.toUpperCase();
  const name = await askText({
    title: 'Save Provider Profile',
    label: 'Give this provider configuration a name',
    value: suggested,
    placeholder: 'e.g. Work OpenAI, Local Ollama, mx-GPT',
  });
  if (!name) return;
  try {
    const form = collectSettingsForm();
    await CW.saveProvider({
      name,
      endpointType: form.endpointType,
      presetId: form.providerPreset,
      endpointUrl: form.endpointUrl,
      username: form.username,
      password: form.password === '__KEEP__' ? (S.settings?.hasPassword ? '__KEEP__' : '') : form.password,
      apiKey: form.apiKey === '__KEEP__' ? (S.settings?.hasApiKey ? '__KEEP__' : '') : form.apiKey,
      fastModel: form.fastModel,
      smartModel: form.smartModel,
    });
    await loadSavedProviders();
    toast(`Saved provider profile "${name}"`);
  } catch (e) { toast(e.message, 4000); }
};

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
    S.piiShield = Boolean(S.settings.piiShieldEnabled);
    $('#webToggleBtn').classList.toggle('on', S.toolWebSearch);
    $('#filesToggleBtn').classList.toggle('on', S.toolOsFiles);
    $('#containerToggleBtn').classList.toggle('on', S.containerEnabled);
    $('#shieldToggleBtn').classList.toggle('on', S.piiShield);
    $('#ctExecTarget').value = S.settings.codeExecutionTarget || 'container';
    syncCodeExecTargetUI();
    $('#ctImage').value = S.settings.containerImage || 'python:3.12-slim';
    $('#ctNet').value = S.settings.containerNetwork || 'none';
    $('#ctMount').value = S.settings.containerMountMode || 'rw';
    if (S.settings.defaultMode) setMode(S.settings.defaultMode);
    if (S.settings.think) setThink(S.settings.think);
    $('#settingsModal').hidden = true;
    hideLoginScreen();
    renderAccountUI();
    renderWorkspaceUI();
    renderAutoAcceptPill();
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

// ============ v1.6.0 Controllers: Slash Workflows, Compare Diff, Tasks, KB, Automations, Clipboard, Screenshot Paste, Drag-Drop & Shield ============

// 1. Privacy / PII Redaction Shield toggle
$('#shieldToggleBtn').onclick = async () => {
  S.piiShield = !S.piiShield;
  $('#shieldToggleBtn').classList.toggle('on', S.piiShield);
  await CW.saveSettings({ piiShieldEnabled: S.piiShield });
  toast(S.piiShield ? 'Privacy Shield ON — emails, IBANs, phones, secrets & custom terms masked locally' : 'Privacy Shield OFF');
};

// 2. Host vs Container Target Selector & Artifact PDF Export
$('#ctExecTarget').onchange = () => syncCodeExecTargetUI();
$('#artPdfBtn').onclick = async () => {
  const art = S.activeArtifactId ? S.artifacts.get(S.activeArtifactId) : null;
  if (!art) { toast('Open an artifact first'); return; }
  try {
    const r = await CW.exportPdf({ title: art.title || 'Artifact', html: buildArtifactHtml(art) });
    if (!r.canceled) toast(`Exported PDF → ${r.filePath}`);
  } catch (e) { toast(e.message, 4000); }
};

// 3. CSV / Excel Data Desk Table Controls
$('#edTableToggleBtn').onclick = () => setEditorTableMode(!S.editorTableMode);
$('#edTableFilter').oninput = (e) => renderEditorTable(e.target.value);
$('#edExportXlsxBtn').onclick = async () => {
  if (!S.editorTable?.rows?.length) return;
  try {
    const title = (S.editor?.name || 'spreadsheet').replace(/\.[^.]+$/, '');
    const r = await CW.exportXlsx({ title, sheets: [{ name: title.slice(0, 28) || 'Data', rows: S.editorTable.rows }] });
    if (!r.canceled) toast(`Exported Excel → ${r.filePath}`);
  } catch (e) { toast(e.message, 4000); }
};

// 4. Side-by-Side Document Compare / Visual Diff Modal
async function openCompareModal() {
  S.lastCompare = null;
  $('#askCopilotDiffBtn').hidden = true;
  $('#cmpSummaryStats').textContent = '';
  $('#cmpDiffViewer').innerHTML = '<div class="muted-note" style="padding:14px">Choose two files above and click <b>Compare Files</b>.</div>';
  // Populate workspace file suggestions in datalist
  try {
    const ls = await CW.listFiles(S.cwd || '');
    const dl = $('#cmpFileOptions');
    dl.innerHTML = (ls.items || [])
      .filter((x) => !x.isDir)
      .map((x) => `<option value="${esc(x.relPath)}"></option>`)
      .join('');
    if (S.pinnedFiles.length >= 2) {
      $('#cmpLeftInput').value = S.pinnedFiles[0];
      $('#cmpRightInput').value = S.pinnedFiles[1];
    }
  } catch {}
  $('#compareModal').hidden = false;
  setTimeout(() => $('#cmpLeftInput').focus(), 30);
}

async function runFileCompare() {
  const leftPath = $('#cmpLeftInput').value.trim();
  const rightPath = $('#cmpRightInput').value.trim();
  if (!leftPath || !rightPath) { toast('Enter two relative workspace file paths'); return; }
  $('#cmpDiffViewer').innerHTML = '<div class="muted-note" style="padding:14px">Computing diff…</div>';
  try {
    const res = await CW.compareFiles({ leftPath, rightPath });
    S.lastCompare = res;
    $('#cmpSummaryStats').innerHTML = res.identical
      ? 'Identical (0 changes)'
      : `<span class="diff-stat-add">+${res.added}</span> · <span class="diff-stat-del">−${res.removed}</span> · ${res.unchanged} unchanged`;
    $('#cmpDiffViewer').innerHTML = renderDiffLinesHtml(res);
    $('#askCopilotDiffBtn').hidden = false;
  } catch (e) {
    $('#cmpDiffViewer').innerHTML = `<div class="muted-note" style="padding:14px;color:var(--danger,#c53030)">${esc(e.message)}</div>`;
    toast(e.message, 4000);
  }
}

$('#compareFilesBtn').onclick = openCompareModal;
$('#quickCompareBtn').onclick = openCompareModal;
$('#closeCompareModalBtn').onclick = () => { $('#compareModal').hidden = true; };
$('#runCompareBtn').onclick = runFileCompare;
$('#askCopilotDiffBtn').onclick = () => {
  if (!S.lastCompare) return;
  const c = S.lastCompare;
  $('#compareModal').hidden = true;
  sendPrompt(`Explain all substantive differences, changed numbers, and potential risks between "${c.left.path}" and "${c.right.path}" (+${c.added} / -${c.removed} lines):\n\`\`\`diff\n${(c.unifiedText || '').slice(0, 8000)}\n\`\`\``);
};

// 5. Reusable Slash /Workflows Autocomplete & Manager
async function loadWorkflows() {
  try {
    const d = await CW.listWorkflows();
    S.workflows = d.workflows || [];
  } catch {}
}

function filteredSlashWorkflows(query) {
  const q = String(query || '').replace(/^\/+/, '').trim().toLowerCase();
  if (!q) return S.workflows;
  return S.workflows.filter((w) =>
    (w.slug || '').toLowerCase().includes(q)
    || (w.title || '').toLowerCase().includes(q)
    || (w.description || '').toLowerCase().includes(q)
  );
}

function hideSlashMenu() {
  $('#slashMenu').hidden = true;
}

function applySlashWorkflow(wf) {
  hideSlashMenu();
  if (!wf) return;
  if (wf.slug === 'compare') {
    $('#promptInput').value = '';
    openCompareModal();
    return;
  }
  const inp = $('#promptInput');
  inp.value = wf.prompt || '';
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 200) + 'px';
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
}

function renderSlashMenu(filterText = '') {
  const menu = $('#slashMenu');
  const items = filteredSlashWorkflows(filterText);
  if (!items.length) { menu.hidden = true; return; }
  S.slashIndex = Math.max(0, Math.min(S.slashIndex, items.length - 1));
  menu.hidden = false;
  menu.innerHTML = '';
  items.forEach((wf, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slash-item' + (idx === S.slashIndex ? ' active' : '');
    btn.innerHTML = `
      <span class="slash-item-l">
        <span class="slash-cmd">/${esc(wf.slug)} · ${esc(wf.title)}</span>
        <span class="slash-desc">${esc(wf.description || wf.prompt.slice(0, 90))}</span>
      </span>
      <span class="slash-badge">${wf.builtin ? 'built-in' : 'custom'}</span>`;
    btn.onmousedown = (e) => { e.preventDefault(); applySlashWorkflow(wf); };
    menu.appendChild(btn);
  });
  const mgr = document.createElement('button');
  mgr.type = 'button';
  mgr.className = 'slash-item';
  mgr.innerHTML = '<span class="slash-item-l"><span class="slash-cmd">+ Manage / Create Custom Workflow…</span><span class="slash-desc">Add reusable team or personal slash templates</span></span>';
  mgr.onmousedown = (e) => { e.preventDefault(); hideSlashMenu(); openWorkflowModal(); };
  menu.appendChild(mgr);
}

$('#workflowsBtn').onclick = () => {
  const menu = $('#slashMenu');
  if (!menu.hidden) { hideSlashMenu(); return; }
  S.slashIndex = 0;
  renderSlashMenu('');
};

$('#promptInput').addEventListener('input', () => {
  const v = $('#promptInput').value;
  if (v.startsWith('/') && !v.includes('\n') && v.length <= 36) {
    S.slashIndex = 0;
    renderSlashMenu(v);
  } else {
    hideSlashMenu();
  }
});

$('#promptInput').addEventListener('keydown', (e) => {
  const menu = $('#slashMenu');
  if (menu.hidden) return;
  const items = filteredSlashWorkflows($('#promptInput').value);
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    S.slashIndex = (S.slashIndex + 1) % items.length;
    renderSlashMenu($('#promptInput').value);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    S.slashIndex = (S.slashIndex - 1 + items.length) % items.length;
    renderSlashMenu($('#promptInput').value);
  } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    applySlashWorkflow(items[S.slashIndex] || items[0]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideSlashMenu();
  }
}, true);

// Screenshot / Image Paste (Ctrl+V) directly into Composer
$('#promptInput').addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const imgItem = items.find((it) => it.type && it.type.startsWith('image/'));
  if (!imgItem) return;
  const file = imgItem.getAsFile();
  if (!file) return;
  e.preventDefault();
  const reader = new FileReader();
  reader.onload = () => {
    const res = String(reader.result || '');
    const base64 = res.includes(',') ? res.split(',')[1] : res;
    if (!base64) return;
    S.attachedImages.push({
      id: 'img_' + Date.now().toString(36),
      name: `Screenshot ${S.attachedImages.length + 1}`,
      mimeType: file.type || 'image/png',
      data: base64,
    });
    renderPinned();
    toast('Screenshot attached — send to any vision-capable model');
  };
  reader.readAsDataURL(file);
});

// Manage Custom Workflows Modal
function renderWorkflowsManageList() {
  const list = $('#workflowsManageList');
  list.innerHTML = '';
  for (const wf of S.workflows) {
    const card = document.createElement('div');
    card.className = 'saved-card';
    card.innerHTML = `
      <div class="sc-row">
        <b>/${esc(wf.slug)} · ${esc(wf.title)}</b>
        ${wf.builtin ? '<span class="slash-badge">built-in</span>' : '<button class="btn tiny danger" data-del-wf>✕</button>'}
      </div>
      <small>${esc(wf.description || wf.prompt.slice(0, 120))}</small>`;
    const delBtn = card.querySelector('[data-del-wf]');
    if (delBtn) {
      delBtn.onclick = async () => {
        const r = await CW.deleteWorkflow(wf.id);
        S.workflows = r.workflows || [];
        renderWorkflowsManageList();
        toast(`Removed /${wf.slug}`);
      };
    }
    list.appendChild(card);
  }
}

function openWorkflowModal() {
  $('#wfSlugInput').value = '';
  $('#wfTitleInput').value = '';
  $('#wfPromptInput').value = '';
  renderWorkflowsManageList();
  $('#workflowModal').hidden = false;
  setTimeout(() => $('#wfSlugInput').focus(), 30);
}

$('#manageWorkflowsBtn').onclick = openWorkflowModal;
$('#closeWorkflowModalBtn').onclick = () => { $('#workflowModal').hidden = true; };
$('#saveWorkflowBtn').onclick = async () => {
  const slug = $('#wfSlugInput').value.trim();
  const title = $('#wfTitleInput').value.trim();
  const prompt = $('#wfPromptInput').value.trim();
  if (!slug || !prompt) { toast('Enter both a slash command and prompt template'); return; }
  const r = await CW.saveWorkflow({ slug, title: title || `/${slug}`, prompt });
  S.workflows = r.workflows || [];
  $('#wfSlugInput').value = '';
  $('#wfTitleInput').value = '';
  $('#wfPromptInput').value = '';
  renderWorkflowsManageList();
  toast(`Saved workflow /${r.workflow.slug}`);
};

// 6. Quick-Ask Clipboard Banner (triggered by Alt+Space or Tray)
function showQuickClipBar(text) {
  const clean = String(text || '').trim();
  if (!clean) {
    $('#promptInput').focus();
    toast('Quick-Ask ready (Alt+Space)');
    return;
  }
  S.quickClipText = clean;
  $('#qcbSnippet').textContent = clean.replace(/\s+/g, ' ').slice(0, 88) + (clean.length > 88 ? '…' : '');
  $('#quickClipBar').hidden = false;
  $('#promptInput').focus();
}
$('#qcbCloseBtn').onclick = () => { $('#quickClipBar').hidden = true; };
$$('[data-qcb]').forEach((b) => {
  b.onclick = () => {
    const act = b.dataset.qcb;
    const txt = S.quickClipText || '';
    $('#quickClipBar').hidden = true;
    if (!txt) return;
    if (act === 'paste') {
      const inp = $('#promptInput');
      inp.value = (inp.value ? inp.value + '\n\n' : '') + txt;
      inp.focus();
      return;
    }
    const prompts = {
      rewrite: `Rewrite the text below into clear, polite, professional business prose (keep original language):\n\n${txt}`,
      translate: `Translate the text below naturally between German and English (preserve formatting & tone):\n\n${txt}`,
      summarize: `Summarize the key points, decisions, and risks from the text below in crisp bullets:\n\n${txt}`,
      actions: `Extract all action items (owner, due date, priority) and output an \`\`\`action-items JSON block so mx-Cowork saves them to Project Tasks:\n\n${txt}`,
    };
    sendPrompt(prompts[act] || txt);
  };
});

// 7. Project Action Items / Tasks + .ics Calendar Invite Export
async function loadTasks() {
  try {
    const d = await CW.listTasks();
    S.tasks = d.tasks || [];
    const list = $('#tasksList');
    if (!list) return;
    list.innerHTML = S.tasks.length ? '' : '<div class="muted-note">No action items yet. Add one above or run <code>/meeting-notes</code>.</div>';
    for (const t of S.tasks) {
      const row = document.createElement('div');
      row.className = 'task-item' + (t.done ? ' done' : '');
      row.innerHTML = `
        <input type="checkbox" ${t.done ? 'checked' : ''} />
        <div class="task-main">
          <span class="task-title">${esc(t.title)}</span>
          <span class="task-meta">
            <span class="task-pri ${esc(t.priority || 'med')}">${esc(t.priority || 'med')}</span>
            ${t.owner ? `<span>@${esc(t.owner)}</span>` : ''}
            ${t.due ? `<span>Due ${esc(t.due)}</span>` : ''}
          </span>
        </div>
        <button type="button" class="icon-btn sm" data-ics title="Export Calendar Invite (.ics)"><svg><use href="#i-calendar"/></svg></button>
        <button type="button" class="icon-btn sm" data-del title="Delete task"><svg><use href="#i-x"/></svg></button>`;
      row.querySelector('input[type="checkbox"]').onchange = async () => {
        const r = await CW.toggleTask(t.id);
        S.tasks = r.tasks || [];
        loadTasks();
      };
      row.querySelector('[data-ics]').onclick = async () => {
        const r = await CW.exportIcs({
          title: t.title,
          description: [t.owner ? `Owner: ${t.owner}` : '', t.source ? `Source: ${t.source}` : ''].filter(Boolean).join('\n'),
          start: t.due ? `${t.due}T09:00:00` : null,
          durationMin: 30,
        });
        if (!r.canceled) toast(`Saved calendar invite → ${r.filePath}`);
      };
      row.querySelector('[data-del]').onclick = async () => {
        await CW.deleteTask(t.id);
        loadTasks();
      };
      list.appendChild(row);
    }
  } catch {}
}

$('#addTaskBtn').onclick = async () => {
  const title = $('#taskTitleInput').value.trim();
  if (!title) { toast('Enter a task title first'); return; }
  await CW.saveTask({
    title,
    owner: $('#taskOwnerInput').value.trim(),
    due: $('#taskDueInput').value,
    priority: 'med',
  });
  $('#taskTitleInput').value = '';
  $('#taskOwnerInput').value = '';
  $('#taskDueInput').value = '';
  loadTasks();
  toast('Task added');
};
$('#taskTitleInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#addTaskBtn').click(); }
});

// 8. Private Local Document Knowledge Base (Offline Semantic BM25 Search)
async function loadKbStats() {
  try {
    const st = await CW.kbStats();
    const el = $('#kbStatus');
    if (!el) return;
    el.textContent = st.indexed
      ? `Indexed ${st.fileCount} docs (${st.chunkCount} passages) · updated ${new Date(st.builtAt).toLocaleTimeString()}`
      : 'Not indexed yet — click "Index Docs" to search local PDFs, DOCX, XLSX & Markdown offline.';
  } catch {}
}

$('#kbIndexBtn').onclick = async () => {
  const btn = $('#kbIndexBtn');
  btn.disabled = true;
  btn.textContent = 'Indexing…';
  try {
    const r = await CW.indexKb();
    toast(`Indexed ${r.fileCount} local documents (${r.chunkCount} passages)`);
    loadKbStats();
  } catch (e) { toast(e.message, 4000); }
  finally { btn.disabled = false; btn.textContent = 'Index Docs'; }
};

async function runKbSearch() {
  const q = $('#kbSearchInput').value.trim();
  if (!q) return;
  const out = $('#kbResults');
  out.innerHTML = '<div class="muted-note">Searching local document knowledge base…</div>';
  try {
    const d = await CW.queryKb({ query: q, topK: 6 });
    loadKbStats();
    out.innerHTML = '';
    if (!d.hits?.length) {
      out.innerHTML = '<div class="muted-note">No matching passages found in indexed project docs.</div>';
      return;
    }
    for (const h of d.hits) {
      const card = document.createElement('div');
      card.className = 'saved-card';
      card.innerHTML = `
        <div class="sc-row"><b>${esc(h.path)}</b><span class="slash-badge">§${h.section} · ${h.score}</span></div>
        <small style="white-space:pre-wrap;color:var(--text-2)">${esc(h.snippet.slice(0, 220))}…</small>`;
      card.onclick = () => { openPanel('files'); openFileInEditor(h.path); };
      out.appendChild(card);
    }
    const askBtn = document.createElement('button');
    askBtn.className = 'btn tiny primary';
    askBtn.textContent = 'Ask Copilot Using These Passages';
    askBtn.onclick = () => {
      const ctx = d.hits.slice(0, 4).map((h, i) => `[${i + 1}] ${h.path} (section ${h.section}):\n${h.snippet}`).join('\n\n');
      sendPrompt(`Answer "${q}" accurately using ONLY the cited local document passages below:\n\n${ctx}`);
    };
    out.appendChild(askBtn);
  } catch (e) {
    out.innerHTML = `<div class="muted-note">KB search failed: ${esc(e.message)}</div>`;
  }
}
$('#kbSearchBtn').onclick = runKbSearch;
$('#kbSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runKbSearch(); });

// 9. Local Scheduled Automations & Folder Watchers
async function loadAutomations() {
  try {
    const d = await CW.listAutomations();
    S.automations = d.automations || [];
    const list = $('#automationsList');
    if (!list) return;
    list.innerHTML = S.automations.length
      ? ''
      : '<div class="muted-note">No automations yet. Click <b>+ Rule</b> to watch a folder or schedule recurring tasks.</div>';
    for (const a of S.automations) {
      const card = document.createElement('div');
      card.className = 'saved-card';
      const trig = a.triggerType === 'folder_watch'
        ? `Watch: ${a.watchFolder || '/'} ${a.filePattern ? `(*${a.filePattern}*)` : ''}`
        : `Every ${a.intervalMinutes} min`;
      card.innerHTML = `
        <div class="sc-row">
          <b>${esc(a.name)}</b>
          <div class="row-gap">
            <button class="btn tiny" data-arun title="Run right now">Run</button>
            <button class="btn tiny ${a.enabled ? 'primary' : ''}" data-atog>${a.enabled ? 'On' : 'Off'}</button>
            <button class="btn tiny danger" data-adel>✕</button>
          </div>
        </div>
        <small>${esc(trig)} · ${esc(a.mode || 'fast')}${a.lastRunAt ? ` · last ${new Date(a.lastRunAt).toLocaleTimeString()} (${esc(a.lastStatus)})` : ''}</small>`;
      card.querySelector('[data-arun]').onclick = async (e) => {
        const b = e.currentTarget; b.disabled = true; b.textContent = 'Running…';
        try {
          await CW.runAutomationNow(a.id);
          loadAutomations(); loadBriefs();
        } catch (err) { toast(err.message, 4000); }
        finally { b.disabled = false; b.textContent = 'Run'; }
      };
      card.querySelector('[data-atog]').onclick = async () => { await CW.toggleAutomation(a.id); loadAutomations(); };
      card.querySelector('[data-adel]').onclick = async () => { await CW.deleteAutomation(a.id); loadAutomations(); };
      list.appendChild(card);
    }
  } catch {}
}

$('#openAutoModalBtn').onclick = () => {
  $('#autoNameInput').value = '';
  $('#autoFolderInput').value = '';
  $('#autoPatternInput').value = '.pdf';
  $('#autoIntervalInput').value = '60';
  $('#autoPromptInput').value = '';
  $('#autoTriggerSelect').value = 'folder_watch';
  $('#autoFolderRow').hidden = false;
  $('#autoIntervalRow').hidden = true;
  $('#automationModal').hidden = false;
};
$('#closeAutoModalBtn').onclick = () => { $('#automationModal').hidden = true; };
$('#cancelAutoBtn').onclick = () => { $('#automationModal').hidden = true; };
$('#autoTriggerSelect').onchange = () => {
  const isWatch = $('#autoTriggerSelect').value === 'folder_watch';
  $('#autoFolderRow').hidden = !isWatch;
  $('#autoIntervalRow').hidden = isWatch;
};
$('#saveAutoBtn').onclick = async () => {
  const name = $('#autoNameInput').value.trim();
  const prompt = $('#autoPromptInput').value.trim();
  if (!prompt) { toast('Enter an automation prompt first'); return; }
  try {
    await CW.saveAutomation({
      name: name || 'Local Automation',
      triggerType: $('#autoTriggerSelect').value,
      watchFolder: $('#autoFolderInput').value.trim(),
      filePattern: $('#autoPatternInput').value.trim(),
      intervalMinutes: Number($('#autoIntervalInput').value) || 60,
      mode: $('#autoModeSelect').value || 'fast',
      prompt,
    });
    $('#automationModal').hidden = true;
    loadAutomations();
    toast('Automation saved & active');
  } catch (e) { toast(e.message, 4000); }
};

// 10. Sidebar Drag-and-Drop Drop Zones (unassign chat to General Chats, or drop OS folder to create Project!)
const chatListDrop = $('#chatList');
chatListDrop.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('application/x-mxcw-chat')) {
    e.preventDefault();
    chatListDrop.classList.add('drag-over');
  }
});
chatListDrop.addEventListener('dragleave', (e) => {
  if (!chatListDrop.contains(e.relatedTarget)) chatListDrop.classList.remove('drag-over');
});
chatListDrop.addEventListener('drop', async (e) => {
  const chatId = e.dataTransfer?.getData('application/x-mxcw-chat');
  if (!chatId) return;
  e.preventDefault();
  e.stopPropagation();
  chatListDrop.classList.remove('drag-over');
  const r = await CW.moveChatToProject({ chatId, projectId: '' });
  S.chats = r.chats || S.chats;
  if (S.chat?.id === chatId) S.chat.projectId = '';
  renderSidebarTree();
  toast('Moved chat to General Chats');
});

const projZoneDrop = $('#sbProjectsZone');
projZoneDrop.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault();
    e.stopPropagation();
    projZoneDrop.classList.add('drag-over');
  }
});
projZoneDrop.addEventListener('dragleave', (e) => {
  if (!projZoneDrop.contains(e.relatedTarget)) projZoneDrop.classList.remove('drag-over');
});
projZoneDrop.addEventListener('drop', async (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  e.stopPropagation();
  projZoneDrop.classList.remove('drag-over');
  try {
    const r = await CW.createProjectFromDropped(files[0]);
    if (r?.ok) {
      S.projects = r.projects || S.projects;
      S.activeProject = r.activeProject;
      S.settings = r.settings;
      S.expandedProjects.add(r.project.id);
      renderSidebarTree();
      renderWorkspaceUI();
      renderAutoAcceptPill();
      loadFiles('');
      toast(`Created project "${r.project.name}" from dropped folder`);
      if (r.project.autoMapGraph) triggerBackgroundGraphMap(r.project);
    }
  } catch (err) { toast(err.message, 4000); }
});

boot().catch((e) => toast(`Startup error: ${e.message}`, 5000));
