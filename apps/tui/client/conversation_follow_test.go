package client

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
	rpc "github.com/atemaguer/supertag/sdks/go/runtimev2/runtimev2connect"
)

// pushingConversations answers FollowConversation with each page in turn, then holds the stream.
type pushingConversations struct {
	rpc.UnimplementedConversationsHandler
	pages []*v2.ListMessagesResponse
	gets  atomic.Int32
}

func (p *pushingConversations) FollowConversation(ctx context.Context, req *connect.Request[v2.FollowConversationRequest], stream *connect.ServerStream[v2.FollowConversationResponse]) error {
	if req.Msg.GetTagId() != "lead" {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("unexpected Tag"))
	}
	for _, page := range p.pages {
		if err := stream.Send(&v2.FollowConversationResponse{Messages: page}); err != nil {
			return err
		}
		time.Sleep(20 * time.Millisecond)
	}
	<-ctx.Done()
	return nil
}

func (p *pushingConversations) GetMessage(context.Context, *connect.Request[v2.GetMessageRequest]) (*connect.Response[v2.ConversationMessage], error) {
	p.gets.Add(1)
	return nil, connect.NewError(connect.CodeUnavailable, errors.New("a pushed follow reads no message"))
}

func TestRuntimeV2FollowsPushedChangesWithoutReadingThem(t *testing.T) {
	turn := func(state v2.TaskState, result *string, events ...*v2.TaskEvent) *v2.ListMessagesResponse {
		return &v2.ListMessagesResponse{ConversationId: "conversation/lead", Incremental: true, Messages: []*v2.ConversationMessage{{
			Order: 1, Events: events, Task: &v2.Task{TagId: "lead", TaskId: "t1", State: state, Result: result},
		}}}
	}
	intent := &v2.TaskEvent{Sequence: 1, Text: "I'll look at the build.", Kind: v2.TaskEventKind_TASK_EVENT_KIND_MESSAGE}
	running := &v2.TaskEvent{Sequence: 2, Text: "Running cargo test", Kind: v2.TaskEventKind_TASK_EVENT_KIND_ACTIVITY}
	conversations := &pushingConversations{pages: []*v2.ListMessagesResponse{
		turn(v2.TaskState_TASK_STATE_QUEUED, nil),
		turn(v2.TaskState_TASK_STATE_RUNNING, nil, intent),
		turn(v2.TaskState_TASK_STATE_RUNNING, nil, intent, running),
		turn(v2.TaskState_TASK_STATE_SUCCEEDED, proto.String("The build passes."), intent),
	}}
	mux := http.NewServeMux()
	mux.Handle(rpc.NewConversationsHandler(conversations))
	c := testRuntime(t, mux, false)
	follower := testFollower(c)
	// Only a push can move the follow along within the test.
	follower.Interval = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := collect(t, follower.Follow(ctx, "lead", message("t1"), nil))
	expect(t, events, "started", "message I'll look at the build.", "status Running cargo test", "reply The build passes.")
	if gets := conversations.gets.Load(); gets != 0 {
		t.Fatalf("a pushed follow read the message %d times", gets)
	}
}
