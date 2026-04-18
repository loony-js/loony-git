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
export { revParse }  from './core/revision';
export { GitIgnore } from './core/ignore';

// Pack / transport
export { PackfileReader, buildPackfile } from './core/pack/packfile';
export { applyDelta }    from './core/pack/delta';
export { encodePkt, PKT_FLUSH, PktLineDecoder, parseRefAdvertisement } from './core/pack/pktline';
export { RemoteManager, parseRemoteUrl } from './core/remote/remote';
export { discoverRefs, fetchPack }       from './core/remote/upload-pack';
export { discoverReceiveRefs, pushPack, collectObjectsForPush } from './core/remote/receive-pack';

// Remote porcelain
export { fetch }  from './porcelain/fetch';
export { push }   from './porcelain/push';
export { pull }   from './porcelain/pull';
export { clone }  from './porcelain/clone';

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
