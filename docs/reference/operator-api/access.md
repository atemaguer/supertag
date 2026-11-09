# AccessService

<!-- Generated from spec/proto/supertag/operator/v1 by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->

`supertag.operator.v1.AccessService` in [`access.proto`](../../../spec/proto/supertag/operator/v1/access.proto). How to call an RPC, authenticate, and
read its errors is in the [Control Plane API Server](../control-plane-api.md) guide; the conventions every
RPC follows are in [Shared messages and options](shared.md#conventions).

Operator Tokens: `supertag create operator-token`, `list operator-token`,
`get operator-token` and `revoke operator-token`.

An Operator Token lets one teammate or machine manage a shared Control
Plane without the admin token. It carries every operator action except
managing Operator Tokens, and the changes made with it are recorded as
`token:NAME`. A token expires 90 days after it is created.

Access. Only the Control Plane admin token may call these RPCs. An
Operator Token or a scoped coordination credential is refused with
`PermissionDenied`.

Every RPC that names an Operator Token takes its name, and fails with
`InvalidArgument` for an empty one and `NotFound` for a token that does not
exist. A call while the Control Plane drains fails with `Unavailable` and
`ERROR_REASON_DRAINING`.

## RPCs

### CreateOperatorToken

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.AccessService/CreateOperatorToken` |
| Request | [`CreateOperatorTokenRequest`](#createoperatortokenrequest) |
| Response | [`CreateOperatorTokenResponse`](#createoperatortokenresponse) |
| Action | `manage_operator_token` |
| Callers | The admin token only |
| Audit log | `operator-token.create` |

Creates an Operator Token and returns its secret, as `supertag create
operator-token` does. The secret is returned only by this call and is
never stored in readable form.

Names are never reused, so an audit entry that names `token:NAME` always
means one token. Repeating the call, or using the name of a revoked or
expired token, changes nothing and fails with `AlreadyExists` and
`ERROR_REASON_CONFLICT`. It fails with `InvalidArgument` for a malformed
name.

### ListOperatorTokens

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.AccessService/ListOperatorTokens` |
| Request | [`ListOperatorTokensRequest`](#listoperatortokensrequest) |
| Response | [`ListOperatorTokensResponse`](#listoperatortokensresponse) |
| Action | `read_operator_token` |
| Callers | The admin token only |
| Audit log | Nothing; reads only |

Lists Operator Tokens, the earliest created first, then by name, as
`supertag list operator-token` shows them, revoked and expired tokens
included. Secrets are never returned. It fails with `InvalidArgument`
for a malformed `page_token`.

### GetOperatorToken

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.AccessService/GetOperatorToken` |
| Request | [`GetOperatorTokenRequest`](#getoperatortokenrequest) |
| Response | [`OperatorToken`](#operatortoken) |
| Action | `read_operator_token` |
| Callers | The admin token only |
| Audit log | Nothing; reads only |

Reads one Operator Token, without its secret, as `supertag get
operator-token` shows it.

### RevokeOperatorToken

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.AccessService/RevokeOperatorToken` |
| Request | [`RevokeOperatorTokenRequest`](#revokeoperatortokenrequest) |
| Response | [`OperatorToken`](#operatortoken) |
| Action | `manage_operator_token` |
| Callers | The admin token only |
| Audit log | `operator-token.revoke` |

Revokes an Operator Token, as `supertag revoke operator-token` does.
Calls that present it are refused with `Unauthenticated` and
`ERROR_REASON_CREDENTIAL_REVOKED` from now on, and the server streams it
opened end at their next credential check. Revoking a revoked token
changes nothing and returns it.

## Messages

### CreateOperatorTokenRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `name` | `name` | `string` | The token's name: 1 to 63 lowercase letters, digits, hyphens or underscores, starting with a letter or digit. Never reused. |

### CreateOperatorTokenResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `operator_token` | `operatorToken` | [`OperatorToken`](#operatortoken) | The new token. |
| `secret` | `secret` | `string` | The token's secret. It is returned only here; send it to its holder over a private channel. The holder saves it with `supertag connect control-plane`. |

### ListOperatorTokensRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `page_size` | `pageSize` | `int32` | At most this many tokens; 0 means 100, and more than 500 means 500. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListOperatorTokensResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `operator_tokens` | `operatorTokens` | repeated [`OperatorToken`](#operatortoken) | The tokens, the earliest created first, then by name. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### GetOperatorTokenRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `name` | `name` | `string` | The token's name. |

### RevokeOperatorTokenRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `name` | `name` | `string` | The token's name. |

### OperatorToken

One Operator Token, without its secret.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `metadata` | `metadata` | [`Metadata`](shared.md#metadata) | Names the token. `resource_version` changes when any field of this view changes. |
| `phase` | `phase` | [`OperatorTokenPhase`](#operatortokenphase) | Its phase. |
| `operator_id` | `operatorId` | `string` | The operator ID calls made with it act as, such as `token:laptop-2`. |
| `expires_at` | `expiresAt` | `google.protobuf.Timestamp` | When it expires. |
| `last_used_at` | `lastUsedAt` | `google.protobuf.Timestamp` | When a call last presented it. The Control Plane refreshes it at most once a minute. Unset when it was never used. |
| `revoked_at` | `revokedAt` | `google.protobuf.Timestamp` | When it was revoked. Unset when it was not. |

## Enums

### OperatorTokenPhase

An Operator Token's phase. Revocation wins over expiry.

| Value | Description |
| --- | --- |
| `OPERATOR_TOKEN_PHASE_UNSPECIFIED` |  |
| `OPERATOR_TOKEN_PHASE_ACTIVE` | Calls may present it. |
| `OPERATOR_TOKEN_PHASE_EXPIRED` | It expired. |
| `OPERATOR_TOKEN_PHASE_REVOKED` | The admin revoked it. |
