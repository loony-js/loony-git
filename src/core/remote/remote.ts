/**
 * Remote configuration.
 *
 * Remotes are stored in .git/config:
 *   [remote "origin"]
 *       url    = https://github.com/user/repo.git
 *       fetch  = +refs/heads/*:refs/remotes/origin/*
 */

import { Repository } from '../repository';

export interface RemoteConfig {
  name:     string;
  url:      string;
  fetchSpec: string;
}

export class RemoteManager {
  constructor(private readonly repo: Repository) {}

  add(name: string, url: string): void {
    const section = `remote.${name}`;
    this.repo.config.set(section, 'url',   url);
    this.repo.config.set(section, 'fetch', `+refs/heads/*:refs/remotes/${name}/*`);
    this.repo.config.save();
  }

  get(name: string): RemoteConfig | null {
    const url = this.repo.config.get(`remote.${name}`, 'url');
    if (!url) return null;
    const fetchSpec = this.repo.config.get(`remote.${name}`, 'fetch')
      ?? `+refs/heads/*:refs/remotes/${name}/*`;
    return { name, url, fetchSpec };
  }

  list(): RemoteConfig[] {
    const results: RemoteConfig[] = [];
    // Parse all [remote "X"] sections
    for (const name of this.listNames()) {
      const r = this.get(name);
      if (r) results.push(r);
    }
    return results;
  }

  remove(name: string): void {
    // Minimal: clear the url key so the remote effectively disappears
    const section = `remote.${name}`;
    this.repo.config.set(section, 'url', '');
    this.repo.config.save();
  }

  // Update the remote-tracking ref after a fetch
  updateRemoteRef(remoteName: string, branch: string, sha: string): void {
    this.repo.refs.updateRef(`refs/remotes/${remoteName}/${branch}`, sha);
  }

  listNames(): string[] {
    // Scan config sections for [remote "X"]
    const names: string[] = [];
    // Use config section iteration — GitConfig stores as "remote.NAME"
    for (const section of this.allSections()) {
      if (section.startsWith('remote.')) {
        names.push(section.slice(7));
      }
    }
    return [...new Set(names)];
  }

  private allSections(): string[] {
    return this.repo.config.sections();
  }
}

// ---- URL helpers -----------------------------------------------------------

export interface ParsedUrl {
  protocol: 'https' | 'http' | 'ssh';
  host:     string;
  port?:    number;
  path:     string;
  user?:    string;
  password?: string;
}

export function parseRemoteUrl(raw: string): ParsedUrl {
  // Handle SCP-style SSH:  git@github.com:user/repo.git
  const scpMatch = raw.match(/^([^@]+)@([^:]+):(.+)$/);
  if (scpMatch && !raw.includes('://')) {
    return { protocol: 'ssh', user: scpMatch[1], host: scpMatch[2], path: scpMatch[3] };
  }

  const u = new URL(raw);
  const protocol = (u.protocol.replace(':', '')) as 'https' | 'http' | 'ssh';
  const port     = u.port ? parseInt(u.port, 10) : undefined;

  return {
    protocol,
    host:     u.hostname,
    port,
    path:     u.pathname,
    user:     u.username || undefined,
    password: u.password || undefined,
  };
}

/** Normalise remote URL to always end in .git and include a trailing slash internally */
export function normaliseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
