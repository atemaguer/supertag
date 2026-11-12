package client

import (
	"context"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
)

func (c *runtimeClient) listTeams(ctx context.Context) ([]*operatorv1.Team, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var teams []*operatorv1.Team
	cursor := ""
	seen := map[string]bool{}
	for {
		res, err := c.teams.ListTeams(ctx, connect.NewRequest(&v2.ListTeamsRequest{Limit: 32, Cursor: cursor}))
		if err != nil {
			return nil, apiError(err)
		}
		for _, team := range res.Msg.GetTeams() {
			teams = append(teams, runtimeTeam(team))
		}
		next := res.Msg.GetNextCursor()
		if next == "" {
			return teams, nil
		}
		if seen[next] {
			return nil, &APIError{Code: connect.CodeDataLoss, Message: "Gateway Team cursor did not advance."}
		}
		seen[next] = true
		cursor = next
	}
}

func (c *runtimeClient) getTeam(ctx context.Context, name string, posts int32) (TeamView, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	got, err := c.teams.GetTeam(ctx, connect.NewRequest(&v2.GetTeamRequest{Team: name}))
	if err != nil {
		return TeamView{}, apiError(err)
	}
	view := TeamView{Team: runtimeTeam(got.Msg), TagNames: map[string]string{}}
	res, err := c.teams.ListWorkstreamPosts(ctx, connect.NewRequest(&v2.ListWorkstreamPostsRequest{
		Team: view.Team.GetId(), Limit: uint32(max(posts, 0)),
	}))
	if err != nil {
		return TeamView{}, apiError(err)
	}
	for _, post := range res.Msg.GetPosts() {
		if post.GetTeamId() != view.Team.GetId() {
			return TeamView{}, &APIError{Code: connect.CodeDataLoss, Message: "Gateway returned a different Team's Workstream post."}
		}
		view.TagNames[post.GetAuthorTagId()] = post.GetAuthorTagId()
		for _, tag := range post.GetToTagIds() {
			view.TagNames[tag] = tag
		}
		view.Posts = append(view.Posts, &operatorv1.WorkstreamPost{
			Id: post.GetPostId(), TeamId: post.GetTeamId(), AuthorTagId: post.GetAuthorTagId(),
			ToTagIds: post.GetToTagIds(), Body: post.GetBody(), SourceTaskId: post.GetSourceTaskId(),
			Sequence: int64(post.GetSequence()), CreatedAt: timestamppb.New(time.UnixMilli(post.GetCreatedAtMs())),
		})
	}
	return view, nil
}

func runtimeTeam(team *v2.Team) *operatorv1.Team {
	view := &operatorv1.Team{
		Id: team.GetTeamId(), Name: team.GetName(), Revision: int64(team.GetRevision()),
		CreatedAt: timestamppb.New(time.UnixMilli(team.GetCreatedAtMs())),
		UpdatedAt: timestamppb.New(time.UnixMilli(team.GetUpdatedAtMs())),
	}
	if team.MaxConcurrency != nil {
		view.MaxConcurrency = proto.Int32(int32(team.GetMaxConcurrency()))
	}
	for _, tag := range team.GetMemberTagIds() {
		view.Members = append(view.Members, &operatorv1.TeamMember{TagId: tag, Tag: tag})
	}
	return view
}
