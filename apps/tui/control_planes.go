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

type controlPlaneDialog struct {
	inputs []textinput.Model
	field  int
	busy   bool
	note   string
	cancel context.CancelFunc
	origin string
}

type controlPlaneCheckedMsg struct {
	dialog *controlPlaneDialog
	target client.Target
	err    error
}

// enrolledMsg is a client Auth Key exchanged for this device's enrolled credential.
type enrolledMsg struct {
	dialog    *controlPlaneDialog
	target    client.Target
	principal string
	err       error
}

func (a *app) manageControlPlanes() bool { return !a.hasTarget || a.inner.client.RuntimeV2() }

func (a *app) closeControlPlaneDialog() {
	if a.controlPlaneDialog != nil {
		if a.controlPlaneDialog.cancel != nil {
			a.controlPlaneDialog.cancel()
		}
		for i := range a.controlPlaneDialog.inputs {
			a.controlPlaneDialog.inputs[i].SetValue("")
		}
	}
	a.controlPlaneDialog = nil
}

func (a *app) openControlPlaneDialog(current bool) tea.Cmd {
	if current {
		return a.editControlPlane(a.contexts[a.current])
	}
	return a.editControlPlane(client.Target{})
}

func (a *app) editControlPlane(target client.Target) tea.Cmd {
	if a.controlPlaneStore == nil {
		a.choiceErr = "Saved Control Plane storage is unavailable."
		return nil
	}
	a.closeControlPlaneDialog()
	d := &controlPlaneDialog{}
	for _, placeholder := range []string{"Name", "Control Plane URL", "Operator token or client Auth Key", "Server CA file (optional)", "Client certificate file (optional)", "Client key file (optional)"} {
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
		d.origin = controlPlaneOrigin(target.URL)
		for i, value := range []string{target.Name, target.URL, target.Token, target.ServerCAFile, target.ClientCertFile, target.ClientKeyFile} {
			d.inputs[i].SetValue(value)
		}
	}
	a.controlPlaneDialog = d
	return d.inputs[0].Focus()
}

func (a *app) controlPlaneKey(msg tea.KeyPressMsg) tea.Cmd {
	d := a.controlPlaneDialog
	switch msg.String() {
	case "ctrl+c":
		return tea.Quit
	case "esc":
		a.closeControlPlaneDialog()
		return nil
	}
	if d.busy {
		return nil
	}
	switch msg.String() {
	case "tab", "down", "enter":
		if msg.String() == "enter" && d.field == len(d.inputs)-1 {
			return a.checkControlPlane()
		}
		d.inputs[d.field].Blur()
		d.field = (d.field + 1) % len(d.inputs)
		return d.inputs[d.field].Focus()
	case "shift+tab", "up":
		d.inputs[d.field].Blur()
		d.field = (d.field + len(d.inputs) - 1) % len(d.inputs)
		return d.inputs[d.field].Focus()
	case "ctrl+s":
		return a.checkControlPlane()
	}
	var cmd tea.Cmd
	d.inputs[d.field], cmd = d.inputs[d.field].Update(msg)
	return cmd
}

func (a *app) checkControlPlane() tea.Cmd {
	d := a.controlPlaneDialog
	target := client.Target{Name: strings.TrimSpace(d.inputs[0].Value()), URL: strings.TrimRight(strings.TrimSpace(d.inputs[1].Value()), "/"), Token: strings.TrimSpace(d.inputs[2].Value())}
	if d.origin != "" && controlPlaneOrigin(target.URL) != d.origin {
		d.note = "Use Add for a different Control Plane URL. An existing credential stays bound to its Control Plane."
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
	if err := validateSavedControlPlane(target); err != nil {
		d.note = err.Error()
		return nil
	}
	target.URL = controlPlaneOrigin(target.URL)
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
	return a.verifyControlPlane(ctx, cancel, d, target)
}

// verifyControlPlane proves the credential by asking the Control Plane whose it is.
func (a *app) verifyControlPlane(ctx context.Context, cancel context.CancelFunc, d *controlPlaneDialog, target client.Target) tea.Cmd {
	connectTarget := a.connect
	return a.scope(func() tea.Msg {
		defer cancel()
		candidate, err := connectTarget(ctx, target)
		if err == nil {
			defer candidate.client.Close()
			_, err = candidate.client.WhoAmI(ctx)
		}
		return controlPlaneCheckedMsg{dialog: d, target: target, err: err}
	})
}

func (a *app) controlPlaneMessage(msg tea.Msg) tea.Cmd {
	if enrolled, ok := msg.(enrolledMsg); ok {
		if a.controlPlaneDialog != enrolled.dialog {
			return nil
		}
		d := a.controlPlaneDialog
		if enrolled.err != nil {
			d.busy = false
			switch connect.CodeOf(enrolled.err) {
			case connect.CodeUnauthenticated, connect.CodePermissionDenied, connect.CodeFailedPrecondition:
				d.note = "The Control Plane refused this Auth Key: " + enrolled.err.Error()
			default:
				d.note = "Could not connect to the Control Plane. Check its URL, Auth Key and TLS files."
			}
			return d.inputs[d.field].Focus()
		}
		// Only the enrolled credential replaces the key, in the dialog and in what is saved.
		d.inputs[2].SetValue(enrolled.target.Token)
		d.note = "Connected as " + enrolled.principal
		ctx, cancel := context.WithTimeout(a.root, 10*time.Second)
		d.cancel = cancel
		return a.verifyControlPlane(ctx, cancel, d, enrolled.target)
	}
	checked, ok := msg.(controlPlaneCheckedMsg)
	if !ok || a.controlPlaneDialog != checked.dialog {
		return nil
	}
	d := a.controlPlaneDialog
	d.busy = false
	if checked.err != nil {
		switch connect.CodeOf(checked.err) {
		case connect.CodeUnauthenticated, connect.CodePermissionDenied:
			d.note = "The Control Plane refused this credential."
		default:
			d.note = "Could not connect to the Control Plane. Check its URL, credential and TLS files."
		}
		return d.inputs[d.field].Focus()
	}
	profiles, err := a.controlPlaneStore.save(checked.target)
	if err != nil {
		d.note = err.Error()
		return d.inputs[d.field].Focus()
	}
	a.savedControlPlanes = profiles.ControlPlanes
	active := client.Target{}
	if a.hasTarget {
		active = a.contexts[a.current]
	}
	a.refreshControlPlanes(active)
	choice := 0
	for i, target := range a.contexts {
		if target == checked.target {
			choice = i
			break
		}
	}
	a.closeControlPlaneDialog()
	if err := a.start(choice); err != nil {
		a.choiceErr = "Saved, but could not connect to this Control Plane."
		return nil
	}
	a.choosing = false
	a.refreshControlPlanes(checked.target)
	return a.scope(a.inner.Init())
}

func (a *app) isSavedControlPlane(target client.Target) bool {
	for _, saved := range a.savedControlPlanes {
		if saved == target {
			return true
		}
	}
	return false
}

func (a *app) forgetControlPlane() {
	target := a.contexts[a.choice]
	if a.controlPlaneStore == nil || !a.isSavedControlPlane(target) {
		a.choiceErr = "This connection was supplied for this launch and is not saved."
		return
	}
	profiles, err := a.controlPlaneStore.remove(target)
	if err != nil {
		a.choiceErr = err.Error()
		return
	}
	a.savedControlPlanes = profiles.ControlPlanes
	a.refreshControlPlanes(a.contexts[a.current])
	a.choiceErr = "Forgot the saved connection. Active connections stay open until you switch or quit."
}

func (a *app) refreshControlPlanes(active client.Target) {
	a.contexts = mergeControlPlanes(a.launchContexts, a.savedControlPlanes)
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

func (a *app) rememberControlPlane() {
	if a.controlPlaneStore != nil && a.hasTarget && a.isSavedControlPlane(a.contexts[a.current]) {
		if err := a.controlPlaneStore.selectTarget(a.contexts[a.current]); err != nil {
			a.inner.notice = note{text: "Connected, but could not save the selected Control Plane.", err: true}
		}
	}
}

func (a *app) renderControlPlaneDialog() string {
	d := a.controlPlaneDialog
	height, width := max(a.height-1, 2), max(a.width-2, 10)
	lines := []string{headerStyle.Render("Save a Control Plane"), "Connect with an operator token, or join this device with a client Auth Key (stak_…). Only the token or the device's own credential is saved, privately on this machine.", ""}
	for i, label := range []string{"Name", "Control Plane URL", "Operator token or client Auth Key", "Server CA file · optional", "Client certificate file · optional", "Client key file · optional"} {
		style := faint
		if i == d.field {
			style = headerStyle
		}
		lines = append(lines, style.Render(label), d.inputs[i].View())
	}
	footer := "tab moves · ctrl+s verifies and saves · esc cancels"
	if d.busy {
		lines = append(lines, "Checking Control Plane access…")
		footer = "esc cancels"
	}
	if d.note != "" {
		lines = append(lines, errorStyle.Render(truncate(d.note, width)))
	}
	lines = append(lines, "", faint.Render(truncate(footer, width)))
	return lipgloss.NewStyle().Padding(0, 1).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}

// A supplied launch target always wins. Without a handover, the native TUI may reopen its
// selected saved Control Plane; credentials still never pass through argv or the environment.
func startupTargets(f *os.File, profiles controlPlaneProfiles) (handover, error) {
	if f != nil {
		if info, err := f.Stat(); err == nil && info.Mode()&(os.ModeNamedPipe|os.ModeSocket) != 0 {
			return readHandover(f)
		}
		f.Close()
	}
	if len(profiles.ControlPlanes) == 0 {
		return handover{Protocol: "runtime.v2"}, nil
	}
	current := 0
	for i, target := range profiles.ControlPlanes {
		if target.Name == profiles.Active {
			current = i
			break
		}
	}
	return handover{Contexts: profiles.ControlPlanes, Current: current, Protocol: "runtime.v2"}, nil
}
