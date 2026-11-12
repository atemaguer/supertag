package client

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// EventKind says what a FollowEvent shows.
type EventKind int

const (
	// EventWaiting says why the turn has not started (Text), once per reason.
	EventWaiting EventKind = iota
	// EventDelta is reply text as the Tag writes it (Text). The final reply replaces it.
	EventDelta
	// EventActivity is a command or tool the Tag or a work Session (Title) starts (Text).
	EventActivity
	// EventReply is the Tag's final reply (Reply).
	EventReply
	// EventTurnError is the error that ended the turn instead of a reply (Text).
	EventTurnError
	// EventWorking says a work Session (Title) is working.
	EventWorking
	// EventReport is a work Session's (Title) report (Text); Status is "done", "waiting on you",
	// "waiting for approval", "failed" or "stopped".
	EventReport
	// EventApproval is a work Session's (Title) approval request notice (Text).
	EventApproval
	// EventNotContinued says why a decision did not continue a work Session (Title, Text).
	EventNotContinued
	// EventStillWorking says following stopped while work Sessions still run (Text).
	EventStillWorking
	// EventJoined says the message was delivered into a turn already running, whose reply
	// answers it.
	EventJoined
	// EventError ends the follow with a failure to follow (Text).
	EventError
)

// FollowEvent is one thing to show while following a message.
type FollowEvent struct {
	Kind   EventKind
	Title  string
	Status string
	Text   string
	Reply  *operatorv1.Reply
	// Indent marks activity of a work Session, shown under its "working" line.
	Indent bool
	// WorkSession is the ID of the work Session the event is about: its activity, that it is
	// working, its report, an approval notice, or why it did not continue. Empty otherwise.
	WorkSession string
	// TaskID identifies the child Task for activity/working, or the distinct
	// parent report Task for a report. Sequence identifies a recorded event.
	TaskID   string
	Sequence uint64
}

// Shown is what has been shown of one message, so a resumed stream, which may send the
// current state again, and a message first shown from history add only what changed.
type Shown struct {
	tag, conversation string
	joined            bool
	joinedOnPage      string
	replied           bool
	waiting           map[string]bool
	// sessions holds the latest snapshot of each work Session, in the order first seen.
	sessions []*operatorv1.WorkSession
	// tasks is the Task each work Session was last shown working on.
	tasks map[string]string
	keys  map[string]bool
}

func newShown(tag, conversation string) *Shown {
	return &Shown{tag: tag, conversation: conversation, waiting: map[string]bool{}, tasks: map[string]string{}, keys: map[string]bool{}}
}

// once reports whether key is new, and records it.
func (s *Shown) once(key string) bool {
	if s.keys[key] {
		return false
	}
	s.keys[key] = true
	return true
}

func (s *Shown) join() []FollowEvent {
	if s.joined {
		return nil
	}
	s.joined = true
	return []FollowEvent{{Kind: EventJoined}}
}

func (s *Shown) wait(reason string) []FollowEvent {
	if reason == "" || s.replied || s.waiting[reason] {
		return nil
	}
	s.waiting[reason] = true
	return []FollowEvent{{Kind: EventWaiting, Text: reason}}
}

func (s *Shown) reply(reply *operatorv1.Reply) []FollowEvent {
	if s.replied || reply == nil {
		return nil
	}
	s.replied = true
	if reply.GetPresentation() == operatorv1.ReplyPresentation_REPLY_PRESENTATION_ERROR {
		return s.turnError(reply.GetText())
	}
	return []FollowEvent{{Kind: EventReply, Reply: reply}}
}

func (s *Shown) turnError(text string) []FollowEvent {
	s.replied = true
	if !s.once("turn-error") {
		return nil
	}
	return []FollowEvent{{Kind: EventTurnError, Text: fmt.Sprintf("Tag %s could not answer: %s", s.tag, text)}}
}

// title names a work Session in its activity lines when the turn started more than one.
func (s *Shown) title(id string) string {
	if len(s.sessions) < 2 {
		return ""
	}
	for _, session := range s.sessions {
		if session.GetId() == id {
			return session.GetTitle()
		}
	}
	return ""
}

// workSession takes a work Session's current state and returns what changed: a "working" line
// when it is new or a decision continued it as a new Task, each new approval notice, its report,
// and why a decision did not continue it.
func (s *Shown) workSession(session *operatorv1.WorkSession) []FollowEvent {
	if session == nil || session.GetId() == "" {
		return nil
	}
	id, task := session.GetId(), session.GetTaskId()
	replaced := false
	for i, held := range s.sessions {
		if held.GetId() == id {
			s.sessions[i], replaced = session, true
		}
	}
	if !replaced {
		s.sessions = append(s.sessions, session)
	}
	var events []FollowEvent
	previous, known := s.tasks[id]
	if !known || previous != task {
		s.tasks[id] = task
		// A work Session that had no Task yet is still the same piece of work.
		if !known || previous != "" {
			events = append(events, FollowEvent{Kind: EventWorking, Title: session.GetTitle(), WorkSession: id, TaskID: task})
		}
	}
	for _, approval := range session.GetApprovals() {
		if s.once("approval:" + approval.GetRequestId()) {
			events = append(events, FollowEvent{Kind: EventApproval, Title: session.GetTitle(), Text: approval.GetText(), WorkSession: id})
		}
	}
	reportKey := "report:" + session.GetReportTaskId()
	if session.GetReportTaskId() == "" {
		reportKey = "report:" + task
	}
	if task == "" && session.GetReportTaskId() == "" {
		reportKey = "report:" + id
	}
	if session.GetReportStatus() == operatorv1.ReplyStatus_REPLY_STATUS_REPLIED && session.GetReport() != nil && s.once(reportKey) {
		events = append(events, FollowEvent{Kind: EventReport, Title: session.GetTitle(), Status: reportEnding(session), Text: session.GetReport().GetText(), WorkSession: id, TaskID: session.GetReportTaskId()})
	}
	if session.GetNotContinued() != "" && s.once("stopped:"+task) {
		events = append(events, FollowEvent{Kind: EventNotContinued, Title: session.GetTitle(), Text: session.GetNotContinued(), WorkSession: id})
	}
	return events
}

func (s *Shown) message(message *operatorv1.Message) []FollowEvent {
	var events []FollowEvent
	for _, session := range message.GetWorkSessions() {
		events = append(events, s.workSession(session)...)
	}
	return events
}

// settled reports whether the message needs no more following: the turn replied, and each work
// Session reported and does not wait on an approval decision only, since deciding it continues
// the work Session.
func (s *Shown) settled() bool {
	if !s.replied {
		return false
	}
	for _, session := range s.sessions {
		if session.GetReportStatus() != operatorv1.ReplyStatus_REPLY_STATUS_REPLIED ||
			(session.GetStatus() == operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_WAITING && session.GetQuestion() == "") {
			return false
		}
	}
	return true
}

func reportEnding(session *operatorv1.WorkSession) string {
	switch session.GetStatus() {
	case operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_COMPLETED:
		return "done"
	case operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_WAITING:
		if session.GetQuestion() == "" {
			return "waiting for approval"
		}
		return "waiting on you"
	case operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_FAILED:
		return "failed"
	}
	return "stopped"
}

// HistoryItem is one past message as a conversation shows it.
type HistoryItem struct {
	Message *operatorv1.Message
	// Events show what answered the message, as following it would have.
	Events []FollowEvent
	// Shown is what Events showed; pass it to Follow when Follow is true, so following adds
	// only what changes.
	Shown *Shown
	// Follow says the message still has a reply or work to show.
	Follow bool
}

// History turns a page of messages, newest first as ListMessages returns them, into what the
// conversation shows, oldest first. A message delivered into a turn on the
// page or already displayed shows only that it joined.
func History(tag string, page []*operatorv1.Message, displayedTaskIDs ...string) []HistoryItem {
	onPage := map[string]bool{}
	for _, id := range displayedTaskIDs {
		onPage[id] = true
	}
	for _, message := range page {
		onPage[message.GetTaskId()] = true
	}
	items := make([]HistoryItem, 0, len(page))
	workEvents := map[string]bool{}
	for i := len(page) - 1; i >= 0; i-- {
		message := page[i]
		shown := newShown(tag, message.GetConversation())
		item := HistoryItem{Message: message, Shown: shown}
		if joined := message.GetJoinedTaskId(); joined != "" {
			item.Events = shown.join()
			if onPage[joined] && joined != message.GetTaskId() {
				shown.joinedOnPage = joined
				// Its follow shows nothing while that turn's does, unless the delivery is withdrawn.
				item.Follow = message.GetStatus() != operatorv1.ReplyStatus_REPLY_STATUS_REPLIED
				items = append(items, item)
				continue
			}
		}
		if isWorkReport(message) {
			shown.replied = true
		} else if message.GetStatus() == operatorv1.ReplyStatus_REPLY_STATUS_REPLIED {
			item.Events = append(item.Events, shown.reply(message.GetReply())...)
		} else {
			item.Events = append(item.Events, shown.wait(message.GetWaitingReason())...)
		}
		item.Events = append(item.Events, shown.message(message)...)
		item.Events = uniqueWorkEvents(item.Events, workEvents)
		item.Follow = !shown.settled()
		items = append(items, item)
	}
	return items
}

// WorkEventKey is stable across a root follow, report history and refreshes.
// Report Task identity allows a later continuation to report independently.
func WorkEventKey(event FollowEvent) string {
	if event.WorkSession == "" || event.TaskID == "" {
		return ""
	}
	switch event.Kind {
	case EventWorking, EventReport:
		return fmt.Sprintf("%d:%s:%s", event.Kind, event.WorkSession, event.TaskID)
	case EventActivity:
		if event.Sequence != 0 {
			return fmt.Sprintf("%d:%s:%s:%d", event.Kind, event.WorkSession, event.TaskID, event.Sequence)
		}
	}
	return ""
}

func uniqueWorkEvents(events []FollowEvent, seen map[string]bool) []FollowEvent {
	result := events[:0]
	for _, event := range events {
		if key := WorkEventKey(event); key != "" {
			if seen[key] {
				continue
			}
			seen[key] = true
		}
		result = append(result, event)
	}
	return result
}

// Follower streams a Tag's reply and the work Sessions it starts.
type Follower struct {
	Client *Client
	// Interval is the first pause before resuming a dropped stream; pauses double to a minute.
	Interval time.Duration
	// IdleTimeout is how long a stream may go without an event, heartbeats included, before it
	// counts as dropped.
	IdleTimeout time.Duration
	// ReconnectTimeout is how long resuming may fail before the follow gives up.
	ReconnectTimeout time.Duration
	// WorkTimeout is how long work Sessions are followed after the reply.
	WorkTimeout time.Duration

	mu     sync.Mutex
	active map[string]map[string]int
}

// NewFollower returns a follower with the CLI's timings.
func NewFollower(c *Client) *Follower {
	return &Follower{Client: c, Interval: time.Second, IdleTimeout: 45 * time.Second, ReconnectTimeout: 10 * time.Minute, WorkTimeout: time.Hour}
}

// Follow streams the message's reply, then its work Sessions until each one reports. shown is
// what is already shown of the message, from History; nil for a message just sent. The channel
// closes when there is nothing more to follow or ctx ends.
func (f *Follower) Follow(ctx context.Context, tag string, message *operatorv1.Message, shown *Shown) <-chan FollowEvent {
	return f.followMessage(ctx, tag, message, shown, false)
}

// FollowObjective follows a Task submitted through an Objective's owner Session.
func (f *Follower) FollowObjective(ctx context.Context, tag string, message *operatorv1.Message) <-chan FollowEvent {
	return f.followMessage(ctx, tag, message, nil, true)
}

func (f *Follower) followMessage(ctx context.Context, tag string, message *operatorv1.Message, shown *Shown, objective bool) <-chan FollowEvent {
	if shown == nil {
		shown = newShown(tag, message.GetConversation())
	}
	release := f.register(tag, message.GetTaskId())
	events := make(chan FollowEvent, 16)
	emit := func(list ...FollowEvent) {
		for _, event := range list {
			select {
			case events <- event:
			case <-ctx.Done():
				return
			}
		}
	}
	go func() {
		defer close(events)
		defer release()
		var err error
		if f.Client.RuntimeV2() {
			err = f.followRuntime(ctx, tag, message.GetTaskId(), shown, objective, emit)
		} else {
			err = f.follow(ctx, tag, message, shown, emit)
		}
		if err != nil && ctx.Err() == nil {
			emit(FollowEvent{Kind: EventError, Text: err.Error()})
		}
	}()
	return events
}

// register records a follow of message taskID, so a later message delivered into its turn hands
// the reply and work over to this follow.
func (f *Follower) register(tag, taskID string) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.active == nil {
		f.active = map[string]map[string]int{}
	}
	if f.active[tag] == nil {
		f.active[tag] = map[string]int{}
	}
	f.active[tag][taskID]++
	var once sync.Once
	return func() {
		once.Do(func() {
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.active[tag][taskID]--; f.active[tag][taskID] <= 0 {
				delete(f.active[tag], taskID)
			}
		})
	}
}

func (f *Follower) following(tag, taskID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.active[tag][taskID] > 0
}

// errStreamEnded is a stream that closed before its end event.
var errStreamEnded = errors.New("the Control Plane closed the stream early")

// errIdle is a stream that went quiet for longer than heartbeats allow.
var errIdle = errors.New("the Control Plane stopped sending events")

// followState carries one follow across resumed streams.
type followState struct {
	tag     string
	message *operatorv1.Message
	shown   *Shown
	after   int64
	// workTimer stops the follow WorkTimeout after the reply.
	workTimer *time.Timer
	timedOut  atomic.Bool
	stopWork  context.CancelFunc
	// deferred says the message joined a turn another follow shows, so this follow shows
	// nothing more unless the delivery is withdrawn and the message runs as its own turn.
	deferred bool
}

func (f *Follower) follow(ctx context.Context, tag string, message *operatorv1.Message, shown *Shown, emit func(...FollowEvent)) error {
	workCtx, stopWork := context.WithCancel(ctx)
	defer stopWork()
	state := &followState{tag: tag, message: message, shown: shown, stopWork: stopWork}
	defer func() {
		if state.workTimer != nil {
			state.workTimer.Stop()
		}
	}()
	if shown.replied {
		f.startWork(state)
	}
	backoff := f.Interval
	lastProgress := time.Now()
	for {
		done, progressed, err := f.stream(workCtx, state, emit)
		if state.timedOut.Load() {
			emit(FollowEvent{Kind: EventStillWorking, Text: fmt.Sprintf("Tag %s is still working; each report will arrive in the %s conversation.", tag, conversationName(message))})
			return nil
		}
		if done || ctx.Err() != nil {
			return nil
		}
		if !transient(err) {
			return apiError(err)
		}
		if progressed {
			backoff, lastProgress = f.Interval, time.Now()
		}
		if time.Since(lastProgress) > f.ReconnectTimeout {
			return fmt.Errorf("lost the Control Plane while following task/%s: %w", message.GetTaskId(), apiError(err))
		}
		if !pause(workCtx, backoff) {
			continue
		}
		backoff = min(backoff*2, time.Minute)
	}
}

func conversationName(message *operatorv1.Message) string {
	if name := message.GetConversation(); name != "" {
		return name
	}
	return "default"
}

func (f *Follower) startWork(state *followState) {
	if state.workTimer != nil {
		return
	}
	state.workTimer = time.AfterFunc(f.WorkTimeout, func() {
		state.timedOut.Store(true)
		state.stopWork()
	})
}

// stream reads one FollowMessage stream from the last sequence seen. done says the follow is
// over: the stream ended. progressed says the stream delivered an event.
func (f *Follower) stream(ctx context.Context, state *followState, emit func(...FollowEvent)) (done, progressed bool, err error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var idle atomic.Bool
	timer := time.AfterFunc(f.IdleTimeout, func() {
		idle.Store(true)
		cancel()
	})
	defer timer.Stop()
	stream, err := f.Client.conversations.FollowMessage(ctx, connect.NewRequest(&operatorv1.FollowMessageRequest{
		Tag: state.tag, TaskId: state.message.GetTaskId(), AfterSequence: state.after,
	}))
	if err != nil {
		return false, false, err
	}
	defer stream.Close()
	shown := state.shown
	for stream.Receive() {
		timer.Reset(f.IdleTimeout)
		progressed = true
		event := stream.Msg()
		if event.GetSequence() > state.after {
			state.after = event.GetSequence()
		}
		if _, joined := event.GetPart().(*operatorv1.FollowEvent_Joined); state.deferred && !joined {
			if _, end := event.GetPart().(*operatorv1.FollowEvent_End); end {
				return true, true, nil
			}
			continue
		}
		switch part := event.GetPart().(type) {
		case *operatorv1.FollowEvent_Joined:
			joined := part.Joined.GetTaskId()
			if joined != "" {
				emit(shown.join()...)
			}
			state.deferred = joined != "" && joined != state.message.GetTaskId() && f.following(state.tag, joined)
		case *operatorv1.FollowEvent_Waiting:
			emit(shown.wait(part.Waiting.GetReason())...)
		case *operatorv1.FollowEvent_TextDelta:
			if text := part.TextDelta.GetText(); text != "" && !shown.replied {
				emit(FollowEvent{Kind: EventDelta, Text: text})
			}
		case *operatorv1.FollowEvent_Activity:
			activity := part.Activity
			line := ActivityLine(activity)
			if line == "" {
				continue
			}
			if id := activity.GetWorkSessionId(); id != "" {
				emit(FollowEvent{Kind: EventActivity, Title: shown.title(id), Text: line, Indent: true, WorkSession: id})
			} else if !shown.replied {
				emit(FollowEvent{Kind: EventActivity, Text: line})
			}
		case *operatorv1.FollowEvent_Finish:
			reply := part.Finish.GetReply()
			if reply == nil {
				reply = part.Finish.GetMessage().GetReply()
			}
			emit(shown.reply(reply)...)
			emit(shown.message(part.Finish.GetMessage())...)
			f.startWork(state)
		case *operatorv1.FollowEvent_Error:
			emit(shown.turnError(part.Error.GetText())...)
		case *operatorv1.FollowEvent_WorkSessionChanged:
			emit(shown.workSession(part.WorkSessionChanged.GetWorkSession())...)
		case *operatorv1.FollowEvent_End:
			emit(shown.message(part.End.GetMessage())...)
			return true, true, nil
		}
	}
	if err := stream.Err(); err != nil && !idle.Load() {
		return false, progressed, err
	}
	if idle.Load() {
		return false, progressed, errIdle
	}
	return false, progressed, errStreamEnded
}

// ActivityLine is the short line for an activity, or "" for one not shown: a command or tool the
// Tag starts, or a retry. An activity of a kind this client does not know shows its text.
func ActivityLine(activity *operatorv1.Activity) string {
	switch detail := activity.GetDetail().(type) {
	case *operatorv1.Activity_Command:
		if detail.Command.GetStatus() == operatorv1.ActivityStatus_ACTIVITY_STATUS_RUNNING {
			return "· running: " + detail.Command.GetCommand()
		}
		return ""
	case *operatorv1.Activity_Tool:
		if detail.Tool.GetStatus() == operatorv1.ActivityStatus_ACTIVITY_STATUS_RUNNING {
			return "· using: " + detail.Tool.GetTool()
		}
		return ""
	case *operatorv1.Activity_Retry:
		return "· retrying (Task Attempt " + strconv.Itoa(int(detail.Retry.GetAttempt())) + ")"
	}
	if text := activity.GetText(); text != "" {
		return "· " + text
	}
	return ""
}
