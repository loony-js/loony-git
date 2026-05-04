/**
 * Server-side git smart-HTTP protocol handlers.
 *
 * Implements the stateless-RPC server side of:
 *   - git-upload-pack  (serve fetch/clone)
 *   - git-receive-pack (accept push)
 *
 * Invoked by the HTTP server as:
 *   lgit upload-pack  --stateless-rpc [--advertise-refs] <repo>
 *   lgit receive-pack --stateless-rpc [--advertise-refs] <repo>
 */

import * as fs from "fs";
import * as path from "path";
import { ObjectStore } from "../objects/store";
import { Refs } from "../refs/refs";
import { PackfileReader, buildPackfile } from "../pack/packfile";
import { encodePkt, PKT_FLUSH, parsePktLines } from "../pack/pktline";
import { ObjectType } from "../../types";
import { CommitObjectParser } from "../objects/commit";
import { TreeObject } from "../objects/tree";

// ---- bare vs non-bare repo -------------------------------------------------

function resolveGitDir(repoPath: string): string {
  const bare = path.join(repoPath, "HEAD");
  if (fs.existsSync(bare)) return repoPath;          // bare repo
  return resolveGitDir(repoPath);                // normal repo
}

// ---- stdin helper ----------------------------------------------------------

function readStdin(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

// ---- shared ref advertisement ----------------------------------------------

function collectAllRefs(refs: Refs): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];

  for (const b of refs.listBranches()) {
    const sha = refs.resolve(`refs/heads/${b}`);
    if (sha) out.push({ name: `refs/heads/${b}`, sha });
  }
  for (const t of refs.listTags()) {
    const sha = refs.resolve(`refs/tags/${t}`);
    if (sha) out.push({ name: `refs/tags/${t}`, sha });
  }

  const headSha = refs.resolveHead();
  if (headSha) {
    out.unshift({ name: "HEAD", sha: headSha });
  }

  return out;
}

function writeRefAdvertisement(refs: Refs, capabilities: string): Buffer {
  const allRefs = collectAllRefs(refs);
  const parts: Buffer[] = [];

  if (allRefs.length === 0) {
    const nullSha = "0".repeat(40);
    parts.push(encodePkt(`${nullSha} capabilities^{}\0${capabilities}\n`));
  } else {
    for (let i = 0; i < allRefs.length; i++) {
      const { sha, name } = allRefs[i];
      const line =
        i === 0 ? `${sha} ${name}\0${capabilities}\n` : `${sha} ${name}\n`;
      parts.push(encodePkt(line));
    }
  }

  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---- upload-pack (serve fetch/clone) ---------------------------------------

export function uploadPackAdvertise(repoPath: string): void {
  const gitDir = resolveGitDir(repoPath);
  const refs = new Refs(gitDir);

  const head = refs.readHead();
  const symrefCap = head.type === "symref" ? `symref=HEAD:${head.ref}` : "";
  const caps = ["side-band-64k", "ofs-delta", "no-progress", symrefCap]
    .filter(Boolean)
    .join(" ");

  process.stdout.write(writeRefAdvertisement(refs, caps));
}

export async function uploadPackStateless(repoPath: string): Promise<void> {
  const gitDir = resolveGitDir(repoPath);
  const store = new ObjectStore(gitDir);

  const input = await readStdin();
  const packets = parsePktLines(input);

  const wants: string[] = [];
  const haves: string[] = [];

  for (const pkt of packets) {
    if (pkt.type !== "data") continue;
    const line = pkt.data.toString("utf8").trim();
    if (line.startsWith("want ")) wants.push(line.slice(5, 45));
    else if (line.startsWith("have ")) haves.push(line.slice(5, 45));
  }

  process.stdout.write(encodePkt("NAK\n"));

  if (wants.length === 0) return;

  const toSend = collectReachable(store, wants, new Set(haves));
  const pack = buildPackfile(toSend);

  const BAND_SIZE = 65515;
  for (let offset = 0; offset < pack.length; offset += BAND_SIZE) {
    const chunk = pack.subarray(offset, offset + BAND_SIZE);
    const payload = Buffer.allocUnsafe(1 + chunk.length);
    payload[0] = 1;
    chunk.copy(payload, 1);
    process.stdout.write(encodePkt(payload));
  }

  process.stdout.write(PKT_FLUSH);
}

// ---- receive-pack (accept push) --------------------------------------------

export function receivePackAdvertise(repoPath: string): void {
  const gitDir = resolveGitDir(repoPath);
  const refs = new Refs(gitDir);

  const head = refs.readHead();
  const symrefCap = head.type === "symref" ? `symref=HEAD:${head.ref}` : "";
  const caps = [
    "report-status",
    "side-band-64k",
    "ofs-delta",
    "delete-refs",
    symrefCap,
  ]
    .filter(Boolean)
    .join(" ");

  process.stdout.write(writeRefAdvertisement(refs, caps));
}

export async function receivePackStateless(repoPath: string): Promise<void> {
  const gitDir = resolveGitDir(repoPath);
  const store = new ObjectStore(gitDir);
  const refs = new Refs(gitDir);

  const input = await readStdin();

  // Parse ref-update command pkt-lines up to flush, then raw PACK follows
  const updates: Array<{ old: string; new: string; ref: string }> = [];
  let pos = 0;

  while (pos < input.length) {
    if (input.length - pos < 4) break;
    const lenStr = input.subarray(pos, pos + 4).toString("ascii");
    if (lenStr === "0000") {
      pos += 4;
      break;
    }
    const len = parseInt(lenStr, 16);
    if (isNaN(len) || len < 4) break;
    const line = input
      .subarray(pos + 4, pos + len)
      .toString("utf8")
      .replace(/\0.*/, "")
      .trim();
    pos += len;

    const parts = line.split(" ");
    if (parts.length >= 3) {
      updates.push({ old: parts[0], new: parts[1], ref: parts[2] });
    }
  }

  // Store incoming objects
  const packData = input.subarray(pos);
  if (packData.length >= 4 && packData.subarray(0, 4).toString() === "PACK") {
    const objects = PackfileReader.parse(packData, store);
    for (const obj of objects) {
      store.write(obj.type as ObjectType, obj.content);
    }
  }

  // Apply ref updates
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const u of updates) {
    try {
      if (u.new === "0".repeat(40)) {
        refs.deleteRef(u.ref);
      } else {
        refs.updateRef(u.ref, u.new);
      }
      results.push({ ref: u.ref, ok: true });
    } catch (e: any) {
      results.push({ ref: u.ref, ok: false, reason: e.message });
    }
  }

  // Send report-status
  const reportParts: Buffer[] = [encodePkt("unpack ok\n")];
  for (const r of results) {
    reportParts.push(
      r.ok
        ? encodePkt(`ok ${r.ref}\n`)
        : encodePkt(`ng ${r.ref} ${r.reason}\n`),
    );
  }
  reportParts.push(PKT_FLUSH);
  process.stdout.write(Buffer.concat(reportParts));
}

// ---- object collection -----------------------------------------------------

function collectReachable(
  store: ObjectStore,
  tips: string[],
  exclude: Set<string>,
): Map<string, { type: ObjectType; content: Buffer }> {
  const result = new Map<string, { type: ObjectType; content: Buffer }>();
  const visited = new Set<string>();
  const queue = [...tips];

  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (visited.has(sha) || exclude.has(sha) || result.has(sha)) continue;
    visited.add(sha);
    if (!store.exists(sha)) continue;

    const { type, content } = store.read(sha);
    result.set(sha, { type: type as ObjectType, content });

    if (type === "commit") {
      const c = CommitObjectParser.deserialize(content);
      if (!exclude.has(c.tree)) queue.push(c.tree);
      for (const p of c.parents) if (!exclude.has(p)) queue.push(p);
    } else if (type === "tree") {
      const t = TreeObject.deserialize(content);
      for (const e of t.entries) if (!exclude.has(e.hash)) queue.push(e.hash);
    }
  }

  return result;
}
