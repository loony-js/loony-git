# Command Reference

All commands are invoked as:

```bash
node dist/cli/cli.js <command> [options] [args]
# or, after linking:
lgit <command> [options] [args]
```

---

## Setup

### `lgit init [<directory>]`

Initialise a new repository. Creates the `.git/` skeleton in the current directory (or `<directory>` if given).

```bash
lgit init
lgit init my-project
```

Files created:
```
.git/
├── HEAD              → "ref: refs/heads/main"
├── config
├── description
├── objects/info/
├── objects/pack/
├── refs/heads/
├── refs/tags/
└── logs/refs/heads/
```

---

### `lgit config [--get] <section>.<key> [<value>]`

Read or write config values in `.git/config`.

```bash
lgit config user.name  "Alice"
lgit config user.email "alice@example.com"
lgit config --get user.name
```

Author name and email are read from `user.name` / `user.email` in config, then from `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` environment variables, with a fallback to `"Unknown"`.

---

## Porcelain commands

### `lgit add <pathspec>...`

Stage files for the next commit.

```bash
lgit add README.md
lgit add src/
lgit add .                  # stage everything under cwd
```

For each file:
1. Read content, compute blob SHA-1.
2. Write blob to object store (if not already present).
3. Update the index entry with current `stat()` data.

The `.git/` directory is always excluded from staging.

---

### `lgit commit -m <message>`

Record staged changes as a new commit.

```bash
lgit commit -m "Fix the parser"
```

Internally: `write-tree` → `commit-tree` → update branch ref → append reflog.

Returns an error if the index is empty or if the staged tree is identical to the parent commit's tree.

---

### `lgit status`

Show the state of the working directory relative to HEAD and the index.

```bash
lgit status
```

Example output:

```
On branch main

Changes to be committed:
  (use "lgit reset HEAD <file>..." to unstage)

	new file:   src/parser.ts
	modified:   README.md

Changes not staged for commit:
  (use "lgit add <file>..." to update what will be committed)

	modified:   src/lexer.ts

Untracked files:
  (use "lgit add <file>..." to include in what will be committed)

	scratch.txt
```

---

### `lgit log [--oneline] [-n <count>] [<ref>]`

Show the commit history from HEAD (or `<ref>`).

```bash
lgit log
lgit log --oneline
lgit log -n 5
lgit log --oneline feature-x
```

Traversal is BFS from the start commit. Handles linear history and merge commits. The `--oneline` flag prints `<short-sha> <first-line-of-message>`.

---

### `lgit branch [<name>] [<start-point>]`

```bash
lgit branch                    # list all branches (* marks current)
lgit branch feature-x          # create branch at HEAD
lgit branch hotfix abc1234     # create branch at given commit
lgit branch -d old-branch      # delete branch
```

A branch is just a file at `.git/refs/heads/<name>` containing a SHA-1. Creation and deletion are file writes/unlinks.

---

### `lgit checkout [-b] <target>`

Switch to a branch, create and switch, or detach HEAD at a commit.

```bash
lgit checkout main             # switch to existing branch
lgit checkout -b feature-y     # create and switch
lgit checkout abc1234          # detach HEAD at commit
```

The three-pointer update:
1. Resolve `<target>` to a commit → tree.
2. Remove working-directory files absent in the target tree.
3. Write working-directory files present in the target tree.
4. Rebuild the index from the target tree.
5. Update HEAD.

### `lgit checkout -- <file>...`

Restore specific files from the index (discard working-directory changes):

```bash
lgit checkout -- src/main.rs
lgit checkout -- .
```

---

### `lgit reset [--soft | --mixed | --hard] [<commit>]`

Move the current branch to a different commit.

```bash
lgit reset HEAD~1              # mixed (default): move branch + reset index
lgit reset --soft HEAD~1       # move branch only; index unchanged
lgit reset --hard HEAD~1       # move branch + reset index + reset workdir
```

| Mode | Branch ref | Index | Working directory |
|---|---|---|---|
| `--soft` | ✓ moved | unchanged | unchanged |
| `--mixed` | ✓ moved | ✓ reset | unchanged |
| `--hard` | ✓ moved | ✓ reset | ✓ reset |

### `lgit reset HEAD <file>...`

Unstage specific files (restore their index entry from HEAD):

```bash
lgit reset HEAD src/main.rs
```

---

### `lgit tag [<name>]`

```bash
lgit tag                       # list all tags
lgit tag v1.0                  # create lightweight tag at HEAD
```

Lightweight tags are stored as ref files at `.git/refs/tags/<name>`. They point directly at a commit.

---

## Plumbing commands

### `lgit hash-object [-w] [-t <type>] <file>`

Compute the SHA-1 of a file's content as a Git object. With `-w`, also write it to the object store.

```bash
lgit hash-object README.md
lgit hash-object -w README.md
lgit hash-object -t blob README.md
```

---

### `lgit cat-file (-t | -s | -p) <hash>`

Inspect an object.

```bash
lgit cat-file -t abc1234       # print type:    "blob", "tree", "commit", "tag"
lgit cat-file -s abc1234       # print size:    byte count of content
lgit cat-file -p abc1234       # pretty-print content
```

Pretty-print output:

- **blob** — raw text content
- **tree** — one line per entry: `<mode> <name>\0<sha>`
- **commit** — header lines + blank line + message
- **tag** — header lines + blank line + message

Accepts abbreviated hashes (≥ 7 chars) as well as full 40-char SHAs.

---

### `lgit write-tree`

Write the current index as a tree object hierarchy, print the root tree SHA.

```bash
lgit write-tree
# → 21a8a30aedea769beca5af17940bc5648dded4ef
```

Typically called internally by `lgit commit`, but useful for inspecting the staged tree before committing.

---

### `lgit read-tree <tree-sha>`

Load a tree object into the index, replacing all current entries. Does **not** touch the working directory.

```bash
lgit read-tree 21a8a30aedea769beca5af17940bc5648dded4ef
```

---

### `lgit update-index (--add | --remove) <file>...`

Directly manipulate index entries.

```bash
lgit update-index --add src/main.rs
lgit update-index --remove old-file.txt
```

`--add` hashes the file, writes the blob, and creates/updates the index entry. `--remove` deletes the entry without touching the working directory.

---

### `lgit commit-tree <tree-sha> [-p <parent>]... -m <message>`

Create a commit object directly. Prints the new commit SHA.

```bash
lgit commit-tree 21a8a30 -m "Root commit"
lgit commit-tree 21a8a30 -p e993291 -m "Second commit"
lgit commit-tree 21a8a30 -p abc1234 -p def5678 -m "Merge commit"
```

Does not update any ref. Use `lgit update-ref` (or modify `.git/refs/heads/<branch>` manually) to point a branch at the new commit.

---

## Environment variables

| Variable | Effect |
|---|---|
| `GIT_AUTHOR_NAME` | Override author name |
| `GIT_AUTHOR_EMAIL` | Override author email |
| `GIT_COMMITTER_NAME` | Override committer name |
| `GIT_COMMITTER_EMAIL` | Override committer email |

These take precedence over `user.name` / `user.email` in config.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Error (message printed to stderr) |
