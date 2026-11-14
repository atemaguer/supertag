# Deploy the Control Plane on Railway

Run the **Control Plane**, the service that stores a SuperTag organization and schedules its
work, as a Railway service with PostgreSQL and a volume. Add the optional **Gateway**, which
connects collaboration surfaces such as Slack, as a second service. **Worker Hosts**, the
machines that run the work, connect from elsewhere. See the [glossary](../reference/glossary.md)
for other terms.

```text
operators, Worker Hosts ── https:// TCP Proxy ──> supertag-control-plane :3434 ── PostgreSQL
supertag-gateway (optional) ── supertag-control-plane.railway.internal:3434 ──┘
```

The Control Plane terminates its own TLS, so it is published through Railway's TCP Proxy rather
than its HTTP domains. The definitions are
[`deploy/native/railway/control-plane.json`](../../deploy/native/railway/control-plane.json) and
[`deploy/native/railway/gateway.json`](../../deploy/native/railway/gateway.json).

## Before you start

- The `supertag` CLI, from the release you deploy. See [Install SuperTag](../operations/install.md).
- A Railway project, and PostgreSQL in it or elsewhere.
- The `hosted` image in a registry Railway can pull, with its digest. See
  [Build the hosted image](../../deploy/native/README.md#build-the-hosted-image).
- A TLS certificate that names the TCP Proxy's host, or a custom domain that points to it, and
  `supertag-control-plane.railway.internal`, which a Gateway dials. See
  [TLS files](../../deploy/native/README.md#tls-files).

## 1. Prepare the configuration

```sh
export SUPERTAG_DATABASE_URL='postgresql://...'
supertag setup deployment railway --output supertag-deployment
supertag check deployment railway --directory supertag-deployment
```

See [Configure a deployment](deployment-setup.md) for the files.

## 2. Create the Control Plane service

1. Create a service from the `hosted` image by digest, named `supertag-control-plane`.
2. Set its config file to `deploy/native/railway/control-plane.json`. Its start command names the
   image entrypoint itself, because Railway's start command replaces it.
3. Paste `control-plane.env` into its variables, and add `SUPERTAG_TLS_CERT_PEM` and
   `SUPERTAG_TLS_KEY_PEM`.
4. Attach a volume at `/var/lib/supertag`.
5. Enable a TCP Proxy with target port 3434. Its host and port form the Control Plane URL, such
   as `https://HOST.proxy.rlwy.net:PORT`.

Keep one replica. The Control Plane migrates PostgreSQL when it starts.

## 3. Verify and connect

```sh
supertag verify deployment https://HOST.proxy.rlwy.net:PORT \
  --env-file supertag-deployment/operator.env
supertag connect https://HOST.proxy.rlwy.net:PORT --name team
```

Set `SUPERTAG_SERVER_CA_FILE` first when the certificate comes from your own CA. Then connect a
Worker Host as in [Self-host SuperTag](self-hosting.md#6-connect-a-worker-host).

## Optional: add the Gateway

Add a `supertag-gateway` service in the same environment from the same image, configured by
`deploy/native/railway/gateway.json`, with `gateway.env` in its variables and a volume at
`/var/lib/supertag`. It needs no public networking. Add `SUPERTAG_SERVER_CA_PEM` for your own CA,
and the connector flags of each surface; see
[Connect a collaboration surface](../surfaces/README.md).

## Check that it worked

```sh
supertag verify deployment https://HOST.proxy.rlwy.net:PORT \
  --env-file supertag-deployment/operator.env --require-ready
```

## Limits

- One replica per service. Back up PostgreSQL and both volumes.
- The TCP Proxy's host and port change if you remove and re-create it. Issue the certificate for a
  custom domain to avoid reissuing it.

## If something goes wrong

- **Verification reports a TLS failure.** The certificate must name the host in the URL.
- **The Gateway restarts repeatedly.** It exits when it cannot reach the Control Plane. Check its
  credential and, for your own CA, `SUPERTAG_SERVER_CA_PEM`.

## Next

- [Control Plane operations](../operations/control-plane.md)
- [Run Worker Hosts](workers.md)
