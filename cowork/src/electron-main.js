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

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const storage = require('./storage');
const endpoint = require('./endpoint');
const localFiles = require('./local-files');
const research = require('./research');
const emailMod = require('./email');
const copilot = require('./copilot');

const ACTIVE_RUNS = new Map(); // chatId -> AbortController
let mainWindow = null;

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
    backgroundColor: storage.getSettings().theme === 'dark' ? '#0f1218' : '#f6f7f9',
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
    const mode = ['fast', 'smart', 'copilot'].includes(payload?.mode) ? payload.mode : storage.getSettings().defaultMode;
    const think = ['off', 'low', 'medium', 'high'].includes(payload?.think) ? payload.think : storage.getSettings().think;

    let chat = payload?.chatId ? storage.getChat(payload.chatId) : null;
    if (!chat) {
      chat = storage.createChat({
        title: prompt.slice(0, 56) + (prompt.length > 56 ? '…' : ''),
        mode,
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
    emit('chat', { chat: { id: chat.id, title: chat.title, mode: chat.mode }, userMessage: userMsg });

    try {
      const result = await copilot.runCoworkTurn({
        mode,
        prompt,
        history: priorHistory,
        pinnedFiles: Array.isArray(payload?.pinnedFiles) ? payload.pinnedFiles : [],
        activeDraft: payload?.activeDraft || null,
        think,
        signal: controller.signal,
        onEvent: emit,
      });

      let savedDraft = null;
      if (result.emailDraft) {
        savedDraft = storage.saveDraft(result.emailDraft);
        emit('email_draft_saved', savedDraft);
      }

      if (result.fileActions?.length && storage.getSettings().autoApproveFileActions) {
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
        emailDraft: savedDraft || result.emailDraft || null,
        fileActions: result.fileActions || [],
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

  // ---- Local Files & Undo
  ipcMain.handle('files:list', (_, relPath) => localFiles.listDir(relPath || ''));
  ipcMain.handle('files:read', async (_, relPath) => {
    const target = localFiles.resolveSafe(relPath || '');
    const content = await localFiles.readTextContent(target.abs, 80000);
    return { path: target.rel, content };
  });
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

  // ---- Email Studio
  ipcMain.handle('email:list', () => ({ drafts: storage.listDrafts() }));
  ipcMain.handle('email:save', (_, draft) => ({ draft: storage.saveDraft(draft) }));
  ipcMain.handle('email:delete', (_, id) => ({ ok: storage.deleteDraft(id) }));
  ipcMain.handle('email:refine', (_, opts) => emailMod.refineDraft(opts || {}));
  ipcMain.handle('email:saveEml', async (_, draft) => {
    const fname = (String(draft?.subject || 'draft').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48) || 'draft') + '.eml';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Email Draft (.eml)',
      defaultPath: path.join(localFiles.getWorkspace(), fname),
      filters: [{ name: 'Email Message (.eml)', extensions: ['eml'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    fs.writeFileSync(res.filePath, emailMod.toEml(draft || {}), 'utf8');
    return { canceled: false, filePath: res.filePath };
  });
  ipcMain.handle('email:openEml', async (_, draft) => {
    const fname = `mx-cowork-${Date.now()}.eml`;
    const tmpPath = path.join(os.tmpdir(), fname);
    fs.writeFileSync(tmpPath, emailMod.toEml(draft || {}), 'utf8');
    const err = await shell.openPath(tmpPath);
    if (err) {
      // Fallback to mailto:
      const u = `mailto:${encodeURIComponent(draft?.to || '')}?cc=${encodeURIComponent(draft?.cc || '')}&subject=${encodeURIComponent(draft?.subject || '')}&body=${encodeURIComponent(draft?.body || '')}`;
      await shell.openExternal(u);
    }
    return { ok: true, tmpPath };
  });
}

app.whenReady().then(() => {
  buildAppMenu();
  registerIpc();
  createWindow();

  if (process.argv.includes('--self-test')) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const check = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const info = await window.cowork.appInfo();
            const set = await window.cowork.getSettings();
            return {
              hasApi: typeof window.cowork === 'object',
              app: info.app,
              version: info.version,
              title: document.title,
              modes: [...document.querySelectorAll('#modeSeg button')].map(b => b.dataset.mode),
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
