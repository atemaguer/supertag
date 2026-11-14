package main

import (
	"testing"
	"time"

	"github.com/atemaguer/supertag/apps/tui/views"
)

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return at
}

func billingTeam() *views.Team {
	return &views.Team{Id: "team-billing", Name: "billing", MaxConcurrency: int32p(2), Revision: 4,
		Members: []*views.TeamMember{{TagId: "tag-lead", Tag: "lead"}, {TagId: "tag-builder", Tag: "builder"}, {TagId: "tag-gone"}}}
}
