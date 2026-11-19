// main.go — server entry and request dispatch, mirroring the reference
// forge's createApp: /healthz, git smart HTTP, GraphQL, MCP, REST v3.

package main

import (
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
)

// requestIsReadOnly reports whether a request only reads the store, so it
// may run under the shared lock. GETs are reads; git-upload-pack fetches
// are reads (the pack is built from the object store and memoized); every
// other route may mutate the store.
func requestIsReadOnly(req *request) bool {
	if req.method == "GET" || req.method == "HEAD" {
		return true
	}
	if req.method != "POST" {
		return false
	}
	var segments []string
	for _, s := range strings.Split(req.path, "/") {
		if s == "" {
			continue
		}
		segments = append(segments, decodeSegment(s))
	}
	if len(segments) >= 2 && strings.HasSuffix(segments[1], ".git") {
		tail := segments[2:]
		if len(tail) >= 1 && tail[0] == "git-upload-pack" {
			return true
		}
	}
	return false
}

// dispatch routes one request and returns the response plus the request id
// to send ("" when the response carries no request id). The caller holds
// the store lock for the whole dispatch, so the single global mutex
// serializes all request handling.
func dispatch(req *request) (response, string) {
	// Segments: split the raw path on '/', drop empties, decode each one;
	// a segment that fails to decode is kept raw.
	var segments []string
	for _, s := range strings.Split(req.path, "/") {
		if s == "" {
			continue
		}
		segments = append(segments, decodeSegment(s))
	}
	// /healthz — exact raw-path match, GET only.
	if req.method == "GET" && req.path == "/healthz" {
		return jsonResp(200, map[string]any{"ok": true}, nil), nextReqID()
	}
	// Git smart HTTP: /{owner}/{repo}.git/...
	if len(segments) >= 2 && strings.HasSuffix(segments[1], ".git") {
		owner := segments[0]
		repoName := strings.TrimSuffix(segments[1], ".git")
		var repo *Repo
		if owner == viewerLogin {
			repo = store.getRepo(owner, repoName)
		}
		tail := segments[2:]
		if req.method == "GET" && len(tail) >= 2 && tail[0] == "info" && tail[1] == "refs" {
			service := parseQuery(req.query)["service"]
			status, contentType, body := handleInfoRefs(repo, service, req.headers["git-protocol"])
			return response{status: status, contentType: contentType, body: body}, nextReqID()
		}
		if req.method == "POST" && len(tail) >= 1 && tail[0] == "git-upload-pack" {
			status, contentType, body := handleUploadPack(repo, req.body, req.headers["git-protocol"])
			return response{status: status, contentType: contentType, body: body}, nextReqID()
		}
		if req.method == "POST" && len(tail) >= 1 && tail[0] == "git-receive-pack" {
			status, contentType, body := handleReceivePack(repo, req.body)
			return response{status: status, contentType: contentType, body: body}, nextReqID()
		}
		return errResp(404, "Not Found"), nextReqID()
	}
	// GraphQL
	if len(segments) == 2 && segments[0] == "api" && segments[1] == "graphql" {
		if req.method != "POST" {
			return errResp(405, "Method Not Allowed"), nextReqID()
		}
		if !authOK(req) {
			return errResp(401, "Requires authentication"), nextReqID()
		}
		// An empty body parses as {} here (readJsonBody semantics).
		var value any = map[string]any{}
		if len(req.body) > 0 {
			v, ok := parseJSONRaw(req.body)
			if !ok {
				return errResp(400, "Problems parsing JSON"), nextReqID()
			}
			value = v
		}
		status, body := handleGraphQL(value)
		return jsonResp(status, body, nil), nextReqID()
	}
	// MCP
	if len(segments) == 1 && segments[0] == "mcp" {
		if req.method == "DELETE" {
			return response{status: 204, noBody: true, noReqID: true}, ""
		}
		if req.method != "POST" {
			return errResp(405, "Method Not Allowed"), nextReqID()
		}
		if !authOK(req) {
			return errResp(401, "Requires authentication"), nextReqID()
		}
		value, ok := parseJSONRaw(req.body)
		if !ok {
			id := mcpParseErrorID(req.body)
			return jsonResp(400, map[string]any{
				"jsonrpc": "2.0", "id": id,
				"error": map[string]any{"code": -32700, "message": "Parse error"},
			}, nil), nextReqID()
		}
		out := handleMcp(value)
		if out.empty {
			return response{status: out.status, noBody: true, noReqID: true}, ""
		}
		return jsonResp(out.status, out.json, nil), nextReqID()
	}
	// REST v3
	if len(segments) >= 2 && segments[0] == "api" && segments[1] == "v3" {
		if !authOK(req) {
			return errResp(401, "Requires authentication"), nextReqID()
		}
		resp := handleRest(req, segments[2:])
		return resp, nextReqID()
	}
	return errResp(404, "Not Found"), nextReqID()
}

func main() {
	port := 0
	if len(os.Args) > 1 {
		if p, err := strconv.Atoi(os.Args[1]); err == nil {
			port = p
		}
	}
	if port == 0 {
		if p, err := strconv.Atoi(os.Getenv("FORGE_PORT")); err == nil {
			port = p
		}
	}
	if port == 0 {
		port = 18080
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		os.Stderr.WriteString("listen: " + err.Error() + "\n")
		os.Exit(1)
	}
	// Announce the bound port on stdout: main.ts reads it back to register
	// with the env. When port was 0 the kernel chose the port; report the
	// actual one.
	actualPort := ln.Addr().(*net.TCPAddr).Port
	os.Stdout.WriteString("listening on port " + strconv.Itoa(actualPort) + "\n")
	// One global read/write lock guards the store. Read-only requests
	// (GETs, info/refs, upload-pack fetches) share it; a mutating request
	// takes it exclusively.
	var mu sync.RWMutex
	for {
		conn, err := ln.Accept()
		if err != nil {
			continue
		}
		go func(c net.Conn) {
			serveConn(c, &mu)
		}(conn)
	}
}
