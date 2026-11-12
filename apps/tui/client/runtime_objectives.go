package client

import (
	"context"
	"math"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
)

func (c *runtimeClient) listOpenObjectives(ctx context.Context) ([]*operatorv1.Objective, error) {
	const pageSize = 12
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var open []*operatorv1.Objective
	after := ""
	for range maxObjectivePages {
		res, err := c.objectives.ListObjectives(ctx, connect.NewRequest(&v2.ListObjectivesRequest{Limit: pageSize, AfterId: after}))
		if err != nil {
			return nil, apiError(err)
		}
		page := res.Msg.GetObjectives()
		for _, objective := range page {
			if !Closed(objectiveStatus(objective.GetStatus())) {
				open = append(open, runtimeObjective(objective))
			}
		}
		if len(page) < pageSize || page[len(page)-1].GetObjectiveId() == after {
			break
		}
		after = page[len(page)-1].GetObjectiveId()
	}
	return open, nil
}

func (c *runtimeClient) createObjective(ctx context.Context, objective NewObjective) (*operatorv1.CreateObjectiveResponse, error) {
	if objective.Workspace != "" {
		return nil, &APIError{Code: connect.CodeFailedPrecondition, Message: "Configure the Workspace on the owner Tag. This Gateway uses the Tag's Workspace for its Objective."}
	}
	id := objective.ID
	if id == "" {
		var err error
		id, err = idempotencyKey()
		if err != nil {
			return nil, err
		}
	}
	body := &v2.CreateObjectiveRequest{
		OperationId: id, ObjectiveId: id, OwnerTagId: objective.Owner, Outcome: objective.Outcome,
	}
	if objective.Team != "" {
		body.TeamId = proto.String(objective.Team)
	}
	if objective.Budget != nil {
		if objective.Budget.GetLimitMinor() < 0 {
			return nil, &APIError{Code: connect.CodeInvalidArgument, Message: "The budget must be nonnegative."}
		}
		limit := uint64(objective.Budget.GetLimitMinor())
		body.BudgetLimitMinor = &limit
		if currency := objective.Budget.GetCurrency(); currency != "" {
			body.BudgetCurrency = &currency
		}
	}
	return retrying(ctx, func(ctx context.Context) (*operatorv1.CreateObjectiveResponse, error) {
		res, err := c.objectives.CreateObjective(ctx, connect.NewRequest(body))
		if err != nil {
			return nil, err
		}
		return &operatorv1.CreateObjectiveResponse{
			Objective: runtimeObjective(res.Msg), StartedTaskId: res.Msg.GetStartingTaskId(),
		}, nil
	})
}

func (c *runtimeClient) getObjective(ctx context.Context, id string) (*v2.Objective, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.objectives.GetObjective(ctx, connect.NewRequest(&v2.GetObjectiveRequest{ObjectiveId: id}))
	if err != nil {
		return nil, apiError(err)
	}
	if res.Msg.GetObjectiveId() != id {
		return nil, &APIError{Code: connect.CodeDataLoss, Message: "Gateway returned a different Objective."}
	}
	return res.Msg, nil
}

func (c *runtimeClient) describeObjective(ctx context.Context, id string) (*operatorv1.ObjectiveOverview, error) {
	objective, err := c.getObjective(ctx, id)
	if err != nil {
		return nil, err
	}
	owner := objective.GetOwnerTagId()
	use := &operatorv1.ObjectiveBudgetUse{
		Currency: objective.GetBudgetCurrency(), LimitMinor: minor(objective.BudgetLimitMinor),
		SpentMinor: minor(objective.ReportedSpendMinor),
	}
	if use.LimitMinor != nil && use.SpentMinor != nil {
		available := *use.LimitMinor - *use.SpentMinor
		use.AvailableMinor = &available
	}
	view := &operatorv1.ObjectiveOverview{
		Objective: runtimeObjective(objective), Budget: use,
		TagNames: map[string]string{owner: owner},
	}
	if id := objective.GetSessionId(); id != "" {
		view.Sessions = []*operatorv1.ObjectiveSession{{Id: id, TagId: owner, Tag: owner, Owner: true}}
	}
	return view, nil
}

func (c *runtimeClient) messageObjective(ctx context.Context, id, text string) (*operatorv1.MessageObjectiveResponse, error) {
	objective, err := c.getObjective(ctx, id)
	if err != nil {
		return nil, err
	}
	key, err := idempotencyKey()
	if err != nil {
		return nil, err
	}
	body := &v2.SubmitTaskRequest{
		TagId: objective.GetOwnerTagId(), SessionId: objective.GetSessionId(), OperationId: key, Prompt: text,
	}
	return retrying(ctx, func(ctx context.Context) (*operatorv1.MessageObjectiveResponse, error) {
		res, err := c.operator.SubmitTask(ctx, connect.NewRequest(body))
		if err != nil {
			return nil, err
		}
		return &operatorv1.MessageObjectiveResponse{TaskId: res.Msg.GetTaskId(), Tag: res.Msg.GetTagId()}, nil
	})
}

func runtimeObjective(objective *v2.Objective) *operatorv1.Objective {
	out := &operatorv1.Objective{
		Id: objective.GetObjectiveId(), Outcome: objective.GetOutcome(),
		OwnerTagId: objective.GetOwnerTagId(), OwnerTag: objective.GetOwnerTagId(),
		TeamId: objective.GetTeamId(),
		Status: objectiveStatus(objective.GetStatus()), Revision: int64(objective.GetRevision()),
		Ongoing:        objective.GetOngoing(),
		RuntimeActions: append([]string(nil), objective.GetRuntimeActions().GetActions()...),
	}
	if objective.DeadlineMs != nil {
		out.Deadline = timestamppb.New(time.UnixMilli(*objective.DeadlineMs))
	}
	if objective.PausedAtMs != nil {
		out.PausedAt = timestamppb.New(time.UnixMilli(*objective.PausedAtMs))
	}
	if limit := minor(objective.BudgetLimitMinor); limit != nil {
		out.Budget = &operatorv1.Budget{LimitMinor: *limit, Currency: objective.GetBudgetCurrency()}
	}
	if spent := minor(objective.ReportedSpendMinor); spent != nil {
		out.Spend = &operatorv1.ObjectiveSpend{AmountMinor: *spent, Currency: objective.GetBudgetCurrency()}
	}
	return out
}

func objectiveStatus(status v2.ObjectiveStatus) operatorv1.ObjectiveStatus {
	// These view enums share names, including the unspecified status.
	return operatorv1.ObjectiveStatus(operatorv1.ObjectiveStatus_value[status.String()])
}

func minor(value *uint64) *int64 {
	if value == nil || *value > math.MaxInt64 {
		return nil
	}
	minor := int64(*value)
	return &minor
}
