package main

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return at
}

func billingTeam() *operatorv1.Team {
	return &operatorv1.Team{Id: "team-billing", Name: "billing", MaxConcurrency: int32p(2), Revision: 4,
		Members: []*operatorv1.TeamMember{{TagId: "tag-lead", Tag: "lead"}, {TagId: "tag-builder", Tag: "builder"}, {TagId: "tag-gone"}}}
}

func TestTheTeamsViewShowsMembersLimitAndWorkstream(t *testing.T) {
	posts := []*operatorv1.WorkstreamPost{
		{Id: "p1", TeamId: "team-billing", AuthorTagId: "tag-builder", ToTagIds: []string{"tag-lead"}, Body: "Fix is on the branch.\nTests pass.",
			Sequence: 1, CreatedAt: timestamppb.New(mustTime(t, "2026-11-08T10:00:00Z"))},
	}
	fake := &fakeControlPlane{
		tags: tags("lead", "builder"),
		teamList: func() []*operatorv1.Team {
			return []*operatorv1.Team{billingTeam(), {Id: "team-open", Name: "open", Revision: 1}}
		},
		posts: func(req *operatorv1.ListWorkstreamPostsRequest) *operatorv1.ListWorkstreamPostsResponse {
			if req.GetPageSize() != teamPosts || req.AfterSequence != nil {
				t.Errorf("request = %v", req)
			}
			if req.GetTeam() != "team-billing" {
				return &operatorv1.ListWorkstreamPostsResponse{}
			}
			return &operatorv1.ListWorkstreamPostsResponse{Posts: posts, TagNames: map[string]string{"tag-lead": "lead", "tag-builder": "builder"}}
		},
	}
	m := testModel(t, fake)
	m = run(t, m, tea.Batch(m.reloadTags(), m.reloadTeams()))
	if rail := ansi.Strip(m.renderRail(20)); !strings.Contains(rail, "Teams") || !strings.Contains(rail, "billing 3 members") || !strings.Contains(rail, "open 0 members") {
		t.Fatalf("rail:\n%s", rail)
	}
	m = moveTo(t, m, "billing")
	got := screen(m)
	for _, want := range []string{"Team · billing", "Team billing (team-billing)", "Members: lead, builder, deleted Tag tag-gone",
		"Turns: at most 2 at once across its Objectives", "Revision: 4", "builder to lead · 2026-11-08T10:00:00Z",
		"    Fix is on the branch.", "    Tests pass.", "supertag team update billing"} {
		if !strings.Contains(got, want) {
			t.Errorf("the Team view lacks %q:\n%s", want, got)
		}
	}

	reads := fake.count(fake.postReads, "team-billing")
	posts = append(posts, &operatorv1.WorkstreamPost{Id: "p2", TeamId: "team-billing", AuthorTagId: "tag-lead", Body: "Merging \x1b[2Jit.", Sequence: 2})
	next, cmd := m.Update(watchMsg{update: client.WatchUpdate{Kind: client.WatchChanged, Change: &operatorv1.WatchChange{
		Kind: operatorv1.WatchKind_WATCH_KIND_WORKSTREAM_POST, Id: "p2", TeamId: "team-billing"}}, updates: closedUpdates()})
	m = run(t, next.(model), cmd)
	if fake.count(fake.postReads, "team-billing") != reads+1 || !strings.Contains(screen(m), "Merging  [2Jit.") {
		t.Fatalf("a post did not reread the Workstream:\n%s", screen(m))
	}
	if strings.Contains(m.View().Content, "\x1b[2J") {
		t.Error("a post reached the terminal unfiltered")
	}

	next, cmd = m.Update(watchMsg{update: client.WatchUpdate{Kind: client.WatchChanged, Change: &operatorv1.WatchChange{
		Kind: operatorv1.WatchKind_WATCH_KIND_WORKSTREAM_POST, Id: "p9", TeamId: "team-open"}}, updates: closedUpdates()})
	m = run(t, next.(model), cmd)
	if fake.count(fake.postReads, "team-open") != 0 {
		t.Fatal("a post to a Team not shown must not reread it")
	}

	m = moveTo(t, m, "open")
	if got := screen(m); !strings.Contains(got, "Turns: limited only by Worker Host capacity") || !strings.Contains(got, "No posts yet.") {
		t.Fatalf("the open Team:\n%s", got)
	}
}
