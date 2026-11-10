# Run a Worker

Connect a machine you control so that **Tasks**, the requests or assignments SuperTag accepts, run
there with a real agent. A **Tag** is a persistent AI actor with its own responsibilities and
permissions, and Tags work in Teams: flat lists of member Tags. Together, your Teams of Tags make up an
**autonomous organization**: Teams may pursue different goals but share one set of rules and one
record of the work. The **Control Plane** stores and coordinates the organization.

- A **Worker** is the code that completes a Task.
- A **Worker Host** is the machine or sandbox where it runs.
- A **Worklet** supervises that host and connects it to the Control Plane.
- A **harness** connects the Worker to an agent system such as Codex, Claude Code, Cursor, or OpenCode.

Start with `supertag init` on your own computer; it starts the Control Plane and connects a
Worker Host. Use the remote connection steps below to add another machine to an existing
Control Plane. A chat connection or smoke test is not a prerequisite.

See the [glossary](../reference/glossary.md) and
[Worker Hosts, Worklets, Workers, and harnesses](../concepts/workers.md) for the full vocabulary.

## Connect a machine day to day

On your own computer, `supertag init` is the everyday way to run Workers. It writes
`~/.supertag/supertag.yaml` with a local Control Plane and a **host service**: this computer as a
Worker Host, with one Worklet and a Worker for each harness you choose. The host service lists the
checkout path of each **Workspace**, a named repository that Tasks work in:

```yaml
services:
  control-plane:
    type: control-plane
  studio:
    type: host
    harnesses: [claude-code, codex]
    allow-unsandboxed-commands: [claude-code]
    workspaces:
      app: ~/code/app
```

`supertag up` brings both up in the background. The host joins with its own Worker Host credential,
and `init` binds it to the lead Tag. `supertag ps` shows whether it is connected and which Tags it
serves, `supertag logs -f` follows it, and `supertag down` stops it with the Control Plane. Add
`restart: unless-stopped` to keep it running after restarts. Run `supertag init` in another
repository to add it as another Workspace. See
[Start in a repository](../operations/cli.md#start-in-a-repository) and
[supertag.yaml and local state](../reference/supertag-yaml.md).

While the host runs **Task Attempts**, single executions of a Task, it keeps the machine from idle sleep, and `supertag ps` says so.
On a laptop, `supertag ps` also warns when it is on battery or would sleep when its lid closes.
See [Keeping the machine awake](../reference/supertag-yaml.md#keeping-the-machine-awake).

Edit the host service and run `supertag up` again to change what it serves. SuperTag drains the
host first: it takes no new Task Attempts, and running ones finish before it restarts. A change to
`concurrency` alone needs no restart; see [Run several Tasks at once](#run-several-tasks-at-once).
See [Run and stop SuperTag](../operations/cli.md#run-and-stop-supertag).

### Harnesses without a sandbox

Codex runs a Task's shell commands inside its own sandbox. Claude Code, OpenCode, and Cursor run them as
you, with your account's access to files, credentials, and the network. A host service therefore
runs Tasks that may run commands (`commands:execute`) on them only when `allow-unsandboxed-commands`
lists them, as `claude-code` above. Without it, such Tasks go to Codex or another host, or wait
with a reason that names the setting. Give the Tags of such a host only trusted work, or run them
on a host with little to lose. See
[Unsandboxed harnesses](../reference/supertag-yaml.md#unsandboxed-harnesses).
Cursor also requires `files:write` for a Task that has `commands:execute`. It refuses a repository
or Task Attempt home `.cursor/sandbox.json` at start. The agent can create this file later and
widen its sandbox, which is why shell access needs the opt-in.

### Run several Tasks at once

Each Worker runs several Task Attempts at once. A Task Attempt mostly waits on the model, so by
default SuperTag sizes this from the machine: half of the CPU cores or of the memory in GB divided
by 3, whichever is smaller, rounded down and kept from 2 through 8. A 14-core laptop with 36 GB runs
6 at once. A long Task, such as a build, then holds one slot while short ones, such as the owner of an
**Objective** (an outcome a Tag owns) answering a message, take others. The limit applies per harness, so
`harnesses: [claude-code, codex]` runs up to that many of each. `supertag config` and
`supertag ps` show the value and whether it came from this machine or supertag.yaml. Set
`concurrency` on the host service to choose it yourself, from 1 through 16:

```yaml
services:
  studio:
    type: host
    harnesses: [claude-code, codex]
    concurrency: 3
```

Run `supertag up` after you change it. The running host takes the new limit without a restart, so
running work continues. A lower limit only holds back new Task Attempts until running ones fit
under it.

`supertag connect worklet --concurrency N` does the same for a foreground Worklet. Each Task Attempt
in a Workspace works in its own git worktree, so parallel Task Attempts never share files. Each also
starts its own harness process, with its own configuration directory. Raise the limit only as far
as the machine's CPU, memory, and model quota allow. When every slot is busy, a queued Task waits,
and `supertag describe task TASK_ID` names the Tasks holding the slots. See
[Waiting for capacity](../reference/scheduling-and-recovery.md#waiting-for-capacity).

### Join your team's Control Plane

When your team shares one Control Plane, add a host service that names it. The first run needs an
[Auth Key](#2-create-an-auth-key) from an operator, saved in a file:

```yaml
services:
  laptop:
    type: host
    control-plane: https://supertag.example.com
    auth-key: laptop-key
    harnesses: [claude-code, codex]
    workspaces:
      app: ~/code/app
secrets:
  laptop-key: { file: ~/laptop.key }
```

Run `supertag up`. One Worker Host serves every harness in the list and keeps running after the
command returns. The Auth Key decides which Tags the host serves. The host connects over WebSocket
to the URL itself, so the shared Control Plane needs `SUPERTAG_WORKLET_TRANSPORT=remote` when it
runs with `supertag start control-plane`, as in
[step 1](#1-start-the-control-plane-with-a-worklet-listener). The host's credential is saved in
`~/.supertag/hosts/laptop/`, so later runs restart the same host and ignore the key. See
[Add teammates](self-hosting.md#add-teammates).

### Connect in the foreground

`supertag start control-plane` and `supertag connect worklet`, as the rest of this guide shows,
expose every option, run one harness per Worklet in the foreground, and suit deployments, scripts,
and custom setups. Neither reads `supertag.yaml`. `connect worklet` keeps its credentials in
`~/.supertag/worker-hosts/`.

## Before you start

- A persistent Control Plane you can restart with new environment variables.
- An operator environment where `supertag status control-plane` succeeds.
- A Worker Host with the codebase the harness should inspect, and a harness installed and
  authenticated there. See [Choose a harness](#choose-a-harness).
- A Tag for the host to serve, such as `researcher`.

## 1. Start the Control Plane with a Worklet listener

Configure the Control Plane to accept an outbound connection through its Worklet API:

```sh
export SUPERTAG_WORKLET_TRANSPORT=remote
export SUPERTAG_WORKLET_GRPC_PORT=3435
supertag start control-plane
```

The Control Plane now listens for Worklets on port 3435. For a Control Plane on another machine,
add TLS as shown in [Connect securely through gRPC](#connect-securely-through-grpc).

## 2. Create an Auth Key

An **Auth Key** is a secret that lets a machine join as a Worker Host with one command. The host
that joins is bound to the key's Tags, so it can run their Tasks right away.

From an operator environment, create a key for the Tag:

```sh
supertag create auth-key laptop --tag researcher
```

The command prints a secret that starts with `stak_`. It is shown only once. This one-off key
joins one host and expires after one hour. For CI runners or containers, create a reusable key
whose hosts are removed after they disconnect:

```sh
supertag create auth-key ci --tag researcher --reusable --ephemeral
```

A reusable key expires after 90 days. `supertag list auth-key` shows every key without its secret,
and `supertag revoke auth-key NAME` stops a key from joining more hosts.

## 3. Join and connect the Worklet

On the Worker Host, pass the key and connect:

```sh
supertag connect worklet \
  --worklet-url http://127.0.0.1:3435 \
  --auth-key stak_... \
  --harness codex \
  --workspace /absolute/path/to/codebase \
  --worker-profile local-codex
```

The Worklet joins as a Worker Host named after the machine's hostname, such as `laptop`. It stores
the host's credential under `~/.supertag/worker-hosts/` and connects outbound. Pass
`--worker-host NAME` to choose another name; if the name is taken, the Control Plane picks
`NAME-2`. To keep the key out of shell history and the process list, set `SUPERTAG_AUTH_KEY`
or pass `--auth-key file:PATH` with a file that holds the key. Prefer either for reusable keys.

The Worklet joins through the Control Plane's management API, not the Worklet listener. It uses
`SUPERTAG_CONTROL_PLANE` when set. Otherwise a WebSocket Worklet URL names the management API
itself, and a gRPC Worklet URL falls back to the saved Control Plane, here `127.0.0.1:3434`. On a
new machine that reaches a remote gRPC listener, set `SUPERTAG_CONTROL_PLANE` to the management
URL, such as `https://control.example.com`.

Run the same command again later. The stored credential is used first and the key is ignored, so
scripts can always pass it. Without a stored credential or a key, `connect worklet` enrolls the
host with the operator credentials on the machine, if they reach this Control Plane. Otherwise it
asks for an Auth Key.

The Worklet supervises the Worker Host. Its Workers can remain near local files and credentials
while the Control Plane runs remotely.

`--workspace PATH` names a folder that Tasks may inspect as a copy. To let Tasks change a
repository, declare a checkout of a Workspace instead with `--workspace NAME=PATH`, such as
`--workspace app=~/code/app`. Repeat it for more Workspaces. Each Task that names the Workspace then
works in its own git worktree on a `supertag/...` branch. A Workspace with a `source` needs no
flag: a host without a checkout clones it. See
[Work in a repository with Workspaces](workspaces.md).

## 4. Bind more Tags

The key already bound the host to `researcher`. To let another Tag use the host, bind it:

```sh
supertag update tag reviewer --add-worker-host laptop
```

A Tag may be bound to several hosts. The Control Plane picks one for each Task; see
[Worker Host selection](../reference/scheduling-and-recovery.md#worker-host-selection) for the
ranking, queue order, and what happens when no host is available.

### Keep a Tag's Tasks on the right hosts with labels

Bindings say which hosts may run a Tag's Tasks. Labels choose among them. Suppose `researcher` is
bound to a Linux server and a Mac with a GPU, and its Tasks need the GPU. Give the Mac a label when
it connects:

```sh
supertag connect worklet --worklet-url http://127.0.0.1:3435 --harness codex --label gpu
```

Then list the label in the Tag's manifest and apply it:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata:
  name: researcher
spec:
  runsOn: [gpu]
```

Now the Tag's Tasks run only on bound hosts that carry every `runsOn` label. Each Worklet also
advertises automatic labels: `linux`, `macos`, or `windows`; `x64` or `arm64`; `harness:NAME`;
`workspace:NAME` for each declared checkout; and `mcp:NAME` for each MCP server a host service
provides. To label every host that joins with a key, add
`--label` when creating it:

```sh
supertag create auth-key gpu-pool --tag researcher --reusable --label gpu
```

`supertag describe worker-host NAME` lists a host's labels. When no bound host carries a Tag's
labels, its Tasks wait, and `supertag describe task ID` names the missing labels. Labels are
self-reported by each host, so they never grant access; only bindings do. See
[Worker Host labels](../reference/resource-model.md#worker-host-labels).

### Remove a host

A Worker Host may revoke its own credential. Without operator credentials on the machine, the
command uses the host's stored credential:

```sh
supertag revoke worker-host-credential laptop
```

The command finds the credential of a host service in `~/.supertag/hosts/SERVICE/`, or of a
`connect worklet` host in `~/.supertag/worker-hosts/`. It deletes the file after the Control Plane
accepts the revocation. Stop a revoked host service with `supertag down SERVICE`.

## Check that it worked

Confirm the Control Plane's stored view of the host:

```sh
supertag describe worker-host laptop
```

It reports the connected Worklet and the `local-codex` **Worker Profile**, a saved recipe for
running a Worker. After you assign the Tag a
Task, check where it ran:

```sh
supertag describe task TASK_ID
```

It shows the eligible Worker Hosts and the selected Worker Host, Worklet, and Worker. Both views
use stored evidence and do not contact the Worker Host.

## Rules for remote hosts

- Use `https://` for a Control Plane on another machine. An `https://` URL selects gRPC over TLS;
  with `--transport websocket`, the Worklet converts it to `wss://`. Non-loopback plaintext
  endpoints are rejected.
- Keep the credential outside the harness workspace.
- Local-process execution under the same operating-system account is not a filesystem security
  boundary. Production harnesses need a separate identity or sandbox that cannot read supervisor
  state. See [credentials and local access](../concepts/persistence.md#credentials-and-local-access)
  for the local Codex and Claude Code filesystem boundaries.

For the supported Dockerized Control Plane path, see [Self-host SuperTag](self-hosting.md).

## Keep artifacts on Worker Hosts

Every Worklet stores the **artifacts**, output files, that its Tasks capture on its own Worker Host, under
`SUPERTAG_STATE_DIR/artifacts` (by default `~/.supertag/artifacts`), or on its
[artifact Volume](#3-store-artifacts-on-a-volume) when it has one. The Control Plane never
receives, relays, or stores those bytes. The Worklet registers verified content locations with the
Control Plane, but the bytes remain on the host. When another Task is allowed to consume the
artifact, its Worklet gets the metadata and a short-lived transfer grant from the Control Plane and
downloads directly from the serving Worklet when its transfer endpoint is configured and reachable.
A default loopback Worklet advertises no endpoint to other machines.

### 1. Choose the transfer endpoint

Other Worklets download copies from this Worklet's transfer endpoint. Set the listener and the URL
peers use when connecting the Worklet:

```sh
supertag connect worklet \
  --worklet-url https://control.example.com:7443 \
  --worker-host laptop \
  --harness codex \
  --workspace /absolute/path/to/codebase \
  --artifact-transfer-host 0.0.0.0 \
  --artifact-transfer-port 7444 \
  --artifact-transfer-url https://worker.example.com:7444
```

`--artifact-transfer-host` and `--artifact-transfer-port` select the local listener.
`--artifact-transfer-url` is the public base URL other Worklets can reach; it must use HTTPS outside
loopback. Use `--artifact-transfer-allow-http` only for an isolated development network.

A loopback address such as the default `127.0.0.1` reaches only this machine, so a connected
Worklet advertises no transfer endpoint unless you set `--artifact-transfer-url` or a specific
`--artifact-transfer-host` address. Without one, other Worklets can't download its copies. Host
services that `supertag up` starts serve each other over loopback on the same machine.

With `--transport grpc`, catalog requests, location reports and transfer grants use the same gRPC
listener as the Worklet connection. Artifact bytes still move directly between Worklets. With
explicit WebSocket transport, metadata uses the authenticated HTTP API; `--artifact-control-plane`
can override its HTTP origin. Authority renewal uses the HTTP origin provided in each Task Attempt.

With default hosts, dependent Tasks needing artifact inputs fail with the unavailable error when
placed on another machine. Resumed **Sessions** (groups of Tasks from one conversation) restoring
harness-home artifacts on a different host fail the same way. Configure a shared artifact
**Volume**, a named storage location, or a reachable transfer endpoint before
moving those Tasks or Sessions. Native Session transcripts on the Control Plane do not replace
the missing artifact bytes.

### 2. Keep the artifact directory persistent

The artifact directory must outlive Worker and harness processes. Mount the Worklet's
`SUPERTAG_STATE_DIR` on persistent storage when it runs in a container, and keep it outside the
harness workspace. The transfer endpoint must be reachable by peer Worklets.

### 3. Store artifacts on a Volume

A [Volume](../reference/resource-model.md#volumes) is a named storage location, such as a bucket
prefix or a shared directory. Give a Worker Host an **artifact Volume** when its artifacts must
outlive the host, as on a container or cloud machine. The host then stores each artifact its Tasks
capture on that Volume instead of under its state directory.

For example, apply a Volume for team artifacts, then connect a Worklet that stores its artifacts
there:

```yaml
kind: Volume
metadata: { name: team-artifacts }
spec:
  source: s3://acme-supertag/artifacts/
  credential: team-artifacts
```

```sh
supertag connect worklet \
  --worklet-url https://control.example.com:7443 \
  --harness codex \
  --artifact-volume team-artifacts \
  --artifact-volume-credential file:/run/secrets/team-artifacts.json
```

`--artifact-volume` names the Volume. `--artifact-volume-credential` names a file on this host that
holds the credential the Volume names. It takes only `file:PATH`: the credential never appears in a
flag, a process listing, or a log. For an `s3://` or `r2://` Volume, the file holds a JSON object
with `accessKeyId` and `secretAccessKey`, and optionally `sessionToken`. For a `file://` Volume, such
as an NFS share the host already mounted, it holds `{ "path": "/DIR" }`: the directory the host
consents to write to, which must contain the Volume's source. The host reads the file each time it
needs the credential, so a rotated file takes effect without a restart. Each flag needs the other.

A host service names its artifact Volume in supertag.yaml with
[`artifact-volume`](../reference/supertag-yaml.md#artifact-volume), and maps its credential in
`volume-credentials`.

What happens:

- The host reads the Volume's source and credential name from the Control Plane's catalog, and
  only the Volume it named. The credential value stays on the host.
- Each artifact file is its own object at `attempts/<attemptId>/sha256/HEX` beneath the Volume's source.
  The key names the producing Task Attempt and the file's SHA-256 digest.
- The host reports each copy to the catalog. The catalog checks that the host stores artifacts on
  that Volume and that the producing Task Attempt ran there. It derives the key from that Task
  Attempt and digest. `describe task` shows the Volume as the copy's location.
- No Workspace may mount an artifact Volume, or any Volume whose location is, contains, or sits
  inside it. A mount would hand a Task every artifact there, bypassing artifact grants. The Control
  Plane refuses the mount when it places the Task. It treats `s3://` and `r2://` as one scheme and
  compares endpoint origins, bucket, and prefix segments, not the strings as written. The Worker
  Host checks again before copying, and compares `file://` sources by their real paths.
- An ephemeral host with an artifact Volume keeps its artifacts there, so `connect worklet` does not
  warn that it would hold their only copy.

Hosts that can't reach each other, such as laptops behind NAT or CI runners, share artifacts
through a common artifact Volume. Give both hosts the same artifact Volume, each with its own copy of
the credential. When a Task on one host needs an artifact the other host captured, the consuming
host asks the Control Plane where the artifact is. The Control Plane first checks that the Task was
given the artifact. It then names the copy's key on the Volume, and the consuming host reads that
one key with its own credential and checks the content against the artifact's digest. Without a
readable Volume copy, it downloads directly from a producing host it can reach. With neither, the
Task fails with an error that names the hosts and Volumes holding the artifact and says a shared
Volume would make it reachable.

The Control Plane's checks govern only what SuperTag Workers fetch. Any host mapped to a shared
Volume holds its credential and can read everything on it. Sharing a Volume means trusting every
host mapped to it with all of its contents, so use one artifact Volume per trust domain.

### Rules for artifacts on Worker Hosts

- Transfer authorization is separate from the Worklet's outbound assignment connection. The
  serving Worklet validates each signed grant locally.
- The consumer verifies the SHA-256 digest before using the bytes.
- One host copy is not a replica. If that host is offline, the artifact remains in the catalog but
  its bytes are unavailable. If its disk is lost, the bytes are lost. The Control Plane keeps no
  copy to fall back on.
- An ephemeral Worker Host, one that joined with an ephemeral Auth Key, loses its copies when it
  stops unless it stores them on an artifact Volume. `connect worklet` warns when such a host would
  hold the only copy of the artifacts its Tasks capture, and connects anyway. Give it an
  `--artifact-volume`, or run work whose artifacts must last on a persistent Worker Host.

See [artifacts](../reference/artifacts.md#storage-and-limits) for storage and failure guarantees.

## Connect securely through gRPC

A **transport** carries assignments and results between the Worklet and the Control Plane.
HTTP(S) listener origins select gRPC by default. Explicit WS(S) URLs or `--transport websocket`
select the legacy transport. gRPC uses HTTP/2 and the same enrolled Worker Host identity. The
Worklet still opens the connection; the Worker Host needs no inbound port.

### 1. Enable the TLS listener on the Control Plane

On the Control Plane, enable an additional listener for its **API Server**, the subsystem that
handles management requests and execution connections:

```sh
export SUPERTAG_WORKLET_TRANSPORT=remote
export SUPERTAG_WORKLET_GRPC_PORT=7443
export SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE=/etc/supertag/worklet.crt
export SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE=/etc/supertag/worklet.key
supertag start control-plane --host 0.0.0.0
```

### 2. Point the Worklet at the listener

On the enrolled Worker Host, point `--worklet-url` at that listener:

```sh
supertag connect worklet \
  --transport grpc \
  --worklet-url https://control.example.com:7443 \
  --worker-host laptop \
  --harness codex \
  --workspace /absolute/path/to/codebase
```

Use `SUPERTAG_WORKLET_TLS_CA_FILE` for a private certificate authority.

### Rules for gRPC

- TLS is required outside loopback, and the URL's hostname must match the certificate.
- The HTTP management API continues using its own port; enrollment commands use that management
  URL. To join a new host with an Auth Key through this listener, set `SUPERTAG_CONTROL_PLANE` to
  the management URL, such as `https://control.example.com`.
- The CLI Worklet keeps a record of accepted execution on the Worker Host so a reconnect can
  inspect it. See [Leases and unknown outcomes](../reference/scheduling-and-recovery.md#leases-and-unknown-outcomes).
- For supported protocol versions and failover behavior, see
  [Worklet connection transports](../reference/worker.md#worklet-connection-transports).
- The Worklet connection and the [shared execution environment](shared-execution.md) connection
  are configured independently. For example, a laptop can receive assignments over gRPC while its
  harness uses local tools, or it can execute tools in a shared sandbox.

## Choose a harness

### Codex

Use `--harness codex`. Authentication comes from `CODEX_API_KEY`, `OPENAI_API_KEY`, or an existing
file-backed Codex sign-in copied from the Worker Host into the isolated Task Attempt directory. Codex
currently runs only the root harness actor: SuperTag disables its native subagents until Codex can give
child agents a tool set distinct from the root harness actor's tools.

#### Optional: Limit reported tokens

For Codex Tasks that request a reported-token limit, add `--codex-execution-mode app-server` when
connecting the Worklet:

```sh
supertag connect worklet \
  --worklet-url http://127.0.0.1:3435 \
  --worker-host laptop \
  --harness codex \
  --codex-execution-mode app-server \
  --workspace /absolute/path/to/codebase
```

App-server mode interrupts execution after a token report reaches the limit. See
[execution limits](../reference/worker.md#execution-limits) for the limits each harness supports.

Rules:

- The default `exec` mode does not advertise that control, so the scheduler will not place a Task
  requiring it there.
- A report can overshoot the threshold.
- If recovery has no saved usage baseline, SuperTag counts the full reported total
  conservatively. Usage remains marked incomplete, and the budget outcome remains unknown. The
  threshold can stop that Attempt early if the total includes earlier work.
- After 80% of that reported-token ceiling, if at least 4,096 reported tokens remain, SuperTag
  makes one attempt to send Codex a short runtime reminder to prioritize required verification
  and completion. The reminder states whether accounting is complete or conservative.
- The reminder does not raise the limit or guarantee delivery before a late usage report crosses
  the ceiling.
- Task instructions also include requested limits so agents can plan within them from the start.

Codex app-server also retries some model-capacity rejections; see
[Automatic retries](../reference/scheduling-and-recovery.md#automatic-retries).

### Claude Code

Use `--harness claude-code --worker-profile local-claude-code`. The Claude Agent SDK reads
`ANTHROPIC_API_KEY` from the Worker Host environment. Add `--allow-unsandboxed-commands` to let it
run Tasks that may run commands; see [Harnesses without a sandbox](#harnesses-without-a-sandbox).

### Cursor

Use `--harness cursor --model composer-2.5` on a macOS or Linux **Worker Host**, a machine that
runs Tasks. The built-in Worker uses the [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript.md)
in a supervised process; `cursor-agent` is optional. Generate an API key at
[Cursor Dashboard → API Keys](https://cursor.com/dashboard/api) and set `CURSOR_API_KEY` in the
host's env file, `~/.supertag/.env`. Cursor's app or CLI login does not authenticate the SDK. `supertag init` checks the key by listing available models without
sending a prompt. See [Cursor setup and limits](../operations/requirements.md#cursor-setup-and-limits).

For a host service, use the existing `harnesses` and `models` fields:

```yaml
services:
  laptop:
    type: host
    harnesses: [cursor]
    models:
      cursor: [composer-2.5]
```

In a Tag or **Role** (a reusable responsibility) manifest, `spec.execution.harness: cursor`
selects that harness. A **Worker Profile** is the saved Worker recipe that advertises its
capabilities. The Worklet creates a Cursor profile when it connects; see
[Worker reference](../reference/worker.md#cursor).

### OpenCode

Use `--harness opencode --model provider/model`, replacing both parts with an installed OpenCode
provider and model. The Worker forwards only the selected provider's configured API credential.
Like Claude Code, it needs `--allow-unsandboxed-commands` to run Tasks that may run commands.

### Choose models and effort

A Worker Host advertises the models each harness serves, and Tags pick among them. Repeat
`--model` to offer several; the first is the default for Tasks that name no model:

```sh
supertag connect worklet --harness codex --model gpt-6-sol --model gpt-6-max ...
```

`--model codex=gpt-6-max` names the harness too and must match `--harness`. A host service in
`supertag.yaml` lists models per harness instead; see
[Host models](../reference/supertag-yaml.md#host-models).

A Tag's `spec.execution`, or that of its **Role** (an assigned responsibility), then chooses the harness, model, and effort its Tasks use, within
what the host offers. A Task that names a model runs only on a bound host that lists it. See
[execution settings](../reference/resource-model.md#execution-settings).

Effort maps to each harness's own option: Codex `model_reasoning_effort`, and the Claude Code
effort option. OpenCode has no effort option and ignores it.

Each Task Attempt may run for 60 minutes; `--timeout-ms` changes that for one Worklet. SuperTag sets
no turn cap for Claude Code.

### What every harness receives

- The shipped harness profiles ignore ambient user/project MCP configuration. They receive only the
  **Skills** (reusable instruction packages), workspace, tools for each **collaboration surface**
  (an external work tool such as Slack), and harness-native tools allowed for the Task.
- SuperTag coordination tools are available only to the root harness actor; supported native subagents
  use harness-local coordination.
- Hosted Surface calls also pass through a Worker-local policy boundary that validates their
  target resource for preset tools with a resource mapping: GitHub repositories, Slack
  channels, Linear teams, Teams channels, and Lark chats. Other tools are granted per tool.
- Runtime permissions separately control command, file-write, web, and browser tools.
- A Surface write is available only when the active **Permission Set** (the allowed actions), call target, and Worker's
  native credential allow the same resource and action.

## Optional: Skills

Set `skills: ~/skills` on a host service in `supertag.yaml`. The path can name a directory of
Skill packages, each with `SKILL.md`, or a JSON catalog file. The host catalog is an allowlist:
a **Context Set**, a reusable knowledge selection, selects Skill names, and the Worker verifies version or digest pins before staging
them. Workspace Skills selected by `spec.skills` take precedence when names match.

## Optional: request-selected GitHub workspace

If a request names an authorized GitHub repository, the Workspace Resolver can resolve a
commit-pinned snapshot using the host-local `GITHUB_TOKEN`. GitHub and Slack tools use the host
service's MCP presets and `target: mcp` Permission Set grants instead. See
[MCP tools](../surfaces/worker-tools.md). Linear, Teams, and Lark tools also come from host
service presets.

## Roll back a connection transport

### 1. Stop the current connection

Stop the previous connection before reconnecting. Keep the same Worker Host credential and
persistent Attempt journal.

### 2. Reconnect over WebSocket

Configure `--transport websocket` and point `--worklet-url` at the HTTP API origin or its
`ws:`/`wss:` Worklet URL.

Inspect accepted Attempts rather than creating replacement executions. A failed gRPC call never
triggers automatic WebSocket redispatch.

Hosted deployment guides use explicit WebSocket configuration until their HTTP/2 listener is
configured and tested. A gRPC endpoint is a separate listener from HTTP management; changing the
client transport cannot make an HTTP/1 proxy carry gRPC.

## If something goes wrong

- **The host never shows as ready, or a Task stays pending.** Work through
  [Troubleshoot the first reply](troubleshooting.md#4-separate-collaboration-surface-testing-from-worker-testing).
- **The Worklet keeps reconnecting.** Check the close code in
  [A remote Worklet keeps disconnecting](troubleshooting.md#a-remote-worklet-keeps-disconnecting).
- **A Task stays queued while others run.** Run `supertag describe task TASK_ID`. A line such as
  `Waiting for a free claude-code slot on Worker Host laptop (2 of 2 busy: ...)` names the Tasks
  holding the host's slots. Wait for one to finish, or
  [raise the host's concurrency](#run-several-tasks-at-once). A line starting `Not started:` means a
  slot was free and names what else holds the Task, such as its Team's `maxConcurrency`.
- **The host stays at capacity after a forced kill.** Follow
  [A Worker Host stays at capacity after a forced kill](troubleshooting.md#a-worker-host-stays-at-capacity-after-a-forced-kill).
- **Assignment is rejected because the Tag has no host.** Repeat step 4; see
  [Worker Host selection](../reference/scheduling-and-recovery.md#worker-host-selection).

## Next

- [Build a custom Worker or harness](custom-workers.md) to add another agent runtime.
- [Worker reference](../reference/worker.md) for runtime contracts, environment placement options,
  and the continuity model.
- [Share an execution environment](shared-execution.md) to run tools in a shared sandbox.
- [Direct work with the CLI](../operations/cli.md) for a full local walkthrough.
