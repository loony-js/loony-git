Tier 1 — Blocking gaps (core workflow is incomplete without these)
.gitignore support
The biggest practical omission. lgit add . currently stages everything including build artifacts, node_modules, etc. Needs recursive .gitignore pattern matching (fnmatch-style globs, negations !, directory anchoring /). Also needs .git/info/exclude and a global ignore file.

diff
No diff at all. Three variants are needed:

index vs working directory (lgit diff) — what add would stage
HEAD vs index (lgit diff --cached) — what commit would record
commit vs commit (lgit diff <a> <b>) — arbitrary tree comparison
Requires implementing Myers diff or patience diff on blob content, plus unified-diff output format.

rm
lgit add can stage a file but there is no lgit rm to remove a tracked file from both the index and the working directory cleanly. lgit rm --cached (index only, keep workdir) is also missing.

mv
Renaming a file currently appears as a delete + add. lgit mv <src> <dst> should rename in the workdir, remove the old index entry, and add the new one atomically.

Revision syntax (HEAD~N, HEAD^, <ref>~N)
lgit reset HEAD~1 is documented but ancestor traversal (~N, ^N) is not implemented — the string HEAD~1 is passed literally to refs.resolve() which returns null. Every command that accepts a commit-ish needs a revParse() function first.

Tier 2 — Important completeness gaps
merge
Three-way merge against a common ancestor. Needs:

merge-base plumbing (lowest common ancestor in the DAG)
File-level three-way merge for text conflicts
Conflict markers (<<<<<<<, =======, >>>>>>>) written to the workdir
Stage 1/2/3 index entries for conflicted paths
MERGE_HEAD special ref
stash
lgit stash / lgit stash pop — saves the dirty workdir and index as a special dangling commit chain under refs/stash, restores on pop. Very useful, moderately complex.

cherry-pick
Apply a single commit's diff onto HEAD. Requires diff + three-way merge.

revert
Inverse of cherry-pick — applies the reverse of a commit's diff. Same dependencies.

commit --amend
Replace the most recent commit with a new one. Mechanically it is write-tree + commit-tree with the current HEAD's parent(s) instead of HEAD, then reset the branch. Easy to add once revParse works.

show
lgit show <object> — pretty-print any object. For commits it should print the commit metadata followed by the diff it introduced. Missing entirely.

Tier 3 — Missing plumbing (needed to build higher-level features)
Command What it does
rev-parse Resolve any commit-ish (HEAD~2, v1.0^{}, abbreviated SHA) to a full SHA
merge-base Find the lowest common ancestor of two commits
ls-files Dump the index (with --others, --modified, --deleted filters)
ls-tree List a tree object recursively (-r)
diff-tree Compare two trees, emit changed paths and blob SHAs
diff-index Compare a tree against the index
diff-files Compare index against the working directory
symbolic-ref Read/write symbolic refs (e.g. HEAD)
update-ref Safely update a ref with old-value checking
for-each-ref Iterate refs with format strings
pack-refs Consolidate loose refs into .git/packed-refs
Tier 4 — Object store completeness
Packed refs (.git/packed-refs)
Real Git consolidates many loose ref files into a single .git/packed-refs file. The current Refs class only reads loose files. Repos with many branches/tags will break if they were created by real Git and have packed refs.

Packfiles
Loose objects don't scale past a few thousand. Real Git bundles objects into .git/objects/pack/_.pack + _.idx files with delta compression. Without this, cloning or fetching from real Git remotes would be impossible. This is the largest single engineering task remaining.

gc / loose object pruning
Unreachable objects (orphaned by reset --hard) accumulate forever. git gc finds them and either packs or deletes them.

Object abbreviation robustness
Currently resolveAbbrev scans all loose objects linearly. It also doesn't search packfiles (once those exist) and doesn't handle the case where an abbreviation matches a packed object.

Tier 5 — Log / history quality
Gap Detail
--graph ASCII branch/merge graph in log output
--all Show commits reachable from any ref, not just HEAD
--author / --grep Filter commits by author or message
--since / --until Date-range filtering
log <file> History for a specific path (requires diff-tree per commit)
Reflog command lgit reflog to read .git/logs/ — the data is written but never read back
Tier 6 — Remote operations (largest scope)
None of this exists yet:

Feature Notes
remote add/remove/list Store remote URLs in .git/config
fetch Download objects + update refs/remotes/ — requires pack protocol (pkt-line framing, smart HTTP or SSH)
push Upload missing objects + update remote refs
pull fetch + merge (or rebase)
clone init + fetch + checkout
Pack protocol The binary wire format Git uses over HTTP/SSH
Remote support is effectively a separate project on top of the current foundation.

Summary by effort
Priority Features Effort
Must-have .gitignore, diff, rm, mv, rev-parse Medium
High merge, stash, commit --amend, show Large
Plumbing ls-files, ls-tree, diff-tree, merge-base, update-ref Small–Medium each
Object store Packed refs, packfiles, gc Large (packfiles = very large)
History log --graph, --all, date filters, reflog command Small–Medium
Remotes fetch, push, pull, clone, pack protocol Very large
The natural next step is rev-parse + .gitignore since they unblock almost everything else.
