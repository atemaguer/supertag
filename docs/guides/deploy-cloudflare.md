# Deploy the Control Plane on Cloudflare

A **Tag** is a persistent AI actor with its own responsibilities and permissions. The **Control
Plane** is the service that stores a SuperTag organization and schedules its work; it is the one
public endpoint for operators, **Worker Hosts** (the machines that run the work), and the
optional **Gateway**, which connects **collaboration surfaces** such as Slack. This guide runs the
Control Plane in a Cloudflare Container behind a Worker, with external PostgreSQL. See the
[glossary](../reference/glossary.md) for other terms.

A Worker forwards only HTTP to a Container, so the Control Plane carries its gRPC API inside a
WebSocket, the **tunnel**, and runs SuperTag's own TLS end to end inside it. Clients use a
`wss://` URL. Cloudflare sees only ciphertext.

```text
operators, Worker Hosts ── wss:// ──> Worker ──> Durable Object ──> Container, port 8080
                                                                     Control Plane
                                                                     Gateway (optional)
                                                                       │
                                                       external PostgreSQL, HashiCorp Vault
```

[`deploy/cloudflare`](../../deploy/cloudflare/README.md) holds:

| File | Role |
| --- | --- |
| [`wrangler.json`](../../deploy/cloudflare/wrangler.json) | One Container instance (`max_instances: 1`), its Durable Object, a cron trigger every minute, `SUPERTAG_GATEWAY` (`off` or `on`), and `SUPERTAG_GATEWAY_FLAGS` |
| [`src/routing.ts`](../../deploy/cloudflare/src/routing.ts) | What the Worker forwards (WebSocket upgrades and `GET /healthz`), the container commands, and the settings passed into the container |
| [`src/index.ts`](../../deploy/cloudflare/src/index.ts) | The Worker and the Container class |
| [`Dockerfile`](../../deploy/cloudflare/Dockerfile) | The Container image: the hosted image tagged `supertag-hosted:local` |

Cloudflare gives containers no network to each other, so the Gateway, when on, runs in the same
container as the Control Plane and reaches it on `https://127.0.0.1:3434`. The Gateway is not
given the database URL, the operator token, or the Control Plane's TLS settings, and the Control
Plane is not given the surface settings. Both run as one user in one container, though, so either
could read the other's files, including the TLS key: they share one trust boundary. When either
exits, the container stops, and the next request or cron run starts it again.

## Before you start

- The `supertag` CLI, from the release you deploy (`supertag --version`). See
  [Install SuperTag](../operations/install.md).
- The Workers Paid plan, which Containers require, and Wrangler authenticated with your account.
- Docker, and the `hosted` service image for `linux/amd64` (see
  [Build the hosted image](../../deploy/native/README.md#build-the-hosted-image)), tagged locally:
  `docker tag IMAGE@sha256:DIGEST supertag-hosted:local`.
- A PostgreSQL database reachable from the internet with TLS, and HashiCorp Vault (KV v2) for the
  Gateway's connector credentials. A Container's disk does not survive a restart, so setup
  requires Vault.
- `openssl`, to issue certificates from your own CA.

## 1. Issue certificates

The `workers.dev` hostname cannot carry a publicly trusted certificate for SuperTag's inner TLS.
Issue the Control Plane's certificate from your own CA for `supertag.YOUR-SUBDOMAIN.workers.dev`
(or your custom domain) and `IP:127.0.0.1`, as shown in
[Issue certificates from your own CA](../../deploy/native/README.md#issue-certificates-from-your-own-ca).
Every client then trusts that CA through `SUPERTAG_SERVER_CA_FILE`.

The Gateway signs in as `gateway:local` with the credential setup put in `gateway.env`; the
Control Plane accepts it because `control-plane.env` holds the same value as
`SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL`. Client certificates are optional. To require them from
every caller, add `SUPERTAG_TLS_CLIENT_CA_PEM` (your CA) to the Control Plane and give the
Gateway, each operator, and each Worker Host a client certificate.

## 2. Prepare the configuration

```sh
export SUPERTAG_DATABASE_URL='postgresql://...?sslmode=require'
export VAULT_ADDR=https://vault.example.com VAULT_TOKEN=...
supertag setup deployment cloudflare --output supertag-deployment
supertag check deployment cloudflare --directory supertag-deployment
```

Setup writes `control-plane.env`, `gateway.env`, and `operator.env`, each readable only by you,
and generates the Gateway's credential and the operator token.

## 3. Upload secrets and deploy

From `deploy/cloudflare`:

```sh
npm ci
npx wrangler secret bulk ../../supertag-deployment/control-plane.env
npx wrangler secret put SUPERTAG_TLS_CERT_PEM < server.pem
npx wrangler secret put SUPERTAG_TLS_KEY_PEM < server.key
npx wrangler deploy
```

With the Gateway on, set `"SUPERTAG_GATEWAY": "on"` and `SUPERTAG_GATEWAY_FLAGS` in
`wrangler.json` (see [Collaboration surfaces](#collaboration-surfaces)), and also upload
`gateway.env` and the connector settings with `wrangler secret bulk`, and
`SUPERTAG_SERVER_CA_PEM` (your CA). The Worker passes only the deployment
settings, these PEM values, and settings named `SUPERTAG_LARK_*`, `SUPERTAG_SLACK_*`, or
`SUPERTAG_NOTIFY_SECRET_*` into the container; the image entrypoint writes each PEM value to a file and runs the services as
an unprivileged user.

`wrangler deploy` builds the image from `supertag-hosted:local` and pushes it to Cloudflare's
registry. The Worker forwards WebSocket upgrades on any path and `GET /healthz` unchanged,
including any `Origin` header, which the Control Plane refuses. It answers every other request
with `426` and removes any request header that would choose another container port.

## 4. Verify

```sh
curl --fail https://supertag.YOUR-SUBDOMAIN.workers.dev/healthz
export SUPERTAG_SERVER_CA_FILE=$PWD/ca.pem
supertag verify deployment wss://supertag.YOUR-SUBDOMAIN.workers.dev \
  --env-file supertag-deployment/operator.env
```

If the Control Plane requires client certificates, also set `SUPERTAG_CLIENT_CERT_FILE` and
`SUPERTAG_CLIENT_KEY_FILE` to an operator's client certificate. Readiness reads `not ready` until a
Worker Host connects.

## 5. Connect a Worker Host

Create an **Auth Key** (a one-time enrollment secret) for the host, then enroll and run it on the
machine that owns the **harness** (the coding agent that does the work, such as Codex):

```sh
supertag auth-key create build-1 --role host --tag engineering \
  --control-plane wss://supertag.YOUR-SUBDOMAIN.workers.dev
# Save the printed key as build-1.key (mode 0600) on the Worker Host, then, with the same
# SUPERTAG_SERVER_CA_FILE (and, if the Control Plane requires client certificates, the host's own
# SUPERTAG_CLIENT_CERT_FILE and SUPERTAG_CLIENT_KEY_FILE):
supertag host enroll build-1 --control-plane wss://supertag.YOUR-SUBDOMAIN.workers.dev \
  --state-directory ~/.supertag-host --auth-key file:build-1.key
supertag worker-host --control-plane wss://supertag.YOUR-SUBDOMAIN.workers.dev \
  --state-directory ~/.supertag-host --harness codex
```

Operator commands read the operator token from `SUPERTAG_OPERATOR_TOKEN`. The Worker Host
connects outbound and needs no inbound port.

## Collaboration surfaces

The Worker forwards only the Control Plane's tunnel, so the Gateway can serve only connectors that
connect outbound. Name them in `SUPERTAG_GATEWAY_FLAGS`, separated by spaces; the Worker refuses to
start the Gateway without one.

- **Lark or Feishu**, over its outbound long connection:
  `--lark-state-directory /var/lib/supertag/lark`, with `SUPERTAG_LARK_ACCOUNT_ID`,
  `SUPERTAG_LARK_DOMAIN` (`lark` or `feishu`), `SUPERTAG_LARK_APP_ID`, `SUPERTAG_LARK_TENANT_KEY`,
  `SUPERTAG_LARK_BOT_OPEN_ID`, `SUPERTAG_LARK_CHAT_ID`, `SUPERTAG_LARK_TAG_ID`, and
  `SUPERTAG_LARK_ALLOWED_USERS` (comma-separated) as Worker secrets. The app secret comes from the
  credential vault, where [`supertag setup surface lark`](../surfaces/lark.md) stores it, or from
  `SUPERTAG_LARK_APP_SECRET`. The container's disk does not survive a restart, so the
  reply receipts in the state directory do not either.
- **Slack**, over Socket Mode: `--slack-socket-mode --slack-state-directory
  /var/lib/supertag/slack`, with `SUPERTAG_SLACK_ACCOUNT_ID`, `SUPERTAG_SLACK_TEAM_ID`,
  `SUPERTAG_SLACK_CHANNEL_ID`, `SUPERTAG_SLACK_TAG_ID`, and `SUPERTAG_SLACK_ALLOWED_USERS`
  (comma-separated) as Worker secrets. The bot token and app-level token come from the credential vault,
  where [`supertag setup surface slack`](../surfaces/slack.md) stores them, or from
  `SUPERTAG_SLACK_BOT_TOKEN` and `SUPERTAG_SLACK_APP_TOKEN`.
- **Operator notifications to a webhook**: `--notify webhook:HTTPS_URL#NAME`, with the bearer
  secret in `SUPERTAG_NOTIFY_SECRET_NAME` (the name uppercased, `-` as `_`).

GitHub, Linear, Microsoft Teams, and Slack HTTP events need inbound webhooks, which this
deployment cannot receive. For them, run a Gateway on a host that can receive webhooks (see [service deployment definitions](../../deploy/native/README.md)), enrolled
with a gateway Auth Key (`supertag gateway enroll NAME`); it dials this Control Plane's `wss://`
URL with its own credential.

```json
"vars": {
  "SUPERTAG_GATEWAY": "on",
  "SUPERTAG_GATEWAY_FLAGS": "--lark-state-directory /var/lib/supertag/lark"
}
```

## Check that it worked

```sh
supertag verify deployment wss://supertag.YOUR-SUBDOMAIN.workers.dev \
  --env-file supertag-deployment/operator.env --require-ready
```

With the Gateway connected to Lark, mention the Tag in the Lark chat and confirm that it replies.

## Cold starts and restarts

- The container starts on the first request or the next cron run, whichever comes first. The
  first start pulls the image and migrates the database; opening a tunnel waits up to 30 seconds,
  and Worker Hosts retry after that.
- Open tunnels keep the container awake, and the cron trigger renews it every minute, so the
  Control Plane's controllers keep running with no client connected. The container sleeps after
  ten minutes only if the cron trigger stops.
- Cloudflare restarts containers on deploys and host maintenance. Tunnels drop, and Worker Hosts
  and the Gateway reconnect.
- Both ends of a tunnel ping every 20 seconds, within Cloudflare's 100-second idle limit.

## Limits

- One container. Every Control Plane runs the controllers, so do not raise `max_instances`.
- Transfer files (Session checkpoints, workspace bundles, and GitHub publication blobs) live on the
  container's temporary disk and are lost on restart. Work whose transfer was in progress must be
  retried. - Native gRPC (`https://`) does not reach this deployment; clients use the `wss://` URL.
  The terminal UI uses your CA when you save the Control Plane with `supertag connect
  --server-ca-file`; the desktop app trusts only the system roots, so it cannot connect to a
  certificate from your own CA.
- The Worker forwards no webhook routes, so the Gateway here serves Lark, Slack Socket Mode, and
  webhook notifications only. GitHub, Linear, Microsoft Teams, and Slack HTTP events need a
  Gateway on another host.
- `wrangler dev` runs this Worker locally only where Docker supports Wrangler's egress proxy
  container.

## Remove the deployment

```sh
npx wrangler delete
npx wrangler containers list   # confirm the instances are gone
npx wrangler containers images list   # then delete the pushed image
```

Then delete the database and the Vault path if they were dedicated to this deployment.

## If something goes wrong

- **`/healthz` returns `500 Failed to start container`.** Check the container logs in the
  Cloudflare dashboard. A missing secret or an unreachable database stops the Control Plane.
- **Verification cannot reach the Control Plane over TLS.** Check `SUPERTAG_SERVER_CA_FILE` and
  that the certificate names the host in the `wss://` URL.
- **The container restarts repeatedly with the Gateway on.** The container exits when either
  service exits; check the Gateway's credential (`SUPERTAG_GATEWAY_CREDENTIAL` must match
  `SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL`), its connector settings, and that the certificate names
  `IP:127.0.0.1`.

## Next

- [Service deployment definitions](../../deploy/native/README.md) for the role contract and TLS files
- [Control Plane operations](../operations/control-plane.md)
