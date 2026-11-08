# Deploy the Control Plane on Fly.io

A **Tag** is a persistent AI identity with its own responsibilities and permissions, and Tags work
in Teams: flat lists of member Tags. Together, your Teams of Tags make up an **autonomous organization**: Teams
may pursue different goals but share one set of rules and one record of the work. Run the **Control
Plane** (the service that stores and coordinates a SuperTag organization) as one always-on Fly.io
Machine with PostgreSQL and a persistent volume. Use this option when you want to choose the
Machine's region and manage its storage directly. A **Worker Host** supplies execution capacity
elsewhere; its **Worklet** connects outbound to the Control Plane over HTTPS/WebSocket. See the
[glossary](../reference/glossary.md) for other terms.

## Before you start

- The installed `supertag` CLI, matching the release you deploy (`supertag --version`).
- The [Fly CLI](https://fly.io/docs/flyctl/install/), installed and authenticated.
- A checkout of the repository; run the commands below from its root.
- A private environment file prepared with `supertag setup deployment --platform fly`, as
  described in [Configure a hosted Control Plane](deployment-setup.md). Use
  `https://YOUR-APP.fly.dev` as the coordination URL.

## 1. Create the app and volume

Choose a unique app name and create its volume in the region selected in
[`deploy/fly/fly.toml`](../../deploy/fly/fly.toml) (`iad` by default):

```sh
fly apps create YOUR-APP
fly volumes create supertag_state --app YOUR-APP --region iad --size 1
```

The volume stores credentials for each **collaboration surface**, an external work tool such as
Slack where SuperTag meets people, and artifacts, the output files that work captures.

## 2. Provision PostgreSQL

Provision PostgreSQL in a nearby region, using Fly Managed Postgres or another provider. Keep its
connection URL private. PostgreSQL stores organization state; it and the volume both require
backups.

## 3. Check, import, and deploy

```sh
supertag setup deployment --platform fly
supertag check deployment --platform fly --env-file .env.deployment
fly secrets import --app YOUR-APP --stage < .env.deployment
fly deploy --app YOUR-APP --config deploy/fly/fly.toml --ha=false
```

Run the deploy command from the repository root so the Docker build includes the workspace.
For a release image you already built and published, add `--image YOUR-IMAGE@sha256:DIGEST`.
The shared Docker image reads port 3434. Fly terminates TLS, forwards WebSocket upgrades, and
checks `/healthz`; `/readyz` waits for a compatible Worklet and is not the deployment health check.

The release command runs ordinary migrations before replacing the Machine. Its temporary Machine
has no mounted state volume, which is fine because migrations only need PostgreSQL.

Always use `--ha=false` on initial deployment, and confirm `fly machine list --app YOUR-APP` shows
one serving Machine. See [Fly deployment behavior](https://fly.io/docs/launch/deploy/).

## 4. Connect your CLI and create an Auth Key

```sh
supertag verify deployment https://YOUR-APP.fly.dev --env-file .env.deployment
supertag connect control-plane https://YOUR-APP.fly.dev
supertag create auth-key build-host --tag engineering
```

The connect command reads `SUPERTAG_ADMIN_TOKEN` from your environment or a masked prompt. The
[Auth Key](../reference/resource-model.md#auth-keys) prints a `stak_` secret once. The host that joins
with it is bound to the Tag. A Tag with no bound Worker Host rejects every mention.

## 5. Connect a Worklet

On the Worker Host, set the secret in `SUPERTAG_AUTH_KEY`, then follow [Run a Worker](workers.md)
to connect a Worklet. A **Worker** is the code on that host that completes a Tag's work. The host
joins on its first connection. This template uses WebSocket by
default; see [Choose the Worker connection](deployment-setup.md#choose-the-worker-connection).

## Check that it worked

Repeat verification with readiness required:

```sh
supertag verify deployment https://YOUR-APP.fly.dev --env-file .env.deployment --require-ready
```

After setting up a collaboration surface and Tag with the [collaboration surface guides](../surfaces/README.md), mention
the Tag in a connected Slack channel and confirm that a Worker replies. Check that the
Worklet reconnects and existing artifacts remain available after restarting the Machine.

## Optional: add a supertag.yaml

The Control Plane starts with `supertag up --foreground control-plane`, so it also reads a
[`supertag.yaml`](../reference/supertag-yaml.md). The `fly.toml` environment and Fly secrets remain the main configuration and override
the file. Keep `SUPERTAG_DATABASE_URL`, `SUPERTAG_ADMIN_TOKEN`, and `SUPERTAG_COORDINATION_URL` there,
because the platform check reads them from the environment. A file suits settings such as `notify`,
`logging`, `operators.file`, or a `provision` list, which creates missing resources each time the
Control Plane starts; leave `ports` out.

Copy the file into the Fly volume mounted at `/var/lib/supertag`, then restart the Machine:

```sh
fly ssh sftp shell --app YOUR-APP
# at the prompt: put supertag.yaml /var/lib/supertag/supertag.yaml
fly apps restart YOUR-APP
```

The file stays on the volume across deployments.

See [In containers and hosting platforms](../reference/supertag-yaml.md#in-containers-and-hosting-platforms)
for the keys that behave differently in a container.

## Limits

- Keep one Control Plane Machine. This template does not support multiple instances sharing local
  credentials or routing Worklets independently.
- Automatic stopping is disabled so scheduling and collaboration surface connections continue without incoming
  requests.
- The immediate deployment strategy replaces the single instance with a brief interruption.
- Back up both PostgreSQL and the volume.

## Optional: add a native gRPC listener

A gRPC listener lets remote Worklets and their internal clients use HTTP/2 directly. This optional
profile keeps the management API on HTTPS port 443 and forwards encrypted TCP port 8443 to the
Control Plane's TLS listener on port 3435. It does not terminate TLS at Fly Proxy or expose a
plaintext gRPC port. [Fly documents TCP passthrough and its addressing requirements](https://fly.io/docs/networking/services/).

### Before you start

- A hostname and matching certificate whose private key you control. Fly-managed edge certificates
  are not installed into the paths below automatically.
- A dedicated IPv6 address or a dedicated IPv4 address for raw TCP passthrough. Shared IPv4 routing
  requires an edge handler and cannot serve this profile as configured.

### 1. Mount the certificate

Mount the full certificate chain at `/var/lib/supertag/tls/fullchain.pem` and private key at
`/var/lib/supertag/tls/privkey.pem`, readable only by the container's runtime user. Keep these
files out of the repository and command arguments. Arrange renewal and restart the Control Plane to
load renewed files.

### 2. Prepare the gRPC environment

Prepare the deployment environment with `supertag setup deployment --platform fly --transport grpc`.
The gRPC profile requires these non-secret settings (the certificate and key stay in mounted files):

```dotenv
SUPERTAG_DEPLOYMENT_RPC_TRANSPORT=grpc
SUPERTAG_WORKLET_GRPC_PORT=3435
SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE=/var/lib/supertag/tls/fullchain.pem
SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE=/var/lib/supertag/tls/privkey.pem
```

### 3. Deploy and connect Worklets

Import the environment and deploy using `--config deploy/fly/fly.grpc.toml` instead of
`deploy/fly/fly.toml`. Keep `SUPERTAG_COORDINATION_URL` on the management HTTPS origin. Connect
Worklets with `--transport grpc --control-plane https://YOUR-GRPC-HOST:8443` and their existing
Worker Host credential files. For a private certificate authority, configure the Worklet's trusted
CA using the [Worker guide](workers.md); keep certificate verification enabled.

### Check that it worked

Check both paths before moving production Workers:

```sh
supertag verify deployment https://YOUR-APP.fly.dev --env-file .env.deployment --grpc-url https://YOUR-GRPC-HOST:8443
```

The RPC probe checks routing and authentication rejection; it does not prove long-lived stream
recovery or application capacity. Exercise an authenticated Worklet reconnect and accepted-Task
recovery through your actual ingress. This profile is generated and locally checked; it has not
been validated by deploying to a hosted Fly app. To roll back, connect Workers using
`--transport websocket` to the management origin and use the WebSocket deployment profile.

## Optional: remove a test deployment

For a disposable deployment test, destroy only the app created for that test with
`fly apps destroy YOUR-TEST-APP`. Verify its Machines and volumes are removed, and separately delete
any test database or external storage you created. Stopping a Machine alone leaves billable storage.

## If something goes wrong

- **`/readyz` returns unavailable.** This is expected until a compatible Worklet connects. See
  [Health and readiness](../operations/control-plane.md#health-and-readiness).
- **The Worklet cannot connect.** HTTPS Worklet addresses select gRPC unless you pass
  `--transport websocket`. See [Choose the Worker connection](deployment-setup.md#choose-the-worker-connection)
  and [Troubleshooting](troubleshooting.md).

## Next

- [Control Plane operations](../operations/control-plane.md)
- [Run a Worker](workers.md)
- [collaboration surface guides](../surfaces/README.md)
