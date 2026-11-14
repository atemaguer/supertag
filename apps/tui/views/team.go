// Presentation types of the terminal UI. They began as the generated types of the removed
// supertag.operator.v1 protos; the Control Plane's runtime.v2 replies are projected into them.

package views

import (
	"google.golang.org/protobuf/types/known/timestamppb"
)

// One Team.
type Team struct {

	// The Team's ID.
	Id string
	// Its name.
	Name string
	// Its member Tags, by Tag ID.
	Members []*TeamMember
	// At most this many turns run at once across the Sessions of every open
	// Objective that names it. Unset: only Worker Host capacity limits them.
	MaxConcurrency *int32
	// Increases with every change, from 1. Pass it as `expected_revision`.
	Revision int64
	// When it was created.
	CreatedAt *timestamppb.Timestamp
	// When it last changed.
	UpdatedAt *timestamppb.Timestamp
}

func (x *Team) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *Team) GetName() string {
	if x != nil {
		return x.Name
	}
	return ""
}

func (x *Team) GetMembers() []*TeamMember {
	if x != nil {
		return x.Members
	}
	return nil
}

func (x *Team) GetMaxConcurrency() int32 {
	if x != nil && x.MaxConcurrency != nil {
		return *x.MaxConcurrency
	}
	return 0
}

func (x *Team) GetRevision() int64 {
	if x != nil {
		return x.Revision
	}
	return 0
}

func (x *Team) GetCreatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.CreatedAt
	}
	return nil
}

func (x *Team) GetUpdatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.UpdatedAt
	}
	return nil
}

// One member Tag of a Team.
type TeamMember struct {

	// The Tag's ID.
	TagId string
	// The Tag's name. Empty when the Tag was deleted.
	Tag string
}

func (x *TeamMember) GetTagId() string {
	if x != nil {
		return x.TagId
	}
	return ""
}

func (x *TeamMember) GetTag() string {
	if x != nil {
		return x.Tag
	}
	return ""
}

// One post to a Team's Workstream, which the Team's members read.
type WorkstreamPost struct {

	// The post's ID.
	Id string
	// The Team's ID.
	TeamId string
	// The ID of the member Tag that wrote it.
	AuthorTagId string
	// The IDs of the member Tags it is addressed to. Each one also receives it
	// as a Mailbox message. Every member reads the post either way.
	ToTagIds []string
	// The post. The Tag wrote it, so it is untrusted text.
	Body string
	// The Task that posted it, when a Task did.
	SourceTaskId string
	// The post's place in the Team's Workstream, from 1.
	Sequence int64
	// When it was posted.
	CreatedAt *timestamppb.Timestamp
}

func (x *WorkstreamPost) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *WorkstreamPost) GetTeamId() string {
	if x != nil {
		return x.TeamId
	}
	return ""
}

func (x *WorkstreamPost) GetAuthorTagId() string {
	if x != nil {
		return x.AuthorTagId
	}
	return ""
}

func (x *WorkstreamPost) GetToTagIds() []string {
	if x != nil {
		return x.ToTagIds
	}
	return nil
}

func (x *WorkstreamPost) GetBody() string {
	if x != nil {
		return x.Body
	}
	return ""
}

func (x *WorkstreamPost) GetSourceTaskId() string {
	if x != nil {
		return x.SourceTaskId
	}
	return ""
}

func (x *WorkstreamPost) GetSequence() int64 {
	if x != nil {
		return x.Sequence
	}
	return 0
}

func (x *WorkstreamPost) GetCreatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.CreatedAt
	}
	return nil
}
