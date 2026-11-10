# Configure a hosted Control Plane

A **Tag** is a persistent AI actor with its own responsibilities and permissions, and Tags work
in Teams: flat lists of member Tags. Together, your Teams of Tags make up an **autonomous organization**: Teams
may pursue different goals but share one set of rules and one record of the work. Prepare, check,
and verify one configuration for a hosted **Control Plane** (the service that stores and coordinates
a SuperTag organization) on Railway, Render, Fly.io, Modal, or Cloudflare. Agents execute on
separate **Worker Hosts**, each connected by an outbound **Worklet**. Every platform uses the same
setup and verification commands; see the [glossary](../reference/glossary.md) for other terms.

## Before you start

- The installed `supertag` CLI, matching the release you deploy (`supertag --version`). See
  [Install the matching SuperTag version](../operations/install.md).
- An account on your chosen hosting platform.
- A PostgreSQL database, storage, and public hostname, created with the platform guide in step 1.

## 1. Choose storage and create the services

All platforms run the same Node.js container, use PostgreSQL, accept authenticated HTTPS and
WebSocket requests, and expose `/healthz` for liveness. `/readyz` also checks whether the organization
can accept work. The deployment runs one Control Plane instance.

| Platform | Credential storage | Platform setup |
| --- | --- | --- |
| Railway | Persistent volume at `/var/lib/supertag` | [Railway](deploy-railway.md) |
| Render | Persistent disk at `/var/lib/supertag` | [Render](deploy-render.md) |
| Fly.io | Persistent volume at `/var/lib/supertag` | [Fly.io](deploy-fly.md) |
| Modal | HashiCorp Vault KV v2 | [Modal](deploy-modal.md) |
| Cloudflare | HashiCorp Vault KV v2 | [Cloudflare](deploy-cloudflare.md) |

Railway, Render, and Fly.io can also use Vault. Cloudflare and Modal require external storage
because their container disks are temporary. The Control Plane stores no artifact bytes (captured
output files) on any platform; Worker Hosts keep them. Create the database, storage, and public hostname using the
platform guide before preparing the final configuration. Cloudflare Containers requires the
Workers Paid plan.

<a id="choose-the-worker-connection"></a>

## 2. Choose the Worker connection

A **Worker** is the code that completes work on a Worker Host, and the host's Worklet carries its
connection. Hosted templates use WebSocket by default. On Worker Hosts, select `--transport websocket`
when connecting to the template's HTTPS management origin, or use its `wss://` Worklet address.
SuperTag normally selects gRPC for an HTTPS Worklet address; a hosting provider's support for
HTTP/2 at its public edge does not establish native, bidirectional gRPC forwarding to your process.

| Template | Worker connection | Native gRPC choice |
| --- | --- | --- |
| Fly.io | WebSocket by default | Optional separate TLS passthrough listener; see [Fly.io](deploy-fly.md) |
| Railway / Render | WebSocket | Not configured in these templates; public edge HTTP/2 alone is insufficient evidence |
| Modal | WebSocket | The web-function template does not expose a verified native gRPC listener |
| Cloudflare | WebSocket | This template routes through a Worker, not a direct gRPC origin proxy |

These are template capabilities, not restrictions on every networking product from those
providers. [Railway documents edge HTTP/2](https://docs.railway.com/networking/public-networking/specs-and-limits),
[Render describes its web-service forwarding](https://render.com/docs/web-services), and
[Modal documents web functions and WebSockets](https://modal.com/docs/guide/webhooks).
Cloudflare's [gRPC origin proxy](https://developers.cloudflare.com/network/grpc-connections/)
is distinct from the [Workers Fetch interface](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
used here. Keep the explicit WebSocket choice, and do not enable a gRPC listener behind a
template's ingress, until a native bidirectional HTTP/2 path has been configured and verified.

## 3. Prepare one environment file

Use the installed CLI, selecting your platform:

```sh
supertag setup deployment --platform railway
# Or: supertag setup deployment --platform render
# Or: supertag setup deployment --platform cloudflare
# Or: supertag setup deployment --platform fly
# Or: supertag setup deployment --platform modal
```

Setup reads existing environment variables and prompts for missing required values. Secret prompts
are masked. If an administrative token is not supplied during interactive setup, it generates one.
It writes `.env.deployment` with owner-only permissions and refuses to overwrite an existing file.
Use `--output PATH` for a separate environment. Keep this file private and out of version control.
It is a dotenv file for configuration tools; do not execute or shell-source it.

For automated setup, supply all required values through your environment and add `--non-interactive`.
Secret values are never passed as flags. To reuse an existing file, use `--env-file PATH`; values
in that file take precedence over your shell environment.

### Common settings

| Variable | Meaning |
| --- | --- |
| `SUPERTAG_DEPLOYMENT_PLATFORM` | `railway`, `render`, `cloudflare`, `fly`, or `modal`; set by setup |
| `SUPERTAG_DATABASE_URL` | PostgreSQL connection URL, kept secret |
| `SUPERTAG_ADMIN_TOKEN` | Administrative credential, kept secret |
| `SUPERTAG_COORDINATION_URL` | Public HTTPS origin, without a path |
| `SUPERTAG_WORKLET_TRANSPORT` | `remote` for all hosted deployments |
| `SUPERTAG_DEPLOYMENT_RPC_TRANSPORT` | `websocket` by default, or `grpc` from `--transport grpc`; set by setup. Only the Fly.io template accepts `grpc` |
| `SUPERTAG_STATE_DIR` | `/var/lib/supertag`; persistent on Railway, Render, and Fly.io by default |
| `SUPERTAG_CREDENTIAL_VAULT` | `file` on Railway/Render/Fly.io; `vault` on Cloudflare/Modal |

For Vault, supply `VAULT_ADDR` and `VAULT_TOKEN`, with optional `SUPERTAG_VAULT_MOUNT`,
`SUPERTAG_VAULT_PATH_PREFIX`, and `VAULT_NAMESPACE`. To select Vault on Railway, Render, or Fly.io, set
`SUPERTAG_CREDENTIAL_VAULT=vault` before running setup. Preserve existing credentials when changing
providers; setup does not migrate them.

## 4. Check the file

```sh
supertag check deployment --platform railway --env-file .env.deployment
```

The check validates configuration locally and reports field names without printing their values.
It does not prove service connectivity or that a volume is mounted. The hosted Control Plane uses
the same validation at startup when `SUPERTAG_DEPLOYMENT_PLATFORM` is set.

## 5. Apply configuration and deploy

- **Railway:** setup and check require `SUPERTAG_DATABASE_URL` to be a real `postgresql://` URL,
  so they reject the reference `${{Postgres.DATABASE_URL}}`. Give setup the database's current URL
  or a placeholder `postgresql://` URL. Import the file using the service Variables RAW Editor.
  Then set `SUPERTAG_DATABASE_URL` in the service back to `${{Postgres.DATABASE_URL}}`, so provider
  rotation remains effective, and attach the persistent volume. See
  [Railway variables](https://docs.railway.com/variables).
- **Render:** use the service's Environment page and **Add from .env** for operator-managed values.
  Preserve the Blueprint's database binding and disk configuration. See
  [Render environment variables](https://render.com/docs/configure-environment-variables).
- **Fly.io:** import the file with `fly secrets import --app YOUR-APP --stage < .env.deployment`,
  then deploy the Fly manifest from the repository root with `--ha=false`.
- **Modal:** import the file into a named Modal Secret with `--from-dotenv`, run the separate
  migration function, and deploy the Server. See the Modal guide for image publishing.
- **Cloudflare:** copy non-secret settings into Wrangler's `vars` and upload the five secret fields
  with the secret commands in the platform guide. Do not bulk-upload the full file as secrets while
  the same names also exist in `vars`.

The provider manifests share the same runtime commands and health path. Railway, Render, and Fly.io apply
ordinary migrations in a pre-deploy/release step; Cloudflare and Modal use explicit migration steps.

## 6. Verify and connect execution

After deployment, use the same command on every platform:

```sh
supertag verify deployment https://YOUR-CONTROL-PLANE --env-file .env.deployment
```

This checks liveness, rejects anonymous management access, tests your administrative credential,
and reports readiness. It does not follow redirects with credentials. Connect your CLI using
`supertag connect control-plane`, enroll a Worker Host, and connect its Worklet as described in the
platform guide.

## Check that it worked

Require readiness:

```sh
supertag verify deployment https://YOUR-CONTROL-PLANE --env-file .env.deployment --require-ready
```

Mention a Tag in a
connected Slack channel and confirm that a Worker replies. Finally, confirm that the Worklet
reconnects after a restart and that an existing artifact remains available. These checks exercise
storage and execution beyond the read-only HTTP verification.

## Optional: keep artifacts on Worker Hosts

Each Worklet keeps the artifact bytes captured by its **Tasks**, the accepted assignments it runs, in its own state directory and serves
authorized downloads directly to other Worklets. The hosted Control Plane stores none.

1. Give every participating Worker Host persistent storage and a transfer endpoint reachable from
   the other participating hosts. A Worklet's outbound connection to the Control Plane is
   sufficient for assignments, but direct artifact transfer also requires this peer reachability.
   Use a private network or tunnel and TLS outside a trusted local network.
2. Connect each Worklet with the transfer endpoint options listed in the
   [Worker guide](workers.md#keep-artifacts-on-worker-hosts).

If a host cannot accept peer connections, other Worker Hosts cannot fetch the artifacts it holds.
The Control Plane does not relay them.

## If something goes wrong

- **`/readyz` returns unavailable.** This is expected until a compatible Worklet connects. See
  [Health and readiness](../operations/control-plane.md#health-and-readiness).
- **The Worklet cannot connect.** Pass `--transport websocket`; see
  [step 2](#choose-the-worker-connection) and [Troubleshooting](troubleshooting.md).

## Next

- Your platform guide: [Railway](deploy-railway.md), [Render](deploy-render.md), [Fly.io](deploy-fly.md), [Modal](deploy-modal.md), or [Cloudflare](deploy-cloudflare.md)
- [Run a Worker](workers.md)
- [Control Plane operations](../operations/control-plane.md)
