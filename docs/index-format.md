# Index Format

The index (`.git/index`) is Git's staging area — the intermediate state between the working directory and the next commit. It is a binary file with precise alignment requirements.

## Role of the index

```
working directory  ──add──►  index  ──commit──►  object store / commit tree
                  ◄─checkout──       ◄─read-tree──
```

The index tracks:

- Which files are staged (path + blob SHA)
- Per-file metadata from the last `stat()` call (mtime, ctime, size, inode)
- File mode (regular file vs executable)

The stat metadata enables the "racy-git" optimisation: if a file's mtime and size match the cached entry, its content is assumed unchanged and the blob hash is not recomputed.

---

## On-disk layout (v2)

```
┌──────────────────────────────────┐
│  Header (12 bytes)               │
│    4B  "DIRC"  signature         │
│    4B  version (2)               │
│    4B  entry count               │
├──────────────────────────────────┤
│  Entry 0                         │
│  Entry 1                         │
│  ...                             │
├──────────────────────────────────┤
│  Extensions (optional, skipped)  │
├──────────────────────────────────┤
│  SHA-1 checksum (20 bytes)       │
│  (SHA-1 of everything above)     │
└──────────────────────────────────┘
```

### Entry layout

Each entry has a 62-byte fixed section followed by a variable-length name:

```
Offset  Size  Field
──────  ────  ─────────────────────────
  0      4    ctime seconds
  4      4    ctime nanoseconds
  8      4    mtime seconds
 12      4    mtime nanoseconds
 16      4    dev
 20      4    ino
 24      4    mode  (e.g. 0o100644)
 28      4    uid
 32      4    gid
 36      4    file size
 40     20    SHA-1 of blob (binary, 20 bytes)
 60      2    flags
              bits 0-11:  name length (capped at 0xFFF)
              bits 12-13: stage (0 = normal, 1-3 = merge conflict)
              bit  14:    extended (v3 only)
              bit  15:    assume-valid
 62      N    name (UTF-8, NUL-terminated)
  ?      P    NUL padding to next 8-byte boundary
              (counted from the start of the entry)
```

The total entry size is always a multiple of 8 bytes.

### 8-byte alignment example

A file named `src/main.rs` (11 bytes):

```
62 (fixed) + 11 (name) + 1 (NUL) = 74 bytes
ceil(74 / 8) * 8 = 80 bytes
padding = 80 - 74 = 6 NUL bytes
```

---

## Implementation

### `GitIndex` class ([src/core/index/index.ts](../src/core/index/index.ts))

```typescript
class GitIndex {
  load(): void           // parse .git/index from disk
  save(): void           // serialize and write atomically
  add(entry): void       // stage a file (overwrites by path)
  remove(name): boolean  // unstage a file
  get(name): IndexEntry  // lookup by path
  getAll(): IndexEntry[] // sorted by name (Git requirement)
  clear(): void          // wipe all entries
}
```

Entries are stored in a `Map<string, IndexEntry>` keyed by path. `getAll()` returns them sorted, which is required for consistent tree hashing.

### Building an entry from `stat()`

```typescript
function statToIndexEntry(filePath, relName, blobHash): IndexEntry {
  const stat = fs.statSync(filePath);
  return {
    mtimeSec:  Math.floor(stat.mtimeMs / 1000),
    mtimeNsec: (stat.mtimeMs % 1000) * 1_000_000,
    ctimeSec:  Math.floor(stat.ctimeMs / 1000),
    ctimeNsec: (stat.ctimeMs % 1000) * 1_000_000,
    dev:  stat.dev  >>> 0,
    ino:  stat.ino  >>> 0,
    mode: stat.mode & 0o111 ? 0o100755 : 0o100644,
    uid:  stat.uid  >>> 0,
    gid:  stat.gid  >>> 0,
    size: stat.size >>> 0,
    hash: blobHash,
    flags: 0,
    name: relName,
  };
}
```

The `>>> 0` coerces to unsigned 32-bit integer, which is required because Node's `stat` returns signed values on some platforms.

---

## Index vs HEAD vs working directory

`lgit status` performs two diffs:

### HEAD → index (staged changes)

Flatten the HEAD commit's tree into a `Map<path, sha>`. Compare every path in HEAD and the index:

| In HEAD | In index | Result |
|---|---|---|
| No | Yes | `A` new file |
| Yes | No | `D` deleted |
| Yes, different SHA | Yes | `M` modified |

### Index → working directory (unstaged changes)

For each file in the index, check the working-directory version:

1. If `mtimeSec` and `size` match the index entry → assume unchanged (skip hash).
2. Otherwise, compute `SHA-1(blob header + file content)` and compare to `entry.hash`.
3. If file is missing from disk → `D` deleted.

Files on disk that are not in the index are reported as **Untracked**.
