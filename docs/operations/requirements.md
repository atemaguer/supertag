# Requirements

These requirements prepare a computer to run SuperTag. A **Tag** is a persistent AI actor with
its own responsibilities and permissions, and Tags work in Teams. Together, your Teams
of Tags make up an **autonomous organization**: Teams may pursue different goals but share one set
of rules and one record of the work. For example, a laptop can run the **Control Plane**, which
stores your organization and accepts work, and act as a **Worker Host**, which provides execution
capacity. A Worker Host runs each **Task**, one turn of a Tag's work, on a **harness**: an agent
system such as Codex, Claude Code, or Cursor.
Check this page before [installing SuperTag](install.md).

## System and tools

- **Node.js 22.13.0 or a later 22.x release** on `PATH` for Claude Code, Cursor, OpenCode, E2B,
  and Modal Tasks, which run through bridges in the release. Codex Tasks don't need it. The
  TypeScript SDK's [package](../../sdks/typescript/package.json) states its own supported
  runtime in `engines.node`.
- **npm**, included with Node.js, to install the TypeScript SDK. Source-development tools are
  listed in [CONTRIBUTING.md](../../CONTRIBUTING.md).
- **git**, available on `PATH`, and a repository for your first Task.
- **Docker**, running for the Worker Host's user, to keep Claude Code and Cursor Tasks in
  [local-vm containers](../reference/supertag-yaml.md#local-vm-containers). On macOS, Docker
  Desktop provides the Linux virtual machine. Allow about 1 GB for the container image and
  Workspace copies.
- **macOS on Apple silicon, or Linux on arm64 or amd64.** Linux needs glibc 2.36 or newer, as in
  Debian 12 or Ubuntu 24.04. Intel Macs have no release; [build the CLI](install.md#build-only-the-cli)
  there instead. Restarting background services uses launchd on macOS and systemd user services on
  Linux. Native Windows is not supported; use a Linux host.
- **Disk space for the release and your work.** Allow about 1 GB for each installed release, plus
  space for repositories, Task checkouts, captured artifacts, and logs. The
  [installer script](install.md#install-a-release-archive) keeps earlier releases under
  `~/.local/share/supertag/versions`; remove ones you no longer use.
- **To build a release archive from a checkout**: the Rust toolchain pinned in
  `core/rust-toolchain.toml`, Go, pnpm, Python 3.13, and uv. See
  [Build an archive from a checkout](install.md#build-an-archive-from-a-checkout).

## Choose and sign in to a harness

Prepare at least one harness on the Worker Host. Codex and OpenCode need their CLIs on `PATH`,
and `supertag init` finds Claude Code by its `claude` CLI; Cursor uses its bundled SDK and does not
need `cursor-agent`. Sign in as the same OS user that runs the host.

SuperTag runs the Codex CLI you install, so keep it current: `supertag init` and `supertag up`
check its version and stop with the upgrade command when it is older than the minimum. A newer
Codex may send notifications SuperTag doesn't know yet: one that only reports progress is logged
on the Worker Host and ignored, and any other fails the turn with `Codex emitted an unsupported
event type: NAME`. Claude Code
Tasks run the Claude Code bundled with the release's Claude Code bridge, unless the Worker Host
is started with `--claude-path`; `supertag init` and `supertag sign-in` use the `claude` on `PATH`
to find Claude Code and check its sign-in.

| Harness | Command on PATH | Minimum version | Sign-in |
| --- | --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/setup) | `claude` | None checked. Install with `npm install -g @anthropic-ai/claude-code`. | Run `claude` and follow its sign-in prompt. |
| [Codex](https://developers.openai.com/codex/cli/) | `codex` | 0.163.0. Install or upgrade with `npm install -g @openai/codex`. | Run `codex -c 'cli_auth_credentials_store="file"' login` so Tasks can use the sign-in file. On macOS, a Keychain-only login is not copied to Tasks. |
| [Cursor](https://cursor.com/docs/sdk/typescript.md) | None | None | Generate an API key and set `CURSOR_API_KEY` for the host service; see [Cursor setup](#cursor-setup-and-limits). Signing in to the Cursor app or `cursor-agent` is not enough. |
| [OpenCode](https://opencode.ai/docs/) | `opencode` | None | Set your selected provider's API-key environment variable for the Worker Host, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. |

For provider API credentials, use provider environment variables or SuperTag's masked prompts;
never put lasting credentials in command flags. Sign-in detection is local and best effort; a
missing credential file does not prove you are signed out. `supertag sign-in HARNESS` checks a
harness the way a Worker Host uses it. OpenCode receives only provider environment credentials, or
the file `--opencode-auth-file` names, and needs an explicit `provider/model`. See
[Run Worker Hosts](../guides/workers.md) for
remote hosts and [credential storage](../reference/credential-storage.md) for secret handling.

### Codex commands and models

Every current Codex model, gpt-6-sol among them, is code-mode-only: it runs commands only
through Codex code mode. Code-mode commands can reach the network that the `commands:execute`
sandbox otherwise blocks, so SuperTag starts code mode only for a Task that also has `web:fetch`.
A Codex Task with `commands:execute` but without `web:fetch` on such a model fails when its turn
starts, naming the model. To let it run commands, do one of these:

- grant the Tag `web:fetch` as well, which also opens the network to its commands; Codex allows
  `web:fetch` only with `files:write`. To limit that network, give the `web:fetch` grant a
  [network scope](../reference/iam.md#network-scopes); or
- select a Codex model that is not code-mode-only in the Tag's or Role's `execution.models`.

SuperTag cannot tell a model's mode before the Task Attempt starts: Codex does not report it, so
`supertag placement explain` cannot name it, and `supertag describe task` shows the failure as the
Task's result. `allow-unsandboxed-commands` does not apply to Codex, which always runs commands in
its own sandbox. `files:write` or `commands:execute` gives a Codex Task read access too; a Task
with none of `files:read`, `files:write`, and `commands:execute` is refused, because Codex reads
the Workspace in every sandbox mode.

### Cursor setup and limits

Cursor runs on macOS and Linux Worker Hosts. SuperTag drives Cursor through its TypeScript SDK,
and the SDK signs in only with an API key. Signing in to the Cursor app or `cursor-agent` does
not sign in the Worker Host, so every host that serves Cursor needs a key:

1. Generate a user API key at [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api).
   See [Cursor authentication](https://cursor.com/docs/cli/reference/authentication.md).
2. Add it to the host's env file, `~/.supertag/.env`, as one line:

   ```text
   CURSOR_API_KEY=your_api_key_here
   ```

   Type or paste the key yourself in an editor. Keep it out of shell history, command flags,
   Objective text, and messages to Tags. A key exported in the shell that runs `supertag up`
   also works, but a service unit does not inherit the shell.
3. Run `supertag init`, or `supertag up` for an existing setup. `init` offers Cursor only when
   `CURSOR_API_KEY` is set in the environment it runs in, so export the key in that shell too.
   SuperTag checks the key by listing Cursor's models, which uses no model turn. A missing key stops the host with the reason.
   A rejected key reports `Cursor rejected CURSOR_API_KEY`.

SuperTag passes the key only to the Cursor adapter. Tasks never receive it, and redaction removes
it from events and logs. To rotate the key, replace the line and restart the host with
`supertag down` and `supertag up`.

On Linux, a process running as the Worker Host's OS user may read the Cursor key from the
Worker Host's memory. It may also read the SDK runner's memory when `ptrace_scope=0` permits
same-user tracing. The runner receives the key over a private stdin channel, but Node does
not expose Linux's `prctl(PR_SET_DUMPABLE, 0)` call. Adding that call only to the runner
would still leave the key in the adapter's memory. Keep untrusted processes under a different
OS user, and restrict same-user tracing on hosts that run Cursor. Cursor's sandbox and log
redaction do not protect process memory from a process with tracing access.

### Cursor tools, models, and sandbox

Choose a model ID returned by Cursor's model list. For example, a host can serve
`models: { cursor: [composer-2.5] }`, and a Tag or its Role can choose
`execution.harness: cursor`. See [host models](../reference/supertag-yaml.md#host-models)
and [Cursor models and pricing](https://cursor.com/docs/models-and-pricing.md).

A **Context Set** selects reusable knowledge for a Tag. The Control Plane resolves
`supertag/artifacts` selections into artifact summaries in Cursor's prompt. This selection applies
only to Tasks from a collaboration surface, not internal Objective Tasks. Cursor does not load
[Skills](../reference/context-resolution.md#skills): a Task Attempt that carries a resolved
`supertag/skill` fails on Cursor. Cursor also enforces no execution limits, so a Task submitted to
a Cursor Tag with a token, cost, or native agent limit is refused.

For colocated local Tasks, SuperTag allows Cursor's read, search, list, and MCP tools.
It adds edit only for `files:write` and enables web search only for `web:search`.
Subagents and Cursor's built-in shell stay disabled. To run commands, grant both `files:write`
and `commands:execute`, and set `environment: local-vm` on the host service to run them in a
container, or `allow-unsandboxed-commands: [cursor]` to run them on the host.
With `allow-unsandboxed-commands`, the adapter runs those commands on the host, with the host's network access, so a package manager
can fetch the version pinned by the project. Use a trusted repository for local command access,
or use a [remote environment](#cursor-with-a-remote-environment) to isolate its commands.

SuperTag keeps Cursor's [OS sandbox](https://cursor.com/docs/agent/security/run-modes.md) enabled
for the SDK and refuses a run if it is unavailable. Reads may still reach outside the workspace.
A private home excludes the operator's Cursor hooks, MCP servers, and rules; Cursor can still read workspace files.
SuperTag supplies only the Task's admitted tools, as Cursor
[custom tools](https://cursor.com/docs/sdk/typescript.md#custom-tools). The adapter stays their MCP
client. Sandboxed SDK runs reject inline MCP server tools because they cannot ask for approval.

### Cursor with a remote environment

A Worker Host run with `--local-vm`, `--e2b-workspace-provider`, `--modal-workspace-provider`,
or `--workspace-provider` runs Cursor's
SDK on the host and keeps the Workspace in a sandbox; see
[Run a harness in a sandbox](../guides/workers.md#run-a-harness-in-a-sandbox). Its API key and native Session state stay there; provider keys never enter
the sandbox's files, environment variables, or processes. Install your project's command
dependencies in the sandbox image. It needs `python3` and POSIX shell tools, with no Cursor
executable.

In this split mode, Cursor has no built-in tools. SDK custom tools provide read, write, edit,
glob, grep, ls, and commands in the sandbox, plus the Task's allowed external tools. Web search
and subagents are unavailable. A **Permission Set** selects allowed actions: write and edit
require `files:write`, and the command tool requires `files:write` and `commands:execute`.
Commands run in the sandbox without network access, so install your project's dependencies in
the sandbox image or its devcontainer setup. Such a host cannot take
`--allow-unsandboxed-commands`, and doesn't need it.

`local.cwd` is an empty host directory. Repository rules do not load automatically, so supply
needed instructions as Task context. Cursor's own sandbox provides no useful workspace
protection in split mode; the bridge checks file paths and permissions. See [Cursor reference](../reference/worker.md#remote-sandboxes-and-shared-execution).

### Cursor local runtime details

The SDK and local commands each get a private `HOME` and private XDG directories. Commands run
from the Task checkout and use the Worker Host's `PATH`, with the adapter's Node directory first.
They do not inherit `CURSOR_API_KEY`, `COREPACK_HOME`, `PNPM_HOME`, or `npm_config_*` variables.
Run the Worker Host with a Node version that meets the project's requirements and put the project’s
package manager or a compatible Corepack shim on its `PATH`. For example, Corepack can use
`"packageManager": "pnpm@10.15.1"` in `package.json` to install and run the pinned version.
The private home keeps operator configuration and caches separate.

For colocated local execution, Cursor's sandbox may refuse writes to `.cursor` even inside
a writable workspace.
An agent cannot assume that `files:write` allows changing Cursor's own repository
configuration, including `.cursor/sandbox.json`. Cursor's
[permissions](https://cursor.com/docs/cli/reference/permissions.md) and
[configuration](https://cursor.com/docs/cli/reference/configuration.md) describe its
own configuration boundary; SuperTag does not relax it.

The SDK reports tokens per Task Attempt. SuperTag records provider cost when returned, estimates
cost only for a model with a published price, and otherwise marks the Task Attempt unpriced.
For `auto`, SuperTag records provider-reported cost when available, but does not estimate one.
See [usage reporting](../reference/worker.md#built-in-harnesses).

### Credentials available during Tasks

When using a file-backed Codex sign-in, a local Codex Worker Host copies `~/.codex/auth.json`
(or the file under the host's `CODEX_HOME`) into each Task's working area. That copy can contain
a long-lived ChatGPT refresh token; its file permissions are restricted to the OS user.
Local Claude Code Tasks can use that user's secure credential store, including macOS Keychain.
Commands running as the same user may be able to access these credentials.

For shared or unattended Worker Hosts, prefer scoped `CODEX_API_KEY` or `ANTHROPIC_API_KEY`
credentials with appropriate provider limits. `CODEX_API_KEY` takes precedence over copying
the Codex sign-in file; `OPENAI_API_KEY` is only a fallback when that file is missing.

On a Worker Host with `allow-unsandboxed-commands` for Claude Code, an `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` given to the host stays in the Worker
Host. Each Task's Claude Code gets a stand-in value and the address of a proxy on `127.0.0.1` that
puts the real key on its requests to `api.anthropic.com`, and on nothing else. Claude Code also
removes its credentials from the environment of the commands it runs. A command can still call
Anthropic through that proxy while its Task runs, but it can't read the key from Claude Code or
the adapter.

OpenCode works the same way on such a host for its `anthropic` and `openai` providers: the
provider's API key, given to the host (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) or from an
`api` entry in the OpenCode auth file, stays in the Worker Host, and OpenCode's provider `baseURL`
points at the proxy, which forwards only to `api.anthropic.com` or `api.openai.com`. Other
providers, and an OpenCode sign-in that isn't an API key, stay readable to the commands OpenCode
runs; the Worker Host warns about that when it starts.

Cursor's key doesn't go behind the proxy. The Cursor SDK trades `CURSOR_API_KEY` for an access
token that it then sends itself, and Cursor's service can switch it to streams the proxy doesn't
carry. On a host with `allow-unsandboxed-commands: [cursor]`, the commands Cursor runs get an
environment without the key, but the Cursor adapter holds it, and a command running as the same
user can read it from the adapter process. The Worker Host warns about this when it starts. Use
`environment: local-vm` to keep the key out of their reach.

`supertag up` hands each Worker Host its harness's provider keys and tokens in a private file
that the host reads and deletes as it starts, rather than in its environment, so `ps eww`,
`/proc/<pid>/environ`, and tools that dump a process's environment don't show them. On Linux the
Worker Host also marks itself non-dumpable, so other processes of the same user can't read its
memory or environment through `/proc` or attach a debugger to it, and it writes no core dump.
A host started directly with `supertag worker-host` reads keys from its environment, unless it is
given the same kind of file, a JSON object of variable names to values, with
`--provider-credentials-file`.

None of this is a boundary against a command set on stealing the key: such a command runs as the
Worker Host's user and can read the host's `env_file` and the OpenCode auth file, and, where the
OS allows it, the host's memory. These measures close accidental leaks only. Only a sandbox, such
as `environment: local-vm`, keeps the key out of reach.

A sign-in made with `/login` lives in the system's secure store (the macOS Keychain) and can't go
behind the proxy, so commands Claude Code runs without a sandbox can reach it. The Worker Host
warns about this when it starts.

## Telemetry and network traffic

SuperTag does not send product analytics or usage telemetry to SuperTag maintainers.
Configured integrations still contact their services: the Control Plane, collaboration tools,
MCP servers, storage, execution providers, and model providers. Disabling telemetry does not
stop the model requests needed to perform Tasks.

Harnesses have separate policies. SuperTag isolates their configuration for each Task, so their
standalone opt-out instructions do not necessarily apply to SuperTag's Tasks.

### Codex

The Codex adapter runs `codex app-server` with a Task-local `CODEX_HOME` and sets
`analytics.enabled=false`, so managed Codex Tasks send no usage analytics. Your personal
`config.toml` does not apply to them. See [Codex](../guides/workers.md#codex). OpenTelemetry
export is separate and off by default; SuperTag does not configure an exporter. See
[Codex metrics](https://developers.openai.com/codex/config-advanced/#metrics) and the
[configuration reference](https://developers.openai.com/codex/config-reference/).

### Claude Code

Claude Code Tasks retain Anthropic's default usage statistics and error reporting.
SuperTag passes an allowlisted environment, disables settings sources, and uses a Task-local
configuration directory. It does not forward `DISABLE_TELEMETRY` or `DISABLE_ERROR_REPORTING`,
nor `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DO_NOT_TRACK`. Setting these variables in
your shell or personal Claude settings does not opt SuperTag's Tasks out.

There is currently no supported telemetry opt-out for Claude Code Tasks. SuperTag also
does not forward `CLAUDE_CODE_ENABLE_TELEMETRY`, so it does not opt into OpenTelemetry export.
See Anthropic's [data usage](https://code.claude.com/docs/en/data-usage) and
[monitoring](https://code.claude.com/docs/en/monitoring-usage) policies for the installed version
and account type.

### OpenCode

SuperTag generates the OpenCode configuration and leaves `experimental.openTelemetry` unset,
so optional AI SDK tracing is off. It disables session sharing, automatic updates, and project
configuration, and uses a Task-local home directory. Editing your personal `opencode.json`
does not configure SuperTag's OpenCode Tasks. See [OpenCode configuration](https://opencode.ai/docs/config/);
your selected model provider also has its own data policy.

On a host with `environment: local-vm`, or an E2B or Modal Workspace, SuperTag turns off every
built-in OpenCode tool and its subagents. The Task's read, write, edit, search, and command tools
are a `workspace` MCP server whose calls run in the Task's container or sandbox. OpenCode itself,
and its provider key, stay on the host, in an empty directory.
