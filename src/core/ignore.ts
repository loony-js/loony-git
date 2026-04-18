/**
 * .gitignore rule engine.
 *
 * Pattern semantics (mirrors Git exactly):
 *   - Blank lines and lines starting with # are ignored.
 *   - A leading ! negates the pattern (un-ignores a previously ignored path).
 *   - A leading / anchors the pattern to the directory containing the ignore file.
 *   - A trailing / matches directories only.
 *   - * matches anything except /
 *   - ? matches any single character except /
 *   - ** matches zero or more path components (any /)
 *   - [abc] / [a-z] character classes work as in glob
 *
 * Load order (later rules override earlier ones for the same path):
 *   1. .git/info/exclude
 *   2. $HOME/.gitignore_global  (core.excludesFile in config)
 *   3. .gitignore files in each directory, applied to that directory
 */

import * as fs from 'fs';
import * as path from 'path';

interface IgnoreRule {
  pattern:  RegExp;
  negated:  boolean;
  dirOnly:  boolean;
  baseDir:  string;   // absolute path of the directory this rule applies from
}

export class GitIgnore {
  private rules: IgnoreRule[] = [];

  constructor(private readonly workDir: string, private readonly gitDir: string) {}

  // Load all applicable ignore files for the repository
  loadAll(configExcludesFile?: string): void {
    this.rules = [];

    // 1. .git/info/exclude
    const infoExclude = path.join(this.gitDir, 'info', 'exclude');
    if (fs.existsSync(infoExclude)) {
      this.loadFile(infoExclude, this.workDir);
    }

    // 2. Global gitignore
    if (configExcludesFile && fs.existsSync(configExcludesFile)) {
      this.loadFile(configExcludesFile, this.workDir);
    }

    // 3. Per-directory .gitignore files
    this.loadDir(this.workDir);
  }

  // Returns true if the path should be ignored
  // relPath: forward-slash path relative to workDir
  // isDir:   whether the path is a directory
  isIgnored(relPath: string, isDir: boolean): boolean {
    let ignored = false;

    for (const rule of this.rules) {
      // The rule's baseDir relative to workDir
      const relBase = path.relative(this.workDir, rule.baseDir)
        .split(path.sep).join('/');

      // The path must be inside the rule's base directory
      const pathToMatch = relBase
        ? (relPath.startsWith(relBase + '/') ? relPath.slice(relBase.length + 1) : null)
        : relPath;

      if (pathToMatch === null) continue;

      // dirOnly rules only match directories
      if (rule.dirOnly && !isDir) continue;

      if (rule.pattern.test(pathToMatch)) {
        ignored = !rule.negated;
      }
    }

    return ignored;
  }

  // ---- loading ------------------------------------------------------------

  private loadDir(dir: string): void {
    const ignoreFile = path.join(dir, '.gitignore');
    if (fs.existsSync(ignoreFile)) {
      this.loadFile(ignoreFile, dir);
    }
    // Recurse into subdirectories (skip .git)
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(dir, entry.name);
      if (path.resolve(abs) === path.resolve(this.gitDir)) continue;
      this.loadDir(abs);
    }
  }

  private loadFile(filePath: string, baseDir: string): void {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const raw of lines) {
      const rule = parseLine(raw, baseDir);
      if (rule) this.rules.push(rule);
    }
  }
}

// ---- pattern parsing -------------------------------------------------------

function parseLine(raw: string, baseDir: string): IgnoreRule | null {
  // Strip trailing spaces (unless escaped)
  let line = raw.replace(/(?<!\\) +$/, '');
  if (line === '' || line.startsWith('#')) return null;

  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  }

  // Trailing slash → directory only
  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }

  // Leading slash anchors to baseDir; strip it
  if (line.startsWith('/')) {
    line = line.slice(1);
  }

  const pattern = patternToRegex(line);
  return { pattern, negated, dirOnly, baseDir };
}

// Convert a gitignore glob pattern to a RegExp
function patternToRegex(pattern: string): RegExp {
  let re = '';
  let i  = 0;

  while (i < pattern.length) {
    // **/ or /** or **
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        // **/ = zero or more directories
        re += '(?:.+/)?';
        i += 3;
      } else if (i > 0 && pattern[i - 1] === '/') {
        // /** = anything including nothing
        re += '.*';
        i += 2;
      } else {
        re += '.*';
        i += 2;
      }
      continue;
    }

    switch (pattern[i]) {
      case '*':
        re += '[^/]*';
        break;
      case '?':
        re += '[^/]';
        break;
      case '[': {
        // Character class — pass through
        const end = pattern.indexOf(']', i + 1);
        if (end === -1) {
          re += '\\[';
        } else {
          re += pattern.slice(i, end + 1);
          i = end;
        }
        break;
      }
      case '.':
      case '+':
      case '^':
      case '$':
      case '{':
      case '}':
      case '(':
      case ')':
      case '|':
      case '\\':
        re += '\\' + pattern[i];
        break;
      default:
        re += pattern[i];
    }
    i++;
  }

  // A pattern without a slash matches against the filename only (any depth)
  // A pattern with a slash matches against the full relative path
  const hasSlash = pattern.includes('/');
  const anchor   = hasSlash ? '^' : '(?:^|.*/)';

  return new RegExp(`${anchor}${re}$`);
}
