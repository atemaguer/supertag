# Run a Worker Host on a persistent machine

A **Worker Host** is a machine that runs Tasks for Tags, the persistent AI actors with their own
identities, responsibilities, permissions, and work histories. This guide turns a Linux server you
already have into one that stays on: an EC2, GCE, Azure, or Hetzner VM, or bare metal. It connects
to a shared **Control Plane**, the service that stores your organization and schedules its work,
such as one you deployed with [Self-host SuperTag](self-hosting.md).

The harness and its keys stay on the machine. Commands run in a sandbox on the same machine, as on
your laptop. The disk keeps checkouts, dependency caches, and each harness's memory between
Tasks, so a Tag doesn't start cold every time.

## What the machine needs

| Requirement | Why |
| --- | --- |
| Linux, x86_64 or arm64 | `supertag` and the harness CLIs run natively |
| A disk that survives a stop and a restart | Checkouts, caches, and harness memory live there |
| Outbound HTTPS to the Control Plane | The host connects out; it needs no inbound port |
| bubblewrap, socat, and unprivileged user namespaces | Codex's and Claude Code's own sandboxes |
| Docker, for Cursor and OpenCode | Their commands run in [local-vm containers](../reference/supertag-yaml.md#local-vm-containers) |
| systemd | Starts the host again after a failure or a reboot |

## 1. Prepare the machine

On Ubuntu or Debian, as the user that will run the host:

```sh
sudo apt-get install -y git curl bubblewrap socat
curl -fsSL https://github.com/atemaguer/supertag/releases/latest/download/install.sh | sh
```

Install [Node.js](../operations/requirements.md) for Claude Code, Cursor, and OpenCode, then the harnesses you
use, such as `npm install -g @anthropic-ai/claude-code @openai/codex`. For Cursor or OpenCode,
also install Docker and add this user to the `docker` group.

Use a dedicated user for the host. Its commands run with that user's files, so keep other
credentials off its home.

## 2. Sign in the harnesses

Sign each harness in as this user, then check it:

```sh
codex -c 'cli_auth_credentials_store="file"' login
supertag sign-in codex
```

A service doesn't see your shell's environment. Put API keys in `~/.supertag/.env` instead
of exporting them; `supertag sign-in` says which file each harness reads.

## 3. Enroll the host

Ask an operator of the Control Plane for a host **Auth Key**, a short-lived secret that enrolls
one machine:

```sh
supertag auth-key create build-1 --role host --tag lead --gateway team
```

Save it to a private file on the machine, such as `~/build-1.key`. Then create a private state
directory with `mkdir -m 700 ~/.supertag` and write `~/.supertag/supertag.yaml`:

```yaml
services:
  build-1:
    type: host
    control-plane: https://supertag.example.com
    auth-key: build-1-key
    harnesses: [codex, claude-code]
    sandbox-commands: [claude-code]
    workspaces:
      app: ~/code/app
    concurrency: 2
    restart: unless-stopped
secrets:
  build-1-key: { file: ~/build-1.key }
```

`workspaces` maps each Workspace name to a Git repository on this machine. Add
`environment: local-vm` to run Cursor and OpenCode Tasks in containers. See
[Run Worker Hosts](workers.md) for every option.

## 4. Start it as a service

When the Control Plane's certificate comes from your own CA, export the CA first.
`supertag up` copies the variable into the service it installs:

```sh
export SUPERTAG_SERVER_CA_FILE=~/ca.pem
supertag up
rm ~/build-1.key
loginctl enable-linger $USER
```

`restart: unless-stopped` makes `supertag up` install a systemd user service. Lingering keeps it
running while you are logged out and starts it at boot. The first start enrolls the host and keeps
its credential in `~/.supertag`, so the key file is no longer needed.

## 5. Check that it worked

```sh
supertag ps
```

On your own machine, `supertag get hosts --gateway team` shows the host as `ready`, with its
harnesses and Workspaces. Restart the machine once and check that the host comes back `ready`
without you logging in.

## Several Tags on one machine

One machine can run many Tags' Tasks. Codex's and Claude Code's sandboxes keep a Task's commands
away from the harness's keys, the host's credential, the CLI's saved Gateways, and the other files
in the host's state directory, such as other Tasks' checkouts. That is a deny list, not a wall:

- Cursor and OpenCode Tasks get it only with `environment: local-vm`.
- The harness itself, as opposed to the commands it runs, reads anything this user can.

So share a machine only between Tags you trust alike, such as one team's Tags. Give each trust
group its own machine, enrolled with an Auth Key that names only that group's Tags:

```sh
supertag auth-key create reviewers --role host --reusable --tag reviewer --tag security-reviewer --gateway team
```

A host enrolled with that key runs only those Tags' Tasks. Separate Unix users on one machine work
too: each runs its own host service from its own state directory, under its own key.

## If something goes wrong

- **`supertag up` reports an unknown issuer.** Export `SUPERTAG_SERVER_CA_FILE` and run
  `supertag up` again, so the service gets it.
- **The host is gone after a reboot.** Run `loginctl enable-linger $USER`.
- **Tasks wait.** Run `supertag placement explain TASK_ID --gateway team` on your own machine.

## Next

- [Run Worker Hosts](workers.md) for harnesses, models, labels, and draining a host
- [supertag.yaml and local state](../reference/supertag-yaml.md)
