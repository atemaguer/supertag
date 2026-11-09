package main

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// postsShown is how many of the newest Workstream posts the Objective view shows.
const postsShown = 5

// objectiveName is how the rail names an Objective: the first line of its outcome.
func objectiveName(objective *operatorv1.Objective) string {
	return terminalText(firstLine(objective.GetOutcome()))
}

// objectiveState is what the rail shows beside an open Objective: why it is held, else its spend
// against a budget in a currency, else that it is working.
func objectiveState(objective *operatorv1.Objective) string {
	switch {
	case objective.GetPausedAt() != nil:
		return "paused"
	case objective.GetStatus() == operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_BLOCKED:
		return "blocked"
	case objective.GetStatus() == operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_LIMITED:
		return "limited"
	case objective.GetStatus() == operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_READY_FOR_REVIEW:
		return "review"
	}
	if budget := objective.GetBudget(); budget != nil && budget.GetCurrency() != "" {
		spent := objective.GetSpend().GetAmountMinor()
		return shortMoney(spent, budget.GetCurrency()) + "/" + shortMoney(budget.GetLimitMinor(), budget.GetCurrency())
	}
	return statusWords(objective.GetStatus())
}

// openObjective is the open Objective with this ID, or nil.
func (m model) openObjective(id string) *operatorv1.Objective {
	for _, objective := range m.objectives {
		if objective.GetId() == id {
			return objective
		}
	}
	return nil
}

// renderObjective is the Objective pane: the shown Objective as `supertag describe objective`
// shows it, wrapped to the pane.
func (m model) renderObjective() string {
	wrap := lipgloss.NewStyle().Width(m.paneWidth())
	overview := m.overviews[m.objectiveID]
	if err := m.overviewErrs[m.objectiveID]; err != "" {
		text := errorStyle.Render(wrap.Render("Could not read the Objective: " + err))
		if overview == nil {
			return text
		}
		return text + "\n\n" + wrap.Render(describeObjective(overview, m.inbox.Items))
	}
	if overview == nil {
		return faint.Render(wrap.Render("Reading the Objective…"))
	}
	return wrap.Render(describeObjective(overview, m.inbox.Items))
}

// describeObjective renders an Objective's overview as `supertag describe objective` does: what a
// person decides on first, then the work, then the details. inbox is what waits on the operator;
// the items of this Objective show under "Needs you". Every line is filtered for the terminal.
func describeObjective(view *operatorv1.ObjectiveOverview, inbox []*operatorv1.InboxItem) string {
	objective := view.GetObjective()
	tag := func(id string) string {
		if name, ok := view.GetTagNames()[id]; ok {
			return name
		}
		return "unknown Tag"
	}
	id := shellWord(objective.GetId())
	closed := client.Closed(objective.GetStatus())
	var lines []string
	add := func(line ...string) { lines = append(lines, line...) }

	add(fmt.Sprintf("Objective %s: %s", objective.GetId(), statusWords(objective.GetStatus())),
		"Outcome: "+objective.GetOutcome())
	if summary := objective.GetCompletionSummary(); summary != "" {
		label := "Result"
		if objective.GetStatus() == operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_READY_FOR_REVIEW {
			label = "Owner's assessment"
		}
		add(label + ": " + summary)
	}
	if summary := objective.GetLimitSummary().GetText(); summary != "" {
		add("Limit summary: " + summary)
	}
	if findings := view.GetHighFindings(); len(findings) > 0 {
		add(fmt.Sprintf("High findings (%d):", len(findings)))
		for _, finding := range findings {
			line := fmt.Sprintf("  %s %s: %s", finding.GetTaskId(), finding.GetId(), finding.GetSummary())
			if finding.GetLocation() != "" {
				line += " (" + finding.GetLocation() + ")"
			}
			add(line)
		}
	}
	add("Owner: " + tag(objective.GetOwnerTagId()))
	if team := view.GetTeam(); team != nil {
		members := make([]string, 0, len(team.GetMemberTagIds()))
		for _, member := range team.GetMemberTagIds() {
			members = append(members, tag(member))
		}
		list := strings.Join(members, ", ")
		if list == "" {
			list = "no members"
		}
		add(fmt.Sprintf("Team: %s (%s)", team.GetName(), list))
	}
	if !closed {
		for _, condition := range view.GetConditions() {
			line := condition.GetType() + ": " + yesNo(condition.GetStatus())
			if reasons := condition.GetReasons(); len(reasons) > 0 {
				line += ". " + strings.Join(reasons, " ")
			}
			add(line)
		}
	}
	add(budgetLine(view.GetBudget()))

	add("", "Delivered:")
	delivered := 0
	for _, session := range view.GetSessions() {
		task := session.GetLatestTask()
		if !hasDelivery(task.GetDelivery()) {
			continue
		}
		delivered++
		add(fmt.Sprintf("  %s (%s, Task %s)", sessionLabel(session), tag(session.GetTagId()), task.GetId()))
		add(deliveryLines(task.GetDelivery(), "    ")...)
	}
	if delivered == 0 {
		if closed {
			add("  Nothing was delivered.")
		} else {
			add("  Nothing yet.")
		}
	}

	var needs []string
	if objective.GetStatus() == operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_LIMITED {
		needs = append(needs,
			"  The Objective reached its budget or deadline limit. Review the limit summary, then raise the budget or move the deadline to resume it.",
			"    supertag update objective "+id+" --budget-minor AMOUNT",
			"    supertag update objective "+id+" --deadline ISO_TIME")
	}
	for _, item := range inbox {
		if item.GetObjectiveId() != objective.GetId() || !item.GetOperatorEligible() {
			continue
		}
		if item.GetKind() == operatorv1.InboxItemKind_INBOX_ITEM_KIND_QUESTION && item.GetQuestion().GetText() != "" {
			needs = append(needs, asks(tag(objective.GetOwnerTagId()), item.GetQuestion().GetText())...)
		} else {
			needs = append(needs, "  "+inboxHeadline(item))
		}
		if commands := item.GetCommands(); len(commands) > 0 {
			needs = append(needs, "    "+commands[0])
		}
	}
	for _, item := range view.GetAttention() {
		switch item.GetKind() {
		case operatorv1.ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_REVIEW:
			needs = append(needs, "  The owner submitted the Objective for review.",
				"    Approve: supertag approve objective "+id,
				"    Ask for changes: supertag message objective "+id+" TEXT")
		case operatorv1.ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_NOT_STARTED, operatorv1.ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_PAUSED:
			needs = append(needs, "  "+item.GetMessage(), "    "+item.GetNextAction())
		}
	}
	if len(needs) == 0 {
		needs = []string{"  Nothing right now."}
	}
	add("", "Needs you:")
	add(needs...)

	if writes := view.GetWrites(); len(writes) > 0 {
		add("", "Writes:")
		for _, write := range writes {
			line := fmt.Sprintf("  %s: %d files / %d bytes written", write.GetVolume(), write.GetFiles(), write.GetBytes())
			if write.GetPartial() > 0 {
				line += fmt.Sprintf("; %d partial", write.GetPartial())
			}
			if write.GetRefused() > 0 {
				line += fmt.Sprintf("; %d refused", write.GetRefused())
			}
			add(line)
		}
	}

	sessions := view.GetSessions()
	add("", "Work: "+plural(len(sessions), "Session"))
	statusWidth, tagWidth := 0, 0
	for _, session := range sessions {
		statusWidth = max(statusWidth, len(sessionStatus(session)))
		tagWidth = max(tagWidth, len(tag(session.GetTagId())))
	}
	for _, session := range sessions {
		task := session.GetLatestTask()
		line := fmt.Sprintf("  %-*s  %-*s  %s", statusWidth, sessionStatus(session), tagWidth, tag(session.GetTagId()), firstLine(sessionLabel(session)))
		if task != nil {
			line += "  (Task " + task.GetId() + ")"
		}
		add(line)
		if task == nil {
			continue
		}
		open := task.GetStatus() == operatorv1.ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_PENDING ||
			task.GetStatus() == operatorv1.ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_RUNNING
		for _, reason := range task.GetExplanations() {
			if (!closed && open) || reason.GetKind() == operatorv1.TaskExplanationKind_TASK_EXPLANATION_KIND_EXECUTION_FAILED {
				add("    " + reason.GetMessage())
			}
		}
		if report := firstLine(task.GetReport()); report != "" {
			add("    Report: " + report)
		}
	}

	if posts := view.GetPosts(); len(posts) > 0 {
		add("", "Workstream:")
		for _, post := range posts[max(len(posts)-postsShown, 0):] {
			line := "  " + tag(post.GetAuthorTagId())
			if to := post.GetToTagIds(); len(to) > 0 {
				names := make([]string, 0, len(to))
				for _, id := range to {
					names = append(names, tag(id))
				}
				line += " to " + strings.Join(names, ", ")
			}
			add(line + ": " + firstLine(post.GetBody()))
		}
	}

	add("", "Details:", fmt.Sprintf("  Revision: %d", objective.GetRevision()))
	if deadline := objective.GetDeadline(); deadline != nil {
		add("  Deadline: " + timestamp(deadline))
	}
	if workspaces := objective.GetWorkspaces(); len(workspaces) > 0 {
		add("  Workspaces: " + strings.Join(workspaces, ", "))
	}
	if objective.GetStatus() == operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_CANCELLED {
		cancelled := "time not recorded"
		if at := objective.GetCancelledAt(); at != nil {
			cancelled = timestamp(at)
		}
		add("  Cancelled: " + cancelled)
	}
	for _, item := range view.GetAttention() {
		switch item.GetKind() {
		case operatorv1.ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_REVIEW, operatorv1.ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_NOT_STARTED,
			operatorv1.ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_APPROVALS_PENDING:
			continue
		}
		add("  "+item.GetMessage(), "    Next: "+item.GetNextAction())
	}
	if approvals := view.GetApprovals(); approvals != nil {
		add(fmt.Sprintf("  Approvals: %d pending; %d approved and %d denied in the last day",
			approvals.GetPending(), approvals.GetApprovedLastDay(), approvals.GetDeniedLastDay()))
	}
	if team := view.GetTeam(); team != nil {
		if team.MaxConcurrency == nil {
			add(fmt.Sprintf("  Team %s: turns limited only by Worker Host capacity", team.GetName()))
		} else {
			add(fmt.Sprintf("  Team %s: at most %d turns at once across its Objectives", team.GetName(), team.GetMaxConcurrency()))
		}
	}
	add("  Full record: supertag describe objective " + id + " --output json")
	for i, line := range lines {
		lines[i] = terminalText(line)
	}
	return strings.Join(lines, "\n")
}

// asks shows the owner's question in full, each line indented under the first: the operator
// has no other way to read it.
func asks(owner, question string) []string {
	var body []string
	for _, line := range strings.Split(strings.ReplaceAll(question, "\r\n", "\n"), "\n") {
		body = append(body, strings.TrimRight(terminalText(strings.ReplaceAll(line, "\t", "  ")), " "))
	}
	for len(body) > 1 && body[0] == "" {
		body = body[1:]
	}
	for len(body) > 1 && body[len(body)-1] == "" {
		body = body[:len(body)-1]
	}
	for i := 1; i < len(body); i++ {
		if body[i] != "" {
			body[i] = "    " + body[i]
		}
	}
	body[0] = "  " + owner + ` asks: "` + body[0]
	body[len(body)-1] += `"`
	return body
}

// budgetLine is the budget in plain words: unlimited, or how much of it was spent.
func budgetLine(use *operatorv1.ObjectiveBudgetUse) string {
	currency := use.GetCurrency()
	amount := func(minor int64) string {
		if currency == "" {
			return fmt.Sprintf("%d units", minor)
		}
		return money(minor, currency)
	}
	unpricedAttempts := 0
	for _, count := range use.GetUnpricedModels() {
		unpricedAttempts += int(count)
	}
	unpriced := ""
	if unpricedAttempts > 0 {
		unpriced = "; " + plural(unpricedAttempts, "Task Attempt") + " unpriced, so the budget cannot count them"
	}
	spent := use.GetSpentMinor()
	if use.LimitMinor == nil {
		if spent > 0 {
			return "Budget: unlimited; " + amount(spent) + " from recorded usage" + unpriced
		}
		return "Budget: unlimited; no cost recorded" + unpriced
	}
	limit := use.GetLimitMinor()
	if use.SpentMinor == nil {
		return "Budget: " + amount(limit) + "; spend is not counted in allocation units" + unpriced
	}
	line := "Budget: " + amount(spent) + " of " + amount(limit) + " spent"
	if spent > limit {
		line += "; overrun " + amount(spent-limit)
	}
	return line + unpriced
}

func hasDelivery(delivery *operatorv1.TaskDelivery) bool {
	if delivery == nil {
		return false
	}
	return delivery.GetWorkspace().GetHead() != "" || len(delivery.GetPatches()) > 0 || delivery.GetPullRequest() != nil ||
		len(delivery.GetOutputs()) > 0
}

// deliveryLines describes what a Task delivered, as the CLI's describe views do.
func deliveryLines(delivery *operatorv1.TaskDelivery, indent string) []string {
	var lines []string
	if workspace := delivery.GetWorkspace(); workspace.GetHead() != "" {
		files := ""
		if workspace.ChangedFiles != nil {
			files = ", " + plural(int(workspace.GetChangedFiles()), "changed file")
		}
		lines = append(lines, fmt.Sprintf("%sBranch %s in Workspace %s%s", indent, workspace.GetBranch(), workspace.GetName(), files))
	}
	for _, patch := range delivery.GetPatches() {
		lines = append(lines, fmt.Sprintf("%sPatch %s: supertag download artifact %s --path %s --out %s", indent, patch.GetPath(),
			shellWord(patch.GetArtifactId()), shellWord(patch.GetPath()), shellWord(baseName(patch.GetPath()))))
	}
	if pr := delivery.GetPullRequest(); pr != nil {
		state := "draft"
		switch pr.GetState() {
		case operatorv1.PullRequestState_PULL_REQUEST_STATE_READY:
			state = "ready for review"
		case operatorv1.PullRequestState_PULL_REQUEST_STATE_CLOSED:
			state = "closed"
		}
		lines = append(lines, fmt.Sprintf("%sPull request %s (%s)", indent, pr.GetUrl(), state))
		if pr.GetLastError() != "" {
			retry := "; not retrying"
			if at := pr.GetNextAttemptAt(); at != nil {
				retry = "; retrying at " + timestamp(at)
			}
			lines = append(lines, indent+"  Last update failed: "+pr.GetLastError()+retry)
		}
	}
	for _, output := range delivery.GetOutputs() {
		for _, path := range output.GetPaths() {
			out := baseName(path)
			if out == "" {
				out = "output"
			}
			lines = append(lines, fmt.Sprintf("%sOutput %s: supertag download artifact %s --path %s --out %s", indent, path,
				shellWord(output.GetArtifactId()), shellWord(path), shellWord(out)))
		}
	}
	return lines
}

// sessionLabel names a Session: the Objective's conversation, or a work Session by its title.
func sessionLabel(session *operatorv1.ObjectiveSession) string {
	if session.GetOwner() {
		return "Objective conversation"
	}
	if session.GetTitle() != "" {
		return session.GetTitle()
	}
	return "Session " + session.GetId()
}

// sessionStatus is how a Session's latest Task is doing, in a word.
func sessionStatus(session *operatorv1.ObjectiveSession) string {
	task := session.GetLatestTask()
	if task == nil {
		return "not started"
	}
	return enumWords(task.GetStatus().String(), "OBJECTIVE_SESSION_STATUS_")
}

// statusWords is an Objective status as people read it, such as "ready for review".
func statusWords(status operatorv1.ObjectiveStatus) string {
	return enumWords(status.String(), "OBJECTIVE_STATUS_")
}

func enumWords(name, prefix string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimPrefix(name, prefix), "_", " "))
}

func yesNo(ok bool) string {
	if ok {
		return "yes"
	}
	return "no"
}

func plural(count int, noun string) string {
	if count == 1 {
		return fmt.Sprintf("%d %s", count, noun)
	}
	return fmt.Sprintf("%d %ss", count, noun)
}

// firstLine is text's first non-empty line, trimmed, cut to 100 characters.
func firstLine(text string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	line = strings.TrimSpace(line)
	if runes := []rune(line); len(runes) > 100 {
		return string(runes[:99]) + "…"
	}
	return line
}

func timestamp(at *timestamppb.Timestamp) string {
	return at.AsTime().UTC().Format(time.RFC3339)
}

func baseName(path string) string {
	parts := strings.Split(strings.TrimRight(path, "/"), "/")
	return parts[len(parts)-1]
}

var plainWord = regexp.MustCompile(`^[A-Za-z0-9_./:@%+=,-]+$`)

// shellWord is one shell word: plain values as they are, others single-quoted.
func shellWord(value string) string {
	if plainWord.MatchString(value) {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// itemKindName is an inbox item's kind as the pane title names it.
func itemKindName(kind operatorv1.InboxItemKind) string {
	switch kind {
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_APPROVAL:
		return "approval"
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_QUESTION:
		return "question"
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_OBJECTIVE_BUDGET:
		return "budget"
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_OBJECTIVE_LIMIT:
		return "limit"
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_TASK_ATTENTION:
		return "Task"
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_MCP_LOGIN:
		return "MCP login"
	}
	return "item"
}
