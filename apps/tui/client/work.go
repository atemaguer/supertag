package client

import (
	"context"
	"strings"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// maxEventPages bounds how many pages of a Task's events TaskActivity reads in one call; the next
// call continues after the last event read.
const maxEventPages = 5

// eventPage is the page size TaskActivity asks for, the most ListTaskEvents returns.
const eventPage = 1000

// maxTeamPages bounds ListTeams, so an organization with very many Teams still gets an answer.
const maxTeamPages = 10

// GetSession reads one Session with what its latest delivering Task delivered.
func (c *Client) GetSession(ctx context.Context, id string) (*operatorv1.Session, error) {
	if c.RuntimeV2() {
		return nil, unavailable("Work Session details")
	}
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.work.GetSession(ctx, connect.NewRequest(&operatorv1.GetSessionRequest{Id: id}))
	if err != nil {
		return nil, apiError(err)
	}
	return res.Msg, nil
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
	if c.RuntimeV2() {
		return nil, after, unavailable("Structured Task activity")
	}
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var activity []Activity
	token := ""
	for range maxEventPages {
		res, err := c.work.ListTaskEvents(ctx, connect.NewRequest(&operatorv1.ListTaskEventsRequest{
			TaskId: taskID, AfterSequence: after, PageSize: eventPage, PageToken: token,
		}))
		if err != nil {
			return nil, 0, apiError(err)
		}
		for _, event := range res.Msg.GetEvents() {
			if a, ok := eventActivity(event); ok {
				activity = append(activity, a)
			}
		}
		if events := res.Msg.GetEvents(); len(events) > 0 {
			after = max(after, events[len(events)-1].GetSequence())
		}
		token = res.Msg.GetNextPageToken()
		if token == "" {
			break
		}
	}
	return activity, after, nil
}

// eventActivity is the activity a recorded event shows: a command that starts running, or a tool
// call that starts. The Control Plane stores Worker events under an `execution.` prefix.
func eventActivity(event *operatorv1.TaskEvent) (Activity, bool) {
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
func (c *Client) ListTeams(ctx context.Context) ([]*operatorv1.Team, error) {
	if c.RuntimeV2() {
		return c.runtime.listTeams(ctx)
	}
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var all []*operatorv1.Team
	token := ""
	for range maxTeamPages {
		res, err := c.teams.ListTeams(ctx, connect.NewRequest(&operatorv1.ListTeamsRequest{PageSize: 500, PageToken: token}))
		if err != nil {
			return nil, apiError(err)
		}
		all = append(all, res.Msg.GetTeams()...)
		token = res.Msg.GetNextPageToken()
		if token == "" {
			break
		}
	}
	return all, nil
}

// TeamView is one Team with the newest posts to its Workstream.
type TeamView struct {
	Team *operatorv1.Team
	// Posts are the newest posts, oldest first.
	Posts []*operatorv1.WorkstreamPost
	// TagNames are the names of the Tags the posts name, by Tag ID.
	TagNames map[string]string
}

// GetTeam reads a Team, by name or ID, and the newest posts of its Workstream, at most posts of
// them.
func (c *Client) GetTeam(ctx context.Context, team string, posts int32) (TeamView, error) {
	if c.RuntimeV2() {
		return c.runtime.getTeam(ctx, team, posts)
	}
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	got, err := c.teams.GetTeam(ctx, connect.NewRequest(&operatorv1.GetTeamRequest{Team: team}))
	if err != nil {
		return TeamView{}, apiError(err)
	}
	list, err := c.mailbox.ListWorkstreamPosts(ctx, connect.NewRequest(&operatorv1.ListWorkstreamPostsRequest{
		Team: got.Msg.GetId(), PageSize: posts,
	}))
	if err != nil {
		return TeamView{}, apiError(err)
	}
	names := map[string]string{}
	for id, name := range list.Msg.GetTagNames() {
		names[id] = name
	}
	return TeamView{Team: got.Msg, Posts: list.Msg.GetPosts(), TagNames: names}, nil
}
