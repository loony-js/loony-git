/**
 * status: show the working tree status.
 *
 *   lgit status
 *
 * Three-way diff:
 *   HEAD commit tree  vs  index   → "Changes to be committed"
 *   index             vs  workdir → "Changes not staged / Untracked"
 *
 * Mirrors: git status (short format output)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { Repository } from '../core/repository';
import { TreeObject } from '../core/objects/tree';
import { CommitObjectParser } from '../core/objects/commit';
import { IndexEntry } from '../types';

interface StatusResult {
  branch: string;
  staged:   { status: string; path: string }[];
  unstaged: { status: string; path: string }[];
  untracked: string[];
}

export function status(repo: Repository): StatusResult {
  const branch = repo.refs.currentBranch() ?? 'HEAD (detached)';

  // ---- HEAD tree (flat map of path → hash) --------------------------------
  const headTree = buildHeadTree(repo);

  // ---- Index entries -------------------------------------------------------
  const indexMap = new Map<string, IndexEntry>(
    repo.index.getAll().map(e => [e.name, e])
  );

  // ---- Staged changes (HEAD vs index) ------------------------------------
  const staged: StatusResult['staged'] = [];
  const allPaths = new Set([...headTree.keys(), ...indexMap.keys()]);

  for (const p of allPaths) {
    const inHead  = headTree.get(p);
    const inIndex = indexMap.get(p);
    if (!inHead && inIndex) {
      staged.push({ status: 'A', path: p });
    } else if (inHead && !inIndex) {
      staged.push({ status: 'D', path: p });
    } else if (inHead && inIndex && inHead !== inIndex.hash) {
      staged.push({ status: 'M', path: p });
    }
  }

  // ---- Unstaged + untracked (index vs workdir) ----------------------------
  const unstaged: StatusResult['unstaged'] = [];
  const untracked: string[] = [];

  const workFiles = new Set<string>();
  collectWorkdir(repo.workDir, repo.gitDir, workFiles, repo.workDir);

  for (const rel of workFiles) {
    if (!indexMap.has(rel)) {
      untracked.push(rel);
    } else {
      const entry = indexMap.get(rel)!;
      const abs   = path.join(repo.workDir, rel);
      const stat  = fs.statSync(abs);

      // Quick check: if mtime and size match the cached entry, skip hash
      const mtimeSec = Math.floor(stat.mtimeMs / 1000);
      if (
        mtimeSec !== entry.mtimeSec ||
        stat.size !== entry.size
      ) {
        // Compute blob hash of current content
        const content = fs.readFileSync(abs);
        const header  = Buffer.from(`blob ${content.length}\0`);
        const full    = Buffer.concat([header, content]);
        const hash    = crypto.createHash('sha1').update(full).digest('hex');
        if (hash !== entry.hash) {
          unstaged.push({ status: 'M', path: rel });
        }
      }
    }
  }

  // Deleted from workdir but still in index
  for (const [rel] of indexMap) {
    const abs = path.join(repo.workDir, rel);
    if (!fs.existsSync(abs)) {
      unstaged.push({ status: 'D', path: rel });
    }
  }

  return { branch, staged, unstaged, untracked };
}

export function formatStatus(result: StatusResult): string {
  const lines: string[] = [];
  lines.push(`On branch ${result.branch}`);
  lines.push('');

  if (
    result.staged.length === 0 &&
    result.unstaged.length === 0 &&
    result.untracked.length === 0
  ) {
    lines.push('nothing to commit, working tree clean');
    return lines.join('\n');
  }

  if (result.staged.length > 0) {
    lines.push('Changes to be committed:');
    lines.push('  (use "lgit reset HEAD <file>..." to unstage)');
    lines.push('');
    for (const s of result.staged) {
      const label =
        s.status === 'A' ? 'new file:   ' :
        s.status === 'D' ? 'deleted:    ' : 'modified:   ';
      lines.push(`\t${label}${s.path}`);
    }
    lines.push('');
  }

  if (result.unstaged.length > 0) {
    lines.push('Changes not staged for commit:');
    lines.push('  (use "lgit add <file>..." to update what will be committed)');
    lines.push('');
    for (const u of result.unstaged) {
      const label = u.status === 'D' ? 'deleted:    ' : 'modified:   ';
      lines.push(`\t${label}${u.path}`);
    }
    lines.push('');
  }

  if (result.untracked.length > 0) {
    lines.push('Untracked files:');
    lines.push('  (use "lgit add <file>..." to include in what will be committed)');
    lines.push('');
    for (const u of result.untracked) {
      lines.push(`\t${u}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// Flatten a commit's root tree into path→hash map
function buildHeadTree(repo: Repository): Map<string, string> {
  const map = new Map<string, string>();
  const headSha = repo.refs.resolveHead();
  if (!headSha) return map;

  const c = CommitObjectParser.read(repo.store, headSha);
  flattenTree(repo, c.tree, '', map);
  return map;
}

function flattenTree(
  repo: Repository,
  treeSha: string,
  prefix: string,
  out: Map<string, string>
): void {
  const tree = TreeObject.read(repo.store, treeSha);
  for (const e of tree.entries) {
    const full = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '040000') {
      flattenTree(repo, e.hash, full, out);
    } else {
      out.set(full, e.hash);
    }
  }
}

function collectWorkdir(
  dir: string,
  gitDir: string,
  out: Set<string>,
  root: string
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (path.resolve(abs) === path.resolve(gitDir)) continue;
    if (entry.isDirectory()) {
      collectWorkdir(abs, gitDir, out, root);
    } else if (entry.isFile()) {
      out.add(path.relative(root, abs).split(path.sep).join('/'));
    }
  }
}
