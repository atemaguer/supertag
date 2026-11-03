# Devcontainer settings for remote workspaces

A workspace is a repository that a [Task](glossary.md#task) can change on its own branch. A
[Worker Host](glossary.md#worker-host) prepares that
repository for a Task. On E2B or Modal, SuperTag reads a `devcontainer.json` from the repository's
trusted commit to choose the sandbox's tools. Use this when the repository needs a specific image or
setup steps. Local workspaces ignore the file and use the workspace's `setup` command instead.

SuperTag reads `.devcontainer/devcontainer.json` first, then `.devcontainer.json`. The file may use
JSON comments and trailing commas. The [Worker](glossary.md#worker) reads it and any Dockerfile as git objects; it does
not check out or execute repository content on the Worker Host. The first matching file is the whole
definition. SuperTag refuses an unsupported property by name before a provider build begins.

| Property | Remote behavior |
| --- | --- |
| `image` | Selects the registry image. Use this or `build`, not both. |
| `build.dockerfile`, `build.context`, `build.args` | Uses a Dockerfile from the trusted commit. Both providers accept `FROM`, `ARG`, `RUN`, `ENV`, `WORKDIR`, `USER`, `EXPOSE`, `VOLUME`, `CMD`, and `ENTRYPOINT`. They refuse `COPY`, `ADD`, `ONBUILD`, and every other instruction by name. E2B passes the Dockerfile to its SDK through a file in a private build context. |
| `onCreateCommand`, `updateContentCommand`, `postCreateCommand` | Run inside the remote build or setup sandbox, in that order, before workspace `setup`. Each accepts a shell string, an argument list, or an object of named commands. A warm preparation runs only `updateContentCommand` and `setup`. |
| `containerEnv`, `remoteEnv` | Set variables in the prepared environment. Values can refer to `${containerEnv:NAME}` from the file or `${workspaceFolder}`. They cannot read Worker Host variables. Names used for credentials and process controls, such as `ANTHROPIC_*`, `OPENAI_*`, `*_PROXY`, `NODE_OPTIONS`, `PATH`, `GIT_*`, `SUPERTAG_*`, `LD_*`, and `DYLD_*`, are refused by name. |
| `containerUser`, `remoteUser`, `workspaceFolder` | Select the sandbox user and checkout folder where the provider supports them. The selected user runs lifecycle commands and workspace `setup`. `remoteUser` takes precedence when both users are set. When neither is set, the Dockerfile's last `USER` is the selected user, and it must name a literal user or user ID, not an `ARG` reference. The selected user owns the checkout. `workspaceFolder`, when set, must equal the provider's checkout directory (`/workspace/repo` on Modal, `/home/user/workspace` on E2B); any other folder is refused. |
| `postStartCommand`, `postAttachCommand`, `forwardPorts`, `customizations` | Ignored. SuperTag does not start an editor session or forward ports. |

Every other property is refused, including `features`, `dockerComposeFile`, `mounts`, `runArgs`,
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

The Worker runs those commands in the remote preparation sandbox. Each Task starts in a separate
sandbox created from the resulting image or template. See the [workspace guide](../guides/workspaces.md)
for repository and delivery setup.
