package client

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
)

const runtimeWorkSessionsPerTask = 4

func workSessionDataLoss(message string) error {
	return &APIError{Code: connect.CodeDataLoss, Message: message}
}

func (c *runtimeClient) getWorkSession(ctx context.Context, id string) (*v2.WorkSession, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.workSessions.Get(ctx, connect.NewRequest(&v2.GetWorkSessionRequest{WorkSessionId: id}))
	if err != nil {
		return nil, apiError(err)
	}
	work := res.Msg
	if work.GetWorkSessionId() != id || work.GetLatestTaskId() == "" || work.GetTagId() == "" || work.GetStarterTaskId() == "" || work.GetParentSessionId() == "" || work.GetParentTagId() == "" {
		return nil, workSessionDataLoss("Gateway returned a different or incomplete Work Session.")
	}
	return work, nil
}

// messageWorkSessions keeps the exact parent Tag, Session and starter Task in
// every request. A report row resolves only its explicitly recorded Work Session.
func (c *runtimeClient) messageWorkSessions(ctx context.Context, message *v2.ConversationMessage) ([]*v2.WorkSession, error) {
	task := message.GetTask()
	if id := message.GetWorkSessionReportId(); id != "" {
		work, err := c.getWorkSession(ctx, id)
		if err != nil {
			return nil, err
		}
		if work.GetReportTaskId() != task.GetTaskId() || work.GetParentTagId() != task.GetTagId() || work.GetParentSessionId() != task.GetSessionId() {
			return nil, workSessionDataLoss("Gateway returned a Work Session outside this report's scope.")
		}
		return []*v2.WorkSession{work}, nil
	}
	if task.GetSessionId() == "" {
		return nil, nil
	}
	if input := message.GetLiveInput(); input != nil && input.GetState() != v2.LiveInputState_LIVE_INPUT_STATE_WITHDRAWN {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var result []*v2.WorkSession
	cursor := ""
	seen, ids := map[string]bool{}, map[string]bool{}
	for range runtimeWorkSessionsPerTask + 1 {
		res, err := c.workSessions.List(ctx, connect.NewRequest(&v2.ListWorkSessionsRequest{
			ParentTagId: task.GetTagId(), ParentSessionId: task.GetSessionId(), StarterTaskId: &task.TaskId,
			Limit: runtimeWorkSessionsPerTask, Cursor: cursor,
		}))
		if err != nil {
			// Only an absent service is compatible with an older Gateway. Scope,
			// authentication and transport failures must never mean "no children".
			if cursor == "" && connect.CodeOf(err) == connect.CodeUnimplemented {
				return nil, nil
			}
			return nil, apiError(err)
		}
		for _, work := range res.Msg.GetWorkSessions() {
			if work.GetWorkSessionId() == "" || ids[work.GetWorkSessionId()] || work.GetLatestTaskId() == "" || work.GetTagId() == "" || work.GetParentTagId() != task.GetTagId() || work.GetParentSessionId() != task.GetSessionId() || work.GetStarterTaskId() != task.GetTaskId() {
				return nil, workSessionDataLoss("Gateway returned a Work Session outside this message's scope.")
			}
			ids[work.GetWorkSessionId()] = true
			result = append(result, work)
		}
		if len(result) > runtimeWorkSessionsPerTask {
			return nil, workSessionDataLoss("Gateway exceeded the Work Session limit for this Task.")
		}
		cursor = res.Msg.GetNextCursor()
		if cursor == "" {
			return result, nil
		}
		if seen[cursor] {
			return nil, workSessionDataLoss("Gateway Work Session cursor did not advance.")
		}
		seen[cursor] = true
	}
	return nil, workSessionDataLoss("Gateway exceeded the Work Session page limit.")
}

func runtimeWork(work *v2.WorkSession) *operatorv1.WorkSession {
	out := &operatorv1.WorkSession{Id: work.GetWorkSessionId(), Title: work.GetTitle(), TaskId: work.GetLatestTaskId(), ReportTaskId: work.GetReportTaskId(), ReportStatus: operatorv1.ReplyStatus_REPLY_STATUS_WAITING, Status: operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_RUNNING}
	switch work.GetLatestTaskState() {
	case v2.TaskState_TASK_STATE_QUEUED, v2.TaskState_TASK_STATE_CLAIMED:
		out.Status = operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_PENDING
	case v2.TaskState_TASK_STATE_UNCERTAIN:
		out.Status = operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_WAITING
	case v2.TaskState_TASK_STATE_SUCCEEDED:
		out.Status = operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_COMPLETED
	case v2.TaskState_TASK_STATE_FAILED:
		out.Status = operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_FAILED
	case v2.TaskState_TASK_STATE_CANCELLED:
		out.Status = operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_CANCELLED
	}
	return out
}

func (c *runtimeClient) projectWork(ctx context.Context, work *v2.WorkSession, report *v2.Task) (*operatorv1.WorkSession, error) {
	out := runtimeWork(work)
	if work.GetReportTaskId() == "" {
		return out, nil
	}
	if report == nil || report.GetTaskId() != work.GetReportTaskId() {
		message, err := c.getObjectiveTask(ctx, work.GetParentTagId(), work.GetReportTaskId())
		if err != nil {
			return nil, err
		}
		report = message.GetTask()
	}
	if report.GetTaskId() != work.GetReportTaskId() || report.GetTagId() != work.GetParentTagId() || report.GetSessionId() != work.GetParentSessionId() {
		return nil, workSessionDataLoss("Gateway returned a different Work Session report Task.")
	}
	out.Report = runtimeReply(report)
	if out.Report != nil {
		out.ReportStatus = operatorv1.ReplyStatus_REPLY_STATUS_REPLIED
		if report.GetState() == v2.TaskState_TASK_STATE_FAILED {
			out.Status = operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_FAILED
		} else if report.GetState() == v2.TaskState_TASK_STATE_CANCELLED {
			out.Status = operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_CANCELLED
		}
	}
	return out, nil
}

func (c *runtimeClient) projectMessage(ctx context.Context, message *v2.ConversationMessage) (*operatorv1.Message, error) {
	out := runtimeMessage(message)
	works, err := c.messageWorkSessions(ctx, message)
	if err != nil {
		return nil, err
	}
	for _, work := range works {
		view, err := c.projectWork(ctx, work, message.GetTask())
		if err != nil {
			return nil, err
		}
		out.WorkSessions = append(out.WorkSessions, view)
	}
	if message.GetWorkSessionReportId() != "" {
		out.Reply, out.WaitingReason = nil, ""
	}
	return out, nil
}

// isWorkReport uses the authoritative report Task link, never prompt text.
func isWorkReport(message *operatorv1.Message) bool {
	for _, work := range message.GetWorkSessions() {
		if work.GetReportTaskId() != "" && work.GetReportTaskId() == message.GetTaskId() {
			return true
		}
	}
	return false
}

func (c *runtimeClient) getWorkSessionDetail(ctx context.Context, id string) (*operatorv1.Session, error) {
	if !strings.HasPrefix(id, "work/") {
		return nil, unavailable("Root Session details")
	}
	work, err := c.getWorkSession(ctx, id)
	if err != nil {
		return nil, err
	}
	message, err := c.getObjectiveTask(ctx, work.GetTagId(), work.GetLatestTaskId())
	if err != nil {
		return nil, err
	}
	task := message.GetTask()
	if task.GetSessionId() != id {
		return nil, workSessionDataLoss("Gateway returned a Task outside this Work Session.")
	}
	status := operatorv1.TaskStatus_TASK_STATUS_RUNNING
	switch task.GetState() {
	case v2.TaskState_TASK_STATE_QUEUED, v2.TaskState_TASK_STATE_CLAIMED:
		status = operatorv1.TaskStatus_TASK_STATUS_PENDING
	case v2.TaskState_TASK_STATE_SUCCEEDED:
		status = operatorv1.TaskStatus_TASK_STATUS_COMPLETED
	case v2.TaskState_TASK_STATE_FAILED:
		status = operatorv1.TaskStatus_TASK_STATUS_FAILED
	case v2.TaskState_TASK_STATE_CANCELLED:
		status = operatorv1.TaskStatus_TASK_STATUS_CANCELLED
	case v2.TaskState_TASK_STATE_UNCERTAIN:
		status = operatorv1.TaskStatus_TASK_STATUS_UNSPECIFIED
	}
	return &operatorv1.Session{Id: id, TagId: work.GetTagId(), Tag: work.GetTagId(), Title: work.GetTitle(), ParentSessionId: work.GetParentSessionId(), ObjectiveId: work.GetObjectiveId(), LatestTaskId: task.GetTaskId(), LatestTaskStatus: status}, nil
}

func (c *runtimeClient) taskActivity(ctx context.Context, task string, after int64) ([]Activity, int64, error) {
	if after < 0 {
		return nil, after, fmt.Errorf("event sequence cannot be negative")
	}
	var activity []Activity
	for range maxEventPages {
		events, err := c.listMessageEvents(ctx, "", task, uint64(after), true)
		if err != nil {
			return nil, after, err
		}
		prior := after
		for _, event := range events {
			if event.GetSequence() <= uint64(after) {
				continue
			}
			if event.GetSequence() > uint64(^uint64(0)>>1) {
				return nil, after, workSessionDataLoss("Gateway event sequence exceeds the presentation limit.")
			}
			after = int64(event.GetSequence())
			if event.GetText() != "" {
				activity = append(activity, Activity{Key: task + ":" + strconv.FormatInt(after, 10), Line: event.GetText()})
			}
		}
		if len(events) < runtimeEventPage {
			return activity, after, nil
		}
		if after == prior {
			return nil, after, workSessionDataLoss("Gateway event cursor did not advance.")
		}
	}
	return activity, after, nil
}
