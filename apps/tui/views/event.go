// Presentation types of the terminal UI. They began as the generated types of the removed
// supertag.operator.v1 protos; the Control Plane's runtime.v2 replies are projected into them.

package views

import (
	"strconv"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// What kind of thing changed.
type WatchKind int32

const (
	WatchKind_WATCH_KIND_UNSPECIFIED WatchKind = 0
	// A Tag was created, changed, or deleted, or its status changed. `id` is
	// the Tag's ID and `tag` its name.
	WatchKind_WATCH_KIND_TAG WatchKind = 1
	// A Session was created or changed. `id` is the Session's ID; `tag` names
	// its Tag, and `conversation` the caller's conversation when the Session is
	// one.
	WatchKind_WATCH_KIND_SESSION WatchKind = 2
	// A Task was created or its status changed. `id` is the Task's ID;
	// `session_id`, `tag`, and `objective_id` for an Objective's Task, name
	// what it belongs to.
	WatchKind_WATCH_KIND_TASK WatchKind = 3
	// An Objective was created or changed, including its status. `id` is the
	// Objective's ID and `tag` its owner Tag.
	WatchKind_WATCH_KIND_OBJECTIVE WatchKind = 4
	// An inbox item appeared, changed, or was resolved. `id` is the item's ID
	// and `objective_id` its Objective's.
	WatchKind_WATCH_KIND_INBOX_ITEM WatchKind = 5
	// An approval request was created, decided, or expired. `id` is the
	// request's ID; `task_id` names the Task that asked, and `objective_id` its
	// Objective when it has one.
	WatchKind_WATCH_KIND_APPROVAL WatchKind = 6
	// A message in one of the caller's conversations was sent, got its reply,
	// or one of its work Sessions changed. `id` is the message's Task ID, as
	// `Message.task_id`; `tag`, `conversation`, and `session_id` name its
	// conversation. Reread it with `ConversationService.GetMessage`.
	WatchKind_WATCH_KIND_CONVERSATION_MESSAGE WatchKind = 7
	// A Team's Workstream got a post. `id` is the post's ID and `team_id` its
	// Team's. Reread the Objectives the Team serves with
	// `ObjectiveService.DescribeObjective`, which carries the newest posts.
	WatchKind_WATCH_KIND_WORKSTREAM_POST WatchKind = 8
	// A Team was created, changed, including its name, members or turn limit,
	// or deleted. `id` and `team_id` are the Team's ID. Reread it with
	// `TeamService.GetTeam`, which fails with `NotFound` once it is deleted.
	WatchKind_WATCH_KIND_TEAM WatchKind = 9
)

// Enum value maps for WatchKind.
var (
	WatchKind_name = map[int32]string{
		0: "WATCH_KIND_UNSPECIFIED",
		1: "WATCH_KIND_TAG",
		2: "WATCH_KIND_SESSION",
		3: "WATCH_KIND_TASK",
		4: "WATCH_KIND_OBJECTIVE",
		5: "WATCH_KIND_INBOX_ITEM",
		6: "WATCH_KIND_APPROVAL",
		7: "WATCH_KIND_CONVERSATION_MESSAGE",
		8: "WATCH_KIND_WORKSTREAM_POST",
		9: "WATCH_KIND_TEAM",
	}
	WatchKind_value = map[string]int32{
		"WATCH_KIND_UNSPECIFIED":          0,
		"WATCH_KIND_TAG":                  1,
		"WATCH_KIND_SESSION":              2,
		"WATCH_KIND_TASK":                 3,
		"WATCH_KIND_OBJECTIVE":            4,
		"WATCH_KIND_INBOX_ITEM":           5,
		"WATCH_KIND_APPROVAL":             6,
		"WATCH_KIND_CONVERSATION_MESSAGE": 7,
		"WATCH_KIND_WORKSTREAM_POST":      8,
		"WATCH_KIND_TEAM":                 9,
	}
)

func (x WatchKind) Enum() *WatchKind {
	p := new(WatchKind)
	*p = x
	return p
}

func (x WatchKind) String() string {
	if s, ok := WatchKind_name[int32(
		x)]; ok {
		return s
	}
	return strconv.Itoa(int(x))
}

// A notice that one thing changed. Only the fields its kind names are set.
type WatchChange struct {

	// What kind of thing changed.
	Kind WatchKind
	// The ID of what changed.
	Id string
	// The name of the Tag it belongs to.
	Tag string
	// The Session it belongs to.
	SessionId string
	// The Task it belongs to.
	TaskId string
	// The Objective it belongs to.
	ObjectiveId string
	// The caller's conversation it belongs to, by name.
	Conversation string
	// What happened, in a few words for logs and people, such as `created` or
	// `status completed`. Clients do not parse it.
	Reason string
	// When the change happened.
	ChangedAt *timestamppb.Timestamp
	// The ID of the Team it belongs to.
	TeamId string
}

func (x *WatchChange) GetKind() WatchKind {
	if x != nil {
		return x.Kind
	}
	return WatchKind_WATCH_KIND_UNSPECIFIED
}

func (x *WatchChange) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *WatchChange) GetTag() string {
	if x != nil {
		return x.Tag
	}
	return ""
}

func (x *WatchChange) GetSessionId() string {
	if x != nil {
		return x.SessionId
	}
	return ""
}

func (x *WatchChange) GetTaskId() string {
	if x != nil {
		return x.TaskId
	}
	return ""
}

func (x *WatchChange) GetObjectiveId() string {
	if x != nil {
		return x.ObjectiveId
	}
	return ""
}

func (x *WatchChange) GetConversation() string {
	if x != nil {
		return x.Conversation
	}
	return ""
}

func (x *WatchChange) GetReason() string {
	if x != nil {
		return x.Reason
	}
	return ""
}

func (x *WatchChange) GetChangedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.ChangedAt
	}
	return nil
}

func (x *WatchChange) GetTeamId() string {
	if x != nil {
		return x.TeamId
	}
	return ""
}
