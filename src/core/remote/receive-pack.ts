/**
 * git-receive-pack client — used for push.
 *
 * Smart-HTTP protocol v1 flow:
 *
 *   1. GET  <url>/info/refs?service=git-receive-pack
 *      → ref advertisement (what the remote currently has)
 *
 *   2. POST <url>/git-receive-pack
 *      → <old-sha> <new-sha> <refname>\n  (per ref to update)
 *      → 0000
 *      → <PACK file>                       (objects the remote needs)
 *      ← report-status pkt-lines
 *
 * Object enumeration (what to send):
 *   Walk from our tips, stop at any SHA the remote already has.
 *   Include commits, their trees, and all referenced blobs/tags.
 */

import { httpGet, httpPost } from './transport';
import {
  encodePkt, PKT_FLUSH,
  parseRefAdvertisement, RefAdvertisement,
} from '../pack/pktline';
import { buildPackfile } from '../pack/packfile';
import { ObjectStore, RawObject } from '../objects/store';
import { CommitObjectParser } from '../objects/commit';
import { TreeObject } from '../objects/tree';
import { ObjectType } from '../../types';

export { RefAdvertisement };

// ---- ref discovery ---------------------------------------------------------

export async function discoverReceiveRefs(url: string): Promise<RefAdvertisement> {
  const infoUrl = `${url}/info/refs?service=git-receive-pack`;
  const resp = await httpGet(infoUrl, {
    'Accept': 'application/x-git-receive-pack-advertisement',
  });

  if (resp.status === 401) throw new Error(`Authentication required for ${url}`);
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status} from ${infoUrl}`);

  return parseRefAdvertisement(resp.body);
}

// ---- push ------------------------------------------------------------------

export interface RefUpdate {
  refname: string;
  oldSha:  string;  // all-zeros = create
  newSha:  string;  // all-zeros = delete
}

export interface PushOptions {
  url:        string;
  updates:    RefUpdate[];
  store:      ObjectStore;
  remoteShas: Set<string>;   // SHAs the remote already has
  onProgress?: (msg: string) => void;
}

export interface PushResult {
  ok:      string[];    // ref names that succeeded
  failed:  { ref: string; reason: string }[];
}

export async function pushPack(opts: PushOptions): Promise<PushResult> {
  if (opts.updates.length === 0) return { ok: [], failed: [] };

  // --- collect objects to send ---
  const tips = opts.updates
    .filter(u => u.newSha !== '0'.repeat(40))
    .map(u => u.newSha);

  const toSend = collectObjectsForPush(opts.store, tips, opts.remoteShas);

  // --- build request body ---
  const parts: Buffer[] = [];

  // Ref-update commands
  for (const u of opts.updates) {
    parts.push(encodePkt(`${u.oldSha} ${u.newSha} ${u.refname}\n`));
  }
  parts.push(PKT_FLUSH);

  // PACK data (empty pack if no objects to send)
  const pack = buildPackfile(toSend);
  parts.push(pack);

  const reqBody = Buffer.concat(parts);

  const resp = await httpPost(
    `${opts.url}/git-receive-pack`,
    reqBody,
    {
      'Content-Type': 'application/x-git-receive-pack-request',
      'Accept':       'application/x-git-receive-pack-result',
    }
  );

  if (resp.status === 401) throw new Error(`Authentication required for ${opts.url}`);
  if (resp.status !== 200) {
    throw new Error(`HTTP ${resp.status} from git-receive-pack\n${resp.body.slice(0,200).toString()}`);
  }

  return parseReceivePackResponse(resp.body, opts.updates);
}

// ---- object collection -----------------------------------------------------

export function collectObjectsForPush(
  store: ObjectStore,
  tips: string[],
  remoteHas: Set<string>
): Map<string, { type: ObjectType; content: Buffer }> {
  const result  = new Map<string, { type: ObjectType; content: Buffer }>();
  const visited = new Set<string>();
  const queue   = [...tips];

  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (visited.has(sha) || remoteHas.has(sha) || result.has(sha)) continue;
    visited.add(sha);

    if (!store.exists(sha)) continue;

    const { type, content } = store.read(sha) as RawObject;
    result.set(sha, { type: type as ObjectType, content });

    if (type === 'commit') {
      const c = CommitObjectParser.deserialize(content);
      if (!remoteHas.has(c.tree) && !result.has(c.tree)) queue.push(c.tree);
      for (const p of c.parents) {
        if (!remoteHas.has(p) && !result.has(p)) queue.push(p);
      }
    } else if (type === 'tree') {
      const t = TreeObject.deserialize(content);
      for (const e of t.entries) {
        if (!remoteHas.has(e.hash) && !result.has(e.hash)) queue.push(e.hash);
      }
    }
  }

  return result;
}

// ---- response parsing ------------------------------------------------------

function parseReceivePackResponse(body: Buffer, updates: RefUpdate[]): PushResult {
  const text = body.toString('utf8');
  const ok: string[]                          = [];
  const failed: { ref: string; reason: string }[] = [];

  // Basic report-status parsing
  for (const line of text.split('\n')) {
    if (line.startsWith('ok ')) {
      ok.push(line.slice(3).trim());
    } else if (line.startsWith('ng ')) {
      const [, ref, ...reasonParts] = line.split(' ');
      failed.push({ ref, reason: reasonParts.join(' ') });
    }
  }

  // If server sent no report-status, assume all ok (older servers)
  if (ok.length === 0 && failed.length === 0) {
    for (const u of updates) ok.push(u.refname);
  }

  return { ok, failed };
}
