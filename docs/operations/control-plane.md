# Control Plane operations

Run, observe, back up, and upgrade a **Control Plane**, the service that stores a SuperTag
organization and schedules its work. It is the one public API for operator clients (the CLI, the
terminal UI, the desktop app, and applications), for **Worker Hosts**, the machines that run the
work, and for **Gateways**, the services that connect collaboration surfaces such as Slack. See
the [glossary](../reference/glossary.md) for other terms, and
[Self-host SuperTag](../guides/self-hosting.md) to deploy one.

## Where it runs

| Setup | How it starts | Database |
| --- | --- | --- |
| Local | `supertag up` runs it, with a Gateway, from `~/.supertag/supertag.yaml` | SQLite at `~/.supertag/runtime.sqlite3`, or PostgreSQL from the `control-plane` service's `database` |
| Hosted | `supertag control-plane` in a container, from the files `supertag setup deployment` writes | PostgreSQL from `SUPERTAG_DATABASE_URL` |

The Control Plane creates and migrates its schema when it starts. It keeps transfer files, such
as Session checkpoints and workspace bundles, in `--transfer-directory`. It never stores artifact
bytes.

### Listeners

| Flag | Serves |
| --- | --- |
| `--listen` | Native gRPC over HTTP/2. With TLS settings it requires TLS; without them it accepts only loopback clients |
| `--websocket-listen` | The same gRPC carried in a WebSocket, for platforms that forward only HTTP/1.1. Clients use `wss://`, and the Control Plane's own TLS runs inside the tunnel. It also answers `GET /healthz` |

Listeners outside loopback require TLS: set `SUPERTAG_TLS_CERT_FILE` and `SUPERTAG_TLS_KEY_FILE`,
and `SUPERTAG_TLS_CLIENT_CA_FILE` to require client certificates. Clients trust a private
certificate authority through `SUPERTAG_SERVER_CA_FILE`, and present a client certificate through
`SUPERTAG_CLIENT_CERT_FILE` and `SUPERTAG_CLIENT_KEY_FILE`.

A Gateway, a Worker Host, and every operator client authenticate each call with their own
credential. TLS client certificates are an optional network filter in front of that
authentication. See [Identity and access](../reference/iam.md).

## Identities and access

| Principal | Credential | Issued by |
| --- | --- | --- |
| The admin operator | The admin Operator Token from setup, or this machine's local operator credential | `supertag setup deployment`, or `supertag up` |
| Another operator | A named Operator Token, `token:NAME` | `supertag operator-token create NAME` (admin only) |
| A client device | A device credential, `client:NAME`, enrolled with a client Auth Key | `supertag auth-key create NAME --role client`, then `supertag connect` |
| A Worker Host | A host credential, `host:NAME`, enrolled with a host Auth Key | `supertag auth-key create NAME --role host`, then `supertag host enroll` or `supertag up` |
| A Gateway | A Gateway credential, `gateway:NAME` | `supertag setup deployment` for `gateway:local`; otherwise a gateway Auth Key and `supertag gateway enroll` |

An **Auth Key** enrolls principals of exactly one role and never changes role. A one-time key
enrolls one principal and lasts at most an hour; `--reusable` keys last up to 90 days. `--tag`
limits a host to the Tags it may run and a client to the Tags it may talk to; `--all-tags`
removes the limit. Revoking an Auth Key stops further enrollment; principals that already joined
stay enrolled.

```sh
supertag auth-key create laptops --role host --reusable --tag lead --control-plane team
supertag get auth-key --control-plane team
supertag auth-key revoke laptops --control-plane team
```

Rotate or revoke an enrolled principal with `host rotate-credential`, `client
rotate-credential`, `gateway rotate-credential`, and the matching `revoke` commands. A revoked
credential is refused at once, and its name is never reused.

## Manage a remote Control Plane

### Connect the CLI

```sh
supertag connect https://supertag.example.com --name team
```

`connect` reads one secret from `SUPERTAG_OPERATOR_TOKEN` or a masked prompt. It saves an
Operator Token after checking it. It uses a client Auth Key (`stak_...`) to enroll this device and
saves only the device credential. Saved Control Planes live in the terminal UI's and the desktop
app's stores, so all three clients share them. For a certificate from your own CA, add
`--server-ca-file`; for a Control Plane that requires client certificates, add
`--client-cert-file` and `--client-key-file`.

A command can also name a URL directly: `--control-plane https://supertag.example.com` with
`SUPERTAG_OPERATOR_TOKEN` set.

### Give teammates Operator Tokens

```sh
supertag operator-token create laptop-2 --control-plane team
supertag operator-token rotate laptop-2 --control-plane team
supertag operator-token revoke laptop-2 --control-plane team
supertag get operator-token --control-plane team
```

Each command that issues a token prints its secret once. A token expires 90 days after it is
created or rotated. Only the admin operator manages Operator Tokens.

### Audit log

Every operator change is recorded with its actor, action, target, and outcome in the same
transaction as the change:

```sh
supertag audit --since 2026-11-01 --actor token:laptop-2 --control-plane team
```

To also stream each entry as one JSON line, start the Control Plane with `--audit-log stderr` or
`--audit-log /absolute/path`, or set `logging.audit` in `supertag.yaml`. The database keeps every
entry either way.

## Operator notifications

The operator inbox lists what needs a person:

| Kind | Waiting on |
| --- | --- |
| `question` | An Objective asked you a question |
| `budget` | An Objective's budget is used up |
| `limit` | A budget reached 80% or its limit, or a deadline is near or passed |
| `task-attention` | A Task Attempt is uncertain and needs `supertag task resolve-attempt`, or a Task needs you for another reason |
| `approval` | An action that requires approval |
| `mcp-login` | A Task is held until an MCP server is logged in on a Worker Host |

```sh
supertag get inbox-item --kind question --control-plane team
```

The Gateway tells you when the inbox gains an item. Local `supertag up` uses desktop
notifications. Choose destinations with the `control-plane` service's `notify` in
`supertag.yaml`, or the Gateway's `--notify` flag: `desktop`, `webhook:HTTPS_URL#SECRET_NAME`, or
`slack:CHANNEL_OR_USER_ID`. Send a sample with `supertag test notification`. See
[Set up operator notifications](../guides/notifications.md).

## Health and readiness

```sh
supertag health --endpoint https://supertag.example.com
supertag verify deployment https://supertag.example.com --env-file operator.env --require-ready
supertag get host --control-plane team
```

`health` checks the gRPC health service through your TLS settings. On the tunnel listener,
`GET /healthz` returns `200 ok` and only says the process is listening. Readiness means at least
one Worker Host is connected and ready; `verify deployment --require-ready` fails until then.
`supertag metrics` reports queued and running Tasks, Worker Host capacity, recovery decisions, and
backlogs.

## Artifact storage

An artifact is saved output from a Task, such as a report or a file. The Control Plane keeps only
its catalog: identity, provenance, access rules, and where each copy lives. The bytes stay on the
Worker Host that captured them, in its state directory, or on a Volume the host maps. Back up the
state directory of every Worker Host whose artifacts you need. See [Artifacts](../reference/artifacts.md).

## Replicas

Several Control Plane processes can share one PostgreSQL database and one transfer directory on a
shared volume. Put them behind one TCP load balancer or private DNS name, keep their clocks in
sync, and run the same release on all of them. A SQLite database serves one process. See
[Control Plane replicas](../../deploy/native/README.md#control-plane-replicas).

## Back up

- **PostgreSQL**: back it up with your provider's backups or `pg_dump`, and back up the transfer
  directory's volume with it.
- **Local SQLite**: stop the services with `supertag down`, then copy `~/.supertag`. Copying a
  running database can capture a torn write.
- **Gateway**: back up its volume, which holds the file credential vault and connector state, or
  use HashiCorp Vault.

## Upgrade a deployment

1. Back up the database and volumes.
2. Drain Worker Hosts with `supertag host drain NAME` and wait for running Task Attempts.
3. Stop every Control Plane replica when the release changes the schema.
4. Deploy the new image, then the Gateway. The Control Plane migrates on start.
5. Upgrade the CLI on operator machines and Worker Hosts, then `supertag host resume NAME`.
6. Run `supertag verify deployment URL --env-file operator.env --require-ready`.

Clients negotiate a protocol version on every connection and refuse a Control Plane that speaks
none of theirs, so upgrade clients and the Control Plane together.

## Network and secret boundaries

- Keep the admin token with the deployment's owner. Give each teammate their own client device or
  Operator Token, and each Worker Host its own credential.
- Never put credentials in command-line flags, images, prompts, or manifests. Setup reads secrets
  from the environment or a masked prompt and writes them only to owner-only files.
- Only the Control Plane holds the database credential. Only the Gateway holds collaboration
  surface credentials. Harness and MCP credentials stay on Worker Hosts.
- A Worker Host connects outbound and needs no inbound port.

See [Credential storage](../reference/credential-storage.md).
