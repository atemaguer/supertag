"""SuperTag on Modal: the Control Plane, and optionally a Gateway, in one always-on container.

Modal's web endpoint terminates TLS and forwards HTTP/1.1 and WebSocket upgrades to the
container, so the Control Plane accepts gRPC carried in a WebSocket on TUNNEL_PORT
(`--websocket-listen`) and runs its own TLS inside the tunnel. Clients use
wss://WORKSPACE--LABEL.modal.run, a stable URL; the service certificate must name that host and
comes from your own CA, given to every client as SUPERTAG_SERVER_CA_FILE. Native gRPC stays on
loopback. See README.md.

Deploy, with the hosted image (rust-service.Dockerfile target "hosted") by digest:

    SUPERTAG_MODAL_IMAGE=REGISTRY/IMAGE@sha256:DIGEST modal deploy deploy/modal/app.py

Settings read at deploy time:

    SUPERTAG_MODAL_IMAGE           required; an image reference pinned by digest
    SUPERTAG_MODAL_GATEWAY         "on" to also run a Gateway in the same container (default off)
    SUPERTAG_MODAL_APP             app name (default supertag)
    SUPERTAG_MODAL_LABEL           web endpoint label, the URL's last part (default supertag)
    SUPERTAG_MODAL_REGISTRY_SECRET Modal secret with REGISTRY_USERNAME and REGISTRY_PASSWORD
                                   for a private registry (optional)

Modal secrets: supertag-control-plane holds control-plane.env from `supertag setup deployment
modal`, and supertag-control-plane-tls the Control Plane's TLS PEM values. With the Gateway on,
supertag-gateway holds gateway.env and supertag-gateway-tls the Gateway's PEM values.
"""

import os
import subprocess

import modal

# The tunnel listener inside the container. Its plain GET /healthz answers health checks.
TUNNEL_PORT = 8080
ENTRYPOINT = "/usr/local/bin/supertag-hosted-entrypoint"
# The Control Plane alone: native gRPC on loopback, the tunnel on TUNNEL_PORT.
CONTROL_PLANE_COMMAND = [
    ENTRYPOINT,
    "control-plane",
    "--listen",
    "127.0.0.1:3434",
    "--websocket-listen",
    "0.0.0.0:8080",
    "--transfer-directory",
    "/var/lib/supertag/transfers",
]
# The Control Plane and a Gateway in this one container; the Gateway dials it on loopback.
PAIR_COMMAND = [ENTRYPOINT, "pair", "0.0.0.0:8080"]
# Holds the Control Plane's transfer files and the Gateway's connector state.
STATE_DIRECTORY = "/var/lib/supertag"

image_ref = os.environ.get("SUPERTAG_MODAL_IMAGE", "")
gateway = os.environ.get("SUPERTAG_MODAL_GATEWAY", "off")
app_name = os.environ.get("SUPERTAG_MODAL_APP", "supertag")
label = os.environ.get("SUPERTAG_MODAL_LABEL", "supertag")
registry_secret = os.environ.get("SUPERTAG_MODAL_REGISTRY_SECRET")

if modal.is_local():
    if "@sha256:" not in image_ref:
        raise SystemExit("Set SUPERTAG_MODAL_IMAGE to the hosted image pinned by digest (IMAGE@sha256:...)")
    if gateway not in ("on", "off"):
        raise SystemExit("SUPERTAG_MODAL_GATEWAY must be on or off")

image = (
    modal.Image.from_registry(
        image_ref,
        add_python="3.12",
        secret=modal.Secret.from_name(registry_secret) if registry_secret else None,
    )
    # Modal runs the function; the service command below names the image entrypoint.
    .entrypoint([])
    # The container re-imports this file, so it carries the deploy-time settings.
    .env({
        "SUPERTAG_MODAL_IMAGE": image_ref,
        "SUPERTAG_MODAL_GATEWAY": gateway,
        "SUPERTAG_MODAL_APP": app_name,
        "SUPERTAG_MODAL_LABEL": label,
    })
)
# Settings from setup, and the TLS PEM values the image entrypoint writes to files.
secrets = [modal.Secret.from_name("supertag-control-plane"), modal.Secret.from_name("supertag-control-plane-tls")]
if gateway == "on":
    secrets += [modal.Secret.from_name("supertag-gateway"), modal.Secret.from_name("supertag-gateway-tls")]
state = modal.Volume.from_name(f"{app_name}-state", create_if_missing=True)
app = modal.App(app_name)


@app.function(
    image=image,
    secrets=secrets,
    volumes={STATE_DIRECTORY: state},
    # Exactly one container, always running: every Control Plane runs the controllers.
    min_containers=1,
    max_containers=1,
    nonpreemptible=True,
    cpu=1.0,
    memory=1024,
    # Each open tunnel is one call; Modal closes it after this long and the client reconnects.
    timeout=24 * 60 * 60,
)
# Every open tunnel holds one input, so the one container accepts many at once.
@modal.concurrent(max_inputs=1000)
@modal.web_server(TUNNEL_PORT, startup_timeout=120, label=label)
def supertag():
    subprocess.Popen(PAIR_COMMAND if gateway == "on" else CONTROL_PLANE_COMMAND)
