package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// The fields of the new Objective form, in order.
const (
	fieldOutcome = iota
	fieldTeam
	fieldBudget
	formFields
)

// fieldLabels head the form's fields.
var fieldLabels = [formFields]string{"Outcome", "Team", "Budget"}

// objectiveForm declares a new Objective owned by the Tag that was selected when it opened.
type objectiveForm struct {
	owner  string
	fields [formFields]textinput.Model
	// field is the field the keys go to.
	field   int
	sending bool
	note    note
	// request is what was last sent; created is the Control Plane's answer once the Objective
	// exists.
	request client.NewObjective
	created *operatorv1.CreateObjectiveResponse
}

type createdMsg struct {
	form     *objectiveForm
	response *operatorv1.CreateObjectiveResponse
	err      error
}

// openObjectiveForm shows the new Objective form for the selected Tag.
func (m *model) openObjectiveForm() tea.Cmd {
	owner := m.selectedTag()
	if owner == "" {
		return nil
	}
	m.saveDraft()
	m.decision, m.itemNote = decisionNone, note{}
	m.viewport.SoftWrap = false
	f := &objectiveForm{owner: owner}
	placeholders := [formFields]string{
		"The result, how success is verified, what must not change, when to ask a person",
		"A Team's name, or empty for " + terminalText(owner) + " to work alone",
		"Such as 300 USD or $12.50; empty for no budget",
	}
	for i := range f.fields {
		input := textinput.New()
		input.Prompt = "> "
		input.Placeholder = placeholders[i]
		input.SetWidth(m.paneWidth() - 3)
		f.fields[i] = input
	}
	m.form = f
	m.pane, m.focus = paneNewObjective, focusInput
	m.placeCursor()
	m.viewport.GotoTop()
	m.refresh()
	return m.syncInput()
}

// formKey handles a key in the new Objective form; ok is false for a key it leaves to the pane.
func (m model) formKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd, bool) {
	f := m.form
	if f == nil {
		return m, nil, false
	}
	if f.sending {
		return m, nil, true
	}
	if f.created != nil {
		switch msg.String() {
		case "enter":
			return m, m.showObjective(f.created.GetObjective().GetId()), true
		case "r":
			if f.created.GetNotStarted() != "" {
				f.request.ID = f.created.GetObjective().GetId()
				return m, m.sendForm(), true
			}
		}
		return m, nil, true
	}
	switch msg.String() {
	case "up":
		return m, m.moveField(f.field - 1), true
	case "down":
		return m, m.moveField(f.field + 1), true
	case "enter":
		if f.field < formFields-1 {
			return m, m.moveField(f.field + 1), true
		}
		return m, m.createObjective(), true
	}
	var cmd tea.Cmd
	f.fields[f.field], cmd = f.fields[f.field].Update(msg)
	m.refresh()
	return m, cmd, true
}

// moveField moves the keys to field i, within the form.
func (m *model) moveField(i int) tea.Cmd {
	m.form.field = min(max(i, 0), formFields-1)
	m.refresh()
	return m.syncInput()
}

// createObjective sends the form, once its fields are valid.
func (m *model) createObjective() tea.Cmd {
	f := m.form
	invalid := func(field int, text string) tea.Cmd {
		f.note = note{text: text, err: true}
		return m.moveField(field)
	}
	outcome := strings.TrimSpace(f.fields[fieldOutcome].Value())
	if outcome == "" {
		return invalid(fieldOutcome, "An Objective needs its outcome: the result, and how success is verified.")
	}
	budget, err := parseBudget(f.fields[fieldBudget].Value())
	if err != nil {
		return invalid(fieldBudget, err.Error())
	}
	f.request = client.NewObjective{Outcome: outcome, Owner: f.owner, Team: strings.TrimSpace(f.fields[fieldTeam].Value()), Budget: budget}
	return m.sendForm()
}

// sendForm sends the form's request.
func (m *model) sendForm() tea.Cmd {
	f := m.form
	f.sending, f.note = true, note{text: "Creating the Objective…"}
	cmd := m.syncInput()
	m.refresh()
	c, ctx, request := m.client, m.ctx, f.request
	return tea.Batch(cmd, func() tea.Msg {
		response, err := c.CreateObjective(ctx, request)
		return createdMsg{form: f, response: response, err: err}
	})
}

// objectiveCreated shows how creating the Objective went, and rereads the Objectives.
func (m *model) objectiveCreated(msg createdMsg) tea.Cmd {
	f := msg.form
	f.sending = false
	if msg.err != nil {
		f.note = note{text: terminalText(msg.err.Error()), err: true}
	} else {
		f.created, f.note = msg.response, note{}
	}
	var cmd tea.Cmd
	if m.form == f {
		cmd = m.syncInput()
		m.refresh()
	}
	if msg.err != nil {
		return cmd
	}
	return tea.Batch(cmd, m.reloadObjectives())
}

// showObjective shows the Objective with this ID in the main pane.
func (m *model) showObjective(id string) tea.Cmd {
	m.form = nil
	m.pane, m.objectiveID = paneObjective, id
	m.input.SetValue(m.drafts[m.draftKey()])
	m.placeCursor()
	focusCmd := m.syncInput()
	m.viewport.GotoTop()
	m.refresh()
	return tea.Batch(focusCmd, m.reloadOverview())
}

// renderObjectiveForm is the new Objective form, or what came of sending it.
func (m model) renderObjectiveForm() string {
	f := m.form
	wrap := lipgloss.NewStyle().Width(m.paneWidth())
	owner := terminalText(f.owner)
	if f.created != nil {
		text := wrap.Render(createdLines(f.owner, f.created))
		if f.note.text != "" {
			text += "\n\n" + errorStyle.Render(wrap.Render(f.note.text))
		}
		return text
	}
	lines := []string{faint.Render(wrap.Render("A new Objective owned by " + owner + ". It starts when you create it: " + owner + " takes its first turn.")), ""}
	for i, input := range f.fields {
		label := fieldLabels[i]
		if i == f.field && m.focus == focusInput {
			label = selected.Render(label)
		} else {
			label = bold.Render(label)
		}
		lines = append(lines, label, input.View())
		if i == fieldTeam && len(m.teams) > 0 {
			names := make([]string, 0, len(m.teams))
			for _, team := range m.teams {
				names = append(names, terminalText(team.GetName()))
			}
			lines = append(lines, faint.Render(wrap.Render("Teams: "+strings.Join(names, ", "))))
		}
		lines = append(lines, "")
	}
	if f.note.text != "" {
		style := faint
		if f.note.err {
			style = errorStyle
		}
		lines = append(lines, style.Render(wrap.Render(f.note.text)))
	}
	return strings.TrimRight(strings.Join(lines, "\n"), "\n")
}

// createdLines say what the Control Plane created and whether it started, with each warning.
// Every field from the server is filtered for the terminal.
func createdLines(owner string, created *operatorv1.CreateObjectiveResponse) string {
	id := terminalText(created.GetObjective().GetId())
	lines := []string{"Created Objective " + id + "."}
	switch {
	case created.GetStartedTaskId() != "":
		lines = append(lines, terminalText(owner)+" took its first turn as Task "+terminalText(created.GetStartedTaskId())+".")
	case created.GetNotStarted() != "":
		lines = append(lines, "It did not start: "+terminalText(created.GetNotStarted()),
			"Once that is fixed, press r to start it.")
	}
	if warnings := created.GetWarnings(); len(warnings) > 0 {
		lines = append(lines, "", "Warnings:")
		for _, warning := range warnings {
			lines = append(lines, "  "+terminalText(warning))
		}
	}
	return strings.Join(lines, "\n")
}

// formHint ends the new Objective form: the keys that act on it.
func (m model) formHint() string {
	switch {
	case m.form.sending:
		return "Waiting for the Control Plane…"
	case m.form.created != nil && m.form.created.GetNotStarted() != "":
		return "enter shows the Objective · r starts it · esc back"
	case m.form.created != nil:
		return "enter shows the Objective · esc back"
	}
	return "↑ ↓ fields · enter next, then creates · esc back"
}

// budgetPattern is a budget as the form takes it: an amount and its ISO 4217 code, or a dollar
// amount.
var budgetPattern = regexp.MustCompile(`^(?:\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)|([0-9][0-9,]*(?:\.[0-9]+)?)\s*([A-Za-z]{3}))$`)

// parseBudget reads a budget such as `300 USD`, `12.50 eur` or `$12.50` into minor units of its
// currency; empty is no budget.
func parseBudget(text string) (*operatorv1.Budget, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, nil
	}
	match := budgetPattern.FindStringSubmatch(text)
	if match == nil {
		return nil, fmt.Errorf("A budget is an amount and its currency, such as 300 USD or $12.50.")
	}
	amount, currency := match[1], "USD"
	if amount == "" {
		amount, currency = match[2], strings.ToUpper(match[3])
	}
	amount = strings.ReplaceAll(amount, ",", "")
	whole, fraction, _ := strings.Cut(amount, ".")
	digits, ok := minorDigits[currency]
	if !ok {
		digits = 2
	}
	if len(fraction) > digits {
		if digits == 0 {
			return nil, fmt.Errorf("A %s budget has no decimal places.", currency)
		}
		return nil, fmt.Errorf("A %s budget has at most %d decimal places.", currency, digits)
	}
	minor, err := strconv.ParseInt(whole+fraction+strings.Repeat("0", digits-len(fraction)), 10, 64)
	if err != nil {
		return nil, fmt.Errorf("That budget is too large.")
	}
	if minor <= 0 {
		return nil, fmt.Errorf("A budget must be more than zero.")
	}
	return &operatorv1.Budget{LimitMinor: minor, Currency: currency}, nil
}
