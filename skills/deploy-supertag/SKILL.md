---
name: deploy-supertag
description: Deploy an always-on SuperTag Control Plane for a team on Docker Compose, Railway, Render, Fly.io, Modal, Cloudflare, or a native service, with PostgreSQL. Read when moving off a local single-user setup.
---

# Deploy SuperTag

Production topology: the persistent Control Plane and PostgreSQL run together. A Worklet on each
Worker Host connects **outbound** to the Control Plane API Server's Worklet API; the host owns the
harnesses, workspace, and MCP credentials.

```text
Slack / GitHub / Lark / Linear / Teams
                |
  persistent Control Plane + PostgreSQL
                ^
                | authenticated outbound connection
          Worker Host
        - Worklet
        - Workers
        - Codex or Claude Code harnesses
```

This keeps collaboration credentials with the Control Plane and execution credentials with the
Worker Host. The Control Plane listener needs a reachable address for remote Worklets and any
webhook-based collaboration surfaces.

Before deploying, check [Requirements](../../docs/operations/requirements.md) for the CLI host
and each Worker Host.

## Choose

| Option | Best for | Guide |
| --- | --- | --- |
| Docker Compose | A server you operate | [Self-host](../../docs/guides/self-hosting.md) |
| Railway | Fast hosted Control Plane | [Railway](../../docs/guides/deploy-railway.md) |
| Render | Blueprint-based hosted | [Render](../../docs/guides/deploy-render.md) |
| Fly.io | Always-on Machine with attached storage | [Fly.io](../../docs/guides/deploy-fly.md) |
| Modal | Always-on Server with external storage | [Modal](../../docs/guides/deploy-modal.md) |
| Cloudflare | Container behind a routing Worker | [Cloudflare](../../docs/guides/deploy-cloudflare.md) |
| Native service | `supertag.yaml` and `supertag up`, kept running by systemd or launchd | [Self-host](../../docs/guides/self-hosting.md#native-single-host-alternative) |
| `supertag up` on a server | A machine you manage by hand, no containers | [supertag.yaml](../../docs/reference/supertag-yaml.md#a-shared-server) |

All run the same Control Plane image; its API Server accepts the same outbound Worklet connection through the Worklet API.

Docker Compose and the native option need a checkout of the repository for `deploy/compose.yaml` and
`deploy/.env.example`. You also need the CLI ([install from npm](../../docs/operations/install.md)) to manage the running
Control Plane — the checkout provides the deployment, the CLI provides management.

Every option starts the Control Plane with `supertag up`. Containers and platforms run
`supertag up --foreground control-plane`: environment variables stay their main configuration, and
an optional `supertag.yaml` mounted or baked at `/var/lib/supertag/supertag.yaml` (or passed with
`-f PATH`) adds settings that the environment still overrides. The image sets
`SUPERTAG_GATEWAY_HOST=0.0.0.0`; on hosting platforms the platform's `PORT` sets the port. In a
container `restart` and `provision` do not apply, and with `SUPERTAG_DEPLOYMENT_PLATFORM` set the
Control Plane never migrates at startup. On a machine you manage directly, `supertag up` with a
`control-plane` service in `~/.supertag/supertag.yaml` (`url`, `ports`, `database`,
`credentials`, `notify`, `logging`, `provision`, `restart: unless-stopped` for
a launchd or systemd unit) runs it; environment variables override its keys. Teammates
join with a `host` service naming the Control Plane's URL and an `auth-key` secret, then
`supertag up`; hosts connect over WebSocket at the URL, so no gRPC listener is needed.

## Non-negotiable requirements

- **PostgreSQL.** SQLite is for local development and evaluation with a single process.
- **HTTPS.** TLS is mandatory outside loopback. Never expose the raw HTTP/WebSocket port.
- **Separate authority:** `SUPERTAG_ADMIN_TOKEN` controls management and stays with the owner.
  Teammates get their own Operator Tokens (`supertag create operator-token NAME`), which can do
  everything except manage Operator Tokens and are recorded as `token:NAME`. Every Worker Host
  receives its own enrollment credential after deployment.
- **Durable credentials:** use Vault on Modal/Cloudflare, or persistent storage at
  `SUPERTAG_STATE_DIR`, mode `0700`, on volume-based platforms. The volume holds collaboration surface
  credentials; PostgreSQL holds Tags, Sessions, Tasks, and delivery state. Losing either loses
  different things — back up both. The Control Plane stores no artifact bytes: each Worker Host
  keeps the artifacts its Tasks capture in its own state directory.

Generate secrets with `openssl rand -hex 32` (24 for the PostgreSQL password). `chmod 600` any
`.env`.

Set `SUPERTAG_GATEWAY_BIND=127.0.0.1` while the Control Plane and Worklet share a machine; use `0.0.0.0`
only behind a firewall or reverse proxy.

## Shape of the deployment

1. Configure environment and generate secrets (`cp deploy/.env.example .env`).
2. Start PostgreSQL, then run migrations **explicitly** — `docker compose --env-file .env -f deploy/compose.yaml run --rm migrate`, or
   `supertag migrate database`. Safe to run again.
3. Start the Control Plane.
4. Connect the CLI once from your machine:

   ```sh
   supertag connect control-plane https://your-control-plane.example.com
   supertag status control-plane
   ```

   The admin token is read from the environment for non-interactive setup and then saved in the
   local credential store. That Control Plane becomes active, so later commands target it
   automatically. Use `--name NAME` when managing several, then `supertag use control-plane NAME` or a
   one-command `--control-plane NAME`.

5. Configure one collaboration surface and Tag. Prompts stay local; verified credentials are enrolled
   through the authenticated management API.
6. Join each Worker Host with an Auth Key: a `host` service and `supertag up`, or
   `supertag connect worklet` for scripts and containers — see
   [run-a-worker](../run-a-worker/SKILL.md).

## Health

| Endpoint | Meaning |
| --- | --- |
| `/healthz` | Process liveness |
| `/readyz` | Unavailable until a compatible Worklet connects — **expected** in remote Worklet mode |

Do not wire `/readyz` to a restart policy in remote Worklet mode; it will restart-loop whenever
no Worklet is attached.

Configure restart-on-failure and send `SIGTERM` for graceful shutdown. Collaboration surface setup and
credential rotation reconcile while the Control Plane runs — do not restart per Task.

## Known limits

**Single Control Plane instance only.** The file-backed collaboration surface secret store is attached to one
service volume, so Railway and Render run one instance. Moving collaboration surface secrets to an external
secret store is required before horizontal scaling is safe. Do not scale the Control Plane
horizontally on the current design.

Webhook-based surfaces (GitHub, Linear, Teams, Slack HTTP) need their Gateway webhook route
reachable through the proxy. Slack Socket Mode and Lark long connections do not. Check the
collaboration surface guide before exposing a route.

## Ongoing

[Control Plane operations](../../docs/operations/control-plane.md) covers backups, recovery, upgrades,
shutdown behavior, and secret boundaries. Apply migrations **before** starting a new release.
