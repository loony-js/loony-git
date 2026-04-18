/**
 * Revision name resolution — the engine behind rev-parse.
 *
 * Supported syntax (composable, left-to-right):
 *
 *   HEAD, ORIG_HEAD, MERGE_HEAD, CHERRY_PICK_HEAD
 *   <branchname>           refs/heads/<name>
 *   <tagname>              refs/tags/<name>
 *   <sha>                  full or abbreviated (≥4 chars)
 *   <rev>~<n>              nth first-parent ancestor
 *   <rev>^<n>              nth parent  (^0 = self, ^1 = first, ^2 = second …)
 *   <rev>^{}               dereference tag objects until non-tag
 *   <rev>^{commit}         ensure result is a commit
 *   <rev>^{tree}           resolve to the commit's tree
 *   <rev>^{object}         any object (just dereferences tags)
 *
 * Examples:
 *   HEAD~1          first parent of HEAD
 *   HEAD~3          great-grandparent
 *   HEAD^2          second parent of HEAD (merge commit)
 *   v1.0^{}         dereference annotated tag to commit
 *   HEAD~2^2~1      chain: grandparent → second parent → its first parent
 */

import { Repository } from './repository';
import { CommitObjectParser } from './objects/commit';
import { TagObjectParser } from './objects/tag';
import { ObjectType } from '../types';

// ---- public API ------------------------------------------------------------

export function revParse(repo: Repository, expr: string): string {
  return parseExpr(repo, expr);
}

// ---- tokeniser / parser ----------------------------------------------------

// Split "HEAD~2^2~1^{tree}" into ["HEAD", "~2", "^2", "~1", "^{tree}"]
function tokenise(expr: string): string[] {
  const tokens: string[] = [];
  // Regex: base token first, then modifier tokens
  const re = /^([^^~]+)((?:[~^][^~^]*)*)/;
  const m  = re.exec(expr);
  if (!m) throw new Error(`Invalid revision: ${expr}`);

  tokens.push(m[1]); // base name

  // Split modifier chain on ~ or ^ boundaries (keep the delimiter)
  const modifiers = m[2];
  const modRe = /([~^][^~^]*)/g;
  let mm: RegExpExecArray | null;
  while ((mm = modRe.exec(modifiers)) !== null) {
    tokens.push(mm[1]);
  }
  return tokens;
}

function parseExpr(repo: Repository, expr: string): string {
  const tokens = tokenise(expr);
  let sha = resolveBase(repo, tokens[0]);

  for (let i = 1; i < tokens.length; i++) {
    sha = applyModifier(repo, sha, tokens[i]);
  }
  return sha;
}

// ---- base resolution -------------------------------------------------------

const SPECIAL_REFS = new Set([
  'HEAD', 'ORIG_HEAD', 'MERGE_HEAD',
  'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_HEAD',
]);

function resolveBase(repo: Repository, base: string): string {
  // Special refs (HEAD, ORIG_HEAD, …)
  if (SPECIAL_REFS.has(base)) {
    const sha = repo.refs.resolveHead();
    if (!sha) throw new Error(`fatal: ambiguous argument '${base}': unknown revision`);
    return sha;
  }

  // Try as a full or abbreviated SHA first (avoids ref-name collision)
  if (/^[0-9a-f]{4,40}$/.test(base)) {
    const expanded = expandAbbrev(repo, base);
    if (expanded) return expanded;
  }

  // Try as a ref name (branch, tag, remote, full ref path)
  const refSha = repo.refs.resolve(base);
  if (refSha) return refSha;

  throw new Error(`fatal: ambiguous argument '${base}': unknown revision or path not in the working tree`);
}

function expandAbbrev(repo: Repository, abbrev: string): string | null {
  if (abbrev.length === 40) {
    return repo.store.exists(abbrev) ? abbrev : null;
  }
  const matches = repo.store.listAll().filter(h => h.startsWith(abbrev));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`fatal: ambiguous abbreviation '${abbrev}'`);
  }
  return null;
}

// ---- modifier application --------------------------------------------------

function applyModifier(repo: Repository, sha: string, modifier: string): string {
  // ^{type} or ^{}
  if (modifier.startsWith('^{')) {
    const inner = modifier.slice(2, -1); // strip ^{ and }
    return deref(repo, sha, inner);
  }

  // ^<n>  or  ^ alone (means ^1)
  if (modifier.startsWith('^')) {
    const nStr = modifier.slice(1);
    const n    = nStr === '' ? 1 : parseInt(nStr, 10);
    if (isNaN(n)) throw new Error(`Invalid modifier: ${modifier}`);
    return nthParent(repo, sha, n);
  }

  // ~<n>  or  ~ alone (means ~1)
  if (modifier.startsWith('~')) {
    const nStr = modifier.slice(1);
    const n    = nStr === '' ? 1 : parseInt(nStr, 10);
    if (isNaN(n) || n < 0) throw new Error(`Invalid modifier: ${modifier}`);
    return nthFirstParentAncestor(repo, sha, n);
  }

  throw new Error(`Unknown modifier: ${modifier}`);
}

// ---- traversal helpers -----------------------------------------------------

function nthParent(repo: Repository, sha: string, n: number): string {
  // ^0 means the commit itself (used in tag dereference context)
  if (n === 0) return sha;

  const obj = repo.store.read(sha);
  const commitSha = ensureCommit(repo, sha, obj.type);
  const commit = CommitObjectParser.read(repo.store, commitSha);

  if (n > commit.parents.length) {
    throw new Error(`fatal: ${sha.slice(0, 7)} does not have parent #${n}`);
  }
  return commit.parents[n - 1];
}

function nthFirstParentAncestor(repo: Repository, sha: string, n: number): string {
  let current = sha;
  for (let i = 0; i < n; i++) {
    const obj = repo.store.read(current);
    const commitSha = ensureCommit(repo, current, obj.type);
    const commit = CommitObjectParser.read(repo.store, commitSha);
    if (commit.parents.length === 0) {
      throw new Error(`fatal: ${current.slice(0, 7)} is a root commit — no ancestor ~${n}`);
    }
    current = commit.parents[0];
  }
  return current;
}

// ^{} or ^{type}: recursively dereference tag objects
function deref(repo: Repository, sha: string, wantType: string): string {
  let current = sha;
  for (let depth = 0; depth < 20; depth++) {
    const { type, content } = repo.store.read(current);

    if (wantType === '' || wantType === 'object') {
      // ^{} / ^{object}: peel until non-tag
      if (type !== 'tag') return current;
      current = TagObjectParser.deserialize(content).object;
      continue;
    }

    if (type === wantType) return current;

    // For commit type: also accept a tag pointing at a commit
    if (type === 'tag') {
      current = TagObjectParser.deserialize(content).object;
      continue;
    }

    // For tree: if we land on a commit, resolve its tree
    if (wantType === 'tree' && type === 'commit') {
      return CommitObjectParser.deserialize(content).tree;
    }

    throw new Error(`fatal: ${sha.slice(0, 7)} is a ${type}, not a ${wantType}`);
  }
  throw new Error(`fatal: circular or deeply nested tag dereference at ${sha.slice(0, 7)}`);
}

function ensureCommit(repo: Repository, sha: string, type: ObjectType): string {
  if (type === 'commit') return sha;
  if (type === 'tag') {
    // Peel the tag
    return deref(repo, sha, 'commit');
  }
  throw new Error(`fatal: ${sha.slice(0, 7)} is a ${type}, not a commit`);
}
