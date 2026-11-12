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
	return runtimeMessage(message), nil
}

func (c *runtimeClient) getObjectiveTask(ctx context.Context, tag, id string) (*v2.ConversationMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.operator.GetTask(ctx, connect.NewRequest(&v2.GetTaskRequest{TaskId: id}))
	if err != nil {
		return nil, apiError(err)
	}
	if res.Msg.GetTaskId() != id || res.Msg.GetTagId() != tag {
		return nil, &APIError{Code: connect.CodeDataLoss, Message: "Gateway returned a different Objective Task."}
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
}

func (f *Follower) followRuntime(ctx context.Context, tag, id string, shown *Shown, objective bool, emit func(...FollowEvent)) error {
	state := runtimeFollow{tag: tag, task: id, delegated: shown.joinedOnPage, shown: shown, objective: objective}
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
			return fmt.Errorf("lost the Gateway while following task/%s: %w", id, err)
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
		if state.delegated == source || f.following(state.tag, source) {
			state.delegated = source
			return runtimeReply(task) != nil, false, nil
		}
		emit(state.shown.wait(runtimeMessage(original).GetWaitingReason())...)
	}
	if state.source != source {
		state.source, state.after = source, 0
	}
	if state.shown.replied {
		return true, false, nil
	}
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
			return false, false, &APIError{Code: connect.CodeDataLoss, Message: "Gateway event cursor did not advance."}
		}
		return false, true, nil
	}
	if reply := runtimeReply(task); reply != nil {
		emit(state.shown.reply(reply)...)
		return true, false, nil
	}
	return false, false, nil
}
