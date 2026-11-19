// mcp.go — MCP (POST /mcp): JSON-RPC 2.0 over the same store as REST.
// The six tools, their schemas, error strings and result shapes match the
// reference forge.

package main

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

type mcpTool struct {
	Name        string
	Description string
	Schema      map[string]any
	Required    []string
}

func toolSchema(props map[string]any, required []string) map[string]any {
	return map[string]any{"type": "object", "properties": props, "required": required}
}

func strProp(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

var mcpTools = []mcpTool{
	{
		Name: "create_repo", Description: "Create a repository owned by the authenticated user.",
		Schema: toolSchema(map[string]any{
			"name":        strProp("Repository name"),
			"description": strProp("Repository description"),
			"private":     map[string]any{"type": "boolean", "description": "Whether the repository is private"},
		}, []string{"name"}),
		Required: []string{"name"},
	},
	{
		Name: "get_repo", Description: "Get a repository by owner and name.",
		Schema: toolSchema(map[string]any{
			"owner": strProp("Repository owner login"),
			"repo":  strProp("Repository name"),
		}, []string{"owner", "repo"}),
		Required: []string{"owner", "repo"},
	},
	{
		Name: "create_issue", Description: "Create an issue in a repository.",
		Schema: toolSchema(map[string]any{
			"owner": strProp("Repository owner login"),
			"repo":  strProp("Repository name"),
			"title": strProp("Issue title"),
			"body":  strProp("Issue body"),
		}, []string{"owner", "repo", "title"}),
		Required: []string{"owner", "repo", "title"},
	},
	{
		Name: "list_issues", Description: "List issues in a repository.",
		Schema: toolSchema(map[string]any{
			"owner": strProp("Repository owner login"),
			"repo":  strProp("Repository name"),
			"state": strProp("Issue state: open, closed, or all"),
		}, []string{"owner", "repo"}),
		Required: []string{"owner", "repo"},
	},
	{
		Name: "create_pull_request", Description: "Create a pull request in a repository.",
		Schema: toolSchema(map[string]any{
			"owner": strProp("Repository owner login"),
			"repo":  strProp("Repository name"),
			"title": strProp("Pull request title"),
			"body":  strProp("Pull request body"),
			"head":  strProp("Head branch name"),
			"base":  strProp("Base branch name"),
		}, []string{"owner", "repo", "title", "head", "base"}),
		Required: []string{"owner", "repo", "title", "head", "base"},
	},
	{
		Name: "merge_pull_request", Description: "Merge a pull request in a repository.",
		Schema: toolSchema(map[string]any{
			"owner":       strProp("Repository owner login"),
			"repo":        strProp("Repository name"),
			"pull_number": map[string]any{"type": "integer", "description": "Pull request number"},
		}, []string{"owner", "repo", "pull_number"}),
		Required: []string{"owner", "repo", "pull_number"},
	},
}

// jsString renders a JSON value the way JavaScript's String() does.
func jsString(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return jsNumberString(t)
	case map[string]any, []any:
		return "[object Object]"
	default:
		return string(jsonBytes(v))
	}
}

// jsNumberString renders a float64 the way JavaScript's String(number) does.
func jsNumberString(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	if f == 0 {
		return "0"
	}
	af := math.Abs(f)
	if af >= 1e21 || af < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		i := strings.IndexByte(s, 'e')
		mant, exp := s[:i], s[i+1:]
		expInt, _ := strconv.Atoi(exp)
		sign := "+"
		if expInt < 0 {
			sign = "-"
			expInt = -expInt
		}
		return mant + "e" + sign + itoa(expInt)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// jsNumber coerces a JSON value the way JavaScript's Number() does.
func jsNumber(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case float64:
		return t
	case bool:
		if t {
			return 1
		}
		return 0
	case string:
		return jsParseNumber(t)
	default:
		return math.NaN()
	}
}

// jsParseNumber parses a string the way JavaScript's Number() does.
func jsParseNumber(s string) float64 {
	t := strings.Trim(s, " \t\n\v\f\r")
	if t == "" {
		return 0
	}
	if t == "Infinity" || t == "+Infinity" {
		return math.Inf(1)
	}
	if t == "-Infinity" {
		return math.Inf(-1)
	}
	// Hex literals: 0x...
	if len(t) >= 2 && t[0] == '0' && (t[1] == 'x' || t[1] == 'X') {
		rest := t[2:]
		if rest == "" {
			return math.NaN()
		}
		v, err := strconv.ParseInt(rest, 16, 64)
		if err != nil {
			return math.NaN()
		}
		return float64(v)
	}
	// Binary / octal literals.
	if len(t) >= 2 && t[0] == '0' && (t[1] == 'b' || t[1] == 'B') {
		v, err := strconv.ParseInt(t[2:], 2, 64)
		if err != nil {
			return math.NaN()
		}
		return float64(v)
	}
	if len(t) >= 2 && t[0] == '0' && (t[1] == 'o' || t[1] == 'O') {
		v, err := strconv.ParseInt(t[2:], 8, 64)
		if err != nil {
			return math.NaN()
		}
		return float64(v)
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

func toolText(obj any) []any {
	return []any{map[string]any{"type": "text", "text": string(jsonBytes(obj))}}
}

type toolResult struct {
	content           []any
	structuredContent any
	hasStructured     bool
	isError           bool
}

// callTool runs one MCP tool. Returns the result (content always set).
func callTool(name string, args map[string]any) toolResult {
	missing := func(tool mcpTool) string {
		for _, r := range tool.Required {
			v, ok := args[r]
			if !ok || v == nil || v == "" {
				return r
			}
		}
		return ""
	}
	repoOf := func(owner, repo any) *Repo {
		o, ok1 := owner.(string)
		r, ok2 := repo.(string)
		if !ok1 || !ok2 {
			return nil
		}
		return store.getRepo(o, r)
	}
	errResult := func(msg string) toolResult {
		return toolResult{content: toolText(map[string]any{"error": msg}), isError: true}
	}
	findTool := func(name string) *mcpTool {
		for i := range mcpTools {
			if mcpTools[i].Name == name {
				return &mcpTools[i]
			}
		}
		return nil
	}
	switch name {
	case "create_repo":
		tool := findTool(name)
		if miss := missing(*tool); miss != "" {
			return errResult("Missing required argument: " + miss)
		}
		priv, _ := args["private"].(bool)
		desc, _ := args["description"].(string)
		repo := store.createRepo(jsString(args["name"]), priv, desc)
		if repo == nil {
			return errResult("Repository already exists")
		}
		out := toRepoJSON(repo)
		return toolResult{content: toolText(out), structuredContent: out, hasStructured: true}
	case "get_repo":
		tool := findTool(name)
		if miss := missing(*tool); miss != "" {
			return errResult("Missing required argument: " + miss)
		}
		repo := repoOf(args["owner"], args["repo"])
		if repo == nil {
			return errResult("Repository not found")
		}
		out := toRepoJSON(repo)
		return toolResult{content: toolText(out), structuredContent: out, hasStructured: true}
	case "create_issue":
		tool := findTool(name)
		if miss := missing(*tool); miss != "" {
			return errResult("Missing required argument: " + miss)
		}
		repo := repoOf(args["owner"], args["repo"])
		if repo == nil {
			return errResult("Repository not found")
		}
		body, _ := args["body"].(string)
		number := repo.NextNum
		repo.NextNum++
		issue := &Issue{Number: number, ID: store.nextIssueID, Title: jsString(args["title"]), Body: body, State: "open", Labels: []string{}, Seq: number, User: viewerLogin}
		store.nextIssueID++
		repo.Issues = append(repo.Issues, issue)
		out := toIssueJSON(repo, issue)
		return toolResult{content: toolText(out), structuredContent: out, hasStructured: true}
	case "list_issues":
		tool := findTool(name)
		if miss := missing(*tool); miss != "" {
			return errResult("Missing required argument: " + miss)
		}
		repo := repoOf(args["owner"], args["repo"])
		if repo == nil {
			return errResult("Repository not found")
		}
		state, ok := args["state"].(string)
		if !ok {
			state = "open"
		}
		var list []any
		for _, i := range repo.Issues {
			if state == "all" || i.State == state {
				list = append(list, toIssueJSON(repo, i))
			}
		}
		if list == nil {
			list = []any{}
		}
		out := map[string]any{"issues": list}
		return toolResult{content: toolText(out), structuredContent: out, hasStructured: true}
	case "create_pull_request":
		tool := findTool(name)
		if miss := missing(*tool); miss != "" {
			return errResult("Missing required argument: " + miss)
		}
		repo := repoOf(args["owner"], args["repo"])
		if repo == nil {
			return errResult("Repository not found")
		}
		headSha, okH := repo.resolveRef(jsString(args["head"]))
		baseSha, okB := repo.resolveRef(jsString(args["base"]))
		if !okH || !okB {
			return errResult("Branch not found")
		}
		body, _ := args["body"].(string)
		number := repo.NextNum
		repo.NextNum++
		pr := &PullRequest{
			Number: number, ID: store.nextPullID, Title: jsString(args["title"]), Body: body, State: "open",
			HeadRef: jsString(args["head"]), BaseRef: jsString(args["base"]), HeadSha: headSha, BaseSha: baseSha,
			Seq: number, User: viewerLogin,
		}
		store.nextPullID++
		repo.Pulls = append(repo.Pulls, pr)
		out := toPullJSON(repo, pr)
		return toolResult{content: toolText(out), structuredContent: out, hasStructured: true}
	case "merge_pull_request":
		tool := findTool(name)
		if miss := missing(*tool); miss != "" {
			return errResult("Missing required argument: " + miss)
		}
		repo := repoOf(args["owner"], args["repo"])
		if repo == nil {
			return errResult("Repository not found")
		}
		numF := jsNumber(args["pull_number"])
		var pr *PullRequest
		if !math.IsNaN(numF) {
			for _, p := range repo.Pulls {
				if float64(p.Number) == numF {
					pr = p
					break
				}
			}
		}
		if pr == nil {
			return errResult("Pull request not found")
		}
		if prConflicted(repo, pr) {
			return errResult("Merge conflict")
		}
		sha := squashMerge(repo, pr)
		out := map[string]any{"merged": true, "number": pr.Number, "sha": sha, "state": "closed"}
		return toolResult{content: toolText(out), structuredContent: out, hasStructured: true}
	default:
		return errResult("Unknown tool: " + name)
	}
}

// mcpOutcome is what handleMcp returns: a status plus either a JSON body or
// an empty body (202 notifications / 204).
type mcpOutcome struct {
	status  int
	json    any
	hasJSON bool
	empty   bool
}

// handleMcp handles one JSON-RPC request object (already parsed).
func handleMcp(body any) mcpOutcome {
	if body == nil {
		return mcpOutcome{status: 400, json: map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "Parse error"}}, hasJSON: true}
	}
	m, ok := body.(map[string]any)
	if !ok {
		if _, isArr := body.([]any); !isArr {
			// A JSON scalar (number/string/bool): typeof is not 'object'.
			return mcpOutcome{status: 400, json: map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "Parse error"}}, hasJSON: true}
		}
		// An array: typeof is 'object' in JS, so it proceeds with method ''
		// and ends at method-not-found.
		return mcpOutcome{status: 200, json: map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32601, "message": "Method not found: "}}, hasJSON: true}
	}
	var id any
	if v, exists := m["id"]; exists {
		id = v
	}
	method, _ := m["method"].(string)
	rpcError := func(code int, message string) mcpOutcome {
		return mcpOutcome{status: 200, json: map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}}, hasJSON: true}
	}
	rpcResult := func(result any) mcpOutcome {
		return mcpOutcome{status: 200, json: map[string]any{"jsonrpc": "2.0", "id": id, "result": result}, hasJSON: true}
	}
	if method == "notifications/initialized" || strings.HasPrefix(method, "notifications/") {
		return mcpOutcome{status: 202, empty: true}
	}
	if method == "initialize" {
		var requested any = "2025-11-25"
		if params, ok := m["params"].(map[string]any); ok {
			if pv, exists := params["protocolVersion"]; exists && pv != nil {
				requested = pv
			}
		}
		return rpcResult(map[string]any{
			"protocolVersion": requested,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "github-core-clone", "version": "1.0.0"},
		})
	}
	if method == "ping" {
		return rpcResult(map[string]any{})
	}
	if method == "tools/list" {
		var tools []any
		for _, t := range mcpTools {
			tools = append(tools, map[string]any{"name": t.Name, "description": t.Description, "inputSchema": t.Schema})
		}
		return rpcResult(map[string]any{"tools": tools})
	}
	if method == "tools/call" {
		params, _ := m["params"].(map[string]any)
		if params == nil {
			params = map[string]any{}
		}
		toolName, _ := params["name"].(string)
		var found *mcpTool
		for i := range mcpTools {
			if mcpTools[i].Name == toolName {
				found = &mcpTools[i]
				break
			}
		}
		if found == nil {
			return rpcError(-32602, "Unknown tool: "+toolName)
		}
		args, _ := params["arguments"].(map[string]any)
		if args == nil {
			args = map[string]any{}
		}
		out := callTool(toolName, args)
		result := map[string]any{"content": out.content, "isError": out.isError}
		if out.hasStructured {
			result["structuredContent"] = out.structuredContent
		}
		return rpcResult(result)
	}
	return rpcError(-32601, "Method not found: "+method)
}

// mcpParseErrorID extracts the "id" number from a raw body that failed to
// parse, the way the reference does (regex over the raw text).
func mcpParseErrorID(raw []byte) any {
	m := regexp.MustCompile(`"id"\s*:\s*(\d+)`).FindSubmatch(raw)
	if m == nil {
		return nil
	}
	return jsParseInt(string(m[1]), 0)
}
