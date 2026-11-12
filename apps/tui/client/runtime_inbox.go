package client

import (
	"context"
	"errors"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
)

func (c *runtimeClient) listInbox(ctx context.Context) (Inbox, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	inbox := Inbox{TagNames: map[string]string{}}
	cursor := ""
	for range maxInboxPages {
		response, err := c.inbox.ListItems(ctx, connect.NewRequest(&v2.ListInboxItemsRequest{
			PageSize: 100, Cursor: cursor,
		}))
		if err != nil {
			return Inbox{}, apiError(err)
		}
		for _, item := range response.Msg.GetItems() {
			if item.GetOperatorEligible() {
				inbox.Items = append(inbox.Items, runtimeInboxItem(item))
			}
		}
		inbox.Truncated = inbox.Truncated || len(response.Msg.GetTruncatedKinds()) != 0
		next := response.Msg.GetNextCursor()
		if next == "" {
			return inbox, nil
		}
		if next == cursor {
			return Inbox{}, &APIError{Code: connect.CodeDataLoss, Message: "Gateway Inbox cursor did not advance."}
		}
		cursor = next
	}
	inbox.Truncated = true
	return inbox, nil
}

func runtimeInboxItem(item *v2.InboxItem) *operatorv1.InboxItem {
	kind := map[v2.InboxItemKind]operatorv1.InboxItemKind{
		v2.InboxItemKind_INBOX_ITEM_KIND_QUESTION:         operatorv1.InboxItemKind_INBOX_ITEM_KIND_QUESTION,
		v2.InboxItemKind_INBOX_ITEM_KIND_OBJECTIVE_BUDGET: operatorv1.InboxItemKind_INBOX_ITEM_KIND_OBJECTIVE_BUDGET,
		v2.InboxItemKind_INBOX_ITEM_KIND_OBJECTIVE_LIMIT:  operatorv1.InboxItemKind_INBOX_ITEM_KIND_OBJECTIVE_LIMIT,
		v2.InboxItemKind_INBOX_ITEM_KIND_TASK_ATTENTION:   operatorv1.InboxItemKind_INBOX_ITEM_KIND_TASK_ATTENTION,
	}[item.GetKind()]
	out := &operatorv1.InboxItem{
		Key: item.GetKey(), Occurrence: item.GetOccurrence(), Kind: kind,
		ObjectiveId: item.GetObjectiveId(), OperatorEligible: item.GetOperatorEligible(),
		Reason: item.GetReason(), ActionableSince: inboxTime(item.GetActionableSinceMs()),
	}
	if question := item.GetQuestion(); question != nil {
		out.Question = &operatorv1.InboxQuestion{
			Text: question.GetText(), AskedAt: inboxTime(question.GetAskedAtMs()), Truncated: question.GetTruncated(),
		}
	}
	if taskID := item.GetTaskId(); taskID != "" {
		out.Evidence = append(out.Evidence, &operatorv1.InboxEvidence{Record: &operatorv1.InboxEvidence_Task{
			Task: &operatorv1.TaskEvidence{Id: taskID},
		}})
	}
	if attemptID := item.GetAttemptId(); attemptID != "" && item.GetKind() == v2.InboxItemKind_INBOX_ITEM_KIND_TASK_ATTENTION {
		out.UncertainAttempt = &operatorv1.UncertainAttempt{AttemptId: attemptID}
	}
	return out
}

func inboxTime(ms int64) *timestamppb.Timestamp {
	if ms == 0 {
		return nil
	}
	return timestamppb.New(time.UnixMilli(ms))
}

func runtimeQuestionID(key string) (string, error) {
	id, ok := strings.CutPrefix(key, "question:")
	if !ok || id == "" {
		return "", &APIError{Code: connect.CodeInvalidArgument, Message: "Select a question to answer."}
	}
	return id, nil
}

func (c *runtimeClient) answerQuestion(ctx context.Context, key, text string) (*operatorv1.MessageObjectiveResponse, error) {
	taskID, err := runtimeQuestionID(key)
	if err != nil {
		return nil, err
	}
	operation, err := idempotencyKey()
	if err != nil {
		return nil, err
	}
	request := &v2.AnswerQuestionRequest{TaskId: taskID, OperationId: operation, Text: text}
	return retrying(ctx, func(ctx context.Context) (*operatorv1.MessageObjectiveResponse, error) {
		response, err := c.inbox.AnswerQuestion(ctx, connect.NewRequest(request))
		if err != nil {
			return nil, err
		}
		task := response.Msg
		if task.GetTaskId() == "" || task.GetTagId() == "" {
			return nil, connect.NewError(connect.CodeDataLoss, errors.New("Gateway returned an invalid answer receipt."))
		}
		return &operatorv1.MessageObjectiveResponse{TaskId: task.GetTaskId(), Tag: task.GetTagId()}, nil
	})
}

// ReadObjectiveQuestion returns the full question for an open Runtime v2 Inbox item.
func (c *Client) ReadObjectiveQuestion(ctx context.Context, key string) (string, error) {
	if !c.RuntimeV2() {
		return "", unavailable("Reading an Objective question")
	}
	id, err := runtimeQuestionID(key)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	response, err := c.runtime.inbox.GetQuestion(ctx, connect.NewRequest(&v2.GetQuestionRequest{TaskId: id}))
	if err != nil {
		return "", apiError(err)
	}
	if response.Msg.GetTaskId() != id || response.Msg.GetText() == "" {
		return "", &APIError{Code: connect.CodeDataLoss, Message: "Gateway returned an invalid Inbox question."}
	}
	return response.Msg.GetText(), nil
}
