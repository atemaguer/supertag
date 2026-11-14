package client

import (
	"context"

	"github.com/atemaguer/supertag/apps/tui/views"
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
func (c *Client) ListOpenObjectives(ctx context.Context) ([]*views.Objective, error) {
	return c.runtime.listOpenObjectives(ctx)
}

// Closed reports whether an Objective in status runs nothing more.
func Closed(status views.ObjectiveStatus) bool {
	return status == views.ObjectiveStatus_OBJECTIVE_STATUS_COMPLETED || status == views.ObjectiveStatus_OBJECTIVE_STATUS_CANCELLED
}

// NewObjective is what the operator declares when creating an Objective.
type NewObjective struct {
	// ID is the Objective's ID; empty, the Control Plane generates one.
	ID string
	// Outcome is the statement of the result.
	Outcome string
	// Owner names the owner Tag.
	Owner string
	// Team names the Team the owner may hand work to; empty, the owner works alone.
	Team string
	// Budget caps the owner and all the work it starts; nil, no budget.
	Budget *views.Budget
	// Workspace names the registered checkout available to the Objective's work.
	Workspace string
}

// CreateObjective creates an Objective and starts it. Repeating it with the Objective's ID and the
// same definition starts one that could not start before, and creates nothing new. It is not
// retried: without an ID, a repeat of a call that reached the Control Plane would create a second
// Objective.
func (c *Client) CreateObjective(ctx context.Context, objective NewObjective) (*views.CreateObjectiveResponse, error) {
	return c.runtime.createObjective(ctx, objective)
}

// DescribeObjective reads the operator's view of an Objective, as `supertag describe objective`
// shows it.
func (c *Client) DescribeObjective(ctx context.Context, id string) (*views.ObjectiveOverview, error) {
	return c.runtime.describeObjective(ctx, id)
}

// MessageObjective sends a follow-up to the owner in the Objective's own conversation.
func (c *Client) MessageObjective(ctx context.Context, id, text string) (*views.MessageObjectiveResponse, error) {
	return c.runtime.messageObjective(ctx, id, text)
}

// Inbox is what waits on the operator.
type Inbox struct {
	// Items are the items an operator decides, the longest waiting first.
	Items []*views.InboxItem
	// TagNames are the display names of the Tags the items name, by Tag ID.
	TagNames map[string]string
	// Truncated says some items are missing: a kind's scan reached its bound, or there were more
	// pages than the client reads.
	Truncated bool
}

// ListInbox returns the inbox items an operator decides.
func (c *Client) ListInbox(ctx context.Context) (Inbox, error) {
	return c.runtime.listInbox(ctx)
}

// Approve approves a pending approval request once. Runtime v2 retries the same operation.
func (c *Client) Approve(ctx context.Context, id string) (*views.Approval, error) {
	return c.runtime.decideApproval(ctx, id, "", true)
}

// Deny denies a pending approval request with the operator's reason.
func (c *Client) Deny(ctx context.Context, id, reason string) (*views.Approval, error) {
	return c.runtime.decideApproval(ctx, id, reason, false)
}

// AnswerQuestion sends text as the answer to the question inbox item key stands for. A retry
// reuses the same idempotency key, so the owner gets the answer once.
func (c *Client) AnswerQuestion(ctx context.Context, key, text string) (*views.MessageObjectiveResponse, error) {
	return c.runtime.answerQuestion(ctx, key, text)
}
