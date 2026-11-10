package main

import (
	"slices"
	"strings"
	"sync"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// teamStore is the fake's Teams, which a test edits between steps.
type teamStore struct {
	mu    sync.Mutex
	teams []*operatorv1.Team
}

func (s *teamStore) list() []*operatorv1.Team {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.teams)
}

func (s *teamStore) set(teams ...*operatorv1.Team) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.teams = teams
}

func openTeam() *operatorv1.Team { return &operatorv1.Team{Id: "team-open", Name: "open", Revision: 1} }

func teamChange(id string) client.WatchUpdate {
	return client.WatchUpdate{Kind: client.WatchChanged, Change: &operatorv1.WatchChange{
		Kind: operatorv1.WatchKind_WATCH_KIND_TEAM, Id: id, TeamId: id}}
}

func watched(t *testing.T, m model, update client.WatchUpdate) model {
	t.Helper()
	next, cmd := m.Update(watchMsg{update: update, updates: closedUpdates()})
	return run(t, next.(model), cmd)
}

// teamsShown starts a model with billing and open listed and billing shown.
func teamsShown(t *testing.T) (*fakeControlPlane, *teamStore, model) {
	t.Helper()
	store := &teamStore{}
	store.set(billingTeam(), openTeam())
	fake := &fakeControlPlane{tags: tags("lead", "builder"), teamList: store.list}
	m := testModel(t, fake)
	m = run(t, m, tea.Batch(m.reloadTags(), m.reloadTeams()))
	m = moveTo(t, m, "billing")
	if !strings.Contains(screen(m), "Revision: 4") {
		t.Fatalf("billing is not shown:\n%s", screen(m))
	}
	return fake, store, m
}

func (f *fakeControlPlane) teamReadCounts() (list int, gets map[string]int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.teamListReads, copyCounts(f.teamGets)
}

func copyCounts(in map[string]int) map[string]int {
	out := make(map[string]int, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func TestTheTUIWatchesTeamChanges(t *testing.T) {
	if !slices.Contains(watchKinds, operatorv1.WatchKind_WATCH_KIND_TEAM) {
		t.Fatal("the TUI does not watch Team changes")
	}
}

func TestACreatedTeamJoinsTheListWithoutRereadingTheShownTeam(t *testing.T) {
	fake, store, m := teamsShown(t)
	list, gets := fake.teamReadCounts()
	store.set(billingTeam(), openTeam(), &operatorv1.Team{Id: "team-new", Name: "new", Revision: 1})
	m = watched(t, m, teamChange("team-new"))
	afterList, afterGets := fake.teamReadCounts()
	if afterList != list+1 {
		t.Fatalf("ListTeams reads = %d, want %d", afterList, list+1)
	}
	if afterGets["team-billing"] != gets["team-billing"] || afterGets["team-new"] != 0 {
		t.Fatalf("a Team not shown was read: %v", afterGets)
	}
	if rail := ansi.Strip(m.renderRail(20)); !strings.Contains(rail, "new 0 members") {
		t.Fatalf("the created Team is not listed:\n%s", rail)
	}
}

func TestAnUpdatedShownTeamRereadsItsDetails(t *testing.T) {
	fake, store, m := teamsShown(t)
	_, gets := fake.teamReadCounts()
	changed := billingTeam()
	changed.Name, changed.Revision, changed.MaxConcurrency = "payments", 5, nil
	changed.Members = []*operatorv1.TeamMember{{TagId: "tag-lead", Tag: "lead"}}
	store.set(changed, openTeam())
	m = watched(t, m, teamChange("team-billing"))
	_, after := fake.teamReadCounts()
	if after["team-billing"] != gets["team-billing"]+1 {
		t.Fatalf("GetTeam(team-billing) = %d, want %d", after["team-billing"], gets["team-billing"]+1)
	}
	got := screen(m)
	for _, want := range []string{"Team payments (team-billing)", "Members: lead", "Revision: 5", "limited only by Worker Host capacity"} {
		if !strings.Contains(got, want) {
			t.Errorf("the updated Team lacks %q:\n%s", want, got)
		}
	}
	if rail := ansi.Strip(m.renderRail(20)); !strings.Contains(rail, "payments 1 member") {
		t.Fatalf("the rail lacks the renamed Team:\n%s", rail)
	}
}

func TestAChangeToAnotherTeamRereadsOnlyTheList(t *testing.T) {
	fake, store, m := teamsShown(t)
	list, gets := fake.teamReadCounts()
	open := openTeam()
	open.Members, open.Revision = []*operatorv1.TeamMember{{TagId: "tag-lead", Tag: "lead"}}, 2
	store.set(billingTeam(), open)
	m = watched(t, m, teamChange("team-open"))
	afterList, after := fake.teamReadCounts()
	if afterList != list+1 || after["team-billing"] != gets["team-billing"] || after["team-open"] != 0 {
		t.Fatalf("list %d→%d, gets %v→%v", list, afterList, gets, after)
	}
	if rail := ansi.Strip(m.renderRail(20)); !strings.Contains(rail, "open 1 member") {
		t.Fatalf("the membership change is not listed:\n%s", rail)
	}
}

func TestADeletedShownTeamSaysSo(t *testing.T) {
	_, store, m := teamsShown(t)
	store.set(openTeam())
	m = watched(t, m, teamChange("team-billing"))
	got := screen(m)
	if !strings.Contains(got, "Team · billing") || !strings.Contains(got, "Team billing was deleted.") || strings.Contains(got, "Revision: 4") {
		t.Fatalf("the deleted Team:\n%s", got)
	}
	if rail := ansi.Strip(m.renderRail(20)); strings.Contains(rail, "billing") {
		t.Fatalf("the deleted Team is still listed:\n%s", rail)
	}
	// Another change, or a resync, keeps the pane stable rather than reading forever.
	m = watched(t, m, teamChange("team-billing"))
	m = watched(t, m, client.WatchUpdate{Kind: client.WatchResync})
	if got := screen(m); !strings.Contains(got, "Team billing was deleted.") {
		t.Fatalf("after another change:\n%s", got)
	}
	m = press(t, press(t, m, key(tea.KeyUp)), key(tea.KeyDown))
	if got := screen(m); !strings.Contains(got, "Team open (team-open)") {
		t.Fatalf("moving on from a deleted Team:\n%s", got)
	}
}

func TestLeavingTheTeamPaneDoesNotStallQueuedRefresh(t *testing.T) {
	_, store, m := teamsShown(t)
	inFlight := m.reloadTeam()
	m = watched(t, m, teamChange("team-billing"))
	m = press(t, m, key(tea.KeyUp))
	if m.pane == paneTeam {
		t.Fatal("the test did not leave the Team pane")
	}
	m = run(t, m, inFlight)

	changed := billingTeam()
	changed.Revision = 5
	store.set(changed, openTeam())
	m = press(t, m, key(tea.KeyDown))
	if got := screen(m); !strings.Contains(got, "Revision: 5") {
		t.Fatalf("the reopened Team did not refresh:\n%s", got)
	}
}

func TestDeletionRejectsLateDetailsAndNameFallback(t *testing.T) {
	_, store, m := teamsShown(t)
	stale := m.reloadTeam()()
	alias := &operatorv1.Team{Id: "team-alias", Name: "team-billing", Revision: 99}
	store.set(openTeam(), alias)
	m = watched(t, m, teamChange("team-billing"))

	next, pending := m.Update(stale)
	m = next.(model)
	if got := screen(m); !strings.Contains(got, "Team billing was deleted.") {
		t.Fatalf("a late read restored the deleted Team:\n%s", got)
	}
	m = run(t, m, pending)
	if got := screen(m); !strings.Contains(got, "Team billing was deleted.") || strings.Contains(got, "Revision: 99") {
		t.Fatalf("the detail pane showed a different Team with the same name:\n%s", got)
	}
}

func TestTeamChangesReadOnlyWhatTheCallerMayRead(t *testing.T) {
	fake, store, m := teamsShown(t)
	_, gets := fake.teamReadCounts()
	// The Control Plane lists only the Teams the caller may read; a change naming another Team,
	// such as one sent before access narrowed, rereads the list but never reads that Team.
	store.set(billingTeam(), openTeam())
	m = watched(t, m, teamChange("team-secret"))
	m = watched(t, m, client.WatchUpdate{Kind: client.WatchChanged, Change: &operatorv1.WatchChange{Kind: operatorv1.WatchKind_WATCH_KIND_TEAM}})
	_, after := fake.teamReadCounts()
	if after["team-secret"] != 0 || after["team-billing"] != gets["team-billing"] {
		t.Fatalf("GetTeam reads: %v", after)
	}
	if strings.Contains(screen(m), "secret") {
		t.Fatalf("a Team outside the caller's view reached the screen:\n%s", screen(m))
	}
}

func TestReconnectingRereadsTheTeams(t *testing.T) {
	fake, store, m := teamsShown(t)
	m = watched(t, m, client.WatchUpdate{Kind: client.WatchLive})
	next, _ := m.Update(watchMsg{update: client.WatchUpdate{Kind: client.WatchLost}, updates: closedUpdates()})
	m = next.(model)
	// Edits made while the stream was down arrive with no change notice.
	changed := billingTeam()
	changed.Revision, changed.Members = 7, []*operatorv1.TeamMember{{TagId: "tag-builder", Tag: "builder"}}
	store.set(changed, &operatorv1.Team{Id: "team-new", Name: "new", Revision: 1})
	list, gets := fake.teamReadCounts()
	for _, kind := range []client.WatchUpdateKind{client.WatchLive, client.WatchResync} {
		m = watched(t, m, client.WatchUpdate{Kind: kind})
	}
	afterList, after := fake.teamReadCounts()
	if afterList < list+1 || after["team-billing"] < gets["team-billing"]+1 {
		t.Fatalf("reconnecting did not reread the Teams: list %d→%d, gets %v→%v", list, afterList, gets, after)
	}
	if got := screen(m); !strings.Contains(got, "Revision: 7") || !strings.Contains(got, "Members: builder") {
		t.Fatalf("the edit made while disconnected is missing:\n%s", got)
	}
	if rail := ansi.Strip(m.renderRail(20)); !strings.Contains(rail, "new") || strings.Contains(rail, "open") {
		t.Fatalf("the rail after reconnecting:\n%s", rail)
	}
}

func TestAStaleTeamsListIsDropped(t *testing.T) {
	_, store, m := teamsShown(t)
	older := m.teamsCmd()
	msgOld := older()
	store.set(billingTeam(), openTeam(), &operatorv1.Team{Id: "team-new", Name: "new", Revision: 1})
	newer := m.teamsCmd()
	msgNew := newer()
	m = update(t, m, msgNew)
	m = update(t, m, msgOld) // The older call answers last.
	if rail := ansi.Strip(m.renderRail(20)); !strings.Contains(rail, "new 0 members") {
		t.Fatalf("an older list replaced a newer one:\n%s", rail)
	}
}

func TestAStaleTeamReadIsDropped(t *testing.T) {
	_, store, m := teamsShown(t)
	older := m.teamCmd("team-billing")
	msgOld := older()
	changed := billingTeam()
	changed.Revision, changed.Name = 5, "payments"
	store.set(changed, openTeam())
	msgNew := m.teamCmd("team-billing")()
	m = update(t, m, msgNew)
	m = update(t, m, msgOld)
	if got := screen(m); !strings.Contains(got, "Revision: 5") || !strings.Contains(got, "Team payments") {
		t.Fatalf("an older read replaced a newer one:\n%s", got)
	}
	// A read started later that carries an older revision, as from a lagging replica, is dropped too.
	late := billingTeam()
	late.Revision = 3
	m = update(t, m, teamMsg{id: "team-billing", view: client.TeamView{Team: late}, read: m.teamReads.start()})
	if got := screen(m); !strings.Contains(got, "Revision: 5") {
		t.Fatalf("an older revision replaced a newer one:\n%s", got)
	}
}
