/**
 * pkt-line framing — Git's binary wire protocol.
 *
 * Every line is prefixed with a 4-byte ASCII hex length that includes
 * the 4 bytes themselves.  Special sentinel values:
 *   "0000"  flush    — end of a logical message
 *   "0001"  delimiter — protocol-v2 section separator
 *   "0002"  response-end — protocol-v2 stream end
 */

export type PktLinePacket =
  | { type: 'data';      data: Buffer }
  | { type: 'flush' }
  | { type: 'delimiter' }
  | { type: 'response-end' };

// ---- encoder ---------------------------------------------------------------

export function encodePkt(data: Buffer | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  const len = buf.length + 4;
  if (len > 65520) throw new Error(`pkt-line too long: ${len}`);
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0')), buf]);
}

export const PKT_FLUSH     = Buffer.from('0000');
export const PKT_DELIMITER = Buffer.from('0001');

export function encodePktList(lines: (Buffer | string)[]): Buffer {
  return Buffer.concat(lines.map(l => encodePkt(l)));
}

// ---- decoder ---------------------------------------------------------------

/**
 * Stateful streaming decoder.  Push chunks of received data with push();
 * it returns fully-parsed packets as they complete.
 */
export class PktLineDecoder {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): PktLinePacket[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: PktLinePacket[] = [];

    while (this.buf.length >= 4) {
      const lenStr = this.buf.subarray(0, 4).toString('ascii');

      if (lenStr === '0000') { out.push({ type: 'flush' });         this.buf = this.buf.subarray(4); continue; }
      if (lenStr === '0001') { out.push({ type: 'delimiter' });     this.buf = this.buf.subarray(4); continue; }
      if (lenStr === '0002') { out.push({ type: 'response-end' });  this.buf = this.buf.subarray(4); continue; }

      const len = parseInt(lenStr, 16);
      if (isNaN(len) || len < 4) throw new Error(`Invalid pkt-line length: "${lenStr}"`);
      if (this.buf.length < len) break;          // wait for more data

      const data = this.buf.subarray(4, len);
      out.push({ type: 'data', data });
      this.buf = this.buf.subarray(len);
    }

    return out;
  }

  remaining(): Buffer { return this.buf; }
}

// ---- one-shot parse (for complete buffers) ---------------------------------

export function parsePktLines(buf: Buffer): PktLinePacket[] {
  const dec = new PktLineDecoder();
  return dec.push(buf);
}

// ---- ref-advertisement parser ----------------------------------------------

export interface AdvertisedRef {
  sha:  string;
  name: string;
}

export interface RefAdvertisement {
  refs: AdvertisedRef[];
  capabilities: Set<string>;
  symrefs: Map<string, string>;    // e.g. HEAD → refs/heads/main
}

/**
 * Parse the ref-advertisement body sent by git-upload-pack /
 * git-receive-pack.  The first ref line carries NUL-separated capabilities.
 */
export function parseRefAdvertisement(body: Buffer): RefAdvertisement {
  const packets = parsePktLines(body);
  const refs: AdvertisedRef[] = [];
  const capabilities = new Set<string>();
  const symrefs = new Map<string, string>();
  let first = true;

  for (const pkt of packets) {
    if (pkt.type !== 'data') continue;
    const line = pkt.data.toString('utf8').replace(/\n$/, '');

    if (first && line.startsWith('# service=')) { first = false; continue; }

    const nullIdx = line.indexOf('\0');
    if (nullIdx !== -1) {
      // First ref line: "<sha> <name>\0<caps>"
      const refPart = line.slice(0, nullIdx);
      const capPart = line.slice(nullIdx + 1);

      for (const cap of capPart.split(' ')) {
        if (cap.startsWith('symref=')) {
          const [src, dst] = cap.slice(7).split(':');
          if (src && dst) symrefs.set(src, dst);
        } else if (cap) {
          capabilities.add(cap);
        }
      }

      const [sha, name] = refPart.split(' ');
      if (sha && name) refs.push({ sha, name });
    } else {
      const [sha, name] = line.split(' ');
      if (sha && name) refs.push({ sha, name });
    }
    first = false;
  }

  return { refs, capabilities, symrefs };
}
