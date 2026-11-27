#!/usr/bin/env node
'use strict';

/**
 * fyre-ollama-queue — Smart CPU-aware multi-request inference scheduler for Ollama.
 *
 * Eliminates cross-model thread contention (e.g., 20-thread Smart + 20-thread Fast
 * thrashing on 20 physical cores) by serializing heavy inference with:
 *   1. Short-job priority lane for Fast (<3B) & subagent requests (with anti-starvation aging)
 *   2. Fair per-user round-robin (via X-Mx-User header) so one user's background chats
 *      never starve other users
 *   3. Instant abort/dequeue when a client cancels while queued
 *   4. Optional NDJSON queue-position heartbeats (when X-Mx-Queue-Events: 1) so the UI
 *      displays live "Queued #N · waiting for <model>" status
 *   5. Direct zero-queue passthrough for metadata routes (/api/tags, /api/ps, /api/version, etc.)
 */

const http = require('http');

const LISTEN_HOST = process.env.QUEUE_HOST || '0.0.0.0';
const LISTEN_PORT = Number(process.env.QUEUE_PORT || 11436);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT || 11434);

// Models considered "fast" (short jobs, 1-5s) eligible for the short-job priority lane
const FAST_MODEL_RE = /^(lfm3|fyre-fast|qwen2\.5:0\.5b|qwen2\.5:1\.5b|qwen3:0\.6b|qwen3:1\.7b|llama3\.2:1b|gemma3:1b|smollm)/i;

// Anti-starvation: after MAX_FAST_STREAK fast jumps, or once a heavy job waits > AGING_MS,
// force the next slot to a heavy job.
const MAX_FAST_STREAK = 2;
const AGING_MS = 12_000;

let active = null;       // { id, user, model, fast, startedAt, abortUpstream }
const queue = [];        // array of pending jobs
let nextJobId = 1;
let fastStreak = 0;
let lastUserServed = '';
const stats = {
  totalCompleted: 0,
  totalAborted: 0,
  totalQueued: 0,
};

function isFastJob(model, priority) {
  if (priority === 'subagent' || priority === 'fast') return true;
  return FAST_MODEL_RE.test(String(model || '').trim());
}

function modelDisplayName(model) {
  const m = String(model || '');
  if (/^inkling-2-mini/i.test(m)) return 'Smart (Inkling 26B)';
  if (/^lfm3/i.test(m)) return 'Fast (LFM3 1.7B)';
  return m.replace(/:latest$/, '') || 'model';
}

function pickNextJobIndex() {
  if (!queue.length) return -1;
  const now = Date.now();

  // Check if any heavy job has aged past AGING_MS or we hit MAX_FAST_STREAK
  const oldestHeavyIdx = queue.findIndex((j) => !j.fast);
  const heavyAged = oldestHeavyIdx >= 0 && (now - queue[oldestHeavyIdx].enqueuedAt >= AGING_MS);
  const mustPickHeavy = oldestHeavyIdx >= 0 && (fastStreak >= MAX_FAST_STREAK || heavyAged);

  const candidates = [];
  for (let i = 0; i < queue.length; i++) {
    const j = queue[i];
    if (mustPickHeavy && j.fast) continue;
    if (!mustPickHeavy && !j.fast && queue.some((x) => x.fast)) continue;
    candidates.push(i);
  }
  const pool = candidates.length ? candidates : queue.map((_, i) => i);

  // Fair per-user round-robin within the chosen priority tier:
  // prefer a user different from lastUserServed if one is waiting.
  if (lastUserServed && pool.length > 1) {
    const otherUser = pool.find((i) => queue[i].user && queue[i].user !== lastUserServed);
    if (otherUser !== undefined) return otherUser;
  }
  return pool[0];
}

function queueSnapshotFor(job) {
  const idx = queue.indexOf(job);
  const position = idx >= 0 ? idx + 1 : 0;
  return {
    position,
    queuedTotal: queue.length,
    runningModel: active ? active.model : '',
    runningLabel: active ? modelDisplayName(active.model) : '',
    runningFast: active ? active.fast : false,
    runningElapsedMs: active ? Date.now() - active.startedAt : 0,
  };
}

function notifyQueuedClients() {
  for (const job of queue) {
    job.emitQueueUpdate();
  }
}

function pump() {
  if (active || !queue.length) return;
  const idx = pickNextJobIndex();
  if (idx < 0) return;
  const [job] = queue.splice(idx, 1);
  if (job.cancelled) {
    pump();
    return;
  }
  if (job.fast) fastStreak++;
  else fastStreak = 0;
  if (job.user) lastUserServed = job.user;

  active = job;
  job.startedAt = Date.now();
  job.stopHeartbeat();
  notifyQueuedClients();
  job.run();
}

function release(job) {
  if (active === job) {
    active = null;
    pump();
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function passthrough(req, res) {
  const headers = { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` };
  delete headers['x-mx-user'];
  delete headers['x-mx-priority'];
  delete headers['x-mx-queue-events'];

  const up = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: req.url,
      method: req.method,
      headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Upstream Ollama error: ${err.message}` }));
    } else {
      try { res.end(); } catch {}
    }
  });
  res.on('close', () => {
    if (!res.writableEnded) up.destroy();
  });
  req.pipe(up);
}

async function handleInference(req, res) {
  let bodyBuf;
  try {
    bodyBuf = await readRawBody(req);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
    return;
  }

  let parsed = null;
  try { parsed = JSON.parse(bodyBuf.toString('utf8')); } catch {}

  // Prewarm / unload calls (empty messages or keep_alive: 0) bypass queue when idle
  const isNoopLoad = parsed && Array.isArray(parsed.messages) && parsed.messages.length === 0;
  const isUnload = parsed && parsed.keep_alive === 0;
  if (isUnload) {
    forwardBuffered(req, res, bodyBuf, null);
    return;
  }

  const model = String(parsed?.model || '');
  const stream = parsed?.stream !== false;
  const user = String(req.headers['x-mx-user'] || 'anon').slice(0, 64);
  const priority = String(req.headers['x-mx-priority'] || '').toLowerCase();
  const wantsQueueEvents = stream && req.headers['x-mx-queue-events'] === '1';
  const fast = isNoopLoad || isFastJob(model, priority);

  const job = {
    id: nextJobId++,
    user,
    model,
    fast,
    enqueuedAt: Date.now(),
    startedAt: 0,
    cancelled: false,
    headersFlushed: false,
    hbTimer: null,
    upReq: null,

    emitQueueUpdate() {
      if (!wantsQueueEvents || this.cancelled || res.writableEnded) return;
      if (!this.headersFlushed) {
        this.headersFlushed = true;
        try {
          res.socket?.setNoDelay?.(true);
          res.writeHead(200, {
            'content-type': 'application/x-ndjson',
            'cache-control': 'no-cache',
            'x-mx-queued': '1',
          });
        } catch {
          return;
        }
      }
      try {
        res.write(JSON.stringify({ _mx_queue: queueSnapshotFor(this) }) + '\n');
      } catch {}
    },

    stopHeartbeat() {
      if (this.hbTimer) {
        clearInterval(this.hbTimer);
        this.hbTimer = null;
      }
    },

    run() {
      if (this.cancelled || res.writableEnded) {
        release(this);
        return;
      }
      // Inform client that it has acquired the execution slot
      if (this.headersFlushed && wantsQueueEvents && !res.writableEnded) {
        try {
          res.write(JSON.stringify({ _mx_queue: { position: 0, acquired: true, model: this.model } }) + '\n');
        } catch {}
      }
      forwardBuffered(req, res, bodyBuf, this);
    },
  };

  res.on('close', () => {
    if (res.writableEnded) return;
    job.cancelled = true;
    job.stopHeartbeat();
    const qi = queue.indexOf(job);
    if (qi >= 0) {
      queue.splice(qi, 1);
      stats.totalAborted++;
      notifyQueuedClients();
    } else if (job.upReq) {
      stats.totalAborted++;
      try { job.upReq.destroy(); } catch {}
    }
  });

  if (!active && queue.length === 0) {
    // Fast path: slot is completely free, zero queueing latency!
    if (job.fast) fastStreak++;
    else fastStreak = 0;
    if (job.user) lastUserServed = job.user;
    active = job;
    job.startedAt = Date.now();
    job.run();
    return;
  }

  // Slot is busy — enqueue cleanly and emit live queue updates
  stats.totalQueued++;
  queue.push(job);
  job.emitQueueUpdate();
  if (wantsQueueEvents) {
    job.hbTimer = setInterval(() => job.emitQueueUpdate(), 1500);
  }
  notifyQueuedClients();
}

function forwardBuffered(req, res, bodyBuf, job) {
  const headers = {
    'content-type': req.headers['content-type'] || 'application/json',
    'content-length': Buffer.byteLength(bodyBuf),
    host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
  };
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    if (job) {
      job.stopHeartbeat();
      stats.totalCompleted++;
      release(job);
    }
  };

  const up = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: req.url,
      method: req.method,
      headers,
    },
    (upRes) => {
      if (job?.cancelled || res.writableEnded) {
        upRes.resume();
        done();
        return;
      }
      if (!job?.headersFlushed) {
        res.socket?.setNoDelay?.(true);
        res.writeHead(upRes.statusCode || 502, upRes.headers);
      } else if ((upRes.statusCode || 200) >= 400) {
        // Headers already flushed as 200 NDJSON while queued -> emit error frame
        const errChunks = [];
        upRes.on('data', (c) => errChunks.push(c));
        upRes.on('end', () => {
          const msg = Buffer.concat(errChunks).toString('utf8').slice(0, 400) || `Ollama HTTP ${upRes.statusCode}`;
          try { res.write(JSON.stringify({ error: msg }) + '\n'); res.end(); } catch {}
          done();
        });
        return;
      }
      upRes.on('data', (chunk) => {
        if (!res.writableEnded) {
          try { res.write(chunk); } catch {}
        }
      });
      upRes.on('end', () => {
        if (!res.writableEnded) {
          try { res.end(); } catch {}
        }
        done();
      });
      upRes.on('error', () => {
        if (!res.writableEnded) {
          try { res.end(); } catch {}
        }
        done();
      });
    },
  );

  if (job) job.upReq = up;
  up.on('error', (err) => {
    if (!res.writableEnded) {
      if (!job?.headersFlushed && !res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `Upstream Ollama error: ${err.message}` }));
      } else {
        try {
          res.write(JSON.stringify({ error: `Upstream Ollama error: ${err.message}` }) + '\n');
          res.end();
        } catch {}
      }
    }
    done();
  });
  up.end(bodyBuf);
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];

  if (pathname === '/_queue/status' && req.method === 'GET') {
    const payload = {
      ok: true,
      active: active
        ? {
            id: active.id,
            user: active.user,
            model: active.model,
            label: modelDisplayName(active.model),
            fast: active.fast,
            elapsedMs: Date.now() - active.startedAt,
          }
        : null,
      queued: queue.map((j, i) => ({
        position: i + 1,
        id: j.id,
        user: j.user,
        model: j.model,
        label: modelDisplayName(j.model),
        fast: j.fast,
        waitMs: Date.now() - j.enqueuedAt,
      })),
      stats,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.method === 'POST' && (pathname === '/api/chat' || pathname === '/api/generate')) {
    handleInference(req, res);
    return;
  }

  passthrough(req, res);
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0; // long streaming responses

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[fyre-ollama-queue] listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
