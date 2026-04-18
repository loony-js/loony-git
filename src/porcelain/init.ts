/**
 * init: initialise a new repository.
 *
 *   lgit init [<directory>]
 */

import * as path from 'path';
import { Repository } from '../core/repository';

export function init(dir?: string): string {
  const workDir = dir ? path.resolve(dir) : process.cwd();
  Repository.init(workDir);
  return `Initialized empty Git repository in ${path.join(workDir, '.git')}/`;
}
