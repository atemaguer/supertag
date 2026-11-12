package client

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	rpc "github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

func TestRuntimeWatchResumesAndMapsTypedChanges(t *testing.T) {
	mux := http.NewServeMux()
	requests := make(chan *v2.WatchRequest, 3)
	wantKinds := []v2.WatchKind{
		v2.WatchKind_WATCH_KIND_TAG, v2.WatchKind_WATCH_KIND_TASK, v2.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE,
		v2.WatchKind_WATCH_KIND_OBJECTIVE, v2.WatchKind_WATCH_KIND_TEAM, v2.WatchKind_WATCH_KIND_WORKSTREAM_POST,
	}
	mux.Handle(rpc.OperatorEventsWatchProcedure, connect.NewServerStreamHandler(rpc.OperatorEventsWatchProcedure,
		func(ctx context.Context, req *connect.Request[v2.WatchRequest], stream *connect.ServerStream[v2.WatchEvent]) error {
			select {
			case requests <- req.Msg:
			case <-ctx.Done():
				return ctx.Err()
			}
			if !slices.Equal(req.Msg.GetKinds(), wantKinds) {
				t.Errorf("requested Watch kinds = %v", req.Msg.GetKinds())
			}
			switch req.Msg.GetResumeToken() {
			case "":
				if err := stream.Send(&v2.WatchEvent{ResumeToken: "initial", Update: &v2.WatchEvent_Heartbeat{Heartbeat: &v2.WatchHeartbeat{}}}); err != nil {
					return err
				}
				change := &v2.WatchChange{
					Kind: v2.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE, Id: "message-1", TagId: "lead", SessionId: "session-1",
					Conversation: "planning", ChangedAtMs: 123456, Reason: v2.WatchReason_WATCH_REASON_CREATED,
				}
				if err := stream.Send(&v2.WatchEvent{ResumeToken: "message", Update: &v2.WatchEvent_Change{Change: change}}); err != nil {
					return err
				}
				return connect.NewError(connect.CodeUnavailable, errors.New("Gateway restarted"))
			case "message":
				if err := stream.Send(&v2.WatchEvent{ResumeToken: "new-head", Update: &v2.WatchEvent_Resync{Resync: &v2.WatchResync{}}}); err != nil {
					return err
				}
				change := &v2.WatchChange{Kind: v2.WatchKind_WATCH_KIND_WORKSTREAM_POST, Id: "post-1", TeamId: "release"}
				if err := stream.Send(&v2.WatchEvent{ResumeToken: "post", Update: &v2.WatchEvent_Change{Change: change}}); err != nil {
					return err
				}
				<-ctx.Done()
				return ctx.Err()
			default:
				return connect.NewError(connect.CodeInvalidArgument, errors.New("unexpected resume token"))
			}
		},
	))
	c := testRuntime(t, mux, false)
	w := NewWatcher(c,
		operatorv1.WatchKind_WATCH_KIND_TAG, operatorv1.WatchKind_WATCH_KIND_TASK, operatorv1.WatchKind_WATCH_KIND_SESSION,
		operatorv1.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE, operatorv1.WatchKind_WATCH_KIND_OBJECTIVE,
		operatorv1.WatchKind_WATCH_KIND_TEAM, operatorv1.WatchKind_WATCH_KIND_WORKSTREAM_POST)
	w.Interval, w.IdleTimeout = time.Millisecond, time.Second
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	updates := w.Run(ctx)
	var got []WatchUpdate
	for _, kind := range []WatchUpdateKind{WatchLive, WatchChanged, WatchLost, WatchResync, WatchChanged} {
		select {
		case update, ok := <-updates:
			if !ok || update.Kind != kind {
				t.Fatalf("update = %+v, want kind %v", update, kind)
			}
			got = append(got, update)
		case <-ctx.Done():
			t.Fatalf("timed out waiting for kind %v", kind)
		}
	}
	first, last := got[1].Change, got[4].Change
	if first.GetKind() != operatorv1.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE || first.GetTag() != "lead" ||
		first.GetId() != "message-1" || first.GetSessionId() != "session-1" || first.GetConversation() != "planning" ||
		first.GetChangedAt().AsTime().UnixMilli() != 123456 || first.GetReason() != "created" {
		t.Fatalf("conversation notice = %v", first)
	}
	if last.GetKind() != operatorv1.WatchKind_WATCH_KIND_WORKSTREAM_POST || last.GetTeamId() != "release" || last.GetId() != "post-1" {
		t.Fatalf("Workstream notice = %v", last)
	}
	if a, b := <-requests, <-requests; a.GetResumeToken() != "" || b.GetResumeToken() != "message" {
		t.Fatalf("Watch requests = %v, %v", a, b)
	}
	cancel()
	select {
	case _, ok := <-updates:
		if ok {
			t.Fatal("watch sent an extra update after cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("watch did not stop after cancellation")
	}
}
