package main

import (
	"context"
	"errors"
	"fmt"
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
// checkout) under tmux, in a git checkout holding the work Session's branch, against a fake
// Control Plane serving one earlier message as history, one scripted conversation turn (a
// streamed reply with a command that starts one work Session, which then reports and delivers a
// branch with a pull request), one open Objective, an inbox holding the Objective owner's question
// and an approval request, and one Team with a Workstream post. It expands the work Session,
// shows the branch's diff, opens the pull request with a stand-in for the platform opener, starts
// a new conversation, answers the question and approves the request in place, shows the Team,
// creates an Objective from the command palette and opens the emptied inbox from it.
// It needs tmux, git, node_modules and ./build.sh output, so it runs only with SUPERTAG_TUI_E2E=1:
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
	fakeBranch    = "supertag/session/b3861d05"
	fakePR        = "https://github.com/acme/app/pull/12"
)

func endToEndControlPlane(base, head string) *fakeControlPlane {
	work := workSession("ses-work-1", fakeWorkTitle, fakeWorkTask, "")
	done := workSession("ses-work-1", fakeWorkTitle, fakeWorkTask, fakeReport)
	inbox := coordinationFake()
	return &fakeControlPlane{
		token:      fakeToken,
		tags:       tags("lead", "builder"),
		objectives: func() []*operatorv1.Objective { return []*operatorv1.Objective{billingOverview().GetObjective()} },
		overview:   inbox.overview,
		items:      inbox.items,
		approve:    inbox.approve,
		deny:       inbox.deny,
		answer:     inbox.answer,
		sessions: func(id string) *operatorv1.Session {
			if id != "ses-work-1" {
				return nil
			}
			return delivered(id, fakeWorkTask, fakeBranch, base, head, "main", fakePR)
		},
		taskEvents: func(*operatorv1.ListTaskEventsRequest) []*operatorv1.TaskEvent {
			return []*operatorv1.TaskEvent{
				commandEvent(fakeWorkTask, 1, "c1", "pytest -q tests/test_discount.py", "running"),
				toolEvent(fakeWorkTask, 2, "u1", "github", "create_pull_request"),
			}
		},
		teamList: func() []*operatorv1.Team { return []*operatorv1.Team{billingTeam()} },
		posts: func(*operatorv1.ListWorkstreamPostsRequest) *operatorv1.ListWorkstreamPostsResponse {
			return &operatorv1.ListWorkstreamPostsResponse{
				Posts:    []*operatorv1.WorkstreamPost{{Id: "p1", TeamId: "team-billing", AuthorTagId: "tag-builder", Body: "The fix is on the branch.", Sequence: 1}},
				TagNames: map[string]string{"tag-builder": "builder"},
			}
		},
		history: func(req *operatorv1.ListMessagesRequest) []*operatorv1.Message {
			if req.GetTag() != fakeTag || req.GetConversation() != "default" {
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

	checkout, base, head := gitRepo(t, fakeBranch)
	fake := endToEndControlPlane(base, head)
	server := fake.start(t)

	// The stand-in opener records the address it was given instead of starting a browser.
	bin := t.TempDir()
	opened := filepath.Join(t.TempDir(), "opened")
	for _, name := range []string{"open", "xdg-open"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$SUPERTAG_TUI_OPENED\"\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}

	session := fmt.Sprintf("tuispike-%d", os.Getpid())
	// HOME is a fresh directory so the CLI resolves only the environment's target.
	command := fmt.Sprintf("cd %s && env HOME=%s PATH=%s SUPERTAG_TUI_OPENED=%s SUPERTAG_CONTROL_PLANE=%s SUPERTAG_OPERATOR_TOKEN=%s %s --conditions=development %s; echo supertag exited $?; sleep 60",
		shellQuote(checkout), shellQuote(t.TempDir()), shellQuote(bin+":"+os.Getenv("PATH")), shellQuote(opened), server.URL, fakeToken, shellQuote(tsx), shellQuote(cli))
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
	if fake.badAuth != 0 {
		t.Errorf("%d requests came without the operator token", fake.badAuth)
	}
	if len(fake.sent) != 1 || fake.sent[0].GetText() != fakeQuestion || fake.sent[0].GetConversation() != "default" || fake.sent[0].GetIdempotencyKey() == "" {
		t.Errorf("sent = %v, want one message to the default conversation with an idempotency key", fake.sent)
	}
	if fake.followed[fakeTask] != 1 || len(fake.followed) != 1 {
		t.Errorf("follows = %v, want one of %s", fake.followed, fakeTask)
	}
	fake.mu.Unlock()

	keys := func(keys ...string) { run(append([]string{"send-keys", "-t", session}, keys...)...) }
	waitFor("the branch line", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "Branch "+fakeBranch+"   [d] diff  [o] open")
	})
	keys("Up")
	keys("Up")
	keys("Enter")
	pane = waitFor("the expanded work Session", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "Activity:") && strings.Contains(pane, "· using: github.create_pull_request")
	})
	t.Logf("expanded work Session:\n%s", pane)
	for _, want := range []string{"▾ working: " + fakeWorkTitle, "Session ses-work-1 · Task " + fakeWorkTask + " completed",
		"Pull request " + fakePR + " (ready for review)"} {
		if !strings.Contains(pane, want) {
			t.Errorf("the expanded work Session does not show %q", want)
		}
	}
	keys("d")
	pane = waitFor("the diff", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "Diff · "+fakeBranch) && strings.Contains(pane, "+    if percent > 100:")
	})
	t.Logf("diff:\n%s", pane)
	if strings.Contains(pane, "\x1b[2J") || !strings.Contains(pane, " [2Jtoo much") {
		t.Errorf("the diff's escape sequence was not shown as text")
	}
	keys("o")
	waitFor("the pull request to open", 10*time.Second, func(pane string) bool {
		data, err := os.ReadFile(opened)
		return err == nil && strings.TrimSpace(string(data)) == fakePR && strings.Contains(pane, "Opened "+fakePR)
	})
	// Each escape waits for its effect, so the terminal does not read two as one Alt sequence.
	keys("Escape")
	waitFor("the conversation", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "lead · default") && strings.Contains(pane, "esc back")
	})
	keys("Escape")
	waitFor("the input", 10*time.Second, func(pane string) bool { return strings.Contains(pane, "ctrl+o conversations") })
	keys("C-o")
	waitFor("the conversation list", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "lead · conversations") && strings.Contains(pane, "+ New conversation")
	})
	keys("n")
	keys("-l", "billing-fix")
	keys("Enter")
	waitFor("the new conversation", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "lead · billing-fix") && strings.Contains(pane, "to start the conversation billing-fix")
	})

	waitFor("the rail's Objectives and inbox", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "$41.23/$300") && strings.Contains(pane, "Waiting on you (2)")
	})
	keys("Tab")
	keys("Down")
	keys("Down")
	pane = waitFor("the Objective view", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "Objective obj-billing: working")
	})
	t.Logf("Objective view:\n%s", pane)
	for _, want := range []string{"Budget: $41.23 of $300.00 spent", "Branch supertag/session/b3861d05 in Workspace app",
		`lead asks: "Should 100% stay allowed?"`, "Report: Percentages over 100 now raise."} {
		if !strings.Contains(pane, want) {
			t.Errorf("the Objective view does not show %q", want)
		}
	}

	keys("Down")
	waitFor("the question", 10*time.Second, func(pane string) bool { return strings.Contains(pane, "The owner asks:") })
	keys("Enter")
	keys("-l", "No, cap it at 100.")
	keys("Enter")
	waitFor("the answer to be sent", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "Sent. lead takes your answer") && strings.Contains(pane, "Waiting on you (1)")
	})

	keys("Tab")
	keys("Enter")
	waitFor("the approval request", 10*time.Second, func(pane string) bool { return strings.Contains(pane, "a approve · d deny") })
	keys("a")
	waitFor("the confirmation", 10*time.Second, func(pane string) bool { return strings.Contains(pane, "enter approves this request once") })
	keys("Enter")
	pane = waitFor("the approval", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "Approved once.") && strings.Contains(pane, "Waiting on you (0)")
	})
	t.Logf("after approving:\n%s", pane)

	keys("Tab")
	for range 4 {
		keys("Up")
	}
	for range 3 {
		keys("Down")
	}
	pane = waitFor("the Team view", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "Team billing (team-billing)") && strings.Contains(pane, "The fix is on the branch.")
	})
	t.Logf("Team view:\n%s", pane)
	for _, want := range []string{"Members: lead, builder, deleted Tag tag-gone", "Turns: at most 2 at once across its Objectives"} {
		if !strings.Contains(pane, want) {
			t.Errorf("the Team view does not show %q", want)
		}
	}

	// Moving through the rail selected builder, so the palette's Tag commands are about builder.
	keys("C-k")
	waitFor("the command palette", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "Commands") && strings.Contains(pane, "Create Objective     owned by builder")
	})
	keys("-l", "objective")
	keys("Enter")
	waitFor("the new Objective form", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "New Objective · owned by builder") && strings.Contains(pane, "Teams: billing")
	})
	keys("-l", "Invoices round half-even, with tests")
	keys("Enter")
	keys("-l", "billing")
	keys("Enter")
	keys("-l", "300 USD")
	keys("Enter")
	pane = waitFor("the created Objective", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "Created Objective obj-new.") && strings.Contains(pane, "builder took its first turn as Task task-new.")
	})
	t.Logf("created Objective:\n%s", pane)
	keys("Enter")
	waitFor("the new Objective's view", 10*time.Second, func(pane string) bool {
		return strings.Contains(pane, "Objective · obj-new")
	})
	keys("/")
	waitFor("the command palette", 10*time.Second, func(pane string) bool { return strings.Contains(pane, "Open inbox           0 waiting") })
	keys("-l", "inbox")
	keys("Enter")
	waitFor("the empty inbox", 10*time.Second, func(pane string) bool { return strings.Contains(pane, "Nothing waits on you.") })

	fake.mu.Lock()
	if len(fake.created) != 1 || fake.created[0].GetOutcome() != "Invoices round half-even, with tests" || fake.created[0].GetOwner() != "builder" ||
		fake.created[0].GetTeam() != "billing" || fake.created[0].GetBudget().GetLimitMinor() != 30000 || fake.created[0].GetBudget().GetCurrency() != "USD" {
		t.Errorf("created = %v", fake.created)
	}
	if len(fake.answered) != 1 || fake.answered[0].GetKey() != "question:task-own" || fake.answered[0].GetText() != "No, cap it at 100." {
		t.Errorf("answered = %v", fake.answered)
	}
	if len(fake.approved) != 1 || fake.approved[0].GetId() != "apr-1" {
		t.Errorf("approved = %v", fake.approved)
	}
	if fake.badAuth != 0 {
		t.Errorf("%d requests came without the operator token", fake.badAuth)
	}
	fake.mu.Unlock()
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
