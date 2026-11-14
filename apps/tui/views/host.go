// Presentation types of the terminal UI. They began as the generated types of the removed
// supertag.operator.v1 protos; the Control Plane's runtime.v2 replies are projected into them.

package views

import (
	"strconv"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// A Worker Host's phase. Revocation wins over everything else, then a lost
// connection, then draining.
type WorkerHostPhase int32

const (
	WorkerHostPhase_WORKER_HOST_PHASE_UNSPECIFIED WorkerHostPhase = 0
	// Connected but not ready to take Tasks.
	WorkerHostPhase_WORKER_HOST_PHASE_CONNECTED WorkerHostPhase = 1
	// It finishes accepted work and takes no new Tasks.
	WorkerHostPhase_WORKER_HOST_PHASE_DRAINING WorkerHostPhase = 2
	// Connected and taking Tasks.
	WorkerHostPhase_WORKER_HOST_PHASE_READY WorkerHostPhase = 3
	// Revoked. It never connects again.
	WorkerHostPhase_WORKER_HOST_PHASE_REVOKED WorkerHostPhase = 4
	// Its Worklet is not connected.
	WorkerHostPhase_WORKER_HOST_PHASE_UNREACHABLE WorkerHostPhase = 5
)

// Enum value maps for WorkerHostPhase.
var (
	WorkerHostPhase_name = map[int32]string{
		0: "WORKER_HOST_PHASE_UNSPECIFIED",
		1: "WORKER_HOST_PHASE_CONNECTED",
		2: "WORKER_HOST_PHASE_DRAINING",
		3: "WORKER_HOST_PHASE_READY",
		4: "WORKER_HOST_PHASE_REVOKED",
		5: "WORKER_HOST_PHASE_UNREACHABLE",
	}
	WorkerHostPhase_value = map[string]int32{
		"WORKER_HOST_PHASE_UNSPECIFIED": 0,
		"WORKER_HOST_PHASE_CONNECTED":   1,
		"WORKER_HOST_PHASE_DRAINING":    2,
		"WORKER_HOST_PHASE_READY":       3,
		"WORKER_HOST_PHASE_REVOKED":     4,
		"WORKER_HOST_PHASE_UNREACHABLE": 5,
	}
)

func (x WorkerHostPhase) Enum() *WorkerHostPhase {
	p := new(WorkerHostPhase)
	*p = x
	return p
}

func (x WorkerHostPhase) String() string {
	if s, ok := WorkerHostPhase_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

// Whether a Worker Host's Worklet is connected.
type WorkerHostConnection int32

const (
	WorkerHostConnection_WORKER_HOST_CONNECTION_UNSPECIFIED WorkerHostConnection = 0
	// It is connected.
	WorkerHostConnection_WORKER_HOST_CONNECTION_CONNECTED WorkerHostConnection = 1
	// It is not connected.
	WorkerHostConnection_WORKER_HOST_CONNECTION_DISCONNECTED WorkerHostConnection = 2
)

// Enum value maps for WorkerHostConnection.
var (
	WorkerHostConnection_name = map[int32]string{
		0: "WORKER_HOST_CONNECTION_UNSPECIFIED",
		1: "WORKER_HOST_CONNECTION_CONNECTED",
		2: "WORKER_HOST_CONNECTION_DISCONNECTED",
	}
	WorkerHostConnection_value = map[string]int32{
		"WORKER_HOST_CONNECTION_UNSPECIFIED":  0,
		"WORKER_HOST_CONNECTION_CONNECTED":    1,
		"WORKER_HOST_CONNECTION_DISCONNECTED": 2,
	}
)

func (x WorkerHostConnection) Enum() *WorkerHostConnection {
	p := new(WorkerHostConnection)
	*p = x
	return p
}

func (x WorkerHostConnection) String() string {
	if s, ok := WorkerHostConnection_name[int32(x)]; ok {
		return s
	}
	return strconv.Itoa(int(x))
}

// One Worker Host, as the Control Plane last recorded it.
type WorkerHost struct {

	// `id` and `name` are both the host's ID. `resource_version` changes when
	// any field of this view changes.
	Metadata *Metadata
	// Whether an operator or the host itself drained it.
	Draining bool
	// Its phase, derived from the fields below.
	Phase WorkerHostPhase
	// Free and total space on the filesystem the host uses for Task Attempt
	// scratch, as it last reported. Unset when it never reported.

	// It joined with an ephemeral Auth Key, so it is revoked after it
	// disconnects with no open Task Attempts.

	// Where the host's Task Attempts kept their files, from the placements the
	// Control Plane recorded. Set only by `ListWorkerHosts` and
	// `GetWorkerHost`.

	// The name of the Auth Key the host redeemed to join. Empty when an
	// operator enrolled it.

	// Increases with every credential rotation, from 1. Pass it as
	// `RotateWorkerHostCredentialRequest.expected_credential_revision`.
	CredentialRevision int64
	// Increases with every connection, so only the current connection may
	// report.
	ConnectionGeneration int64
	// Whether its Worklet is connected.
	ConnectionStatus WorkerHostConnection
	// The ID of its current or last Worklet. Empty when it never connected.

	// The Worklet protocol version it connected with. Unset when it never
	// connected.
	ProtocolVersion *int32
	// The durable transport extension version it connected with. Unset when
	// its Worklet does not support it.

	// The durable control extension version it connected with. Unset when its
	// Worklet does not support it.

	// Each Worker the host's Worklet advertised, in the Worklet protocol's
	// `WorkerDescriptor` JSON form: `id`, `type`, `capabilities`, `profiles`,
	// `profileCapabilities` (harness, models, efforts and capabilities per
	// Worker Profile), `contextTypes` and `maxConcurrency`. The host reports
	// them, so they are untrusted.

	// The names of the Workspaces with a checkout declared on the host. Paths
	// stay on the host.
	Workspaces []string
	// Its placement labels: those it advertised, which are self-reported, and
	// those its Auth Key granted. Sorted.

	// The labels its Auth Key granted. Sorted.

	// Whether it can take Tasks now.
	Ready bool
	// When its credential last claimed a connection. Unset when it never did.

	// How many connection claims with a wrong credential were refused.

	// When a claim was last refused. Unset when none was.

	// When it last reported. Unset when it never did.
	LastSeenAt *timestamppb.Timestamp
	// When its current or last connection began. Unset when it never
	// connected.

	// When its last connection ended. Unset while its first connection lasts
	// or when it never connected.

	// When it was revoked. Unset while it is enrolled.
	RevokedAt *timestamppb.Timestamp
	// Why it was revoked: `OperatorRevoked`, `SelfRevoked` or
	// `EphemeralDisconnected`. Empty while it is enrolled.

	// Task Attempts running on it.
	ActiveAttempts int32
	// How many Task Attempts it runs at once.
	Capacity int32
	// How many more it can take now.
	AvailableSlots int32
}

func (x *WorkerHost) GetMetadata() *Metadata {
	if x != nil {
		return x.Metadata
	}
	return nil
}

func (x *WorkerHost) GetDraining() bool {
	if x != nil {
		return x.Draining
	}
	return false
}

func (x *WorkerHost) GetPhase() WorkerHostPhase {
	if x != nil {
		return x.Phase
	}
	return WorkerHostPhase_WORKER_HOST_PHASE_UNSPECIFIED
}

func (x *WorkerHost) GetCredentialRevision() int64 {
	if x != nil {
		return x.CredentialRevision
	}
	return 0
}

func (x *WorkerHost) GetConnectionGeneration() int64 {
	if x != nil {
		return x.ConnectionGeneration
	}
	return 0
}

func (x *WorkerHost) GetConnectionStatus() WorkerHostConnection {
	if x != nil {
		return x.ConnectionStatus
	}
	return WorkerHostConnection_WORKER_HOST_CONNECTION_UNSPECIFIED
}

func (x *WorkerHost) GetProtocolVersion() int32 {
	if x != nil && x.ProtocolVersion != nil {
		return *x.ProtocolVersion
	}
	return 0
}

func (x *WorkerHost) GetWorkspaces() []string {
	if x != nil {
		return x.Workspaces
	}
	return nil
}

func (x *WorkerHost) GetReady() bool {
	if x != nil {
		return x.Ready
	}
	return false
}

func (x *WorkerHost) GetLastSeenAt() *timestamppb.Timestamp {
	if x != nil {
		return x.LastSeenAt
	}
	return nil
}

func (x *WorkerHost) GetRevokedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.RevokedAt
	}
	return nil
}

func (x *WorkerHost) GetActiveAttempts() int32 {
	if x != nil {
		return x.ActiveAttempts
	}
	return 0
}

func (x *WorkerHost) GetCapacity() int32 {
	if x != nil {
		return x.Capacity
	}
	return 0
}

func (x *WorkerHost) GetAvailableSlots() int32 {
	if x != nil {
		return x.AvailableSlots
	}
	return 0
}
