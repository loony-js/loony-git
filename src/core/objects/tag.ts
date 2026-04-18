/**
 * Annotated tag object.
 *
 * Text format:
 *   object <hex-sha>\n
 *   type <type>\n
 *   tag <name>\n
 *   tagger Name <email> ts tz\n
 *   \n
 *   <message>
 */

import { TagObject, ObjectType, PersonInfo } from '../../types';
import { ObjectStore } from './store';

function formatPerson(p: PersonInfo): string {
  return `${p.name} <${p.email}> ${p.timestamp} ${p.timezone}`;
}

function parsePerson(s: string): PersonInfo {
  const match = s.match(/^(.+?) <(.+?)> (\d+) ([+-]\d{4})$/);
  if (!match) throw new Error(`Cannot parse tagger line: ${s}`);
  return {
    name: match[1],
    email: match[2],
    timestamp: parseInt(match[3], 10),
    timezone: match[4],
  };
}

export class TagObjectParser {
  static serialize(t: TagObject): Buffer {
    const lines: string[] = [];
    lines.push(`object ${t.object}`);
    lines.push(`type ${t.type}`);
    lines.push(`tag ${t.tag}`);
    if (t.tagger) lines.push(`tagger ${formatPerson(t.tagger)}`);
    lines.push('');
    lines.push(t.message);
    return Buffer.from(lines.join('\n'), 'utf8');
  }

  static deserialize(data: Buffer): TagObject {
    const text = data.toString('utf8');
    const blankLine = text.indexOf('\n\n');
    const header = blankLine !== -1 ? text.slice(0, blankLine) : text;
    const message = blankLine !== -1 ? text.slice(blankLine + 2) : '';

    let object = '';
    let type: ObjectType = 'commit';
    let tag = '';
    let tagger: PersonInfo | undefined;

    for (const line of header.split('\n')) {
      if (line.startsWith('object ')) object = line.slice(7);
      else if (line.startsWith('type ')) type = line.slice(5) as ObjectType;
      else if (line.startsWith('tag ')) tag = line.slice(4);
      else if (line.startsWith('tagger ')) tagger = parsePerson(line.slice(7));
    }

    return { object, type, tag, tagger, message };
  }

  static write(store: ObjectStore, t: TagObject): string {
    return store.write('tag', TagObjectParser.serialize(t));
  }

  static read(store: ObjectStore, hash: string): TagObject {
    const { type, content } = store.read(hash);
    if (type !== 'tag') throw new Error(`Expected tag, got ${type}`);
    return TagObjectParser.deserialize(content);
  }
}
