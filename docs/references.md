# References

## What is a ref?

A reference (ref) is a named pointer to an object — almost always a commit. Refs live as plain text files under `.git/`:

```
.git/
├── HEAD                        ← special: points at current branch or commit
├── refs/
│   ├── heads/
│   │   ├── main                ← branch "main"  → commit SHA
│   │   └── feature-x           ← branch "feature-x" → commit SHA
│   └── tags/
│       └── v1.0                ← lightweight tag → commit SHA
└── logs/
    └── refs/
        └── heads/
            └── main            ← reflog for main
```

Each file contains a single 40-character hex SHA-1 followed by a newline:

```
e9932914e67dece5482167890bd57a76975f8dac
```

---

## HEAD

`HEAD` is the most important ref. It tells Git (and `lgit`) what commit is currently checked out.

### Symbolic ref (on a branch)

```
ref: refs/heads/main
```

HEAD indirects through the branch. Every new commit advances `main`, not HEAD itself.

### Detached HEAD (raw SHA)

```
69767537af417e2abce10d64754ec974a19017fc
```

Happens when you `lgit checkout <commit-sha>` or check out a tag directly. New commits in detached HEAD are not reachable from any branch until you create one.

---

## Symbolic ref resolution chain

```
HEAD  →  "ref: refs/heads/main"
                    ↓
         .git/refs/heads/main  →  "e9932914..."
                    ↓
              commit SHA
```

`refs.resolveHead()` follows this chain and returns the final SHA (or `null` for a new empty repository).

```typescript
resolveHead(): string | null {
  return this.resolveTarget(this.readHead());
}

resolve(ref: string): string | null {
  // checks ref, refs/heads/<ref>, refs/tags/<ref> in order
  const p = path.join(this.gitDir, ref);
  if (fs.existsSync(p)) {
    const content = fs.readFileSync(p, 'utf8').trim();
    if (content.startsWith('ref: ')) return this.resolve(content.slice(5));
    if (/^[0-9a-f]{40}$/.test(content)) return content;
  }
  return null;
}
```

---

## Branches

A branch is just a file under `.git/refs/heads/`. Creating a branch writes a new file; deleting it removes the file.

```typescript
createBranch(name, hash): void {
  this.updateRef(`refs/heads/${name}`, hash);
}

deleteBranch(name): void {
  this.deleteRef(`refs/heads/${name}`);
}
```

When you commit on a branch, only that branch's ref file is updated. Other branches are unaffected.

### Switching branches

`lgit checkout <branch>`:

1. Resolve the branch to a commit SHA.
2. Read that commit's tree.
3. Diff the current index vs the target tree.
4. Write/remove files in the working directory.
5. Rebuild the index from the target tree.
6. Write `HEAD` → `ref: refs/heads/<branch>`.

---

## Tags

### Lightweight tag

A file under `.git/refs/tags/` containing a commit SHA. Created by `lgit tag <name>`. No tag object is stored.

```
.git/refs/tags/v1.0  →  "e9932914..."
```

### Annotated tag (planned)

Uses a `tag` object in the object store. The ref points at the tag object, which in turn points at the tagged commit. Annotated tags have their own SHA, can be signed, and carry a message.

---

## Reflogs

Every time a branch ref changes, a line is appended to `.git/logs/refs/heads/<branch>`:

```
<old-sha> <new-sha> Author Name <email> <unix-ts> <tz>\t<message>
```

Example:

```
0000000000000000000000000000000000000000 6976753... Test User <t@e.com> 1776496067 +0530	commit: Initial commit
6976753... e993291... Test User <t@e.com> 1776496091 +0530	commit: Add src/main.rs
```

All-zeros in the old SHA indicates the ref was just created. Reflogs let you recover commits even after `reset --hard` by inspecting `HEAD@{1}`, `HEAD@{2}`, etc. (full reflog querying is a planned feature).

---

## Short-name resolution order

`lgit` resolves a short ref name by trying candidates in this order:

1. Exact path from `.git/` root (e.g. `refs/heads/main`)
2. `refs/heads/<name>`
3. `refs/tags/<name>`
4. `refs/remotes/<name>`

This matches Git's ref disambiguation rules.
