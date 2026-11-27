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
let statusCache = null;
let statusCacheAt = 0;

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
  timeoutSec = 0,
  memoryMb = 0,
  cpus = '',
  workspace = '',
  onOutput,
} = {}) {
  const cfg = storage.getSettings();
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

async function stopContainerRun(runId) {
  const entry = ACTIVE_CONTAINERS.get(runId);
  if (!entry) return { ok: false };
  entry.markStopped?.();
  try {
    await execFileAsync(entry.runtime, ['rm', '-f', entry.cname], 4000);
  } catch {}
  try { entry.child.kill('SIGKILL'); } catch {}
  ACTIVE_CONTAINERS.delete(runId);
  return { ok: true };
}

module.exports = {
  IMAGE_PRESETS,
  detectRuntimes,
  defaultImageForLanguage,
  runInContainer,
  stopContainerRun,
};
