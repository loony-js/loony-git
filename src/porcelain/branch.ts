/**
 * branch: create, delete, or list branches.
 *
 *   lgit branch                    list branches
 *   lgit branch <name>             create branch at HEAD
 *   lgit branch <name> <sha>       create branch at given commit
 *   lgit branch -d <name>          delete branch
 *
 * Mirrors: git branch
 */

import { Repository } from '../core/repository';

export interface BranchOptions {
  name?: string;
  startPoint?: string;   // commit SHA or branch name
  delete?: string;
  list?: boolean;
}

export function branch(repo: Repository, opts: BranchOptions): string {
  // ---- list ---------------------------------------------------------------
  if (!opts.name && !opts.delete) {
    const branches = repo.refs.listBranches();
    const current  = repo.refs.currentBranch();
    if (branches.length === 0) return '(no branches)';
    return branches
      .map(b => (b === current ? `* ${b}` : `  ${b}`))
      .join('\n');
  }

  // ---- delete -------------------------------------------------------------
  if (opts.delete) {
    const name = opts.delete;
    if (!repo.refs.branchExists(name)) {
      throw new Error(`error: branch '${name}' not found`);
    }
    const current = repo.refs.currentBranch();
    if (current === name) {
      throw new Error(`error: Cannot delete branch '${name}' checked out`);
    }
    repo.refs.deleteBranch(name);
    return `Deleted branch ${name}`;
  }

  // ---- create -------------------------------------------------------------
  const name = opts.name!;
  if (repo.refs.branchExists(name)) {
    throw new Error(`fatal: A branch named '${name}' already exists`);
  }

  let sha: string | null = null;
  if (opts.startPoint) {
    sha = repo.refs.resolve(opts.startPoint) ?? opts.startPoint;
  } else {
    sha = repo.refs.resolveHead();
  }

  if (!sha) {
    throw new Error('fatal: Not a valid object name: HEAD');
  }

  repo.refs.createBranch(name, sha);
  return `Created branch '${name}' at ${sha.slice(0, 7)}`;
}
