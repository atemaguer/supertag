# Native split-service rehearsal

This contributor check runs the Rust Control Plane (the durable scheduler), Gateway
(the public API), and PostgreSQL in separate containers. A Worker Host, which provides
execution capacity, runs a synthetic adapter to complete one Task, or turn of work.
It uses disposable certificates, credentials, state volumes, and an internal Docker
network. It publishes no host ports and calls no model or external work provider.

The native Compose entry point is `deploy/compose.native.yaml`. The existing
`deploy/compose.yaml` still selects the TypeScript runtime. This rehearsal does not
change an installation, import old state, publish images, or perform a production cutover.

## Build and verify

Use a Linux complete archive assembled by `rust/scripts/native_release.py` and its
matching fixture adapter. The normal release CLI contains no test-only adapter; build
that separately from the same source with the `test-fixtures` feature. Docker must support
the archive's architecture, and Docker Compose must support `up --wait`.

```sh
uv run rust/scripts/split_service_images.py /path/to/supertag-complete.tar.gz \
  --repository supertag-rehearsal --tag local
python3 rust/scripts/smoke_native_compose.py \
  --control-image supertag-rehearsal-control-plane:local \
  --gateway-image supertag-rehearsal-gateway:local \
  --fixture-adapter /path/to/supertag-fixture-adapter \
  --receipt /tmp/supertag-native-compose-receipt.json
```

The image builder verifies every archive entry and its checksum before copying only the
CLI into the two service images. It records the archive digest, source commit, and version
as image labels. Harness helpers, the terminal UI, and the shared execution provider stay
out of these images. They remain in the complete archive for their respective deployments.
The older two-binary fixture archive is still accepted explicitly with
`--archive-format cli-tui`.

The rehearsal verifies private mutual TLS, public TLS, operator authentication, service
UID 10001, real gRPC health, Task completion, recorded events, request deduplication, and
persistence after restarting PostgreSQL and both services. It removes only its randomly
named Compose project, including its volumes, and checks that nothing remains before
writing a receipt. Local image tags remain for inspection; remove your chosen tags when done.

## Configuration and health

Compose takes image names and the paths of private per-role environment files and TLS
directories from these variables:

- `SUPERTAG_CONTROL_IMAGE` and `SUPERTAG_GATEWAY_IMAGE`.
- `SUPERTAG_POSTGRES_ENV_FILE`: PostgreSQL database, user, and password.
- `SUPERTAG_CONTROL_ENV_FILE` and `SUPERTAG_CONTROL_TLS_DIRECTORY`.
- `SUPERTAG_GATEWAY_ENV_FILE` and `SUPERTAG_GATEWAY_TLS_DIRECTORY`.

The Control Plane file supplies `SUPERTAG_DATABASE_URL`, its Gateway token, the synthetic
bootstrap Host token, and the server TLS certificate/key and client CA paths. The Gateway
file supplies its upstream Gateway token, operator token, server TLS identity, upstream CA,
and client TLS identity. The rehearsal creates these files privately. Never put lasting
credentials into command arguments or tracked Compose files.

The standard read-only gRPC health check uses the same TLS configuration as the normal CLI:

```sh
supertag health --endpoint https://gateway:3434
supertag health --endpoint https://control-plane:3435 \
  --service supertag.runtime.v2.Operator --timeout-seconds 5
```

Set `SUPERTAG_SERVER_CA_FILE` for private trust and both `SUPERTAG_CLIENT_CERT_FILE` and
`SUPERTAG_CLIENT_KEY_FILE` when the server requires mutual TLS. The private Control Plane
health probe also needs that client identity; the rehearsal mounts only synthetic keys in
its container. No bearer token is needed for health. A successful check reports `SERVING`
for the requested service. It checks that server's declared service status, not the health
of its dependencies or its available execution capacity. Missing services, `NOT_SERVING`,
TLS failures, and deadlines produce nonzero exits. Plaintext endpoints must be loopback IPs.

The native Compose file intentionally has no public port or ingress. A deployment needs
its own certificate names, network boundary, credential provisioning, backup policy, and
explicit Gateway ingress override. This local rehearsal does not certify those choices.
