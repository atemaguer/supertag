# SuperTag wire specifications

This directory holds language-neutral JSON Schemas for SuperTag resources and configuration. The
gRPC services that the Control Plane, Gateway, and Worker Hosts speak are defined by the
`supertag.runtime.v2` protos in [`rust/proto`](../rust/proto); their generated Go, TypeScript, and
Python bindings are in [`rust/bindings`](../rust/bindings/README.md).

The schemas use [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/schema). Consumers should resolve the relative references within this directory as one bundle.
Schema IDs identify files in this repository; validation does not depend on a separately hosted
SuperTag domain.

## Stability

Their stability is defined by the project-wide
[API stability policy](https://github.com/atemaguer/supertag/blob/main/docs/reference/api-stability.md):

- `resource-envelope.schema.json` — the common control-plane resource shape.

`common.schema.json` contains shared definitions and is not a standalone message.

`supertag-yaml.schema.json` describes `supertag.yaml`, the services that `supertag up` runs on a
machine: at most one `control-plane` service and any number of `host` services, with `secrets`,
`env_file`, and `${VAR}` interpolation. It is a configuration file, not a wire message, so it
rejects unknown fields instead of ignoring them; keys that start with `x-` are ignored. See [supertag.yaml and local state](../docs/reference/supertag-yaml.md).

The [Worker service-provider contract](worker-spi.md) defines
language-neutral extension behavior for Workers, harnesses, execution
environments, Runtime Input resolution, and continuity.

The schemas intentionally allow unknown object properties. A compatible producer may add an optional field, and consumers must preserve or ignore fields they do not understand. Required fields, discriminator values, and version constants remain strict. A producer must not send a new discriminator or require new behavior without negotiating or incrementing the relevant version.

## Version layers

Versions belong to the contract they describe: control-plane resources use
`apiVersion: "supertag/v1"`, and services negotiate the SuperTag protocol version before their
first call.

## Compatibility policy

A change is backward compatible when existing consumers can safely process it without changing behavior. Examples include a new optional property or a new schema document that does not alter an existing message.

A change requires a new version when it removes or changes a required field, changes the meaning or type of a field, adds a required behavior, or introduces a discriminator that older receivers cannot safely ignore.

## Validation

Validate the complete document against its entry-point schema. Schema tests in `tests/spec/` verify reference integrity and representative accepted and rejected messages without coupling the specification to a particular validator implementation.

`fixtures/harness-lifecycle.json` lists valid and invalid harness event sequences; the Python SDK
tests decode it.

## Coordination (Experimental)

[Objectives](objectives.md) define an outcome a Tag owns, with a budget, a deadline and a status;
[objective.schema.json](objective.schema.json) is the response shape.

[Workstreams](workstreams.md) are Teams' shared records of posts, with
[workstream.schema.json](workstream.schema.json) as the shape of one post. The
[Team schema](team.schema.json) describes a Team: a flat list of member Tags with an optional
concurrency limit.

Tag-to-Tag messages are plain text delivered as Tasks of the recipient's inbox; the rules are in
[Mailbox](../docs/reference/coordination.md#mailbox).
