'use strict';

/**
 * Unified Line Diff Engine for mx-Cowork
 *
 * Powers:
 *  - Pre-approval Red/Green Diff previews inside AI file-action cards
 *  - Side-by-side / Unified "Compare 2 Files" (supports code, markdown, CSV, PDF, DOCX, XLSX)
 */

const localFiles = require('./local-files');

function splitLines(text) {
  const s = String(text ?? '');
  if (!s) return [];
  return s.replace(/\r\n/g, '\n').split('\n');
}

/**
 * Computes a clean line-by-line diff with context hunks.
 * Uses exact LCS DP for typical documents (<= 1400 lines) and a fast anchored
 * matching fallback for very large files so the UI never stalls.
 */
function computeLineDiff(beforeText, afterText, { context = 3, maxLines = 1200 } = {}) {
  const aAll = splitLines(beforeText);
  const bAll = splitLines(afterText);
  const truncated = aAll.length > maxLines || bAll.length > maxLines;
  const a = truncated ? aAll.slice(0, maxLines) : aAll;
  const b = truncated ? bAll.slice(0, maxLines) : bAll;

  // Trim common prefix and suffix to keep DP tiny & fast
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const rawOps = [];
  for (let i = 0; i < start; i++) {
    rawOps.push({ type: 'eq', oldLine: i + 1, newLine: i + 1, text: a[i] });
  }

  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);

  if (midA.length === 0) {
    for (let j = 0; j < midB.length; j++) {
      rawOps.push({ type: 'add', oldLine: null, newLine: start + j + 1, text: midB[j] });
    }
  } else if (midB.length === 0) {
    for (let i = 0; i < midA.length; i++) {
      rawOps.push({ type: 'del', oldLine: start + i + 1, newLine: null, text: midA[i] });
    }
  } else if (midA.length * midB.length <= 2_500_000) {
    // Exact LCS DP
    const m = midA.length;
    const n = midB.length;
    const dp = new Uint32Array((m + 1) * (n + 1));
    const stride = n + 1;
    for (let i = m - 1; i >= 0; i--) {
      const row = i * stride;
      const nextRow = (i + 1) * stride;
      for (let j = n - 1; j >= 0; j--) {
        if (midA[i] === midB[j]) {
          dp[row + j] = dp[nextRow + j + 1] + 1;
        } else {
          const down = dp[nextRow + j];
          const right = dp[row + j + 1];
          dp[row + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        rawOps.push({ type: 'eq', oldLine: start + i + 1, newLine: start + j + 1, text: midA[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
        rawOps.push({ type: 'del', oldLine: start + i + 1, newLine: null, text: midA[i] });
        i++;
      } else {
        rawOps.push({ type: 'add', oldLine: null, newLine: start + j + 1, text: midB[j] });
        j++;
      }
    }
    while (i < m) {
      rawOps.push({ type: 'del', oldLine: start + i + 1, newLine: null, text: midA[i] });
      i++;
    }
    while (j < n) {
      rawOps.push({ type: 'add', oldLine: null, newLine: start + j + 1, text: midB[j] });
      j++;
    }
  } else {
    // Fast line-hash greedy alignment for huge changed files
    const bIdx = new Map();
    for (let j = 0; j < midB.length; j++) {
      if (!bIdx.has(midB[j])) bIdx.set(midB[j], []);
      bIdx.get(midB[j]).push(j);
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        rawOps.push({ type: 'eq', oldLine: start + i + 1, newLine: start + j + 1, text: midA[i] });
        i++;
        j++;
      } else {
        const hits = (bIdx.get(midA[i]) || []).filter((pos) => pos >= j && pos <= j + 40);
        if (hits.length) {
          const target = hits[0];
          while (j < target) {
            rawOps.push({ type: 'add', oldLine: null, newLine: start + j + 1, text: midB[j] });
            j++;
          }
        } else {
          rawOps.push({ type: 'del', oldLine: start + i + 1, newLine: null, text: midA[i] });
          i++;
        }
      }
    }
    while (i < midA.length) {
      rawOps.push({ type: 'del', oldLine: start + i + 1, newLine: null, text: midA[i] });
      i++;
    }
    while (j < midB.length) {
      rawOps.push({ type: 'add', oldLine: null, newLine: start + j + 1, text: midB[j] });
      j++;
    }
  }

  for (let k = 0; k < a.length - (endA + 1); k++) {
    rawOps.push({
      type: 'eq',
      oldLine: endA + 2 + k,
      newLine: endB + 2 + k,
      text: a[endA + 1 + k],
    });
  }

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const op of rawOps) {
    if (op.type === 'add') added++;
    else if (op.type === 'del') removed++;
    else unchanged++;
  }

  // Collapse long unchanged regions into compact hunks
  const changedIndices = [];
  for (let idx = 0; idx < rawOps.length; idx++) {
    if (rawOps[idx].type !== 'eq') changedIndices.push(idx);
  }

  const lines = [];
  if (!changedIndices.length) {
    // Identical files — return brief summary
    return {
      identical: true,
      added: 0,
      removed: 0,
      unchanged,
      truncated,
      lines: [],
      unifiedText: '(Files are identical)',
    };
  }

  const keep = new Uint8Array(rawOps.length);
  for (const idx of changedIndices) {
    const lo = Math.max(0, idx - context);
    const hi = Math.min(rawOps.length - 1, idx + context);
    for (let k = lo; k <= hi; k++) keep[k] = 1;
  }

  let skipping = false;
  let skippedCount = 0;
  for (let idx = 0; idx < rawOps.length; idx++) {
    if (keep[idx]) {
      if (skipping) {
        lines.push({ type: 'sep', text: `⋯ ${skippedCount} unchanged line${skippedCount === 1 ? '' : 's'} ⋯` });
        skipping = false;
        skippedCount = 0;
      }
      lines.push(rawOps[idx]);
    } else {
      skipping = true;
      skippedCount++;
    }
  }
  if (skipping) {
    lines.push({ type: 'sep', text: `⋯ ${skippedCount} unchanged line${skippedCount === 1 ? '' : 's'} ⋯` });
  }

  const unifiedText = lines
    .slice(0, 400)
    .map((l) => {
      if (l.type === 'sep') return `@@ ${l.text} @@`;
      if (l.type === 'add') return `+ ${l.text}`;
      if (l.type === 'del') return `- ${l.text}`;
      return `  ${l.text}`;
    })
    .join('\n');

  return {
    identical: false,
    added,
    removed,
    unchanged,
    truncated,
    lines: lines.slice(0, 800),
    unifiedText,
  };
}

async function compareWorkspaceFiles(leftRelPath, rightRelPath) {
  const left = await localFiles.readFileContent(leftRelPath, 160000);
  const right = await localFiles.readFileContent(rightRelPath, 160000);
  const diff = computeLineDiff(left.content || '', right.content || '', { context: 3 });
  return {
    left: { path: left.path, name: left.name, sizeLabel: left.sizeLabel },
    right: { path: right.path, name: right.name, sizeLabel: right.sizeLabel },
    ...diff,
  };
}

async function previewFileActionDiff(action) {
  const type = String(action?.type || '').toLowerCase();
  const relPath = action?.path || action?.to || '';
  if (!relPath || !['write', 'append', 'create'].includes(type)) {
    return null;
  }
  let before = '';
  let exists = false;
  try {
    const cur = await localFiles.readFileContent(relPath, 120000);
    before = cur.content || '';
    exists = true;
  } catch {
    before = '';
    exists = false;
  }
  const after = type === 'append'
    ? (before ? `${before.replace(/\n*$/, '')}\n${String(action.content || '')}` : String(action.content || ''))
    : String(action.content || '');
  const diff = computeLineDiff(before, after, { context: 2 });
  return {
    path: relPath,
    exists,
    ...diff,
  };
}

module.exports = {
  computeLineDiff,
  compareWorkspaceFiles,
  previewFileActionDiff,
};
