# Devcontainer settings for remote workspaces

A workspace is a repository that a [Task](glossary.md#task) can change on its own branch. A
[Worker Host](glossary.md#worker-host)'s [Worklet](glossary.md#worklet) prepares that
repository for a Task. When a Worklet keeps Cursor Tasks' checkouts in an E2B or Modal sandbox,
SuperTag reads a `devcontainer.json` from the Task's base commit to choose the sandbox's image and
setup. Use this when the repository needs a specific image or setup steps. Local workspaces ignore
the file and use the workspace's `setup` command instead; a remote workspace cannot use `setup`.

SuperTag reads `.devcontainer/devcontainer.json` first, then `.devcontainer.json`. The file may use
JSON comments and trailing commas. The Worklet reads it and any Dockerfile as git objects; it
does not check out or execute repository content on the Worker Host. The first matching file is the whole
definition. SuperTag refuses an unsupported property by name before a provider build begins.

| Property | Remote behavior |
| --- | --- |
| `image` | Selects the registry image. Use this or `build`, not both. |
| `build.dockerfile`, `build.context`, `build.args` | Uses a Dockerfile from the trusted commit. Both providers accept `FROM`, `ARG`, `RUN`, `ENV`, `WORKDIR`, `USER`, `EXPOSE`, `VOLUME`, `CMD`, and `ENTRYPOINT`. They refuse `COPY`, `ADD`, `ONBUILD`, and every other instruction by name. The Dockerfile has one stage, whose `FROM` names a registry image. |
| `onCreateCommand`, `updateContentCommand`, `postCreateCommand` | Run in the checkout inside the remote preparation sandbox, in that order. Each accepts a shell string, an argument list, or an object of named commands. A warm preparation runs only `updateContentCommand`. |
| `containerEnv`, `remoteEnv` | Set variables in the prepared environment. Values can refer to `${containerEnv:NAME}` from the file or `${workspaceFolder}`. They cannot read Worker Host variables. Names used for credentials and process controls, such as `ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_*`, `CODEX_*`, `E2B_*`, `MODAL_*`, `AWS_*`, `*_PROXY`, `NODE_OPTIONS`, `PATH`, `GIT_*`, `SUPERTAG_*`, `LD_*`, and `DYLD_*`, are refused by name. |
| `containerUser`, `remoteUser` | Select the sandbox user. The selected user runs lifecycle commands and owns the checkout. `remoteUser` takes precedence when both users are set. When neither is set, the Dockerfile's last `USER` is the selected user, and it must name a literal user or `user:group`, not an `ARG` reference. |
| `postStartCommand`, `postAttachCommand`, `forwardPorts`, `customizations` | Ignored. SuperTag does not start an editor session or forward ports. |

`workspaceFolder` is refused: the provider chooses the checkout path, which `${workspaceFolder}`
names. Every other property is refused, including `features`, `dockerComposeFile`, `mounts`, `runArgs`,
`privileged`, and `capAdd`. `initializeCommand` is refused because devcontainer tools run it on the
host. `${localEnv:...}` is refused in supported values. Provider credentials stay on the Worker Host;
the repository can provide only literal values or references to its own container variables.

For example, a repository can put this at `.devcontainer/devcontainer.json`:

```json
{
  "image": "node:22",
  "onCreateCommand": "npm ci",
  "updateContentCommand": ["npm", "run", "build"]
}
```

The Worklet runs those commands in a remote preparation sandbox and saves the result. Each Task
starts in a separate sandbox created from that prepared result, or from the image alone when the file
has no lifecycle commands. See the [workspace guide](../guides/workspaces.md)
for repository and delivery setup.
