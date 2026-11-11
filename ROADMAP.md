# Roadmap

SuperTag is in alpha. This page lists what we're working on and what we're considering, not
promises with dates. Shipped changes are in the [changelog](CHANGELOG.md), and how SuperTag works
today is in the [documentation](docs/README.md).

## Verified in 0.2.0-alpha.9

- **Hosted Control Plane.** We tested laptop and remote Workers on both
  [Modal](docs/guides/deploy-modal.md) and [Fly.io](docs/guides/deploy-fly.md). Both Workers
  reconnected and completed new Tasks after the Control Plane was replaced, and prior Task history
  remained available. Modal Workers also delivered commits from Workspaces with persistent
  [Volume mounts](docs/guides/modal-workers.md).
- **First-run experience.** We tested the [public installer](docs/operations/install.md) without
  GitHub credentials, using a fresh home directory on Apple Silicon and a clean Linux ARM64
  container. On both, `supertag init` set up local scheduling and execution, and a `/goal` in the
  terminal UI delivered a Git commit for review. The macOS binaries are signed and notarized.

## Unreleased

- **Cursor builder support.** A Cursor Tag with [local command access](docs/operations/requirements.md#cursor-tools-models-and-sandbox)
  can use the Worker's Node.js and a project's pinned package manager. We verified a frozen
  install, typecheck, tests, build, and delivery of a Git commit.

## Next

- **More sandbox providers.** Split execution runs on Modal today; e2b needs live validation.

## Considering

- **A separately scaled Gateway.** Route client, surface, and Task traffic through a stateless
  Gateway tier that scales horizontally, with Worker Hosts pulling their work from it. The Control
  Plane would keep scheduling, policy, and the record, without sitting on every request. A
  single-process setup on one machine would work as it does today.

- **Optional host binding.** Let Tags run on any Worker Host that accepts them, and let a
  Workspace choose a local or remote runtime.
- **Scratch Workspaces.** An empty repository for Tags whose work has no codebase, such as
  research or planning.
- **Retention.** Keep the database small on long-running deployments by expiring saved harness
  sessions of finished work.

Have a use case these don't cover? Open an issue. See [CONTRIBUTING.md](CONTRIBUTING.md).
