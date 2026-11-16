package client

import (
	"context"

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

// Activity is one recorded event of a Task, as its activity line shows it.
type Activity struct {
	// Key names the event, so a refresh adds no second line for it.
	Key string
	// Line is the activity line: a message the Task's Tag wrote, what it did, such as
	// "Running pytest -q", or its plan's current step. It is not filtered for the terminal.
	Line string
}

// TaskActivity returns the activity lines of the Task's recorded events after sequence after,
// in order, and the last sequence read.
func (c *Client) TaskActivity(ctx context.Context, taskID string, after int64) ([]Activity, int64, error) {
	return c.runtime.taskActivity(ctx, taskID, after)
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
