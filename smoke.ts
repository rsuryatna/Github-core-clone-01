// smoke.ts — local smoke test (not part of the entry): starts the app on an
// ephemeral port and exercises REST + real git clone/push + GraphQL + MCP.
import { createApp } from './app.ts';

const server = createApp();
await new Promise<void>((resolve) => server.listen(0, resolve));
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('no port');
const base = `http://127.0.0.1:${addr.port}`;
const TOKEN = 'shpat_testtoken';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  if (!cond) failures++;
}
async function j(method: string, path: string, body?: unknown, headers: Record<string, string> = H): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, json, text };
}

// healthz (no auth)
let r = await fetch(`${base}/healthz`);
check('healthz', r.status === 200 && (await r.json() as { ok: boolean }).ok === true);
// auth
r = await fetch(`${base}/api/v3/user`);
check('rest no-auth 401', r.status === 401);
let u = await j('GET', '/api/v3/user');
check('user login adaiversen', u.status === 200 && (u.json as { login: string }).login === 'adaiversen', u.json);
let meta = await j('GET', '/api/v3/meta');
check('meta', meta.status === 200 && typeof (meta.json as { installed_version: string }).installed_version === 'string');
// create repo
let cr = await j('POST', '/api/v3/user/repos', { name: 'smoke', description: 'smoke test' });
check('create repo 201', cr.status === 201, cr.json);
// git clone empty + push via real git
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const execFileAsync = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), 'smoke-'));
function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  return execFileAsync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, ...env } }).then((r) => r.stdout);
}
const remote = `${base}/adaiversen/smoke.git`;
await git(['clone', remote, 'w'], dir, { GIT_ASKPASS: 'true' });
check('clone empty ok', existsSync(join(dir, 'w', '.git')));
await git(['-C', 'w', 'checkout', '-b', 'main'], dir);
writeFileSync(join(dir, 'w', 'hello.txt'), 'hello world\n');
await git(['-C', 'w', 'config', 'user.email', 'adaiversen@example.invalid'], dir);
await git(['-C', 'w', 'config', 'user.name', 'ada iversen'], dir);
await git(['-C', 'w', 'add', '.'], dir);
await git(['-C', 'w', 'commit', '-m', 'first commit'], dir);
await git(['-C', 'w', 'push', '-u', 'origin', 'main'], dir);
check('push ok', true);
await git(['clone', remote, 'w2'], dir);
check('clone has hello.txt', existsSync(join(dir, 'w2', 'hello.txt')));
// contents
let contents = await j('GET', '/api/v3/repos/adaiversen/smoke/contents/hello.txt');
check('contents read', contents.status === 200 && Buffer.from((contents.json as { content: string }).content, 'base64').toString() === 'hello world\n', contents.json);
let put = await j('PUT', '/api/v3/repos/adaiversen/smoke/contents/new.txt', { message: 'add new', content: Buffer.from('new file\n').toString('base64') });
check('contents put 201', put.status === 201, put.json);
let branches = await j('GET', '/api/v3/repos/adaiversen/smoke/branches');
check('branches', branches.status === 200 && Array.isArray(branches.json) && (branches.json as unknown[]).length === 1, branches.json);
let commits = await j('GET', '/api/v3/repos/adaiversen/smoke/commits');
check('commits list', commits.status === 200 && Array.isArray(commits.json) && (commits.json as unknown[]).length === 2, (commits.json as unknown[])?.length);
// issues + PR flow
let issue = await j('POST', '/api/v3/repos/adaiversen/smoke/issues', { title: 'bug one', body: 'body' });
check('issue create', issue.status === 201 && (issue.json as { number: number }).number === 1, issue.json);
let issList = await j('GET', '/api/v3/repos/adaiversen/smoke/issues?state=open');
check('issues list', issList.status === 200 && (issList.json as unknown[]).length === 1);
let comment = await j('POST', '/api/v3/repos/adaiversen/smoke/issues/1/comments', { body: 'hi' });
check('comment', comment.status === 201, comment.json);
// branch via git, PR via REST
await git(['-C', 'w', 'checkout', '-b', 'feature-x'], dir);
writeFileSync(join(dir, 'w', 'feat.txt'), 'feature\n');
await git(['-C', 'w', 'add', '.'], dir);
await git(['-C', 'w', 'commit', '-m', 'feat'], dir);
await git(['-C', 'w', 'push', '-u', 'origin', 'feature-x'], dir);
let pr = await j('POST', '/api/v3/repos/adaiversen/smoke/pulls', { title: 'add feat', head: 'feature-x', base: 'main' });
check('pr create', pr.status === 201 && (pr.json as { number: number }).number === 2, pr.json);
let files = await j('GET', '/api/v3/repos/adaiversen/smoke/pulls/2/files');
check('pr files', files.status === 200 && Array.isArray(files.json) && (files.json as { filename: string }[]).some((f) => f.filename === 'feat.txt'), files.json);
let merge = await j('PUT', '/api/v3/repos/adaiversen/smoke/pulls/2/merge', { merge_method: 'squash' });
check('pr merge', merge.status === 200 && (merge.json as { merged: boolean }).merged === true, merge.json);
let after = await j('GET', '/api/v3/repos/adaiversen/smoke/contents/feat.txt');
check('merged content visible', after.status === 200);
// GraphQL
let gql = await j('POST', '/api/graphql', { query: 'query ViewerLogin { viewer { login } }' });
check('graphql viewer', gql.status === 200 && (gql.json as { data: { viewer: { login: string } } }).data.viewer.login === 'adaiversen', gql.json);
let gqlRepo = await j('POST', '/api/graphql', { query: 'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }', variables: { owner: 'adaiversen', name: 'smoke' } });
check('graphql repo', gqlRepo.status === 200 && (gqlRepo.json as { data: { repository: { name: string } } }).data.repository.name === 'smoke', gqlRepo.json);
// MCP
let mcpInit = await j('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
check('mcp initialize', mcpInit.status === 200 && (mcpInit.json as { result: { serverInfo: { name: string } } }).result.serverInfo.name === 'github-core-clone', mcpInit.json);
let mcpList = await j('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
check('mcp tools/list >=6', mcpList.status === 200 && ((mcpList.json as { result: { tools: unknown[] } }).result.tools.length >= 6));
let mcpCall = await j('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'smoke', title: 'mcp issue' } } });
check('mcp create_issue', mcpCall.status === 200 && !(mcpCall.json as { result: { isError: boolean } }).result.isError, mcpCall.json);
let mcpBad = await j('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
check('mcp unknown tool -32602', mcpBad.status === 200 && (mcpBad.json as { error: { code: number } }).error.code === -32602, mcpBad.json);

server.close();
console.log(failures === 0 ? 'SMOKE ALL PASS' : `SMOKE ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
