package client

import (
	"context"
	"regexp"
	"slices"
	"strings"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

// newTagActions are the runtime actions `supertag init` gives its lead Tag through its Permission
// Set: edit files, run commands in its Workspace, and schedule its own follow-ups. A Tag created
// here gets the same.
var newTagActions = []string{"commands:execute", "files:write", "schedule:create"}

// Harnesses are the harnesses a Tag can name, in the order they are offered, with their names.
var Harnesses = []struct{ Kind, Label string }{
	{"claude_code", "Claude Code"},
	{"codex", "Codex"},
	{"opencode", "OpenCode"},
	{"cursor", "Cursor"},
	{"openai_agents", "OpenAI Agents"},
}

// HarnessLabel is a harness's name, or its kind when it has none.
func HarnessLabel(kind string) string {
	for _, harness := range Harnesses {
		if harness.Kind == kind {
			return harness.Label
		}
	}
	return kind
}

// TagOptions are what a new Tag can run on: the harnesses and Workspaces the Control Plane's
// Worker Hosts offer, each sorted.
type TagOptions struct {
	Harnesses  []string
	Workspaces []string
}

// NewTag is a Tag to create: its permanent ID, a display name, its harness, and optionally the
// Workspace its Sessions start in.
type NewTag struct {
	ID, Name, Harness, Workspace string
}

var notTagID = regexp.MustCompile(`[^a-z0-9]+`)

// TagIDFor derives a Tag ID from a name as `supertag init` names Tags: lowercase letters, digits
// and hyphens, at most 63 characters.
func TagIDFor(name string) string {
	id := strings.Trim(notTagID.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(id) > 63 {
		id = strings.TrimRight(id[:63], "-")
	}
	return id
}

// TagAdminRefusal says why a principal cannot create Tags, or "" when it can: only operators may.
func TagAdminRefusal(principal string) string {
	if principal == "" || strings.HasPrefix(principal, "operator:") {
		return ""
	}
	return "Only an operator can create Tags. This terminal is connected as " + principal + "."
}

func harnessName(kind v2.HarnessKind) string {
	return strings.ToLower(strings.TrimPrefix(kind.String(), "HARNESS_KIND_"))
}

// ListTagOptions reads the harnesses and Workspaces of the Control Plane's current Worker Hosts.
// Only an operator may list them, as only an operator may create a Tag.
func (c *Client) ListTagOptions(ctx context.Context) (TagOptions, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var options TagOptions
	cursor := ""
	for range maxHostPages {
		res, err := c.runtime.operator.ListHosts(ctx, connect.NewRequest(&v2.ListHostsRequest{Limit: hostPage, Cursor: cursor}))
		if err != nil {
			return TagOptions{}, apiError(err)
		}
		for _, host := range res.Msg.GetHosts() {
			if host.RevokedAtMs != nil || host.RemovedAtMs != nil {
				continue
			}
			kinds := []v2.HarnessKind{host.GetHarnessKind()}
			for _, harness := range host.GetHarnesses() {
				kinds = append(kinds, harness.GetHarnessKind())
			}
			for _, kind := range kinds {
				if kind != v2.HarnessKind_HARNESS_KIND_UNSPECIFIED {
					options.Harnesses = append(options.Harnesses, harnessName(kind))
				}
			}
			options.Workspaces = append(options.Workspaces, host.GetWorkspaceIds()...)
		}
		next := res.Msg.GetNextCursor()
		if next == "" || next == cursor {
			break
		}
		cursor = next
	}
	slices.Sort(options.Harnesses)
	slices.Sort(options.Workspaces)
	options.Harnesses = slices.Compact(options.Harnesses)
	options.Workspaces = slices.Compact(options.Workspaces)
	return options, nil
}

// putTagRequest is the request that creates tag with the lead Tag's defaults. It is fenced at
// revision zero, so it never replaces another Tag.
func putTagRequest(tag NewTag) (*v2.PutTagRequest, error) {
	kind, ok := v2.HarnessKind_value["HARNESS_KIND_"+strings.ToUpper(tag.Harness)]
	if !ok || v2.HarnessKind(kind) == v2.HarnessKind_HARNESS_KIND_UNSPECIFIED {
		return nil, &APIError{Code: connect.CodeInvalidArgument, Message: "Choose a harness for the Tag."}
	}
	if tag.ID == "" {
		return nil, &APIError{Code: connect.CodeInvalidArgument, Message: "Name the Tag with letters or digits."}
	}
	zero := uint64(0)
	request := &v2.PutTagRequest{TagId: tag.ID, HarnessKind: v2.HarnessKind(kind),
		AllowedActions: slices.Clone(newTagActions), ExpectedRevision: &zero}
	if name := strings.TrimSpace(tag.Name); name != "" && name != tag.ID {
		request.Name = &name
	}
	if tag.Workspace != "" {
		request.Workspace = &v2.WorkspaceSpec{WorkspaceId: tag.Workspace}
	}
	return request, nil
}

// CreateTag creates a Tag, refusing an ID or name another Tag holds.
func (c *Client) CreateTag(ctx context.Context, tag NewTag) (*views.Tag, error) {
	request, err := putTagRequest(tag)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.runtime.operator.PutTag(ctx, connect.NewRequest(request))
	if err != nil {
		switch connect.CodeOf(err) {
		case connect.CodeAlreadyExists:
			return nil, &APIError{Code: connect.CodeAlreadyExists, Message: "A Tag with that ID or name already exists."}
		case connect.CodePermissionDenied:
			return nil, &APIError{Code: connect.CodePermissionDenied, Message: "Only an operator can create Tags."}
		}
		return nil, apiError(err)
	}
	name := res.Msg.GetName()
	if name == "" {
		name = res.Msg.GetTagId()
	}
	return &views.Tag{Metadata: &views.Metadata{Id: res.Msg.GetTagId(), Name: name},
		Spec: &views.TagSpec{Lead: res.Msg.GetLead()}, Status: &views.TagStatus{Phase: views.TagPhase_TAG_PHASE_ACTIVE}}, nil
}
