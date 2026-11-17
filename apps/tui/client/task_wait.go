package client

import (
	"context"

	"connectrpc.com/connect"

	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

// TaskWait says why a queued Task waits, as `supertag placement explain` does: an uncertain Task
// Attempt that keeps a Worker Host's only slot, a busy or offline host, or labels no host carries.
// It is empty when nothing keeps the Task from running, or the caller may not read placement.
func (c *Client) TaskWait(ctx context.Context, taskID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.runtime.placement.DiagnoseTask(ctx, connect.NewRequest(&v2.DiagnoseTaskPlacementRequest{TaskId: taskID}))
	if connect.CodeOf(err) == connect.CodePermissionDenied {
		return "", nil
	}
	if err != nil {
		return "", apiError(err)
	}
	if res.Msg.GetState() != v2.TaskState_TASK_STATE_QUEUED || res.Msg.GetRequirement() == "" {
		return "", nil
	}
	return res.Msg.GetSummary(), nil
}
