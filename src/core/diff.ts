/**
 * Tree diffing, unified diff formatting, and 3-way merge.
 */

import { ObjectStore } from './objects/store';
import { TreeObject } from './objects/tree';

// ---- Tree comparison -------------------------------------------------------

export interface FileDiff {
  path:    string;
  oldSha:  string | null;   // null = file is new
  newSha:  string | null;   // null = file was deleted
  oldMode: string | null;
  newMode: string | null;
}

/** Recursively flatten a tree to path → {sha, mode}. */
export function flattenTree(
  store: ObjectStore,
  treeSha: string,
  prefix = '',
): Map<string, { sha: string; mode: string }> {
  const result = new Map<string, { sha: string; mode: string }>();
  const tree = TreeObject.read(store, treeSha);
  for (const entry of tree.entries) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '040000' || entry.mode === '40000') {
      for (const [p, v] of flattenTree(store, entry.hash, fullPath)) result.set(p, v);
    } else {
      result.set(fullPath, { sha: entry.hash, mode: entry.mode });
    }
  }
  return result;
}

/** Diff two trees; returns only changed/added/deleted entries. */
export function diffTrees(
  store: ObjectStore,
  oldTreeSha: string | null,
  newTreeSha: string | null,
): FileDiff[] {
  const oldFiles = oldTreeSha
    ? flattenTree(store, oldTreeSha)
    : new Map<string, { sha: string; mode: string }>();
  const newFiles = newTreeSha
    ? flattenTree(store, newTreeSha)
    : new Map<string, { sha: string; mode: string }>();

  const diffs: FileDiff[] = [];
  for (const p of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    const o = oldFiles.get(p) ?? null;
    const n = newFiles.get(p) ?? null;
    if (!o && n)               diffs.push({ path: p, oldSha: null,   newSha: n.sha, oldMode: null,   newMode: n.mode });
    else if (o && !n)          diffs.push({ path: p, oldSha: o.sha,  newSha: null,  oldMode: o.mode, newMode: null   });
    else if (o && n && o.sha !== n.sha) diffs.push({ path: p, oldSha: o.sha, newSha: n.sha, oldMode: o.mode, newMode: n.mode });
  }
  return diffs;
}

// ---- Unified diff ----------------------------------------------------------

interface Edit { type: 'equal' | 'delete' | 'insert'; line: string }
interface Hunk { header: string; lines: string[] }

/** LCS-based line-level diff. */
function diffLines(a: string[], b: string[]): Edit[] {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);

  const edits: Edit[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      edits.unshift({ type: 'equal',  line: a[i-1] }); i--; j--;
    } else if (i > 0 && (j === 0 || dp[i-1][j] >= dp[i][j-1])) {
      edits.unshift({ type: 'delete', line: a[i-1] }); i--;
    } else {
      edits.unshift({ type: 'insert', line: b[j-1] }); j--;
    }
  }
  return edits;
}

function buildHunks(edits: Edit[], ctx: number): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;

  while (i < edits.length) {
    if (edits[i].type === 'equal') { i++; continue; }

    const start = Math.max(0, i - ctx);
    let end = i + 1;

    // Absorb changes within 2*ctx of each other
    while (end < edits.length) {
      if (edits[end].type !== 'equal') { end++; continue; }
      let k = end;
      while (k < edits.length && edits[k].type === 'equal') k++;
      if (k >= edits.length || k - end > 2 * ctx) break;
      end = k;
    }
    const stop = Math.min(edits.length, end + ctx);

    let oldLine = 1, newLine = 1;
    for (let x = 0; x < start; x++) {
      if (edits[x].type !== 'insert') oldLine++;
      if (edits[x].type !== 'delete') newLine++;
    }

    let oldCount = 0, newCount = 0;
    const lines: string[] = [];
    for (let x = start; x < stop; x++) {
      const e = edits[x];
      if (e.type === 'equal')  { lines.push(` ${e.line}`); oldCount++; newCount++; }
      if (e.type === 'delete') { lines.push(`-${e.line}`); oldCount++; }
      if (e.type === 'insert') { lines.push(`+${e.line}`); newCount++; }
    }

    hunks.push({ header: `@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`, lines });
    i = stop;
  }

  return hunks;
}

function splitLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Returns just the hunk body (no --- / +++ header lines). */
export function diffHunks(oldContent: string, newContent: string, ctx = 3): string[] {
  const edits = diffLines(splitLines(oldContent), splitLines(newContent));
  const hunks = buildHunks(edits, ctx);
  const out: string[] = [];
  for (const h of hunks) { out.push(h.header); out.push(...h.lines); }
  return out;
}

/** Full unified diff including --- / +++ header. */
export function unifiedDiff(
  oldContent: string,
  newContent: string,
  oldLabel: string,
  newLabel: string,
  ctx = 3,
): string {
  const hunks = diffHunks(oldContent, newContent, ctx);
  if (hunks.length === 0) return '';
  return [`--- ${oldLabel}`, `+++ ${newLabel}`, ...hunks].join('\n');
}

// ---- 3-way merge -----------------------------------------------------------

interface MergeHunk {
  baseStart: number; // inclusive
  baseEnd:   number; // exclusive
  sideLines: string[];
}

function toMergeHunks(base: string[], side: string[]): MergeHunk[] {
  const edits = diffLines(base, side);
  const hunks: MergeHunk[] = [];
  let baseIdx = 0, i = 0;

  while (i < edits.length) {
    if (edits[i].type === 'equal') { baseIdx++; i++; continue; }
    const hunkStart = baseIdx;
    const sideLines: string[] = [];
    while (i < edits.length && edits[i].type !== 'equal') {
      if (edits[i].type === 'delete') baseIdx++;
      else sideLines.push(edits[i].line);
      i++;
    }
    hunks.push({ baseStart: hunkStart, baseEnd: baseIdx, sideLines });
  }
  return hunks;
}

function applyHunks(baseRegion: string[], hunks: MergeHunk[], offset: number): string[] {
  if (hunks.length === 0) return [...baseRegion];
  const result: string[] = [];
  let i = 0;
  for (const h of hunks) {
    const ls = h.baseStart - offset;
    const le = h.baseEnd   - offset;
    while (i < ls) result.push(baseRegion[i++]);
    result.push(...h.sideLines);
    i = le;
  }
  while (i < baseRegion.length) result.push(baseRegion[i++]);
  return result;
}

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Line-level 3-way merge.
 * Returns merged content and a flag indicating whether conflict markers were inserted.
 */
export function threeWayMerge(
  base:       string,
  ours:       string,
  theirs:     string,
  ourLabel   = 'HEAD',
  theirLabel = 'theirs',
): { result: string; conflicts: boolean } {
  if (ours === theirs)  return { result: ours,   conflicts: false };
  if (base === ours)    return { result: theirs, conflicts: false };
  if (base === theirs)  return { result: ours,   conflicts: false };

  const baseLines  = splitLines(base);
  const ourLines   = splitLines(ours);
  const theirLines = splitLines(theirs);

  const ourHunks   = toMergeHunks(baseLines, ourLines);
  const theirHunks = toMergeHunks(baseLines, theirLines);

  const result: string[] = [];
  let conflicts = false;
  let baseIdx = 0;
  let oi = 0, ti = 0;

  while (baseIdx < baseLines.length || oi < ourHunks.length || ti < theirHunks.length) {
    const nextOur   = oi < ourHunks.length   ? ourHunks[oi].baseStart   : Infinity;
    const nextTheir = ti < theirHunks.length ? theirHunks[ti].baseStart : Infinity;
    const nextChange = Math.min(nextOur, nextTheir);

    if (nextChange === Infinity) { result.push(...baseLines.slice(baseIdx)); break; }

    while (baseIdx < nextChange) result.push(baseLines[baseIdx++]);

    // Gather all overlapping hunks from both sides
    const oHunks: MergeHunk[] = [];
    const tHunks: MergeHunk[] = [];
    let rangeEnd = nextChange;
    let changed = true;
    while (changed) {
      changed = false;
      while (oi < ourHunks.length && ourHunks[oi].baseStart <= rangeEnd) {
        rangeEnd = Math.max(rangeEnd, ourHunks[oi].baseEnd);
        oHunks.push(ourHunks[oi++]); changed = true;
      }
      while (ti < theirHunks.length && theirHunks[ti].baseStart <= rangeEnd) {
        rangeEnd = Math.max(rangeEnd, theirHunks[ti].baseEnd);
        tHunks.push(theirHunks[ti++]); changed = true;
      }
    }

    const baseRegion  = baseLines.slice(baseIdx, rangeEnd);
    const ourRegion   = applyHunks(baseRegion, oHunks, baseIdx);
    const theirRegion = applyHunks(baseRegion, tHunks, baseIdx);

    if (arrEq(ourRegion, theirRegion))        result.push(...ourRegion);
    else if (arrEq(ourRegion, baseRegion))    result.push(...theirRegion);
    else if (arrEq(theirRegion, baseRegion))  result.push(...ourRegion);
    else {
      result.push(`<<<<<<< ${ourLabel}`, ...ourRegion, '=======', ...theirRegion, `>>>>>>> ${theirLabel}`);
      conflicts = true;
    }

    baseIdx = rangeEnd;
  }

  const joined = result.join('\n');
  return { result: joined ? joined + '\n' : '', conflicts };
}
