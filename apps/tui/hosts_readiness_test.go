package main

import (
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	"testing"
)

func TestRuntimeHostSummaryPreservesPendingSuppressedAndOffline(t *testing.T) {
	var hosts []*operatorv1.WorkerHost
	labels := map[string]string{}
	for _, phase := range []string{"ready", "busy", "pending", "suppressed", "offline", "revoked"} {
		hosts = append(hosts, host(phase, operatorv1.WorkerHostPhase_WORKER_HOST_PHASE_UNSPECIFIED))
		labels[phase] = phase
	}
	want := "Worker Hosts: 1 ready, 1 busy, 1 pending, 1 suppressed, 1 offline"
	if got := runtimeHostSummary(hosts, labels); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
