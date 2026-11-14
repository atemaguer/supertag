// Presentation types of the terminal UI. They began as the generated types of the removed
// supertag.operator.v1 protos; the Control Plane's runtime.v2 replies are projected into them.

package views

import (
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Identifies and versions a resource.
type Metadata struct {

	// The stable ID the Control Plane assigned.
	Id string
	// The unique name within the resource's kind.
	Name string
	// Changes whenever the resource changes. Compare it for equality only.

	// When the resource was created.
	CreatedAt *timestamppb.Timestamp
	// When the resource last changed.
	UpdatedAt *timestamppb.Timestamp
}

func (x *Metadata) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *Metadata) GetName() string {
	if x != nil {
		return x.Name
	}
	return ""
}

func (x *Metadata) GetCreatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.CreatedAt
	}
	return nil
}

func (x *Metadata) GetUpdatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.UpdatedAt
	}
	return nil
}

// What a server stream sends after 15 seconds without another event, so
// proxies keep an idle connection open. It carries no state.
type Heartbeat struct {
}
