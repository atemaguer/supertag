"""Host the standard SuperTag image on Modal; see README.md."""

import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request

import modal

# Generated from deploy/shared; the image carries the same contract remotely.
config_path = (
    Path(__file__).with_name("runtime.json")
    if modal.is_local()
    else Path("/opt/supertag-deploy/runtime.json")
)
runtime = json.loads(config_path.read_text())
image_ref = os.environ.get("SUPERTAG_MODAL_IMAGE")
app_name = os.environ.get("SUPERTAG_MODAL_APP", "supertag-control-plane")
secret_name = os.environ.get("SUPERTAG_MODAL_SECRET", "supertag-control-plane")
registry_secret = os.environ.get("SUPERTAG_MODAL_REGISTRY_SECRET")
source_root = Path(__file__).resolve().parents[2] if modal.is_local() else Path("/app")
base_image = (
    modal.Image.from_registry(
        image_ref,
        add_python="3.12",
        secret=modal.Secret.from_name(registry_secret) if registry_secret else None,
    )
    if image_ref
    else modal.Image.from_dockerfile(
        source_root / "deploy" / "docker" / "Dockerfile",
        context_dir=source_root,
        add_python="3.12",
    )
)
image = (
    base_image.entrypoint([])
    .add_local_file(config_path, "/opt/supertag-deploy/runtime.json", copy=True)
    .env({
        "SUPERTAG_MODAL_IMAGE": image_ref or "",
        "SUPERTAG_MODAL_APP": app_name,
        "SUPERTAG_MODAL_SECRET": secret_name,
    })
)
secrets = [modal.Secret.from_name(secret_name)]
app = modal.App(app_name)
# Migration invocations must not start the serving App before schema readiness.
migration_app = modal.App(f"{app_name}-migrations")


@migration_app.function(image=image, secrets=secrets, timeout=600)
def migrate():
    """Run before deployment."""
    command = ["/usr/local/bin/supertag-entrypoint", *runtime["migrationArguments"]]
    subprocess.run(command, cwd="/app", check=True)


class ControlPlaneProcess:
    """Supervise Node and wait for application health, including startup failure cleanup."""

    def start(self):
        environment = dict(os.environ)
        for key, value in runtime["environment"].items():
            environment.setdefault(key, value)
        environment["PORT"] = str(runtime["port"])
        self.process = subprocess.Popen(
            ["/usr/local/bin/supertag-entrypoint", *runtime["startArguments"]],
            cwd="/app",
            env=environment,
            start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 270
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError("SuperTag exited before becoming healthy")
                try:
                    with urllib.request.urlopen(
                        f'http://127.0.0.1:{runtime["port"]}{runtime["healthPath"]}',
                        timeout=2,
                    ) as response:
                        if json.load(response).get("ok") is True:
                            return
                except (OSError, ValueError):
                    pass
                time.sleep(0.25)
            raise TimeoutError("SuperTag health check timed out")
        except BaseException:
            self.stop()
            raise

    def stop(self):
        process = getattr(self, "process", None)
        if process is None or process.poll() is not None:
            return
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


@app.server(
    image=image,
    secrets=secrets,
    port=runtime["port"],
    min_containers=1,
    max_containers=1,
    cpu=1.0,
    memory=1024,
    startup_timeout=300,
    exit_grace_period=0,
    name="control-plane",
    # SuperTag authenticates management and Worklet requests itself. An extra
    # Modal proxy token would prevent standard clients and webhooks connecting.
    unauthenticated=True,
)
class ControlPlane:
    @modal.enter()
    def start(self):
        self.supervisor = ControlPlaneProcess()
        self.supervisor.start()

    @modal.exit()
    def stop(self):
        if hasattr(self, "supervisor"):
            self.supervisor.stop()
