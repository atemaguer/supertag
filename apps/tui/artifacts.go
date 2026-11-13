package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
)

type taskFilesDialog struct {
	input                        textinput.Model
	task                         string
	files                        []client.TaskFile
	cursor                       int
	enterTask, destination, busy bool
	note                         string
	cancel                       context.CancelFunc
}

type taskFilesMsg struct {
	dialog *taskFilesDialog
	files  []client.TaskFile
	err    error
}

type taskFileSavedMsg struct {
	dialog *taskFilesDialog
	path   string
	err    error
}

func (a *app) closeTaskFiles() {
	if a.files != nil && a.files.cancel != nil {
		a.files.cancel()
	}
	a.files = nil
}

func (a *app) openTaskFiles() tea.Cmd {
	a.closeTaskFiles()
	input := textinput.New()
	input.Prompt = "> "
	input.Placeholder = "Task ID"
	input.SetWidth(max(a.width-6, 10))
	a.files = &taskFilesDialog{input: input, enterTask: true}
	var task string
	if a.inner.pane == paneObjective {
		if message := a.inner.objectiveMessages[a.inner.objectiveID]; message != nil {
			task = message.task
		}
	} else if a.inner.pane == paneConversation {
		if conversation := a.inner.shown(); conversation != nil {
			task = conversation.runtime.head
		}
	}
	if task != "" {
		a.files.task = task
		return a.loadTaskFiles()
	}
	return a.files.input.Focus()
}

func (a *app) loadTaskFiles() tea.Cmd {
	d := a.files
	d.enterTask, d.destination, d.busy, d.note = false, false, true, ""
	d.input.Blur()
	ctx, cancel := context.WithCancel(a.inner.ctx)
	d.cancel = cancel
	c := a.inner.client
	return a.scope(func() tea.Msg {
		defer cancel()
		files, err := c.TaskFiles(ctx, d.task)
		return taskFilesMsg{dialog: d, files: files, err: err}
	})
}

func (a *app) taskFilesMessage(msg tea.Msg) bool {
	switch msg := msg.(type) {
	case taskFilesMsg:
		if a.files == msg.dialog {
			d := a.files
			d.busy, d.files, d.cursor = false, msg.files, 0
			if msg.err != nil {
				d.note = terminalText(msg.err.Error())
			}
		}
		return true
	case taskFileSavedMsg:
		if a.files == msg.dialog {
			d := a.files
			d.busy = false
			if msg.err != nil {
				d.note = terminalText(msg.err.Error())
			} else {
				d.destination = false
				d.input.Blur()
				d.note = "Saved " + terminalText(msg.path)
			}
		}
		return true
	}
	return false
}

func (a *app) taskFilesKey(msg tea.KeyPressMsg) tea.Cmd {
	d := a.files
	switch msg.String() {
	case "ctrl+c":
		a.closeTaskFiles()
		return tea.Quit
	case "esc":
		if d.destination && !d.busy {
			d.destination, d.note = false, ""
			d.input.Blur()
		} else {
			a.closeTaskFiles()
		}
		return nil
	}
	if d.busy {
		return nil
	}
	if d.enterTask || d.destination {
		if msg.String() == "enter" {
			if strings.TrimSpace(d.input.Value()) == "" {
				return nil
			}
			if d.enterTask {
				d.task = strings.TrimSpace(d.input.Value())
				return a.loadTaskFiles()
			}
			selected, output, c := d.files[d.cursor], d.input.Value(), a.inner.client
			ctx, cancel := context.WithCancel(a.inner.ctx)
			d.cancel, d.busy, d.note = cancel, true, ""
			return a.scope(func() tea.Msg {
				defer cancel()
				path, err := c.DownloadTaskFile(ctx, selected, output)
				return taskFileSavedMsg{dialog: d, path: path, err: err}
			})
		}
		var cmd tea.Cmd
		d.input, cmd = d.input.Update(msg)
		return cmd
	}
	switch msg.String() {
	case "up", "k":
		d.cursor = max(d.cursor-1, 0)
	case "down", "j":
		d.cursor = max(min(d.cursor+1, len(d.files)-1), 0)
	case "t":
		d.enterTask, d.note = true, ""
		d.input.Placeholder = "Task ID"
		d.input.SetValue(d.task)
		return d.input.Focus()
	case "enter":
		if len(d.files) > 0 {
			d.destination, d.note = true, ""
			d.input.Placeholder = "Local destination"
			d.input.SetValue(filepath.Base(d.files[d.cursor].Path))
			return d.input.Focus()
		}
	}
	return nil
}

func (a *app) renderTaskFiles() string {
	d := a.files
	height, width := max(a.height-1, 2), max(a.width-2, 10)
	lines := []string{headerStyle.Render("Task files")}
	footer := "enter chooses · ↑ ↓ files · t another Task · esc back"
	switch {
	case d.enterTask:
		lines = append(lines, "Enter the Task ID shown beside its result files.", d.input.View())
		footer = "enter lists files · esc back"
	case d.destination:
		lines = append(lines, terminalText(d.files[d.cursor].Path), "Save to a local path (existing files are never replaced):", d.input.View())
		footer = "enter saves · esc back"
	default:
		lines = append(lines, "Task "+terminalText(d.task))
		shown := max(height-7, 1)
		first := max(d.cursor-shown+1, 0)
		for i := first; i < min(first+shown, len(d.files)); i++ {
			file := d.files[i]
			text := fmt.Sprintf("%s  ·  %d bytes  ·  %s", terminalText(file.Path), file.Bytes, terminalText(file.Title))
			style := lipgloss.NewStyle()
			if i == d.cursor {
				style = focusedSel
			}
			lines = append(lines, style.Render(truncate(text, width)))
		}
		if len(d.files) == 0 && !d.busy {
			lines = append(lines, "No files in this Task's completed result.")
		}
	}
	if d.busy {
		lines = append(lines, "Reading from the Control Plane…")
		footer = "esc cancels"
	}
	if d.note != "" {
		lines = append(lines, truncate(d.note, width))
	}
	lines = append(lines, "", faint.Render(truncate(footer, width)))
	return lipgloss.NewStyle().Padding(0, 1).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}
