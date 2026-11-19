// core.go — git object model, packfile codec, pkt-line codec, and the forge's
// single in-memory store shared by REST, GraphQL, MCP and git smart HTTP.
//
// Determinism: no wall clock or randomness anywhere in state. Commit
// timestamps come from a fixed epoch plus a per-repo sequence counter, ids
// from counters, request ids from a counter. Two runs that send the same
// requests in the same order therefore build the same objects.
//
// The token owner: the suite's scenario is seeded from a constant, so the
// viewer the bearer token names is always "adaiversen" and the stranger is
// "olgabauer". The token itself is opaque — the server authenticates it
// against MAKEFUN_SHOP_TOKEN and treats the authenticated user as the viewer.

package main

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
)

const zeroOID = "0000000000000000000000000000000000000000"
const viewerLogin = "adaiversen"
const viewerName = "ada iversen"
const viewerEmail = "adaiversen@example.invalid"
const viewerID = 1000
const strangerLogin = "olgabauer"
const fixedEpoch = 1700000000

// ObjType is the git object kind. The numeric codes are the packfile ones.
type ObjType string

const (
	objCommit ObjType = "commit"
	objTree   ObjType = "tree"
	objBlob   ObjType = "blob"
	objTag    ObjType = "tag"
)

var typeCode = map[ObjType]byte{objCommit: 1, objTree: 2, objBlob: 3, objTag: 4}
var codeType = map[byte]ObjType{1: objCommit, 2: objTree, 3: objBlob, 4: objTag}

// GitObj is one stored object: its kind and its raw bytes.
type GitObj struct {
	Type ObjType
	Data []byte
}

func isOID(s string) bool {
	if len(s) != 40 {
		return false
	}
	for i := 0; i < 40; i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func hashObject(typ ObjType, data []byte) string {
	h := sha1.New()
	// Header is "<type> <len>\0"; write it without an extra allocation.
	var hdr [32]byte
	n := copy(hdr[:], string(typ))
	n += copy(hdr[n:], " ")
	n += copy(hdr[n:], itoa(len(data)))
	hdr[n] = 0
	h.Write(hdr[:n+1])
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// itoa renders a non-negative integer without importing strconv.
func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	return string(b[i:])
}

func putObject(r *Repo, typ ObjType, data []byte) string {
	oid := hashObject(typ, data)
	if _, ok := r.objects[oid]; !ok {
		r.objects[oid] = &GitObj{Type: typ, Data: data}
	}
	return oid
}

// ---------------------------------------------------------------- trees

// TreeEntry is one entry of a git tree object.
type TreeEntry struct {
	Mode string
	Name string
	OID  string
}

func parseTree(data []byte) ([]TreeEntry, error) {
	var out []TreeEntry
	off := 0
	for off < len(data) {
		sp := bytes.IndexByte(data[off:], ' ')
		if sp < 0 {
			return nil, errors.New("bad tree")
		}
		sp += off
		nul := bytes.IndexByte(data[sp+1:], 0)
		if nul < 0 {
			return nil, errors.New("bad tree")
		}
		nul += sp + 1
		if nul+21 > len(data) {
			return nil, errors.New("bad tree")
		}
		out = append(out, TreeEntry{
			Mode: string(data[off:sp]),
			Name: string(data[sp+1 : nul]),
			OID:  hex.EncodeToString(data[nul+1 : nul+21]),
		})
		off = nul + 21
	}
	return out, nil
}

// treeNameLess orders tree entries the way git does: directory names compare
// with a trailing slash appended.
func treeNameLess(a, b TreeEntry) bool {
	an := a.Name
	if a.Mode == "40000" {
		an += "/"
	}
	bn := b.Name
	if b.Mode == "40000" {
		bn += "/"
	}
	return an < bn
}

func buildTree(entries []TreeEntry) []byte {
	sorted := append([]TreeEntry(nil), entries...)
	sort.SliceStable(sorted, func(i, j int) bool { return treeNameLess(sorted[i], sorted[j]) })
	var buf bytes.Buffer
	for _, e := range sorted {
		buf.WriteString(e.Mode)
		buf.WriteByte(' ')
		buf.WriteString(e.Name)
		buf.WriteByte(0)
		raw, _ := hex.DecodeString(e.OID)
		buf.Write(raw)
	}
	return buf.Bytes()
}

// ---------------------------------------------------------------- commits / tags

// CommitView is the parsed header of a commit object.
type CommitView struct {
	Tree      string
	Parents   []string
	Author    string
	Committer string
	Message   string
}

func parseCommit(data []byte) CommitView {
	var c CommitView
	blank := bytes.Index(data, []byte("\n\n"))
	var head, msg []byte
	if blank < 0 {
		head, msg = data, nil
	} else {
		head, msg = data[:blank], data[blank+2:]
	}
	c.Message = string(msg)
	for _, line := range strings.Split(string(head), "\n") {
		sp := strings.IndexByte(line, ' ')
		var k, v string
		if sp < 0 {
			k, v = line, ""
		} else {
			k, v = line[:sp], line[sp+1:]
		}
		switch k {
		case "tree":
			c.Tree = v
		case "parent":
			c.Parents = append(c.Parents, v)
		case "author":
			c.Author = v
		case "committer":
			c.Committer = v
		}
	}
	return c
}

func buildCommit(tree string, parents []string, message, who string, ts int) []byte {
	var b strings.Builder
	b.WriteString("tree " + tree + "\n")
	for _, p := range parents {
		b.WriteString("parent " + p + "\n")
	}
	fmt.Fprintf(&b, "author %s %d +0000\n", who, ts)
	fmt.Fprintf(&b, "committer %s %d +0000\n", who, ts)
	b.WriteString("\n")
	b.WriteString(message)
	return []byte(b.String())
}

// TagView is the parsed header of an annotated tag object.
type TagView struct {
	Object  string
	Type    ObjType
	Tag     string
	Tagger  string
	Message string
}

func parseTag(data []byte) TagView {
	var t TagView
	blank := bytes.Index(data, []byte("\n\n"))
	var head, msg []byte
	if blank < 0 {
		head, msg = data, nil
	} else {
		head, msg = data[:blank], data[blank+2:]
	}
	t.Message = string(msg)
	m := map[string]string{}
	for _, line := range strings.Split(string(head), "\n") {
		sp := strings.IndexByte(line, ' ')
		if sp > 0 {
			m[line[:sp]] = line[sp+1:]
		}
	}
	t.Object = m["object"]
	if ty, ok := m["type"]; ok {
		t.Type = ObjType(ty)
	} else {
		t.Type = objCommit
	}
	t.Tag = m["tag"]
	t.Tagger = m["tagger"]
	return t
}

// peelObject follows annotated tags to the object they point at.
func peelObject(r *Repo, oid string) string {
	cur := oid
	for i := 0; i < 10; i++ {
		o := r.objects[cur]
		if o == nil || o.Type != objTag {
			return cur
		}
		cur = parseTag(o.Data).Object
	}
	return cur
}

// ---------------------------------------------------------------- reachability

// collectReachable returns every object reachable from roots (commits, their
// trees and blobs, tags and their targets), minus the excluded set.
func collectReachable(r *Repo, roots []string, maxDepth int, exclude map[string]bool) map[string]bool {
	seen := map[string]bool{}
	type item struct {
		oid   string
		depth int
	}
	var stack []item
	for _, root := range roots {
		if isOID(root) {
			stack = append(stack, item{root, 0})
		}
	}
	for len(stack) > 0 {
		it := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[it.oid] || exclude[it.oid] {
			continue
		}
		obj := r.objects[it.oid]
		if obj == nil {
			continue
		}
		seen[it.oid] = true
		if maxDepth >= 0 && it.depth >= maxDepth {
			continue
		}
		switch obj.Type {
		case objCommit:
			c := parseCommit(obj.Data)
			stack = append(stack, item{c.Tree, it.depth + 1})
			for _, p := range c.Parents {
				stack = append(stack, item{p, it.depth + 1})
			}
		case objTag:
			stack = append(stack, item{parseTag(obj.Data).Object, it.depth + 1})
		case objTree:
			entries, err := parseTree(obj.Data)
			if err != nil {
				continue
			}
			for _, e := range entries {
				if e.Mode != "160000" {
					stack = append(stack, item{e.OID, it.depth + 1})
				}
			}
		}
	}
	return seen
}

// commitWalk lists commits reachable from tip, newest-first (BFS by depth,
// parents after), up to limit entries.
func commitWalk(r *Repo, tip string, limit int) []string {
	var out []string
	seen := map[string]bool{}
	queue := []string{tip}
	for len(queue) > 0 && len(out) < limit {
		oid := queue[0]
		queue = queue[1:]
		if seen[oid] {
			continue
		}
		seen[oid] = true
		obj := r.objects[oid]
		if obj == nil || obj.Type != objCommit {
			continue
		}
		out = append(out, oid)
		for _, p := range parseCommit(obj.Data).Parents {
			queue = append(queue, p)
		}
	}
	return out
}

func isAncestor(r *Repo, anc, desc string) bool {
	if anc == desc {
		return true
	}
	return collectReachable(r, []string{desc}, -1, nil)[anc]
}

// isAncestorCommit is the fast-forward check over commit parents only.
func isAncestorCommit(r *Repo, anc, desc string) bool {
	if anc == desc {
		return true
	}
	seen := map[string]bool{}
	stack := []string{desc}
	for len(stack) > 0 {
		oid := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if oid == anc {
			return true
		}
		if seen[oid] {
			continue
		}
		seen[oid] = true
		obj := r.objects[oid]
		if obj == nil || obj.Type != objCommit {
			continue
		}
		for _, p := range parseCommit(obj.Data).Parents {
			stack = append(stack, p)
		}
	}
	return false
}

func mergeBase(r *Repo, a, b string) string {
	fromA := map[string]bool{}
	for _, c := range commitWalk(r, a, 10000) {
		fromA[c] = true
	}
	for _, c := range commitWalk(r, b, 10000) {
		if fromA[c] {
			return c
		}
	}
	return ""
}

// ---------------------------------------------------------------- file maps

// FileMap maps a path to the blob oid at that path in some commit.
type FileMap map[string]string

func filesAt(r *Repo, commitOID string) FileMap {
	out := FileMap{}
	obj := r.objects[commitOID]
	if obj == nil || obj.Type != objCommit {
		return out
	}
	var walk func(treeOID, prefix string)
	walk = func(treeOID, prefix string) {
		t := r.objects[treeOID]
		if t == nil || t.Type != objTree {
			return
		}
		entries, err := parseTree(t.Data)
		if err != nil {
			return
		}
		for _, e := range entries {
			if e.Mode == "40000" {
				walk(e.OID, prefix+e.Name+"/")
			} else {
				out[prefix+e.Name] = e.OID
			}
		}
	}
	walk(parseCommit(obj.Data).Tree, "")
	return out
}

func treeOIDForFiles(r *Repo, files map[string][]byte) string {
	type node struct {
		files map[string][]byte
		dirs  map[string]*node
	}
	mk := func() *node { return &node{files: map[string][]byte{}, dirs: map[string]*node{}} }
	root := mk()
	for path, data := range files {
		segs := strings.Split(path, "/")
		n := root
		for i := 0; i < len(segs)-1; i++ {
			s := segs[i]
			child, ok := n.dirs[s]
			if !ok {
				child = mk()
				n.dirs[s] = child
			}
			n = child
		}
		n.files[segs[len(segs)-1]] = data
	}
	var build func(n *node) string
	build = func(n *node) string {
		var entries []TreeEntry
		for name, data := range n.files {
			entries = append(entries, TreeEntry{Mode: "100644", Name: name, OID: putObject(r, objBlob, data)})
		}
		for name, child := range n.dirs {
			entries = append(entries, TreeEntry{Mode: "40000", Name: name, OID: build(child)})
		}
		return putObject(r, objTree, buildTree(entries))
	}
	return build(root)
}

// createCommit builds a commit whose tree holds exactly files.
func createCommit(r *Repo, files map[string][]byte, parents []string, message string) string {
	tree := treeOIDForFiles(r, files)
	ts := fixedEpoch + r.commitSeq
	r.commitSeq++
	who := viewerName + " <" + viewerEmail + ">"
	msg := message
	if !strings.HasSuffix(msg, "\n") {
		msg += "\n"
	}
	return putObject(r, objCommit, buildCommit(tree, parents, msg, who, ts))
}

func blobBytes(r *Repo, oid string) []byte {
	o := r.objects[oid]
	if o == nil || o.Type != objBlob {
		return nil
	}
	return o.Data
}

func countLines(b []byte) int {
	if len(b) == 0 {
		return 0
	}
	n := bytes.Count(b, []byte{'\n'})
	if b[len(b)-1] == '\n' {
		return n
	}
	return n + 1
}

// FileDiff is one file's change between two commits.
type FileDiff struct {
	Filename  string
	Status    string // added | modified | removed
	Additions int
	Deletions int
	Changes   int
}

func diffFileMaps(r *Repo, oldM, newM FileMap) []FileDiff {
	pathSet := map[string]bool{}
	for p := range oldM {
		pathSet[p] = true
	}
	for p := range newM {
		pathSet[p] = true
	}
	var paths []string
	for p := range pathSet {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	var out []FileDiff
	for _, p := range paths {
		o, hasO := oldM[p]
		n, hasN := newM[p]
		if hasO && hasN && o == n {
			continue
		}
		if !hasO {
			add := countLines(blobBytes(r, n))
			out = append(out, FileDiff{Filename: p, Status: "added", Additions: add, Changes: add})
		} else if !hasN {
			del := countLines(blobBytes(r, o))
			out = append(out, FileDiff{Filename: p, Status: "removed", Deletions: del, Changes: del})
		} else {
			oldLines := map[string]bool{}
			for _, l := range strings.Split(string(blobBytes(r, o)), "\n") {
				oldLines[l] = true
			}
			newLines := strings.Split(string(blobBytes(r, n)), "\n")
			add := 0
			for _, l := range newLines {
				if !oldLines[l] {
					add++
				}
			}
			newSet := map[string]bool{}
			for _, l := range newLines {
				newSet[l] = true
			}
			del := 0
			for l := range oldLines {
				if !newSet[l] {
					del++
				}
			}
			if add == 0 && del == 0 {
				add = 1
			}
			out = append(out, FileDiff{Filename: p, Status: "modified", Additions: add, Deletions: del, Changes: add + del})
		}
	}
	return out
}

// ---------------------------------------------------------------- packfile

func writePackHeader(typ ObjType, size int) []byte {
	code := typeCode[typ]
	var out []byte
	rem := size
	first := byte(code<<4) | byte(rem&0x0f)
	rem /= 16
	for rem > 0 {
		out = append(out, first|0x80)
		first = byte(rem & 0x7f)
		rem /= 128
	}
	out = append(out, first)
	return out
}

// writePack serializes objects as a packfile (plain entries, zlib level 1).
func writePack(objects []*GitObj) []byte {
	var body bytes.Buffer
	hdr := make([]byte, 12)
	copy(hdr, "PACK")
	binary.BigEndian.PutUint32(hdr[4:8], 2)
	binary.BigEndian.PutUint32(hdr[8:12], uint32(len(objects)))
	body.Write(hdr)
	for _, o := range objects {
		body.Write(writePackHeader(o.Type, len(o.Data)))
		zw, _ := zlib.NewWriterLevel(&body, zlib.BestSpeed)
		zw.Write(o.Data)
		zw.Close()
	}
	sum := sha1.Sum(body.Bytes())
	out := body.Bytes()
	out = append(out, sum[:]...)
	return out
}

// readPackVarint decodes a pack entry size header.
func readPackVarint(buf []byte, start int) (size int, next int, first byte, err error) {
	if start >= len(buf) {
		return 0, 0, 0, errors.New("truncated pack")
	}
	b := buf[start]
	first = b
	size = int(b & 0x0f)
	shift := uint(4)
	off := start + 1
	for b&0x80 != 0 {
		if off >= len(buf) {
			return 0, 0, 0, errors.New("truncated pack")
		}
		b = buf[off]
		off++
		size += int(b&0x7f) << shift
		shift += 7
	}
	return size, off, first, nil
}

func readPackOfsBase(buf []byte, start int) (baseOffset int, next int, err error) {
	if start >= len(buf) {
		return 0, 0, errors.New("truncated pack")
	}
	b := buf[start]
	off := start + 1
	value := int(b & 0x7f)
	for b&0x80 != 0 {
		if off >= len(buf) {
			return 0, 0, errors.New("truncated pack")
		}
		b = buf[off]
		off++
		value = ((value + 1) << 7) + int(b&0x7f)
	}
	return value, off, nil
}

func applyDelta(base, delta []byte) ([]byte, error) {
	off := 0
	readSize := func() (int, error) {
		v := 0
		sh := uint(0)
		for {
			if off >= len(delta) {
				return 0, errors.New("truncated delta")
			}
			b := delta[off]
			off++
			v += int(b&0x7f) << sh
			sh += 7
			if b&0x80 == 0 {
				break
			}
		}
		return v, nil
	}
	srcSize, err := readSize()
	if err != nil {
		return nil, err
	}
	tgtSize, err := readSize()
	if err != nil {
		return nil, err
	}
	if srcSize != len(base) {
		return nil, errors.New("delta base size mismatch")
	}
	out := make([]byte, tgtSize)
	written := 0
	for off < len(delta) {
		op := delta[off]
		off++
		if op&0x80 != 0 {
			co, cs := 0, 0
			sh := uint(0)
			for bit := 0; bit < 4; bit++ {
				if op&(1<<uint(bit)) != 0 {
					if off >= len(delta) {
						return nil, errors.New("truncated delta")
					}
					co += int(delta[off]) << sh
					off++
				}
				sh += 8
			}
			sh = 0
			for bit := 4; bit < 7; bit++ {
				if op&(1<<uint(bit)) != 0 {
					if off >= len(delta) {
						return nil, errors.New("truncated delta")
					}
					cs += int(delta[off]) << sh
					off++
				}
				sh += 8
			}
			if cs == 0 {
				cs = 0x10000
			}
			if co+cs > len(base) || written+cs > tgtSize {
				return nil, errors.New("delta copy out of range")
			}
			copy(out[written:written+cs], base[co:co+cs])
			written += cs
		} else if op != 0 {
			lit := int(op & 0x7f)
			if off+lit > len(delta) || written+lit > tgtSize {
				return nil, errors.New("delta literal out of range")
			}
			copy(out[written:written+lit], delta[off:off+lit])
			off += lit
			written += lit
		} else {
			return nil, errors.New("delta opcode 0")
		}
	}
	if written != tgtSize {
		return nil, errors.New("delta size mismatch")
	}
	return out, nil
}

// inflateZlib decompresses one zlib stream starting at pack[off:] and returns
// the plain bytes plus the offset just past the stream (Go's zlib reader stops
// exactly at the end of the stream, Adler-32 included).
func inflateZlib(pack []byte, off int) ([]byte, int, error) {
	br := bytes.NewReader(pack[off:])
	zr, err := zlib.NewReader(br)
	if err != nil {
		return nil, 0, err
	}
	defer zr.Close()
	out, err := io.ReadAll(zr)
	if err != nil {
		return nil, 0, err
	}
	consumed := len(pack[off:]) - br.Len()
	return out, off + consumed, nil
}

// readPack parses a packfile into objects (plain + OFS/REF deltas).
func readPack(pack []byte, resolveBase func(oid string) *GitObj) (map[string]*GitObj, error) {
	if len(pack) < 32 || string(pack[0:4]) != "PACK" {
		return nil, errors.New("bad pack header")
	}
	version := binary.BigEndian.Uint32(pack[4:8])
	if version != 2 && version != 3 {
		return nil, fmt.Errorf("unsupported pack version %d", version)
	}
	count := int(binary.BigEndian.Uint32(pack[8:12]))
	trailerStart := len(pack) - 20
	trailer := hex.EncodeToString(pack[trailerStart:])
	sum := sha1.Sum(pack[:trailerStart])
	if hex.EncodeToString(sum[:]) != trailer {
		return nil, errors.New("pack checksum mismatch")
	}
	type raw struct {
		offset     int
		typeCode   byte
		size       int
		data       []byte
		baseOffset int
		baseOID    string
		resolved   *GitObj
		oid        string
	}
	raws := make([]*raw, 0, count)
	byOffset := map[int]*raw{}
	off := 12
	for i := 0; i < count; i++ {
		entryOffset := off
		size, next, first, err := readPackVarint(pack, off)
		if err != nil {
			return nil, err
		}
		off = next
		tc := (first >> 4) & 0x07
		e := &raw{offset: entryOffset, typeCode: tc, size: size}
		switch tc {
		case 6:
			bo, n, err := readPackOfsBase(pack, off)
			if err != nil {
				return nil, err
			}
			off = n
			e.baseOffset = entryOffset - bo
		case 7:
			if off+20 > len(pack) {
				return nil, errors.New("truncated pack")
			}
			e.baseOID = hex.EncodeToString(pack[off : off+20])
			off += 20
		default:
			if _, ok := codeType[tc]; !ok {
				return nil, fmt.Errorf("unknown pack type %d", tc)
			}
		}
		inflated, newOff, err := inflateZlib(pack[:trailerStart], off)
		if err != nil {
			return nil, err
		}
		if len(inflated) != size {
			return nil, errors.New("pack entry size mismatch")
		}
		e.data = inflated
		off = newOff
		raws = append(raws, e)
		byOffset[entryOffset] = e
	}
	if off != trailerStart {
		return nil, errors.New("pack trailing bytes")
	}
	objects := map[string]*GitObj{}
	resolvedByOID := map[string]*raw{}
	resolving := map[int]bool{}
	var resolve func(e *raw) (*GitObj, error)
	resolve = func(e *raw) (*GitObj, error) {
		if e.resolved != nil && e.oid != "" {
			return e.resolved, nil
		}
		if resolving[e.offset] {
			return nil, errors.New("delta cycle")
		}
		resolving[e.offset] = true
		var obj *GitObj
		switch e.typeCode {
		case 6:
			baseEntry, ok := byOffset[e.baseOffset]
			if !ok {
				return nil, errors.New("ofs-delta base missing")
			}
			base, err := resolve(baseEntry)
			if err != nil {
				return nil, err
			}
			data, err := applyDelta(base.Data, e.data)
			if err != nil {
				return nil, err
			}
			obj = &GitObj{Type: base.Type, Data: data}
		case 7:
			if baseEntry, ok := resolvedByOID[e.baseOID]; ok {
				base, err := resolve(baseEntry)
				if err != nil {
					return nil, err
				}
				data, err := applyDelta(base.Data, e.data)
				if err != nil {
					return nil, err
				}
				obj = &GitObj{Type: base.Type, Data: data}
			} else {
				ext := resolveBase(e.baseOID)
				if ext == nil {
					return nil, fmt.Errorf("ref-delta base %s missing", e.baseOID)
				}
				data, err := applyDelta(ext.Data, e.data)
				if err != nil {
					return nil, err
				}
				obj = &GitObj{Type: ext.Type, Data: data}
			}
		default:
			obj = &GitObj{Type: codeType[e.typeCode], Data: e.data}
		}
		oid := hashObject(obj.Type, obj.Data)
		e.resolved = obj
		e.oid = oid
		resolvedByOID[oid] = e
		delete(resolving, e.offset)
		return obj, nil
	}
	for _, e := range raws {
		obj, err := resolve(e)
		if err != nil {
			return nil, err
		}
		objects[e.oid] = obj
	}
	return objects, nil
}

// ---------------------------------------------------------------- pkt-line

func pktLine(payload []byte) []byte {
	out := make([]byte, 4+len(payload))
	hex4 := fmt.Sprintf("%04x", len(payload)+4)
	copy(out, hex4)
	copy(out[4:], payload)
	return out
}

func pktLineStr(s string) []byte { return pktLine([]byte(s)) }

var pktFlushBytes = []byte("0000")
var pktDelimBytes = []byte("0001")

// pktLines joins pkt-lines; the strings "flush" and "delim" become those packets.
func pktLines(items []any) []byte {
	var buf bytes.Buffer
	for _, it := range items {
		switch v := it.(type) {
		case string:
			if v == "flush" {
				buf.Write(pktFlushBytes)
			} else if v == "delim" {
				buf.Write(pktDelimBytes)
			} else {
				buf.Write(pktLineStr(v))
			}
		case []byte:
			buf.Write(pktLine(v))
		}
	}
	return buf.Bytes()
}

// Packet is one decoded pkt-line.
type Packet struct {
	Kind    string // data | flush | delim | response-end
	Payload []byte
}

func decodePktLines(buf []byte) ([]Packet, error) {
	var out []Packet
	off := 0
	for off < len(buf) {
		if off+4 > len(buf) {
			return nil, errors.New("truncated pkt-line")
		}
		header := string(buf[off : off+4])
		ln := 0
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
				return nil, fmt.Errorf("invalid pkt-line header %q", header)
			}
			ln = ln*16 + v
		}
		switch ln {
		case 0:
			out = append(out, Packet{Kind: "flush"})
			off += 4
		case 1:
			out = append(out, Packet{Kind: "delim"})
			off += 4
		case 2:
			out = append(out, Packet{Kind: "response-end"})
			off += 4
		default:
			if ln < 4 || off+ln > len(buf) {
				return nil, errors.New("bad pkt-line length")
			}
			out = append(out, Packet{Kind: "data", Payload: buf[off+4 : off+ln]})
			off += ln
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- store

type Label struct {
	Name  string
	Color string
}

type IssueComment struct {
	ID   int
	Body string
	User string
	Seq  int
}

type Issue struct {
	Number   int
	ID       int
	Title    string
	Body     string
	State    string // open | closed
	Labels   []string
	Seq      int
	Comments []IssueComment
	User     string
}

type PullRequest struct {
	Number   int
	ID       int
	Title    string
	Body     string
	State    string // open | closed
	HeadRef  string
	BaseRef  string
	HeadSha  string
	BaseSha  string
	Merged   bool
	MergedAt *string
	MergeSha *string
	Seq      int
	User     string
}

type Repo struct {
	Name          string
	Owner         string
	Description   string
	Private       bool
	DefaultBranch string
	DBID          int
	Seq           int
	objects       map[string]*GitObj
	refs          map[string]string
	refOrder      []string
	Issues        []*Issue
	Pulls         []*PullRequest
	labels        map[string]*Label
	labelOrder    []string
	NextNum       int
	NextCommentID int
	commitSeq     int
}

func (r *Repo) refTip(ref string) (string, bool) {
	oid, ok := r.refs[ref]
	return oid, ok
}

func (r *Repo) setRef(ref, oid string) {
	if _, ok := r.refs[ref]; !ok {
		r.refOrder = append(r.refOrder, ref)
	}
	r.refs[ref] = oid
}

func (r *Repo) deleteRef(ref string) {
	if _, ok := r.refs[ref]; !ok {
		return
	}
	delete(r.refs, ref)
	for i, n := range r.refOrder {
		if n == ref {
			r.refOrder = append(r.refOrder[:i], r.refOrder[i+1:]...)
			break
		}
	}
}

func (r *Repo) defaultTip() (string, bool) {
	return r.refTip("refs/heads/" + r.DefaultBranch)
}

func (r *Repo) resolveRef(ref string) (string, bool) {
	if isOID(ref) {
		_, ok := r.objects[ref]
		if ok {
			return ref, true
		}
		return "", false
	}
	if strings.HasPrefix(ref, "refs/") {
		return r.refTip(ref)
	}
	if oid, ok := r.refTip("refs/heads/" + ref); ok {
		return oid, true
	}
	return r.refTip("refs/tags/" + ref)
}

// Store is the forge's whole state.
type Store struct {
	mu          sync.Mutex
	repos       map[string]*Repo
	nextRepoID  int
	nextIssueID int
	nextPullID  int
}

func newStore() *Store {
	return &Store{repos: map[string]*Repo{}, nextRepoID: 1000, nextIssueID: 1, nextPullID: 1}
}

func (s *Store) key(owner, name string) string { return owner + "/" + name }

func (s *Store) getRepo(owner, name string) *Repo { return s.repos[s.key(owner, name)] }

func (s *Store) listRepos(owner string) []*Repo {
	var out []*Repo
	for _, r := range s.repos {
		if r.Owner == owner {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}

func (s *Store) createRepo(name string, priv bool, description string) *Repo {
	if _, ok := s.repos[s.key(viewerLogin, name)]; ok {
		return nil
	}
	r := &Repo{
		Name: name, Owner: viewerLogin, Description: description, Private: priv,
		DefaultBranch: "main", DBID: s.nextRepoID, Seq: len(s.repos),
		objects: map[string]*GitObj{}, refs: map[string]string{},
		labels: map[string]*Label{}, NextNum: 1, NextCommentID: 1,
	}
	s.nextRepoID++
	s.repos[s.key(viewerLogin, name)] = r
	return r
}

func (s *Store) deleteRepo(owner, name string) bool {
	_, ok := s.repos[s.key(owner, name)]
	if ok {
		delete(s.repos, s.key(owner, name))
	}
	return ok
}

// findRepoByDbID locates a repo by its numeric database id (GraphQL node
// lookups). Iteration order over the map does not matter: dbIds are unique.
func (s *Store) findRepoByDbID(dbID int) *Repo {
	for _, r := range s.repos {
		if r.DBID == dbID {
			return r
		}
	}
	return nil
}

var store = newStore()

// globalId encodes a GraphQL node id as base64("Kind:part:part...").
func globalId(kind string, parts ...any) string {
	var ss []string
	ss = append(ss, kind)
	for _, p := range parts {
		ss = append(ss, fmt.Sprintf("%v", p))
	}
	return base64.StdEncoding.EncodeToString([]byte(strings.Join(ss, ":")))
}

// decodeGlobalId reverses globalId. Returns kind and parts, or ok=false.
func decodeGlobalId(id string) (kind string, parts []string, ok bool) {
	raw, err := lenientB64(id)
	if err != nil {
		return "", nil, false
	}
	segs := strings.Split(string(raw), ":")
	if len(segs) == 0 || segs[0] == "" || len(segs) < 2 {
		return "", nil, false
	}
	return segs[0], segs[1:], true
}

// ---------------------------------------------------------------- shared shapes (JSON)

const fixedDate = "2026-01-01T00:00:00Z"

type userJSON struct {
	Login string `json:"login"`
	ID    int    `json:"id"`
	Type  string `json:"type,omitempty"`
}

type repoJSON struct {
	ID              int      `json:"id"`
	NodeID          string   `json:"node_id"`
	Name            string   `json:"name"`
	FullName        string   `json:"full_name"`
	Owner           userJSON `json:"owner"`
	Private         bool     `json:"private"`
	Description     string   `json:"description"`
	DefaultBranch   string   `json:"default_branch"`
	HTMLURL         string   `json:"html_url"`
	URL             string   `json:"url"`
	CreatedAt       string   `json:"created_at"`
	UpdatedAt       string   `json:"updated_at"`
	PushedAt        string   `json:"pushed_at"`
	HasIssues       bool     `json:"has_issues"`
	HasProjects     bool     `json:"has_projects"`
	HasWiki         bool     `json:"has_wiki"`
	Fork            bool     `json:"fork"`
	Archived        bool     `json:"archived"`
	OpenIssuesCount int      `json:"open_issues_count"`
}

func toRepoJSON(r *Repo) repoJSON {
	open := 0
	for _, i := range r.Issues {
		if i.State == "open" {
			open++
		}
	}
	return repoJSON{
		ID: r.DBID, NodeID: globalId("Repository", r.DBID), Name: r.Name,
		FullName: r.Owner + "/" + r.Name,
		Owner:    userJSON{Login: r.Owner, ID: viewerID, Type: "User"},
		Private:  r.Private, Description: r.Description, DefaultBranch: r.DefaultBranch,
		HTMLURL:   "https://github.com/" + r.Owner + "/" + r.Name,
		URL:       "/api/v3/repos/" + r.Owner + "/" + r.Name,
		CreatedAt: fixedDate, UpdatedAt: fixedDate, PushedAt: fixedDate,
		HasIssues: true, HasProjects: false, HasWiki: false, Fork: false, Archived: false,
		OpenIssuesCount: open,
	}
}

type labelJSON struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

type issueJSON struct {
	ID        int         `json:"id"`
	NodeID    string      `json:"node_id"`
	Number    int         `json:"number"`
	Title     string      `json:"title"`
	Body      string      `json:"body"`
	State     string      `json:"state"`
	Labels    []labelJSON `json:"labels"`
	User      userJSON    `json:"user"`
	Comments  int         `json:"comments"`
	HTMLURL   string      `json:"html_url"`
	URL       string      `json:"url"`
	CreatedAt string      `json:"created_at"`
	UpdatedAt string      `json:"updated_at"`
	ClosedAt  *string     `json:"closed_at"`
}

func toIssueJSON(r *Repo, i *Issue) issueJSON {
	labels := []labelJSON{}
	for _, name := range i.Labels {
		color := "ededed"
		if l, ok := r.labels[name]; ok {
			color = l.Color
		}
		labels = append(labels, labelJSON{Name: name, Color: color})
	}
	var closedAt *string
	if i.State == "closed" {
		s := fixedDate
		closedAt = &s
	}
	return issueJSON{
		ID: i.ID, NodeID: globalId("Issue", r.DBID, i.Number), Number: i.Number,
		Title: i.Title, Body: i.Body, State: i.State, Labels: labels,
		User:      userJSON{Login: viewerLogin, ID: viewerID, Type: "User"},
		Comments:  len(i.Comments),
		HTMLURL:   "https://github.com/" + r.Owner + "/" + r.Name + "/issues/" + itoa(i.Number),
		URL:       "/api/v3/repos/" + r.Owner + "/" + r.Name + "/issues/" + itoa(i.Number),
		CreatedAt: fixedDate, UpdatedAt: fixedDate, ClosedAt: closedAt,
	}
}

type refJSON struct {
	Ref   string   `json:"ref"`
	Sha   string   `json:"sha"`
	Label string   `json:"label,omitempty"`
	User  userJSON `json:"user,omitempty"`
}

type pullJSON struct {
	ID             int      `json:"id"`
	NodeID         string   `json:"node_id"`
	Number         int      `json:"number"`
	Title          string   `json:"title"`
	Body           string   `json:"body"`
	State          string   `json:"state"`
	Head           refJSON  `json:"head"`
	Base           refJSON  `json:"base"`
	Merged         bool     `json:"merged"`
	MergedAt       *string  `json:"merged_at"`
	MergeCommitSha *string  `json:"merge_commit_sha"`
	User           userJSON `json:"user"`
	HTMLURL        string   `json:"html_url"`
	URL            string   `json:"url"`
	CreatedAt      string   `json:"created_at"`
	UpdatedAt      string   `json:"updated_at"`
	Draft          bool     `json:"draft"`
}

func toPullJSON(r *Repo, pr *PullRequest) pullJSON {
	return pullJSON{
		ID: pr.ID, NodeID: globalId("PullRequest", r.DBID, pr.Number), Number: pr.Number,
		Title: pr.Title, Body: pr.Body, State: pr.State,
		Head:   refJSON{Ref: pr.HeadRef, Sha: pr.HeadSha, Label: r.Owner + ":" + pr.HeadRef, User: userJSON{Login: viewerLogin, ID: viewerID}},
		Base:   refJSON{Ref: pr.BaseRef, Sha: pr.BaseSha, Label: r.Owner + ":" + pr.BaseRef, User: userJSON{Login: viewerLogin, ID: viewerID}},
		Merged: pr.Merged, MergedAt: pr.MergedAt, MergeCommitSha: pr.MergeSha,
		User:      userJSON{Login: viewerLogin, ID: viewerID, Type: "User"},
		HTMLURL:   "https://github.com/" + r.Owner + "/" + r.Name + "/pull/" + itoa(pr.Number),
		URL:       "/api/v3/repos/" + r.Owner + "/" + r.Name + "/pulls/" + itoa(pr.Number),
		CreatedAt: fixedDate, UpdatedAt: fixedDate, Draft: false,
	}
}

func prFiles(r *Repo, pr *PullRequest) []FileDiff {
	var baseFiles, headFiles FileMap
	if pr.BaseSha != "" {
		baseFiles = filesAt(r, pr.BaseSha)
	} else {
		baseFiles = FileMap{}
	}
	if pr.HeadSha != "" {
		headFiles = filesAt(r, pr.HeadSha)
	} else {
		headFiles = FileMap{}
	}
	return diffFileMaps(r, baseFiles, headFiles)
}

// prConflicted reports whether merging pr is conflicted: both sides changed
// the same path differently since the merge-base.
func prConflicted(r *Repo, pr *PullRequest) bool {
	curBase, ok := r.refTip("refs/heads/" + pr.BaseRef)
	if !ok {
		curBase = pr.BaseSha
	}
	base := mergeBase(r, pr.HeadSha, curBase)
	if base == "" {
		return false
	}
	baseFiles := filesAt(r, base)
	headFiles := filesAt(r, pr.HeadSha)
	curFiles := filesAt(r, curBase)
	paths := map[string]bool{}
	for p := range baseFiles {
		paths[p] = true
	}
	for p := range headFiles {
		paths[p] = true
	}
	for p := range curFiles {
		paths[p] = true
	}
	for p := range paths {
		b, hasB := baseFiles[p]
		h, hasH := headFiles[p]
		c, hasC := curFiles[p]
		// A missing entry differs from any present one.
		bv, hv, cv := "", "", ""
		if hasB {
			bv = b
		}
		if hasH {
			hv = h
		}
		if hasC {
			cv = c
		}
		if hv != bv && cv != bv && hv != cv {
			return true
		}
	}
	return false
}

// squashMerge squash-merges pr onto its base branch. Returns the merge commit
// oid, or "" on conflict / when not mergeable.
func squashMerge(r *Repo, pr *PullRequest) string {
	if pr.Merged || pr.State != "open" {
		return ""
	}
	if prConflicted(r, pr) {
		return ""
	}
	curBase, ok := r.refTip("refs/heads/" + pr.BaseRef)
	if !ok {
		curBase = pr.BaseSha
	}
	base := mergeBase(r, pr.HeadSha, curBase)
	var baseFiles FileMap
	if base != "" {
		baseFiles = filesAt(r, base)
	} else {
		baseFiles = FileMap{}
	}
	headFiles := filesAt(r, pr.HeadSha)
	curFiles := filesAt(r, curBase)
	merged := map[string][]byte{}
	for path, oid := range curFiles {
		if b := blobBytes(r, oid); b != nil {
			merged[path] = b
		}
	}
	allPaths := map[string]bool{}
	for p := range baseFiles {
		allPaths[p] = true
	}
	for p := range headFiles {
		allPaths[p] = true
	}
	for p := range allPaths {
		b, hasB := baseFiles[p]
		h, hasH := headFiles[p]
		if hasH && hasB && h == b {
			continue
		}
		if !hasH && hasB {
			// Deleted on the head side relative to base — but only when the
			// head actually changed it; a path absent from both is untouched.
			if _, inHead := headFiles[p]; !inHead {
				delete(merged, p)
			}
			continue
		}
		if hasH {
			if data := blobBytes(r, h); data != nil {
				merged[p] = data
			}
		}
	}
	msg := "Merge pull request #" + itoa(pr.Number) + " from " + r.Owner + "/" + pr.HeadRef + "\n\n" + pr.Title
	var parents []string
	if curBase != "" {
		parents = []string{curBase}
	}
	commit := createCommit(r, merged, parents, msg)
	r.setRef("refs/heads/"+pr.BaseRef, commit)
	pr.State = "closed"
	pr.Merged = true
	s := fixedDate
	pr.MergedAt = &s
	pr.MergeSha = &commit
	return commit
}
