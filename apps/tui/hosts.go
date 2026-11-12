package main

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// hostRefresh is how often the status bar rereads the Worker Hosts. The watch stream carries no
// Worker Host changes, so they are reread on this interval whether or not it is live.
var hostRefresh = 15 * time.Second

type (
	hostsMsg struct {
		hosts []*operatorv1.WorkerHost
		err   error
	}
	hostTickMsg struct{}
)

// hostPhases are the phases the status bar counts, in the order it shows them. Revoked hosts
// never connect again, so they are left out.
var hostPhases = []struct {
	phase operatorv1.WorkerHostPhase
	label string
}{
	{operatorv1.WorkerHostPhase_WORKER_HOST_PHASE_READY, "ready"},
	{operatorv1.WorkerHostPhase_WORKER_HOST_PHASE_CONNECTED, "connected"},
	{operatorv1.WorkerHostPhase_WORKER_HOST_PHASE_DRAINING, "draining"},
	{operatorv1.WorkerHostPhase_WORKER_HOST_PHASE_UNREACHABLE, "unreachable"},
	{operatorv1.WorkerHostPhase_WORKER_HOST_PHASE_UNSPECIFIED, "unknown"},
}

func (m model) hostsAfter() tea.Cmd {
	if m.client.RuntimeV2() {
		return nil
	}
	return tea.Tick(hostRefresh, func(time.Time) tea.Msg { return hostTickMsg{} })
}

func (m model) reloadHosts() tea.Cmd {
	if m.client.RuntimeV2() || !m.hostReload.start() {
		return nil
	}
	return m.hostsCmd()
}

func (m model) hostsCmd() tea.Cmd {
	return func() tea.Msg {
		hosts, err := m.client.ListWorkerHosts(m.ctx)
		return hostsMsg{hosts: hosts, err: err}
	}
}

// hostsRead keeps what was read of the Worker Hosts. A failed read hides the summary rather than
// keep one that may be stale; the status bar already says when the Control Plane is unreachable.
func (m *model) hostsRead(msg hostsMsg) tea.Cmd {
	var again tea.Cmd
	if m.hostReload.done() {
		again = m.hostsCmd()
	}
	if msg.err != nil {
		m.hosts, m.hostsKnown = nil, false
		return again
	}
	m.hosts, m.hostsKnown = msg.hosts, true
	return again
}

// hostSummary is what the status bar says of the Worker Hosts, such as
// "Worker Hosts: 2 ready, 1 unreachable"; empty until they are read.
func (m model) hostSummary() string {
	if m.client.RuntimeV2() {
		return "Worker Host status unavailable"
	}
	if !m.hostsKnown {
		return ""
	}
	counts := map[operatorv1.WorkerHostPhase]int{}
	total := 0
	for _, host := range m.hosts {
		phase := host.GetPhase()
		switch phase {
		case operatorv1.WorkerHostPhase_WORKER_HOST_PHASE_REVOKED:
			continue
		case operatorv1.WorkerHostPhase_WORKER_HOST_PHASE_READY, operatorv1.WorkerHostPhase_WORKER_HOST_PHASE_CONNECTED,
			operatorv1.WorkerHostPhase_WORKER_HOST_PHASE_DRAINING, operatorv1.WorkerHostPhase_WORKER_HOST_PHASE_UNREACHABLE:
		default:
			phase = operatorv1.WorkerHostPhase_WORKER_HOST_PHASE_UNSPECIFIED
		}
		counts[phase]++
		total++
	}
	if total == 0 {
		return "no Worker Hosts"
	}
	var parts []string
	for _, p := range hostPhases {
		if n := counts[p.phase]; n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", n, p.label))
		}
	}
	return "Worker Hosts: " + strings.Join(parts, ", ")
}
