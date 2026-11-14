# Deploy the Control Plane on Fly.io

Run the **Control Plane**, the service that stores a SuperTag organization and schedules its
work, as one always-on Fly.io Machine with PostgreSQL and a volume. Add the optional **Gateway**,
which connects collaboration surfaces such as Slack, as a second app. **Worker Hosts**, the
machines that run the work, connect from elsewhere. See the [glossary](../reference/glossary.md)
for other terms.

```text
operators, Worker Hosts ── https:// :443 (raw TCP) ──> supertag-control-plane ── PostgreSQL
supertag-gateway (optional) ── 6PN supertag-control-plane.internal:3434 ──┘
```

The Control Plane terminates its own TLS, so port 443 passes raw TCP to it and gRPC reaches it
unchanged. The definitions are [`deploy/native/fly/control-plane.toml`](../../deploy/native/fly/control-plane.toml)
and [`deploy/native/fly/gateway.toml`](../../deploy/native/fly/gateway.toml).

## Before you start

- The `supertag` CLI, from the release you deploy. See [Install SuperTag](../operations/install.md).
- The [Fly CLI](https://fly.io/docs/flyctl/install/), authenticated, and an organization with
  billing for an always-on Machine.
- The `hosted` image in a registry Fly.io can pull, with its digest. See
  [Build the hosted image](../../deploy/native/README.md#build-the-hosted-image).
- PostgreSQL reachable from Fly.io, such as Fly Managed Postgres.
- A TLS certificate that names the public host name and `supertag-control-plane.internal`, which
  a Gateway dials. See [TLS files](../../deploy/native/README.md#tls-files).

## 1. Create the app, volume, and addresses

```sh
fly apps create supertag-control-plane
fly volumes create supertag_control_plane_state --app supertag-control-plane --region iad --size 1
fly ips allocate-v4 --app supertag-control-plane
fly ips allocate-v6 --app supertag-control-plane
```

Fly.io's shared IPv4 addresses route only HTTP and TLS-handler services. Without a dedicated IPv4
address, clients on IPv4-only networks cannot reach the raw TCP service.

## 2. Prepare the configuration

```sh
export SUPERTAG_DATABASE_URL='postgresql://...'
supertag setup deployment fly --output supertag-deployment
supertag check deployment fly --directory supertag-deployment
```

See [Configure a deployment](deployment-setup.md) for the files.

## 3. Import the secrets and deploy

```sh
fly secrets import --app supertag-control-plane < supertag-deployment/control-plane.env
fly secrets set --app supertag-control-plane \
  SUPERTAG_TLS_CERT_PEM="$(cat server.pem)" SUPERTAG_TLS_KEY_PEM="$(cat server.key)"
fly deploy --config deploy/native/fly/control-plane.toml --image IMAGE@sha256:DIGEST
```

Run exactly one Machine. Its volume holds the transfer directory, and every Control Plane process
runs the controllers. The Control Plane migrates PostgreSQL when it starts.

## 4. Verify and connect

```sh
supertag verify deployment https://supertag-control-plane.fly.dev \
  --env-file supertag-deployment/operator.env
supertag connect https://supertag-control-plane.fly.dev --name team
```

Set `SUPERTAG_SERVER_CA_FILE` first when the certificate comes from your own CA. Then connect a
Worker Host as in [Self-host SuperTag](self-hosting.md#6-connect-a-worker-host).

## Optional: add the Gateway

Deploy the Gateway only to connect a collaboration surface or send operator notifications.
Create the app `supertag-gateway` in the same organization, with the volume
`supertag_gateway_state` and no public IP:

```sh
fly apps create supertag-gateway
fly volumes create supertag_gateway_state --app supertag-gateway --region iad --size 1
fly secrets import --app supertag-gateway < supertag-deployment/gateway.env
fly deploy --config deploy/native/fly/gateway.toml --image IMAGE@sha256:DIGEST
```

Add `SUPERTAG_SERVER_CA_PEM` when the Control Plane's certificate comes from your own CA. Append
the connector flags of each surface to the Gateway's command in `gateway.toml`; see
[Connect a collaboration surface](../surfaces/README.md). Its webhook listeners are loopback
only, so put a reverse proxy for them in the same Machine. If you rename the Control Plane app,
change `--control-plane` in `gateway.toml` to match.

## Check that it worked

```sh
supertag verify deployment https://supertag-control-plane.fly.dev \
  --env-file supertag-deployment/operator.env --require-ready
```

## Limits

- One Machine per app. Back up PostgreSQL and both volumes; they hold different state.
- The volume holds transfer files such as Session checkpoints. Losing it loses checkpoints that
  are not yet consumed.

## Remove the deployment

```sh
fly apps destroy supertag-gateway
fly apps destroy supertag-control-plane
```

Destroying an app removes its volumes. Delete the database separately.

## If something goes wrong

- **Clients time out.** Check that the app has a dedicated IPv4 address and that port 443 has
  `handlers = []`.
- **The Gateway restarts repeatedly.** It exits when it cannot reach the Control Plane. Check its
  credential and, for your own CA, `SUPERTAG_SERVER_CA_PEM`.

## Next

- [Control Plane operations](../operations/control-plane.md)
- [Run Worker Hosts](workers.md)
