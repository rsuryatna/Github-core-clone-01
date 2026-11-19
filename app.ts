// app.ts — HTTP surface: /healthz, git smart HTTP, REST v3, GraphQL, MCP.
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type Socket, type Server as NetServer } from 'node:net';

/** The narrow surface the routing code uses from a request: a real node:http
 *  request and the raw TCP server's facade both satisfy it, so the handlers
 *  below never know which transport delivered the request. */
export interface ReqLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data' | 'end' | 'error', cb: (...args: never[]) => void): void;
  destroy(err?: Error): void;
}
export interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(data?: unknown): void;
}
import {
  VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL, store,
  isOid, repoJson, issueJson, pullJson, prFiles, prConflicted, squashMerge,
  filesAt, blobBytes, createCommit, parseCommit,
  type Repo, type Issue, type PullRequest,
} from './core.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './git.ts';
import { handleGraphQL, handleMcp } from './api.ts';

let reqCounter = 0;
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authOk(req: ReqLike): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const token = h.slice(7);
  if (!token) return false;
  if (SHOP_TOKEN) return token === SHOP_TOKEN;
  return true;
}
function sendJson(res: ResLike, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'x-github-request-id': `req-${++reqCounter}`, ...extra });
  res.end(data);
}
function sendErr(res: ResLike, status: number, message: string): void {
  sendJson(res, status, { message });
}
function readBody(req: ReqLike): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    // Track the length incrementally: concat-ing the accumulated chunks on
    // every data event is quadratic for large bodies (a 600-object push).
    let total = 0;
    req.on('data', (c: Buffer) => { chunks.push(c); total += c.length; if (total > 64 * 1024 * 1024) req.destroy(new Error('body too large')); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req: ReqLike): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw.toString('utf8')) }; }
  catch { return { ok: false }; }
}
function paginationLink(req: ReqLike, url: URL, totalPages: number): string {
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPage = Math.max(1, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30);
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${url.pathname}`;
  const link = (p: number, rel: string): string => `<${base}?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), page: String(p), per_page: String(perPage) }).toString()}>; rel="${rel}"`;
  const links: string[] = [];
  if (page < totalPages) links.push(link(page + 1, 'next'));
  if (page > 1) links.push(link(page - 1, 'prev'));
  links.push(link(1, 'first'));
  links.push(link(Math.max(1, totalPages), 'last'));
  return links.join(', ');
}
function paginate<T>(req: ReqLike, url: URL, items: T[]): { page: T[]; link: string } {
  const perPage = Math.max(1, Math.min(100, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  return { page: slice, link: paginationLink(req, url, totalPages) };
}

// ---------------------------------------------------------------- git helpers for REST
function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}
function snapshotBytes(repo: Repo, tip: string | undefined): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!tip) return out;
  for (const [path, oid] of filesAt(repo, tip)) {
    const b = blobBytes(repo, oid);
    if (b) out.set(path, b);
  }
  return out;
}
function createIssueIn(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const number = repo.nextNum++;
  const issue: Issue = { number, id: store.nextIssueId++, title, body, state: 'open', labels, seq: number, comments: [], user: VIEWER_LOGIN };
  repo.issues.push(issue);
  return issue;
}

// ---------------------------------------------------------------- REST handlers
async function handleRest(req: ReqLike, res: ResLike, url: URL, segments: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  // GET /api/v3/
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    } else sendErr(res, 405, 'Method Not Allowed');
    return;
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method === 'GET') sendJson(res, 200, { installed_version: '1.0.0' });
    else sendErr(res, 405, 'Method Not Allowed');
    return;
  }
  if (segments.length === 1 && segments[0] === 'rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 0 } } });
    return;
  }
  if (segments.length === 1 && segments[0] === 'user') {
    if (method === 'GET') {
      sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User', html_url: `https://github.com/${VIEWER_LOGIN}` });
      return;
    }
    sendErr(res, 405, 'Method Not Allowed');
    return;
  }
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) { sendErr(res, 422, 'name is required'); return; }
      const repo = store.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      if (!repo) { sendErr(res, 422, 'name already exists on this account'); return; }
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const { page, link } = paginate(req, url, store.listRepos(VIEWER_LOGIN).map((r) => repoJson(r)));
      sendJson(res, 200, page, { link });
      return;
    }
    sendErr(res, 405, 'Method Not Allowed');
    return;
  }
  // /api/v3/repos/{owner}/{repo}[...]
  if (segments[0] !== 'repos' || segments.length < 3) { sendErr(res, 404, 'Not Found'); return; }
  const owner = segments[1]!;
  const repoName = segments[2]!;
  const rest = segments.slice(3);
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  // Repo object itself
  if (rest.length === 0) {
    if (!repo) { sendErr(res, 404, 'Not Found'); return; }
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') { store.deleteRepo(owner, repoName); res.writeHead(204, { 'x-github-request-id': `req-${++reqCounter}` }); res.end(); return; }
    sendErr(res, 405, 'Method Not Allowed');
    return;
  }
  if (!repo) { sendErr(res, 404, 'Not Found'); return; }
  const sub = rest[0]!;
  // ---- git refs
  if (sub === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) { sendErr(res, 422, 'Invalid ref or sha'); return; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, '')}` });
      return;
    }
    if (method === 'GET') {
      const refPath = rest.slice(2).join('/');
      if (!refPath) {
        const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
        sendJson(res, 200, all);
        return;
      }
      const fullRef = `refs/${refPath}`;
      const sha = repo.refs.get(fullRef);
      if (!sha) { sendErr(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { ref: fullRef, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${refPath}` });
      return;
    }
    sendErr(res, 405, 'Method Not Allowed');
    return;
  }
  // ---- branches
  if (sub === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.entries()]
        .filter(([r]) => r.startsWith('refs/heads/'))
        .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      sendJson(res, 200, list);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(rest[1]!);
      const sha = branchTip(repo, branch);
      if (!sha) { sendErr(res, 404, 'Branch not found'); return; }
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }
  // ---- commits
  if (sub === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const shaParam = url.searchParams.get('sha');
      const tip = shaParam ? (store.resolveRef(repo, shaParam) ?? (isOid(shaParam) && repo.objects.has(shaParam) ? shaParam : undefined)) : branchTip(repo, repo.defaultBranch);
      if (!tip) { sendJson(res, 200, []); return; }
      const list: Record<string, unknown>[] = [];
      const queue: string[] = [tip];
      const seen = new Set<string>();
      while (queue.length) {
        const oid = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const c = parseCommit(obj.data);
        list.push({
          sha: oid, commit: { message: c.message.trim(), author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: '2026-01-01T00:00:00Z' }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: '2026-01-01T00:00:00Z' } },
          parents: c.parents.map((p) => ({ sha: p })),
        });
        for (const p of c.parents) queue.push(p);
      }
      const { page, link } = paginate(req, url, list);
      sendJson(res, 200, page, { link });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }
  // ---- contents
  if (sub === 'contents') {
    const path = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    const refParam = url.searchParams.get('ref');
    const tip = refParam ? store.resolveRef(repo, refParam) : branchTip(repo, repo.defaultBranch);
    if (method === 'GET') {
      const files = filesAt(repo, tip ?? '');
      if (!tip) { sendErr(res, 404, 'Not Found'); return; }
      if (files.has(path)) {
        const oid = files.get(path)!;
        const data = blobBytes(repo, oid) ?? Buffer.alloc(0);
        sendJson(res, 200, { type: 'file', encoding: 'base64', size: data.length, name: path.split('/').pop(), path, content: data.toString('base64'), sha: oid });
        return;
      }
      // directory listing
      const prefix = path ? `${path}/` : '';
      const entries: Record<string, unknown>[] = [];
      const seenDirs = new Set<string>();
      for (const [p, oid] of files) {
        if (!p.startsWith(prefix)) continue;
        const restPath = p.slice(prefix.length);
        const slash = restPath.indexOf('/');
        if (slash === -1) entries.push({ type: 'file', name: restPath, path: p, sha: oid, size: (blobBytes(repo, oid) ?? Buffer.alloc(0)).length });
        else {
          const dir = restPath.slice(0, slash);
          if (!seenDirs.has(dir)) { seenDirs.add(dir); entries.push({ type: 'dir', name: dir, path: `${prefix}${dir}`, sha: '' }); }
        }
      }
      if (entries.length === 0) { sendErr(res, 404, 'Not Found'); return; }
      entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      sendJson(res, 200, entries);
      return;
    }
    if (method === 'PUT') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const contentB64 = typeof body.content === 'string' ? body.content : '';
      const message = typeof body.message === 'string' ? body.message : 'Update';
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const shaField = typeof body.sha === 'string' ? body.sha : undefined;
      let data: Buffer;
      try { data = Buffer.from(contentB64.replace(/\n/g, ''), 'base64'); } catch { sendErr(res, 400, 'Invalid content encoding'); return; }
      const tipBranch = branchTip(repo, branch);
      const files = snapshotBytes(repo, tipBranch);
      const existing = files.has(path) ? filesAt(repo, tipBranch ?? '').get(path) : undefined;
      if (shaField && existing && shaField !== existing) { sendErr(res, 409, 'sha does not match'); return; }
      const isCreate = !existing;
      files.set(path, data);
      const commit = createCommit(repo, files, tipBranch ? [tipBranch] : [], message);
      repo.refs.set(`refs/heads/${branch}`, commit);
      const blobOid = filesAt(repo, commit).get(path)!;
      sendJson(res, isCreate ? 201 : 200, {
        content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
        commit: { sha: commit, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const message = typeof body.message === 'string' ? body.message : 'Delete';
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const shaField = typeof body.sha === 'string' ? body.sha : undefined;
      const tipBranch = branchTip(repo, branch);
      if (!tipBranch) { sendErr(res, 404, 'Not Found'); return; }
      const files = snapshotBytes(repo, tipBranch);
      if (!files.has(path)) { sendErr(res, 404, 'Not Found'); return; }
      if (shaField) {
        const cur = filesAt(repo, tipBranch).get(path);
        if (cur && cur !== shaField) { sendErr(res, 409, 'sha does not match'); return; }
      }
      files.delete(path);
      const commit = createCommit(repo, files, [tipBranch], message);
      repo.refs.set(`refs/heads/${branch}`, commit);
      sendJson(res, 200, { commit: { sha: commit, message } });
      return;
    }
    sendErr(res, 405, 'Method Not Allowed');
    return;
  }
  // ---- labels
  if (sub === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
      if (!name) { sendErr(res, 422, 'name is required'); return; }
      const existing = repo.labels.get(name);
      if (existing) { sendJson(res, 201, { name: existing.name, color: existing.color }); return; }
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color });
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }
  // ---- issues
  if (sub === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const title = typeof body.title === 'string' ? body.title : '';
        const bodyText = typeof body.body === 'string' ? body.body : '';
        if (!title) { sendErr(res, 422, 'title is required'); return; }
        const labelNames: string[] = Array.isArray(body.labels) ? body.labels.map((l) => (typeof l === 'string' ? l : String((l as { name?: unknown }).name ?? ''))).filter(Boolean) : [];
        for (const l of labelNames) if (!repo.labels.has(l)) { sendErr(res, 422, `Label does not exist: ${l}`); return; }
        const issue = createIssueIn(repo, title, bodyText, labelNames);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const sort = url.searchParams.get('sort') ?? 'created';
        const direction = url.searchParams.get('direction') ?? 'asc';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') list.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
        const { page, link } = paginate(req, url, list.map((i) => issueJson(repo, i)));
        sendJson(res, 200, page, { link });
        return;
      }
      sendErr(res, 405, 'Method Not Allowed');
      return;
    }
    const num = parseInt(rest[1] ?? '', 10);
    const issue = Number.isInteger(num) ? repo.issues.find((i) => i.number === num) : undefined;
    if (!issue) { sendErr(res, 404, 'Not Found'); return; }
    if (rest.length === 2) {
      if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
      if (method === 'PATCH') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const names = body.labels.map((l) => (typeof l === 'string' ? l : String((l as { name?: unknown }).name ?? ''))).filter(Boolean);
          for (const l of names) if (!repo.labels.has(l)) { sendErr(res, 422, `Label does not exist: ${l}`); return; }
          issue.labels = names;
        }
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      sendErr(res, 405, 'Method Not Allowed');
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: '2026-01-01T00:00:00Z' })));
        return;
      }
      if (method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const commentBody = typeof body.body === 'string' ? body.body : '';
        if (!commentBody) { sendErr(res, 422, 'body is required'); return; }
        const id = repo.nextCommentId++;
        issue.comments.push({ id, body: commentBody, user: VIEWER_LOGIN, seq: id });
        sendJson(res, 201, { id, body: commentBody, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: '2026-01-01T00:00:00Z' });
        return;
      }
      sendErr(res, 405, 'Method Not Allowed');
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }
  // ---- pulls
  if (sub === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const title = typeof body.title === 'string' ? body.title : '';
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
        if (!title || !head) { sendErr(res, 422, 'title and head are required'); return; }
        const headSha = store.resolveRef(repo, head);
        const baseSha = store.resolveRef(repo, base);
        if (!headSha || !baseSha) { sendErr(res, 422, 'Invalid head or base branch'); return; }
        const number = repo.nextNum++;
        const pr: PullRequest = {
          number, id: store.nextPullId++, title, body: typeof body.body === 'string' ? body.body : '', state: 'open',
          headRef: head, baseRef: base, headSha, baseSha, merged: false, mergedAt: null, mergeSha: null, seq: number, user: VIEWER_LOGIN,
        };
        repo.pulls.push(pr);
        sendJson(res, 201, pullJson(repo, pr));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        const { page, link } = paginate(req, url, list.map((p) => pullJson(repo, p)));
        sendJson(res, 200, page, { link });
        return;
      }
      sendErr(res, 405, 'Method Not Allowed');
      return;
    }
    const num = parseInt(rest[1] ?? '', 10);
    const pr = Number.isInteger(num) ? repo.pulls.find((p) => p.number === num) : undefined;
    if (!pr) { sendErr(res, 404, 'Not Found'); return; }
    if (rest.length === 2) {
      if (method === 'GET') { sendJson(res, 200, pullJson(repo, pr)); return; }
      if (method === 'PATCH') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        if (typeof body.title === 'string') pr.title = body.title;
        if (typeof body.body === 'string') pr.body = body.body;
        if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) pr.state = body.state;
        sendJson(res, 200, pullJson(repo, pr));
        return;
      }
      sendErr(res, 405, 'Method Not Allowed');
      return;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      sendJson(res, 200, prFiles(repo, pr).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })));
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
      if (pr.merged) { sendJson(res, 200, { merged: true, sha: pr.mergeSha, message: `Pull request #${pr.number} merged` }); return; }
      if (pr.state !== 'open') { sendErr(res, 405, 'Pull request is closed'); return; }
      if (prConflicted(repo, pr)) { sendErr(res, 405, 'Merge conflict'); return; }
      const sha = squashMerge(repo, pr);
      if (!sha) { sendErr(res, 405, 'Merge conflict'); return; }
      sendJson(res, 200, { merged: true, sha, message: `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}` });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }
  sendErr(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- server
async function route(req: ReqLike, res: ResLike): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const segments = url.pathname.split('/').filter((s) => s.length > 0).map((s) => {
        try { return decodeURIComponent(s); } catch { return s; }
      });
      if (req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
        const owner = segments[0]!;
        const repoName = segments[1]!.slice(0, -4);
        const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
        const tail = segments.slice(2);
        if (req.method === 'GET' && tail[0] === 'info' && tail[1] === 'refs') {
          const service = url.searchParams.get('service') ?? '';
          const r = handleInfoRefs(repo, service, req.headers['git-protocol'] ?? '');
          res.writeHead(r.status, { 'content-type': r.contentType, 'x-github-request-id': `req-${++reqCounter}` });
          res.end(r.body);
          return;
        }
        if (req.method === 'POST' && tail[0] === 'git-upload-pack') {
          const body = await readBody(req);
          const r = handleUploadPack(repo, body, req.headers['git-protocol'] ?? '');
          res.writeHead(r.status, { 'content-type': r.contentType, 'x-github-request-id': `req-${++reqCounter}` });
          res.end(r.body);
          return;
        }
        if (req.method === 'POST' && tail[0] === 'git-receive-pack') {
          const body = await readBody(req);
          const r = handleReceivePack(repo, body);
          res.writeHead(r.status, { 'content-type': r.contentType, 'x-github-request-id': `req-${++reqCounter}` });
          res.end(r.body);
          return;
        }
        sendErr(res, 404, 'Not Found');
        return;
      }
      // GraphQL
      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
        if (req.method !== 'POST') { sendErr(res, 405, 'Method Not Allowed'); return; }
        if (!authOk(req)) { sendErr(res, 401, 'Requires authentication'); return; }
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
        const [status, body] = handleGraphQL(parsed.value);
        sendJson(res, status, body);
        return;
      }
      // MCP
      if (segments.length === 1 && segments[0] === 'mcp') {
        if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
        if (req.method !== 'POST') { sendErr(res, 405, 'Method Not Allowed'); return; }
        if (!authOk(req)) { sendErr(res, 401, 'Requires authentication'); return; }
        const raw = await readBody(req);
        let body: unknown;
        try { body = JSON.parse(raw.toString('utf8')); } catch {
          const idMatch = raw.toString('utf8').match(/"id"\s*:\s*(\d+)/);
          const id = idMatch ? parseInt(idMatch[1]!, 10) : null;
          sendJson(res, 400, { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } });
          return;
        }
        const out = handleMcp(body);
        if ('empty' in out) { res.writeHead(out.status); res.end(); return; }
        sendJson(res, out.status, out.json);
        return;
      }
      // REST v3
      if (segments[0] === 'api' && segments[1] === 'v3') {
        if (!authOk(req)) { sendErr(res, 401, 'Requires authentication'); return; }
        await handleRest(req, res, url, segments.slice(2));
        return;
      }
      sendErr(res, 404, 'Not Found');
    } catch (err) {
      try { sendErr(res, 500, err instanceof Error ? err.message : 'Internal error'); } catch { /* already sent */ }
    }
}

// ---------------------------------------------------------------- raw TCP transport
// Replaces node:http with a minimal HTTP/1.1 parser over a raw socket. The
// handlers above never see the difference: they get a ReqLike facade whose
// body arrives via the same 'data'/'end' events readBody expects, and a
// ResLike that captures writeHead/end into one buffer. Each response goes out
// as a single socket.write (prebuilt head + body), which is what makes this
// faster than node:http on this workload: no per-request parser objects, no
// stream machinery, no chunked framing on the way out, no per-response Date
// formatting (the Date header is cached and refreshed once a second).

const MAX_BODY = 64 * 1024 * 1024; // mirror readBody's cap

let cachedDate = new Date().toUTCString();
const dateTimer = setInterval(() => { cachedDate = new Date().toUTCString(); }, 1000);
dateTimer.unref();

function statusText(status: number): string {
  switch (status) {
    case 200: return 'OK';
    case 201: return 'Created';
    case 204: return 'No Content';
    case 400: return 'Bad Request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 405: return 'Method Not Allowed';
    case 422: return 'Unprocessable Entity';
    case 500: return 'Internal Server Error';
    default: return 'OK';
  }
}

interface RawRequest {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  body: Buffer;
}

interface ParsedHead {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  headLen: number;
}

/** Parse the request line + headers out of `buf`. Returns null when the head
 *  is incomplete; throws on malformed input. */
function parseHead(buf: Buffer): ParsedHead | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd === -1) {
    if (buf.length > 65536) throw new Error('headers too large');
    return null;
  }
  const head = buf.subarray(0, headEnd).toString('latin1');
  const lines = head.split('\r\n');
  const m = /^([A-Z]+) (\S+) HTTP\/(\d\.\d)$/.exec(lines[0]!);
  if (!m) throw new Error('bad request line');
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i]!.indexOf(':');
    if (idx === -1) throw new Error('bad header');
    const name = lines[i]!.slice(0, idx).trim().toLowerCase();
    const value = lines[i]!.slice(idx + 1).trim();
    if (headers[name] === undefined) headers[name] = value;
    else headers[name] += ', ' + value;
  }
  return { method: m[1]!, target: m[2]!, version: m[3]!, headers, headLen: headEnd + 4 };
}

/** Extract the body for a parsed head from `buf` (bytes after the head).
 *  Returns null when more bytes are needed; throws on malformed framing.
 *  Supports Content-Length and chunked bodies. */
function extractBody(head: ParsedHead, buf: Buffer): { body: Buffer; consumed: number } | null {
  const te = head.headers['transfer-encoding'];
  if (te && te.toLowerCase().includes('chunked')) {
    const chunks: Buffer[] = [];
    let total = 0;
    let pos = 0;
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', pos);
      if (lineEnd === -1) return null;
      const sizeLine = buf.subarray(pos, lineEnd).toString('latin1');
      const semi = sizeLine.indexOf(';');
      const size = parseInt(semi === -1 ? sizeLine : sizeLine.slice(0, semi), 16);
      if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
      total += size;
      if (total > MAX_BODY) throw new Error('body too large');
      pos = lineEnd + 2;
      if (size === 0) {
        // Trailers run until an empty line.
        for (;;) {
          const eol = buf.indexOf('\r\n', pos);
          if (eol === -1) return null;
          if (eol === pos) { pos += 2; break; }
          pos = eol + 2;
        }
        break;
      }
      if (buf.length < pos + size + 2) return null;
      chunks.push(buf.subarray(pos, pos + size));
      pos += size + 2; // chunk data + trailing CRLF
    }
    return { body: Buffer.concat(chunks, total), consumed: pos };
  }
  const clen = head.headers['content-length'] ? parseInt(head.headers['content-length'], 10) : 0;
  if (!Number.isFinite(clen) || clen < 0) throw new Error('bad content-length');
  if (clen > MAX_BODY) throw new Error('body too large');
  if (buf.length < clen) return null;
  return { body: buf.subarray(0, clen), consumed: clen };
}

function shouldKeepAlive(req: RawRequest): boolean {
  const conn = (req.headers['connection'] ?? '').toLowerCase();
  if (conn.includes('close')) return false;
  if (req.version === '1.0') return conn.includes('keep-alive');
  return true;
}

/** Run one parsed request through the existing handlers and return the
 *  captured response. The fake request replays the buffered body through the
 *  'data'/'end' events readBody listens for, so handler code is untouched. */
async function dispatchRaw(req: RawRequest, socket: Socket): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const listeners: Record<string, Array<(c?: Buffer) => void>> = { data: [], end: [], error: [] };
  let status = 500;
  const outHeaders: Record<string, string> = {};
  const outBody: Buffer[] = [];
  let doneResolve!: () => void;
  const done = new Promise<void>((resolve) => { doneResolve = resolve; });
  const fakeReq: ReqLike = {
    method: req.method,
    url: req.target,
    headers: req.headers,
    on(event, cb) { listeners[event]!.push(cb as (c?: Buffer) => void); },
    destroy() { socket.destroy(); },
  };
  const fakeRes: ResLike = {
    writeHead(s, h) {
      status = s;
      if (h) for (const k of Object.keys(h)) outHeaders[k.toLowerCase()] = h[k]!;
    },
    end(data) {
      if (data !== undefined && data !== null) outBody.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      doneResolve();
    },
  };
  const p = route(fakeReq, fakeRes).catch(() => {
    // route() already sends a 500 on its own errors; this is a last resort.
    if (status === 500 && outBody.length === 0) {
      fakeRes.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      fakeRes.end(JSON.stringify({ message: 'Internal error' }));
    }
  });
  // Replay the body after the handlers have attached their listeners.
  queueMicrotask(() => {
    if (req.body.length > 0) for (const cb of listeners.data) cb(req.body);
    for (const cb of listeners.end) cb();
  });
  await done;
  await p;
  return { status, headers: outHeaders, body: Buffer.concat(outBody) };
}

function buildResponseHead(status: number, headers: Record<string, string>, bodyLen: number, keepAlive: boolean): Buffer {
  const parts: string[] = [`HTTP/1.1 ${status} ${statusText(status)}\r\n`];
  let hasDate = false;
  let hasLength = false;
  let hasConn = false;
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'date') hasDate = true;
    if (lk === 'content-length') hasLength = true;
    if (lk === 'connection') hasConn = true;
    parts.push(`${k}: ${headers[k]}\r\n`);
  }
  if (!hasDate) parts.push(`date: ${cachedDate}\r\n`);
  if (!hasLength) parts.push(`content-length: ${bodyLen}\r\n`);
  if (!hasConn) parts.push(`connection: ${keepAlive ? 'keep-alive' : 'close'}\r\n`);
  parts.push('\r\n');
  return Buffer.from(parts.join(''), 'latin1');
}

function createRawApp(): NetServer {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    socket.setNoDelay(true);
    socket.setTimeout(60_000);
    socket.on('timeout', () => socket.destroy());
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* 'close' cleans up */ });
    let buf = Buffer.alloc(0);
    let pendingHead: ParsedHead | null = null;
    let chain: Promise<void> = Promise.resolve();
    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        if (!pendingHead) {
          let head: ParsedHead | null;
          try {
            head = parseHead(buf);
          } catch {
            const body = Buffer.from(JSON.stringify({ message: 'Bad Request' }));
            const respHead = buildResponseHead(400, { 'content-type': 'application/json; charset=utf-8' }, body.length, false);
            socket.write(Buffer.concat([respHead, body]));
            socket.destroy();
            return;
          }
          if (!head) break;
          buf = buf.subarray(head.headLen);
          pendingHead = head;
          // 100-continue (libcurl/git send this for bodies > 1 KiB): answer
          // immediately, before waiting for the body, or the client stalls.
          if ((head.headers['expect'] ?? '').toLowerCase().includes('100-continue')) {
            socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1'));
          }
        }
        let extracted: { body: Buffer; consumed: number } | null;
        try {
          extracted = extractBody(pendingHead, buf);
        } catch {
          const body = Buffer.from(JSON.stringify({ message: 'Bad Request' }));
          const respHead = buildResponseHead(400, { 'content-type': 'application/json; charset=utf-8' }, body.length, false);
          socket.write(Buffer.concat([respHead, body]));
          socket.destroy();
          return;
        }
        if (!extracted) break;
        buf = buf.subarray(extracted.consumed);
        if (buf.length === 0) buf = Buffer.alloc(0);
        const rawReq: RawRequest = {
          method: pendingHead.method,
          target: pendingHead.target,
          version: pendingHead.version,
          headers: pendingHead.headers,
          body: extracted.body,
        };
        pendingHead = null;
        const keepAlive = shouldKeepAlive(rawReq);
        // Serialize responses per socket so pipelined requests are answered
        // in order; the chain is idle between sequential requests.
        chain = chain.then(async () => {
          const out = await dispatchRaw(rawReq, socket);
          const respHead = buildResponseHead(out.status, out.headers, out.body.length, keepAlive);
          const packet = out.body.length === 0 ? respHead : Buffer.concat([respHead, out.body]);
          if (!socket.write(packet)) await new Promise<void>((resolve) => socket.once('drain', resolve));
          if (!keepAlive) socket.end();
        }).catch(() => { socket.destroy(); });
      }
    });
  });
  const origClose = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const s of sockets) s.destroy();
    return origClose(cb as never);
  }) as typeof server.close;
  return server;
}

export function createApp(): Server | NetServer {
  // FORGE_HTTP=node selects the node:http transport for A/B measurement.
  // (The trial spawns the entry with a fixed env, so this default is the
  // switch; the committed default is the raw server.)
  if (process.env.FORGE_HTTP === 'node') {
    return createServer(async (req, res) => { await route(req, res); });
  }
  return createRawApp();
}
