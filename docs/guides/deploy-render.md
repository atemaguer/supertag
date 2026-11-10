# Deploy the Control Plane on Render

A **Tag** is a persistent AI actor with its own responsibilities and permissions, and Tags work
in Teams: flat lists of member Tags. Together, your Teams of Tags make up an **autonomous organization**: Teams
may pursue different goals but share one set of rules and one record of the work. Declare a hosted
**Control Plane** (the service that stores and coordinates a SuperTag organization), managed
PostgreSQL, and persistent secret storage together as a Render Blueprint. That storage holds
credentials for each **collaboration surface**, an external work tool such as Slack where SuperTag
meets people. **Worker Hosts** (machines that execute the work) stay on machines you control, and
each runs a **Worklet**, the supervisor that connects outbound to the Control Plane. See the
[glossary](../reference/glossary.md) for other terms.

The repository's [`render.yaml`](../../deploy/render/render.yaml) declares one Docker web service,
one Render Postgres database, a persistent disk, database migrations, `/healthz` checks, and remote
Worklet transport.

## Before you start

- The installed `supertag` CLI. Deploy the release tag or commit that matches `supertag --version`.
- A private environment file prepared with `supertag setup deployment --platform render`, as
  described in [Configure a hosted Control Plane](deployment-setup.md). The Blueprint provides the
  persistent disk and database binding; preserve those provider-managed settings.
- Render access to the SuperTag GitHub repository. The repository is not publicly accessible, so
  grant Render access to it or use a fork your account can read.

## 1. Create the Blueprint

1. Generate an administrative token locally:

   ```sh
   openssl rand -hex 32
   ```

2. In the Render Dashboard, create a new Blueprint from the SuperTag GitHub repository and set
   **Blueprint Path** to `deploy/render/render.yaml`. Keep the service root at the repository root.
3. During creation, provide `SUPERTAG_ADMIN_TOKEN` and `SUPERTAG_COORDINATION_URL`, the service's final
   HTTPS origin or configured custom domain. The Blueprint sets `SUPERTAG_DEPLOYMENT_PLATFORM=render`.
4. Review the selected service and database plans, region, and disk size before applying the Blueprint.

The persistent disk makes the Control Plane a paid, single-instance service. It is mandatory
because collaboration surface credentials are stored under `/var/lib/supertag`; the managed database does not
contain credential values.

Render builds `deploy/docker/Dockerfile`, runs `node dist/index.js migrate` before each deployment,
and starts the Control Plane on Render's injected `PORT`. Inside the container image,
`node dist/index.js` is the `supertag` CLI. The database is private-network only. The generated
HTTPS endpoint serves management requests, Worklet connections, and collaboration surface traffic from the same
Control Plane process and listener. See Render's [Docker](https://render.com/docs/docker),
[Blueprint](https://render.com/docs/blueprint-spec), and
[PostgreSQL](https://render.com/docs/postgresql-creating-connecting) documentation.

## 2. Verify the Control Plane

After the Blueprint finishes, copy the Control Plane's `onrender.com` URL and check liveness:

```sh
curl --fail https://YOUR-CONTROL-PLANE.onrender.com/healthz
```

Use `supertag verify deployment https://YOUR-CONTROL-PLANE.onrender.com --env-file .env.deployment`
to check management authentication and report readiness as well.

Render continuously checks `/healthz` and uses it to gate deployments. `/readyz` remains
unavailable until a compatible Worklet connects, so keep `/healthz` as the platform health-check
path. Render explains this distinction in its [health-check documentation](https://render.com/docs/health-checks).

## 3. Connect your local CLI

Connect once from your local machine. The administrative token is read from the environment and
stored in the local credential store:

```sh
export SUPERTAG_ADMIN_TOKEN="the-administrative-token"
supertag connect control-plane https://YOUR-CONTROL-PLANE.onrender.com
unset SUPERTAG_ADMIN_TOKEN
```

The active Control Plane is remembered in `~/.supertag`, so your local CLI now controls the Render
deployment, the way `kubectl` controls a cluster, without Shell or SSH access. Then manage the deployment from your local CLI, just like a local one: write the `org.yaml`
manifests from [Declare a collaboration surface and Tag](self-hosting.md#5-declare-a-collaboration-surface-and-tag)
and apply them.

```sh
supertag apply -f org.yaml
```

 Follow the matching [collaboration surface guide](../surfaces/README.md) for
provider-side app and webhook configuration.

## 4. Connect a Worklet

A Tag with no
bound Worker Host rejects every mention. From an operator environment, create an
[Auth Key](../reference/resource-model.md#auth-keys) for the Tag. The host that joins with it is bound to
the Tag:

```sh
supertag create auth-key build-east-1 --tag engineering
```

The command prints a `stak_` secret once. On the machine that owns the **harness** (the coding agent that does the work, such as Claude
Code or Codex) and workspace, set
it in `SUPERTAG_AUTH_KEY`. The Worker Host needs only this key, not the administrative token, so
pass the Control Plane URL directly:

```sh
export SUPERTAG_AUTH_KEY=stak_...
supertag connect worklet --transport websocket \
  --worklet-url https://YOUR-CONTROL-PLANE.onrender.com \
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
supertag verify deployment https://YOUR-CONTROL-PLANE.onrender.com --env-file .env.deployment --require-ready
supertag describe worker-host build-east-1
```

Readiness shows that a compatible Worklet is connected, not that the Tag can complete work. Finish
by mentioning the Slack app in channel `C0123456789` and confirming that a Worker replies.

## Optional: add a supertag.yaml

The Control Plane starts with `supertag up --foreground control-plane`, so it also reads a
[`supertag.yaml`](../reference/supertag-yaml.md). The Blueprint's environment variables remain the main configuration and override
the file. Keep `SUPERTAG_DATABASE_URL`, `SUPERTAG_ADMIN_TOKEN`, and `SUPERTAG_COORDINATION_URL` there,
because the platform check reads them from the environment. A file suits settings such as `notify`,
`logging`, `operators.file`, or a `provision` list, which creates missing resources each time the
Control Plane starts; leave `ports` out.

The persistent disk at `/var/lib/supertag` hides any file the image puts there, so bake the file in at
another path. In your copy of the repository, add this line to `deploy/docker/Dockerfile` after
`COPY deploy/docker/entrypoint.sh`:

```dockerfile
COPY supertag.yaml /etc/supertag/supertag.yaml
```

Then append `-f /etc/supertag/supertag.yaml` to `dockerCommand` in `deploy/render/render.yaml`, or the service's Docker Command in the Render Dashboard, so it reads
`node dist/index.js up --foreground control-plane -f /etc/supertag/supertag.yaml`.

See [In containers and hosting platforms](../reference/supertag-yaml.md#in-containers-and-hosting-platforms)
for the keys that behave differently in a container.

## Limits

- A Render persistent disk is accessible to one service instance, so the Control Plane cannot scale horizontally in this configuration.
- A disk-backed Render service does not receive zero-downtime deploys; expect a short interruption during replacement.
- Back up both Render Postgres and the `/var/lib/supertag` disk. Render provides database recovery features and daily disk snapshots, but they protect different state.
- Keep the Control Plane and database in the same region. Put collaboration surface webhook URLs behind the Render HTTPS domain or a verified custom domain.

The disk behavior and limitations are documented in Render's [persistent disk guide](https://render.com/docs/disks).

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
