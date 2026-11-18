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

For a Codex Task Attempt, the request also carries the Worker Host's Codex version. The provider
then checks, as the Workspace user, that `codex --version` on the fixed PATH
`/usr/local/bin:/usr/bin:/bin` reports exactly that version. As the sandbox's privileged user, it
recreates `/opt/supertag-codex-home` empty, owned by root, and read-only. A mismatch, a missing
`codex`, or a sandbox that can't do either fails Allocate, naming the version the image needs.

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
| `RunStdioServer` | The Workspace declares stdio MCP servers, which run from a trusted copy of the start commit; or a Codex Task Attempt runs Codex's exec-server (see below) |
| `Snapshot`, `RemoveArtifact` | The provider keeps prepared artifacts, so later sandboxes skip the image build and setup |

A provider that lacks one refuses the call. The Task Attempt that needed it fails; nothing falls
back to the host.

`RunStdioServer` with the Codex kind runs `codex exec-server --listen stdio` in the checkout, as the
Workspace user. Its environment is exactly what a Task command gets, plus
`CODEX_HOME=/opt/supertag-codex-home`. Codex reads its configuration layers, such as MCP servers
and hooks, from `CODEX_HOME`, so nothing a Task writes in the sandbox, such as `~/.codex` or a
repository's `.codex/config.toml`, adds tools or commands. Codex applies its environment policy to
this environment for every command it runs, so no Worker Host variable reaches a command.
Codex itself stays on the Worker Host with its keys, including the host that runs code-mode
JavaScript: a V8 isolate with no network or file access, whose tool calls run in the sandbox
through the exec-server.

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
6. **Network rules.** The sandbox has no network access, DNS included. Egress, if offered, must
   go only to the Worker Host's egress proxy, with no other egress, DNS included. SuperTag's own
   E2B, Modal, and local-vm providers offer it through an egress relay in the sandbox, carried
   over the provider's own command channel. A Task with `web:search`, `browser:use`, or a
   `web:fetch` without a [network scope](iam.md#network-scopes) never runs on such a host,
   because those tools would run on the host.
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

Where the Task can never become root, the seal is also a boundary. The local-vm container
provider runs every Task process as an unprivileged user, with every capability dropped and no
way to gain privileges, and refuses a root Workspace user. Only the seal, Capture, and the egress
relay run as root, holding just the capabilities they need: to stop processes and to read and
return files, never a privileged container's. The provider refuses a container whose Workspace
user could write anything root runs: the interpreter, the libraries and modules it loads, `git`,
or a directory on the way to them. A Task process there cannot hide from the seal or replace the
program that reads the tree. Rules 1 and 3 still protect the host.

### Planned additions

These will become requirements when they ship. A provider written now should leave room for
them.

- **Egress relay.** A sandbox will reach the network only through a relay that carries its
  traffic over the provider's exec stream to the Worker Host's egress proxy, while the sandbox's
  own network stays fully blocked. The proxy applies the Task's
  [network scope](iam.md#network-scopes). Egress, if offered, must go only to the host's proxy,
  with no other egress, DNS included. A tunnel that leaves the sandbox's resolver working does
  not meet this.

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
  as `network-scope`. Only SuperTag's own E2B, Modal, and local-vm providers carry the egress
  relay.
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

Each case gets a fresh session, a scratch `directory`, and a `hostId` of its own for the owner
of every sandbox it allocates. The options:

| Option | Means |
| --- | --- |
| `commands` | The provider can seal its sandboxes and admits `commands:execute`. Without it, the suite checks that Allocate refuses commands |
| `snapshots` | The provider keeps prepared artifacts |
| `isolated` | The sandbox is a separate machine or container. Set it for a real provider. A test double that runs on the test machine leaves it unset, and the host-reach and seal cases then check the protocol only |
| `egress` | The provider carries a network-scoped Task's connections over an egress relay. The case runs a command in the sandbox that connects through the relay to a proxy the suite runs. A test double whose relay runs on the test machine returns its port from `relayPort()`, and the suite connects to it directly |

A session may also offer `lose()`, which ends its sandbox out of band, to run the lost-sandbox
case. Find the sandbox by the case's `hostId`, so another run against the same provider keeps its
own.

The cases check allocation and ownership, Stage's digest check and its refusal of links that leave
the checkout, file tools within the checkout, Capture and its exclusions, Stop, rule 1 after Stop
and after a lost sandbox, and that a host directory the suite watches never changes. With
`commands`, they check bounded commands and their time limit, and Capture after a command left a
process running. With `egress`, they check that a command gets the proxy variables and that a
connection's bytes cross the relay intact, both ways. The cases need `git` on the machine running them.

A provider must pass the suite with `isolated` set. E2B and Modal run it against their test
doubles. The container provider behind the `local-vm` environment
([`harnesses/sdk/src/rust-workspace-provider/container.ts`](../../harnesses/sdk/src/rust-workspace-provider/container.ts))
runs it against real containers with `isolated` set: the seal stops real processes, and a lost
container fails every call. It is the shortest complete provider to start from.
