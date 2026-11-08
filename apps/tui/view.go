package main

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/glamour/v2"
	"charm.land/lipgloss/v2"
)

const railWidth = 24

var (
	accent      = lipgloss.Color("12")
	faint       = lipgloss.NewStyle().Faint(true)
	bold        = lipgloss.NewStyle().Bold(true)
	errorStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	okStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	selected    = lipgloss.NewStyle().Bold(true).Foreground(accent)
	focusedSel  = lipgloss.NewStyle().Bold(true).Reverse(true).Foreground(accent)
	railStyle   = lipgloss.NewStyle().Border(lipgloss.NormalBorder(), false, true, false, false).PaddingRight(1)
	headerStyle = lipgloss.NewStyle().Bold(true).Foreground(accent)
	statusStyle = lipgloss.NewStyle().Reverse(true)
)

// markdown renders replies with Glamour, rebuilding its renderer when the width changes.
type markdown struct {
	width    int
	renderer *glamour.TermRenderer
	// renders counts replies rendered, for tests.
	renders int
}

func (md *markdown) render(text string, width int) string {
	md.renders++
	if md.renderer == nil || md.width != width {
		renderer, err := glamour.NewTermRenderer(glamour.WithStandardStyle("dark"), glamour.WithWordWrap(width))
		if err != nil {
			return lipgloss.NewStyle().Width(width).Render(text)
		}
		md.renderer, md.width = renderer, width
	}
	out, err := md.renderer.Render(text)
	if err != nil {
		return lipgloss.NewStyle().Width(width).Render(text)
	}
	return strings.Trim(out, "\n")
}

func (m model) paneWidth() int { return max(m.width-railWidth-2, 10) }

// layout sizes the viewport and input to the window: one status line, and in the pane a header,
// the conversation and the input line.
func (m *model) layout() {
	m.viewport.SetWidth(m.paneWidth())
	m.viewport.SetHeight(max(m.height-3, 1))
	m.input.SetWidth(m.paneWidth() - 3)
	m.refresh()
}

// refresh redraws the selected conversation, keeping the view at the bottom when it was there.
func (m *model) refresh() {
	atBottom := m.viewport.AtBottom()
	m.viewport.SetContent(m.renderConversation())
	if atBottom {
		m.viewport.GotoBottom()
	}
}

func (m model) renderConversation() string {
	tag := m.selectedTag()
	if tag == "" {
		return faint.Render("No Tags yet. Create one with supertag apply or supertag create tag.")
	}
	name := terminalText(tag)
	width := m.paneWidth()
	wrap := lipgloss.NewStyle().Width(width)
	c := m.conversations[tag]
	if c == nil || (len(c.entries) == 0 && c.draft == "") {
		return faint.Render(wrap.Render("Say something to " + name + ". This is your default conversation with it."))
	}
	if c.renderedWidth != width {
		c.rendered.Reset()
		c.renderedCount, c.renderedWidth = 0, width
	}
	for _, e := range c.entries[c.renderedCount:] {
		switch e.kind {
		case entryYou:
			c.rendered.WriteString(bold.Render("you") + "\n" + wrap.Render(e.text) + "\n\n")
		case entryReply:
			c.rendered.WriteString(headerStyle.Render(name) + "\n" + m.md.render(e.text, width) + "\n\n")
		case entryDim:
			c.rendered.WriteString(faint.Render(wrap.Render(e.text)) + "\n")
		case entryError:
			c.rendered.WriteString(errorStyle.Render(wrap.Render(e.text)) + "\n\n")
		}
	}
	c.renderedCount = len(c.entries)
	out := c.rendered.String()
	if c.draft != "" {
		out += headerStyle.Render(name) + "\n" + faint.Render(wrap.Render(c.draft))
	}
	return strings.TrimRight(out, "\n")
}

// railContent is the rail's text width: railWidth less its right border and padding.
const railContent = railWidth - 2

// renderRail lists the Tags one row each, cut to fit, scrolled so the selected Tag shows.
func (m model) renderRail(height int) string {
	lines := []string{headerStyle.Render("Tags")}
	rows := max(height-1, 1)
	first := max(m.selected-rows+1, 0)
	for i := first; i < len(m.tags) && i < first+rows; i++ {
		tag := m.tags[i]
		phase := truncate(terminalText(tag.Status.Phase), railContent/2)
		nameWidth := railContent
		if phase != "" {
			nameWidth -= lipgloss.Width(phase) + 1
		}
		name := truncate(terminalText(tag.Name()), nameWidth)
		style := lipgloss.NewStyle()
		if i == m.selected {
			style = selected
			if m.focus == focusRail {
				style = focusedSel
			}
		}
		line := style.Render(name)
		if phase != "" {
			line += " " + faint.Render(phase)
		}
		lines = append(lines, line)
	}
	return railStyle.Width(railWidth).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}

func (m model) renderStatus() string {
	target := m.client.Target()
	where := terminalText(target.URL)
	if target.Name != "" && target.Name != target.URL {
		where = terminalText(target.Name) + " · " + where
	}
	left := " " + where + "  "
	state := okStyle.Render("connected")
	if !m.connected {
		status := strings.Join(strings.Fields(terminalText(m.status)), " ")
		state = errorStyle.Render(truncate(status, max(m.width-lipgloss.Width(left)-1, 1)))
	}
	gap := max(m.width-lipgloss.Width(left)-lipgloss.Width(state)-1, 0)
	return statusStyle.MaxWidth(m.width).Render(left + strings.Repeat(" ", gap) + state + " ")
}

func (m model) View() tea.View {
	if m.width == 0 {
		v := tea.NewView("")
		v.AltScreen = true
		return v
	}
	bodyHeight := max(m.height-1, 2)
	header := headerStyle.Render(truncate(fmt.Sprintf("%s · %s", terminalText(m.selectedTag()), conversationSession), m.paneWidth()))
	pane := lipgloss.JoinVertical(lipgloss.Left, header, m.viewport.View(), m.input.View())
	body := lipgloss.JoinHorizontal(lipgloss.Top, m.renderRail(bodyHeight), " ", pane)
	body = lipgloss.NewStyle().Height(bodyHeight).MaxHeight(bodyHeight).Render(body)
	v := tea.NewView(lipgloss.JoinVertical(lipgloss.Left, body, m.renderStatus()))
	v.AltScreen = true
	return v
}

// truncate cuts s to width columns, ending it with "…" when cut.
func truncate(s string, width int) string {
	if lipgloss.Width(s) <= width {
		return s
	}
	if width < 1 {
		return ""
	}
	runes := []rune(s)
	for len(runes) > 0 && lipgloss.Width(string(runes))+1 > width {
		runes = runes[:len(runes)-1]
	}
	return string(runes) + "…"
}
