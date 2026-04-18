/**
 * cat-file: inspect objects in the object store.
 *
 *   lgit cat-file -t <hash>         print type
 *   lgit cat-file -s <hash>         print size
 *   lgit cat-file -p <hash>         pretty-print content
 *   lgit cat-file <type> <hash>     print raw content
 *
 * Mirrors: git cat-file
 */

import { Repository } from '../core/repository';
import { TreeObject } from '../core/objects/tree';
import { CommitObjectParser } from '../core/objects/commit';
import { TagObjectParser } from '../core/objects/tag';

export type CatFileMode = 'type' | 'size' | 'pretty' | 'raw';

export interface CatFileOptions {
  mode: CatFileMode;
  hash: string;
}

export function catFile(repo: Repository, opts: CatFileOptions): string {
  // Allow abbreviated hashes by scanning all objects
  const hash = resolveAbbrev(repo, opts.hash);
  const { type, content } = repo.store.read(hash);

  switch (opts.mode) {
    case 'type':
      return type;

    case 'size':
      return String(content.length);

    case 'pretty':
      return prettyPrint(repo, type, content, hash);

    case 'raw':
      return content.toString();
  }
}

function prettyPrint(
  repo: Repository,
  type: string,
  content: Buffer,
  _hash: string
): string {
  if (type === 'blob') {
    return content.toString('utf8');
  }

  if (type === 'tree') {
    const tree = TreeObject.deserialize(content);
    return tree.entries
      .map(e => `${e.mode} ${e.name}\0${e.hash}`)
      .join('\n');
  }

  if (type === 'commit') {
    const c = CommitObjectParser.deserialize(content);
    const lines: string[] = [];
    lines.push(`tree ${c.tree}`);
    for (const p of c.parents) lines.push(`parent ${p}`);
    lines.push(`author ${c.author.name} <${c.author.email}> ${c.author.timestamp} ${c.author.timezone}`);
    lines.push(`committer ${c.committer.name} <${c.committer.email}> ${c.committer.timestamp} ${c.committer.timezone}`);
    lines.push('');
    lines.push(c.message);
    return lines.join('\n');
  }

  if (type === 'tag') {
    const t = TagObjectParser.deserialize(content);
    const lines: string[] = [];
    lines.push(`object ${t.object}`);
    lines.push(`type ${t.type}`);
    lines.push(`tag ${t.tag}`);
    if (t.tagger) {
      lines.push(`tagger ${t.tagger.name} <${t.tagger.email}> ${t.tagger.timestamp} ${t.tagger.timezone}`);
    }
    lines.push('');
    lines.push(t.message);
    return lines.join('\n');
  }

  return content.toString('utf8');
}

// Simple prefix-based abbreviation resolution
function resolveAbbrev(repo: Repository, abbrev: string): string {
  if (/^[0-9a-f]{40}$/.test(abbrev)) return abbrev;
  const all = repo.store.listAll();
  const matches = all.filter(h => h.startsWith(abbrev));
  if (matches.length === 0) throw new Error(`Object not found: ${abbrev}`);
  if (matches.length > 1) throw new Error(`Ambiguous object: ${abbrev}`);
  return matches[0];
}
