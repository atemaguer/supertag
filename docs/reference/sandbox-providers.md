# Sandbox provider contract

A sandbox provider runs a Task's Workspace in a sandbox away from the
[Worker Host](worker.md), while the harness and its credentials stay on the host. SuperTag calls
this split execution. E2B and Modal are the built-in providers. This page is the contract a new
provider, such as Fly, Firecracker, or Docker, implements, and the conformance suite it passes.

What moves and what stays:

```text
Worker Host (harness, model keys, delivery)        sandbox (no keys, no network)
  ── Allocate, Stage ──────────────────────────────>  checkout of the start commit
  ── file tools, commands ─────────────────────────>  runs them in the checkout
  <─ Capture: the changed tree ──────────────────────  sealed, then read
  ── Stop ─────────────────────────────────────────>  gone, with every process in it
```

The host never trusts what comes back. It checks the returned tree and the Task's path scope at
delivery, exactly as it does for a local Task Attempt.

## Two ways to implement

| Way | You write | SuperTag supplies |
| --- | --- | --- |
| The TypeScript SDK (recommended) | `SandboxWorkspaceProvider` and `SandboxWorkspace` from `@supertag/worker-sdk/internal/rust-workspace-provider` | Staging, file tools, bounded commands, the seal, capture, Volume copies, Workspace MCP servers, and the transport |
| The wire protocol | A helper process in any language serving `supertag.runtime.v2.RemoteWorkspaceProvider` and `HarnessWorkspace` | Nothing; you meet every rule below yourself |

The SDK is the shorter path: E2B and Modal are each a few hundred lines on top of it. A provider
implements these calls:

| Call | Does |
| --- | --- |
| `provider.allocate(owner, timeoutMs, signal, environment?, artifact?)` | Creates one sandbox labelled with `owner`, and returns a `SandboxWorkspace` |
| `provider.stop(owner, sandboxId?)` | Ends the owner's sandbox; returns `stopped` with its ID, or `uncertain` |
| `provider.validateOwner(owner)` | Refuses an owner its labels cannot carry |
| `provider.removeArtifact(artifact)` | Deletes a prepared artifact; one already gone counts as deleted |
| `provider.sandboxGone(owner, sandboxId)` | Optional. Whether the provider confirms the owner's sandbox no longer exists. See [A lost sandbox](#a-lost-sandbox) |
| `sandbox.run(argv, timeoutMs, signal)` | Runs a trusted program, returns its exit code and stdout |
| `sandbox.environment(root)` | File and process access rooted at `root`, from `sandboxExecutionEnvironment` |
| `sandbox.writeTransfer(path, bytes)` / `readTransfer(path)` | Moves the bundle in and the captured tree out |
| `sandbox.snapshot(signal)` | Records a preparation sandbox as a prepared artifact |
| `sandbox.runPrivileged(argv, timeoutMs, signal)` | Runs the trusted seal program as the sandbox's privileged user. Without it, the sandbox never admits commands |

## The helper process

The Worker Host starts one helper process per Task Attempt:

1. It runs the helper's executable with a cleared environment: `PATH`, `LANG=C`, a private
   `TMPDIR`, and the provider's own credentials, nothing else.
2. It writes a `RemoteWorkspaceProviderBootstrap` message to stdin and closes it. The message
   carries a bearer token.
3. The helper prints one line on stdout within 10 seconds: `http://127.0.0.1:PORT`, a literal
   loopback address of at most 512 bytes.
4. The host connects with gRPC over HTTP/2. Every call carries the token; the helper refuses any
   call without it.

The helper serves `RemoteWorkspaceProvider`, the lifecycle calls below, and `HarnessWorkspace`,
the file tools and commands. One helper owns at most one allocation. A fresh helper may be asked
only to Stop a sandbox an earlier one allocated.

Limits the helper must accept and must not exceed:

| Limit | Value |
| --- | --- |
| One message | 1 MiB |
| One stream chunk | 256 KiB |
| A bundle or a captured tree | 256 MiB |
| Allocate | 60 s; 20 minutes with an image build |
| Stage, Capture, and other transfers | 120 s |
| Devcontainer setup after staging | 20 minutes |
| Stop | 30 s |
| Sandbox lifetime | What Allocate asks for, at most 1 hour |

## Lifecycle

### Allocate

Allocate creates one sandbox for one owner: the host ID, host generation, Task ID, Task Attempt
ID, and allocation ID. The provider:

- labels the sandbox with all five values, and reads the labels back before it returns the
  sandbox ID;
- caps its lifetime at the requested time, so a lost host cannot leave it running;
- gives it no network access and no host environment variable;
- builds the devcontainer image first when the request carries one (see
  [Devcontainer settings](devcontainer-subset.md)), or starts from a prepared artifact;
- records the sandbox's own processes before the Task can start any, when the Task may run
  commands (see [The seal](#the-seal)).

A Task with `commands:execute` gets a sandbox only from a provider that can seal it. Otherwise
Allocate fails.

When the allocation response is lost, the host recovers through Stop with the owner alone. The
provider then finds the sandbox by its five labels. It counts exactly one match as the owner's,
and never trusts a sandbox ID it has not verified.

### Stage

Stage receives the start commit's Git bundle, pinned by its SHA-256 and length. The provider
checks both before it moves any byte into the sandbox. It then materializes the commit in a
private directory, writes Git objects directly so no repository filter or hook runs, and keeps
the repository outside the checkout. Staged input files land in a read-only root. A preparation
sandbox takes the trusted commit alone, then runs the devcontainer's setup lines.

### File tools and commands

After Stage, the harness reads, writes, edits, globs, greps, and lists inside the checkout, under
the Task's path scope. No tool reaches `.git`. Edits run one at a time. Each command:

- runs in its own process group in the checkout;
- has its own time limit, enforced inside the sandbox, plus a 15-second grace before the provider
  stops it;
- returns at most the configured bytes of stdout and stderr; the rest is drained in the sandbox.

### A lost sandbox

When a tool call fails because its sandbox no longer exists, the provider answers that call with
`sandbox_lost` set, and every later call the same way. The Worker Host then stops and journals the
lost sandbox and replaces it from the turn's starting files, at most twice per Task Attempt; the call
tells the harness that its earlier changes in the turn are gone. Set `sandbox_lost` only on the
provider's own confirmation: a timeout, a network error, or a sandbox that is merely unresponsive
is an ordinary tool error. On the SDK path, `sandboxGone` is asked only after a call failed, and
any error or a wait over 10 seconds counts as not gone. E2B counts only its not-found answer for
the exact sandbox ID. Modal counts only a terminal exit code from the exact sandbox, reattached
with its owner's tags.

### Capture

Capture returns the Workspace as one tree file:

- entries in sorted order, with exact bytes and file modes;
- symbolic links kept as links, never followed;
- no `.git` entry, no staged input, and no Volume copy;
- no untracked path the checkout's `.gitignore` files match, except the paths the host asks to
  keep, such as the Task output directory.

The provider prints a receipt of the tree's length and SHA-256. The host reads the tree and
refuses it when either differs. A tool call that did not settle, such as an edit whose wrapper
was interrupted, makes Capture fail rather than return a tree it cannot vouch for.

### Stop

Stop ends the sandbox and every process in it. It returns `stopped` with the sandbox ID, or
`uncertain`. It returns `stopped` only after the provider confirms the sandbox is gone; a
missing acknowledgement is `uncertain`, and the host retries. Stop on a stopped sandbox succeeds.

### Optional calls

| Call | When |
| --- | --- |
| `StageCopy`, `CaptureCopy` | The host maps [Workspace Volume](worker.md#workspace-volumes) copies |
| `RunMcpServer` | The Workspace declares stdio MCP servers; they run from a trusted copy of the start commit |
| `Snapshot`, `RemoveArtifact` | The provider keeps prepared artifacts, so later sandboxes skip the image build and setup |

A provider that lacks one refuses the call. The Task Attempt that needed it fails; nothing falls
back to the host.

## Security requirements

A provider must meet every rule here. The [conformance suite](#conformance-suite) checks each one
an outside caller can observe.

1. **No host fallback.** When the sandbox is unreachable, lost, or stopped, every tool call and
   command fails. Nothing ever runs on the Worker Host instead.
2. **No keys in the sandbox.** The helper may hold the provider's own credentials. The sandbox
   gets no credential, no host environment variable, and no path on the host.
3. **Nothing returned is trusted.** The provider passes back what the sandbox holds, bounded and
   digested. The host validates the tree and enforces the path scope at delivery, so a provider
   never needs to filter the Task's work for safety.
4. **The seal is a reliability property.** See [The seal](#the-seal). A provider that cannot seal
   must not admit commands.
5. **Capture rules.** Capture returns exactly what [Capture](#capture) lists, within the size
   limit, with a receipt. It never follows a link out of the checkout.
6. **Network rules.** The sandbox has no network access. A Task with `web:fetch`, `web:search`,
   or `browser:use` never runs on such a host, because those tools would run on the host.
7. **Ownership.** Every sandbox carries its owner's five labels. Stop and recovery act only on a
   sandbox whose labels match exactly.

### The seal

After a Task ran commands or a Workspace MCP server, a process it left behind could change the
Workspace while Capture reads it. Before Capture, the provider stops every process in the
sandbox except the ones it recorded at Allocate. It confirms none is left, then reads the tree
in the same process, with no gap in between. Every step fails closed: the provider refuses
Capture when it cannot confirm the seal.

The seal is not a security boundary. A Task that can become root in its sandbox can defeat it.
It keeps an honest Task's leftovers, such as a dev server or a file watcher, from racing Capture.
What protects the host is rule 1 and rule 3: nothing runs on the host, and nothing returned is
trusted.

### Planned additions

These will become requirements when they ship. A provider written now should leave room for
them.

- **Egress relay.** A sandbox will reach the network only through a relay inside it, which
  tunnels to the Worker Host's egress proxy. The proxy applies the Task's
  [network scope](iam.md#network-scopes). The sandbox will deny every other connection.

## Run your own provider

A Worker Host runs your provider's helper with `--workspace-provider`:

```sh
supertag worker-host --harness claude-code --workspace-id repository \
  --workspace-source ~/src/repository \
  --workspace-provider /usr/local/bin/node \
  --workspace-provider-arg /opt/fly-provider/main.js \
  --workspace-provider-env FLY_API_TOKEN --workspace-provider-env FLY_APP
```

- `--workspace-provider-env NAME` names one Worker Host variable to pass to the helper. The named
  variables are the only ones it gets, besides `PATH`, `LANG`, and `TMPDIR`. A variable that is
  not set stops the Worker Host at start.
- The helper's executable, its arguments, and every passed name and value bind the sandboxes it
  allocates. A host restarted with another value, such as a rotated key, never stops or recovers
  a sandbox the earlier one made.
- SuperTag has not verified your provider's network rules, so placement never gives such a host
  a Task with a [network scope](iam.md#network-scopes). `supertag placement explain` names this
  as `network-scope`. This holds even after the egress relay ships for E2B and Modal.
- Your provider must pass the [conformance suite](#conformance-suite) with `isolated` set before
  a Worker Host runs it. SuperTag does not check this at start.

## Conformance suite

`sandboxProviderConformance` in `@supertag/worker-sdk/internal/rust-workspace-provider/conformance`
drives a provider through the production handlers and the real gRPC transport, as the Worker Host
does. It returns named cases whose `run` throws on a failure, so any test runner can register
them. With Vitest:

```ts
import { sandboxProviderConformance } from "@supertag/worker-sdk/internal/rust-workspace-provider/conformance";
import { it } from "vitest";
import { createMyWorkspaceSession } from "./src/session.js";

for (const check of sandboxProviderConformance(
  async () => ({ session: createMyWorkspaceSession() }),
  { commands: true, snapshots: false, isolated: true },
))
  it(check.name, check.run, check.timeoutMs);
```

Each case gets a fresh session and a scratch `directory`. The options:

| Option | Means |
| --- | --- |
| `commands` | The provider can seal its sandboxes and admits `commands:execute`. Without it, the suite checks that Allocate refuses commands |
| `snapshots` | The provider keeps prepared artifacts |
| `isolated` | The sandbox is a separate machine or container. Set it for a real provider. A test double that runs on the test machine leaves it unset, and the host-reach and seal cases then check the protocol only |

A session may also offer `lose()`, which ends its sandbox out of band, to run the lost-sandbox
case.

The cases check allocation and ownership, Stage's digest check and its refusal of links that leave
the checkout, file tools within the checkout, Capture and its exclusions, Stop, rule 1 after Stop
and after a lost sandbox, and that a host directory the suite watches never changes. With
`commands`, they check bounded commands and their time limit, and Capture after a command left a
process running. The cases need `git` on the machine running them.

A provider must pass the suite with `isolated` set. E2B and Modal run it against their test
doubles. A reference provider on local Docker containers, used only in tests
([`harnesses/sdk/docker-reference.ts`](../../harnesses/sdk/docker-reference.ts)), runs it with
`isolated` set: the seal stops real processes, and a lost container fails every call. It is the
shortest complete provider to start from.
