// Presentation types of the terminal UI. They began as the generated types of the removed
// supertag.operator.v1 protos; the Control Plane's runtime.v2 replies are projected into them.

package views

import (
	"strconv"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// How a Task is doing.
type TaskStatus int32

const (
	TaskStatus_TASK_STATUS_UNSPECIFIED TaskStatus = 0
	// It waits to run: for a Worker Host that can place it, for its Objective to
	// resume, or for capacity.
	TaskStatus_TASK_STATUS_PENDING TaskStatus = 1
	// A Task Attempt runs it.
	TaskStatus_TASK_STATUS_RUNNING TaskStatus = 2
	// It completed.
	TaskStatus_TASK_STATUS_COMPLETED TaskStatus = 3
	// It failed.
	TaskStatus_TASK_STATUS_FAILED TaskStatus = 4
	// It was cancelled.
	TaskStatus_TASK_STATUS_CANCELLED TaskStatus = 5
)

// Enum value maps for TaskStatus.
var (
	TaskStatus_name = map[int32]string{
		0: "TASK_STATUS_UNSPECIFIED",
		1: "TASK_STATUS_PENDING",
		2: "TASK_STATUS_RUNNING",
		3: "TASK_STATUS_COMPLETED",
		4: "TASK_STATUS_FAILED",
		5: "TASK_STATUS_CANCELLED",
	}
	TaskStatus_value = map[string]int32{
		"TASK_STATUS_UNSPECIFIED": 0,
		"TASK_STATUS_PENDING":     1,
		"TASK_STATUS_RUNNING":     2,
		"TASK_STATUS_COMPLETED":   3,
		"TASK_STATUS_FAILED":      4,
		"TASK_STATUS_CANCELLED":   5,
	}
)

func (x TaskStatus) Enum() *TaskStatus {
	p := new(TaskStatus)
	*p = x
	return p
}

func (x TaskStatus) String() string {
	if s, ok := TaskStatus_name[int32(x)]; ok {
		return s
	}
	return strconv.Itoa(int(x))
}

// How a Task's Workspace changes come back.
type WorkspaceDeliveryMode int32

const (
	WorkspaceDeliveryMode_WORKSPACE_DELIVERY_MODE_UNSPECIFIED WorkspaceDeliveryMode = 0
	// As patch artifacts.
	WorkspaceDeliveryMode_WORKSPACE_DELIVERY_MODE_PATCH WorkspaceDeliveryMode = 1
	// As a branch in the Workspace's checkout on the Worker Host.
	WorkspaceDeliveryMode_WORKSPACE_DELIVERY_MODE_BRANCH WorkspaceDeliveryMode = 2
	// As a GitHub pull request.
	WorkspaceDeliveryMode_WORKSPACE_DELIVERY_MODE_PULL_REQUEST WorkspaceDeliveryMode = 3
)

// Enum value maps for WorkspaceDeliveryMode.
var (
	WorkspaceDeliveryMode_name = map[int32]string{
		0: "WORKSPACE_DELIVERY_MODE_UNSPECIFIED",
		1: "WORKSPACE_DELIVERY_MODE_PATCH",
		2: "WORKSPACE_DELIVERY_MODE_BRANCH",
		3: "WORKSPACE_DELIVERY_MODE_PULL_REQUEST",
	}
	WorkspaceDeliveryMode_value = map[string]int32{
		"WORKSPACE_DELIVERY_MODE_UNSPECIFIED":  0,
		"WORKSPACE_DELIVERY_MODE_PATCH":        1,
		"WORKSPACE_DELIVERY_MODE_BRANCH":       2,
		"WORKSPACE_DELIVERY_MODE_PULL_REQUEST": 3,
	}
)

func (x WorkspaceDeliveryMode) Enum() *WorkspaceDeliveryMode {
	p := new(WorkspaceDeliveryMode)
	*p = x
	return p
}

func (x WorkspaceDeliveryMode) String() string {
	if s, ok := WorkspaceDeliveryMode_name[int32(x)]; ok {
		return s
	}
	return strconv.Itoa(int(x))
}

// Whether a delivered pull request is open for review.
type PullRequestState int32

const (
	PullRequestState_PULL_REQUEST_STATE_UNSPECIFIED PullRequestState = 0
	// Open as a draft.
	PullRequestState_PULL_REQUEST_STATE_DRAFT PullRequestState = 1
	// Open and ready for review.
	PullRequestState_PULL_REQUEST_STATE_READY PullRequestState = 2
	// Closed.
	PullRequestState_PULL_REQUEST_STATE_CLOSED PullRequestState = 3
)

// Enum value maps for PullRequestState.
var (
	PullRequestState_name = map[int32]string{
		0: "PULL_REQUEST_STATE_UNSPECIFIED",
		1: "PULL_REQUEST_STATE_DRAFT",
		2: "PULL_REQUEST_STATE_READY",
		3: "PULL_REQUEST_STATE_CLOSED",
	}
	PullRequestState_value = map[string]int32{
		"PULL_REQUEST_STATE_UNSPECIFIED": 0,
		"PULL_REQUEST_STATE_DRAFT":       1,
		"PULL_REQUEST_STATE_READY":       2,
		"PULL_REQUEST_STATE_CLOSED":      3,
	}
)

func (x PullRequestState) Enum() *PullRequestState {
	p := new(PullRequestState)
	*p = x
	return p
}

func (x PullRequestState) String() string {
	if s, ok := PullRequestState_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

// What a finished Task delivered for a person to look at: a branch in its
// Workspace, patches, a pull request, and output files. Every part is empty
// when the Task delivered nothing.
type TaskDelivery struct {

	// The Task's Workspace delivery. Unset for a Task without a named
	// Workspace.
	Workspace *WorkspaceDelivery
	// The patch artifacts of `WORKSPACE_DELIVERY_MODE_PATCH` delivery.
	Patches []*PatchDelivery
	// The pull request of `WORKSPACE_DELIVERY_MODE_PULL_REQUEST` delivery,
	// once it was opened.
	PullRequest *PullRequestDelivery
	// Other files the Task captured as output artifacts.
	Outputs []*OutputDelivery
}

func (x *TaskDelivery) GetWorkspace() *WorkspaceDelivery {
	if x != nil {
		return x.Workspace
	}
	return nil
}

func (x *TaskDelivery) GetPatches() []*PatchDelivery {
	if x != nil {
		return x.Patches
	}
	return nil
}

func (x *TaskDelivery) GetPullRequest() *PullRequestDelivery {
	if x != nil {
		return x.PullRequest
	}
	return nil
}

func (x *TaskDelivery) GetOutputs() []*OutputDelivery {
	if x != nil {
		return x.Outputs
	}
	return nil
}

// The branch a Task committed to in its Workspace.
type WorkspaceDelivery struct {

	// The Workspace's name.
	Name string
	// How the Workspace delivers.
	Mode WorkspaceDeliveryMode
	// The Task's branch.
	Branch string
	// The base ref the branch started from, such as `main`, when the Workspace
	// names one.
	Ref string
	// The branch head the Worker recorded with the result. Empty until the
	// Worker recorded one; a branch without a head delivered nothing yet.
	Head string
	// How many files changed on the branch since its base, as the Worker
	// reported them. Unset when the Worker reported no count.
	ChangedFiles *int32
	// The commit the branch started from, as the Worker reported it.
	Base string
}

func (x *WorkspaceDelivery) GetName() string {
	if x != nil {
		return x.Name
	}
	return ""
}

func (x *WorkspaceDelivery) GetMode() WorkspaceDeliveryMode {
	if x != nil {
		return x.Mode
	}
	return WorkspaceDeliveryMode_WORKSPACE_DELIVERY_MODE_UNSPECIFIED
}

func (x *WorkspaceDelivery) GetBranch() string {
	if x != nil {
		return x.Branch
	}
	return ""
}

func (x *WorkspaceDelivery) GetRef() string {
	if x != nil {
		return x.Ref
	}
	return ""
}

func (x *WorkspaceDelivery) GetHead() string {
	if x != nil {
		return x.Head
	}
	return ""
}

func (x *WorkspaceDelivery) GetChangedFiles() int32 {
	if x != nil && x.ChangedFiles != nil {
		return *x.ChangedFiles
	}
	return 0
}

func (x *WorkspaceDelivery) GetBase() string {
	if x != nil {
		return x.Base
	}
	return ""
}

// One patch artifact.
type PatchDelivery struct {

	// The artifact's ID, for `supertag download artifact`.
	ArtifactId string
	// The patch file's path within the artifact.
	Path string
}

func (x *PatchDelivery) GetArtifactId() string {
	if x != nil {
		return x.ArtifactId
	}
	return ""
}

func (x *PatchDelivery) GetPath() string {
	if x != nil {
		return x.Path
	}
	return ""
}

// A GitHub pull request a Task opened.
type PullRequestDelivery struct {

	// The ID of the Surface Account that opened it, when one is recorded.

	// The repository as `owner/name`.
	Repository string
	// The pull request's number.
	Number int32
	// The pull request's web address.
	Url string
	// Whether it is a draft, ready, or closed.
	State PullRequestState
	// Why the Control Plane's last update to it failed. Empty when it did not.
	LastError string
	// When the Control Plane retries that update. Unset when it does not retry.
	NextAttemptAt *timestamppb.Timestamp
}

func (x *PullRequestDelivery) GetRepository() string {
	if x != nil {
		return x.Repository
	}
	return ""
}

func (x *PullRequestDelivery) GetNumber() int32 {
	if x != nil {
		return x.Number
	}
	return 0
}

func (x *PullRequestDelivery) GetUrl() string {
	if x != nil {
		return x.Url
	}
	return ""
}

func (x *PullRequestDelivery) GetState() PullRequestState {
	if x != nil {
		return x.State
	}
	return PullRequestState_PULL_REQUEST_STATE_UNSPECIFIED
}

func (x *PullRequestDelivery) GetLastError() string {
	if x != nil {
		return x.LastError
	}
	return ""
}

func (x *PullRequestDelivery) GetNextAttemptAt() *timestamppb.Timestamp {
	if x != nil {
		return x.NextAttemptAt
	}
	return nil
}

// One output artifact and the files in it.
type OutputDelivery struct {

	// The artifact's ID, for `supertag download artifact`.
	ArtifactId string
	// The paths of its files.
	Paths []string
}

func (x *OutputDelivery) GetArtifactId() string {
	if x != nil {
		return x.ArtifactId
	}
	return ""
}

func (x *OutputDelivery) GetPaths() []string {
	if x != nil {
		return x.Paths
	}
	return nil
}
