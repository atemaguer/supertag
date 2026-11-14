// Presentation types of the terminal UI. They began as the generated types of the removed
// supertag.operator.v1 protos; the Control Plane's runtime.v2 replies are projected into them.

package views

import (
	"strconv"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// A Tag's phase.
type TagPhase int32

const (
	TagPhase_TAG_PHASE_UNSPECIFIED TagPhase = 0
	// It receives work.
	TagPhase_TAG_PHASE_ACTIVE TagPhase = 1
	// It was deleted. Its record stays for history; it receives no work.
	TagPhase_TAG_PHASE_RETIRED TagPhase = 2
)

// Enum value maps for TagPhase.
var (
	TagPhase_name = map[int32]string{
		0: "TAG_PHASE_UNSPECIFIED",
		1: "TAG_PHASE_ACTIVE",
		2: "TAG_PHASE_RETIRED",
	}
	TagPhase_value = map[string]int32{
		"TAG_PHASE_UNSPECIFIED": 0,
		"TAG_PHASE_ACTIVE":      1,
		"TAG_PHASE_RETIRED":     2,
	}
)

func (x TagPhase) Enum() *TagPhase {
	p := new(TagPhase)
	*p = x
	return p
}

func (x TagPhase) String() string {
	if s, ok := TagPhase_name[int32(x)]; ok {
		return s
	}
	return strconv.Itoa(int(x))
}

// A Role's phase.
type RolePhase int32

const (
	RolePhase_ROLE_PHASE_UNSPECIFIED RolePhase = 0
	// Tags may hold it.
	RolePhase_ROLE_PHASE_ACTIVE RolePhase = 1
	// It was deleted. Its record stays for history.
	RolePhase_ROLE_PHASE_RETIRED RolePhase = 2
)

// Enum value maps for RolePhase.
var (
	RolePhase_name = map[int32]string{
		0: "ROLE_PHASE_UNSPECIFIED",
		1: "ROLE_PHASE_ACTIVE",
		2: "ROLE_PHASE_RETIRED",
	}
	RolePhase_value = map[string]int32{
		"ROLE_PHASE_UNSPECIFIED": 0,
		"ROLE_PHASE_ACTIVE":      1,
		"ROLE_PHASE_RETIRED":     2,
	}
)

func (x RolePhase) Enum() *RolePhase {
	p := new(RolePhase)
	*p = x
	return p
}

func (x RolePhase) String() string {
	if s, ok := RolePhase_name[int32(
		x)]; ok {
		return s
	}
	return strconv.Itoa(int(x))
}

// One resource of any kind.
type Resource struct {

	// The resource. Exactly one is set.
	//
	// Types that are valid to be assigned to Resource:
	//
	//	*Resource_Tag
	//	*Resource_Role
	//	*Resource_PermissionSet
	//	*Resource_ContextSet
	//	*Resource_Volume
	//	*Resource_Workspace
	//	*Resource_SurfaceAccount
	//	*Resource_Objective
	//	*Resource_WorkerProfile
	Resource isResource_Resource
	// The resource's manifest, set only when the request asks for it: the
	// document `ApplyManifests` takes, with `apiVersion`, `kind`,
	// `metadata.name` and the declarable `spec` fields. It leaves out what the
	// Control Plane sets, such as IDs and timestamps, and an Objective's
	// fields at their defaults. A Surface Account's has its secret references,
	// never a value.

}

func (x *Resource) GetResource() isResource_Resource {
	if x != nil {
		return x.Resource
	}
	return nil
}

func (x *Resource) GetTag() *Tag {
	if x != nil {
		if x, ok := x.Resource.(*Resource_Tag); ok {
			return x.Tag
		}
	}
	return nil
}

func (x *Resource) GetRole() *Role {
	if x != nil {
		if x, ok := x.Resource.(*Resource_Role); ok {
			return x.Role
		}
	}
	return nil
}

func (x *Resource) GetVolume() *Volume {
	if x != nil {
		if x, ok := x.Resource.(*Resource_Volume); ok {
			return x.Volume
		}
	}
	return nil
}

func (x *Resource) GetWorkspace() *Workspace {
	if x != nil {
		if x, ok := x.Resource.(*Resource_Workspace); ok {
			return x.Workspace
		}
	}
	return nil
}

func (x *Resource) GetObjective() *DeclaredObjective {
	if x != nil {
		if x, ok := x.Resource.(*Resource_Objective); ok {
			return x.Objective
		}
	}
	return nil
}

type isResource_Resource interface {
	isResource_Resource()
}

type Resource_Tag struct {
	// A Tag.
	Tag *Tag
}

type Resource_Role struct {
	// A Role.
	Role *Role
}

type Resource_PermissionSet struct {
	// A Permission Set.

}

type Resource_ContextSet struct {
	// A Context Set.

}

type Resource_Volume struct {
	// A Volume.
	Volume *Volume
}

type Resource_Workspace struct {
	// A Workspace.
	Workspace *Workspace
}

type Resource_SurfaceAccount struct {
	// A Surface Account.

}

type Resource_Objective struct {
	// A declared Objective. Its status and history are
	// `ObjectiveService.GetObjective`'s.
	Objective *DeclaredObjective
}

type Resource_WorkerProfile struct {
	// A Worker Profile.

}

func (*Resource_Tag) isResource_Resource() {}

func (*Resource_Role) isResource_Resource() {}

func (*Resource_PermissionSet) isResource_Resource() {}

func (*Resource_ContextSet) isResource_Resource() {}

func (*Resource_Volume) isResource_Resource() {}

func (*Resource_Workspace) isResource_Resource() {}

func (*Resource_SurfaceAccount) isResource_Resource() {}

func (*Resource_Objective) isResource_Resource() {}

func (*Resource_WorkerProfile) isResource_Resource() {}

// A persistent AI actor with a stable identity, responsibilities, permissions,
// and work history. It exists independently of the model or harness that
// executes its work.
type Tag struct {

	// Its identity and version.
	Metadata *Metadata
	// What is declared.
	Spec *TagSpec
	// What the Control Plane observes.
	Status *TagStatus
}

func (x *Tag) GetMetadata() *Metadata {
	if x != nil {
		return x.Metadata
	}
	return nil
}

func (x *Tag) GetSpec() *TagSpec {
	if x != nil {
		return x.Spec
	}
	return nil
}

func (x *Tag) GetStatus() *TagStatus {
	if x != nil {
		return x.Status
	}
	return nil
}

// A Tag's declared configuration, and the `spec` of a `Tag` manifest. Apply
// merges each list entry by entry: a Role name, a Worker Host ID, a label, a
// location by provider and scope ID, and a sender Tag.
type TagSpec struct {
}

// What the Control Plane observes of a Tag.
type TagStatus struct {

	// Its phase.
	Phase TagPhase
	// When it was retired. Unset for an active Tag.

}

func (x *TagStatus) GetPhase() TagPhase {
	if x != nil {
		return x.Phase
	}
	return TagPhase_TAG_PHASE_UNSPECIFIED
}

// A Role: reusable policy for a responsibility.
type Role struct {

	// Its identity and version.
	Metadata *Metadata
	// What is declared.
	Spec *RoleSpec
	// What the Control Plane observes.
	Status *RoleStatus
}

func (x *Role) GetMetadata() *Metadata {
	if x != nil {
		return x.Metadata
	}
	return nil
}

func (x *Role) GetSpec() *RoleSpec {
	if x != nil {
		return x.Spec
	}
	return nil
}

func (x *Role) GetStatus() *RoleStatus {
	if x != nil {
		return x.Status
	}
	return nil
}

// A Role's declared policy, and the `spec` of a `Role` manifest. Apply
// merges its set lists entry by entry.
type RoleSpec struct {
}

// What the Control Plane observes of a Role.
type RoleStatus struct {

	// Its phase.
	Phase RolePhase
	// The Tags that hold it, by name.

}

func (x *RoleStatus) GetPhase() RolePhase {
	if x != nil {
		return x.Phase
	}
	return RolePhase_ROLE_PHASE_UNSPECIFIED
}

// A Volume: a named storage location outside git and the name of the
// credential that reaches it.
type Volume struct {

	// Its identity and version.
	Metadata *Metadata
	// What is declared.
	Spec *VolumeSpec
}

func (x *Volume) GetMetadata() *Metadata {
	if x != nil {
		return x.Metadata
	}
	return nil
}

func (x *Volume) GetSpec() *VolumeSpec {
	if x != nil {
		return x.Spec
	}
	return nil
}

// A Volume's source and credential name, and the `spec` of a `Volume`
// manifest. Apply replaces it whole.
type VolumeSpec struct {
}

// A Workspace: a named repository Objectives may work in.
type Workspace struct {

	// Its identity and version.
	Metadata *Metadata
	// What is declared.
	Spec *WorkspaceSpec
	// What the Control Plane observes.
	Status *WorkspaceStatus
}

func (x *Workspace) GetMetadata() *Metadata {
	if x != nil {
		return x.Metadata
	}
	return nil
}

func (x *Workspace) GetSpec() *WorkspaceSpec {
	if x != nil {
		return x.Spec
	}
	return nil
}

func (x *Workspace) GetStatus() *WorkspaceStatus {
	if x != nil {
		return x.Status
	}
	return nil
}

// A Workspace's declared fields, and the `spec` of a `Workspace` manifest.
// Every field is optional, and a manifest may leave out `spec`. A field an
// earlier apply set that a later manifest omits returns to its default.
type WorkspaceSpec struct {

	// The git remote hosts without a checkout clone. Embedded credentials are
	// refused. Required with `mounts`, and a github.com remote with
	// `pull-request` delivery.

	// The base of each new Session branch. Empty: the checkout's current
	// branch, or the source's default branch in a clone, else `main`.
	Ref string
	// One shell command, on one line, run once in each new Task worktree.

	// Server names selected from the trusted checkout's `.mcp.json`, without
	// duplicates.

	// Skill names selected from the host checkout, without duplicates.

	// Skills from a GitHub repository, selected for every Task.

	// Volumes attached at absolute paths outside the checkout. Paths may not
	// overlap each other, staged files or protected system locations.

	// How Tasks deliver their changes. Unset: `branch`.
	Delivery WorkspaceDeliveryMode
}

func (x *WorkspaceSpec) GetRef() string {
	if x != nil {
		return x.Ref
	}
	return ""
}

func (x *WorkspaceSpec) GetDelivery() WorkspaceDeliveryMode {
	if x != nil {
		return x.Delivery
	}
	return WorkspaceDeliveryMode_WORKSPACE_DELIVERY_MODE_UNSPECIFIED
}

// What the Control Plane observes of a Workspace.
type WorkspaceStatus struct {
}

// An Objective as a manifest declares it. Its status, history and spend are
// `ObjectiveService`'s.
type DeclaredObjective struct {

	// `name` is the Objective's ID.
	Metadata *Metadata
	// What is declared.
	Spec *ObjectiveDeclaration
}

func (x *DeclaredObjective) GetMetadata() *Metadata {
	if x != nil {
		return x.Metadata
	}
	return nil
}

func (x *DeclaredObjective) GetSpec() *ObjectiveDeclaration {
	if x != nil {
		return x.Spec
	}
	return nil
}

// The `spec` of an `Objective` manifest: standing work declared beside the
// Tags that do it. `metadata.name` is the Objective's ID. Owner, outcome,
// `ongoing`, Workspaces and which Team it names are fixed once it exists, and
// apply refuses a change to them. The deadline and runtime actions change,
// the budget only increases, and its own Team's fields change in place. A
// manifest that stops setting the budget, deadline or runtime actions leaves
// the stored value. A manifest has no `status`.
type ObjectiveDeclaration struct {

	// The owner Tag's name.
	Owner string
	// One natural-language statement: the result, how success is verified,
	// what must not change, and when to ask a person.
	Outcome string
	// A continuing responsibility that only an operator can end.
	Ongoing bool
	// Names of existing Workspaces its work may use.
	Workspaces []string
	// Its allocation limit.
	Budget *ObjectiveBudgetDeclaration
	// Its deadline.
	Deadline *timestamppb.Timestamp
	// Runtime actions, such as `files:write`, for turns admitted afterwards. A
	// list narrows what the owner's Permission Sets allow. Omitted from a new
	// Objective: what they allow when it is created.
	RuntimeActions []string
	// The Team whose members the owner may hand work to. In a manifest it is
	// one field, `team`: a Team's name, or the Objective's own Team.
	//
	// Types that are valid to be assigned to Team:
	//
	//	*ObjectiveDeclaration_TeamName
	//	*ObjectiveDeclaration_OwnTeam
	Team isObjectiveDeclaration_Team
}

func (x *ObjectiveDeclaration) GetOwner() string {
	if x != nil {
		return x.Owner
	}
	return ""
}

func (x *ObjectiveDeclaration) GetOutcome() string {
	if x != nil {
		return x.Outcome
	}
	return ""
}

func (x *ObjectiveDeclaration) GetOngoing() bool {
	if x != nil {
		return x.Ongoing
	}
	return false
}

func (x *ObjectiveDeclaration) GetWorkspaces() []string {
	if x != nil {
		return x.Workspaces
	}
	return nil
}

func (x *ObjectiveDeclaration) GetBudget() *ObjectiveBudgetDeclaration {
	if x != nil {
		return x.Budget
	}
	return nil
}

func (x *ObjectiveDeclaration) GetDeadline() *timestamppb.Timestamp {
	if x != nil {
		return x.Deadline
	}
	return nil
}

func (x *ObjectiveDeclaration) GetRuntimeActions() []string {
	if x != nil {
		return x.RuntimeActions
	}
	return nil
}

func (x *ObjectiveDeclaration) GetTeam() isObjectiveDeclaration_Team {
	if x != nil {
		return x.Team
	}
	return nil
}

type isObjectiveDeclaration_Team interface {
	isObjectiveDeclaration_Team()
}

type ObjectiveDeclaration_TeamName struct {
	// An existing Team, by name. Apply leaves it as it is.

}

type ObjectiveDeclaration_OwnTeam struct {
	// The Objective's own Team, whose ID is the Objective's ID. Apply creates
	// and updates it.

}

func (*ObjectiveDeclaration_TeamName) isObjectiveDeclaration_Team() {}

func (*ObjectiveDeclaration_OwnTeam) isObjectiveDeclaration_Team() {}

// An Objective's budget as a manifest declares it.
type ObjectiveBudgetDeclaration struct {

	// The limit in minor units of `currency`, or in allocation units without
	// one.

	// The ISO 4217 code, such as `USD`. With one, the budget caps
	// provider-reported cost.
	Currency string
}

func (x *ObjectiveBudgetDeclaration) GetCurrency() string {
	if x != nil {
		return x.Currency
	}
	return ""
}
