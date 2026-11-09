package main

import (
	"context"
	"strings"
	"sync"
	"testing"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

func TestSwitchingAndStartingConversations(t *testing.T) {
	var mu sync.Mutex
	var asked []string
	fake := &fakeControlPlane{
		tags: tags("lead", "builder"),
		open: func() []*operatorv1.Conversation {
			return []*operatorv1.Conversation{
				{Tag: "lead", Name: "billing", LastMessageText: "Done.\nMore", LastMessageAuthor: operatorv1.ConversationAuthor_CONVERSATION_AUTHOR_TAG, OpenWorkSessionCount: 1},
				{Tag: "lead", Name: "default", LastMessageText: "hello", LastMessageAuthor: operatorv1.ConversationAuthor_CONVERSATION_AUTHOR_OPERATOR},
				{Tag: "builder", Name: "other"},
			}
		},
		history: func(req *operatorv1.ListMessagesRequest) []*operatorv1.Message {
			mu.Lock()
			asked = append(asked, req.GetTag()+"/"+req.GetConversation())
			mu.Unlock()
			if req.GetConversation() == "billing" {
				return []*operatorv1.Message{{TaskId: "tb", Tag: "lead", Conversation: "billing", Text: "Bill it",
					Status: operatorv1.ReplyStatus_REPLY_STATUS_REPLIED, Reply: finalReply("Billed.")}}
			}
			return nil
		},
		send: func(req *operatorv1.SendMessageRequest) *operatorv1.Message {
			return &operatorv1.Message{TaskId: "tn", Tag: "lead", Conversation: req.GetConversation(), Text: req.GetText(),
				Status: operatorv1.ReplyStatus_REPLY_STATUS_REPLIED, Reply: finalReply("Hi.")}
		},
		follow: func(_ context.Context, req *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
			return stream.Send(followEvent(1, &operatorv1.FollowEnd{Message: &operatorv1.Message{TaskId: req.GetTaskId()}}))
		},
	}
	m := start(t, testModel(t, fake))
	m.input.SetValue("half-typed")
	m = press(t, m, tea.KeyPressMsg{Code: 'o', Mod: tea.ModCtrl})
	got := screen(m)
	if m.pane != paneConversations || !strings.Contains(got, "lead · conversations") {
		t.Fatalf("ctrl+o did not list the conversations:\n%s", got)
	}
	for _, want := range []string{"billing  1 open  lead: Done.", "default  (shown)  you: hello", "+ New conversation"} {
		if !strings.Contains(got, want) {
			t.Errorf("the list lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "other") {
		t.Errorf("the list shows another Tag's conversation:\n%s", got)
	}
	if last := fake.conversationLists[len(fake.conversationLists)-1]; last != "lead" {
		t.Errorf("ListConversations asked for %q, want lead", last)
	}

	m = press(t, m, key(tea.KeyUp), key(tea.KeyEnter))
	got = screen(m)
	if m.pane != paneConversation || !strings.Contains(got, "lead · billing") || !strings.Contains(got, "Billed.") {
		t.Fatalf("enter did not switch to billing:\n%s", got)
	}
	if m.input.Value() != "" {
		t.Errorf("billing shows the default conversation's draft %q", m.input.Value())
	}

	m = press(t, m, tea.KeyPressMsg{Code: 'o', Mod: tea.ModCtrl}, letter('n'))
	if !m.inputShown() || !strings.Contains(screen(m), "Name the new conversation") {
		t.Fatalf("n did not ask for a name:\n%s", screen(m))
	}
	m.input.SetValue("not a name!")
	m = press(t, m, key(tea.KeyEnter))
	if m.pane != paneConversations || !strings.Contains(screen(m), "A conversation name is 1 to 64") {
		t.Fatalf("a bad name was not refused:\n%s", screen(m))
	}
	m.input.SetValue("release-1")
	m = press(t, m, key(tea.KeyEnter))
	if got := screen(m); !strings.Contains(got, "lead · release-1") || !strings.Contains(got, "to start the conversation release-1") {
		t.Fatalf("the new conversation is not shown:\n%s", got)
	}
	m.input.SetValue("First message")
	m = press(t, m, key(tea.KeyEnter))
	if n := len(fake.sent); n != 1 || fake.sent[0].GetConversation() != "release-1" {
		t.Fatalf("sent = %v, want one message to release-1", fake.sent)
	}

	m = press(t, m, tea.KeyPressMsg{Code: 'o', Mod: tea.ModCtrl})
	if !strings.Contains(screen(m), "release-1  (shown)") {
		t.Fatalf("the shown conversation is not listed:\n%s", screen(m))
	}
	for range 4 {
		m = press(t, m, key(tea.KeyUp))
	}
	m = press(t, m, key(tea.KeyDown), key(tea.KeyEnter))
	if !strings.Contains(screen(m), "lead · default") || m.input.Value() != "half-typed" {
		t.Fatalf("back on default: input %q\n%s", m.input.Value(), screen(m))
	}
	mu.Lock()
	if strings.Join(asked, " ") != "lead/default lead/billing lead/release-1" {
		t.Errorf("history loads = %v, want one per conversation", asked)
	}
	mu.Unlock()

	m = press(t, m, tea.KeyPressMsg{Code: 'o', Mod: tea.ModCtrl}, key(tea.KeyEscape))
	if m.pane != paneConversation {
		t.Fatal("esc should leave the list")
	}
	if _, cmd := m.Update(key(tea.KeyEscape)); cmd == nil || cmd() != tea.Quit() {
		t.Fatal("esc in the conversation should quit")
	}
}

func TestTheRailCountsTheShownConversationsOpenWork(t *testing.T) {
	fake := &fakeControlPlane{
		tags: tags("lead"),
		open: func() []*operatorv1.Conversation {
			return []*operatorv1.Conversation{{Tag: "lead", Name: "default"}, {Tag: "lead", Name: "billing", OpenWorkSessionCount: 3}}
		},
	}
	m := start(t, testModel(t, fake))
	if strings.Contains(screen(m), "3 open") {
		t.Fatal("the default conversation has no open work")
	}
	m = press(t, m, tea.KeyPressMsg{Code: 'o', Mod: tea.ModCtrl}, key(tea.KeyDown), key(tea.KeyEnter))
	if !strings.Contains(screen(m), "lead 3 open") {
		t.Fatalf("rail:\n%s", screen(m))
	}
}
