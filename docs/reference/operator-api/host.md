# HostService

<!-- Generated from spec/proto/supertag/operator/v1 by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->

`supertag.operator.v1.HostService` in [`host.proto`](../../../spec/proto/supertag/operator/v1/host.proto). How to call an RPC, authenticate, and
read its errors is in the [Control Plane API Server](../control-plane-api.md) guide; the conventions every
RPC follows are in [Shared messages and options](shared.md#conventions).

Worker Hosts and the Auth Keys that join them: `supertag list worker-host`,
`get worker-host`, `describe worker-host`, `enroll worker-host`, `drain
worker-host`, `resume worker-host`, `rotate worker-host-credential`,
`revoke worker-host-credential`, `update tag --add-worker-host` and
`--remove-worker-host`, `create auth-key`, `list auth-key`, `get auth-key`
and `revoke auth-key`, and joining with an Auth Key in `supertag connect
worklet` and `supertag up`.

A Worker Host is a machine that runs Tasks for the Tags bound to it. Its
Worklet connects to the Control Plane with the host's credential. An
operator enrolls a host and receives its first credential, or creates an
Auth Key that a machine redeems with `JoinWorkerHost` to join by itself.

Every view is built from what each host last reported to the Control
Plane, never a live probe of the machine. A Control Plane that runs its own
Worklet in process, without a Worker Host record, lists that Worklet's host
too, and its ID cannot be enrolled.

Access. The admin token and Operator Tokens may call every RPC except
`JoinWorkerHost`, which takes an Auth Key instead; a scoped coordination
credential is refused with `PermissionDenied`. Every caller sees every
Worker Host and Auth Key. A Worker Host's own credential may drain, resume
and revoke that host, as `supertag up`, `supertag down` and `supertag
revoke worker-host-credential` do without operator access, and may call
nothing else.

Every RPC that names a Worker Host takes its ID, and fails with
`InvalidArgument` for an empty one and, unless it says otherwise,
`NotFound` for a host that was never enrolled. Every RPC that names an Auth Key takes its name, and fails with
`InvalidArgument` for an empty one and `NotFound` for a key that does not
exist. A call while the Control Plane drains fails with `Unavailable` and
`ERROR_REASON_DRAINING`.

## RPCs

### ListWorkerHosts

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/ListWorkerHosts` |
| Request | [`ListWorkerHostsRequest`](#listworkerhostsrequest) |
| Response | [`ListWorkerHostsResponse`](#listworkerhostsresponse) |
| Action | `read_worker_host` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists Worker Hosts, the earliest enrolled first, then by ID, as `supertag
list worker-host` shows them. A host that joined with an ephemeral Auth
Key and was revoked after it disconnected is left out; `GetWorkerHost`
still reads it. It fails with `InvalidArgument` for a malformed
`page_token`.

### GetWorkerHost

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/GetWorkerHost` |
| Request | [`GetWorkerHostRequest`](#getworkerhostrequest) |
| Response | [`WorkerHost`](#workerhost) |
| Action | `read_worker_host` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Reads one Worker Host as `supertag get worker-host` and `describe
worker-host` show it, revoked hosts included.

### EnrollWorkerHost

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/EnrollWorkerHost` |
| Request | [`EnrollWorkerHostRequest`](#enrollworkerhostrequest) |
| Response | [`WorkerHostCredential`](#workerhostcredential) |
| Action | `manage_worker_host` |
| Callers | The admin token and Operator Tokens |
| Audit log | `worker-host.enroll` |

Enrolls a Worker Host under a new ID and returns its first credential, as
`supertag enroll worker-host` does. The host is bound to no Tag; bind it
with `BindWorkerHost`. The token is returned only by this call and is
never stored in readable form, so a caller that loses it rotates the
credential.

An ID is enrolled once. Repeating the call, or enrolling an ID a revoked
host had, changes nothing and fails with `AlreadyExists` and
`ERROR_REASON_CONFLICT`.

### RotateWorkerHostCredential

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/RotateWorkerHostCredential` |
| Request | [`RotateWorkerHostCredentialRequest`](#rotateworkerhostcredentialrequest) |
| Response | [`WorkerHostCredential`](#workerhostcredential) |
| Action | `manage_worker_host_credential` |
| Callers | The admin token and Operator Tokens |
| Audit log | `worker-host.credential.rotate` |

Replaces a Worker Host's credential and returns the new one, as
`supertag rotate worker-host-credential` does. The previous token stops
working at once, and the host's current connection ends; its Worklet
connects again with the new token. The token is returned only by this
call.

The rotation applies only while the host's `credential_revision` is
still `expected_credential_revision`, so a retry of a rotation that
already applied changes nothing. It fails with `FailedPrecondition` and
`ERROR_REASON_CONFLICT` when the revision differs, or when the host is
revoked: a revoked host must be enrolled under a new ID. It fails with
`InvalidArgument` for an `expected_credential_revision` below 1.

### RevokeWorkerHostCredential

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/RevokeWorkerHostCredential` |
| Request | [`RevokeWorkerHostCredentialRequest`](#revokeworkerhostcredentialrequest) |
| Response | [`WorkerHost`](#workerhost) |
| Action | `manage_worker_host_credential` |
| Callers | The admin token, Operator Tokens, and the Worker Host's own credential |
| Audit log | `worker-host.credential.revoke` |

Revokes a Worker Host, as `supertag revoke worker-host-credential` does.
Its credential stops working at once, its connection ends, and it takes
no new Tasks. A revoked host stays readable and its ID is never enrolled
again. Revoking a revoked host changes nothing and returns it.

A host may revoke itself with its own credential, and its
`revocation_reason` is then `SelfRevoked`. Its credential no longer
works afterward, so a repeat fails with `Unauthenticated`.

### DrainWorkerHost

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/DrainWorkerHost` |
| Request | [`DrainWorkerHostRequest`](#drainworkerhostrequest) |
| Response | [`WorkerHost`](#workerhost) |
| Action | `manage_worker_host` |
| Callers | The admin token, Operator Tokens, and the Worker Host's own credential |
| Audit log | `worker-host.drain` |

Drains a Worker Host, as `supertag drain worker-host` does: it finishes
the work it accepted and takes no new Tasks until it is resumed. Draining
a draining host changes nothing. The host returned has no `storage`. A
host may drain itself with its own credential, as `supertag up` and
`supertag down` do before they restart or stop a host service.

### ResumeWorkerHost

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/ResumeWorkerHost` |
| Request | [`ResumeWorkerHostRequest`](#resumeworkerhostrequest) |
| Response | [`WorkerHost`](#workerhost) |
| Action | `manage_worker_host` |
| Callers | The admin token, Operator Tokens, and the Worker Host's own credential |
| Audit log | `worker-host.resume` |

Ends a drain, as `supertag resume worker-host` does: the host takes new
Tasks again. Resuming a host that is not draining changes nothing. The
host returned has no `storage`. A host may resume itself with its own
credential, as a host service does when it starts after `supertag up` or
`supertag down` drained it.

### JoinWorkerHost

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/JoinWorkerHost` |
| Request | [`JoinWorkerHostRequest`](#joinworkerhostrequest) |
| Response | [`JoinWorkerHostResponse`](#joinworkerhostresponse) |
| Action | `join_worker_host` |
| Callers | An Auth Key, in place of an operator credential |
| Audit log | `worker-host.join` |

Joins a machine as a new Worker Host by redeeming the Auth Key sent as
the bearer token, as `supertag connect worklet --auth-key` does. The
host is enrolled under `name`, or `NAME-2`, `NAME-3` and so on when that
ID is taken, bound to the key's Tags and given its labels. It returns the
host's first credential, which only this call returns.

A repeat with the same Auth Key and `idempotency_key` enrolls nothing:
it returns the host the first call enrolled, whatever its `name`, with a
new credential that replaces the one the first call returned, until that
host first connects. After that, or once the host is revoked, a repeat
fails with `AlreadyExists`. It fails with `Unauthenticated` for an Auth
Key the Control Plane does not know, `PermissionDenied` for a revoked,
expired or used one, `FailedPrecondition` and `ERROR_REASON_CONFLICT`
when one of the key's Tags was deleted, and `InvalidArgument` for a
malformed `name` or `idempotency_key`. A call with an unknown Auth Key is
refused before its request is read and is not recorded in the audit
trail.

### BindWorkerHost

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/BindWorkerHost` |
| Request | [`BindWorkerHostRequest`](#bindworkerhostrequest) |
| Response | [`BindWorkerHostResponse`](#bindworkerhostresponse) |
| Action | `bind_worker_host` |
| Callers | The admin token and Operator Tokens |
| Audit log | `tag.worker-host.add` |

Binds a Worker Host to a Tag, as `supertag update tag --add-worker-host`
does, so the host may run the Tag's Tasks. Binding a host that is
already bound changes nothing and succeeds with `changed` false. It fails
with `NotFound` when the Tag does not exist or was deleted, or the host
was never enrolled.

### UnbindWorkerHost

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/UnbindWorkerHost` |
| Request | [`UnbindWorkerHostRequest`](#unbindworkerhostrequest) |
| Response | [`UnbindWorkerHostResponse`](#unbindworkerhostresponse) |
| Action | `bind_worker_host` |
| Callers | The admin token and Operator Tokens |
| Audit log | `tag.worker-host.remove` |

Unbinds a Worker Host from a Tag, as `supertag update tag
--remove-worker-host` does. Task Attempts already running on the host
are not stopped. Unbinding a host that is not bound changes nothing and
succeeds with `changed` false, whether or not the host exists. It fails
with `NotFound` when the Tag does not exist or was deleted.

### CreateAuthKey

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/CreateAuthKey` |
| Request | [`CreateAuthKeyRequest`](#createauthkeyrequest) |
| Response | [`CreateAuthKeyResponse`](#createauthkeyresponse) |
| Action | `manage_auth_key` |
| Callers | The admin token and Operator Tokens |
| Audit log | `auth-key.create` |

Creates an Auth Key, as `supertag create auth-key` does, and returns its
secret. Every Worker Host that redeems the key is bound to its Tags and
carries its labels. A one-off key joins one host and expires one hour
after it is created; a reusable key expires after 90 days. The secret is
returned only by this call and is never stored in readable form.

Names are never reused. Repeating the call, or using the name of a
revoked or expired key, changes nothing and fails with `AlreadyExists`
and `ERROR_REASON_CONFLICT`. It fails with `InvalidArgument` for a
malformed name or label, no Tags, more than 32 Tags, or more than 64
labels, and `NotFound` for a Tag that does not exist or was deleted.

### ListAuthKeys

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/ListAuthKeys` |
| Request | [`ListAuthKeysRequest`](#listauthkeysrequest) |
| Response | [`ListAuthKeysResponse`](#listauthkeysresponse) |
| Action | `read_auth_key` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists Auth Keys, the earliest created first, then by name, as `supertag
list auth-key` shows them, revoked and expired keys included. Secrets are
never returned. It fails with `InvalidArgument` for a malformed
`page_token`.

### GetAuthKey

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/GetAuthKey` |
| Request | [`GetAuthKeyRequest`](#getauthkeyrequest) |
| Response | [`AuthKey`](#authkey) |
| Action | `read_auth_key` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Reads one Auth Key, without its secret, as `supertag get auth-key` shows
it.

### RevokeAuthKey

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.HostService/RevokeAuthKey` |
| Request | [`RevokeAuthKeyRequest`](#revokeauthkeyrequest) |
| Response | [`AuthKey`](#authkey) |
| Action | `manage_auth_key` |
| Callers | The admin token and Operator Tokens |
| Audit log | `auth-key.revoke` |

Revokes an Auth Key, as `supertag revoke auth-key` does: no new Worker
Host can join with it. Hosts that already joined keep their enrollment
and Tags. Revoking a revoked key changes nothing and returns it.

## Messages

### ListWorkerHostsRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `page_size` | `pageSize` | `int32` | At most this many Worker Hosts; 0 means 100, and more than 500 means 500. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListWorkerHostsResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `worker_hosts` | `workerHosts` | repeated [`WorkerHost`](#workerhost) | The Worker Hosts, the earliest enrolled first, then by ID. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### GetWorkerHostRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Worker Host's ID. |

### EnrollWorkerHostRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The new Worker Host's ID. Leading and trailing whitespace is removed, and what remains must not be empty. |

### RotateWorkerHostCredentialRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Worker Host's ID. |
| `expected_credential_revision` | `expectedCredentialRevision` | `int64` | The host's `credential_revision` as the caller read it, from 1. Read it with `GetWorkerHost`. |

### RevokeWorkerHostCredentialRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Worker Host's ID. |

### DrainWorkerHostRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Worker Host's ID. |

### ResumeWorkerHostRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Worker Host's ID. |

### JoinWorkerHostRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `name` | `name` | `string` | The ID the host asks for, such as the machine's hostname: 1 to 63 lowercase letters, digits, dots, hyphens or underscores, starting with a letter or digit. |
| `idempotency_key` | `idempotencyKey` | `string` | Makes a retry safe, as described on `JoinWorkerHost`. A key is 1 to 200 characters without whitespace or control characters. Empty enrolls a new host on every call. |

### JoinWorkerHostResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `credential` | `credential` | [`WorkerHostCredential`](#workerhostcredential) | The new host's first credential. |
| `auth_key` | `authKey` | `string` | The name of the Auth Key it redeemed. |
| `tags` | `tags` | repeated `string` | The Tags it is bound to, by name. |
| `ephemeral` | `ephemeral` | `bool` | It joined with an ephemeral Auth Key, so it is revoked after it disconnects with no open Task Attempts. |

### BindWorkerHostRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `worker_host_id` | `workerHostId` | `string` | The Worker Host's ID. |

### BindWorkerHostResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `tag_id` | `tagId` | `string` | The Tag's ID. |
| `worker_hosts` | `workerHosts` | repeated `string` | The IDs of every Worker Host bound to the Tag after the call, sorted. |
| `changed` | `changed` | `bool` | False when the host was already bound and nothing changed. |

### UnbindWorkerHostRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `worker_host_id` | `workerHostId` | `string` | The Worker Host's ID. |

### UnbindWorkerHostResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `tag_id` | `tagId` | `string` | The Tag's ID. |
| `worker_hosts` | `workerHosts` | repeated `string` | The IDs of every Worker Host bound to the Tag after the call, sorted. |
| `changed` | `changed` | `bool` | False when the host was not bound and nothing changed. |

### CreateAuthKeyRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `name` | `name` | `string` | The key's name: 1 to 63 lowercase letters, digits, hyphens or underscores, starting with a letter or digit. Never reused. |
| `tags` | `tags` | repeated `string` | The Tags every host that redeems the key is bound to, by name: 1 to 32 of them. Repeated names count once. |
| `labels` | `labels` | repeated `string` | Placement labels every host that redeems the key carries, such as `gpu`: at most 64, each 1 to 63 lowercase letters, digits, dots, colons, hyphens or underscores, starting with a letter or digit. Labels are lowercased, and repeated labels count once. Labels that start with `mcp:`, `mcp-login:`, `volume-credential:` or `artifact-volume:` come from host configuration and are refused. Labels place work only; they never grant access. |
| `reusable` | `reusable` | `bool` | Lets the key join any number of hosts until it expires after 90 days. False makes a one-off key that joins one host and expires after one hour. |
| `ephemeral` | `ephemeral` | `bool` | Hosts that join with the key are revoked after they disconnect with no open Task Attempts, and leave `ListWorkerHosts`. |

### CreateAuthKeyResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `auth_key` | `authKey` | [`AuthKey`](#authkey) | The new key. |
| `secret` | `secret` | `string` | The key's secret. It is returned only here; store it in a secret manager. A machine joins with it through `supertag connect worklet`. |

### ListAuthKeysRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `page_size` | `pageSize` | `int32` | At most this many Auth Keys; 0 means 100, and more than 500 means 500. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListAuthKeysResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `auth_keys` | `authKeys` | repeated [`AuthKey`](#authkey) | The Auth Keys, the earliest created first, then by name. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### GetAuthKeyRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `name` | `name` | `string` | The key's name. |

### RevokeAuthKeyRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `name` | `name` | `string` | The key's name. |

### WorkerHost

One Worker Host, as the Control Plane last recorded it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `metadata` | `metadata` | [`Metadata`](shared.md#metadata) | `id` and `name` are both the host's ID. `resource_version` changes when any field of this view changes. |
| `draining` | `draining` | `bool` | Whether an operator or the host itself drained it. |
| `phase` | `phase` | [`WorkerHostPhase`](#workerhostphase) | Its phase, derived from the fields below. |
| `disk_space` | `diskSpace` | [`DiskSpace`](#diskspace) | Free and total space on the filesystem the host uses for Task Attempt scratch, as it last reported. Unset when it never reported. |
| `ephemeral` | `ephemeral` | `bool` | It joined with an ephemeral Auth Key, so it is revoked after it disconnects with no open Task Attempts. |
| `storage` | `storage` | [`WorkerHostStorage`](#workerhoststorage) | Where the host's Task Attempts kept their files, from the placements the Control Plane recorded. Set only by `ListWorkerHosts` and `GetWorkerHost`. |
| `auth_key` | `authKey` | `string` | The name of the Auth Key the host redeemed to join. Empty when an operator enrolled it. |
| `credential_revision` | `credentialRevision` | `int64` | Increases with every credential rotation, from 1. Pass it as `RotateWorkerHostCredentialRequest.expected_credential_revision`. |
| `connection_generation` | `connectionGeneration` | `int64` | Increases with every connection, so only the current connection may report. |
| `connection_status` | `connectionStatus` | [`WorkerHostConnection`](#workerhostconnection) | Whether its Worklet is connected. |
| `worklet_id` | `workletId` | `string` | The ID of its current or last Worklet. Empty when it never connected. |
| `protocol_version` | `protocolVersion` | optional `int32` | The Worklet protocol version it connected with. Unset when it never connected. |
| `durable_protocol_version` | `durableProtocolVersion` | optional `int32` | The durable transport extension version it connected with. Unset when its Worklet does not support it. |
| `control_protocol_version` | `controlProtocolVersion` | optional `int32` | The durable control extension version it connected with. Unset when its Worklet does not support it. |
| `workers` | `workers` | repeated `google.protobuf.Struct` | Each Worker the host's Worklet advertised, in the Worklet protocol's `WorkerDescriptor` JSON form: `id`, `type`, `capabilities`, `profiles`, `profileCapabilities` (harness, models, efforts and capabilities per Worker Profile), `contextTypes` and `maxConcurrency`. The host reports them, so they are untrusted. |
| `workspaces` | `workspaces` | repeated `string` | The names of the Workspaces with a checkout declared on the host. Paths stay on the host. |
| `labels` | `labels` | repeated `string` | Its placement labels: those it advertised, which are self-reported, and those its Auth Key granted. Sorted. |
| `granted_labels` | `grantedLabels` | repeated `string` | The labels its Auth Key granted. Sorted. |
| `ready` | `ready` | `bool` | Whether it can take Tasks now. |
| `last_authenticated_at` | `lastAuthenticatedAt` | `google.protobuf.Timestamp` | When its credential last claimed a connection. Unset when it never did. |
| `failed_authentication_count` | `failedAuthenticationCount` | `int32` | How many connection claims with a wrong credential were refused. |
| `last_authentication_failure_at` | `lastAuthenticationFailureAt` | `google.protobuf.Timestamp` | When a claim was last refused. Unset when none was. |
| `last_seen_at` | `lastSeenAt` | `google.protobuf.Timestamp` | When it last reported. Unset when it never did. |
| `connected_at` | `connectedAt` | `google.protobuf.Timestamp` | When its current or last connection began. Unset when it never connected. |
| `disconnected_at` | `disconnectedAt` | `google.protobuf.Timestamp` | When its last connection ended. Unset while its first connection lasts or when it never connected. |
| `revoked_at` | `revokedAt` | `google.protobuf.Timestamp` | When it was revoked. Unset while it is enrolled. |
| `revocation_reason` | `revocationReason` | `string` | Why it was revoked: `OperatorRevoked`, `SelfRevoked` or `EphemeralDisconnected`. Empty while it is enrolled. |
| `active_attempts` | `activeAttempts` | `int32` | Task Attempts running on it. |
| `capacity` | `capacity` | `int32` | How many Task Attempts it runs at once. |
| `available_slots` | `availableSlots` | `int32` | How many more it can take now. |

### DiskSpace

Space on one filesystem, in bytes.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `free_bytes` | `freeBytes` | `int64` | Space available to the host. |
| `total_bytes` | `totalBytes` | `int64` | The filesystem's size. |

### WorkerHostStorage

Where a Worker Host's Task Attempts kept their files.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `sandboxes` | `sandboxes` | repeated `string` | The remote sandbox providers its Task Attempts ran in, such as `e2b`. Their files are lost when the sandbox stops. |
| `placement_unknown` | `placementUnknown` | `bool` | True when a Task Attempt of the host recorded no complete placement, so where its files were is not known. |

### WorkerHostCredential

A Worker Host credential, returned once when it is issued.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `worker_host_id` | `workerHostId` | `string` | The Worker Host's ID. |
| `issued_at` | `issuedAt` | `google.protobuf.Timestamp` | When it was issued. |
| `token` | `token` | `string` | The token the host's Worklet connects with. It is a secret; give it to the host through its secret manager. |

### AuthKey

One Auth Key, without its secret.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `metadata` | `metadata` | [`Metadata`](shared.md#metadata) | Names the key. `resource_version` changes when any field of this view changes. |
| `tags` | `tags` | repeated `string` | The Tags a host that redeems the key is bound to, by name. A Tag deleted since keeps its name; one whose record is gone shows its ID. |
| `labels` | `labels` | repeated `string` | The placement labels it grants, sorted. |
| `reusable` | `reusable` | `bool` | It joins any number of hosts until it expires. |
| `ephemeral` | `ephemeral` | `bool` | Hosts that join with it are revoked after they disconnect. |
| `phase` | `phase` | [`AuthKeyPhase`](#authkeyphase) | Its phase. |
| `expires_at` | `expiresAt` | `google.protobuf.Timestamp` | When it expires. |
| `used_at` | `usedAt` | `google.protobuf.Timestamp` | When a host last redeemed it. Unset when none has. |
| `redemption_count` | `redemptionCount` | `int32` | How many hosts redeemed it. |
| `revoked_at` | `revokedAt` | `google.protobuf.Timestamp` | When it was revoked. Unset when it was not. |

## Enums

### WorkerHostPhase

A Worker Host's phase. Revocation wins over everything else, then a lost
connection, then draining.

| Value | Description |
| --- | --- |
| `WORKER_HOST_PHASE_UNSPECIFIED` |  |
| `WORKER_HOST_PHASE_CONNECTED` | Connected but not ready to take Tasks. |
| `WORKER_HOST_PHASE_DRAINING` | It finishes accepted work and takes no new Tasks. |
| `WORKER_HOST_PHASE_READY` | Connected and taking Tasks. |
| `WORKER_HOST_PHASE_REVOKED` | Revoked. It never connects again. |
| `WORKER_HOST_PHASE_UNREACHABLE` | Its Worklet is not connected. |

### WorkerHostConnection

Whether a Worker Host's Worklet is connected.

| Value | Description |
| --- | --- |
| `WORKER_HOST_CONNECTION_UNSPECIFIED` |  |
| `WORKER_HOST_CONNECTION_CONNECTED` | It is connected. |
| `WORKER_HOST_CONNECTION_DISCONNECTED` | It is not connected. |

### AuthKeyPhase

An Auth Key's phase. Revocation wins over expiry, and expiry over use.

| Value | Description |
| --- | --- |
| `AUTH_KEY_PHASE_UNSPECIFIED` |  |
| `AUTH_KEY_PHASE_ACTIVE` | A host can join with it. |
| `AUTH_KEY_PHASE_USED` | A one-off key that a host already redeemed. |
| `AUTH_KEY_PHASE_EXPIRED` | It expired. |
| `AUTH_KEY_PHASE_REVOKED` | An operator revoked it. |
