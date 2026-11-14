// Presentation types of the terminal UI. They began as the generated types of the removed
// supertag.operator.v1 protos; the Control Plane's runtime.v2 replies are projected into them.

package views

import (
	"strconv"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// Where an Objective stands.
type ObjectiveStatus int32

const (
	ObjectiveStatus_OBJECTIVE_STATUS_UNSPECIFIED ObjectiveStatus = 0
	// The owner works on it.
	ObjectiveStatus_OBJECTIVE_STATUS_WORKING ObjectiveStatus = 1
	// The owner cannot continue without a person: it ended twice with nothing
	// running and nothing asked, or marked the Objective blocked.
	ObjectiveStatus_OBJECTIVE_STATUS_BLOCKED ObjectiveStatus = 2
	// It reached its budget or deadline limit. An operator raises the budget or
	// moves the deadline to resume it.
	ObjectiveStatus_OBJECTIVE_STATUS_LIMITED ObjectiveStatus = 3
	// The owner submitted its result for an operator's review.
	ObjectiveStatus_OBJECTIVE_STATUS_READY_FOR_REVIEW ObjectiveStatus = 4
	// It is done. Nothing new starts.
	ObjectiveStatus_OBJECTIVE_STATUS_COMPLETED ObjectiveStatus = 5
	// An operator cancelled it. Nothing new starts.
	ObjectiveStatus_OBJECTIVE_STATUS_CANCELLED ObjectiveStatus = 6
)

// Enum value maps for ObjectiveStatus.
var (
	ObjectiveStatus_name = map[int32]string{
		0: "OBJECTIVE_STATUS_UNSPECIFIED",
		1: "OBJECTIVE_STATUS_WORKING",
		2: "OBJECTIVE_STATUS_BLOCKED",
		3: "OBJECTIVE_STATUS_LIMITED",
		4: "OBJECTIVE_STATUS_READY_FOR_REVIEW",
		5: "OBJECTIVE_STATUS_COMPLETED",
		6: "OBJECTIVE_STATUS_CANCELLED",
	}
	ObjectiveStatus_value = map[string]int32{
		"OBJECTIVE_STATUS_UNSPECIFIED":      0,
		"OBJECTIVE_STATUS_WORKING":          1,
		"OBJECTIVE_STATUS_BLOCKED":          2,
		"OBJECTIVE_STATUS_LIMITED":          3,
		"OBJECTIVE_STATUS_READY_FOR_REVIEW": 4,
		"OBJECTIVE_STATUS_COMPLETED":        5,
		"OBJECTIVE_STATUS_CANCELLED":        6,
	}
)

func (x ObjectiveStatus) Enum() *ObjectiveStatus {
	p := new(ObjectiveStatus)
	*p = x
	return p
}

func (x ObjectiveStatus) String() string {
	if s, ok := ObjectiveStatus_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

// What about an Objective needs a look.
type ObjectiveAttentionKind int32

const (
	ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_UNSPECIFIED ObjectiveAttentionKind = 0
	// Its conversation has not started.
	ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_NOT_STARTED ObjectiveAttentionKind = 1
	// An operator paused it.
	ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_PAUSED ObjectiveAttentionKind = 2
	// An operator cancelled it.
	ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_CANCELLED ObjectiveAttentionKind = 3
	// It is blocked.
	ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_BLOCKED ObjectiveAttentionKind = 4
	// The owner submitted it for review.
	ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_REVIEW ObjectiveAttentionKind = 5
	// The owner asked a question and waits on the answer.
	ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_OWNER_QUESTION ObjectiveAttentionKind = 6
	// Spend crossed a budget warning threshold.
	ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_BUDGET_THRESHOLD ObjectiveAttentionKind = 7
	// The budget is used up.
	ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_BUDGET_EXHAUSTED ObjectiveAttentionKind = 8
	// Some executed Task Attempts reported no cost, so reported spend may be
	// low.
	ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_BUDGET_COVERAGE_INCOMPLETE ObjectiveAttentionKind = 9
	// The deadline is near.
	ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_DEADLINE_APPROACHING ObjectiveAttentionKind = 10
	// The deadline passed.
	ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_DEADLINE_PASSED ObjectiveAttentionKind = 11
	// Approval requests wait for a decision.
	ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_APPROVALS_PENDING ObjectiveAttentionKind = 12
)

// Enum value maps for ObjectiveAttentionKind.
var (
	ObjectiveAttentionKind_name = map[int32]string{
		0:  "OBJECTIVE_ATTENTION_KIND_UNSPECIFIED",
		1:  "OBJECTIVE_ATTENTION_KIND_NOT_STARTED",
		2:  "OBJECTIVE_ATTENTION_KIND_PAUSED",
		3:  "OBJECTIVE_ATTENTION_KIND_CANCELLED",
		4:  "OBJECTIVE_ATTENTION_KIND_BLOCKED",
		5:  "OBJECTIVE_ATTENTION_KIND_REVIEW",
		6:  "OBJECTIVE_ATTENTION_KIND_OWNER_QUESTION",
		7:  "OBJECTIVE_ATTENTION_KIND_BUDGET_THRESHOLD",
		8:  "OBJECTIVE_ATTENTION_KIND_BUDGET_EXHAUSTED",
		9:  "OBJECTIVE_ATTENTION_KIND_BUDGET_COVERAGE_INCOMPLETE",
		10: "OBJECTIVE_ATTENTION_KIND_DEADLINE_APPROACHING",
		11: "OBJECTIVE_ATTENTION_KIND_DEADLINE_PASSED",
		12: "OBJECTIVE_ATTENTION_KIND_APPROVALS_PENDING",
	}
	ObjectiveAttentionKind_value = map[string]int32{
		"OBJECTIVE_ATTENTION_KIND_UNSPECIFIED":                0,
		"OBJECTIVE_ATTENTION_KIND_NOT_STARTED":                1,
		"OBJECTIVE_ATTENTION_KIND_PAUSED":                     2,
		"OBJECTIVE_ATTENTION_KIND_CANCELLED":                  3,
		"OBJECTIVE_ATTENTION_KIND_BLOCKED":                    4,
		"OBJECTIVE_ATTENTION_KIND_REVIEW":                     5,
		"OBJECTIVE_ATTENTION_KIND_OWNER_QUESTION":             6,
		"OBJECTIVE_ATTENTION_KIND_BUDGET_THRESHOLD":           7,
		"OBJECTIVE_ATTENTION_KIND_BUDGET_EXHAUSTED":           8,
		"OBJECTIVE_ATTENTION_KIND_BUDGET_COVERAGE_INCOMPLETE": 9,
		"OBJECTIVE_ATTENTION_KIND_DEADLINE_APPROACHING":       10,
		"OBJECTIVE_ATTENTION_KIND_DEADLINE_PASSED":            11,
		"OBJECTIVE_ATTENTION_KIND_APPROVALS_PENDING":          12,
	}
)

func (x ObjectiveAttentionKind) Enum() *ObjectiveAttentionKind {
	p := new(ObjectiveAttentionKind)
	*p = x
	return p
}

func (x ObjectiveAttentionKind) String() string {
	if s, ok := ObjectiveAttentionKind_name[int32(
		x)]; ok {
		return s
	}
	return strconv.Itoa(int(x))
}

// How one of an Objective's Sessions is doing, by its latest Task.
type ObjectiveSessionStatus int32

const (
	ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_UNSPECIFIED ObjectiveSessionStatus = 0
	// It has no Task yet.
	ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_QUEUED ObjectiveSessionStatus = 1
	// Its latest Task waits to run.
	ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_PENDING ObjectiveSessionStatus = 2
	// Its latest Task runs.
	ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_RUNNING ObjectiveSessionStatus = 3
	// Its latest Task completed waiting on a person: on the answer to
	// `question` when set, otherwise on a decision on its approval requests.
	ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_WAITING ObjectiveSessionStatus = 4
	// Its latest Task completed.
	ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_COMPLETED ObjectiveSessionStatus = 5
	// Its latest Task failed.
	ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_FAILED ObjectiveSessionStatus = 6
	// Its latest Task was cancelled.
	ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_CANCELLED ObjectiveSessionStatus = 7
)

// Enum value maps for ObjectiveSessionStatus.
var (
	ObjectiveSessionStatus_name = map[int32]string{
		0: "OBJECTIVE_SESSION_STATUS_UNSPECIFIED",
		1: "OBJECTIVE_SESSION_STATUS_QUEUED",
		2: "OBJECTIVE_SESSION_STATUS_PENDING",
		3: "OBJECTIVE_SESSION_STATUS_RUNNING",
		4: "OBJECTIVE_SESSION_STATUS_WAITING",
		5: "OBJECTIVE_SESSION_STATUS_COMPLETED",
		6: "OBJECTIVE_SESSION_STATUS_FAILED",
		7: "OBJECTIVE_SESSION_STATUS_CANCELLED",
	}
	ObjectiveSessionStatus_value = map[string]int32{
		"OBJECTIVE_SESSION_STATUS_UNSPECIFIED": 0,
		"OBJECTIVE_SESSION_STATUS_QUEUED":      1,
		"OBJECTIVE_SESSION_STATUS_PENDING":     2,
		"OBJECTIVE_SESSION_STATUS_RUNNING":     3,
		"OBJECTIVE_SESSION_STATUS_WAITING":     4,
		"OBJECTIVE_SESSION_STATUS_COMPLETED":   5,
		"OBJECTIVE_SESSION_STATUS_FAILED":      6,
		"OBJECTIVE_SESSION_STATUS_CANCELLED":   7,
	}
)

func (x ObjectiveSessionStatus) Enum() *ObjectiveSessionStatus {
	p := new(ObjectiveSessionStatus)
	*p = x
	return p
}

func (x ObjectiveSessionStatus) String() string {
	if s, ok := ObjectiveSessionStatus_name[int32(
		x)]; ok {
		return s
	}
	return strconv.Itoa(int(x))
}

// What a Task explanation is about.
type TaskExplanationKind int32

const (
	TaskExplanationKind_TASK_EXPLANATION_KIND_UNSPECIFIED TaskExplanationKind = 0
	// The Objective is paused; the Task starts once it resumes.
	TaskExplanationKind_TASK_EXPLANATION_KIND_OBJECTIVE_PAUSED TaskExplanationKind = 1
	// The Control Plane does not execute Objectives now.
	TaskExplanationKind_TASK_EXPLANATION_KIND_CONTROLLER TaskExplanationKind = 2
	// No connected Worker can meet the Task's requirements.
	TaskExplanationKind_TASK_EXPLANATION_KIND_WORKER_REQUIREMENTS TaskExplanationKind = 3
	// The Task's Task Attempt may have executed and will not be replayed.
	TaskExplanationKind_TASK_EXPLANATION_KIND_ATTEMPT_UNCERTAIN TaskExplanationKind = 4
	// The Task failed.
	TaskExplanationKind_TASK_EXPLANATION_KIND_EXECUTION_FAILED TaskExplanationKind = 5
)

// Enum value maps for TaskExplanationKind.
var (
	TaskExplanationKind_name = map[int32]string{
		0: "TASK_EXPLANATION_KIND_UNSPECIFIED",
		1: "TASK_EXPLANATION_KIND_OBJECTIVE_PAUSED",
		2: "TASK_EXPLANATION_KIND_CONTROLLER",
		3: "TASK_EXPLANATION_KIND_WORKER_REQUIREMENTS",
		4: "TASK_EXPLANATION_KIND_ATTEMPT_UNCERTAIN",
		5: "TASK_EXPLANATION_KIND_EXECUTION_FAILED",
	}
	TaskExplanationKind_value = map[string]int32{
		"TASK_EXPLANATION_KIND_UNSPECIFIED":         0,
		"TASK_EXPLANATION_KIND_OBJECTIVE_PAUSED":    1,
		"TASK_EXPLANATION_KIND_CONTROLLER":          2,
		"TASK_EXPLANATION_KIND_WORKER_REQUIREMENTS": 3,
		"TASK_EXPLANATION_KIND_ATTEMPT_UNCERTAIN":   4,
		"TASK_EXPLANATION_KIND_EXECUTION_FAILED":    5,
	}
)

func (x TaskExplanationKind) Enum() *TaskExplanationKind {
	p := new(TaskExplanationKind)
	*p = x
	return p
}

func (x TaskExplanationKind) String() string {
	if s, ok := TaskExplanationKind_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

type CreateObjectiveResponse struct {

	// The Objective, or with `dry_run` the Objective the call would create.
	Objective *Objective
	// Each condition that would hold the Objective's turns or limit what they
	// may do, in one sentence, such as an owner Tag with no connected Worker
	// Host or a runtime action the owner lacks.
	Warnings []string
	// The Task of the owner's first turn, when this call or an earlier one
	// started the Objective. Empty with `dry_run`, for a completed or cancelled
	// Objective, and when the Objective could not be started.
	StartedTaskId string
	// Why the Objective could not be started, in one sentence, when it could
	// not. Repeat the call with the Objective's `id` once that is fixed.
	NotStarted string
}

func (x *CreateObjectiveResponse) GetObjective() *Objective {
	if x != nil {
		return x.Objective
	}
	return nil
}

func (x *CreateObjectiveResponse) GetWarnings() []string {
	if x != nil {
		return x.Warnings
	}
	return nil
}

func (x *CreateObjectiveResponse) GetStartedTaskId() string {
	if x != nil {
		return x.StartedTaskId
	}
	return ""
}

func (x *CreateObjectiveResponse) GetNotStarted() string {
	if x != nil {
		return x.NotStarted
	}
	return ""
}

type MessageObjectiveResponse struct {

	// The Task of the turn the message started, or of the turn an earlier call
	// with the same `idempotency_key` started.
	TaskId string
	// The owner Tag's name, for `ConversationService.FollowMessage`.
	Tag string
	// The message repeated an earlier one with the same `idempotency_key`, and
	// nothing was sent.

	// The status the message moved the Objective out of, back to `working`.
	// `OBJECTIVE_STATUS_UNSPECIFIED` when the status did not change.
	StatusChange ObjectiveStatus
}

func (x *MessageObjectiveResponse) GetTaskId() string {
	if x != nil {
		return x.TaskId
	}
	return ""
}

func (x *MessageObjectiveResponse) GetTag() string {
	if x != nil {
		return x.Tag
	}
	return ""
}

func (x *MessageObjectiveResponse) GetStatusChange() ObjectiveStatus {
	if x != nil {
		return x.StatusChange
	}
	return ObjectiveStatus_OBJECTIVE_STATUS_UNSPECIFIED
}

// A list of runtime actions, such as `files:write`.
type RuntimeActions struct {

	// The actions, at most 50.
	Actions []string
}

func (x *RuntimeActions) GetActions() []string {
	if x != nil {
		return x.Actions
	}
	return nil
}

// A budget: provider-reported cost in a currency, or allocation units.
type Budget struct {

	// The limit, in minor units of `currency`, or in allocation units when
	// `currency` is empty.
	LimitMinor int64
	// The ISO 4217 code, such as `USD`. Empty keeps the budget in allocation
	// units, which provider-reported cost does not count against.
	Currency string
}

func (x *Budget) GetLimitMinor() int64 {
	if x != nil {
		return x.LimitMinor
	}
	return 0
}

func (x *Budget) GetCurrency() string {
	if x != nil {
		return x.Currency
	}
	return ""
}

// One Objective.
type Objective struct {

	// The Objective's ID.
	Id string
	// The outcome statement.
	Outcome string
	// The owner Tag's ID.
	OwnerTagId string
	// The owner Tag's name. Empty when the Tag no longer exists.
	OwnerTag string
	// Where the Objective stands.
	Status ObjectiveStatus
	// Increases with every change. Pass it as `expected_revision`.
	Revision int64
	// A responsibility that only an operator ends.
	Ongoing bool
	// When it is due. Unset without a deadline.
	Deadline *timestamppb.Timestamp
	// Its budget. Unset without one.
	Budget *Budget
	// Provider-reported spend against a budget in a currency, as last
	// observed. Unset without such a budget.
	Spend *ObjectiveSpend
	// The runtime actions its Tasks may receive.
	RuntimeActions []string
	// The Workspaces its work may use.
	Workspaces []string
	// The ID of the Team whose members the owner may hand work to. Empty when
	// the owner works alone.
	TeamId string
	// The owner's assessment of the outcome: the result once completed, or
	// what the owner submitted for review.
	CompletionSummary string
	// The owner's account of progress, open work, blockers and the next step,
	// written when the Objective reached a limit. Unset until then.
	LimitSummary *LimitSummary
	// When it started: its first turn was admitted. Unset until then.

	// When an operator paused it. Unset while it runs.
	PausedAt *timestamppb.Timestamp
	// When an operator cancelled it. Unset otherwise.
	CancelledAt *timestamppb.Timestamp
	// The operator's reason for cancelling it, when one was given.

	// The collaboration surface Task it was created from, such as a Slack
	// message. Empty for an Objective created through this API or a manifest.

	// The surface Task an operator chose as its home thread, where the owner's
	// replies post, in place of the thread it was created in. Empty otherwise.

	// When it was created.
	CreatedAt *timestamppb.Timestamp
	// When it last changed.
	UpdatedAt *timestamppb.Timestamp
}

func (x *Objective) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *Objective) GetOutcome() string {
	if x != nil {
		return x.Outcome
	}
	return ""
}

func (x *Objective) GetOwnerTagId() string {
	if x != nil {
		return x.OwnerTagId
	}
	return ""
}

func (x *Objective) GetOwnerTag() string {
	if x != nil {
		return x.OwnerTag
	}
	return ""
}

func (x *Objective) GetStatus() ObjectiveStatus {
	if x != nil {
		return x.Status
	}
	return ObjectiveStatus_OBJECTIVE_STATUS_UNSPECIFIED
}

func (x *Objective) GetRevision() int64 {
	if x != nil {
		return x.Revision
	}
	return 0
}

func (x *Objective) GetOngoing() bool {
	if x != nil {
		return x.Ongoing
	}
	return false
}

func (x *Objective) GetDeadline() *timestamppb.Timestamp {
	if x != nil {
		return x.Deadline
	}
	return nil
}

func (x *Objective) GetBudget() *Budget {
	if x != nil {
		return x.Budget
	}
	return nil
}

func (x *Objective) GetSpend() *ObjectiveSpend {
	if x != nil {
		return x.Spend
	}
	return nil
}

func (x *Objective) GetRuntimeActions() []string {
	if x != nil {
		return x.RuntimeActions
	}
	return nil
}

func (x *Objective) GetWorkspaces() []string {
	if x != nil {
		return x.Workspaces
	}
	return nil
}

func (x *Objective) GetTeamId() string {
	if x != nil {
		return x.TeamId
	}
	return ""
}

func (x *Objective) GetCompletionSummary() string {
	if x != nil {
		return x.CompletionSummary
	}
	return ""
}

func (x *Objective) GetLimitSummary() *LimitSummary {
	if x != nil {
		return x.LimitSummary
	}
	return nil
}

func (x *Objective) GetPausedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.PausedAt
	}
	return nil
}

func (x *Objective) GetCancelledAt() *timestamppb.Timestamp {
	if x != nil {
		return x.CancelledAt
	}
	return nil
}

func (x *Objective) GetCreatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.CreatedAt
	}
	return nil
}

func (x *Objective) GetUpdatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.UpdatedAt
	}
	return nil
}

// Provider-reported spend against an Objective's budget.
type ObjectiveSpend struct {

	// The provider-reported cost of every Task of the Objective's Sessions, in
	// minor units of the budget's currency.
	AmountMinor int64
	// The budget's ISO 4217 code.
	Currency string
	// Executed Task Attempts that reported no cost. They are not counted as
	// zero, so actual spend may be higher.

}

func (x *ObjectiveSpend) GetAmountMinor() int64 {
	if x != nil {
		return x.AmountMinor
	}
	return 0
}

func (x *ObjectiveSpend) GetCurrency() string {
	if x != nil {
		return x.Currency
	}
	return ""
}

// The owner's summary at a limit.
type LimitSummary struct {

	// The summary. The Tag wrote it, so it is untrusted text.
	Text string
	// When it was written.

}

func (x *LimitSummary) GetText() string {
	if x != nil {
		return x.Text
	}
	return ""
}

// The operator's view of one Objective. See `DescribeObjective`.
type ObjectiveOverview struct {

	// When the Control Plane read the records.

	// The Objective.
	Objective *Objective
	// Whether the Control Plane can execute Objectives now: `ready`,
	// `awaiting-coordination` until it knows the address Tasks coordinate
	// through, or `awaiting-worklet` until its Worklet service is attached.

	// Whether the Objective's turns can run now. A completed or cancelled
	// Objective runs nothing more, whatever they say.
	Conditions []*ObjectiveCondition
	// What the operator should look at, each with the next step.
	Attention []*ObjectiveAttention
	// The Objective's approval requests: pending, and decided in the last day.
	Approvals *ApprovalCounts
	// Display names of the Tags this view names by ID, keyed by Tag ID. A Tag
	// that no longer exists has no entry.
	TagNames map[string]string
	// The Team whose members the owner may hand work to. Unset when the owner
	// works alone.
	Team *ObjectiveTeam
	// The deadline and the budget, with the notices each raised.

	// Spend against the budget and the usage behind it.
	Budget *ObjectiveBudgetUse
	// The newest turns of the Objective's own conversation, at most 25 Tasks'
	// worth, oldest first.
	Conversation []*ObjectiveConversationEntry
	// Every Session of the Objective: its own conversation first, then work
	// Sessions, oldest first.
	Sessions []*ObjectiveSession
	// High-severity findings in the latest result of each Session.
	HighFindings []*HighFinding
	// The Team's newest Workstream posts, at most 50, oldest first. Empty
	// without a Team.
	Posts []*WorkstreamPost
	// What the Objective's Task Attempts wrote to each Volume, by Volume name.
	Writes []*VolumeWrites
	// One page of the Tasks of every Session, oldest first within each
	// Session, the Objective's own Session first.

	// How many Tasks all pages hold.

	// Fetches the next page of `tasks`. Empty on the last page.

	// The 50 newest commit review requests and their recorded verdicts, newest first.
	CommitReviews []*ObjectiveCommitReview
}

func (x *ObjectiveOverview) GetObjective() *Objective {
	if x != nil {
		return x.Objective
	}
	return nil
}

func (x *ObjectiveOverview) GetConditions() []*ObjectiveCondition {
	if x != nil {
		return x.Conditions
	}
	return nil
}

func (x *ObjectiveOverview) GetAttention() []*ObjectiveAttention {
	if x != nil {
		return x.Attention
	}
	return nil
}

func (x *ObjectiveOverview) GetApprovals() *ApprovalCounts {
	if x != nil {
		return x.Approvals
	}
	return nil
}

func (x *ObjectiveOverview) GetTagNames() map[string]string {
	if x != nil {
		return x.TagNames
	}
	return nil
}

func (x *ObjectiveOverview) GetTeam() *ObjectiveTeam {
	if x != nil {
		return x.Team
	}
	return nil
}

func (x *ObjectiveOverview) GetBudget() *ObjectiveBudgetUse {
	if x != nil {
		return x.Budget
	}
	return nil
}

func (x *ObjectiveOverview) GetConversation() []*ObjectiveConversationEntry {
	if x != nil {
		return x.Conversation
	}
	return nil
}

func (x *ObjectiveOverview) GetSessions() []*ObjectiveSession {
	if x != nil {
		return x.Sessions
	}
	return nil
}

func (x *ObjectiveOverview) GetHighFindings() []*HighFinding {
	if x != nil {
		return x.HighFindings
	}
	return nil
}

func (x *ObjectiveOverview) GetPosts() []*WorkstreamPost {
	if x != nil {
		return x.Posts
	}
	return nil
}

func (x *ObjectiveOverview) GetWrites() []*VolumeWrites {
	if x != nil {
		return x.Writes
	}
	return nil
}

func (x *ObjectiveOverview) GetCommitReviews() []*ObjectiveCommitReview {
	if x != nil {
		return x.CommitReviews
	}
	return nil
}

// A review request tied to one delivered Git commit of the Objective.
type ObjectiveCommitReview struct {

	// The request's Mailbox message ID.
	RequestId string
	// Full Git commit hash.
	Commit string
	// The Tag asked to review the commit.
	ReviewerTagId string
	// Empty while pending, otherwise approved or changes_requested.
	Verdict string
	// The reviewer's evidence. Treat it as untrusted text.
	Summary string
	// When the reviewer recorded the verdict.
	RecordedAt *timestamppb.Timestamp
}

func (x *ObjectiveCommitReview) GetRequestId() string {
	if x != nil {
		return x.RequestId
	}
	return ""
}

func (x *ObjectiveCommitReview) GetCommit() string {
	if x != nil {
		return x.Commit
	}
	return ""
}

func (x *ObjectiveCommitReview) GetReviewerTagId() string {
	if x != nil {
		return x.ReviewerTagId
	}
	return ""
}

func (x *ObjectiveCommitReview) GetVerdict() string {
	if x != nil {
		return x.Verdict
	}
	return ""
}

func (x *ObjectiveCommitReview) GetSummary() string {
	if x != nil {
		return x.Summary
	}
	return ""
}

func (x *ObjectiveCommitReview) GetRecordedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.RecordedAt
	}
	return nil
}

// A condition on an Objective, such as whether its turns can run.
type ObjectiveCondition struct {

	// The condition: `Runnable`.
	Type string
	// Whether it holds.
	Status bool
	// Why it does not, each in one sentence with the step that clears it.
	// Empty when it holds.
	Reasons []string
}

func (x *ObjectiveCondition) GetType() string {
	if x != nil {
		return x.Type
	}
	return ""
}

func (x *ObjectiveCondition) GetStatus() bool {
	if x != nil {
		return x.Status
	}
	return false
}

func (x *ObjectiveCondition) GetReasons() []string {
	if x != nil {
		return x.Reasons
	}
	return nil
}

// One thing about an Objective that needs a look, with the next step.
type ObjectiveAttention struct {

	// What it is.
	Kind ObjectiveAttentionKind
	// What is the matter, in one or two sentences.
	Message string
	// What to do about it, usually naming a `supertag` command.
	NextAction string
	// When it was observed. Unset when the Control Plane recorded no time.

}

func (x *ObjectiveAttention) GetKind() ObjectiveAttentionKind {
	if x != nil {
		return x.Kind
	}
	return ObjectiveAttentionKind_OBJECTIVE_ATTENTION_KIND_UNSPECIFIED
}

func (x *ObjectiveAttention) GetMessage() string {
	if x != nil {
		return x.Message
	}
	return ""
}

func (x *ObjectiveAttention) GetNextAction() string {
	if x != nil {
		return x.NextAction
	}
	return ""
}

// How many approval requests an Objective has, by state.
type ApprovalCounts struct {

	// Waiting for a decision.
	Pending int32
	// Approved in the last 24 hours.
	ApprovedLastDay int32
	// Denied in the last 24 hours.
	DeniedLastDay int32
}

func (x *ApprovalCounts) GetPending() int32 {
	if x != nil {
		return x.Pending
	}
	return 0
}

func (x *ApprovalCounts) GetApprovedLastDay() int32 {
	if x != nil {
		return x.ApprovedLastDay
	}
	return 0
}

func (x *ApprovalCounts) GetDeniedLastDay() int32 {
	if x != nil {
		return x.DeniedLastDay
	}
	return 0
}

// The Team an Objective's owner may hand work to.
type ObjectiveTeam struct {

	// The Team's ID.
	Id string
	// The Team's name.
	Name string
	// The IDs of its member Tags.
	MemberTagIds []string
	// At most this many turns run at once across the Team's Objectives. Unset:
	// only Worker Host capacity limits them.
	MaxConcurrency *int32
}

func (x *ObjectiveTeam) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *ObjectiveTeam) GetName() string {
	if x != nil {
		return x.Name
	}
	return ""
}

func (x *ObjectiveTeam) GetMemberTagIds() []string {
	if x != nil {
		return x.MemberTagIds
	}
	return nil
}

func (x *ObjectiveTeam) GetMaxConcurrency() int32 {
	if x != nil && x.MaxConcurrency != nil {
		return *x.MaxConcurrency
	}
	return 0
}

// Spend against an Objective's budget, and the usage behind it.
type ObjectiveBudgetUse struct {

	// The budget's ISO 4217 code. Empty for a budget in allocation units and
	// for an Objective without a budget.
	Currency string
	// The budget limit. Unset without a budget.
	LimitMinor *int64
	// Provider-reported spend counted against the budget, in minor units of
	// `currency`. Unset when `currency` is empty: spend is not counted in
	// allocation units.
	SpentMinor *int64
	// What is left: `limit_minor` minus `spent_minor`, negative once over.
	// Unset when either is unset.
	AvailableMinor *int64
	// Executed Task Attempts of every Task of the Objective's Sessions.

	// Their provider-reported cost by ISO 4217 code, in minor units. Separate
	// currencies are never combined. Empty when no Task Attempt reported cost.

	// Task Attempts that reported no cost.

	// Task Attempts whose cost comes from a model price estimate.

	// Task Attempts that reported tokens for a model the Harness has no price
	// for, by model. The budget cannot count them.
	UnpricedModels map[string]int32
	// Tokens those Task Attempts reported.

}

func (x *ObjectiveBudgetUse) GetCurrency() string {
	if x != nil {
		return x.Currency
	}
	return ""
}

func (x *ObjectiveBudgetUse) GetLimitMinor() int64 {
	if x != nil && x.LimitMinor != nil {
		return *x.LimitMinor
	}
	return 0
}

func (x *ObjectiveBudgetUse) GetSpentMinor() int64 {
	if x != nil && x.SpentMinor != nil {
		return *x.SpentMinor
	}
	return 0
}

func (x *ObjectiveBudgetUse) GetAvailableMinor() int64 {
	if x != nil && x.AvailableMinor != nil {
		return *x.AvailableMinor
	}
	return 0
}

func (x *ObjectiveBudgetUse) GetUnpricedModels() map[string]int32 {
	if x != nil {
		return x.UnpricedModels
	}
	return nil
}

// One entry of an Objective's own conversation.
type ObjectiveConversationEntry struct {

	// The Task of the turn.
	TaskId string
	// Who wrote it.

	// The operator who wrote it, when `author` is
	// `OBJECTIVE_CONVERSATION_AUTHOR_OPERATOR`.

	// The text. An owner's reply is untrusted text.
	Text string
	// When it was written.
	CreatedAt *timestamppb.Timestamp
}

func (x *ObjectiveConversationEntry) GetTaskId() string {
	if x != nil {
		return x.TaskId
	}
	return ""
}

func (x *ObjectiveConversationEntry) GetText() string {
	if x != nil {
		return x.Text
	}
	return ""
}

func (x *ObjectiveConversationEntry) GetCreatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.CreatedAt
	}
	return nil
}

// One Session of an Objective: its own conversation, where the owner works,
// or a work Session started under it.
type ObjectiveSession struct {

	// The Session's ID.
	Id string
	// The ID of the Tag running it.
	TagId string
	// The name of the Tag running it. Empty when the Tag no longer exists.
	Tag string
	// Whether it is the Objective's own conversation.
	Owner bool
	// The title the Tag gave the work. Empty for the Objective's own
	// conversation.
	Title string
	// The Session that started this work Session. Empty for the Objective's
	// own conversation.
	ParentSessionId string
	// How it is doing.
	Status ObjectiveSessionStatus
	// What its latest Task asked, while it waits on the answer.
	Question string
	// The approval requests its latest Task waits on.

	// How many Tasks it has.

	// When it was created.
	CreatedAt *timestamppb.Timestamp
	// Its latest Task. Unset while it has none.
	LatestTask *ObjectiveSessionTask
}

func (x *ObjectiveSession) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *ObjectiveSession) GetTagId() string {
	if x != nil {
		return x.TagId
	}
	return ""
}

func (x *ObjectiveSession) GetTag() string {
	if x != nil {
		return x.Tag
	}
	return ""
}

func (x *ObjectiveSession) GetOwner() bool {
	if x != nil {
		return x.Owner
	}
	return false
}

func (x *ObjectiveSession) GetTitle() string {
	if x != nil {
		return x.Title
	}
	return ""
}

func (x *ObjectiveSession) GetParentSessionId() string {
	if x != nil {
		return x.ParentSessionId
	}
	return ""
}

func (x *ObjectiveSession) GetStatus() ObjectiveSessionStatus {
	if x != nil {
		return x.Status
	}
	return ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_UNSPECIFIED
}

func (x *ObjectiveSession) GetQuestion() string {
	if x != nil {
		return x.Question
	}
	return ""
}

func (x *ObjectiveSession) GetCreatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.CreatedAt
	}
	return nil
}

func (x *ObjectiveSession) GetLatestTask() *ObjectiveSessionTask {
	if x != nil {
		return x.LatestTask
	}
	return nil
}

// A Session's latest Task, with what it delivered and reported.
type ObjectiveSessionTask struct {

	// The Task's ID.
	Id string
	// How it is doing. `OBJECTIVE_SESSION_STATUS_WAITING` when it completed
	// asking a question or waiting on approval requests; never
	// `OBJECTIVE_SESSION_STATUS_QUEUED`.
	Status ObjectiveSessionStatus
	// When it was created.
	CreatedAt *timestamppb.Timestamp
	// When it last changed.
	UpdatedAt *timestamppb.Timestamp
	// What it asked, while it waits on the answer.
	Question string
	// The Workspace it works in. Empty without one.
	Workspace string
	// What it delivered. Unset until the Worker recorded a delivery, and for a
	// Task without one.
	Delivery *TaskDelivery
	// The status of its latest Task Attempt. Unspecified before one started.

	// Its report: the result text it ended with, cut to 400 characters. The
	// Tag wrote it, so it is untrusted text. Empty until it ended with one.
	Report string
	// Why it is held while open, or how it failed.
	Explanations []*TaskExplanation
}

func (x *ObjectiveSessionTask) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *ObjectiveSessionTask) GetStatus() ObjectiveSessionStatus {
	if x != nil {
		return x.Status
	}
	return ObjectiveSessionStatus_OBJECTIVE_SESSION_STATUS_UNSPECIFIED
}

func (x *ObjectiveSessionTask) GetCreatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.CreatedAt
	}
	return nil
}

func (x *ObjectiveSessionTask) GetUpdatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.UpdatedAt
	}
	return nil
}

func (x *ObjectiveSessionTask) GetQuestion() string {
	if x != nil {
		return x.Question
	}
	return ""
}

func (x *ObjectiveSessionTask) GetWorkspace() string {
	if x != nil {
		return x.Workspace
	}
	return ""
}

func (x *ObjectiveSessionTask) GetDelivery() *TaskDelivery {
	if x != nil {
		return x.Delivery
	}
	return nil
}

func (x *ObjectiveSessionTask) GetReport() string {
	if x != nil {
		return x.Report
	}
	return ""
}

func (x *ObjectiveSessionTask) GetExplanations() []*TaskExplanation {
	if x != nil {
		return x.Explanations
	}
	return nil
}

// Why a Task is held, or how it failed, from its stored records.
type TaskExplanation struct {

	// What it is about.
	Kind TaskExplanationKind
	// The explanation, in one or two sentences.
	Message string
	// What to do about it, usually naming a `supertag` command.
	NextAction string
	// When the record behind it was written. Unset when none was.

}

func (x *TaskExplanation) GetKind() TaskExplanationKind {
	if x != nil {
		return x.Kind
	}
	return TaskExplanationKind_TASK_EXPLANATION_KIND_UNSPECIFIED
}

func (x *TaskExplanation) GetMessage() string {
	if x != nil {
		return x.Message
	}
	return ""
}

func (x *TaskExplanation) GetNextAction() string {
	if x != nil {
		return x.NextAction
	}
	return ""
}

// A high-severity finding in a Session's latest result.
type HighFinding struct {

	// The Task whose result carries it.
	TaskId string
	// The finding's ID within that result.
	Id string
	// What was found. The Tag wrote it, so it is untrusted text.
	Summary string
	// Where, such as a file and line, when the Tag said.
	Location string
}

func (x *HighFinding) GetTaskId() string {
	if x != nil {
		return x.TaskId
	}
	return ""
}

func (x *HighFinding) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *HighFinding) GetSummary() string {
	if x != nil {
		return x.Summary
	}
	return ""
}

func (x *HighFinding) GetLocation() string {
	if x != nil {
		return x.Location
	}
	return ""
}

// What an Objective's Task Attempts wrote to one Volume.
type VolumeWrites struct {

	// The Volume's name.
	Volume string
	// Files written.
	Files int64
	// Bytes written.
	Bytes int64
	// Task Attempts whose writes were cut short.
	Partial int32
	// Task Attempts whose writes the Worker Host refused.
	Refused int32
}

func (x *VolumeWrites) GetVolume() string {
	if x != nil {
		return x.Volume
	}
	return ""
}

func (x *VolumeWrites) GetFiles() int64 {
	if x != nil {
		return x.Files
	}
	return 0
}

func (x *VolumeWrites) GetBytes() int64 {
	if x != nil {
		return x.Bytes
	}
	return 0
}

func (x *VolumeWrites) GetPartial() int32 {
	if x != nil {
		return x.Partial
	}
	return 0
}

func (x *VolumeWrites) GetRefused() int32 {
	if x != nil {
		return x.Refused
	}
	return 0
}
