# Requirements

These requirements prepare a computer to run SuperTag. A **Tag** is a persistent AI identity with
its own responsibilities and permissions, and Tags work in Teams under a lead. Together, your Teams
of Tags make up an **autonomous organization**: Teams may pursue different goals but share one set
of rules and one record of the work. For example, a laptop can run the **Control Plane**, which
stores your organization and accepts work, and act as a **Worker Host**, which provides execution
capacity. A **Worker**, the code that does the work, completes an assigned **Task**, one request or
assignment, through a **harness**: the connection to an agent system such as Codex, Claude Code, or Cursor.
Check this page before [installing SuperTag](install.md).

## System and tools

- **Node.js 22.13.0 or newer.** The `engines.node` fields in the root
  [package.json](../../package.json) and [SDK package](../../packages/supertag-ai/package.json)
  define the supported runtime.
- **npm**, included with Node.js, to install the published CLI and SDK. Source-development
  tools are listed in [CONTRIBUTING.md](../../CONTRIBUTING.md).
- **git**, available on `PATH`, and a repository for your first Task.
- **macOS or Linux.** Restarting background services uses launchd on macOS and systemd user
  services on Linux. Native Windows is not a supported alpha installation target; in particular,
  SuperTag does not implement a Windows service manager. Use a Linux host for that workflow.
- **Disk space for dependencies and your work.** Allow about 1 GB for the installed package, plus
  space for repositories, Task outputs, and logs. With `npm install -g`, npm also downloads the
  Claude Code and Codex CLI copies that the vendor SDKs bundle, about 520 MB more on macOS arm64.
  SuperTag doesn't use them, and the [installer script](install.md#or-use-the-installer-script)
  removes them.

The small bridge that runs MCP tools inside a sandbox has a separate runtime minimum, enforced
when SuperTag prepares that sandbox. See [MCP tools](../guides/mcp-tools.md#5-connect-from-the-execution-environment-when-the-server-lives-there).
Use the supported runtime above when installing SuperTag itself.

## Choose and sign in to a harness

Prepare at least one harness on the Worker Host. Claude Code, Codex, and OpenCode need their
CLIs on `PATH`; Cursor uses its bundled SDK and does not need `cursor-agent`. Sign in as the
same OS user that runs the host.

SuperTag runs the Claude Code and Codex CLIs you install, so keep them current. Each needs at
least the version SuperTag's SDK targets. `supertag init` and `supertag up` check the installed
version and stop with the upgrade command when it is older.

| Harness | Command on PATH | Minimum version | Sign-in |
| --- | --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/setup) | `claude` | 2.1.280. Install with `npm install -g @anthropic-ai/claude-code`; upgrade with `claude update`. | Run `claude` and follow its sign-in prompt. |
| [Codex](https://developers.openai.com/codex/cli/) | `codex` | 0.156.0. Install or upgrade with `npm install -g @openai/codex`. | Run `codex -c 'cli_auth_credentials_store="file"' login` so Tasks can use the sign-in file. On macOS, a Keychain-only login is not copied to Tasks. |
| [Cursor](https://cursor.com/docs/sdk/typescript.md) | None | None | Generate an API key and set `CURSOR_API_KEY` for the host service; see [Cursor setup](#cursor-setup-and-limits). Signing in to the Cursor app or `cursor-agent` is not enough. |
| [OpenCode](https://opencode.ai/docs/) | `opencode` | None | Set your selected provider's API-key environment variable for the **Worklet** process, the program that connects the Worker Host to the Control Plane, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. |

For provider API credentials, use provider environment variables or SuperTag's masked prompts;
never put lasting credentials in command flags. Sign-in detection is local and best effort; a
missing credential file does not prove you are signed out. A managed OpenCode Worker receives
only provider environment credentials and does not use credentials from `opencode auth login`,
even if initialization detects that login. OpenCode also needs an explicit `provider/model`
selection during initialization. See [Run a Worker](../guides/workers.md) for
remote hosts and [credential storage](../reference/credential-storage.md) for secret handling.

### Cursor setup and limits

Cursor runs on macOS and Linux Worker Hosts. SuperTag drives Cursor through its TypeScript SDK,
and the SDK signs in only with an API key. Signing in to the Cursor app or `cursor-agent` does
not sign in the Worker, so every host that serves Cursor needs a key:

1. Generate a user API key at [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api).
   See [Cursor authentication](https://cursor.com/docs/cli/reference/authentication.md).
2. Add it to the host's env file, `~/.supertag/.env`, as one line:

   ```text
   CURSOR_API_KEY=your_api_key_here
   ```

   Type or paste the key yourself in an editor. Keep it out of shell history, command flags,
   Objective text, and messages to Tags. A key exported in the shell that runs `supertag up`
   also works, but a service unit does not inherit the shell.
3. Run `supertag init`, or `supertag up` for an existing setup. SuperTag checks the key by listing
   Cursor's models, which uses no model turn. A missing key stops the host with the reason.
   A rejected key reports `Cursor rejected CURSOR_API_KEY`.

SuperTag passes the key only to the Cursor Worker. Tasks never receive it, and redaction removes
it from events and logs. To rotate the key, replace the line and restart the host with
`supertag down` and `supertag up`.

On Linux, a process running as the Worker Host's OS user may read the Cursor key from the
Worker's memory. It may also read the SDK runner's memory when `ptrace_scope=0` permits
same-user tracing. The runner receives the key over a private stdin channel, but Node does
not expose Linux's `prctl(PR_SET_DUMPABLE, 0)` call. Adding that call only to the runner
would still leave the key in the Worker's memory. Keep untrusted processes under a different
OS user, and restrict same-user tracing on hosts that run Cursor. Cursor's sandbox and log
redaction do not protect process memory from a process with tracing access.

### Cursor tools, models, and sandbox

`supertag init` also detects Cursor when only `cursor-agent` is installed, then asks you to set
`CURSOR_API_KEY`. A binary named `agent` counts as Cursor only if it identifies itself as Cursor;
another vendor may install that name.

Choose a model ID returned by Cursor's model list. For example, a host can serve
`models: { cursor: [composer-2.5] }`, and a Tag or its Role can choose
`execution.harness: cursor`. See [host models](../reference/supertag-yaml.md#host-models)
and [Cursor models and pricing](https://cursor.com/docs/models-and-pricing.md).

A **Context Set** selects reusable knowledge for a Tag. The bundled Worker resolves
`supertag/artifacts@1` selections into artifact summaries in Cursor's prompt; Cursor can retrieve
selected content through admitted artifact tools. This selection applies only to Tasks from a
collaboration surface, not internal Objective Tasks. A Role can also select
`supertag/skill@1` when the Worker Host has a [Skill catalog](../reference/context-resolution.md#skills).
The Worker does not include a general text Context resolver. If a Workspace selects a Skill with
the same name, the Workspace Skill takes precedence.

For colocated local Tasks, SuperTag allows Cursor's read, search, list, and MCP tools.
It adds edit only for `files:write` and shell only for `commands:execute`. It enables
web search only when the Task has `web:search`; subagents remain disabled.
Cursor's [OS sandbox](https://cursor.com/docs/agent/security/run-modes.md) limits writes to the
workspace and temporary files and denies network access as defense in depth. Because of that,
a package manager that must download a pinned version cannot run inside Cursor; it fails
with `ERR_PNPM_META_FETCH_FAIL`. SuperTag does not widen the sandbox; run such checks from
another harness. The Worker refuses
a run if the sandbox is unavailable or a repository or Task Attempt home `.cursor/sandbox.json`
exists. The agent can create that file mid-run and widen later shell decisions. Shell access thus
requires `files:write` and `allow-unsandboxed-commands: [cursor]`; shell-only Permission Sets are
refused. Reads may still reach outside the workspace, and Cursor offers no approval for each tool
call. A private home excludes the operator's Cursor hooks, MCP servers, and rules; Cursor may still
read `AGENTS.md` and `.cursor` files in the workspace.
SuperTag supplies only the Task's admitted tools, as Cursor
[custom tools](https://cursor.com/docs/sdk/typescript.md#custom-tools). The Worker stays their MCP
client. Sandboxed SDK runs reject inline MCP server tools because they cannot ask for approval.

### Cursor with a remote environment

A host service with `environment: e2b` or `environment: { modal: ... }` runs Cursor's SDK on
the Worker Host. Its API key and native Session state stay there; provider keys never enter
the sandbox's files, environment variables, or processes. Install your project's command
dependencies in the sandbox image. It needs `python3` and POSIX shell tools, with no Cursor
executable.

In this split mode, Cursor has no built-in tools. SDK custom tools provide read, write, edit,
glob, grep, ls, and foreground commands in the sandbox, plus the Task's allowed external tools.
Web search, subagents, and background commands are unavailable. A **Permission Set** selects
allowed actions: write and edit require `files:write`; commands require both `commands:execute`
and `files:write`. Remove `allow-unsandboxed-commands` from services with `environment`;
startup refuses it.

`local.cwd` is an empty host directory. Repository rules do not load automatically, so supply
needed instructions as Task context. Cursor's own sandbox provides no useful workspace
protection in split mode; the remote provider enforces the command boundary, and the bridge
checks file paths and permissions. See [Cursor reference](../reference/worker.md#cursor-split-execution).

### Cursor local runtime details

Cursor starts its SDK runner with a private `HOME` and private `XDG_CONFIG_HOME`,
`XDG_DATA_HOME`, and `XDG_CACHE_HOME`. It keeps the Worker's `PATH`, with the Worker's
Node directory first. It does not pass `COREPACK_HOME`, `PNPM_HOME`, or `npm_config_*`
settings into that process. This keeps host configuration and credentials out of the
Task Attempt's environment. If a `pnpm` executable on `PATH` installs the repository's
pinned version into the host's home on demand, a Cursor Task cannot rely on that cache
or a package download: its private home is empty and the sandbox denies network access.
Use a Node version that meets this repository's minimum and a directly runnable pinned
`pnpm` executable available on the Worker Host before assigning a Cursor coding Task.
The SDK's current `local.sandboxOptions` offers an enable switch but no read-path grants
for a package store or Corepack cache. See [SDK sandbox options](https://cursor.com/docs/sdk/typescript.md),
[Cursor run modes](https://cursor.com/docs/agent/security/run-modes.md), and
[SDK release notes](https://cursor.com/docs/release-notes/sdk.md).

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
See [usage reporting](../reference/worker.md#cursor).

### Credentials available during Tasks

When using a file-backed Codex sign-in, a local Codex Worker copies `~/.codex/auth.json`
(or the file under the host's `CODEX_HOME`) into each Task's working area. That copy can contain
a long-lived ChatGPT refresh token; its file permissions are restricted to the OS user.
Local Claude Workers can use that user's secure credential store, including macOS Keychain.
Commands running as the same user may be able to access these credentials.

For shared or unattended Worker Hosts, prefer scoped `CODEX_API_KEY` or `ANTHROPIC_API_KEY`
credentials with appropriate provider limits. `CODEX_API_KEY` takes precedence over copying
the Codex sign-in file; `OPENAI_API_KEY` is only a fallback after the file copy fails.

## Telemetry and network traffic

SuperTag does not send product analytics or usage telemetry to SuperTag maintainers. Its built-in
RPC counters stay in process memory and are exposed through its own operator diagnostics.
Configured integrations still contact their services: the Control Plane, collaboration tools,
MCP servers, storage, execution providers, and model providers. Disabling telemetry does not
stop the model requests needed to perform Tasks. The default implementation is
[process-local RPC counters](../../packages/runtime/sdk/src/rpc-telemetry.ts), connected to
[Control Plane diagnostics](../../apps/cli/src/control-plane-api.ts).

Harnesses have separate policies. SuperTag isolates their configuration for each Task, so their
standalone opt-out instructions do not necessarily apply to managed Workers.

### Codex

The default Worker runs `codex exec`, which sends usage analytics by default. SuperTag gives it
a Task-local `CODEX_HOME` and passes `--ignore-user-config`. Setting `[analytics] enabled = false`
in your personal `config.toml` therefore does not disable analytics for this Worker. SuperTag
does not expose an analytics setting for the managed exec path.

To use the analytics-off default instead, select `--codex-execution-mode app-server` when
connecting a Codex Worklet. See the [Worklet example](../guides/workers.md#optional-limit-reported-tokens).
The bundled app-server disables analytics by default, and SuperTag does not pass its opt-in flag.
App-server also refuses active user or project configuration. OpenTelemetry export is separate
and off by default; SuperTag does not configure an exporter. See
[Codex metrics](https://developers.openai.com/codex/config-advanced/#metrics) and the
[configuration reference](https://developers.openai.com/codex/config-reference/).

### Claude Code

Managed Claude Workers retain Anthropic's default usage statistics and error reporting.
SuperTag passes an allowlisted environment, disables settings sources, and uses a Task-local
configuration directory. It does not forward `DISABLE_TELEMETRY` or `DISABLE_ERROR_REPORTING`,
nor `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DO_NOT_TRACK`. Setting these variables in
your shell or personal Claude settings does not opt managed Workers out.

There is currently no supported telemetry opt-out for managed Claude Workers. SuperTag also
does not forward `CLAUDE_CODE_ENABLE_TELEMETRY`, so it does not opt into OpenTelemetry export.
See Anthropic's [data usage](https://code.claude.com/docs/en/data-usage) and
[monitoring](https://code.claude.com/docs/en/monitoring-usage) policies for the installed version
and account type.

### OpenCode

SuperTag generates the OpenCode configuration and leaves `experimental.openTelemetry` unset,
so optional AI SDK tracing is off. It disables session sharing, automatic updates, and project
configuration, and uses a Task-local home directory. Editing your personal `opencode.json`
does not configure a managed Worker. See [OpenCode configuration](https://opencode.ai/docs/config/);
your selected model provider also has its own data policy.
