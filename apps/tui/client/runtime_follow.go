package client

import (
	"context"
	"fmt"
	"time"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
)

const runtimeEventPage = 32

// GetObjectiveMessage reads an owner Session Task through the operator API.
func (c *Client) GetObjectiveMessage(ctx context.Context, tag, id string) (*operatorv1.Message, error) {
	if !c.RuntimeV2() {
		return c.GetMessage(ctx, tag, id)
	}
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

func (c *runtimeClient) listMessageEvents(ctx context.Context, tag, id string, after uint64, objective bool) ([]*v2.TaskEvent, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var res *connect.Response[v2.ListEventsResponse]
	var err error
	if objective {
		res, err = c.operator.ListEvents(ctx, connect.NewRequest(&v2.ListEventsRequest{TaskId: id, AfterSequence: after, Limit: runtimeEventPage}))
	} else {
		res, err = c.conversations.ListMessageEvents(ctx, connect.NewRequest(&v2.ListMessageEventsRequest{TagId: tag, TaskId: id, AfterSequence: after, Limit: runtimeEventPage}))
	}
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
	children  map[string]uint64
	workSince time.Time
}

func (f *Follower) followRuntime(ctx context.Context, tag, id string, shown *Shown, objective bool, emit func(...FollowEvent)) error {
	state := runtimeFollow{tag: tag, task: id, delegated: shown.joinedOnPage, shown: shown, objective: objective, children: map[string]uint64{}}
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

func (f *Follower) pollRuntime(ctx context.Context, state *runtimeFollow, emit func(...FollowEvent)) (done, more bool, err error) {
	runtime := f.Client.runtime
	read := runtime.getMessage
	if state.objective {
		read = runtime.getObjectiveTask
	}
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
		events, err := runtime.listMessageEvents(ctx, state.tag, source, state.after, state.objective)
		if err != nil {
			return false, false, err
		}
		previous := state.after
		for _, event := range events {
			if event.GetSequence() <= state.after {
				continue
			}
			state.after = event.GetSequence()
			if event.GetText() != "" {
				emit(FollowEvent{Kind: EventDelta, Text: event.GetText()})
			}
		}
		if len(events) >= runtimeEventPage {
			if state.after == previous {
				return false, false, workSessionDataLoss("Control Plane event cursor did not advance.")
			}
			return false, true, nil
		}
		if reply := runtimeReply(task); reply != nil {
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
		events, err := runtime.listMessageEvents(ctx, work.GetTagId(), id, after, true)
		if err != nil {
			return false, false, err
		}
		for _, event := range events {
			if event.GetSequence() <= state.children[id] {
				continue
			}
			state.children[id] = event.GetSequence()
			if event.GetText() != "" {
				emit(FollowEvent{Kind: EventActivity, Text: event.GetText(), Indent: true, WorkSession: work.GetWorkSessionId(), Title: state.shown.title(work.GetWorkSessionId()), TaskID: id, Sequence: event.GetSequence()})
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
		if view.GetReportStatus() != operatorv1.ReplyStatus_REPLY_STATUS_REPLIED {
			settled = false
		}
	}
	return settled, more, nil
}
