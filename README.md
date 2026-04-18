# loony-git

A high-fidelity reimplementation of Git in TypeScript/Node.js, built from first principles.

`loony-git` (`lgit`) mirrors Git's internal architecture — content-addressable object storage, binary index, commit DAG, refs, and working-directory checkout — without wrapping or calling the real `git` binary. Objects written by `lgit` are byte-for-byte compatible with real Git and can be read back by `git` directly.

---

## Quick start

```bash
# Build
npm install
npm run build

# Alias the binary (optional)
alias lgit="node /path/to/loony-git/dist/cli/cli.js"

# Use it exactly like git
lgit init my-project
cd my-project
lgit config user.name  "Your Name"
lgit config user.email "you@example.com"

echo "hello" > README.md
lgit add README.md
lgit commit -m "Initial commit"
lgit log
```

---

## Documentation

| Document | Description |
|---|---|
| [Architecture Overview](docs/architecture.md) | How the layers fit together |
| [Object Storage](docs/object-storage.md) | CAS, SHA-1, zlib, loose objects |
| [Index Format](docs/index-format.md) | Binary staging area (v2 wire format) |
| [Commit Graph](docs/commit-graph.md) | DAG structure and traversal |
| [References](docs/references.md) | HEAD, branches, tags, reflogs |
| [Command Reference](docs/commands.md) | All porcelain and plumbing commands |

---

## Project structure

```
loony-git/
├── src/
│   ├── types.ts                   # Shared interfaces
│   ├── index.ts                   # Public API surface
│   ├── core/
│   │   ├── objects/
│   │   │   ├── store.ts           # Content-addressable object store
│   │   │   ├── blob.ts            # Blob read/write
│   │   │   ├── tree.ts            # Tree serialization (binary)
│   │   │   ├── commit.ts          # Commit serialization (text)
│   │   │   └── tag.ts             # Annotated tag serialization
│   │   ├── index/
│   │   │   └── index.ts           # Index v2 binary format
│   │   ├── refs/
│   │   │   └── refs.ts            # HEAD, branches, tags, reflogs
│   │   ├── config.ts              # INI config parser
│   │   └── repository.ts          # Top-level context object
│   ├── plumbing/                  # Low-level commands
│   │   ├── hash-object.ts
│   │   ├── cat-file.ts
│   │   ├── write-tree.ts
│   │   ├── read-tree.ts
│   │   ├── update-index.ts
│   │   └── commit-tree.ts
│   ├── porcelain/                 # User-facing commands
│   │   ├── init.ts
│   │   ├── add.ts
│   │   ├── commit.ts
│   │   ├── status.ts
│   │   ├── log.ts
│   │   ├── branch.ts
│   │   ├── checkout.ts
│   │   └── reset.ts
│   └── cli/
│       └── cli.ts                 # CLI entry point and dispatcher
├── docs/
├── dist/                          # Compiled output (after npm run build)
├── package.json
└── tsconfig.json
```

---

## Requirements

- Node.js >= 18
- No runtime dependencies — only Node.js built-ins (`crypto`, `zlib`, `fs`, `path`)
