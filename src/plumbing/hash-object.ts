/**
 * hash-object: compute object SHA-1 and optionally store it.
 *
 *   lgit hash-object [-w] [-t <type>] <file>
 *
 * Mirrors: git hash-object
 */

import * as fs from 'fs';
import { Repository } from '../core/repository';
import { ObjectType } from '../types';

export interface HashObjectOptions {
  write: boolean;
  type: ObjectType;
  file: string;
}

export function hashObject(repo: Repository, opts: HashObjectOptions): string {
  const content = fs.readFileSync(opts.file);
  if (opts.write) {
    return repo.store.write(opts.type, content);
  }
  return repo.store.hash(opts.type, content);
}
