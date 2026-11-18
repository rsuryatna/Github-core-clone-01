// git.ts — git smart HTTP: info/refs, upload-pack (protocol v2 + v0), receive-pack (v0).
import {
  ZERO_OID, VIEWER_LOGIN, isOid, hashObject, parseCommit, parseTag, peelObject,
  collectReachable, isAncestorCommit, filesAt, putObject, readPack, writePack,
  pktLine, pktFlush, pktDelim, pktLines, decodePktLines,
  type Repo, type GitObj, type Packet,
} from './core.ts';

export function notFoundJson(): { status: number; body: string } {
  return { status: 404, body: JSON.stringify({ message: 'Not Found' }) };
}

interface RefRow { oid: string; name: string; symref?: string; peeled?: string }
function refRows(repo: Repo): RefRow[] {
  const rows: RefRow[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  rows.push({ oid: tip ?? ZERO_OID, name: 'HEAD', symref: `refs/heads/${repo.defaultBranch}` });
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const row: RefRow = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') row.peeled = peelObject(repo, oid);
    rows.push(row);
  }
  return rows;
}

const UPLOAD_CAPS_V0 = 'multi_ack thin-pack side-band-64k side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want report-status report-status-v2';
const RECEIVE_CAPS_V0 = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta quiet';

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', caps: string): Buffer {
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const rows = refRows(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const capsLine = `${caps} ${symref} agent=github-core-clone/1.0.0`;
  if (rows.length === 1 && rows[0]!.oid === ZERO_OID) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capsLine}\n`));
  } else {
    let first = true;
    for (const row of rows) {
      if (row.name === 'HEAD') {
        parts.push(pktLine(`${row.oid} HEAD\0${capsLine}\n`));
        first = false;
        continue;
      }
      parts.push(pktLine(`${row.oid} ${row.name}\n`));
      if (row.peeled) parts.push(pktLine(`${row.peeled} ${row.name}^{}\n`));
      first = false;
    }
    void first;
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n', 'flush',
    'version 2\n',
    'agent=github-core-clone/1.0.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
    'object-info\n',
    'flush',
  ]);
}
// The v2 advertisement never depends on repo state: build it once.
const V2_ADVERTISEMENT = v2Advertisement();

// ---------------------------------------------------------------- fetch cache
// An upload-pack fetch response is a pure function of (repo.objects, args):
// objects are content-addressed and append-only — never deleted or mutated —
// so when repo.objects.size is unchanged, the reachable set for the same args
// is identical, and writePack is deterministic. Memoizing the response turns
// 50 identical depth-1 clones into one pack build. The cache holds derived
// bytes only and never enters the state export.
const fetchCache = new WeakMap<Repo, Map<string, Buffer>>();
const FETCH_CACHE_MAX = 128;
function fetchCacheKey(repo: Repo, a: FetchArgs, protocol: string): string {
  const s = (xs: string[]): string => [...xs].sort().join(',');
  return `${protocol}|${repo.objects.size}|${s(a.wants)}|${s(a.haves)}|${s(a.shallows)}|${a.deepen ?? ''}|${a.filter ?? ''}|${a.thinPack ? 1 : 0}`;
}
function fetchCached(repo: Repo, a: FetchArgs, protocol: string, build: () => Buffer): Buffer {
  let perRepo = fetchCache.get(repo);
  if (!perRepo) { perRepo = new Map(); fetchCache.set(repo, perRepo); }
  const key = fetchCacheKey(repo, a, protocol);
  const hit = perRepo.get(key);
  if (hit) return hit;
  const built = build();
  if (perRepo.size >= FETCH_CACHE_MAX) {
    const oldest = perRepo.keys().next();
    if (!oldest.done) perRepo.delete(oldest.value);
  }
  perRepo.set(key, built);
  return built;
}

export function handleInfoRefs(repo: Repo | undefined, service: string, protocol: string): { status: number; body: Buffer; contentType: string } {
  if (!repo) return { status: 404, body: Buffer.from(JSON.stringify({ message: 'Not Found' })), contentType: 'application/json' };
  if (service === 'git-receive-pack') {
    return { status: 200, body: v0Advertisement(repo, 'git-receive-pack', RECEIVE_CAPS_V0), contentType: 'application/x-git-receive-pack-advertisement' };
  }
  if (service !== 'git-upload-pack') {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'Unknown service' })), contentType: 'application/json' };
  }
  if (protocol === 'version=2') {
    return { status: 200, body: V2_ADVERTISEMENT, contentType: 'application/x-git-upload-pack-advertisement' };
  }
  return { status: 200, body: v0Advertisement(repo, 'git-upload-pack', UPLOAD_CAPS_V0), contentType: 'application/x-git-upload-pack-advertisement' };
}

// ---------------------------------------------------------------- upload-pack v2
interface FetchArgs {
  wants: string[]; haves: string[]; shallows: string[]; deepen: number | null;
  filter: string | null; thinPack: boolean;
}
function parseV2Request(packets: Packet[]): { command: string; args: Map<string, string[]> } {
  let command = '';
  const args = new Map<string, string[]>();
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind !== 'data') { if (p.kind === 'delim') afterDelim = true; continue; }
    const line = p.payload.toString('utf8');
    if (!afterDelim && line.startsWith('command=')) { command = line.slice(8).trim(); continue; }
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [key, ...rest] = trimmed.split(' ');
    const arr = args.get(key) ?? [];
    arr.push(rest.join(' '));
    args.set(key, arr);
  }
  return { command, args };
}

function packForFetch(repo: Repo, a: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const haveSet = new Set(a.haves.filter((h) => isOid(h) && repo.objects.has(h)));
  const wantedRoots = a.wants.filter((w) => isOid(w) && repo.objects.has(w));
  // The haves' whole closure is already held: exclude every object reachable
  // from a have, not just the have commits (shared subtrees/blobs must not
  // be re-sent). This holds for full fetches: a have is a commit the client
  // holds with its complete history.
  const haveClosure = collectReachable(repo, [...haveSet]);
  // For depth-limited fetches the haves are shallow boundaries: the client
  // holds the boundary commit and its own tree, but not its parents, so the
  // exclusion there is only the boundary commits and their trees.
  const haveHeld = new Set<string>(haveSet);
  for (const h of haveSet) {
    const obj = repo.objects.get(h);
    if (obj?.type === 'commit') for (const o of collectReachable(repo, [parseCommit(obj.data).tree])) haveHeld.add(o);
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  let reachable: Set<string>;
  if (a.deepen !== null) {
    // Depth-limited traversal: commits within `deepen` generations of the
    // wants (depth 0 = the want itself). Boundary commits are the deepest
    // included generation; their trees/blobs are included, their parents are not.
    const commitDepth = new Map<string, number>();
    const q2: Array<{ oid: string; depth: number }> = wantedRoots.map((r) => ({ oid: r, depth: 0 }));
    while (q2.length) {
      const { oid, depth } = q2.pop()!;
      if (commitDepth.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      commitDepth.set(oid, depth);
      if (depth < a.deepen - 1) {
        for (const p of parseCommit(obj.data).parents) q2.push({ oid: p, depth: depth + 1 });
      }
    }
    const final = new Set<string>();
    for (const [oid, depth] of commitDepth) {
      if (haveHeld.has(oid)) continue;
      final.add(oid);
      if (depth === a.deepen - 1) shallow.push(oid);
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') {
        for (const o of collectReachable(repo, [parseCommit(obj.data).tree])) {
          if (!haveHeld.has(o)) final.add(o);
        }
      }
    }
    for (const s of a.shallows) if (commitDepth.has(s)) unshallow.push(s);
    reachable = final;
  } else {
    reachable = collectReachable(repo, wantedRoots, { exclude: haveClosure });
  }
  // Deterministic pack order: commits, then trees, then blobs, each by oid.
  const objs: GitObj[] = [];
  const typeRank = { commit: 0, tree: 1, blob: 2, tag: 3 };
  for (const oid of [...reachable].sort((x, y) => {
    const tx = repo.objects.get(x)?.type ?? 'blob'; const ty = repo.objects.get(y)?.type ?? 'blob';
    return typeRank[tx] - typeRank[ty] || (x < y ? -1 : 1);
  })) {
    const o = repo.objects.get(oid);
    if (o) objs.push(o);
  }
  return { pack: writePack(objs), shallow, unshallow };
}
function lsRefsResponse(repo: Repo, args: Map<string, string[]>): Buffer {
  const prefixes = args.get('ref-prefix') ?? [];
  const wantPeel = args.has('peel');
  // An empty repo advertises no refs at all: a HEAD line with a zero oid
  // makes real git write an empty .git/HEAD, and an `unborn refs/heads/...`
  // line would count as a real ref for the clone-empty check.
  if (repo.refs.size === 0) return pktFlush();
  const rows = refRows(repo);
  const lines: string[] = [];
  for (const row of rows) {
    if (prefixes.length > 0 && !prefixes.some((p) => row.name.startsWith(p))) continue;
    if (row.name === 'HEAD') {
      lines.push(`${row.oid} HEAD symref-target:${row.symref}\n`);
      continue;
    }
    if (prefixes.length > 0 && !prefixes.some((p) => row.name.startsWith(p))) continue;
    let line = `${row.oid} ${row.name}`;
    if (wantPeel && row.peeled) line += ` peeled:${row.peeled}`;
    lines.push(`${line}\n`);
  }
  return Buffer.concat([pktLines(lines), pktFlush()]);
}

function fetchV2Response(repo: Repo, args: Map<string, string[]>): Buffer {
  const a: FetchArgs = {
    wants: args.get('want') ?? [], haves: args.get('have') ?? [],
    shallows: args.get('shallow') ?? [],
    deepen: args.has('deepen') ? parseInt(args.get('deepen')![0] ?? '0', 10) : null,
    filter: args.get('filter')?.[0] ?? null, thinPack: args.has('thin-pack'),
  };
  return fetchCached(repo, a, 'v2', () => buildFetchV2Response(repo, a));
}

function buildFetchV2Response(repo: Repo, a: FetchArgs): Buffer {
  const { pack, shallow, unshallow } = packForFetch(repo, a);
  const parts: Buffer[] = [];
  // The acknowledgments section is only sent when the client negotiated with
  // `have` lines; a fresh fetch expects the packfile section first.
  if (a.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  // Sideband: band 1 chunks.
  const chunkSize = 60000;
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  } else {
    for (let off = 0; off < pack.length; off += chunkSize) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(off, off + chunkSize)])));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack v0
interface V0Fetch { wants: string[]; haves: string[]; deepen: number | null; shallows: string[] }
function fetchV0Response(repo: Repo, packets: Packet[]): Buffer {
  const wants: string[] = []; const haves: string[] = []; const shallows: string[] = [];
  let deepen: number | null = null;
  let inHaves = false;
  for (const p of packets) {
    if (p.kind === 'flush') { inHaves = true; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    if (line === 'done') continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('deepen ')) deepen = parseInt(line.slice(7), 10);
    else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
  }
  const a: FetchArgs = { wants, haves, shallows, deepen, filter: null, thinPack: false };
  return fetchCached(repo, a, 'v0', () => buildFetchV0Response(repo, a));
}

function buildFetchV0Response(repo: Repo, a: FetchArgs): Buffer {
  const { pack, shallow, unshallow } = packForFetch(repo, a);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  const chunkSize = 60000;
  for (let off = 0; off < pack.length; off += chunkSize) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(off, off + chunkSize)])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(repo: Repo | undefined, body: Buffer, protocol: string): { status: number; body: Buffer; contentType: string } {
  if (!repo) return { status: 404, body: Buffer.from(JSON.stringify({ message: 'Not Found' })), contentType: 'application/json' };
  let packets: Packet[];
  try { packets = decodePktLines(body); } catch {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'Bad request' })), contentType: 'application/json' };
  }
  const isV2 = protocol === 'version=2' || packets.some((p) => p.kind === 'data' && p.payload.toString('utf8').startsWith('command='));
  if (isV2) {
    const { command, args } = parseV2Request(packets);
    if (command === 'ls-refs') {
      return { status: 200, body: lsRefsResponse(repo, args), contentType: 'application/x-git-upload-pack-result' };
    }
    if (command === 'fetch') {
      return { status: 200, body: fetchV2Response(repo, args), contentType: 'application/x-git-upload-pack-result' };
    }
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'Unknown command' })), contentType: 'application/json' };
  }
  return { status: 200, body: fetchV0Response(repo, packets), contentType: 'application/x-git-upload-pack-result' };
}

// ---------------------------------------------------------------- receive-pack v0
interface PushCommand { oldOid: string; newOid: string; ref: string }
export function handleReceivePack(repo: Repo | undefined, body: Buffer): { status: number; body: Buffer; contentType: string } {
  if (!repo) return { status: 404, body: Buffer.from(JSON.stringify({ message: 'Not Found' })), contentType: 'application/json' };
  const commands: PushCommand[] = [];
  let packOffset = -1;
  let sideBand = false;
  let seenFlush = false;
  let offset = 0;
  // Walk the raw bytes packet by packet: commands until the flush, then the
  // raw pack data follows (it is not pkt-line framed, so never decode it as
  // pkt-lines).
  // Re-walk the raw bytes so we know where the pack starts (after the flush).
  while (offset < body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const len = parseInt(header, 16);
    if (len === 0) { seenFlush = true; packOffset = offset + 4; break; }
    if (len === 1) { offset += 4; continue; }
    if (len < 4 || offset + len > body.length) break;
    const payload = body.subarray(offset + 4, offset + len);
    if (!seenFlush) {
      const line = payload.toString('utf8');
      const nul = line.indexOf('\0');
      const head = nul >= 0 ? line.slice(0, nul) : line;
      const m = head.trim().match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
      if (m) {
        commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
        if (nul >= 0) {
          const caps = line.slice(nul + 1);
          if (caps.includes('side-band-64k')) sideBand = true;
        }
      }
    }
    offset += len;
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  if (packOffset >= 0 && packOffset < body.length) {
    const packBytes = body.subarray(packOffset);
    if (packBytes.length >= 12) {
      try {
        const objs = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of objs) repo.objects.set(oid, obj);
      } catch {
        unpackOk = false;
      }
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const cmd of commands) {
    const cur = repo.refs.get(cmd.ref);
    if (!unpackOk) { results.push({ ref: cmd.ref, ok: false, reason: 'unpack error' }); continue; }
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (!cur) { results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' }); continue; }
      repo.refs.delete(cmd.ref);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    const target = repo.objects.get(cmd.newOid);
    if (!target || (target.type !== 'commit' && target.type !== 'tag')) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' }); continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (cur) { results.push({ ref: cmd.ref, ok: false, reason: 'already exists' }); continue; }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    if (cur !== cmd.oldOid) { results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    // fast-forward check: new tip must descend from old tip
    const peeledNew = target.type === 'tag' ? peelObject(repo, cmd.newOid) : cmd.newOid;
    const peeledOld = peelObject(repo, cmd.oldOid);
    if (!isOid(peeledNew) || !isAncestorCommit(repo, peeledOld, peeledNew)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true });
  }
  reportLines.push(unpackOk ? 'unpack ok\n' : 'unpack error\n');
  for (const r of results) reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? 'error'}\n`);
  // The report is pkt-lines inside sideband band 1, and must end with a flush
  // pkt-line inside the band so the reader sees a clean end, not EOF.
  const report = pktLines([...reportLines, 'flush']);
  let out: Buffer;
  if (sideBand) {
    const chunks: Buffer[] = [];
    const chunkSize = 60000;
    for (let off = 0; off < report.length; off += chunkSize) {
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(off, off + chunkSize)])));
    }
    out = Buffer.concat([...chunks, pktFlush()]);
  } else {
    out = Buffer.concat([report, pktFlush()]);
  }
  return { status: 200, body: out, contentType: 'application/x-git-receive-pack-result' };
}

export { VIEWER_LOGIN, filesAt, putObject, hashObject };
