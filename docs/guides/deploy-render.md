# Deploy the Control Plane on Render

<!-- supertag-cli: native -->

A **Tag** is a persistent AI actor with its own responsibilities and permissions. The **Control
Plane** is the service that stores a SuperTag organization and schedules its work; it is the one
public endpoint for operators, **Worker Hosts** (the machines that run the work), and the
optional **Gateway**, which connects **collaboration surfaces** such as Slack. This guide runs the
native Control Plane on Render from a Blueprint, with Render PostgreSQL. See the
[glossary](../reference/glossary.md) for other terms.

Render's edge terminates TLS and forwards only HTTP/1.1. The Control Plane therefore carries its
gRPC API inside a WebSocket, the **tunnel**, and runs SuperTag's own TLS end to end inside it.
Clients use a `wss://` URL. Render sees only ciphertext.

```text
operators, Worker Hosts ── wss:// ──> Render edge ──> supertag-control-plane (web, port 8080)
                                                        │ PostgreSQL (Render), disk
supertag-gateway (background worker, optional) ── wss:// ──┘
```

[`render.yaml`](../../deploy/render/render.yaml) declares:

| Service | Render type | Runs | State |
| --- | --- | --- | --- |
| `supertag-control-plane` | Web service, port 8080 | `control-plane --websocket-listen 0.0.0.0:8080`; native gRPC on loopback only | Render PostgreSQL; a 1 GB disk at `/var/lib/supertag` for transfer files |
| `supertag-gateway` | Background worker, optional | `gateway --control-plane wss://supertag-control-plane.onrender.com` | A 1 GB disk for connector state and the file credential vault |
| `supertag-postgres` | PostgreSQL | | Private network only (`ipAllowList: []`) |

## Before you start

- The installed `supertag` CLI, matching the release you deploy.
- The `hosted` service image pushed to a registry Render can pull, with its digest. See
  [Build the hosted image](../../deploy/native/README.md#build-the-hosted-image).
- `openssl`, to issue certificates from your own CA.
- A Render workspace with billing: disks need a paid instance type, and free instances sleep.

## 1. Issue certificates

Render's `onrender.com` hostname cannot carry a publicly trusted certificate for SuperTag's inner
TLS. Issue the Control Plane's certificate from your own CA for
`supertag-control-plane.onrender.com` (and any custom domain you add), as shown in
[Issue certificates from your own CA](../../deploy/native/README.md#issue-certificates-from-your-own-ca).
Every client then trusts that CA through `SUPERTAG_SERVER_CA_FILE`.

If you deploy the Gateway, also issue it a client certificate. The Control Plane accepts the
Gateway's credential only from a client whose certificate it verifies, so it then requires client
certificates from everyone: issue one for each operator and Worker Host too.

## 2. Prepare the configuration

```sh
supertag setup deployment render --output supertag-deployment
supertag check deployment render --directory supertag-deployment
```

Setup writes `control-plane.env`, `gateway.env`, and `operator.env`, each readable only by you.
It generates the Gateway and operator tokens. It leaves out `SUPERTAG_DATABASE_URL`: the Blueprint
sets it from its own database, and setup refuses one supplied in the environment.

## 3. Create the Blueprint

1. In your copy of the repository, replace both image URLs in `deploy/render/render.yaml` with
   your hosted image by digest. Remove the `supertag-gateway` service if you use no collaboration
   surface or notification.
2. In the Render Dashboard, create a Blueprint from the repository with **Blueprint Path**
   `deploy/render/render.yaml`.
3. On `supertag-control-plane`, open **Environment**, choose **Add from .env**, and paste
   `control-plane.env`. Add `SUPERTAG_TLS_CERT_PEM` and `SUPERTAG_TLS_KEY_PEM` with the
   certificate and key, and, with a Gateway, `SUPERTAG_TLS_CLIENT_CA_PEM` with your CA.
4. On `supertag-gateway`, paste `gateway.env` and add `SUPERTAG_SERVER_CA_PEM` (your CA),
   `SUPERTAG_CLIENT_CERT_PEM`, and `SUPERTAG_CLIENT_KEY_PEM`. If Render assigned the Control Plane
   another hostname, or you use a custom domain, change the Gateway's `--control-plane` URL to it.

The image entrypoint writes each `_PEM` value to a file under `/run/supertag-tls` and runs the
service as an unprivileged user. Do not set the matching `_FILE` variables yourself.

The Control Plane migrates its database when it starts. Render's health check sends
`GET /healthz` to port 8080. The tunnel listener answers that one plain request with `200 ok`,
refuses it from a browser (any request with an `Origin` header), and accepts nothing else that is
not a WebSocket upgrade.

## 4. Verify

```sh
curl --fail https://supertag-control-plane.onrender.com/healthz
export SUPERTAG_SERVER_CA_FILE=$PWD/ca.pem
supertag verify deployment wss://supertag-control-plane.onrender.com \
  --env-file supertag-deployment/operator.env
```

With a Gateway, also set `SUPERTAG_CLIENT_CERT_FILE` and `SUPERTAG_CLIENT_KEY_FILE` to an
operator's client certificate. Verification checks gRPC health through the tunnel, that anonymous
and invalid credentials are refused, and that the operator token works. It reports readiness as
`not ready` until a Worker Host connects.

## 5. Connect a Worker Host

Run operator commands with the operator token in `SUPERTAG_OPERATOR_TOKEN` and the URL in
`--control-plane`. Create an **Auth Key** (a one-time enrollment secret) for the host, then enroll
and run it on the machine that owns the **harness** (the coding agent that does the work, such as
Codex):

```sh
supertag auth-key create build-1 --host build-1 --tag engineering \
  --control-plane wss://supertag-control-plane.onrender.com
# Save the printed key as build-1.key (mode 0600) on the Worker Host, then, with the same
# SUPERTAG_SERVER_CA_FILE:
supertag host enroll build-1 --control-plane wss://supertag-control-plane.onrender.com \
  --state-directory ~/.supertag-host --auth-key file:build-1.key
supertag worker-host --control-plane wss://supertag-control-plane.onrender.com \
  --state-directory ~/.supertag-host --harness codex
```

The Worker Host connects outbound and needs no inbound port.

## Check that it worked

```sh
supertag verify deployment wss://supertag-control-plane.onrender.com \
  --env-file supertag-deployment/operator.env --require-ready
```

Then mention a Tag in a connected collaboration surface and confirm that it replies.

## Cold starts and restarts

- Each deploy replaces the instance. A service with a disk gets no zero-downtime deploy, so open
  tunnels drop. Worker Hosts and the Gateway reconnect and retry; opening a tunnel waits up to 30
  seconds for the new instance.
- Do not use a free instance type: it sleeps when idle, which stops the Control Plane's
  controllers, and it cannot attach a disk.
- Both ends of a tunnel ping every 20 seconds, which keeps idle tunnels open through Render's proxy.

## Limits

- One instance per service. A service with a disk cannot scale, and every Control Plane runs the
  controllers.
- Back up Render PostgreSQL and both disks; they hold different state.
- Native gRPC (`https://`) does not reach this deployment. The terminal UI and the desktop app need
  an `https://` URL, so they cannot connect to it yet.
- The Gateway's webhook listeners stay on loopback, so webhook-based surfaces (GitHub, Linear,
  Microsoft Teams, Slack over HTTP) need a reverse proxy in its container. Slack Socket Mode and
  Lark long connections need none.

## Remove the deployment

Delete the Blueprint's services and database in the Render Dashboard, then confirm that both disks
and the database are gone. Deleting a service removes its disk.

## If something goes wrong

- **Verification cannot reach the Control Plane over TLS.** Check that `SUPERTAG_SERVER_CA_FILE`
  names your CA and that the certificate names the host in the `wss://` URL.
- **The health check fails.** The service must listen on port 8080, and `PORT` must stay `8080`.
- **The Gateway restarts repeatedly.** It exits when it cannot reach the Control Plane; check its
  client certificate and that the Control Plane has `SUPERTAG_TLS_CLIENT_CA_PEM`.

## Next

- [Native service deployments](../../deploy/native/README.md) for the role contract and TLS files
- [Control Plane operations](../operations/control-plane.md)
