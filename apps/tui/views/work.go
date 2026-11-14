// Presentation types of the terminal UI. They began as the generated types of the removed
// supertag.operator.v1 protos; the Control Plane's runtime.v2 replies are projected into them.

package views

import (
	"strconv"

	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Where a Session stands.
type SessionPhase int32

const (
	SessionPhase_SESSION_PHASE_UNSPECIFIED SessionPhase = 0
	// It takes new turns.
	SessionPhase_SESSION_PHASE_OPEN SessionPhase = 1
)

// Enum value maps for SessionPhase.
var (
	SessionPhase_name = map[int32]string{
		0: "SESSION_PHASE_UNSPECIFIED",
		1: "SESSION_PHASE_OPEN",
	}
	SessionPhase_value = map[string]int32{
		"SESSION_PHASE_UNSPECIFIED": 0,
		"SESSION_PHASE_OPEN":        1,
	}
)

func (x SessionPhase) Enum() *SessionPhase {
	p := new(SessionPhase)
	*p = x
	return p
}

func (x SessionPhase) String() string {
	if s, ok := SessionPhase_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

// One Task: a turn of a Session, and how it ran.
type Task struct {

	// The Task's ID.
	Id string
	// Changes whenever the view changes, apart from `storage`. Compare it for
	// equality only.

	// The ID of the Tag that runs it.
	TagId string
	// That Tag's name. Empty when the Tag no longer exists.
	Tag string
	// Its Session's ID.
	SessionId string
	// The Objective its Session belongs to. Empty outside an Objective.
	ObjectiveId string
	// How it is doing.
	Status TaskStatus
	// When it was created.
	CreatedAt *timestamppb.Timestamp
	// When it last changed.
	UpdatedAt *timestamppb.Timestamp
	// When it started running. Unset until it did.

	// When it ended. Unset while it is open.

	// What the Task requires of the Worker that runs it, as recorded when it
	// was accepted.

	// What started the Task, as recorded when it was accepted: the inbound
	// event, delegation or schedule, with its references. The record's fields
	// depend on what started it, so it is a JSON object. Collaboration
	// surfaces shape parts of it, so it is untrusted text.

	// The named Workspace and the Task's branch, recorded when it was
	// accepted. Unset for a Task without a named Workspace.
	Workspace *TaskWorkspace
	// How the Task ended, as the Control Plane recorded it: a JSON object such
	// as `{"status": "completed"}` with the reason for a failure or
	// cancellation. Unset while it is open.
	Outcome *structpb.Struct
	// The findings its result carries, or why they are unreadable. Unset when
	// it has none.

	// How the harness, model and effort were chosen, and what the latest Task
	// Attempt ran with. Unset when nothing was recorded.

	// Skills delivered to the latest Task Attempt.

	// The prepared Workspace environment the latest Task Attempt used, when
	// its Worker reported one.

	// Every Task Attempt, oldest first.

	// The latest Task Attempt in detail. Unset before one started.

	// The last placement check of the Task's requirements against the bound
	// Worker Hosts. Unset before one was recorded. Clients show it while the
	// Task is `TASK_STATUS_PENDING`.

	// The pull request a Worker opened for `WORKSPACE_DELIVERY_MODE_PULL_REQUEST`
	// delivery, from the moment it was recorded, before `delivery` carries it.
	PullRequest *PullRequestDelivery
	// What the Task delivered. Unset until the Worker recorded a delivery.
	Delivery *TaskDelivery
	// Where the latest Task Attempt's files and the Task's artifacts are
	// kept. Set by `GetTask` only.

}

func (x *Task) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *Task) GetTagId() string {
	if x != nil {
		return x.TagId
	}
	return ""
}

func (x *Task) GetTag() string {
	if x != nil {
		return x.Tag
	}
	return ""
}

func (x *Task) GetSessionId() string {
	if x != nil {
		return x.SessionId
	}
	return ""
}

func (x *Task) GetObjectiveId() string {
	if x != nil {
		return x.ObjectiveId
	}
	return ""
}

func (x *Task) GetStatus() TaskStatus {
	if x != nil {
		return x.Status
	}
	return TaskStatus_TASK_STATUS_UNSPECIFIED
}

func (x *Task) GetCreatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.CreatedAt
	}
	return nil
}

func (x *Task) GetUpdatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.UpdatedAt
	}
	return nil
}

func (x *Task) GetWorkspace() *TaskWorkspace {
	if x != nil {
		return x.Workspace
	}
	return nil
}

func (x *Task) GetOutcome() *structpb.Struct {
	if x != nil {
		return x.Outcome
	}
	return nil
}

func (x *Task) GetPullRequest() *PullRequestDelivery {
	if x != nil {
		return x.PullRequest
	}
	return nil
}

func (x *Task) GetDelivery() *TaskDelivery {
	if x != nil {
		return x.Delivery
	}
	return nil
}

// The named Workspace a Task works in.
type TaskWorkspace struct {

	// The Workspace's name.
	Name string
	// The Task's branch.
	Branch string
	// The ref the branch starts from, when the Workspace names one.
	Ref string
	// How the Workspace delivers.
	Delivery WorkspaceDeliveryMode
}

func (x *TaskWorkspace) GetName() string {
	if x != nil {
		return x.Name
	}
	return ""
}

func (x *TaskWorkspace) GetBranch() string {
	if x != nil {
		return x.Branch
	}
	return ""
}

func (x *TaskWorkspace) GetRef() string {
	if x != nil {
		return x.Ref
	}
	return ""
}

func (x *TaskWorkspace) GetDelivery() WorkspaceDeliveryMode {
	if x != nil {
		return x.Delivery
	}
	return WorkspaceDeliveryMode_WORKSPACE_DELIVERY_MODE_UNSPECIFIED
}

// Where a Task Attempt's files are: a Workspace checkout on its Worker Host,
// or a remote sandbox.
type TaskFiles struct {

	// The Worker Host that ran the Task Attempt.
	WorkerHostId string
	// Whether that Worker Host joined with an ephemeral Auth Key, so its files
	// are lost when it stops.

}

func (x *TaskFiles) GetWorkerHostId() string {
	if x != nil {
		return x.WorkerHostId
	}
	return ""
}

// One event recorded about a Task or one of its Task Attempts.
type TaskEvent struct {

	// The event's ID.
	Id string
	// The Task's ID.
	TaskId string
	// The Task Attempt it is about. Empty for an event about the Task.
	AttemptId string
	// Its place in the Task's events, from 1.
	Sequence int64
	// What happened, such as `task.created`, `execution.started` or
	// `command.updated`.
	Type string
	// The event's record, a JSON object whose fields depend on `type`. Worker
	// events carry what the Worker reported after its redaction policy, so
	// they are untrusted text. Unset for an event without one.
	Payload *structpb.Struct
	// When it was recorded.
	CreatedAt *timestamppb.Timestamp
}

func (x *TaskEvent) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *TaskEvent) GetTaskId() string {
	if x != nil {
		return x.TaskId
	}
	return ""
}

func (x *TaskEvent) GetAttemptId() string {
	if x != nil {
		return x.AttemptId
	}
	return ""
}

func (x *TaskEvent) GetSequence() int64 {
	if x != nil {
		return x.Sequence
	}
	return 0
}

func (x *TaskEvent) GetType() string {
	if x != nil {
		return x.Type
	}
	return ""
}

func (x *TaskEvent) GetPayload() *structpb.Struct {
	if x != nil {
		return x.Payload
	}
	return nil
}

func (x *TaskEvent) GetCreatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.CreatedAt
	}
	return nil
}

// One Session.
type Session struct {

	// The Session's ID.
	Id string
	// Changes whenever the Session changes. Compare it for equality only.

	// The ID of its Tag.
	TagId string
	// That Tag's name. Empty when the Tag no longer exists.
	Tag string
	// The key that routes its turns, such as a thread or a private operator conversation.

	// Where it started, as recorded when it opened: a JSON object whose fields
	// depend on what started it, such as a work Session's `title`.
	// Collaboration surfaces shape parts of it, so it is untrusted text.

	// Where it stands.
	Phase SessionPhase
	// Who its replies are for.

	// The Session that started this work Session. Empty for a Session no turn
	// started.
	ParentSessionId string
	// The Objective it belongs to: the Objective's own conversation, or a work
	// Session started under it. Empty otherwise.
	ObjectiveId string
	// A work Session's title, or how the Session began, such as its first
	// request shortened to 60 characters, `Objective ID` or `Inbox`. Empty
	// when there is nothing to name it by. Untrusted text.
	Title string
	// Its latest Task's ID. Empty before it has one.
	LatestTaskId string
	// Its latest Task's status. Unspecified before it has one.
	LatestTaskStatus TaskStatus
	// When it last had a turn.

	// When it was created.
	CreatedAt *timestamppb.Timestamp
	// When it last changed.
	UpdatedAt *timestamppb.Timestamp
	// What its latest delivering Task delivered. Set by `GetSession` only, and
	// unset when no Task of it delivered anything.
	Delivery *SessionDelivery
}

func (x *Session) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *Session) GetTagId() string {
	if x != nil {
		return x.TagId
	}
	return ""
}

func (x *Session) GetTag() string {
	if x != nil {
		return x.Tag
	}
	return ""
}

func (x *Session) GetPhase() SessionPhase {
	if x != nil {
		return x.Phase
	}
	return SessionPhase_SESSION_PHASE_UNSPECIFIED
}

func (x *Session) GetParentSessionId() string {
	if x != nil {
		return x.ParentSessionId
	}
	return ""
}

func (x *Session) GetObjectiveId() string {
	if x != nil {
		return x.ObjectiveId
	}
	return ""
}

func (x *Session) GetTitle() string {
	if x != nil {
		return x.Title
	}
	return ""
}

func (x *Session) GetLatestTaskId() string {
	if x != nil {
		return x.LatestTaskId
	}
	return ""
}

func (x *Session) GetLatestTaskStatus() TaskStatus {
	if x != nil {
		return x.LatestTaskStatus
	}
	return TaskStatus_TASK_STATUS_UNSPECIFIED
}

func (x *Session) GetCreatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.CreatedAt
	}
	return nil
}

func (x *Session) GetUpdatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.UpdatedAt
	}
	return nil
}

func (x *Session) GetDelivery() *SessionDelivery {
	if x != nil {
		return x.Delivery
	}
	return nil
}

// What a Session's latest delivering Task delivered, for review. A client
// shows the branch's changes by diffing `base` and `head` of
// `delivery.workspace` in its own checkout of the Workspace; the Control
// Plane keeps no repository contents.
type SessionDelivery struct {

	// The Task that delivered it: the latest Task of the Session whose
	// delivery the Worker recorded.
	TaskId string
	// What it delivered: the Workspace branch with its base and head commits,
	// patches, the pull request with its web address, and outputs.
	Delivery *TaskDelivery
	// Where the branch's checkout is. Unset when the Task Attempt recorded no
	// Worker Host.
	Checkout *TaskFiles
}

func (x *SessionDelivery) GetTaskId() string {
	if x != nil {
		return x.TaskId
	}
	return ""
}

func (x *SessionDelivery) GetDelivery() *TaskDelivery {
	if x != nil {
		return x.Delivery
	}
	return nil
}

func (x *SessionDelivery) GetCheckout() *TaskFiles {
	if x != nil {
		return x.Checkout
	}
	return nil
}
