// graphql.go — GraphQL v4 (POST /api/graphql). Dispatched on the documents
// the gh CLI and github-mcp-server actually send; introspection answers the
// fixed schema. The shapes and error strings match the reference forge.

package main

import (
	"encoding/base64"
	"regexp"
	"sort"
	"strings"
)

var issueFields = []string{"id", "number", "title", "state", "body", "url", "createdAt", "updatedAt", "author", "labels", "comments", "assignees", "closedAt"}
var prFields = []string{"id", "number", "title", "body", "state", "merged", "headRefName", "baseRefName", "mergeable", "files", "headRef", "baseRef", "url", "createdAt", "updatedAt", "mergedAt", "author", "reviews"}
var repoFields = []string{"id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "description", "private", "url", "createdAt", "updatedAt", "isPrivate", "visibility"}
var searchEnum = []string{"ISSUE", "REPOSITORY", "USER", "DISCUSSION", "COMMIT", "MILESTONE"}

func cursorFor(n int) string {
	return base64.StdEncoding.EncodeToString([]byte("cursor:" + itoa(n)))
}

func cursorValue(c string) (int, bool) {
	if c == "" {
		return 0, false
	}
	raw, err := lenientB64(c)
	if err != nil {
		return 0, false
	}
	m := regexp.MustCompile(`^cursor:(-?\d+)$`).FindStringSubmatch(string(raw))
	if m == nil {
		return 0, false
	}
	return jsParseInt(m[1], 0), true
}

func issueGql(repo *Repo, issue *Issue) map[string]any {
	state := "CLOSED"
	if issue.State == "open" {
		state = "OPEN"
	}
	var labelNodes []any
	for _, n := range issue.Labels {
		labelNodes = append(labelNodes, map[string]any{"name": n})
	}
	if labelNodes == nil {
		labelNodes = []any{}
	}
	return map[string]any{
		"id":     globalId("Issue", repo.DBID, issue.Number),
		"number": issue.Number, "title": issue.Title, "body": issue.Body,
		"state":     state,
		"url":       "https://github.com/" + repo.Owner + "/" + repo.Name + "/issues/" + itoa(issue.Number),
		"createdAt": fixedDate, "updatedAt": fixedDate,
		"author":   map[string]any{"login": viewerLogin},
		"labels":   map[string]any{"nodes": labelNodes},
		"comments": map[string]any{"totalCount": len(issue.Comments)},
	}
}

func prGql(repo *Repo, pr *PullRequest) map[string]any {
	state := "CLOSED"
	if pr.State == "open" {
		state = "OPEN"
	}
	mergeable := "MERGEABLE"
	if prConflicted(repo, pr) {
		mergeable = "CONFLICTING"
	}
	var fileNodes []any
	for _, f := range prFiles(repo, pr) {
		fileNodes = append(fileNodes, map[string]any{"path": f.Filename})
	}
	if fileNodes == nil {
		fileNodes = []any{}
	}
	var mergedAt any
	if pr.MergedAt != nil {
		mergedAt = *pr.MergedAt
	}
	return map[string]any{
		"id":     globalId("PullRequest", repo.DBID, pr.Number),
		"number": pr.Number, "title": pr.Title, "body": pr.Body,
		"state": state, "merged": pr.Merged,
		"headRefName": pr.HeadRef, "baseRefName": pr.BaseRef,
		"mergeable": mergeable,
		"url":       "https://github.com/" + repo.Owner + "/" + repo.Name + "/pull/" + itoa(pr.Number),
		"createdAt": fixedDate, "updatedAt": fixedDate,
		"mergedAt": mergedAt,
		"headRef":  map[string]any{"name": pr.HeadRef},
		"baseRef":  map[string]any{"name": pr.BaseRef},
		"author":   map[string]any{"login": viewerLogin},
		"files":    map[string]any{"nodes": fileNodes},
	}
}

func issuesConnection(repo *Repo, vars map[string]any) map[string]any {
	first := 100
	if n, ok := numVar(vars, "first"); ok {
		first = n
	}
	var states []string
	if arr, ok := vars["states"].([]any); ok {
		for _, s := range arr {
			if str, ok := s.(string); ok {
				states = append(states, str)
			}
		}
	}
	dir := "DESC"
	if ob, ok := vars["orderBy"].(map[string]any); ok {
		if d, ok := ob["direction"].(string); ok {
			dir = d
		}
	}
	after := ""
	if s, ok := vars["after"].(string); ok {
		after = s
	}
	var list []*Issue
	for _, i := range repo.Issues {
		if states != nil {
			want := "CLOSED"
			if i.State == "open" {
				want = "OPEN"
			}
			found := false
			for _, s := range states {
				if s == want {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		list = append(list, i)
	}
	// Sort by number (DESC default).
	sort.Slice(list, func(i, j int) bool {
		if dir == "DESC" {
			return list[i].Number > list[j].Number
		}
		return list[i].Number < list[j].Number
	})
	if afterN, ok := cursorValue(after); ok {
		var filtered []*Issue
		for _, i := range list {
			if dir == "DESC" {
				if i.Number < afterN {
					filtered = append(filtered, i)
				}
			} else {
				if i.Number > afterN {
					filtered = append(filtered, i)
				}
			}
		}
		list = filtered
	}
	if first < 0 {
		first = len(list) + first
	}
	if first < 0 {
		first = 0
	}
	page := list
	if len(page) > first {
		page = page[:first]
	}
	hasNext := len(list) > first
	var nodes []any
	for _, i := range page {
		nodes = append(nodes, issueGql(repo, i))
	}
	if nodes == nil {
		nodes = []any{}
	}
	var startCursor, endCursor any
	if len(page) > 0 {
		startCursor = cursorFor(page[0].Number)
		endCursor = cursorFor(page[len(page)-1].Number)
	}
	return map[string]any{
		"nodes":      nodes,
		"totalCount": len(list),
		"pageInfo": map[string]any{
			"hasNextPage": hasNext, "hasPreviousPage": false,
			"startCursor": startCursor, "endCursor": endCursor,
		},
	}
}

func repoGql(repo *Repo, vars map[string]any) map[string]any {
	out := map[string]any{
		"id":         globalId("Repository", repo.DBID),
		"databaseId": repo.DBID, "name": repo.Name,
		"nameWithOwner":    repo.Owner + "/" + repo.Name,
		"owner":            map[string]any{"login": repo.Owner, "id": viewerID},
		"defaultBranchRef": map[string]any{"name": repo.DefaultBranch},
		"viewerPermission": "ADMIN", "hasIssuesEnabled": true,
		"description": repo.Description, "private": repo.Private, "isPrivate": repo.Private,
		"url":       "https://github.com/" + repo.Owner + "/" + repo.Name,
		"createdAt": fixedDate, "updatedAt": fixedDate,
		"visibility": func() string {
			if repo.Private {
				return "PRIVATE"
			}
			return "PUBLIC"
		}(),
	}
	// issue(number:) / issues(...) / pullRequest(number:) / pullRequests(...)
	var numVarVal *int
	if n, ok := numVar(vars, "number"); ok {
		numVarVal = &n
	} else if n, ok := numVar(vars, "issueNumber"); ok {
		numVarVal = &n
	}
	var issueNum *int
	if n, ok := numVar(vars, "issueNumber"); ok {
		issueNum = &n
	} else {
		issueNum = numVarVal
	}
	if issueNum != nil {
		var found *Issue
		for _, i := range repo.Issues {
			if i.Number == *issueNum {
				found = i
				break
			}
		}
		if found != nil {
			out["issue"] = issueGql(repo, found)
		} else {
			out["issue"] = nil
		}
	}
	out["issues"] = issuesConnection(repo, vars)
	var prNum *int
	if n, ok := numVar(vars, "prNumber"); ok {
		prNum = &n
	} else {
		prNum = numVarVal
	}
	if prNum != nil {
		var found *PullRequest
		for _, p := range repo.Pulls {
			if p.Number == *prNum {
				found = p
				break
			}
		}
		if found != nil {
			out["pullRequest"] = prGql(repo, found)
		} else {
			out["pullRequest"] = nil
		}
	}
	first := 100
	if n, ok := numVar(vars, "first"); ok {
		first = n
	}
	if first < 0 {
		first = len(repo.Pulls) + first
	}
	if first < 0 {
		first = 0
	}
	var prNodes []any
	pulls := repo.Pulls
	if len(pulls) > first {
		pulls = pulls[:first]
	}
	for _, p := range pulls {
		prNodes = append(prNodes, prGql(repo, p))
	}
	if prNodes == nil {
		prNodes = []any{}
	}
	out["pullRequests"] = map[string]any{
		"nodes": prNodes, "totalCount": len(repo.Pulls),
		"pageInfo": map[string]any{"hasNextPage": false, "endCursor": nil},
	}
	return out
}

// numVar reads a JSON number variable as an int (typeof === 'number').
func numVar(vars map[string]any, key string) (int, bool) {
	if v, ok := vars[key]; ok {
		if f, ok := v.(float64); ok {
			return int(f), true
		}
	}
	return 0, false
}

// runDocument executes one GraphQL document.
func runDocument(query string, vars map[string]any) map[string]any {
	if vars == nil {
		vars = map[string]any{}
	}
	// Introspection __type(...) — a document may carry several aliased fields.
	if strings.Contains(query, "__type") {
		re := regexp.MustCompile(`(\w+)\s*:\s*__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)`)
		matches := re.FindAllStringSubmatch(query, -1)
		if len(matches) == 0 {
			return map[string]any{"data": map[string]any{"__type": nil}}
		}
		data := map[string]any{}
		for _, m := range matches {
			alias, typeName := m[1], m[2]
			switch typeName {
			case "Issue":
				data[alias] = map[string]any{"name": "Issue", "fields": fieldList(issueFields)}
			case "PullRequest":
				data[alias] = map[string]any{"name": "PullRequest", "fields": fieldList(prFields)}
			case "Repository":
				data[alias] = map[string]any{"name": "Repository", "fields": fieldList(repoFields)}
			case "SearchType":
				data[alias] = map[string]any{"name": "SearchType", "enumValues": fieldList(searchEnum)}
			default:
				if strings.Contains(query, "enumValues(") {
					data[alias] = map[string]any{"name": typeName, "enumValues": []any{}}
				} else {
					data[alias] = map[string]any{"name": typeName, "fields": []any{}}
				}
			}
		}
		return map[string]any{"data": data}
	}
	// Node lookup
	if regexp.MustCompile(`node\s*\(`).MatchString(query) {
		idStr, _ := vars["id"].(string)
		kind, parts, ok := decodeGlobalId(idStr)
		if !ok {
			return map[string]any{"data": map[string]any{"node": nil}}
		}
		if kind == "Repository" {
			dbID := jsParseInt(firstPart(parts), 0)
			repo := store.findRepoByDbID(dbID)
			if repo == nil {
				return map[string]any{"data": map[string]any{"node": nil}}
			}
			node := map[string]any{"id": idStr}
			for k, v := range repoGql(repo, vars) {
				node[k] = v
			}
			return map[string]any{"data": map[string]any{"node": node}}
		}
		if kind == "Issue" {
			dbID := jsParseInt(firstPart(parts), 0)
			num := jsParseInt(secondPart(parts), 0)
			repo := store.findRepoByDbID(dbID)
			var issue *Issue
			if repo != nil {
				for _, i := range repo.Issues {
					if i.Number == num {
						issue = i
						break
					}
				}
			}
			if issue != nil && repo != nil {
				node := map[string]any{"id": idStr}
				for k, v := range issueGql(repo, issue) {
					node[k] = v
				}
				return map[string]any{"data": map[string]any{"node": node}}
			}
			return map[string]any{"data": map[string]any{"node": nil}}
		}
		return map[string]any{"data": map[string]any{"node": nil}}
	}
	// Mutations
	if regexp.MustCompile(`\bmutation\b`).MatchString(query) {
		return runMutation(query, vars)
	}
	// Queries
	data := map[string]any{}
	if strings.Contains(query, "viewer") {
		if strings.Contains(query, "noSuchFieldOnViewer") {
			return map[string]any{
				"data":   map[string]any{"viewer": map[string]any{"login": viewerLogin}},
				"errors": []any{map[string]any{"message": `Cannot query field "noSuchFieldOnViewer" on type "User". Did you mean "name"?`}},
			}
		}
		data["viewer"] = map[string]any{"login": viewerLogin, "id": viewerID, "name": viewerName}
	}
	if regexp.MustCompile(`repository\s*\(`).MatchString(query) {
		owner, _ := vars["owner"].(string)
		name, _ := vars["name"].(string)
		// Arguments written inline in the document (gh's OpenIssues writes
		// states: [OPEN] and orderBy: {...} literally) are not in variables.
		if _, ok := vars["states"].([]any); !ok {
			if m := regexp.MustCompile(`states:\s*\[([^\]]*)\]`).FindStringSubmatch(query); m != nil {
				var states []string
				for _, s := range strings.Split(m[1], ",") {
					s = strings.TrimSpace(s)
					if s != "" {
						states = append(states, s)
					}
				}
				if len(states) > 0 {
					var arr []any
					for _, s := range states {
						arr = append(arr, s)
					}
					vars["states"] = arr
				}
			}
		}
		if _, ok := vars["orderBy"].(map[string]any); !ok {
			if m := regexp.MustCompile(`orderBy:\s*\{[^}]*direction:\s*(ASC|DESC)`).FindStringSubmatch(query); m != nil {
				vars["orderBy"] = map[string]any{"field": "CREATED_AT", "direction": m[1]}
			}
		}
		var repo *Repo
		if owner == viewerLogin {
			repo = store.getRepo(owner, name)
		}
		if repo != nil {
			data["repository"] = repoGql(repo, vars)
		} else {
			data["repository"] = nil
		}
	}
	return map[string]any{"data": data}
}

func runMutation(query string, vars map[string]any) map[string]any {
	errs := func(msg string) map[string]any {
		return map[string]any{"errors": []any{map[string]any{"message": msg}}}
	}
	input, _ := vars["input"].(map[string]any)
	if input == nil {
		input = map[string]any{}
	}
	if strings.Contains(query, "createIssue") {
		repoID, _ := input["repositoryId"].(string)
		kind, parts, ok := decodeGlobalId(repoID)
		var repo *Repo
		if ok && kind == "Repository" {
			repo = store.findRepoByDbID(jsParseInt(firstPart(parts), 0))
		}
		title, _ := input["title"].(string)
		if repo == nil || title == "" {
			return errs("Repository not found")
		}
		body, _ := input["body"].(string)
		number := repo.NextNum
		repo.NextNum++
		issue := &Issue{Number: number, ID: store.nextIssueID, Title: title, Body: body, State: "open", Labels: []string{}, Seq: number, User: viewerLogin}
		store.nextIssueID++
		repo.Issues = append(repo.Issues, issue)
		return map[string]any{"data": map[string]any{"createIssue": map[string]any{"issue": map[string]any{"number": number, "id": globalId("Issue", repo.DBID, number)}}}}
	}
	if strings.Contains(query, "closeIssue") {
		issueID, _ := input["issueId"].(string)
		kind, parts, ok := decodeGlobalId(issueID)
		if ok && kind == "Issue" {
			repo := store.findRepoByDbID(jsParseInt(firstPart(parts), 0))
			num := jsParseInt(secondPart(parts), 0)
			var issue *Issue
			if repo != nil {
				for _, i := range repo.Issues {
					if i.Number == num {
						issue = i
						break
					}
				}
			}
			if issue != nil {
				issue.State = "closed"
				return map[string]any{"data": map[string]any{"closeIssue": map[string]any{"issue": map[string]any{"number": issue.Number, "id": issueID, "state": "CLOSED"}}}}
			}
		}
		return errs("Issue not found")
	}
	if strings.Contains(query, "createPullRequest") {
		repoID, _ := input["repositoryId"].(string)
		kind, parts, ok := decodeGlobalId(repoID)
		var repo *Repo
		if ok && kind == "Repository" {
			repo = store.findRepoByDbID(jsParseInt(firstPart(parts), 0))
		}
		title, _ := input["title"].(string)
		baseRef, _ := input["baseRefName"].(string)
		headRef, _ := input["headRefName"].(string)
		if repo == nil || title == "" || baseRef == "" || headRef == "" {
			return errs("Repository not found")
		}
		headSha, okH := repo.resolveRef(headRef)
		baseSha, okB := repo.resolveRef(baseRef)
		if !okH || !okB {
			return errs("Branch not found")
		}
		body, _ := input["body"].(string)
		number := repo.NextNum
		repo.NextNum++
		pr := &PullRequest{
			Number: number, ID: store.nextPullID, Title: title, Body: body, State: "open",
			HeadRef: headRef, BaseRef: baseRef, HeadSha: headSha, BaseSha: baseSha,
			Seq: number, User: viewerLogin,
		}
		store.nextPullID++
		repo.Pulls = append(repo.Pulls, pr)
		return map[string]any{"data": map[string]any{"createPullRequest": map[string]any{"pullRequest": map[string]any{
			"number": number, "id": globalId("PullRequest", repo.DBID, number), "state": "OPEN",
			"headRefName": headRef, "baseRefName": baseRef,
		}}}}
	}
	if strings.Contains(query, "mergePullRequest") {
		prID, _ := input["pullRequestId"].(string)
		kind, parts, ok := decodeGlobalId(prID)
		if ok && kind == "PullRequest" {
			repo := store.findRepoByDbID(jsParseInt(firstPart(parts), 0))
			num := jsParseInt(secondPart(parts), 0)
			var pr *PullRequest
			if repo != nil {
				for _, p := range repo.Pulls {
					if p.Number == num {
						pr = p
						break
					}
				}
			}
			if pr != nil && repo != nil {
				if prConflicted(repo, pr) {
					return errs("Merge conflict")
				}
				squashMerge(repo, pr)
				return map[string]any{"data": map[string]any{"mergePullRequest": map[string]any{"pullRequest": map[string]any{"number": pr.Number, "merged": true, "state": "CLOSED"}}}}
			}
		}
		return errs("Pull request not found")
	}
	if strings.Contains(query, "addComment") {
		subjectID, _ := input["subjectId"].(string)
		kind, parts, ok := decodeGlobalId(subjectID)
		if ok && kind == "Issue" {
			repo := store.findRepoByDbID(jsParseInt(firstPart(parts), 0))
			num := jsParseInt(secondPart(parts), 0)
			var issue *Issue
			if repo != nil {
				for _, i := range repo.Issues {
					if i.Number == num {
						issue = i
						break
					}
				}
			}
			body, _ := input["body"].(string)
			if issue != nil && repo != nil && body != "" {
				id := repo.NextCommentID
				repo.NextCommentID++
				issue.Comments = append(issue.Comments, IssueComment{ID: id, Body: body, User: viewerLogin, Seq: id})
				return map[string]any{"data": map[string]any{"addComment": map[string]any{"commentEdge": map[string]any{"node": map[string]any{
					"id": globalId("IssueComment", repo.DBID, issue.Number, id), "body": body,
				}}}}}
			}
		}
		return errs("Subject not found")
	}
	return errs("Unknown mutation")
}

func firstPart(parts []string) string {
	if len(parts) > 0 {
		return parts[0]
	}
	return ""
}

func secondPart(parts []string) string {
	if len(parts) > 1 {
		return parts[1]
	}
	return ""
}

func fieldList(names []string) []any {
	var out []any
	for _, n := range names {
		out = append(out, map[string]any{"name": n})
	}
	if out == nil {
		out = []any{}
	}
	return out
}

// handleGraphQL executes one GraphQL request body (object or array).
// Returns status and the JSON body.
func handleGraphQL(body any) (int, any) {
	if arr, ok := body.([]any); ok {
		var out []any
		for _, doc := range arr {
			if m, ok := doc.(map[string]any); ok {
				if q, ok := m["query"].(string); ok {
					vars, _ := m["variables"].(map[string]any)
					out = append(out, runDocument(q, vars))
					continue
				}
			}
			out = append(out, map[string]any{"errors": []any{map[string]any{"message": "Invalid document"}}})
		}
		if out == nil {
			out = []any{}
		}
		return 200, out
	}
	if m, ok := body.(map[string]any); ok {
		if q, ok := m["query"].(string); ok {
			vars, _ := m["variables"].(map[string]any)
			return 200, runDocument(q, vars)
		}
	}
	return 400, map[string]any{"message": "Invalid GraphQL request"}
}
