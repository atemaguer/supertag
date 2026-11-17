package client

import (
	"context"
	"sync"
	"time"

	"connectrpc.com/connect"

	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

// conversationStreams keeps one Conversations.FollowConversation stream open per Tag while any
// turn of that conversation is followed, and shares what it pushes with every follow.
type conversationStreams struct {
	mu   sync.Mutex
	tags map[string]*conversationStream
}

// conversationStream is one Tag's pushed conversation: the latest copy of each message it pushed,
// why queued turns wait, and a channel closed on every change.
type conversationStream struct {
	refs   int
	cancel context.CancelFunc

	mu   sync.Mutex
	live bool
	// ended says the Control Plane cannot push this conversation, so follows read on a timer.
	ended    bool
	messages map[string]pushedMessage
	waits    map[string]string
	// texts is the text of the message each running turn is writing now.
	texts   map[string]string
	changed chan struct{}
	// What a reconnect resumes from: the conversation, its latest order, and the turns the
	// stream last saw unfinished.
	conversationID string
	after          uint64
	unfinished     map[string]bool
}

// pushedMessage is a message as last pushed, with the push that carried it.
type pushedMessage struct {
	message *v2.ConversationMessage
	version uint64
}

// streamIdle is how long a follow stream may go without a response, heartbeats included,
// before it counts as dropped.
var streamIdle = 45 * time.Second

// followConversation opens, or shares, the follow stream of tag's conversation. release closes
// it once no follow uses it.
func (c *Client) followConversation(tag string) (*conversationStream, func()) {
	streams := &c.runtime.streams
	streams.mu.Lock()
	defer streams.mu.Unlock()
	if streams.tags == nil {
		streams.tags = map[string]*conversationStream{}
	}
	stream := streams.tags[tag]
	if stream == nil {
		ctx, cancel := context.WithCancel(context.Background())
		stream = &conversationStream{cancel: cancel, messages: map[string]pushedMessage{}, waits: map[string]string{},
			texts: map[string]string{}, changed: make(chan struct{}), unfinished: map[string]bool{}}
		streams.tags[tag] = stream
		go stream.run(ctx, c, tag)
	}
	stream.refs++
	var once sync.Once
	return stream, func() {
		once.Do(func() {
			streams.mu.Lock()
			defer streams.mu.Unlock()
			if stream.refs--; stream.refs == 0 {
				stream.cancel()
				delete(streams.tags, tag)
			}
		})
	}
}

// run keeps the stream open until ctx ends, resuming from what it holds after a drop.
func (s *conversationStream) run(ctx context.Context, c *Client, tag string) {
	backoff := time.Second
	for ctx.Err() == nil {
		live, err := s.read(ctx, c, tag)
		s.update(func() bool {
			changed := s.live || len(s.texts) > 0
			s.live = false
			clear(s.texts)
			return changed
		})
		if ctx.Err() != nil {
			return
		}
		if live {
			backoff = time.Second
		}
		if connect.CodeOf(err) == connect.CodeUnimplemented || connect.CodeOf(err) == connect.CodePermissionDenied {
			// The follows keep reading on their own.
			s.update(func() bool {
				s.ended = true
				return true
			})
			return
		}
		if !pause(ctx, backoff) {
			return
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (s *conversationStream) read(ctx context.Context, c *Client, tag string) (bool, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	idle := time.AfterFunc(streamIdle, cancel)
	defer idle.Stop()
	s.mu.Lock()
	request := &v2.FollowConversationRequest{TagId: tag, ConversationId: s.conversationID, After: s.after}
	for id := range s.unfinished {
		if len(request.RefreshTaskIds) < maxRefresh {
			request.RefreshTaskIds = append(request.RefreshTaskIds, id)
		}
	}
	if request.ConversationId == "" {
		request.After = 0
	}
	s.mu.Unlock()
	stream, err := c.runtime.conversations.FollowConversation(ctx, connect.NewRequest(request))
	if err != nil {
		return false, err
	}
	defer stream.Close()
	live := false
	for stream.Receive() {
		idle.Reset(streamIdle)
		live = true
		response := stream.Msg()
		s.update(func() bool { return s.apply(tag, response) })
	}
	return live, stream.Err()
}

// apply records one response; it says whether anything a follow reads changed.
func (s *conversationStream) apply(tag string, response *v2.FollowConversationResponse) bool {
	changed := !s.live
	s.live = true
	if page := response.GetMessages(); page != nil {
		if !page.GetIncremental() {
			s.conversationID = page.GetConversationId()
			s.after = 0
			clear(s.unfinished)
		}
		for _, message := range page.GetMessages() {
			task := message.GetTask()
			if task.GetTagId() != tag || task.GetTaskId() == "" {
				continue
			}
			id := task.GetTaskId()
			s.messages[id] = pushedMessage{message: message, version: s.messages[id].version + 1}
			s.after = max(s.after, message.GetOrder())
			if runtimeFinished(task.GetState()) {
				delete(s.unfinished, id)
			} else {
				s.unfinished[id] = true
			}
			changed = true
		}
	}
	for _, text := range response.GetTexts() {
		if text.GetText() == "" {
			delete(s.texts, text.GetTaskId())
		} else {
			s.texts[text.GetTaskId()] = text.GetText()
		}
		changed = true
	}
	for _, wait := range response.GetWaits() {
		if wait.GetReason() == "" {
			delete(s.waits, wait.GetTaskId())
		} else {
			s.waits[wait.GetTaskId()] = wait.GetReason()
		}
		changed = true
	}
	return changed
}

func runtimeFinished(state v2.TaskState) bool {
	switch state {
	case v2.TaskState_TASK_STATE_SUCCEEDED, v2.TaskState_TASK_STATE_FAILED, v2.TaskState_TASK_STATE_CANCELLED:
		return true
	}
	return false
}

// update applies change under the lock and wakes every follow when it reports a change.
func (s *conversationStream) update(change func() bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if change() {
		close(s.changed)
		s.changed = make(chan struct{})
	}
}

// wait returns when the stream changes, after d, or when ctx ends.
func (s *conversationStream) wait(ctx context.Context, d time.Duration) {
	s.mu.Lock()
	changed := s.changed
	s.mu.Unlock()
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-changed:
	case <-timer.C:
	case <-ctx.Done():
	}
}

// awaitLive waits up to d for the stream's first response, so a follow starts from it rather
// than reading the turn itself.
func (s *conversationStream) awaitLive(ctx context.Context, d time.Duration) {
	deadline := time.Now().Add(d)
	for ctx.Err() == nil && time.Now().Before(deadline) {
		s.mu.Lock()
		settled := s.live || s.ended
		s.mu.Unlock()
		if settled {
			return
		}
		s.wait(ctx, time.Until(deadline))
	}
}

// message is the latest pushed copy of a turn while the stream is open, and its version.
func (s *conversationStream) message(id string) (*v2.ConversationMessage, uint64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pushed, ok := s.messages[id]
	if !s.live || !ok {
		return nil, 0, false
	}
	return pushed.message, pushed.version, true
}

// hostWait is why a queued turn waits for a Worker Host, as last pushed.
func (s *conversationStream) hostWait(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.waits[id]
}

// text is the text of the message a running turn is writing now, as last pushed.
func (s *conversationStream) text(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.texts[id]
}

// isLive says the stream is open.
func (s *conversationStream) isLive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.live
}
