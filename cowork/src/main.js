#!/usr/bin/env node
'use strict';

/**
 * mx-Cowork — Local AI Coworker Desktop App (Linux + Windows standalone executable)
 *
 * Launches a local loopback server (127.0.0.1:4318) serving the embedded desktop UI
 * and native OS coworker APIs (Files, Research, Email Studio, Fast/Smart/Copilot),
 * and opens a clean native app window (Edge/Chrome --app mode or default browser).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const storage = require('./storage');
const endpoint = require('./endpoint');
const localFiles = require('./local-files');
const research = require('./research');
const emailMod = require('./email');
const copilot = require('./copilot');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ACTIVE_RUNS = new Map(); // chatId -> AbortController

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function parseCliArgs() {
  const args = process.argv.slice(2);
  const opts = { port: Number(process.env.MX_COWORK_PORT || 4318), noOpen: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-open' || args[i] === '--headless') opts.noOpen = true;
    else if (args[i] === '--port' && args[i + 1]) opts.port = Number(args[++i]);
    else if (args[i].startsWith('--port=')) opts.port = Number(args[i].slice(7));
  }
  return opts;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, reqPath) {
  let clean = reqPath === '/' ? '/index.html' : reqPath;
  clean = clean.replace(/\.\./g, '');
  const full = path.join(PUBLIC_DIR, clean);
  try {
    const content = fs.readFileSync(full);
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

async function handleApi(req, res, urlObj) {
  const pathname = urlObj.pathname;
  const method = req.method || 'GET';

  try {
    // ---- Health & Settings
    if (pathname === '/api/health' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        app: 'mx-cowork',
        version: '1.0.0',
        platform: process.platform,
        dataDir: storage.DATA_DIR,
        workspace: localFiles.getWorkspace(),
      });
    }
    if (pathname === '/api/settings' && method === 'GET') {
      return sendJson(res, 200, {
        settings: storage.publicSettings(),
        quickFolders: localFiles.quickFolders(),
        platform: process.platform,
        dataDir: storage.DATA_DIR,
      });
    }
    if (pathname === '/api/settings' && method === 'POST') {
      const body = await readJsonBody(req);
      storage.saveSettings(body);
      endpoint.resetSession();
      return sendJson(res, 200, { ok: true, settings: storage.publicSettings() });
    }
    if (pathname === '/api/endpoint/test' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = await endpoint.testConnection(body && Object.keys(body).length ? body : null);
      return sendJson(res, 200, result);
    }

    // ---- Chats
    if (pathname === '/api/chats' && method === 'GET') {
      return sendJson(res, 200, { chats: storage.listChats() });
    }
    if (pathname === '/api/chats' && method === 'POST') {
      const body = await readJsonBody(req);
      const chat = storage.createChat({ title: body.title || 'New coworker session', mode: body.mode || storage.getSettings().defaultMode });
      return sendJson(res, 200, { chat });
    }
    const chatMatch = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)$/);
    if (chatMatch) {
      const id = chatMatch[1];
      if (method === 'GET') {
        const c = storage.getChat(id);
        if (!c) return sendJson(res, 404, { error: 'Chat not found' });
        return sendJson(res, 200, { chat: c });
      }
      if (method === 'DELETE') {
        const ac = ACTIVE_RUNS.get(id);
        if (ac) ac.abort();
        return sendJson(res, 200, { ok: storage.deleteChat(id) });
      }
    }

    // ---- Cowork Streaming Chat (Fast / Smart / Copilot)
    if (pathname === '/api/cowork/stop' && method === 'POST') {
      const body = await readJsonBody(req);
      const ac = ACTIVE_RUNS.get(body.chatId);
      if (ac) ac.abort();
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/cowork/chat' && method === 'POST') {
      const body = await readJsonBody(req);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return sendJson(res, 400, { error: 'Prompt is required' });

      const mode = ['fast', 'smart', 'copilot'].includes(body.mode) ? body.mode : storage.getSettings().defaultMode;
      const think = ['off', 'low', 'medium', 'high'].includes(body.think) ? body.think : storage.getSettings().think;

      let chat = body.chatId ? storage.getChat(body.chatId) : null;
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

      try { res.socket?.setNoDelay?.(true); } catch {}
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });

      const emit = (ev, data) => {
        if (res.writableEnded || res.destroyed) return;
        try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
      };

      const controller = new AbortController();
      ACTIVE_RUNS.set(chat.id, controller);
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      emit('chat', { chat: { id: chat.id, title: chat.title, mode: chat.mode }, userMessage: userMsg });

      try {
        const result = await copilot.runCoworkTurn({
          mode,
          prompt,
          history: priorHistory,
          pinnedFiles: Array.isArray(body.pinnedFiles) ? body.pinnedFiles : [],
          activeDraft: body.activeDraft || null,
          think,
          signal: controller.signal,
          onEvent: emit,
        });

        // Auto-save generated email draft so it immediately appears in Email Studio
        let savedDraft = null;
        if (result.emailDraft) {
          savedDraft = storage.saveDraft(result.emailDraft);
          emit('email_draft_saved', savedDraft);
        }

        // Auto-apply file actions only if user explicitly enabled Auto-Approve
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
      } catch (err) {
        if (err.name === 'AbortError') {
          emit('stopped', { ok: true });
        } else {
          emit('error', { message: err.message || 'Cowork request failed' });
        }
      } finally {
        if (ACTIVE_RUNS.get(chat.id) === controller) ACTIVE_RUNS.delete(chat.id);
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // ---- Local Files & File Management
    if (pathname === '/api/files/list' && method === 'GET') {
      const p = urlObj.searchParams.get('path') || '';
      return sendJson(res, 200, await localFiles.listDir(p));
    }
    if (pathname === '/api/files/read' && method === 'GET') {
      const p = urlObj.searchParams.get('path') || '';
      const target = localFiles.resolveSafe(p);
      const text = await localFiles.readTextContent(target.abs, 80000);
      return sendJson(res, 200, { path: target.rel, content: text });
    }
    if (pathname === '/api/files/search' && method === 'GET') {
      const q = urlObj.searchParams.get('q') || '';
      const p = urlObj.searchParams.get('path') || '';
      return sendJson(res, 200, await localFiles.searchFiles({ query: q, relPath: p }));
    }
    if (pathname === '/api/files/overview' && method === 'GET') {
      const p = urlObj.searchParams.get('path') || '';
      return sendJson(res, 200, await localFiles.folderOverview(p));
    }
    if (pathname === '/api/files/action' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = await localFiles.executeFileAction(body);
      return sendJson(res, 200, result);
    }
    if (pathname === '/api/files/undo' && method === 'GET') {
      return sendJson(res, 200, { history: storage.listUndo() });
    }
    if (pathname === '/api/files/undo' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = await localFiles.undoFileAction(body.id);
      return sendJson(res, 200, result);
    }

    // ---- Research Desk
    if (pathname === '/api/research/search' && method === 'GET') {
      const q = urlObj.searchParams.get('q') || '';
      const [results, wiki] = await Promise.all([
        research.webSearch(q, 8).catch(() => []),
        research.wikiLookup(q, 'en').catch(() => null),
      ]);
      return sendJson(res, 200, { query: q, results, wiki });
    }
    if (pathname === '/api/research/briefs' && method === 'GET') {
      return sendJson(res, 200, { briefs: storage.listResearch() });
    }
    if (pathname === '/api/research/briefs' && method === 'POST') {
      const body = await readJsonBody(req);
      const saved = storage.saveResearch(body);
      return sendJson(res, 200, { brief: saved });
    }
    const resMatch = pathname.match(/^\/api\/research\/briefs\/([A-Za-z0-9_-]+)$/);
    if (resMatch && method === 'DELETE') {
      return sendJson(res, 200, { ok: storage.deleteResearch(resMatch[1]) });
    }

    // ---- Email Drafting Studio
    if (pathname === '/api/email/drafts' && method === 'GET') {
      return sendJson(res, 200, { drafts: storage.listDrafts() });
    }
    if (pathname === '/api/email/drafts' && method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { draft: storage.saveDraft(body) });
    }
    const mailMatch = pathname.match(/^\/api\/email\/drafts\/([A-Za-z0-9_-]+)$/);
    if (mailMatch && method === 'DELETE') {
      return sendJson(res, 200, { ok: storage.deleteDraft(mailMatch[1]) });
    }
    if (pathname === '/api/email/refine' && method === 'POST') {
      const body = await readJsonBody(req);
      const refined = await emailMod.refineDraft({
        draft: body.draft || {},
        action: body.action || 'formal',
        customInstruction: body.customInstruction || '',
        tier: body.tier === 'smart' ? 'smart' : 'fast',
      });
      return sendJson(res, 200, { ok: true, ...refined });
    }
    if (pathname === '/api/email/eml' && method === 'POST') {
      const body = await readJsonBody(req);
      const eml = emailMod.toEml(body);
      const fname = (String(body.subject || 'draft').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48) || 'draft') + '.eml';
      res.writeHead(200, {
        'content-type': 'message/rfc822; charset=utf-8',
        'content-disposition': `attachment; filename="${fname}"`,
      });
      return res.end(eml);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'Internal error' });
  }
}

function openDesktopWindow(url) {
  if (process.platform === 'win32') {
    const edgePaths = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ];
    const browser = edgePaths.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (browser) {
      spawn(browser, [`--app=${url}`, '--window-size=1360,860'], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  // Linux: prefer app-mode Chromium/Chrome/Edge, fall back to xdg-open
  const linuxBrowsers = ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  for (const b of linuxBrowsers) {
    try {
      const p = spawn(b, [`--app=${url}`, '--window-size=1360,860'], { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
      return;
    } catch {}
  }
  try {
    const p = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch {}
}

function startServer(port, noOpen) {
  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (urlObj.pathname.startsWith('/api/')) {
      handleApi(req, res, urlObj);
    } else {
      serveStatic(res, urlObj.pathname);
    }
  });

  server.requestTimeout = 0;
  server.headersTimeout = 70000;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < 4400) {
      startServer(port + 1, noOpen);
    } else {
      console.error('[mx-cowork] Server error:', err.message);
      process.exit(1);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log('');
    console.log('  mx-Cowork v1.0.0 — Local AI Coworker (Fast · Smart · Copilot)');
    console.log(`  App URL:   ${url}`);
    console.log(`  Workspace: ${localFiles.getWorkspace()}`);
    console.log(`  Config:    ${storage.DATA_DIR}`);
    console.log('  Press Ctrl+C to quit.');
    console.log('');
    if (!noOpen) openDesktopWindow(url);
  });
}

const cli = parseCliArgs();
startServer(cli.port, cli.noOpen);
