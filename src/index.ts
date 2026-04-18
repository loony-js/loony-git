// Public API surface — import these in your own tools/scripts

export { Repository } from './core/repository';
export { ObjectStore } from './core/objects/store';
export { BlobObject } from './core/objects/blob';
export { TreeObject } from './core/objects/tree';
export { CommitObjectParser } from './core/objects/commit';
export { TagObjectParser } from './core/objects/tag';
export { GitIndex, statToIndexEntry } from './core/index/index';
export { Refs } from './core/refs/refs';
export { GitConfig } from './core/config';

// Plumbing
export { hashObject } from './plumbing/hash-object';
export { catFile } from './plumbing/cat-file';
export { writeTree } from './plumbing/write-tree';
export { readTree } from './plumbing/read-tree';
export { updateIndex } from './plumbing/update-index';
export { commitTree } from './plumbing/commit-tree';
export { plumbingRevParse } from './plumbing/rev-parse';

// Core utilities
export { revParse } from './core/revision';
export { GitIgnore } from './core/ignore';

// Porcelain
export { init } from './porcelain/init';
export { add } from './porcelain/add';
export { commit } from './porcelain/commit';
export { status, formatStatus } from './porcelain/status';
export { log, formatLog } from './porcelain/log';
export { branch } from './porcelain/branch';
export { checkout } from './porcelain/checkout';
export { reset } from './porcelain/reset';

export * from './types';
