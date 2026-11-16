package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	"github.com/charmbracelet/x/ansi"
	"google.golang.org/protobuf/proto"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
	rpc "github.com/atemaguer/supertag/sdks/go/runtimev2/runtimev2connect"
)

func runtimeModel(t *testing.T) model {
	t.Helper()
	return runtimeModelAt(t, "http://127.0.0.1:1")
}

func runtimeModelAt(t *testing.T, endpoint string) model {
	t.Helper()
	m, err := dial("test")(t.Context(), client.Target{URL: endpoint, Token: "test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.client.Close)
	m.tags, m.selected = runtimeTestTags(), 0
	return update(t, m, tea.WindowSizeMsg{Width: 100, Height: 30})
}

func runtimeTestTags() []*views.Tag {
	return []*views.Tag{{
		Metadata: &views.Metadata{Id: "lead", Name: "Engineering Lead"},
		Status:   &views.TagStatus{Phase: views.TagPhase_TAG_PHASE_ACTIVE},
	}}
}

func runtimeHistoryMessage(id, text, reply string) *views.Message {
	return &views.Message{
		TaskId: id, Tag: "lead", SessionId: "session", Text: text,
		Status: views.ReplyStatus_REPLY_STATUS_REPLIED, Reply: finalReply(reply),
	}
}

// runtimeConversationID identifies the conversation runtimePage reads.
const runtimeConversationID = "conversation-lead"

func runtimePage(revision uint64, newestFirst ...*views.Message) historyMsg {
	return historyMsg{tag: "lead", items: client.History("lead", newestFirst), conversationID: runtimeConversationID, revision: revision}
}

func runtimeConversationWatch(tag string) watchMsg {
	return watchMsg{update: client.WatchUpdate{Kind: client.WatchChanged, Change: &views.WatchChange{
		Kind: views.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE, Tag: tag,
	}}}
}

func TestRuntimeWatchMergesExternalAndLocalTurnsOnce(t *testing.T) {
	m := runtimeModel(t)
	prior := runtimeHistoryMessage("first", "Previous request", "Previous answer")
	m = update(t, m, runtimePage(0, prior))
	c := m.shown()
	m.input.SetValue("My submitted turn")
	if cmd := m.submit(); cmd == nil || c.runtime.sending != 1 {
		t.Fatal("submitting should start a send")
	}
	m.input.SetValue("Keep this unsent draft")
	m = update(t, m, runtimeConversationWatch("build"))
	if c.historyReload.running {
		t.Fatal("another Tag's conversation should not reload visible history")
	}
	m = update(t, m, runtimeConversationWatch("lead"))
	m = update(t, m, runtimeConversationWatch("lead"))
	if !c.historyReload.running || !c.historyReload.again {
		t.Fatal("repeated notices should coalesce while a history read is running")
	}
	remote := runtimeHistoryMessage("remote", "Sent from desktop", "Answer from desktop")
	local := runtimeHistoryMessage("local", "My submitted turn", "Answer to me")
	// A commit and its Watch notice can both precede the send receipt.
	m = update(t, m, runtimePage(0, local, remote, prior))
	m = update(t, m, sentMsg{tag: "lead", message: local})
	m = update(t, m, runtimePage(0, local, remote, prior))
	if !slices.Equal(c.runtime.order, []string{"first", "remote", "local"}) || c.runtime.sending != 0 {
		t.Fatalf("runtime history = %+v", c.runtime)
	}
	got := ansi.Strip(m.renderConversation())
	for _, text := range []string{"Previous request", "Sent from desktop", "My submitted turn", "Answer to me"} {
		if strings.Count(got, text) != 1 {
			t.Fatalf("%q must occur once in:\n%s", text, got)
		}
	}
	if m.input.Value() != "Keep this unsent draft" {
		t.Fatalf("history changed the draft to %q", m.input.Value())
	}
}

func TestRuntimeHistoryOrdersTheReceiptAfterEarlierExternalTurns(t *testing.T) {
	m := runtimeModel(t)
	old := runtimeHistoryMessage("old", "Old request", "Old reply")
	m = update(t, m, runtimePage(0, old))
	c := m.shown()
	m.reloadShownHistory()
	local := runtimeHistoryMessage("local", "Local request", "Local reply")
	remote := runtimeHistoryMessage("remote", "Earlier remote request", "Remote reply")
	m = update(t, m, sentMsg{tag: "lead", message: local})
	m = update(t, m, runtimePage(0, remote, old))
	if !slices.Equal(c.runtime.order, []string{"old", "local"}) {
		t.Fatalf("stale snapshot changed history: %v", c.runtime.order)
	}
	m = update(t, m, runtimePage(c.runtime.revision, local, remote, old))
	if !slices.Equal(c.runtime.order, []string{"old", "remote", "local"}) {
		t.Fatalf("history did not follow Control Plane order: %v", c.runtime.order)
	}
	newer := runtimeHistoryMessage("new", "New request", "New reply")
	m = update(t, m, runtimePage(c.runtime.revision, newer, local))
	if !slices.Equal(c.runtime.order, []string{"old", "remote", "local", "new"}) {
		t.Fatalf("a rolling page dropped old history: %v", c.runtime.order)
	}
}

func TestRuntimeWatchResyncLossAndUnwatchedOverviewPolling(t *testing.T) {
	m := runtimeModel(t)
	c := m.shown()
	m = update(t, m, watchMsg{update: client.WatchUpdate{Kind: client.WatchResync}})
	if !m.live || !c.historyReload.running {
		t.Fatal("resync should reread visible history")
	}
	c.historyReload = reload{}
	m = update(t, m, watchMsg{update: client.WatchUpdate{Kind: client.WatchLost}})
	if m.live || !c.historyReload.running || !m.polling {
		t.Fatal("disconnect should reread immediately and keep polling")
	}
	m = runtimeModel(t)
	m.live, m.pane, m.objectiveID = true, paneObjective, "objective-1"
	m = update(t, m, pollMsg{})
	if !m.overviewReload.running || m.tagReload.running || !m.polling {
		t.Fatal("live Watch should poll the shown Objective overview without polling the whole workspace")
	}
	m = runtimeModel(t)
	m.live = true
	m = update(t, m, historyMsg{tag: "lead", err: errors.New("transient read failure")})
	m = update(t, m, pollMsg{})
	if !m.shown().historyReload.running || m.tagReload.running {
		t.Fatal("live Watch should retry a failed history read without polling the whole workspace")
	}
}

func TestRuntimeHistoryReplaysPagesToTheLastAuthoritativeMessage(t *testing.T) {
	reply := func(id string) *v2.ConversationMessage {
		session := "session"
		if id == "first" {
			// A conversation's history spans its Sessions.
			session = "earlier-session"
		}
		return &v2.ConversationMessage{Task: &v2.Task{
			TaskId: id, TagId: "lead", SessionId: session, Prompt: id,
			State: v2.TaskState_TASK_STATE_SUCCEEDED, Result: proto.String("Done"),
		}}
	}
	seen := make(chan string, 5)
	handler := connect.NewUnaryHandler(rpc.ConversationsListMessagesProcedure,
		func(_ context.Context, req *connect.Request[v2.ListMessagesRequest]) (*connect.Response[v2.ListMessagesResponse], error) {
			if req.Msg.GetTagId() != "lead" {
				t.Errorf("unexpected history scope: %v", req.Msg)
			}
			seen <- req.Msg.GetCursor()
			page := &v2.ListMessagesResponse{ConversationId: runtimeConversationID}
			switch req.Msg.GetCursor() {
			case "":
				page.Messages, page.NextCursor = []*v2.ConversationMessage{reply("fourth")}, "p1"
			case "p1":
				page.Messages, page.NextCursor = []*v2.ConversationMessage{reply("third")}, "p2"
			case "p2":
				page.Messages, page.NextCursor = []*v2.ConversationMessage{reply("second"), reply("first")}, "unused"
			default:
				return nil, fmt.Errorf("unexpected cursor %q", req.Msg.GetCursor())
			}
			return connect.NewResponse(page), nil
		},
	)
	mux := http.NewServeMux()
	mux.Handle(rpc.ConversationsListMessagesProcedure, handler)
	mux.Handle(rpc.WorkSessionsListProcedure, connect.NewUnaryHandler(rpc.WorkSessionsListProcedure,
		func(_ context.Context, _ *connect.Request[v2.ListWorkSessionsRequest]) (*connect.Response[v2.ListWorkSessionsResponse], error) {
			return connect.NewResponse(&v2.ListWorkSessionsResponse{}), nil
		}))
	handleNegotiation(mux)
	server := httptest.NewUnstartedServer(mux)
	server.Config.Protocols = new(http.Protocols)
	server.Config.Protocols.SetUnencryptedHTTP2(true)
	server.Start()
	t.Cleanup(server.Close)
	m := runtimeModelAt(t, server.URL)
	m = update(t, m, runtimePage(0, runtimeHistoryMessage("first", "Old request", "Old reply")))
	// A local receipt from the newest page does not change the catch-up boundary.
	m = update(t, m, sentMsg{tag: "lead", message: runtimeHistoryMessage("fourth", "Latest", "Done")})
	msg := m.loadHistory("lead")()
	m = update(t, m, msg)
	if got := m.shown().runtime.order; msg.(historyMsg).err != nil || !slices.Equal(got, []string{"first", "second", "third", "fourth"}) {
		t.Fatalf("history = %v, %v", got, msg.(historyMsg).err)
	}
	if len(seen) != 3 {
		t.Fatalf("loaded %d pages, want three", len(seen))
	}
}

func TestRuntimeHistorySpansSessionsUntilTheConversationIsReplaced(t *testing.T) {
	m := runtimeModel(t)
	m = update(t, m, runtimePage(0, runtimeHistoryMessage("old", "Old Session", "Old reply")))
	next := runtimeHistoryMessage("new", "Current Session", "Current reply")
	next.SessionId = "another-session"
	m = update(t, m, runtimePage(0, next))
	if got := m.shown().runtime.order; !slices.Equal(got, []string{"old", "new"}) {
		t.Fatalf("a new Session dropped the conversation's earlier messages: %v", got)
	}
	replaced := runtimePage(0, runtimeHistoryMessage("fresh", "After a reset", "Fresh reply"))
	replaced.conversationID = "conversation-replaced"
	m = update(t, m, replaced)
	if got := m.shown().runtime.order; !slices.Equal(got, []string{"fresh"}) {
		t.Fatalf("messages of a replaced conversation survived: %v", got)
	}
}

func TestRuntimeHistoryReplacesAWithdrawnInputsSourceReply(t *testing.T) {
	m := runtimeModel(t)
	message := runtimeHistoryMessage("follower", "My message", "Previous source reply")
	m = update(t, m, runtimePage(0, message))
	m.shown().runtime.turns["follower"].joined = true
	message = runtimeHistoryMessage("follower", "My message", "Its own reply")
	m = update(t, m, runtimePage(0, message))
	got := ansi.Strip(m.renderConversation())
	if strings.Contains(got, "Previous source reply") || strings.Count(got, "My message") != 1 || strings.Count(got, "Its own reply") != 1 {
		t.Fatalf("withdrawn input history:\n%s", got)
	}
}

func TestRuntimeWorkReportsDeduplicateAcrossFollowHistoryAndLaterContinuation(t *testing.T) {
	m := runtimeModel(t)
	root := runtimeHistoryMessage("root", "Check the release", "I started checking")
	work := &views.WorkSession{Id: "work/check", Title: "Release checks", TaskId: "child-1", Status: views.WorkSessionStatus_WORK_SESSION_STATUS_RUNNING, ReportStatus: views.ReplyStatus_REPLY_STATUS_WAITING}
	root.WorkSessions = []*views.WorkSession{work}
	m = update(t, m, runtimePage(0, root))
	turn := m.shown().runtime.turns["root"]
	if !turn.following {
		t.Fatal("root reply must keep following its unfinished child")
	}
	report := client.FollowEvent{Kind: client.EventReport, WorkSession: work.Id, TaskID: "report-1", Title: work.Title, Status: "done", Text: "First child report"}
	m = update(t, m, followMsg{tag: "lead", taskID: "root", event: report})
	work.Status, work.ReportStatus = views.WorkSessionStatus_WORK_SESSION_STATUS_COMPLETED, views.ReplyStatus_REPLY_STATUS_REPLIED
	work.ReportTaskId, work.Report = "report-1", finalReply(report.Text)
	row := runtimeHistoryMessage("report-1", "", "")
	row.Reply, row.WorkSessions = nil, []*views.WorkSession{work}
	// The report arrives as a separate page while the old root is still followed.
	m = update(t, m, runtimePage(0, row))
	m = update(t, m, followDoneMsg{tag: "lead", taskID: "root"})
	m = update(t, m, runtimePage(0, row, root))
	got := ansi.Strip(m.renderConversation())
	if strings.Count(got, "First child report") != 1 || strings.Count(got, "Check the release") != 1 {
		t.Fatalf("report repeated across root and report row:\n%s", got)
	}
	if m.shown().runtime.head != "report-1" || !slices.Contains(m.shown().runtime.order, "report-1") {
		t.Fatal("rendering a report must preserve its real Task as the pagination head")
	}
	// A future continuation of the same Work Session has a distinct report Task.
	clone := *work
	continued := &clone
	continued.TaskId, continued.ReportTaskId, continued.Report = "child-2", "report-2", finalReply("Second child report")
	row2 := runtimeHistoryMessage("report-2", "", "")
	row2.Reply, row2.WorkSessions = nil, []*views.WorkSession{continued}
	m = update(t, m, runtimePage(0, row2, row))
	got = ansi.Strip(m.renderConversation())
	if strings.Count(got, "First child report") != 1 || strings.Count(got, "Second child report") != 1 {
		t.Fatalf("distinct report Tasks must both appear once:\n%s", got)
	}
}

func TestRuntimeWorkHistoryRecoversReportAfterRootFollowEnds(t *testing.T) {
	m := runtimeModel(t)
	root := runtimeHistoryMessage("root", "Check it", "Started")
	root.WorkSessions = []*views.WorkSession{{Id: "work/check", Title: "Check", TaskId: "child", Status: views.WorkSessionStatus_WORK_SESSION_STATUS_RUNNING, ReportStatus: views.ReplyStatus_REPLY_STATUS_WAITING}}
	m = update(t, m, runtimePage(0, root))
	m = update(t, m, followDoneMsg{tag: "lead", taskID: "root"})
	root.WorkSessions[0].Status = views.WorkSessionStatus_WORK_SESSION_STATUS_COMPLETED
	root.WorkSessions[0].ReportStatus = views.ReplyStatus_REPLY_STATUS_REPLIED
	root.WorkSessions[0].ReportTaskId, root.WorkSessions[0].Report = "report", finalReply("Recovered report")
	m = update(t, m, runtimePage(0, root))
	if got := ansi.Strip(m.renderConversation()); strings.Count(got, "Recovered report") != 1 {
		t.Fatalf("root reply must not hide a later report snapshot:\n%s", got)
	}
}

func TestRailShowsEachConversationFromItsSummaryAndShowingAReplyMarksItRead(t *testing.T) {
	fake := &fakeControlPlane{tags: tags("lead", "builder", "reviewer")}
	fake.conversations = func() []*v2.Conversation {
		return []*v2.Conversation{
			{TagId: "lead", ConversationId: "c-lead", Preview: "Fixed it", PreviewFromTag: true, LatestOrder: 3, ReadOrder: 1, UnreadCount: 2},
			{TagId: "builder", ConversationId: "c-builder", Preview: "Run the tests", LatestOrder: 1, Working: true},
			{TagId: "reviewer", ConversationId: "c-reviewer", Preview: "INTERNAL REPORT INSTRUCTION", LatestOrder: 4,
				LatestWorkSessionReportId: proto.String("work/one")},
		}
	}
	fake.messages = func(tag string) *v2.ListMessagesResponse {
		if tag != "lead" {
			return nil
		}
		task := &v2.Task{TaskId: "fix", TagId: "lead", SessionId: "s2", Prompt: "Fix it",
			State: v2.TaskState_TASK_STATE_SUCCEEDED, Result: proto.String("Fixed it")}
		earlier := &v2.Task{TaskId: "look", TagId: "lead", SessionId: "s1", Prompt: "Look at it",
			State: v2.TaskState_TASK_STATE_SUCCEEDED, Result: proto.String("Looked")}
		return &v2.ListMessagesResponse{ConversationId: "c-lead",
			Messages: []*v2.ConversationMessage{{Task: task, Order: 3}, {Task: earlier, Order: 1}}}
	}
	m := start(t, testModel(t, fake))
	got := screen(m)
	for _, want := range []string{"2 new", "Fixed it", "working", "you: Run the tests", "Work Session report"} {
		if !strings.Contains(got, want) {
			t.Errorf("the rail lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "INTERNAL REPORT INSTRUCTION") {
		t.Errorf("a report turn's instruction shows as your message:\n%s", got)
	}
	if marks := fake.readMarks(); len(marks) != 1 || marks[0].GetTagId() != "lead" || marks[0].GetOrder() != 3 {
		t.Fatalf("marks after showing the latest reply = %v", marks)
	}
	// Until the Control Plane lists the conversation read, rereading it marks nothing again.
	m = run(t, m, tea.Batch(m.reloadConversations(), m.reloadShownHistory()))
	if marks := fake.readMarks(); len(marks) != 1 {
		t.Fatalf("the same reply was marked read again: %v", marks)
	}
}
