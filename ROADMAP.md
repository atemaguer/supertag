# Roadmap

SuperTag is in alpha. This page lists what we're working on and what we're considering, not
promises with dates. Shipped changes are in the [changelog](CHANGELOG.md), and how SuperTag works
today is in the [documentation](docs/README.md).

## Now

- **Modal hosting.** Make Modal the first hosted deployment path we verify end to end, from the
  [always-on Control Plane](docs/guides/deploy-modal.md) to
  [Worker Hosts, repository Workspaces, and persistent Volume mounts](docs/guides/modal-workers.md).
- **Cursor as a full builder.** Cursor Tasks run, edit, and use SuperTag's tools today. Its
  sandbox still finds an older Node.js and can't download a project's pinned package manager, so a
  Cursor builder can't yet run a Node project's whole check on its own.
- **First-run experience.** Installing, running `supertag init`, and getting a team's first result
  on a clean machine without help.

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
