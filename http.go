// http.go — a minimal HTTP/1.1 server over raw TCP, written for this forge
// only: request-line and header parsing, Content-Length and chunked bodies,
// Expect: 100-continue, keep-alive, and explicit Content-Length replies.
// Using the standard net/http server would drag the TLS and HTTP/2 stacks
// into the binary (several MiB); this one keeps the binary small and the
// hot path short. Only what the suite's clients send is handled.

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"
)

// request is one parsed HTTP request.
type request struct {
	method  string
	rawPath string            // path + query, as sent
	path    string            // raw path (still percent-encoded), no query
	query   string            // raw query string
	headers map[string]string // lower-cased names
	body    []byte
	proto   string // HTTP/1.1 or HTTP/1.0
	need100 bool   // Expect: 100-continue was sent
}

// response is what a handler returns.
type response struct {
	status      int
	contentType string
	extra       map[string]string
	body        []byte
	noBody      bool // 204-style: no body, no Content-Length
	noReqID     bool // the MCP DELETE 204: no request-id header at all
}

var reqCounter int64

func nextReqID() string {
	return "req-" + strconv.FormatInt(atomic.AddInt64(&reqCounter, 1), 10)
}

var shopToken = os.Getenv("MAKEFUN_SHOP_TOKEN")

func authOK(r *request) bool {
	h := r.headers["authorization"]
	if !strings.HasPrefix(h, "Bearer ") {
		return false
	}
	token := h[len("Bearer "):]
	if token == "" {
		return false
	}
	if shopToken != "" {
		return token == shopToken
	}
	return true
}

// jsonBytes marshals v the way the reference does: no HTML escaping, so the
// bytes match Node's JSON.stringify for the same value.
func jsonBytes(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	b := buf.Bytes()
	// Encoder appends a newline; strip it.
	if len(b) > 0 && b[len(b)-1] == '\n' {
		b = b[:len(b)-1]
	}
	return b
}

func jsonResp(status int, body any, extra map[string]string) response {
	return response{status: status, contentType: "application/json", extra: extra, body: jsonBytes(body)}
}

func errResp(status int, message string) response {
	return jsonResp(status, map[string]any{"message": message}, nil)
}

// readJSONBody parses a request body as JSON; an empty body is {}.
// Numbers decode as float64, exactly like JavaScript's JSON.parse.
func readJSONBody(body []byte) (map[string]any, bool) {
	if len(body) == 0 {
		return map[string]any{}, true
	}
	var v any
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	m, ok := v.(map[string]any)
	if !ok {
		// A valid JSON body that is not an object: the reference treats it as
		// a parsed value and its handlers read fields off it as an object.
		// Keep the same shape the reference's callers see: an empty object.
		return map[string]any{}, true
	}
	return m, true
}

// parseJSONRaw parses a body the way JSON.parse does: an empty body is an
// error (JSON.parse(”) throws), and the value is returned as-is (object,
// array, scalar or null). Numbers decode as float64.
func parseJSONRaw(body []byte) (any, bool) {
	if len(body) == 0 {
		return nil, false
	}
	var v any
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	return v, true
}

// jsonGetString reads a string field from a decoded JSON object.
func jsonGetString(m map[string]any, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func jsonGetBool(m map[string]any, key string) bool {
	if v, ok := m[key]; ok {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return false
}

func jsonGetNumber(m map[string]any, key string) (float64, bool) {
	if v, ok := m[key]; ok {
		switch n := v.(type) {
		case json.Number:
			f, err := n.Float64()
			return f, err == nil
		case float64:
			return n, true
		}
	}
	return 0, false
}

// parseQuery parses a raw query string into a map (first value wins).
func parseQuery(q string) map[string]string {
	out := map[string]string{}
	for _, pair := range strings.Split(q, "&") {
		if pair == "" {
			continue
		}
		k, v, _ := strings.Cut(pair, "=")
		k = percentDecode(k)
		if _, ok := out[k]; !ok {
			out[k] = percentDecode(v)
		}
	}
	return out
}

func percentDecode(s string) string {
	if !strings.Contains(s, "%") && !strings.Contains(s, "+") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '%' && i+2 < len(s) {
			hi := hexVal(s[i+1])
			lo := hexVal(s[i+2])
			if hi >= 0 && lo >= 0 {
				b.WriteByte(byte(hi<<4 | lo))
				i += 2
				continue
			}
		}
		if c == '+' {
			b.WriteByte(' ')
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

func hexVal(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

// percentDecodeStrict decodes a path segment; on a bad escape it reports an
// error (the caller decides whether to fall back or fail).
func percentDecodeStrict(s string) (string, error) {
	if !strings.Contains(s, "%") {
		return s, nil
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '%' {
			if i+2 >= len(s) {
				return "", errors.New("bad escape")
			}
			hi := hexVal(s[i+1])
			lo := hexVal(s[i+2])
			if hi < 0 || lo < 0 {
				return "", errors.New("bad escape")
			}
			b.WriteByte(byte(hi<<4 | lo))
			i += 2
			continue
		}
		b.WriteByte(c)
	}
	// decodeURIComponent also rejects sequences that are not valid UTF-8.
	if !utf8.ValidString(b.String()) {
		return "", errors.New("bad escape")
	}
	return b.String(), nil
}

// decodeSegment decodes one path segment, falling back to the raw text on a
// bad escape (the reference's outer segment decode does the same).
func decodeSegment(s string) string {
	if d, err := percentDecodeStrict(s); err == nil {
		return d
	}
	return s
}

// jsParseInt parses like JavaScript's parseInt: optional sign, leading
// digits, stop at the first non-digit; NaN becomes the fallback.
func jsParseInt(s string, fallback int) int {
	i := 0
	// JS parseInt skips leading whitespace.
	for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\v' || s[i] == '\f' || s[i] == '\r') {
		i++
	}
	neg := false
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		neg = s[i] == '-'
		i++
	}
	start := i
	v := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		v = v*10 + int(s[i]-'0')
		i++
	}
	if i == start {
		return fallback
	}
	if neg {
		v = -v
	}
	return v
}

// ---------------------------------------------------------------- transport

const maxBodyBytes = 64 * 1024 * 1024

// readRequest reads one request from br. It returns io.EOF when the client
// closed the connection cleanly before a request line.
func readRequest(br *bufio.Reader) (*request, error) {
	line, err := br.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimRight(line, "\r\n")
	parts := strings.SplitN(line, " ", 3)
	if len(parts) != 3 {
		return nil, errors.New("bad request line")
	}
	r := &request{
		method:  parts[0],
		rawPath: parts[1],
		proto:   parts[2],
		headers: map[string]string{},
	}
	if i := strings.Index(r.rawPath, "?"); i >= 0 {
		r.path, r.query = r.rawPath[:i], r.rawPath[i+1:]
	} else {
		r.path = r.rawPath
	}
	for {
		hline, err := br.ReadString('\n')
		if err != nil {
			return nil, err
		}
		hline = strings.TrimRight(hline, "\r\n")
		if hline == "" {
			break
		}
		name, value, ok := strings.Cut(hline, ":")
		if !ok {
			continue
		}
		name = strings.ToLower(strings.TrimSpace(name))
		value = strings.TrimSpace(value)
		if _, exists := r.headers[name]; !exists {
			r.headers[name] = value
		}
	}
	// Expect: 100-continue — answered before the body is read.
	if strings.EqualFold(r.headers["expect"], "100-continue") {
		r.need100 = true
	}
	return r, nil
}

// readBody reads the request body (Content-Length or chunked). The caller
// must have answered 100-continue first when it was requested.
func readBody(br *bufio.Reader, r *request) ([]byte, error) {
	te := strings.ToLower(r.headers["transfer-encoding"])
	if strings.Contains(te, "chunked") {
		var out []byte
		for {
			sizeLine, err := br.ReadString('\n')
			if err != nil {
				return nil, err
			}
			sizeLine = strings.TrimRight(sizeLine, "\r\n")
			if i := strings.IndexByte(sizeLine, ';'); i >= 0 {
				sizeLine = sizeLine[:i]
			}
			sizeLine = strings.TrimSpace(sizeLine)
			n, err := strconv.ParseInt(sizeLine, 16, 64)
			if err != nil || n < 0 {
				return nil, errors.New("bad chunk size")
			}
			if n == 0 {
				// Trailers until an empty line.
				for {
					t, err := br.ReadString('\n')
					if err != nil {
						return nil, err
					}
					if strings.TrimRight(t, "\r\n") == "" {
						break
					}
				}
				return out, nil
			}
			if int64(len(out))+n > maxBodyBytes {
				return nil, errors.New("body too large")
			}
			chunk := make([]byte, n)
			if _, err := io.ReadFull(br, chunk); err != nil {
				return nil, err
			}
			out = append(out, chunk...)
			// Trailing CRLF after the chunk.
			if _, err := br.ReadString('\n'); err != nil {
				return nil, err
			}
		}
	}
	cl := r.headers["content-length"]
	if cl == "" {
		return nil, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(cl))
	if err != nil || n < 0 {
		return nil, errors.New("bad content-length")
	}
	if n > maxBodyBytes {
		return nil, errors.New("body too large")
	}
	if n == 0 {
		return nil, nil
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(br, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// writeResponse serializes one response onto the connection.
func writeResponse(w *bufio.Writer, resp response, reqID string, keepAlive bool) error {
	var b strings.Builder
	b.WriteString("HTTP/1.1 ")
	b.WriteString(strconv.Itoa(resp.status))
	b.WriteString(" ")
	b.WriteString(statusText(resp.status))
	b.WriteString("\r\n")
	if resp.contentType != "" {
		b.WriteString("Content-Type: " + resp.contentType + "\r\n")
	}
	if !resp.noReqID {
		b.WriteString("X-GitHub-Request-Id: " + reqID + "\r\n")
	}
	for k, v := range resp.extra {
		b.WriteString(k + ": " + v + "\r\n")
	}
	if !resp.noBody {
		b.WriteString("Content-Length: " + strconv.Itoa(len(resp.body)) + "\r\n")
	}
	if !keepAlive {
		b.WriteString("Connection: close\r\n")
	}
	b.WriteString("\r\n")
	if _, err := w.WriteString(b.String()); err != nil {
		return err
	}
	if !resp.noBody && len(resp.body) > 0 {
		if _, err := w.Write(resp.body); err != nil {
			return err
		}
	}
	return w.Flush()
}

func statusText(code int) string {
	switch code {
	case 200:
		return "OK"
	case 201:
		return "Created"
	case 202:
		return "Accepted"
	case 204:
		return "No Content"
	case 400:
		return "Bad Request"
	case 401:
		return "Unauthorized"
	case 404:
		return "Not Found"
	case 405:
		return "Method Not Allowed"
	case 409:
		return "Conflict"
	case 422:
		return "Unprocessable Entity"
	case 500:
		return "Internal Server Error"
	default:
		return "Status"
	}
}

// serveConn handles one TCP connection for its whole keep-alive life.
// mu serializes dispatch: the store is a plain in-memory structure.
// Read-only requests take a shared lock so concurrent clones and GETs run
// in parallel; mutating requests take the exclusive lock.
func serveConn(conn net.Conn, mu *sync.RWMutex) {
	defer conn.Close()
	// Disable Nagle: the suite's client sends a small request and waits for
	// a small response, and a delayed second segment would add a round
	// trip. Node's server sets this by default; Go does not.
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	br := bufio.NewReader(conn)
	bw := bufio.NewWriter(conn)
	for {
		req, err := readRequest(br)
		if err != nil {
			return
		}
		// 100-continue is answered before the body is read.
		if req.need100 {
			if _, err := bw.WriteString("HTTP/1.1 100 Continue\r\n\r\n"); err != nil {
				return
			}
			if err := bw.Flush(); err != nil {
				return
			}
		}
		body, err := readBody(br, req)
		if err != nil {
			return
		}
		req.body = body
		keepAlive := true
		connHdr := strings.ToLower(req.headers["connection"])
		if strings.Contains(connHdr, "close") {
			keepAlive = false
		} else if req.proto == "HTTP/1.0" && !strings.Contains(connHdr, "keep-alive") {
			keepAlive = false
		}
		var resp response
		var reqID string
		if requestIsReadOnly(req) {
			mu.RLock()
			resp, reqID = dispatch(req)
			mu.RUnlock()
		} else {
			mu.Lock()
			resp, reqID = dispatch(req)
			mu.Unlock()
		}
		if err := writeResponse(bw, resp, reqID, keepAlive); err != nil {
			return
		}
		if !keepAlive {
			return
		}
	}
}
