package main

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	"github.com/charmbracelet/x/ansi"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

func int32p(n int32) *int32 { return &n }
func int64p(n int64) *int64 { return &n }

// billingOverview is the overview of obj-billing: a Team of two, one delivered work Session with
// a report, one running, and a Workstream post.
func billingOverview() *operatorv1.ObjectiveOverview {
	o := budgeted(objective("obj-billing", "Billing rejects bad discounts\nwith tests", operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_WORKING), 4123, 30000)
	o.TeamId = "team-billing"
	return &operatorv1.ObjectiveOverview{
		Objective:  o,
		TagNames:   map[string]string{"tag-lead": "lead", "tag-builder": "builder"},
		Team:       &operatorv1.ObjectiveTeam{Id: "team-billing", Name: "billing", MemberTagIds: []string{"tag-lead", "tag-builder"}, MaxConcurrency: int32p(2)},
		Conditions: []*operatorv1.ObjectiveCondition{{Type: "Runnable", Status: true}},
		Budget:     &operatorv1.ObjectiveBudgetUse{Currency: "USD", LimitMinor: int64p(30000), SpentMinor: int64p(4123), UnpricedModels: map[string]int32{"m": 2}},
		Approvals:  &operatorv1.ApprovalCounts{Pending: 1},
		Sessions: []*operatorv1.ObjectiveSession{
			{Id: "ses-own", TagId: "tag-lead", Owner: true, LatestTask: &operatorv1.ObjectiveSessionTask{Id: "task-own",
				Status: operatorv1.ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_WAITING}},
			{Id: "ses-fix", TagId: "tag-builder", Title: "Validate apply_discount", LatestTask: &operatorv1.ObjectiveSessionTask{Id: "task-fix",
				Status: operatorv1.ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_COMPLETED, Report: "Percentages over 100 now raise.",
				Delivery: &operatorv1.TaskDelivery{Workspace: &operatorv1.WorkspaceDelivery{Name: "app", Branch: "supertag/session/b3861d05", Head: "abc", ChangedFiles: int32p(2)}}}},
			{Id: "ses-docs", TagId: "tag-builder", Title: "Document it", LatestTask: &operatorv1.ObjectiveSessionTask{Id: "task-docs",
				Status:       operatorv1.ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_PENDING,
				Explanations: []*operatorv1.TaskExplanation{{Kind: operatorv1.TaskExplanationKind_TASK_EXPLANATION_KIND_WORKER_REQUIREMENTS, Message: "No connected Worker can run it."}}}},
		},
		Posts: []*operatorv1.WorkstreamPost{{Id: "p1", TeamId: "team-billing", AuthorTagId: "tag-builder", ToTagIds: []string{"tag-lead"}, Body: "Fix is on the branch.\nDetails follow."}},
	}
}

// coordinationFake serves one open Objective with a budget, one blocked, one completed, and an
// inbox of a question, an approval request and an item another Tag decides. Deciding or answering
// an item removes it.
func coordinationFake() *fakeControlPlane {
	var mu sync.Mutex
	items := []*operatorv1.InboxItem{
		questionItem("obj-billing", "task-own", "Should 100% stay allowed?"),
		approvalItem("obj-billing", "apr-1", "Push supertag/session/b3861d05 to origin"),
		{Key: "question:task-x", Occurrence: "question:task-x:1", Kind: operatorv1.InboxItemKind_INBOX_ITEM_KIND_QUESTION, OperatorEligible: false},
	}
	remove := func(key string) {
		mu.Lock()
		defer mu.Unlock()
		for i, item := range items {
			if item.GetKey() == key {
				items = append(items[:i], items[i+1:]...)
				return
			}
		}
	}
	return &fakeControlPlane{
		tags: tags("lead", "builder"),
		objectives: func() []*operatorv1.Objective {
			return []*operatorv1.Objective{
				billingOverview().GetObjective(),
				objective("obj-invites", "Invites expire", operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_BLOCKED),
				objective("obj-done", "Old work", operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_COMPLETED),
			}
		},
		overview: func(id string) *operatorv1.ObjectiveOverview {
			if id == "obj-billing" {
				return billingOverview()
			}
			return nil
		},
		items: func() []*operatorv1.InboxItem {
			mu.Lock()
			defer mu.Unlock()
			return append([]*operatorv1.InboxItem(nil), items...)
		},
		approve: func(req *operatorv1.ApproveRequest) error { remove("approval:" + req.GetId()); return nil },
		deny:    func(req *operatorv1.DenyRequest) error { remove("approval:" + req.GetId()); return nil },
		answer:  func(req *operatorv1.AnswerQuestionRequest) error { remove(req.GetKey()); return nil },
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

func TestTheRailListsOpenObjectivesAndWhatWaitsOnYou(t *testing.T) {
	m := startAll(t, testModel(t, coordinationFake()))
	rail := ansi.Strip(m.renderRail(28))
	at := 0
	for _, want := range []string{"Tags", "lead", "builder", "Objectives", "Billing r… $41.23/$300", "Invites expire blocked",
		"Waiting on you (2)", "? Billing rejects bad", "! Push supertag/sess"} {
		i := strings.Index(rail[at:], want)
		if i < 0 {
			t.Fatalf("rail lacks %q after position %d:\n%s", want, at, rail)
		}
		at += i + len(want)
	}
	if strings.Contains(rail, "Old work") {
		t.Fatalf("a completed Objective is listed:\n%s", rail)
	}
	if len(m.rows()) != 6 {
		t.Fatalf("rows = %d, want 2 Tags, 2 Objectives and 2 inbox items", len(m.rows()))
	}
}

func TestSelectingAnObjectiveShowsItLive(t *testing.T) {
	fake := coordinationFake()
	m := startAll(t, testModel(t, fake))
	m = update(t, m, tea.WindowSizeMsg{Width: 140, Height: 60})
	m = moveTo(t, m, "Billing")
	if m.pane != paneObjective || fake.descriptions("obj-billing") != 1 {
		t.Fatalf("pane = %v, descriptions = %d", m.pane, fake.descriptions("obj-billing"))
	}
	got := screen(m)
	for _, want := range []string{
		"Objective · Billing rejects bad discounts",
		"Objective obj-billing: working",
		"Owner: lead",
		"Team: billing (lead, builder)",
		"Runnable: yes",
		"Budget: $41.23 of $300.00 spent; 2 Task Attempts unpriced, so the budget cannot count them",
		"Validate apply_discount (builder, Task task-fix)",
		"Branch supertag/session/b3861d05 in Workspace app, 2 changed files",
		`lead asks: "Should 100% stay allowed?"`,
		"supertag approve request apr-1",
		"Work: 3 Sessions",
		"waiting    lead     Objective conversation  (Task task-own)",
		"completed  builder  Validate apply_discount  (Task task-fix)",
		"Report: Percentages over 100 now raise.",
		"No connected Worker can run it.",
		"builder to lead: Fix is on the branch.",
		"Team billing: at most 2 turns at once across its Objectives",
		"m message the owner · answer questions under Waiting on you",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("screen lacks %q", want)
		}
	}
	if t.Failed() {
		t.Log(got)
	}

	changed := func(m model, change *operatorv1.WatchChange) model {
		closed := make(chan client.WatchUpdate)
		close(closed)
		next, cmd := m.Update(watchMsg{update: client.WatchUpdate{Kind: client.WatchChanged, Change: change}, updates: closed})
		return run(t, next.(model), cmd)
	}
	m = changed(m, &operatorv1.WatchChange{Kind: operatorv1.WatchKind_WATCH_KIND_TASK, Id: "t", ObjectiveId: "obj-billing"})
	m = changed(m, &operatorv1.WatchChange{Kind: operatorv1.WatchKind_WATCH_KIND_WORKSTREAM_POST, Id: "p2", TeamId: "team-billing"})
	m = changed(m, &operatorv1.WatchChange{Kind: operatorv1.WatchKind_WATCH_KIND_TASK, Id: "t", ObjectiveId: "obj-other"})
	m = changed(m, &operatorv1.WatchChange{Kind: operatorv1.WatchKind_WATCH_KIND_WORKSTREAM_POST, Id: "p3", TeamId: "team-other"})
	m = changed(m, &operatorv1.WatchChange{Kind: operatorv1.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE, Tag: "lead"})
	if n := fake.descriptions("obj-billing"); n != 3 {
		t.Fatalf("descriptions = %d, want a reread for its Task and its Team's post only", n)
	}

	m = moveTo(t, m, "Invites")
	if got := screen(m); !strings.Contains(got, "Could not read the Objective: Objective obj-invites was not found") {
		t.Fatalf("screen:\n%s", got)
	}
	m = press(t, m, key(tea.KeyUp))
	m = press(t, m, key(tea.KeyUp))
	if m.pane != paneConversation || !strings.Contains(screen(m), "builder · default") {
		t.Fatalf("moving back up should show a conversation:\n%s", screen(m))
	}
}

func TestAnsweringAQuestionInPlace(t *testing.T) {
	fake := coordinationFake()
	m := startAll(t, testModel(t, fake))
	m = update(t, m, tea.WindowSizeMsg{Width: 120, Height: 40})
	m = moveTo(t, m, "? ")
	got := screen(m)
	for _, want := range []string{"Waiting on you · question", "Objective obj-billing waits on your answer", "The owner asks:",
		"Should 100% stay allowed?", "Type your answer"} {
		if !strings.Contains(got, want) {
			t.Errorf("screen lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "supertag message objective") {
		t.Fatalf("the question offers an outdated message command:\n%s", got)
	}
	m = press(t, m, key(tea.KeyRight))
	m.input.SetValue("No, cap it at 100.")
	m = press(t, m, key(tea.KeyEnter))
	if len(fake.answered) != 1 || fake.answered[0].GetKey() != "question:task-own" || fake.answered[0].GetText() != "No, cap it at 100." ||
		fake.answered[0].GetIdempotencyKey() == "" {
		t.Fatalf("answered = %v", fake.answered)
	}
	got = screen(m)
	if !strings.Contains(got, "Sent. lead takes your answer as its next turn.") || !strings.Contains(got, "Waiting on you (1)") ||
		!strings.Contains(got, "This item is settled.") || m.inputShown() {
		t.Fatalf("after answering:\n%s", got)
	}
}

func TestObjectiveFollowUpStaysInTheObjective(t *testing.T) {
	fake := coordinationFake()
	fake.messageObjective = func(req *operatorv1.MessageObjectiveRequest) (*operatorv1.MessageObjectiveResponse, error) {
		if req.GetId() != "obj-billing" || req.GetText() != "Cap percentages at 100." || req.GetIdempotencyKey() == "" {
			t.Errorf("message request = %v", req)
		}
		return &operatorv1.MessageObjectiveResponse{Tag: "lead", TaskId: "task-follow-up"}, nil
	}
	fake.getMessage = func(req *operatorv1.GetMessageRequest) (*operatorv1.Message, error) {
		if req.GetTag() != "lead" || req.GetTaskId() != "task-follow-up" {
			t.Errorf("reply request = %v", req)
		}
		return &operatorv1.Message{TaskId: req.GetTaskId(), Tag: req.GetTag(), Conversation: "objective:obj-billing"}, nil
	}
	fake.follow = func(_ context.Context, req *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
		if req.GetTag() != "lead" || req.GetTaskId() != "task-follow-up" {
			t.Errorf("follow request = %v", req)
		}
		return stream.Send(followEvent(1, &operatorv1.Finish{Reply: finalReply("I will cap percentages.")}))
	}
	m := startAll(t, testModel(t, fake))
	m = moveTo(t, m, "Billing rejects")
	m = press(t, m, letter('m'))
	m.input.SetValue("Cap percentages at 100.")
	m = press(t, m, key(tea.KeyEscape), letter('m'))
	if !m.inputShown() || m.input.Value() != "Cap percentages at 100." {
		t.Fatal("esc should close the composer and keep its draft")
	}
	m = press(t, m, key(tea.KeyEnter))
	got := screen(m)
	for _, want := range []string{"Your follow-up", "Follow-up sent.", "lead replied", "I will cap percentages."} {
		if !strings.Contains(got, want) {
			t.Errorf("screen lacks %q:\n%s", want, got)
		}
	}
	if len(fake.sent) != 0 || len(m.conversation("lead", "default").entries) != 0 || m.inputShown() {
		t.Fatalf("the follow-up must stay out of the normal Tag conversation:\n%s", got)
	}
}

func TestObjectiveFollowUpKeepsTheDraftAndExplainsAnExternalReply(t *testing.T) {
	fake := coordinationFake()
	refuse := true
	fake.messageObjective = func(req *operatorv1.MessageObjectiveRequest) (*operatorv1.MessageObjectiveResponse, error) {
		if req.GetText() != "Try a smaller change." {
			t.Errorf("message text = %q", req.GetText())
		}
		if refuse {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("Message refused"))
		}
		return &operatorv1.MessageObjectiveResponse{Tag: "lead", TaskId: "task-external"}, nil
	}
	fake.getMessage = func(*operatorv1.GetMessageRequest) (*operatorv1.Message, error) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("No reply in this conversation"))
	}
	m := startAll(t, testModel(t, fake))
	m = moveTo(t, m, "Billing rejects")
	m = press(t, m, letter('m'))
	m.input.SetValue("Try a smaller change.")
	m = press(t, m, key(tea.KeyEnter))
	if got := screen(m); !strings.Contains(got, "Could not send your follow-up. Message refused") {
		t.Fatalf("a refused send must explain why:\n%s", got)
	}
	m = press(t, m, letter('m'))
	if m.input.Value() != "Try a smaller change." {
		t.Fatalf("the draft was lost: %q", m.input.Value())
	}
	m = press(t, m, key(tea.KeyTab), key(tea.KeyDown), letter('m'))
	if m.objectiveID != "obj-invites" || !m.inputShown() || m.input.Value() != "" {
		t.Fatalf("the draft crossed into another Objective:\n%s", screen(m))
	}
	m = press(t, m, key(tea.KeyEscape), key(tea.KeyTab), key(tea.KeyUp), letter('m'))
	if m.objectiveID != "obj-billing" || m.input.Value() != "Try a smaller change." {
		t.Fatalf("returning to the Objective lost its draft: %q", m.input.Value())
	}
	refuse = false
	m = press(t, m, key(tea.KeyEnter))
	if got := screen(m); !strings.Contains(got, "Follow-up sent.") ||
		!strings.Contains(got, "The reply posts to the thread the Objective was created in.") {
		t.Fatalf("the accepted message must explain where to read the reply:\n%s", got)
	}
}

func TestClosingAnObjectiveEndsItsComposer(t *testing.T) {
	m := startAll(t, testModel(t, coordinationFake()))
	m = moveTo(t, m, "Billing rejects")
	m = press(t, m, letter('m'))
	m.input.SetValue("One more change.")
	closed := billingOverview()
	closed.Objective.Status = operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_COMPLETED
	m = update(t, m, overviewMsg{id: "obj-billing", overview: closed})
	m = press(t, m, letter('m'), key(tea.KeyEnter))
	if m.inputShown() || m.drafts[objectivePaneKey("obj-billing")] != "One more change." {
		t.Fatalf("the composer remained open after closure or lost the draft:\n%s", screen(m))
	}
}

func TestApprovingAndDenyingInPlace(t *testing.T) {
	fake := coordinationFake()
	m := startAll(t, testModel(t, fake))
	m = update(t, m, tea.WindowSizeMsg{Width: 120, Height: 40})
	m = moveTo(t, m, "! ")
	got := screen(m)
	for _, want := range []string{"Waiting on you · approval", "Approval apr-1 (work is waiting): Push supertag/session/b3861d05 to origin (requested by Tag",
		"Requested by: builder", "A running Task Attempt waits on the decision.", "a approve · d deny"} {
		if !strings.Contains(got, want) {
			t.Errorf("screen lacks %q:\n%s", want, got)
		}
	}
	m = press(t, m, letter('a'))
	if !strings.Contains(screen(m), "enter approves this request once · esc cancels") || len(fake.approved) != 0 {
		t.Fatalf("a should ask to confirm:\n%s", screen(m))
	}
	m = press(t, m, key(tea.KeyEscape))
	if m.decision != decisionNone || !strings.Contains(screen(m), "a approve · d deny") {
		t.Fatal("esc should cancel approving, not quit")
	}
	m = press(t, m, letter('a'))
	m = press(t, m, key(tea.KeyEnter))
	if len(fake.approved) != 1 || fake.approved[0].GetId() != "apr-1" || fake.approved[0].GetScope() != operatorv1.ApprovalScope_APPROVAL_SCOPE_ONCE {
		t.Fatalf("approved = %v", fake.approved)
	}
	if got := screen(m); !strings.Contains(got, "Approved once. The waiting Session continues.") || !strings.Contains(got, "Waiting on you (1)") {
		t.Fatalf("after approving:\n%s", got)
	}
}

func TestDenyingTakesAReasonAndKeepsItOnFailure(t *testing.T) {
	fake := coordinationFake()
	fails, deny := true, fake.deny
	fake.deny = func(req *operatorv1.DenyRequest) error {
		if fails {
			return connect.NewError(connect.CodeUnavailable, errors.New("The Control Plane is draining."))
		}
		return deny(req)
	}
	m := startAll(t, testModel(t, fake))
	m = update(t, m, tea.WindowSizeMsg{Width: 120, Height: 40})
	m = moveTo(t, m, "! ")
	m = press(t, m, letter('d'))
	if m.focus != focusInput || !m.inputShown() || !strings.Contains(screen(m), "Why deny it?") {
		t.Fatalf("d should ask for a reason:\n%s", screen(m))
	}
	m = press(t, m, key(tea.KeyEnter))
	if len(fake.denied) != 0 {
		t.Fatal("an empty reason must not deny")
	}
	m.input.SetValue("Push to a fork")
	m = press(t, m, key(tea.KeyEnter))
	if len(fake.denied) != 1 || fake.denied[0].GetId() != "apr-1" || fake.denied[0].GetReason() != "Push to a fork" {
		t.Fatalf("denied = %v", fake.denied)
	}
	if !strings.Contains(screen(m), "The Control Plane is draining.") || m.input.Value() != "Push to a fork" || m.decision != decisionReason {
		t.Fatalf("a failed deny should keep the reason:\n%s", screen(m))
	}
	fails = false
	m = press(t, m, key(tea.KeyEnter))
	if got := screen(m); len(fake.denied) != 2 || !strings.Contains(got, "Denied. The Session that asked continues with your reason.") ||
		!strings.Contains(got, "Waiting on you (1)") {
		t.Fatalf("after denying:\n%s", got)
	}
}

func TestObjectiveAndInboxTextIsFilteredForTheTerminal(t *testing.T) {
	fake := coordinationFake()
	evil := "\x1b]0;owned\x07\x1b[8m"
	fake.objectives = func() []*operatorv1.Objective {
		return []*operatorv1.Objective{objective("obj-billing", "Billing"+evil, operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_WORKING)}
	}
	fake.overview = func(string) *operatorv1.ObjectiveOverview {
		view := billingOverview()
		view.Objective.Outcome += evil
		view.Objective.CompletionSummary = "done" + evil
		view.TagNames["tag-builder"] = "builder" + evil
		view.Sessions[1].LatestTask.Report = "report" + evil
		view.Posts[0].Body = "post" + evil
		view.Attention = []*operatorv1.ObjectiveAttention{{Kind: operatorv1.ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_DEADLINE_APPROACHING, Message: "soon" + evil, NextAction: "act" + evil}}
		return view
	}
	fake.items = func() []*operatorv1.InboxItem {
		return []*operatorv1.InboxItem{questionItem("obj-billing", "task-own", "Why?"+evil+"\nReally?"), approvalItem("obj-billing", "apr-1", "Push"+evil)}
	}
	m := startAll(t, testModel(t, fake))
	views := []string{m.View().Content}
	for _, label := range []string{"Billing", "? ", "! "} {
		m = moveTo(t, m, label)
		views = append(views, m.View().Content)
	}
	for _, view := range views {
		for _, raw := range []string{"\x1b]", "\x07", "\x1b[8m"} {
			if strings.Contains(view, raw) {
				t.Errorf("view carries %q from the server:\n%s", raw, ansi.Strip(view))
			}
		}
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

// An item settled elsewhere leaves the inbox; the pane follows the cursor to the item that took
// its place instead of keeping the removed one, and to the clamped row once the inbox is empty.
func TestASettledItemHandsThePaneToTheNowSelectedItem(t *testing.T) {
	fake := coordinationFake()
	all := fake.items
	gone := map[string]bool{}
	fake.items = func() []*operatorv1.InboxItem {
		var kept []*operatorv1.InboxItem
		for _, item := range all() {
			if !gone[item.GetKey()] {
				kept = append(kept, item)
			}
		}
		return kept
	}
	m := startAll(t, testModel(t, fake))
	m = update(t, m, tea.WindowSizeMsg{Width: 120, Height: 40})
	m = moveTo(t, m, "? ")
	gone["question:task-own"] = true
	m = run(t, m, m.reloadInbox())
	if m.pane != paneInbox || m.item.GetKey() != "approval:apr-1" {
		t.Fatalf("pane shows %v %q, want the approval that took the question's place", m.pane, m.item.GetKey())
	}
	if r := m.rows()[m.cursor]; r.kind != rowInbox || m.inbox.Items[r.index].GetKey() != "approval:apr-1" {
		t.Fatalf("cursor is on %v, not the shown approval", r)
	}
	got := screen(m)
	if strings.Contains(got, "Should 100% stay allowed?") || strings.Contains(got, "This item is settled") ||
		!strings.Contains(got, "Push supertag/session/b3861d05 to origin") || !strings.Contains(got, "a approve · d deny") {
		t.Fatalf("after the question left:\n%s", got)
	}
	gone["approval:apr-1"] = true
	m = run(t, m, m.reloadInbox())
	if m.pane == paneInbox {
		t.Fatalf("pane still shows the removed %q", m.item.GetKey())
	}
	if want := m.rowKey(m.rows()[m.cursor]); want != m.paneKey() {
		t.Fatalf("pane %q and cursor %q disagree", m.paneKey(), want)
	}
}

// An approval a running Task Attempt waits on reads differently from a question whose Session
// finished its turn, and from an approval nothing waits on.
func TestTheInboxTellsABlockingApprovalFromAFinishedTurn(t *testing.T) {
	fake := coordinationFake()
	all := fake.items
	fake.items = func() []*operatorv1.InboxItem {
		idle := approvalItem("obj-billing", "apr-2", "Open a pull request")
		idle.Approval.Blocking = false
		return append(all(), idle)
	}
	m := startAll(t, testModel(t, fake))
	m = update(t, m, tea.WindowSizeMsg{Width: 120, Height: 40})
	for _, c := range []struct{ row, title, line, not string }{
		{"? ", "Waiting on you · question · turn finished", "The owner's Task finished its turn; its Session waits for your answer", "blocking"},
		{"! Push", "Waiting on you · approval · blocking", "A running Task Attempt waits on the decision.", "turn finished"},
		{"! Open", "Waiting on you · approval · not blocking", "No running Task Attempt waits on the decision.", "A running Task Attempt waits"},
	} {
		m = moveTo(t, m, c.row)
		got := screen(m)
		if !strings.Contains(got, c.title) || !strings.Contains(got, c.line) || strings.Contains(got, c.not) {
			t.Errorf("%s: want %q and %q without %q:\n%s", c.row, c.title, c.line, c.not, got)
		}
	}
}

// A failed decision leaves an error note on the item; when the item is then settled elsewhere and
// leaves the inbox, that stale note must not keep the pane on it: the pane follows the selection.
func TestAFailedActionNoteDoesNotStopThePaneFollowing(t *testing.T) {
	fake := coordinationFake()
	all := fake.items
	gone := map[string]bool{}
	fake.items = func() []*operatorv1.InboxItem {
		var kept []*operatorv1.InboxItem
		for _, item := range all() {
			if !gone[item.GetKey()] {
				kept = append(kept, item)
			}
		}
		return kept
	}
	fake.approve = func(*operatorv1.ApproveRequest) error {
		return connect.NewError(connect.CodeUnavailable, errors.New("The Control Plane is draining."))
	}
	m := startAll(t, testModel(t, fake))
	m = update(t, m, tea.WindowSizeMsg{Width: 120, Height: 40})
	m = moveTo(t, m, "! ")
	m = press(t, m, letter('a'))
	m = press(t, m, key(tea.KeyEnter))
	if !m.itemNote.err || !strings.Contains(screen(m), "The Control Plane is draining.") {
		t.Fatalf("a failed approve should leave an error note:\n%s", screen(m))
	}
	gone["approval:apr-1"] = true
	m = run(t, m, m.reloadInbox())
	if m.pane == paneInbox && m.item.GetKey() == "approval:apr-1" {
		t.Fatalf("pane stayed on the removed approval:\n%s", screen(m))
	}
	if want := m.rowKey(m.rows()[m.cursor]); want != m.paneKey() {
		t.Fatalf("pane %q and cursor %q disagree", m.paneKey(), want)
	}
	if got := screen(m); strings.Contains(got, "The Control Plane is draining.") || strings.Contains(got, "This item is settled") {
		t.Fatalf("stale note shown after following:\n%s", got)
	}
}
