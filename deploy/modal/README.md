# SuperTag on Modal

[`app.py`](app.py) runs the Control Plane, and optionally the Gateway, from the native hosted image
in one always-on Modal container behind a web endpoint that carries the WebSocket tunnel.
[`requirements.txt`](requirements.txt) pins the Modal client. Follow the
[Modal guide](../../docs/guides/deploy-modal.md). The role contract, TLS files, and hosted image
are described in [native service deployments](../native/README.md).
