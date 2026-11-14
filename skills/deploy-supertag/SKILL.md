---
name: deploy-supertag
description: Deploy an always-on SuperTag Control Plane for a team on Docker Compose, Fly.io, Railway, Render, Cloudflare, or Modal, with PostgreSQL, and connect Worker Hosts and teammates. Read when moving off a local single-user setup.
---

# Deploy SuperTag

Production topology: the Control Plane is the one public endpoint, for operators, Worker Hosts,
and Gateways. It stores state in PostgreSQL and terminates its own TLS. An optional Gateway
connects collaboration surfaces as a client of the Control Plane. Worker Hosts connect
**outbound** and own the harnesses, Workspaces, and MCP credentials.

```text
Slack / GitHub / Lark / Linear / Teams ──> Gateway (optional) ──┐
operators: CLI, terminal UI, desktop app ───────────────────────┤ https:// or wss://
Worker Hosts (outbound only) ───────────────────────────────────┴──> Control Plane ── PostgreSQL
```

Collaboration credentials stay with the Gateway, the database credential with the Control
Plane, and execution credentials with each Worker Host.

Install the `supertag` CLI first; see [installation](../../docs/operations/install.md). Check
[Requirements](../../docs/operations/requirements.md) for each Worker Host.

## Choose

| Platform | Clients connect with | Guide |
| --- | --- | --- |
| Docker Compose on a server | `https://` native gRPC | [Self-host SuperTag](../../docs/guides/self-hosting.md#docker-compose) |
| Fly.io | `https://` through a raw TCP service | [Fly.io](../../docs/guides/deploy-fly.md) |
| Railway | `https://` through a TCP Proxy | [Railway](../../docs/guides/deploy-railway.md) |
| Render | `wss://` WebSocket tunnel | [Render](../../docs/guides/deploy-render.md) |
| Cloudflare | `wss://` WebSocket tunnel | [Cloudflare](../../docs/guides/deploy-cloudflare.md) |
| Modal | `wss://` WebSocket tunnel | [Modal](../../docs/guides/deploy-modal.md) |

Render, Cloudflare, and Modal forward only HTTP/1.1, so the Control Plane carries gRPC in a
WebSocket and runs its own TLS inside it. Their Gateway receives no inbound traffic, so it serves
only Lark, Slack Socket Mode, and webhook notifications; webhook surfaces need a Gateway on
another host. Every
platform except Compose uses the `hosted` container image, built from a Linux `supertag` binary
as [Build the hosted image](../../deploy/native/README.md#build-the-hosted-image) shows.

## Configure, check, deploy, verify

```sh
export SUPERTAG_DATABASE_URL='postgresql://...'   # not for Compose or Render
supertag setup deployment fly --output supertag-deployment
supertag check deployment fly --directory supertag-deployment
# deploy with the platform guide, then:
supertag verify deployment https://supertag.example.com \
  --env-file supertag-deployment/operator.env
```

- **Configuration.** Setup writes `control-plane.env`, `gateway.env`, and `operator.env`, each
  mode 0600, into a new directory. It generates the Gateway credential and the admin Operator
  Token, reads other values from the environment, and prompts with masked input. It never
  accepts a secret as a flag or prints one. Upload the files through the platform's secret
  controls; do not shell-source them.
- **TLS.** The Control Plane needs a certificate for its public host name. Platform host names
  such as `*.onrender.com` need a certificate from your own CA; clients then set
  `SUPERTAG_SERVER_CA_FILE`. See [TLS files](../../deploy/native/README.md#tls-files).
- **Verification.** `verify deployment` checks gRPC health, that anonymous calls and invalid
  credentials are refused, and the operator token. `--require-ready` also requires a ready
  Worker Host. Use the `wss://` URL on Render, Cloudflare, and Modal.

## Connect operators and Worker Hosts

```sh
supertag connect https://supertag.example.com --name team
supertag auth-key create build-1 --role host --tag lead --control-plane team
```

`connect` reads the admin token from `operator.env`'s value at a masked prompt or from
`SUPERTAG_OPERATOR_TOKEN`. On each Worker Host, put the host Auth Key in a private file and add a
host service with `control-plane: https://supertag.example.com` and `auth-key: SECRET_NAME` to
`~/.supertag/supertag.yaml`, then `supertag up`. Or run
`supertag host enroll NAME --control-plane URL --state-directory DIR --auth-key file:KEY` and then
`supertag worker-host --control-plane URL --state-directory DIR --harness codex`. See
[Run Worker Hosts](../../docs/guides/workers.md).

Teammates get a client Auth Key (`--role client`) or an Operator Token
(`supertag operator-token create NAME`), and connect with `supertag connect`. Keep the admin token
with the deployment's owner.

## Non-negotiable requirements

- PostgreSQL for every shared deployment. SQLite serves one local process.
- One Control Plane process per platform service unless you follow
  [Control Plane replicas](../../deploy/native/README.md#control-plane-replicas).
- Persistent volumes for the Control Plane's transfer directory and the Gateway's state, or Vault
  for the Gateway's credentials where the platform has no persistent disk.
- A fresh database. There is no importer from the earlier TypeScript runtime; dump and check its
  database first, as
  [Retire the earlier TypeScript runtime](../../docs/operations/install.md#retire-the-earlier-typescript-runtime)
  shows.

## Health

```sh
supertag health --endpoint https://supertag.example.com
supertag verify deployment https://supertag.example.com --env-file supertag-deployment/operator.env --require-ready
supertag get host --control-plane team
```

## Ongoing

- Upgrade per [Upgrade a deployment](../../docs/operations/control-plane.md#upgrade-a-deployment).
- Back up PostgreSQL, the transfer volume, and the Gateway's volume.
- Rotate Operator Tokens before their 90-day expiry; revoke departed teammates' tokens, clients,
  and hosts.
- `supertag audit --control-plane team` lists operator changes with their actor.
