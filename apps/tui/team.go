package main

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// teamPosts is how many of the newest Workstream posts the Team view shows.
const teamPosts = 20

type (
	teamsMsg struct {
		teams []*operatorv1.Team
		err   error
	}
	teamMsg struct {
		id   string
		view client.TeamView
		err  error
	}
)

func (m model) reloadTeams() tea.Cmd {
	if !m.teamReload.start() {
		return nil
	}
	return m.teamsCmd()
}

func (m model) teamsCmd() tea.Cmd {
	return func() tea.Msg {
		teams, err := m.client.ListTeams(m.ctx)
		return teamsMsg{teams: teams, err: err}
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
	return func() tea.Msg {
		view, err := m.client.GetTeam(m.ctx, id, teamPosts)
		return teamMsg{id: id, view: view, err: err}
	}
}

func (m *model) teamsRead(msg teamsMsg) tea.Cmd {
	var again tea.Cmd
	if m.teamReload.done() {
		again = m.teamsCmd()
	}
	if msg.err != nil {
		m.teamsErr = terminalText(msg.err.Error())
		return again
	}
	m.teams, m.teamsErr = msg.teams, ""
	m.placeCursor()
	m.refresh()
	return again
}

func (m *model) teamRead(msg teamMsg) tea.Cmd {
	var again tea.Cmd
	if m.teamView.done() && m.pane == paneTeam {
		again = m.teamCmd(m.teamID)
	}
	if msg.err != nil {
		m.teamErrs[msg.id] = terminalText(msg.err.Error())
	} else {
		m.teamViews[msg.id] = msg.view
		delete(m.teamErrs, msg.id)
	}
	if m.pane == paneTeam && m.teamID == msg.id {
		m.refresh()
	}
	return again
}

// listedTeam is the listed Team with this ID, or nil.
func (m model) listedTeam(id string) *operatorv1.Team {
	for _, team := range m.teams {
		if team.GetId() == id {
			return team
		}
	}
	return nil
}

// teamState is what the rail shows beside a Team: how many members it has.
func teamState(team *operatorv1.Team) string {
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
	add("", "Change it with supertag update team "+shellWord(team.GetName())+".")
	for i, line := range lines {
		lines[i] = terminalText(line)
	}
	return strings.Join(lines, "\n")
}
