// rest.go — REST v3 handlers (/api/v3). The routes, statuses, error
// bodies and JSON shapes match the reference forge exactly.

package main

import (
	"encoding/base64"
	"sort"
	"strconv"
	"strings"
)

// paginate slices items to the requested page and builds the Link header.
func paginate(req *request, items []any) ([]any, string) {
	q := parseQuery(req.query)
	perPage := jsParseInt(q["per_page"], 30)
	if perPage < 1 {
		perPage = 1
	}
	if perPage > 100 {
		perPage = 100
	}
	page := jsParseInt(q["page"], 1)
	if page < 1 {
		page = 1
	}
	totalPages := (len(items) + perPage - 1) / perPage
	if totalPages < 1 {
		totalPages = 1
	}
	start := (page - 1) * perPage
	if start > len(items) {
		start = len(items)
	}
	end := start + perPage
	if end > len(items) {
		end = len(items)
	}
	return items[start:end], paginationLink(req, totalPages)
}

func paginationLink(req *request, totalPages int) string {
	q := parseQuery(req.query)
	page := jsParseInt(q["page"], 1)
	if page < 1 {
		page = 1
	}
	perPage := jsParseInt(q["per_page"], 30)
	if perPage < 1 {
		perPage = 1
	}
	host := req.headers["host"]
	if host == "" {
		host = "localhost"
	}
	base := "http://" + host + req.path
	link := func(p int, rel string) string {
		return "<" + base + "?" + linkQuery(req.query, p, perPage) + ">; rel=\"" + rel + "\""
	}
	var links []string
	if page < totalPages {
		links = append(links, link(page+1, "next"))
	}
	if page > 1 {
		links = append(links, link(page-1, "prev"))
	}
	links = append(links, link(1, "first"))
	last := totalPages
	if last < 1 {
		last = 1
	}
	links = append(links, link(last, "last"))
	return strings.Join(links, ", ")
}

// linkQuery rebuilds a query string the way `new URLSearchParams({...obj,
// page, per_page}).toString()` does: keys keep their first-occurrence order
// (a repeated key keeps its last value), page/per_page are updated in place
// if present and appended otherwise, and values use form-urlencoded
// serialization (space -> '+', everything else percent-encoded).
func linkQuery(rawQuery string, page, perPage int) string {
	type kv struct{ k, v string }
	var pairs []kv
	index := map[string]int{}
	for _, pair := range strings.Split(rawQuery, "&") {
		if pair == "" {
			continue
		}
		k, v, _ := strings.Cut(pair, "=")
		k = percentDecode(k)
		v = percentDecode(v)
		if i, ok := index[k]; ok {
			pairs[i].v = v
		} else {
			index[k] = len(pairs)
			pairs = append(pairs, kv{k, v})
		}
	}
	set := func(key, val string) {
		if i, ok := index[key]; ok {
			pairs[i].v = val
		} else {
			index[key] = len(pairs)
			pairs = append(pairs, kv{key, val})
		}
	}
	set("page", itoa(page))
	set("per_page", itoa(perPage))
	var parts []string
	for _, p := range pairs {
		parts = append(parts, formEncode(p.k)+"="+formEncode(p.v))
	}
	return strings.Join(parts, "&")
}

// formEncode is the WHATWG form-urlencoded serializer: alphanumerics and
// *-._ stay, space becomes '+', everything else becomes %XX.
func formEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '*' {
			b.WriteByte(c)
		} else if c == ' ' {
			b.WriteByte('+')
		} else {
			const hex = "0123456789ABCDEF"
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		}
	}
	return b.String()
}

func branchTip(r *Repo, branch string) (string, bool) {
	return r.refTip("refs/heads/" + branch)
}

func snapshotBytes(r *Repo, tip string) map[string][]byte {
	out := map[string][]byte{}
	if tip == "" {
		return out
	}
	for path, oid := range filesAt(r, tip) {
		if b := blobBytes(r, oid); b != nil {
			out[path] = b
		}
	}
	return out
}

func createIssueIn(r *Repo, title, body string, labels []string) *Issue {
	number := r.NextNum
	r.NextNum++
	issue := &Issue{Number: number, ID: store.nextIssueID, Title: title, Body: body, State: "open", Labels: labels, Seq: number, User: viewerLogin}
	store.nextIssueID++
	r.Issues = append(r.Issues, issue)
	return issue
}

// lenientB64 decodes base64 the way Node's Buffer.from(str, 'base64') does:
// characters outside the alphabet are ignored.
func lenientB64(s string) ([]byte, error) {
	var clean strings.Builder
	for _, c := range s {
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '=' {
			clean.WriteRune(c)
		}
	}
	t := clean.String()
	// Pad to a multiple of 4.
	if m := len(t) % 4; m != 0 {
		t += strings.Repeat("=", 4-m)
	}
	return base64.StdEncoding.DecodeString(t)
}

// handleRest serves /api/v3/...; segments are the path parts after /api/v3.
func handleRest(req *request, segments []string) response {
	method := req.method
	if len(segments) == 0 {
		if method == "GET" {
			return jsonResp(200, map[string]any{
				"current_user_url": "/api/v3/user",
				"repository_url":   "/api/v3/repos/{owner}/{repo}",
			}, map[string]string{"x-oauth-scopes": "repo, read:org"})
		}
		return errResp(405, "Method Not Allowed")
	}
	if len(segments) == 1 && segments[0] == "meta" {
		if method == "GET" {
			return jsonResp(200, map[string]any{"installed_version": "1.0.0"}, nil)
		}
		return errResp(405, "Method Not Allowed")
	}
	if len(segments) == 1 && segments[0] == "rate_limit" {
		return jsonResp(200, map[string]any{
			"resources": map[string]any{
				"core": map[string]any{"limit": 5000, "remaining": 4999, "reset": 0},
			},
		}, nil)
	}
	if len(segments) == 1 && segments[0] == "user" {
		if method == "GET" {
			return jsonResp(200, map[string]any{
				"login": viewerLogin, "id": viewerID, "name": viewerName, "email": viewerEmail,
				"type": "User", "html_url": "https://github.com/" + viewerLogin,
			}, nil)
		}
		return errResp(405, "Method Not Allowed")
	}
	if len(segments) == 2 && segments[0] == "user" && segments[1] == "repos" {
		if method == "POST" {
			body, ok := readJSONBody(req.body)
			if !ok {
				return errResp(400, "Problems parsing JSON")
			}
			name := strings.TrimSpace(jsonGetString(body, "name"))
			if name == "" {
				return errResp(422, "name is required")
			}
			repo := store.createRepo(name, jsonGetBool(body, "private"), jsonGetString(body, "description"))
			if repo == nil {
				return errResp(422, "name already exists on this account")
			}
			return jsonResp(201, toRepoJSON(repo), nil)
		}
		if method == "GET" {
			var items []any
			for _, r := range store.listRepos(viewerLogin) {
				items = append(items, toRepoJSON(r))
			}
			page, link := paginate(req, items)
			return jsonResp(200, page, map[string]string{"link": link})
		}
		return errResp(405, "Method Not Allowed")
	}
	// /api/v3/repos/{owner}/{repo}[...]
	if len(segments) < 3 || segments[0] != "repos" {
		return errResp(404, "Not Found")
	}
	owner := segments[1]
	repoName := segments[2]
	rest := segments[3:]
	var repo *Repo
	if owner == viewerLogin {
		repo = store.getRepo(owner, repoName)
	}
	// Repo object itself
	if len(rest) == 0 {
		if repo == nil {
			return errResp(404, "Not Found")
		}
		if method == "GET" {
			return jsonResp(200, toRepoJSON(repo), nil)
		}
		if method == "PATCH" {
			body, ok := readJSONBody(req.body)
			if !ok {
				return errResp(400, "Problems parsing JSON")
			}
			if v, exists := body["description"]; exists {
				if s, ok := v.(string); ok {
					repo.Description = s
				}
			}
			if v, exists := body["private"]; exists {
				if b, ok := v.(bool); ok {
					repo.Private = b
				}
			}
			return jsonResp(200, toRepoJSON(repo), nil)
		}
		if method == "DELETE" {
			store.deleteRepo(owner, repoName)
			return response{status: 204, noBody: true}
		}
		return errResp(405, "Method Not Allowed")
	}
	if repo == nil {
		return errResp(404, "Not Found")
	}
	sub := rest[0]
	// ---- git refs
	if sub == "git" && len(rest) > 1 && rest[1] == "refs" {
		if method == "POST" && len(rest) == 2 {
			body, ok := readJSONBody(req.body)
			if !ok {
				return errResp(400, "Problems parsing JSON")
			}
			ref := jsonGetString(body, "ref")
			sha := jsonGetString(body, "sha")
			if !strings.HasPrefix(ref, "refs/") || !isOID(sha) {
				return errResp(422, "Invalid ref or sha")
			}
			if _, exists := repo.objects[sha]; !exists {
				return errResp(422, "Invalid ref or sha")
			}
			repo.setRef(ref, sha)
			typ := "commit"
			if o := repo.objects[sha]; o != nil {
				typ = string(o.Type)
			}
			return jsonResp(201, map[string]any{
				"ref":    ref,
				"object": map[string]any{"sha": sha, "type": typ},
				"url":    "/api/v3/repos/" + owner + "/" + repoName + "/git/refs/" + strings.TrimPrefix(ref, "refs/"),
			}, nil)
		}
		if method == "GET" {
			refPath := strings.Join(rest[2:], "/")
			if refPath == "" {
				var all []any
				for _, name := range repo.refOrder {
					sha := repo.refs[name]
					typ := "commit"
					if o := repo.objects[sha]; o != nil {
						typ = string(o.Type)
					}
					all = append(all, map[string]any{"ref": name, "object": map[string]any{"sha": sha, "type": typ}})
				}
				if all == nil {
					all = []any{}
				}
				return jsonResp(200, all, nil)
			}
			fullRef := "refs/" + refPath
			sha, ok := repo.refTip(fullRef)
			if !ok {
				return errResp(404, "Not Found")
			}
			typ := "commit"
			if o := repo.objects[sha]; o != nil {
				typ = string(o.Type)
			}
			return jsonResp(200, map[string]any{
				"ref":    fullRef,
				"object": map[string]any{"sha": sha, "type": typ},
				"url":    "/api/v3/repos/" + owner + "/" + repoName + "/git/refs/" + refPath,
			}, nil)
		}
		return errResp(405, "Method Not Allowed")
	}
	// ---- branches
	if sub == "branches" {
		if len(rest) == 1 && method == "GET" {
			var list []any
			for _, name := range repo.refOrder {
				if !strings.HasPrefix(name, "refs/heads/") {
					continue
				}
				sha := repo.refs[name]
				list = append(list, map[string]any{
					"name":      strings.TrimPrefix(name, "refs/heads/"),
					"commit":    map[string]any{"sha": sha},
					"protected": false,
				})
			}
			if list == nil {
				list = []any{}
			}
			return jsonResp(200, list, nil)
		}
		if len(rest) == 2 && method == "GET" {
			branch, err := percentDecodeStrict(rest[1])
			if err != nil {
				return response{status: 500, contentType: "application/json", body: jsonBytes(map[string]any{"message": "Internal error"})}
			}
			sha, ok := branchTip(repo, branch)
			if !ok {
				return errResp(404, "Branch not found")
			}
			return jsonResp(200, map[string]any{
				"name":      branch,
				"commit":    map[string]any{"sha": sha},
				"protected": false,
			}, nil)
		}
		return errResp(404, "Not Found")
	}
	// ---- commits
	if sub == "commits" {
		if method == "GET" && len(rest) == 1 {
			q := parseQuery(req.query)
			shaParam := q["sha"]
			var tip string
			var hasTip bool
			if shaParam != "" {
				if oid, ok := repo.resolveRef(shaParam); ok {
					tip, hasTip = oid, true
				} else if isOID(shaParam) {
					if _, ok := repo.objects[shaParam]; ok {
						tip, hasTip = shaParam, true
					}
				}
			} else {
				tip, hasTip = branchTip(repo, repo.DefaultBranch)
			}
			if !hasTip {
				return jsonResp(200, []any{}, nil)
			}
			var list []any
			queue := []string{tip}
			seen := map[string]bool{}
			for len(queue) > 0 {
				oid := queue[0]
				queue = queue[1:]
				if seen[oid] {
					continue
				}
				seen[oid] = true
				obj := repo.objects[oid]
				if obj == nil || obj.Type != objCommit {
					continue
				}
				c := parseCommit(obj.Data)
				list = append(list, map[string]any{
					"sha": oid,
					"commit": map[string]any{
						"message": strings.TrimSpace(c.Message),
						"author": map[string]any{
							"name": viewerName, "email": viewerEmail, "date": fixedDate,
						},
						"committer": map[string]any{
							"name": viewerName, "email": viewerEmail, "date": fixedDate,
						},
					},
					"parents": func() []any {
						var ps []any
						for _, p := range c.Parents {
							ps = append(ps, map[string]any{"sha": p})
						}
						if ps == nil {
							ps = []any{}
						}
						return ps
					}(),
				})
				queue = append(queue, c.Parents...)
			}
			if list == nil {
				list = []any{}
			}
			page, link := paginate(req, list)
			return jsonResp(200, page, map[string]string{"link": link})
		}
		return errResp(404, "Not Found")
	}
	// ---- contents
	if sub == "contents" {
		pathParts := rest[1:]
		// The reference decodes each segment a second time here.
		decoded := make([]string, len(pathParts))
		for i, s := range pathParts {
			d, err := percentDecodeStrict(s)
			if err != nil {
				return response{status: 500, contentType: "application/json", body: jsonBytes(map[string]any{"message": "Internal error"})}
			}
			decoded[i] = d
		}
		path := strings.Join(decoded, "/")
		q := parseQuery(req.query)
		refParam := q["ref"]
		var tip string
		var hasTip bool
		if refParam != "" {
			tip, hasTip = repo.resolveRef(refParam)
		} else {
			tip, hasTip = branchTip(repo, repo.DefaultBranch)
		}
		if method == "GET" {
			files := filesAt(repo, tip)
			if !hasTip {
				return errResp(404, "Not Found")
			}
			if oid, ok := files[path]; ok {
				data := blobBytes(repo, oid)
				if data == nil {
					data = []byte{}
				}
				name := path
				if i := strings.LastIndex(path, "/"); i >= 0 {
					name = path[i+1:]
				}
				return jsonResp(200, map[string]any{
					"type": "file", "encoding": "base64", "size": len(data),
					"name": name, "path": path,
					"content": base64.StdEncoding.EncodeToString(data), "sha": oid,
				}, nil)
			}
			// Directory listing.
			prefix := ""
			if path != "" {
				prefix = path + "/"
			}
			var entries []any
			seenDirs := map[string]bool{}
			for p, oid := range files {
				if !strings.HasPrefix(p, prefix) {
					continue
				}
				restPath := p[len(prefix):]
				if i := strings.IndexByte(restPath, '/'); i == -1 {
					size := 0
					if b := blobBytes(repo, oid); b != nil {
						size = len(b)
					}
					entries = append(entries, map[string]any{"type": "file", "name": restPath, "path": p, "sha": oid, "size": size})
				} else {
					dir := restPath[:i]
					if !seenDirs[dir] {
						seenDirs[dir] = true
						entries = append(entries, map[string]any{"type": "dir", "name": dir, "path": prefix + dir, "sha": ""})
					}
				}
			}
			if len(entries) == 0 {
				return errResp(404, "Not Found")
			}
			sort.Slice(entries, func(i, j int) bool {
				return localeCompareASCII(entries[i].(map[string]any)["name"].(string), entries[j].(map[string]any)["name"].(string)) < 0
			})
			return jsonResp(200, entries, nil)
		}
		if method == "PUT" {
			body, ok := readJSONBody(req.body)
			if !ok {
				return errResp(400, "Problems parsing JSON")
			}
			contentB64 := jsonGetString(body, "content")
			message := jsonGetString(body, "message")
			if message == "" {
				message = "Update"
			}
			branch := jsonGetString(body, "branch")
			if branch == "" {
				branch = repo.DefaultBranch
			}
			shaField := ""
			if v, exists := body["sha"]; exists {
				if s, ok := v.(string); ok {
					shaField = s
				}
			}
			data, err := lenientB64(strings.ReplaceAll(contentB64, "\n", ""))
			if err != nil {
				return errResp(400, "Invalid content encoding")
			}
			tipBranch, hasTipBranch := branchTip(repo, branch)
			files := snapshotBytes(repo, tipBranch)
			var existing string
			var hasExisting bool
			if hasTipBranch {
				existing, hasExisting = filesAt(repo, tipBranch)[path]
			}
			if shaField != "" && hasExisting && shaField != existing {
				return errResp(409, "sha does not match")
			}
			isCreate := !hasExisting
			files[path] = data
			var parents []string
			if hasTipBranch {
				parents = []string{tipBranch}
			}
			commit := createCommit(repo, files, parents, message)
			repo.setRef("refs/heads/"+branch, commit)
			blobOID := filesAt(repo, commit)[path]
			name := path
			if i := strings.LastIndex(path, "/"); i >= 0 {
				name = path[i+1:]
			}
			status := 200
			if isCreate {
				status = 201
			}
			return jsonResp(status, map[string]any{
				"content": map[string]any{
					"name": name, "path": path, "sha": blobOID, "size": len(data),
					"type": "file", "encoding": "base64",
				},
				"commit": map[string]any{"sha": commit, "message": message},
			}, nil)
		}
		if method == "DELETE" {
			body, ok := readJSONBody(req.body)
			if !ok {
				return errResp(400, "Problems parsing JSON")
			}
			message := jsonGetString(body, "message")
			if message == "" {
				message = "Delete"
			}
			branch := jsonGetString(body, "branch")
			if branch == "" {
				branch = repo.DefaultBranch
			}
			shaField := ""
			if v, exists := body["sha"]; exists {
				if s, ok := v.(string); ok {
					shaField = s
				}
			}
			tipBranch, hasTipBranch := branchTip(repo, branch)
			if !hasTipBranch {
				return errResp(404, "Not Found")
			}
			files := snapshotBytes(repo, tipBranch)
			if _, ok := files[path]; !ok {
				return errResp(404, "Not Found")
			}
			if shaField != "" {
				if cur, ok := filesAt(repo, tipBranch)[path]; ok && cur != shaField {
					return errResp(409, "sha does not match")
				}
			}
			delete(files, path)
			commit := createCommit(repo, files, []string{tipBranch}, message)
			repo.setRef("refs/heads/"+branch, commit)
			return jsonResp(200, map[string]any{
				"commit": map[string]any{"sha": commit, "message": message},
			}, nil)
		}
		return errResp(405, "Method Not Allowed")
	}
	// ---- labels
	if sub == "labels" {
		if method == "POST" && len(rest) == 1 {
			body, ok := readJSONBody(req.body)
			if !ok {
				return errResp(400, "Problems parsing JSON")
			}
			name := jsonGetString(body, "name")
			color := jsonGetString(body, "color")
			color = strings.TrimPrefix(color, "#")
			if color == "" {
				color = "ededed"
			}
			if name == "" {
				return errResp(422, "name is required")
			}
			if existing, ok := repo.labels[name]; ok {
				return jsonResp(201, map[string]any{"name": existing.Name, "color": existing.Color}, nil)
			}
			repo.labels[name] = &Label{Name: name, Color: color}
			repo.labelOrder = append(repo.labelOrder, name)
			return jsonResp(201, map[string]any{"name": name, "color": color}, nil)
		}
		if method == "GET" && len(rest) == 1 {
			var list []any
			for _, name := range repo.labelOrder {
				l := repo.labels[name]
				list = append(list, map[string]any{"name": l.Name, "color": l.Color})
			}
			if list == nil {
				list = []any{}
			}
			return jsonResp(200, list, nil)
		}
		return errResp(404, "Not Found")
	}
	// ---- issues
	if sub == "issues" {
		if len(rest) == 1 {
			if method == "POST" {
				body, ok := readJSONBody(req.body)
				if !ok {
					return errResp(400, "Problems parsing JSON")
				}
				title := jsonGetString(body, "title")
				bodyText := jsonGetString(body, "body")
				if title == "" {
					return errResp(422, "title is required")
				}
				var labelNames []string
				if arr, ok := body["labels"].([]any); ok {
					for _, l := range arr {
						switch v := l.(type) {
						case string:
							if v != "" {
								labelNames = append(labelNames, v)
							}
						case map[string]any:
							if n, ok := v["name"].(string); ok && n != "" {
								labelNames = append(labelNames, n)
							} else if v["name"] != nil {
								labelNames = append(labelNames, jsonStringify(v["name"]))
							}
						}
					}
				}
				for _, l := range labelNames {
					if _, ok := repo.labels[l]; !ok {
						return errResp(422, "Label does not exist: "+l)
					}
				}
				issue := createIssueIn(repo, title, bodyText, labelNames)
				return jsonResp(201, toIssueJSON(repo, issue), nil)
			}
			if method == "GET" {
				q := parseQuery(req.query)
				state := q["state"]
				if state == "" {
					state = "open"
				}
				sortMode := q["sort"]
				if sortMode == "" {
					sortMode = "created"
				}
				direction := q["direction"]
				if direction == "" {
					direction = "asc"
				}
				var list []*Issue
				for _, i := range repo.Issues {
					if state != "all" && i.State != state {
						continue
					}
					list = append(list, i)
				}
				if sortMode == "created" {
					sort.Slice(list, func(a, b int) bool {
						if direction == "desc" {
							return list[a].Number > list[b].Number
						}
						return list[a].Number < list[b].Number
					})
				}
				var items []any
				for _, i := range list {
					items = append(items, toIssueJSON(repo, i))
				}
				if items == nil {
					items = []any{}
				}
				page, link := paginate(req, items)
				return jsonResp(200, page, map[string]string{"link": link})
			}
			return errResp(405, "Method Not Allowed")
		}
		num, err := strconv.Atoi(rest[1])
		if err != nil {
			return errResp(404, "Not Found")
		}
		var issue *Issue
		for _, i := range repo.Issues {
			if i.Number == num {
				issue = i
				break
			}
		}
		if issue == nil {
			return errResp(404, "Not Found")
		}
		if len(rest) == 2 {
			if method == "GET" {
				return jsonResp(200, toIssueJSON(repo, issue), nil)
			}
			if method == "PATCH" {
				body, ok := readJSONBody(req.body)
				if !ok {
					return errResp(400, "Problems parsing JSON")
				}
				if v, exists := body["title"]; exists {
					if s, ok := v.(string); ok {
						issue.Title = s
					}
				}
				if v, exists := body["body"]; exists {
					if s, ok := v.(string); ok {
						issue.Body = s
					}
				}
				if v, exists := body["state"]; exists {
					if s, ok := v.(string); ok && (s == "open" || s == "closed") {
						issue.State = s
					}
				}
				if arr, ok := body["labels"].([]any); ok {
					var names []string
					for _, l := range arr {
						switch v := l.(type) {
						case string:
							if v != "" {
								names = append(names, v)
							}
						case map[string]any:
							if n, ok := v["name"].(string); ok && n != "" {
								names = append(names, n)
							} else if v["name"] != nil {
								names = append(names, jsonStringify(v["name"]))
							}
						}
					}
					for _, l := range names {
						if _, ok := repo.labels[l]; !ok {
							return errResp(422, "Label does not exist: "+l)
						}
					}
					issue.Labels = names
				}
				return jsonResp(200, toIssueJSON(repo, issue), nil)
			}
			return errResp(405, "Method Not Allowed")
		}
		if len(rest) == 3 && rest[2] == "comments" {
			if method == "GET" {
				var list []any
				for _, c := range issue.Comments {
					list = append(list, map[string]any{
						"id": c.ID, "body": c.Body,
						"user":       map[string]any{"login": viewerLogin, "id": viewerID},
						"created_at": fixedDate,
					})
				}
				if list == nil {
					list = []any{}
				}
				return jsonResp(200, list, nil)
			}
			if method == "POST" {
				body, ok := readJSONBody(req.body)
				if !ok {
					return errResp(400, "Problems parsing JSON")
				}
				commentBody := jsonGetString(body, "body")
				if commentBody == "" {
					return errResp(422, "body is required")
				}
				id := repo.NextCommentID
				repo.NextCommentID++
				issue.Comments = append(issue.Comments, IssueComment{ID: id, Body: commentBody, User: viewerLogin, Seq: id})
				return jsonResp(201, map[string]any{
					"id": id, "body": commentBody,
					"user":       map[string]any{"login": viewerLogin, "id": viewerID},
					"created_at": fixedDate,
				}, nil)
			}
			return errResp(405, "Method Not Allowed")
		}
		return errResp(404, "Not Found")
	}
	// ---- pulls
	if sub == "pulls" {
		if len(rest) == 1 {
			if method == "POST" {
				body, ok := readJSONBody(req.body)
				if !ok {
					return errResp(400, "Problems parsing JSON")
				}
				title := jsonGetString(body, "title")
				head := jsonGetString(body, "head")
				base := jsonGetString(body, "base")
				if base == "" {
					base = repo.DefaultBranch
				}
				if title == "" || head == "" {
					return errResp(422, "title and head are required")
				}
				headSha, okH := repo.resolveRef(head)
				baseSha, okB := repo.resolveRef(base)
				if !okH || !okB {
					return errResp(422, "Invalid head or base branch")
				}
				number := repo.NextNum
				repo.NextNum++
				pr := &PullRequest{
					Number: number, ID: store.nextPullID, Title: title,
					Body: jsonGetString(body, "body"), State: "open",
					HeadRef: head, BaseRef: base, HeadSha: headSha, BaseSha: baseSha,
					Seq: number, User: viewerLogin,
				}
				store.nextPullID++
				repo.Pulls = append(repo.Pulls, pr)
				return jsonResp(201, toPullJSON(repo, pr), nil)
			}
			if method == "GET" {
				q := parseQuery(req.query)
				state := q["state"]
				if state == "" {
					state = "open"
				}
				var items []any
				for _, p := range repo.Pulls {
					if state != "all" && p.State != state {
						continue
					}
					items = append(items, toPullJSON(repo, p))
				}
				if items == nil {
					items = []any{}
				}
				page, link := paginate(req, items)
				return jsonResp(200, page, map[string]string{"link": link})
			}
			return errResp(405, "Method Not Allowed")
		}
		num, err := strconv.Atoi(rest[1])
		if err != nil {
			return errResp(404, "Not Found")
		}
		var pr *PullRequest
		for _, p := range repo.Pulls {
			if p.Number == num {
				pr = p
				break
			}
		}
		if pr == nil {
			return errResp(404, "Not Found")
		}
		if len(rest) == 2 {
			if method == "GET" {
				return jsonResp(200, toPullJSON(repo, pr), nil)
			}
			if method == "PATCH" {
				body, ok := readJSONBody(req.body)
				if !ok {
					return errResp(400, "Problems parsing JSON")
				}
				if v, exists := body["title"]; exists {
					if s, ok := v.(string); ok {
						pr.Title = s
					}
				}
				if v, exists := body["body"]; exists {
					if s, ok := v.(string); ok {
						pr.Body = s
					}
				}
				if v, exists := body["state"]; exists {
					if s, ok := v.(string); ok && (s == "open" || s == "closed") {
						pr.State = s
					}
				}
				return jsonResp(200, toPullJSON(repo, pr), nil)
			}
			return errResp(405, "Method Not Allowed")
		}
		if len(rest) == 3 && rest[2] == "files" && method == "GET" {
			var list []any
			for _, f := range prFiles(repo, pr) {
				list = append(list, map[string]any{
					"filename": f.Filename, "status": f.Status,
					"additions": f.Additions, "deletions": f.Deletions, "changes": f.Changes,
				})
			}
			if list == nil {
				list = []any{}
			}
			return jsonResp(200, list, nil)
		}
		if len(rest) == 3 && rest[2] == "merge" && method == "PUT" {
			if _, ok := readJSONBody(req.body); !ok {
				return errResp(400, "Problems parsing JSON")
			}
			if pr.Merged {
				sha := ""
				if pr.MergeSha != nil {
					sha = *pr.MergeSha
				}
				return jsonResp(200, map[string]any{
					"merged": true, "sha": sha,
					"message": "Pull request #" + itoa(pr.Number) + " merged",
				}, nil)
			}
			if pr.State != "open" {
				return errResp(405, "Pull request is closed")
			}
			if prConflicted(repo, pr) {
				return errResp(405, "Merge conflict")
			}
			sha := squashMerge(repo, pr)
			if sha == "" {
				return errResp(405, "Merge conflict")
			}
			return jsonResp(200, map[string]any{
				"merged": true, "sha": sha,
				"message": "Merge pull request #" + itoa(pr.Number) + " from " + repo.Owner + "/" + pr.HeadRef,
			}, nil)
		}
		return errResp(404, "Not Found")
	}
	return errResp(404, "Not Found")
}

// jsonStringify renders a non-string JSON value the way JavaScript's
// String() of a label name would look (the rare non-string label path).
func jsonStringify(v any) string {
	if v == nil {
		return ""
	}
	switch v.(type) {
	case map[string]any, []any:
		return "[object Object]"
	}
	return string(jsonBytes(v))
}

// localeCompareASCII approximates JavaScript's String.localeCompare for the
// ASCII filenames that appear in directory listings: the primary comparison
// is case-insensitive, and ties break with lowercase before uppercase.
func localeCompareASCII(a, b string) int {
	la, lb := strings.ToLower(a), strings.ToLower(b)
	if la != lb {
		if la < lb {
			return -1
		}
		return 1
	}
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			if a[i] >= 'a' && a[i] <= 'z' {
				return -1
			}
			return 1
		}
	}
	if len(a) < len(b) {
		return -1
	}
	if len(a) > len(b) {
		return 1
	}
	return 0
}
