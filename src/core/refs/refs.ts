/**
 * Reference management.
 *
 * Mirrors Git's ref storage:
 *   - HEAD is a symref: "ref: refs/heads/<branch>\n"
 *     or a detached commit hash
 *   - Branch refs: .git/refs/heads/<name>  (file containing 40-char hex SHA)
 *   - Tag refs:    .git/refs/tags/<name>
 *   - Remote refs: .git/refs/remotes/<remote>/<name>
 *
 * Reflogs are written to .git/logs/ when enabled.
 */

import * as fs from 'fs';
import * as path from 'path';

export type RefTarget =
  | { type: 'sha'; hash: string }
  | { type: 'symref'; ref: string };

export class Refs {
  constructor(private readonly gitDir: string) {}

  private get refsDir(): string  { return path.join(this.gitDir, 'refs'); }
  private get headPath(): string { return path.join(this.gitDir, 'HEAD'); }

  // ---- HEAD --------------------------------------------------------------

  readHead(): RefTarget {
    const content = fs.readFileSync(this.headPath, 'utf8').trim();
    if (content.startsWith('ref: ')) {
      return { type: 'symref', ref: content.slice(5) };
    }
    return { type: 'sha', hash: content };
  }

  writeHead(target: RefTarget): void {
    if (target.type === 'symref') {
      fs.writeFileSync(this.headPath, `ref: ${target.ref}\n`);
    } else {
      fs.writeFileSync(this.headPath, `${target.hash}\n`);
    }
  }

  // Resolve HEAD to a commit SHA (or null if repo is empty)
  resolveHead(): string | null {
    return this.resolveTarget(this.readHead());
  }

  currentBranch(): string | null {
    const head = this.readHead();
    if (head.type !== 'symref') return null;
    const prefix = 'refs/heads/';
    if (head.ref.startsWith(prefix)) return head.ref.slice(prefix.length);
    return null;
  }

  // ---- Generic ref read/write --------------------------------------------

  resolve(ref: string): string | null {
    // Allow short branch names as well as full ref paths
    const candidates = [
      ref,
      `refs/heads/${ref}`,
      `refs/tags/${ref}`,
      `refs/remotes/${ref}`,
    ];

    for (const candidate of candidates) {
      const p = path.join(this.gitDir, candidate);
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf8').trim();
        if (content.startsWith('ref: ')) {
          return this.resolve(content.slice(5));
        }
        if (/^[0-9a-f]{40}$/.test(content)) return content;
      }
    }
    return null;
  }

  updateRef(ref: string, hash: string): void {
    const refPath = path.join(this.gitDir, ref);
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, `${hash}\n`);
  }

  deleteRef(ref: string): void {
    const refPath = path.join(this.gitDir, ref);
    if (fs.existsSync(refPath)) fs.unlinkSync(refPath);
  }

  // ---- Branches ----------------------------------------------------------

  listBranches(): string[] {
    const headsDir = path.join(this.refsDir, 'heads');
    if (!fs.existsSync(headsDir)) return [];
    return this.walkRefs(headsDir, headsDir);
  }

  branchExists(name: string): boolean {
    return fs.existsSync(path.join(this.refsDir, 'heads', name));
  }

  createBranch(name: string, hash: string): void {
    this.updateRef(`refs/heads/${name}`, hash);
  }

  deleteBranch(name: string): void {
    this.deleteRef(`refs/heads/${name}`);
  }

  // ---- Tags --------------------------------------------------------------

  listTags(): string[] {
    const tagsDir = path.join(this.refsDir, 'tags');
    if (!fs.existsSync(tagsDir)) return [];
    return this.walkRefs(tagsDir, tagsDir);
  }

  createTag(name: string, hash: string): void {
    this.updateRef(`refs/tags/${name}`, hash);
  }

  // ---- Reflogs -----------------------------------------------------------

  appendReflog(
    ref: string,
    oldHash: string,
    newHash: string,
    message: string,
    author: { name: string; email: string; timestamp: number; timezone: string }
  ): void {
    const logPath = path.join(this.gitDir, 'logs', ref);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const line = `${oldHash.padEnd(40, '0')} ${newHash} ${author.name} <${author.email}> ${author.timestamp} ${author.timezone}\t${message}\n`;
    fs.appendFileSync(logPath, line);
  }

  // ---- Helpers -----------------------------------------------------------

  private resolveTarget(target: RefTarget): string | null {
    if (target.type === 'sha') return target.hash;
    return this.resolve(target.ref);
  }

  private walkRefs(dir: string, base: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const sub of this.walkRefs(full, base)) {
          results.push(`${entry.name}/${sub}`);
        }
      } else {
        results.push(entry.name);
      }
    }
    return results;
  }
}
