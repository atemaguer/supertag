# SuperTag on Render

See the [deployment guide](../../docs/guides/deploy-render.md) for setup and verification.

### Opt-in SSH image

For a paid Render service that needs Render-managed SSH access, select
`deploy/render/Dockerfile` with the repository root as the Docker build context.
This image prepares the root account and its SSH directory for Render's SSH
service. It contains no SSH daemon, embedded key, or known login password. The
Control Plane still runs as the `node` user through the standard entrypoint, with
state under `/var/lib/supertag`. Do not mount a persistent disk over `/root`.

Register your public SSH key with Render to connect. This image does not change
Render's public gRPC routing capabilities; SSH access is an administrative path.
See [Render's Docker SSH requirements](https://render.com/docs/ssh#docker-specific-configuration).
