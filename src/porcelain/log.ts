/**
 * log: show commit history by walking the DAG.
 *
 *   lgit log [--oneline] [-n <count>] [<commit>]
 *
 * Traversal order: topological (BFS from HEAD, newest first).
 * Handles linear history and merge commits (multiple parents).
 *
 * Mirrors: git log
 */

import { Repository } from '../core/repository';
import { CommitObjectParser } from '../core/objects/commit';
import { CommitObject } from '../types';

export interface LogOptions {
  oneline?: boolean;
  maxCount?: number;
  startRef?: string;   // branch/tag/sha to start from (defaults to HEAD)
}

export interface LogEntry {
  hash: string;
  commit: CommitObject;
}

export function log(repo: Repository, opts: LogOptions = {}): LogEntry[] {
  const startHash = opts.startRef
    ? repo.refs.resolve(opts.startRef) ?? opts.startRef
    : repo.refs.resolveHead();

  if (!startHash) {
    return [];
  }

  const entries: LogEntry[] = [];
  const visited  = new Set<string>();
  const queue: string[] = [startHash];

  while (queue.length > 0) {
    if (opts.maxCount !== undefined && entries.length >= opts.maxCount) break;

    const sha = queue.shift()!;
    if (visited.has(sha)) continue;
    visited.add(sha);

    if (!repo.store.exists(sha)) continue;

    const c = CommitObjectParser.read(repo.store, sha);
    entries.push({ hash: sha, commit: c });

    // BFS: queue all parents (merge commits have > 1)
    for (const parent of c.parents) {
      if (!visited.has(parent)) queue.push(parent);
    }
  }

  return entries;
}

export function formatLog(entries: LogEntry[], oneline = false): string {
  if (entries.length === 0) return 'fatal: your current branch has no commits yet';

  return entries
    .map(({ hash, commit: c }) => {
      if (oneline) {
        const firstLine = c.message.split('\n')[0];
        return `${hash.slice(0, 7)} ${firstLine}`;
      }
      const date = new Date(c.author.timestamp * 1000).toUTCString();
      return [
        `commit ${hash}`,
        `Author: ${c.author.name} <${c.author.email}>`,
        `Date:   ${date}`,
        '',
        c.message
          .split('\n')
          .map(l => `    ${l}`)
          .join('\n'),
      ].join('\n');
    })
    .join('\n\n');
}
