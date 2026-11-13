// Command supertag-tui is SuperTag's terminal UI. Plain `supertag` in a terminal starts it and hands it
// the Control Planes to talk to over file descriptor 3.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
)

// version is set at build time.
var version = "dev"

const launchHint = "Run supertag in a terminal to start the terminal UI."

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	store, storeErr := defaultGatewayStore()
	var profiles gatewayProfiles
	if storeErr == nil {
		profiles, storeErr = store.load()
	}
	targetFile := os.NewFile(3, "supertag-target")
	noHandover := true
	if targetFile != nil {
		if info, err := targetFile.Stat(); err == nil && info.Mode()&(os.ModeNamedPipe|os.ModeSocket) != 0 {
			noHandover = false
		}
	}
	h, err := startupTargets(targetFile, profiles)
	if err != nil {
		fmt.Fprintln(os.Stderr, launchHint)
		os.Exit(2)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	connect := dial(version)
	launchContexts := append([]client.Target(nil), h.Contexts...)
	if h.Protocol == "runtime.v2" {
		connect = dialRuntimeV2(version)
		h.Contexts = mergeGateways(h.Contexts, profiles.Gateways)
	}
	a, err := newApp(ctx, connect, h.Contexts, h.Current)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer a.stop()
	if h.Protocol == "runtime.v2" {
		a.gatewayStore = store
		a.savedGateways = profiles.Gateways
		// Only a real handover is a launch-specific connection. Saved-only startup
		// must not retain a forgotten connection after switching away.
		a.launchContexts = launchContexts
		if noHandover {
			a.launchContexts = nil
		}
		if storeErr != nil {
			a.inner.notice = note{text: "Saved Gateways could not be read safely. This launch connection is still available.", err: true}
			a.choiceErr = "Saved Gateways could not be read safely. Check the private profile file and its permissions."
		}
	}
	if _, err := tea.NewProgram(a).Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// handover is what `supertag` writes to descriptor 3: every Control Plane the CLI resolved, and
// the index of the one it selected.
type handover struct {
	Contexts []client.Target `json:"contexts"`
	Current  int             `json:"current"`
	Protocol string          `json:"protocol,omitempty"`
}

// readHandover reads the one JSON line `supertag` writes to the inherited pipe, to EOF. Only a
// pipe or a socket counts (Node's `stdio: "pipe"` is a Unix socketpair), so a stray descriptor 3
// a shell left open on a file or terminal is not read.
func readHandover(f *os.File) (handover, error) {
	var h handover
	if f == nil {
		return h, errors.New("no target descriptor")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return h, err
	}
	if info.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
		return h, errors.New("the target descriptor is not a pipe")
	}
	data, err := io.ReadAll(io.LimitReader(f, 1<<20))
	if err != nil {
		return h, err
	}
	if err := json.Unmarshal(data, &h); err != nil {
		return h, err
	}
	if len(h.Contexts) == 0 || h.Current < 0 || h.Current >= len(h.Contexts) {
		return h, errors.New("the handover needs its Control Planes and the index of the current one")
	}
	if h.Protocol != "" && h.Protocol != "runtime.v2" {
		return h, errors.New("unsupported TUI handover protocol")
	}
	for _, target := range h.Contexts {
		if target.URL == "" || target.Token == "" {
			return h, errors.New("every Control Plane needs a url and a token")
		}
	}
	return h, nil
}
