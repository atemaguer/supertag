package client

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/structpb"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1/operatorv1connect"
)

func event(t *testing.T, sequence int64, kind string, payload map[string]any) *operatorv1.TaskEvent {
	t.Helper()
	s, err := structpb.NewStruct(payload)
	if err != nil {
		t.Fatal(err)
	}
	return &operatorv1.TaskEvent{TaskId: "w1", Sequence: sequence, Type: kind, Payload: s}
}

func TestTaskActivityReadsCommandsAndToolCalls(t *testing.T) {
	var requests []*operatorv1.ListTaskEventsRequest
	f := &fakeControlPlane{taskEvents: func(req *operatorv1.ListTaskEventsRequest) (*operatorv1.ListTaskEventsResponse, error) {
		requests = append(requests, req)
		if req.GetPageToken() == "" {
			return &operatorv1.ListTaskEventsResponse{Events: []*operatorv1.TaskEvent{
				event(t, 3, "task.created", map[string]any{}),
				event(t, 4, "execution.command.updated", map[string]any{"command": map[string]any{"id": "c1", "command": "pytest -q", "status": "running"}}),
				event(t, 5, "execution.command.updated", map[string]any{"command": map[string]any{"id": "c1", "command": "pytest -q", "status": "completed"}}),
			}, NextPageToken: "more"}, nil
		}
		return &operatorv1.ListTaskEventsResponse{Events: []*operatorv1.TaskEvent{
			event(t, 6, "execution.tool.call.started", map[string]any{"call": map[string]any{"id": "u1", "provider": "github", "operation": "create_pull_request"}}),
			event(t, 7, "execution.command.updated", map[string]any{"command": map[string]any{"id": "c2", "command": "  ", "status": "running"}}),
		}}, nil
	}}
	c := newFake(t, f)
	activity, after, err := c.TaskActivity(context.Background(), "w1", 2)
	if err != nil || after != 7 {
		t.Fatalf("TaskActivity() after = %d, %v", after, err)
	}
	want := []Activity{{Key: "command:c1", Line: "· running: pytest -q"}, {Key: "tool:u1", Line: "· using: github.create_pull_request"}}
	if len(activity) != len(want) || activity[0] != want[0] || activity[1] != want[1] {
		t.Fatalf("activity = %+v, want %+v", activity, want)
	}
	if len(requests) != 2 || requests[0].GetTaskId() != "w1" || requests[0].GetAfterSequence() != 2 || requests[0].GetPageSize() != eventPage || requests[1].GetPageToken() != "more" {
		t.Fatalf("requests = %v", requests)
	}
}

func TestGetSessionAndTeamCallTheirServices(t *testing.T) {
	f := &fakeControlPlane{
		session: func(req *operatorv1.GetSessionRequest) (*operatorv1.Session, error) {
			if req.GetId() != "s1" {
				return nil, connect.NewError(connect.CodeNotFound, errors.New("Session "+req.GetId()+" was not found"))
			}
			return &operatorv1.Session{Id: "s1", Delivery: &operatorv1.SessionDelivery{TaskId: "w1"}}, nil
		},
		teams: func(req *operatorv1.ListTeamsRequest) (*operatorv1.ListTeamsResponse, error) {
			if req.GetPageToken() == "" {
				return &operatorv1.ListTeamsResponse{Teams: []*operatorv1.Team{{Id: "a", Name: "a"}}, NextPageToken: "p2"}, nil
			}
			return &operatorv1.ListTeamsResponse{Teams: []*operatorv1.Team{{Id: "b", Name: "b"}}}, nil
		},
		team: func(req *operatorv1.GetTeamRequest) (*operatorv1.Team, error) {
			return &operatorv1.Team{Id: "team-billing", Name: req.GetTeam()}, nil
		},
		posts: func(req *operatorv1.ListWorkstreamPostsRequest) (*operatorv1.ListWorkstreamPostsResponse, error) {
			if req.GetTeam() != "team-billing" || req.GetPageSize() != 5 || req.AfterSequence != nil {
				t.Errorf("request = %v", req)
			}
			return &operatorv1.ListWorkstreamPostsResponse{Posts: []*operatorv1.WorkstreamPost{{Id: "p1"}}, TagNames: map[string]string{"t1": "lead"}}, nil
		},
	}
	c := newFake(t, f)
	session, err := c.GetSession(context.Background(), "s1")
	if err != nil || session.GetDelivery().GetTaskId() != "w1" {
		t.Fatalf("GetSession() = %v, %v", session, err)
	}
	var apiErr *APIError
	if _, err := c.GetSession(context.Background(), "s2"); !errors.As(err, &apiErr) || apiErr.Code != connect.CodeNotFound || !strings.Contains(err.Error(), "s2 was not found") {
		t.Fatalf("GetSession(s2) = %v", err)
	}
	teams, err := c.ListTeams(context.Background())
	if err != nil || len(teams) != 2 || teams[1].GetId() != "b" {
		t.Fatalf("ListTeams() = %v, %v", teams, err)
	}
	view, err := c.GetTeam(context.Background(), "billing", 5)
	if err != nil || view.Team.GetName() != "billing" || len(view.Posts) != 1 || view.TagNames["t1"] != "lead" {
		t.Fatalf("GetTeam() = %+v, %v", view, err)
	}
	if calls := f.callsTo(operatorv1connect.WorkServiceGetSessionProcedure); len(calls) != 2 || calls[0].authorization != "Bearer secret" {
		t.Fatalf("GetSession calls = %+v", calls)
	}
}
