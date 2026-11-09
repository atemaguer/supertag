# Shared messages and options

<!-- Generated from spec/proto/supertag/operator/v1 by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->

The messages, enums, and options that several operator services share, from
[`common.proto`](../../../spec/proto/supertag/operator/v1/common.proto), [`options.proto`](../../../spec/proto/supertag/operator/v1/options.proto), [`task.proto`](../../../spec/proto/supertag/operator/v1/task.proto).

Messages about Tasks and what they delivered, shared by the services that
show them.

## Conventions

Messages shared by every operator service.

Conventions for every RPC in this package:

- The JSON form is proto3 JSON. Fields are lowerCamelCase and enums are
  their value names as strings.
- Times are `google.protobuf.Timestamp`, which encode as RFC 3339 strings.
- 64-bit integers encode as JSON strings.
- An enum's `_UNSPECIFIED` value, unless its own comment says more, means
  the field is not set.
- A list RPC takes `int32 page_size` and `string page_token` in its
  request and returns `string next_page_token` in its response. Each
  `page_size` comment gives the size 0 stands for and the largest size
  served; a larger one is served as the largest. An empty
  `next_page_token` means the last page. A page token is opaque, and any
  API Server of the Control Plane continues it. A negative `page_size` or
  a `page_token` the server did not issue fails with `InvalidArgument` and
  `ERROR_REASON_INVALID_ARGUMENT`.
- A call the Control Plane refuses returns a Connect error code with one
  `ErrorDetail`. A body the Connect protocol itself rejects, one that is
  not valid JSON for the request message or is over 1 MB (16 MB for a
  `ResourceService` RPC), gets only the code. The credential is checked
  before the body is read.

Every call is checked in this order before its RPC runs:

1. While the Control Plane drains, every call fails with `Unavailable`
   and `ERROR_REASON_DRAINING`, and open server streams end with
   `Unavailable`. Retry against its replacement.
2. The `authorization: Bearer TOKEN` header carries the admin token, an
   Operator Token, a scoped coordination credential, or a Worker Host's
   own credential, which names its host in the `x-supertag-worker-host-id`
   header. A missing or unknown one fails with `Unauthenticated` and
   `ERROR_REASON_UNAUTHENTICATED`; a revoked or expired Operator Token
   with `Unauthenticated` and `ERROR_REASON_CREDENTIAL_REVOKED` or
   `ERROR_REASON_CREDENTIAL_EXPIRED`. An RPC that sets `allow_anonymous`
   accepts a call without the header and skips step 3 for it. An RPC that
   sets `requires_auth_key` takes an Auth Key as the bearer token instead,
   fails the same way when the Control Plane does not know the key, and
   skips step 3; the RPC checks whether the key may still be used.
3. The RPC's options in `options.proto` decide whether the credential may
   call it: a scoped coordination credential needs
   `allow_scoped_credential`, a Worker Host credential needs
   `allow_worker_host_credential` and carries no action,
   `requires_admin_token` refuses everything but the admin token, and
   every other credential must carry the RPC's `action`. A refusal is
   `PermissionDenied` with `ERROR_REASON_PERMISSION_DENIED`.

A server stream checks its credential again before the first event sent
15 seconds or more after the last check, and sends a heartbeat after 15
seconds without another event, so revoking or expiring an Operator Token
also ends the streams it opened, with the error step 2 names.

A call that passes these checks to an RPC with an `audit_action` is
recorded whether it succeeds or fails, and the entry is stored before the
call answers, so `OrganizationService.ListAuditEntries` lists it to any
later call. A call these checks refuse is not recorded, and neither is a
call with `dry_run`. A successful `ResourceService.ApplyManifests` that applied, failed
or pruned resources records one entry for each of them instead, a pruned
one as `resource.prune`.

Each service's comment says what its callers see and which errors its RPCs
add.

## Options

| Option | Applies to | Type | Description |
| --- | --- | --- | --- |
| `(supertag.operator.v1.action)` | `google.protobuf.MethodOptions` | `string` | The operator action the caller's credential must carry, such as `status`. The admin token and Operator Tokens carry every action. Every RPC declares one. |
| `(supertag.operator.v1.allow_anonymous)` | `google.protobuf.MethodOptions` | `bool` | Accept a call without a credential. A call that carries a credential is still authenticated and must carry `action`. |
| `(supertag.operator.v1.requires_admin_token)` | `google.protobuf.MethodOptions` | `bool` | Accept only the Control Plane admin token. An Operator Token is refused with `PermissionDenied`, whatever actions it carries. Managing Operator Tokens needs this. |
| `(supertag.operator.v1.audit_action)` | `google.protobuf.MethodOptions` | `string` | The audit action recorded for each authenticated call, such as `objective.cancel`. Every RPC that can change state declares one; an RPC that reads only sets `idempotency_level = NO_SIDE_EFFECTS` instead. |
| `(supertag.operator.v1.allow_scoped_credential)` | `google.protobuf.MethodOptions` | `bool` | Accept a scoped coordination credential, one the Control Plane reads from `SUPERTAG_COORDINATION_OPERATORS_FILE`. It must carry `action` among its actions, and it reaches only the Objectives its scope names: the RPC refuses any other with `PermissionDenied`. Without this option such a credential is refused with `PermissionDenied`, whatever actions it carries. |
| `(supertag.operator.v1.requires_auth_key)` | `google.protobuf.MethodOptions` | `bool` | Take an Auth Key as the bearer token in place of an operator credential. A call without a bearer token, or with one that is not an Auth Key the Control Plane knows, fails with `Unauthenticated` before its body is read. The RPC redeems the key, so it checks then whether the key was revoked, has expired or was used. |
| `(supertag.operator.v1.allow_worker_host_credential)` | `google.protobuf.MethodOptions` | `bool` | Also accept a Worker Host's own credential, sent as the bearer token with the host's ID in the `x-supertag-worker-host-id` header. It carries no operator actions: this option alone admits it, and the RPC acts only on that Worker Host and refuses any other with `PermissionDenied`. |
| `(supertag.operator.v1.manifest)` | `google.protobuf.MessageOptions` | [`ManifestKind`](#manifestkind) | Makes this message the `spec` of a manifest kind. |
| `(supertag.operator.v1.manifest_requirements)` | `google.protobuf.MessageOptions` | repeated [`ManifestRequirement`](#manifestrequirement) | Rules a manifest's fields must satisfy together, beyond the rules of each field. |
| `(supertag.operator.v1.manifest_field)` | `google.protobuf.FieldOptions` | [`ManifestField`](#manifestfield) | How the field is written and checked in manifests. |
| `(supertag.operator.v1.manifest_oneof)` | `google.protobuf.OneofOptions` | [`ManifestOneof`](#manifestoneof) | How the oneof is written and checked in manifests. |
| `(supertag.operator.v1.manifest_value)` | `google.protobuf.EnumValueOptions` | `string` | The value's spelling in manifests, such as `read-only`. |

## Messages

### Money

An amount of money in the smallest unit of its currency.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `currency` | `currency` | `string` | The ISO 4217 code, such as `USD`. |
| `amount_minor` | `amountMinor` | `int64` | The amount in minor units. 1250 with `USD` is $12.50. |

### Metadata

Identifies and versions a resource.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The stable ID the Control Plane assigned. |
| `name` | `name` | `string` | The unique name within the resource's kind. |
| `resource_version` | `resourceVersion` | `string` | Changes whenever the resource changes. Compare it for equality only. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When the resource was created. |
| `updated_at` | `updatedAt` | `google.protobuf.Timestamp` | When the resource last changed. |

### Heartbeat

What a server stream sends after 15 seconds without another event, so
proxies keep an idle connection open. It carries no state.

No fields.

### FieldViolation

One request field an error is about.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `path` | `path` | `string` | The field path in the request, such as `spec.roles`. |
| `description` | `description` | `string` | What is wrong with it. |
| `manager` | `manager` | `string` | For a conflict over a manifest field, the field manager that owns it, such as `apply` or an apply set's name. Empty otherwise. |

### ErrorDetail

The detail every refused call carries beside its Connect error code.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `reason` | `reason` | [`ErrorReason`](#errorreason) | The stable reason for the refusal. |
| `fields` | `fields` | repeated [`FieldViolation`](#fieldviolation) | The request fields involved, when the reason concerns fields. |

### ManifestKind

One manifest kind.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `kind` | `kind` | `string` | The kind, such as `Tag`, as `kind` names it. |
| `name` | `name` | [`ManifestField`](#manifestfield) | The rules for `metadata.name`. It is always a required string. |
| `spec_optional` | `specOptional` | `bool` | A manifest may leave out `spec`, which then takes every default. |

### ManifestField

How one field is written and checked in manifests. For a repeated field,
the string and number rules apply to each item and the item rules to the
list.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `required` | `required` | `bool` | The field must be present. |
| `output_only` | `outputOnly` | `bool` | The Control Plane sets the field. It is not part of the manifest form, and a manifest that sets it is invalid. |
| `pattern` | `pattern` | `string` | A string must match this regular expression. |
| `min_length` | `minLength` | optional `uint32` | A string's least length, in characters. |
| `max_length` | `maxLength` | optional `uint32` | A string's greatest length, in characters. |
| `minimum` | `minimum` | optional `int64` | A number's least value. |
| `maximum` | `maximum` | optional `int64` | A number's greatest value. |
| `min_items` | `minItems` | optional `uint32` | A list's least number of items. |
| `max_items` | `maxItems` | optional `uint32` | A list's greatest number of items. |
| `accepts_single` | `acceptsSingle` | `bool` | A repeated field also accepts one item in place of a list of one, as `model: gpt-6-sol` for `model: [gpt-6-sol]`. |

### ManifestOneof

How one oneof is written and checked in manifests. Without this option a
oneof's members are ordinary optional fields of which at most one is set.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `required` | `required` | `bool` | Exactly one member must be set. |
| `field` | `field` | `string` | Writes the oneof as one field with this name, whose value is the set member's manifest form. |
| `discriminator` | `discriminator` | `string` | Writes the set member inline beside a field with this name, whose value is the member's JSON name. Each member is a message. |

### ManifestRequirement

A rule that makes fields required depending on another field's value.
Paths are dotted manifest field names relative to the message, such as
`configuration.transport`.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `path` | `path` | `string` | The field whose value decides. |
| `equals` | `equals` | `string` | The value that selects `required`. Any other value, or no value, selects `otherwise_required`. |
| `required` | `required` | repeated `string` | The fields required when `path` equals `equals`. |
| `otherwise_required` | `otherwiseRequired` | repeated `string` | The fields required otherwise. |

### TaskDelivery

What a finished Task delivered for a person to look at: a branch in its
Workspace, patches, a pull request, and output files. Every part is empty
when the Task delivered nothing.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `workspace` | `workspace` | [`WorkspaceDelivery`](#workspacedelivery) | The Task's Workspace delivery. Unset for a Task without a named Workspace. |
| `patches` | `patches` | repeated [`PatchDelivery`](#patchdelivery) | The patch artifacts of `WORKSPACE_DELIVERY_MODE_PATCH` delivery. |
| `pull_request` | `pullRequest` | [`PullRequestDelivery`](#pullrequestdelivery) | The pull request of `WORKSPACE_DELIVERY_MODE_PULL_REQUEST` delivery, once it was opened. |
| `outputs` | `outputs` | repeated [`OutputDelivery`](#outputdelivery) | Other files the Task captured as output artifacts. |

### WorkspaceDelivery

The branch a Task committed to in its Workspace.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `name` | `name` | `string` | The Workspace's name. |
| `mode` | `mode` | [`WorkspaceDeliveryMode`](#workspacedeliverymode) | How the Workspace delivers. |
| `branch` | `branch` | `string` | The Task's branch. |
| `ref` | `ref` | `string` | The base ref the branch started from, such as `main`, when the Workspace names one. |
| `head` | `head` | `string` | The branch head the Worker recorded with the result. Empty until the Worker recorded one; a branch without a head delivered nothing yet. |
| `changed_files` | `changedFiles` | optional `int32` | How many files changed on the branch since its base, as the Worker reported them. Unset when the Worker reported no count. |
| `base` | `base` | `string` | The commit the branch started from, as the Worker reported it. |

### PatchDelivery

One patch artifact.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `artifact_id` | `artifactId` | `string` | The artifact's ID, for `supertag download artifact`. |
| `path` | `path` | `string` | The patch file's path within the artifact. |

### PullRequestDelivery

A GitHub pull request a Task opened.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `surface_account_id` | `surfaceAccountId` | `string` | The ID of the Surface Account that opened it, when one is recorded. |
| `repository` | `repository` | `string` | The repository as `owner/name`. |
| `number` | `number` | `int32` | The pull request's number. |
| `url` | `url` | `string` | The pull request's web address. |
| `state` | `state` | [`PullRequestState`](#pullrequeststate) | Whether it is a draft, ready, or closed. |
| `last_error` | `lastError` | `string` | Why the Control Plane's last update to it failed. Empty when it did not. |
| `next_attempt_at` | `nextAttemptAt` | `google.protobuf.Timestamp` | When the Control Plane retries that update. Unset when it does not retry. |

### OutputDelivery

One output artifact and the files in it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `artifact_id` | `artifactId` | `string` | The artifact's ID, for `supertag download artifact`. |
| `paths` | `paths` | repeated `string` | The paths of its files. |

## Enums

### ErrorReason

Why the Control Plane refused a call. Clients branch on this, never on the
error message, which is prose for people.

| Value | Description |
| --- | --- |
| `ERROR_REASON_UNSPECIFIED` | The Connect code alone says why, as for `Canceled`, `DeadlineExceeded`, and `Unimplemented`. |
| `ERROR_REASON_UNAUTHENTICATED` | The call carried no credential, or one the Control Plane does not know. |
| `ERROR_REASON_CREDENTIAL_REVOKED` | The Operator Token was revoked. |
| `ERROR_REASON_CREDENTIAL_EXPIRED` | The Operator Token has expired. |
| `ERROR_REASON_PERMISSION_DENIED` | The credential is valid but may not call this RPC: it lacks the RPC's operator action, or the RPC accepts only the admin token. |
| `ERROR_REASON_DRAINING` | The Control Plane is shutting down and accepts no new calls. Retry against its replacement. |
| `ERROR_REASON_INVALID_ARGUMENT` | A request field is missing or malformed. `fields` names it. |
| `ERROR_REASON_NOT_FOUND` | The named resource does not exist. |
| `ERROR_REASON_CONFLICT` | The request conflicts with the stored resource. `fields` names each path. |
| `ERROR_REASON_INTERNAL` | The Control Plane failed. The message names no internal detail. |
| `ERROR_REASON_UNAVAILABLE` | Something the RPC needs is not available on this Control Plane, such as a feature it is configured without. Retrying the same call does not help until the configuration changes. |
| `ERROR_REASON_RESOURCE_EXHAUSTED` | The request is over a size limit, or the caller reached a rate or mailbox limit. The message names the limit. |

### TaskStatus

How a Task is doing.

| Value | Description |
| --- | --- |
| `TASK_STATUS_UNSPECIFIED` |  |
| `TASK_STATUS_PENDING` | It waits to run: for a Worker Host that can place it, for its Objective to resume, or for capacity. |
| `TASK_STATUS_RUNNING` | A Task Attempt runs it. |
| `TASK_STATUS_COMPLETED` | It completed. |
| `TASK_STATUS_FAILED` | It failed. |
| `TASK_STATUS_CANCELLED` | It was cancelled. |

### TaskAttemptStatus

How one Task Attempt is doing.

| Value | Description |
| --- | --- |
| `TASK_ATTEMPT_STATUS_UNSPECIFIED` |  |
| `TASK_ATTEMPT_STATUS_RUNNING` | It runs on a Worker. |
| `TASK_ATTEMPT_STATUS_COMPLETED` | It ended with the Task's result. |
| `TASK_ATTEMPT_STATUS_FAILED` | It ended without a result. |
| `TASK_ATTEMPT_STATUS_CANCELLED` | It was stopped. |

### WorkspaceDeliveryMode

How a Task's Workspace changes come back.

| Value | Description |
| --- | --- |
| `WORKSPACE_DELIVERY_MODE_UNSPECIFIED` |  |
| `WORKSPACE_DELIVERY_MODE_PATCH` | As patch artifacts. |
| `WORKSPACE_DELIVERY_MODE_BRANCH` | As a branch in the Workspace's checkout on the Worker Host. |
| `WORKSPACE_DELIVERY_MODE_PULL_REQUEST` | As a GitHub pull request. |

### PullRequestState

Whether a delivered pull request is open for review.

| Value | Description |
| --- | --- |
| `PULL_REQUEST_STATE_UNSPECIFIED` |  |
| `PULL_REQUEST_STATE_DRAFT` | Open as a draft. |
| `PULL_REQUEST_STATE_READY` | Open and ready for review. |
| `PULL_REQUEST_STATE_CLOSED` | Closed. |
