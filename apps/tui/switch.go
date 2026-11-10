package main

import (
	"context"
	"reflect"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
)

// switchKey opens the list of Control Planes to switch to.
const switchKey = "ctrl+p"

// connector builds the model for one Control Plane; ctx ends when the TUI switches away from it.
type connector func(ctx context.Context, target client.Target) (model, error)

// dial is the connector the binary uses: a client, a follower and a watcher with the default
// timings.
func dial(version string) connector {
	return func(ctx context.Context, target client.Target) (model, error) {
		c, err := client.New(target, version)
		if err != nil {
			return model{}, err
		}
		return newModel(ctx, c, client.NewFollower(c), client.NewWatcher(c, watchKinds...)), nil
	}
}

// app is the program's model: the model of the current Control Plane, and the Control Planes the
// CLI handed over to switch between. Switching ends every stream and call of the one left and
// starts a fresh model for the next, so no state crosses from one Control Plane to another.
type app struct {
	root     context.Context
	cancel   context.CancelFunc
	connect  connector
	contexts []client.Target
	current  int
	inner    model
	// generation counts the models started; what a command of an earlier model delivers is
	// dropped.
	generation int

	// choosing says the Control Plane list shows; choice is the row under its cursor, and
	// choiceErr why the last switch failed.
	choosing  bool
	choice    int
	choiceErr string
	// palette is the command palette while it shows.
	palette *palette

	width, height int
}

// scoped is a message a command of one model delivered, kept for that model only.
type scoped struct {
	generation int
	msg        tea.Msg
}

// newApp starts the model for contexts[current].
func newApp(root context.Context, connect connector, contexts []client.Target, current int) (*app, error) {
	a := &app{root: root, connect: connect, contexts: contexts, current: current}
	if err := a.start(current); err != nil {
		return nil, err
	}
	return a, nil
}

// start replaces the model with a fresh one for contexts[i], ending the one it replaces.
func (a *app) start(i int) error {
	ctx, cancel := context.WithCancel(a.root)
	inner, err := a.connect(ctx, a.contexts[i])
	if err != nil {
		cancel()
		return err
	}
	if a.cancel != nil {
		a.cancel()
	}
	a.cancel, a.current, a.inner = cancel, i, inner
	a.generation++
	a.inner.switchable = len(a.contexts) > 1
	a.inner.defaultWorkspace = a.contexts[i].Workspace
	if a.width > 0 {
		next, _ := a.inner.Update(tea.WindowSizeMsg{Width: a.width, Height: a.height})
		a.inner = next.(model)
	}
	return nil
}

// stop ends the current model's streams and calls.
func (a *app) stop() {
	if a.cancel != nil {
		a.cancel()
	}
}

func (a *app) Init() tea.Cmd { return a.scope(a.inner.Init()) }

func (a *app) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case scoped:
		if msg.generation != a.generation {
			return a, nil
		}
		return a, a.forward(msg.msg)
	case tea.WindowSizeMsg:
		a.width, a.height = msg.Width, msg.Height
		if a.palette != nil {
			a.palette.filter.SetWidth(max(a.width-6, 10))
		}
	case tea.KeyPressMsg:
		if a.palette != nil {
			return a, a.paletteKeyPress(msg)
		}
		if a.choosing {
			return a, a.chooseKey(msg)
		}
		if msg.String() == switchKey && len(a.contexts) > 1 {
			a.choosing, a.choice, a.choiceErr = true, a.current, ""
			return a, nil
		}
		if msg.String() == paletteKey || (msg.String() == "/" && a.inner.slashOpensPalette()) {
			return a, a.openPalette(msg.String() == "/")
		}
	default:
		if a.palette != nil {
			var cmd tea.Cmd
			a.palette.filter, cmd = a.palette.filter.Update(msg)
			if _, paste := msg.(tea.PasteMsg); paste {
				a.palette.cursor = max(min(a.palette.cursor, len(a.matching())-1), 0)
				return a, cmd
			}
			return a, tea.Batch(cmd, a.forward(msg))
		}
	}
	return a, a.forward(msg)
}

func (a *app) forward(msg tea.Msg) tea.Cmd {
	next, cmd := a.inner.Update(msg)
	a.inner = next.(model)
	return a.scope(cmd)
}

// chooseKey moves through the Control Plane list and switches to the chosen one.
func (a *app) chooseKey(msg tea.KeyPressMsg) tea.Cmd {
	switch msg.String() {
	case "ctrl+c":
		return tea.Quit
	case "esc", switchKey:
		a.choosing = false
	case "up", "k":
		a.choice = max(a.choice-1, 0)
	case "down", "j":
		a.choice = min(a.choice+1, len(a.contexts)-1)
	case "enter":
		if a.choice == a.current {
			a.choosing = false
			return nil
		}
		if err := a.start(a.choice); err != nil {
			a.choiceErr = terminalText(err.Error())
			return nil
		}
		a.choosing = false
		return a.scope(a.inner.Init())
	}
	return nil
}

// scope keeps what cmd delivers for the current model. Messages of the runtime and of other
// packages, such as the input cursor's blink, pass as they are.
func (a *app) scope(cmd tea.Cmd) tea.Cmd {
	return scopeTo(a.generation, cmd)
}

func scopeTo(generation int, cmd tea.Cmd) tea.Cmd {
	if cmd == nil {
		return nil
	}
	return func() tea.Msg {
		switch msg := cmd().(type) {
		case nil:
			return nil
		case tea.BatchMsg:
			batch := make(tea.BatchMsg, 0, len(msg))
			for _, c := range msg {
				if c != nil {
					batch = append(batch, scopeTo(generation, c))
				}
			}
			return batch
		default:
			if ownMessage(msg) {
				return scoped{generation: generation, msg: msg}
			}
			return msg
		}
	}
}

// ownPackage is this package's import path, as reflect reports it.
var ownPackage = reflect.TypeFor[scoped]().PkgPath()

// ownMessage says whether msg is one of this package's messages, which only the model that asked
// for it may take.
func ownMessage(msg tea.Msg) bool {
	t := reflect.TypeOf(msg)
	if t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t.PkgPath() == ownPackage
}

func (a *app) View() tea.View {
	if (!a.choosing && a.palette == nil) || a.width == 0 {
		return a.inner.View()
	}
	shown := a.renderChoices
	if a.palette != nil {
		shown = a.renderPalette
	}
	v := tea.NewView(lipgloss.JoinVertical(lipgloss.Left, shown(), a.inner.renderStatus()))
	v.AltScreen = true
	return v
}

// renderChoices lists the Control Planes, the current one marked, filling the screen above the
// status line.
func (a *app) renderChoices() string {
	height := max(a.height-1, 2)
	width := max(a.width-2, 10)
	rows := make([]string, 0, len(a.contexts))
	for i, target := range a.contexts {
		label := contextLabel(target)
		if i == a.current {
			label += "  (current)"
		}
		style := lipgloss.NewStyle()
		if i == a.choice {
			style = focusedSel
		}
		rows = append(rows, style.Render(truncate(label, width)))
	}
	var footer []string
	if a.choiceErr != "" {
		footer = append(footer, errorStyle.Render(truncate(strings.Join(strings.Fields(a.choiceErr), " "), width)))
	}
	footer = append(footer, faint.Render(truncate("enter switches · esc goes back", width)))
	shown := max(height-2-len(footer), 1)
	first := max(a.choice-shown+1, 0)
	rows = rows[first:min(first+shown, len(rows))]
	lines := append([]string{headerStyle.Render(truncate("Control Planes", width))}, rows...)
	lines = append(append(lines, ""), footer...)
	return lipgloss.NewStyle().Padding(0, 1).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}

// contextLabel names a Control Plane in the list as the status bar does: its name and URL, or
// only its URL when it has no name.
func contextLabel(target client.Target) string {
	where := terminalText(target.URL)
	if target.Name != "" && target.Name != target.URL {
		where = terminalText(target.Name) + " · " + where
	}
	return where
}
