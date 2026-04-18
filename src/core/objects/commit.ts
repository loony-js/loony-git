/**
 * Commit object.
 *
 * Text format (identical to real Git):
 *
 *   tree <hex-sha>\n
 *   parent <hex-sha>\n          (zero or more)
 *   author Name <email> ts tz\n
 *   committer Name <email> ts tz\n
 *   \n
 *   <message>
 */

import { CommitObject, PersonInfo } from '../../types';
import { ObjectStore } from './store';

function formatPerson(p: PersonInfo): string {
  return `${p.name} <${p.email}> ${p.timestamp} ${p.timezone}`;
}

function parsePerson(s: string): PersonInfo {
  // "Name <email> timestamp timezone"
  const match = s.match(/^(.+?) <(.+?)> (\d+) ([+-]\d{4})$/);
  if (!match) throw new Error(`Cannot parse person line: ${s}`);
  return {
    name: match[1],
    email: match[2],
    timestamp: parseInt(match[3], 10),
    timezone: match[4],
  };
}

export class CommitObjectParser {
  static serialize(c: CommitObject): Buffer {
    const lines: string[] = [];
    lines.push(`tree ${c.tree}`);
    for (const p of c.parents) lines.push(`parent ${p}`);
    lines.push(`author ${formatPerson(c.author)}`);
    lines.push(`committer ${formatPerson(c.committer)}`);
    lines.push('');
    lines.push(c.message);
    return Buffer.from(lines.join('\n'), 'utf8');
  }

  static deserialize(data: Buffer): CommitObject {
    const text = data.toString('utf8');
    const blankLine = text.indexOf('\n\n');
    if (blankLine === -1) throw new Error('Malformed commit object');

    const header = text.slice(0, blankLine);
    const message = text.slice(blankLine + 2);

    const lines = header.split('\n');
    let tree = '';
    const parents: string[] = [];
    let author!: PersonInfo;
    let committer!: PersonInfo;

    for (const line of lines) {
      if (line.startsWith('tree ')) {
        tree = line.slice(5);
      } else if (line.startsWith('parent ')) {
        parents.push(line.slice(7));
      } else if (line.startsWith('author ')) {
        author = parsePerson(line.slice(7));
      } else if (line.startsWith('committer ')) {
        committer = parsePerson(line.slice(10));
      }
    }

    return { tree, parents, author, committer, message };
  }

  static write(store: ObjectStore, c: CommitObject): string {
    return store.write('commit', CommitObjectParser.serialize(c));
  }

  static read(store: ObjectStore, hash: string): CommitObject {
    const { type, content } = store.read(hash);
    if (type !== 'commit') throw new Error(`Expected commit, got ${type}`);
    return CommitObjectParser.deserialize(content);
  }
}
