/**
 * Git config file parser/writer.
 *
 * Supports the INI-like format Git uses:
 *   [section]
 *       key = value
 *   [section "subsection"]
 *       key = value
 */

import * as fs from 'fs';
import * as path from 'path';

type Section = Record<string, string>;
type ConfigData = Record<string, Section>;

export class GitConfig {
  private data: ConfigData = {};

  constructor(private readonly configPath: string) {}

  load(): void {
    this.data = {};
    if (!fs.existsSync(this.configPath)) return;
    const text = fs.readFileSync(this.configPath, 'utf8');
    this.parse(text);
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, this.serialize());
  }

  get(section: string, key: string): string | undefined {
    return this.data[section]?.[key];
  }

  set(section: string, key: string, value: string): void {
    if (!this.data[section]) this.data[section] = {};
    this.data[section][key] = value;
  }

  getSection(section: string): Section {
    return this.data[section] ?? {};
  }

  private parse(text: string): void {
    let currentSection = '';
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('#') || line.startsWith(';') || line === '') continue;

      const sectionMatch = line.match(/^\[([^\]"]+?)(?:\s+"([^"]+)")?\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[2]
          ? `${sectionMatch[1]}.${sectionMatch[2]}`
          : sectionMatch[1];
        if (!this.data[currentSection]) this.data[currentSection] = {};
        continue;
      }

      const kvMatch = line.match(/^(\w[\w-]*)[ \t]*=[ \t]*(.*)$/);
      if (kvMatch && currentSection) {
        this.data[currentSection][kvMatch[1]] = kvMatch[2].replace(/\s*#.*$/, '').trim();
      }
    }
  }

  private serialize(): string {
    const lines: string[] = [];
    for (const [section, kvs] of Object.entries(this.data)) {
      const dotIdx = section.indexOf('.');
      if (dotIdx !== -1) {
        const name = section.slice(0, dotIdx);
        const sub  = section.slice(dotIdx + 1);
        lines.push(`[${name} "${sub}"]`);
      } else {
        lines.push(`[${section}]`);
      }
      for (const [k, v] of Object.entries(kvs)) {
        lines.push(`\t${k} = ${v}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }
}
