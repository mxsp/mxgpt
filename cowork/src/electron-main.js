'use strict';

/**
 * mx-Cowork Native Desktop Main Process (Electron — Linux & Windows)
 *
 * Pure native desktop application:
 *  - Own OS window, branded icon, native application menu & keyboard shortcuts
 *  - Direct secure Electron IPC (ZERO local HTTP server, ZERO browser tabs)
 *  - Native OS folder picker, native Save As dialogs (.eml / .md), Reveal in File Manager,
 *    and direct OS Mail Client launching
 *  - Full Fast / Smart / Copilot hybrid orchestration engine
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, globalShortcut, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const storage = require('./storage');
const endpoint = require('./endpoint');
const localFiles = require('./local-files');
const research = require('./research');
const copilot = require('./copilot');
const updater = require('./updater');
const containerRunner = require('./container-runner');
const knowledgeGraph = require('./knowledge-graph');
const localTools = require('./local-tools');
const diffEngine = require('./diff-engine');
const officeExport = require('./office-export');
const docIndex = require('./doc-index');
const automations = require('./automations');

const ACTIVE_RUNS = new Map(); // chatId -> AbortController
let mainWindow = null;
let appTray = null;
let registeredHotkey = '';

// Single-instance lock so double-clicking the app focuses the existing window
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function sendMenuAction(action, payload = null) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('cowork:menu', { action, payload });
  }
}

function buildAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Coworker Task', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-task') },
        { label: 'Choose Workspace Folder…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuAction('pick-folder') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('open-settings') },
        { label: 'Check for Updates…', click: () => sendMenuAction('open-updates') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Mode',
      submenu: [
        { label: 'Fast (LFM3 1.7B)', accelerator: 'CmdOrCtrl+1', click: () => sendMenuAction('set-mode', 'fast') },
        { label: 'Smart (Inkling 26B)', accelerator: 'CmdOrCtrl+2', click: () => sendMenuAction('set-mode', 'smart') },
        { label: 'Copilot (Smart + Fast Workers)', accelerator: 'CmdOrCtrl+3', click: () => sendMenuAction('set-mode', 'copilot') },
        { label: 'Copilot (B) — nemotron-3.5-lightning', accelerator: 'CmdOrCtrl+4', click: () => sendMenuAction('set-mode', 'copilot_b') },
        { type: 'separator' },
        { label: 'Toggle Studio Drawer', accelerator: 'CmdOrCtrl+B', click: () => sendMenuAction('toggle-drawer') },
        { label: 'Toggle Light / Dark Theme', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendMenuAction('toggle-theme') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 920,
    minHeight: 600,
    title: 'mx-Cowork',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: storage.getSettings().theme === 'dark' ? '#262624' : '#faf9f5',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--self-test')) {
      mainWindow.show();
    }
  });

  // Open external links in OS default browser instead of navigating the app window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'public', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---- Native IPC Handlers (Zero HTTP Server)
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    ok: true,
    app: 'mx-Cowork',
    version: app.getVersion(),
    platform: process.platform,
    dataDir: storage.DATA_DIR,
    workspace: localFiles.getWorkspace(),
  }));

  ipcMain.handle('settings:get', () => ({
    settings: storage.publicSettings(),
    quickFolders: localFiles.quickFolders(),
    platform: process.platform,
    dataDir: storage.DATA_DIR,
  }));

  ipcMain.handle('settings:save', (_, patch) => {
    storage.saveSettings(patch || {});
    endpoint.resetSession();
    return { ok: true, settings: storage.publicSettings() };
  });

  ipcMain.handle('endpoint:test', async (_, overrideCfg) => {
    return endpoint.testConnection(overrideCfg && Object.keys(overrideCfg).length ? overrideCfg : null);
  });

  ipcMain.handle('auth:login', async (_, creds) => {
    const patch = {
      endpointType: creds?.endpointType || 'mxgpt',
      providerPreset: creds?.providerPreset || creds?.endpointType || 'mxgpt',
      endpointUrl: String(creds?.endpointUrl || 'https://max.fyreflysystems.de').trim().replace(/\/+$/, ''),
      username: String(creds?.username || '').trim(),
      password: creds?.password || '__KEEP__',
      apiKey: creds?.apiKey ? String(creds.apiKey).trim() : '__KEEP__',
    };
    if (creds?.fastModel) patch.fastModel = String(creds.fastModel).trim();
    if (creds?.smartModel) patch.smartModel = String(creds.smartModel).trim();

    // Verify credentials against the remote/local provider before persisting
    const testRes = await endpoint.testConnection(patch);
    storage.saveSettings({ ...patch, signedIn: true });
    endpoint.resetSession();
    return { ok: true, connection: testRes, settings: storage.publicSettings() };
  });

  ipcMain.handle('auth:logout', () => {
    storage.saveSettings({ signedIn: false, password: '', apiKey: '' });
    endpoint.resetSession();
    return { ok: true, settings: storage.publicSettings() };
  });

  ipcMain.handle('providers:presets', () => ({
    presets: endpoint.PROVIDER_PRESETS,
    defaultUrl: 'https://max.fyreflysystems.de',
  }));
  ipcMain.handle('providers:list', () => ({
    providers: storage.publicProviders(),
    presets: endpoint.PROVIDER_PRESETS,
  }));
  ipcMain.handle('providers:save', (_, prof) => {
    const saved = storage.saveProviderProfile(prof || {});
    return { ok: true, id: saved.id, providers: storage.publicProviders() };
  });
  ipcMain.handle('providers:delete', (_, id) => {
    const ok = storage.deleteProviderProfile(id);
    return { ok, providers: storage.publicProviders() };
  });
  ipcMain.handle('providers:activate', (_, id) => {
    storage.activateProviderProfile(id);
    endpoint.resetSession();
    return { ok: true, settings: storage.publicSettings(), providers: storage.publicProviders() };
  });
  ipcMain.handle('providers:refresh', async (_, id) => {
    const raw = storage.listSavedProviders().find((x) => x.id === id);
    if (!raw) throw new Error('Provider not found');
    const r = await endpoint.testConnection({
      endpointType: raw.endpointType,
      endpointUrl: raw.endpointUrl,
      username: raw.username,
      password: raw.password,
      apiKey: raw.apiKey,
    });
    storage.saveProviderProfile({ ...raw, password: '__KEEP__', apiKey: '__KEEP__', models: r.models });
    return { ok: true, found: r.models.length, latencyMs: r.latencyMs, models: r.models, providers: storage.publicProviders() };
  });

  // ---- Token Usage Statistics & 2-Tier Limits (no reset allowed to protect limits)
  ipcMain.handle('usage:get', () => storage.getUsageStats());

  // ---- Artifact Save & External Preview
  ipcMain.handle('artifact:save', async (_, art) => {
    const extMap = { html: 'html', htm: 'html', svg: 'svg', jsx: 'jsx', tsx: 'tsx', react: 'jsx', mermaid: 'mmd' };
    const ext = extMap[String(art?.lang || '').toLowerCase()] || 'html';
    const slug = String(art?.title || 'artifact').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'artifact';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Artifact',
      defaultPath: path.join(localFiles.getWorkspace(), `${slug}.${ext}`),
      filters: [{ name: `${ext.toUpperCase()} Artifact`, extensions: [ext] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    fs.writeFileSync(res.filePath, String(art?.code || ''), 'utf8');
    return { canceled: false, filePath: res.filePath };
  });
  ipcMain.handle('artifact:openBrowser', async (_, htmlDoc) => {
    const tmpPath = path.join(os.tmpdir(), `mx-cowork-artifact-${Date.now()}.html`);
    fs.writeFileSync(tmpPath, String(htmlDoc || ''), 'utf8');
    await shell.openPath(tmpPath);
    return { ok: true, tmpPath };
  });

  // ---- Built-in GitHub Release Updater (Gimel-style)
  ipcMain.handle('updater:check', async (_, opts) => {
    const s = storage.getSettings();
    return updater.checkForUpdate({
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      force: Boolean(opts?.force),
      repo: s.updateRepo || updater.DEFAULT_UPDATE_REPO,
    });
  });

  ipcMain.handle('updater:apply', async (event) => {
    const s = storage.getSettings();
    return updater.applyUpdate({
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      repo: s.updateRepo || updater.DEFAULT_UPDATE_REPO,
      onProgress: (p) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('updater:progress', p);
        }
      },
      relaunchFn: (execPath, exitOnly = false) => {
        if (!exitOnly) {
          app.relaunch(execPath ? { execPath } : undefined);
        }
        app.exit(0);
      },
      revealFn: (filePath) => shell.showItemInFolder(filePath),
      openExternalFn: (url) => shell.openExternal(url),
    });
  });

  // ---- Native OS Dialogs & Shell
  ipcMain.handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Local Workspace Folder',
      defaultPath: localFiles.getWorkspace(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths?.length) return { canceled: true };
    const chosen = res.filePaths[0];
    storage.saveSettings({ workspace: chosen });
    return { canceled: false, workspace: chosen, settings: storage.publicSettings() };
  });

  ipcMain.handle('shell:openExternal', async (_, url) => {
    if (/^(https?|mailto):/i.test(String(url || ''))) {
      await shell.openExternal(String(url));
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('shell:revealFile', async (_, relPath) => {
    const target = localFiles.resolveSafe(relPath || '');
    shell.showItemInFolder(target.abs);
    return { ok: true };
  });

  ipcMain.handle('shell:openFile', async (_, relPath) => {
    const target = localFiles.resolveSafe(relPath || '');
    const err = await shell.openPath(target.abs);
    if (err) throw new Error(err);
    return { ok: true };
  });

  // ---- First-Class Projects & Per-Project Workspace Settings
  ipcMain.handle('projects:list', () => ({
    projects: storage.listProjects(),
    activeProject: storage.getActiveProject(),
  }));

  ipcMain.handle('projects:pickPath', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Project Folder',
      defaultPath: localFiles.getWorkspace(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths?.length) return { canceled: true };
    const chosen = res.filePaths[0];
    return { canceled: false, path: chosen, suggestedName: path.basename(chosen) || 'Project' };
  });

  ipcMain.handle('projects:save', (_, payload) => {
    const activate = payload?.activate !== false;
    const project = storage.saveProject(payload || {});
    let activeProject = storage.getActiveProject();
    if (activate || activeProject?.id === project.id) {
      activeProject = storage.setActiveProject(project.id);
    }
    return {
      ok: true,
      project,
      projects: storage.listProjects(),
      activeProject,
      settings: storage.publicSettings(),
    };
  });

  ipcMain.handle('projects:select', (_, id) => {
    const activeProject = storage.setActiveProject(id);
    const cachedGraph = storage.getProjectGraphCache(activeProject.id);
    return {
      ok: true,
      activeProject,
      projects: storage.listProjects(),
      settings: storage.publicSettings(),
      cachedGraph,
    };
  });

  ipcMain.handle('projects:delete', (_, id) => {
    const ok = storage.deleteProject(id);
    return {
      ok,
      projects: storage.listProjects(),
      activeProject: storage.getActiveProject(),
      settings: storage.publicSettings(),
    };
  });

  ipcMain.handle('projects:toggleAutoAccept', (_, value) => {
    const active = storage.getActiveProject();
    if (active) {
      const updated = storage.saveProject({ ...active, autoAcceptEdits: Boolean(value) });
      storage.saveSettings({ autoApproveFileActions: Boolean(value) });
      return { ok: true, autoAcceptEdits: Boolean(value), activeProject: updated, settings: storage.publicSettings() };
    }
    storage.saveSettings({ autoApproveFileActions: Boolean(value) });
    return { ok: true, autoAcceptEdits: Boolean(value), activeProject: null, settings: storage.publicSettings() };
  });

  // ---- Chats
  ipcMain.handle('chats:list', () => ({ chats: storage.listChats() }));
  ipcMain.handle('chats:get', (_, id) => {
    const chat = storage.getChat(id);
    if (!chat) throw new Error('Chat not found');
    return { chat };
  });
  ipcMain.handle('chats:create', (_, opts) => ({
    chat: storage.createChat({
      title: opts?.title || 'New coworker session',
      mode: opts?.mode || storage.getSettings().defaultMode,
    }),
  }));
  ipcMain.handle('chats:delete', (_, id) => {
    const ac = ACTIVE_RUNS.get(id);
    if (ac) ac.abort();
    return { ok: storage.deleteChat(id) };
  });

  // ---- Streaming Cowork Turn (Fast / Smart / Copilot) over native Electron IPC
  ipcMain.handle('cowork:stop', (_, chatId) => {
    const ac = ACTIVE_RUNS.get(chatId);
    if (ac) ac.abort();
    return { ok: true };
  });

  ipcMain.handle('cowork:run', async (event, payload) => {
    const prompt = String(payload?.prompt || '').trim();
    if (!prompt) throw new Error('Prompt is required');

    const streamId = String(payload?.streamId || storage.newId('str'));
    const mode = ['fast', 'smart', 'copilot', 'copilot_b'].includes(payload?.mode) ? payload.mode : storage.getSettings().defaultMode;
    const think = ['off', 'low', 'medium', 'high'].includes(payload?.think) ? payload.think : storage.getSettings().think;

    let chat = payload?.chatId ? storage.getChat(payload.chatId) : null;
    if (!chat) {
      chat = storage.createChat({
        title: prompt.slice(0, 56) + (prompt.length > 56 ? '…' : ''),
        mode,
        projectId: payload?.projectId !== undefined ? String(payload.projectId || '') : (storage.getSettings().activeProjectId || ''),
      });
    }
    if (chat.messages.length === 0) {
      chat.title = prompt.slice(0, 56) + (prompt.length > 56 ? '…' : '');
    }
    chat.mode = mode;

    const userMsg = { id: storage.newId('u'), role: 'user', content: prompt, ts: Date.now() };
    const priorHistory = chat.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    chat.messages.push(userMsg);
    storage.saveChat(chat);

    const emit = (evName, data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('cowork:event', { streamId, event: evName, data });
      }
    };

    const controller = new AbortController();
    ACTIVE_RUNS.set(chat.id, controller);
    emit('chat', { chat: { id: chat.id, title: chat.title, mode: chat.mode, projectId: chat.projectId || '' }, userMessage: userMsg });

    try {
      const result = await copilot.runCoworkTurn({
        mode,
        chatId: chat.id,
        chatTitle: chat.title,
        prompt,
        history: priorHistory,
        pinnedFiles: Array.isArray(payload?.pinnedFiles) ? payload.pinnedFiles : [],
        images: Array.isArray(payload?.images) ? payload.images : [],
        activeContext: payload?.activeContext || null,
        piiShieldOverride: payload?.piiShield,
        toolOverrides: payload?.toolOverrides || {},
        think,
        signal: controller.signal,
        onEvent: emit,
      });

      if (result.savedNotes?.length) {
        for (const n of result.savedNotes) {
          storage.saveNote(n);
        }
        emit('notes_saved', result.savedNotes);
      }

      if (result.savedTasks?.length) {
        const added = [];
        for (const t of result.savedTasks) {
          const sv = storage.saveTask({ ...t, source: chat.title || 'Chat' });
          if (sv) added.push(sv);
        }
        if (added.length) emit('tasks_saved', added);
      }

      const activeProj = storage.getActiveProject();
      const autoAcceptEdits = activeProj ? Boolean(activeProj.autoAcceptEdits) : Boolean(storage.getSettings().autoApproveFileActions);
      const autoRunContainer = activeProj ? Boolean(activeProj.autoRunContainer) : Boolean(storage.getSettings().autoApproveContainerRuns);

      if (result.fileActions?.length && autoAcceptEdits) {
        for (const act of result.fileActions) {
          try {
            const r = await localFiles.executeFileAction(act);
            act.status = 'applied';
            act.result = r.summary;
            act.undoId = r.undoId;
          } catch (e) {
            act.status = 'error';
            act.result = e.message;
          }
        }
        emit('file_actions', result.fileActions);
      }

      if (result.tableEdits?.length && autoAcceptEdits) {
        for (const te of result.tableEdits) {
          try {
            const parsed = await localFiles.parseTableFile(te.path);
            const sIdx = Math.max(0, Math.min((parsed.sheets?.length || 1) - 1, Number(te.sheetIndex) || 0));
            const sheetRows = parsed.sheets?.[sIdx]?.rows || parsed.rows || [];
            const { rows: nextRows, applied } = officeExport.applyTableOperations(sheetRows, te.operations || []);
            const saved = await localFiles.saveTableFile({
              path: te.path,
              rows: nextRows,
              sheets: parsed.sheets,
              sheetIndex: sIdx,
              delimiter: parsed.delimiter,
            });
            te.status = 'applied';
            te.appliedCount = applied.length;
            te.undoId = saved.undoId;
            te.result = `Applied ${applied.length} edit(s) to ${te.path}`;
          } catch (e) {
            te.status = 'error';
            te.result = e.message;
          }
        }
        emit('table_edits', result.tableEdits);
      }

      if (result.codeRuns?.length && autoRunContainer) {
        for (const cr of result.codeRuns) {
          try {
            cr.status = 'running';
            emit('code_runs', result.codeRuns);
            const r = await containerRunner.runInContainer({
              runId: cr.id,
              title: cr.title,
              language: cr.language,
              code: cr.code,
              command: cr.command,
              image: cr.image,
              network: cr.network,
              mountMode: cr.mountMode,
              execTarget: cr.execTarget || storage.getSettings().codeExecutionTarget || 'container',
              onOutput: (o) => {
                if (!event.sender.isDestroyed()) event.sender.send('container:output', o);
              },
            });
            cr.status = r.ok ? 'done' : 'error';
            cr.exitCode = r.exitCode;
            cr.elapsedMs = r.elapsedMs;
            cr.output = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
          } catch (e) {
            cr.status = 'error';
            cr.output = e.message;
          }
        }
        emit('code_runs', result.codeRuns);
      }

      const assistantMsg = {
        id: storage.newId('a'),
        role: 'assistant',
        content: result.content,
        thinking: result.thinking || '',
        mode: result.mode,
        model: result.model,
        usage: result.usage,
        plan: result.plan,
        workers: result.workers,
        sources: result.sources,
        fileActions: result.fileActions || [],
        tableEdits: result.tableEdits || [],
        codeRuns: result.codeRuns || [],
        shieldSummary: result.shieldSummary || null,
        ts: Date.now(),
      };
      chat.messages.push(assistantMsg);
      storage.saveChat(chat);

      emit('done', {
        chat: { id: chat.id, title: chat.title, mode: chat.mode, updated: chat.updated },
        message: assistantMsg,
      });
      return { ok: true, chatId: chat.id };
    } catch (err) {
      if (err.name === 'AbortError') {
        emit('stopped', { ok: true });
        return { ok: false, stopped: true };
      }
      emit('error', { message: err.message || 'Cowork request failed' });
      return { ok: false, error: err.message };
    } finally {
      if (ACTIVE_RUNS.get(chat.id) === controller) ACTIVE_RUNS.delete(chat.id);
    }
  });

  // ---- Local OS Files, Navigation, Search, Editor & Undo
  ipcMain.handle('files:navigateOs', (_, targetPath) => {
    const nextWs = localFiles.navigateOsFolder(targetPath);
    return { workspace: nextWs, settings: storage.publicSettings() };
  });
  ipcMain.handle('files:pickFiles', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach Local Files to Chat',
      defaultPath: localFiles.getWorkspace(),
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled || !res.filePaths?.length) return { canceled: true, pinned: [] };
    const root = localFiles.getWorkspace();
    const pinned = [];
    let switchedWorkspace = null;
    for (const abs of res.filePaths) {
      let rel = path.relative(root, path.resolve(abs));
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        // Switch workspace to the chosen file's parent folder so Cowork can access it cleanly
        const parentDir = path.dirname(path.resolve(abs));
        storage.saveSettings({ workspace: parentDir });
        switchedWorkspace = parentDir;
        rel = path.basename(abs);
      }
      pinned.push(rel.replace(/\\/g, '/'));
    }
    return {
      canceled: false,
      pinned,
      switchedWorkspace,
      settings: storage.publicSettings(),
    };
  });
  ipcMain.handle('files:list', (_, relPath) => localFiles.listDir(relPath || ''));
  ipcMain.handle('files:read', async (_, relPath) => {
    const target = localFiles.resolveSafe(relPath || '');
    const content = await localFiles.readTextContent(target.abs, 80000);
    return { path: target.rel, content };
  });
  ipcMain.handle('files:readForEdit', (_, relPath) => localFiles.readFileForEdit(relPath || ''));
  ipcMain.handle('files:write', (_, opts) => localFiles.executeFileAction({
    type: 'write',
    path: opts?.path,
    content: opts?.content ?? '',
  }));
  ipcMain.handle('files:mkdir', (_, relPath) => localFiles.executeFileAction({ type: 'mkdir', path: relPath }));
  ipcMain.handle('files:rename', (_, opts) => localFiles.executeFileAction({ type: 'rename', from: opts?.from, to: opts?.to }));
  ipcMain.handle('files:delete', (_, relPath) => localFiles.executeFileAction({ type: 'delete', path: relPath }));
  ipcMain.handle('files:search', (_, opts) => localFiles.searchFiles(opts || {}));
  ipcMain.handle('files:overview', (_, relPath) => localFiles.folderOverview(relPath || ''));
  ipcMain.handle('files:action', (_, action) => localFiles.executeFileAction(action));
  ipcMain.handle('files:undoList', () => ({ history: storage.listUndo() }));
  ipcMain.handle('files:undo', (_, id) => localFiles.undoFileAction(id));
  ipcMain.handle('files:pinDropped', (_, absPaths) => {
    const root = localFiles.getWorkspace();
    const pinned = [];
    for (const p of absPaths || []) {
      const rel = path.relative(root, path.resolve(String(p)));
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        pinned.push(rel.replace(/\\/g, '/'));
      }
    }
    return { pinned };
  });

  // ---- Container Code Execution Sandbox (Docker / Podman)
  ipcMain.handle('container:status', (_, opts) => containerRunner.detectRuntimes(Boolean(opts?.force)));
  ipcMain.handle('container:history', () => ({ runs: storage.listContainerRuns() }));
  ipcMain.handle('container:stop', (_, runId) => containerRunner.stopContainerRun(runId));
  ipcMain.handle('container:run', async (event, opts) => {
    return containerRunner.runInContainer({
      ...(opts || {}),
      onOutput: (chunk) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('container:output', chunk);
        }
      },
    });
  });

  // ---- Interactive Project Knowledge Graph (Structural + Fast Model Mapping)
  ipcMain.handle('graph:getCached', (_, projectId) => {
    const active = projectId ? storage.getProject(projectId) : storage.getActiveProject();
    if (!active) return { graph: null };
    return { graph: storage.getProjectGraphCache(active.id) };
  });
  ipcMain.handle('graph:build', (_, opts) => knowledgeGraph.buildProjectGraph(localFiles.getWorkspace(), opts || {}));
  ipcMain.handle('graph:mapFast', async (event, opts) => {
    const graph = await knowledgeGraph.mapProjectWithFastModel({
      projectId: opts?.projectId || '',
      workspace: opts?.workspace || '',
      useFastModel: opts?.useFastModel !== false,
      onProgress: (p) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('graph:progress', p);
        }
      },
    });
    return {
      graph,
      projects: storage.listProjects(),
      activeProject: storage.getActiveProject(),
    };
  });
  ipcMain.handle('graph:summarize', async () => {
    const active = storage.getActiveProject();
    const graph = (active && storage.getProjectGraphCache(active.id)) || await knowledgeGraph.buildProjectGraph(localFiles.getWorkspace());
    const summaryText = knowledgeGraph.summarizeGraphForAI(graph);
    const res = await endpoint.chatCompletion({
      tier: 'fast',
      systemPrompt: 'You are a concise software architect. Given a project knowledge graph summary, produce a crisp 5-bullet architectural overview highlighting entrypoints, core hubs, dependencies, and any risks.',
      messages: [{ role: 'user', content: summaryText }],
      think: 'off',
      priority: 'fast',
    });
    return { ok: true, summary: res.content, stats: graph.stats };
  });

  // ---- Research Desk
  ipcMain.handle('research:search', async (_, query) => {
    const [results, wiki] = await Promise.all([
      research.webSearch(query, 8).catch(() => []),
      research.wikiLookup(query, 'en').catch(() => null),
    ]);
    return { query, results, wiki };
  });
  ipcMain.handle('research:list', () => ({ briefs: storage.listResearch() }));
  ipcMain.handle('research:save', (_, brief) => ({ brief: storage.saveResearch(brief) }));
  ipcMain.handle('research:delete', (_, id) => ({ ok: storage.deleteResearch(id) }));
  ipcMain.handle('research:exportMd', async (_, brief) => {
    const slug = String(brief?.title || 'research-brief').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'research-brief';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Research Brief as Markdown',
      defaultPath: path.join(localFiles.getWorkspace(), `${slug}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    fs.writeFileSync(res.filePath, `# ${brief?.title || 'Research Brief'}\n\n${brief?.markdown || ''}\n`, 'utf8');
    return { canceled: false, filePath: res.filePath };
  });

  // ---- Local Copilot Tools & Persistent Memory Notes
  ipcMain.handle('notes:list', () => ({ notes: storage.listNotes() }));
  ipcMain.handle('notes:save', (_, note) => ({ note: storage.saveNote(note || {}) }));
  ipcMain.handle('notes:delete', (_, id) => ({ ok: storage.deleteNote(id) }));
  ipcMain.handle('tools:gitInspect', (_, focus) => localTools.gitInspect(localFiles.getWorkspace(), focus || ''));
  ipcMain.handle('tools:systemInfo', () => localTools.systemInfo(localFiles.getWorkspace()));
  ipcMain.handle('tools:calcJs', (_, code) => localTools.evalSandboxedJs(code));

  // ---- Visual Diff & Side-by-Side Document Compare (v1.6.0)
  ipcMain.handle('diff:compareFiles', (_, { leftPath, rightPath }) => {
    if (!leftPath || !rightPath) throw new Error('Select two files to compare');
    return diffEngine.compareWorkspaceFiles(leftPath, rightPath);
  });
  ipcMain.handle('diff:previewAction', (_, action) => diffEngine.previewFileActionDiff(action));

  // ---- CSV / Excel Table Parser, Live Save & Office Doc Listing (v1.7.0)
  ipcMain.handle('files:parseTable', (_, relPath) => localFiles.parseTableFile(relPath || ''));
  ipcMain.handle('files:saveTable', (_, opts) => localFiles.saveTableFile(opts || {}));
  ipcMain.handle('files:applyTableEdits', async (_, te) => {
    if (!te?.path || !Array.isArray(te.operations)) throw new Error('Invalid table edit payload');
    const parsed = await localFiles.parseTableFile(te.path);
    const sIdx = Math.max(0, Math.min((parsed.sheets?.length || 1) - 1, Number(te.sheetIndex) || 0));
    const sheetRows = parsed.sheets?.[sIdx]?.rows || parsed.rows || [];
    const { rows: nextRows, applied } = officeExport.applyTableOperations(sheetRows, te.operations);
    const saved = await localFiles.saveTableFile({
      path: te.path,
      rows: nextRows,
      sheets: parsed.sheets,
      sheetIndex: sIdx,
      delimiter: parsed.delimiter,
    });
    return { ok: true, rows: nextRows, applied, undoId: saved.undoId, summary: `Applied ${applied.length} edit(s) to ${te.path}` };
  });
  ipcMain.handle('files:officeList', async () => ({ files: await localFiles.listOfficeFiles() }));

  // ---- Real Office & PDF Exports (.docx, .xlsx, .pdf, .ics)
  const slugify = (s, fallback = 'mx-cowork-export') =>
    String(s || fallback).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || fallback;

  ipcMain.handle('export:docx', async (_, { title, markdown }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Word Document (.docx)',
      defaultPath: path.join(localFiles.getWorkspace(), `${slugify(title, 'report')}.docx`),
      filters: [{ name: 'Word Document', extensions: ['docx'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    const buf = officeExport.buildDocxBuffer(markdown || '', title || 'mx-Cowork Document');
    fs.writeFileSync(res.filePath, buf);
    return { canceled: false, filePath: res.filePath };
  });

  ipcMain.handle('export:xlsx', async (_, { title, markdown, sheets }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Excel Workbook (.xlsx)',
      defaultPath: path.join(localFiles.getWorkspace(), `${slugify(title, 'spreadsheet')}.xlsx`),
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    const finalSheets = Array.isArray(sheets) && sheets.length
      ? sheets
      : officeExport.extractTablesFromMarkdown(markdown || '');
    const buf = officeExport.buildXlsxBuffer(finalSheets);
    fs.writeFileSync(res.filePath, buf);
    return { canceled: false, filePath: res.filePath };
  });

  ipcMain.handle('export:pdf', async (_, { title, markdown, html }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export PDF Document',
      defaultPath: path.join(localFiles.getWorkspace(), `${slugify(title, 'document')}.pdf`),
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    const docHtml = html || officeExport.buildPrintableHtml(markdown || '', title || 'mx-Cowork Report');
    const tmpHtml = path.join(os.tmpdir(), `mx-cowork-pdf-${Date.now()}.html`);
    fs.writeFileSync(tmpHtml, docHtml, 'utf8');
    const printWin = new BrowserWindow({
      show: false,
      width: 960,
      height: 1200,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    try {
      await printWin.loadFile(tmpHtml);
      await new Promise((r) => setTimeout(r, 250));
      const pdfBuf = await printWin.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      });
      fs.writeFileSync(res.filePath, pdfBuf);
      return { canceled: false, filePath: res.filePath };
    } finally {
      if (!printWin.isDestroyed()) printWin.destroy();
      try { fs.unlinkSync(tmpHtml); } catch {}
    }
  });

  ipcMain.handle('export:ics', async (_, evt) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Calendar Invite (.ics)',
      defaultPath: path.join(localFiles.getWorkspace(), `${slugify(evt?.title, 'follow-up')}.ics`),
      filters: [{ name: 'Calendar Invite', extensions: ['ics'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    const ics = officeExport.buildIcsText(evt || {});
    fs.writeFileSync(res.filePath, ics, 'utf8');
    return { canceled: false, filePath: res.filePath };
  });

  // ---- Reusable Slash Workflows Library
  ipcMain.handle('workflows:list', () => ({ workflows: storage.listWorkflows() }));
  ipcMain.handle('workflows:save', (_, wf) => ({ workflow: storage.saveWorkflow(wf || {}), workflows: storage.listWorkflows() }));
  ipcMain.handle('workflows:delete', (_, id) => ({ ok: storage.deleteWorkflow(id), workflows: storage.listWorkflows() }));

  // ---- Project Action Items / Tasks
  ipcMain.handle('tasks:list', () => ({ tasks: storage.listTasks(storage.getSettings().activeProjectId || '') }));
  ipcMain.handle('tasks:save', (_, task) => ({ task: storage.saveTask(task || {}), tasks: storage.listTasks(storage.getSettings().activeProjectId || '') }));
  ipcMain.handle('tasks:toggle', (_, id) => ({ task: storage.toggleTask(id), tasks: storage.listTasks(storage.getSettings().activeProjectId || '') }));
  ipcMain.handle('tasks:delete', (_, id) => ({ ok: storage.deleteTask(id), tasks: storage.listTasks(storage.getSettings().activeProjectId || '') }));

  // ---- Drag & Drop Project / Chat Organization (v1.6.0)
  ipcMain.handle('chats:moveToProject', (_, { chatId, projectId }) => {
    const c = storage.moveChatToProject(chatId, projectId || '');
    return { ok: Boolean(c), chat: c, chats: storage.listChats() };
  });
  ipcMain.handle('projects:reorder', (_, orderedIds) => {
    const projects = storage.reorderProjects(Array.isArray(orderedIds) ? orderedIds : []);
    return { ok: true, projects };
  });
  ipcMain.handle('projects:createFromPath', (_, folderPath) => {
    const abs = path.resolve(String(folderPath || ''));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error('Dropped item is not a local folder');
    }
    const saved = storage.saveProject({ name: path.basename(abs) || 'Project', path: abs, autoMapGraph: true });
    storage.setActiveProject(saved.id);
    return {
      ok: true,
      project: saved,
      projects: storage.listProjects(),
      activeProject: storage.getActiveProject(),
      settings: storage.publicSettings(),
    };
  });

  // ---- Private Document Knowledge Base (Local Semantic BM25 Search)
  ipcMain.handle('kb:stats', () => docIndex.getIndexStats(localFiles.getWorkspace()));
  ipcMain.handle('kb:index', async (event) => {
    return docIndex.indexWorkspaceDocs(localFiles.getWorkspace(), {
      onProgress: (p) => {
        if (!event.sender.isDestroyed()) event.sender.send('kb:progress', p);
      },
    });
  });
  ipcMain.handle('kb:query', (_, { query, topK }) => docIndex.queryWorkspaceDocs(query || '', localFiles.getWorkspace(), { topK: topK || 6, autoBuild: true }));

  // ---- Local Scheduled Automations & Folder Watchers
  ipcMain.handle('automations:list', () => ({ automations: automations.listAutomations() }));
  ipcMain.handle('automations:save', (_, rule) => ({ automation: automations.saveAutomation(rule || {}), automations: automations.listAutomations() }));
  ipcMain.handle('automations:toggle', (_, id) => ({ automation: automations.toggleAutomation(id), automations: automations.listAutomations() }));
  ipcMain.handle('automations:delete', (_, id) => ({ ok: automations.deleteAutomation(id), automations: automations.listAutomations() }));
  ipcMain.handle('automations:runNow', (_, id) => automations.executeAutomation(id, 'Manual run'));

  // ---- OS Clipboard Read (Text + Screenshot Image)
  ipcMain.handle('clipboard:read', () => {
    const text = clipboard.readText() || '';
    const img = clipboard.readImage();
    let image = null;
    if (img && !img.isEmpty()) {
      const png = img.toPNG();
      if (png.length && png.length <= 8 * 1024 * 1024) {
        image = { mimeType: 'image/png', data: png.toString('base64'), name: `clipboard-${Date.now()}.png` };
      }
    }
    return { text, image };
  });
}

function showAndFocusWindow(quickAsk = false) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (quickAsk) {
    const text = (clipboard.readText() || '').trim();
    sendMenuAction('quick-ask-clipboard', { text: text.slice(0, 8000) });
  }
}

function setupTrayAndHotkey() {
  if (process.argv.includes('--self-test')) return;
  // System Tray
  try {
    const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
    if (fs.existsSync(iconPath) && !appTray) {
      const trayImg = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
      appTray = new Tray(trayImg);
      appTray.setToolTip('mx-Cowork — Local AI Copilot (Alt+Space Quick Ask)');
      appTray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Show mx-Cowork', click: () => showAndFocusWindow(false) },
        { label: 'Quick Ask Clipboard (Alt+Space)', click: () => showAndFocusWindow(true) },
        { type: 'separator' },
        { label: 'New Task', click: () => { showAndFocusWindow(false); sendMenuAction('new-task'); } },
        { label: 'Compare 2 Files…', click: () => { showAndFocusWindow(false); sendMenuAction('open-compare'); } },
        { label: 'Settings…', click: () => { showAndFocusWindow(false); sendMenuAction('open-settings'); } },
        { type: 'separator' },
        { label: 'Quit mx-Cowork', click: () => app.quit() },
      ]));
      appTray.on('click', () => showAndFocusWindow(false));
    }
  } catch {}

  // Global Quick-Ask Shortcut (Alt+Space default)
  try {
    if (registeredHotkey) {
      globalShortcut.unregister(registeredHotkey);
      registeredHotkey = '';
    }
    const hotkey = String(storage.getSettings().globalHotkey || 'Alt+Space').trim();
    if (hotkey) {
      const ok = globalShortcut.register(hotkey, () => showAndFocusWindow(true));
      if (ok) registeredHotkey = hotkey;
    }
  } catch {}
}

app.whenReady().then(() => {
  buildAppMenu();
  registerIpc();
  createWindow();
  setupTrayAndHotkey();

  if (!process.argv.includes('--self-test')) {
    automations.initScheduler(
      (rule, fullPrompt) => copilot.runCoworkTurn({
        mode: rule.mode || 'fast',
        chatTitle: `[Auto] ${rule.name}`,
        prompt: fullPrompt,
        think: 'off',
        onEvent: () => {},
      }),
      (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('automations:event', info);
        }
      }
    );
  }

  if (process.argv.includes('--self-test')) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const check = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const info = await window.cowork.appInfo();
            const set = await window.cowork.getSettings();
            const presets = await window.cowork.getProviderPresets();
            const upd = await window.cowork.checkUpdate({ force: false });
            const wfs = await window.cowork.listWorkflows();
            return {
              hasApi: typeof window.cowork === 'object',
              app: info.app,
              version: info.version,
              title: document.title,
              modes: [...document.querySelectorAll('#modeSeg button')].map(b => b.dataset.mode),
              defaultEndpoint: set.settings.endpointUrl,
              endpointType: set.settings.endpointType,
              providerCount: (presets.presets || []).length,
              hasLoginScreen: Boolean(document.querySelector('#loginScreen')),
              hasFileEditor: Boolean(document.querySelector('#fileEditorView')),
              hasOsNav: typeof window.cowork.navigateOs === 'function' && typeof window.cowork.writeFile === 'function',
              hasContainerApi: typeof window.cowork.runInContainer === 'function' && Boolean(document.querySelector('[data-pane="container"]')),
              hasGraphApi: typeof window.cowork.mapGraphFast === 'function' && Boolean(document.querySelector('#graphCanvas')),
              hasProjectsApi: typeof window.cowork.listProjects === 'function' && Boolean(document.querySelector('#projectsList')),
              hasAutoEditPill: Boolean(document.querySelector('#autoAcceptTopPill')),
              hasArtifactCanvas: Boolean(document.querySelector('[data-pane="artifact"]')),
              hasUsageApi: typeof window.cowork.getUsage === 'function',
              hasDiffApi: typeof window.cowork.compareFiles === 'function' && Boolean(document.querySelector('#compareModal')),
              hasExportApi: typeof window.cowork.exportDocx === 'function' && typeof window.cowork.exportXlsx === 'function' && typeof window.cowork.exportPdf === 'function' && typeof window.cowork.exportIcs === 'function',
              hasWorkflowsApi: (wfs.workflows || []).length >= 8,
              hasTasksApi: typeof window.cowork.listTasks === 'function' && Boolean(document.querySelector('#tasksList')),
              hasPiiShield: Boolean(document.querySelector('#shieldToggleBtn')),
              hasKbApi: typeof window.cowork.queryKb === 'function',
              hasAutomationsApi: typeof window.cowork.listAutomations === 'function',
              hasMoveChatApi: typeof window.cowork.moveChatToProject === 'function',
              hasUsageResetDisabled: typeof window.cowork.resetUsage === 'undefined',
              hasLiveCursorApi: typeof window.cowork.saveTableFile === 'function' && Boolean(document.querySelector('#copilotCursor')),
              hasPreSendQueue: Boolean(document.querySelector('#queuedBar')),
              hasOfficeStrip: Boolean(document.querySelector('#officeQuickBar')),
              hasUpdateBtn: Boolean(document.querySelector('#openUpdatesBtn')),
              hasUpdateModal: Boolean(document.querySelector('#updatesModal')),
              updaterOk: upd.ok,
              latestTag: upd.latestTag || null,
              workspace: set.settings.workspace,
            };
          })()
        `);
        console.log('SELF_TEST_OK:' + JSON.stringify(check));
        app.exit(0);
      } catch (e) {
        console.error('SELF_TEST_FAIL:', e);
        app.exit(1);
      }
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
  try { automations.stopAllSchedulers(); } catch {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
