package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/apps/tui/client"
)

type gatewayDialog struct {
	inputs []textinput.Model
	field  int
	busy   bool
	note   string
	cancel context.CancelFunc
	origin string
}

type gatewayCheckedMsg struct {
	dialog *gatewayDialog
	target client.Target
	err    error
}

// enrolledMsg is a client Auth Key exchanged for this device's enrolled credential.
type enrolledMsg struct {
	dialog    *gatewayDialog
	target    client.Target
	principal string
	err       error
}

func (a *app) closeGatewayDialog() {
	if a.gatewayDialog != nil {
		if a.gatewayDialog.cancel != nil {
			a.gatewayDialog.cancel()
		}
		for i := range a.gatewayDialog.inputs {
			a.gatewayDialog.inputs[i].SetValue("")
		}
	}
	a.gatewayDialog = nil
}

func (a *app) openGatewayDialog(current bool) tea.Cmd {
	if current {
		return a.editGateway(a.contexts[a.current])
	}
	return a.editGateway(client.Target{})
}

func (a *app) editGateway(target client.Target) tea.Cmd {
	if a.isLocal(target) {
		// Its token is never shown or saved; it may change whenever supertag up restarts.
		a.choiceErr = localRefusal
		return nil
	}
	if a.gatewayStore == nil {
		a.choiceErr = "Saved Gateway storage is unavailable."
		return nil
	}
	a.closeGatewayDialog()
	d := &gatewayDialog{}
	for _, placeholder := range []string{"Name", "Gateway URL", "Operator token or client Auth Key", "Server CA file (optional)", "Client certificate file (optional)", "Client key file (optional)"} {
		input := textinput.New()
		input.Prompt = "> "
		input.Placeholder = placeholder
		input.SetWidth(max(a.width-6, 10))
		input.CharLimit = 4096
		d.inputs = append(d.inputs, input)
	}
	d.inputs[0].CharLimit = 64
	d.inputs[1].CharLimit = 2048
	d.inputs[2].CharLimit = 8192
	d.inputs[2].EchoMode = textinput.EchoPassword
	d.inputs[2].EchoCharacter = '•'
	if target.URL != "" {
		d.origin = gatewayOrigin(target.URL)
		for i, value := range []string{target.Name, target.URL, target.Token, target.ServerCAFile, target.ClientCertFile, target.ClientKeyFile} {
			d.inputs[i].SetValue(value)
		}
	}
	a.gatewayDialog = d
	return d.inputs[0].Focus()
}

func (a *app) gatewayKey(msg tea.KeyPressMsg) tea.Cmd {
	d := a.gatewayDialog
	switch msg.String() {
	case "ctrl+c":
		return tea.Quit
	case "esc":
		a.closeGatewayDialog()
		return nil
	}
	if d.busy {
		return nil
	}
	switch msg.String() {
	case "tab", "down", "enter":
		if msg.String() == "enter" && d.field == len(d.inputs)-1 {
			return a.checkGateway()
		}
		d.inputs[d.field].Blur()
		d.field = (d.field + 1) % len(d.inputs)
		return d.inputs[d.field].Focus()
	case "shift+tab", "up":
		d.inputs[d.field].Blur()
		d.field = (d.field + len(d.inputs) - 1) % len(d.inputs)
		return d.inputs[d.field].Focus()
	case "ctrl+s":
		return a.checkGateway()
	}
	var cmd tea.Cmd
	d.inputs[d.field], cmd = d.inputs[d.field].Update(msg)
	return cmd
}

func (a *app) checkGateway() tea.Cmd {
	d := a.gatewayDialog
	target := client.Target{Name: strings.TrimSpace(d.inputs[0].Value()), URL: strings.TrimRight(strings.TrimSpace(d.inputs[1].Value()), "/"), Token: strings.TrimSpace(d.inputs[2].Value())}
	if d.origin != "" && gatewayOrigin(target.URL) != d.origin {
		d.note = "Use Add for a different Gateway URL. An existing credential stays bound to its Control Plane."
		return nil
	}
	paths := []*string{&target.ServerCAFile, &target.ClientCertFile, &target.ClientKeyFile}
	for i, path := range paths {
		value := strings.TrimSpace(d.inputs[i+3].Value())
		if strings.HasPrefix(value, "~/") {
			home, err := os.UserHomeDir()
			if err != nil {
				d.note = "Could not locate the home directory."
				return nil
			}
			value = filepath.Join(home, value[2:])
		}
		if value != "" {
			absolute, err := filepath.Abs(value)
			if err != nil {
				d.note = "Invalid TLS file path."
				return nil
			}
			*path = absolute
		}
	}
	if err := validateSavedGateway(target); err != nil {
		d.note = err.Error()
		return nil
	}
	target.URL = gatewayOrigin(target.URL)
	ctx, cancel := context.WithTimeout(a.root, 10*time.Second)
	d.cancel, d.busy, d.note = cancel, true, ""
	d.inputs[d.field].Blur()
	if client.IsAuthKey(target.Token) {
		// The key joins this device as client:NAME once; only the resulting credential is kept.
		return a.scope(func() tea.Msg {
			defer cancel()
			enrolled, principal, err := client.Enroll(ctx, target, "", client.DeviceName())
			return enrolledMsg{dialog: d, target: enrolled, principal: principal, err: err}
		})
	}
	return a.verifyGateway(ctx, cancel, d, target)
}

// verifyGateway proves the credential by asking the Gateway whose it is.
func (a *app) verifyGateway(ctx context.Context, cancel context.CancelFunc, d *gatewayDialog, target client.Target) tea.Cmd {
	connectTarget := a.connect
	return a.scope(func() tea.Msg {
		defer cancel()
		candidate, err := connectTarget(ctx, target)
		if err == nil {
			defer candidate.client.Close()
			_, err = candidate.client.WhoAmI(ctx)
		}
		return gatewayCheckedMsg{dialog: d, target: target, err: err}
	})
}

func (a *app) gatewayMessage(msg tea.Msg) tea.Cmd {
	if enrolled, ok := msg.(enrolledMsg); ok {
		if a.gatewayDialog != enrolled.dialog {
			return nil
		}
		d := a.gatewayDialog
		if enrolled.err != nil {
			d.busy = false
			if client.ProtocolMismatch(enrolled.err) {
				// The mismatch names both releases and which to upgrade.
				d.note = enrolled.err.Error()
				return d.inputs[d.field].Focus()
			}
			switch connect.CodeOf(enrolled.err) {
			case connect.CodeUnauthenticated, connect.CodePermissionDenied, connect.CodeFailedPrecondition:
				d.note = "The Gateway refused this Auth Key: " + enrolled.err.Error()
			default:
				d.note = "Could not connect to the Gateway. Check its URL, Auth Key and TLS files."
			}
			return d.inputs[d.field].Focus()
		}
		// Only the enrolled credential replaces the key, in the dialog and in what is saved.
		d.inputs[2].SetValue(enrolled.target.Token)
		d.note = "Connected as " + enrolled.principal
		ctx, cancel := context.WithTimeout(a.root, 10*time.Second)
		d.cancel = cancel
		return a.verifyGateway(ctx, cancel, d, enrolled.target)
	}
	checked, ok := msg.(gatewayCheckedMsg)
	if !ok || a.gatewayDialog != checked.dialog {
		return nil
	}
	d := a.gatewayDialog
	d.busy = false
	if checked.err != nil {
		switch {
		case client.ProtocolMismatch(checked.err):
			// The mismatch names both releases and which to upgrade.
			d.note = checked.err.Error()
		case connect.CodeOf(checked.err) == connect.CodeUnauthenticated, connect.CodeOf(checked.err) == connect.CodePermissionDenied:
			d.note = "The Gateway refused this credential."
		default:
			d.note = "Could not connect to the Gateway. Check its URL, credential and TLS files."
		}
		return d.inputs[d.field].Focus()
	}
	profiles, err := a.gatewayStore.save(checked.target)
	if err != nil {
		d.note = err.Error()
		return d.inputs[d.field].Focus()
	}
	a.savedGateways = profiles.Gateways
	active := client.Target{}
	if a.hasTarget {
		active = a.contexts[a.current]
	}
	a.refreshGateways(active)
	choice := 0
	for i, target := range a.contexts {
		if target == checked.target {
			choice = i
			break
		}
	}
	a.closeGatewayDialog()
	if err := a.start(choice); err != nil {
		a.choiceErr = "Saved, but could not connect to this Gateway."
		return nil
	}
	a.choosing = false
	a.refreshGateways(checked.target)
	return a.scope(a.inner.Init())
}

func (a *app) isSavedGateway(target client.Target) bool {
	for _, saved := range a.savedGateways {
		if saved == target {
			return true
		}
	}
	return false
}

func (a *app) forgetGateway() {
	target := a.contexts[a.choice]
	if a.gatewayStore == nil || !a.isSavedGateway(target) {
		a.choiceErr = "This connection was supplied for this launch and is not saved."
		return
	}
	profiles, err := a.gatewayStore.remove(target)
	if err != nil {
		a.choiceErr = err.Error()
		return
	}
	a.savedGateways = profiles.Gateways
	if a.current < 0 || a.current >= len(a.contexts) || cacheOrigin(a.contexts[a.current]) != cacheOrigin(target) {
		// What the terminal UI cached from this Gateway goes with it, unless it is still
		// connected.
		if cache := openCache(cacheOrigin(target)); cache != nil && !a.reachable(target) {
			cache.forget()
		}
	}
	a.refreshGateways(a.contexts[a.current])
	a.choiceErr = "Forgot the saved connection. Active connections stay open until you switch or quit."
}

// reachable says another connection the terminal UI offers, besides target, is to target's
// Gateway.
func (a *app) reachable(target client.Target) bool {
	for _, other := range append(append([]client.Target(nil), a.launchContexts...), a.savedGateways...) {
		if other != target && cacheOrigin(other) == cacheOrigin(target) {
			return true
		}
	}
	return cacheOrigin(a.local) == cacheOrigin(target) && a.local.URL != ""
}

func (a *app) refreshGateways(active client.Target) {
	a.contexts = mergeGateways(a.launchContexts, a.savedGateways)
	if active.URL != "" {
		index := -1
		for i, target := range a.contexts {
			if target == active {
				index = i
				break
			}
		}
		if index < 0 {
			a.contexts = append(a.contexts, active)
			index = len(a.contexts) - 1
		}
		a.current = index
	}
	a.choice = max(min(a.choice, len(a.contexts)-1), 0)
}

func (a *app) rememberGateway() {
	if a.gatewayStore != nil && a.hasTarget && a.isLocal(a.contexts[a.current]) {
		// With no saved Gateway active, the next launch opens the local one again.
		if err := a.gatewayStore.clearActive(); err != nil {
			a.inner.notice = note{text: "Connected, but could not save the selected Gateway.", err: true}
		}
		return
	}
	if a.gatewayStore != nil && a.hasTarget && a.isSavedGateway(a.contexts[a.current]) {
		if err := a.gatewayStore.selectTarget(a.contexts[a.current]); err != nil {
			a.inner.notice = note{text: "Connected, but could not save the selected Gateway.", err: true}
		}
	}
}

func (a *app) renderGatewayDialog() string {
	d := a.gatewayDialog
	height, width := max(a.height-1, 2), max(a.width-2, 10)
	lines := []string{headerStyle.Render("Save a Gateway"), "Connect with an operator token, or join this device with a client Auth Key (stak_…). Only the token or the device's own credential is saved, privately on this machine.", ""}
	for i, label := range []string{"Name", "Gateway URL", "Operator token or client Auth Key", "Server CA file · optional", "Client certificate file · optional", "Client key file · optional"} {
		style := faint
		if i == d.field {
			style = headerStyle
		}
		lines = append(lines, style.Render(label), d.inputs[i].View())
	}
	footer := "tab moves · ctrl+s verifies and saves · esc cancels"
	if d.busy {
		lines = append(lines, "Checking Gateway access…")
		footer = "esc cancels"
	}
	if d.note != "" {
		lines = append(lines, errorStyle.Render(truncate(d.note, width)))
	}
	lines = append(lines, "", faint.Render(truncate(footer, width)))
	return lipgloss.NewStyle().Padding(0, 1).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}

// A supplied launch target always wins. Without a handover, the native TUI reopens its selected
// saved Gateway, else the local Gateway while it runs, else the first saved one;
// credentials still never pass through argv or the environment. The local Gateway, when
// it runs, is listed first; the returned local target is that entry.
func startupTargets(f *os.File, profiles gatewayProfiles, local client.Target) (handover, client.Target, error) {
	if f != nil {
		if info, err := f.Stat(); err == nil && info.Mode()&(os.ModeNamedPipe|os.ModeSocket) != 0 {
			h, err := readHandover(f)
			if err != nil {
				return h, client.Target{}, err
			}
			h.Contexts, h.Current, local = withLocal(h.Contexts, h.Current, local)
			return h, local, nil
		}
		f.Close()
	}
	current := -1
	for i, target := range profiles.Gateways {
		if target.Name == profiles.Active {
			current = i
			break
		}
	}
	if current < 0 && local.URL == "" {
		current = 0
	}
	contexts, current, local := withLocal(profiles.Gateways, current, local)
	if len(contexts) == 0 {
		return handover{Protocol: "runtime.v2"}, local, nil
	}
	return handover{Contexts: contexts, Current: current, Protocol: "runtime.v2"}, local, nil
}
