package client

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

const runtimeEventPage = 32

// messageReadEvery is the most polls of a busy turn's events before its message is read again.
const messageReadEvery = 5

// GetObjectiveMessage reads an owner Session Task through the operator API.
func (c *Client) GetObjectiveMessage(ctx context.Context, tag, id string) (*views.Message, error) {
	message, err := c.runtime.getObjectiveTask(ctx, tag, id)
	if err != nil {
		return nil, err
	}
	return c.runtime.projectMessage(ctx, message)
}

func (c *runtimeClient) getObjectiveTask(ctx context.Context, tag, id string) (*v2.ConversationMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.operator.GetTask(ctx, connect.NewRequest(&v2.GetTaskRequest{TaskId: id}))
	if err != nil {
		return nil, apiError(err)
	}
	if res.Msg.GetTaskId() != id || res.Msg.GetTagId() != tag {
		return nil, &APIError{Code: connect.CodeDataLoss, Message: "Control Plane returned a different Objective Task."}
	}
	return &v2.ConversationMessage{Task: res.Msg}, nil
}

// listEvents reads a Task's events after a sequence. Operators and clients read the Tasks they
// may see, which include their conversation turns and their children.
func (c *runtimeClient) listEvents(ctx context.Context, id string, after uint64) ([]*v2.TaskEvent, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.operator.ListEvents(ctx, connect.NewRequest(&v2.ListEventsRequest{TaskId: id, AfterSequence: after, Limit: runtimeEventPage}))
	if err != nil {
		return nil, apiError(err)
	}
	return res.Msg.GetEvents(), nil
}

type runtimeFollow struct {
	tag, task string
	source    string
	delegated string
	after     uint64
	shown     *Shown
	objective bool
	// running says the source turn was last read claimed or running; only then do its events
	// grow, so only then are they read.
	running bool
	// quiet says the last read of the running turn's events found none new: the next poll reads
	// the turn itself, which may have finished.
	quiet bool
	// reads counts the polls since the turn itself was last read; a busy turn is still read
	// every few polls, for its work Sessions.
	reads     int
	children  map[string]uint64
	workSince time.Time
}

func (f *Follower) followRuntime(ctx context.Context, tag, id string, shown *Shown, objective bool, emit func(...FollowEvent)) error {
	state := runtimeFollow{tag: tag, task: id, delegated: shown.joinedOnPage, shown: shown, objective: objective,
		children: map[string]uint64{}, source: id, after: shown.after}
	interval := f.Interval
	if interval <= 0 {
		interval = time.Second
	}
	backoff, lastOK := interval, time.Now()
	for ctx.Err() == nil {
		done, more, err := f.pollRuntime(ctx, &state, emit)
		if done || ctx.Err() != nil {
			return nil
		}
		if state.shown.replied && state.workSince.IsZero() {
			state.workSince = time.Now()
		}
		if f.WorkTimeout > 0 && !state.workSince.IsZero() && time.Since(state.workSince) >= f.WorkTimeout {
			emit(FollowEvent{Kind: EventStillWorking, Text: "Work Sessions are still running or waiting for their reports."})
			return nil
		}
		if err == nil {
			lastOK, backoff = time.Now(), interval
			if more {
				continue
			}
			pause(ctx, interval)
			continue
		}
		if !transient(err) {
			return err
		}
		if time.Since(lastOK) > f.ReconnectTimeout {
			return fmt.Errorf("lost the Control Plane while following task/%s: %w", id, err)
		}
		pause(ctx, backoff)
		backoff = min(backoff*2, time.Minute)
	}
	return nil
}

// pollRuntime reads what changed of the followed turn. While the turn runs, a poll reads only its
// new events with Operator.ListEvents, until a poll finds none; the next then reads the turn
// itself, its state, the events it carries and its work Sessions. A queued or finished turn reads
// no events: the message carries every message its Tag wrote.
func (f *Follower) pollRuntime(ctx context.Context, state *runtimeFollow, emit func(...FollowEvent)) (done, more bool, err error) {
	runtime := f.Client.runtime
	if state.running && !state.quiet && !state.shown.replied && state.reads < messageReadEvery {
		state.reads++
		events, err := runtime.listEvents(ctx, state.source, state.after)
		if err != nil {
			return false, false, err
		}
		if more, err := state.emitEvents(events, emit); more || err != nil {
			return false, more, err
		}
		state.quiet = len(events) == 0
		if !state.quiet {
			return false, false, nil
		}
	}
	read := runtime.getMessage
	if state.objective {
		read = runtime.getObjectiveTask
	}
	state.reads = 0
	message, err := read(ctx, state.tag, state.task)
	if err != nil {
		return false, false, err
	}
	view := runtimeMessage(message)
	emit(state.shown.wait(view.GetWaitingReason())...)
	task := message.GetTask()
	source := state.task
	if joined := view.GetJoinedTaskId(); joined != "" && joined != state.task {
		emit(state.shown.join()...)
		source = joined
		original, err := read(ctx, state.tag, source)
		if err != nil {
			return false, false, err
		}
		task = original.GetTask()
		message = original
		if state.delegated == source || f.following(state.tag, source) {
			state.delegated = source
			return runtimeReply(task) != nil, false, nil
		}
		emit(state.shown.wait(runtimeMessage(original).GetWaitingReason())...)
	}
	if state.source != source {
		state.source, state.after = source, 0
	}
	if message.GetWorkSessionReportId() != "" {
		// The report is rendered through its Work Session, including when its
		// starter is on an older history page. It is not another operator turn.
		state.shown.replied = true
	}
	if !state.shown.replied {
		switch task.GetState() {
		case v2.TaskState_TASK_STATE_QUEUED, v2.TaskState_TASK_STATE_UNSPECIFIED:
			state.running = false
		default:
			emit(state.shown.start()...)
			state.running, state.quiet = true, false
		}
		carried := message.GetEvents()
		if message.GetEventsTruncated() && len(carried) > 0 && carried[0].GetSequence() > state.after+1 {
			// The message left out messages this follow has not shown; read them in order.
			events, err := runtime.listEvents(ctx, source, state.after)
			if err != nil {
				return false, false, err
			}
			if more, err := state.emitEvents(events, emit); more || err != nil {
				return false, more, err
			}
		}
		if _, err := state.emitEvents(carried, emit); err != nil {
			return false, false, err
		}
		if reply := runtimeReply(task); reply != nil {
			state.running = false
			emit(state.shown.reply(reply)...)
		}
	}
	works, err := runtime.messageWorkSessions(ctx, message)
	if err != nil {
		return false, false, err
	}
	settled := state.shown.replied
	for _, work := range works {
		// Show working before activity, but wait until every event page has
		// been read before showing the final parent report.
		emit(state.shown.workSession(runtimeWork(work))...)
		id := work.GetLatestTaskId()
		after := state.children[id]
		events, err := runtime.listEvents(ctx, id, after)
		if err != nil {
			return false, false, err
		}
		for _, event := range events {
			if event.GetSequence() <= state.children[id] {
				continue
			}
			state.children[id] = event.GetSequence()
			if text := eventLine(event); text != "" {
				emit(FollowEvent{Kind: EventActivity, Text: text, Indent: true, WorkSession: work.GetWorkSessionId(), Title: state.shown.title(work.GetWorkSessionId()), TaskID: id, Sequence: event.GetSequence()})
			}
		}
		if len(events) >= runtimeEventPage {
			if after == state.children[id] {
				return false, false, workSessionDataLoss("Control Plane child event cursor did not advance.")
			}
			more, settled = true, false
			continue
		}
		view, err := runtime.projectWork(ctx, work, message.GetTask())
		if err != nil {
			return false, false, err
		}
		emit(state.shown.workSession(view)...)
		if view.GetReportStatus() != views.ReplyStatus_REPLY_STATUS_REPLIED {
			settled = false
		}
	}
	return settled, more, nil
}

// emitEvents shows the turn's events after those already shown, in order. more says a full page
// was read, so more may wait.
func (state *runtimeFollow) emitEvents(events []*v2.TaskEvent, emit func(...FollowEvent)) (more bool, err error) {
	previous := state.after
	for _, event := range events {
		if event.GetSequence() <= state.after {
			continue
		}
		state.after = event.GetSequence()
		state.shown.after = state.after
		if shown, ok := turnEvent(event); ok {
			emit(shown)
		}
	}
	if len(events) >= runtimeEventPage {
		if state.after == previous {
			return false, workSessionDataLoss("Control Plane event cursor did not advance.")
		}
		return true, nil
	}
	return false, nil
}

// turnEvent is what a recorded event of the followed turn shows: a message the Tag wrote, or a
// status line saying what it is doing.
func turnEvent(event *v2.TaskEvent) (FollowEvent, bool) {
	switch event.GetKind() {
	case v2.TaskEventKind_TASK_EVENT_KIND_MESSAGE:
		if strings.TrimSpace(event.GetText()) != "" {
			return FollowEvent{Kind: EventMessage, Text: strings.TrimSpace(event.GetText()), Sequence: event.GetSequence()}, true
		}
	case v2.TaskEventKind_TASK_EVENT_KIND_ACTIVITY, v2.TaskEventKind_TASK_EVENT_KIND_PROGRESS:
		if text := eventLine(event); text != "" {
			return FollowEvent{Kind: EventStatus, Text: text}, true
		}
	}
	return FollowEvent{}, false
}

// eventLine is one line for a recorded event: its text, or a plan's summary and current step.
func eventLine(event *v2.TaskEvent) string {
	if event.GetKind() != v2.TaskEventKind_TASK_EVENT_KIND_PROGRESS {
		return strings.TrimSpace(event.GetText())
	}
	var plan struct {
		Progress struct {
			Summary string `json:"summary"`
			Items   []struct {
				Text   string `json:"text"`
				Status string `json:"status"`
			} `json:"items"`
		} `json:"progress"`
	}
	if json.Unmarshal([]byte(event.GetText()), &plan) != nil {
		return ""
	}
	line := strings.TrimSpace(plan.Progress.Summary)
	for _, item := range plan.Progress.Items {
		if step := strings.TrimSpace(item.Text); item.Status == "active" && step != "" {
			if line == "" {
				return step
			}
			return line + ": " + step
		}
	}
	return line
}
