package main

import (
	"strings"
	"testing"

	"github.com/atemaguer/supertag/apps/tui/client"
)

func TestRuntimeObjectiveFollowShowsChildReportAfterRootReplyOrFailure(t *testing.T) {
	for _, failed := range []bool{false, true} {
		name := "reply"
		if failed {
			name = "failure"
		}
		t.Run(name, func(t *testing.T) {
			m := runtimeModel(t)
			cancelled := false
			message := &objectiveMessage{text: "Check the release", tag: "lead", status: "Follow-up sent.", cancel: func() { cancelled = true }}
			m.objectiveID = "objective"
			m.objectiveMessages["objective"] = message
			events := make(chan client.FollowEvent)
			read := func(event client.FollowEvent) {
				if cmd := m.objectiveReplyRead(objectiveReplyMsg{id: "objective", message: message, event: event, events: events}); cmd == nil {
					t.Fatal("follow stopped before the stream closed")
				}
				if cancelled {
					t.Fatal("root completion must not cancel child/report following")
				}
			}
			if failed {
				read(client.FollowEvent{Kind: client.EventTurnError, Text: "Root failed"})
			} else {
				read(client.FollowEvent{Kind: client.EventReply, Reply: finalReply("Started checking")})
			}
			read(client.FollowEvent{Kind: client.EventWorking, WorkSession: "work/check", TaskID: "child", Title: "Release checks"})
			report := client.FollowEvent{Kind: client.EventReport, WorkSession: "work/check", TaskID: "report", Title: "Release checks", Status: "done", Text: "Release verified"}
			read(report)
			read(report)
			got := m.objectiveMessageText()
			if !strings.Contains(got, "Working: Release checks") || strings.Count(got, "Release verified") != 1 {
				t.Fatalf("Objective follow text:\n%s", got)
			}
			if cmd := m.objectiveReplyRead(objectiveReplyMsg{id: "objective", message: message}); cmd != nil || !cancelled || message.cancel != nil {
				t.Fatal("stream closure must release the follow")
			}
		})
	}
}
