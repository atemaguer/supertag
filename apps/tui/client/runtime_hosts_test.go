package client

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"connectrpc.com/connect"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	rpc "github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

func TestRuntimeHostReadinessKeepsAllPhasesAndCapacityAcrossPages(t *testing.T) {
	mux := http.NewServeMux()
	testRPC(mux, rpc.OperatorListHostsProcedure, func(_ context.Context, req *v2.ListHostsRequest) (*v2.ListHostsResponse, error) {
		if req.GetCursor() == "" {
			return &v2.ListHostsResponse{Hosts: []*v2.WorkerHostStatus{
				{HostId: "ready", Phase: v2.HostPhase_HOST_PHASE_READY, Capacity: 1, AvailableSlots: 1},
				{HostId: "busy", Phase: v2.HostPhase_HOST_PHASE_BUSY, Capacity: 1, ActiveAttempts: 1},
				{HostId: "pending", Phase: v2.HostPhase_HOST_PHASE_PENDING},
			}, NextCursor: "pending"}, nil
		}
		if req.GetCursor() != "pending" {
			t.Fatalf("unexpected cursor: %q", req.GetCursor())
		}
		return &v2.ListHostsResponse{Hosts: []*v2.WorkerHostStatus{
			{HostId: "suppressed", Phase: v2.HostPhase_HOST_PHASE_SUPPRESSED},
			{HostId: "offline", Phase: v2.HostPhase_HOST_PHASE_OFFLINE},
			{HostId: "revoked", Phase: v2.HostPhase_HOST_PHASE_REVOKED},
		}}, nil
	})
	c := testRuntime(t, mux, false)
	hosts, labels, err := c.ListWorkerHostReadiness(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(hosts) != 6 || hosts[0].GetAvailableSlots() != 1 || hosts[1].GetActiveAttempts() != 1 {
		t.Fatalf("hosts: %v", hosts)
	}
	for _, phase := range []string{"ready", "busy", "pending", "suppressed", "offline", "revoked"} {
		if labels[phase] != phase {
			t.Errorf("%s projected as %q", phase, labels[phase])
		}
	}
}

func TestRuntimeHostReadinessRejectsRepeatedCursors(t *testing.T) {
	mux := http.NewServeMux()
	testRPC(mux, rpc.OperatorListHostsProcedure, func(context.Context, *v2.ListHostsRequest) (*v2.ListHostsResponse, error) {
		return &v2.ListHostsResponse{NextCursor: "repeated"}, nil
	})
	_, _, err := testRuntime(t, mux, false).ListWorkerHostReadiness(context.Background())
	var api *APIError
	if !errors.As(err, &api) || api.Code != connect.CodeDataLoss {
		t.Fatalf("expected cursor data loss, got %v", err)
	}
}
