// core.ts — git object model, packfile codec, pkt-line codec, and the forge's
// single in-memory store shared by REST, GraphQL, MCP and git smart HTTP.
//
// Determinism: no Date.now / Math.random anywhere in state. Commit timestamps
// come from a fixed epoch plus a per-repo sequence counter, ids from counters,
// request ids from a counter. Two runs that send the same requests in the same
// order therefore build the same objects.
//
// The token owner: the suite's scenario is seeded from a constant
// (kit program/env/src/wire.ts SCENARIO_SEED 6a09e667f3bcc909), so the viewer
// the bearer token names is always "adaiversen" and the stranger is
// "olgabauer". The entry recomputes nothing from the token itself — the token
// is an opaque shpat_ value — it authenticates the token against
// MAKEFUN_SHOP_TOKEN and treats the authenticated user as the viewer.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const STRANGER_LOGIN = 'olgabauer';
export const FIXED_EPOCH = 1700000000;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObj { type: ObjType; data: Buffer }

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;
export function isOid(s: string): boolean { return HEX40.test(s); }

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}
export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- trees
export interface TreeEntry { mode: string; name: string; oid: string }
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('bad tree');
    out.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}
function cmpTreeName(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}
export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of [...entries].sort(cmpTreeName)) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits / tags
export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
export function buildCommit(tree: string, parents: string[], message: string, who: string, ts: number): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who} ${ts} +0000`, `committer ${who} ${ts} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}
export interface TagView { object: string; type: ObjType; tag: string; tagger: string; message: string }
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const m = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) m.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return { object: m.get('object') ?? '', type: (m.get('type') ?? 'commit') as ObjType, tag: m.get('tag') ?? '', tagger: m.get('tagger') ?? '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}
export function peelObject(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i++) {
    const o = repo.objects.get(cur);
    if (!o || o.type !== 'tag') return cur;
    cur = parseTag(o.data).object;
  }
  return cur;
}

// ---------------------------------------------------------------- reachability
export function collectReachable(repo: Repo, roots: Iterable<string>, opts: { maxDepth?: number; exclude?: Set<string> } = {}): Set<string> {
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const r of roots) if (isOid(r)) queue.push({ oid: r, depth: 0 });
  const exclude = opts.exclude ?? new Set<string>();
  while (queue.length) {
    const { oid, depth } = queue.pop()!;
    if (seen.has(oid) || exclude.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (opts.maxDepth !== undefined && depth >= opts.maxDepth) continue;
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push({ oid: c.tree, depth: depth + 1 });
      for (const p of c.parents) queue.push({ oid: p, depth: depth + 1 });
    } else if (obj.type === 'tag') {
      queue.push({ oid: parseTag(obj.data).object, depth: depth + 1 });
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push({ oid: e.oid, depth: depth + 1 });
    }
  }
  return seen;
}
// Commits reachable from `tip`, in newest-first order (BFS by depth, parents after).
export function commitWalk(repo: Repo, tip: string, limit = 10000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}
export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  return collectReachable(repo, [desc]).has(anc);
}
/** Fast-forward check over commit parents only (no tree/blob expansion). */
export function isAncestorCommit(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const queue: string[] = [desc];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = new Set(commitWalk(repo, a));
  for (const c of commitWalk(repo, b)) if (fromA.has(c)) return c;
  return null;
}

// ---------------------------------------------------------------- file maps
export type FileMap = Map<string, string>; // path -> blob oid
export function filesAt(repo: Repo, commitOid: string): FileMap {
  const out: FileMap = new Map();
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string): void => {
    const t = repo.objects.get(treeOid);
    if (!t || t.type !== 'tree') return;
    for (const e of parseTree(t.data)) {
      if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
      else out.set(`${prefix}${e.name}`, e.oid);
    }
  };
  walk(parseCommit(obj.data).tree, '');
  return out;
}
export function treeOidForFiles(repo: Repo, files: Map<string, Buffer>): string {
  interface Node { files: Map<string, Buffer>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, data] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i]!;
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s)!;
    }
    node.files.set(segs[segs.length - 1]!, data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of node.files) entries.push({ mode: '100644', name, oid: putObject(repo, 'blob', data) });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}
/** Create a commit whose tree holds exactly `files` (path -> bytes). */
export function createCommit(repo: Repo, files: Map<string, Buffer>, parents: string[], message: string): string {
  const tree = treeOidForFiles(repo, files);
  const ts = FIXED_EPOCH + (repo.commitSeq++);
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return putObject(repo, 'commit', buildCommit(tree, parents, msg, who, ts));
}
export function blobBytes(repo: Repo, oid: string): Buffer | null {
  const o = repo.objects.get(oid);
  return o && o.type === 'blob' ? o.data : null;
}
export function countLines(b: Buffer): number {
  if (b.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === 0x0a) n++;
  return b[b.length - 1] === 0x0a ? n : n + 1;
}
export interface FileDiff { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }
export function diffFileMaps(repo: Repo, oldM: FileMap, newM: FileMap): FileDiff[] {
  const out: FileDiff[] = [];
  const paths = new Set([...oldM.keys(), ...newM.keys()]);
  for (const p of [...paths].sort()) {
    const o = oldM.get(p); const n = newM.get(p);
    if (o === n) continue;
    if (o === undefined) {
      const add = countLines(blobBytes(repo, n!) ?? Buffer.alloc(0));
      out.push({ filename: p, status: 'added', additions: add, deletions: 0, changes: add });
    } else if (n === undefined) {
      const del = countLines(blobBytes(repo, o) ?? Buffer.alloc(0));
      out.push({ filename: p, status: 'removed', additions: 0, deletions: del, changes: del });
    } else {
      const oldLines = new Set((blobBytes(repo, o) ?? Buffer.alloc(0)).toString('utf8').split('\n'));
      const newLines = (blobBytes(repo, n) ?? Buffer.alloc(0)).toString('utf8').split('\n');
      let add = 0; for (const l of newLines) if (!oldLines.has(l)) add++;
      const newSet = new Set(newLines);
      let del = 0; for (const l of oldLines) if (!newSet.has(l)) del++;
      if (add === 0 && del === 0) { add = 1; }
      out.push({ filename: p, status: 'modified', additions: add, deletions: del, changes: add + del });
    }
  }
  return out;
}

// ---------------------------------------------------------------- packfile
function writePackHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rem = size;
  let first = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) { bytes.push(first | 0x80); first = rem & 0x7f; rem = Math.floor(rem / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}
export function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(writePackHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start]!;
  const first = byte;
  let size = byte & 0x0f; let shift = 4; let off = start + 1;
  while (byte & 0x80) { byte = buf[off++]!; size += (byte & 0x7f) * 2 ** shift; shift += 7; }
  return { size, next: off, first };
}
function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start]!;
  let off = start + 1; let value = byte & 0x7f;
  while (byte & 0x80) { byte = buf[off++]!; value = ((value + 1) * 128) + (byte & 0x7f); }
  return { baseOffset: value, next: off };
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0; let sh = 0;
    for (;;) { const b = delta[off++]!; v += (b & 0x7f) * 2 ** sh; sh += 7; if (!(b & 0x80)) break; }
    return v;
  };
  const srcSize = readSize(); const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let co = 0; let cs = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) co += delta[off++]! * 2 ** sh; sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) cs += delta[off++]! * 2 ** sh; sh += 8; }
      if (cs === 0) cs = 0x10000;
      base.copy(out, written, co, co + cs); written += cs;
    } else if (op !== 0) {
      const lit = op & 0x7f;
      delta.copy(out, written, off, off + lit); off += lit; written += lit;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}
/** Parse a packfile into objects (plain + OFS/REF deltas). Throws on corruption. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex') !== trailer) throw new Error('pack checksum mismatch');
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; resolved?: GitObj; oid?: string }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    const h = readVarint(pack, off); off = h.next;
    const typeCode = (h.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: h.size, data: Buffer.alloc(0) };
    if (typeCode === 6) { const b = readOfsBase(pack, off); off = b.next; entry.baseOffset = entryOffset - b.baseOffset; }
    else if (typeCode === 7) { entry.baseOid = pack.subarray(off, off + 20).toString('hex'); off += 20; }
    else if (!CODE_TYPE[typeCode]) throw new Error(`unknown pack type ${typeCode}`);
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== h.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    off += inflated.engine.bytesWritten;
    raw.push(entry); byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObj => {
    if (entry.resolved && entry.oid) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let obj: GitObj;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) { const base = resolve(baseEntry); obj = { type: base.type, data: applyDelta(base.data, entry.data) }; }
      else {
        const ext = resolveBase?.(wanted);
        if (!ext) throw new Error(`ref-delta base ${wanted} missing`);
        obj = { type: ext.type, data: applyDelta(ext.data, entry.data) };
      }
    } else {
      obj = { type: CODE_TYPE[entry.typeCode]!, data: entry.data };
    }
    const oid = hashObject(obj.type, obj.data);
    entry.resolved = obj; entry.oid = oid; resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return obj;
  };
  for (const e of raw) {
    const obj = resolve(e);
    // resolve() already hashed this object into entry.oid; re-hashing here
    // would pay a second SHA-1 per object on every push.
    objects.set(e.oid!, obj);
  }
  return objects;
}

// ---------------------------------------------------------------- pkt-line
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(pktFlush());
    else if (it === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}
export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };
export function decodePktLines(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const header = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    const len = parseInt(header, 16);
    if (len === 0) { out.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// ---------------------------------------------------------------- global ids (GraphQL Relay)
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch { return null; }
}

// ---------------------------------------------------------------- store
export interface Label { name: string; color: string }
export interface IssueComment { id: number; body: string; user: string; seq: number }
export interface Issue {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; seq: number; comments: IssueComment[]; user: string;
}
export interface PullRequest {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeSha: string | null; seq: number; user: string;
}
export interface Repo {
  name: string; owner: string; description: string; private: boolean;
  defaultBranch: string; dbId: number; seq: number;
  objects: Map<string, GitObj>; refs: Map<string, string>;
  issues: Issue[]; pulls: PullRequest[]; labels: Map<string, Label>;
  nextNum: number; nextCommentId: number; commitSeq: number;
}
export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1000;
  nextIssueId = 1;
  nextPullId = 1;
  key(owner: string, name: string): string { return `${owner}/${name}`; }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.key(owner, name)); }
  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.seq - b.seq);
  }
  createRepo(name: string, priv: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(VIEWER_LOGIN, name))) return null;
    const repo: Repo = {
      name, owner: VIEWER_LOGIN, description, private: priv,
      defaultBranch: 'main', dbId: this.nextRepoId++, seq: this.repos.size,
      objects: new Map(), refs: new Map(), issues: [], pulls: [],
      labels: new Map(), nextNum: 1, nextCommentId: 1, commitSeq: 0,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }
  deleteRepo(owner: string, name: string): boolean { return this.repos.delete(this.key(owner, name)); }
  refTip(repo: Repo, ref: string): string | undefined { return repo.refs.get(ref); }
  defaultTip(repo: Repo): string | undefined { return repo.refs.get(`refs/heads/${repo.defaultBranch}`); }
  resolveRef(repo: Repo, ref: string): string | undefined {
    // branch name, full ref, or raw oid
    if (isOid(ref)) return repo.objects.has(ref) ? ref : undefined;
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  }
}
export const store = new Store();

// ---------------------------------------------------------------- shared shapes
export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId, node_id: globalId('Repository', repo.dbId), name: repo.name,
    full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private, description: repo.description, default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`, url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', pushed_at: '2026-01-01T00:00:00Z',
    has_issues: true, has_projects: false, has_wiki: false, fork: false, archived: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}
export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: globalId('Issue', repo.dbId, issue.number), number: issue.number,
    title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((name) => { const l = repo.labels.get(name); return { name, color: l?.color ?? 'ededed' }; }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: issue.state === 'closed' ? '2026-01-01T00:00:00Z' : null,
  };
}
export function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id, node_id: globalId('PullRequest', repo.dbId, pr.number), number: pr.number,
    title: pr.title, body: pr.body, state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    merged: pr.merged, merged_at: pr.mergedAt, merge_commit_sha: pr.mergeSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', draft: false,
  };
}
export function prFiles(repo: Repo, pr: PullRequest): FileDiff[] {
  const baseFiles = pr.baseSha ? filesAt(repo, pr.baseSha) : new Map<string, string>();
  const headFiles = pr.headSha ? filesAt(repo, pr.headSha) : new Map<string, string>();
  return diffFileMaps(repo, baseFiles, headFiles);
}
/** Is merging `pr` conflicted? Both sides changed the same path differently since merge-base. */
export function prConflicted(repo: Repo, pr: PullRequest): boolean {
  const curBase = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  const base = mergeBase(repo, pr.headSha, curBase);
  if (!base) return false;
  const baseFiles = filesAt(repo, base);
  const headFiles = filesAt(repo, pr.headSha);
  const curFiles = filesAt(repo, curBase);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...curFiles.keys()]);
  for (const p of paths) {
    const b = baseFiles.get(p); const h = headFiles.get(p); const c = curFiles.get(p);
    if (h !== b && c !== b && h !== c) return true;
  }
  return false;
}
/** Squash-merge a PR onto its base branch. Returns the merge commit oid, or null on conflict. */
export function squashMerge(repo: Repo, pr: PullRequest): string | null {
  if (pr.merged || pr.state !== 'open') return null;
  if (prConflicted(repo, pr)) return null;
  const curBase = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  const base = mergeBase(repo, pr.headSha, curBase);
  const baseFiles = base ? filesAt(repo, base) : new Map<string, string>();
  const headFiles = filesAt(repo, pr.headSha);
  const curFiles = filesAt(repo, curBase);
  // Start from current base files, overlay head's changes vs merge-base.
  const merged = new Map<string, Buffer>();
  for (const [path, oid] of curFiles) {
    const b = blobBytes(repo, oid);
    if (b) merged.set(path, b);
  }
  const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const p of allPaths) {
    const b = baseFiles.get(p); const h = headFiles.get(p);
    if (h === b) continue;
    if (h === undefined) merged.delete(p);
    else { const data = blobBytes(repo, h); if (data) merged.set(p, data); }
  }
  const msg = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}\n\n${pr.title}`;
  const commit = createCommit(repo, merged, curBase ? [curBase] : [], msg);
  repo.refs.set(`refs/heads/${pr.baseRef}`, commit);
  pr.state = 'closed'; pr.merged = true; pr.mergedAt = '2026-01-01T00:00:00Z'; pr.mergeSha = commit;
  return commit;
}
