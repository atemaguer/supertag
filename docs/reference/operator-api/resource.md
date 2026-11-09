# ResourceService

<!-- Generated from spec/proto/supertag/operator/v1 by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->

`supertag.operator.v1.ResourceService` in [`resource.proto`](../../../spec/proto/supertag/operator/v1/resource.proto). How to call an RPC, authenticate, and
read its errors is in the [Control Plane API Server](../control-plane-api.md) guide; the conventions every
RPC follows are in [Shared messages and options](shared.md#conventions).

The organization's configuration as manifests: `supertag apply -f`, `diff
-f`, `get`, `describe` and `delete` of a resource, the `provision:`
entries `supertag up` applies, the starter resources `supertag init`
writes, and `create tag`.

A manifest declares one resource: `apiVersion: supertag/v1`, `kind`,
`metadata.name` and `spec`. `ApplyManifests` and `DiffManifests` take
manifest documents as they were read, and the Control Plane validates
them, merges each field under its field manager, applies them in
dependency order and prunes apply sets. The messages below define each
kind's `spec`; the options in `options.proto` say how they are written in
a manifest, and the JSON Schemas under `spec/manifests/` are generated from
them.

The kinds and their manifests:

| Kind | Manifest | Delete |
| --- | --- | --- |
| `Tag` | `TagSpec` | Retires it |
| `Role` | `RoleSpec` | Retires it |
| `PermissionSet` | `PermissionSetSpec` | Deletes it |
| `ContextSet` | `ContextSetSpec` | Deletes it |
| `Volume` | `VolumeSpec` | Deletes it |
| `Workspace` | `WorkspaceSpec` | Deletes it |
| `SurfaceAccount` | `SurfaceAccountManifestSpec` | Retires it |
| `Objective` | `ObjectiveDeclaration` | Refused: cancel it with `ObjectiveService.CancelObjective` |
| `WorkerProfile` | None: observed, never applied | Refused |

Worker Hosts, Auth Keys, Operator Tokens, Tasks, Sessions and Teams have
their own services and are not resources of this one.

Access. The admin token and Operator Tokens may call every RPC; a scoped
coordination credential is refused with `PermissionDenied`. Every caller
sees every resource.

Every RPC that names a resource takes its kind and name, and fails with
`InvalidArgument` for an unset kind or an empty name, and `NotFound` for a
resource that does not exist. A call while the Control Plane drains fails
with `Unavailable` and `ERROR_REASON_DRAINING`.

## RPCs

### GetResource

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ResourceService/GetResource` |
| Request | [`GetResourceRequest`](#getresourcerequest) |
| Response | [`Resource`](#resource) |
| Action | `read_resource` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Reads one resource, as `supertag get` and `supertag describe` of a named
resource show it. A Workspace read this way also reports
`WorkspaceStatus.environments`, which `ListResources` leaves out. A Tag is
read by name even once retired; when several retired Tags share the name
and no active Tag holds it, the latest retired is returned.

With `manifest`, `Resource.manifest` is also set. It fails with
`FailedPrecondition` and `ERROR_REASON_CONFLICT` for `manifest` on a
Surface Account that `supertag setup surface` set up, which has no
secret references to export, and with `InvalidArgument` for `manifest` on
a Worker Profile.

### ListResources

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ResourceService/ListResources` |
| Request | [`ListResourcesRequest`](#listresourcesrequest) |
| Response | [`ListResourcesResponse`](#listresourcesresponse) |
| Action | `read_resource` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists the resources of one kind, as `supertag get` and `supertag list` of
a kind show them. Tags, Roles, Permission Sets, Context Sets, Volumes,
Workspaces and Surface Accounts come by name; Worker Profiles by Worker
Host ID, then in the order each host advertises them. Retired Tags and
retired Surface Accounts are left out.

With `manifest`, each `Resource.manifest` is also set, and Surface
Accounts that `supertag setup surface` set up are left out, since they
have no manifest.

It fails with `InvalidArgument` for `RESOURCE_KIND_OBJECTIVE`, whose
listing is `ObjectiveService.ListObjectives`, for `manifest` with
`RESOURCE_KIND_WORKER_PROFILE`, and for a malformed `page_token`.

### DiffManifests

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ResourceService/DiffManifests` |
| Request | [`DiffManifestsRequest`](#diffmanifestsrequest) |
| Response | [`DiffManifestsResponse`](#diffmanifestsresponse) |
| Action | `read_resource` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Plans an apply without changing anything, as `supertag diff -f` does: what
`ApplyManifests` with the same documents and flags would create, update,
leave unchanged, refuse, or find in conflict, and with `prune` what it
would delete, cancel or keep. It never reads Surface Account secrets: it
compares their declared fields and references only.

It fails as `ApplyManifests` does for an invalid input, without the
"Nothing was applied." prefix, and with `InvalidArgument` when a
document carries `secrets`. Conflicts and refusals are plan entries, not
errors.

### ApplyManifests

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ResourceService/ApplyManifests` |
| Request | [`ApplyManifestsRequest`](#applymanifestsrequest) |
| Response | [`ApplyManifestsResponse`](#applymanifestsresponse) |
| Action | `apply_resource` |
| Callers | The admin token and Operator Tokens |
| Audit log | `resource.apply` |

Applies manifests, as `supertag apply -f` does.

The Control Plane first validates every document, without writing:
its shape and kind, that the input defines each resource once, that
every Role, Permission Set, Context Set, Tag and Workspace it names is in
the input or already exists, and each field's manager. A Surface Account
that is new, or whose resolved `secrets` differ from its stored
credentials, is verified with its provider, as `supertag setup surface`
does; an unchanged one is neither verified nor rewritten. It then
applies the documents in dependency order: Surface Accounts, Volumes,
Workspaces, Context Sets, Permission Sets, Roles, Tags, then Objectives,
each kind in input order. A Tag that accepts messages from a Tag later in
the input is applied after that sender exists. With `prune` it then
removes the apply set's members the input no longer declares.

Applying is not one transaction. When one document fails, the documents
before it stay applied, the rest are not applied, prune does not run, and
the call still succeeds with `complete` false; `results` say which
document failed and why.

Applying the same input again changes nothing more, so a retry is safe:
an Objective that started is not started again, and a member already
pruned is not pruned again.

It fails, and nothing is applied, with:

- `InvalidArgument` and `ERROR_REASON_INVALID_ARGUMENT` when any document
  is invalid, including credentials the provider rejects. The message is
  `Nothing was applied. Invalid manifests:` and one line per problem,
  sorted, each starting with the document's `source`. `fields` has one
  entry per problem, with `path` `documents[INDEX]` and the line as its
  `description`.
- `FailedPrecondition` and `ERROR_REASON_CONFLICT` when a document changes
  a field that cannot change, such as an Objective's outcome. The message
  is `Nothing was applied. The input changes what cannot change:` and one
  line per field, `KIND/NAME: PATH: REASON`. `fields` has one entry per
  field, with `path` `documents[INDEX].PATH` and the reason as its
  `description`.
- `FailedPrecondition` and `ERROR_REASON_CONFLICT` when, without
  `force_conflicts`, a document changes a field another field manager
  owns and no field is refused. The message is `Nothing was applied. The
  input changes fields another manager owns:` and one line per field,
  `KIND/NAME: PATH is owned by MANAGER`. `fields` has one entry per field,
  with `path` `documents[INDEX].PATH` and `manager` set.
- `InvalidArgument` for no documents, `prune` without `apply_set`, a
  malformed `apply_set`, or `imperative` with `apply_set`, `prune` or an
  Objective.

### DeleteResource

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ResourceService/DeleteResource` |
| Request | [`DeleteResourceRequest`](#deleteresourcerequest) |
| Response | [`DeleteResourceResponse`](#deleteresourceresponse) |
| Action | `delete_resource` |
| Callers | The admin token and Operator Tokens |
| Audit log | `resource.delete` |

Deletes or retires one resource, as `supertag delete` of a resource does,
with what goes with it. Deletion never erases history: a retired Tag, Role or
Surface Account keeps its record, and Tasks keep the policy and Workspace
they recorded. Deleting also removes the resource's field-manager record
and apply-set membership. With `dry_run` it answers the same way and
changes nothing.

It fails with `FailedPrecondition` and `ERROR_REASON_CONFLICT` while
something still uses the resource, such as a Tag that owns an open
Objective or a Permission Set a Role lists; the message names every
reference. There is no force option. It fails with `InvalidArgument` for
`RESOURCE_KIND_OBJECTIVE` and `RESOURCE_KIND_WORKER_PROFILE`. A repeat
after the resource is gone fails with `NotFound`.

## Messages

### GetResourceRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `kind` | `kind` | [`ResourceKind`](#resourcekind) | The resource's kind. |
| `name` | `name` | `string` | Its `metadata.name`. A Surface Account is also named `PROVIDER:EXTERNAL_ACCOUNT_ID`, such as `slack:T0123456789`, and a manifest name wins over that form. A Worker Profile is named `ID@REVISION` or by its `metadata.id`. A declared Objective is named by its ID. |
| `manifest` | `manifest` | `bool` | Also return the resource's manifest in `Resource.manifest`. |

### ListResourcesRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `kind` | `kind` | [`ResourceKind`](#resourcekind) | The kind to list. |
| `page_size` | `pageSize` | `int32` | At most this many resources; 0 means 100, and more than 500 means 500. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |
| `manifest` | `manifest` | `bool` | Also return each resource's manifest in `Resource.manifest`. |

### ListResourcesResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `resources` | `resources` | repeated [`Resource`](#resource) | The resources, in the order `ListResources` describes. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### Resource

One resource of any kind.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | [`Tag`](#tag) | One of `resource`. A Tag. |
| `role` | `role` | [`Role`](#role) | One of `resource`. A Role. |
| `permission_set` | `permissionSet` | [`PermissionSet`](#permissionset) | One of `resource`. A Permission Set. |
| `context_set` | `contextSet` | [`ContextSet`](#contextset) | One of `resource`. A Context Set. |
| `volume` | `volume` | [`Volume`](#volume) | One of `resource`. A Volume. |
| `workspace` | `workspace` | [`Workspace`](#workspace) | One of `resource`. A Workspace. |
| `surface_account` | `surfaceAccount` | [`SurfaceAccount`](surface.md#surfaceaccount) | One of `resource`. A Surface Account. |
| `objective` | `objective` | [`DeclaredObjective`](#declaredobjective) | One of `resource`. A declared Objective. Its status and history are `ObjectiveService.GetObjective`'s. |
| `worker_profile` | `workerProfile` | [`WorkerProfile`](#workerprofile) | One of `resource`. A Worker Profile. |
| `manifest` | `manifest` | `google.protobuf.Struct` | The resource's manifest, set only when the request asks for it: the document `ApplyManifests` takes, with `apiVersion`, `kind`, `metadata.name` and the declarable `spec` fields. It leaves out what the Control Plane sets, such as IDs and timestamps, and an Objective's fields at their defaults. A Surface Account's has its secret references, never a value. |

Oneof `resource`: `tag`, `role`, `permission_set`, `context_set`, `volume`, `workspace`, `surface_account`, `objective`, `worker_profile`. The resource. Exactly one is set.

### ManifestDocument

One manifest document as the caller read it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `manifest` | `manifest` | `google.protobuf.Struct` | The document: `apiVersion`, `kind`, `metadata` and `spec`, as parsed from YAML or JSON. `metadata.name` is required. |
| `source` | `source` | `string` | Names the document in messages, such as `tags.yaml` or `tags.yaml document 2`. Empty uses `documents[INDEX]`. |
| `secrets` | `secrets` | map of `string` to `string` | A Surface Account's secret values by secret name, such as `botToken`, resolved from the manifest's `secrets` references by the caller: `env` and `file` from where the caller runs, `secretRef` from a secrets map such as the one in `supertag.yaml`. Set them for a SurfaceAccount document only, one per reference. The Control Plane verifies them with the provider and stores them in its credential vault. They are never returned, logged or recorded in the audit trail. |

### DiffManifestsRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `documents` | `documents` | repeated [`ManifestDocument`](#manifestdocument) | The documents, at most 16 MB in all. |
| `apply_set` | `applySet` | `string` | Plans as a member of this apply set, as `ApplyManifestsRequest.apply_set` does. |
| `prune` | `prune` | `bool` | Also plans pruning the apply set. |
| `force_conflicts` | `forceConflicts` | `bool` | Plans as `force_conflicts` would apply. |

### DiffManifestsResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `plans` | `plans` | repeated [`ManifestPlan`](#manifestplan) | One plan per document, in the order `ApplyManifests` would apply them. |
| `pruned` | `pruned` | repeated [`PruneResult`](#pruneresult) | With `prune`, what pruning would do to each member the input no longer declares, Objectives first. |

### ApplyManifestsRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `documents` | `documents` | repeated [`ManifestDocument`](#manifestdocument) | The documents, at most 16 MB in all. |
| `apply_set` | `applySet` | `string` | Applies the input as this apply set: each resource becomes a member, and the set's name is the field manager. 1 to 63 lowercase letters, digits, hyphens or underscores. Empty writes as field manager `apply`. |
| `prune` | `prune` | `bool` | After applying, removes the apply set's members the input no longer declares: cancels Objectives first, then deletes Tags, sets, Workspaces and Volumes, and retires Surface Accounts last, as `DeleteResource` does. A member still in use is kept, stays in the set, and is reported. Requires `apply_set`. |
| `force_conflicts` | `forceConflicts` | `bool` | Applies changes to fields another manager owns, and moves them to this apply's manager. |
| `create_only` | `createOnly` | `bool` | Applies only documents whose resource does not exist yet and leaves existing ones untouched, as `supertag up` provisions. |
| `imperative` | `imperative` | `bool` | Writes as field manager `cli`, as `supertag create tag` does: the fields a document lists replace the stored ones, and the fields it omits stay. |

### ApplyManifestsResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `results` | `results` | repeated [`ManifestResult`](#manifestresult) | One result per document, in the order they were applied. With `create_only`, documents whose resource existed are reported as `MANIFEST_OUTCOME_EXISTED`. |
| `complete` | `complete` | `bool` | True when every document applied. False when one failed: it is the result with `MANIFEST_OUTCOME_FAILED`, those after it are `MANIFEST_OUTCOME_NOT_APPLIED`, and pruning did not run. |
| `pruned` | `pruned` | repeated [`PruneResult`](#pruneresult) | With `prune` and `complete`, what pruning did to each member the input no longer declares, Objectives first. |

### ManifestPlan

What applying one document would change.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `document` | `document` | `int32` | The document's index in the request. |
| `kind` | `kind` | [`ResourceKind`](#resourcekind) | Its kind. |
| `name` | `name` | `string` | Its `metadata.name`. |
| `action` | `action` | [`PlanAction`](#planaction) | Whether applying it creates, updates or leaves the resource. |
| `changes` | `changes` | repeated [`FieldChange`](#fieldchange) | Each field applying would change. For a Tag location whose Surface Account the same input creates, an addition of the whole location. |
| `conflicts` | `conflicts` | repeated [`FieldConflict`](#fieldconflict) | Each field another manager owns that the document changes. |
| `refusals` | `refusals` | repeated [`FieldRefusal`](#fieldrefusal) | Each field the document changes that cannot change, such as an Objective's outcome. Applying refuses the whole input. |
| `starts_objective` | `startsObjective` | `bool` | An Objective only: applying starts its conversation, because it is new or did not start before. |
| `held` | `held` | `string` | An Objective only: why applying leaves it as it is, such as a cancelled Objective. Empty otherwise. |

### FieldChange

One field an apply changes.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `path` | `path` | `string` | The field's path, such as `spec.purpose`, or `spec.roles[Reviewer]` for one entry of a list field, keyed as the field manager rules key it. |
| `action` | `action` | [`FieldChangeAction`](#fieldchangeaction) | How it changes. |
| `before` | `before` | `google.protobuf.Value` | The value before. Unset for an addition. |
| `after` | `after` | `google.protobuf.Value` | The value after. Unset for a removal. |

### FieldConflict

A field another field manager owns.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `path` | `path` | `string` | The field's path, as in `FieldChange.path`. |
| `manager` | `manager` | `string` | The manager that owns it: `apply`, `init`, `cli`, an apply set's name, or `tag:NAME`. |

### FieldRefusal

A field that cannot change.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `path` | `path` | `string` | The field's path, as in `FieldChange.path`. |
| `reason` | `reason` | `string` | Why, in one sentence. |

### ManifestResult

What applying one document did.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `document` | `document` | `int32` | The document's index in the request. |
| `kind` | `kind` | [`ResourceKind`](#resourcekind) | Its kind. |
| `name` | `name` | `string` | Its `metadata.name`. |
| `outcome` | `outcome` | [`ManifestOutcome`](#manifestoutcome) | What happened. |
| `action` | `action` | [`PlanAction`](#planaction) | For `MANIFEST_OUTCOME_APPLIED`: whether it was created, updated or left unchanged. |
| `warnings` | `warnings` | repeated `string` | Conditions that would hold an Objective's turns or limit what they may do, and why an apply left an Objective unchanged. The apply still succeeded. |
| `started_task_id` | `startedTaskId` | `string` | An Objective only: the Task its first turn started as, when applying started it. |
| `not_started` | `notStarted` | `string` | An Objective only: why it could not start, such as an owner without a connected Worker Host. Applying again once that is fixed starts it. |
| `verification` | `verification` | [`SurfaceVerification`](#surfaceverification) | A Surface Account only: the provider account its credentials verified as. Unset when its credentials were unchanged and not verified. |
| `failure_message` | `failureMessage` | `string` | For `MANIFEST_OUTCOME_FAILED`: why, in prose for people. A failure of the Control Plane itself, with `ERROR_REASON_INTERNAL`, names no internal detail. |
| `failure` | `failure` | [`ErrorDetail`](shared.md#errordetail) | For `MANIFEST_OUTCOME_FAILED`: the stable reason and fields, as a refused call's `ErrorDetail` carries them. |

### SurfaceVerification

The provider account a Surface Account's credentials verified as.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `provider` | `provider` | [`SurfaceProvider`](surface.md#surfaceprovider) | The account's collaboration surface. |
| `display_name` | `displayName` | `string` | Its name for people, such as the Slack workspace name. |
| `external_account_id` | `externalAccountId` | `string` | Its ID at the provider. |

### PruneResult

What pruning does to one apply-set member the input no longer declares.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `kind` | `kind` | [`ResourceKind`](#resourcekind) | The member's kind. |
| `name` | `name` | `string` | Its name; an Objective's ID. |
| `action` | `action` | [`PruneAction`](#pruneaction) | What pruning does. |
| `reason` | `reason` | `string` | For `PRUNE_ACTION_KEEP`: why, such as what still uses it. |

### DeleteResourceRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `kind` | `kind` | [`ResourceKind`](#resourcekind) | The resource's kind. |
| `name` | `name` | `string` | Its name, as `GetResourceRequest.name` takes it. |
| `dry_run` | `dryRun` | `bool` | Answers as a deletion would, and changes nothing. |

### DeleteResourceResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `kind` | `kind` | [`ResourceKind`](#resourcekind) | The resource's kind. |
| `name` | `name` | `string` | Its name. |
| `dry_run` | `dryRun` | `bool` | True when nothing was changed. |
| `action` | `action` | [`DeletionAction`](#deletionaction) | Whether it was deleted or retired. |
| `removed` | `removed` | repeated `string` | What was removed with it, one line for people each, such as a Tag's location with its set activations. |
| `notes` | `notes` | repeated `string` | Effects outside the Control Plane's configuration, one line for people each, such as a Worker Host that keeps a deleted Workspace's checkout. |

### ExecutionSettings

The harness, models and reasoning efforts a Role or Tag allows. A Tag's
settings override its Roles' field by field; when several Roles set a
field, the first Role by name wins. `execution` is one field to the field
manager rules.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `harness` | `harness` | `string` | The one harness Tasks run on, such as `codex` or `claude-code`. Empty allows any harness the Worker Host offers. |
| `model` | `model` | repeated `string` | The models allowed; the first is the default. Empty allows any, and uses the Worker Host's default. |
| `effort` | `effort` | repeated [`ExecutionEffort`](#executioneffort) | The efforts allowed; the first is the default. Empty starts Tasks at `low` and allows `medium` and `high`. |

### Tag

A Tag: a persistent AI identity with its own responsibilities and
permissions.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `metadata` | `metadata` | [`Metadata`](shared.md#metadata) | Its identity and version. |
| `spec` | `spec` | [`TagSpec`](#tagspec) | What is declared. |
| `status` | `status` | [`TagStatus`](#tagstatus) | What the Control Plane observes. |

### TagSpec

A Tag's declared configuration, and the `spec` of a `Tag` manifest. Apply
merges each list entry by entry: a Role name, a Worker Host ID, a label, a
location by provider and scope ID, and a sender Tag.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `roles` | `roles` | repeated `string` | The Roles it holds, by name. |
| `worker_hosts` | `workerHosts` | repeated `string` | The Worker Hosts that may run its Tasks, by ID. An empty pool is valid, but its Tasks are refused until a host is bound. A manifest that lists them is authoritative and unbinds hosts that joined with an Auth Key but are missing. |
| `runs_on` | `runsOn` | repeated `string` | Labels a bound Worker Host must carry to run its Tasks; placement only. Labels are lowercased. |
| `execution` | `execution` | [`ExecutionSettings`](#executionsettings) | The harness, models and efforts it allows, overriding its Roles'. |
| `locations` | `locations` | repeated [`TagLocation`](#taglocation) | Where it answers, each with the sets activated there and the Workspaces its Objectives get. |
| `accepts_messages_from` | `acceptsMessagesFrom` | repeated `string` | The Tags it accepts Mailbox messages from beyond its Teams, by name. |

### TagLocation

One place on a collaboration surface where a Tag answers. In a manifest
it is `provider` beside that provider's scope fields, such as `provider:
slack` with `channelId`. A stored Tag reports the resolved `account` and
stable IDs, such as `repo_id` for a GitHub repository.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `slack` | `slack` | [`SlackLocation`](#slacklocation) | One of `place`. A Slack channel. |
| `github` | `github` | [`GithubLocation`](#githublocation) | One of `place`. A GitHub repository. |
| `lark` | `lark` | [`LarkLocation`](#larklocation) | One of `place`. A Lark chat. |
| `linear` | `linear` | [`LinearLocation`](#linearlocation) | One of `place`. A Linear team. |
| `teams` | `teams` | [`TeamsLocation`](#teamslocation) | One of `place`. A Microsoft Teams channel. |
| `account` | `account` | `string` | Selects the Surface Account by its external account ID or manifest name, when the provider has several. Empty selects the provider's only one. |
| `permission_sets` | `permissionSets` | repeated `string` | Permission Sets activated here, by name. |
| `context_sets` | `contextSets` | repeated `string` | Context Sets activated here, by name. |
| `workspaces` | `workspaces` | repeated `string` | The Workspaces an Objective created here names, in order. A GitHub location without any gives its Objectives every Workspace whose `source` is that repository. |

Oneof `place`: `slack`, `github`, `lark`, `linear`, `teams`. The provider and its scope.

### SlackLocation

A Slack channel.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `channel_id` | `channelId` | `string` | The channel ID, such as `C0123456789`. Slack IDs are uppercased. |

### GithubLocation

A GitHub repository.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `repo` | `repo` | `string` | One of `repository`. The repository as `owner/name`, which the Control Plane resolves with the account's credentials. |
| `repo_id` | `repoId` | `string` | One of `repository`. The repository's ID. |

Oneof `repository`: `repo`, `repo_id`. The repository. Exactly one is set.

### LarkLocation

A Lark chat.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `chat_id` | `chatId` | `string` | The chat ID. |

### LinearLocation

A Linear team.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `team` | `team` | `string` | One of `linear_team`. The team's name or key, which the Control Plane resolves with the account's credentials. |
| `team_id` | `teamId` | `string` | One of `linear_team`. The team's UUID. |

Oneof `linear_team`: `team`, `team_id`. The team. Exactly one is set.

### TeamsLocation

A Microsoft Teams channel.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `team_id` | `teamId` | `string` | The team ID. |
| `channel_id` | `channelId` | `string` | The channel ID. |

### TagStatus

What the Control Plane observes of a Tag.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `phase` | `phase` | [`TagPhase`](#tagphase) | Its phase. |
| `retired_at` | `retiredAt` | `google.protobuf.Timestamp` | When it was retired. Unset for an active Tag. |
| `execution` | `execution` | [`ExecutionSettings`](#executionsettings) | The range its Tasks run in: its own settings, then its Roles' in name order. |
| `locations` | `locations` | repeated [`TagLocationStatus`](#taglocationstatus) | Each location, with its Surface Account's display name and whether it is enabled. |

### TagLocationStatus

One location of a Tag, as people read it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `provider` | `provider` | [`SurfaceProvider`](surface.md#surfaceprovider) | The collaboration surface. |
| `account` | `account` | `string` | The Surface Account's display name. |
| `target` | `target` | `string` | The location for people, such as `C0123456789` for a Slack channel. |
| `enabled` | `enabled` | `bool` | Whether the location delivers events to the Tag. |

### Role

A Role: reusable policy for a responsibility.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `metadata` | `metadata` | [`Metadata`](shared.md#metadata) | Its identity and version. |
| `spec` | `spec` | [`RoleSpec`](#rolespec) | What is declared. |
| `status` | `status` | [`RoleStatus`](#rolestatus) | What the Control Plane observes. |

### RoleSpec

A Role's declared policy, and the `spec` of a `Role` manifest. Apply
merges its set lists entry by entry.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `purpose` | `purpose` | `string` | What the responsibility is for, in one sentence. |
| `instructions` | `instructions` | `string` | Instructions every Task of its Tags receives. |
| `context_sets` | `contextSets` | repeated `string` | Its Context Sets, by name, without duplicates. |
| `permission_sets` | `permissionSets` | repeated `string` | Its Permission Sets, by name, without duplicates. |
| `execution` | `execution` | [`ExecutionSettings`](#executionsettings) | The default harness, models and efforts for its Tags. |

### RoleStatus

What the Control Plane observes of a Role.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `phase` | `phase` | [`RolePhase`](#rolephase) | Its phase. |
| `assigned_tags` | `assignedTags` | repeated `string` | The Tags that hold it, by name. |

### PermissionSet

A Permission Set: reusable authority for surface actions, harness and
runtime tools, and MCP server tools.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `metadata` | `metadata` | [`Metadata`](shared.md#metadata) | Its identity and version. |
| `spec` | `spec` | [`PermissionSetSpec`](#permissionsetspec) | What is declared. |
| `status` | `status` | [`PermissionSetStatus`](#permissionsetstatus) | What the Control Plane observes. |

### PermissionSetSpec

A Permission Set's declared permissions, and the `spec` of a
`PermissionSet` manifest. Apply merges approvers and permissions entry by
entry; a permission is keyed by its target, scope or resource, and action.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `approvers` | `approvers` | repeated `string` | Who may decide its gated permissions: `operator:OPERATOR_ID` or `tag:TAG`, by name or ID. Repeated entries count once. |
| `permissions` | `permissions` | repeated [`Permission`](#permission) | Its permissions. |

### Permission

One permission. In a manifest it is `target` beside the target's fields,
`action` and `approval`.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The permission's ID. |
| `surface` | `surface` | [`SurfacePermission`](#surfacepermission) | One of `target`. An action on a collaboration surface through one Surface Account. |
| `runtime` | `runtime` | [`RuntimePermission`](#runtimepermission) | One of `target`. A harness or runtime capability, such as `commands:execute`. |
| `mcp` | `mcp` | [`McpPermission`](#mcppermission) | One of `target`. Tools of an MCP server. |
| `action` | `action` | `string` | The action, such as `commands:execute`, `issues:comment`, or for MCP `server/tool`, where the tool may be `*`. |
| `approval` | `approval` | [`PermissionApproval`](#permissionapproval) | Whether using it needs a decision first. |
| `created_by` | `createdBy` | `string` | Who added it. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was added. |

Oneof `target`: `surface`, `runtime`, `mcp`. What it grants authority over.

### SurfacePermission

Authority for an action on a collaboration surface.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `surface_account_id` | `surfaceAccountId` | `string` | The Surface Account's ID. |
| `scope` | `scope` | `string` | Where on the account, such as a channel or `owner/repo`. |
| `reference` | `reference` | `string` | A canonical, non-secret locator for the resource, used to pick the target when a request names it. |

### RuntimePermission

Authority for a harness or runtime capability.

No fields.

### McpPermission

Authority to call tools of an MCP server.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `resource` | `resource` | `string` | Limits the grant to calls whose arguments name this resource, for servers with a resource mapping. Empty: any call. |

### PermissionSetStatus

What the Control Plane observes of a Permission Set.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `bindings` | `bindings` | repeated `string` | The IDs of the Tag locations it is activated at. |

### ContextSet

A Context Set: reusable knowledge and Skills that may enter a Task.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `metadata` | `metadata` | [`Metadata`](shared.md#metadata) | Its identity and version. |
| `spec` | `spec` | [`ContextSetSpec`](#contextsetspec) | What is declared. |
| `status` | `status` | [`ContextSetStatus`](#contextsetstatus) | What the Control Plane observes. |

### ContextSetSpec

A Context Set's declared items, and the `spec` of a `ContextSet`
manifest. Apply merges items by `item_key`.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `items` | `items` | repeated [`ContextItem`](#contextitem) | Its items. |

### ContextItem

One Context Item: content a Worker resolver brings into a Task.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The item's ID. |
| `item_key` | `itemKey` | `string` | Its stable key within the set, which makes applying it idempotent. |
| `type` | `type` | `string` | The Context Item contract, such as `supertag/skill`. |
| `version` | `version` | `int32` | The contract's version. |
| `required` | `required` | `bool` | A required item fails closed when no compatible Worker resolver is available. |
| `config` | `config` | `google.protobuf.Struct` | Settings the resolver reads. Never secret. |
| `created_by` | `createdBy` | `string` | Who added it. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was added. |

### ContextSetStatus

What the Control Plane observes of a Context Set.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `bindings` | `bindings` | repeated `string` | The IDs of the Tag locations it is activated at. |

### Volume

A Volume: a named storage location outside git and the name of the
credential that reaches it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `metadata` | `metadata` | [`Metadata`](shared.md#metadata) | Its identity and version. |
| `spec` | `spec` | [`VolumeSpec`](#volumespec) | What is declared. |

### VolumeSpec

A Volume's source and credential name, and the `spec` of a `Volume`
manifest. Apply replaces it whole.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `source` | `source` | `string` | Where the data lives: `s3://BUCKET/PREFIX`, `r2://BUCKET/PREFIX`, `file:///ABSOLUTE/PATH` on the Worker Host, and for native mounts `gs://BUCKET/PREFIX/` or `modal-volume://NAME/PREFIX/`. S3 and R2 accept the `region`, `endpoint` and `forcePathStyle` query parameters. Credentials, fragments, and `.` or `..` segments are refused. |
| `credential` | `credential` | `string` | The name each Worker Host maps to a secret, a provider-held reference or its consent. Never a secret value: one that looks like a key is refused. |

### Workspace

A Workspace: a named repository Objectives may work in.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `metadata` | `metadata` | [`Metadata`](shared.md#metadata) | Its identity and version. |
| `spec` | `spec` | [`WorkspaceSpec`](#workspacespec) | What is declared. |
| `status` | `status` | [`WorkspaceStatus`](#workspacestatus) | What the Control Plane observes. |

### WorkspaceSpec

A Workspace's declared fields, and the `spec` of a `Workspace` manifest.
Every field is optional, and a manifest may leave out `spec`. A field an
earlier apply set that a later manifest omits returns to its default.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `source` | `source` | `string` | The git remote hosts without a checkout clone. Embedded credentials are refused. Required with `mounts`, and a github.com remote with `pull-request` delivery. |
| `ref` | `ref` | `string` | The base of each new Session branch. Empty: the checkout's current branch, or the source's default branch in a clone, else `main`. |
| `setup` | `setup` | `string` | One shell command, on one line, run once in each new Task worktree. |
| `mcp` | `mcp` | repeated `string` | Server names selected from the trusted checkout's `.mcp.json`, without duplicates. |
| `skills` | `skills` | repeated `string` | Skill names selected from the host checkout, without duplicates. |
| `skill_catalog` | `skillCatalog` | [`WorkspaceSkillCatalog`](#workspaceskillcatalog) | Skills from a GitHub repository, selected for every Task. |
| `mounts` | `mounts` | repeated [`WorkspaceMount`](#workspacemount) | Volumes attached at absolute paths outside the checkout. Paths may not overlap each other, staged files or protected system locations. |
| `delivery` | `delivery` | [`WorkspaceDeliveryMode`](shared.md#workspacedeliverymode) | How Tasks deliver their changes. Unset: `branch`. |

### WorkspaceSkillCatalog

Skills from a GitHub repository at one revision.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `repository` | `repository` | `string` | The repository as `OWNER/REPO`. |
| `path` | `path` | `string` | The directory within it that holds the Skills. |
| `revision` | `revision` | `string` | The branch, tag or commit to read. |
| `skills` | `skills` | repeated `string` | The Skill names, distinct from `WorkspaceSpec.skills`. |

### WorkspaceMount

One Volume attached to a Workspace's Tasks.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `volume` | `volume` | `string` | The Volume's name. |
| `path` | `path` | `string` | The absolute path it appears at, outside the checkout. |
| `access` | `access` | [`MountAccess`](work.md#mountaccess) | How the Task may use it. Unset: `read-only`. |
| `strategy` | `strategy` | [`WorkspaceMountStrategy`](#workspacemountstrategy) | How it is attached. Unset: `copy`. |
| `max_bytes` | `maxBytes` | optional `int64` | The most bytes a copy may hold. Unset: only the 20 GiB limit of every Task Attempt. |

### WorkspaceStatus

What the Control Plane observes of a Workspace.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `worker_hosts` | `workerHosts` | repeated [`WorkspaceWorkerHost`](#workspaceworkerhost) | Enrolled Worker Hosts whose latest descriptor declares a checkout of it, by ID. |
| `environments` | `environments` | repeated [`WorkspaceEnvironment`](#workspaceenvironment) | Enrolled Worker Hosts that serve it, by environment provider, with what their latest Task Attempt prepared. Only `GetResource` sets it. |

### WorkspaceWorkerHost

A Worker Host with a checkout of a Workspace.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The host's ID. |
| `connection` | `connection` | [`WorkerHostConnection`](host.md#workerhostconnection) | Whether its Worklet is connected. |

### WorkspaceEnvironment

How one Worker Host serves a Workspace.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `worker_host_id` | `workerHostId` | `string` | The host's ID. |
| `connection` | `connection` | [`WorkerHostConnection`](host.md#workerhostconnection) | Whether its Worklet is connected. |
| `provider` | `provider` | `string` | The environment provider: `local`, or a remote sandbox provider such as `e2b` or `modal`. |
| `prepared` | `prepared` | [`PreparedWorkspace`](work.md#preparedworkspace) | The environment the host's latest Task Attempt prepared. Unset when none reported one. |
| `prepared_at` | `preparedAt` | `google.protobuf.Timestamp` | When that Task Attempt reported it. |
| `refusal` | `refusal` | `string` | Why the host's provider refuses the Workspace's Tasks. Empty when it does not. |

### WorkerProfile

A Worker Profile: a versioned execution configuration a Worker on one
Worker Host advertises. It is observed, never applied.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `metadata` | `metadata` | [`Metadata`](shared.md#metadata) | `id` is `HOST:WORKER:PROFILE@REVISION` and `name` is `PROFILE@REVISION`. Both timestamps are when the Control Plane started. |
| `spec` | `spec` | [`WorkerProfileSpec`](#workerprofilespec) | Which profile. |
| `status` | `status` | [`WorkerProfileStatus`](#workerprofilestatus) | Where it is offered. |

### WorkerProfileSpec

Which Worker Profile.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `ref` | `ref` | [`WorkerProfileRef`](work.md#workerprofileref) | The profile and its revision. |

### WorkerProfileStatus

Where a Worker Profile is offered.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `phase` | `phase` | [`WorkerProfilePhase`](#workerprofilephase) | Whether its Worker Host is ready. |
| `worker_host_id` | `workerHostId` | `string` | The Worker Host's ID. |
| `worklet_id` | `workletId` | `string` | The Worklet's ID. |
| `worker_id` | `workerId` | `string` | The Worker's ID on that host. |

### SurfaceAccountManifestSpec

The `spec` of a `SurfaceAccount` manifest: one connected account of a
collaboration surface. In a manifest it is `provider` beside that
provider's fields. Its secrets are references, never values; a literal
value is invalid. `metadata.name` stays bound to the provider account it
first named. Apply merges `configuration` and `secrets` entry by entry.

Reading a Surface Account returns `SurfaceAccount`, with the fields its
verification recorded.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `slack` | `slack` | [`SlackAccountSpec`](#slackaccountspec) | One of `account`. A Slack workspace. |
| `github` | `github` | [`GithubAccountSpec`](#githubaccountspec) | One of `account`. A GitHub token or GitHub App installation. |
| `lark` | `lark` | [`LarkAccountSpec`](#larkaccountspec) | One of `account`. A Lark or Feishu app. |
| `linear` | `linear` | [`LinearAccountSpec`](#linearaccountspec) | One of `account`. A Linear workspace. |
| `teams` | `teams` | [`TeamsAccountSpec`](#teamsaccountspec) | One of `account`. A Microsoft Teams tenant. |

Oneof `account`: `slack`, `github`, `lark`, `linear`, `teams`. The provider and its fields.

### SlackAccountSpec

A Slack Surface Account. Socket Mode needs `appToken`; HTTP events need
`signingSecret`.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `display_name` | `displayName` | `string` | Overrides the workspace name Slack reports. |
| `configuration` | `configuration` | [`SlackAccountConfiguration`](#slackaccountconfiguration) | Its options. |
| `secrets` | `secrets` | [`SlackAccountSecrets`](#slackaccountsecrets) | Where its secrets come from. |

### SlackAccountConfiguration

A Slack Surface Account's options.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `transport` | `transport` | [`SlackTransport`](#slacktransport) | How events arrive. Unset: `socket`. |

### SlackAccountSecrets

Where a Slack Surface Account's secrets come from.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `bot_token` | `botToken` | [`SurfaceSecretReference`](surface.md#surfacesecretreference) | The bot token. |
| `app_token` | `appToken` | [`SurfaceSecretReference`](surface.md#surfacesecretreference) | The app-level token, for Socket Mode. |
| `signing_secret` | `signingSecret` | [`SurfaceSecretReference`](surface.md#surfacesecretreference) | The signing secret, for HTTP events. |

### GithubAccountSpec

A GitHub Surface Account. A fine-grained token needs `token`; a GitHub App
needs `appId`, `installationId`, `privateKey` and `webhookSecret`.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `display_name` | `displayName` | `string` | Overrides the account name GitHub reports. |
| `configuration` | `configuration` | [`GithubAccountConfiguration`](#githubaccountconfiguration) | Its options. |
| `secrets` | `secrets` | [`GithubAccountSecrets`](#githubaccountsecrets) | Where its secrets come from. |

### GithubAccountConfiguration

A GitHub Surface Account's options.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `auth` | `auth` | [`GithubAuth`](#githubauth) | How SuperTag authenticates. Unset: `token`. |
| `api_base_url` | `apiBaseUrl` | `string` | The API's base URL, for GitHub Enterprise Server. |
| `app_id` | `appId` | `string` | The GitHub App's ID, for `auth: app`. |
| `installation_id` | `installationId` | `string` | The GitHub App installation's ID, for `auth: app`. |

### GithubAccountSecrets

Where a GitHub Surface Account's secrets come from.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `token` | `token` | [`SurfaceSecretReference`](surface.md#surfacesecretreference) | The fine-grained token, for `auth: token`. |
| `private_key` | `privateKey` | [`SurfaceSecretReference`](surface.md#surfacesecretreference) | The GitHub App's private key, for `auth: app`. |
| `webhook_secret` | `webhookSecret` | [`SurfaceSecretReference`](surface.md#surfacesecretreference) | The webhook secret, for `auth: app`. |

### LarkAccountSpec

A Lark or Feishu Surface Account.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `display_name` | `displayName` | `string` | Overrides the app name Lark reports. |
| `configuration` | `configuration` | [`LarkAccountConfiguration`](#larkaccountconfiguration) | Its options. |
| `secrets` | `secrets` | [`LarkAccountSecrets`](#larkaccountsecrets) | Where its secrets come from. |

### LarkAccountConfiguration

A Lark Surface Account's options.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `app_id` | `appId` | `string` | The app's ID. |
| `domain` | `domain` | [`LarkDomain`](#larkdomain) | Which service. Unset: `lark`. |

### LarkAccountSecrets

Where a Lark Surface Account's secrets come from.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `app_secret` | `appSecret` | [`SurfaceSecretReference`](surface.md#surfacesecretreference) | The app secret. |

### LinearAccountSpec

A Linear Surface Account.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `display_name` | `displayName` | `string` | Overrides the workspace name Linear reports. |
| `configuration` | `configuration` | [`LinearAccountConfiguration`](#linearaccountconfiguration) | Its options. |
| `secrets` | `secrets` | [`LinearAccountSecrets`](#linearaccountsecrets) | Where its secrets come from. |

### LinearAccountConfiguration

A Linear Surface Account's options.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `api_base_url` | `apiBaseUrl` | `string` | The API's base URL. |

### LinearAccountSecrets

Where a Linear Surface Account's secrets come from.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `api_key` | `apiKey` | [`SurfaceSecretReference`](surface.md#surfacesecretreference) | The API key. |
| `webhook_secret` | `webhookSecret` | [`SurfaceSecretReference`](surface.md#surfacesecretreference) | The webhook signing secret. |

### TeamsAccountSpec

A Microsoft Teams Surface Account.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `display_name` | `displayName` | `string` | The tenant's name for people. Empty: the tenant ID. |
| `configuration` | `configuration` | [`TeamsAccountConfiguration`](#teamsaccountconfiguration) | Its options. |
| `secrets` | `secrets` | [`TeamsAccountSecrets`](#teamsaccountsecrets) | Where its secrets come from. |

### TeamsAccountConfiguration

A Microsoft Teams Surface Account's options.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `app_id` | `appId` | `string` | The bot's app ID. |
| `tenant_id` | `tenantId` | `string` | The tenant's ID. It may not name another account's tenant. |

### TeamsAccountSecrets

Where a Microsoft Teams Surface Account's secrets come from.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `app_secret` | `appSecret` | [`SurfaceSecretReference`](surface.md#surfacesecretreference) | The bot's app secret. |

### DeclaredObjective

An Objective as a manifest declares it. Its status, history and spend are
`ObjectiveService`'s.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `metadata` | `metadata` | [`Metadata`](shared.md#metadata) | `name` is the Objective's ID. |
| `spec` | `spec` | [`ObjectiveDeclaration`](#objectivedeclaration) | What is declared. |

### ObjectiveDeclaration

The `spec` of an `Objective` manifest: standing work declared beside the
Tags that do it. `metadata.name` is the Objective's ID. Owner, outcome,
`ongoing`, Workspaces and which Team it names are fixed once it exists, and
apply refuses a change to them. The deadline and runtime actions change,
the budget only increases, and its own Team's fields change in place. A
manifest that stops setting the budget, deadline or runtime actions leaves
the stored value. A manifest has no `status`.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `owner` | `owner` | `string` | The owner Tag's name. |
| `outcome` | `outcome` | `string` | One natural-language statement: the result, how success is verified, what must not change, and when to ask a person. |
| `ongoing` | `ongoing` | `bool` | A continuing responsibility that only an operator can end. |
| `workspaces` | `workspaces` | repeated `string` | Names of existing Workspaces its work may use. |
| `budget` | `budget` | [`ObjectiveBudgetDeclaration`](#objectivebudgetdeclaration) | Its allocation limit. |
| `deadline` | `deadline` | `google.protobuf.Timestamp` | Its deadline. |
| `runtime_actions` | `runtimeActions` | repeated `string` | Runtime actions, such as `files:write`, for turns admitted afterwards. A list narrows what the owner's Permission Sets allow. Omitted from a new Objective: what they allow when it is created. |
| `team_name` | `teamName` | `string` | One of `team`. An existing Team, by name. Apply leaves it as it is. |
| `own_team` | `ownTeam` | [`ObjectiveTeamDeclaration`](#objectiveteamdeclaration) | One of `team`. The Objective's own Team, whose ID is the Objective's ID. Apply creates and updates it. |

Oneof `team`: `team_name`, `own_team`. The Team whose members the owner may hand work to. In a manifest it is
one field, `team`: a Team's name, or the Objective's own Team.

### ObjectiveBudgetDeclaration

An Objective's budget as a manifest declares it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `minor` | `minor` | `int64` | The limit in minor units of `currency`, or in allocation units without one. |
| `currency` | `currency` | `string` | The ISO 4217 code, such as `USD`. With one, the budget caps provider-reported cost. |

### ObjectiveTeamDeclaration

An Objective's own Team as a manifest declares it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `name` | `name` | `string` | The Team's name. Empty: the Objective's ID. |
| `members` | `members` | repeated `string` | The member Tags, by name. |
| `max_concurrency` | `maxConcurrency` | optional `int32` | At most this many turns run at once across the Team's Objectives. Unset: only Worker Host capacity limits them. |

## Enums

### ResourceKind

A kind of resource. Its `manifest_value` is the manifest's `kind`.

| Value | Description |
| --- | --- |
| `RESOURCE_KIND_UNSPECIFIED` |  |
| `RESOURCE_KIND_TAG` | A Tag. |
| `RESOURCE_KIND_ROLE` | A Role. |
| `RESOURCE_KIND_PERMISSION_SET` | A Permission Set. |
| `RESOURCE_KIND_CONTEXT_SET` | A Context Set. |
| `RESOURCE_KIND_VOLUME` | A Volume. |
| `RESOURCE_KIND_WORKSPACE` | A Workspace. |
| `RESOURCE_KIND_SURFACE_ACCOUNT` | A Surface Account. |
| `RESOURCE_KIND_OBJECTIVE` | A declared Objective. |
| `RESOURCE_KIND_WORKER_PROFILE` | A Worker Profile a Worker Host advertises. It cannot be applied. |

### PlanAction

Whether an apply creates, updates or leaves a resource.

| Value | Description |
| --- | --- |
| `PLAN_ACTION_UNSPECIFIED` |  |
| `PLAN_ACTION_CREATE` | The resource does not exist yet. |
| `PLAN_ACTION_UPDATE` | At least one field changes. |
| `PLAN_ACTION_UNCHANGED` | Nothing changes. |

### FieldChangeAction

How a field changes.

| Value | Description |
| --- | --- |
| `FIELD_CHANGE_ACTION_UNSPECIFIED` |  |
| `FIELD_CHANGE_ACTION_ADD` | The field or list entry is added. |
| `FIELD_CHANGE_ACTION_REMOVE` | The field or list entry is removed, or a single value returns to its default. |
| `FIELD_CHANGE_ACTION_CHANGE` | The value changes. |

### ManifestOutcome

What happened to one document of an apply.

| Value | Description |
| --- | --- |
| `MANIFEST_OUTCOME_UNSPECIFIED` |  |
| `MANIFEST_OUTCOME_APPLIED` | It was applied. |
| `MANIFEST_OUTCOME_EXISTED` | With `create_only`, its resource already existed and was left untouched. |
| `MANIFEST_OUTCOME_FAILED` | Applying it failed. Nothing after it was applied. |
| `MANIFEST_OUTCOME_NOT_APPLIED` | It was not applied because a document before it failed. |

### PruneAction

What pruning does to one member.

| Value | Description |
| --- | --- |
| `PRUNE_ACTION_UNSPECIFIED` |  |
| `PRUNE_ACTION_DELETE` | It is deleted, or retired, as `DeleteResource` does. |
| `PRUNE_ACTION_CANCEL` | An Objective is cancelled and keeps its history. |
| `PRUNE_ACTION_KEEP` | It is kept because something still uses it, or an Objective completed. It stays in the set for the next prune. |

### DeletionAction

How a deletion removes a resource.

| Value | Description |
| --- | --- |
| `DELETION_ACTION_UNSPECIFIED` |  |
| `DELETION_ACTION_RETIRE` | The record stays for history, and the name is free again. |
| `DELETION_ACTION_DELETE` | The record is deleted. |

### ExecutionEffort

A reasoning effort. Each harness maps it to its own option.

| Value | Description |
| --- | --- |
| `EXECUTION_EFFORT_UNSPECIFIED` |  |
| `EXECUTION_EFFORT_LOW` | Low effort. |
| `EXECUTION_EFFORT_MEDIUM` | Medium effort. |
| `EXECUTION_EFFORT_HIGH` | High effort. |

### TagPhase

A Tag's phase.

| Value | Description |
| --- | --- |
| `TAG_PHASE_UNSPECIFIED` |  |
| `TAG_PHASE_ACTIVE` | It receives work. |
| `TAG_PHASE_RETIRED` | It was deleted. Its record stays for history; it receives no work. |

### RolePhase

A Role's phase.

| Value | Description |
| --- | --- |
| `ROLE_PHASE_UNSPECIFIED` |  |
| `ROLE_PHASE_ACTIVE` | Tags may hold it. |
| `ROLE_PHASE_RETIRED` | It was deleted. Its record stays for history. |

### PermissionApproval

Whether a permission is gated.

| Value | Description |
| --- | --- |
| `PERMISSION_APPROVAL_UNSPECIFIED` | Not gated. |
| `PERMISSION_APPROVAL_REQUIRED` | Each use needs a decision from one of the set's approvers. |

### WorkspaceMountStrategy

How a Volume is attached to a Task.

| Value | Description |
| --- | --- |
| `WORKSPACE_MOUNT_STRATEGY_UNSPECIFIED` |  |
| `WORKSPACE_MOUNT_STRATEGY_COPY` | Its files are copied in before the Task starts. |
| `WORKSPACE_MOUNT_STRATEGY_MOUNT` | It is mounted live, on providers that support native mounts. |

### WorkerProfilePhase

Whether a Worker Profile can take Tasks.

| Value | Description |
| --- | --- |
| `WORKER_PROFILE_PHASE_UNSPECIFIED` |  |
| `WORKER_PROFILE_PHASE_AVAILABLE` | Its Worker Host is ready. |
| `WORKER_PROFILE_PHASE_UNAVAILABLE` | Its Worker Host is not ready. |

### SlackTransport

How a Slack Surface Account receives events.

| Value | Description |
| --- | --- |
| `SLACK_TRANSPORT_UNSPECIFIED` |  |
| `SLACK_TRANSPORT_SOCKET` | Socket Mode, with an app-level token. |
| `SLACK_TRANSPORT_HTTP` | Signed events sent to the Gateway. |

### GithubAuth

How a GitHub Surface Account authenticates.

| Value | Description |
| --- | --- |
| `GITHUB_AUTH_UNSPECIFIED` |  |
| `GITHUB_AUTH_TOKEN` | A fine-grained token. |
| `GITHUB_AUTH_APP` | A GitHub App installation. |

### LarkDomain

Which Lark service an account uses.

| Value | Description |
| --- | --- |
| `LARK_DOMAIN_UNSPECIFIED` |  |
| `LARK_DOMAIN_LARK` | Lark. |
| `LARK_DOMAIN_FEISHU` | Feishu. |
