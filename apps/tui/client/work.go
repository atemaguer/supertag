package client

import (
	"context"
	"strings"

	"github.com/atemaguer/supertag/apps/tui/views"
)

// maxEventPages bounds how many pages of a Task's events TaskActivity reads in one call; the next
// call continues after the last event read.
const maxEventPages = 5

// eventPage is the page size TaskActivity asks for, the most ListTaskEvents returns.
const eventPage = 1000

// maxTeamPages bounds ListTeams, so an organization with very many Teams still gets an answer.
const maxTeamPages = 10

// GetSession reads one Session with what its latest delivering Task delivered.
func (c *Client) GetSession(ctx context.Context, id string) (*views.Session, error) {
	return c.runtime.getWorkSessionDetail(ctx, id)
}

// Activity is one command or tool call a Task ran, as its activity line shows it.
type Activity struct {
	// Key names the command or tool call, so a later event about it adds no second line.
	Key string
	// Line is the activity line, such as "· running: pytest -q". It is not filtered for the
	// terminal.
	Line string
}

// TaskActivity returns the commands and tool calls the Task's recorded events after sequence
// after start, in order, and the last sequence read. A command shows once, when it starts
// running.
func (c *Client) TaskActivity(ctx context.Context, taskID string, after int64) ([]Activity, int64, error) {
	return c.runtime.taskActivity(ctx, taskID, after)
}

// eventActivity is the activity a recorded event shows: a command that starts running, or a tool
// call that starts. The Control Plane stores Worker events under an `execution.` prefix.
func eventActivity(event *views.TaskEvent) (Activity, bool) {
	payload := event.GetPayload().AsMap()
	field := func(object any, name string) string {
		if m, ok := object.(map[string]any); ok {
			if s, ok := m[name].(string); ok {
				return s
			}
		}
		return ""
	}
	switch strings.TrimPrefix(event.GetType(), "execution.") {
	case "command.updated":
		command := payload["command"]
		text := strings.TrimSpace(field(command, "command"))
		if field(command, "status") != "running" || text == "" {
			return Activity{}, false
		}
		return Activity{Key: "command:" + field(command, "id"), Line: "· running: " + text}, true
	case "tool.call.started":
		call := payload["call"]
		tool := field(call, "provider") + "." + field(call, "operation")
		if tool == "." {
			return Activity{}, false
		}
		return Activity{Key: "tool:" + field(call, "id"), Line: "· using: " + strings.Trim(tool, ".")}, true
	}
	return Activity{}, false
}

// ListTeams returns every Team, by name.
func (c *Client) ListTeams(ctx context.Context) ([]*views.Team, error) {
	return c.runtime.listTeams(ctx)
}

// TeamView is one Team with the newest posts to its Workstream.
type TeamView struct {
	Team *views.Team
	// Posts are the newest posts, oldest first.
	Posts []*views.WorkstreamPost
	// TagNames are the names of the Tags the posts name, by Tag ID.
	TagNames map[string]string
}

// GetTeam reads a Team, by name or ID, and the newest posts of its Workstream, at most posts of
// them.
func (c *Client) GetTeam(ctx context.Context, team string, posts int32) (TeamView, error) {
	return c.runtime.getTeam(ctx, team, posts)
}
