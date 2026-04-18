/**
 * update-index: register file content in the index.
 *
 *   lgit update-index --add <file>
 *   lgit update-index --remove <file>
 *   lgit update-index --cacheinfo <mode>,<hash>,<path>
 *
 * Mirrors: git update-index
 */

import * as fs from 'fs';
import * as path from 'path';
import { Repository } from '../core/repository';
import { BlobObject } from '../core/objects/blob';
import { statToIndexEntry } from '../core/index/index';

export interface UpdateIndexOptions {
  add?: string[];
  remove?: string[];
  cacheinfo?: Array<{ mode: number; hash: string; name: string }>;
}

export function updateIndex(repo: Repository, opts: UpdateIndexOptions): void {
  if (opts.add) {
    for (const file of opts.add) {
      const abs = path.resolve(repo.workDir, file);
      if (!fs.existsSync(abs)) {
        throw new Error(`File not found: ${file}`);
      }
      const content = fs.readFileSync(abs);
      const hash = BlobObject.write(repo.store, content);
      const rel = repo.relativePath(abs);
      const entry = statToIndexEntry(abs, rel, hash);
      repo.index.add(entry);
    }
  }

  if (opts.remove) {
    for (const file of opts.remove) {
      const rel = path.relative(repo.workDir, path.resolve(repo.workDir, file));
      repo.index.remove(rel);
    }
  }

  if (opts.cacheinfo) {
    for (const ci of opts.cacheinfo) {
      repo.index.add({
        ctimeSec: 0, ctimeNsec: 0,
        mtimeSec: 0, mtimeNsec: 0,
        dev: 0, ino: 0,
        mode: ci.mode,
        uid: 0, gid: 0, size: 0,
        hash: ci.hash,
        flags: 0,
        name: ci.name,
      });
    }
  }

  repo.index.save();
}
