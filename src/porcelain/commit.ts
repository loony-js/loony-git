/**
 * commit: record staged changes as a new commit.
 *
 *   lgit commit -m <message>
 *
 * Steps (identical to real Git):
 *   1. write-tree  → produce root tree SHA from index
 *   2. commit-tree → wrap tree in a commit object
 *   3. Update HEAD (or current branch ref) to new commit SHA
 *   4. Append to reflog
 *
 * Mirrors: git commit
 */

import { Repository } from '../core/repository';
import { writeTree } from '../plumbing/write-tree';
import { commitTree } from '../plumbing/commit-tree';

export interface CommitOptions {
  message:  string;
  amend?:   boolean;
}

export function commit(repo: Repository, opts: CommitOptions): string {
  if (repo.index.count() === 0) {
    return 'nothing to commit (index is empty)';
  }

  // 1. Materialise tree from the staging area
  const treeSha = writeTree(repo);

  // 2. Resolve current HEAD to get parent commit(s)
  const headSha = repo.refs.resolveHead();

  // ---- amend: replace the HEAD commit ------------------------------------
  if (opts.amend) {
    if (!headSha) throw new Error('nothing to amend — no commits yet');
    const { CommitObjectParser } = require('../core/objects/commit');
    const headCommit = CommitObjectParser.read(repo.store, headSha);

    const { name, email } = repo.getAuthor();
    const now = Math.floor(Date.now() / 1000);
    const tz  = new Date().toTimeString().slice(12, 17);

    const newSha = CommitObjectParser.write(repo.store, {
      tree:      treeSha,
      parents:   headCommit.parents,       // keep original parents
      author:    headCommit.author,         // keep original authorship
      committer: { name, email, timestamp: now, timezone: tz },
      message:   opts.message || headCommit.message,
    });

    const headTarget = repo.refs.readHead();
    if (headTarget.type === 'symref') repo.refs.updateRef(headTarget.ref, newSha);
    else repo.refs.writeHead({ type: 'sha', hash: newSha });

    const branch = repo.refs.currentBranch();
    const label  = branch ?? `(HEAD detached at ${newSha.slice(0, 7)})`;
    return `[${label} ${newSha.slice(0, 7)}] ${(opts.message || headCommit.message).split('\n')[0]}\n  (amend)`;
  }

  const parents = headSha ? [headSha] : [];

  // 3. Guard: don't commit if nothing changed vs parent tree
  if (headSha) {
    const { CommitObjectParser } = require('../core/objects/commit');
    const parentCommit = CommitObjectParser.read(repo.store, headSha);
    if (parentCommit.tree === treeSha) {
      return 'nothing to commit, working tree clean';
    }
  }

  // 4. Create commit object
  const commitSha = commitTree(repo, {
    tree: treeSha,
    parents,
    message: opts.message,
  });

  // 5. Advance the branch ref (or write detached HEAD)
  const headTarget = repo.refs.readHead();
  const oldHash = headSha ?? '0'.repeat(40);

  if (headTarget.type === 'symref') {
    repo.refs.updateRef(headTarget.ref, commitSha);
  } else {
    repo.refs.writeHead({ type: 'sha', hash: commitSha });
  }

  // 6. Append reflog entry
  const { name, email } = repo.getAuthor();
  const now = Math.floor(Date.now() / 1000);
  const tz = new Date().toTimeString().slice(12, 17);
  const refName =
    headTarget.type === 'symref' ? headTarget.ref : 'HEAD';

  repo.refs.appendReflog(
    refName,
    oldHash,
    commitSha,
    `commit: ${opts.message}`,
    { name, email, timestamp: now, timezone: tz }
  );

  const branch = repo.refs.currentBranch();
  const label  = branch ?? `(HEAD detached at ${commitSha.slice(0, 7)})`;
  const abbrev = commitSha.slice(0, 7);
  const isRoot = parents.length === 0;

  return [
    `[${label} ${isRoot ? '(root-commit) ' : ''}${abbrev}] ${opts.message}`,
    `  Tree: ${treeSha.slice(0, 7)}`,
  ].join('\n');
}
