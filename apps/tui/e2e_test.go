package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// The end-to-end test runs the built binary through plain `supertag` (the Node CLI from this
// checkout) under tmux, against a fake Control Plane serving one earlier message as history and
// one scripted conversation turn: a streamed reply with a command that starts one work Session,
// which then reports. It needs tmux, node_modules and ./build.sh output, so it runs only with
// SUPERTAG_TUI_E2E=1:
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
	fakeEarlier   = "Which module computes discounts?"
	fakeAnswer    = "The `pricing` module does, in **apply_discount**."
)

func endToEndControlPlane() *fakeControlPlane {
	work := workSession("ses-work-1", fakeWorkTitle, fakeWorkTask, "")
	done := workSession("ses-work-1", fakeWorkTitle, fakeWorkTask, fakeReport)
	return &fakeControlPlane{
		token: fakeToken,
		tags:  func(w http.ResponseWriter) { tagList(w, "lead", "builder") },
		history: func(req *operatorv1.ListMessagesRequest) []*operatorv1.Message {
			if req.GetTag() != fakeTag {
				return nil
			}
			earlier := &operatorv1.Message{TaskId: "task-earlier", Tag: fakeTag, Conversation: "default", Text: fakeEarlier,
				Status: operatorv1.ReplyStatus_REPLY_STATUS_REPLIED, Reply: finalReply(fakeAnswer)}
			return []*operatorv1.Message{earlier}
		},
		send: func(req *operatorv1.SendMessageRequest) *operatorv1.Message {
			return waitingMessage(fakeTask, req.GetText())
		},
		follow: func(ctx context.Context, req *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
			if req.GetTaskId() != fakeTask {
				return connect.NewError(connect.CodeNotFound, errors.New("Message "+req.GetTaskId()+" was not found"))
			}
			replied := waitingMessage(fakeTask, fakeQuestion)
			replied.Status, replied.Reply, replied.WorkSessions = operatorv1.ReplyStatus_REPLY_STATUS_REPLIED, finalReply(fakeReply), []*operatorv1.WorkSession{work}
			reported := waitingMessage(fakeTask, fakeQuestion)
			reported.Status, reported.Reply, reported.WorkSessions = operatorv1.ReplyStatus_REPLY_STATUS_REPLIED, finalReply(fakeReply), []*operatorv1.WorkSession{done}
			events := []*operatorv1.FollowEvent{
				followEvent(0, &operatorv1.Heartbeat{}),
				followEvent(1, &operatorv1.TextDelta{Text: "I've started a work session "}),
				followEvent(2, command("", "pytest -q tests/test_discount.py")),
				followEvent(3, &operatorv1.TextDelta{Text: "to make **apply_discount** reject percentages over 100."}),
				followEvent(4, &operatorv1.Finish{Reply: finalReply(fakeReply), Message: replied}),
				followEvent(5, tool(work.GetId(), "edit_file")),
				followEvent(6, &operatorv1.WorkSessionChanged{WorkSession: done}),
				followEvent(7, &operatorv1.FollowEnd{Message: reported}),
			}
			for _, event := range events {
				if event.GetSequence() != 0 && event.GetSequence() <= req.GetAfterSequence() {
					continue
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(150 * time.Millisecond):
				}
				if err := stream.Send(event); err != nil {
					return err
				}
			}
			return nil
		},
		watch: func(ctx context.Context, _ *operatorv1.WatchRequest, stream *connect.ServerStream[operatorv1.WatchEvent]) error {
			if err := stream.Send(&operatorv1.WatchEvent{ResumeToken: "w1", Event: &operatorv1.WatchEvent_Heartbeat{Heartbeat: &operatorv1.Heartbeat{}}}); err != nil {
				return err
			}
			<-ctx.Done()
			return ctx.Err()
		},
	}
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

	fake := endToEndControlPlane()
	server := fake.start(t)

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

	waitFor("the Tag rail and the history", 30*time.Second, func(pane string) bool {
		return strings.Contains(pane, "builder") && strings.Contains(pane, "connected") && strings.Contains(pane, fakeEarlier)
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
		fakeEarlier,
		"module does, in apply_discount",
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
	if len(fake.sent) != 1 || fake.sent[0].GetText() != fakeQuestion || fake.sent[0].GetConversation() != "default" || fake.sent[0].GetIdempotencyKey() == "" {
		t.Errorf("sent = %v, want one message to the default conversation with an idempotency key", fake.sent)
	}
	if fake.followed[fakeTask] != 1 || len(fake.followed) != 1 {
		t.Errorf("follows = %v, want one of %s", fake.followed, fakeTask)
	}
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
