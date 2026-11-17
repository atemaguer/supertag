package main

import (
	"context"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

// notesDialog lists the notes the selected Tag keeps that you may see: what it remembers between
// turns. Each can be deleted; people never write notes here, they tell the Tag. The Watch keeps
// the list current. The conversation itself stays messages only.
type notesDialog struct {
	tag, label string
	notes      []client.Note
	cursor     int
	busy       bool
	read       bool
	note       string
	cancel     context.CancelFunc
}

type notesMsg struct {
	dialog *notesDialog
	notes  []client.Note
	err    error
}

type noteDeletedMsg struct {
	dialog *notesDialog
	id     string
	err    error
}

func (a *app) closeNotes() {
	if a.notes != nil && a.notes.cancel != nil {
		a.notes.cancel()
	}
	a.notes = nil
}

// openNotes shows the selected Tag's notes.
func (a *app) openNotes() tea.Cmd {
	a.closeNotes()
	tag := a.inner.selectedTag()
	if tag == "" {
		return nil
	}
	a.notes = &notesDialog{tag: tag, label: a.inner.tagLabel(tag)}
	return a.loadNotes()
}

func (a *app) loadNotes() tea.Cmd {
	d := a.notes
	if d.cancel != nil {
		d.cancel()
	}
	ctx, cancel := context.WithCancel(a.inner.ctx)
	d.cancel = cancel
	c := a.inner.client
	return a.scope(func() tea.Msg {
		defer cancel()
		notes, err := c.Notes(ctx, d.tag)
		return notesMsg{dialog: d, notes: notes, err: err}
	})
}

// notesWatched rereads the list when the Watch reports a change to the Tag's notes, or may have
// missed one.
func (a *app) notesWatched(msg tea.Msg) tea.Cmd {
	watched, ok := msg.(watchMsg)
	if !ok || a.notes == nil || a.notes.busy {
		return nil
	}
	switch watched.update.Kind {
	case client.WatchLive, client.WatchResync:
		return a.loadNotes()
	case client.WatchChanged:
		change := watched.update.Change
		if change.GetKind() == views.WatchKind_WATCH_KIND_MEMORY && change.GetTag() == a.notes.tag {
			return a.loadNotes()
		}
	}
	return nil
}

func (a *app) notesMessage(msg tea.Msg) bool {
	switch msg := msg.(type) {
	case notesMsg:
		if d := a.notes; d == msg.dialog {
			d.read = true
			if msg.err != nil {
				d.note = terminalText(msg.err.Error())
			} else {
				d.notes, d.note = msg.notes, ""
				d.cursor = max(min(d.cursor, len(d.notes)-1), 0)
			}
		}
		return true
	case noteDeletedMsg:
		if d := a.notes; d == msg.dialog {
			d.busy = false
			if msg.err != nil {
				d.note = terminalText(msg.err.Error())
				return true
			}
			d.note = ""
			kept := d.notes[:0]
			for _, note := range d.notes {
				if note.ID != msg.id {
					kept = append(kept, note)
				}
			}
			d.notes = kept
			d.cursor = max(min(d.cursor, len(d.notes)-1), 0)
		}
		return true
	}
	return false
}

func (a *app) notesKey(msg tea.KeyPressMsg) tea.Cmd {
	d := a.notes
	switch msg.String() {
	case "ctrl+c":
		a.closeNotes()
		return tea.Quit
	case "esc":
		a.closeNotes()
		return nil
	case "up", "k":
		d.cursor = max(d.cursor-1, 0)
		return nil
	case "down", "j":
		d.cursor = max(min(d.cursor+1, len(d.notes)-1), 0)
		return nil
	case "x", "delete", "backspace":
	default:
		return nil
	}
	if d.busy || len(d.notes) == 0 {
		return nil
	}
	selected := d.notes[d.cursor]
	if d.cancel != nil {
		d.cancel()
	}
	ctx, cancel := context.WithCancel(a.inner.ctx)
	d.cancel, d.busy, d.note = cancel, true, ""
	c := a.inner.client
	return a.scope(func() tea.Msg {
		defer cancel()
		_, err := c.DeleteNote(ctx, selected.ID)
		return noteDeletedMsg{dialog: d, id: selected.ID, err: err}
	})
}

// noteCaption says who sees a note, when it was kept, and when a turn last used it, as the
// desktop app's Tag details do.
func noteCaption(note client.Note, now time.Time) string {
	who := "shared"
	if note.Private {
		who = "only you"
	}
	used := "not used yet"
	if !note.LastSeen.IsZero() {
		used = "last used " + noteTime(note.LastSeen, now)
	}
	return who + " · kept " + noteTime(note.Kept, now) + " · " + used
}

func noteTime(at, now time.Time) string {
	at = at.Local()
	if y, m, d := at.Date(); y == now.Local().Year() && m == now.Local().Month() && d == now.Local().Day() {
		return at.Format("15:04")
	}
	return at.Format("Mon Jan 2")
}

func (a *app) renderNotes() string {
	d := a.notes
	height, width := max(a.height-1, 2), max(a.width-2, 10)
	lines := []string{headerStyle.Render(truncate("Notes · "+terminalText(d.label), width)),
		faint.Render(truncate("What "+terminalText(d.label)+" keeps between turns. Delete a note to have it forget it.", width))}
	shown := max((height-6)/2, 1)
	first := max(d.cursor-shown+1, 0)
	now := time.Now()
	for i := first; i < min(first+shown, len(d.notes)); i++ {
		style := lipgloss.NewStyle()
		if i == d.cursor {
			style = focusedSel
		}
		note := d.notes[i]
		lines = append(lines, style.Render(truncate(terminalText(note.Text), width)),
			faint.Render(truncate("  "+noteCaption(note, now), width)))
	}
	switch {
	case !d.read:
		lines = append(lines, "Reading from the Control Plane…")
	case len(d.notes) == 0 && d.note == "":
		lines = append(lines, terminalText(d.label)+" keeps no notes you can see yet. Tell it what to remember.")
	}
	if d.note != "" {
		lines = append(lines, errorStyle.Render(truncate(d.note, width)))
	}
	footer := "x deletes · ↑ ↓ notes · esc back"
	lines = append(lines, "", faint.Render(truncate(footer, width)))
	return lipgloss.NewStyle().Padding(0, 1).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}
