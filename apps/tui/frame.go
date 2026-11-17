package main

import (
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// frame keeps what the last frames rendered, so a keystroke, which changes only the input line,
// neither measures nor restyles the rest of the screen again. Bubble Tea renders a frame after
// every message, keys and the cursor's blink included. A model's copies share it; each cache is
// keyed by what it was rendered from, so an older copy never shows a newer one's rendering.
type frame struct {
	// contents counts the contents given to viewports, to name each one.
	contents int

	// viewport is the viewport's last rendering, and viewportKey what it was rendered from.
	viewport    block
	viewportKey viewportKey
	viewportSet bool

	// rail is the rail's last rendering, from railLines at railHeight.
	rail       block
	railLines  string
	railHeight int
	railWidth  int
	railSet    bool
}

// shownContent is what the model's viewport was last given: the text, whether it soft-wrapped,
// and a number no other content given to a viewport has. id is 0 before any and after a resize.
type shownContent struct {
	text     string
	softWrap bool
	id       int
}

// viewportKey is everything the viewport's rendering depends on.
type viewportKey struct {
	content, yOffset, xOffset, width, height int
	softWrap                                 bool
}

// block is a rendered block of lines with each line's width, measured once.
type block struct {
	text   string
	lines  []string
	widths []int
	width  int
	// plain says the text has no tab or carriage return, which lipgloss would rewrite.
	plain bool
}

func measure(text string) block {
	b := block{text: text, lines: strings.Split(text, "\n"), plain: !strings.ContainsAny(text, "\t\r")}
	b.widths = make([]int, len(b.lines))
	for i, line := range b.lines {
		b.widths[i] = ansi.StringWidth(line)
		b.width = max(b.width, b.widths[i])
	}
	return b
}

// setContent gives the viewport new content. The same content again leaves the viewport as it
// is: setting content measures every line, which costs milliseconds in a long conversation, and
// most rereads change nothing that shows.
func (m *model) setContent(content string) {
	if m.shownContent.id != 0 && m.shownContent.text == content && m.shownContent.softWrap == m.viewport.SoftWrap {
		return
	}
	m.viewport.SetContent(content)
	m.frame.contents++
	m.shownContent = shownContent{text: content, softWrap: m.viewport.SoftWrap, id: m.frame.contents}
}

// viewportBlock is the viewport's rendering, rendered again only when its content, scroll
// position or size changed.
func (m model) viewportBlock() *block {
	key := viewportKey{content: m.shownContent.id, yOffset: m.viewport.YOffset(), xOffset: m.viewport.XOffset(),
		width: m.viewport.Width(), height: m.viewport.Height(), softWrap: m.viewport.SoftWrap}
	if !m.frame.viewportSet || m.frame.viewportKey != key {
		m.frame.viewport, m.frame.viewportKey, m.frame.viewportSet = measure(m.viewport.View()), key, true
	}
	return &m.frame.viewport
}

// railBlock is the rail at height rows, styled and measured again only when its rows changed.
func (m model) railBlock(height int) *block {
	lines := m.railLines(height)
	if !m.frame.railSet || m.frame.railLines != lines || m.frame.railHeight != height || m.frame.railWidth != m.railWidth() {
		rail := railStyle.Width(m.railWidth()).Height(height).MaxHeight(height).Render(lines)
		m.frame.rail, m.frame.railLines, m.frame.railHeight, m.frame.railSet = measure(rail), lines, height, true
		m.frame.railWidth = m.railWidth()
	}
	return &m.frame.rail
}

// composeScreen lays out the whole screen: the rail, a space and the pane of header, viewport and
// bottom line, cut to bodyHeight rows, over the status line. It gives what
//
//	body := lipgloss.JoinHorizontal(lipgloss.Top, rail, " ", lipgloss.JoinVertical(lipgloss.Left, header, viewport, bottom))
//	body = lipgloss.NewStyle().Height(bodyHeight).MaxHeight(bodyHeight).Render(body)
//	lipgloss.JoinVertical(lipgloss.Left, body, status)
//
// gives, without measuring the rail and viewport again, which lipgloss does for every line of the
// screen each time.
func composeScreen(rail, viewport *block, header, bottom, status string, bodyHeight int) string {
	head, foot, stat := measure(header), measure(bottom), measure(status)
	if !rail.plain || !viewport.plain || !head.plain || !foot.plain || !stat.plain {
		pane := lipgloss.JoinVertical(lipgloss.Left, header, viewport.text, bottom)
		body := lipgloss.JoinHorizontal(lipgloss.Top, rail.text, " ", pane)
		body = lipgloss.NewStyle().Height(bodyHeight).MaxHeight(bodyHeight).Render(body)
		return lipgloss.JoinVertical(lipgloss.Left, body, status)
	}

	paneWidth := max(head.width, viewport.width, foot.width)
	paneRows := len(head.lines) + len(viewport.lines) + len(foot.lines)
	paneLine := func(i int) (string, int) {
		for _, b := range []*block{&head, viewport, &foot} {
			if i < len(b.lines) {
				return b.lines[i], b.widths[i]
			}
			i -= len(b.lines)
		}
		return "", 0
	}
	rows := max(len(rail.lines), paneRows)
	bodyWidth := rail.width + 1 + paneWidth
	width := max(bodyWidth, stat.width)

	var out strings.Builder
	// MaxHeight cuts the body to bodyHeight rows; Height pads it to as many.
	for i := range bodyHeight {
		line, lineWidth := "", 0
		if i < rows {
			if i < len(rail.lines) {
				out.WriteString(rail.lines[i])
				lineWidth = rail.widths[i]
			}
			out.WriteString(strings.Repeat(" ", rail.width-lineWidth) + " ")
			line, lineWidth = paneLine(i)
			out.WriteString(line)
			out.WriteString(strings.Repeat(" ", paneWidth-lineWidth))
			out.WriteString(strings.Repeat(" ", width-bodyWidth))
		} else {
			out.WriteString(strings.Repeat(" ", width))
		}
		out.WriteByte('\n')
	}
	for i, line := range stat.lines {
		out.WriteString(line)
		out.WriteString(strings.Repeat(" ", width-stat.widths[i]))
		if i < len(stat.lines)-1 {
			out.WriteByte('\n')
		}
	}
	return out.String()
}
