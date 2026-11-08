# SuperTag wire specifications

This directory is the language-neutral contract for software that exchanges SuperTag resources, Task Attempts, events, or Worklet transport messages. TypeScript interfaces remain useful implementation types, but they are not the portable specification.

The schemas use [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/schema). Consumers should resolve the relative references within this directory as one bundle.
Schema IDs identify files in this repository; validation does not depend on a separately hosted
SuperTag domain.

## Stability

The initial bundle specifies the versioned wire-facing kernel. Its current
stability is defined by the project-wide
[API stability policy](https://github.com/atemaguer/supertag/blob/main/docs/reference/api-stability.md):

- `resource-envelope.schema.json` — the common control-plane resource shape;
- `task-attempt-spec.schema.json` — immutable input for one execution attempt;
- `task-attempt-event.schema.json` — observable events emitted by an attempt;
- `worker-host-descriptor.schema.json` — Workers and capacity advertised for one host;
- `worklet-descriptor.schema.json` — Worklet identity and its Worker Host descriptor;
- `worklet-transport-message.schema.json` — messages exchanged by the API Server and a remote Worklet.

`common.schema.json` contains shared definitions and is not a standalone message.

`supertag-yaml.schema.json` describes `supertag.yaml`, the services that `supertag up` runs on a
machine: at most one `control-plane` service and any number of `host` services, with `secrets`,
`env_file`, and `${VAR}` interpolation. It is a configuration file, not a wire message, so it
rejects unknown fields instead of ignoring them; keys that start with `x-` are ignored. See [supertag.yaml and local state](../docs/reference/supertag-yaml.md).
`objective-manifest.schema.json` describes the `Objective` manifest that `supertag apply -f`
reads. It also rejects unknown fields, and it has no `status`: an Objective's status is observed,
never declared. See [Declared Objectives](../docs/reference/resource-model.md#declared-objectives).

The [Worker service-provider contract](worker-spi.md) defines
language-neutral extension behavior for Workers, harnesses, execution
environments, Runtime Input resolution, and continuity. It complements the JSON schemas:
the schemas specify portable data, while the SPI specifies lifecycle and
ownership behavior that cannot be expressed fully in JSON Schema.

The schemas intentionally allow unknown object properties. A compatible producer may add an optional field, and consumers must preserve or ignore fields they do not understand. Required fields, discriminator values, and version constants remain strict. A producer must not send a new discriminator or require new behavior without negotiating or incrementing the relevant version.

## Version layers

Versions belong to the contract they describe:

- control-plane resources use `apiVersion: "supertag/v1"`;
- a Task Attempt Spec uses `version: 2`;
- surface authorization snapshots use version `5`, internal authorization snapshots use version
  `4`, and Context Plans use version `7`;
- Session history contains derived Task results; it has no separate stored resource or artifact kind;
- a Worklet Descriptor starts its independent contract at `protocolVersion: 1`;
- Worklet transport messages require protocol version `18` and durable acceptance for execution.
  The API Server selects `18` in `ready` or returns a structured `unsupported_protocol` error.


These values are deliberately independent. For example, adding a compatible Task event field does not require a new Worklet transport protocol.

## Compatibility policy

A change is backward compatible when existing consumers can safely process it without changing behavior. Examples include a new optional property or a new schema document that does not alter an existing message.

A change requires a new version when it removes or changes a required field, changes the meaning or type of a field, adds a required behavior, or introduces a discriminator that older receivers cannot safely ignore.

Secrets are never reusable descriptor or Task fields. The enrolled Worker Host credential appears
only in the initial transport `hello` message and must not be logged, persisted in Task history, or
echoed in protocol errors. This field is `credential`; `pairingToken` is rejected.

## Validation

Validate the complete document against its entry-point schema. Schema tests in `tests/spec/` verify reference integrity and representative accepted and rejected messages without coupling the specification to a particular validator implementation.

Checked-in examples under `fixtures/worklet-transport/VERSION/` describe the current protocol. SDKs in another language must decode the protocol 18 fixtures. CI validates the current fixtures on every supported Node.js release.

## Coordination (Experimental)

[Objectives](objectives.md) define an outcome a Tag owns, with a budget, a deadline and a status;
[objective.schema.json](objective.schema.json) is the response shape and
[objective-manifest.schema.json](objective-manifest.schema.json) the declared form.

[Workstreams](workstreams.md) are Teams' shared records of posts, with
[workstream.schema.json](workstream.schema.json) as the shape of one post. The
[Team schema](team.schema.json) describes a Team: a flat list of member Tags with an optional
concurrency limit.

Tag-to-Tag messages are plain text delivered as Tasks of the recipient's inbox; the rules are in
[Mailbox](../docs/reference/coordination.md#mailbox). They are separate from the
[Worklet execution transport](worklet-transport.md).

[resource-deletion.schema.json](resource-deletion.schema.json) defines the response to deleting a
Tag, Role, Permission Set, Context Set, or Workspace, including a dry run. See
[Deleting resources](../docs/reference/control-plane-api.md#deleting-resources).
