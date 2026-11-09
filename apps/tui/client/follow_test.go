package client

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

func testFollower(c *Client) *Follower {
	return &Follower{Client: c, Interval: time.Millisecond, IdleTimeout: time.Second, ReconnectTimeout: 5 * time.Second, WorkTimeout: 5 * time.Second}
}

func collect(t *testing.T, events <-chan FollowEvent) []FollowEvent {
	t.Helper()
	var out []FollowEvent
	timeout := time.After(10 * time.Second)
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return out
			}
			out = append(out, event)
		case <-timeout:
			t.Fatalf("the follow did not end; events so far: %s", describe(out))
		}
	}
}

// describe writes events as one line each: kind, then the fields that are set.
func describe(events []FollowEvent) string {
	names := []string{"waiting", "delta", "activity", "reply", "turn-error", "working", "report", "approval", "not-continued", "still-working", "joined", "error"}
	var lines []string
	for _, e := range events {
		line := names[e.Kind]
		if e.Title != "" {
			line += " [" + e.Title + "]"
		}
		if e.Status != "" {
			line += " (" + e.Status + ")"
		}
		if e.Indent {
			line += " indent"
		}
		if e.Text != "" {
			line += " " + e.Text
		}
		if e.Reply != nil {
			line += " " + e.Reply.GetText()
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func expect(t *testing.T, got []FollowEvent, want ...string) {
	t.Helper()
	if g, w := describe(got), strings.Join(want, "\n"); g != w {
		t.Fatalf("events:\n%s\nwant:\n%s", g, w)
	}
}

func message(task string) *operatorv1.Message {
	return &operatorv1.Message{TaskId: task, Tag: "lead", Conversation: "default", Status: operatorv1.ReplyStatus_REPLY_STATUS_WAITING}
}

func TestFollowReplyThenWorkSession(t *testing.T) {
	f := &fakeControlPlane{follow: func(_ context.Context, req *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
		if req.GetTag() != "lead" || req.GetTaskId() != "t1" || req.GetAfterSequence() != 0 {
			t.Errorf("request = %v", req)
		}
		return sendAll(stream,
			seq(1, waitingPart("no bound Worker Host provides MCP server notes")),
			seq(2, waitingPart("no bound Worker Host provides MCP server notes")),
			seq(3, deltaPart("Starting ")),
			seq(4, commandPart("", "rg discount", operatorv1.ActivityStatus_ACTIVITY_STATUS_RUNNING)),
			seq(5, commandPart("", "rg discount", operatorv1.ActivityStatus_ACTIVITY_STATUS_COMPLETED)),
			heartbeatPart(),
			seq(6, deltaPart("the fix.")),
			seq(7, finishPart("Started the fix.", running("s1", "Validate percent", "w1"))),
			seq(8, commandPart("s1", "pytest -q", operatorv1.ActivityStatus_ACTIVITY_STATUS_RUNNING)),
			seq(9, changedPart(reported("s1", "Validate percent", "w1", "Fixed it."))),
			seq(10, endPart(reported("s1", "Validate percent", "w1", "Fixed it."))),
		)
	}}
	c := newFake(t, f)
	expect(t, collect(t, testFollower(c).Follow(context.Background(), "lead", message("t1"), nil)),
		"waiting no bound Worker Host provides MCP server notes",
		"delta Starting ",
		"activity · running: rg discount",
		"delta the fix.",
		"reply Started the fix.",
		"working [Validate percent]",
		"activity indent · running: pytest -q",
		"report [Validate percent] (done) Fixed it.",
	)
}

func TestFollowResumesADroppedStream(t *testing.T) {
	var mu sync.Mutex
	var afters []int64
	f := &fakeControlPlane{follow: func(_ context.Context, req *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
		mu.Lock()
		afters = append(afters, req.GetAfterSequence())
		attempt := len(afters)
		mu.Unlock()
		switch attempt {
		case 1:
			if err := sendAll(stream, seq(1, deltaPart("Hel")), seq(2, commandPart("", "ls", operatorv1.ActivityStatus_ACTIVITY_STATUS_RUNNING))); err != nil {
				return err
			}
			return connect.NewError(connect.CodeUnavailable, errors.New("the Control Plane is draining"))
		case 2:
			// The stream closes without its end event, as a proxy dropping it would.
			return sendAll(stream, seq(3, deltaPart("lo")))
		}
		return sendAll(stream, seq(4, finishPart("Hello.")), seq(5, endPart()))
	}}
	c := newFake(t, f)
	expect(t, collect(t, testFollower(c).Follow(context.Background(), "lead", message("t1"), nil)),
		"delta Hel",
		"activity · running: ls",
		"delta lo",
		"reply Hello.",
	)
	if fmt.Sprint(afters) != "[0 2 3]" {
		t.Fatalf("after_sequence per call = %v, want [0 2 3]", afters)
	}
}

func TestFollowAppliesAResentStateOnce(t *testing.T) {
	calls := 0
	f := &fakeControlPlane{follow: func(_ context.Context, req *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
		calls++
		if calls == 1 {
			if err := sendAll(stream,
				seq(1, waitingPart("no Worker Host")),
				seq(2, deltaPart("Partial")),
				seq(3, finishPart("Done.", running("s1", "Fix", "w1"))),
			); err != nil {
				return err
			}
			return connect.NewError(connect.CodeUnavailable, errors.New("restarting"))
		}
		if req.GetAfterSequence() != 3 {
			t.Errorf("after_sequence = %d", req.GetAfterSequence())
		}
		// The restarted Control Plane lost the events and sends the current state again.
		return sendAll(stream,
			seq(40, waitingPart("no Worker Host")),
			seq(41, finishPart("Done.", running("s1", "Fix", "w1"))),
			seq(42, changedPart(running("s1", "Fix", "w1"))),
			seq(43, changedPart(reported("s1", "Fix", "w1", "Fixed."))),
			seq(44, endPart(reported("s1", "Fix", "w1", "Fixed."))),
		)
	}}
	c := newFake(t, f)
	expect(t, collect(t, testFollower(c).Follow(context.Background(), "lead", message("t1"), nil)),
		"waiting no Worker Host",
		"delta Partial",
		"reply Done.",
		"working [Fix]",
		"report [Fix] (done) Fixed.",
	)
}

func TestFollowApprovalContinuesTheWorkSession(t *testing.T) {
	waiting := &operatorv1.WorkSession{Id: "s1", Title: "Push", TaskId: "w1",
		Status:       operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_WAITING,
		Approvals:    []*operatorv1.ApprovalNotice{{RequestId: "apr_1", Text: "May I push to main?"}},
		ReportStatus: operatorv1.ReplyStatus_REPLY_STATUS_REPLIED,
		Report:       &operatorv1.Reply{Text: "Waiting for approval to push."}}
	f := &fakeControlPlane{follow: func(_ context.Context, _ *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
		return sendAll(stream,
			seq(1, finishPart("On it.", running("s1", "Push", "w1"))),
			seq(2, changedPart(waiting)),
			seq(3, changedPart(running("s1", "Push", "w2"))),
			seq(4, changedPart(reported("s1", "Push", "w2", "Pushed."))),
			seq(5, endPart(reported("s1", "Push", "w2", "Pushed."))),
		)
	}}
	c := newFake(t, f)
	expect(t, collect(t, testFollower(c).Follow(context.Background(), "lead", message("t1"), nil)),
		"reply On it.",
		"working [Push]",
		"approval [Push] May I push to main?",
		"report [Push] (waiting for approval) Waiting for approval to push.",
		"working [Push]",
		"report [Push] (done) Pushed.",
	)
}

func TestFollowTurnError(t *testing.T) {
	f := &fakeControlPlane{follow: func(_ context.Context, _ *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
		return sendAll(stream,
			seq(1, &operatorv1.FollowEvent{Part: &operatorv1.FollowEvent_Error{Error: &operatorv1.TurnError{Text: "the Task failed"}}}),
			seq(2, endPart()),
		)
	}}
	c := newFake(t, f)
	expect(t, collect(t, testFollower(c).Follow(context.Background(), "lead", message("t1"), nil)),
		"turn-error Tag lead could not answer: the Task failed")
}

func TestFollowStopsOnARefusal(t *testing.T) {
	calls := 0
	f := &fakeControlPlane{follow: func(context.Context, *operatorv1.FollowMessageRequest, *connect.ServerStream[operatorv1.FollowEvent]) error {
		calls++
		return connect.NewError(connect.CodeNotFound, errors.New("Message t1 was not found"))
	}}
	c := newFake(t, f)
	expect(t, collect(t, testFollower(c).Follow(context.Background(), "lead", message("t1"), nil)),
		"error Message t1 was not found")
	if calls != 1 {
		t.Fatalf("a refusal was retried: %d calls", calls)
	}
}

func TestFollowReconnectsAStreamThatGoesQuiet(t *testing.T) {
	calls := 0
	f := &fakeControlPlane{follow: func(ctx context.Context, _ *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
		calls++
		if calls == 1 {
			if err := sendAll(stream, seq(1, deltaPart("a"))); err != nil {
				return err
			}
			<-ctx.Done()
			return ctx.Err()
		}
		return sendAll(stream, seq(2, finishPart("Done.")), seq(3, endPart()))
	}}
	c := newFake(t, f)
	follower := testFollower(c)
	follower.IdleTimeout = 100 * time.Millisecond
	expect(t, collect(t, follower.Follow(context.Background(), "lead", message("t1"), nil)), "delta a", "reply Done.")
	if calls != 2 {
		t.Fatalf("calls = %d, want a reconnect", calls)
	}
}

func TestFollowStopsAfterTheWorkTimeout(t *testing.T) {
	f := &fakeControlPlane{follow: func(ctx context.Context, _ *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
		if err := sendAll(stream, seq(1, finishPart("On it.", running("s1", "Fix", "w1")))); err != nil {
			return err
		}
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(20 * time.Millisecond):
				if err := stream.Send(heartbeatPart()); err != nil {
					return err
				}
			}
		}
	}}
	c := newFake(t, f)
	follower := testFollower(c)
	follower.WorkTimeout = 150 * time.Millisecond
	expect(t, collect(t, follower.Follow(context.Background(), "lead", message("t1"), nil)),
		"reply On it.",
		"working [Fix]",
		"still-working Tag lead is still working; each report will arrive in the default conversation.",
	)
}

func TestFollowHandsAJoinedMessageToTheRunningTurn(t *testing.T) {
	release := make(chan struct{})
	f := &fakeControlPlane{follow: func(ctx context.Context, req *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
		if req.GetTaskId() == "t1" {
			if err := sendAll(stream, seq(1, deltaPart("Working on both"))); err != nil {
				return err
			}
			<-release
			return sendAll(stream, seq(2, finishPart("Both done.")), seq(3, endPart()))
		}
		return sendAll(stream,
			seq(1, &operatorv1.FollowEvent{Part: &operatorv1.FollowEvent_Joined{Joined: &operatorv1.JoinedTurn{TaskId: "t1"}}}),
			seq(2, deltaPart("Working on both")),
			seq(3, finishPart("Both done.")),
			seq(4, endPart()),
		)
	}}
	c := newFake(t, f)
	follower := testFollower(c)
	first := follower.Follow(context.Background(), "lead", message("t1"), nil)
	if event := <-first; event.Kind != EventDelta {
		t.Fatalf("first event = %+v", event)
	}
	expect(t, collect(t, follower.Follow(context.Background(), "lead", message("t2"), nil)), "joined")
	close(release)
	expect(t, collect(t, first), "reply Both done.")

	// Without a follow of the joined turn, the joined message's own stream shows the reply.
	expect(t, collect(t, follower.Follow(context.Background(), "lead", message("t3"), nil)),
		"joined", "delta Working on both", "reply Both done.")
}

func TestFollowShowsAWithdrawnMessagesOwnTurn(t *testing.T) {
	release := make(chan struct{})
	f := &fakeControlPlane{follow: func(ctx context.Context, req *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
		joined := func(task string) *operatorv1.FollowEvent {
			return &operatorv1.FollowEvent{Part: &operatorv1.FollowEvent_Joined{Joined: &operatorv1.JoinedTurn{TaskId: task}}}
		}
		if req.GetTaskId() == "t1" {
			if err := sendAll(stream, seq(1, deltaPart("Working"))); err != nil {
				return err
			}
			<-release
			return sendAll(stream, seq(2, finishPart("First done.")), seq(3, endPart()))
		}
		return sendAll(stream,
			seq(1, joined("t1")),
			seq(2, deltaPart("Working")),
			// The joined turn ended without reading the message, which runs as its own turn.
			seq(3, joined("")),
			seq(4, deltaPart("Looking at the tests")),
			seq(5, finishPart("Tests pass.")),
			seq(6, endPart()),
		)
	}}
	c := newFake(t, f)
	follower := testFollower(c)
	first := follower.Follow(context.Background(), "lead", message("t1"), nil)
	if event := <-first; event.Kind != EventDelta {
		t.Fatalf("first event = %+v", event)
	}
	expect(t, collect(t, follower.Follow(context.Background(), "lead", message("t2"), nil)),
		"joined", "delta Looking at the tests", "reply Tests pass.")
	close(release)
	expect(t, collect(t, first), "reply First done.")
}

func TestHistoryShowsPastMessagesOldestFirst(t *testing.T) {
	replied := func(task, text string, sessions ...*operatorv1.WorkSession) *operatorv1.Message {
		return &operatorv1.Message{TaskId: task, Text: "ask " + task, Status: operatorv1.ReplyStatus_REPLY_STATUS_REPLIED,
			Reply: &operatorv1.Reply{Presentation: operatorv1.ReplyPresentation_REPLY_PRESENTATION_FINAL_RESULT, Text: text}, WorkSessions: sessions}
	}
	joined := replied("t3", "Both done.")
	joined.JoinedTaskId = "t2"
	failed := replied("t4", "the Task failed")
	failed.Reply.Presentation = operatorv1.ReplyPresentation_REPLY_PRESENTATION_ERROR
	waiting := message("t5")
	waiting.WaitingReason = "no Worker Host"
	// Delivered into t5's turn, which has not answered it yet.
	pending := message("t6")
	pending.JoinedTaskId = "t5"
	// Newest first, as ListMessages returns them.
	items := History("lead", []*operatorv1.Message{pending, waiting, failed, joined, replied("t2", "Both done.", running("s2", "Fix", "w2")), replied("t1", "Hi.", reported("s1", "Look", "w1", "Looked."))})
	var got []string
	for _, item := range items {
		got = append(got, fmt.Sprintf("%s follow=%v\n%s", item.Message.GetTaskId(), item.Follow, describe(item.Events)))
	}
	want := []string{
		"t1 follow=false\nreply Hi.\nworking [Look]\nreport [Look] (done) Looked.",
		"t2 follow=true\nreply Both done.\nworking [Fix]",
		"t3 follow=false\njoined",
		"t4 follow=false\nturn-error Tag lead could not answer: the Task failed",
		"t5 follow=true\nwaiting no Worker Host",
		"t6 follow=true\njoined",
	}
	if strings.Join(got, "\n\n") != strings.Join(want, "\n\n") {
		t.Fatalf("history:\n%s\nwant:\n%s", strings.Join(got, "\n\n"), strings.Join(want, "\n\n"))
	}

	// Following a message from history adds only what changed since.
	f := &fakeControlPlane{follow: func(_ context.Context, _ *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
		return sendAll(stream,
			seq(1, finishPart("Both done.", running("s2", "Fix", "w2"))),
			seq(2, changedPart(reported("s2", "Fix", "w2", "Fixed."))),
			seq(3, endPart(reported("s2", "Fix", "w2", "Fixed."))),
		)
	}}
	c := newFake(t, f)
	expect(t, collect(t, testFollower(c).Follow(context.Background(), "lead", items[1].Message, items[1].Shown)),
		"report [Fix] (done) Fixed.")
}

func TestActivityLine(t *testing.T) {
	tool := &operatorv1.Activity{Detail: &operatorv1.Activity_Tool{Tool: &operatorv1.ToolActivity{Tool: "github.create_pull_request", Status: operatorv1.ActivityStatus_ACTIVITY_STATUS_RUNNING}}}
	retry := &operatorv1.Activity{Detail: &operatorv1.Activity_Retry{Retry: &operatorv1.RetryActivity{Attempt: 2}}}
	unknown := &operatorv1.Activity{Text: "thinking hard"}
	for activity, want := range map[*operatorv1.Activity]string{
		tool:    "· using: github.create_pull_request",
		retry:   "· retrying (Task Attempt 2)",
		unknown: "· thinking hard",
		{}:      "",
	} {
		if got := ActivityLine(activity); got != want {
			t.Errorf("ActivityLine(%v) = %q, want %q", activity, got, want)
		}
	}
}
