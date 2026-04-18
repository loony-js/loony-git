/**
 * Repository — top-level context object.
 *
 * Locates the .git directory, wires together the object store,
 * index, refs, and config. All commands receive a Repository.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ObjectStore } from './objects/store';
import { GitIndex } from './index/index';
import { Refs } from './refs/refs';
import { GitConfig } from './config';

export class Repository {
  readonly gitDir: string;
  readonly workDir: string;
  readonly store: ObjectStore;
  readonly index: GitIndex;
  readonly refs: Refs;
  readonly config: GitConfig;

  private constructor(workDir: string, gitDir: string) {
    this.workDir = workDir;
    this.gitDir  = gitDir;
    this.store   = new ObjectStore(gitDir);
    this.index   = new GitIndex(path.join(gitDir, 'index'));
    this.refs    = new Refs(gitDir);
    this.config  = new GitConfig(path.join(gitDir, 'config'));
  }

  // Walk up from cwd looking for a .git directory
  static find(startDir: string = process.cwd()): Repository {
    let dir = path.resolve(startDir);
    while (true) {
      const candidate = path.join(dir, '.git');
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        const repo = new Repository(dir, candidate);
        repo.index.load();
        repo.config.load();
        return repo;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        throw new Error('Not a git repository (or any of the parent directories)');
      }
      dir = parent;
    }
  }

  // Create a new bare .git skeleton
  static init(workDir: string): Repository {
    const gitDir = path.join(workDir, '.git');
    fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'objects', 'pack'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'refs', 'tags'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'logs', 'refs', 'heads'), { recursive: true });

    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(gitDir, 'description'),
      'Unnamed repository; edit this file to name the repository.\n');

    const repo = new Repository(workDir, gitDir);
    repo.config.set('core', 'repositoryformatversion', '0');
    repo.config.set('core', 'filemode', 'true');
    repo.config.set('core', 'bare', 'false');
    repo.config.set('core', 'logallrefupdates', 'true');
    repo.config.save();

    return repo;
  }

  // Convenience: author info from config with fallback to env
  getAuthor(): { name: string; email: string } {
    const name  = process.env.GIT_AUTHOR_NAME
      || this.config.get('user', 'name')
      || 'Unknown';
    const email = process.env.GIT_AUTHOR_EMAIL
      || this.config.get('user', 'email')
      || 'unknown@example.com';
    return { name, email };
  }

  // Relative path from workDir
  relativePath(absPath: string): string {
    return path.relative(this.workDir, absPath);
  }
}
