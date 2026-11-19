package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
)

// The local Gateway is the one `supertag up` runs from this user's state directory
// (SUPERTAG_STATE_DIR, else ~/.supertag). The terminal UI asks the supertag command installed
// beside it, `supertag __local-gateway`, rather than reading the state directory itself:
// the CLI's own code checks the files' ownership and permissions and the supervisor's lock, so
// the format has one reader, and core/crates/cli/tests/local_gateway.rs pins what it
// prints. The token is read again at each connect because `supertag up` may replace it, and it
// is never saved.

// localName is what the Gateway list calls the local Gateway.
const localName = "Local"

// localProtocol is the format `supertag __local-gateway` prints.
const localProtocol = "local-gateway.v2"

const localDiscoveryTimeout = 5 * time.Second

// localDiscovery finds the local Gateway: its target when it runs, else why it is
// unavailable.
type localDiscovery func() (client.Target, string)

type localReport struct {
	Protocol string `json:"protocol"`
	Running  bool   `json:"running"`
	URL      string `json:"url"`
	Token    string `json:"token"`
	Message  string `json:"message"`
}

// localDiscoveredMsg is a fresh look at the local Gateway.
type localDiscoveredMsg struct {
	target  client.Target
	problem string
}

// discoverLocal asks the supertag command beside this executable, else the one on PATH.
func discoverLocal() (client.Target, string) {
	binary := supertagBinary()
	if binary == "" {
		return client.Target{}, "Install supertag beside supertag-tui to connect to a local Gateway."
	}
	ctx, cancel := context.WithTimeout(context.Background(), localDiscoveryTimeout)
	defer cancel()
	return runLocalDiscovery(ctx, binary)
}

// supertagBinary is the supertag command installed with this terminal UI: the release
// directory holds both, and the installed command links into it.
func supertagBinary() string {
	if executable, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(executable); err == nil {
			sibling := filepath.Join(filepath.Dir(resolved), "supertag")
			if info, err := os.Stat(sibling); err == nil && info.Mode().IsRegular() && info.Mode()&0111 != 0 {
				return sibling
			}
		}
	}
	if found, err := exec.LookPath("supertag"); err == nil {
		return found
	}
	return ""
}

func runLocalDiscovery(ctx context.Context, binary string) (client.Target, string) {
	command := exec.CommandContext(ctx, binary, "__local-gateway")
	var stdout, stderr limitedBuffer
	stdout.limit, stderr.limit = 64<<10, 4<<10
	command.Stdin, command.Stdout, command.Stderr = nil, &stdout, &stderr
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return client.Target{}, "Could not check the local Gateway: supertag did not answer in time."
		}
		// The CLI's own sentence, such as a state directory with unsafe permissions. It never
		// contains the token.
		reason := terminalText(strings.TrimPrefix(firstLine(stderr.String()), "Error: "))
		if reason == "" {
			reason = "supertag could not check it"
		}
		return client.Target{}, "Could not check the local Gateway: " + reason
	}
	var report localReport
	if json.Unmarshal(stdout.Bytes(), &report) != nil || report.Protocol != localProtocol {
		return client.Target{}, "Could not check the local Gateway: use the supertag release this terminal UI came with."
	}
	if !report.Running {
		return client.Target{}, terminalText(firstLine(report.Message))
	}
	target := client.Target{Name: localName, URL: report.URL, Token: report.Token}
	if validateSavedGateway(target) != nil {
		return client.Target{}, "Could not check the local Gateway: supertag reported an invalid connection."
	}
	return target, ""
}

// withLocal lists the local Gateway first. A handed-over target for the same Gateway
// and token becomes the local entry, keeping its Workspace. current follows its target; with
// none, the local Gateway is current.
func withLocal(targets []client.Target, current int, local client.Target) ([]client.Target, int, client.Target) {
	if local.URL == "" {
		return targets, current, local
	}
	out := []client.Target{local}
	next := 0
	for i, target := range targets {
		if gatewayOrigin(target.URL) == gatewayOrigin(local.URL) && target.Token == local.Token {
			local.Workspace = target.Workspace
			out[0] = local
			continue
		}
		if i == current {
			next = len(out)
		}
		out = append(out, target)
	}
	return out, next, local
}

// isLocal says whether target is the local entry, including one opened with a token that has
// since changed or for a local Gateway that has since stopped: its token is never shown,
// edited or saved.
func (a *app) isLocal(target client.Target) bool {
	return target.Name == localName && target.URL != "" && !a.isSavedGateway(target)
}

// lookForLocal checks the local Gateway again in the background.
func (a *app) lookForLocal() tea.Cmd {
	if a.discover == nil {
		return nil
	}
	discover := a.discover
	return func() tea.Msg {
		target, problem := discover()
		return localDiscoveredMsg{target: target, problem: problem}
	}
}

// setLocal replaces the local entry with what discovery found now, keeping the row under the
// cursor and the current connection.
func (a *app) setLocal(target client.Target, problem string) {
	old := a.local
	if target.URL != "" {
		target.Workspace = old.Workspace
	}
	var chosen, active client.Target
	if a.choice >= 0 && a.choice < len(a.contexts) {
		chosen = a.contexts[a.choice]
	}
	if a.hasTarget {
		active = a.contexts[a.current]
	}
	launch := make([]client.Target, 0, len(a.launchContexts)+1)
	if target.URL != "" {
		launch = append(launch, target)
	}
	for _, existing := range a.launchContexts {
		if old.URL == "" || existing != old {
			launch = append(launch, existing)
		}
	}
	a.local, a.localProblem, a.launchContexts = target, problem, launch
	if old.URL != "" && target.URL != "" {
		// The connection opened with an earlier token is still the Local entry.
		if active == old {
			active = target
		}
		if chosen == old {
			chosen = target
		}
	}
	a.refreshGateways(active)
	for i, existing := range a.contexts {
		if existing == chosen {
			a.choice = i
			break
		}
	}
}

// chooseLocal connects to the local Gateway with the token its state directory holds now.
func (a *app) chooseLocal() tea.Cmd {
	if a.discover != nil {
		a.setLocal(a.discover())
	}
	if a.local.URL == "" {
		a.choiceErr = a.localProblem
		return nil
	}
	for i, target := range a.contexts {
		if target == a.local {
			a.choice = i
		}
	}
	// The open connection already uses the current token.
	if a.hasTarget && a.choice == a.current && a.inner.client != nil && a.inner.client.Target() == a.local {
		a.choosing = false
		a.rememberGateway()
		return nil
	}
	if err := a.start(a.choice); err != nil {
		a.choiceErr = terminalText(err.Error())
		return nil
	}
	a.choosing = false
	a.rememberGateway()
	a.refreshGateways(a.contexts[a.current])
	return a.scope(a.inner.Init())
}

// localRefusal explains why the local entry cannot be edited, saved or forgotten.
const localRefusal = "Local connects with this machine's own credentials from supertag up and is never saved."
