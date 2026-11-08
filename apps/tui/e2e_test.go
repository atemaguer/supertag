package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// The end-to-end test runs the built binary through plain `supertag` (the Node CLI from this
// checkout) under tmux, against a fake Control Plane serving one scripted conversation turn: a
// streamed reply with an activity part that starts one work Session, which then reports. It needs
// tmux, node_modules and ./build.sh output, so it runs only with SUPERTAG_TUI_E2E=1:
//
//	SUPERTAG_TUI_E2E=1 go test -run TestEndToEnd -v .
const (
	fakeToken     = "test"
	fakeTag       = "lead"
	fakeTask      = "task-reply-1"
	fakeWorkTask  = "task-work-1"
	fakeWorkTitle = "Validate apply_discount percent range"
	fakeReply     = "I've started a work session to make **apply_discount** reject percentages over 100."
	fakeReport    = "apply_discount now raises a ValueError for percentages over 100. Branch supertag/session/b3861d05."
	fakeQuestion  = "Does apply_discount accept percentages over 100?"
)

// fakeControlPlane serves GET /api/v1/tags and the Tag conversation routes for one turn.
type fakeControlPlane struct {
	mu        sync.Mutex
	sent      []map[string]string
	badAuth   int
	replied   bool
	reported  bool
	streamed  map[string]int
	lastEvent map[string]string
}

func newFakeControlPlane() *fakeControlPlane {
	return &fakeControlPlane{streamed: map[string]int{}, lastEvent: map[string]string{}}
}

func (f *fakeControlPlane) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("authorization") != "Bearer "+fakeToken {
		f.mu.Lock()
		f.badAuth++
		f.mu.Unlock()
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized", "message": "The operator token is not valid."})
		return
	}
	messages := "/api/v1/tags/" + fakeTag + "/messages"
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/tags":
		writeJSON(w, http.StatusOK, map[string]any{
			"apiVersion": "supertag.dev/v1", "kind": "ResourceList",
			"metadata": map[string]string{"resourceVersion": "1"},
			"items":    []any{fakeTagResource("lead"), fakeTagResource("builder")},
		})
	case r.Method == http.MethodPost && r.URL.Path == messages:
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"message": "The body is not JSON."})
			return
		}
		f.mu.Lock()
		f.sent = append(f.sent, body)
		f.mu.Unlock()
		writeJSON(w, http.StatusAccepted, f.record())
	case r.Method == http.MethodGet && r.URL.Path == messages+"/"+fakeTask:
		writeJSON(w, http.StatusOK, f.record())
	case r.Method == http.MethodGet && r.URL.Path == messages+"/"+fakeTask+"/stream":
		f.stream(w, r, fakeTask, []string{
			`{"type":"start"}`,
			`{"type":"text-start","id":"t1"}`,
			`{"type":"text-delta","id":"t1","delta":"I've started a work session "}`,
			`{"type":"data-activity","data":{"kind":"command","status":"running","command":"pytest -q tests/test_discount.py"}}`,
			`{"type":"text-delta","id":"t1","delta":"to make **apply_discount** reject percentages over 100."}`,
			`{"type":"text-end","id":"t1"}`,
			fmt.Sprintf(`{"type":"finish","messageMetadata":{"reply":{"presentation":"markdown","text":%q}}}`, fakeReply),
		}, func() { f.replied = true })
	case r.Method == http.MethodGet && r.URL.Path == messages+"/"+fakeWorkTask+"/stream":
		f.stream(w, r, fakeWorkTask, []string{
			`{"type":"start"}`,
			`{"type":"data-activity","data":{"kind":"tool","status":"running","tool":"edit_file"}}`,
			`{"type":"finish","messageMetadata":{"reply":{"presentation":"markdown","text":"Done."}}}`,
		}, func() { f.reported = true })
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "No route for " + r.Method + " " + r.URL.Path + "."})
	}
}

func fakeTagResource(name string) map[string]any {
	return map[string]any{
		"apiVersion": "supertag.dev/v1", "kind": "Tag",
		"metadata": map[string]string{"name": name},
		"spec":     map[string]any{"roles": []string{}, "workerHosts": []string{}},
		"status":   map[string]any{"phase": "active", "locations": []any{}},
	}
}

// record is the TagMessage record for the one turn, as far as the script has got.
func (f *fakeControlPlane) record() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	record := map[string]any{
		"apiVersion": "supertag.dev/v1", "kind": "TagMessage",
		"tag": fakeTag, "session": "default", "sessionId": "ses-default", "taskId": fakeTask,
		"status": "waiting",
	}
	if !f.replied {
		return record
	}
	record["status"] = "replied"
	record["reply"] = map[string]string{"presentation": "markdown", "text": fakeReply}
	work := map[string]any{
		"id": "ses-work-1", "title": fakeWorkTitle, "taskId": fakeWorkTask,
		"status": "running", "reportStatus": "waiting",
	}
	if f.reported {
		work["status"] = "completed"
		work["reportStatus"] = "replied"
		work["reportTaskId"] = "task-report-1"
		work["report"] = map[string]string{"presentation": "markdown", "text": fakeReport}
	}
	record["startedSessions"] = []any{work}
	return record
}

// stream sends parts as Server-Sent Events, a keepalive first and a pause between parts, then
// runs done and ends with [DONE].
func (f *fakeControlPlane) stream(w http.ResponseWriter, r *http.Request, task string, parts []string, done func()) {
	f.mu.Lock()
	f.streamed[task]++
	f.lastEvent[task] = r.Header.Get("last-event-id")
	f.mu.Unlock()
	flusher, _ := w.(http.Flusher)
	w.Header().Set("content-type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, ": keepalive\n\n")
	flusher.Flush()
	for i, part := range parts {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(150 * time.Millisecond):
		}
		fmt.Fprintf(w, "id: %d\ndata: %s\n\n", i, part)
		flusher.Flush()
	}
	f.mu.Lock()
	done()
	f.mu.Unlock()
	fmt.Fprint(w, "data: [DONE]\n\n")
	flusher.Flush()
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func TestEndToEnd(t *testing.T) {
	if os.Getenv("SUPERTAG_TUI_E2E") != "1" {
		t.Skip("set SUPERTAG_TUI_E2E=1 to run the TUI under tmux through supertag")
	}
	tmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Fatal("tmux is not installed")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	tsx := filepath.Join(root, "node_modules", ".bin", "tsx")
	cli := filepath.Join(root, "apps", "cli", "src", "index.ts")
	binary := filepath.Join("dist", fmt.Sprintf("supertag-tui-%s-%s", runtime.GOOS, runtime.GOARCH))
	for _, path := range []string{tsx, cli, binary} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("%s is missing; run pnpm install and ./build.sh first", path)
		}
	}

	fake := newFakeControlPlane()
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)

	session := fmt.Sprintf("tuispike-%d", os.Getpid())
	// HOME is a fresh directory so the CLI resolves only the environment's target.
	command := fmt.Sprintf("env HOME=%s SUPERTAG_CONTROL_PLANE=%s SUPERTAG_OPERATOR_TOKEN=%s %s --conditions=development %s; echo supertag exited $?; sleep 60",
		shellQuote(t.TempDir()), server.URL, fakeToken, shellQuote(tsx), shellQuote(cli))
	run := func(args ...string) string {
		t.Helper()
		out, err := exec.Command(tmux, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("tmux %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return string(out)
	}
	run("new-session", "-d", "-s", session, "-x", "160", "-y", "45", command)
	t.Cleanup(func() { _ = exec.Command(tmux, "kill-session", "-t", session).Run() })

	capture := func() string { return run("capture-pane", "-p", "-t", session) }
	waitFor := func(what string, timeout time.Duration, ok func(string) bool) string {
		t.Helper()
		deadline := time.Now().Add(timeout)
		for {
			pane := capture()
			if ok(pane) {
				return pane
			}
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s; the pane shows:\n%s", what, pane)
			}
			time.Sleep(200 * time.Millisecond)
		}
	}

	waitFor("the Tag rail", 30*time.Second, func(pane string) bool {
		return strings.Contains(pane, "builder") && strings.Contains(pane, "connected")
	})
	run("send-keys", "-t", session, "-l", fakeQuestion)
	run("send-keys", "-t", session, "Enter")
	pane := waitFor("the work Session report", 30*time.Second, func(pane string) bool {
		return strings.Contains(pane, "ValueError")
	})
	// Let the follower settle and the screen redraw once more.
	time.Sleep(1500 * time.Millisecond)
	pane = capture()
	t.Logf("captured pane:\n%s", pane)

	for _, want := range []string{
		"lead · default",
		fakeQuestion,
		"reject percentages over 100",
		"· running: pytest -q tests/test_discount.py",
		"· working: " + fakeWorkTitle,
		"· using: edit_file",
		"· done: " + fakeWorkTitle,
		"apply_discount now raises a ValueError",
	} {
		if !strings.Contains(pane, want) {
			t.Errorf("the pane does not show %q", want)
		}
	}
	if strings.Contains(pane, "**") {
		t.Errorf("the reply's markdown was not rendered")
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.badAuth != 0 {
		t.Errorf("%d requests came without the operator token", fake.badAuth)
	}
	if len(fake.sent) != 1 || fake.sent[0]["text"] != fakeQuestion || fake.sent[0]["session"] != "default" || len(fake.sent[0]) != 2 {
		t.Errorf("sent bodies = %v, want one {text, session: default}", fake.sent)
	}
	if fake.streamed[fakeTask] != 1 || fake.streamed[fakeWorkTask] != 1 {
		t.Errorf("streams opened = %v, want one per Task", fake.streamed)
	}
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
