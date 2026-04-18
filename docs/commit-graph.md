# Commit Graph

## Structure

Every commit points to exactly one tree (the root directory snapshot at that moment) and zero or more parent commits. This forms a **directed acyclic graph (DAG)** where edges point backwards in time from child to parent.

```
A ← B ← C ← D      (linear history)
         ↑
    E ← F            (branch that diverged at C)

Merge commit M has two parents (D and F):
A ← B ← C ← D ← M
         ↑       ↑
    E ← F ────── ┘
```

Key properties:
- **Immutable** — once written, a commit object never changes. Its hash is its identity.
- **Content-addressed** — the commit SHA covers the tree, parents, author, message. Change any field and you get a different commit.
- **No cycles** — a commit cannot be its own ancestor. Git enforces this structurally because a commit must reference objects that already exist.

---

## Commit object anatomy

```
tree   21a8a30aedea769beca5af17940bc5648dded4ef
parent 69767537af417e2abce10d64754ec974a19017fc
author Test User <test@example.com> 1776496067 +0530
committer Test User <test@example.com> 1776496067 +0530

Add src/main.rs
```

| Field | Description |
|---|---|
| `tree` | SHA-1 of the root `tree` object — the complete directory snapshot |
| `parent` | SHA-1 of the preceding commit(s). Zero for the root commit, two+ for merges |
| `author` | Who wrote the change. Includes Unix timestamp and timezone offset |
| `committer` | Who recorded the commit. Differs from author on cherry-picks and rebases |
| message | Free-form text separated from the header by a blank line |

---

## Creating a commit: the write path

`lgit commit` composes three plumbing operations:

### 1. `write-tree` — snapshot the index into a tree object

The index is a flat list of `(path, blob-sha, mode)` entries. `write-tree` groups them by directory depth and recursively writes tree objects from the leaves up:

```
index entries:
  README.md          → blob aaa
  src/main.rs        → blob bbb
  src/lib.rs         → blob ccc

write-tree produces:
  tree(src/)         → tree ddd  { main.rs→bbb, lib.rs→ccc }
  tree(root)         → tree eee  { README.md→aaa, src/→ddd }
```

The final SHA (`eee`) is the tree for the commit.

### 2. `commit-tree` — wrap the tree in a commit

```typescript
CommitObjectParser.write(store, {
  tree:      treeSha,
  parents:   [parentSha],   // [] for root commit
  author:    { name, email, timestamp, timezone },
  committer: { name, email, timestamp, timezone },
  message,
});
```

### 3. Advance the branch ref

```
.git/refs/heads/main  ←  newCommitSha
```

If HEAD is detached, HEAD itself is updated instead.

---

## Traversal: `lgit log`

`log` does a breadth-first walk from the start commit, following parent pointers:

```typescript
const queue = [startHash];
const visited = new Set<string>();

while (queue.length > 0) {
  const sha = queue.shift();
  if (visited.has(sha)) continue;  // handles diamond merges
  visited.add(sha);

  const commit = CommitObjectParser.read(store, sha);
  emit(sha, commit);

  for (const parent of commit.parents) {
    queue.push(parent);
  }
}
```

This correctly handles:
- **Linear history** — single parent chain
- **Merge commits** — two parents both get queued
- **Diamond merges** — the `visited` set prevents double-visiting the common ancestor

Output is newest-first because commits are emitted as they are dequeued from BFS.

---

## Parent relationships and branching

When a branch diverges, the two branch tips share a common ancestor but have independent commit chains. No data is duplicated — both branches share all the tree and blob objects from the point of divergence.

```
branch main:    A → B → C → D
branch feature:         C → E → F
                        ↑
                  shared commit C and all its ancestors
```

`lgit branch <name>` simply writes the current HEAD SHA into a new ref file. No objects are copied. The branch is just a named pointer.

---

## Root commit

A repository's first commit has no `parent` lines. `lgit commit` detects this case:

```typescript
const parentSha = repo.refs.resolveHead();  // null when no commits exist
const parents = parentSha ? [parentSha] : [];
```

The log output labels it `(root-commit)`:

```
[main (root-commit) 6976753] Initial commit
```
