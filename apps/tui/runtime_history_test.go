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
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	rpc "github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

func runtimeModel(t *testing.T) model {
	t.Helper()
	return runtimeModelAt(t, "http://127.0.0.1:1")
}

func runtimeModelAt(t *testing.T, endpoint string) model {
	t.Helper()
	m, err := dialRuntimeV2("test")(t.Context(), client.Target{URL: endpoint, Token: "test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.client.Close)
	m.tags, m.selected = tagList("lead"), 0
	return update(t, m, tea.WindowSizeMsg{Width: 100, Height: 30})
}

func runtimeHistoryMessage(id, text, reply string) *operatorv1.Message {
	return &operatorv1.Message{
		TaskId: id, Tag: "lead", SessionId: "session", Conversation: defaultConversation, Text: text,
		Status: operatorv1.ReplyStatus_REPLY_STATUS_REPLIED, Reply: finalReply(reply),
	}
}

func runtimePage(revision uint64, newestFirst ...*operatorv1.Message) historyMsg {
	return historyMsg{tag: "lead", conversation: defaultConversation, items: client.History("lead", newestFirst), revision: revision}
}

func runtimeConversationWatch(tag, name string) watchMsg {
	return watchMsg{update: client.WatchUpdate{Kind: client.WatchChanged, Change: &operatorv1.WatchChange{
		Kind: operatorv1.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE, Tag: tag, Conversation: name,
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
	m = update(t, m, runtimeConversationWatch("lead", "somewhere-else"))
	if c.historyReload.running {
		t.Fatal("an unrelated conversation should not reload visible history")
	}
	m = update(t, m, runtimeConversationWatch("lead", defaultConversation))
	m = update(t, m, runtimeConversationWatch("lead", defaultConversation))
	if !c.historyReload.running || !c.historyReload.again {
		t.Fatal("repeated notices should coalesce while a history read is running")
	}
	remote := runtimeHistoryMessage("remote", "Sent from desktop", "Answer from desktop")
	local := runtimeHistoryMessage("local", "My submitted turn", "Answer to me")
	// A commit and its Watch notice can both precede the send receipt.
	m = update(t, m, runtimePage(0, local, remote, prior))
	m = update(t, m, sentMsg{tag: "lead", conversation: defaultConversation, message: local})
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
	m = update(t, m, sentMsg{tag: "lead", conversation: defaultConversation, message: local})
	m = update(t, m, runtimePage(0, remote, old))
	if !slices.Equal(c.runtime.order, []string{"old", "local"}) {
		t.Fatalf("stale snapshot changed history: %v", c.runtime.order)
	}
	m = update(t, m, runtimePage(c.runtime.revision, local, remote, old))
	if !slices.Equal(c.runtime.order, []string{"old", "remote", "local"}) {
		t.Fatalf("history did not follow Gateway order: %v", c.runtime.order)
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
	m = update(t, m, historyMsg{tag: "lead", conversation: defaultConversation, err: errors.New("transient read failure")})
	m = update(t, m, pollMsg{})
	if !m.shown().historyReload.running || m.tagReload.running {
		t.Fatal("live Watch should retry a failed history read without polling the whole workspace")
	}
}

func TestRuntimeHistoryReplaysPagesToTheLastAuthoritativeMessage(t *testing.T) {
	reply := func(id string) *v2.ConversationMessage {
		return &v2.ConversationMessage{Conversation: defaultConversation, Task: &v2.Task{
			TaskId: id, TagId: "lead", SessionId: "session", Prompt: id,
			State: v2.TaskState_TASK_STATE_SUCCEEDED, Result: proto.String("Done"),
		}}
	}
	seen := make(chan string, 5)
	handler := connect.NewUnaryHandler(rpc.ConversationsListMessagesProcedure,
		func(_ context.Context, req *connect.Request[v2.ListMessagesRequest]) (*connect.Response[v2.ListMessagesResponse], error) {
			if req.Msg.GetTagId() != "lead" || req.Msg.GetConversation() != defaultConversation {
				t.Errorf("unexpected history scope: %v", req.Msg)
			}
			seen <- req.Msg.GetCursor()
			page := &v2.ListMessagesResponse{}
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
	server := httptest.NewUnstartedServer(handler)
	server.Config.Protocols = new(http.Protocols)
	server.Config.Protocols.SetUnencryptedHTTP2(true)
	server.Start()
	t.Cleanup(server.Close)
	m := runtimeModelAt(t, server.URL)
	m = update(t, m, runtimePage(0, runtimeHistoryMessage("first", "Old request", "Old reply")))
	// A local receipt from the newest page does not change the catch-up boundary.
	m = update(t, m, sentMsg{tag: "lead", conversation: defaultConversation, message: runtimeHistoryMessage("fourth", "Latest", "Done")})
	msg := m.loadHistory("lead", defaultConversation)()
	m = update(t, m, msg)
	if got := m.shown().runtime.order; !slices.Equal(got, []string{"first", "second", "third", "fourth"}) {
		t.Fatalf("history = %v", got)
	}
	if len(seen) != 3 {
		t.Fatalf("loaded %d pages, want three", len(seen))
	}
}

func TestRuntimeHistoryKeepsSessionsSeparate(t *testing.T) {
	m := runtimeModel(t)
	m = update(t, m, runtimePage(0, runtimeHistoryMessage("old", "Old Session", "Old reply")))
	replacement := runtimeHistoryMessage("new", "Current Session", "Current reply")
	replacement.SessionId = "another-session"
	m = update(t, m, runtimePage(0, replacement))
	if got := m.shown().runtime.order; !slices.Equal(got, []string{"new"}) {
		t.Fatalf("messages from an old Session survived its replacement: %v", got)
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
