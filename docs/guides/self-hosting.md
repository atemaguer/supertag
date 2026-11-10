# Self-host SuperTag

A **Tag** is a persistent AI actor with its own responsibilities and permissions, and Tags work
in Teams: flat lists of member Tags. Together, your Teams of Tags make up an **autonomous organization**: Teams
may pursue different goals but share one set of rules and one record of the work. Run your own
**Control Plane** (the service that stores and coordinates the organization) with PostgreSQL, and
connect **Worker Hosts** (machines that provide execution capacity) to it. Each Worker Host runs a
**Worklet**, the supervisor that connects outbound to the Control Plane, and **Workers** that
complete accepted assignments (**Tasks**), optionally through a **harness** such as Codex or Claude
Code. The main path below uses Docker Compose on a server you operate; see the
[glossary](../reference/glossary.md) for other terms.

```text
Slack / GitHub / Lark / Linear / Teams
                |
  persistent Control Plane + PostgreSQL
                ^
                | authenticated outbound connection
                |
      Worker Host
        - Worklet
        - Workers
        - Codex, Claude Code, or custom harnesses
        - local or remote execution environments
```

This keeps collaboration credentials with the Control Plane and execution credentials inside each
Worker Host boundary. The Worklet only supervises the host and maintains its connection to the
Control Plane. The Control Plane's **API Server** (which handles management requests and Worklet
connections) and **Gateway** (which carries collaboration surface traffic) are parts of one process; see
[How SuperTag fits together](../concepts/how-it-works.md).

## Before you start

- Docker with Compose and a checkout of this repository. The checkout provides the Compose
  deployment; the CLI manages the running Control Plane from your machine.
- Credentials for at least one [collaboration surface](../surfaces/README.md): an external work
  tool, such as Slack or GitHub, where SuperTag meets people.
- The SuperTag CLI and the [required system tools](../operations/requirements.md).
  [Install SuperTag from npm](../operations/install.md).

## 1. Choose a deployment

All supported options run the same Control Plane image, and every option accepts the same outbound
Worklet connection. Railway, Render, Fly.io, Modal, and Cloudflare share the
[deployment setup and verification workflow](deployment-setup.md).

| Option | Best for | PostgreSQL | Collaboration surface secret storage | Configured by |
| --- | --- | --- | --- | --- |
| Docker Compose | A server you operate | bundled container | named volume | `compose.yaml` and `.env`; `supertag.yaml` optional |
| [Railway](deploy-railway.md) | Fast hosted Control Plane setup | Railway PostgreSQL service | Railway volume | Platform config and environment; `supertag.yaml` optional |
| [Render](deploy-render.md) | Blueprint-based hosted setup | Render Postgres | Render persistent disk | Platform config and environment; `supertag.yaml` optional |
| [Fly.io](deploy-fly.md) | Choosing the region and managing storage directly | Fly Managed Postgres or another provider | Fly volume | Platform config and environment; `supertag.yaml` optional |
| [Modal](deploy-modal.md) | An always-on Modal Server with external storage | external PostgreSQL | external HashiCorp Vault KV v2 | Platform config and environment; `supertag.yaml` optional |
| [Cloudflare](deploy-cloudflare.md) | Container hosting with Cloudflare ingress | external PostgreSQL | external HashiCorp Vault KV v2 | Platform config and environment; `supertag.yaml` optional |
| [Native service](#native-single-host-alternative) | A server without containers, kept running by systemd or launchd | external PostgreSQL | host filesystem | `supertag.yaml` |

Every option starts the Control Plane with `supertag up`. It reads
[`supertag.yaml`](../reference/supertag-yaml.md) when one is present, and environment variables
override the file. Containers and hosting platforms keep using environment variables, so their file
is optional; see [In containers and hosting platforms](../reference/supertag-yaml.md#in-containers-and-hosting-platforms).

Production deployments require PostgreSQL, an HTTPS address for the Control Plane, a strong
administrative token, per-Worker-Host enrollment credentials, and durable credential storage. By
default, a persistent volume at `SUPERTAG_STATE_DIR` preserves credentials; Cloudflare uses external
Vault instead. PostgreSQL preserves **Tags** (persistent AI actors with their own
responsibilities and permissions), **Sessions** (groups of Tasks from one conversation), Tasks,
delivery state, and the catalog of artifacts, the output files that Tasks capture. The Control Plane
stores no artifact bytes: Worker Hosts keep them.

Railway and Render currently run a single Control Plane instance because the file-backed collaboration surface
secret store is attached to one service volume. Moving collaboration surface secrets to an external secret store
is required before horizontal Control Plane scaling is safe.

The rest of this guide uses Docker Compose. If you already run SuperTag locally, read
[Moving from a local setup](#moving-from-a-local-setup) first.

## 2. Create the environment file

The Compose file is `deploy/compose.yaml`; commands below run from the repository root and read
the root `.env` explicitly. Its project name is `supertag`. If you previously used a custom project
name, preserve it with `COMPOSE_PROJECT_NAME` or `-p` to keep using your existing volumes.

```sh
cp deploy/.env.example .env
openssl rand -hex 24  # use as SUPERTAG_POSTGRES_PASSWORD
openssl rand -hex 32  # use as SUPERTAG_ADMIN_TOKEN
chmod 600 .env
```

Put both generated values in `.env`. Keep `SUPERTAG_GATEWAY_BIND=127.0.0.1` while the Control Plane
and Worklet are on the same machine. This variable binds the Control Plane's embedded network
Gateway. Enroll each Worker Host after the Control Plane starts.

## 3. Build and initialize

```sh
docker compose --env-file .env -f deploy/compose.yaml build
docker compose --env-file .env -f deploy/compose.yaml up -d postgres
docker compose --env-file .env -f deploy/compose.yaml run --rm migrate
```

The migration is explicit and safe to run again on a new database. Upgrades may require a
zero-traffic maintenance window; follow the [Control Plane upgrade procedure](../operations/control-plane.md#upgrade-a-compose-deployment)
instead of applying an upgrade while the Control Plane is running. PostgreSQL data lives in the
`supertag-postgres` volume; Control Plane collaboration surface secrets live separately in `supertag-state`.

## 4. Start and connect to the Control Plane

```sh
docker compose --env-file .env -f deploy/compose.yaml up -d control-plane

set -a
. ./.env
set +a

supertag connect control-plane http://127.0.0.1:3434
supertag status control-plane
```

From here on, your local CLI controls the deployed Control Plane, the way `kubectl` controls a
Kubernetes cluster. `supertag connect control-plane` saves the connection and makes it current, so
every later command, such as `supertag apply`, `supertag get`, or `supertag watch`, runs against
the deployment. You never run commands inside the container. If you manage several deployments,
name each connection with `--name` and switch with `supertag use control-plane NAME`, much like
switching `kubectl` contexts; see
[Connect the CLI](../operations/control-plane.md#connect-the-cli).

The admin token is saved in the local credential store under `~/.supertag`. Teammates use their
own **Operator Tokens**, named credentials the admin token's holder issues to one teammate or
machine; see [Add teammates](#add-teammates). The Control
Plane connection becomes active, so subsequent management commands use it automatically. A Worklet
with no explicit `--control-plane` uses that connection's URL for its Worklet API connection.

`/healthz` reports process liveness. `/readyz` remains unavailable until a compatible Worklet
connects; this is expected in remote Worklet mode.

The `control-plane` container runs `supertag up --foreground control-plane`. Its environment, set
in `deploy/compose.yaml` and `.env`, stays the main configuration. To keep settings such as
`notify` or `logging` in a `supertag.yaml` as well, mount the file into the state directory. Add a
line to the `control-plane` service's `volumes` in `deploy/compose.yaml`; the path is relative to
`deploy/`:

```yaml
    volumes:
      - supertag-state:/var/lib/supertag
      - ../supertag.yaml:/var/lib/supertag/supertag.yaml:ro
```

Environment variables override the file. Leave `ports` out of it: the container listens on
`0.0.0.0:3434`, which the port mapping and health check expect. See
[In containers and hosting platforms](../reference/supertag-yaml.md#in-containers-and-hosting-platforms)
for the keys that behave differently in a container.

## 5. Declare a collaboration surface and Tag

Describe the organization in manifests and apply them from your local CLI, as you would with
`kubectl apply`. Keep the files in your repository so changes get reviewed. This `org.yaml`
connects Slack and adds a Tag that answers in one channel:

```yaml
apiVersion: supertag/v1
kind: SurfaceAccount
metadata:
  name: acme-slack
spec:
  provider: slack
  configuration:
    transport: socket
  secrets:
    botToken: { env: SLACK_BOT_TOKEN }
    appToken: { env: SLACK_APP_TOKEN }
---
apiVersion: supertag/v1
kind: Tag
metadata:
  name: engineering
spec:
  locations:
    - provider: slack
      channelId: C0123456789
```

A manifest never holds a secret value. Each entry under `secrets` names where your local CLI reads
it, here two environment variables. Create the Slack app as the
[Slack guide](../surfaces/slack.md) describes, set the variables, then apply:

```sh
supertag diff -f org.yaml
supertag apply -f org.yaml
```

`supertag apply` checks the tokens with Slack before it stores anything, then sends them to the
Control Plane's credential vault over its authenticated API. Apply again after you edit the file;
unchanged resources are left alone. For GitHub, Lark, Linear, or Microsoft Teams, use that
provider's `SurfaceAccount` secrets and location key from its
[collaboration surface guide](../surfaces/README.md#declare-a-surface-account-in-a-manifest). See
[Manage resources](../operations/resources.md) for the full manifest format, including Roles,
Permission Sets, and `--prune`.

For a quick first try, `supertag setup surface slack` walks through the same Slack setup
interactively, and `supertag create tag` with
`supertag update tag engineering --add-location slack --channel-id C0123456789` adds the Tag.
These commands also run from your local CLI against the deployment.

The default local vault writes collaboration surface credentials to the state volume; an external
vault may store them elsewhere. Relational records retain only stable logical credential IDs.

## 6. Create an Auth Key for the Tag

Each Worker Host needs its own credential. A Tag with no bound Worker Host rejects Tasks. From the
machine where you ran `supertag connect control-plane`, create an
[Auth Key](../reference/resource-model.md#auth-keys) for the Tag. The host that joins with it gets
its own credential and is bound to the Tag:

```sh
supertag create auth-key laptop --tag engineering
```

The command prints a `stak_` secret once. The key joins one host within an hour. Keep the secret
out of chat and version control.

For a fleet of hosts that come and go, such as CI runners, autoscaled machines, or cloud
sandboxes, create one reusable, ephemeral key instead and store its secret in your platform's
secret manager:

```sh
supertag create auth-key fleet --tag engineering --reusable --ephemeral --label linux
```

Every host that starts with the secret in `SUPERTAG_AUTH_KEY` joins on its own, gets the
`linux` label, and is bound to the Tag. Ephemeral hosts are removed after they disconnect, so
stopped machines don't pile up. A reusable key expires after 90 days: create a new key under a new
name, update the platform secret, then revoke the old key with `supertag revoke auth-key fleet`.
Hosts that already joined keep working. See [Auth Keys](../reference/resource-model.md#auth-keys).

## 7. Connect a Worklet from the Worker Host

On the Worker Host that owns the codebase and harness authentication,
[install SuperTag from npm](../operations/install.md) at the same version as the Control Plane, and check that
`supertag version` reports a supported pair.

Set the key's secret in the environment. The Worklet redeems it on its first connection, joins as
Worker Host `laptop`, and stores the host's credential under `~/.supertag/worker-hosts/`. Later
runs use that credential and need no key. The Worker Host needs only the key, not the
administrative token.

```sh
export SUPERTAG_AUTH_KEY=stak_...
```

**Same host as Compose.** The active Control Plane connection from step 4 supplies the address:

```sh
supertag connect worklet --transport websocket \
  --worker-host laptop \
  --harness codex \
  --workspace /absolute/path/to/codebase \
  --worker-profile local-codex
```

**Another machine.** First put the Control Plane behind an HTTPS reverse proxy, as described in
[Put the Control Plane on another host](#put-the-control-plane-on-another-host). This host has no
saved Control Plane connection, so name the proxy URL:

```sh
supertag connect worklet --transport websocket \
  --worklet-url https://YOUR-PROXY \
  --worker-host laptop \
  --harness codex \
  --workspace /absolute/path/to/codebase \
  --worker-profile local-codex
```

Run the Worklet under a process supervisor if its Worker Host is always on. For Claude Code, use
`--harness claude-code --worker-profile local-claude-code`.

Use `supertag connect control-plane URL --name NAME` only when this machine manages multiple Control
Planes. Switch with `supertag use control-plane NAME`; `--control-plane NAME` remains a one-command
override.

## Check that it worked

Check readiness on the same host as Compose:

```sh
curl --fail http://127.0.0.1:3434/readyz
```

or, from another machine, through the proxy:

```sh
curl --fail https://YOUR-PROXY/readyz
```

Then mention the Tag on the collaboration surface you configured in step 5 and confirm that a
Worker replies.

## Put the Control Plane on another host

The Worklet connection is outbound, so the Control Plane listener needs a reachable address.

1. Put an HTTPS reverse proxy in front of port 3434. TLS is mandatory outside loopback deployments.
   Keep the raw HTTP/WebSocket port off the public internet.
2. Set `SUPERTAG_GATEWAY_BIND=0.0.0.0` only when a firewall or reverse proxy restricts access.
3. Route the Gateway webhook paths your collaboration surfaces need through the proxy. Socket Mode Slack and
   Lark long connections do not require public webhook ingress. HTTP Slack, GitHub webhooks,
   Linear, and Teams require the relevant Gateway webhook path to be reachable. See the
   surface-specific guide before exposing a route.
4. Connect the Worklet to that `https://` Control Plane URL with `--transport websocket`; the CLI
   converts it to `wss://` and uses the Worklet API path automatically.

Check that it worked: `curl --fail https://YOUR-PROXY/readyz` succeeds after the Worklet connects.

## Native single-host alternative

Operators who do not want Docker can run the installed CLI directly on a server. `supertag up`
reads [`supertag.yaml`](../reference/supertag-yaml.md) and, with `restart: unless-stopped`, installs
a systemd user unit on Linux or a LaunchAgent on macOS that keeps the Control Plane running.
PostgreSQL remains the recommended database even on a single host.

Run these steps as the account that should own the Control Plane, such as a dedicated `supertag`
user. Its state lives in `~/.supertag/`. Write `~/.supertag/supertag.yaml`:

```yaml
name: acme
services:
  control-plane:
    type: control-plane
    url: https://supertag.example.com
    ports: ["127.0.0.1:3434"]
    restart: unless-stopped
    database:
      url: postgresql://supertag@${SUPERTAG_DB_HOST:-127.0.0.1}:5432/supertag
      password: db-password
    provision:
      - ~/supertag/org.yaml
secrets:
  db-password: { file: ~/.supertag/db-password }
```

The database password stays out of the file: `secrets:` reads it from `~/.supertag/db-password`
when the Control Plane starts. `${VAR}` takes a value from the environment, with a default after
`:-`. `provision` is optional; it creates the Tags, Surface Accounts, and other resources its
manifests list when they are missing, and never changes ones that exist.

The admin token comes from the environment. A service unit does not inherit your shell's
environment, so put the token in `~/.supertag/.env`, which the unit reads. Load the same file into
your shell, so `supertag up` and later commands use the token too:

```sh
umask 077
printf '%s\n' 'replace-with-the-database-password' > ~/.supertag/db-password
printf 'SUPERTAG_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" >> ~/.supertag/.env
set -a; . ~/.supertag/.env; set +a
supertag config   # prints the resolved file, or every problem in it
supertag up
```

`supertag up` applies pending database migrations as the Control Plane starts, waits for it to
answer `/healthz`, and applies `provision`. On Linux, run `loginctl enable-linger $USER` once so the unit keeps running
after you log out. `supertag ps` shows the service, `supertag logs -f control-plane` follows its
log, and `supertag down` stops it. Run `supertag up` again after you edit the file; it restarts the
Control Plane only when its settings changed.

Put an HTTPS reverse proxy in front of port 3434, as in
[Put the Control Plane on another host](#put-the-control-plane-on-another-host), and use its
address as `url`. On the server, commands such as `supertag setup surface` reach the local
Control Plane with the token loaded from `~/.supertag/.env`. From another machine, run
`supertag connect control-plane https://supertag.example.com` and paste the admin token. SQLite
remains useful for local development and evaluation, but it is not the recommended production
store.

Check that it worked: `supertag ps` shows `control-plane` running, `curl --fail
http://127.0.0.1:3434/healthz` succeeds, and `/readyz` succeeds after a Worklet connects.

## Add teammates

Once the Control Plane runs, teammates can manage it and add their own computers as Worker Hosts.
Keep the admin token to yourself. Each teammate gets two separate secrets:

| Secret | Lets them | Create it with |
| --- | --- | --- |
| [Operator Token](../reference/resource-model.md#operator-tokens) | Run `supertag` commands against the shared Control Plane, recorded under the token's name | `supertag create operator-token NAME` |
| [Auth Key](../reference/resource-model.md#auth-keys) | Join their computer as a Worker Host for the key's Tags | `supertag create auth-key NAME --tag TAG` |

A teammate who only directs work needs the Operator Token. A teammate who only lends a computer
needs the Auth Key.

**1. Create the secrets.** On your machine, connected with the admin token:

```sh
supertag create operator-token laptop-2
supertag create auth-key laptop-2 --tag engineering
```

Each command prints its secret once. Send both to the teammate over a private channel. The Auth Key
joins one computer within an hour; the Operator Token lasts 90 days.

**2. The teammate connects.** The teammate saves the Operator Token and pastes it at the masked
prompt:

```sh
supertag connect control-plane https://YOUR-PROXY
```

Then they save the Auth Key to a file, such as `~/laptop-2.key`, and add a **host service**, a
`host` entry that connects their machine as a Worker Host, to `~/.supertag/supertag.yaml`. It names the shared Control Plane, the harnesses their computer
serves, and their checkout of each Workspace:

```yaml
services:
  laptop-2:
    type: host
    control-plane: https://YOUR-PROXY
    auth-key: laptop-2-key
    harnesses: [codex]
    workspaces:
      app: ~/code/app
secrets:
  laptop-2-key: { file: ~/laptop-2.key }
```

```sh
supertag up
rm ~/laptop-2.key
```

The computer joins as a Worker Host for the key's Tags and keeps running in the background. It
connects over WebSocket at the URL, so the Control Plane needs no separate gRPC listener. Its
credential is saved in `~/.supertag/hosts/laptop-2/`, so later runs of `supertag up` bring back the
same host and ignore the key. `restart: unless-stopped` keeps it running after restarts,
`supertag ps` shows whether it is connected, `supertag logs -f laptop-2` shows its log, and
`supertag down` stops it. List several harnesses to serve them from one host.

Changes to the Control Plane's resources stay explicit: someone with an Operator Token writes
manifests and runs `supertag apply -f`. To end a teammate's access, revoke the token and their
host. The host's ID is its service name, such as `laptop-2`; `supertag list worker-host` shows it
beside the Auth Key it joined with.

```sh
supertag revoke operator-token laptop-2
supertag revoke worker-host-credential HOST_ID
```

Check that it worked: `supertag list operator-token` shows `laptop-2` with a recent
`lastUsedAt`, and `supertag list worker-host` shows the teammate's computer connected.

## Manage your organization from CI

Keep `org.yaml`, or a directory of manifests, in a repository, and let CI apply it. Changing the
organization then works like any other change: open a pull request, review the diff, and merge.

Give CI its own [Operator Token](#add-teammates), so its changes are recorded under its name and
you can revoke it without affecting anyone else:

```sh
supertag create operator-token ci
```

Store the `stop_` secret as a CI secret. In the CI job, set `SUPERTAG_CONTROL_PLANE` to the
Control Plane's URL and `SUPERTAG_OPERATOR_TOKEN` to the secret, install the CLI as
[Install SuperTag](../operations/install.md) describes, and run:

```sh
# On each pull request: show what would change
supertag diff -f org/ --set org --prune

# After merging: apply it
supertag apply -f org/ --set org --prune
```

`--set org` names the resources these manifests own. With `--prune`, apply deletes a resource in
that set once you remove it from the files, and it never touches resources created another way.
The Surface Account secrets that the manifests reference come from the CI job's environment, so
store them as CI secrets too. An Operator Token expires after 90 days; create a new one and update
the CI secret before then. See [Manage resources](../operations/resources.md) for apply sets and
how apply shares fields with CLI changes.

## Moving from a local setup

A local Control Plane keeps its state in SQLite under `~/.supertag`. SuperTag has no command that
copies that state into PostgreSQL.

1. Stop the local Control Plane and Worker Host with `supertag down` before starting the hosted
   Control Plane, so only one Control Plane uses the same collaboration surface app.
2. Repeat collaboration surface setup against the hosted Control Plane, and apply your Tag and Workspace
   manifests there with `supertag apply -f`.
3. Join your computer as in [Add teammates](#add-teammates): in `~/.supertag/supertag.yaml`,
   remove the `control-plane` service and point the host service's `control-plane` at the hosted
   Control Plane's URL, with an `auth-key` secret. Then run `supertag down` and `supertag up`.

Check that it worked: `supertag status control-plane` reports the hosted Control Plane, and a
mention receives a reply from it.

## If something goes wrong

- **`/readyz` returns unavailable.** This is expected until a compatible Worklet connects. See
  [Health and readiness](../operations/control-plane.md#health-and-readiness).
- **A mention gets no reply.** Work through [Troubleshoot the first reply](troubleshooting.md).

## Next

- [Control Plane operations](../operations/control-plane.md) for health semantics, backups,
  recovery, upgrades, shutdown behavior, and secret boundaries.
- [Run a Worker](workers.md) for Worker-specific credentials and hosted MCP configuration.
- [collaboration surface guides](../surfaces/README.md)
