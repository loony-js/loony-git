// Core type definitions mirroring Git's internal object model

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

// Octal file mode strings as used in tree entries
export type FileMode =
  | '100644'  // regular file
  | '100755'  // executable file
  | '040000'  // directory (stored as '40000' in trees)
  | '120000'  // symbolic link
  | '160000'; // gitlink (submodule)

export interface TreeEntry {
  mode: string;   // e.g. "100644", "40000"
  name: string;
  hash: string;   // hex SHA-1
}

export interface PersonInfo {
  name: string;
  email: string;
  timestamp: number;  // unix epoch seconds
  timezone: string;   // e.g. "+0000" or "-0800"
}

export interface CommitObject {
  tree: string;       // hex SHA-1 of root tree
  parents: string[];  // hex SHA-1(s) of parent commits
  author: PersonInfo;
  committer: PersonInfo;
  message: string;
}

export interface TagObject {
  object: string;     // hex SHA-1 of tagged object
  type: ObjectType;
  tag: string;        // tag name
  tagger?: PersonInfo;
  message: string;
}

// Index entry — mirrors Git's index v2 on-disk layout
export interface IndexEntry {
  ctimeSec: number;
  ctimeNsec: number;
  mtimeSec: number;
  mtimeNsec: number;
  dev: number;
  ino: number;
  mode: number;   // e.g. 0o100644
  uid: number;
  gid: number;
  size: number;
  hash: string;   // hex SHA-1
  flags: number;  // upper bits: assume-valid, extended, stage; lower 12: name length
  name: string;   // relative path
}

export interface Config {
  [section: string]: {
    [key: string]: string;
  };
}
