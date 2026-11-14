package client

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/apps/tui/views"
)

// WatchUpdateKind says what a WatchUpdate tells the UI.
type WatchUpdateKind int

const (
	// WatchLive says the watch stream is open and delivers changes: reread what the UI shows,
	// then apply the changes that follow.
	WatchLive WatchUpdateKind = iota
	// WatchChanged is one change (Change): reread what it names.
	WatchChanged
	// WatchResync says changes were lost while the stream was down: reread everything.
	WatchResync
	// WatchLost says the stream dropped (Err). Changes stop until the next WatchLive or
	// WatchResync, so the UI rereads on its own meanwhile.
	WatchLost
)

// WatchUpdate is one thing the watcher tells the UI.
type WatchUpdate struct {
	Kind   WatchUpdateKind
	Change *views.WatchChange
	Err    error
}

// Watcher keeps one EventService.Watch stream open, resuming it from the last resume token
// after it drops, with a growing pause between attempts.
type Watcher struct {
	Client *Client
	// Kinds are the changes to watch; empty watches every kind the caller may see.
	Kinds []views.WatchKind
	// Interval is the first pause before reconnecting; pauses double to MaxBackoff.
	Interval, MaxBackoff time.Duration
	// IdleTimeout is how long the stream may go without an event, heartbeats included, before
	// it counts as dropped.
	IdleTimeout time.Duration
}

// NewWatcher watches kinds with the default timings.
func NewWatcher(c *Client, kinds ...views.WatchKind) *Watcher {
	return &Watcher{Client: c, Kinds: kinds, Interval: time.Second, MaxBackoff: 30 * time.Second, IdleTimeout: 45 * time.Second}
}

// Run watches until ctx ends, then closes the channel.
func (w *Watcher) Run(ctx context.Context) <-chan WatchUpdate {
	updates := make(chan WatchUpdate, 16)
	send := func(update WatchUpdate) bool {
		select {
		case updates <- update:
			return true
		case <-ctx.Done():
			return false
		}
	}
	go func() {
		defer close(updates)
		token := ""
		backoff := w.Interval
		lost := false
		for ctx.Err() == nil {
			live, err := w.watch(ctx, &token, send)
			if ctx.Err() != nil {
				return
			}
			if live {
				backoff, lost = w.Interval, false
			}
			if connect.CodeOf(err) == connect.CodeInvalidArgument && token != "" {
				// The server does not know the token: start over, rereading everything.
				token = ""
				continue
			}
			if !lost {
				lost = true
				if !send(WatchUpdate{Kind: WatchLost, Err: apiError(err)}) {
					return
				}
			}
			if !pause(ctx, backoff) {
				return
			}
			backoff = min(backoff*2, w.MaxBackoff)
		}
	}()
	return updates
}

// watch reads one stream from token, keeping token current. live says the stream delivered an
// event; err says why it ended.
func (w *Watcher) watch(ctx context.Context, token *string, send func(WatchUpdate) bool) (live bool, err error) {
	return w.watchRuntime(ctx, token, send)
}

// errStreamEnded is a stream that closed before its end event.
var errStreamEnded = errors.New("the Control Plane closed the stream early")

// errIdle is a stream that went quiet for longer than heartbeats allow.
var errIdle = errors.New("the Control Plane stopped sending events")

func watchStream[T any](
	ctx context.Context, idleTimeout time.Duration, token *string, send func(WatchUpdate) bool,
	open func(context.Context) (*connect.ServerStreamForClient[T], error),
	frame func(*T) (string, WatchUpdate, bool),
) (live bool, err error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var idle atomic.Bool
	timer := time.AfterFunc(idleTimeout, func() {
		idle.Store(true)
		cancel()
	})
	defer timer.Stop()
	stream, err := open(ctx)
	if err != nil {
		return false, err
	}
	defer stream.Close()
	for stream.Receive() {
		next, update, valid := frame(stream.Msg())
		if !valid {
			continue
		}
		timer.Reset(idleTimeout)
		if next != "" {
			*token = next
		}
		if !live {
			live = true
			if update.Kind != WatchResync && !send(WatchUpdate{Kind: WatchLive}) {
				return live, ctx.Err()
			}
		}
		if (update.Kind == WatchResync || update.Change != nil) && !send(update) {
			return live, ctx.Err()
		}
	}
	if idle.Load() {
		return live, errIdle
	}
	if err := stream.Err(); err != nil {
		return live, err
	}
	return live, errStreamEnded
}
