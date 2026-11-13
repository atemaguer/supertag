# SuperTag on Render

[`render.yaml`](render.yaml) is a Render Blueprint for the native services: the Control Plane as
a web service behind Render's HTTP edge, carried in the WebSocket tunnel; Render PostgreSQL; a
disk for transfer files; and an optional Gateway worker. Follow the
[Render guide](../../docs/guides/deploy-render.md). The role contract, TLS files, and hosted image
are described in [native service deployments](../native/README.md).
