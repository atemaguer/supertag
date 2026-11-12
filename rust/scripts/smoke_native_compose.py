"""Rehearse native split Compose on fresh PostgreSQL, with no exposed ports or providers."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import uuid

from native_archive import ArchiveError, REPO, digest, require
from smoke_native_archive import run
from smoke_split_service_images import CLI, GATEWAY, TLS, certificates, docker, env_file


def smoke(control_image, gateway_image, fixture):
    fixture = Path(fixture).resolve(strict=True)
    require(fixture.is_file() and os.access(fixture, os.X_OK), "fixture adapter must be executable")
    identifier = "supertag-native-compose-" + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix=identifier + "-", dir="/tmp") as temporary:
        root = Path(temporary).resolve()
        tls = root / "tls"
        certificates(tls)
        # The private health probe also proves the configured client identity.
        # Only synthetic credentials are used, and neither private key is in the worker.
        for name in ("gateway-client.pem", "gateway-client.key"):
            shutil.copy2(tls / name, tls / "control" / name)
        credentials = {name: secrets.token_hex(32) for name in ("gateway", "operator", "worker", "database")}
        postgres_env = env_file(root / "postgres.env", {
            "POSTGRES_DB": "supertag", "POSTGRES_USER": "supertag", "POSTGRES_PASSWORD": credentials["database"],
        })
        control_env = env_file(root / "control.env", {
            "SUPERTAG_DATABASE_URL": f"postgresql://supertag:{credentials['database']}@postgres:5432/supertag",
            "SUPERTAG_GATEWAY_TOKEN": credentials["gateway"],
            "SUPERTAG_BOOTSTRAP_HOST_TOKEN": credentials["worker"],
            "SUPERTAG_TLS_CERT_FILE": f"{TLS}/control-plane.pem", "SUPERTAG_TLS_KEY_FILE": f"{TLS}/control-plane.key",
            "SUPERTAG_TLS_CLIENT_CA_FILE": f"{TLS}/ca.pem", "SUPERTAG_SERVER_CA_FILE": f"{TLS}/ca.pem",
            "SUPERTAG_CLIENT_CERT_FILE": f"{TLS}/gateway-client.pem", "SUPERTAG_CLIENT_KEY_FILE": f"{TLS}/gateway-client.key",
        })
        gateway_env = env_file(root / "gateway.env", {
            "SUPERTAG_GATEWAY_TOKEN": credentials["gateway"], "SUPERTAG_OPERATOR_TOKEN": credentials["operator"],
            "SUPERTAG_TLS_CERT_FILE": f"{TLS}/gateway.pem", "SUPERTAG_TLS_KEY_FILE": f"{TLS}/gateway.key",
            "SUPERTAG_SERVER_CA_FILE": f"{TLS}/ca.pem", "SUPERTAG_CLIENT_CERT_FILE": f"{TLS}/gateway-client.pem",
            "SUPERTAG_CLIENT_KEY_FILE": f"{TLS}/gateway-client.key",
        })
        worker_env = env_file(root / "worker.env", {
            "SUPERTAG_HOST_TOKEN": credentials["worker"], "SUPERTAG_SERVER_CA_FILE": f"{TLS}/ca.pem",
        })
        env = {name: value for name, value in os.environ.items()
               if not name.startswith(("COMPOSE_", "SUPERTAG_"))}
        env.update({"SUPERTAG_POSTGRES_IMAGE": "postgres:17-alpine", "SUPERTAG_CONTROL_IMAGE": control_image, "SUPERTAG_GATEWAY_IMAGE": gateway_image,
                    "SUPERTAG_POSTGRES_ENV_FILE": str(postgres_env), "SUPERTAG_CONTROL_ENV_FILE": str(control_env),
                    "SUPERTAG_GATEWAY_ENV_FILE": str(gateway_env), "SUPERTAG_CONTROL_TLS_DIRECTORY": str(tls / "control"),
                    "SUPERTAG_GATEWAY_TLS_DIRECTORY": str(tls / "gateway")})
        # Worker images are a separate distribution concern. This provider-free
        # fixture mounts its matching adapter explicitly; it is never baked into a service image.
        override = root / "fixture.json"
        override.write_text(json.dumps({"services": {"worker": {
            "image": gateway_image, "profiles": ["fixture"], "env_file": str(worker_env),
            "command": ["worker-host", "--gateway", GATEWAY, "--state-directory", "/var/lib/supertag/worker",
                        "--adapter", "/run/fixture-adapter", "--once"],
            "volumes": [f"{tls / 'worker'}:{TLS}:ro", f"{fixture}:/run/fixture-adapter:ro", "worker-state:/var/lib/supertag"],
            "read_only": True, "tmpfs": ["/tmp:uid=10001,gid=10001,mode=0700"],
            "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "networks": ["runtime"],
            "stop_grace_period": "15s",
        }}, "volumes": {"worker-state": {}}}))
        prefix = ["docker", "compose", "--project-directory", str(root), "--project-name", identifier, "--file", str(REPO / "deploy/compose.native.yaml"),
                  "--file", str(override)]
        def compose(*arguments, timeout=90):
            return run([*prefix, *arguments], env, timeout=timeout)
        def operator(command, *arguments):
            return json.loads(compose("exec", "-T", "gateway", CLI, command, "--gateway", GATEWAY, *arguments))
        def task_events(task_id):
            output = compose("exec", "-T", "gateway", CLI, "task-events", "--gateway", GATEWAY, task_id)
            return [json.loads(line) for line in output.splitlines()]
        def container(service):
            return compose("ps", "--all", "--quiet", service).strip()
        try:
            compose("config", "--quiet")
            compose("up", "--detach", "--wait", "--wait-timeout", "90", "gateway", timeout=120)
            for service in ("control-plane", "gateway"):
                identity = container(service)
                require(identity, "service container is missing")
                require(docker("inspect", "--format", "{{.State.Health.Status}}", identity).strip() == "healthy",
                        "gRPC health probe did not pass")
                require(compose("exec", "-T", service, "id", "-u").strip() == "10001", "service is not running as assigned UID")
                require(docker("inspect", "--format", "{{json .HostConfig.PortBindings}}", identity).strip() in ("{}", "null"),
                        "rehearsal unexpectedly published a service port")
            # No client certificate may reach private APIs, including health.
            rejected = subprocess.run([*prefix, "exec", "-T", "gateway", "env", "-u", "SUPERTAG_CLIENT_CERT_FILE", "-u",
                                       "SUPERTAG_CLIENT_KEY_FILE", CLI, "health", "--endpoint", "https://control-plane:3435"],
                                      env=env, capture_output=True, text=True, timeout=15)
            require(rejected.returncode != 0, "private health accepted a client without its identity")
            # The public health API is intentionally read-only and token-free;
            # accepting Task mutations still requires a named operator token.
            rejected = subprocess.run([*prefix, "exec", "-T", "gateway", "env", "SUPERTAG_OPERATOR_TOKEN=synthetic-invalid", CLI,
                                       "put-tag", "unauthorized", "--gateway", GATEWAY, "--instructions", "must not exist"],
                                      env=env, capture_output=True, text=True, timeout=15)
            require(rejected.returncode != 0, "operator mutation accepted an invalid token")
            operator("put-tag", "compose-fixture", "--instructions", "Native Compose fixture")
            submit = ("--tag", "compose-fixture", "--session", "rehearsal", "--operation-id", "compose-request", "through native Compose")
            task = operator("submit", *submit)
            compose("run", "--rm", "--no-deps", "worker", timeout=90)
            finished = operator("get-task", task["task_id"])
            require(finished["state"] == "TASK_STATE_SUCCEEDED" and "through native Compose" in finished["result"],
                    "Task did not complete through native Compose")
            events = task_events(task["task_id"])
            require(events, "Task event history is empty")
            # Stop each dependent cleanly, then restart the real database as well.
            for service in ("gateway", "control-plane", "postgres"):
                compose("stop", service)
                require(docker("inspect", "--format", "{{.State.ExitCode}}", container(service)).strip() == "0",
                        "service did not stop cleanly")
            compose("up", "--detach", "--wait", "--wait-timeout", "90", "gateway", timeout=120)
            require(operator("get-task", task["task_id"]) == finished, "Task changed across full service restart")
            require(task_events(task["task_id"]) == events, "Task event history changed after restart")
            require(operator("submit", *submit)["task_id"] == task["task_id"], "request replay created another Task")
            return {"format": "supertag-native-compose-rehearsal-v1", "compose_project": identifier,
                    "images": {service: {"tag": image, "id": docker("image", "inspect", "--format", "{{.Id}}", image).strip()}
                               for service, image in (("control-plane", control_image), ("gateway", gateway_image))},
                    "fixture_sha256": digest(fixture), "postgresql": True, "private_mtls": True, "public_tls": True,
                    "grpc_health": True, "operator_auth": True, "nonroot": True, "no_published_ports": True,
                    "task_completed": True, "database_and_services_restart": True, "event_replay": True, "submission_dedup": True,
                    "clean_shutdown": True, "cleanup_verified": True,
                    "task_id": task["task_id"]}
        finally:
            # Only this randomly named Compose project is owned by the rehearsal.
            failure = sys.exc_info()[1]
            try:
                # Include the opt-in worker profile: Compose otherwise omits its
                # named volume when resolving the teardown resource set.
                compose("--profile", "fixture", "down", "--volumes", "--remove-orphans", "--timeout", "15")
                for kind in ("container", "network", "volume"):
                    remaining = docker(kind, "ls", *(["--all"] if kind == "container" else []), "--quiet",
                                       "--filter", f"label=com.docker.compose.project={identifier}")
                    require(not remaining.strip(), "rehearsal left an owned " + kind)
            except Exception as cleanup:
                if failure:
                    raise ArchiveError(f"rehearsal failed ({failure}); cleanup failed ({cleanup})") from cleanup
                raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--control-image", required=True)
    parser.add_argument("--gateway-image", required=True)
    parser.add_argument("--fixture-adapter", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    try:
        require(not args.receipt.exists(), "receipt already exists")
        result = smoke(args.control_image, args.gateway_image, args.fixture_adapter)
        args.receipt.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        print(json.dumps(result, sort_keys=True))
    except (ArchiveError, OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Native Compose rehearsal: {error}\n")


if __name__ == "__main__":
    main()
