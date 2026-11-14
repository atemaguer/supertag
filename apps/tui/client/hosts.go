package client

import (
	"context"
	"math"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
)

// maxHostPages bounds ListWorkerHosts, so an organization with very many Worker Hosts still gets
// an answer.
const maxHostPages = 10

// hostPage is the page size ListWorkerHosts asks for, the most HostService returns.
const hostPage = 500

// ListWorkerHosts returns the organization's Worker Hosts, the earliest enrolled first, as
// `supertag list worker-host` shows them.
func (c *Client) ListWorkerHosts(ctx context.Context) ([]*views.WorkerHost, error) {
	hosts, _, err := c.ListWorkerHostReadiness(ctx)
	return hosts, err
}

// ListWorkerHostReadiness preserves the Runtime's additional readiness phases
// alongside the existing presentation types used by the Go application.
func (c *Client) ListWorkerHostReadiness(ctx context.Context) ([]*views.WorkerHost, map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var hosts []*views.WorkerHost
	labels := map[string]string{}
	cursor := ""
	seen := map[string]bool{}
	for range maxHostPages {
		res, err := c.runtime.operator.ListHosts(ctx, connect.NewRequest(&v2.ListHostsRequest{Limit: hostPage, Cursor: cursor}))
		if err != nil {
			return nil, nil, apiError(err)
		}
		for _, host := range res.Msg.GetHosts() {
			if host.GetHostId() == "" || host.GetCapacity() > math.MaxInt32 || host.GetAvailableSlots() > host.GetCapacity() || host.GetActiveAttempts() > math.MaxInt32 {
				return nil, nil, &APIError{Code: connect.CodeDataLoss, Message: "Control Plane returned invalid Worker Host capacity."}
			}
			if _, exists := labels[host.GetHostId()]; exists {
				return nil, nil, &APIError{Code: connect.CodeDataLoss, Message: "Control Plane repeated a Worker Host."}
			}
			phase, label := runtimeHostPhase(host.GetPhase())
			view := &views.WorkerHost{
				Metadata: &views.Metadata{Id: host.GetHostId(), Name: host.GetHostId(), CreatedAt: timestamppb.New(time.UnixMilli(host.GetEnrolledAtMs()))},
				Phase:    phase, Draining: host.GetDraining(), ConnectionGeneration: int64(host.GetGeneration()),
				Capacity: int32(host.GetCapacity()), AvailableSlots: int32(host.GetAvailableSlots()), ActiveAttempts: int32(host.GetActiveAttempts()),
				Ready: host.GetPhase() == v2.HostPhase_HOST_PHASE_READY, Workspaces: host.GetWorkspaceIds(),
				ConnectionStatus: views.WorkerHostConnection_WORKER_HOST_CONNECTION_DISCONNECTED,
			}
			if host.LastSeenAtMs != nil {
				view.LastSeenAt = timestamppb.New(time.UnixMilli(host.GetLastSeenAtMs()))
			}
			if host.RevokedAtMs != nil {
				view.RevokedAt = timestamppb.New(time.UnixMilli(host.GetRevokedAtMs()))
			}
			if host.GetPhase() == v2.HostPhase_HOST_PHASE_READY || host.GetPhase() == v2.HostPhase_HOST_PHASE_BUSY || host.GetPhase() == v2.HostPhase_HOST_PHASE_SUPPRESSED || host.GetPhase() == v2.HostPhase_HOST_PHASE_DRAINING {
				view.ConnectionStatus = views.WorkerHostConnection_WORKER_HOST_CONNECTION_CONNECTED
			}
			hosts = append(hosts, view)
			labels[host.GetHostId()] = label
		}
		next := res.Msg.GetNextCursor()
		if next == "" {
			return hosts, labels, nil
		}
		if seen[next] {
			return nil, nil, &APIError{Code: connect.CodeDataLoss, Message: "Control Plane Worker Host cursor did not advance."}
		}
		seen[next] = true
		cursor = next
	}
	return nil, nil, &APIError{Code: connect.CodeResourceExhausted, Message: "Worker Host list exceeded the display limit."}
}

func runtimeHostPhase(phase v2.HostPhase) (views.WorkerHostPhase, string) {
	switch phase {
	case v2.HostPhase_HOST_PHASE_READY:
		return views.WorkerHostPhase_WORKER_HOST_PHASE_READY, "ready"
	case v2.HostPhase_HOST_PHASE_BUSY:
		return views.WorkerHostPhase_WORKER_HOST_PHASE_CONNECTED, "busy"
	case v2.HostPhase_HOST_PHASE_PENDING:
		return views.WorkerHostPhase_WORKER_HOST_PHASE_UNSPECIFIED, "pending"
	case v2.HostPhase_HOST_PHASE_SUPPRESSED:
		return views.WorkerHostPhase_WORKER_HOST_PHASE_CONNECTED, "suppressed"
	case v2.HostPhase_HOST_PHASE_OFFLINE:
		return views.WorkerHostPhase_WORKER_HOST_PHASE_UNREACHABLE, "offline"
	case v2.HostPhase_HOST_PHASE_DRAINING:
		return views.WorkerHostPhase_WORKER_HOST_PHASE_DRAINING, "draining"
	case v2.HostPhase_HOST_PHASE_REVOKED:
		return views.WorkerHostPhase_WORKER_HOST_PHASE_REVOKED, "revoked"
	default:
		return views.WorkerHostPhase_WORKER_HOST_PHASE_UNSPECIFIED, "unknown"
	}
}
