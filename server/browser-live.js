'use strict';
// Live interactive browser: a real headless Chromium streamed to the client via CDP
// screencast, with mouse / keyboard / wheel / drag input forwarded back.
let playwright = null;
let browser = null;
const sessions = new Map();
const MAX_SESSIONS = 4;
const VIEW_W = 1280, VIEW_H = 800;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (!playwright) playwright = require('playwright');
  browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });
  return browser;
}

function broadcast(s, obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of s.subs) { try { res.write(line); } catch {} }
}

async function pushNav(s) {
  try {
    const url = s.page.url();
    const title = await s.page.title().catch(() => '');
    s.url = url; s.title = title;
    broadcast(s, { type: 'nav', url, title, canGoBack: true, canGoForward: true });
  } catch {}
}

async function startCast(s) {
  if (s.casting || !s.subs.size) return;
  s.casting = true;
  try {
    await s.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: VIEW_W, maxHeight: VIEW_H, everyNthFrame: 1 });
  } catch { s.casting = false; }
}
async function stopCast(s) {
  if (!s.casting) return;
  s.casting = false;
  try { await s.cdp.send('Page.stopScreencast'); } catch {}
}

async function open(url) {
  const b = await getBrowser();
  // evict oldest idle
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b2) => a.lastUse - b2.lastUse)[0];
    await close(oldest.id).catch(() => {});
  }
  const context = await b.newContext({ viewport: { width: VIEW_W, height: VIEW_H }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const s = { id, page, cdp, context, subs: new Set(), casting: false, url: '', title: '', lastUse: Date.now() };
  sessions.set(id, s);

  cdp.on('Page.screencastFrame', async (params) => {
    s.lastUse = Date.now();
    broadcast(s, { type: 'frame', data: params.data, meta: params.metadata });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }); } catch {}
  });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) pushNav(s); });
  page.on('close', () => close(id).catch(() => {}));

  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
  await pushNav(s);
  return { session: id, url: s.url, title: s.title, width: VIEW_W, height: VIEW_H };
}

function get(id) { return sessions.get(id) || null; }

async function subscribe(id, res) {
  const s = get(id);
  if (!s) return false;
  s.subs.add(res);
  s.lastUse = Date.now();
  res.on('close', () => { s.subs.delete(res); if (!s.subs.size) stopCast(s); });
  await startCast(s);
  // send current nav immediately
  try { res.write(`data: ${JSON.stringify({ type: 'nav', url: s.url, title: s.title })}\n\n`); } catch {}
  return true;
}

async function navigate(id, url) {
  const s = get(id); if (!s) throw new Error('Browser session expired');
  s.lastUse = Date.now();
  try { await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
  await pushNav(s);
  return { url: s.url, title: s.title };
}
async function back(id) { const s = get(id); if (!s) throw new Error('expired'); await s.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); await pushNav(s); return { url: s.url }; }
async function forward(id) { const s = get(id); if (!s) throw new Error('expired'); await s.page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {}); await pushNav(s); return { url: s.url }; }
async function reload(id) { const s = get(id); if (!s) throw new Error('expired'); await s.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await pushNav(s); return { url: s.url }; }

const KEYCODES = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 };

async function input(id, ev) {
  const s = get(id); if (!s) throw new Error('Browser session expired');
  s.lastUse = Date.now();
  const c = s.cdp;
  if (ev.kind === 'mouse') {
    const base = { x: Math.round(ev.x), y: Math.round(ev.y), modifiers: ev.modifiers || 0 };
    if (ev.action === 'wheel') {
      await c.send('Input.dispatchMouseEvent', { ...base, type: 'mouseWheel', deltaX: ev.deltaX || 0, deltaY: ev.deltaY || 0 });
    } else if (ev.action === 'down') {
      await c.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', button: ev.button || 'left', buttons: ev.buttons ?? 1, clickCount: ev.clickCount || 1 });
    } else if (ev.action === 'up') {
      await c.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', button: ev.button || 'left', buttons: 0, clickCount: ev.clickCount || 1 });
    } else {
      await c.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: ev.button || 'none', buttons: ev.buttons ?? 0 });
    }
  } else if (ev.kind === 'key') {
    const code = ev.code || '';
    const keyCode = KEYCODES[ev.key] || (ev.key && ev.key.length === 1 ? ev.key.toUpperCase().charCodeAt(0) : 0);
    if (ev.action === 'char') {
      await c.send('Input.dispatchKeyEvent', { type: 'char', text: ev.text, unmodifiedText: ev.text });
    } else {
      await c.send('Input.dispatchKeyEvent', {
        type: ev.action === 'down' ? 'keyDown' : 'keyUp',
        key: ev.key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
        text: ev.action === 'down' && ev.text ? ev.text : undefined,
        modifiers: ev.modifiers || 0,
      });
    }
  } else if (ev.kind === 'text') {
    await c.send('Input.insertText', { text: ev.text });
  }
  return { ok: true };
}

async function close(id) {
  const s = get(id); if (!s) return;
  sessions.delete(id);
  for (const res of s.subs) { try { res.end(); } catch {} }
  await stopCast(s);
  await s.context.close().catch(() => {});
}

module.exports = { open, get, subscribe, navigate, back, forward, reload, input, close, VIEW_W, VIEW_H };
