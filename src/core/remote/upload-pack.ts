/**
 * git-upload-pack client — used for fetch and clone.
 *
 * Smart-HTTP protocol v1 flow:
 *
 *   1. GET  <url>/info/refs?service=git-upload-pack
 *      → ref advertisement (capabilities + SHA→name map)
 *
 *   2. POST <url>/git-upload-pack
 *      → want <sha> <caps>\n   (first want includes capabilities)
 *      → want <sha>\n           (subsequent wants)
 *      → 0000                   (flush)
 *      → have <sha>\n           (objects we already have — empty for clone)
 *      → 0000
 *      → done\n
 *      ← NAK\n  (or ACKs for haves)
 *      ← sideband-64k muxed PACK stream
 *      ← 0000
 *
 * Received pack objects are returned as raw PackObject[] for the caller
 * to write to the object store.
 */

import { httpGet, httpPost } from './transport';
import {
  encodePkt, PKT_FLUSH,
  parseRefAdvertisement, RefAdvertisement, PktLineDecoder,
} from '../pack/pktline';
import { PackfileReader, PackObject } from '../pack/packfile';
import { ObjectStore } from '../objects/store';

export { PackObject };

// ---- ref discovery ---------------------------------------------------------

export async function discoverRefs(url: string): Promise<RefAdvertisement> {
  const infoUrl = `${url}/info/refs?service=git-upload-pack`;
  const resp = await httpGet(infoUrl, {
    'Accept': 'application/x-git-upload-pack-advertisement',
  });

  if (resp.status === 401) throw new Error(`Authentication required for ${url}`);
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status} from ${infoUrl}`);

  const ct = resp.headers['content-type'] ?? '';
  if (!ct.includes('git-upload-pack-advertisement') && !ct.includes('text/plain')) {
    throw new Error(`Unexpected Content-Type from server: ${ct}`);
  }

  return parseRefAdvertisement(resp.body);
}

// ---- fetch / clone negotiation ---------------------------------------------

export interface FetchOptions {
  url:      string;
  wants:    string[];    // SHAs we want
  haves:    string[];    // SHAs we already have (empty for clone)
  store:    ObjectStore; // used to resolve REF_DELTA thin-pack bases
  onProgress?: (msg: string) => void;
}

export interface FetchResult {
  objects:  PackObject[];
  packSize: number;
}

export async function fetchPack(opts: FetchOptions): Promise<FetchResult> {
  if (opts.wants.length === 0) return { objects: [], packSize: 0 };

  // Build want/have lines
  const lines: Buffer[] = [];

  // First want: include capabilities
  const caps = 'side-band-64k ofs-delta no-progress thin-pack include-tag';
  lines.push(encodePkt(`want ${opts.wants[0]} ${caps}\n`));
  for (const sha of opts.wants.slice(1)) {
    lines.push(encodePkt(`want ${sha}\n`));
  }
  lines.push(PKT_FLUSH);

  // Git protocol v1: only emit haves section when we actually have objects.
  // An empty haves section (0000 immediately before "done") confuses servers.
  if (opts.haves.length > 0) {
    for (const sha of opts.haves) {
      lines.push(encodePkt(`have ${sha}\n`));
    }
    lines.push(PKT_FLUSH);
  }

  lines.push(encodePkt('done\n'));

  const reqBody = Buffer.concat(lines);

  const resp = await httpPost(
    `${opts.url}/git-upload-pack`,
    reqBody,
    {
      'Content-Type': 'application/x-git-upload-pack-request',
      'Accept':       'application/x-git-upload-pack-result',
    }
  );

  if (resp.status === 401) throw new Error(`Authentication required for ${opts.url}`);
  if (resp.status !== 200) {
    throw new Error(`HTTP ${resp.status} from git-upload-pack\n${resp.body.subarray(0, 200).toString()}`);
  }

  const packData = demuxSideband(resp.body, opts.onProgress);
  const objects  = PackfileReader.parse(packData, opts.store);

  return { objects, packSize: packData.length };
}

// ---- sideband demultiplexer ------------------------------------------------

/**
 * After the NAK/ACK header lines, the rest of the response body is a stream
 * of pkt-lines where the first byte of each data payload is the band number:
 *   1 → pack data
 *   2 → progress (stderr)
 *   3 → error (fatal)
 */
function demuxSideband(body: Buffer, onProgress?: (m: string) => void): Buffer {
  const decoder  = new PktLineDecoder();
  const packets  = decoder.push(body);
  const packParts: Buffer[] = [];
  let headersDone = false;

  for (const pkt of packets) {
    if (pkt.type === 'flush') { headersDone = true; continue; }
    if (pkt.type !== 'data')  continue;

    if (!headersDone) {
      const line = pkt.data.toString('utf8').replace(/\n$/, '');
      if (line === 'NAK' || line.startsWith('ACK')) { headersDone = true; continue; }
      // ERR responses arrive before sideband begins
      if (line.startsWith('ERR ')) throw new Error(`Remote: ${line.slice(4)}`);
      // Fall through only for sideband-prefixed packets
      if (pkt.data[0] !== 0x01 && pkt.data[0] !== 0x02 && pkt.data[0] !== 0x03) continue;
      headersDone = true; // first sideband packet signals header phase is over
    }

    const band = pkt.data[0];
    const payload = pkt.data.subarray(1);

    if (band === 1) {
      packParts.push(payload);
    } else if (band === 2) {
      onProgress?.(payload.toString('utf8').replace(/\n$/, ''));
    } else if (band === 3) {
      throw new Error(`Remote error: ${payload.toString('utf8')}`);
    }
  }

  if (packParts.length === 0) {
    throw new Error('Server sent no pack data');
  }

  return Buffer.concat(packParts);
}
