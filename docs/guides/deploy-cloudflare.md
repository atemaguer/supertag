# Deploy the Control Plane on Cloudflare

A **Tag** is a persistent AI identity with its own responsibilities and permissions, and Tags work
in Teams: flat lists of member Tags. Together, your Teams of Tags make up an **autonomous organization**: Teams
may pursue different goals but share one set of rules and one record of the work. Run the Node.js
**Control Plane** (the service that stores and coordinates a SuperTag organization) in a Cloudflare
Container, with Cloudflare ingress, while agents run on your own machines. A **Worker Host**
provides that execution capacity; its **Worklet** connects outbound to the Control Plane. A
Cloudflare Worker (Cloudflare's request handler, unrelated to a SuperTag **Worker**, the code that
completes an agent's work) routes HTTPS requests and WebSocket connections to one named container.
See the [glossary](../reference/glossary.md) for other terms.

Use this option when you can provide managed PostgreSQL and HashiCorp Vault. The
[deployment files](../../deploy/cloudflare/) include Wrangler configuration and the routing Worker.
This does not provide Cloudflare Sandbox execution.

## Before you start

- A Cloudflare Workers Paid account with Containers enabled. See Cloudflare's
  [Containers setup](https://developers.cloudflare.com/containers/get-started/).
- Docker, Node.js, a checkout of this repository, and the installed `supertag` CLI matching the
  release you deploy (`supertag --version`).
- A private environment file prepared with `supertag setup deployment --platform cloudflare`, as
  described in [Configure a hosted Control Plane](deployment-setup.md), once the services in step 1
  exist.

## 1. Prepare the services

This deployment requires external PostgreSQL and Vault before it starts; see [Limits](#limits).

1. Create a PostgreSQL database reachable from the container. Use a TLS connection with certificate
   verification and store its URL as `SUPERTAG_DATABASE_URL` in your operator environment.
2. Configure a durable HashiCorp Vault service reachable over HTTPS with a KV v2 mount. The runtime
   token needs `create`, `update`, and `read` on `MOUNT/data/PREFIX/*`, and `delete` on
   `MOUNT/metadata/PREFIX/*`. The defaults are `secret` and `supertag` respectively. Use a dedicated
   prefix per organization. Keep Vault storage durable and arrange token renewal or rotation.
3. Generate an administrative token locally with `openssl rand -hex 32` and store it securely.

Vault contains secrets written through normal SuperTag setup and enrollment. Cloudflare Worker
secrets hold only the bootstrap credentials needed to reach the database and Vault, plus the
administrative token. Keep secret values out of Wrangler variables and build arguments.

## 2. Initialize the database

From the checkout root, build the same image used by Wrangler and apply migrations to a new database:

```sh
docker build --platform linux/amd64 -f deploy/docker/Dockerfile -t supertag-cloudflare .
docker run --rm --env SUPERTAG_DATABASE_URL supertag-cloudflare node dist/index.js migrate database
```

Inside the image, `node dist/index.js` is the `supertag` CLI. The database URL is inherited from
your environment; it is not passed as a flag value. For an existing deployment, follow
[Upgrade, recover, and rotate secrets](#optional-upgrade-recover-and-rotate-secrets) before changing
its schema. The container does not migrate the database at startup and refuses an incompatible schema.

## 3. Configure Cloudflare

```sh
cd deploy/cloudflare
npm ci
npx wrangler login
```

Edit `wrangler.json`:

- Set `SUPERTAG_COORDINATION_URL` to the final HTTPS Worker URL or custom domain.
- Set `VAULT_ADDR`, `SUPERTAG_VAULT_MOUNT`, and `SUPERTAG_VAULT_PATH_PREFIX` for your Vault service.
- Add `VAULT_NAMESPACE` if your Vault Enterprise deployment requires it.

Keep `max_instances` at `1` and the routing instance name unchanged. This deployment assumes a
single active Control Plane. Provision separate Workers and storage namespaces for separate organizations.

Use Wrangler's interactive secret input for each value:

```sh
npx wrangler secret put SUPERTAG_DATABASE_URL
npx wrangler secret put SUPERTAG_ADMIN_TOKEN
npx wrangler secret put VAULT_TOKEN
```

If Wrangler asks to create the Worker before
the first deployment, allow it. The deployment forwards only its documented variables into the
container. See Cloudflare's [container secrets guide](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/).

## 4. Deploy

Check configuration before deployment with
`supertag check deployment --platform cloudflare --env-file .env.deployment` from the directory containing
your prepared file. Then deploy and check liveness:

```sh
npm run deploy
curl --fail https://YOUR-CONTROL-PLANE.workers.dev/healthz
```

After deployment, use `supertag verify deployment https://YOUR-CONTROL-PLANE.workers.dev --env-file .env.deployment`.

Initial container provisioning can take several minutes. The Worker and container image rollouts
are separate; check both in Cloudflare before considering the deployment complete.
The first successful health request starts the service. A one-minute Cron Trigger also wakes it
after a failure.

## 5. Connect your CLI and create a Tag

With `SUPERTAG_ADMIN_TOKEN` set in your local environment, connect the installed CLI:

```sh
supertag connect control-plane https://YOUR-CONTROL-PLANE.workers.dev
supertag status control-plane
supertag apply -f org.yaml
supertag create auth-key build-east-1 --tag engineering
```

Your local CLI now controls the deployment, the way `kubectl` controls a cluster. `org.yaml` holds
the manifests from
[Declare a collaboration surface and Tag](self-hosting.md#5-declare-a-collaboration-surface-and-tag):
a Slack **collaboration surface**, an external work tool where Tags meet people, and a Tag that
answers there.
A Tag with no bound Worker Host rejects every mention. The host that joins with the
[Auth Key](../reference/resource-model.md#auth-keys) is bound to the Tag. The key's `stak_` secret is
printed once. Configure external tool webhooks with the same public hostname and their normal paths.
Requests retain their body and authentication headers.

## 6. Connect a Worklet

On the Worker Host, set the secret in `SUPERTAG_AUTH_KEY`. The Worker Host needs only this key, not
the administrative token, so pass the Control Plane URL directly:

```sh
export SUPERTAG_AUTH_KEY=stak_...
supertag connect worklet --transport websocket \
  --worklet-url https://YOUR-CONTROL-PLANE.workers.dev \
  --worker-host build-east-1 \
  --harness codex \
  --workspace /absolute/path/to/codebase \
  --worker-profile local-codex
```

The host joins as `build-east-1` and stores its credential, so later runs need no key.

The connection uses the HTTPS endpoint's WebSocket upgrade. This deployment exposes the HTTP and
WebSocket APIs; it does not expose a separate gRPC port. See
[Choose the Worker connection](deployment-setup.md#choose-the-worker-connection).

## Check that it worked

```sh
supertag verify deployment https://YOUR-CONTROL-PLANE.workers.dev --env-file .env.deployment --require-ready
```

`/healthz` checks process liveness; `/readyz` can remain unavailable until the organization has
execution capacity. Finish by mentioning the Slack app in channel `C0123456789` and confirming that
a Worker replies.

## Optional: add a supertag.yaml

The Control Plane starts with `supertag up --foreground control-plane`, so it also reads a
[`supertag.yaml`](../reference/supertag-yaml.md). The Worker variables and secrets remain the main configuration and override
the file. Keep `SUPERTAG_DATABASE_URL`, `SUPERTAG_ADMIN_TOKEN`, and `SUPERTAG_COORDINATION_URL` there,
because the platform check reads them from the environment. A file suits settings such as `notify`,
`logging`, `operators.file`, or a `provision` list, which creates missing resources each time the
Control Plane starts; leave `ports` out.

The Cloudflare container has no volume at `/var/lib/supertag`, so bake the file into the image there. In your
copy of the repository, add this line to `deploy/docker/Dockerfile` after
`COPY deploy/docker/entrypoint.sh`, then deploy as usual; Wrangler builds that Dockerfile:

```dockerfile
COPY supertag.yaml /var/lib/supertag/supertag.yaml
```

See [In containers and hosting platforms](../reference/supertag-yaml.md#in-containers-and-hosting-platforms)
for the keys that behave differently in a container.

## Limits

- Cloudflare [container disks are ephemeral](https://developers.cloudflare.com/containers/concepts/architecture/),
  so all Control Plane state lives in two external stores:

  | State | Storage |
  | --- | --- |
  | Organization, Tasks (accepted assignments), Sessions (Tasks from one conversation), and delivery records | External PostgreSQL |
  | Collaboration surface credentials, Worker Host credential digests, and coordination signing key | HashiCorp Vault KV v2 |

- Artifact bytes (captured output files) stay on the Worker Hosts that capture them; the Control Plane stores none.
- No persistent filesystem mount is required. The local state directory is temporary. Back up
  PostgreSQL and Vault independently. Keeping the coordination signing key and Worker Host
  credential digests allows enrolled hosts to reconnect after container replacement.
- Idle shutdown is disabled because background scheduling and outbound collaboration surface connections must
  continue when nobody is making HTTP requests. Budget for an always-running container.
- Keep one active Control Plane (`max_instances` at `1`).
- A platform outage or database/Vault outage can still interrupt work; the Cron Trigger is a
  recovery aid, not a high-availability guarantee.

## Optional: upgrade, recover, and rotate secrets

### 1. Stop the running container

Before a schema upgrade, back up both stores. Set `SUPERTAG_MAINTENANCE` to `"true"` in the
currently deployed Worker's variables, preserving its other variables and secrets. This returns
503 for incoming requests and makes the Cron Trigger stop the container. Wait for a Cron execution
and confirm in Cloudflare that the container is stopped before migrating. Keep maintenance enabled
through the image rollout. Introduce the new image only after the old process is confirmed stopped.

### 2. Migrate and deploy

Build the new image and run its migration command using the operator database environment after
confirming the old process has stopped. Deploy with `SUPERTAG_MAINTENANCE` still
`"true"`, wait for the image rollout, then set it to `"false"` and verify both health endpoints.

### Rotate bootstrap secrets

Use the same maintenance window when changing bootstrap secrets. Replacing a Worker secret does
not change the environment of an already-running container; restart it before testing the new value.
Keep your checked-out Wrangler configuration consistent with any dashboard changes.

### Check that it worked

As a recovery check, restart the container, verify an existing enrolled Worklet reconnects, and
inspect an artifact captured before the restart with `supertag get artifact ARTIFACT_ID`. This
confirms state survives replacement rather than depending on the old disk.

## If something goes wrong

- **`/readyz` returns unavailable.** This is expected until a compatible Worklet connects. See
  [Health and readiness](../operations/control-plane.md#health-and-readiness).
- **The Worklet cannot connect.** HTTPS Worklet addresses select gRPC unless you pass
  `--transport websocket`, and this deployment has no gRPC port. See
  [Choose the Worker connection](deployment-setup.md#choose-the-worker-connection) and
  [Troubleshooting](troubleshooting.md).

## Next

- [Control Plane operations](../operations/control-plane.md) for migration, recovery, credential, and artifact behavior.
- [Run a Worker](workers.md)
- [collaboration surface guides](../surfaces/README.md)
