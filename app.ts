// app.ts — HTTP surface: /healthz, git smart HTTP, REST v3, GraphQL, MCP.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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

function authOk(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const token = h.slice(7);
  if (!token) return false;
  if (SHOP_TOKEN) return token === SHOP_TOKEN;
  return true;
}
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'x-github-request-id': `req-${++reqCounter}`, ...extra });
  res.end(data);
}
function sendErr(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function readBody(req: IncomingMessage): Promise<Buffer> {
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
async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw.toString('utf8')) }; }
  catch { return { ok: false }; }
}
function paginationLink(req: IncomingMessage, url: URL, totalPages: number): string {
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
function paginate<T>(req: IncomingMessage, url: URL, items: T[]): { page: T[]; link: string } {
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
async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, segments: string[]): Promise<void> {
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
export function createApp(): Server {
  return createServer(async (req, res) => {
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
  });
}
