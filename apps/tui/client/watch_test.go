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

func watchEvent(token string, change *operatorv1.WatchChange) *operatorv1.WatchEvent {
	if change == nil {
		return &operatorv1.WatchEvent{ResumeToken: token, Event: &operatorv1.WatchEvent_Heartbeat{Heartbeat: &operatorv1.Heartbeat{}}}
	}
	return &operatorv1.WatchEvent{ResumeToken: token, Event: &operatorv1.WatchEvent_Change{Change: change}}
}

func resyncEvent(token string) *operatorv1.WatchEvent {
	return &operatorv1.WatchEvent{ResumeToken: token, Event: &operatorv1.WatchEvent_Resync{Resync: &operatorv1.WatchResync{}}}
}

func tagChange(name string) *operatorv1.WatchChange {
	return &operatorv1.WatchChange{Kind: operatorv1.WatchKind_WATCH_KIND_TAG, Id: "tag-" + name, Tag: name, Reason: "status"}
}

// watchScript answers the nth Watch call with the nth function; later calls wait for the
// test to end.
func watchScript(t *testing.T, script ...func(context.Context, *operatorv1.WatchRequest, *connect.ServerStream[operatorv1.WatchEvent]) error) (*fakeControlPlane, func() []*operatorv1.WatchRequest) {
	var mu sync.Mutex
	var requests []*operatorv1.WatchRequest
	f := &fakeControlPlane{watch: func(ctx context.Context, req *operatorv1.WatchRequest, stream *connect.ServerStream[operatorv1.WatchEvent]) error {
		mu.Lock()
		requests = append(requests, req)
		n := len(requests)
		mu.Unlock()
		if n <= len(script) {
			return script[n-1](ctx, req, stream)
		}
		<-ctx.Done()
		return ctx.Err()
	}}
	return f, func() []*operatorv1.WatchRequest {
		mu.Lock()
		defer mu.Unlock()
		return append([]*operatorv1.WatchRequest(nil), requests...)
	}
}

// waitRequests waits until the server saw n Watch calls.
func waitRequests(t *testing.T, requests func() []*operatorv1.WatchRequest, n int) []*operatorv1.WatchRequest {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if seen := requests(); len(seen) >= n {
			return seen
		}
		if time.Now().After(deadline) {
			t.Fatalf("the watcher made %d calls, want %d", len(requests()), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func testWatcher(c *Client) *Watcher {
	w := NewWatcher(c, operatorv1.WatchKind_WATCH_KIND_TAG, operatorv1.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE)
	w.Interval, w.MaxBackoff, w.IdleTimeout = time.Millisecond, 5*time.Millisecond, time.Second
	return w
}

// nextUpdates reads n updates and writes them one per line.
func nextUpdates(t *testing.T, updates <-chan WatchUpdate, n int) string {
	t.Helper()
	names := []string{"live", "changed", "resync", "lost"}
	var lines []string
	for range n {
		select {
		case update := <-updates:
			line := names[update.Kind]
			if update.Change != nil {
				line += " " + update.Change.GetTag()
			}
			if update.Err != nil {
				line += ": " + update.Err.Error()
			}
			lines = append(lines, line)
		case <-time.After(5 * time.Second):
			t.Fatalf("no update after:\n%s", strings.Join(lines, "\n"))
		}
	}
	return strings.Join(lines, "\n")
}

func TestWatchGoesLiveThenResumesAfterADrop(t *testing.T) {
	f, requests := watchScript(t,
		func(ctx context.Context, _ *operatorv1.WatchRequest, stream *connect.ServerStream[operatorv1.WatchEvent]) error {
			if err := stream.Send(watchEvent("r1", nil)); err != nil {
				return err
			}
			if err := stream.Send(watchEvent("r2", tagChange("lead"))); err != nil {
				return err
			}
			return connect.NewError(connect.CodeUnavailable, errors.New("the Control Plane is draining"))
		},
		func(ctx context.Context, _ *operatorv1.WatchRequest, stream *connect.ServerStream[operatorv1.WatchEvent]) error {
			return stream.Send(watchEvent("r3", tagChange("builder")))
		},
	)
	c := newFake(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	updates := testWatcher(c).Run(ctx)
	got := nextUpdates(t, updates, 6)
	want := "live\nchanged lead\nlost: the Control Plane is draining\nlive\nchanged builder\nlost: the Control Plane closed the stream early"
	if got != want {
		t.Fatalf("updates:\n%s\nwant:\n%s", got, want)
	}
	seen := waitRequests(t, requests, 3)
	if seen[0].GetResumeToken() != "" || seen[1].GetResumeToken() != "r2" || seen[2].GetResumeToken() != "r3" {
		t.Fatalf("requests = %v", seen)
	}
	if fmt.Sprint(seen[0].GetKinds()) != "[WATCH_KIND_TAG WATCH_KIND_CONVERSATION_MESSAGE]" {
		t.Fatalf("kinds = %v", seen[0].GetKinds())
	}
}

func TestWatchResyncReplacesLive(t *testing.T) {
	f, requests := watchScript(t,
		func(ctx context.Context, _ *operatorv1.WatchRequest, stream *connect.ServerStream[operatorv1.WatchEvent]) error {
			if err := stream.Send(watchEvent("r1", nil)); err != nil {
				return err
			}
			return connect.NewError(connect.CodeUnavailable, errors.New("restarting"))
		},
		func(ctx context.Context, _ *operatorv1.WatchRequest, stream *connect.ServerStream[operatorv1.WatchEvent]) error {
			if err := stream.Send(resyncEvent("s1")); err != nil {
				return err
			}
			if err := stream.Send(watchEvent("s2", tagChange("lead"))); err != nil {
				return err
			}
			<-ctx.Done()
			return ctx.Err()
		},
	)
	c := newFake(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := nextUpdates(t, testWatcher(c).Run(ctx), 4)
	if want := "live\nlost: restarting\nresync\nchanged lead"; got != want {
		t.Fatalf("updates:\n%s\nwant:\n%s", got, want)
	}
	if seen := requests(); seen[1].GetResumeToken() != "r1" {
		t.Fatalf("resumed with %q", seen[1].GetResumeToken())
	}
}

func TestWatchStartsOverOnATokenTheServerDidNotIssue(t *testing.T) {
	f, requests := watchScript(t,
		func(ctx context.Context, _ *operatorv1.WatchRequest, stream *connect.ServerStream[operatorv1.WatchEvent]) error {
			if err := stream.Send(watchEvent("old", nil)); err != nil {
				return err
			}
			return connect.NewError(connect.CodeUnavailable, errors.New("restarting"))
		},
		func(context.Context, *operatorv1.WatchRequest, *connect.ServerStream[operatorv1.WatchEvent]) error {
			return connect.NewError(connect.CodeInvalidArgument, errors.New("resume_token was not issued by this Control Plane"))
		},
		func(ctx context.Context, _ *operatorv1.WatchRequest, stream *connect.ServerStream[operatorv1.WatchEvent]) error {
			if err := stream.Send(watchEvent("new", nil)); err != nil {
				return err
			}
			<-ctx.Done()
			return ctx.Err()
		},
	)
	c := newFake(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := nextUpdates(t, testWatcher(c).Run(ctx), 3)
	if want := "live\nlost: restarting\nlive"; got != want {
		t.Fatalf("updates:\n%s\nwant:\n%s", got, want)
	}
	if seen := requests(); len(seen) != 3 || seen[1].GetResumeToken() != "old" || seen[2].GetResumeToken() != "" {
		t.Fatalf("requests = %v", seen)
	}
}

func TestWatchReconnectsAQuietStream(t *testing.T) {
	f, requests := watchScript(t,
		func(ctx context.Context, _ *operatorv1.WatchRequest, stream *connect.ServerStream[operatorv1.WatchEvent]) error {
			if err := stream.Send(watchEvent("r1", nil)); err != nil {
				return err
			}
			<-ctx.Done()
			return ctx.Err()
		},
	)
	c := newFake(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := testWatcher(c)
	w.IdleTimeout = 100 * time.Millisecond
	got := nextUpdates(t, w.Run(ctx), 2)
	if want := "live\nlost: the Control Plane stopped sending events"; got != want {
		t.Fatalf("updates:\n%s\nwant:\n%s", got, want)
	}
	if waitRequests(t, requests, 2)[1].GetResumeToken() != "r1" {
		t.Fatal("the reconnect did not resume")
	}
}
