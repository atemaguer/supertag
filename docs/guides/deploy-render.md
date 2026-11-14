# Deploy the Control Plane on Render

A **Tag** is a persistent AI actor with its own responsibilities and permissions. The **Control
Plane** is the service that stores a SuperTag organization and schedules its work; it is the one
public endpoint for operators, **Worker Hosts** (the machines that run the work), and the
optional **Gateway**, which connects **collaboration surfaces** such as Slack. This guide runs the
Control Plane on Render from a Blueprint, with Render PostgreSQL. See the
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
| `supertag-gateway` | Background worker, optional | `gateway --control-plane wss://supertag-control-plane.onrender.com` plus its connector flags | A 1 GB disk for connector state and the file credential vault |
| `supertag-postgres` | PostgreSQL | | Private network only (`ipAllowList: []`) |

## Before you start

- The `supertag` CLI, from the release you deploy (`supertag --version`). See
  [Install SuperTag](../operations/install.md).
- The `hosted` service image pushed to a registry Render can pull, with its digest. See
  [Build the hosted image](../../deploy/native/README.md#build-the-hosted-image).
- `openssl`, to issue certificates from your own CA.
- A Render workspace with billing: disks need a paid instance type, and free instances sleep.

## 1. Prepare the configuration

```sh
supertag setup deployment render --output supertag-deployment
supertag check deployment render --directory supertag-deployment
```

Setup writes `control-plane.env`, `gateway.env`, and `operator.env`, each readable only by you.
It generates the Gateway and operator tokens. It leaves out `SUPERTAG_DATABASE_URL`: the Blueprint
sets it from its own database, and setup refuses one supplied in the environment.

## 2. Create the Blueprint

1. In your copy of the repository, replace both image URLs in `deploy/render/render.yaml` with
   your hosted image by digest. For a private registry, add the registry credential to each
   service's `image` (`creds: {fromRegistryCreds: {name: ...}}`). Remove the `supertag-gateway`
   service if you use no collaboration surface or notification; otherwise give it its connector
   flags (see [Collaboration surfaces](#collaboration-surfaces)).
2. In the Render Dashboard, create a Blueprint from the repository with **Blueprint Path**
   `deploy/render/render.yaml`.
3. Read the Control Plane's hostname on the `supertag-control-plane` service page. Render
   subdomains are global, so it is `supertag-control-plane.onrender.com` only if no other service
   took that name first. This guide writes `supertag-control-plane.onrender.com`; use yours. If it
   differs, or you add a custom domain, change the Gateway's `--control-plane` URL in
   `render.yaml` to it.

The services fail their first start: they have no TLS settings yet.

## 3. Issue certificates and add the settings

Render's `onrender.com` hostname cannot carry a publicly trusted certificate for SuperTag's inner
TLS. Issue the Control Plane's certificate from your own CA for the hostname from step 2 (and any
custom domain you add), as shown in
[Issue certificates from your own CA](../../deploy/native/README.md#issue-certificates-from-your-own-ca).
Every client then trusts that CA through `SUPERTAG_SERVER_CA_FILE`. If the hostname changes later,
issue the certificate again.

The Gateway signs in as `gateway:local` with the credential setup put in `gateway.env`; the
Control Plane accepts it because `control-plane.env` holds the same value as
`SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL`. Client certificates are optional. To require them from
every caller, add `SUPERTAG_TLS_CLIENT_CA_PEM` (your CA) to the Control Plane and give the
Gateway, each operator, and each Worker Host a client certificate.

1. On `supertag-control-plane`, open **Environment**, choose **Add from .env**, and paste
   `control-plane.env`. Add `SUPERTAG_TLS_CERT_PEM` and `SUPERTAG_TLS_KEY_PEM` with the
   certificate and key.
2. On `supertag-gateway`, paste `gateway.env` and its connector settings, and add
   `SUPERTAG_SERVER_CA_PEM` (your CA).

The image entrypoint writes each `_PEM` value to a file under `/run/supertag-tls` and runs the
service as an unprivileged user. Do not set the matching `_FILE` variables yourself.

The Control Plane migrates its database when it starts. Render's health check sends
`GET /healthz` to port 8080. The tunnel listener answers that one plain request with `200 ok` and
accepts nothing else that is not a WebSocket upgrade, and it refuses any upgrade that carries an
`Origin` header, as browsers send. The health check reports only that the Control Plane process is
listening.

## 4. Verify

```sh
curl --fail https://supertag-control-plane.onrender.com/healthz
export SUPERTAG_SERVER_CA_FILE=$PWD/ca.pem
supertag verify deployment wss://supertag-control-plane.onrender.com \
  --env-file supertag-deployment/operator.env
```

If the Control Plane requires client certificates, also set `SUPERTAG_CLIENT_CERT_FILE` and
`SUPERTAG_CLIENT_KEY_FILE` to an operator's client certificate. Verification checks gRPC health
through the tunnel, that anonymous and invalid credentials are refused, and that the operator token
works. It reports readiness as `not ready` until a Worker Host connects.

## 5. Connect a Worker Host

Run operator commands with the operator token in `SUPERTAG_OPERATOR_TOKEN` and the URL in
`--control-plane`. Create an **Auth Key** (a one-time enrollment secret) for the host, then enroll
and run it on the machine that owns the **harness** (the coding agent that does the work, such as
Codex):

```sh
supertag auth-key create build-1 --role host --tag engineering \
  --control-plane wss://supertag-control-plane.onrender.com
# Save the printed key as build-1.key (mode 0600) on the Worker Host, then, with the same
# SUPERTAG_SERVER_CA_FILE (and, if the Control Plane requires client certificates, the host's own
# SUPERTAG_CLIENT_CERT_FILE and SUPERTAG_CLIENT_KEY_FILE):
supertag host enroll build-1 --control-plane wss://supertag-control-plane.onrender.com \
  --state-directory ~/.supertag-host --auth-key file:build-1.key
supertag worker-host --control-plane wss://supertag-control-plane.onrender.com \
  --state-directory ~/.supertag-host --harness codex
```

The Worker Host connects outbound and needs no inbound port.

## Collaboration surfaces

`supertag-gateway` is a background worker, which receives no inbound traffic, so it can serve only
connectors that connect outbound. Append their flags to its `dockerCommand` in `render.yaml`; with
none, it runs no connector.

- **Lark or Feishu**, over its outbound long connection:
  `--lark-state-directory /var/lib/supertag/lark`, with `SUPERTAG_LARK_ACCOUNT_ID`,
  `SUPERTAG_LARK_DOMAIN` (`lark` or `feishu`), `SUPERTAG_LARK_APP_ID`, `SUPERTAG_LARK_TENANT_KEY`,
  `SUPERTAG_LARK_BOT_OPEN_ID`, `SUPERTAG_LARK_CHAT_ID`, `SUPERTAG_LARK_TAG_ID`, and
  `SUPERTAG_LARK_ALLOWED_USERS` (comma-separated) in its environment. The app secret comes from the
  credential vault, where [`supertag setup surface lark`](../surfaces/lark.md) stores it, or from
  `SUPERTAG_LARK_APP_SECRET`.
- **Slack**, over Socket Mode: `--slack-socket-mode --slack-state-directory
  /var/lib/supertag/slack`, with `SUPERTAG_SLACK_ACCOUNT_ID`, `SUPERTAG_SLACK_TEAM_ID`,
  `SUPERTAG_SLACK_CHANNEL_ID`, `SUPERTAG_SLACK_TAG_ID`, and `SUPERTAG_SLACK_ALLOWED_USERS`
  (comma-separated) in its environment. The bot token and app-level token come from the credential vault,
  where [`supertag setup surface slack`](../surfaces/slack.md) stores them, or from
  `SUPERTAG_SLACK_BOT_TOKEN` and `SUPERTAG_SLACK_APP_TOKEN`.
- **Operator notifications to a webhook**: `--notify webhook:HTTPS_URL#NAME`, with the bearer
  secret in `SUPERTAG_NOTIFY_SECRET_NAME` (the name uppercased, `-` as `_`).

GitHub, Linear, Microsoft Teams, and Slack HTTP events need inbound webhooks, which this
deployment cannot receive. For them, run a Gateway on a host that can receive webhooks (see [service deployment definitions](../../deploy/native/README.md)), enrolled
with a gateway Auth Key (`supertag gateway enroll NAME`); it dials this Control Plane's `wss://`
URL with its own credential.

```yaml
    dockerCommand: /usr/local/bin/supertag-hosted-entrypoint gateway --listen 127.0.0.1:3436 --control-plane wss://supertag-control-plane.onrender.com --lark-state-directory /var/lib/supertag/lark
```

## Check that it worked

```sh
supertag verify deployment wss://supertag-control-plane.onrender.com \
  --env-file supertag-deployment/operator.env --require-ready
```

With the Gateway connected to Lark, mention the Tag in the Lark chat and confirm that it replies.

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
- Native gRPC (`https://`) does not reach this deployment; clients use the `wss://` URL. The
  terminal UI uses your CA when you save the Control Plane with `supertag connect --server-ca-file`;
  the desktop app trusts only the system roots, so it cannot connect to a certificate from your own
  CA.
- The Gateway is a background worker with no inbound traffic, so it serves Lark, Slack Socket
  Mode, and webhook notifications only. GitHub, Linear, Microsoft Teams, and Slack HTTP events
  need a Gateway on another host.

## Remove the deployment

Delete the Blueprint's services and database in the Render Dashboard, then confirm that both disks
and the database are gone. Deleting a service removes its disk.

## If something goes wrong

- **Verification cannot reach the Control Plane over TLS.** Check that `SUPERTAG_SERVER_CA_FILE`
  names your CA and that the certificate names the host in the `wss://` URL.
- **The health check fails.** The service must listen on port 8080, and `PORT` must stay `8080`.
- **The Gateway restarts repeatedly.** It exits when it cannot reach the Control Plane; check that
  its `SUPERTAG_GATEWAY_CREDENTIAL` matches the Control Plane's
  `SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL`, and, if the Control Plane requires client certificates,
  that the Gateway has one.

## Next

- [Service deployment definitions](../../deploy/native/README.md) for the role contract and TLS files
- [Control Plane operations](../operations/control-plane.md)
