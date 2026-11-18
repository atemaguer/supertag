package main

import (
	"strconv"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

// newTagKey opens the New Tag form.
const newTagKey = "ctrl+n"

// The New Tag form's fields, in order.
const (
	tagFieldName = iota
	tagFieldHarness
	tagFieldWorkspace
	tagFieldWorkSessions
	tagFields
)

// tagForm creates a Tag from a name, from which its permanent ID is derived the way `supertag init`
// names Tags, a harness, and optionally a Workspace. The harnesses and Workspaces come from the
// connected Worker Hosts; every harness is offered when none is connected. Like the lead Tag
// `supertag init` creates, the new Tag may edit files and run commands.
type tagForm struct {
	name  textinput.Model
	field int
	// options are what the Worker Hosts offer, nil until read.
	options *client.TagOptions
	// harness and workspace are the chosen indexes into harnesses() and workspaces().
	harness, workspace int
	// workSessions is how many Work Sessions the Tag may have open at once, 1 to 64.
	workSessions int
	sending      bool
	note         note
}

type (
	tagOptionsMsg struct {
		form    *tagForm
		options client.TagOptions
		err     error
	}
	tagCreatedMsg struct {
		form *tagForm
		tag  *views.Tag
		err  error
	}
)

// harnesses are the harnesses offered: the Worker Hosts', or every one when none is connected.
func (f *tagForm) harnesses() []string {
	if f.options != nil && len(f.options.Harnesses) > 0 {
		return f.options.Harnesses
	}
	all := make([]string, 0, len(client.Harnesses))
	for _, harness := range client.Harnesses {
		all = append(all, harness.Kind)
	}
	return all
}

// workspaces are the Workspaces offered, after "None".
func (f *tagForm) workspaces() []string {
	if f.options == nil {
		return []string{""}
	}
	return append([]string{""}, f.options.Workspaces...)
}

// tagAdminRefusal says why this connection cannot create Tags, or "" when it may try: a client
// device, or a principal the Gateway named that is not an operator.
func (m model) tagAdminRefusal() string {
	if m.cache != nil && m.cache.principal != "" {
		return client.TagAdminRefusal(m.cache.principal)
	}
	if client.IsClientCredential(m.client.Target().Token) {
		return "Only an operator can create Tags. This terminal is connected as a client device."
	}
	return ""
}

// openTagForm shows the New Tag form, or says why this connection cannot create Tags.
func (m *model) openTagForm() tea.Cmd {
	if refusal := m.tagAdminRefusal(); refusal != "" {
		m.notice = note{text: refusal, err: true}
		return nil
	}
	m.saveDraft()
	m.decision, m.itemNote, m.form = decisionNone, note{}, nil
	m.viewport.SoftWrap = false
	name := textinput.New()
	name.Prompt = "> "
	name.Placeholder = "Reviewer"
	name.CharLimit = 63
	name.SetWidth(m.paneWidth() - 3)
	f := &tagForm{name: name, workSessions: 8}
	m.tagForm, m.pane, m.focus = f, paneNewTag, focusInput
	m.viewport.GotoTop()
	m.refresh()
	c, ctx := m.client, m.ctx
	return tea.Batch(m.syncInput(), func() tea.Msg {
		options, err := c.ListTagOptions(ctx)
		return tagOptionsMsg{form: f, options: options, err: err}
	})
}

// tagOptionsRead offers what the Worker Hosts run, preferring the first harness in the usual order
// and the only Workspace when there is one. Without the hosts' offer, every harness and no
// Workspace can still be chosen.
func (m *model) tagOptionsRead(msg tagOptionsMsg) {
	f := m.tagForm
	if f == nil || f != msg.form {
		return
	}
	options := msg.options
	if msg.err != nil {
		options = client.TagOptions{}
	}
	f.options = &options
	f.harness = 0
	harnesses := f.harnesses()
	for _, preferred := range client.Harnesses {
		if i := indexOf(harnesses, preferred.Kind); i >= 0 {
			f.harness = i
			break
		}
	}
	if len(options.Workspaces) == 1 {
		f.workspace = 1
	}
	if m.pane == paneNewTag {
		m.refresh()
	}
}

func indexOf(list []string, s string) int {
	for i, item := range list {
		if item == s {
			return i
		}
	}
	return -1
}

// tagFormKey handles a key on the New Tag form: up and down move between fields, left and right
// choose a harness or Workspace, enter moves on and on the last field creates the Tag.
func (m model) tagFormKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd, bool) {
	f := m.tagForm
	if f == nil {
		return m, nil, false
	}
	if f.sending {
		return m, nil, true
	}
	step := func(at *int, n, delta int) {
		if n > 0 {
			*at = (*at + delta + n) % n
		}
	}
	switch msg.String() {
	case "up", "shift+tab":
		f.field = max(f.field-1, 0)
	case "down":
		f.field = min(f.field+1, tagFields-1)
	case "enter":
		if f.field < tagFields-1 {
			f.field++
		} else {
			return m, m.createTag(), true
		}
	case "left", "right":
		delta := 1
		if msg.String() == "left" {
			delta = -1
		}
		switch f.field {
		case tagFieldHarness:
			step(&f.harness, len(f.harnesses()), delta)
		case tagFieldWorkspace:
			step(&f.workspace, len(f.workspaces()), delta)
		case tagFieldWorkSessions:
			f.workSessions = min(max(f.workSessions+delta, 1), 64)
		default:
			var cmd tea.Cmd
			f.name, cmd = f.name.Update(msg)
			m.refresh()
			return m, cmd, true
		}
	default:
		if f.field != tagFieldName {
			return m, nil, true
		}
		var cmd tea.Cmd
		f.name, cmd = f.name.Update(msg)
		f.note = note{}
		m.refresh()
		return m, cmd, true
	}
	m.refresh()
	return m, m.syncInput(), true
}

// createTag creates the Tag, fenced at revision zero so it never replaces another.
func (m *model) createTag() tea.Cmd {
	f := m.tagForm
	id := client.TagIDFor(f.name.Value())
	if id == "" {
		f.note, f.field = note{text: "Name the Tag with letters or digits.", err: true}, tagFieldName
		m.refresh()
		return m.syncInput()
	}
	tag := client.NewTag{ID: id, Name: strings.TrimSpace(f.name.Value()), Harness: f.harnesses()[f.harness],
		Workspace: f.workspaces()[f.workspace], MaxWorkSessions: uint32(f.workSessions)}
	f.sending, f.note = true, note{text: "Creating…"}
	m.refresh()
	c, ctx := m.client, m.ctx
	return func() tea.Msg {
		created, err := c.CreateTag(ctx, tag)
		return tagCreatedMsg{form: f, tag: created, err: err}
	}
}

// tagCreated selects the new Tag's conversation, or says why it was not created.
func (m *model) tagCreated(msg tagCreatedMsg) tea.Cmd {
	f := m.tagForm
	if f == nil || f != msg.form {
		return m.reloadTags()
	}
	f.sending = false
	if msg.err != nil {
		f.note = note{text: terminalText(msg.err.Error()), err: true}
		m.refresh()
		return m.syncInput()
	}
	id := msg.tag.GetMetadata().GetId()
	if m.tagIndex(id) < 0 {
		m.tags = append(m.tags, msg.tag)
	}
	m.tagForm = nil
	m.pane = paneConversation
	cmd := m.selectNthTag(m.tagIndex(id))
	m.focus = focusInput
	return tea.Batch(cmd, m.syncInput(), m.reloadTags())
}

// tagIndex is the index of the Tag with this ID in the rail, or -1.
func (m model) tagIndex(id string) int {
	for i, tag := range m.tags {
		if m.tagReference(tag) == id {
			return i
		}
	}
	return -1
}

// renderTagForm renders the New Tag form.
func (m model) renderTagForm() string {
	f := m.tagForm
	wrap := lipgloss.NewStyle().Width(m.paneWidth())
	label := func(field int, text string) string {
		if field == f.field && m.focus == focusInput {
			return selected.Render(text)
		}
		return bold.Render(text)
	}
	choice := func(field int, value string) string {
		if field == f.field && m.focus == focusInput {
			return "< " + selected.Render(value) + " >"
		}
		return "  " + value
	}
	lines := []string{faint.Render(wrap.Render("A Tag can edit files and run commands, like the lead Tag supertag init creates.")), ""}
	lines = append(lines, label(tagFieldName, "Name"), f.name.View())
	if id := client.TagIDFor(f.name.Value()); id != "" {
		lines = append(lines, faint.Render(wrap.Render("ID: "+id+". It cannot change later.")))
	} else {
		lines = append(lines, faint.Render("Use letters or digits."))
	}
	lines = append(lines, "", label(tagFieldHarness, "Harness"))
	if f.options == nil {
		lines = append(lines, faint.Render("  Reading the Worker Hosts…"))
	} else {
		lines = append(lines, choice(tagFieldHarness, terminalText(client.HarnessLabel(f.harnesses()[f.harness]))))
		if len(f.options.Harnesses) == 0 {
			lines = append(lines, faint.Render(wrap.Render("No Worker Host is connected. Choose the harness its host will run.")))
		}
	}
	lines = append(lines, "", label(tagFieldWorkspace, "Workspace"))
	workspace := "None"
	if f.workspace > 0 {
		workspace = terminalText(f.workspaces()[f.workspace])
	}
	lines = append(lines, choice(tagFieldWorkspace, workspace))
	if f.options != nil && len(f.options.Workspaces) == 0 {
		lines = append(lines, faint.Render(wrap.Render("No Worker Host offers a Workspace.")))
	}
	lines = append(lines, "", label(tagFieldWorkSessions, "Work Sessions open at once"),
		choice(tagFieldWorkSessions, strconv.Itoa(f.workSessions)),
		faint.Render(wrap.Render("Longer work the Tag may have open across all its conversations.")))
	if f.note.text != "" {
		style := faint
		if f.note.err {
			style = errorStyle
		}
		lines = append(lines, "", style.Render(wrap.Render(f.note.text)))
	}
	return strings.Join(lines, "\n")
}

// tagFormHint ends the New Tag form: the keys that act on it.
func (m model) tagFormHint() string {
	if m.tagForm != nil && m.tagForm.sending {
		return "Creating the Tag…"
	}
	return "↑ ↓ fields · ← → choose · enter moves on, and creates the Tag on the last field · esc cancels"
}
