# Native service deployments

Definitions for the native SuperTag services. These are separate from the TypeScript Control
Plane definitions in the parent directory, which stay until the cutover.

A deployment runs three roles:

| Role | Reachability | State |
| --- | --- | --- |
| Control Plane | Private network only, port 3435, mutual TLS | PostgreSQL |
| Gateway | Public native gRPC with its own TLS certificate, container port 3434 | Volume at `/var/lib/supertag`: checkpoints and the file credential vault |
| Worker Hosts | Outbound only: each connects to the Gateway | The host's own state directory |

The Gateway terminates TLS itself and speaks gRPC over HTTP/2, so a platform must pass raw TCP to
it (TLS passthrough). A platform whose ingress terminates TLS and forwards only HTTP/1.1 reaches
the services through the [WebSocket tunnel](#websocket-tunnel-for-http-only-platforms) instead.

| Platform | Definitions | Public Gateway path | Private Control Plane path |
| --- | --- | --- | --- |
| Docker Compose | [`../compose.native.yaml`](../compose.native.yaml), [`../compose.native.ingress.yaml`](../compose.native.ingress.yaml) | Published port on the Gateway only | Internal Compose network, `control-plane:3435` |
| Fly.io | [`fly/control-plane.toml`](fly/control-plane.toml), [`fly/gateway.toml`](fly/gateway.toml) | TCP service on 443 with `handlers = []` | 6PN, `supertag-control-plane.internal:3435` |
| Railway | [`railway/control-plane.json`](railway/control-plane.json), [`railway/gateway.json`](railway/gateway.json) | TCP Proxy to port 3434 | Private network, `supertag-control-plane.railway.internal:3435` |

Render, Cloudflare, and Modal forward only HTTP and need the WebSocket tunnel; their definitions
are not written yet. See [Platforms behind an HTTP proxy](#platforms-behind-an-http-proxy).

## Configure, check, and verify

```sh
export SUPERTAG_DATABASE_URL='postgresql://...'   # not needed for Compose
supertag setup deployment fly --output supertag-deployment
supertag check deployment fly --directory supertag-deployment
# deploy, then:
SUPERTAG_SERVER_CA_FILE=ca.pem supertag verify deployment https://gateway.example.com \
  --env-file supertag-deployment/operator.env --require-ready
```

Setup writes a new private directory and never replaces one. Each file is mode 0600:

| File | For | Holds |
| --- | --- | --- |
| `control-plane.env` | Control Plane | Database URL and Gateway token |
| `gateway.env` | Gateway | Gateway token, operator token, state directory, credential vault settings |
| `operator.env` | Your machine | Operator token, for `verify deployment` and operator commands |
| `postgres.env` | Compose PostgreSQL | Generated database password (Compose only, when no database URL is supplied) |

Values are written unquoted or in single quotes, which Compose and the platforms read literally.
A value containing a single quote or a line break is refused; percent-encode a quote in a
database URL as `%27`. If you edit a file by hand, `check deployment` refuses double quotes and
unquoted `$`, quotes, or spaces, because Compose would expand or change them.

Only the Control Plane holds the database credential. Setup generates the Gateway and operator
tokens unless `SUPERTAG_GATEWAY_TOKEN` or `SUPERTAG_OPERATOR_TOKEN` is set. It reads
`SUPERTAG_CREDENTIAL_VAULT=vault` and `VAULT_*` to keep connector credentials in HashiCorp Vault
instead of the Gateway's volume. Without a terminal, or with `--non-interactive`, a missing value
fails instead of prompting.

`verify deployment` connects only to the public Gateway. It checks gRPC health, that an
anonymous operator request and an invalid Worker Host credential are refused, and that the
operator token works through the Gateway's private hop to the Control Plane. Readiness means at
least one Worker Host is ready; `--require-ready` makes that required. It registers no Worker
Host and runs no Task.

Worker Hosts are not part of setup. Create an Auth Key with `supertag auth-key create`, then run
`supertag host enroll` and `supertag worker-host` on each host against the Gateway's URL.

## TLS files

Every container reads its TLS files from `/run/supertag-tls`:

| File | Control Plane | Gateway |
| --- | --- | --- |
| `server.pem`, `server.key` | Certificate naming its private host | Certificate naming the public host |
| `client-ca.pem` | CA that issued the Gateway's client certificate | Optional: require client certificates from operators and Worker Hosts |
| `server-ca.pem` | CA for its own health probe | CA that issued the Control Plane's certificate |
| `client.pem`, `client.key` | Identity for its own health probe | Identity it presents to the Control Plane |

Compose mounts one directory per role there. Compose's Gateway health probe connects to
`https://gateway:3434` and trusts `server-ca.pem`, so with Compose the Gateway certificate must
also name `gateway` and chain to that CA. To use a certificate from a public authority, replace the
Gateway health check in an override file.

Fly.io and Railway use the image target `hosted` of
[`../docker/rust-service.Dockerfile`](../docker/rust-service.Dockerfile). Its
[entrypoint](../docker/rust-hosted-entrypoint.sh) starts as root, gives the root-owned volume to
UID 10001, writes each `SUPERTAG_<NAME>_PEM` secret to the file above, and then runs the service
as UID 10001 with no capabilities. Set these secrets per role:

| Secret | Control Plane | Gateway |
| --- | --- | --- |
| `SUPERTAG_TLS_CERT_PEM`, `SUPERTAG_TLS_KEY_PEM` | Required | Required |
| `SUPERTAG_TLS_CLIENT_CA_PEM` | Required | Optional |
| `SUPERTAG_SERVER_CA_PEM`, `SUPERTAG_CLIENT_CERT_PEM`, `SUPERTAG_CLIENT_KEY_PEM` | Optional | Required |

## Docker Compose

```sh
supertag setup deployment compose --output supertag-deployment
export SUPERTAG_CONTROL_IMAGE=... SUPERTAG_GATEWAY_IMAGE=...
export SUPERTAG_POSTGRES_ENV_FILE=$PWD/supertag-deployment/postgres.env
export SUPERTAG_CONTROL_ENV_FILE=$PWD/supertag-deployment/control-plane.env
export SUPERTAG_GATEWAY_ENV_FILE=$PWD/supertag-deployment/gateway.env
export SUPERTAG_CONTROL_TLS_DIRECTORY=... SUPERTAG_GATEWAY_TLS_DIRECTORY=...
export SUPERTAG_GATEWAY_PUBLISH=0.0.0.0:443
docker compose -f deploy/compose.native.yaml -f deploy/compose.native.ingress.yaml up -d --wait
```

Without the ingress file nothing is published.

## Fly.io

Create two apps, `supertag-control-plane` and `supertag-gateway`, in one organization. Give the
Control Plane no public IP. Create the Gateway's volume `supertag_gateway_state` and allocate the
Gateway a dedicated IPv4 address with `fly ips allocate-v4 --app supertag-gateway` (and an IPv6
address with `fly ips allocate-v6`). The Gateway's port 443 is a raw TCP service
(`handlers = []`), and Fly.io's shared IPv4 addresses route only HTTP and TLS-handler services, so
without a dedicated IPv4 address Worker Hosts and operators on IPv4-only networks cannot reach it.
Then:

```sh
supertag setup deployment fly --output supertag-deployment
fly secrets import --app supertag-control-plane < supertag-deployment/control-plane.env
fly secrets import --app supertag-gateway < supertag-deployment/gateway.env
fly secrets set --app supertag-control-plane SUPERTAG_TLS_CERT_PEM="$(cat control-plane.pem)" ...
fly secrets set --app supertag-gateway SUPERTAG_TLS_CERT_PEM="$(cat gateway.pem)" ...
fly deploy --config deploy/native/fly/control-plane.toml --image IMAGE@sha256:DIGEST
fly deploy --config deploy/native/fly/gateway.toml --image IMAGE@sha256:DIGEST
```

Use the `hosted` image for both apps. Run one Machine per app. If you rename the Control Plane
app, change `--control-plane` in `fly/gateway.toml` and its certificate name to match.

## Railway

Create two services from the `hosted` image in one environment, named `supertag-control-plane` and
`supertag-gateway`. Set each service's config file to its JSON definition here. The definition's
start command replaces the image entrypoint, so it names the entrypoint itself. Paste the matching
env file into each service's variables and add its PEM variables. Attach a volume at
`/var/lib/supertag` to the Gateway. Enable a TCP Proxy on the Gateway with target port 3434, and
use the proxy's host and port as the Gateway URL; its certificate must name that host or a custom
domain that points to it. The Control Plane has no public networking.

## WebSocket tunnel for HTTP-only platforms

Some platforms terminate TLS at their own proxy and forward only HTTP/1.1: Render web services,
a Cloudflare Worker in front of a Container, Modal web endpoints, and many ingress controllers.
For these, start the Gateway or Control Plane with `--websocket-listen ADDRESS` in addition to
`--listen`, and route the platform's HTTP traffic to that address. The listener accepts a
WebSocket upgrade on any path and serves the upgraded connection as an ordinary gRPC connection,
so every call works as it does natively. With `--websocket-listen`, the service prints the
tunnel listener's address on the line after its gRPC address. Native gRPC on `--listen` is
unchanged.

Clients choose the tunnel by URL scheme: give a `wss://HOST[:PORT][/PATH]` URL instead of
`https://` wherever a Gateway or Control Plane URL is expected. That covers operator commands,
`host enroll`, `worker-host`, `health`, and the Gateway's `--control-plane`. The terminal UI,
the desktop app, saved Gateways, and `verify deployment` still need an `https://` URL.

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
flight the same way a dropped TCP connection does, and Worker Hosts and the Gateway reconnect and
retry as they do with native gRPC. Opening a tunnel may take up to 30 seconds, rather than the
5 allowed for native gRPC, so a platform can start a service that scaled to zero.

## Platforms behind an HTTP proxy

The tunnel carries the services' traffic on these platforms; definitions and live runs are still
to come. Their TypeScript definitions stay until the cutover.

- **Render.** A public web service runs the Gateway with `--websocket-listen` on the web port.
  The Control Plane can be a private service reached at its internal `https://` address, or
  another web service reached through `wss://`.
- **Cloudflare.** A Worker forwards WebSocket upgrades to each Container through its Durable
  Object `fetch`. The Gateway reaches the Control Plane's Worker through `wss://`, with mutual TLS
  inside the tunnel because there is no private network between Containers.
- **Modal.** A web endpoint gives each service a stable HTTPS origin, which raw TCP tunnels do not.
  Modal also remains a supported Workspace provider for Worker Hosts.

## Rehearsal

[`../../rust/scripts/smoke_deployment_compose.py`](../../rust/scripts/smoke_deployment_compose.py)
runs a disposable Compose deployment configured by `setup deployment compose`, with PostgreSQL
(including a deliberately slow first-start initialization), mutual TLS, `verify deployment`, two
outbound Worker Hosts placed by label, and a full restart. It then replaces the Compose Control
Plane with the `hosted` image and runs all four service commands from `fly/` and `railway/` with
PEM secrets and root-owned volumes, including a Control Plane that refuses to start without a
client CA. Fly.io and Railway themselves are not exercised.
