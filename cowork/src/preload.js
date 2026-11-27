'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cowork', {
  isNativeApp: true,
  platform: process.platform,

  // App & Settings
  appInfo: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  testEndpoint: (cfg) => ipcRenderer.invoke('endpoint:test', cfg),

  // Native OS Dialogs & Shell
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  revealFile: (relPath) => ipcRenderer.invoke('shell:revealFile', relPath),
  openFile: (relPath) => ipcRenderer.invoke('shell:openFile', relPath),

  // Chats & Copilot Streaming
  listChats: () => ipcRenderer.invoke('chats:list'),
  getChat: (id) => ipcRenderer.invoke('chats:get', id),
  createChat: (opts) => ipcRenderer.invoke('chats:create', opts),
  deleteChat: (id) => ipcRenderer.invoke('chats:delete', id),
  runCowork: (payload) => ipcRenderer.invoke('cowork:run', payload),
  stopCowork: (chatId) => ipcRenderer.invoke('cowork:stop', chatId),

  onCoworkEvent: (cb) => {
    const listener = (_, msg) => cb(msg);
    ipcRenderer.on('cowork:event', listener);
    return () => ipcRenderer.removeListener('cowork:event', listener);
  },
  onMenuAction: (cb) => {
    const listener = (_, msg) => cb(msg);
    ipcRenderer.on('cowork:menu', listener);
    return () => ipcRenderer.removeListener('cowork:menu', listener);
  },

  // Local Files & Undo
  listFiles: (relPath) => ipcRenderer.invoke('files:list', relPath),
  readFile: (relPath) => ipcRenderer.invoke('files:read', relPath),
  searchFiles: (opts) => ipcRenderer.invoke('files:search', opts),
  folderOverview: (relPath) => ipcRenderer.invoke('files:overview', relPath),
  executeFileAction: (action) => ipcRenderer.invoke('files:action', action),
  listUndo: () => ipcRenderer.invoke('files:undoList'),
  undoFileAction: (id) => ipcRenderer.invoke('files:undo', id),
  pinDroppedFiles: (files) => {
    const paths = [];
    for (const f of files || []) {
      try {
        const p = webUtils.getPathForFile(f);
        if (p) paths.push(p);
      } catch {}
    }
    return ipcRenderer.invoke('files:pinDropped', paths);
  },

  // Research Desk
  researchSearch: (q) => ipcRenderer.invoke('research:search', q),
  listBriefs: () => ipcRenderer.invoke('research:list'),
  saveBrief: (brief) => ipcRenderer.invoke('research:save', brief),
  deleteBrief: (id) => ipcRenderer.invoke('research:delete', id),
  exportBriefMd: (brief) => ipcRenderer.invoke('research:exportMd', brief),

  // Email Studio
  listDrafts: () => ipcRenderer.invoke('email:list'),
  saveDraft: (draft) => ipcRenderer.invoke('email:save', draft),
  deleteDraft: (id) => ipcRenderer.invoke('email:delete', id),
  refineDraft: (opts) => ipcRenderer.invoke('email:refine', opts),
  saveEml: (draft) => ipcRenderer.invoke('email:saveEml', draft),
  openEmlInMail: (draft) => ipcRenderer.invoke('email:openEml', draft),
});
