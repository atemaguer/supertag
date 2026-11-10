# Run a Worker in Modal sandboxes

Run each **Task Attempt**—one execution or retry of a **Task**, an accepted assignment—in a
separate Modal sandbox. Use `ModalExecutionEnvironmentProvider` when a custom Worker should isolate
its staged workspace in Modal. A split-capable harness can stay on the Worker Host.

- A **Worker** is the code that completes a Task.
- A **harness** connects the Worker to an agent system. For Claude Code and Cursor host
  services, it runs on the Worker Host while workspace tools run in Modal.
- The **Control Plane** still stores the work and applies policy.
- A **Worker Host** is the machine that provides execution capacity, and a **Worklet** connects it
  to the Control Plane's **API Server**, the subsystem that accepts execution connections.

See the [glossary](../reference/glossary.md) for other terms.

There are two ways to use Modal:

| Way | When to use it |
| --- | --- |
| A **host service** (a `host` entry in supertag.yaml that connects its machine as a Worker Host) with `environment` | The built-in Claude Code, Codex, or Cursor Workers, with no code |
| A custom Worker with `ModalExecutionEnvironmentProvider` | Your own Worker or harness; steps 1 to 4 below |

## Run a host service in Modal

Name the Modal app, and optionally a registry image, on the host service:

```yaml
services:
  cloud:
    type: host
    control-plane: https://supertag.example.com
    harnesses: [claude-code]
    environment: { modal: { app: supertag-workers, image: python:3.13-slim } }
```

Then start it:

```sh
supertag up cloud
```

- Every Task Attempt gets its own Modal sandbox, created in the app. SuperTag creates the app
  when it is missing. Claude Code and Cursor run on the Worker Host; their workspace tools run
  in that sandbox.
- For these split paths, the image needs `python3` and POSIX shell tools, plus project
  dependencies. The default, `python:3.13-slim`, supports the bridge. No Claude Code or
  Cursor install is needed.
- The host signs in to Modal with `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, from the environment
  or an `env_file`, or with `~/.modal.toml`. Sandboxes never receive these credentials.
- Claude Code and Cursor provider keys and native Session state stay on the Worker Host.
  Their split paths never send keys into sandbox files, environment variables, or processes.
- Read, write, edit, glob, grep, ls, and foreground commands use the bridge. Write and edit need
  `files:write`; commands also need `commands:execute`. These are actions in a **Permission Set**,
  a reusable selection of allowed actions. Background commands are unavailable.
- Remove `allow-unsandboxed-commands` from a service with `environment`; startup refuses it.
  See [Built-in harness paths](shared-execution.md#built-in-harness-paths) for each harness's
  disabled tools, Skills, MCP placement, and repository-rule limits.
- Codex runs through app-server on the Worker Host and exec-server in the sandbox. A host
  service with `environment` refuses OpenCode because its provider key would enter the sandbox.
  Use Claude Code, Codex, or Cursor for Modal, or remove `environment` for local OpenCode.
- Each sandbox lives at most the Task Attempt time limit plus ten minutes, so a stopped host leaves
  nothing running.

`supertag ps` shows the host as `host (modal)`. See
[Host environment](../reference/supertag-yaml.md#host-environment) for every setting and
[Run in e2b or Modal sandboxes](workspaces.md#run-in-e2b-or-modal-sandboxes) for repository work
in sandboxes.

### Attach a read-only dataset

A **Workspace** names the git repository a Task uses. A **Volume** names external storage it can
attach beside that checkout. Use a native mount when a shared dataset is too large to copy.
A Worker Host on macOS or Linux can start these mounts in its remote Modal sandboxes.

Create a Modal Secret named `dataset-access` containing the bucket credentials Modal requires.
Keep its values in Modal; the host service maps only its name:

```yaml
services:
  cloud:
    type: host
    control-plane: https://supertag.example.com
    harnesses: [codex]
    environment: { modal: { app: supertag-workers } }
    volume-credentials:
      datasets: { modal-secret: dataset-access }
```

Apply a Volume and a Workspace that selects it:

```yaml
apiVersion: supertag/v1
kind: Volume
metadata: { name: datasets }
spec:
  source: s3://acme-training/datasets/
  credential: datasets
---
apiVersion: supertag/v1
kind: Workspace
metadata: { name: research }
spec:
  source: https://github.com/acme/research.git
  mounts:
    - volume: datasets
      path: /mnt/datasets
      strategy: mount
      access: read-only
```

Save this manifest as `research.yaml`, then run:

```sh
supertag apply -f research.yaml
supertag up cloud
```

Modal attaches the dataset after setup, when the Task sandbox starts. Neither prepared images nor
snapshots include mounted data. `supertag describe task TASK_ID` shows the live source, prefix,
and attachment time. The mount has no content manifest and may change while the Task runs.

For GCS, use `gs://BUCKET/PREFIX/` and a Modal Secret. For R2, use
`r2://BUCKET/PREFIX/?endpoint=https%3A%2F%2FACCOUNT.r2.cloudflarestorage.com` and a Modal Secret.
S3 also accepts a host mapping of `{ modal-oidc-role: ARN }`. That role must trust Modal's OIDC
identity and grant the required read access.

To mount an existing Modal Volume, set the Volume resource's source to
`modal-volume://training/models/` and set `credential: team-data`. On the host, add
`team-data: { modal-volume: training }` under `volume-credentials`. The mapped name must match
exactly, including case. The mount uses the host's configured Modal environment; queries are rejected.
Both new source schemes require `strategy: mount`; `copy` refuses them.

Native mounts always use provider-enforced read-only access. Mount destinations cannot overlap
the checkout, staged files, other mounts, or artifact storage. Use bucket prefixes ending in `/`;
unsupported endpoint and path-style options produce an explicit refusal. See
[Native source settings](../reference/resource-model.md#native-source-settings) for the full contract.
These source and credential settings are Experimental.

The rest of this page builds a custom Worker instead.

## Before you start

- An enrolled Worker Host and its credential. See [Run a Worker](workers.md).
- A Modal account, with an existing Modal application or permission to create one.
- A Linux image, as a registry image or an existing Modal image ID, containing `python3` and the
  selected harness executable when runtime and tools are colocated.
- Model credentials for the selected harness, set through its supported provider environment
  variables. They are separate from Modal account credentials.

## 1. Install the package

Install the published SDK from npm in your Worker application. See
[installation](../operations/install.md) for runtime requirements and version matching:

```sh
npm install supertag-ai
```

## 2. Authenticate the Worker Host with Modal

Use Modal's normal profile or the `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` environment
variables. Keep those credentials in the host's secret manager or provider configuration. See
[Modal's JavaScript SDK](https://modal.com/docs/guide/sdk-javascript-go) for setup.

The adapter does not copy Modal account credentials into the sandbox or accept them in a
**Worker Profile**, the saved, versioned recipe for running a Worker.

## 3. Compose the Worker

Create a Modal application and prepare a Linux image containing `python3` and the selected harness
executable. The default image, `python:3.13-slim`, supports file staging and Python commands but
does not include Codex, Claude Code, or OpenCode. Use a registry image or an existing Modal image ID
containing the tools you need.

```ts
import { LocalWorklet } from "supertag-ai";
import { createCodexWorker } from "supertag-ai/harnesses/codex";
import { ModalExecutionEnvironmentProvider } from "supertag-ai/environments/modal";

const imageId = process.env["MODAL_IMAGE_ID"];
const model = process.env["CODEX_MODEL"];
if (!imageId || !model) throw new Error("Configure MODAL_IMAGE_ID and CODEX_MODEL");

const environment = new ModalExecutionEnvironmentProvider({
  appName: "supertag-workers",
  imageId,
  sandboxTimeoutMs: 300_000,
  cpu: 1,
  memoryMiB: 1024,
});

const worker = createCodexWorker({
  workerId: "modal-codex",
  profileId: "modal-codex",
  model,
  sandboxMode: "external",
  environment,
  maxConcurrency: 2,
});

export const worklet = new LocalWorklet("modal-worklet", "worker-host-1", [worker]);
```

Codex's explicit `sandboxMode: "external"` delegates isolation to the Modal Execution Environment
rather than starting an inner Codex sandbox. See [Sandbox rules](#sandbox-rules) before using it.

## 4. Connect the Worklet and run the application

Connect this Worklet using the transport setup in [Build a custom Worker](custom-workers.md). Run
the application with its normal Node deployment process. `supertag connect worklet` runs Workers
on its own machine; for built-in Workers in Modal, use a
[host service](#run-a-host-service-in-modal).

## Check that it worked

Confirm that the Worker Host advertises the Modal Worker:

```sh
supertag describe worker-host worker-host-1
```

It lists the `modal-codex` Worker and profile. A **Tag** is a persistent AI actor with its own
responsibilities and permissions. After a Tag bound to this host receives a Task,
`supertag events task TASK_ID` shows its Task Attempt events.

## Provider options

- `appName` names an existing application by default. Set `createAppIfMissing: true` only when the
  Worker should create it.
- `environment` selects a Modal environment.
- `image` selects a registry image; `imageId` selects an existing Modal image. Supply one of those
  image options, not both.
- `cpu` and `memoryMiB` set matching reservations and hard limits.
- The sandbox lifetime defaults to five minutes; choose it to cover staging, execution, and output
  export.
- These limits are resource and lifetime controls, not a currency spending cap.

## Sandbox rules

- Use `sandboxMode: "external"` only with a remote provider whose filesystem and network boundary
  you control. It is rejected for local process execution and requires admitted `files:write`
  authority.
- SuperTag's admission and permission checks remain in force; this option does not grant
  additional coordination authority.
- Providers and environments can declare `guarantees` for filesystem isolation, network-policy
  enforcement, process-tree termination, and scoped HTTP support. Missing guarantees mean unknown
  support, not implicit isolation.
- A remote placement label alone does not authorize Codex's external sandbox mode.

## Network, files, and cleanup

The adapter translates the Harness Plan's network policy:

| Policy | Modal behavior |
| --- | --- |
| `none` | Block outbound network traffic |
| `allowlist` | Allow TLS on port 443 to the listed domains; no additional CIDR grants |
| `unrestricted` | Modal's default outbound connectivity |

Network rules:

- Allowlist entries must be domain names, optionally prefixed with `*.`; URLs, ports, and CIDR
  ranges are rejected.
- Modal's domain allowlist is a beta feature and does not enable arbitrary protocols to those
  hosts.
- Include the model provider and Control Plane coordination API host when those connections are
  required. See [Modal networking](https://modal.com/docs/guide/sandbox-networking).

File rules:

- Copy mounts and artifact inputs are copied before the harness runs. Native Workspace mounts
  attach at sandbox creation, after setup.
- File staging creates files exclusively, rejects symbolic-link path components, and applies
  read-only permissions after overlays are installed.
- For copies, read-only permissions prevent ordinary writes; they are not immutable mounts against a process
  that can change its own permissions.
- Output reads use a bounded file descriptor and reject symbolic links.
- Configure an `ArtifactStore` on the Worker to preserve exported outputs before disposal; see
  [artifact transfer](custom-workers.md#preserve-generated-files).

Process and cleanup rules:

- Commands use native argument arrays and stream stdout and stderr separately.
- Cancellation and disposal terminate the entire attempt sandbox and wait for Modal to confirm
  exit.
- If confirmation fails or exceeds the cleanup bound, execution reports `ExecutionCleanupError`; it
  does not claim successful cleanup.
- The adapter does not reuse sandboxes across Task Attempts or expose inbound tunnels. Native
  mounts use provider-held secrets for attachment; they never inject those secrets into the sandbox.

## Optional: Connect to an environment-owned HTTP server

### 1. Request a connection after the server is ready

After a harness has started its server and observed readiness, it can request a scoped, unary HTTP
connection using that server's `ProcessHandle`:

```ts
if (!environment.connect) throw new Error("This environment does not support HTTP connections");
const connection = await environment.connect(server, {
  port: 8080,
  timeoutMs: 10_000,
  maxResponseBytes: 1024 * 1024,
});
try {
  const response = await connection.request({ path: "/" });
  console.log(response.status);
} finally {
  await connection.close();
}
```

Wait for the server's own readiness signal before requesting data. The request prints the server's
HTTP status.

### HTTP connection rules

- Requests use loopback inside the Modal sandbox, not the Worker Host network.
- The API accepts an origin-relative path and a process handle created by that environment; it
  does not accept arbitrary URLs or follow redirects.
- Responses are buffered and bounded (up to 32 MiB), and each request has a deadline.
- It does not provide SSE, WebSocket, or duplex streaming.
- Closing an idle Modal connection only revokes the connection. Aborting or closing an in-flight
  Modal request terminates the entire attempt sandbox and waits for confirmed cleanup, including
  its server. Do not use that operation as a native interrupt-turn mechanism for a server you
  expect to keep running.
- The local process provider offers the same unary API but checks listener and accepted-socket
  ownership with `lsof` and `ps` before sending HTTP data. Missing ownership-inspection tools fail
  closed. A local request cancellation closes its socket while leaving the supervised server
  running.

## Optional: Use a custom Modal client

For custom client integration, `ModalSandboxBackend` implements the existing `SandboxBackend`
interface, and `sandboxFactory` accepts the small native-client subset used by the adapter. Keep
custom factory authentication local to the Worker Host and preserve the same termination,
filesystem, and network guarantees.

## If something goes wrong

- **The harness command is not found in the sandbox.** The default `python:3.13-slim` image has no
  harness; supply `image` or `imageId` as described in [Provider options](#provider-options).
- **`sandboxMode: "external"` is rejected.** Check [Sandbox rules](#sandbox-rules).
- **The harness cannot reach its model provider.** Add the provider host to the allowlist; see
  [Network, files, and cleanup](#network-files-and-cleanup).
- **A Task Attempt reports `ExecutionCleanupError`.** Modal did not confirm sandbox exit within the
  cleanup bound; see [Network, files, and cleanup](#network-files-and-cleanup).

## Next

- [Build a custom Worker or harness](custom-workers.md) for the Worklet connection code.
- [Share an execution environment](shared-execution.md) to host a shared service instead.
- [Worker reference](../reference/worker.md) for execution environment contracts.
