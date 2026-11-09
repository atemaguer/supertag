# SurfaceService

<!-- Generated from spec/proto/supertag/operator/v1 by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->

`supertag.operator.v1.SurfaceService` in [`surface.proto`](../../../spec/proto/supertag/operator/v1/surface.proto). How to call an RPC, authenticate, and
read its errors is in the [Control Plane API Server](../control-plane-api.md) guide; the conventions every
RPC follows are in [Shared messages and options](shared.md#conventions).

Collaboration surface connections and where Tags answer on them: `supertag
setup surface`, `list surface`, `get surface`, `update tag --add-location`
and `--remove-location`, and `activate` and `deactivate` of a Context Set
or Permission Set.

A Surface Account is one connected account of a collaboration surface,
such as a Slack workspace or a GitHub App installation. The Control Plane
keeps its credentials in its credential vault and never returns them. A
location is one place on a Surface Account where a Tag answers, such as a
Slack channel or a GitHub repository. A Context Set or Permission Set
applies to a Tag only in the locations it is activated for.

The webhooks collaboration surfaces call stay plain HTTP. Applying and
deleting SurfaceAccount manifests is `ResourceService`'s.

Access. The admin token and Operator Tokens may call every RPC; a scoped
coordination credential is refused with `PermissionDenied`. Every caller
sees every Surface Account.

Every RPC that names a Tag takes its name, and fails with `InvalidArgument`
for an empty one and `NotFound` for a Tag that does not exist or was
deleted. A call while the Control Plane drains fails with `Unavailable` and
`ERROR_REASON_DRAINING`.

## RPCs

### SetUpSurface

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.SurfaceService/SetUpSurface` |
| Request | [`SetUpSurfaceRequest`](#setupsurfacerequest) |
| Response | [`SurfaceAccount`](#surfaceaccount) |
| Action | `set_up_surface` |
| Callers | The admin token and Operator Tokens |
| Audit log | `surface.enroll` |

Saves a Surface Account whose credentials the caller already verified
with its provider, as `supertag setup surface` does. The secrets go to
the credential vault, and the account's phase becomes
`SURFACE_ACCOUNT_PHASE_CONNECTED`. An account with the same provider and
`external_account_id` is updated in place, so repeating the call changes
nothing more; a retired account is connected again. Its manifest name
and secret references are kept.

It fails with `InvalidArgument`, and `fields` naming each one, for a
missing provider or an empty `external_account_id`, `display_name` or
`auth_method`.

### ListSurfaceAccounts

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.SurfaceService/ListSurfaceAccounts` |
| Request | [`ListSurfaceAccountsRequest`](#listsurfaceaccountsrequest) |
| Response | [`ListSurfaceAccountsResponse`](#listsurfaceaccountsresponse) |
| Action | `read_surface_account` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists connected Surface Accounts, the earliest created first, as
`supertag list surface` shows them. Retired accounts are left out, as
they are from `GetSurfaceAccount`. It fails with `InvalidArgument` for a
malformed `page_token`.

### GetSurfaceAccount

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.SurfaceService/GetSurfaceAccount` |
| Request | [`GetSurfaceAccountRequest`](#getsurfaceaccountrequest) |
| Response | [`SurfaceAccount`](#surfaceaccount) |
| Action | `read_surface_account` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Reads one Surface Account, as `supertag get surface` shows it. It fails
with `InvalidArgument` for an empty `name` and `NotFound` for an account
it names none of.

### AddTagLocation

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.SurfaceService/AddTagLocation` |
| Request | [`AddTagLocationRequest`](#addtaglocationrequest) |
| Response | [`TagLocationChange`](#taglocationchange) |
| Action | `manage_tag_location` |
| Callers | The admin token and Operator Tokens |
| Audit log | `tag.location.add` |

Makes a Tag answer in a location, as `supertag update tag
--add-location` does. The Control Plane resolves the location on its
Surface Account, asking the provider with the account's credentials when
the location names a GitHub repository or a Linear team by name. Adding
a location the Tag already has changes nothing and succeeds with
`changed` false. A location has at most one Tag: adding one another Tag
has fails with `FailedPrecondition` and `ERROR_REASON_CONFLICT`.

It fails with `InvalidArgument`, and `fields` naming the field, when a
field the provider needs is empty or one it does not use is set, and
`FailedPrecondition` and `ERROR_REASON_CONFLICT` when `location.account`
selects no Surface Account of the provider or more than one. It fails
with `NotFound` when the provider does not know the repository or team,
and `Unavailable` when the provider cannot be reached.

### RemoveTagLocation

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.SurfaceService/RemoveTagLocation` |
| Request | [`RemoveTagLocationRequest`](#removetaglocationrequest) |
| Response | [`TagLocationChange`](#taglocationchange) |
| Action | `manage_tag_location` |
| Callers | The admin token and Operator Tokens |
| Audit log | `tag.location.remove` |

Stops a Tag answering in a location, as `supertag update tag
--remove-location` does, and deactivates every Context Set and
Permission Set activated there. Removing a location the Tag does not
have changes nothing and succeeds with `changed` false. It fails as
`AddTagLocation` does.

### ActivateSet

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.SurfaceService/ActivateSet` |
| Request | [`ActivateSetRequest`](#activatesetrequest) |
| Response | [`SetActivationChange`](#setactivationchange) |
| Action | `manage_set_activation` |
| Callers | The admin token and Operator Tokens |
| Audit log | `tag.set.activate` |

Activates a Context Set or Permission Set of a Tag in one of the Tag's
locations, as `supertag activate context-set` and `activate
permission-set` do. Activating a set that is already active there
changes nothing. It fails with `NotFound` when the Tag has no set of
that kind and name, and `FailedPrecondition` and `ERROR_REASON_CONFLICT`
when the Tag does not answer in the location. Otherwise it fails as
`AddTagLocation` does.

### DeactivateSet

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.SurfaceService/DeactivateSet` |
| Request | [`DeactivateSetRequest`](#deactivatesetrequest) |
| Response | [`SetActivationChange`](#setactivationchange) |
| Action | `manage_set_activation` |
| Callers | The admin token and Operator Tokens |
| Audit log | `tag.set.deactivate` |

Deactivates a Context Set or Permission Set of a Tag in one of the Tag's
locations, as `supertag deactivate context-set` and `deactivate
permission-set` do. Deactivating a set that is not active there changes
nothing. It fails as `ActivateSet` does.

## Messages

### SetUpSurfaceRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `provider` | `provider` | [`SurfaceProvider`](#surfaceprovider) | The account's collaboration surface. |
| `external_account_id` | `externalAccountId` | `string` | The account's ID at the provider, such as a Slack team ID or a GitHub App installation ID. |
| `display_name` | `displayName` | `string` | The account's name for people, such as the Slack workspace name. |
| `auth_method` | `authMethod` | `string` | How SuperTag authenticates to the provider, such as `slack-socket-mode` or `github-app`. |
| `configuration` | `configuration` | `google.protobuf.Struct` | Settings that are not secret, such as an API base URL or an App ID. |
| `secrets` | `secrets` | map of `string` to `string` | The verified credentials by name, such as `botToken`. The Control Plane stores them in its credential vault. They are never returned, logged or recorded in the audit trail. |

### ListSurfaceAccountsRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `page_size` | `pageSize` | `int32` | At most this many accounts; 0 means 100, and more than 500 means 500. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListSurfaceAccountsResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `surface_accounts` | `surfaceAccounts` | repeated [`SurfaceAccount`](#surfaceaccount) | The accounts, the earliest created first. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### GetSurfaceAccountRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `name` | `name` | `string` | The account's `metadata.name`: its SurfaceAccount manifest name, or `PROVIDER:EXTERNAL_ACCOUNT_ID` for an account set up with `supertag setup surface`, such as `slack:T0123456789`. A manifest name wins over the other form. |

### AddTagLocationRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `location` | `location` | [`SurfaceLocation`](#surfacelocation) | The location. |

### RemoveTagLocationRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `location` | `location` | [`SurfaceLocation`](#surfacelocation) | The location. |

### ActivateSetRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `kind` | `kind` | [`SetKind`](#setkind) | Whether `set` names a Context Set or a Permission Set. |
| `set` | `set` | `string` | The set's name. |
| `tag` | `tag` | `string` | The Tag's name. |
| `location` | `location` | [`SurfaceLocation`](#surfacelocation) | One of the Tag's locations. |

### DeactivateSetRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `kind` | `kind` | [`SetKind`](#setkind) | Whether `set` names a Context Set or a Permission Set. |
| `set` | `set` | `string` | The set's name. |
| `tag` | `tag` | `string` | The Tag's name. |
| `location` | `location` | [`SurfaceLocation`](#surfacelocation) | One of the Tag's locations. |

### SurfaceLocation

One place on a collaboration surface, as the `--add-location` flags name
it. Set the fields the provider needs and no others:

| Provider | Fields |
| --- | --- |
| Slack | `channel_id` |
| Lark | `chat_id` |
| Microsoft Teams | `team_id` and `channel_id` |
| GitHub | `repo` or `repo_id` |
| Linear | `team` or `team_id` |

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `provider` | `provider` | [`SurfaceProvider`](#surfaceprovider) | The collaboration surface. |
| `account` | `account` | `string` | Selects the Surface Account by its ID, its external account ID or its manifest name. Empty selects the provider's only Surface Account. |
| `channel_id` | `channelId` | `string` | A Slack channel ID, such as `C0123456789`, or a Microsoft Teams channel ID. Slack IDs are uppercased. |
| `chat_id` | `chatId` | `string` | A Lark chat ID. |
| `team_id` | `teamId` | `string` | A Microsoft Teams team ID, or a Linear team UUID. |
| `team` | `team` | `string` | A Linear team's name or key, which the Control Plane resolves with the account's credentials. |
| `repo_id` | `repoId` | `string` | A GitHub repository ID. |
| `repo` | `repo` | `string` | A GitHub repository as `owner/name`, which the Control Plane resolves with the account's credentials. |

### TagLocationChange

What `AddTagLocation` or `RemoveTagLocation` did.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `tag_id` | `tagId` | `string` | The Tag's ID. |
| `provider` | `provider` | [`SurfaceProvider`](#surfaceprovider) | The location's collaboration surface. |
| `location` | `location` | `string` | The location for people, such as `C0123456789` for a Slack channel or `chat oc_123` for a Lark chat. |
| `surface_account_id` | `surfaceAccountId` | `string` | The Surface Account's ID. |
| `account_display_name` | `accountDisplayName` | `string` | The Surface Account's name for people. |
| `changed` | `changed` | `bool` | False when the Tag already had the location, or did not have it, and nothing changed. |

### SetActivationChange

What `ActivateSet` or `DeactivateSet` did.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `kind` | `kind` | [`SetKind`](#setkind) | The set's kind. |
| `set` | `set` | `string` | The set's name. |
| `tag` | `tag` | `string` | The Tag's name. |
| `provider` | `provider` | [`SurfaceProvider`](#surfaceprovider) | The location's collaboration surface. |
| `location` | `location` | `string` | The location for people, as in `TagLocationChange.location`. |
| `surface_account_id` | `surfaceAccountId` | `string` | The Surface Account's ID. |

### SurfaceAccount

One Surface Account, without its credentials.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `metadata` | `metadata` | [`Metadata`](shared.md#metadata) | `name` is the SurfaceAccount manifest name, or `PROVIDER:EXTERNAL_ACCOUNT_ID` for an account set up with `supertag setup surface`. `resource_version` changes when the account changes. |
| `provider` | `provider` | [`SurfaceProvider`](#surfaceprovider) | Its collaboration surface. |
| `external_account_id` | `externalAccountId` | `string` | Its ID at the provider. |
| `display_name` | `displayName` | `string` | Its name for people. |
| `auth_method` | `authMethod` | `string` | How SuperTag authenticates to the provider. |
| `configuration` | `configuration` | `google.protobuf.Struct` | Its settings that are not secret. |
| `secrets` | `secrets` | [`SurfaceSecretReferences`](#surfacesecretreferences) | Where each secret came from when a manifest last applied the account. Unset for an account only `supertag setup surface` set up. |
| `phase` | `phase` | [`SurfaceAccountPhase`](#surfaceaccountphase) | Its phase. |
| `last_verified_at` | `lastVerifiedAt` | `google.protobuf.Timestamp` | When its credentials were last verified. |

### SurfaceSecretReferences

Where a SurfaceAccount manifest took its secrets from.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `references` | `references` | map of `string` to [`SurfaceSecretReference`](#surfacesecretreference) | The reference of each secret, by the secret's name. |

### SurfaceSecretReference

Where a SurfaceAccount manifest takes one secret from. Never the value.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `secret_ref` | `secretRef` | `string` | One of `source`. A named secret its caller resolves, such as an entry in the `secrets` map of `supertag.yaml`. |
| `env` | `env` | `string` | One of `source`. An environment variable the applying caller reads. |
| `file` | `file` | `string` | One of `source`. A file the applying caller reads. A relative path starts from the manifest's directory. |

Oneof `source`: `secret_ref`, `env`, `file`. Where the secret comes from. A manifest sets exactly one.

## Enums

### SetKind

A kind of set a Tag activates per location.

| Value | Description |
| --- | --- |
| `SET_KIND_UNSPECIFIED` |  |
| `SET_KIND_CONTEXT_SET` | A Context Set: what the Tag knows. |
| `SET_KIND_PERMISSION_SET` | A Permission Set: what the Tag may do. |

### SurfaceProvider

A collaboration surface.

| Value | Description |
| --- | --- |
| `SURFACE_PROVIDER_UNSPECIFIED` |  |
| `SURFACE_PROVIDER_SLACK` | Slack. |
| `SURFACE_PROVIDER_GITHUB` | GitHub. |
| `SURFACE_PROVIDER_LARK` | Lark. |
| `SURFACE_PROVIDER_LINEAR` | Linear. |
| `SURFACE_PROVIDER_TEAMS` | Microsoft Teams. |

### SurfaceAccountPhase

A Surface Account's phase.

| Value | Description |
| --- | --- |
| `SURFACE_ACCOUNT_PHASE_UNSPECIFIED` |  |
| `SURFACE_ACCOUNT_PHASE_CONNECTED` | It receives and sends. |
| `SURFACE_ACCOUNT_PHASE_RETIRED` | It keeps its history but receives and sends nothing, and holds no credential. |
