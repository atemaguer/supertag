# Control Plane operations

Run, observe, back up, and upgrade a **Control Plane**, the service that stores a SuperTag
organization and schedules its work. Its API serves the Worklets of **Worker Hosts**, the
machines that run the work, and **Gateways**, the services that clients (the CLI, the terminal
UI, the desktop app, and applications) connect to and that connect collaboration surfaces such as
Slack. See
the [glossary](../reference/glossary.md) for other terms, and
[Self-host SuperTag](../guides/self-hosting.md) to deploy one.

## Where it runs

| Setup | How it starts | Database |
| --- | --- | --- |
| Local | `supertag up` runs it, with a Gateway, from `~/.supertag/supertag.yaml` | SQLite at `~/.supertag/runtime.sqlite3`, or PostgreSQL from the `control-plane` service's `database` |
| Hosted | `supertag control-plane` in a container, from the files `supertag setup deployment` writes | PostgreSQL from `SUPERTAG_DATABASE_URL` |

The Control Plane reads Schedule times that name no time zone in its own time zone: the
`control-plane` service's `time-zone` in `supertag.yaml`, which `supertag init` sets to the
machine's, or `SUPERTAG_TIME_ZONE` for a hosted Control Plane. Each is an IANA name such as
`Europe/Berlin`. Without either, it uses the machine's time zone, or UTC when that is unknown.

A Gateway can carry the data calls of running [Task Attempts](../reference/glossary.md#task-attempt), such as their events and streamed
text. Set `SUPERTAG_DATA_ENDPOINT` to that Gateway's URL (`https://`, `wss://`, or a loopback
`http://` or `ws://`). The Control Plane refuses to start with any other form. It names the URL to
each Worker Host when the host registers, and that host's Workers send every data call there and
nowhere else. Every Worker Host must then reach the Gateway at that URL, with the same TLS trust it
uses for the Control Plane. Without the variable, Workers send these calls to the Control Plane
URL their Worklet uses. `supertag up` sets it to the local Gateway unless the process
environment or the `control-plane` service's `env_file` names another.

The Control Plane creates and migrates its schema when it starts. It stores no files: Session
checkpoints stay on the Worker Host that wrote them, artifacts on the Worker Host that produced
them or a Volume, and Workspace deliveries in the Workspace's git remote or the host's
repository. No file passes through the Control Plane.

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
removes the limit. On a host key, `--label` gives every host that joins a placement label that a
Tag's `runsOn` can select. Revoking an Auth Key stops further enrollment; principals that already
joined stay enrolled.

```sh
supertag auth-key create laptops --role host --reusable --tag lead --gateway team
supertag get auth-key --gateway team
supertag auth-key revoke laptops --gateway team
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
saves only the device credential. It saves the Control Plane in the CLI's store; commands also read the
names the desktop app saves. For a certificate from your own CA, add
`--server-ca-file`; for a Control Plane that requires client certificates, add
`--client-cert-file` and `--client-key-file`.

A command can also name a URL directly: `--gateway https://supertag.example.com` with
`SUPERTAG_OPERATOR_TOKEN` set.

### Give teammates Operator Tokens

```sh
supertag operator-token create laptop-2 --gateway team
supertag operator-token rotate laptop-2 --gateway team
supertag operator-token revoke laptop-2 --gateway team
supertag get operator-token --gateway team
```

Each command that issues a token prints its secret once. A token expires 90 days after it is
created or rotated. Only the admin operator manages Operator Tokens.

### Audit log

Every operator change is recorded with its actor, action, target, and outcome in the same
transaction as the change:

```sh
supertag audit --since 2026-11-01 --actor token:laptop-2 --gateway team
```

The JSON-lines audit stream is off unless you configure it. To stream each entry as one JSON
line, start the Control Plane with `--audit-log stderr` or `--audit-log /absolute/path`, or set
`logging.audit` in `supertag.yaml`. Without it, standard error carries only the service log that
`supertag logs` shows. The database keeps every entry either way.

## Operator notifications

The operator inbox lists what needs a person:

| Kind | Waiting on |
| --- | --- |
| `question` | An Objective asked you a question |
| `budget` | An Objective's budget is used up |
| `limit` | A budget reached 80% or its limit, or a deadline is near or passed |
| `task-attention` | A Task Attempt of any Task, a conversation turn included, is uncertain and needs `supertag task resolve-attempt`, or a Task needs you for another reason |
| `approval` | An action that requires approval |
| `mcp-login` | A Task is held until an MCP server is logged in on a Worker Host |

```sh
supertag get inbox-item --kind question --gateway team
supertag watch inbox-item --gateway team
```

`watch inbox-item` prints every item already waiting, then each new item once as it appears,
until you stop it. It takes `--objective ID`, `--kind KIND`, `--limit N`, and `--output json`.

The Gateway tells you when the inbox gains an item. Choose destinations with the
`control-plane` service's `notify` in `supertag.yaml`, or the Gateway's `--notify` flag:
`webhook:HTTPS_URL#SECRET_NAME` or `slack:CHANNEL_OR_USER_ID`. The desktop app and the terminal
UI notify on their own device without one. Send a sample with `supertag test notification`. See
[Set up operator notifications](../guides/notifications.md).

## Health and readiness

```sh
supertag health --endpoint https://supertag.example.com
supertag verify deployment https://supertag.example.com --env-file operator.env --require-ready
supertag get host --gateway team
```

`health` checks the gRPC health service through your TLS settings. On the tunnel listener,
`GET /healthz` returns `200 ok` and only says the process is listening. Readiness means at least
one Worker Host is connected and ready; `verify deployment --require-ready` fails until then.
`supertag metrics` reports queued and running Tasks, Worker Host capacity, recovery decisions, and
backlogs. For the last 500 started Task Attempts it shows the median and longest time from start
until the Workspace was ready, the harness adapter attached, and the harness's first event, so you
can see where the wait before a model's first token goes, and the time from the harness finishing
to the Worklet reporting the result (`finalization`: Workspace capture, delivery, checkpoint,
and outputs). The Control Plane stamps each point by its own clock; a Worklet reports when the
Workspace was ready, when the adapter attached, and when the harness finished, best-effort, so a
Task Attempt may lack them. It also reports how long the Control Plane process that answered took to admit each
collaboration surface's events since it started: admitted and failed calls, average and longest
time, and how many took over 2 seconds, the shortest acknowledgement deadline a Gateway has. Each
replica counts only the events it served.

## Artifact storage

An artifact is saved output from a Task, such as a report or a file. The Control Plane keeps its
catalog in the database and never stores its files. The Worklet on the Worker Host whose Task captured them
keeps them. A Task on the same host, or on a host sharing its artifact storage, reads them there; a Task
on another host reads them directly from a host run with `--artifact-transfer-listen`. Clients
can't download artifacts. For copies that outlive the host, give a
Tag a `volume`: the capturing host's Worklet writes each copy there itself. The Control Plane maps no
Volume; for an S3 Volume it only signs, with the credential `supertag volume credential set`
stores in its credential vault on this machine. See
[Keep every capture on a Volume](../reference/artifacts.md#keep-every-capture-on-a-volume).
Workspace deliveries stay on the Worker Host that ran the Task: its Worklet writes or pushes each
Session branch itself. See
[Artifacts](../reference/artifacts.md).

## Replicas

Several Control Plane processes can share one PostgreSQL database. Put them behind one TCP load balancer or private DNS name, keep their clocks in
sync, and run the same release on all of them. No replica relays artifacts or Workspace
deliveries. Every replica signs S3 Volume URLs with the same
vault credential, so give the replicas one credential vault. A SQLite database serves one process. See
[Control Plane replicas](../../deploy/native/README.md#control-plane-replicas).

Clients follow conversations and changes with streams, and any replica may serve them. While a
replica serves at least one stream, it keeps one PostgreSQL connection of its own, outside its
pool of 8, and listens there with `LISTEN` for the commits of other replicas. Every committed write
that changes what streams show sends a `NOTIFY` that carries no content; each listening replica
then reads the change from the database. So a message written through one replica reaches a
client of another at once.

The listener needs a direct connection, or a pooler that keeps one server connection per client
connection:

| The database URL points at | Session limits | Changes from other replicas |
| --- | --- | --- |
| PostgreSQL directly | Kept | Pushed at once |
| A session-mode pooler, such as PgBouncer with `pool_mode = session` | Kept | Pushed at once |
| A transaction-mode pooler, such as PgBouncer with `pool_mode = transaction` | Dropped | Up to a second late: notifications don't arrive |

Allow each replica 9 connections: its pool and the listener, which names itself `supertag-hints`
in `pg_stat_activity`. A lost notification costs no data. Each replica reads the feed every second
anyway, and reconnects a dropped listener with backoff, so streams catch up within about a second.

Streamed reply text, shown while a Tag writes, is held only in the memory of the replica that
received it, and reaches only the clients of that replica. Clients of other replicas see the
message when it is recorded.

## Back up

- **PostgreSQL**: back it up with your provider's backups or `pg_dump`. Back up each Worker Host's
  artifact storage too: it holds the host's artifacts, deliveries, and Session checkpoints.
- **Local SQLite**: stop the Control Plane first, with `supertag down`, then copy `~/.supertag`.
  Copying a running database can capture a torn write. The database commits through a
  write-ahead log: a clean stop folds it into the database file, and any `-wal` file left beside
  it belongs in the copy, which copying the whole directory does. A database from an earlier
  release switches to the write-ahead log the first time the Control Plane opens it.
- **Gateway**: back up its volume, which holds the file credential vault and connector state, or
  use HashiCorp Vault. A deployment that reads credentials from its environment keeps them in
  the deployment directory on your machine and in the platform's secrets; back up the directory.

## Upgrade a deployment

1. Back up the database and volumes.
2. Drain Worker Hosts with `supertag host drain NAME` and wait for running Task Attempts.
3. Stop every Control Plane replica when the release changes the schema.
4. Deploy the new image, then the Gateway. The Control Plane migrates on start.
5. Upgrade the CLI on operator machines and Worker Hosts, then `supertag host resume NAME`.
6. Run `supertag verify deployment URL --env-file operator.env --require-ready`.

Clients and Worklets negotiate a protocol version on every connection and refuse a Control Plane
that speaks none of theirs, so upgrade them and the Control Plane together. A Worklet from 0.3.2
speaks protocol 6 and cannot connect to a Control Plane that speaks protocol 7, so drain those
Worker Hosts before the upgrade.

## Network and secret boundaries

- Keep the admin token with the deployment's owner. Give each teammate their own client device or
  Operator Token, and each Worker Host its own credential.
- Never put credentials in command-line flags, images, prompts, or manifests. Setup reads secrets
  from the environment or a masked prompt and writes them only to owner-only files.
- Only the Control Plane holds the database credential. Only the Gateway holds collaboration
  surface credentials. Harness and MCP credentials stay on Worker Hosts.
- A Worker Host's Worklet connects outbound and needs no inbound port.

See [Credential storage](../reference/credential-storage.md).
