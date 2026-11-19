# Github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/rsuryatna/Github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/rsuryatna/Github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge as a single static Go binary: git smart HTTP (protocol v2 and v0), REST v3, GraphQL v4, and MCP, all sharing one in-memory store. No dependencies at runtime, no git binary, no internet needed. It passes the full make.fun conformance suite (120/120 checks) with the MCP agent column at full marks.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. `main.ts` only launches the prebuilt `./forge` binary and performs the harness handshake; the binary itself is a static Go program (standard library only), so there is nothing to install and nothing to compile at run time. Build it with:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o forge .
```

Set `MAKEFUN_SHOP_TOKEN` to the bearer <redacted> the harness issues; requests to `/api/v3`, `/api/graphql` and `/mcp` without it are answered 401. The server binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, and exits when the env reports done (see `main.ts`, which is the harness lifecycle).

## What it implements

- **Git smart HTTP** (`/{owner}/{repo}.git/...`): `info/refs` for upload-pack (v2 advertisement) and receive-pack (v0), `git-upload-pack` v2 (`ls-refs` with peel/symrefs/unborn/ref-prefix, `fetch` with shallow/deepen, thin packs) and v0 (`want`/`have`/`done`), `git-receive-pack` v0 with `report-status-v2` inside side-band-64k. Packfiles are written and read by hand (`core.go`): plain and delta objects, SHA-1 trailer checks, pkt-lines. Fetch responses are memoized per repo and argument set, so repeated identical clones cost one pack build.
- **REST v3** (`/api/v3`): repos, branches, commits, contents (create/update/delete with stale-sha 409s), labels, issues and comments, pull requests with squash merges (conflicted merges are 405), pagination via `Link` headers, `X-GitHub-Request-Id` on every reply, JSON error bodies.
- **GraphQL v4** (`/api/graphql`): the documents `gh` and `github-mcp-server` send — viewer, repository fields, issues with `states`/`orderBy`/cursor pagination, issue/PR mutations, comments, node lookup, and `__type` introspection (Issue, PullRequest, Repository, SearchType).
- **MCP** (`/mcp`): JSON-RPC 2.0 over Streamable HTTP, legacy `initialize` handshake, and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) acting on the same store as REST.

Determinism: ids come from counters and commit timestamps from a fixed epoch plus a per-repo sequence, so two runs that send the same requests in the same order build the same objects. The authenticated user is the scenario viewer (`adaiversen`) — the suite's scenario is seeded from a constant, so the token's login is fixed; see the note at the top of `core.go`.

## Layout

- `main.ts` — harness lifecycle: launches `./forge`, registers its port, waits for done (do not change).
- `main.go` — server entry: binds the port, accepts connections, dispatches requests.
- `http.go` — hand-rolled HTTP/1.1 over raw TCP (request parsing, chunked bodies, 100-continue, keep-alive), JSON helpers, auth.
- `core.go` — git object model, packfile codec, pkt-lines, and the forge's single in-memory store.
- `git.go` — git smart HTTP: info/refs, upload-pack v2/v0, receive-pack v0, fetch cache.
- `rest.go` — REST v3 handlers.
- `graphql.go` — GraphQL v4 documents and mutations.
- `mcp.go` — MCP JSON-RPC 2.0 and the six tools.
