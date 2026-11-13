# SuperTag on Cloudflare

A Worker ([`src/`](src/)) in front of one Container that runs the Control Plane, and optionally
the Gateway, from the native hosted image. The Worker forwards only WebSocket upgrades (the
Control Plane's tunnel) and the `/healthz` health check. [`wrangler.json`](wrangler.json)
configures the Worker, the Container, and the keep-alive cron trigger;
[`Dockerfile`](Dockerfile) builds the Container from `supertag-hosted:local`.

Follow the [Cloudflare guide](../../docs/guides/deploy-cloudflare.md). Tooling runs from this
directory with its own `npm ci`. The role contract, TLS files, and hosted image are described in
[native service deployments](../native/README.md).
