# Object Storage

## Content-addressable storage (CAS)

Every object is identified by the SHA-1 hash of its content. The key insight: if two files have identical content they share a single object. If content changes, a new object is created with a new hash. Nothing is ever overwritten.

### Hash computation

Before hashing, Git prepends a header to the raw content:

```
"<type> <size>\0<content>"
```

For example, a file containing `hello\n`:

```
"blob 6\0hello\n"
        ^NUL byte
```

The SHA-1 of that complete byte sequence is the object's identity.

In code ([src/core/objects/store.ts](../src/core/objects/store.ts)):

```typescript
hash(type: ObjectType, content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\0`);
  return crypto
    .createHash('sha1')
    .update(Buffer.concat([header, content]))
    .digest('hex');
}
```

---

## On-disk format

Objects are stored at:

```
.git/objects/<XX>/<YYYYYY...>
```

where `XX` is the first two hex characters of the SHA-1 and `YYYYYY...` is the remaining 38. This two-level directory structure bounds the number of files per directory to at most 256 buckets.

The file content is the zlib-deflated byte sequence `header + content`. Real Git uses level-1 compression by default for loose objects; `lgit` does the same.

```
write(type, content):
  sha    = SHA-1(header + content)
  data   = zlib.deflate(header + content)
  path   = .git/objects/sha[0:2]/sha[2:]
  write  data → tmp file
  rename tmp  → path          ← atomic
```

Reading reverses the process:

```
read(sha):
  data    = readFile(.git/objects/sha[0:2]/sha[2:])
  raw     = zlib.inflate(data)
  nullPos = raw.indexOf(0x00)
  header  = raw[0 .. nullPos]          → "type size"
  content = raw[nullPos+1 ..]
```

---

## Object types

### Blob

A blob is the raw bytes of a file — no metadata, no filename. Two files with identical content share one blob.

```
blob <size>\0<raw file bytes>
```

### Tree

A tree records a single directory level. Each entry describes one file or subdirectory:

```
<mode> <name>\0<20-byte binary SHA-1>
```

Mode is an ASCII octal string (no leading zero for directories):

| Mode | Meaning |
|---|---|
| `100644` | Regular file |
| `100755` | Executable file |
| `40000` | Directory (subtree) |
| `120000` | Symbolic link |
| `160000` | Gitlink (submodule) |

Entries are sorted so that directory names sort as if they end with `/`. This ensures consistent hashing regardless of insertion order.

```typescript
// Tree entry wire format (one entry)
const header = Buffer.from(`${modeStr} ${entry.name}\0`);
const sha20  = Buffer.from(entry.hash, 'hex');  // 20 raw bytes
```

### Commit

Commits are UTF-8 text with a blank-line separator between header and body:

```
tree <hex-sha>
parent <hex-sha>
parent <hex-sha>       ← zero or more parent lines
author Name <email> <unix-ts> <tz>
committer Name <email> <unix-ts> <tz>

<message body>
```

A root commit (no parents) simply omits the `parent` lines. A merge commit has two or more.

### Tag

An annotated tag wraps any object with a name and optional message:

```
object <hex-sha>
type <blob|tree|commit|tag>
tag <name>
tagger Name <email> <unix-ts> <tz>

<message>
```

Lightweight tags (created by `lgit tag <name>`) are just ref files pointing directly at a commit — no tag object is created.

---

## Abbreviated hashes

`lgit cat-file` and `lgit checkout` accept abbreviated hashes (minimum 7 characters). Resolution scans all loose objects and finds the unique match:

```typescript
function resolveAbbrev(repo, abbrev) {
  if (abbrev.length === 40) return abbrev;
  const matches = repo.store.listAll().filter(h => h.startsWith(abbrev));
  if (matches.length !== 1) throw new Error('ambiguous or missing');
  return matches[0];
}
```

---

## Compatibility with real Git

Because `lgit` implements the same header + zlib format with the same hash computation, its loose objects are byte-for-byte identical to real Git's. You can run `git log`, `git cat-file`, or `git fsck` inside an `lgit`-managed repository and everything works.

Verified:
```bash
# Inside a repo created and committed to by lgit:
git cat-file -p HEAD          # reads lgit commit object
git log --oneline             # walks lgit commit DAG
git fsck                      # reports no corruption
```
