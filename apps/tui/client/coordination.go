package client

import (
	"context"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// maxObjectivePages and maxInboxPages bound the list calls, so a very large organization still
// gets an answer.
const (
	maxObjectivePages = 10
	maxInboxPages     = 10
)

// overviewTasks is the page of Tasks DescribeObjective returns. The UI shows none of them, only
// the Sessions, which come whole on every page.
const overviewTasks = 1

// ListOpenObjectives returns the Objectives that are neither completed nor cancelled, the most
// recently created first.
func (c *Client) ListOpenObjectives(ctx context.Context) ([]*operatorv1.Objective, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var open []*operatorv1.Objective
	token := ""
	for range maxObjectivePages {
		res, err := c.objectives.ListObjectives(ctx, connect.NewRequest(&operatorv1.ListObjectivesRequest{PageSize: 200, PageToken: token}))
		if err != nil {
			return nil, apiError(err)
		}
		for _, objective := range res.Msg.GetObjectives() {
			if !Closed(objective.GetStatus()) {
				open = append(open, objective)
			}
		}
		token = res.Msg.GetNextPageToken()
		if token == "" {
			break
		}
	}
	return open, nil
}

// Closed reports whether an Objective in status runs nothing more.
func Closed(status operatorv1.ObjectiveStatus) bool {
	return status == operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_COMPLETED || status == operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_CANCELLED
}

// DescribeObjective reads the operator's view of an Objective, as `supertag describe objective`
// shows it.
func (c *Client) DescribeObjective(ctx context.Context, id string) (*operatorv1.ObjectiveOverview, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.objectives.DescribeObjective(ctx, connect.NewRequest(&operatorv1.DescribeObjectiveRequest{Id: id, PageSize: overviewTasks}))
	if err != nil {
		return nil, apiError(err)
	}
	return res.Msg, nil
}

// Inbox is what waits on the operator.
type Inbox struct {
	// Items are the items an operator decides, the longest waiting first.
	Items []*operatorv1.InboxItem
	// TagNames are the display names of the Tags the items name, by Tag ID.
	TagNames map[string]string
	// Truncated says some items are missing: a kind's scan reached its bound, or there were more
	// pages than the client reads.
	Truncated bool
}

// ListInbox returns the inbox items an operator decides.
func (c *Client) ListInbox(ctx context.Context) (Inbox, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	inbox := Inbox{TagNames: map[string]string{}}
	token := ""
	for page := range maxInboxPages {
		res, err := c.inbox.ListInboxItems(ctx, connect.NewRequest(&operatorv1.ListInboxItemsRequest{PageSize: 100, PageToken: token}))
		if err != nil {
			return Inbox{}, apiError(err)
		}
		for _, item := range res.Msg.GetItems() {
			if item.GetOperatorEligible() {
				inbox.Items = append(inbox.Items, item)
			}
		}
		for id, name := range res.Msg.GetTagNames() {
			inbox.TagNames[id] = name
		}
		if len(res.Msg.GetTruncatedKinds()) > 0 {
			inbox.Truncated = true
		}
		token = res.Msg.GetNextPageToken()
		if token == "" {
			break
		}
		if page == maxInboxPages-1 {
			inbox.Truncated = true
		}
	}
	return inbox, nil
}

// Approve approves a pending approval request once. It is not retried: a repeat of a call that
// reached the Control Plane fails because the request is no longer pending.
func (c *Client) Approve(ctx context.Context, id string) (*operatorv1.Approval, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.inbox.Approve(ctx, connect.NewRequest(&operatorv1.ApproveRequest{Id: id, Scope: operatorv1.ApprovalScope_APPROVAL_SCOPE_ONCE}))
	if err != nil {
		return nil, apiError(err)
	}
	return res.Msg, nil
}

// Deny denies a pending approval request with a reason the Session that asked reads. It is not
// retried, as Approve is not.
func (c *Client) Deny(ctx context.Context, id, reason string) (*operatorv1.Approval, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.inbox.Deny(ctx, connect.NewRequest(&operatorv1.DenyRequest{Id: id, Reason: reason}))
	if err != nil {
		return nil, apiError(err)
	}
	return res.Msg, nil
}

// AnswerQuestion sends text as the answer to the question inbox item key stands for. A retry
// reuses the same idempotency key, so the owner gets the answer once.
func (c *Client) AnswerQuestion(ctx context.Context, key, text string) (*operatorv1.MessageObjectiveResponse, error) {
	idempotency, err := idempotencyKey()
	if err != nil {
		return nil, err
	}
	request := &operatorv1.AnswerQuestionRequest{Key: key, Text: text, IdempotencyKey: idempotency}
	return retrying(ctx, func(ctx context.Context) (*operatorv1.MessageObjectiveResponse, error) {
		res, err := c.inbox.AnswerQuestion(ctx, connect.NewRequest(request))
		if err != nil {
			return nil, err
		}
		return res.Msg, nil
	})
}
