package main

import (
	"cmp"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/views"
)

// The rail can be expanded, with each Tag's preview, or folded into a narrow column of Tag
// initials; ctrl+b switches between them. While it has the focus, [ and ] make the expanded rail
// narrower and wider. Both choices are kept for the next launch.

const (
	// defaultRailWidth, minRailWidth and maxRailWidth bound the expanded rail, border included.
	defaultRailWidth = 24
	minRailWidth     = 16
	maxRailWidth     = 48
	// railStep is how much one key resizes the rail.
	railStep = 4
	// narrowRailWidth is the folded rail: a marker, two initials and a state, and its border.
	narrowRailWidth = 6
)

// railLayout is how the rail is laid out. A model's copies share it.
type railLayout struct {
	Collapsed bool `json:"collapsed,omitempty"`
	Width     int  `json:"width,omitempty"`
}

// preferencesFile keeps the rail's layout, for every Gateway.
func preferencesFile() (root, path string, ok bool) {
	root, err := cacheDirectory()
	if err != nil || root == "" {
		return "", "", false
	}
	return root, filepath.Join(root, "preferences.json"), true
}

type preferences struct {
	Rail railLayout `json:"rail"`
}

// loadRailLayout is the rail's layout as last kept.
func loadRailLayout() *railLayout {
	layout := &railLayout{Width: defaultRailWidth}
	if _, path, ok := preferencesFile(); ok {
		var saved preferences
		if (&localCache{}).readFile(path, &saved) {
			layout.Collapsed = saved.Rail.Collapsed
			if saved.Rail.Width != 0 {
				layout.Width = min(max(saved.Rail.Width, minRailWidth), maxRailWidth)
			}
		}
	}
	return layout
}

// saveRailLayout keeps the rail's layout, off the program's goroutine.
func saveRailLayout(layout railLayout) tea.Cmd {
	return func() tea.Msg {
		if root, path, ok := preferencesFile(); ok {
			_ = writeCacheFile(root, path, preferences{Rail: layout})
		}
		return nil
	}
}

// railWidth is the rail's width, its border included.
func (m model) railWidth() int {
	if m.rail == nil {
		return defaultRailWidth
	}
	if m.rail.Collapsed {
		return narrowRailWidth
	}
	return m.rail.Width
}

// railContent is the rail's text width: its width less its right border and padding.
func (m model) railContent() int { return m.railWidth() - 2 }

// toggleRail folds the rail into its narrow column, or expands it.
func (m *model) toggleRail() tea.Cmd {
	m.rail.Collapsed = !m.rail.Collapsed
	m.layout()
	return saveRailLayout(*m.rail)
}

// resizeRail widens the expanded rail by delta columns, within its bounds.
func (m *model) resizeRail(delta int) tea.Cmd {
	if m.rail.Collapsed {
		return nil
	}
	width := min(max(m.rail.Width+delta, minRailWidth), maxRailWidth)
	if width == m.rail.Width {
		return nil
	}
	m.rail.Width = width
	m.layout()
	return saveRailLayout(*m.rail)
}

// sortTags lists the lead Tag first, then the others by their conversation's latest activity,
// the latest first; Tags without one keep the Gateway's order after them. The selected Tag
// stays selected.
func (m *model) sortTags() {
	current := m.selectedTag()
	activity := func(i int) int64 {
		return m.summaries[m.tagReference(m.tags[i])].GetLastActivityAtMs()
	}
	type ranked struct {
		index int
		lead  bool
		at    int64
	}
	ranks := make([]ranked, len(m.tags))
	for i, tag := range m.tags {
		ranks[i] = ranked{i, tag.GetSpec().GetLead(), activity(i)}
	}
	slices.SortStableFunc(ranks, func(a, b ranked) int {
		if a.lead != b.lead {
			if a.lead {
				return -1
			}
			return 1
		}
		return cmp.Compare(b.at, a.at)
	})
	sorted := make([]*views.Tag, len(m.tags))
	for i, r := range ranks {
		sorted[i] = m.tags[r.index]
	}
	m.tags = sorted
	for i, tag := range m.tags {
		if m.tagReference(tag) == current {
			m.selected = i
		}
	}
}

// selectNthTag shows the conversation with the rail's nth Tag, counting from zero.
func (m *model) selectNthTag(n int) tea.Cmd {
	if n < 0 || n >= len(m.tags) {
		return nil
	}
	for i, r := range m.rows() {
		if r.kind == rowTag && r.index == n {
			m.cursor = i
			return m.choose()
		}
	}
	return nil
}

// stepTag shows the conversation with the previous (-1) or next (1) Tag in the rail.
func (m *model) stepTag(delta int) tea.Cmd {
	at := m.selected
	if m.pane != paneConversation && delta > 0 {
		at--
	}
	return m.selectNthTag(min(max(at+delta, 0), len(m.tags)-1))
}

// tagKey is the index of the Tag a key such as alt+3 or ctrl+3 jumps to, counting from zero.
func tagKey(key string) (int, bool) {
	for _, prefix := range []string{"alt+", "ctrl+"} {
		if digit, ok := strings.CutPrefix(key, prefix); ok && len(digit) == 1 && digit >= "1" && digit <= "9" {
			return int(digit[0] - '1'), true
		}
	}
	return 0, false
}

// initials are up to two letters naming a Tag in the folded rail.
func initials(name string) string {
	words := strings.FieldsFunc(name, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	var out []rune
	switch {
	case len(words) >= 2:
		out = append(out, []rune(words[0])[0], []rune(words[1])[0])
	case len(words) == 1:
		out = []rune(words[0])
		if len(out) > 2 {
			out = out[:2]
		}
	}
	return strings.ToUpper(string(out))
}

// railTime is when a conversation was last active, as short as a messaging app's list says it:
// the time today, "Yday", the weekday within a week, else the date.
func railTime(ms int64, now time.Time) string {
	if ms <= 0 {
		return ""
	}
	t, now := time.UnixMilli(ms).Local(), now.Local()
	day := func(t time.Time) time.Time { return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location()) }
	switch days := int(day(now).Sub(day(t)).Round(time.Hour).Hours() / 24); {
	case days <= 0:
		return clockTime(t)
	case days == 1:
		return "Yday"
	case days < 7:
		return t.Format("Mon")
	}
	return t.Format("Jan 2")
}
