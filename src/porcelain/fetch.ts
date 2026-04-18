/**
 * fetch: download objects and update remote-tracking refs.
 *
 *   lgit fetch [<remote>]
 *   lgit fetch <remote> <refspec>
 *
 * Steps:
 *   1. Discover remote refs via GET /info/refs
 *   2. Compare with what we already have locally
 *   3. Fetch missing objects via POST /git-upload-pack
 *   4. Explode received pack into loose objects
 *   5. Update refs/remotes/<remote>/<branch>
 *   6. Write FETCH_HEAD
 */

import * as fs   from 'fs';
import * as path from 'path';
import { Repository } from '../core/repository';
import { RemoteManager } from '../core/remote/remote';
import { discoverRefs, fetchPack } from '../core/remote/upload-pack';
import { log } from './log';

export interface FetchOptions {
  remote?:   string;
  refspec?:  string;
  verbose?:  boolean;
  onProgress?: (msg: string) => void;
}

export async function fetch(
  repo: Repository,
  opts: FetchOptions = {}
): Promise<string> {
  const remoteName = opts.remote ?? defaultRemote(repo);
  if (!remoteName) throw new Error('fatal: no remote configured');

  const mgr    = new RemoteManager(repo);
  const remote = mgr.get(remoteName);
  if (!remote) throw new Error(`fatal: remote '${remoteName}' not found`);

  const url = remote.url;

  // 1. Discover remote refs
  const advert = await discoverRefs(url);
  if (advert.refs.length === 0) return 'Everything up-to-date (empty remote)';

  // 2. Determine what we want vs what we have
  const wants: string[] = [];
  const haves: string[] = collectHaves(repo);
  const haveSet = new Set(haves);

  const remoteRefs = advert.refs.filter(r =>
    r.name.startsWith('refs/heads/') || r.name.startsWith('refs/tags/')
  );

  // Deduplicate SHAs — many refs may point at the same commit
  const seenShas = new Set<string>();
  for (const ref of remoteRefs) {
    if (!haveSet.has(ref.sha) && !repo.store.exists(ref.sha) && !seenShas.has(ref.sha)) {
      seenShas.add(ref.sha);
      wants.push(ref.sha);
    }
  }

  // 3. Fetch pack — retry without problematic wants if server rejects any
  if (wants.length > 0) {
    let result;
    try {
      result = await fetchPack({
        url, wants, haves,
        store: repo.store,
        onProgress: opts.onProgress,
      });
    } catch (err: any) {
      // "not our ref" — fall back to only requesting the default branch HEAD
      const headRef = advert.symrefs.get('HEAD');
      const headSha = headRef
        ? advert.refs.find(r => r.name === headRef)?.sha
        : advert.refs.find(r => r.name === 'refs/heads/main' || r.name === 'refs/heads/master')?.sha;
      if (!headSha || headSha === wants[0]) throw err;
      result = await fetchPack({
        url, wants: [headSha], haves,
        store: repo.store,
        onProgress: opts.onProgress,
      });
    }

    // 4. Write received objects to loose store
    for (const obj of result.objects) {
      if (!repo.store.exists(obj.sha)) {
        repo.store.write(obj.type, obj.content);
      }
    }
  }

  // 5. Update remote-tracking refs
  const updated: string[] = [];
  for (const ref of remoteRefs) {
    if (!ref.name.startsWith('refs/heads/')) continue;
    const branch = ref.name.slice('refs/heads/'.length);
    const trackRef = `refs/remotes/${remoteName}/${branch}`;
    const oldSha = repo.refs.resolve(trackRef);
    if (oldSha !== ref.sha) {
      repo.refs.updateRef(trackRef, ref.sha);
      updated.push(`${remoteName}/${branch}`);
    }
  }

  // Also update remote tracking tags
  for (const ref of remoteRefs) {
    if (!ref.name.startsWith('refs/tags/')) continue;
    const existing = repo.refs.resolve(ref.name);
    if (!existing) {
      repo.refs.updateRef(ref.name, ref.sha);
    }
  }

  // 6. Write FETCH_HEAD
  writeFetchHead(repo, remoteRefs, url);

  if (updated.length === 0) return 'Already up to date.';
  return updated.map(r => ` * [new branch]  ${r}`).join('\n');
}

function collectHaves(repo: Repository): string[] {
  // All commit SHAs reachable from local refs
  const commits: string[] = [];
  const visited = new Set<string>();

  const processRef = (sha: string | null) => {
    if (!sha || visited.has(sha)) return;
    const queue = [sha];
    while (queue.length > 0) {
      const s = queue.shift()!;
      if (visited.has(s)) continue;
      visited.add(s);
      if (!repo.store.exists(s)) continue;
      const { type, content } = repo.store.read(s);
      if (type !== 'commit') continue;
      commits.push(s);
      const { CommitObjectParser } = require('../core/objects/commit');
      const c = CommitObjectParser.deserialize(content);
      for (const p of c.parents) queue.push(p);
    }
  };

  // Walk all local branches
  for (const branch of repo.refs.listBranches()) {
    processRef(repo.refs.resolve(`refs/heads/${branch}`));
  }

  return commits;
}

function writeFetchHead(
  repo: Repository,
  refs: { sha: string; name: string }[],
  url: string
): void {
  const lines = refs
    .filter(r => r.name.startsWith('refs/heads/'))
    .map(r => `${r.sha}\t\t${r.name} of ${url}`)
    .join('\n');
  fs.writeFileSync(path.join(repo.gitDir, 'FETCH_HEAD'), lines + '\n');
}

function defaultRemote(repo: Repository): string | null {
  const mgr  = new RemoteManager(repo);
  const list = mgr.listNames();
  if (list.includes('origin')) return 'origin';
  return list[0] ?? null;
}
