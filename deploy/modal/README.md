# SuperTag on Modal

[`app.py`](app.py) runs the Control Plane, and optionally the Gateway, from the native hosted image
in one always-on Modal container behind a web endpoint that carries the WebSocket tunnel.
[`requirements.txt`](requirements.txt) pins the Modal client. `supertag deploy` deploys this
definition, which is compiled into the CLI, and sets its `SUPERTAG_MODAL_*` settings from
[`supertag-deploy.yaml`](../../docs/reference/supertag-deploy-yaml.md); it can also be deployed by
hand. Follow the [Modal guide](../../docs/guides/deploy-modal.md). The role contract, TLS files, and hosted image
are described in [native service deployments](../native/README.md).
