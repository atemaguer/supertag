// Presentation types of the terminal UI. They began as the generated types of the removed
// supertag.operator.v1 protos; the Control Plane's runtime.v2 replies are projected into them.

package views

import (
	"strconv"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// What an inbox item waits on.
type InboxItemKind int32

const (
	InboxItemKind_INBOX_ITEM_KIND_UNSPECIFIED InboxItemKind = 0
	// A pending approval request. `approval` describes it.
	InboxItemKind_INBOX_ITEM_KIND_APPROVAL InboxItemKind = 1
	// An Objective's owner asked a question and waits on the answer.
	// `question` carries it. Answer it with `AnswerQuestion`.
	InboxItemKind_INBOX_ITEM_KIND_QUESTION InboxItemKind = 2
	// An Objective's budget is used up.
	InboxItemKind_INBOX_ITEM_KIND_OBJECTIVE_BUDGET InboxItemKind = 3
	// An Objective reached a budget or deadline limit. `reason` says which.
	InboxItemKind_INBOX_ITEM_KIND_OBJECTIVE_LIMIT InboxItemKind = 4
	// A Task needs an operator, such as a running Task whose Task Attempt is
	// uncertain. `uncertain_attempt` names that Task Attempt.
	InboxItemKind_INBOX_ITEM_KIND_TASK_ATTENTION InboxItemKind = 5
	// A Task is held until an MCP server is logged in to.
	InboxItemKind_INBOX_ITEM_KIND_MCP_LOGIN InboxItemKind = 6
)

// Enum value maps for InboxItemKind.
var (
	InboxItemKind_name = map[int32]string{
		0: "INBOX_ITEM_KIND_UNSPECIFIED",
		1: "INBOX_ITEM_KIND_APPROVAL",
		2: "INBOX_ITEM_KIND_QUESTION",
		3: "INBOX_ITEM_KIND_OBJECTIVE_BUDGET",
		4: "INBOX_ITEM_KIND_OBJECTIVE_LIMIT",
		5: "INBOX_ITEM_KIND_TASK_ATTENTION",
		6: "INBOX_ITEM_KIND_MCP_LOGIN",
	}
	InboxItemKind_value = map[string]int32{
		"INBOX_ITEM_KIND_UNSPECIFIED":      0,
		"INBOX_ITEM_KIND_APPROVAL":         1,
		"INBOX_ITEM_KIND_QUESTION":         2,
		"INBOX_ITEM_KIND_OBJECTIVE_BUDGET": 3,
		"INBOX_ITEM_KIND_OBJECTIVE_LIMIT":  4,
		"INBOX_ITEM_KIND_TASK_ATTENTION":   5,
		"INBOX_ITEM_KIND_MCP_LOGIN":        6,
	}
)

func (x InboxItemKind) Enum() *InboxItemKind {
	p := new(InboxItemKind)
	*p = x
	return p
}

func (x InboxItemKind) String() string {
	if s, ok := InboxItemKind_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

// What kind of approval request it is.
type ApprovalKind int32

const (
	ApprovalKind_APPROVAL_KIND_UNSPECIFIED ApprovalKind = 0
	// A Tag's use of a surface, runtime or MCP action.
	ApprovalKind_APPROVAL_KIND_SURFACE_ACTION ApprovalKind = 1
)

// Enum value maps for ApprovalKind.
var (
	ApprovalKind_name = map[int32]string{
		0: "APPROVAL_KIND_UNSPECIFIED",
		1: "APPROVAL_KIND_SURFACE_ACTION",
	}
	ApprovalKind_value = map[string]int32{
		"APPROVAL_KIND_UNSPECIFIED":    0,
		"APPROVAL_KIND_SURFACE_ACTION": 1,
	}
)

func (x ApprovalKind) Enum() *ApprovalKind {
	p := new(ApprovalKind)
	*p = x
	return p
}

func (x ApprovalKind) String() string {
	if s, ok := ApprovalKind_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

// Where an approval request stands.
type ApprovalStatus int32

const (
	ApprovalStatus_APPROVAL_STATUS_UNSPECIFIED ApprovalStatus = 0
	// It waits for a decision.
	ApprovalStatus_APPROVAL_STATUS_PENDING ApprovalStatus = 1
	// It was approved.
	ApprovalStatus_APPROVAL_STATUS_APPROVED ApprovalStatus = 2
	// It was denied.
	ApprovalStatus_APPROVAL_STATUS_DENIED ApprovalStatus = 3
	// It can no longer be used, because its Task finished or its approval
	// ended.
	ApprovalStatus_APPROVAL_STATUS_EXPIRED ApprovalStatus = 4
)

// Enum value maps for ApprovalStatus.
var (
	ApprovalStatus_name = map[int32]string{
		0: "APPROVAL_STATUS_UNSPECIFIED",
		1: "APPROVAL_STATUS_PENDING",
		2: "APPROVAL_STATUS_APPROVED",
		3: "APPROVAL_STATUS_DENIED",
		4: "APPROVAL_STATUS_EXPIRED",
	}
	ApprovalStatus_value = map[string]int32{
		"APPROVAL_STATUS_UNSPECIFIED": 0,
		"APPROVAL_STATUS_PENDING":     1,
		"APPROVAL_STATUS_APPROVED":    2,
		"APPROVAL_STATUS_DENIED":      3,
		"APPROVAL_STATUS_EXPIRED":     4,
	}
)

func (x ApprovalStatus) Enum() *ApprovalStatus {
	p := new(ApprovalStatus)
	*p = x
	return p
}

func (x ApprovalStatus) String() string {
	if s, ok := ApprovalStatus_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

// What an approval covers.
type ApprovalScope int32

const (
	ApprovalScope_APPROVAL_SCOPE_UNSPECIFIED ApprovalScope = 0
	// This one request.
	ApprovalScope_APPROVAL_SCOPE_ONCE ApprovalScope = 1
	// Every matching action in the request's Objective, until `valid_until`
	// when set.
	ApprovalScope_APPROVAL_SCOPE_OBJECTIVE ApprovalScope = 2
)

// Enum value maps for ApprovalScope.
var (
	ApprovalScope_name = map[int32]string{
		0: "APPROVAL_SCOPE_UNSPECIFIED",
		1: "APPROVAL_SCOPE_ONCE",
		2: "APPROVAL_SCOPE_OBJECTIVE",
	}
	ApprovalScope_value = map[string]int32{
		"APPROVAL_SCOPE_UNSPECIFIED": 0,
		"APPROVAL_SCOPE_ONCE":        1,
		"APPROVAL_SCOPE_OBJECTIVE":   2,
	}
)

func (x ApprovalScope) Enum() *ApprovalScope {
	p := new(ApprovalScope)
	*p = x
	return p
}

func (x ApprovalScope) String() string {
	if s, ok := ApprovalScope_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

// What an approval action acts on.
type ApprovalTarget int32

const (
	ApprovalTarget_APPROVAL_TARGET_UNSPECIFIED ApprovalTarget = 0
	// A collaboration surface, through a Surface Account.
	ApprovalTarget_APPROVAL_TARGET_SURFACE ApprovalTarget = 1
	// A runtime action in the Task's sandbox, such as `files:write`.
	ApprovalTarget_APPROVAL_TARGET_RUNTIME ApprovalTarget = 2
	// An MCP server's tool.
	ApprovalTarget_APPROVAL_TARGET_MCP ApprovalTarget = 3
)

// Enum value maps for ApprovalTarget.
var (
	ApprovalTarget_name = map[int32]string{
		0: "APPROVAL_TARGET_UNSPECIFIED",
		1: "APPROVAL_TARGET_SURFACE",
		2: "APPROVAL_TARGET_RUNTIME",
		3: "APPROVAL_TARGET_MCP",
	}
	ApprovalTarget_value = map[string]int32{
		"APPROVAL_TARGET_UNSPECIFIED": 0,
		"APPROVAL_TARGET_SURFACE":     1,
		"APPROVAL_TARGET_RUNTIME":     2,
		"APPROVAL_TARGET_MCP":         3,
	}
)

func (x ApprovalTarget) Enum() *ApprovalTarget {
	p := new(ApprovalTarget)
	*p = x
	return p
}

func (x ApprovalTarget) String() string {
	if s, ok := ApprovalTarget_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

// One thing waiting on a person. It carries metadata only: no approval
// action arguments, Task text or Tag output beyond what the fields name.
type InboxItem struct {

	// Identifies what the item stands for, such as `approval:ID` or
	// `question:TASK_ID`. It is opaque except to `AnswerQuestion`, and it is
	// the `id` of `WATCH_KIND_INBOX_ITEM` changes.
	Key string
	// Identifies one occurrence of the item. A Task that needs the same
	// decision again after another Task Attempt is a new occurrence with the
	// same `key`. A client that shows each item once keys on this.
	Occurrence string
	// What it waits on.
	Kind InboxItemKind
	// Why it needs a look, in one sentence. Worker Hosts and Tags can shape
	// it, so it is untrusted text.
	Reason string
	// The Objective it belongs to. Empty only for an approval requested by a
	// Tag's inbox turn, which belongs to no Objective.
	ObjectiveId string
	// The IDs of the Tags that may act on it next.

	// The IDs of Tags that may not act on it, such as the Tag that asked.

	// Whether an operator decides it. `supertag list inbox` without `--all`
	// shows only these.
	OperatorEligible bool
	// Since when it waits.
	ActionableSince *timestamppb.Timestamp
	// The deadline of its Objective. Unset without one.
	Deadline *timestamppb.Timestamp
	// The records it was derived from.
	Evidence []*InboxEvidence
	// The approval request, for `INBOX_ITEM_KIND_APPROVAL`.
	Approval *InboxApproval
	// The question, for `INBOX_ITEM_KIND_QUESTION`, when the caller may read
	// the whole Objective.
	Question *InboxQuestion
	// The uncertain Task Attempt, for an `INBOX_ITEM_KIND_TASK_ATTENTION` item
	// about one.
	UncertainAttempt *UncertainAttempt
	// The `supertag` commands that act on it, the most direct first, such as
	// `supertag approve request ID`. A command for a Worker Host, such as
	// `supertag recover worklet`, runs there.
	Commands []string
	// How the operator notification about it was delivered. Unset for kinds
	// that send none.

}

func (x *InboxItem) GetKey() string {
	if x != nil {
		return x.Key
	}
	return ""
}

func (x *InboxItem) GetOccurrence() string {
	if x != nil {
		return x.Occurrence
	}
	return ""
}

func (x *InboxItem) GetKind() InboxItemKind {
	if x != nil {
		return x.Kind
	}
	return InboxItemKind_INBOX_ITEM_KIND_UNSPECIFIED
}

func (x *InboxItem) GetReason() string {
	if x != nil {
		return x.Reason
	}
	return ""
}

func (x *InboxItem) GetObjectiveId() string {
	if x != nil {
		return x.ObjectiveId
	}
	return ""
}

func (x *InboxItem) GetOperatorEligible() bool {
	if x != nil {
		return x.OperatorEligible
	}
	return false
}

func (x *InboxItem) GetActionableSince() *timestamppb.Timestamp {
	if x != nil {
		return x.ActionableSince
	}
	return nil
}

func (x *InboxItem) GetDeadline() *timestamppb.Timestamp {
	if x != nil {
		return x.Deadline
	}
	return nil
}

func (x *InboxItem) GetEvidence() []*InboxEvidence {
	if x != nil {
		return x.Evidence
	}
	return nil
}

func (x *InboxItem) GetApproval() *InboxApproval {
	if x != nil {
		return x.Approval
	}
	return nil
}

func (x *InboxItem) GetQuestion() *InboxQuestion {
	if x != nil {
		return x.Question
	}
	return nil
}

func (x *InboxItem) GetUncertainAttempt() *UncertainAttempt {
	if x != nil {
		return x.UncertainAttempt
	}
	return nil
}

func (x *InboxItem) GetCommands() []string {
	if x != nil {
		return x.Commands
	}
	return nil
}

// A record an inbox item was derived from.
type InboxEvidence struct {

	// The record. Exactly one is set.
	//
	// Types that are valid to be assigned to Record:
	//
	//	*InboxEvidence_Task
	//	*InboxEvidence_Objective
	//	*InboxEvidence_ApprovalRequestId
	Record isInboxEvidence_Record
}

func (x *InboxEvidence) GetRecord() isInboxEvidence_Record {
	if x != nil {
		return x.Record
	}
	return nil
}

func (x *InboxEvidence) GetTask() *TaskEvidence {
	if x != nil {
		if x, ok := x.Record.(*InboxEvidence_Task); ok {
			return x.Task
		}
	}
	return nil
}

func (x *InboxEvidence) GetObjective() *ObjectiveEvidence {
	if x != nil {
		if x, ok := x.Record.(*InboxEvidence_Objective); ok {
			return x.Objective
		}
	}
	return nil
}

type isInboxEvidence_Record interface {
	isInboxEvidence_Record()
}

type InboxEvidence_Task struct {
	// A Task.
	Task *TaskEvidence
}

type InboxEvidence_Objective struct {
	// An Objective.
	Objective *ObjectiveEvidence
}

type InboxEvidence_ApprovalRequestId struct {
	// An approval request, by ID.

}

func (*InboxEvidence_Task) isInboxEvidence_Record() {}

func (*InboxEvidence_Objective) isInboxEvidence_Record() {}

func (*InboxEvidence_ApprovalRequestId) isInboxEvidence_Record() {}

// A Task as an inbox item saw it.
type TaskEvidence struct {

	// The Task's ID.
	Id string
	// How it was doing.
	Status TaskStatus
	// How many Task Attempts it had.

	// When it last changed.
	UpdatedAt *timestamppb.Timestamp
}

func (x *TaskEvidence) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *TaskEvidence) GetStatus() TaskStatus {
	if x != nil {
		return x.Status
	}
	return TaskStatus_TASK_STATUS_UNSPECIFIED
}

func (x *TaskEvidence) GetUpdatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.UpdatedAt
	}
	return nil
}

// An Objective as an inbox item saw it.
type ObjectiveEvidence struct {

	// The Objective's ID.
	Id string
	// Its revision.
	Revision int64
}

func (x *ObjectiveEvidence) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *ObjectiveEvidence) GetRevision() int64 {
	if x != nil {
		return x.Revision
	}
	return 0
}

// The approval request an `INBOX_ITEM_KIND_APPROVAL` item stands for.
type InboxApproval struct {

	// The approval request's ID.
	RequestId string
	// What kind of request it is.
	Kind ApprovalKind
	// What would happen, in a short sanitized sentence.
	Summary string
	// The ID of the Tag that asked.
	RequestingTagId string
	// The name of the Tag that asked. Empty when the Tag no longer exists.
	RequestingTag string
	// The Task that asked.
	TaskId string
	// Whether a running Task Attempt waits on the decision.
	Blocking bool
}

func (x *InboxApproval) GetRequestId() string {
	if x != nil {
		return x.RequestId
	}
	return ""
}

func (x *InboxApproval) GetKind() ApprovalKind {
	if x != nil {
		return x.Kind
	}
	return ApprovalKind_APPROVAL_KIND_UNSPECIFIED
}

func (x *InboxApproval) GetSummary() string {
	if x != nil {
		return x.Summary
	}
	return ""
}

func (x *InboxApproval) GetRequestingTagId() string {
	if x != nil {
		return x.RequestingTagId
	}
	return ""
}

func (x *InboxApproval) GetRequestingTag() string {
	if x != nil {
		return x.RequestingTag
	}
	return ""
}

func (x *InboxApproval) GetTaskId() string {
	if x != nil {
		return x.TaskId
	}
	return ""
}

func (x *InboxApproval) GetBlocking() bool {
	if x != nil {
		return x.Blocking
	}
	return false
}

// The question an `INBOX_ITEM_KIND_QUESTION` item stands for.
type InboxQuestion struct {

	// The question, cut to 500 characters. The Tag wrote it, so it is
	// untrusted text.
	Text string
	// When the owner asked it.
	AskedAt *timestamppb.Timestamp
	// Whether the question is longer than `text`. `DescribeObjective` shows it
	// whole.
	Truncated bool
}

func (x *InboxQuestion) GetText() string {
	if x != nil {
		return x.Text
	}
	return ""
}

func (x *InboxQuestion) GetAskedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.AskedAt
	}
	return nil
}

func (x *InboxQuestion) GetTruncated() bool {
	if x != nil {
		return x.Truncated
	}
	return false
}

// A Task Attempt that may have executed, which only an operator on its
// Worker Host can recover.
type UncertainAttempt struct {

	// The Task Attempt's ID.
	AttemptId string
	// The Worker Host it ran on, when known.
	WorkerHostId string
	// The Worker it ran on, when known.

}

func (x *UncertainAttempt) GetAttemptId() string {
	if x != nil {
		return x.AttemptId
	}
	return ""
}

func (x *UncertainAttempt) GetWorkerHostId() string {
	if x != nil {
		return x.WorkerHostId
	}
	return ""
}

// One action an approval request covers.
type ApprovalAction struct {

	// What it acts on.
	Target ApprovalTarget
	// The action. For `APPROVAL_TARGET_MCP`, the concrete `server/tool`
	// called.
	Action string
	// The Surface Account, for `APPROVAL_TARGET_SURFACE`.

	// The Surface Account scope, for `APPROVAL_TARGET_SURFACE`.
	Scope string
	// The resource the call's arguments name, for `APPROVAL_TARGET_MCP` when
	// the server maps one.
	Resource string
	// The surface provider, such as `github`, for display.

}

func (x *ApprovalAction) GetTarget() ApprovalTarget {
	if x != nil {
		return x.Target
	}
	return ApprovalTarget_APPROVAL_TARGET_UNSPECIFIED
}

func (x *ApprovalAction) GetAction() string {
	if x != nil {
		return x.Action
	}
	return ""
}

func (x *ApprovalAction) GetScope() string {
	if x != nil {
		return x.Scope
	}
	return ""
}

func (x *ApprovalAction) GetResource() string {
	if x != nil {
		return x.Resource
	}
	return ""
}

// One approval request.
type Approval struct {

	// The approval request's ID.
	Id string
	// The Objective it belongs to. Empty for a request a Tag's inbox turn made.
	ObjectiveId string
	// The Task that asked.
	TaskId string
	// The Task Attempt that asked, when known.
	AttemptId string
	// The ID of the Tag that asked.
	RequestingTagId string
	// What kind of request it is.
	Kind ApprovalKind
	// The actions it covers.
	Actions []*ApprovalAction
	// The `sha256:` digest of the call's canonical JSON arguments, for a
	// surface action. The arguments themselves are never returned.

	// What would happen, in a short sanitized sentence.
	Summary string
	// The Permission Sets whose `approval: required` produced it.

	// Who may decide it, as the requiring Permission Sets name them, such as
	// `operator:ID`. Without an `operator:` entry, any operator may decide it.

	// Where it stands.
	Status ApprovalStatus
	// What the approval covers, once approved.
	Scope ApprovalScope
	// When an `APPROVAL_SCOPE_OBJECTIVE` approval ends. Unset when it does not.

	// Who decided it: the operator's or Tag's ID. Empty while pending.
	DecidedBy string
	// Whether an operator or a Tag decided it.

	// When it was decided. Unset while pending.
	DecidedAt *timestamppb.Timestamp
	// The decider's reason, when one was given. A denial always has one.
	Reason string
	// When a once-scope approval was used up. Unset until then.

	// When it was created.
	CreatedAt *timestamppb.Timestamp
	// When it last changed.
	UpdatedAt *timestamppb.Timestamp
}

func (x *Approval) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *Approval) GetObjectiveId() string {
	if x != nil {
		return x.ObjectiveId
	}
	return ""
}

func (x *Approval) GetTaskId() string {
	if x != nil {
		return x.TaskId
	}
	return ""
}

func (x *Approval) GetAttemptId() string {
	if x != nil {
		return x.AttemptId
	}
	return ""
}

func (x *Approval) GetRequestingTagId() string {
	if x != nil {
		return x.RequestingTagId
	}
	return ""
}

func (x *Approval) GetKind() ApprovalKind {
	if x != nil {
		return x.Kind
	}
	return ApprovalKind_APPROVAL_KIND_UNSPECIFIED
}

func (x *Approval) GetActions() []*ApprovalAction {
	if x != nil {
		return x.Actions
	}
	return nil
}

func (x *Approval) GetSummary() string {
	if x != nil {
		return x.Summary
	}
	return ""
}

func (x *Approval) GetStatus() ApprovalStatus {
	if x != nil {
		return x.Status
	}
	return ApprovalStatus_APPROVAL_STATUS_UNSPECIFIED
}

func (x *Approval) GetScope() ApprovalScope {
	if x != nil {
		return x.Scope
	}
	return ApprovalScope_APPROVAL_SCOPE_UNSPECIFIED
}

func (x *Approval) GetDecidedBy() string {
	if x != nil {
		return x.DecidedBy
	}
	return ""
}

func (x *Approval) GetDecidedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.DecidedAt
	}
	return nil
}

func (x *Approval) GetReason() string {
	if x != nil {
		return x.Reason
	}
	return ""
}

func (x *Approval) GetCreatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.CreatedAt
	}
	return nil
}

func (x *Approval) GetUpdatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.UpdatedAt
	}
	return nil
}
