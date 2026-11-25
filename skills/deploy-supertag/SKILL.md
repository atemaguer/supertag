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
operators: CLI, desktop app ───────────────────────────────────┤ https:// or wss://
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
| Modal | `wss://` WebSocket tunnel | [Modal](../../docs/guides/deploy-modal.md), with `supertag deploy` |

Render, Cloudflare, and Modal forward only HTTP/1.1, so the Control Plane carries gRPC in a
WebSocket and runs its own TLS inside it. Their Gateway receives no inbound traffic, so it serves
only Lark, Slack Socket Mode, and webhook notifications; webhook surfaces need a Gateway on
another host. Every
platform except Compose uses the `hosted` container image. Each release publishes it for
`linux/amd64` as `ghcr.io/atemaguer/supertag-hosted`; build it for another architecture, or from
your own binary, as
[Build the hosted image](../../deploy/native/README.md#build-the-hosted-image) shows.

## Deploy on Modal with one command

```sh
supertag deploy init modal      # writes supertag-deploy.yaml, which holds no secret
export SUPERTAG_DATABASE_URL='postgresql://...?sslmode=require'   # first deploy only
supertag deploy
```

- **One file, no secrets.** `supertag-deploy.yaml` names the target, the release or image, the
  Gateway's connector flags, and non-secret settings. Commit it and the
  `supertag-deploy-ca.pem` deploy writes beside it.
  [supertag-deploy.yaml](../../docs/reference/supertag-deploy-yaml.md) lists every key.
- **Secrets stay on the platform.** The first deploy generates the admin Operator Token and the
  Gateway's credential straight into Modal secrets and issues the Control Plane's certificate.
  Later deploys create only what is missing and never replace a secret. Change one with
  `supertag deploy secret set NAME` (value from standard input), `secret unset NAME`, or, for
  surface, Workspace, and Volume credentials, `secret push`; then deploy again.
- **Deploy waits and verifies.** It waits for `/healthz`, runs `verify deployment`'s checks,
  prints the `wss://` URL and the next commands, and saves the deployment for the CLI under the
  app's name (`--gateway supertag`).
- **Check first.** `supertag deploy check` says whether this machine can deploy and lists every
  problem, one per line; `supertag deploy --dry-run` prints the full plan. Neither changes
  anything. `supertag deploy status` asks the target what runs now: deployed or not, endpoint,
  health, release, secret names, and whether the CA file matches.
- **CI.** The same command with `--non-interactive`, `MODAL_TOKEN_ID`, and `MODAL_TOKEN_SECRET`,
  after a first deploy from a laptop; `--dry-run` on pull requests. `SUPERTAG_OPERATOR_TOKEN` is
  optional there.
- **Don't** put a secret in `supertag-deploy.yaml` or its `env` map, and don't delete
  `supertag-deploy-ca.pem`: clients and Worker Hosts trust the deployment through it
  (`SUPERTAG_SERVER_CA_FILE`). `--renew-certificate` replaces it for everyone.

## Configure, check, deploy, verify

The other platforms, and Modal by hand:

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
- **Data endpoint.** To carry Task Attempts' events and streamed text through the Gateway, set
  `SUPERTAG_DATA_ENDPOINT` on the Control Plane to the Gateway's `https://` or `wss://` URL, and
  make that URL reachable from every Worker Host. Workers then use only the Gateway for those
  calls, with no fallback; when that URL is unreachable, each Worker logs `the data endpoint URL is
  unreachable`. Unset, Workers send them to the Control Plane.
- **Verification.** `verify deployment` checks gRPC health, that anonymous calls and invalid
  credentials are refused, and the operator token. `--require-ready` also requires a ready
  Worker Host. Use the `wss://` URL on Render, Cloudflare, and Modal.

## Connect operators and Worker Hosts

```sh
supertag connect https://supertag.example.com --name team
supertag auth-key create build-1 --role host --tag lead --gateway team
```

`connect` reads the admin token from `operator.env`'s value at a masked prompt or from
`SUPERTAG_OPERATOR_TOKEN`. On each Worker Host, put the host Auth Key in a private file and add a
host service with `control-plane: https://supertag.example.com` and `auth-key: SECRET_NAME` to
`~/.supertag/supertag.yaml`, then `supertag up`. Or run
`supertag host enroll NAME --control-plane URL --state-directory DIR --auth-key file:KEY` and then
`supertag worklet --control-plane URL --state-directory DIR --harness codex`. See
[Run Worker Hosts](../../docs/guides/workers.md).

Teammates get an invite key (`supertag user invite NAME`) or an Operator Token
(`supertag operator-token create NAME`), and connect with `supertag connect`. Keep the admin token
with the deployment's owner.

## Non-negotiable requirements

- PostgreSQL for every shared deployment. SQLite serves one local process.
- One Control Plane process per platform service unless you follow
  [Control Plane replicas](../../deploy/native/README.md#control-plane-replicas).
- A persistent volume for the Gateway's state. Where the platform has no persistent disk
  (Cloudflare, Modal), the services read credentials from the platform's own secrets by default:
  store them with `SUPERTAG_CREDENTIAL_FILE` naming the deployment directory's
  `gateway-credentials.json`, run `supertag gateway credential export`, upload both service
  files, and redeploy. With `supertag deploy`, name the file deploy prints instead and run
  `supertag deploy secret push`, then `supertag deploy`. HashiCorp Vault is optional
  (`--credential-vault vault`, or `credential-vault: vault` in `supertag-deploy.yaml`).
- Persistent state directories for Worker Hosts. The Control Plane stores no artifact or
  Workspace delivery bytes and relays none: each Worker Host keeps what its Tasks produce, or its
  Worklet writes it to a shared Volume or pushes deliveries to the Workspace's git remote. Files on an
  ephemeral host without a Volume or a remote Workspace are lost with it.

## Health

```sh
supertag health --endpoint https://supertag.example.com
supertag verify deployment https://supertag.example.com --env-file supertag-deployment/operator.env --require-ready
supertag get host --gateway team
```

## Ongoing

- Upgrade per [Upgrade a deployment](../../docs/operations/control-plane.md#upgrade-a-deployment).
- Back up PostgreSQL, each Worker Host's artifact storage (artifacts, deliveries, and Session
  checkpoints), and the Gateway's volume.
- Rotate Operator Tokens before their 90-day expiry; revoke departed teammates' tokens, clients,
  and hosts.
- `supertag audit --gateway team` lists operator changes with their actor.
