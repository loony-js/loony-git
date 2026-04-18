/**
 * rev-parse: resolve revision names to object SHAs.
 *
 *   lgit rev-parse HEAD
 *   lgit rev-parse HEAD~2
 *   lgit rev-parse main^2
 *   lgit rev-parse v1.0^{}
 *   lgit rev-parse --abbrev-ref HEAD     → branch name
 *   lgit rev-parse --short HEAD          → 7-char abbrev
 *   lgit rev-parse --verify <rev>        → exit 1 if not resolvable
 *
 * Mirrors: git rev-parse
 */

import { Repository } from '../core/repository';
import { revParse } from '../core/revision';

export interface RevParseOptions {
  expr: string;
  abbrevRef?: boolean;    // --abbrev-ref: return branch name instead of SHA
  short?: boolean;        // --short: return 7-char abbreviated SHA
  verify?: boolean;       // --verify: throw if not resolvable (default true)
}

export function plumbingRevParse(repo: Repository, opts: RevParseOptions): string {
  // --abbrev-ref HEAD → branch name or 'HEAD' if detached
  if (opts.abbrevRef) {
    if (opts.expr === 'HEAD') {
      return repo.refs.currentBranch() ?? 'HEAD';
    }
    // For non-HEAD, fall through to normal resolution then return the ref name
  }

  const sha = revParse(repo, opts.expr);

  if (opts.short) return sha.slice(0, 7);
  return sha;
}
