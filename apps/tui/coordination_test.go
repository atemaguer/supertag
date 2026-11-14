package main

import (
	"errors"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

func int32p(n int32) *int32 { return &n }
func int64p(n int64) *int64 { return &n }

// billingOverview is the overview of obj-billing: a Team of two, one delivered work Session with
// a report, one running, and a Workstream post.
func billingOverview() *views.ObjectiveOverview {
	o := budgeted(objective("obj-billing", "Billing rejects bad discounts\nwith tests", views.ObjectiveStatus_OBJECTIVE_STATUS_WORKING), 4123, 30000)
	o.TeamId = "team-billing"
	return &views.ObjectiveOverview{
		Objective:  o,
		TagNames:   map[string]string{"tag-lead": "lead", "tag-builder": "builder"},
		Team:       &views.ObjectiveTeam{Id: "team-billing", Name: "billing", MemberTagIds: []string{"tag-lead", "tag-builder"}, MaxConcurrency: int32p(2)},
		Conditions: []*views.ObjectiveCondition{{Type: "Runnable", Status: true}},
		Budget:     &views.ObjectiveBudgetUse{Currency: "USD", LimitMinor: int64p(30000), SpentMinor: int64p(4123), UnpricedModels: map[string]int32{"m": 2}},
		Approvals:  &views.ApprovalCounts{Pending: 1},
		Sessions: []*views.ObjectiveSession{
			{Id: "ses-own", TagId: "tag-lead", Owner: true, LatestTask: &views.ObjectiveSessionTask{Id: "task-own",
				Status: views.ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_WAITING}},
			{Id: "ses-fix", TagId: "tag-builder", Title: "Validate apply_discount", LatestTask: &views.ObjectiveSessionTask{Id: "task-fix",
				Status: views.ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_COMPLETED, Report: "Percentages over 100 now raise.",
				Delivery: &views.TaskDelivery{Workspace: &views.WorkspaceDelivery{Name: "app", Branch: "supertag/session/b3861d05", Head: "abc", ChangedFiles: int32p(2)}}}},
			{Id: "ses-docs", TagId: "tag-builder", Title: "Document it", LatestTask: &views.ObjectiveSessionTask{Id: "task-docs",
				Status:       views.ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_PENDING,
				Explanations: []*views.TaskExplanation{{Kind: views.TaskExplanationKind_TASK_EXPLANATION_KIND_WORKER_REQUIREMENTS, Message: "No connected Worker can run it."}}}},
		},
		Posts: []*views.WorkstreamPost{{Id: "p1", TeamId: "team-billing", AuthorTagId: "tag-builder", ToTagIds: []string{"tag-lead"}, Body: "Fix is on the branch.\nDetails follow."}},
	}
}

// startAll loads the Tags, the Objectives and the inbox, as Init does without the watch stream.
func startAll(t *testing.T, m model) model {
	t.Helper()
	return run(t, m, tea.Batch(m.reloadTags(), m.reloadConversations(), m.reloadObjectives(), m.reloadInbox()))
}

// press feeds keys one by one and runs what each starts.
func press(t *testing.T, m model, keys ...tea.KeyPressMsg) model {
	t.Helper()
	for _, k := range keys {
		next, cmd := m.Update(k)
		m = run(t, next.(model), cmd)
	}
	return m
}

func letter(r rune) tea.KeyPressMsg { return tea.KeyPressMsg{Code: r, Text: string(r)} }

// moveTo focuses the rail and moves the cursor down to the row whose rail text contains label.
func moveTo(t *testing.T, m model, label string) model {
	t.Helper()
	if m.focus != focusRail {
		m = press(t, m, key(tea.KeyTab))
	}
	for range len(m.rows()) {
		r := m.rows()[m.cursor]
		text := ""
		switch r.kind {
		case rowObjective:
			text = objectiveName(m.objectives[r.index])
		case rowInbox:
			text = m.inboxRow(m.inbox.Items[r.index])
		case rowTeam:
			text = m.teams[r.index].GetName()
		default:
			text = tagName(m.tags[r.index])
		}
		if strings.Contains(text, label) {
			return m
		}
		m = press(t, m, key(tea.KeyDown))
	}
	t.Fatalf("no rail row shows %q:\n%s", label, ansi.Strip(m.renderRail(40)))
	return m
}

func TestRuntimeApprovalRequiresDetailsBeforeConfirmation(t *testing.T) {
	m := runtimeModel(t)
	item := approvalItem("release", "apr-1", "Publish a branch")
	m.pane, m.item = paneInbox, item
	m.inbox.Items = []*views.InboxItem{item}
	m.refresh()
	m = press(t, m, letter('a'))
	if m.decision != decisionNone || !strings.Contains(m.renderItem(), "Loading approval details") {
		t.Fatal("a decision was offered before the actual effect was available")
	}
	m = update(t, m, inboxApprovalMsg{occurrence: item.GetOccurrence(), err: errors.New("Unavailable")})
	if m.approvalShown() || m.paneHint() != "r reload approval details" {
		t.Fatal("a failed read should allow reloading details, with the decision disabled")
	}
	details := client.ApprovalDetails{Action: "git:push", Resource: "refs/heads/main",
		Arguments: "{\n  \"force\": false\n}", Pending: true}
	m = update(t, m, inboxApprovalMsg{occurrence: "another-approval", details: details})
	if m.approvalShown() || strings.Contains(m.renderItem(), "refs/heads/main") {
		t.Fatal("approval details crossed into a different Inbox item")
	}
	m = update(t, m, inboxApprovalMsg{occurrence: item.GetOccurrence(), details: details})
	got := ansi.Strip(m.renderItem())
	for _, want := range []string{"Action: git:push", "Resource: refs/heads/main", `"force": false`} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in approval:\n%s", want, got)
		}
	}
	m = press(t, m, letter('a'))
	if m.decision != decisionConfirm || m.paneHint() != "enter approves this request once · esc cancels" {
		t.Fatal("loaded approval should require a once-scope confirmation")
	}
}

func TestMoney(t *testing.T) {
	for _, c := range []struct {
		minor    int64
		currency string
		want     string
	}{
		{4123, "USD", "$41.23"},
		{123456789, "USD", "$1,234,567.89"},
		{-250, "EUR", "-€2.50"},
		{1200, "JPY", "¥1,200"},
		{1234, "KWD", "KWD 1.234"},
		{100, "CHF", "CHF 1.00"},
		{5, "usd\x1b", "5 usd  minor units"},
	} {
		if got := money(c.minor, c.currency); got != c.want {
			t.Errorf("money(%d, %q) = %q, want %q", c.minor, c.currency, got, c.want)
		}
	}
	if got := shortMoney(30000, "USD"); got != "$300" {
		t.Errorf("shortMoney = %q", got)
	}
	if got := shortMoney(4120, "USD"); got != "$41.20" {
		t.Errorf("shortMoney = %q", got)
	}
}
