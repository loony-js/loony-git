# Architecture Overview

## Design philosophy

`loony-git` follows the same separation Git uses internally:

- **Plumbing** — small, composable primitives that operate on raw objects, the index, or refs. No user-facing polish.
- **Porcelain** — commands that compose plumbing to produce the workflow a developer expects.

This mirrors how real Git is structured. `git commit`, for example, is essentially `write-tree` + `commit-tree` + `update-ref`, all wired together with error handling and output formatting.

---

## Layered architecture

```
┌─────────────────────────────────────────────────┐
│                  CLI  (cli/cli.ts)               │  ← argument parsing, dispatch
├──────────────────────┬──────────────────────────┤
│  Porcelain           │  Plumbing                │  ← user commands / low-level ops
│  add, commit,        │  hash-object, cat-file,  │
│  status, log,        │  write-tree, read-tree,  │
│  branch, checkout,   │  update-index,           │
│  reset               │  commit-tree             │
├──────────────────────┴──────────────────────────┤
│              Repository  (core/repository.ts)    │  ← root context; wires everything
├──────────┬──────────┬────────────┬──────────────┤
│ Object   │  Index   │   Refs     │  Config      │  ← core subsystems
│ Store    │ (index/) │ (refs/)    │ (config.ts)  │
│ blob/    │          │            │              │
│ tree/    │          │            │              │
│ commit/  │          │            │              │
│ tag/     │          │            │              │
├──────────┴──────────┴────────────┴──────────────┤
│           Filesystem  (.git/ directory)          │  ← the actual database
└─────────────────────────────────────────────────┘
```

---

## Core subsystems

### Object Store (`core/objects/`)

The foundation. Every piece of content is stored by its SHA-1 hash. Nothing is ever mutated — objects are immutable once written.

Four object types, each with its own serializer/deserializer:

| Type | Stores |
|---|---|
| `blob` | Raw file bytes |
| `tree` | Directory listing: mode + name + SHA per entry |
| `commit` | Tree SHA, parent SHAs, author/committer, message |
| `tag` | Pointer to any object with a name and optional message |

See [object-storage.md](object-storage.md) for the wire format.

### Index (`core/index/`)

The staging area. A binary file at `.git/index` that maps file paths to (blob SHA, file mode, stat metadata). It is the intermediate state between the working directory and the next commit.

Three-way relationship:
```
HEAD commit tree  ←→  index  ←→  working directory
```

See [index-format.md](index-format.md) for the binary layout.

### Refs (`core/refs/`)

Named pointers to commit SHAs. Stored as plain files under `.git/refs/`. `HEAD` is special: it is either a **symbolic ref** (pointing at a branch) or a raw SHA (detached HEAD).

See [references.md](references.md).

### Config (`core/config.ts`)

INI-style parser for `.git/config`. Used by porcelain commands to read `user.name` / `user.email` and by `lgit config` to set them.

### Repository (`core/repository.ts`)

The root context object. All commands receive a `Repository` instance. It:
- Locates `.git/` by walking up from `cwd`
- Owns `store`, `index`, `refs`, `config`
- Provides helpers like `getAuthor()` and `relativePath()`

---

## Data flow: `lgit commit -m "msg"`

```
lgit commit -m "msg"
  │
  ├─ writeTree(repo)
  │    └─ for each index entry, group by directory depth
  │         └─ TreeObject.write(store, entries)  →  tree SHA
  │
  ├─ commitTree(repo, { tree, parents, message })
  │    └─ CommitObjectParser.write(store, commitObj)  →  commit SHA
  │
  ├─ refs.updateRef("refs/heads/main", commitSha)
  │    └─ writes SHA to .git/refs/heads/main
  │
  └─ refs.appendReflog(...)
       └─ appends line to .git/logs/refs/heads/main
```

---

## Data flow: `lgit checkout <branch>`

```
lgit checkout feature-x
  │
  ├─ refs.resolve("feature-x")  →  commit SHA
  ├─ CommitObjectParser.read(store, sha)  →  tree SHA
  ├─ flattenTree(store, treeSha)  →  Map<path, {hash, mode}>
  │
  ├─ diff current index vs target tree
  │    ├─ remove files absent in target  (unlink + prune empty dirs)
  │    └─ write files present in target  (blob content → disk)
  │
  ├─ rebuild index from target tree
  │    └─ index.save()
  │
  └─ refs.writeHead({ type: "symref", ref: "refs/heads/feature-x" })
```

---

## Key design decisions

**No external dependencies.** Only Node.js built-ins: `crypto` for SHA-1, `zlib` for deflate, `fs`/`path` for storage. This keeps the implementation auditable and ensures it mirrors what Git actually does rather than delegating to a library.

**Atomic writes.** Both the object store and the index write to a temp file first, then `rename()` into place. This is the same technique Git uses to prevent corruption on crashes.

**Idempotent object writes.** Writing an object that already exists is a no-op. The store checks for the destination path before compressing.

**Index padded to 8-byte boundaries.** Each index entry ends with enough NUL bytes so that the next entry starts on an 8-byte boundary from the start of the current entry. This matches Git's v2 format exactly, making the index readable by real `git`.
