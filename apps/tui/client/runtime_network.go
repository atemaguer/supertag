package client

import (
	"context"
	"time"

	"connectrpc.com/connect"

	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

// NetworkRequest is one request a Task Attempt's egress proxy allowed or refused. It never holds
// headers or bodies, and its path has no query.
type NetworkRequest struct {
	At                                       time.Time
	Method, Origin, Path, Reason, Credential string
	Allowed                                  bool
	// Status is the origin's HTTP status, zero when the request never reached it.
	Status uint32
}

// NetworkLog is a Task Attempt's network log: its first requests and its totals.
type NetworkLog struct {
	Task, Attempt               string
	Allowed, Denied, Unrecorded uint64
	Requests                    []NetworkRequest
}

// NetworkLogs lists the Tag's newest Task Attempts with a network log, newest first. Only
// operators may read them.
func (c *Client) NetworkLogs(ctx context.Context, tag string) ([]NetworkLog, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.runtime.networkLogs.List(ctx, connect.NewRequest(&v2.ListNetworkLogsRequest{TagId: tag, Limit: 20}))
	if err != nil {
		return nil, apiError(err)
	}
	var out []NetworkLog
	for _, entry := range res.Msg.GetLogs() {
		log := entry.GetLog()
		view := NetworkLog{Task: entry.GetTaskId(), Attempt: entry.GetAttemptId(),
			Allowed: log.GetAllowed(), Denied: log.GetDenied(), Unrecorded: log.GetUnrecorded()}
		for _, record := range log.GetRequests() {
			view.Requests = append(view.Requests, NetworkRequest{At: time.UnixMilli(record.GetAtMs()),
				Method: record.GetMethod(), Origin: record.GetOrigin(), Path: record.GetPath(),
				Reason: record.GetReason(), Credential: record.GetCredential(),
				Allowed: record.GetAllowed(), Status: record.GetStatus()})
		}
		out = append(out, view)
	}
	return out, nil
}
