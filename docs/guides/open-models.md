# Run SuperTag on open-weight models

A **Tag** is a persistent AI actor with its own identity, responsibilities, permissions, and work
history. Each Tag runs on a coding agent, its *harness*, and a model. Open-weight models run
through the [OpenCode](https://opencode.ai/docs/) harness. This guide sets up a Tag on one, from
the first command or on an existing setup.

## What works today

SuperTag has run real work on these models through OpenCode: answering questions about a
repository, completing an **Objective**, an outcome a Tag owns until it is met, on its own branch,
recalling earlier work, and messaging other Tags.

| Model | OpenCode model ID | Provider |
| --- | --- | --- |
| GLM 5.3 | `opencode-go/glm-5.3` | OpenCode Go, a subscription |
| Kimi K3 | `opencode-go/kimi-k3` | OpenCode Go |
| DeepSeek V4.1 Flash | `opencode/deepseek-v4.1-flash-free` | OpenCode Zen's free copy; no key |

Other models OpenCode lists may work too. SuperTag passes the model ID to OpenCode as written, so
any `provider/model` that `opencode run` accepts can be tried.

## Before you start

You need `supertag`, Node.js, and Git; see [Requirements](../operations/requirements.md). Then:

1. Install OpenCode, so that `opencode` is on your `PATH`.
2. Sign in to the model's provider with an API key:

   ```sh
   opencode auth login
   ```

   Pick the provider entry that matches the model ID's first part. For `opencode-go/...` models,
   choose **OpenCode Go**, not **OpenCode**: the two entries are separate, and a key saved under
   **OpenCode** does not reach `opencode-go` models. OpenCode Zen's free `opencode/...` models need
   no sign-in. SuperTag refuses OAuth sign-ins, so use an API key.
3. Check the entry and the model outside SuperTag:

   ```sh
   opencode auth list
   opencode run -m opencode-go/glm-5.3 "Reply with OK only."
   ```

   `opencode auth list` should show **OpenCode Go** with `api`. If `opencode run` fails here, it
   fails in SuperTag too; see [Troubleshooting](#troubleshooting).

## Start with supertag init

In a Git repository with at least one commit, name the harness and the model:

```sh
cd ~/code/app
supertag init --harness opencode --model opencode-go/glm-5.3
```

Without `--model`, `init` runs `opencode models` and offers a model you can use now. It prefers one
SuperTag has tested, from the table above.

`init` finds the provider's key the way the **Worker Host**, the machine that runs Tasks, will:

1. An API key for the provider in OpenCode's sign-in file, `~/.local/share/opencode/auth.json`.
   `init` reads only which providers the file holds, never a key. It writes the path as the host's
   `opencode-auth-file`. The file must be readable only by you; `init` stops with `chmod 600`
   otherwise.
2. The provider's key variable, such as `DEEPSEEK_API_KEY`, in your environment or
   `~/.supertag/.env`.
3. No key, for OpenCode Zen's `opencode/...` models.

With none of these, `init` stops before writing anything and says to run `opencode auth login`.
Then it runs one short OpenCode turn with that key, and stops with the `opencode run` command to
try when the turn fails.

OpenCode has no sandbox of its own, so `init` asks how the lead may run commands. Choose Docker
containers; see [Run commands in containers](#run-commands-in-containers). With `--yes`, the lead
reads and edits files but runs no commands.

`init` writes `~/.supertag/supertag.yaml` and starts SuperTag. The host service it writes looks
like this, with `environment: local-vm` only when you chose containers. `harnesses` also lists
the other harnesses you are signed in to, after `opencode`:

```yaml
  studio:
    type: host
    harnesses: [opencode]
    models:
      opencode: opencode-go/glm-5.3
    opencode-auth-file: /Users/you/.local/share/opencode/auth.json
    environment: local-vm
    concurrency: 3
    workspaces:
      app: /Users/you/code/app
```

The lead Tag gets `execution: { harness: opencode, models: [opencode-go/glm-5.3] }`. Send it a
message to check the setup:

```sh
supertag message lead "Read this repository and tell me what you would improve first."
```

`init` with `--harness opencode` applies to a new setup only. See
[Start on open-weight models with OpenCode](../operations/cli.md#start-on-open-weight-models-with-opencode)
for every `init` detail.

## Add open models to an existing setup

Edit the host service in `~/.supertag/supertag.yaml`. Add `opencode` to `harnesses`, list its
models, and name OpenCode's sign-in file:

```yaml
  studio:
    type: host
    harnesses: [codex, opencode]
    models:
      opencode: [opencode-go/glm-5.3, opencode-go/kimi-k3]
    opencode-auth-file: ~/.local/share/opencode/auth.json
    environment: local-vm
    workspaces:
      app: ~/code/app
```

| Setting | Meaning |
| --- | --- |
| `harnesses` | Add `opencode` |
| `models.opencode` | One `provider/model`, or a list whose first is the default. A Tag's model must be on the list |
| `opencode-auth-file` | OpenCode's sign-in file, for providers without a key variable. SuperTag stores only the path, and each Task Attempt copies only its provider's entry |

`opencode-auth-file` is not needed for OpenCode Zen's free models, or for the providers whose key
variable SuperTag passes, such as `DEEPSEEK_API_KEY` or `OPENROUTER_API_KEY`; see
[OpenCode sign-in](../reference/supertag-yaml.md#opencode-sign-in). Each Task Attempt reads the file
afresh, so a new `opencode auth login` needs no restart.

Run `supertag up` to apply the file. Then create a Tag on the model with a manifest:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata: { name: kimi }
spec:
  roles: [lead]
  execution: { harness: opencode, models: [opencode-go/kimi-k3] }
  workspace: { id: app, ref: main }
```

```sh
supertag apply -f kimi.yaml
```

A Tag keeps the harness it was created with, so create a new Tag rather than moving a Codex or
Claude Code Tag to OpenCode. OpenCode has no effort option, so it ignores a Tag's `efforts`.

## Run commands in containers

OpenCode has no sandbox that SuperTag can enforce. Without one, an OpenCode Tag's commands run as
you, on this machine. They can read and change your files outside the Tag's checkout, reach the
network, and read the provider's key: SuperTag keeps only `anthropic` and `openai` keys away
from them. When SuperTag refuses an OpenCode file tool outside the checkout, the model can still
run the same read as a shell command.

Run its commands in Docker containers instead. Start Docker and set `environment: local-vm` on the
host:

```yaml
    harnesses: [opencode]
    environment: local-vm
```

Each Task Attempt's checkout then lives in a container with no network and none of your other
files. OpenCode and its key stay on the host. The first Task Attempt builds the container image,
which takes a few minutes. The containers have no network, so `init` gives a lead whose commands
run there no `web:fetch`, and it can't read web pages. See [local-vm containers](../reference/supertag-yaml.md#local-vm-containers).

To let the lead run commands after a setup without them, see
[Let the lead run commands](../operations/cli.md#let-the-lead-run-commands).
`allow-unsandboxed-commands: [opencode]` runs them without a sandbox; use it only for work you
would run yourself.

## One provider per host

An OpenCode host serves one provider: every model on its list uses the default model's provider.
The host picks the key and the provider proxy from that provider. `supertag up` refuses a list
that mixes providers:

```text
OpenCode model opencode/deepseek-v4.1-flash-free uses provider opencode, but this host's default
model opencode-go/glm-5.3 uses opencode-go; an OpenCode host serves one provider. Add another host
service for opencode
```

To serve a second provider from the same machine, add a second host service:

```yaml
services:
  go:
    type: host
    harnesses: [opencode]
    models: { opencode: [opencode-go/glm-5.3, opencode-go/kimi-k3] }
    opencode-auth-file: ~/.local/share/opencode/auth.json
    environment: local-vm
    workspaces: { app: ~/code/app }
  zen:
    type: host
    harnesses: [opencode]
    models: { opencode: [opencode/deepseek-v4.1-flash-free] }
    environment: local-vm
    workspaces: { app: ~/code/app }
```

Both hosts map the same Workspace. Each Tag's Tasks go to the host that lists its model.

## DeepSeek on OpenCode Go needs Global hosting

OpenCode Go serves some models, such as its DeepSeek models, from outside Europe and the United
States. An account limited to those regions can't use them. Turn on **Global** in the OpenCode
Console's privacy settings, under regions. Until then, each Task fails with:

```text
OpenCode execution failed: This OpenCode Go model is hosted outside Europe and the United States.
Select Global at https://opencode.ai/console/.../settings/privacy#regions to use it.
```

OpenCode Zen's free `opencode/deepseek-v4.1-flash-free` is not affected.

## Troubleshooting

When a provider refuses a turn, the Task fails with the provider's reason. Keys and tokens in it
are hidden. The reply shows it, and so do `supertag describe task TASK_ID` and
`supertag logs`.

| Error | Do this |
| --- | --- |
| `This API key has expired. Create a new API key in OpenCode Console...` | Create a key in the OpenCode Console and run `opencode auth login` again, under the right provider entry |
| `This OpenCode Go model is hosted outside Europe and the United States. Select Global...` | Turn on Global hosting; see [DeepSeek on OpenCode Go](#deepseek-on-opencode-go-needs-global-hosting) |
| `Model not found: PROVIDER/MODEL.` | Use the ID exactly as `opencode models` prints it, on the host's list and the Tag |
| `Couldn't check the opencode sign-in... did not finish within 30 seconds` from `init` with an `opencode/...` free model | `init`'s check turn can stall on Zen's free models. Run `init` with your provider's model, then add the free model on a second host; see [One provider per host](#one-provider-per-host) |
| The Task stays queued | `supertag placement explain TASK_ID` names the cause, such as no host listing the Tag's model |

For anything else, try the model outside SuperTag with `opencode run -m PROVIDER/MODEL "Reply with
OK only."`. It shows the provider's full error. See also
[Troubleshoot the first reply](troubleshooting.md).

## Other coding agents

Claude Code and Codex can't run open-weight models in SuperTag yet. Each of their Tasks gets a
private configuration without your own settings, so neither can be pointed at another provider's
endpoint. Use OpenCode for open-weight models.
