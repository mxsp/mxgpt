'use strict';

/**
 * GitHub Release Auto-Updater for mx-Cowork (inspired by mxsp/gimel updater.py).
 *
 * - Queries GitHub Releases API (default: mxsp/mxgpt) with a 5-minute TTL cache
 * - Compares semantic versions cleanly (handles v-prefix & prereleases)
 * - Verifies downloaded binaries against SHA256SUMS.txt before applying
 * - Full Auto-Install & Auto-Restart on every platform:
 *     * Linux AppImage: atomic swap + clean-env detached relaunch
 *     * Linux .deb:     native pkexec apt-get install + detached relaunch
 *     * Windows zip:    robocopy/PowerShell swap (with UAC elevation fallback) + auto-relaunch
 *     * Git checkout:   git pull --ff-only + Electron app relaunch
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const DEFAULT_UPDATE_REPO = process.env.MX_COWORK_UPDATE_REPO || 'mxsp/mxgpt';
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedResult = null;
let cachedAt = 0;
let cachedKey = '';

function parseSemver(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-.](.+))?$/i);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || '',
  };
}

function isNewerVersion(current, candidate) {
  const a = parseSemver(current);
  const b = parseSemver(candidate);
  if (!a || !b) {
    const ca = String(current || '').replace(/^v/i, '').trim();
    const cb = String(candidate || '').replace(/^v/i, '').trim();
    return Boolean(cb && ca && cb !== ca);
  }
  if (b.major !== a.major) return b.major > a.major;
  if (b.minor !== a.minor) return b.minor > a.minor;
  if (b.patch !== a.patch) return b.patch > a.patch;
  if (a.pre && !b.pre) return true;
  if (!a.pre && b.pre) return false;
  return b.pre > a.pre;
}

function findGitRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function detectInstallKind({ isPackaged = false } = {}) {
  if (process.env.APPIMAGE) return 'appimage';
  if (isPackaged) {
    if (process.platform === 'win32') return 'win-portable';
    if (process.platform === 'linux') return 'deb';
    return 'release';
  }
  if (findGitRoot(__dirname)) return 'git';
  return 'release';
}

function selectPlatformAsset(assets, installKind) {
  const list = Array.isArray(assets) ? assets : [];
  const byName = (re) => list.find((a) => re.test(String(a.name || '')));

  if (installKind === 'appimage') return byName(/\.AppImage$/i) || null;
  if (installKind === 'deb') return byName(/\.deb$/i) || byName(/\.AppImage$/i) || null;
  if (installKind === 'win-portable') {
    return byName(/win[-_]?x64\.zip$/i) || byName(/win\.zip$/i) || byName(/\.exe$/i) || null;
  }
  if (process.platform === 'win32') return byName(/win[-_]?x64\.zip$/i) || byName(/\.exe$/i) || null;
  if (process.platform === 'linux') return byName(/\.AppImage$/i) || byName(/\.deb$/i) || null;
  return null;
}

function findChecksumsAsset(assets) {
  return (assets || []).find((a) => /^SHA256SUMS(\.txt)?$/i.test(String(a.name || ''))) || null;
}

function spawnDetachedLinuxRestart(execPath) {
  const cleanEnv = { ...process.env };
  // Clear AppImage FUSE mount variables so the new binary mounts cleanly
  delete cleanEnv.APPIMAGE;
  delete cleanEnv.APPDIR;
  delete cleanEnv.ARGV0;
  delete cleanEnv.OWD;

  const child = spawn(
    '/bin/sh',
    ['-c', 'sleep 1.2; nohup "$1" >/dev/null 2>&1 &', '_', execPath],
    {
      detached: true,
      stdio: 'ignore',
      env: cleanEnv,
    }
  );
  child.unref();
}

function runCommandAsync(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => resolve({ code: -1, stdout: out, stderr: e.message }));
    child.on('close', (code) => resolve({ code: typeof code === 'number' ? code : -1, stdout: out, stderr: err }));
  });
}

function isDirWritable(dir) {
  try {
    const probe = path.join(dir, `.mx-upd-probe-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

async function checkForUpdate({
  currentVersion = '1.0.0',
  isPackaged = false,
  force = false,
  repo = DEFAULT_UPDATE_REPO,
} = {}) {
  const installKind = detectInstallKind({ isPackaged });
  const key = `${repo}|${currentVersion}|${installKind}`;
  const now = Date.now();

  if (!force && cachedResult && cachedKey === key && now - cachedAt < CACHE_TTL_MS) {
    return { ...cachedResult, cached: true };
  }

  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const res = await fetch(apiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `mx-Cowork/${currentVersion}`,
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) {
      const txt = (await res.text().catch(() => '')).slice(0, 200);
      return {
        ok: false,
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        installKind,
        canAutoApply: false,
        repo,
        releaseUrl: `https://github.com/${repo}/releases`,
        checkedAt: now,
        cached: false,
        error: `GitHub API HTTP ${res.status}${txt ? ': ' + txt : ''}`,
      };
    }

    const rel = await res.json();
    const latestTag = String(rel.tag_name || '').trim();
    const latestVersion = latestTag.replace(/^v/i, '') || currentVersion;
    const updateAvailable = isNewerVersion(currentVersion, latestVersion);
    const assetObj = selectPlatformAsset(rel.assets, installKind);
    const sumsObj = findChecksumsAsset(rel.assets);

    const canAutoApply = Boolean(
      updateAvailable &&
      (installKind === 'git' ||
        ((installKind === 'appimage' || installKind === 'win-portable' || installKind === 'deb') && assetObj))
    );

    const result = {
      ok: true,
      currentVersion,
      latestVersion,
      latestTag: latestTag || `v${latestVersion}`,
      updateAvailable,
      installKind,
      canAutoApply,
      repo,
      releaseName: rel.name || latestTag || `v${latestVersion}`,
      releaseNotes: String(rel.body || '').trim(),
      releaseUrl: rel.html_url || `https://github.com/${repo}/releases/latest`,
      publishedAt: rel.published_at || '',
      asset: assetObj
        ? {
            name: assetObj.name,
            url: assetObj.browser_download_url,
            size: assetObj.size || 0,
          }
        : null,
      checksumsUrl: sumsObj ? sumsObj.browser_download_url : null,
      checkedAt: now,
      cached: false,
    };

    cachedResult = result;
    cachedAt = now;
    cachedKey = key;
    return result;
  } catch (err) {
    return {
      ok: false,
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      installKind,
      canAutoApply: false,
      repo,
      releaseUrl: `https://github.com/${repo}/releases`,
      checkedAt: now,
      cached: false,
      error: err.message || 'Could not reach GitHub Releases',
    };
  }
}

async function downloadFileWithProgress(url, destPath, { currentVersion, expectedSize, onProgress }) {
  const res = await fetch(url, {
    headers: { 'User-Agent': `mx-Cowork/${currentVersion}` },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);

  const total = Number(res.headers.get('content-length')) || expectedSize || 0;
  const out = fs.createWriteStream(destPath);
  const hash = crypto.createHash('sha256');
  const reader = res.body.getReader();
  let downloaded = 0;
  let lastEmit = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      hash.update(buf);
      if (!out.write(buf)) {
        await new Promise((r) => out.once('drain', r));
      }
      downloaded += buf.length;
      const now = Date.now();
      if (now - lastEmit > 120 || downloaded === total) {
        lastEmit = now;
        const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
        onProgress?.({ phase: 'downloading', downloaded, total, percent });
      }
    }
    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    out.destroy();
    try { fs.unlinkSync(destPath); } catch {}
    throw err;
  }

  return hash.digest('hex');
}

async function verifyAgainstChecksums(checksumsUrl, assetName, actualSha256, currentVersion) {
  if (!checksumsUrl) return { verified: false, reason: 'No SHA256SUMS.txt attached' };
  const res = await fetch(checksumsUrl, {
    headers: { 'User-Agent': `mx-Cowork/${currentVersion}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return { verified: false, reason: `Could not fetch SHA256SUMS.txt (HTTP ${res.status})` };
  const text = await res.text();
  let expected = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!m) continue;
    const fname = path.basename(m[2].trim());
    if (fname === assetName) {
      expected = m[1].toLowerCase();
      break;
    }
  }
  if (!expected) return { verified: false, reason: `${assetName} not listed in SHA256SUMS.txt` };
  if (expected !== actualSha256.toLowerCase()) {
    throw new Error(`SHA-256 verification failed for ${assetName}! Expected ${expected.slice(0, 12)}…, got ${actualSha256.slice(0, 12)}…`);
  }
  return { verified: true, sha256: actualSha256 };
}

async function applyUpdate({
  currentVersion = '1.0.0',
  isPackaged = false,
  repo = DEFAULT_UPDATE_REPO,
  onProgress,
  relaunchFn,
  revealFn,
  openExternalFn,
} = {}) {
  const info = await checkForUpdate({ currentVersion, isPackaged, force: true, repo });
  if (!info.ok) throw new Error(info.error || 'Update check failed');
  if (!info.updateAvailable) {
    return { ok: true, updated: false, message: `Already up to date (v${currentVersion}).` };
  }

  // 1. Git dev checkout -> git pull --ff-only + auto-relaunch
  if (info.installKind === 'git') {
    const gitRoot = findGitRoot(__dirname);
    if (!gitRoot) throw new Error('Git repository root not found');
    onProgress?.({ phase: 'applying', message: 'Pulling latest changes via git…', percent: 60 });
    const out = execFileSync('git', ['pull', '--ff-only'], {
      cwd: gitRoot,
      encoding: 'utf8',
      timeout: 30000,
    }).trim();
    onProgress?.({ phase: 'relaunching', message: 'Restarting mx-Cowork…', percent: 100 });
    if (relaunchFn) {
      setTimeout(() => relaunchFn(null, false), 800);
    }
    return {
      ok: true,
      updated: true,
      relaunching: true,
      version: info.latestVersion,
      message: `${out || 'Git updated'} — restarting mx-Cowork…`,
    };
  }

  if (!info.asset) {
    if (openExternalFn) await openExternalFn(info.releaseUrl);
    return {
      ok: true,
      updated: false,
      openedBrowser: true,
      message: 'No matching binary found for this platform — opened GitHub Releases.',
    };
  }

  // Download to temp location
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-cowork-upd-'));
  const tmpFile = path.join(tmpDir, info.asset.name);

  onProgress?.({ phase: 'downloading', downloaded: 0, total: info.asset.size, percent: 0, message: `Downloading ${info.asset.name}…` });
  const actualSha = await downloadFileWithProgress(info.asset.url, tmpFile, {
    currentVersion,
    expectedSize: info.asset.size,
    onProgress,
  });

  onProgress?.({ phase: 'verifying', percent: 100, message: 'Verifying SHA-256 checksum…' });
  const check = await verifyAgainstChecksums(info.checksumsUrl, info.asset.name, actualSha, currentVersion);

  // 2. Linux AppImage -> atomic swap + clean-env detached auto-restart
  if (info.installKind === 'appimage' && process.env.APPIMAGE) {
    const targetAppImage = process.env.APPIMAGE;
    const stagedPath = `${targetAppImage}.new`;
    onProgress?.({ phase: 'applying', percent: 100, message: 'Installing AppImage update…' });
    fs.copyFileSync(tmpFile, stagedPath);
    fs.chmodSync(stagedPath, 0o755);
    fs.renameSync(stagedPath, targetAppImage);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    onProgress?.({ phase: 'relaunching', percent: 100, message: 'Restarting updated mx-Cowork…' });
    spawnDetachedLinuxRestart(targetAppImage);
    if (relaunchFn) {
      setTimeout(() => relaunchFn(null, true), 650);
    }
    return {
      ok: true,
      updated: true,
      relaunching: true,
      verified: check.verified,
      version: info.latestVersion,
      message: `Installed v${info.latestVersion}${check.verified ? ' (SHA-256 verified)' : ''}. Restarting automatically…`,
    };
  }

  // 3. Windows portable zip -> extract, robocopy swap (with UAC fallback), and auto-restart
  if (info.installKind === 'win-portable' && process.platform === 'win32') {
    const appDir = path.dirname(process.execPath);
    const exeName = path.basename(process.execPath);
    const stageDir = path.join(tmpDir, 'staged');
    fs.mkdirSync(stageDir, { recursive: true });
    onProgress?.({ phase: 'applying', percent: 100, message: 'Extracting Windows update…' });

    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${tmpFile.replace(/'/g, "''")}' -DestinationPath '${stageDir.replace(/'/g, "''")}' -Force`,
      ],
      { timeout: 120000 }
    );

    const needsElevation = !isDirWritable(appDir);
    const psScript = path.join(tmpDir, 'apply-update.ps1');
    const escPs = (p) => String(p).replace(/'/g, "''");
    const scriptBody = [
      `$pidToWait = ${process.pid}`,
      `for ($i = 0; $i -lt 80; $i++) {`,
      `  if (-not (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue)) { break }`,
      `  Start-Sleep -Milliseconds 500`,
      `}`,
      `Start-Sleep -Milliseconds 700`,
      `$src = '${escPs(stageDir)}'`,
      `$dst = '${escPs(appDir)}'`,
      `$exe = '${escPs(exeName)}'`,
      `if (-not (Test-Path (Join-Path $src $exe))) {`,
      `  $sub = Get-ChildItem -LiteralPath $src -Directory | Select-Object -First 1`,
      `  if ($sub -and (Test-Path (Join-Path $sub.FullName $exe))) { $src = $sub.FullName }`,
      `}`,
      `$rc = Start-Process -FilePath 'robocopy.exe' -ArgumentList @($src, $dst, '/E', '/IS', '/IT', '/R:12', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS') -Wait -PassThru -WindowStyle Hidden`,
      `if ($rc.ExitCode -ge 8) {`,
      `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
      `}`,
      `Start-Process -FilePath (Join-Path $dst $exe) -WorkingDirectory $dst`,
      `Start-Sleep -Seconds 2`,
      `Remove-Item -LiteralPath '${escPs(tmpDir)}' -Recurse -Force -ErrorAction SilentlyContinue`,
    ].join('\r\n');
    fs.writeFileSync(psScript, scriptBody, 'utf8');

    onProgress?.({ phase: 'relaunching', percent: 100, message: 'Installing update & restarting mx-Cowork…' });
    if (needsElevation) {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-WindowStyle', 'Hidden',
          '-Command',
          `Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${psScript.replace(/"/g, '""')}"'`,
        ],
        { detached: true, stdio: 'ignore' }
      );
      child.unref();
    } else {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', psScript],
        { detached: true, stdio: 'ignore' }
      );
      child.unref();
    }

    if (relaunchFn) {
      setTimeout(() => relaunchFn(null, true), 650);
    }
    return {
      ok: true,
      updated: true,
      relaunching: true,
      verified: check.verified,
      version: info.latestVersion,
      message: `Installing v${info.latestVersion}${check.verified ? ' (SHA-256 verified)' : ''} and restarting automatically…`,
    };
  }

  // 4. Linux .deb -> automatic graphical pkexec install + detached auto-restart (with Downloads fallback)
  if (info.installKind === 'deb' && info.asset.name.endsWith('.deb')) {
    const hasPkexec = fs.existsSync('/usr/bin/pkexec');
    if (hasPkexec) {
      onProgress?.({ phase: 'applying', percent: 100, message: 'Installing .deb package (confirm OS password prompt)…' });
      const res = await runCommandAsync('/usr/bin/pkexec', [
        'apt-get', 'install', '-y', '--allow-downgrades', tmpFile,
      ]);
      if (res.code === 0) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        const targetBin = fs.existsSync('/opt/mx-Cowork/mx-cowork')
          ? '/opt/mx-Cowork/mx-cowork'
          : process.execPath;
        onProgress?.({ phase: 'relaunching', percent: 100, message: 'Installed! Restarting mx-Cowork…' });
        spawnDetachedLinuxRestart(targetBin);
        if (relaunchFn) {
          setTimeout(() => relaunchFn(null, true), 650);
        }
        return {
          ok: true,
          updated: true,
          relaunching: true,
          verified: check.verified,
          version: info.latestVersion,
          message: `Installed v${info.latestVersion}${check.verified ? ' (SHA-256 verified)' : ''}. Restarting automatically…`,
        };
      }
    }
  }

  // Fallback: move verified package to ~/Downloads, reveal in file manager, show command hint
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  const finalPath = path.join(downloadsDir, info.asset.name);
  fs.copyFileSync(tmpFile, finalPath);
  if (info.asset.name.endsWith('.AppImage')) {
    try { fs.chmodSync(finalPath, 0o755); } catch {}
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  if (revealFn) revealFn(finalPath);
  const commandHint = info.asset.name.endsWith('.deb')
    ? `sudo apt install "${finalPath}"`
    : `"${finalPath}"`;

  onProgress?.({ phase: 'done', percent: 100, message: `Saved to ${finalPath}` });
  return {
    ok: true,
    updated: true,
    manualInstall: true,
    verified: check.verified,
    version: info.latestVersion,
    downloadedPath: finalPath,
    commandHint,
    message: `Downloaded v${info.latestVersion}${check.verified ? ' (SHA-256 verified)' : ''} to Downloads (install cancelled or requires manual sudo).`,
  };
}

module.exports = {
  DEFAULT_UPDATE_REPO,
  parseSemver,
  isNewerVersion,
  detectInstallKind,
  checkForUpdate,
  applyUpdate,
};
