package client

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/atemaguer/supertag/apps/tui/views"
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
	Reply  *views.Reply
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
	sessions []*views.WorkSession
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

func (s *Shown) reply(reply *views.Reply) []FollowEvent {
	if s.replied || reply == nil {
		return nil
	}
	s.replied = true
	if reply.GetPresentation() == views.ReplyPresentation_REPLY_PRESENTATION_ERROR {
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
func (s *Shown) workSession(session *views.WorkSession) []FollowEvent {
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
	if session.GetReportStatus() == views.ReplyStatus_REPLY_STATUS_REPLIED && session.GetReport() != nil && s.once(reportKey) {
		events = append(events, FollowEvent{Kind: EventReport, Title: session.GetTitle(), Status: reportEnding(session), Text: session.GetReport().GetText(), WorkSession: id, TaskID: session.GetReportTaskId()})
	}
	if session.GetNotContinued() != "" && s.once("stopped:"+task) {
		events = append(events, FollowEvent{Kind: EventNotContinued, Title: session.GetTitle(), Text: session.GetNotContinued(), WorkSession: id})
	}
	return events
}

func (s *Shown) message(message *views.Message) []FollowEvent {
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
		if session.GetReportStatus() != views.ReplyStatus_REPLY_STATUS_REPLIED ||
			(session.GetStatus() == views.WorkSessionStatus_WORK_SESSION_STATUS_WAITING && session.GetQuestion() == "") {
			return false
		}
	}
	return true
}

func reportEnding(session *views.WorkSession) string {
	switch session.GetStatus() {
	case views.WorkSessionStatus_WORK_SESSION_STATUS_COMPLETED:
		return "done"
	case views.WorkSessionStatus_WORK_SESSION_STATUS_WAITING:
		if session.GetQuestion() == "" {
			return "waiting for approval"
		}
		return "waiting on you"
	case views.WorkSessionStatus_WORK_SESSION_STATUS_FAILED:
		return "failed"
	}
	return "stopped"
}

// HistoryItem is one past message as a conversation shows it.
type HistoryItem struct {
	Message *views.Message
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
func History(tag string, page []*views.Message, displayedTaskIDs ...string) []HistoryItem {
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
				item.Follow = message.GetStatus() != views.ReplyStatus_REPLY_STATUS_REPLIED
				items = append(items, item)
				continue
			}
		}
		if isWorkReport(message) {
			shown.replied = true
		} else if message.GetStatus() == views.ReplyStatus_REPLY_STATUS_REPLIED {
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
func (f *Follower) Follow(ctx context.Context, tag string, message *views.Message, shown *Shown) <-chan FollowEvent {
	return f.followMessage(ctx, tag, message, shown, false)
}

// FollowObjective follows a Task submitted through an Objective's owner Session.
func (f *Follower) FollowObjective(ctx context.Context, tag string, message *views.Message) <-chan FollowEvent {
	return f.followMessage(ctx, tag, message, nil, true)
}

func (f *Follower) followMessage(ctx context.Context, tag string, message *views.Message, shown *Shown, objective bool) <-chan FollowEvent {
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

		err = f.followRuntime(ctx, tag, message.GetTaskId(), shown, objective, emit)

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

// ActivityLine is the short line for an activity, or "" for one not shown: a command or tool the
// Tag starts, or a retry. An activity of a kind this client does not know shows its text.
func ActivityLine(activity *views.Activity) string {
	switch detail := activity.GetDetail().(type) {
	case *views.Activity_Command:
		if detail.Command.GetStatus() == views.ActivityStatus_ACTIVITY_STATUS_RUNNING {
			return "· running: " + detail.Command.GetCommand()
		}
		return ""
	case *views.Activity_Tool:
		if detail.Tool.GetStatus() == views.ActivityStatus_ACTIVITY_STATUS_RUNNING {
			return "· using: " + detail.Tool.GetTool()
		}
		return ""
	case *views.Activity_Retry:
		return "· retrying (Task Attempt " + strconv.Itoa(int(detail.Retry.GetAttempt())) + ")"
	}
	if text := activity.GetText(); text != "" {
		return "· " + text
	}
	return ""
}
