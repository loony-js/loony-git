#!/usr/bin/env node
/**
 * CLI entry point — dispatches to plumbing and porcelain commands.
 *
 * Usage:
 *   lgit <command> [options] [args]
 */
import { initEnvs } from "../envs";
initEnvs();

import { Repository } from "../core/repository";
import { init } from "../porcelain/init";
import { add } from "../porcelain/add";
import { commit } from "../porcelain/commit";
import { status, formatStatus } from "../porcelain/status";
import { log, formatLog } from "../porcelain/log";
import { branch } from "../porcelain/branch";
import { checkout } from "../porcelain/checkout";
import { reset } from "../porcelain/reset";
import { hashObject } from "../plumbing/hash-object";
import { catFile } from "../plumbing/cat-file";
import { writeTree } from "../plumbing/write-tree";
import { readTree } from "../plumbing/read-tree";
import { updateIndex } from "../plumbing/update-index";
import { commitTree } from "../plumbing/commit-tree";
import { plumbingRevParse } from "../plumbing/rev-parse";
import { fetch as gitFetch } from "../porcelain/fetch";
import { push as gitPush } from "../porcelain/push";
import { pull as gitPull } from "../porcelain/pull";
import { clone as gitClone } from "../porcelain/clone";
import { show as gitShow } from "../porcelain/show";
import { merge as gitMerge } from "../porcelain/merge";
import { stash as gitStash } from "../porcelain/stash";
import { RemoteManager } from "../core/remote/remote";
import { ObjectType } from "../types";
import {
  uploadPackAdvertise,
  uploadPackStateless,
  receivePackAdvertise,
  receivePackStateless,
} from "../core/remote/server-pack";

const HELP = `
usage: lgit <command> [<args>]

Porcelain commands:
  init [<dir>]              Create an empty repository
  add <pathspec>...         Add files to the index
  commit -m <msg>           Record staged changes
  status                    Show working tree status
  log [--oneline] [-n <n>]  Show commit history
  branch [<name>] [-d <n>]  Create/list/delete branches
  checkout [-b] <target>    Switch branches or restore files
  checkout -- <file>...     Restore files from index
  reset [--soft|--mixed|--hard] [<commit>]
  tag [<name>]              Create or list lightweight tags
  config [--get] <key> [<value>]
  remote [-v|add|remove] [<name>] [<url>]
  fetch [<remote>]          Download objects + update remote-tracking refs
  push  [<remote>] [<refspec>] [-f]  Upload commits to remote
  pull  [<remote>] [<branch>]  fetch + fast-forward
  clone <url> [<directory>] Clone a remote repository
  merge [--no-ff] [-m <msg>] <branch>  Merge a branch
  stash [push|pop|list|drop|show] [-m <msg>]  Stash working changes
  show  [--stat] [<ref>]    Show a commit with its diff

Plumbing commands:
  hash-object [-w] [-t <type>] <file>
  cat-file [-t|-s|-p] <hash>
  write-tree
  read-tree <tree-sha>
  update-index --add|--remove <file>...
  commit-tree <tree-sha> [-p <parent>]... -m <msg>
  rev-parse [--abbrev-ref] [--short] <rev>
`.trim();

const args = process.argv.slice(2);
const command = args[0];

function die(msg: string): never {
  process.stderr.write(`lgit: ${msg}\n`);
  process.exit(1);
}

function out(msg: string): void {
  if (msg) process.stdout.write(msg + "\n");
}

function needRepo(): Repository {
  try {
    return Repository.find();
  } catch (e: any) {
    die(e.message);
  }
}

// ---- Argument helpers -------------------------------------------------------

function flag(name: string): boolean {
  return args.includes(name);
}

function optArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function positionals(from: number): string[] {
  return args.slice(from).filter((a) => !a.startsWith("-"));
}

// ---- Command dispatch -------------------------------------------------------

try {
  switch (command) {
    // ── init ──────────────────────────────────────────────────────────────
    case "init": {
      const dir = args[1];
      out(init(dir));
      break;
    }

    // ── add ───────────────────────────────────────────────────────────────
    case "add": {
      const repo = needRepo();
      const paths = args.slice(1);
      if (paths.length === 0) die("Nothing specified, nothing added.");
      add(repo, paths);
      break;
    }

    // ── commit ────────────────────────────────────────────────────────────
    case "commit": {
      const repo = needRepo();
      const amend = flag("--amend");
      const msg = optArg("-m") ?? "";
      if (!amend && !msg) die("Commit message required (-m)");
      out(commit(repo, { message: msg, amend }));
      break;
    }

    // ── status ────────────────────────────────────────────────────────────
    case "status": {
      const repo = needRepo();
      out(formatStatus(status(repo)));
      break;
    }

    // ── log ───────────────────────────────────────────────────────────────
    case "log": {
      const repo = needRepo();
      const oneline = flag("--oneline");
      const nArg = optArg("-n");
      const maxCount = nArg ? parseInt(nArg, 10) : undefined;
      const startRef = positionals(1)[0];
      out(formatLog(log(repo, { oneline, maxCount, startRef }), oneline));
      break;
    }

    // ── branch ────────────────────────────────────────────────────────────
    case "branch": {
      const repo = needRepo();
      const dFlag = optArg("-d");
      if (dFlag) {
        out(branch(repo, { delete: dFlag }));
      } else {
        const name = positionals(1)[0];
        const startPoint = positionals(1)[1];
        out(branch(repo, { name, startPoint }));
      }
      break;
    }

    // ── checkout ──────────────────────────────────────────────────────────
    case "checkout": {
      const repo = needRepo();
      const bFlag = flag("-b");
      const dashDash = args.indexOf("--");

      if (dashDash !== -1) {
        // lgit checkout -- <files>
        const files = args.slice(dashDash + 1);
        out(checkout(repo, { target: "--", files }));
      } else {
        const target = positionals(1)[0];
        if (!target) die("No target specified");
        out(checkout(repo, { target, createBranch: bFlag }));
      }
      break;
    }

    // ── reset ─────────────────────────────────────────────────────────────
    case "reset": {
      const repo = needRepo();
      const mode = flag("--soft") ? "soft" : flag("--hard") ? "hard" : "mixed";

      // lgit reset HEAD <file>...
      const headIdx = args.indexOf("HEAD");
      if (headIdx !== -1 && args.length > headIdx + 1) {
        const files = args.slice(headIdx + 1);
        out(reset(repo, { mode, files }));
      } else {
        const target = positionals(1).find((a) => a !== "HEAD");
        out(reset(repo, { mode, target }));
      }
      break;
    }

    // ── hash-object ───────────────────────────────────────────────────────
    case "hash-object": {
      const repo = needRepo();
      const write = flag("-w");
      const type = (optArg("-t") ?? "blob") as ObjectType;
      const file = positionals(1)[0];
      if (!file) die("hash-object: requires a file argument");
      out(hashObject(repo, { write, type, file }));
      break;
    }

    // ── cat-file ──────────────────────────────────────────────────────────
    case "cat-file": {
      const repo = needRepo();
      let mode: "type" | "size" | "pretty" | "raw";
      let hash: string;

      if (flag("-t")) {
        mode = "type";
        hash = positionals(1)[0];
      } else if (flag("-s")) {
        mode = "size";
        hash = positionals(1)[0];
      } else if (flag("-p")) {
        mode = "pretty";
        hash = positionals(1)[0];
      } else {
        mode = "raw";
        hash = positionals(1)[0];
      }
      if (!hash) die("cat-file: requires an object hash");
      out(catFile(repo, { mode, hash }));
      break;
    }

    // ── write-tree ────────────────────────────────────────────────────────
    case "write-tree": {
      const repo = needRepo();
      out(writeTree(repo));
      break;
    }

    // ── read-tree ─────────────────────────────────────────────────────────
    case "read-tree": {
      const repo = needRepo();
      const sha = positionals(1)[0];
      if (!sha) die("read-tree: requires a tree SHA");
      readTree(repo, sha);
      break;
    }

    // ── update-index ──────────────────────────────────────────────────────
    case "update-index": {
      const repo = needRepo();
      const addFlag = flag("--add");
      const rmFlag = flag("--remove");

      if (addFlag) {
        const files = positionals(1);
        updateIndex(repo, { add: files });
      } else if (rmFlag) {
        const files = positionals(1);
        updateIndex(repo, { remove: files });
      } else {
        die("update-index: specify --add or --remove");
      }
      break;
    }

    // ── commit-tree ───────────────────────────────────────────────────────
    case "commit-tree": {
      const repo = needRepo();
      const tree = positionals(1)[0];
      if (!tree) die("commit-tree: requires a tree SHA");

      // Collect all -p parent arguments
      const parents: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-p" && args[i + 1]) {
          parents.push(args[i + 1]);
          i++;
        }
      }
      const msg = optArg("-m") ?? "";
      out(commitTree(repo, { tree, parents, message: msg }));
      break;
    }

    // ── rev-parse ─────────────────────────────────────────────────────────
    case "rev-parse": {
      const repo = needRepo();
      const abbrevRef = flag("--abbrev-ref");
      const short = flag("--short");
      const expr = positionals(1)[0];
      if (!expr) die("rev-parse: requires a revision argument");
      out(plumbingRevParse(repo, { expr, abbrevRef, short }));
      break;
    }

    // ── tag ───────────────────────────────────────────────────────────────
    case "tag": {
      const repo = needRepo();
      const name = positionals(1)[0];
      if (!name) {
        // List tags
        out(repo.refs.listTags().join("\n"));
      } else {
        const sha = repo.refs.resolveHead();
        if (!sha) die("fatal: no commits yet");
        repo.refs.createTag(name, sha);
        out(`Created tag '${name}'`);
      }
      break;
    }

    // ── config ────────────────────────────────────────────────────────────
    case "config": {
      // lgit config user.name "John"
      // lgit config --get user.name
      const repo = needRepo();
      const getMode = flag("--get");
      const keyArg = positionals(1)[0];
      if (!keyArg) die("config: key required");

      const dotIdx = keyArg.indexOf(".");
      if (dotIdx === -1) die("config: key must be in <section>.<name> form");
      const section = keyArg.slice(0, dotIdx);
      const key = keyArg.slice(dotIdx + 1);

      if (getMode) {
        const val = repo.config.get(section, key);
        if (val === undefined) die(`error: key does not exist: ${keyArg}`);
        out(val);
      } else {
        const val = positionals(1)[1];
        if (val === undefined) die("config: value required");
        repo.config.set(section, key, val);
        repo.config.save();
      }
      break;
    }

    // ── remote ────────────────────────────────────────────────────────────
    case "remote": {
      const repo = needRepo();
      const sub = args[1];
      const mgr = new RemoteManager(repo);

      if (!sub || sub === "show" || sub === "-v") {
        const remotes = mgr.list();
        if (remotes.length === 0) {
          out("(no remotes configured)");
          break;
        }
        for (const r of remotes)
          out(sub === "-v" ? `${r.name}\t${r.url}` : r.name);
        break;
      }
      if (sub === "add") {
        const name = args[2];
        const url = args[3];
        if (!name || !url) die("remote add: <name> <url> required");
        mgr.add(name, url);
        out(`Added remote '${name}' → ${url}`);
        break;
      }
      if (sub === "remove" || sub === "rm") {
        const name = args[2];
        if (!name) die("remote remove: <name> required");
        mgr.remove(name);
        out(`Removed remote '${name}'`);
        break;
      }
      die(`remote: unknown subcommand '${sub}'`);
    }

    // ── fetch ─────────────────────────────────────────────────────────────
    case "fetch": {
      const repo = needRepo();
      const remote = positionals(1)[0];
      const verbose = flag("-v") || flag("--verbose");
      out("Fetching...");
      gitFetch(repo, {
        remote,
        verbose,
        onProgress: (m) => process.stderr.write(m + "\n"),
      })
        .then(out)
        .catch((e: Error) => die(e.message));
      break;
    }

    // ── push ──────────────────────────────────────────────────────────────
    case "push": {
      const repo = needRepo();
      const remote = positionals(1)[0];
      const refspec = positionals(1)[1];
      const force = flag("-f") || flag("--force");
      out("Pushing...");
      gitPush(repo, {
        remote,
        refspec,
        force,
        onProgress: (m) => process.stderr.write(m + "\n"),
      })
        .then(out)
        .catch((e: Error) => die(e.message));
      break;
    }

    // ── pull ──────────────────────────────────────────────────────────────
    case "pull": {
      const repo = needRepo();
      const remote = positionals(1)[0];
      const branch = positionals(1)[1];
      out("Pulling...");
      gitPull(repo, {
        remote,
        branch,
        onProgress: (m) => process.stderr.write(m + "\n"),
      })
        .then(out)
        .catch((e: Error) => die(e.message));
      break;
    }

    // ── clone ─────────────────────────────────────────────────────────────
    case "clone": {
      const url = positionals(1)[0];
      if (!url) die("clone: URL required");
      const directory = positionals(1)[1];
      gitClone({
        url,
        directory,
        onProgress: (m) => process.stderr.write(m + "\n"),
      })
        .then(out)
        .catch((e: Error) => die(e.message));
      break;
    }

    // ── show ──────────────────────────────────────────────────────────────
    case "show": {
      const repo = needRepo();
      const stat = flag("--stat");
      const ref = positionals(1)[0];
      out(gitShow(repo, { ref, stat }));
      break;
    }

    // ── merge ─────────────────────────────────────────────────────────────
    case "merge": {
      const repo = needRepo();
      const noFf = flag("--no-ff");
      const msg = optArg("-m");
      const branch = positionals(1)[0];
      if (!branch) die("merge: branch name required");
      out(gitMerge(repo, { branch, message: msg, noFf }));
      break;
    }

    // ── stash ─────────────────────────────────────────────────────────────
    case "stash": {
      const repo = needRepo();
      const sub = args[1];
      // 'push' is the default; distinguish from a branch-name positional
      const knownSubs = ["push", "pop", "list", "drop", "show"];
      const isSub = sub && knownSubs.includes(sub);
      const subCmd = isSub ? sub : sub === undefined ? "push" : undefined;
      if (subCmd === undefined) die(`stash: unknown subcommand '${sub}'`);
      const msg = optArg("-m");
      const ref =
        isSub && (sub === "drop" || sub === "show")
          ? positionals(2)[0]
          : undefined;
      out(gitStash(repo, { sub: subCmd, message: msg, ref }));
      break;
    }

    // ── help / default ────────────────────────────────────────────────────
    case undefined:
    // ── upload-pack (server-side: serve fetch/clone) ──────────────────────
    case "upload-pack": {
      const repoPath = positionals(1)[0];
      if (!repoPath) die("usage: lgit upload-pack [--stateless-rpc] [--advertise-refs] <repo>");
      if (flag("--advertise-refs")) {
        uploadPackAdvertise(repoPath);
      } else if (flag("--stateless-rpc")) {
        uploadPackStateless(repoPath);
      } else {
        die("upload-pack: expected --stateless-rpc");
      }
      break;
    }

    // ── receive-pack (server-side: accept push) ────────────────────────────
    case "receive-pack": {
      const repoPath = positionals(1)[0];
      if (!repoPath) die("usage: lgit receive-pack [--stateless-rpc] [--advertise-refs] <repo>");
      if (flag("--advertise-refs")) {
        receivePackAdvertise(repoPath);
      } else if (flag("--stateless-rpc")) {
        receivePackStateless(repoPath);
      } else {
        die("receive-pack: expected --stateless-rpc");
      }
      break;
    }

    case "--help":
    case "help": {
      out(HELP);
      break;
    }

    default:
      die(`'${command}' is not a lgit command. See 'lgit help'.`);
  }
} catch (err: any) {
  die(err.message ?? String(err));
}
