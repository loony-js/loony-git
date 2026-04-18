/**
 * show: display a commit with its diff.
 *
 *   lgit show [<ref>]
 *   lgit show --stat [<ref>]
 */

import { Repository } from '../core/repository';
import { CommitObjectParser } from '../core/objects/commit';
import { revParse } from '../core/revision';
import { diffTrees, diffHunks } from '../core/diff';

export interface ShowOptions {
  ref?:  string;
  stat?: boolean;
}

export function show(repo: Repository, opts: ShowOptions = {}): string {
  const sha = revParse(repo, opts.ref ?? 'HEAD');
  const { type, content } = repo.store.read(sha);

  if (type !== 'commit') return content.toString('utf8');

  const c = CommitObjectParser.deserialize(content);
  const lines: string[] = [];

  lines.push(`commit ${sha}`);
  if (c.parents.length > 1) {
    lines.push(`Merge: ${c.parents.map(p => p.slice(0, 7)).join(' ')}`);
  }
  lines.push(`Author: ${c.author.name} <${c.author.email}>`);
  lines.push(`Date:   ${new Date(c.author.timestamp * 1000).toUTCString()}`);
  lines.push('');
  for (const l of c.message.trimEnd().split('\n')) lines.push(`    ${l}`);
  lines.push('');

  const parentTreeSha = c.parents.length > 0
    ? CommitObjectParser.read(repo.store, c.parents[0]).tree
    : null;

  const fileDiffs = diffTrees(repo.store, parentTreeSha, c.tree);

  for (const fd of fileDiffs) {
    const oldContent = fd.oldSha ? repo.store.read(fd.oldSha).content.toString('utf8') : '';
    const newContent = fd.newSha ? repo.store.read(fd.newSha).content.toString('utf8') : '';

    lines.push(`diff --git a/${fd.path} b/${fd.path}`);

    if (!fd.oldSha) {
      lines.push(`new file mode ${fd.newMode}`);
      lines.push(`index 0000000..${fd.newSha!.slice(0, 7)}`);
    } else if (!fd.newSha) {
      lines.push(`deleted file mode ${fd.oldMode}`);
      lines.push(`index ${fd.oldSha.slice(0, 7)}..0000000`);
    } else {
      if (fd.oldMode !== fd.newMode) lines.push(`old mode ${fd.oldMode}\nnew mode ${fd.newMode}`);
      lines.push(`index ${fd.oldSha.slice(0, 7)}..${fd.newSha.slice(0, 7)} ${fd.newMode}`);
    }

    const oldLabel = fd.oldSha ? `a/${fd.path}` : '/dev/null';
    const newLabel = fd.newSha ? `b/${fd.path}` : '/dev/null';

    if (opts.stat) {
      const oldLen = oldContent.split('\n').length;
      const newLen = newContent.split('\n').length;
      lines.push(`${fd.path} | ${Math.abs(newLen - oldLen)} ${newLen > oldLen ? '+'.repeat(Math.min(newLen - oldLen, 20)) : '-'.repeat(Math.min(oldLen - newLen, 20))}`);
    } else {
      lines.push(`--- ${oldLabel}`);
      lines.push(`+++ ${newLabel}`);
      const hunks = diffHunks(oldContent, newContent);
      if (hunks.length > 0) lines.push(...hunks);
    }
  }

  return lines.join('\n');
}
