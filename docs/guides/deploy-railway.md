# Deploy the Control Plane on Railway

A **Tag** is a persistent AI actor with its own responsibilities and permissions, and Tags work
in Teams: flat lists of member Tags. Together, your Teams of Tags make up an **autonomous organization**: Teams
may pursue different goals but share one set of rules and one record of the work. Deploy a hosted
**Control Plane** (the service that stores and coordinates a SuperTag organization) and PostgreSQL
on Railway, while Codex, Claude Code, codebases, and MCP credentials stay on **Worker Hosts**
(machines that execute the work) you control. Each Worker Host runs a **Worklet**, the supervisor
that connects outbound to the Control Plane. See the [glossary](../reference/glossary.md) for other
terms.

This guide deploys one Control Plane service, one PostgreSQL service, and one persistent volume.
The repository's [`railway.json`](../../deploy/railway/railway.json) configures the Docker build,
database migration, start command, restart policy, and `/healthz` deployment check.

## Before you start

- The installed `supertag` CLI. Deploy the release tag or commit that matches `supertag --version`.
- A private environment file prepared with `supertag setup deployment --platform railway`, as
  described in [Configure a hosted Control Plane](deployment-setup.md).
- Railway access to the SuperTag GitHub repository. The repository is not publicly accessible, so
  grant Railway's GitHub app access to it or deploy from a fork your account can read.

## 1. Create the project

1. In Railway, create a project from the SuperTag GitHub repository.
2. Add a PostgreSQL service to the same project.
3. Attach a volume to the Control Plane service at `/var/lib/supertag`.
   Generate its public domain in Networking so the final HTTPS origin is available during setup.
4. Generate an administrative token locally:

   ```sh
   openssl rand -hex 32
   ```

Set Railway’s Config File path to `/deploy/railway/railway.json` and keep the service root at the
repository root. That configuration selects `deploy/docker/Dockerfile`. The volume is mandatory
because credentials for each **collaboration surface** (an external work tool such as Slack where
SuperTag meets people) are stored under `SUPERTAG_STATE_DIR`; PostgreSQL alone is not sufficient.

## 2. Configure the Control Plane variables

Add these variables to the Control Plane service:

```text
SUPERTAG_DATABASE_URL=${{Postgres.DATABASE_URL}}
SUPERTAG_DEPLOYMENT_PLATFORM=railway
SUPERTAG_STATE_DIR=/var/lib/supertag
SUPERTAG_WORKLET_TRANSPORT=remote
SUPERTAG_CREDENTIAL_VAULT=file
SUPERTAG_COORDINATION_URL=https://YOUR-CONTROL-PLANE.up.railway.app
SUPERTAG_ADMIN_TOKEN=the-administrative-token-you-generated
```

If your database service is not named `Postgres`, replace that name in the reference variable.
Seal the administrative token after confirming the CLI can connect. Railway documents
[service reference variables](https://docs.railway.com/variables#referencing-another-services-variable)
and [sealed variables](https://docs.railway.com/variables#sealed-variables).

Keep collaboration surface credentials and credentials for each **harness** (the connection to an
agent system such as Codex or Claude Code) out of the repository, Docker image, and build arguments.

## 3. Deploy and expose the Control Plane

Deploy the Control Plane service, then generate a Railway public domain under its networking
settings. The same HTTPS endpoint serves management requests, Worklet connections, and collaboration surface
traffic. The Control Plane reads Railway's injected `PORT`; no port variable is required.

The configured pre-deploy command applies ordinary database migrations before the new Control Plane
starts. Railway waits for `/healthz` before switching the deployment. See Railway's
[Dockerfile](https://docs.railway.com/builds/dockerfiles),
[pre-deploy command](https://docs.railway.com/deployments/pre-deploy-command), and
[healthcheck](https://docs.railway.com/deployments/healthchecks) documentation.

Check liveness:

```sh
curl --fail https://YOUR-CONTROL-PLANE.up.railway.app/healthz
```

With your prepared environment file, `supertag verify deployment https://YOUR-CONTROL-PLANE.up.railway.app --env-file .env.deployment`
also verifies management authentication and reports readiness. Use `/healthz` for the platform
deployment check and `/readyz` for operational readiness.

## 4. Connect your local CLI

From your local machine, connect once using the public HTTPS URL. The token is read from the
environment for non-interactive setup and then saved in the local credential store:

```sh
export SUPERTAG_ADMIN_TOKEN="the-administrative-token"
supertag connect control-plane https://YOUR-CONTROL-PLANE.up.railway.app
unset SUPERTAG_ADMIN_TOKEN

supertag status control-plane
```

The active Control Plane is remembered in `~/.supertag`, so your local CLI now controls the
Railway deployment, the way `kubectl` controls a cluster, without Railway SSH. Then manage the deployment from your local CLI, just like a local one: write the `org.yaml`
manifests from [Declare a collaboration surface and Tag](self-hosting.md#5-declare-a-collaboration-surface-and-tag)
and apply them.

```sh
supertag apply -f org.yaml
```

Follow the matching [collaboration surface guide](../surfaces/README.md) for provider-side app and webhook
configuration. Collaboration surface credentials travel only over the Control Plane's Railway-managed HTTPS
endpoint and are persisted by its configured vault. The default local vault uses the mounted state
volume.

## 5. Connect a Worklet

A Tag with no
bound Worker Host rejects every mention. From an operator environment, create an
[Auth Key](../reference/resource-model.md#auth-keys) for the Tag. The host that joins with it is bound to
the Tag:

```sh
supertag create auth-key build-east-1 --tag engineering
```

The command prints a `stak_` secret once. On the machine that owns the harness and workspace, set
it in `SUPERTAG_AUTH_KEY`. The Worker Host needs only this key, not the administrative token, so
pass the Control Plane URL directly:

```sh
export SUPERTAG_AUTH_KEY=stak_...
supertag connect worklet --transport websocket \
  --worklet-url https://YOUR-CONTROL-PLANE.up.railway.app \
  --worker-host build-east-1 \
  --harness codex \
  --workspace /absolute/path/to/codebase \
  --worker-profile local-codex
```

The host joins as `build-east-1` and stores its credential, so later runs need no key.

A **Worker** is the code on that host that completes a Tag's work. The HTTPS URL is upgraded to
WSS automatically. This template uses WebSocket; see
[Choose the Worker connection](deployment-setup.md#choose-the-worker-connection) before enabling gRPC.

## Check that it worked

From the operator environment, confirm readiness and the host's connection:

```sh
supertag verify deployment https://YOUR-CONTROL-PLANE.up.railway.app --env-file .env.deployment --require-ready
supertag describe worker-host build-east-1
```

`/readyz` and `--require-ready` show that a compatible Worklet is connected, not that the Tag can
complete work. Finish by mentioning the Slack app in channel `C0123456789` and confirming that a
Worker replies in the thread.

## Optional: add a supertag.yaml

The Control Plane starts with `supertag up --foreground control-plane`, so it also reads a
[`supertag.yaml`](../reference/supertag-yaml.md). The Railway variables remain the main configuration and override
the file. Keep `SUPERTAG_DATABASE_URL`, `SUPERTAG_ADMIN_TOKEN`, and `SUPERTAG_COORDINATION_URL` there,
because the platform check reads them from the environment. A file suits settings such as `notify`,
`logging`, `operators.file`, or a `provision` list, which creates missing resources each time the
Control Plane starts; leave `ports` out.

The Railway volume at `/var/lib/supertag` hides any file the image puts there, so bake the file in at
another path. In your copy of the repository, add this line to `deploy/docker/Dockerfile` after
`COPY deploy/docker/entrypoint.sh`:

```dockerfile
COPY supertag.yaml /etc/supertag/supertag.yaml
```

Then append `-f /etc/supertag/supertag.yaml` to `startCommand` in `deploy/railway/railway.json`, so it reads
`node dist/index.js up --foreground control-plane -f /etc/supertag/supertag.yaml`.

See [In containers and hosting platforms](../reference/supertag-yaml.md#in-containers-and-hosting-platforms)
for the keys that behave differently in a container.

## Limits

- A Railway volume is attached to one Control Plane service. Keep the Control Plane at one replica.
- Railway volume deployments have brief downtime because two deployments cannot mount the same volume simultaneously.
- Railway uses the configured healthcheck during deployment, not as continuous monitoring. Add an external monitor for `/healthz` and `/readyz`.
- Back up both PostgreSQL and the `/var/lib/supertag` volume. Railway documents [PostgreSQL backups](https://docs.railway.com/databases/postgresql#backups-and-observability) and [volume backups](https://docs.railway.com/volumes/backups).

## If something goes wrong

- **`/readyz` returns unavailable.** This is expected until a compatible Worklet connects. See
  [Health and readiness](../operations/control-plane.md#health-and-readiness).
- **The Worklet cannot connect.** HTTPS Worklet addresses select gRPC unless you pass
  `--transport websocket`. See [Choose the Worker connection](deployment-setup.md#choose-the-worker-connection)
  and [Troubleshooting](troubleshooting.md).

## Next

- [Control Plane operations](../operations/control-plane.md) for recovery, upgrades, and credential boundaries.
- [Run a Worker](workers.md)
- [collaboration surface guides](../surfaces/README.md)
