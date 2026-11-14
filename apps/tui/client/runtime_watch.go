package client

import (
	"context"
	"errors"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
)

func (w *Watcher) watchRuntime(ctx context.Context, token *string, send func(WatchUpdate) bool) (bool, error) {
	kinds := make([]v2.WatchKind, 0, len(w.Kinds))
	for _, kind := range w.Kinds {
		if value, ok := v2.WatchKind_value[kind.String()]; ok && value != 0 {
			kinds = append(kinds, v2.WatchKind(value))
		}
	}
	if len(w.Kinds) > 0 && len(kinds) == 0 {
		return false, connect.NewError(connect.CodeInvalidArgument, errors.New("none of the requested Watch kinds is available on this Control Plane"))
	}
	return watchStream(ctx, w.IdleTimeout, token, send, func(ctx context.Context) (*connect.ServerStreamForClient[v2.WatchEvent], error) {
		return w.Client.runtime.events.Watch(ctx, connect.NewRequest(&v2.WatchRequest{ResumeToken: *token, Kinds: kinds}))
	}, runtimeWatchFrame)
}

func runtimeWatchFrame(event *v2.WatchEvent) (string, WatchUpdate, bool) {
	token := event.GetResumeToken()
	switch part := event.GetUpdate().(type) {
	case *v2.WatchEvent_Heartbeat:
		return token, WatchUpdate{}, true
	case *v2.WatchEvent_Resync:
		return token, WatchUpdate{Kind: WatchResync}, true
	case *v2.WatchEvent_Change:
		change := part.Change
		kind, ok := views.WatchKind_value[change.GetKind().String()]
		if !ok || kind == 0 || change.GetId() == "" {
			return "", WatchUpdate{}, false
		}
		reason := ""
		switch change.GetReason() {
		case v2.WatchReason_WATCH_REASON_CREATED, v2.WatchReason_WATCH_REASON_CHANGED, v2.WatchReason_WATCH_REASON_DELETED:
			reason = strings.ToLower(strings.TrimPrefix(change.GetReason().String(), "WATCH_REASON_"))
		}
		update := &views.WatchChange{
			Kind: views.WatchKind(kind), Id: change.GetId(), Tag: change.GetTagId(),
			SessionId: change.GetSessionId(), ObjectiveId: change.GetObjectiveId(), TeamId: change.GetTeamId(),
			Conversation: change.GetConversation(), Reason: reason,
			ChangedAt: timestamppb.New(time.UnixMilli(change.GetChangedAtMs())),
		}
		return token, WatchUpdate{Kind: WatchChanged, Change: update}, true
	default:
		return "", WatchUpdate{}, false
	}
}
