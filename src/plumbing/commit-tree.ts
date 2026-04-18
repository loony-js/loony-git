/**
 * commit-tree: create a commit object from a tree SHA.
 *
 *   lgit commit-tree <tree-sha> [-p <parent>]... -m <message>
 *
 * Mirrors: git commit-tree
 */

import { Repository } from '../core/repository';
import { CommitObjectParser } from '../core/objects/commit';
import { PersonInfo } from '../types';

export interface CommitTreeOptions {
  tree: string;
  parents: string[];
  message: string;
  author?: PersonInfo;
  committer?: PersonInfo;
}

export function commitTree(
  repo: Repository,
  opts: CommitTreeOptions
): string {
  const now = Math.floor(Date.now() / 1000);
  const tz = formatTimezone(new Date().getTimezoneOffset());
  const { name, email } = repo.getAuthor();

  const defaultPerson: PersonInfo = {
    name:      process.env.GIT_AUTHOR_NAME  || name,
    email:     process.env.GIT_AUTHOR_EMAIL || email,
    timestamp: now,
    timezone:  tz,
  };

  const author    = opts.author    ?? defaultPerson;
  const committer = opts.committer ?? {
    name:      process.env.GIT_COMMITTER_NAME  || name,
    email:     process.env.GIT_COMMITTER_EMAIL || email,
    timestamp: now,
    timezone:  tz,
  };

  return CommitObjectParser.write(repo.store, {
    tree:      opts.tree,
    parents:   opts.parents,
    author,
    committer,
    message:   opts.message,
  });
}

// Convert JS getTimezoneOffset (minutes west of UTC) to Git tz string
function formatTimezone(offsetMinutes: number): string {
  const sign   = offsetMinutes <= 0 ? '+' : '-';
  const abs    = Math.abs(offsetMinutes);
  const hours  = String(Math.floor(abs / 60)).padStart(2, '0');
  const mins   = String(abs % 60).padStart(2, '0');
  return `${sign}${hours}${mins}`;
}
