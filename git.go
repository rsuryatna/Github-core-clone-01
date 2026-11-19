// git.go — git smart HTTP: info/refs, upload-pack (protocol v2 + v0),
// receive-pack (v0). The wire bytes match the reference forge exactly:
// the same advertisements, capabilities, pkt-lines, sideband framing and
// deterministic pack order.

package main

import (
	"bytes"
	"sort"
	"strings"
	"sync"
)

type refRow struct {
	oid    string
	name   string
	symref string
	peeled string
}

func refRows(r *Repo) []refRow {
	rows := []refRow{}
	tip, ok := r.refTip("refs/heads/" + r.DefaultBranch)
	if !ok {
		tip = zeroOID
	}
	rows = append(rows, refRow{oid: tip, name: "HEAD", symref: "refs/heads/" + r.DefaultBranch})
	names := make([]string, 0, len(r.refs))
	for name := range r.refs {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		oid := r.refs[name]
		row := refRow{oid: oid, name: name}
		if obj := r.objects[oid]; obj != nil && obj.Type == objTag {
			row.peeled = peelObject(r, oid)
		}
		rows = append(rows, row)
	}
	return rows
}

const uploadCapsV0 = "multi_ack thin-pack side-band-64k side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want report-status report-status-v2"
const receiveCapsV0 = "report-status report-status-v2 delete-refs side-band-64k ofs-delta quiet"

func v0Advertisement(r *Repo, service, caps string) []byte {
	symref := "symref=HEAD:refs/heads/" + r.DefaultBranch
	rows := refRows(r)
	var parts [][]byte
	parts = append(parts, pktLineStr("# service="+service+"\n"), pktFlushBytes)
	capsLine := caps + " " + symref + " agent=github-core-clone/1.0.0"
	if len(rows) == 1 && rows[0].oid == zeroOID {
		parts = append(parts, pktLineStr(zeroOID+" capabilities^{}\x00"+capsLine+"\n"))
	} else {
		for _, row := range rows {
			if row.name == "HEAD" {
				parts = append(parts, pktLineStr(row.oid+" HEAD\x00"+capsLine+"\n"))
				continue
			}
			parts = append(parts, pktLineStr(row.oid+" "+row.name+"\n"))
			if row.peeled != "" {
				parts = append(parts, pktLineStr(row.peeled+" "+row.name+"^{}\n"))
			}
		}
	}
	parts = append(parts, pktFlushBytes)
	return bytes.Join(parts, nil)
}

func v2Advertisement() []byte {
	return pktLines([]any{
		"# service=git-upload-pack\n", "flush",
		"version 2\n",
		"agent=github-core-clone/1.0.0\n",
		"ls-refs=unborn\n",
		"fetch=shallow wait-for-done filter\n",
		"object-format=sha1\n",
		"object-info\n",
		"flush",
	})
}

// The v2 advertisement never depends on repo state: build it once.
var v2AdvertisementBytes = v2Advertisement()

// ---------------------------------------------------------------- fetch cache
// An upload-pack fetch response is a pure function of (repo.objects, args):
// objects are content-addressed and append-only, so when the object count is
// unchanged the reachable set for the same args is identical, and writePack
// is deterministic. Memoizing the response turns 50 identical depth-1
// clones into one pack build. The cache holds derived bytes only.

type fetchCache struct {
	mu     sync.RWMutex
	byRepo map[*Repo]map[string][]byte
	order  map[*Repo][]string
}

var fetchCacheStore = &fetchCache{byRepo: map[*Repo]map[string][]byte{}, order: map[*Repo][]string{}}

const fetchCacheMax = 128

func fetchCacheKey(r *Repo, a fetchArgs, protocol string) string {
	sorted := func(xs []string) string {
		cp := append([]string(nil), xs...)
		sort.Strings(cp)
		return strings.Join(cp, ",")
	}
	deepen := ""
	if a.deepen != nil {
		deepen = itoa(*a.deepen)
	}
	thin := "0"
	if a.thinPack {
		thin = "1"
	}
	filter := ""
	if a.filter != nil {
		filter = *a.filter
	}
	return protocol + "|" + itoa(len(r.objects)) + "|" + sorted(a.wants) + "|" + sorted(a.haves) + "|" + sorted(a.shallows) + "|" + deepen + "|" + filter + "|" + thin
}

func fetchCached(r *Repo, a fetchArgs, protocol string, build func() []byte) []byte {
	key := fetchCacheKey(r, a, protocol)
	fetchCacheStore.mu.RLock()
	if perRepo, ok := fetchCacheStore.byRepo[r]; ok {
		if hit, ok := perRepo[key]; ok {
			fetchCacheStore.mu.RUnlock()
			return hit
		}
	}
	fetchCacheStore.mu.RUnlock()
	built := build()
	fetchCacheStore.mu.Lock()
	defer fetchCacheStore.mu.Unlock()
	perRepo, ok := fetchCacheStore.byRepo[r]
	if !ok {
		perRepo = map[string][]byte{}
		fetchCacheStore.byRepo[r] = perRepo
	}
	// Another goroutine may have built it while we were building: keep the
	// first one (both are byte-identical for the same key).
	if hit, ok := perRepo[key]; ok {
		return hit
	}
	if len(perRepo) >= fetchCacheMax {
		oldest := fetchCacheStore.order[r][0]
		delete(perRepo, oldest)
		fetchCacheStore.order[r] = fetchCacheStore.order[r][1:]
	}
	perRepo[key] = built
	fetchCacheStore.order[r] = append(fetchCacheStore.order[r], key)
	return built
}

// ---------------------------------------------------------------- info/refs

// handleInfoRefs answers GET info/refs. Returns status, content type, body.
func handleInfoRefs(r *Repo, service, protocol string) (int, string, []byte) {
	if r == nil {
		return 404, "application/json", jsonBytes(map[string]any{"message": "Not Found"})
	}
	if service == "git-receive-pack" {
		return 200, "application/x-git-receive-pack-advertisement", v0Advertisement(r, "git-receive-pack", receiveCapsV0)
	}
	if service != "git-upload-pack" {
		return 400, "application/json", jsonBytes(map[string]any{"message": "Unknown service"})
	}
	if protocol == "version=2" {
		return 200, "application/x-git-upload-pack-advertisement", v2AdvertisementBytes
	}
	return 200, "application/x-git-upload-pack-advertisement", v0Advertisement(r, "git-upload-pack", uploadCapsV0)
}

// ---------------------------------------------------------------- upload-pack v2

type fetchArgs struct {
	wants    []string
	haves    []string
	shallows []string
	deepen   *int
	filter   *string
	thinPack bool
}

func parseV2Request(packets []Packet) (string, map[string][]string) {
	command := ""
	args := map[string][]string{}
	afterDelim := false
	for _, p := range packets {
		if p.Kind != "data" {
			if p.Kind == "delim" {
				afterDelim = true
			}
			continue
		}
		line := string(p.Payload)
		if !afterDelim && strings.HasPrefix(line, "command=") {
			command = strings.TrimSpace(line[8:])
			continue
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		key, rest, _ := strings.Cut(trimmed, " ")
		args[key] = append(args[key], rest)
	}
	return command, args
}

func packForFetch(r *Repo, a fetchArgs) (pack []byte, shallow, unshallow []string) {
	haveSet := map[string]bool{}
	for _, h := range a.haves {
		if isOID(h) {
			if _, ok := r.objects[h]; ok {
				haveSet[h] = true
			}
		}
	}
	var wantedRoots []string
	for _, w := range a.wants {
		if isOID(w) {
			if _, ok := r.objects[w]; ok {
				wantedRoots = append(wantedRoots, w)
			}
		}
	}
	// The haves' whole closure is already held: exclude every object
	// reachable from a have, not just the have commits.
	var haveList []string
	for h := range haveSet {
		haveList = append(haveList, h)
	}
	haveClosure := collectReachable(r, haveList, -1, nil)
	// For depth-limited fetches the haves are shallow boundaries: the client
	// holds the boundary commit and its own tree, but not its parents.
	haveHeld := map[string]bool{}
	for h := range haveSet {
		haveHeld[h] = true
		if obj := r.objects[h]; obj != nil && obj.Type == objCommit {
			for o := range collectReachable(r, []string{parseCommit(obj.Data).Tree}, -1, nil) {
				haveHeld[o] = true
			}
		}
	}
	var reachable map[string]bool
	if a.deepen != nil {
		deepen := *a.deepen
		// Depth-limited traversal: commits within `deepen` generations of
		// the wants (depth 0 = the want itself). visitOrder records first
		// visit order so the shallow list is deterministic.
		commitDepth := map[string]int{}
		var visitOrder []string
		type item struct {
			oid   string
			depth int
		}
		var stack []item
		for _, root := range wantedRoots {
			stack = append(stack, item{root, 0})
		}
		for len(stack) > 0 {
			it := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if _, ok := commitDepth[it.oid]; ok {
				continue
			}
			obj := r.objects[it.oid]
			if obj == nil || obj.Type != objCommit {
				continue
			}
			commitDepth[it.oid] = it.depth
			visitOrder = append(visitOrder, it.oid)
			if it.depth < deepen-1 {
				for _, p := range parseCommit(obj.Data).Parents {
					stack = append(stack, item{p, it.depth + 1})
				}
			}
		}
		final := map[string]bool{}
		for _, oid := range visitOrder {
			depth := commitDepth[oid]
			if haveHeld[oid] {
				continue
			}
			final[oid] = true
			if depth == deepen-1 {
				shallow = append(shallow, oid)
			}
			if obj := r.objects[oid]; obj != nil && obj.Type == objCommit {
				for o := range collectReachable(r, []string{parseCommit(obj.Data).Tree}, -1, nil) {
					if !haveHeld[o] {
						final[o] = true
					}
				}
			}
		}
		for _, s := range a.shallows {
			if _, ok := commitDepth[s]; ok {
				unshallow = append(unshallow, s)
			}
		}
		reachable = final
	} else {
		reachable = collectReachable(r, wantedRoots, -1, haveClosure)
	}
	// Deterministic pack order: commits, then trees, then blobs, each by oid.
	typeRank := map[ObjType]int{objCommit: 0, objTree: 1, objBlob: 2, objTag: 3}
	var oids []string
	for oid := range reachable {
		oids = append(oids, oid)
	}
	sort.Slice(oids, func(i, j int) bool {
		ti := objBlob
		if o := r.objects[oids[i]]; o != nil {
			ti = o.Type
		}
		tj := objBlob
		if o := r.objects[oids[j]]; o != nil {
			tj = o.Type
		}
		if typeRank[ti] != typeRank[tj] {
			return typeRank[ti] < typeRank[tj]
		}
		return oids[i] < oids[j]
	})
	var objs []*GitObj
	for _, oid := range oids {
		if o := r.objects[oid]; o != nil {
			objs = append(objs, o)
		}
	}
	return writePack(objs), shallow, unshallow
}

func lsRefsResponse(r *Repo, args map[string][]string) []byte {
	prefixes := args["ref-prefix"]
	wantPeel := false
	if _, ok := args["peel"]; ok {
		wantPeel = true
	}
	// An empty repo advertises no refs at all.
	if len(r.refs) == 0 {
		return pktFlushBytes
	}
	rows := refRows(r)
	var lines []string
	for _, row := range rows {
		if len(prefixes) > 0 {
			matched := false
			for _, p := range prefixes {
				if strings.HasPrefix(row.name, p) {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}
		if row.name == "HEAD" {
			lines = append(lines, row.oid+" HEAD symref-target:"+row.symref+"\n")
			continue
		}
		line := row.oid + " " + row.name
		if wantPeel && row.peeled != "" {
			line += " peeled:" + row.peeled
		}
		lines = append(lines, line+"\n")
	}
	var items []any
	for _, l := range lines {
		items = append(items, l)
	}
	return append(pktLines(items), pktFlushBytes...)
}

func fetchV2Response(r *Repo, args map[string][]string) []byte {
	var a fetchArgs
	a.wants = args["want"]
	a.haves = args["have"]
	a.shallows = args["shallow"]
	if v, ok := args["deepen"]; ok && len(v) > 0 {
		d := jsParseInt(v[0], 0)
		a.deepen = &d
	}
	if v, ok := args["filter"]; ok && len(v) > 0 {
		f := v[0]
		a.filter = &f
	}
	if _, ok := args["thin-pack"]; ok {
		a.thinPack = true
	}
	return fetchCached(r, a, "v2", func() []byte { return buildFetchV2Response(r, a) })
}

func buildFetchV2Response(r *Repo, a fetchArgs) []byte {
	pack, shallow, unshallow := packForFetch(r, a)
	var parts [][]byte
	// The acknowledgments section is only sent when the client negotiated
	// with `have` lines; a fresh fetch expects the packfile section first.
	if len(a.haves) > 0 {
		parts = append(parts, pktLineStr("acknowledgments\n"), pktLineStr("NAK\n"), pktDelimBytes)
	}
	if len(shallow) > 0 || len(unshallow) > 0 {
		parts = append(parts, pktLineStr("shallow-info\n"))
		for _, s := range shallow {
			parts = append(parts, pktLineStr("shallow "+s+"\n"))
		}
		for _, u := range unshallow {
			parts = append(parts, pktLineStr("unshallow "+u+"\n"))
		}
		parts = append(parts, pktDelimBytes)
	}
	parts = append(parts, pktLineStr("packfile\n"))
	// Sideband: band 1 chunks.
	const chunkSize = 60000
	if len(pack) == 0 {
		parts = append(parts, pktLine([]byte{1}))
	} else {
		for off := 0; off < len(pack); off += chunkSize {
			end := off + chunkSize
			if end > len(pack) {
				end = len(pack)
			}
			chunk := make([]byte, 1+end-off)
			chunk[0] = 1
			copy(chunk[1:], pack[off:end])
			parts = append(parts, pktLine(chunk))
		}
	}
	parts = append(parts, pktFlushBytes)
	return bytes.Join(parts, nil)
}

// ---------------------------------------------------------------- upload-pack v0

func fetchV0Response(r *Repo, packets []Packet) []byte {
	var wants, haves, shallows []string
	var deepen *int
	for _, p := range packets {
		if p.Kind == "flush" {
			continue
		}
		if p.Kind != "data" {
			continue
		}
		line := strings.TrimSpace(string(p.Payload))
		if line == "done" {
			continue
		}
		switch {
		case strings.HasPrefix(line, "want "):
			wants = append(wants, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "have "):
			haves = append(haves, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "deepen "):
			d := jsParseInt(strings.TrimSpace(line[7:]), 0)
			deepen = &d
		case strings.HasPrefix(line, "shallow "):
			shallows = append(shallows, strings.TrimSpace(line[8:]))
		}
	}
	a := fetchArgs{wants: wants, haves: haves, shallows: shallows, deepen: deepen}
	return fetchCached(r, a, "v0", func() []byte { return buildFetchV0Response(r, a) })
}

func buildFetchV0Response(r *Repo, a fetchArgs) []byte {
	pack, shallow, unshallow := packForFetch(r, a)
	var parts [][]byte
	parts = append(parts, pktLineStr("NAK\n"))
	for _, s := range shallow {
		parts = append(parts, pktLineStr("shallow "+s+"\n"))
	}
	for _, u := range unshallow {
		parts = append(parts, pktLineStr("unshallow "+u+"\n"))
	}
	const chunkSize = 60000
	for off := 0; off < len(pack); off += chunkSize {
		end := off + chunkSize
		if end > len(pack) {
			end = len(pack)
		}
		chunk := make([]byte, 1+end-off)
		chunk[0] = 1
		copy(chunk[1:], pack[off:end])
		parts = append(parts, pktLine(chunk))
	}
	parts = append(parts, pktFlushBytes)
	return bytes.Join(parts, nil)
}

// handleUploadPack answers POST git-upload-pack. Returns status, content
// type, body.
func handleUploadPack(r *Repo, body []byte, protocol string) (int, string, []byte) {
	if r == nil {
		return 404, "application/json", jsonBytes(map[string]any{"message": "Not Found"})
	}
	packets, err := decodePktLines(body)
	if err != nil {
		return 400, "application/json", jsonBytes(map[string]any{"message": "Bad request"})
	}
	isV2 := protocol == "version=2"
	if !isV2 {
		for _, p := range packets {
			if p.Kind == "data" && strings.HasPrefix(string(p.Payload), "command=") {
				isV2 = true
				break
			}
		}
	}
	if isV2 {
		command, args := parseV2Request(packets)
		switch command {
		case "ls-refs":
			return 200, "application/x-git-upload-pack-result", lsRefsResponse(r, args)
		case "fetch":
			return 200, "application/x-git-upload-pack-result", fetchV2Response(r, args)
		default:
			return 400, "application/json", jsonBytes(map[string]any{"message": "Unknown command"})
		}
	}
	return 200, "application/x-git-upload-pack-result", fetchV0Response(r, packets)
}

// ---------------------------------------------------------------- receive-pack v0

type pushCommand struct {
	oldOID string
	newOID string
	ref    string
}

// handleReceivePack answers POST git-receive-pack. Returns status, content
// type, body.
func handleReceivePack(r *Repo, body []byte) (int, string, []byte) {
	if r == nil {
		return 404, "application/json", jsonBytes(map[string]any{"message": "Not Found"})
	}
	var commands []pushCommand
	packOffset := -1
	sideBand := false
	offset := 0
	// Walk the raw bytes packet by packet: commands until the flush, then the
	// raw pack data follows (it is not pkt-line framed).
	for offset < len(body) {
		if offset+4 > len(body) {
			break
		}
		header := string(body[offset : offset+4])
		ln := 0
		valid := true
		for _, c := range header {
			var v int
			switch {
			case c >= '0' && c <= '9':
				v = int(c - '0')
			case c >= 'a' && c <= 'f':
				v = int(c-'a') + 10
			case c >= 'A' && c <= 'F':
				v = int(c-'A') + 10
			default:
				valid = false
			}
			if !valid {
				break
			}
			ln = ln*16 + v
		}
		if !valid {
			break
		}
		if ln == 0 {
			packOffset = offset + 4
			break
		}
		if ln == 1 {
			offset += 4
			continue
		}
		if ln < 4 || offset+ln > len(body) {
			break
		}
		payload := body[offset+4 : offset+ln]
		line := string(payload)
		nul := strings.IndexByte(line, 0)
		head := line
		if nul >= 0 {
			head = line[:nul]
		}
		head = strings.TrimSpace(head)
		if len(head) >= 83 && head[40] == ' ' && head[81] == ' ' && isOID(head[:40]) && isOID(head[41:81]) && !strings.Contains(head[82:], " ") && !strings.Contains(head[82:], "\t") {
			oldOID, newOID, ref := head[:40], head[41:81], head[82:]
			commands = append(commands, pushCommand{oldOID: oldOID, newOID: newOID, ref: ref})
			if nul >= 0 && strings.Contains(line[nul+1:], "side-band-64k") {
				sideBand = true
			}
		}
		offset += ln
	}
	unpackOK := true
	if packOffset >= 0 && packOffset < len(body) {
		packBytes := body[packOffset:]
		if len(packBytes) >= 12 {
			objs, err := readPack(packBytes, func(oid string) *GitObj { return r.objects[oid] })
			if err != nil {
				unpackOK = false
			} else {
				for oid, obj := range objs {
					r.objects[oid] = obj
				}
			}
		}
	}
	type result struct {
		ref    string
		ok     bool
		reason string
	}
	var results []result
	for _, cmd := range commands {
		cur, hasCur := r.refTip(cmd.ref)
		if !unpackOK {
			results = append(results, result{ref: cmd.ref, reason: "unpack error"})
			continue
		}
		if cmd.newOID == zeroOID {
			// delete
			if !hasCur {
				results = append(results, result{ref: cmd.ref, reason: "ref does not exist"})
				continue
			}
			r.deleteRef(cmd.ref)
			results = append(results, result{ref: cmd.ref, ok: true})
			continue
		}
		target := r.objects[cmd.newOID]
		if target == nil || (target.Type != objCommit && target.Type != objTag) {
			results = append(results, result{ref: cmd.ref, reason: "object not found"})
			continue
		}
		if cmd.oldOID == zeroOID {
			if hasCur {
				results = append(results, result{ref: cmd.ref, reason: "already exists"})
				continue
			}
			r.setRef(cmd.ref, cmd.newOID)
			results = append(results, result{ref: cmd.ref, ok: true})
			continue
		}
		if !hasCur || cur != cmd.oldOID {
			results = append(results, result{ref: cmd.ref, reason: "non-fast-forward"})
			continue
		}
		peeledNew := cmd.newOID
		if target.Type == objTag {
			peeledNew = peelObject(r, cmd.newOID)
		}
		peeledOld := peelObject(r, cmd.oldOID)
		if !isOID(peeledNew) || !isAncestorCommit(r, peeledOld, peeledNew) {
			results = append(results, result{ref: cmd.ref, reason: "non-fast-forward"})
			continue
		}
		r.setRef(cmd.ref, cmd.newOID)
		results = append(results, result{ref: cmd.ref, ok: true})
	}
	var reportLines []string
	if unpackOK {
		reportLines = append(reportLines, "unpack ok\n")
	} else {
		reportLines = append(reportLines, "unpack error\n")
	}
	for _, res := range results {
		if res.ok {
			reportLines = append(reportLines, "ok "+res.ref+"\n")
		} else {
			reportLines = append(reportLines, "ng "+res.ref+" "+res.reason+"\n")
		}
	}
	var items []any
	for _, l := range reportLines {
		items = append(items, l)
	}
	items = append(items, "flush")
	report := pktLines(items)
	var out []byte
	if sideBand {
		var chunks [][]byte
		const chunkSize = 60000
		for off := 0; off < len(report); off += chunkSize {
			end := off + chunkSize
			if end > len(report) {
				end = len(report)
			}
			chunk := make([]byte, 1+end-off)
			chunk[0] = 1
			copy(chunk[1:], report[off:end])
			chunks = append(chunks, pktLine(chunk))
		}
		chunks = append(chunks, pktFlushBytes)
		out = bytes.Join(chunks, nil)
	} else {
		out = append(append([]byte{}, report...), pktFlushBytes...)
	}
	return 200, "application/x-git-receive-pack-result", out
}
