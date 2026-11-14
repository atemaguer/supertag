# API stability

SuperTag is still below version 1.0. This page explains which contracts applications, harness
adapters, and connectors can rely on, and how changes are communicated. Terms are defined in the
[glossary](glossary.md).

## What counts as a public contract

A contract is public only when this page lists it. Database tables, files in a state directory,
the internals of the `rust/` crates, and undocumented fields are internal: depending on them may
require changes at any time.

## Stability levels

| Level | Meaning |
| --- | --- |
| Stable | Intended for long-term use. Breaking changes follow the release and deprecation rules below. |
| Beta | Ready for real use, but feedback may require breaking changes in a minor pre-1.0 release. |
| Experimental | An early design that may change or disappear without a deprecation period. |
| Internal | An implementation detail with no compatibility promise. |

## Current stability by area

| Area | Level | Compatibility boundary |
| --- | --- | --- |
| The `supertag` command grammar: `get`, `describe`, `delete`, `watch`, `apply`, and `diff` with a kind, and `RESOURCE VERB` commands, as listed in the [CLI reference](cli.md) | Beta | Command and flag names. Readable text output may change; `get` JSON and `--output json` follow the API's field names |
| Manifests (`apiVersion: supertag/v1`) read by `apply` and `diff` | Beta | The kinds and fields in [Manage Control Plane resources](../operations/resources.md) |
| `supertag.yaml` (`version: 1`) | Beta | The keys in [supertag.yaml and local state](supertag-yaml.md) |
| The Control Plane API, protobuf package `supertag.runtime.v2`: operator services | Experimental | [Control Plane API](control-plane-api.md). Field numbers are not reused |
| Protocol negotiation and the `x-supertag-protocol` header | Beta | A client and a Control Plane that share a protocol version interoperate |
| The harness protocol: `AdapterBootstrap` and the `Harness` services | Experimental | [Write a harness adapter](../guides/harness-adapters.md) |
| The connector protocol: `supertag.runtime.v2.Connector` | Experimental | [Connector contract](connector-contract.md) |
| The shared execution protocol, `supertag.environment.v2` | Experimental | Used by `supertag-shared-execution` and Worker Hosts |
| Generated Go, TypeScript, and Python bindings in `rust/bindings` | Experimental | Regenerated from the protos; not published as packages yet |
| Workspace Volumes (`workspace-volume put`, `get workspace-volume`), Tag `--workspace-mounts` copies, and Worker Host `--workspace-mount-mappings` | Experimental | `file://` and `s3://` sources; an `s3://` Volume holds a credential label, never a value, and each Worker Host pins its endpoint, region, and key variables. Copies only; read-only provider-native Modal Volume mounts are on the backlog |
| `deploy/` definitions and the `hosted` image's environment | Beta | The role contract in [Configure a deployment](../guides/deployment-setup.md) |

## Package entry points

`supertag-ai` is the TypeScript SDK on npm. Each import path has its own stability level:

| Import | Level | Main exports |
| --- | --- | --- |
| `supertag-ai/control-plane-client` | Experimental | `createControlPlaneClient`, operator service clients, and their `supertag.runtime.v2` protobuf requests, responses, and streams |
| `supertag-ai/harness` | Experimental | `openHarness`, exact-request receipt retries, Worker-managed effect receipts (`effects`, `EffectReceiptState`), and execution-scoped `supertag.runtime.v2` clients |

The Python SDK (`supertag` on PyPI) has two Experimental modules, both installed with the
`runtime` extra. `supertag.control_plane_client` provides `ControlPlaneClient` and
`ControlPlaneClientSync`, which connect to a Control Plane over gRPC and expose its operator
services. `supertag.harness_adapter` provides `open_harness`, which opens a Worker Host's
execution-scoped services for a custom harness adapter from its standard input. The OpenAI Agents
harness adapter, `python -m supertag.openai_agents_adapter`, is Experimental. Other Python
modules are internal.

## Release policy

SuperTag uses semantic version numbers, with these pre-1.0 rules:

- patch releases should contain compatible fixes and documentation changes;
- minor releases may change Beta contracts and may remove Experimental ones;
- known breaking changes are called out in the changelog and release notes;
- security or data-integrity fixes may require an immediate incompatible change.

Before 1.0, there is no guaranteed deprecation window. When practical, a Beta contract is marked
deprecated for at least one published minor release before it is removed.

After 1.0, removing or incompatibly changing a Stable contract requires a major release, with a
documented migration and at least one minor release or 60 days of deprecation, whichever is
longer, unless keeping the behavior would create a security or data-integrity risk.

## CLI and Control Plane versions

Every client and service negotiates a protocol version when it connects: the CLI, the terminal
UI, the desktop app, applications, Worker Hosts, and Gateways. A pair that shares a version works;
a pair that shares none is refused before any other call, with both sides' versions in the
error. `supertag version` prints this CLI's version and the running local services' versions.
Release the CLI and the Control Plane together, and upgrade them together.

## Contract changes

A proposal is required before changing a lasting public contract. The process is described in
[CONTRIBUTING.md](../../CONTRIBUTING.md#propose-a-contract-change). A proposal should answer:

- Which stability level does the contract have?
- Can old and new implementations communicate safely?
- What happens to persisted data and in-flight Tasks?
- Can callers detect that a capability is unsupported?
- What migration and conformance tests are needed?

Bug fixes that make an implementation match its documented contract are not normally breaking
changes, even when someone relied on the bug.

## Deprecation notices

Deprecations should identify the replacement, the first deprecated version, and the earliest
possible removal version. Notices belong in runtime warnings where useful, the changelog, release
notes, and the relevant reference documentation.
