'use strict';

/**
 * Isolated Container Code Execution Engine for mx-Cowork (Linux & Windows).
 *
 * - Auto-detects Docker or Podman on the host machine
 * - Executes Python, Node.js, or Shell commands inside hardened ephemeral containers
 *   mounted to the active local workspace (/workspace)
 * - Security defaults: --cap-drop=ALL, --security-opt=no-new-privileges,
 *   --pids-limit=256, --network=none (configurable), memory/CPU limits, timeout,
 *   and explicit user approval before execution unless Auto-Run is enabled
 * - Streams live stdout/stderr over Electron IPC and supports instant Kill/Stop
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const localFiles = require('./local-files');

const IMAGE_PRESETS = [
  { id: 'python:3.12-slim', label: 'Python 3.12', lang: 'python', desc: 'Lightweight Python 3.12 runtime' },
  { id: 'node:22-alpine', label: 'Node.js 22', lang: 'javascript', desc: 'Fast Node.js 22 Alpine runtime' },
  { id: 'ubuntu:24.04', label: 'Ubuntu 24.04', lang: 'bash', desc: 'Full Ubuntu shell environment' },
  { id: 'golang:1.23-alpine', label: 'Go 1.23', lang: 'bash', desc: 'Go toolchain on Alpine Linux' },
  { id: 'rust:1.83-slim', label: 'Rust 1.83', lang: 'bash', desc: 'Rust / Cargo toolchain' },
];

const ACTIVE_CONTAINERS = new Map(); // runId -> { child, runtime, cname }
const ACTIVE_SERVERS = new Map(); // serverId -> { id, title, command, language, cwd, child, pid, startedAt, logs, urls, status, exitCode }
let statusCache = null;
let statusCacheAt = 0;

const HIGH_RISK_PATTERNS = [
  { re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b[^\n]*(\s+\/(\s|$)|\s+~|\s+\$HOME|\s+\*)/i, reason: 'Recursive force-delete on broad path' },
  { re: /\bgit\s+push\b[^\n]*(--force|-f\b)/i, reason: 'Force-pushing Git history' },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: 'Hard-resetting Git working tree' },
  { re: /\b(mkfs|fdisk|parted|dd\s+if=.*of=\/dev\/|wipefs)\b/i, reason: 'Low-level disk/filesystem modification' },
  { re: /\b(Format-Volume|Clear-Disk|Remove-Item\s+[^\n]*-Recurse[^\n]*-Force[^\n]*[A-Z]:\\(\s|$))/i, reason: 'Destructive Windows disk/folder operation' },
  { re: /\b(DROP\s+DATABASE|DROP\s+SCHEMA|TRUNCATE\s+TABLE)\b/i, reason: 'Destructive database command' },
  { re: /\b(shutdown|reboot|poweroff|halt)\b/i, reason: 'System power/shutdown command' },
];

function assessCommandRisk(code = '', command = '') {
  const combined = `${String(code || '')}\n${String(command || '')}`;
  const reasons = [];
  for (const p of HIGH_RISK_PATTERNS) {
    if (p.re.test(combined)) reasons.push(p.reason);
  }
  return {
    highRisk: reasons.length > 0,
    reasons,
  };
}

function execFileAsync(bin, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: err ? err.message : '',
      });
    });
  });
}

async function probeBinary(bin) {
  const ver = await execFileAsync(bin, ['--version'], 4000);
  if (!ver.ok) return { installed: false, running: false, version: '', error: ver.stderr || ver.error };
  const info = await execFileAsync(bin, ['info', '--format', '{{.ServerVersion}}'], 5000);
  return {
    installed: true,
    running: info.ok,
    version: ver.stdout.split('\n')[0] || bin,
    serverVersion: info.ok ? info.stdout.split('\n')[0] : '',
    error: info.ok ? '' : (info.stderr || info.error || `${bin} daemon is not running`),
  };
}

async function detectRuntimes(force = false) {
  const now = Date.now();
  if (!force && statusCache && now - statusCacheAt < 15000) {
    return statusCache;
  }
  const [docker, podman] = await Promise.all([probeBinary('docker'), probeBinary('podman')]);
  const preferred = storage.getSettings().containerRuntime || 'auto';
  let activeRuntime = null;
  if (preferred === 'docker' && docker.running) activeRuntime = 'docker';
  else if (preferred === 'podman' && podman.running) activeRuntime = 'podman';
  else if (docker.running) activeRuntime = 'docker';
  else if (podman.running) activeRuntime = 'podman';

  statusCache = {
    docker,
    podman,
    activeRuntime,
    available: Boolean(activeRuntime),
    presets: IMAGE_PRESETS,
    checkedAt: now,
  };
  statusCacheAt = now;
  return statusCache;
}

function defaultImageForLanguage(lang, fallbackImage) {
  const l = String(lang || '').toLowerCase();
  if (l === 'python' || l === 'py') return 'python:3.12-slim';
  if (l === 'javascript' || l === 'js' || l === 'node' || l === 'ts') return 'node:22-alpine';
  return fallbackImage || 'python:3.12-slim';
}

function resolveCommandSpec(language, code, command) {
  const l = String(language || 'bash').toLowerCase();
  if (command && !code) {
    return { cmd: ['sh', '-s'], stdin: String(command) + '\n' };
  }
  if (l === 'python' || l === 'py') {
    return { cmd: ['python3', '-'], stdin: String(code || command || '') + '\n' };
  }
  if (l === 'javascript' || l === 'js' || l === 'node') {
    return { cmd: ['node', '-'], stdin: String(code || command || '') + '\n' };
  }
  return { cmd: ['sh', '-s'], stdin: String(code || command || '') + '\n' };
}

function sanitizeImageName(img) {
  const clean = String(img || '').trim();
  if (!/^[a-zA-Z0-9._:/@-]{2,128}$/.test(clean)) {
    throw new Error(`Invalid container image name: ${clean}`);
  }
  return clean;
}

async function runInContainer({
  runId = storage.newId('crun'),
  title = '',
  language = 'python',
  code = '',
  command = '',
  image = '',
  network = '',
  mountMode = '',
  execTarget = '',
  timeoutSec = 0,
  memoryMb = 0,
  cpus = '',
  workspace = '',
  cwd = '',
  onOutput,
} = {}) {
  const cfg = storage.getSettings();
  const target = execTarget || cfg.codeExecutionTarget || 'container';
  if (target === 'host') {
    return runOnHost({
      runId,
      title,
      language,
      code,
      command,
      timeoutSec,
      workspace,
      cwd,
      onOutput,
    });
  }
  const status = await detectRuntimes(false);
  const runtime = status.activeRuntime;

  if (!runtime) {
    const detail = status.docker.installed
      ? `Docker is installed (${status.docker.version}) but the daemon is not running or permission is denied.`
      : status.podman.installed
        ? `Podman is installed (${status.podman.version}) but not ready.`
        : 'Neither Docker nor Podman was found on this computer. Install Docker Desktop (Windows/Linux) or Podman to execute code in containers.';
    throw new Error(detail);
  }

  const ws = path.resolve(workspace || localFiles.getWorkspace());
  const chosenImage = sanitizeImageName(image || cfg.containerImage || defaultImageForLanguage(language, cfg.containerImage));
  const netMode = (network || cfg.containerNetwork || 'none') === 'bridge' ? 'bridge' : 'none';
  const mMode = (mountMode || cfg.containerMountMode || 'rw') === 'ro' ? 'ro' : 'rw';
  const maxTime = Math.max(5, Math.min(180, Number(timeoutSec || cfg.containerTimeoutSec || 30)));
  const memMb = Math.max(128, Math.min(8192, Number(memoryMb || cfg.containerMemoryMb || 1024)));
  const cpuLimit = String(cpus || cfg.containerCpus || '2').replace(/[^0-9.]/g, '') || '2';

  const cname = `mx-cowork-${runId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const spec = resolveCommandSpec(language, code, command);

  const args = [
    'run',
    '--rm',
    '-i',
    '--name', cname,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=256',
    `--memory=${memMb}m`,
    `--cpus=${cpuLimit}`,
    `--network=${netMode}`,
    '-v', `${ws}:/workspace:${mMode}`,
    '-w', '/workspace',
    chosenImage,
    ...spec.cmd,
  ];

  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let stopped = false;
  const MAX_OUT = 120000;

  onOutput?.({
    runId,
    stream: 'meta',
    chunk: `▶ ${runtime} run (${chosenImage} · net=${netMode} · /workspace:${mMode})\n`,
  });

  return new Promise((resolve) => {
    const child = spawn(runtime, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    ACTIVE_CONTAINERS.set(runId, { child, runtime, cname, markStopped: () => { stopped = true; } });

    const timer = setTimeout(() => {
      timedOut = true;
      stopContainerRun(runId).catch(() => {});
    }, maxTime * 1000);

    child.stdout.on('data', (buf) => {
      const chunk = buf.toString('utf8');
      if (stdout.length < MAX_OUT) stdout += chunk.slice(0, MAX_OUT - stdout.length);
      onOutput?.({ runId, stream: 'stdout', chunk });
    });

    child.stderr.on('data', (buf) => {
      const chunk = buf.toString('utf8');
      if (stderr.length < MAX_OUT) stderr += chunk.slice(0, MAX_OUT - stderr.length);
      onOutput?.({ runId, stream: 'stderr', chunk });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      ACTIVE_CONTAINERS.delete(runId);
      const result = {
        runId,
        ok: false,
        exitCode: -1,
        runtime,
        image: chosenImage,
        network: netMode,
        mountMode: mMode,
        language,
        title: title || `${language} container run`,
        code: code || command,
        stdout,
        stderr: (stderr ? stderr + '\n' : '') + err.message,
        timedOut,
        stopped,
        elapsedMs: Date.now() - startedAt,
        workspace: ws,
      };
      storage.pushContainerRun(result);
      resolve(result);
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      ACTIVE_CONTAINERS.delete(runId);
      if (timedOut) {
        stderr += `\n[Timed out after ${maxTime}s — container terminated]`;
      } else if (stopped) {
        stderr += '\n[Stopped by user]';
      }
      const result = {
        runId,
        ok: exitCode === 0 && !timedOut && !stopped,
        exitCode: typeof exitCode === 'number' ? exitCode : -1,
        runtime,
        image: chosenImage,
        network: netMode,
        mountMode: mMode,
        language,
        title: title || `${language} container run`,
        code: code || command,
        stdout,
        stderr,
        timedOut,
        stopped,
        elapsedMs: Date.now() - startedAt,
        workspace: ws,
      };
      storage.pushContainerRun(result);
      resolve(result);
    });

    // Feed code/command cleanly via stdin and close stdin
    try {
      child.stdin.write(spec.stdin);
      child.stdin.end();
    } catch {}
  });
}

function detectWorkspaceVenv(ws) {
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
        path.join(ws, '.venv', 'Scripts', 'python.exe'),
        path.join(ws, 'venv', 'Scripts', 'python.exe'),
      ]
    : [
        path.join(ws, '.venv', 'bin', 'python3'),
        path.join(ws, '.venv', 'bin', 'python'),
        path.join(ws, 'venv', 'bin', 'python3'),
        path.join(ws, 'venv', 'bin', 'python'),
      ];
  for (const py of candidates) {
    if (fs.existsSync(py)) {
      const binDir = path.dirname(py);
      const venvDir = path.dirname(binDir);
      return { pythonBin: py, binDir, venvDir };
    }
  }
  return null;
}

async function runOnHost({
  runId = storage.newId('hrun'),
  title = '',
  language = 'python',
  code = '',
  command = '',
  timeoutSec = 0,
  workspace = '',
  cwd = '',
  onOutput,
} = {}) {
  const cfg = storage.getSettings();
  const ws = path.resolve(workspace || localFiles.getWorkspace());
  let runCwd = ws;
  if (cwd && String(cwd).trim()) {
    try {
      const resolved = localFiles.resolveSafe(String(cwd).trim(), ws);
      if (fs.existsSync(resolved.abs) && fs.statSync(resolved.abs).isDirectory()) {
        runCwd = resolved.abs;
      }
    } catch {}
  }
  const defaultHostTimeout = Math.max(60, Number(cfg.containerTimeoutSec || 60));
  const maxTime = Math.max(5, Math.min(300, Number(timeoutSec || defaultHostTimeout)));
  const l = String(language || 'bash').toLowerCase();
  const isWin = process.platform === 'win32';
  const script = String(code || command || '').trim();
  if (!script) throw new Error('No code or command provided');

  const venv = detectWorkspaceVenv(ws) || (runCwd !== ws ? detectWorkspaceVenv(runCwd) : null);
  const env = { ...process.env };
  if (venv) {
    env.VIRTUAL_ENV = venv.venvDir;
    env.PATH = `${venv.binDir}${path.delimiter}${env.PATH || ''}`;
  }

  let bin;
  let args;
  let stdinPayload = script + '\n';
  if (l === 'python' || l === 'py' || l === 'python3') {
    bin = venv ? venv.pythonBin : (isWin ? 'python' : 'python3');
    args = ['-u', '-'];
  } else if (l === 'javascript' || l === 'js' || l === 'node') {
    bin = 'node';
    args = ['-'];
  } else if (l === 'powershell' || l === 'ps1' || (isWin && (l === 'bash' || l === 'sh' || l === 'shell'))) {
    bin = isWin ? 'powershell.exe' : 'pwsh';
    args = ['-NoProfile', '-NonInteractive', '-Command', script];
    stdinPayload = '';
  } else {
    if (isWin) {
      bin = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-Command', script];
      stdinPayload = '';
    } else {
      bin = 'bash';
      args = ['-s'];
    }
  }

  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let stopped = false;
  const MAX_OUT = 120000;

  const venvNote = venv ? ` · venv=${path.basename(venv.venvDir)}` : '';
  onOutput?.({
    runId,
    stream: 'meta',
    chunk: `▶ HOST (${path.basename(bin)}${venvNote} · cwd=${runCwd})\n`,
  });

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: runCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    ACTIVE_CONTAINERS.set(runId, { child, runtime: 'host', cname: '', markStopped: () => { stopped = true; } });

    const timer = setTimeout(() => {
      timedOut = true;
      stopContainerRun(runId).catch(() => {});
    }, maxTime * 1000);

    child.stdout.on('data', (buf) => {
      const chunk = buf.toString('utf8');
      if (stdout.length < MAX_OUT) stdout += chunk.slice(0, MAX_OUT - stdout.length);
      onOutput?.({ runId, stream: 'stdout', chunk });
    });

    child.stderr.on('data', (buf) => {
      const chunk = buf.toString('utf8');
      if (stderr.length < MAX_OUT) stderr += chunk.slice(0, MAX_OUT - stderr.length);
      onOutput?.({ runId, stream: 'stderr', chunk });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      ACTIVE_CONTAINERS.delete(runId);
      const result = {
        runId,
        ok: false,
        exitCode: -1,
        runtime: 'host',
        execTarget: 'host',
        image: `host:${bin}`,
        network: 'host',
        mountMode: 'rw',
        language: l,
        title: title || `${l} host run`,
        code: script,
        stdout,
        stderr: (stderr ? stderr + '\n' : '') + err.message,
        timedOut,
        stopped,
        elapsedMs: Date.now() - startedAt,
        workspace: ws,
      };
      storage.pushContainerRun(result);
      resolve(result);
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      ACTIVE_CONTAINERS.delete(runId);
      if (timedOut) stderr += `\n[Timed out after ${maxTime}s — process terminated]`;
      else if (stopped) stderr += '\n[Stopped by user]';
      const result = {
        runId,
        ok: exitCode === 0 && !timedOut && !stopped,
        exitCode: typeof exitCode === 'number' ? exitCode : -1,
        runtime: 'host',
        execTarget: 'host',
        image: `host:${bin}`,
        network: 'host',
        mountMode: 'rw',
        language: l,
        title: title || `${l} host run`,
        code: script,
        stdout,
        stderr,
        timedOut,
        stopped,
        elapsedMs: Date.now() - startedAt,
        workspace: ws,
      };
      storage.pushContainerRun(result);
      resolve(result);
    });

    try {
      if (stdinPayload) child.stdin.write(stdinPayload);
      child.stdin.end();
    } catch {}
  });
}

async function stopContainerRun(runId) {
  const entry = ACTIVE_CONTAINERS.get(runId);
  if (!entry) return { ok: false };
  entry.markStopped?.();
  if (entry.runtime && entry.runtime !== 'host' && entry.cname) {
    try {
      await execFileAsync(entry.runtime, ['rm', '-f', entry.cname], 4000);
    } catch {}
  }
  if (entry.runtime === 'host' && process.platform === 'win32' && entry.child?.pid) {
    try {
      await execFileAsync('taskkill', ['/pid', String(entry.child.pid), '/T', '/F'], 4000);
    } catch {}
  }
  try { entry.child.kill('SIGKILL'); } catch {}
  ACTIVE_CONTAINERS.delete(runId);
  return { ok: true };
}

async function startServer({
  serverId = storage.newId('srv'),
  title = '',
  language = 'bash',
  command = '',
  code = '',
  cwd = '',
  workspace = '',
  waitReadyMs = 1800,
  onOutput,
} = {}) {
  const ws = path.resolve(workspace || localFiles.getWorkspace());
  let runCwd = ws;
  if (cwd && String(cwd).trim()) {
    try {
      const resolved = localFiles.resolveSafe(String(cwd).trim(), ws);
      if (fs.existsSync(resolved.abs) && fs.statSync(resolved.abs).isDirectory()) {
        runCwd = resolved.abs;
      }
    } catch {}
  }
  const script = String(command || code || '').trim();
  if (!script) throw new Error('Command or code is required to start a background server');
  const l = String(language || 'bash').toLowerCase();
  const isWin = process.platform === 'win32';
  const venv = detectWorkspaceVenv(ws) || (runCwd !== ws ? detectWorkspaceVenv(runCwd) : null);
  const env = { ...process.env };
  if (venv) {
    env.VIRTUAL_ENV = venv.venvDir;
    env.PATH = `${venv.binDir}${path.delimiter}${env.PATH || ''}`;
  }

  let bin;
  let args;
  let stdinPayload = '';
  if (l === 'python' || l === 'py' || l === 'python3') {
    bin = venv ? venv.pythonBin : (isWin ? 'python' : 'python3');
    args = ['-u', '-'];
    stdinPayload = script + '\n';
  } else if (l === 'javascript' || l === 'js' || l === 'node') {
    bin = 'node';
    args = ['-'];
    stdinPayload = script + '\n';
  } else if (isWin) {
    bin = 'powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-Command', script];
  } else {
    bin = 'bash';
    args = ['-c', script];
  }

  const entry = {
    id: serverId,
    title: String(title || script.slice(0, 60)),
    command: script,
    language: l,
    cwd: runCwd,
    pid: null,
    startedAt: Date.now(),
    status: 'running',
    exitCode: null,
    logs: '',
    urls: [],
    child: null,
  };

  const MAX_LOG = 24000;
  const appendLog = (chunk) => {
    entry.logs += chunk;
    if (entry.logs.length > MAX_LOG) entry.logs = entry.logs.slice(-MAX_LOG);
    for (const m of chunk.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s"'<>)]*/gi)) {
      const u = m[0].replace('0.0.0.0', 'localhost');
      if (!entry.urls.includes(u)) entry.urls.push(u);
    }
    onOutput?.({ runId: serverId, stream: 'stdout', chunk });
  };

  const child = spawn(bin, args, {
    cwd: runCwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !isWin,
  });
  entry.child = child;
  entry.pid = child.pid || null;
  ACTIVE_SERVERS.set(serverId, entry);

  child.stdout.on('data', (b) => appendLog(b.toString('utf8')));
  child.stderr.on('data', (b) => appendLog(b.toString('utf8')));
  child.on('error', (err) => {
    appendLog(`\n[server error: ${err.message}]\n`);
    entry.status = 'error';
  });
  child.on('close', (code) => {
    entry.exitCode = typeof code === 'number' ? code : -1;
    if (entry.status === 'running') entry.status = code === 0 ? 'stopped' : 'error';
  });

  if (stdinPayload) {
    try {
      child.stdin.write(stdinPayload);
      child.stdin.end();
    } catch {}
  }

  // Wait briefly for initial startup logs / listening URL (or early crash)
  const deadline = Date.now() + Math.max(300, Math.min(5000, Number(waitReadyMs) || 1800));
  while (Date.now() < deadline && entry.status === 'running' && entry.urls.length === 0) {
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    ok: entry.status === 'running',
    id: entry.id,
    title: entry.title,
    pid: entry.pid,
    cwd: entry.cwd,
    status: entry.status,
    exitCode: entry.exitCode,
    urls: [...entry.urls],
    logs: entry.logs.slice(-4000),
  };
}

function listServers() {
  return [...ACTIVE_SERVERS.values()].map((s) => ({
    id: s.id,
    title: s.title,
    pid: s.pid,
    cwd: s.cwd,
    status: s.status,
    exitCode: s.exitCode,
    urls: [...s.urls],
    startedAt: s.startedAt,
    logBytes: s.logs.length,
  }));
}

function readServerLogs(serverId, tailChars = 6000) {
  const entry = ACTIVE_SERVERS.get(serverId);
  if (!entry) throw new Error(`Background server not found: ${serverId}`);
  return {
    id: entry.id,
    title: entry.title,
    pid: entry.pid,
    status: entry.status,
    exitCode: entry.exitCode,
    urls: [...entry.urls],
    logs: entry.logs.slice(-Math.max(500, Math.min(20000, Number(tailChars) || 6000))),
  };
}

async function stopServer(serverId) {
  const entry = ACTIVE_SERVERS.get(serverId);
  if (!entry) return { ok: false, error: `Server not found: ${serverId}` };
  entry.status = 'stopped';
  if (entry.child?.pid) {
    if (process.platform === 'win32') {
      try { await execFileAsync('taskkill', ['/pid', String(entry.child.pid), '/T', '/F'], 4000); } catch {}
    } else {
      try { process.kill(-entry.child.pid, 'SIGTERM'); } catch {}
      try { entry.child.kill('SIGKILL'); } catch {}
    }
  }
  return { ok: true, id: serverId, title: entry.title, status: 'stopped' };
}

async function stopAllServers() {
  const ids = [...ACTIVE_SERVERS.keys()];
  for (const id of ids) {
    try { await stopServer(id); } catch {}
  }
  ACTIVE_SERVERS.clear();
}

module.exports = {
  IMAGE_PRESETS,
  detectRuntimes,
  detectWorkspaceVenv,
  assessCommandRisk,
  defaultImageForLanguage,
  runInContainer,
  runOnHost,
  stopContainerRun,
  startServer,
  listServers,
  readServerLogs,
  stopServer,
  stopAllServers,
};
