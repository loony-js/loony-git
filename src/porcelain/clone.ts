/**
 * clone: create a new repository from a remote URL.
 *
 *   lgit clone <url> [<directory>]
 *
 * Steps:
 *   1. Create the target directory
 *   2. lgit init
 *   3. Store remote 'origin' in config
 *   4. Discover remote refs
 *   5. Fetch all objects (lgit fetch)
 *   6. Set up local branch tracking HEAD
 *   7. Checkout the default branch
 */

import * as fs   from 'fs';
import * as path from 'path';
import { Repository } from '../core/repository';
import { RemoteManager } from '../core/remote/remote';
import { discoverRefs } from '../core/remote/upload-pack';
import { fetch } from './fetch';
import { checkout } from './checkout';

export interface CloneOptions {
  url:          string;
  directory?:   string;
  branch?:      string;   // checkout this branch instead of remote HEAD
  onProgress?:  (msg: string) => void;
}

export async function clone(opts: CloneOptions): Promise<string> {
  // 1. Determine target directory from URL if not given
  const dir = opts.directory ?? urlToDir(opts.url);
  const absDir = path.resolve(dir);

  if (fs.existsSync(absDir) && fs.readdirSync(absDir).length > 0) {
    throw new Error(`fatal: destination path '${dir}' already exists and is not empty`);
  }

  fs.mkdirSync(absDir, { recursive: true });
  const lines: string[] = [`Cloning into '${dir}'...`];

  // 2. Init
  const repo = Repository.init(absDir);

  // 3. Add remote 'origin'
  const mgr = new RemoteManager(repo);
  mgr.add('origin', opts.url);

  // 4. Discover refs so we know what the default branch is
  const advert = await discoverRefs(opts.url);
  if (advert.refs.length === 0) {
    return lines.concat(['warning: You appear to have cloned an empty repository.']).join('\n');
  }

  // Determine default branch from symref HEAD→ or fall back to 'main'/'master'
  const defaultBranch = opts.branch
    ?? advert.symrefs.get('HEAD')?.replace('refs/heads/', '')
    ?? guessDefaultBranch(advert.refs.map(r => r.name));

  // 5. Fetch all objects
  repo.index.load();
  const fetchMsg = await fetch(repo, {
    remote: 'origin',
    onProgress: opts.onProgress,
  });
  if (opts.onProgress) opts.onProgress(fetchMsg);

  // 6. Set up local branch pointing at the fetched remote tip
  const trackRef = `refs/remotes/origin/${defaultBranch}`;
  const remoteSha = repo.refs.resolve(trackRef);

  if (!remoteSha) {
    return lines.concat([`warning: remote HEAD branch '${defaultBranch}' not found`]).join('\n');
  }

  repo.refs.createBranch(defaultBranch, remoteSha);
  repo.refs.writeHead({ type: 'symref', ref: `refs/heads/${defaultBranch}` });

  // Store upstream tracking config
  repo.config.set(`branch.${defaultBranch}`, 'remote', 'origin');
  repo.config.set(`branch.${defaultBranch}`, 'merge',  `refs/heads/${defaultBranch}`);
  repo.config.save();

  // 7. Checkout working directory
  repo.index.load();
  checkout(repo, { target: defaultBranch });

  lines.push(`Branch '${defaultBranch}' set up to track remote branch '${defaultBranch}' from 'origin'.`);
  return lines.join('\n');
}

// ---- helpers ---------------------------------------------------------------

function urlToDir(url: string): string {
  // Strip trailing .git and take the last path component
  const stripped = url.replace(/\.git$/, '').replace(/\/$/, '');
  return path.basename(stripped);
}

function guessDefaultBranch(refNames: string[]): string {
  if (refNames.includes('refs/heads/main'))   return 'main';
  if (refNames.includes('refs/heads/master')) return 'master';
  const heads = refNames.filter(n => n.startsWith('refs/heads/'));
  if (heads.length > 0) return heads[0].slice('refs/heads/'.length);
  return 'main';
}
