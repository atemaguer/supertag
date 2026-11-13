# Deploy the Control Plane on Modal

<!-- supertag-cli: native -->

A **Tag** is a persistent AI actor with its own responsibilities and permissions. The **Control
Plane** is the service that stores a SuperTag organization and schedules its work; it is the one
public endpoint for operators, **Worker Hosts** (the machines that run the work), and the
optional **Gateway**, which connects **collaboration surfaces** such as Slack. This guide runs the
native Control Plane in one always-on Modal container behind a web endpoint, with external
PostgreSQL. See the [glossary](../reference/glossary.md) for other terms.

Modal's web endpoint terminates TLS and forwards HTTP/1.1 and WebSocket upgrades. The Control
Plane therefore carries its gRPC API inside a WebSocket, the **tunnel**, and runs SuperTag's own
TLS end to end inside it. Clients use the endpoint's stable URL with `wss://`. Modal sees only
ciphertext. Modal's raw TCP tunnels would carry native gRPC, but their addresses change with
each container, so this deployment does not use them.

```text
operators, Worker Hosts ── wss://WORKSPACE--supertag.modal.run ──> web endpoint, port 8080
                                                                    Control Plane
                                                                    Gateway (optional)
                                                                      │
                                    external PostgreSQL, Modal Volume, HashiCorp Vault
```

[`app.py`](../../deploy/modal/app.py) runs one container (`min_containers=1`,
`max_containers=1`, non-preemptible) from the hosted image. A Modal Volume at
`/var/lib/supertag` holds transfer files. With the Gateway on, it runs in the same container and
reaches the Control Plane on `https://127.0.0.1:3434`. The Gateway is not given the database URL,
the operator token, or the Control Plane's TLS settings, and the Control Plane is not given the
surface settings. Both run as one user in one container, though, so either could read the other's
files, including the TLS key: they share one trust boundary.

The function supervises the service: if the Control Plane, or the Gateway beside it, exits, the
container exits too and Modal starts a replacement.

Modal also runs Workspaces for Worker Hosts; that is independent of where the Control Plane runs.
See [Run a Worker in Modal](modal-workers.md).

## Before you start

- The native `supertag` CLI, from the release you deploy. No native release archive is published
  yet, so build it from that release's checkout with
  `cargo build --release --locked --manifest-path rust/Cargo.toml -p supertag-cli --bin supertag`
  and put `rust/target/release/supertag` first on your `PATH`. The `supertag-ai` npm package
  installs the TypeScript CLI, which cannot set up or verify this deployment.
- The Modal CLI, authenticated, at the version in
  [`requirements.txt`](../../deploy/modal/requirements.txt).
- The `hosted` service image for `linux/amd64` in a registry Modal can pull, with its digest. See
  [Build the hosted image](../../deploy/native/README.md#build-the-hosted-image).
- A PostgreSQL database reachable from Modal with TLS, and HashiCorp Vault (KV v2) for the
  Gateway's connector credentials. Setup requires Vault, because a Modal Volume does not give the
  file credential vault's atomic, durable writes.
- `openssl`, to issue certificates from your own CA.

## 1. Issue certificates

The URL is `https://WORKSPACE--LABEL.modal.run`: your Modal workspace name and the endpoint label,
`supertag` unless you set `SUPERTAG_MODAL_LABEL`. Deployed to a Modal environment other than your
default one, the host also carries the environment's name (`WORKSPACE-ENVIRONMENT--LABEL`); the
deploy prints the URL. That hostname cannot carry a publicly trusted
certificate for SuperTag's inner TLS. Issue the Control Plane's certificate from your own CA for
it and `IP:127.0.0.1`, as shown in
[Issue certificates from your own CA](../../deploy/native/README.md#issue-certificates-from-your-own-ca).
Every client then trusts that CA through `SUPERTAG_SERVER_CA_FILE`.

With the Gateway on, also issue it a client certificate. The Control Plane then requires client
certificates from everyone, so issue one for each operator and Worker Host too.

## 2. Prepare the configuration

```sh
export SUPERTAG_DATABASE_URL='postgresql://...?sslmode=require'
export VAULT_ADDR=https://vault.example.com VAULT_TOKEN=...
supertag setup deployment modal --output supertag-deployment
supertag check deployment modal --directory supertag-deployment
```

Setup writes `control-plane.env`, `gateway.env`, and `operator.env`, each readable only by you,
and generates the Gateway and operator tokens.

## 3. Create the secrets and deploy

```sh
modal secret create supertag-control-plane --from-dotenv supertag-deployment/control-plane.env
modal secret create supertag-control-plane-tls \
  SUPERTAG_TLS_CERT_PEM="$(cat server.pem)" SUPERTAG_TLS_KEY_PEM="$(cat server.key)"
SUPERTAG_MODAL_IMAGE=REGISTRY/supertag-hosted@sha256:DIGEST modal deploy deploy/modal/app.py
```

With the Gateway on, recreate `supertag-control-plane-tls` with `SUPERTAG_TLS_CLIENT_CA_PEM` (your
CA) added (`modal secret create --force` replaces a secret's values), create `supertag-gateway`
from `gateway.env` plus your connector settings, and `supertag-gateway-tls` with
`SUPERTAG_SERVER_CA_PEM` (your CA), `SUPERTAG_CLIENT_CERT_PEM`, and `SUPERTAG_CLIENT_KEY_PEM`.
Deploy with `SUPERTAG_MODAL_GATEWAY=on` and `SUPERTAG_MODAL_GATEWAY_FLAGS` naming the Gateway's
connectors (see [Collaboration surfaces](#collaboration-surfaces)). For a private registry, also set
`SUPERTAG_MODAL_REGISTRY_SECRET` to a Modal secret with `REGISTRY_USERNAME` and
`REGISTRY_PASSWORD`. The image entrypoint writes each PEM value to a file and runs the services as
an unprivileged user.

The deploy refuses an image reference without a digest. Modal's web endpoint checks that port 8080
is listening; `GET /healthz` on it answers `200 ok` for your own checks.

## 4. Verify

```sh
curl --fail https://WORKSPACE--supertag.modal.run/healthz
export SUPERTAG_SERVER_CA_FILE=$PWD/ca.pem
supertag verify deployment wss://WORKSPACE--supertag.modal.run \
  --env-file supertag-deployment/operator.env
```

With the Gateway on, also set `SUPERTAG_CLIENT_CERT_FILE` and `SUPERTAG_CLIENT_KEY_FILE` to an
operator's client certificate. Readiness reads `not ready` until a Worker Host connects.

## 5. Connect a Worker Host

Create an **Auth Key** (a one-time enrollment secret) for the host, then enroll and run it on the
machine that owns the **harness** (the coding agent that does the work, such as Codex):

```sh
supertag auth-key create build-1 --host build-1 --tag engineering \
  --control-plane wss://WORKSPACE--supertag.modal.run
# Save the printed key as build-1.key (mode 0600) on the Worker Host, then, with the same
# SUPERTAG_SERVER_CA_FILE (and, with a Gateway, the host's own SUPERTAG_CLIENT_CERT_FILE and
# SUPERTAG_CLIENT_KEY_FILE):
supertag host enroll build-1 --control-plane wss://WORKSPACE--supertag.modal.run \
  --state-directory ~/.supertag-host --auth-key file:build-1.key
supertag worker-host --control-plane wss://WORKSPACE--supertag.modal.run \
  --state-directory ~/.supertag-host --harness codex
```

Operator commands read the operator token from `SUPERTAG_OPERATOR_TOKEN`. The Worker Host
connects outbound and needs no inbound port.

## Collaboration surfaces

The web endpoint reaches only the Control Plane's tunnel, so the Gateway can serve only connectors
that connect outbound:

- **Lark or Feishu**, over its outbound long connection:
  `--lark-state-directory /var/lib/supertag/lark`, with `SUPERTAG_LARK_ACCOUNT_ID`,
  `SUPERTAG_LARK_DOMAIN` (`lark` or `feishu`), `SUPERTAG_LARK_APP_ID`, `SUPERTAG_LARK_TENANT_KEY`,
  `SUPERTAG_LARK_BOT_OPEN_ID`, `SUPERTAG_LARK_CHAT_ID`, `SUPERTAG_LARK_TAG_ID`, and
  `SUPERTAG_LARK_ALLOWED_USERS` (comma-separated) in the `supertag-gateway` secret. The app secret comes from the
  credential vault, where [`supertag setup surface lark`](../surfaces/lark.md) stores it, or from
  `SUPERTAG_LARK_APP_SECRET`.
- **Operator notifications to a webhook**: `--notify webhook:HTTPS_URL#NAME`, with the bearer
  secret in `SUPERTAG_NOTIFY_SECRET_NAME` (the name uppercased, `-` as `_`).

Slack, GitHub, Linear, and Microsoft Teams need inbound webhooks, which this deployment cannot
receive, and the native Gateway has no Slack Socket Mode. For them, run a Gateway on a host that
can receive webhooks (see [native service deployments](../../deploy/native/README.md)); it dials
this Control Plane's `wss://` URL with its client certificate.

```sh
SUPERTAG_MODAL_IMAGE=REGISTRY/supertag-hosted@sha256:DIGEST SUPERTAG_MODAL_GATEWAY=on \
  SUPERTAG_MODAL_GATEWAY_FLAGS='--lark-state-directory /var/lib/supertag/lark' \
  modal deploy deploy/modal/app.py
```

The deploy refuses `SUPERTAG_MODAL_GATEWAY=on` without connector flags.

## Check that it worked

```sh
supertag verify deployment wss://WORKSPACE--supertag.modal.run \
  --env-file supertag-deployment/operator.env --require-ready
```

With the Gateway connected to Lark, mention the Tag in the Lark chat and confirm that it replies.

## Cold starts and restarts

- The container is always running. A deploy or a host failure replaces it; the replacement pulls
  the image and starts within the two-minute startup timeout. Requests during that time get `503`,
  opening a tunnel waits up to 30 seconds, and Worker Hosts and the Gateway retry.
- Each open tunnel is one function call, closed after the 24-hour function timeout; clients
  reconnect at once.
- Both ends of a tunnel ping every 20 seconds, which keeps idle tunnels open.

## Limits

- One container. Every Control Plane runs the controllers, so do not raise `max_containers`.
- Modal commits Volume writes in the background; transfer files written just before a container
  replacement may be lost, and work whose transfer was in progress must be retried.
- Native gRPC (`https://`) does not reach this deployment. The terminal UI and the desktop app need
  an `https://` URL, so they cannot connect to it yet.
- The web endpoint forwards only the tunnel port, so the Gateway here serves Lark and webhook
  notifications only. Slack, GitHub, Linear, and Microsoft Teams need a Gateway on another host.

## Remove the deployment

```sh
modal app stop supertag
modal volume delete supertag-state
modal secret delete supertag-control-plane
modal secret delete supertag-control-plane-tls
```

Delete `supertag-gateway` and `supertag-gateway-tls` too if you created them, then the database
and Vault path if they were dedicated to this deployment. `modal app list` and
`modal volume list` confirm the removal.

## If something goes wrong

- **The deploy stops with a message about the digest.** Set `SUPERTAG_MODAL_IMAGE` to
  `IMAGE@sha256:DIGEST`.
- **Verification cannot reach the Control Plane over TLS.** Check `SUPERTAG_SERVER_CA_FILE` and
  that the certificate names the `modal.run` host.
- **The container restarts repeatedly.** The container exits whenever its service does. Check the
  logs with `modal app logs supertag`: an unreachable database stops the Control Plane, and with
  the Gateway on, check its client certificate, its connector settings,
  `SUPERTAG_TLS_CLIENT_CA_PEM`, and that the certificate names `IP:127.0.0.1`.

## Next

- [Native service deployments](../../deploy/native/README.md) for the role contract and TLS files
- [Control Plane operations](../operations/control-plane.md)
