package main

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

type inboxQuestionMsg struct {
	occurrence string
	text       string
}

type inboxApprovalMsg struct {
	occurrence string
	details    client.ApprovalDetails
	err        error
}

func (m model) readInboxApproval() tea.Cmd {
	id, occurrence := m.item.GetApproval().GetRequestId(), m.item.GetOccurrence()
	if !m.client.RuntimeV2() || id == "" {
		return nil
	}
	return func() tea.Msg {
		details, err := m.client.ReadApproval(m.ctx, id)
		return inboxApprovalMsg{occurrence: occurrence, details: details, err: err}
	}
}

func (m model) readInboxQuestion() tea.Cmd {
	if !m.client.RuntimeV2() || !m.item.GetQuestion().GetTruncated() {
		return nil
	}
	key, occurrence := m.item.GetKey(), m.item.GetOccurrence()
	return func() tea.Msg {
		text, err := m.client.ReadObjectiveQuestion(m.ctx, key)
		if err != nil {
			return nil
		}
		return inboxQuestionMsg{occurrence: occurrence, text: text}
	}
}

// inboxRow is how the rail lists an inbox item: "?" for a question, "!" for an approval request,
// "·" for anything else, then what it is about.
func (m model) inboxRow(item *operatorv1.InboxItem) string {
	switch item.GetKind() {
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_QUESTION:
		text := item.GetQuestion().GetText()
		if text == "" {
			text = item.GetReason()
		}
		if objective := m.openObjective(item.GetObjectiveId()); objective != nil {
			text = firstLine(objective.GetOutcome()) + ": " + text
		}
		return "? " + terminalText(firstLine(text))
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_APPROVAL:
		return "! " + terminalText(firstLine(item.GetApproval().GetSummary()))
	}
	return "· " + terminalText(inboxHeadline(item))
}

// inboxWaitState says what the work behind an item is doing while it waits, so a decision that
// holds a running Task Attempt reads differently from a Session that finished its turn:
// "blocking" for an approval a running or waiting Task Attempt waits on, "not blocking" for one no
// Task Attempt waits on, and "turn finished" for a question its owner's Session waits to have
// answered as its next turn. Other kinds have none.
func inboxWaitState(item *operatorv1.InboxItem) string {
	switch item.GetKind() {
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_APPROVAL:
		if item.GetApproval().GetBlocking() {
			return "blocking"
		}
		return "not blocking"
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_QUESTION:
		return "turn finished"
	}
	return ""
}

// inboxHeadline says what an inbox item waits on in one line, as `supertag list inbox` does.
func inboxHeadline(item *operatorv1.InboxItem) string {
	task := "?"
	for _, evidence := range item.GetEvidence() {
		if evidence.GetTask() != nil {
			task = evidence.GetTask().GetId()
			break
		}
	}
	summary := func(text string) string {
		clean := strings.TrimSpace(terminalText(text))
		if runes := []rune(clean); len(runes) > 160 {
			return string(runes[:159]) + "…"
		}
		return clean
	}
	switch item.GetKind() {
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_APPROVAL:
		approval := item.GetApproval()
		if approval == nil {
			return "An approval request waits for a decision"
		}
		waiting := ""
		if approval.GetBlocking() {
			waiting = " (work is waiting)"
		}
		requester := approval.GetRequestingTag()
		if requester == "" {
			requester = "unknown Tag"
		}
		return fmt.Sprintf("Approval %s%s: %s (requested by Tag %s)", approval.GetRequestId(), waiting, summary(approval.GetSummary()), requester)
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_QUESTION:
		return "Objective " + item.GetObjectiveId() + " waits on your answer"
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_OBJECTIVE_BUDGET:
		return "The Objective budget is used up"
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_TASK_ATTENTION:
		if attempt := item.GetUncertainAttempt(); attempt != nil {
			host := attempt.GetWorkerHostId()
			if host == "" {
				return fmt.Sprintf("Task %s is uncertain: Attempt %s may have executed", task, attempt.GetAttemptId())
			}
			return fmt.Sprintf("Task %s is uncertain: Attempt %s may have executed, and only an operator on Worker Host %s can recover it",
				task, attempt.GetAttemptId(), host)
		}
		return "Task " + task + " needs attention"
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_OBJECTIVE_LIMIT:
		if item.GetReason() != "" {
			return summary(item.GetReason())
		}
		return "A budget or deadline limit was reached"
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_MCP_LOGIN:
		server := "?"
		if key := item.GetKey(); strings.HasPrefix(key, "mcp_login:") {
			server = key[strings.LastIndexByte(key, ':')+1:]
		}
		return "Task " + task + " is held until MCP server " + server + " is logged in"
	}
	return summary(item.GetReason())
}

// renderItem is the inbox pane: the shown item, what acting on it takes, and what came of it.
func (m model) renderItem() string {
	item := m.item
	width := m.paneWidth()
	wrap := lipgloss.NewStyle().Width(width)
	var lines []string
	add := func(line ...string) { lines = append(lines, line...) }

	add(inboxHeadline(item), "")
	if id := item.GetObjectiveId(); id != "" {
		name := id
		if objective := m.openObjective(id); objective != nil {
			name = firstLine(objective.GetOutcome()) + " (" + id + ")"
		}
		add("Objective: " + name)
	}
	if since := item.GetActionableSince(); since != nil {
		add("Waiting since: " + timestamp(since))
	}
	if deadline := item.GetDeadline(); deadline != nil {
		add("Deadline: " + timestamp(deadline))
	}
	switch item.GetKind() {
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_QUESTION:
		question := item.GetQuestion()
		text := question.GetText()
		if m.fullQuestion != "" {
			text = m.fullQuestion
		}
		if text == "" {
			add("", "The question is not shown to this credential.")
			break
		}
		add("", "The owner's Task finished its turn; its Session waits for your answer as its next turn.")
		add("", "The owner asks:", "")
		for _, line := range strings.Split(terminalLines(text), "\n") {
			add("  " + line)
		}
		if question.GetTruncated() && m.fullQuestion == "" {
			command := "supertag describe objective " + shellWord(item.GetObjectiveId())
			if m.client.RuntimeV2() {
				command = "supertag inbox question " + shellWord(strings.TrimPrefix(item.GetKey(), "question:"))
			}
			add("", "The question was cut short. "+command+" shows all of it.")
		}
	case operatorv1.InboxItemKind_INBOX_ITEM_KIND_APPROVAL:
		approval := item.GetApproval()
		add("", "Wants to: "+approval.GetSummary())
		if approval.GetRequestingTag() != "" {
			add("Requested by: " + approval.GetRequestingTag())
		}
		if approval.GetTaskId() != "" {
			add("Task: " + approval.GetTaskId())
		}
		if m.client.RuntimeV2() {
			switch {
			case m.approvalDetails.err != nil:
				add("", "Could not load approval details: "+m.approvalDetails.err.Error())
			case m.approvalDetails.occurrence == "":
				add("", "Loading approval details…")
			case !m.approvalDetails.details.Pending:
				add("", "This approval no longer waits for a decision.")
			default:
				details := m.approvalDetails.details
				add("", "Action: "+details.Action)
				if details.Resource != "" {
					add("Resource: " + details.Resource)
				}
				add("Arguments:")
				for _, line := range strings.Split(details.Arguments, "\n") {
					add("  " + line)
				}
			}
		} else if approval.GetBlocking() {
			add("A running Task Attempt waits on the decision.")
		} else {
			add("No running Task Attempt waits on the decision.")
		}
	default:
		if item.GetReason() != "" {
			add("", "Why: "+item.GetReason())
		}
	}
	if commands := item.GetCommands(); item.GetKind() != operatorv1.InboxItemKind_INBOX_ITEM_KIND_QUESTION && len(commands) > 0 {
		add("", "Commands:")
		for _, command := range commands {
			add("  " + command)
		}
	}
	for i, line := range lines {
		lines[i] = wrap.Render(terminalText(line))
	}
	lines[0] = bold.Render(lines[0])
	out := strings.Join(lines, "\n")
	switch {
	case m.itemNote.text != "" && m.itemNote.err:
		out += "\n\n" + errorStyle.Render(wrap.Render(m.itemNote.text))
	case m.itemNote.text != "":
		out += "\n\n" + okStyle.Render(wrap.Render(m.itemNote.text))
	case m.inboxItem(item.GetOccurrence()) == nil:
		out += "\n\n" + faint.Render(wrap.Render("This item is settled and left the inbox."))
	}
	if m.decision == decisionReason {
		out += "\n\n" + wrap.Render("Type why you deny it; the Session that asked reads it. enter sends · esc cancels")
	}
	return out
}
