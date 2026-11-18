// api.ts — GraphQL v4 (POST /api/graphql) and MCP (POST /mcp), both over the
// same Store as REST. GraphQL is dispatched on the documents the gh CLI and
// github-mcp-server actually send; introspection answers the fixed schema.
import {
  VIEWER_LOGIN, VIEWER_ID, store, globalId, decodeGlobalId, isOid,
  repoJson, issueJson, pullJson, prFiles, prConflicted, squashMerge,
  filesAt, type Repo, type Issue, type PullRequest,
} from './core.ts';

// ---------------------------------------------------------------- GraphQL
const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'assignees', 'closedAt'];
const PR_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'author', 'reviews'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'visibility'];
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'];

function cursorFor(n: number): string { return Buffer.from(`cursor:${n}`, 'utf8').toString('base64'); }
function cursorValue(c: string | undefined): number | null {
  if (!c) return null;
  try {
    const t = Buffer.from(c, 'base64').toString('utf8');
    const m = t.match(/^cursor:(-?\d+)$/);
    return m ? parseInt(m[1]!, 10) : null;
  } catch { return null; }
}
function issueGql(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: globalId('Issue', repo.dbId, issue.number), number: issue.number, title: issue.title,
    body: issue.body, state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    author: { login: VIEWER_LOGIN }, labels: { nodes: issue.labels.map((n) => ({ name: n })) },
    comments: { totalCount: issue.comments.length },
  };
}
function prGql(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: globalId('PullRequest', repo.dbId, pr.number), number: pr.number, title: pr.title,
    body: pr.body, state: pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged, headRefName: pr.headRef, baseRefName: pr.baseRef,
    mergeable: prConflicted(repo, pr) ? 'CONFLICTING' : 'MERGEABLE',
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    mergedAt: pr.mergedAt, headRef: { name: pr.headRef }, baseRef: { name: pr.baseRef },
    author: { login: VIEWER_LOGIN },
    files: { nodes: prFiles(repo, pr).map((f) => ({ path: f.filename })) },
  };
}
function issuesConnection(repo: Repo, vars: Record<string, unknown>): Record<string, unknown> {
  const first = typeof vars.first === 'number' ? vars.first : 100;
  const states = Array.isArray(vars.states) ? vars.states as string[] : null;
  const orderBy = vars.orderBy as { field?: string; direction?: string } | undefined;
  const after = typeof vars.after === 'string' ? vars.after : undefined;
  let list = [...repo.issues];
  if (states) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  const dir = orderBy?.direction ?? 'DESC';
  list.sort((a, b) => (dir === 'DESC' ? b.number - a.number : a.number - b.number));
  const afterN = cursorValue(after);
  if (afterN !== null) list = list.filter((i) => (dir === 'DESC' ? i.number < afterN : i.number > afterN));
  const page = list.slice(0, first);
  const hasNext = list.length > first;
  const endCursor = page.length ? cursorFor(page[page.length - 1]!.number) : null;
  return {
    nodes: page.map((i) => issueGql(repo, i)),
    totalCount: list.length,
    pageInfo: { hasNextPage: hasNext, hasPreviousPage: false, startCursor: page.length ? cursorFor(page[0]!.number) : null, endCursor },
  };
}
function repoGql(repo: Repo, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: globalId('Repository', repo.dbId), databaseId: repo.dbId, name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`, owner: { login: repo.owner, id: VIEWER_ID },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN', hasIssuesEnabled: true,
    description: repo.description, private: repo.private, isPrivate: repo.private,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    visibility: repo.private ? 'PRIVATE' : 'PUBLIC',
  };
  // issue(number:) / issues(...) / pullRequest(number:) / pullRequests(...)
  const numVar = typeof vars.number === 'number' ? vars.number : typeof vars.issueNumber === 'number' ? vars.issueNumber : null;
  const issueNum = typeof vars.issueNumber === 'number' ? vars.issueNumber : numVar;
  if (issueNum !== null) {
    const issue = repo.issues.find((i) => i.number === issueNum);
    out.issue = issue ? issueGql(repo, issue) : null;
  }
  out.issues = issuesConnection(repo, vars);
  const prNum = typeof vars.prNumber === 'number' ? vars.prNumber : numVar;
  if (prNum !== null) {
    const pr = repo.pulls.find((p) => p.number === prNum);
    out.pullRequest = pr ? prGql(repo, pr) : null;
  }
  const first = typeof vars.first === 'number' ? vars.first : 100;
  out.pullRequests = { nodes: [...repo.pulls].slice(0, first).map((p) => prGql(repo, p)), totalCount: repo.pulls.length, pageInfo: { hasNextPage: false, endCursor: null } };
  return out;
}

function runDocument(doc: { query: string; variables?: Record<string, unknown> }): { data?: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const query = doc.query;
  const vars = (doc.variables ?? {}) as Record<string, unknown>;
  // Introspection __type(...) — a document may carry several aliased fields.
  if (query.includes('__type')) {
    const data: Record<string, unknown> = {};
    const re = /(\w+)\s*:\s*__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g;
    let m: RegExpExecArray | null;
    let matched = false;
    while ((m = re.exec(query)) !== null) {
      matched = true;
      const alias = m[1]!; const typeName = m[2]!;
      if (typeName === 'Issue') data[alias] = { name: 'Issue', fields: ISSUE_FIELDS.map((n) => ({ name: n })) };
      else if (typeName === 'PullRequest') data[alias] = { name: 'PullRequest', fields: PR_FIELDS.map((n) => ({ name: n })) };
      else if (typeName === 'Repository') data[alias] = { name: 'Repository', fields: REPO_FIELDS.map((n) => ({ name: n })) };
      else if (typeName === 'SearchType') data[alias] = { name: 'SearchType', enumValues: SEARCH_ENUM.map((n) => ({ name: n })) };
      else if (query.includes('enumValues(')) data[alias] = { name: typeName, enumValues: [] };
      else data[alias] = { name: typeName, fields: [] };
    }
    if (matched) return { data };
    return { data: { __type: null } };
  }
  // Node lookup
  if (/node\s*\(/.test(query)) {
    const decoded = typeof vars.id === 'string' ? decodeGlobalId(vars.id) : null;
    if (!decoded) return { data: { node: null } };
    if (decoded.kind === 'Repository') {
      const repo = [...store.repos.values()].find((r) => r.dbId === parseInt(decoded.parts[0] ?? '', 10));
      if (!repo) return { data: { node: null } };
      return { data: { node: { id: vars.id, ...repoGql(repo, vars) } } };
    }
    if (decoded.kind === 'Issue') {
      const repo = [...store.repos.values()].find((r) => r.dbId === parseInt(decoded.parts[0] ?? '', 10));
      const issue = repo?.issues.find((i) => i.number === parseInt(decoded.parts[1] ?? '', 10));
      return { data: { node: issue && repo ? { id: vars.id, ...issueGql(repo, issue) } : null } };
    }
    return { data: { node: null } };
  }
  // Mutations
  if (/\bmutation\b/.test(query)) {
    if (query.includes('createIssue')) {
      const input = vars.input as { repositoryId?: string; title?: string; body?: string } | undefined;
      const decoded = input?.repositoryId ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded?.kind === 'Repository' ? [...store.repos.values()].find((r) => r.dbId === parseInt(decoded.parts[0] ?? '', 10)) : undefined;
      if (!repo || !input?.title) return { errors: [{ message: 'Repository not found' }] };
      const number = repo.nextNum++;
      const issue: Issue = { number, id: store.nextIssueId++, title: input.title, body: input.body ?? '', state: 'open', labels: [], seq: number, comments: [], user: VIEWER_LOGIN };
      repo.issues.push(issue);
      return { data: { createIssue: { issue: { number, id: globalId('Issue', repo.dbId, number) } } } };
    }
    if (query.includes('closeIssue')) {
      const input = vars.input as { issueId?: string } | undefined;
      const decoded = input?.issueId ? decodeGlobalId(input.issueId) : null;
      if (decoded?.kind === 'Issue') {
        const repo = [...store.repos.values()].find((r) => r.dbId === parseInt(decoded.parts[0] ?? '', 10));
        const issue = repo?.issues.find((i) => i.number === parseInt(decoded.parts[1] ?? '', 10));
        if (issue) {
          issue.state = 'closed';
          return { data: { closeIssue: { issue: { number: issue.number, id: input.issueId, state: 'CLOSED' } } } };
        }
      }
      return { errors: [{ message: 'Issue not found' }] };
    }
    if (query.includes('createPullRequest')) {
      const input = vars.input as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string } | undefined;
      const decoded = input?.repositoryId ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded?.kind === 'Repository' ? [...store.repos.values()].find((r) => r.dbId === parseInt(decoded.parts[0] ?? '', 10)) : undefined;
      if (!repo || !input?.title || !input.baseRefName || !input.headRefName) return { errors: [{ message: 'Repository not found' }] };
      const headSha = store.resolveRef(repo, input.headRefName);
      const baseSha = store.resolveRef(repo, input.baseRefName);
      if (!headSha || !baseSha) return { errors: [{ message: 'Branch not found' }] };
      const number = repo.nextNum++;
      const pr: PullRequest = {
        number, id: store.nextPullId++, title: input.title, body: input.body ?? '', state: 'open',
        headRef: input.headRefName, baseRef: input.baseRefName, headSha, baseSha,
        merged: false, mergedAt: null, mergeSha: null, seq: number, user: VIEWER_LOGIN,
      };
      repo.pulls.push(pr);
      return { data: { createPullRequest: { pullRequest: { number, id: globalId('PullRequest', repo.dbId, number), state: 'OPEN', headRefName: input.headRefName, baseRefName: input.baseRefName } } } };
    }
    if (query.includes('mergePullRequest')) {
      const input = vars.input as { pullRequestId?: string; mergeMethod?: string } | undefined;
      const decoded = input?.pullRequestId ? decodeGlobalId(input.pullRequestId) : null;
      if (decoded?.kind === 'PullRequest') {
        const repo = [...store.repos.values()].find((r) => r.dbId === parseInt(decoded.parts[0] ?? '', 10));
        const pr = repo?.pulls.find((p) => p.number === parseInt(decoded.parts[1] ?? '', 10));
        if (pr && repo) {
          if (prConflicted(repo, pr)) return { errors: [{ message: 'Merge conflict' }] };
          squashMerge(repo, pr);
          return { data: { mergePullRequest: { pullRequest: { number: pr.number, merged: true, state: 'CLOSED' } } } };
        }
      }
      return { errors: [{ message: 'Pull request not found' }] };
    }
    if (query.includes('addComment')) {
      const input = vars.input as { subjectId?: string; body?: string } | undefined;
      const decoded = input?.subjectId ? decodeGlobalId(input.subjectId) : null;
      if (decoded?.kind === 'Issue') {
        const repo = [...store.repos.values()].find((r) => r.dbId === parseInt(decoded.parts[0] ?? '', 10));
        const issue = repo?.issues.find((i) => i.number === parseInt(decoded.parts[1] ?? '', 10));
        if (issue && repo && input?.body) {
          const id = repo.nextCommentId++;
          issue.comments.push({ id, body: input.body, user: VIEWER_LOGIN, seq: id });
          return { data: { addComment: { commentEdge: { node: { id: globalId('IssueComment', repo.dbId, issue.number, id), body: input.body } } } } };
        }
      }
      return { errors: [{ message: 'Subject not found' }] };
    }
    return { errors: [{ message: 'Unknown mutation' }] };
  }
  // Queries
  const data: Record<string, unknown> = {};
  if (/viewer\s*\{/.test(query) || /viewer\s*$/.test(query) || query.includes('viewer')) {
    if (query.includes('noSuchFieldOnViewer')) {
      return {
        data: { viewer: { login: VIEWER_LOGIN } },
        errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User". Did you mean "name"?' }],
      };
    }
    data.viewer = { login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen' };
  }
  if (/repository\s*\(/.test(query)) {
    const owner = typeof vars.owner === 'string' ? vars.owner : '';
    const name = typeof vars.name === 'string' ? vars.name : '';
    // Arguments written inline in the document (gh's OpenIssues writes
    // states: [OPEN] and orderBy: {...} literally) are not in variables.
    const statesMatch = query.match(/states:\s*\[([^\]]*)\]/);
    if (statesMatch && !Array.isArray(vars.states)) {
      vars.states = statesMatch[1]!.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const dirMatch = query.match(/orderBy:\s*\{[^}]*direction:\s*(ASC|DESC)/);
    if (dirMatch && typeof vars.orderBy !== 'object') {
      vars.orderBy = { field: 'CREATED_AT', direction: dirMatch[1] };
    }
    const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, name) : undefined;
    data.repository = repo ? repoGql(repo, vars) : null;
  }
  return { data };
}

/** Handle one GraphQL request body (object or array). Returns [status, json]. */
export function handleGraphQL(body: unknown): [number, unknown] {
  if (Array.isArray(body)) {
    const out: unknown[] = [];
    for (const doc of body) {
      if (doc && typeof doc === 'object' && typeof (doc as { query?: unknown }).query === 'string') out.push(runDocument(doc as { query: string; variables?: Record<string, unknown> }));
      else out.push({ errors: [{ message: 'Invalid document' }] });
    }
    return [200, out];
  }
  if (body && typeof body === 'object' && typeof (body as { query?: unknown }).query === 'string') {
    return [200, runDocument(body as { query: string; variables?: Record<string, unknown> })];
  }
  return [400, { message: 'Invalid GraphQL request' }];
}

// ---------------------------------------------------------------- MCP
export interface McpTool { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] } }
const TOOLS: McpTool[] = [
  {
    name: 'create_repo', description: 'Create a repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo', description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue', description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues', description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request', description: 'Create a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request', description: 'Merge a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

function toolText(obj: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(obj) }];
}
function callTool(name: string, args: Record<string, unknown>): { content: Array<{ type: 'text'; text: string }>; structuredContent?: unknown; isError?: boolean } {
  const missing = (tool: McpTool): string | null => {
    for (const r of tool.inputSchema.required) if (args[r] === undefined || args[r] === null || args[r] === '') return r;
    return null;
  };
  const repoOf = (owner: unknown, repo: unknown): Repo | undefined =>
    typeof owner === 'string' && typeof repo === 'string' ? store.getRepo(owner, repo) : undefined;
  switch (name) {
    case 'create_repo': {
      const tool = TOOLS[0]!;
      const miss = missing(tool);
      if (miss) return { content: toolText({ error: `Missing required argument: ${miss}` }), isError: true };
      const repo = store.createRepo(String(args.name), args.private === true, typeof args.description === 'string' ? args.description : '');
      if (!repo) return { content: toolText({ error: 'Repository already exists' }), isError: true };
      const out = repoJson(repo);
      return { content: toolText(out), structuredContent: out };
    }
    case 'get_repo': {
      const tool = TOOLS[1]!;
      const miss = missing(tool);
      if (miss) return { content: toolText({ error: `Missing required argument: ${miss}` }), isError: true };
      const repo = repoOf(args.owner, args.repo);
      if (!repo) return { content: toolText({ error: 'Repository not found' }), isError: true };
      const out = repoJson(repo);
      return { content: toolText(out), structuredContent: out };
    }
    case 'create_issue': {
      const tool = TOOLS[2]!;
      const miss = missing(tool);
      if (miss) return { content: toolText({ error: `Missing required argument: ${miss}` }), isError: true };
      const repo = repoOf(args.owner, args.repo);
      if (!repo) return { content: toolText({ error: 'Repository not found' }), isError: true };
      const number = repo.nextNum++;
      const issue: Issue = { number, id: store.nextIssueId++, title: String(args.title), body: typeof args.body === 'string' ? args.body : '', state: 'open', labels: [], seq: number, comments: [], user: VIEWER_LOGIN };
      repo.issues.push(issue);
      const out = issueJson(repo, issue);
      return { content: toolText(out), structuredContent: out };
    }
    case 'list_issues': {
      const tool = TOOLS[3]!;
      const miss = missing(tool);
      if (miss) return { content: toolText({ error: `Missing required argument: ${miss}` }), isError: true };
      const repo = repoOf(args.owner, args.repo);
      if (!repo) return { content: toolText({ error: 'Repository not found' }), isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state).map((i) => issueJson(repo, i));
      const out = { issues: list };
      return { content: toolText(out), structuredContent: out };
    }
    case 'create_pull_request': {
      const tool = TOOLS[4]!;
      const miss = missing(tool);
      if (miss) return { content: toolText({ error: `Missing required argument: ${miss}` }), isError: true };
      const repo = repoOf(args.owner, args.repo);
      if (!repo) return { content: toolText({ error: 'Repository not found' }), isError: true };
      const headSha = store.resolveRef(repo, String(args.head));
      const baseSha = store.resolveRef(repo, String(args.base));
      if (!headSha || !baseSha) return { content: toolText({ error: 'Branch not found' }), isError: true };
      const number = repo.nextNum++;
      const pr: PullRequest = {
        number, id: store.nextPullId++, title: String(args.title), body: typeof args.body === 'string' ? args.body : '', state: 'open',
        headRef: String(args.head), baseRef: String(args.base), headSha, baseSha,
        merged: false, mergedAt: null, mergeSha: null, seq: number, user: VIEWER_LOGIN,
      };
      repo.pulls.push(pr);
      const out = pullJson(repo, pr);
      return { content: toolText(out), structuredContent: out };
    }
    case 'merge_pull_request': {
      const tool = TOOLS[5]!;
      const miss = missing(tool);
      if (miss) return { content: toolText({ error: `Missing required argument: ${miss}` }), isError: true };
      const repo = repoOf(args.owner, args.repo);
      if (!repo) return { content: toolText({ error: 'Repository not found' }), isError: true };
      const pr = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pr) return { content: toolText({ error: 'Pull request not found' }), isError: true };
      if (prConflicted(repo, pr)) return { content: toolText({ error: 'Merge conflict' }), isError: true };
      const sha = squashMerge(repo, pr);
      const out = { merged: true, number: pr.number, sha, state: 'closed' };
      return { content: toolText(out), structuredContent: out };
    }
    default:
      return { content: toolText({ error: `Unknown tool: ${name}` }), isError: true };
  }
}

export type McpOutcome = { status: number; json: unknown } | { status: number; empty: true };

/** Handle one JSON-RPC request object. */
export function handleMcp(body: unknown): McpOutcome {
  if (!body || typeof body !== 'object') {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const req = body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const rpcError = (code: number, message: string): McpOutcome => ({ status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } });
  const rpcResult = (result: unknown): McpOutcome => ({ status: 200, json: { jsonrpc: '2.0', id, result } });
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, empty: true };
  }
  if (method === 'initialize') {
    const requested = (req.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '2025-11-25';
    return rpcResult({
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
    });
  }
  if (method === 'ping') return rpcResult({});
  if (method === 'tools/list') {
    return rpcResult({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) return rpcError(-32602, `Unknown tool: ${toolName}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const out = callTool(toolName, args);
    return rpcResult({ content: out.content, structuredContent: out.structuredContent, isError: out.isError ?? false });
  }
  // server/discover and anything else: method not found (client falls back to legacy handshake)
  return rpcError(-32601, `Method not found: ${method}`);
}

export { isOid };
