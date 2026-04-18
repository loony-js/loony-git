/**
 * pull: fetch + fast-forward merge.
 *
 *   lgit pull [<remote>] [<branch>]
 *
 * Strategy: fetch remote, then fast-forward the current branch to the
 * fetched tip if possible.  Refuses if the merge would not be fast-forward
 * (full 3-way merge is a future feature).
 */

import { Repository } from '../core/repository';
import { fetch } from './fetch';
import { checkout } from './checkout';
import { RemoteManager } from '../core/remote/remote';

export interface PullOptions {
  remote?:     string;
  branch?:     string;
  onProgress?: (msg: string) => void;
}

export async function pull(
  repo: Repository,
  opts: PullOptions = {}
): Promise<string> {
  const remoteName = opts.remote ?? 'origin';
  const mgr        = new RemoteManager(repo);
  const remote     = mgr.get(remoteName);
  if (!remote) throw new Error(`fatal: remote '${remoteName}' not found`);

  const currentBranch = repo.refs.currentBranch();
  const targetBranch  = opts.branch ?? currentBranch;
  if (!targetBranch) throw new Error('fatal: Not on a branch (detached HEAD). Specify a branch to pull.');

  // 1. Fetch
  const fetchMsg = await fetch(repo, {
    remote: remoteName,
    onProgress: opts.onProgress,
  });

  // 2. Find the remote-tracking ref
  const trackRef = `refs/remotes/${remoteName}/${targetBranch}`;
  const remoteSha = repo.refs.resolve(trackRef);
  if (!remoteSha) {
    return `${fetchMsg}\nAlready up to date. (no remote tracking branch for ${targetBranch})`;
  }

  const localSha = repo.refs.resolve(`refs/heads/${targetBranch}`);

  // Nothing to merge
  if (localSha === remoteSha) {
    return `${fetchMsg}\nAlready up to date.`;
  }

  // 3. Fast-forward check
  if (localSha) {
    const isFF = await isFastForward(repo, localSha, remoteSha);
    if (!isFF) {
      return [
        fetchMsg,
        `CONFLICT: Cannot fast-forward '${targetBranch}'.`,
        `Hint: Your local branch has diverged from the remote.`,
        `Use 'lgit merge' (not yet implemented) for a 3-way merge.`,
      ].join('\n');
    }
  }

  // 4. Advance the branch ref
  const oldSha = localSha ?? '0'.repeat(40);
  repo.refs.updateRef(`refs/heads/${targetBranch}`, remoteSha);

  // 5. If we're on this branch, update index + working directory
  if (repo.refs.currentBranch() === targetBranch) {
    repo.index.load();
    checkout(repo, { target: targetBranch });
  }

  const abbrev = (s: string) => s.slice(0, 7);
  return [
    fetchMsg,
    `Updating ${abbrev(oldSha)}..${abbrev(remoteSha)}`,
    `Fast-forward`,
  ].join('\n');
}

async function isFastForward(
  repo: Repository,
  ancestorSha: string,
  descendantSha: string
): Promise<boolean> {
  const visited = new Set<string>();
  const queue   = [descendantSha];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (sha === ancestorSha) return true;
    if (visited.has(sha)) continue;
    visited.add(sha);
    if (!repo.store.exists(sha)) continue;
    const { type, content } = repo.store.read(sha);
    if (type !== 'commit') continue;
    const { CommitObjectParser } = require('../core/objects/commit');
    const c = CommitObjectParser.deserialize(content);
    for (const p of c.parents) queue.push(p);
  }
  return false;
}
