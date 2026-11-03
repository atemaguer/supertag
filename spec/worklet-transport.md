# Worklet transport versions

The current authenticated WebSocket transport is version **18**. Worklets send
`protocolVersions: [18]` during `hello`; the Control Plane API Server confirms protocol 18 in `ready`.

Protocol 18 requires a one-use authority check before a harness takes Team input.

It also supports two-level execution placement. The Control Plane selects an eligible Worker Host,
then sends `select_placement` to that host. The Worklet chooses the concrete Worker and profile from
current local capacity and returns a single-use reservation with an expiry. The returned host,
Worklet, Worker, profile, and reservation are frozen into the Task Attempt before `accept`.
Acceptance consumes the reservation. If durable Task admission declines after placement, the
Control Plane sends `release_placement` so the Worklet frees the unused hold immediately. Missing,
expired, reused, or mismatched reservations are rejected before execution, allowing the Control
Plane to schedule a fresh Attempt after admission backoff. Disconnected or otherwise abandoned
reservations release their capacity when they expire.

Protocol 18 supports Session persistence: `session.sessionState`, optional private
`session.persistence: {controlPlaneUrl, token}` in Task Attempt Specs, and `session.updated`
events with a `sessionState` reference. Task results name catalog artifact IDs and explicit entry
paths. Specs require `workspacePlan`; unknown event kinds are rejected.

Only `protocolVersions: [18]` is accepted. Other lists receive `unsupported_protocol` before
authentication.
The Worker Host sends its enrolled secret in `credential`. The removed `pairingToken` field is
rejected, including when accompanied by a credential. This handshake does not enroll a host.

The `hello` credential is authenticated against the declared Worker Host identity. A successful
claim atomically allocates a monotonically increasing `connectionGeneration`, returned in `ready`.
Only the latest generation for a Worker Host is authoritative: a newer claim replaces the prior
socket, and the API Server rejects its late heartbeats, events, and acknowledgements. Revocation
fences the active generation immediately. Heartbeat observations and disconnect updates carry the
same generation so durable status updates can use compare-and-set rather than allowing a stale
socket to overwrite a newer connection.

The API Server closes a superseded or stale generation with WebSocket code `4007` and a revoked
generation with `4008`. Both are terminal for that client process: it must not reconnect with the
same credential. A separately started Worklet may connect with a newly issued credential.

Attempt-scoped coordination credentials contain `controlPlaneUrl`. Workers must advertise
`supertag.coordination` version 1, plus `supertag.coordination.surface` version 1 for a
surface-scoped credential.

The credential contains a Control Plane URL and token. Internal credentials also identify an
Objective; a surface credential uses `scope: "surface"` and may omit the Objective ID before
creation. Treat it as a secret: do not log it, store it in artifacts, or reuse it outside the active
Attempt. The API Server validates the Attempt's lease and Objective for coordination calls.

Remote execution requires a durable backend advertising `durableProtocolVersion: 1`.
Legacy job delivery is unsupported. The independent Worklet Descriptor remains
`protocolVersion: 1` and Task Attempt Spec remains `version: 2`.

See [transport message schema](worklet-transport-message.schema.json) and
[Task Attempt Spec schema](task-attempt-spec.schema.json) for the message shapes. Surface and
internal authorization are distinguished by their version and origin shapes; an internal Task
does not manufacture a Surface route.

Cancelling observation does not prove that the Worker Host has finished cleanup. The Control Plane
retains the Attempt's capacity reservation until durable inspection confirms terminal cleanup.
Disconnecting the socket does not release accepted execution capacity.

Durable requests use a
correlation `requestId` and the canonical `attemptId`; transport job IDs do not identify
accepted work. `accept` acknowledges only after the host journal and capacity reservation
succeed. Repeating the same Attempt and specification returns its existing receipt; a
changed specification is rejected. An acknowledgement timeout or disconnect is an uncertain
outcome, never permission to dispatch the Attempt to a different host.

`inspect` returns the persisted receipt and event cursor, or no receipt when absent.
`events` streams journal entries after `afterSequence`; entries carry monotonically increasing
sequences and observers can reconnect and resume from their last sequence. Unsubscribing
only detaches observation. `cancel` requests cancellation explicitly. The `execute` adapter
requests cancellation when its observer aborts.

The Control Plane remembers the selected host for an Attempt. After Control Plane restart,
inspection queries connected durable hosts and rejects conflicting
receipts. A disconnected host makes the outcome unavailable until it reconnects; the transport
does not automatically replay execution. Journals store specification digests and redacted events,
never coordination credentials. Host restart exposes unfinished journal records as `unknown` for
reconciliation.

Durable capability detection is independent of available slots. When a matching durable host
exists, admission waits for its capacity. Raw `job` and `cancel` messages are rejected so execution
cannot bypass durable acceptance.

## Durable native control extension

A protocol 18 Worklet with `durableProtocolVersion: 1` advertises
`controlProtocolVersion: 1` only when its durable supervisor implements native control delivery.
Omission means unsupported; Python Workers currently omit this extension and reject control
requests explicitly.

`durable_request` operations `control_capabilities` (`taskId`, `attemptId`) and
`control` (`attemptId`, `command`) address the exact accepted Attempt and Worker.
Capabilities are available only while that Attempt has an active native control
channel; an inspection may include the same `control` value. Supported operations
are `input`, `reply`, and `interrupt`. Optional `inputMode` distinguishes `steer`
(active-turn input) from `queue`; clients must not infer queue support. Codex native
execution currently advertises `steer`.

Each command includes `id`, `taskId`, and `attemptId`. Its ID is immutable within
that Attempt. Before native dispatch, the supervisor commits a digest and an
`unknown` acknowledgement to its private journal, without storing the command
payload. It records the resulting `accepted`, `rejected`, or `unknown` status.
Identical IDs replay the recorded acknowledgement; changed payloads are rejected.
After a crash, an `unknown` record is never dispatched again. Lost transport ACKs
may be inspected by resending the identical command ID to the same durable host;
this retrieves the journaled outcome and does not permit another native dispatch.
A disconnected or ambiguous host is never replaced for control delivery.

`accepted` means the native adapter accepted the action, not that the Attempt
completed. A reply cannot expand the Attempt's admitted permissions. Native
interrupt and durable Attempt cancellation remain distinct operations.
