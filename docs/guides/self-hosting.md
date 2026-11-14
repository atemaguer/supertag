# Self-host SuperTag

A **Tag** is a persistent AI actor with its own responsibilities and permissions, and Tags work
in Teams. Run your own **Control Plane**, the service that stores your organization and schedules
work, and connect **Worker Hosts**, the machines that run the work. Add a **Gateway** when Tags
should answer on a collaboration surface such as Slack or GitHub. See the
[glossary](../reference/glossary.md) for other terms.

```text
Slack / GitHub / Lark / Linear / Teams
                |
             Gateway  (optional; a client of the Control Plane)
                |
  Control Plane + PostgreSQL   <-- your CLI, terminal UI, and desktop app
                ^
                | outbound connection
                |
           Worker Hosts
             - Codex, Claude Code, Cursor, OpenCode, or a custom harness
```

The Control Plane is the one public endpoint. Operators, Worker Hosts, and Gateways each connect to
it with their own credential. Only the Control Plane holds the database credential, and only the
Gateway holds collaboration surface credentials.

## Before you start

- SuperTag [installed](../operations/install.md) on your machine and on each Worker Host.
- PostgreSQL for a shared deployment. Docker Compose can run it for you.
- A TLS certificate for the Control Plane's public name.
- For a collaboration surface, its app credentials; see the
  [collaboration surface guides](../surfaces/README.md).

## 1. Choose a deployment

| Option | Best for | Definitions |
| --- | --- | --- |
| Docker Compose | A server you operate | [`deploy/compose.native.yaml`](../../deploy/compose.native.yaml) |
| Fly.io | Choosing the region and managing storage directly | [`deploy/native/fly`](../../deploy/native/README.md#flyio) |
| Railway | Fast hosted setup | [`deploy/native/railway`](../../deploy/native/README.md#railway) |
| [Render](deploy-render.md) | Blueprint-based hosted setup | [`deploy/render/render.yaml`](../../deploy/render/render.yaml) |
| [Modal](deploy-modal.md) | An always-on Modal container | [`deploy/modal/app.py`](../../deploy/modal/app.py) |
| [Cloudflare](deploy-cloudflare.md) | A Container behind a Cloudflare Worker | [`deploy/cloudflare`](../../deploy/cloudflare/README.md) |
| [Native service](#native-single-host-alternative) | A server without containers, kept running by systemd or launchd | `supertag.yaml` |

Render, Modal, and Cloudflare forward only HTTP, so clients reach their Control Plane through a
`wss://` URL. The [deployment definitions](../../deploy/native/README.md) explain each platform,
the TLS files, and the roles in detail.

## 2. Write the deployment's settings

Write private per-role environment files, then check them without connecting:

```sh
export SUPERTAG_DATABASE_URL='postgresql://...'   # not needed for Compose
supertag setup deployment fly --output supertag-deployment
supertag check deployment fly --directory supertag-deployment
```

Use `compose`, `railway`, `render`, `modal`, or `cloudflare` in place of `fly`. Setup writes a new
directory and never replaces one. `control-plane.env` is for the Control Plane, `gateway.env` for
the Gateway, and `operator.env` holds the operator token for your machine. Upload each file
through your platform's secret controls.

## 3. Deploy and verify

Deploy with your platform's definitions. For Docker Compose, follow
[Docker Compose](../../deploy/native/README.md#docker-compose). Then check the running deployment
from your machine:

```sh
supertag verify deployment https://supertag.example.com \
  --env-file supertag-deployment/operator.env --require-ready
```

It checks health, that the Control Plane refuses anonymous and invalid credentials, and that the
operator token works. `--require-ready` also requires a ready Worker Host, so run it again after
step 5.

## 4. Connect your CLI

Save the Control Plane under a name. The command reads the operator token from
`SUPERTAG_OPERATOR_TOKEN`, or prompts for it:

```sh
supertag connect --name acme https://supertag.example.com
```

Add `--server-ca-file ca.pem` when a private certificate authority signed the Control Plane's
certificate. Later commands take `--control-plane acme`, and the terminal UI and desktop app list
the saved Control Plane.

Describe Tags, Roles, and Surface Accounts in manifests and apply them:

```sh
supertag diff --control-plane acme -f org.yaml
supertag apply --control-plane acme -f org.yaml
```

See [Manage resources](../operations/resources.md) for the manifest format.

## 5. Connect a Worker Host

Create an Auth Key for the host. A host key's Tags are the Tags that host may run:

```sh
supertag auth-key create --control-plane acme --role host --tag engineering laptop
```

The command prints a `stak_` secret once. Keep it out of chat and version control. On the Worker
Host, enroll with the key, then run the host:

```sh
export SUPERTAG_AUTH_KEY=stak_...
supertag host enroll --control-plane https://supertag.example.com \
  --state-directory ~/.supertag-host laptop
supertag worker-host --control-plane https://supertag.example.com \
  --state-directory ~/.supertag-host --harness codex
```

Enrollment saves the host's own credential in the state directory, so later runs need no key.
For hosts that come and go, such as CI runners or autoscaled machines, create one key with
`--reusable --ephemeral` and store its secret in your platform's secret manager. Ephemeral hosts
are removed after they go offline.

Check that it worked: `supertag get hosts --control-plane acme` shows `laptop`, and
`supertag verify deployment` with `--require-ready` succeeds.

## Native single-host alternative

Operators who do not want containers can run the installed CLI directly on a server.
`supertag up` reads `~/.supertag/supertag.yaml` and, with `restart: unless-stopped`, installs a
systemd user unit on Linux or a LaunchAgent on macOS that keeps the Control Plane running:

```yaml
name: acme
services:
  control-plane:
    type: control-plane
    url: https://supertag.example.com
    ports: ["127.0.0.1:3434"]
    restart: unless-stopped
    database:
      url: postgresql://supertag@127.0.0.1:5432/supertag
      password: db-password
secrets:
  db-password: { file: ~/.supertag/db-password }
```

```sh
supertag config   # prints the resolved file, or every problem in it
supertag up
```

On Linux, run `loginctl enable-linger $USER` once so the unit keeps running after you log out.
`supertag ps` shows the service, `supertag logs` prints its log, and `supertag down` stops it. See
[supertag.yaml](../reference/supertag-yaml.md) for every key.

## Add teammates

Keep the admin operator token to yourself. Each teammate gets their own secrets:

| Secret | Lets them | Create it with |
| --- | --- | --- |
| [Operator Token](../reference/resource-model.md#operator-tokens) | Run `supertag` commands against the shared Control Plane, recorded under the token's name | `supertag operator-token create NAME` |
| Client Auth Key | Enroll their device as a client of the Control Plane | `supertag auth-key create --role client NAME` |
| Host Auth Key | Join their computer as a Worker Host for the key's Tags | `supertag auth-key create --role host --tag TAG NAME` |

Each command prints its secret once; send it over a private channel. The teammate saves a token or
a client key with `supertag connect --name acme https://supertag.example.com`. To add their
computer as a Worker Host, they save the host key to a file and add a host service to
`~/.supertag/supertag.yaml`:

```yaml
services:
  laptop-2:
    type: host
    control-plane: https://supertag.example.com
    auth-key: laptop-2-key
    harnesses: [codex]
    workspaces:
      app: ~/code/app
    restart: unless-stopped
secrets:
  laptop-2-key: { file: ~/laptop-2.key }
```

Then they run `supertag up`. To end a teammate's access, revoke their token and their host:

```sh
supertag operator-token revoke --control-plane acme laptop-2
supertag host revoke --control-plane acme laptop-2
```

## Manage your organization from CI

Keep your manifests in a repository and let CI apply them. Give CI its own Operator Token, so its
changes are recorded under its name. In the CI job, set `SUPERTAG_OPERATOR_TOKEN` to the token's
secret and run:

```sh
# On each pull request: show what would change
supertag diff --control-plane https://supertag.example.com -f org/ --set org --prune

# After merging: apply it
supertag apply --control-plane https://supertag.example.com -f org/ --set org --prune
```

`--set org` names the resources these manifests own. With `--prune`, apply removes a resource in
that set once you delete it from the files, and never touches resources created another way.

## Moving from a local setup

A local Control Plane keeps its state under `~/.supertag`. SuperTag has no command that copies that
state into a hosted Control Plane.

1. Stop the local services with `supertag down`, so only one Control Plane uses the same
   collaboration surface app.
2. Apply your manifests to the hosted Control Plane with `supertag apply`.
3. Join your computer as a Worker Host, as in [Add teammates](#add-teammates).

## Next

- [Deployment definitions](../../deploy/native/README.md) for TLS, the WebSocket tunnel, replicas,
  and each platform
- [Control Plane operations](../operations/control-plane.md)
- [Collaboration surface guides](../surfaces/README.md)
