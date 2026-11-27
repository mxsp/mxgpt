'use strict';

/**
 * Local Copilot Tools for mx-Cowork:
 *   - gitInspect: read-only local git status, branch, recent commits, diff stat/patch
 *   - systemInfo: OS, CPU, RAM, workspace disk usage, installed dev runtimes
 *   - evalSandboxedJs: safe vm.runInNewContext math / data / regex / date evaluator
 *   - recallNotes: keyword search across persistent local Copilot memory notes
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFile } = require('child_process');
const storage = require('./storage');
const localFiles = require('./local-files');

function execAsync(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: opts.timeout || 5000, cwd: opts.cwd, windowsHide: true, maxBuffer: 512 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
          error: err ? err.message : '',
        });
      }
    );
  });
}

async function gitInspect(workspace = localFiles.getWorkspace(), focus = '') {
  const cwd = path.resolve(workspace);
  const inside = await execAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (!inside.ok || inside.stdout !== 'true') {
    return {
      isRepo: false,
      workspace: cwd,
      text: `Workspace "${cwd}" is not a Git repository.`,
    };
  }

  const [branch, status, log, diffStat, remotes] = await Promise.all([
    execAsync('git', ['branch', '--show-current'], { cwd }),
    execAsync('git', ['status', '--short', '--branch'], { cwd }),
    execAsync('git', ['log', '-n', '15', '--oneline', '--decorate'], { cwd }),
    execAsync('git', ['diff', '--stat'], { cwd }),
    execAsync('git', ['remote', '-v'], { cwd }),
  ]);

  let diffPatch = '';
  if (/\b(diff|patch|change|unstaged|staged|review|commit)\b/i.test(focus || '')) {
    const d = await execAsync('git', ['diff', '--unified=2'], { cwd });
    if (d.ok && d.stdout) diffPatch = d.stdout.slice(0, 6000);
  }

  const parts = [
    `Git Repository: ${cwd}`,
    `Branch: ${branch.stdout || '(detached)'}`,
    remotes.stdout ? `Remotes:\n${remotes.stdout.split('\n').slice(0, 4).join('\n')}` : '',
    `Status:\n${status.stdout || '(clean working tree)'}`,
    diffStat.stdout ? `Unstaged Diff Summary:\n${diffStat.stdout}` : '',
    `Recent Commits:\n${log.stdout || '(no commits)'}`,
    diffPatch ? `Diff Excerpt:\n${diffPatch}` : '',
  ].filter(Boolean);

  return {
    isRepo: true,
    workspace: cwd,
    branch: branch.stdout || '',
    status: status.stdout || '',
    log: log.stdout || '',
    text: parts.join('\n\n'),
  };
}

async function systemInfo(workspace = localFiles.getWorkspace()) {
  const cpus = os.cpus() || [];
  const totalMemGb = (os.totalmem() / 1024 ** 3).toFixed(1);
  const freeMemGb = (os.freemem() / 1024 ** 3).toFixed(1);
  const ws = path.resolve(workspace);

  let diskInfo = '';
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(ws);
      const freeGb = ((st.bavail * st.bsize) / 1024 ** 3).toFixed(1);
      const totalGb = ((st.blocks * st.bsize) / 1024 ** 3).toFixed(1);
      diskInfo = `${freeGb} GB free / ${totalGb} GB total`;
    }
  } catch {}

  const toolChecks = [
    ['node', ['--version']],
    ['python3', ['--version']],
    ['git', ['--version']],
    ['docker', ['--version']],
    ['podman', ['--version']],
    ['go', ['version']],
    ['rustc', ['--version']],
  ];
  const detected = await Promise.all(
    toolChecks.map(async ([name, args]) => {
      const r = await execAsync(name, args, { timeout: 2500 });
      return r.ok ? `${name}: ${r.stdout.split('\n')[0]}` : null;
    })
  );
  const runtimes = detected.filter(Boolean);

  const info = {
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(),
    cpu: `${cpus[0]?.model || 'Unknown CPU'} (${cpus.length} logical cores)`,
    memory: `${freeMemGb} GB free / ${totalMemGb} GB total`,
    workspace: ws,
    disk: diskInfo || 'n/a',
    runtimes,
  };

  const text = [
    `OS: ${info.platform}`,
    `CPU: ${info.cpu}`,
    `RAM: ${info.memory}`,
    `Workspace: ${info.workspace} (Disk: ${info.disk})`,
    `Installed Dev Runtimes:\n${runtimes.length ? runtimes.map((x) => `  - ${x}`).join('\n') : '  (none detected)'}`,
  ].join('\n');

  return { ...info, text };
}

function evalSandboxedJs(code) {
  const src = String(code || '').trim();
  if (!src) throw new Error('Expression/code is required');
  const logs = [];
  const sandbox = Object.create(null);
  sandbox.Math = Math;
  sandbox.Date = Date;
  sandbox.JSON = JSON;
  sandbox.Number = Number;
  sandbox.String = String;
  sandbox.Boolean = Boolean;
  sandbox.Array = Array;
  sandbox.Object = Object;
  sandbox.Map = Map;
  sandbox.Set = Set;
  sandbox.RegExp = RegExp;
  sandbox.parseInt = parseInt;
  sandbox.parseFloat = parseFloat;
  sandbox.isNaN = isNaN;
  sandbox.isFinite = isFinite;
  sandbox.console = {
    log: (...a) => logs.push(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')),
  };

  const ctx = vm.createContext(sandbox);
  const result = vm.runInContext(src, ctx, { timeout: 1500 });
  const resultStr = result === undefined
    ? ''
    : (typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result));

  return {
    ok: true,
    result: resultStr,
    logs,
    text: [
      logs.length ? `Console:\n${logs.join('\n')}` : '',
      resultStr ? `Result: ${resultStr}` : '',
    ].filter(Boolean).join('\n\n') || '(undefined)',
  };
}

function recallNotes(query = '') {
  const hits = storage.searchNotes(query);
  if (!hits.length) return { notes: [], text: 'No matching saved notes found.' };
  const text = hits.slice(0, 12).map((n) =>
    `- [${n.title}]${n.tags?.length ? ` (${n.tags.join(', ')})` : ''}: ${n.content}`
  ).join('\n');
  return { notes: hits, text };
}

module.exports = {
  gitInspect,
  systemInfo,
  evalSandboxedJs,
  recallNotes,
};
