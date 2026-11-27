'use strict';

/**
 * Local Scheduled Automations & Folder Watchers for mx-Cowork
 *
 * Examples:
 *  - Folder Watcher: "Whenever a PDF lands in Invoices/, extract vendor/date/amount & append a summary"
 *  - Scheduled Interval: "Every 60 min / daily compile project Git & notes status brief"
 *
 * Runs quietly in the background using the Fast tier (unlimited) by default,
 * saving results into Research Briefs and notifying the desktop UI.
 */

const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const localFiles = require('./local-files');

const AUTO_FILE = path.join(storage.DATA_DIR, 'automations.json');
const ACTIVE_TIMERS = new Map();
const ACTIVE_WATCHERS = new Map();
const DEBOUNCE_MAP = new Map();

let runnerCallback = null;
let eventNotifyCallback = null;

function readAll() {
  try {
    const arr = JSON.parse(fs.readFileSync(AUTO_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAll(arr) {
  fs.mkdirSync(path.dirname(AUTO_FILE), { recursive: true });
  fs.writeFileSync(AUTO_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

function listAutomations() {
  return readAll().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function saveAutomation(rule) {
  const all = readAll();
  const now = Date.now();
  const id = rule.id || storage.newId('auto');
  const existing = all.find((x) => x.id === id);
  const item = {
    id,
    name: String(rule.name || 'Local Automation').trim().slice(0, 90),
    triggerType: rule.triggerType === 'folder_watch' ? 'folder_watch' : 'interval',
    intervalMinutes: Math.max(5, Math.min(10080, Number(rule.intervalMinutes) || 60)),
    watchFolder: String(rule.watchFolder || '').trim(),
    filePattern: String(rule.filePattern || '').trim(), // e.g. ".pdf"
    prompt: String(rule.prompt || '').trim(),
    mode: rule.mode === 'smart' || rule.mode === 'copilot' ? rule.mode : 'fast',
    enabled: rule.enabled !== false,
    projectId: String(rule.projectId ?? existing?.projectId ?? storage.getSettings().activeProjectId ?? ''),
    lastRunAt: existing?.lastRunAt || 0,
    lastStatus: existing?.lastStatus || '',
    runCount: existing?.runCount || 0,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  if (!item.prompt) throw new Error('Automation prompt is required');
  const idx = all.findIndex((x) => x.id === id);
  if (idx >= 0) all[idx] = item;
  else all.unshift(item);
  writeAll(all.slice(0, 50));
  syncSchedulers();
  return item;
}

function toggleAutomation(id) {
  const all = readAll();
  const item = all.find((x) => x.id === id);
  if (!item) return null;
  item.enabled = !item.enabled;
  item.updatedAt = Date.now();
  writeAll(all);
  syncSchedulers();
  return item;
}

function deleteAutomation(id) {
  const all = readAll();
  const next = all.filter((x) => x.id !== id);
  writeAll(next);
  syncSchedulers();
  return next.length !== all.length;
}

async function executeAutomation(id, triggerContext = '') {
  const all = readAll();
  const item = all.find((x) => x.id === id);
  if (!item) throw new Error('Automation not found');
  if (!runnerCallback) throw new Error('Automation runner not initialized');

  const fullPrompt = triggerContext
    ? `[Automated Trigger: ${triggerContext}]\n\n${item.prompt}`
    : item.prompt;

  try {
    const res = await runnerCallback(item, fullPrompt);
    const savedBrief = storage.saveResearch({
      title: `[Auto] ${item.name} (${new Date().toLocaleTimeString()})`,
      query: triggerContext || item.triggerType,
      markdown: res?.content || '(no output)',
      sources: res?.sources || [],
    });
    const fresh = readAll();
    const target = fresh.find((x) => x.id === id);
    if (target) {
      target.lastRunAt = Date.now();
      target.lastStatus = 'ok';
      target.runCount = (target.runCount || 0) + 1;
      writeAll(fresh);
    }
    eventNotifyCallback?.({ type: 'ran', automation: target || item, brief: savedBrief });
    return { ok: true, brief: savedBrief, automation: target || item };
  } catch (err) {
    const fresh = readAll();
    const target = fresh.find((x) => x.id === id);
    if (target) {
      target.lastRunAt = Date.now();
      target.lastStatus = `error: ${err.message}`;
      writeAll(fresh);
    }
    eventNotifyCallback?.({ type: 'error', automation: target || item, error: err.message });
    throw err;
  }
}

function stopAllSchedulers() {
  for (const t of ACTIVE_TIMERS.values()) clearInterval(t);
  ACTIVE_TIMERS.clear();
  for (const w of ACTIVE_WATCHERS.values()) {
    try { w.close(); } catch {}
  }
  ACTIVE_WATCHERS.clear();
}

function syncSchedulers() {
  stopAllSchedulers();
  if (!runnerCallback) return;
  const rules = readAll().filter((r) => r.enabled);
  const ws = localFiles.getWorkspace();

  for (const r of rules) {
    if (r.triggerType === 'interval') {
      const ms = Math.max(5, r.intervalMinutes || 60) * 60 * 1000;
      const timer = setInterval(() => {
        executeAutomation(r.id, `Scheduled every ${r.intervalMinutes}m`).catch(() => {});
      }, ms);
      ACTIVE_TIMERS.set(r.id, timer);
    } else if (r.triggerType === 'folder_watch') {
      try {
        const targetDir = r.watchFolder
          ? (path.isAbsolute(r.watchFolder) ? r.watchFolder : path.join(ws, r.watchFolder))
          : ws;
        if (!fs.existsSync(targetDir)) continue;
        const watcher = fs.watch(targetDir, { persistent: false }, (evType, filename) => {
          if (!filename) return;
          if (r.filePattern && !String(filename).toLowerCase().includes(r.filePattern.toLowerCase())) return;
          const key = `${r.id}:${filename}`;
          clearTimeout(DEBOUNCE_MAP.get(key));
          DEBOUNCE_MAP.set(key, setTimeout(() => {
            DEBOUNCE_MAP.delete(key);
            executeAutomation(r.id, `File ${evType}: ${path.join(r.watchFolder || '.', String(filename))}`).catch(() => {});
          }, 2500));
        });
        ACTIVE_WATCHERS.set(r.id, watcher);
      } catch {}
    }
  }
}

function initScheduler(runFn, onNotify) {
  runnerCallback = runFn;
  eventNotifyCallback = onNotify;
  syncSchedulers();
}

module.exports = {
  listAutomations,
  saveAutomation,
  toggleAutomation,
  deleteAutomation,
  executeAutomation,
  initScheduler,
  stopAllSchedulers,
  syncSchedulers,
};
