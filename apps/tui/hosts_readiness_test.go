package main

import (
	"testing"

	"github.com/atemaguer/supertag/apps/tui/views"
)

func TestRuntimeHostSummaryPreservesPendingSuppressedAndOffline(t *testing.T) {
	var hosts []*views.WorkerHost
	labels := map[string]string{}
	for _, phase := range []string{"ready", "busy", "pending", "suppressed", "offline", "revoked"} {
		hosts = append(hosts, host(phase, views.WorkerHostPhase_WORKER_HOST_PHASE_UNSPECIFIED))
		labels[phase] = phase
	}
	want := "Worker Hosts: 1 ready, 1 busy, 1 pending, 1 suppressed, 1 offline"
	if got := runtimeHostSummary(hosts, labels); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
