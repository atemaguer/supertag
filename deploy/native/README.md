# Native service deployments

Definitions for the native SuperTag services. These are separate from the TypeScript Control
Plane definitions in the parent directory, which stay until the cutover.

A deployment runs these roles:

| Role | Reachability | State |
| --- | --- | --- |
| Control Plane | Public native gRPC with its own TLS certificate, container port 3434 | PostgreSQL, and a volume at `/var/lib/supertag` for transfers |
| Gateway (optional) | No public listener: connects to the Control Plane as a client | Volume at `/var/lib/supertag`: the file credential vault and connector state |
| Worker Hosts | Outbound only: each connects to the Control Plane | The host's own state directory |

The Control Plane is the one public endpoint, for operators, Worker Hosts, and Gateways. It
terminates TLS itself and speaks gRPC over HTTP/2, so a platform must pass raw TCP to it (TLS
passthrough). A platform whose ingress terminates TLS and forwards only HTTP/1.1 reaches it
through the [WebSocket tunnel](#websocket-tunnel-for-http-only-platforms) instead.

Inside, the Control Plane is a stateless API tier in front of the state owner and its
controllers, in one process. The API tier keeps only transfer files (Session checkpoints,
workspace bundles, and GitHub publication blobs) in `--transfer-directory`. Run exactly one
Control Plane per database: every process also runs the controllers, and API replicas without
them are not supported yet. Artifact bytes are never stored in the database: they stay on Worker
Hosts and shared Volumes.

The Gateway runs collaboration surfaces: Slack, GitHub, Linear, Lark, and Microsoft Teams
ingress, reply delivery, and operator notifications. Deploy it only when you use a surface or
notification. Its webhook listeners are loopback only, so put a reverse proxy for them in the
same container or host. Its own gRPC listener serves only `supertag test notification`, on
loopback inside its container. It holds no operator credential.

Every caller authenticates with its own credential, and the Control Plane checks each call
against one table of roles. The deployment's Gateway is `gateway:local`: setup gives the Control
Plane `SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL` and the Gateway the same value as
`SUPERTAG_GATEWAY_CREDENTIAL`. It may call only the surface services, for the Surface Accounts
that name it (`gateway: local`). It is trusted with every Tag, so it also delivers operator
notifications. To add another Gateway, create a gateway Auth Key and enroll it with
`supertag gateway enroll NAME`. Add `--all-tags` to the key only for a Gateway that delivers
operator notifications or serves accounts no Surface Account names. No Auth Key enrolls a host or
Gateway named `local`.

| Platform | Definitions | Public Control Plane path | Gateway to Control Plane |
| --- | --- | --- | --- |
| Docker Compose | [`../compose.native.yaml`](../compose.native.yaml), [`../compose.native.ingress.yaml`](../compose.native.ingress.yaml) | Published port on the Control Plane only | Internal Compose network, `control-plane:3434` |
| Fly.io | [`fly/control-plane.toml`](fly/control-plane.toml), [`fly/gateway.toml`](fly/gateway.toml) | TCP service on 443 with `handlers = []` | 6PN, `supertag-control-plane.internal:3434` |
| Railway | [`railway/control-plane.json`](railway/control-plane.json), [`railway/gateway.json`](railway/gateway.json) | TCP Proxy to port 3434 | Private network, `supertag-control-plane.railway.internal:3434` |

Render, Cloudflare, and Modal forward only HTTP and need the WebSocket tunnel; their definitions
are not written yet. See [Platforms behind an HTTP proxy](#platforms-behind-an-http-proxy).

## Configure, check, and verify

```sh
export SUPERTAG_DATABASE_URL='postgresql://...'   # not needed for Compose
supertag setup deployment fly --output supertag-deployment
supertag check deployment fly --directory supertag-deployment
# deploy, then:
SUPERTAG_SERVER_CA_FILE=ca.pem supertag verify deployment https://supertag.example.com \
  --env-file supertag-deployment/operator.env --require-ready
```

Setup writes a new private directory and never replaces one. Each file is mode 0600:

| File | For | Holds |
| --- | --- | --- |
| `control-plane.env` | Control Plane | Database URL, the Gateway's bootstrap credential, operator token, state directory |
| `gateway.env` | Gateway | Its enrolled credential, state directory, credential vault settings |
| `operator.env` | Your machine | Operator token, for `verify deployment` and operator commands |
| `postgres.env` | Compose PostgreSQL | Generated database password (Compose only, when no database URL is supplied) |

Values are written unquoted or in single quotes, which Compose and the platforms read literally.
A value containing a single quote or a line break is refused; percent-encode a quote in a
database URL as `%27`. If you edit a file by hand, `check deployment` refuses double quotes and
unquoted `$`, quotes, or spaces, because Compose would expand or change them.

Only the Control Plane holds the database credential, and only the Gateway holds surface
credentials. Setup generates the Gateway's credential and the operator token unless
`SUPERTAG_GATEWAY_CREDENTIAL` or `SUPERTAG_OPERATOR_TOKEN` is set. It reads `SUPERTAG_CREDENTIAL_VAULT=vault` and `VAULT_*` to keep
connector credentials in HashiCorp Vault instead of the Gateway's volume. Without a terminal, or
with `--non-interactive`, a missing value fails instead of prompting.

`verify deployment` connects to the public Control Plane. It checks gRPC health, that an
anonymous operator request and an invalid Worker Host credential are refused, and that the
operator token works. Readiness means at least one Worker Host is ready; `--require-ready` makes
that required. It registers no Worker Host and runs no Task.

Worker Hosts are not part of setup. Create an Auth Key with `supertag auth-key create NAME --role
host`, then run `supertag host enroll` and `supertag worker-host` on each host against the Control
Plane's URL. Teammates' devices join with a client Auth Key (`--role client`) and
`supertag connect`.

To check a deployed Gateway's notification destinations, run `supertag test notification
--gateway http://127.0.0.1:3436` inside its container with your operator token in
`SUPERTAG_OPERATOR_TOKEN`. The Gateway asks the Control Plane whether that token is valid.

## TLS files

Every container reads its TLS files from `/run/supertag-tls`:

| File | Control Plane | Gateway |
| --- | --- | --- |
| `server.pem`, `server.key` | Certificate naming its public host and the private host Gateways use | Not used |
| `client-ca.pem` | Optional: require client certificates from every caller | Not used |
| `server-ca.pem` | CA for its own health probe | CA that issued the Control Plane's certificate |
| `client.pem`, `client.key` | Identity for its own health probe when client certificates are required | When client certificates are required |

Client certificates are an optional network filter in front of authentication: every call still
presents its own bearer credential, and identity comes only from that credential.

Compose mounts one directory per role there. Compose's Control Plane health probe connects to
`https://control-plane:3434` and trusts `server-ca.pem`, so with Compose the certificate must also
name `control-plane` and chain to that CA. To use a certificate from a public authority, replace
the health check in an override file.

Fly.io and Railway use the image target `hosted` of
[`../docker/rust-service.Dockerfile`](../docker/rust-service.Dockerfile). Its
[entrypoint](../docker/rust-hosted-entrypoint.sh) starts as root, gives the root-owned volume to
UID 10001, writes each `SUPERTAG_<NAME>_PEM` secret to the file above, and then runs the service
as UID 10001 with no capabilities. Set these secrets per role:

| Secret | Control Plane | Gateway |
| --- | --- | --- |
| `SUPERTAG_TLS_CERT_PEM`, `SUPERTAG_TLS_KEY_PEM` | Required | Not used |
| `SUPERTAG_TLS_CLIENT_CA_PEM` | Optional | Not used |
| `SUPERTAG_SERVER_CA_PEM` | Optional | When the Control Plane's CA is private |
| `SUPERTAG_CLIENT_CERT_PEM`, `SUPERTAG_CLIENT_KEY_PEM` | Optional | When the Control Plane requires client certificates |

## Docker Compose

```sh
supertag setup deployment compose --output supertag-deployment
export SUPERTAG_CONTROL_IMAGE=... SUPERTAG_GATEWAY_IMAGE=...
export SUPERTAG_POSTGRES_ENV_FILE=$PWD/supertag-deployment/postgres.env
export SUPERTAG_CONTROL_ENV_FILE=$PWD/supertag-deployment/control-plane.env
export SUPERTAG_GATEWAY_ENV_FILE=$PWD/supertag-deployment/gateway.env
export SUPERTAG_CONTROL_TLS_DIRECTORY=... SUPERTAG_GATEWAY_TLS_DIRECTORY=...
export SUPERTAG_CONTROL_PLANE_PUBLISH=0.0.0.0:443
docker compose -f deploy/compose.native.yaml -f deploy/compose.native.ingress.yaml up -d --wait
```

Add `--profile gateway` to also run the Gateway. Its server CA goes in the Gateway's TLS
directory. To also require client certificates, add `SUPERTAG_TLS_CLIENT_CA_FILE`, plus
`SUPERTAG_CLIENT_CERT_FILE` and `SUPERTAG_CLIENT_KEY_FILE` for its health probe, to
`control-plane.env`, and give every client, the Gateway included, a certificate (see
[TLS files](#tls-files)). Without the ingress file nothing is published.

## Fly.io

Create the app `supertag-control-plane`, its volume `supertag_control_plane_state`, and a
dedicated IPv4 address with `fly ips allocate-v4 --app supertag-control-plane` (and an IPv6
address with `fly ips allocate-v6`). Port 443 is a raw TCP service (`handlers = []`), and Fly.io's
shared IPv4 addresses route only HTTP and TLS-handler services, so without a dedicated IPv4 address
Worker Hosts and operators on IPv4-only networks cannot reach it. Then:

```sh
supertag setup deployment fly --output supertag-deployment
fly secrets import --app supertag-control-plane < supertag-deployment/control-plane.env
fly secrets set --app supertag-control-plane SUPERTAG_TLS_CERT_PEM="$(cat control-plane.pem)" ...
fly deploy --config deploy/native/fly/control-plane.toml --image IMAGE@sha256:DIGEST
```

For surfaces, create the app `supertag-gateway` in the same organization with the volume
`supertag_gateway_state` and no public IP, then:

```sh
fly secrets import --app supertag-gateway < supertag-deployment/gateway.env
fly deploy --config deploy/native/fly/gateway.toml --image IMAGE@sha256:DIGEST
```

Use the `hosted` image for both apps. Run one Machine per app. If you rename the Control Plane
app, change `--control-plane` in `fly/gateway.toml` to match.

## Railway

Create a service from the `hosted` image named `supertag-control-plane`, set its config file to
[`railway/control-plane.json`](railway/control-plane.json), paste `control-plane.env` into its
variables, add its PEM variables, and attach a volume at `/var/lib/supertag`. Enable a TCP Proxy
with target port 3434, and use the proxy's host and port as the Control Plane URL; its certificate
must name that host or a custom domain that points to it. The definition's start command replaces
the image entrypoint, so it names the entrypoint itself.

For surfaces, add a `supertag-gateway` service in the same environment configured by
[`railway/gateway.json`](railway/gateway.json), with `gateway.env` and a volume at
`/var/lib/supertag`. It needs no public networking.

## Control Plane replicas

Several Control Plane processes can share one PostgreSQL database. Replicas may start together:
one migrates the schema while the others wait. Any replica serves any call, and one replica runs
each periodic maintenance pass. Keep replica clocks synchronized, run the same release on every
replica, and stop all of them before an upgrade that changes the schema. A replica that freezes or
loses its network during a write stalls every write for up to 15 seconds, until PostgreSQL ends its
session; connect replicas to PostgreSQL directly or through a session-mode pooler, because a
transaction-mode pooler drops those session limits. A Gateway connects to one Control Plane
address, so put the replicas behind a TCP load balancer or private DNS name. A SQLite
database serves one Control Plane process; a second one on the same file refuses to start. See
[Control Plane replicas](../../rust/docs/control-plane-replicas.md) for the concurrency audit.

## WebSocket tunnel for HTTP-only platforms

Some platforms terminate TLS at their own proxy and forward only HTTP/1.1: Render web services,
a Cloudflare Worker in front of a Container, Modal web endpoints, and many ingress controllers.
For these, start the Control Plane (or a Gateway) with `--websocket-listen ADDRESS` in addition
to `--listen`, and route the platform's HTTP traffic to that address. The listener accepts a
WebSocket upgrade on any path and serves the upgraded connection as an ordinary gRPC connection,
so every call works as it does natively. With `--websocket-listen`, the service prints the
tunnel listener's address on the line after its gRPC address. Native gRPC on `--listen` is
unchanged.

Clients choose the tunnel by URL scheme: give a `wss://HOST[:PORT][/PATH]` URL instead of
`https://` wherever a Control Plane URL is expected. That covers operator commands,
`host enroll`, `worker-host`, `health`, and the Gateway's `--control-plane`. The terminal UI,
the desktop app, saved Control Planes, and `verify deployment` still need an `https://` URL.

Security does not depend on the platform's proxy:

- The proxy terminates the outer `wss://` TLS with its own certificate. Clients check it against
  the system roots and, when set, `SUPERTAG_SERVER_CA_FILE`.
- SuperTag's own TLS runs end to end inside the tunnel. The service's `SUPERTAG_TLS_*` settings
  apply to tunnelled connections exactly as to native ones, including required client
  certificates, so the proxy sees only ciphertext. The service certificate must name the host in
  the `wss://` URL.
- A `wss://` target never falls back to cleartext: if the inner TLS cannot complete, or the
  service refuses the client certificate, the connection fails.
- `ws://` is cleartext and, like `http://`, allowed only for a loopback IP address. A service
  without TLS accepts tunnels only on a loopback address.
- The listener refuses any upgrade that carries an `Origin` header, so a web page open in a
  browser cannot reach a service through the tunnel. SuperTag's clients never send one.

A platform-owned hostname such as `*.onrender.com` or `*.modal.run` cannot get a publicly
trusted certificate for SuperTag's inner TLS, so issue the service certificate from your own CA
for that hostname and give every client that CA in `SUPERTAG_SERVER_CA_FILE`.

Both ends send a WebSocket ping every 20 seconds, which keeps an idle tunnel open through proxies
that close idle connections (about 100 seconds on Cloudflare), and both treat a peer that has sent
nothing for 60 seconds as gone, noticing within the next 20. A dropped tunnel fails calls in
flight the same way a dropped TCP connection does, and Worker Hosts and Gateways reconnect and
retry as they do with native gRPC. Opening a tunnel may take up to 30 seconds, rather than the
5 allowed for native gRPC, so a platform can start a service that scaled to zero.

## Platforms behind an HTTP proxy

The tunnel carries the services' traffic on these platforms; definitions and live runs are still
to come. Their TypeScript definitions stay until the cutover.

- **Render.** A public web service runs the Control Plane with `--websocket-listen` on the web
  port. A Gateway, when used, is a private service that reaches it through `wss://`.
- **Cloudflare.** A Worker forwards WebSocket upgrades to the Control Plane's Container through
  its Durable Object `fetch`. A Gateway reaches the Control Plane's Worker through `wss://`.
- **Modal.** A web endpoint gives each service a stable HTTPS origin, which raw TCP tunnels do not.
  Modal also remains a supported Workspace provider for Worker Hosts.

## Rehearsal

[`../../rust/scripts/smoke_deployment_compose.py`](../../rust/scripts/smoke_deployment_compose.py)
rehearses this topology on disposable containers: setup's files, the published Control Plane with
client certificates, the Gateway profile, two outbound Worker Hosts, a full restart, and every Fly
and Railway service command in the `hosted` image. Fly.io and Railway themselves are not exercised.
