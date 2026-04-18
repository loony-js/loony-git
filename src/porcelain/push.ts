/**
 * push: upload local commits to a remote.
 *
 *   lgit push [<remote>] [<refspec>]
 *   lgit push origin main
 *   lgit push origin main:refs/heads/main
 *
 * Steps:
 *   1. Discover remote refs via GET /info/refs?service=git-receive-pack
 *   2. Compute ref updates (old → new)
 *   3. Collect objects the remote is missing
 *   4. POST to git-receive-pack with ref-updates + PACK
 *   5. Report results
 */

import { Repository } from '../core/repository';
import { RemoteManager } from '../core/remote/remote';
import { discoverReceiveRefs, pushPack, RefUpdate, collectObjectsForPush } from '../core/remote/receive-pack';

export interface PushOptions {
  remote?:     string;
  refspec?:    string;   // "local:remote"  or just "branchname"
  force?:      boolean;
  onProgress?: (msg: string) => void;
}

export async function push(
  repo: Repository,
  opts: PushOptions = {}
): Promise<string> {
  const remoteName = opts.remote ?? defaultRemote(repo);
  if (!remoteName) throw new Error('fatal: no remote configured');

  const mgr    = new RemoteManager(repo);
  const remote = mgr.get(remoteName);
  if (!remote) throw new Error(`fatal: remote '${remoteName}' not found`);

  const url = remote.url;

  // 1. Discover remote refs
  const advert = await discoverReceiveRefs(url);
  const remoteRefMap = new Map(advert.refs.map(r => [r.name, r.sha]));
  const remoteHas = new Set(advert.refs.map(r => r.sha));

  // 2. Determine which local branches to push
  const refspecs = resolveRefspecs(repo, opts.refspec);
  if (refspecs.length === 0) return 'Everything up-to-date';

  const updates: RefUpdate[] = [];
  const lines: string[] = [];

  for (const { localRef, remoteRef } of refspecs) {
    const localSha = repo.refs.resolve(localRef);
    if (!localSha) {
      lines.push(`error: src refspec ${localRef} does not match any`);
      continue;
    }
    const remoteSha = remoteRefMap.get(remoteRef) ?? '0'.repeat(40);

    if (localSha === remoteSha) {
      lines.push(`= [up to date]  ${localRef.replace('refs/heads/', '')} -> ${remoteRef.replace('refs/heads/', '')}`);
      continue;
    }

    // Check if fast-forward (unless --force)
    if (remoteSha !== '0'.repeat(40) && !opts.force) {
      const isFF = await isFastForward(repo, remoteSha, localSha);
      if (!isFF) {
        lines.push(`! [rejected]  ${localRef} -> ${remoteRef} (non-fast-forward)`);
        continue;
      }
    }

    updates.push({ refname: remoteRef, oldSha: remoteSha, newSha: localSha });
    const arrow = remoteSha === '0'.repeat(40) ? '* [new branch]' : '..';
    lines.push(` ${arrow}  ${localRef.replace('refs/heads/','')} -> ${remoteRef.replace('refs/heads/','')}`);
  }

  if (updates.length === 0) {
    return lines.join('\n') || 'Everything up-to-date';
  }

  // 3. Collect objects
  const toSend = collectObjectsForPush(
    repo.store,
    updates.map(u => u.newSha),
    remoteHas
  );

  // 4. Push
  const result = await pushPack({
    url, updates, store: repo.store, remoteShas: remoteHas,
    onProgress: opts.onProgress,
  });

  // 5. Update remote tracking refs on success
  for (const okRef of result.ok) {
    const branch = okRef.replace('refs/heads/', '');
    const newSha = updates.find(u => u.refname === okRef)?.newSha;
    if (newSha) {
      repo.refs.updateRef(`refs/remotes/${remoteName}/${branch}`, newSha);
    }
  }

  for (const f of result.failed) {
    lines.push(`! [remote rejected]  ${f.ref} (${f.reason})`);
  }

  lines.push(`Objects sent: ${toSend.size}`);
  return lines.join('\n');
}

// ---- helpers ---------------------------------------------------------------

interface ResolvedRefspec {
  localRef:  string;   // full local ref
  remoteRef: string;   // full remote ref
}

function resolveRefspecs(repo: Repository, refspec?: string): ResolvedRefspec[] {
  if (refspec) {
    const [local, remote] = refspec.split(':');
    const localRef  = local.startsWith('refs/') ? local : `refs/heads/${local}`;
    const remoteRef = (remote ?? local).startsWith('refs/') ? (remote ?? local) : `refs/heads/${remote ?? local}`;
    return [{ localRef, remoteRef }];
  }

  // Default: push all local branches that have a tracking config,
  // or fall back to the current branch
  const currentBranch = repo.refs.currentBranch();
  if (currentBranch) {
    return [{
      localRef:  `refs/heads/${currentBranch}`,
      remoteRef: `refs/heads/${currentBranch}`,
    }];
  }
  return [];
}

function defaultRemote(repo: Repository): string | null {
  const mgr  = new RemoteManager(repo);
  const list = mgr.listNames();
  if (list.includes('origin')) return 'origin';
  return list[0] ?? null;
}

async function isFastForward(
  repo: Repository,
  ancestorSha: string,
  descendantSha: string
): Promise<boolean> {
  // Check if ancestorSha is reachable from descendantSha
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
