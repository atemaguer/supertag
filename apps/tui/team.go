package main

import (
	"errors"
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

// teamPosts is how many of the newest Workstream posts the Team view shows.
const teamPosts = 20

type (
	teamsMsg struct {
		teams []*views.Team
		err   error
		// read numbers the ListTeams call this answers.
		read uint64
	}
	teamMsg struct {
		id   string
		view client.TeamView
		err  error
		// read numbers the GetTeam call this answers.
		read uint64
	}
)

// teamReads numbers Team reads as they start and remembers the newest applied, so a reply that
// arrives after a newer one, or answers a call started before it, never replaces newer data.
type teamReads struct {
	next        uint64
	listApplied uint64
	viewApplied map[string]uint64
	// gone holds the Teams found deleted, by ID, with the name they last had.
	gone map[string]string
}

func newTeamReads() *teamReads {
	return &teamReads{viewApplied: map[string]uint64{}, gone: map[string]string{}}
}

func (r *teamReads) start() uint64 {
	r.next++
	return r.next
}

func (m model) reloadTeams() tea.Cmd {
	if !m.teamReload.start() {
		return nil
	}
	return m.teamsCmd()
}

func (m model) teamsCmd() tea.Cmd {
	read := m.teamReads.start()
	return func() tea.Msg {
		teams, err := m.client.ListTeams(m.ctx)
		return teamsMsg{teams: teams, err: err, read: read}
	}
}

// reloadTeam rereads the shown Team and its Workstream; nil when no Team is shown.
func (m model) reloadTeam() tea.Cmd {
	if m.pane != paneTeam || !m.teamView.start() {
		return nil
	}
	return m.teamCmd(m.teamID)
}

func (m model) teamCmd(id string) tea.Cmd {
	read := m.teamReads.start()
	return func() tea.Msg {
		view, err := m.client.GetTeam(m.ctx, id, teamPosts)
		return teamMsg{id: id, view: view, err: err, read: read}
	}
}

// teamChanged rereads what a Team change touches: the Teams list always, since the change may
// add, rename or remove a row, and the Team's details only when the Team pane shows that Team.
// The Control Plane sends the change only to a caller that may read
// Teams, and the rereads go through the same reads, so nothing outside the caller's view is read.
func (m model) teamChanged(change *views.WatchChange) tea.Cmd {
	id := change.GetTeamId()
	if id == "" {
		id = change.GetId()
	}
	var detail tea.Cmd
	if id != "" && m.pane == paneTeam && id == m.teamID {
		detail = m.reloadTeam()
	}
	return tea.Batch(m.reloadTeams(), detail)
}

// shownTeamHasMember reports whether the Team pane shows a Team with this member Tag.
func (m model) shownTeamHasMember(tagID string) bool {
	team := m.teamViews[m.teamID].Team
	if team == nil {
		team = m.listedTeam(m.teamID)
	}
	for _, member := range team.GetMembers() {
		if member.GetTagId() == tagID {
			return true
		}
	}
	return false
}

func (m *model) teamsRead(msg teamsMsg) tea.Cmd {
	var again tea.Cmd
	if m.teamReload.done() {
		again = m.teamsCmd()
	}
	reads := m.teamReads
	if msg.read <= reads.listApplied {
		return again // A newer list is already shown.
	}
	if msg.err != nil {
		m.teamsErr = terminalText(msg.err.Error())
		return again
	}
	reads.listApplied = msg.read
	m.teams, m.teamsErr = msg.teams, ""
	if m.pane == paneTeam && m.teamID != "" && msg.read > reads.viewApplied[m.teamID] {
		if team := m.listedTeam(m.teamID); team != nil {
			delete(reads.gone, m.teamID)
		} else {
			// A pre-deletion detail read can still be in flight. Do not let it restore this Team.
			reads.viewApplied[m.teamID] = msg.read
			m.forgetTeam(m.teamID)
		}
	}
	m.placeCursor()
	m.refresh()
	return again
}

// forgetTeam records that the Team was deleted and drops what was read of it.
func (m *model) forgetTeam(id string) {
	name := m.teamViews[id].Team.GetName()
	if name == "" {
		name = m.teamReads.gone[id]
	}
	m.teamReads.gone[id] = name
	delete(m.teamViews, id)
	delete(m.teamErrs, id)
}

func (m *model) teamRead(msg teamMsg) tea.Cmd {
	var again tea.Cmd
	if m.pane != paneTeam {
		// There is no pane to refresh. Let the next visit start its own read.
		*m.teamView = reload{}
	} else if m.teamView.done() {
		again = m.teamCmd(m.teamID)
	}
	reads := m.teamReads
	if msg.read <= reads.viewApplied[msg.id] {
		return again // A newer read of this Team is already shown.
	}
	var apiErr *client.APIError
	switch {
	case (msg.err == nil && msg.view.Team.GetId() != msg.id) ||
		(errors.As(msg.err, &apiErr) && apiErr.Code == connect.CodeNotFound):
		// GetTeam also accepts names. A different Team with this name is not this ID.
		reads.viewApplied[msg.id] = msg.read
		m.forgetTeam(msg.id)
	case msg.err != nil:
		m.teamErrs[msg.id] = terminalText(msg.err.Error())
	default:
		if shown, ok := m.teamViews[msg.id]; ok && shown.Team.GetRevision() > msg.view.Team.GetRevision() {
			return again // An older revision answered late.
		}
		reads.viewApplied[msg.id] = msg.read
		m.teamViews[msg.id] = msg.view
		delete(m.teamErrs, msg.id)
		delete(reads.gone, msg.id)
	}
	if m.pane == paneTeam && m.teamID == msg.id {
		m.refresh()
	}
	return again
}

// listedTeam is the listed Team with this ID, or nil.
func (m model) listedTeam(id string) *views.Team {
	for _, team := range m.teams {
		if team.GetId() == id {
			return team
		}
	}
	return nil
}

// teamState is what the rail shows beside a Team: how many members it has.
func teamState(team *views.Team) string {
	return plural(len(team.GetMembers()), "member")
}

// renderTeam is the Team pane: its members, its turn limit, and the newest posts of its
// Workstream, wrapped to the pane.
func (m model) renderTeam() string {
	wrap := lipgloss.NewStyle().Width(m.paneWidth())
	view, read := m.teamViews[m.teamID]
	text := ""
	if err := m.teamErrs[m.teamID]; err != "" {
		text = errorStyle.Render(wrap.Render("Could not read the Team: "+err)) + "\n\n"
	}
	if !read {
		if name, gone := m.teamReads.gone[m.teamID]; gone {
			if name == "" {
				name = m.teamID
			}
			return text + faint.Render(wrap.Render(terminalText("Team "+name+" was deleted. Choose another row.")))
		}
		team := m.listedTeam(m.teamID)
		if team == nil {
			return text + faint.Render("Reading the Team…")
		}
		view = client.TeamView{Team: team}
	}
	return text + wrap.Render(describeTeam(view, read))
}

// describeTeam renders a Team and its Workstream; posts says the Workstream was read. Every line
// is filtered for the terminal.
func describeTeam(view client.TeamView, posts bool) string {
	team := view.Team
	var lines []string
	add := func(line ...string) { lines = append(lines, line...) }
	add(fmt.Sprintf("Team %s (%s)", team.GetName(), team.GetId()))
	members := make([]string, 0, len(team.GetMembers()))
	names := map[string]string{}
	for _, member := range team.GetMembers() {
		name := member.GetTag()
		if name == "" {
			name = "deleted Tag " + member.GetTagId()
		}
		names[member.GetTagId()] = name
		members = append(members, name)
	}
	if len(members) == 0 {
		members = []string{"none"}
	}
	add("Members: " + strings.Join(members, ", "))
	if team.MaxConcurrency == nil {
		add("Turns: limited only by Worker Host capacity")
	} else {
		add(fmt.Sprintf("Turns: at most %d at once across its Objectives", team.GetMaxConcurrency()))
	}
	add(fmt.Sprintf("Revision: %d", team.GetRevision()))
	tag := func(id string) string {
		if name, ok := view.TagNames[id]; ok {
			return name
		}
		if name, ok := names[id]; ok {
			return name
		}
		return "unknown Tag"
	}
	add("", "Workstream:")
	switch {
	case !posts:
		add("  Reading the Workstream…")
	case len(view.Posts) == 0:
		add("  No posts yet.")
	}
	for _, post := range view.Posts {
		line := "  " + tag(post.GetAuthorTagId())
		if to := post.GetToTagIds(); len(to) > 0 {
			recipients := make([]string, 0, len(to))
			for _, id := range to {
				recipients = append(recipients, tag(id))
			}
			line += " to " + strings.Join(recipients, ", ")
		}
		if at := post.GetCreatedAt(); at != nil {
			line += " · " + timestamp(at)
		}
		add(line)
		for _, body := range strings.Split(strings.TrimSpace(strings.ReplaceAll(post.GetBody(), "\r\n", "\n")), "\n") {
			add("    " + body)
		}
	}
	add("", "Change it with supertag team update "+shellWord(team.GetId())+" --help.")
	for i, line := range lines {
		lines[i] = terminalText(line)
	}
	return strings.Join(lines, "\n")
}
