"""Exercise locally built split service images on an isolated Docker network."""

import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import uuid

from native_archive import ArchiveError, require
from smoke_native_archive import run, wait_until


CLI = "/usr/local/bin/supertag"
TLS = "/run/supertag-tls"
CONTROL_PLANE = "https://control-plane:3434"


def certificates(root):
    root.mkdir(mode=0o755)
    ca = root / "ca.pem"
    key = root / "ca.key"
    run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
         "-subj", "/CN=SuperTag disposable smoke CA", "-keyout", str(key), "-out", str(ca)], None)
    for name, use in (("control-plane", "serverAuth"), ("gateway-client", "clientAuth"), ("worker-client", "clientAuth")):
        private = root / f"{name}.key"
        request = root / f"{name}.csr"
        public = root / f"{name}.pem"
        extensions = root / f"{name}.ext"
        extensions.write_text(f"basicConstraints=CA:FALSE\nextendedKeyUsage={use}\nsubjectAltName=DNS:{name}\n")
        run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", f"/CN={name}",
             "-keyout", str(private), "-out", str(request)], None)
        run(["openssl", "x509", "-req", "-in", str(request), "-CA", str(ca), "-CAkey", str(key),
             "-CAcreateserial", "-out", str(public), "-days", "1", "-sha256", "-extfile", str(extensions)], None)
        # Only disposable credentials are made readable in the rootless containers.
        private.chmod(0o444)
        public.chmod(0o444)
        request.unlink()
        extensions.unlink()
    key.unlink()
    (root / "ca.srl").unlink()
    ca.chmod(0o444)
    for role, files in {
        "control": ("ca.pem", "control-plane.pem", "control-plane.key"),
        "gateway": ("ca.pem", "gateway-client.pem", "gateway-client.key"),
        "worker": ("ca.pem", "worker-client.pem", "worker-client.key"),
    }.items():
        destination = root / role
        destination.mkdir(mode=0o755)
        for name in files:
            shutil.copy2(root / name, destination / name)


def env_file(path, variables):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        for name, value in variables.items():
            output.write(f"{name}={value}\n")
    return path


def docker(*arguments):
    return run(["docker", *map(str, arguments)], None)


def listening(container, address):
    return docker("inspect", "--format", "{{.State.Running}}", container).strip() == "true" and any(
        address in line for line in docker("logs", container).splitlines()
    )


def smoke(control_image, gateway_image, fixture):
    fixture = Path(fixture).resolve(strict=True)
    require(fixture.is_file() and os.access(fixture, os.X_OK), "fixture adapter must be executable")
    identifier = "supertag-split-" + uuid.uuid4().hex[:12]
    control, gateway, worker = [f"{identifier}-{kind}" for kind in ("control-plane", "gateway", "worker")]
    control_state, gateway_state = [f"{identifier}-{kind}-state" for kind in ("control", "gateway")]
    credentials = {"gateway": "stcr_" + secrets.token_hex(32), "operator": secrets.token_urlsafe(32), "worker": "stcr_" + secrets.token_hex(32)}
    with tempfile.TemporaryDirectory(prefix="supertag-split-smoke-", dir="/tmp") as temporary:
        root = Path(temporary).resolve()
        tls = root / "tls"
        certificates(tls)
        def network(role):
            return ["--network", identifier, "--mount", f"type=bind,src={tls / role},dst={TLS},readonly"]
        control_env = env_file(root / "control.env", {
            "SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL": credentials["gateway"],
            "SUPERTAG_OPERATOR_TOKEN": credentials["operator"],
            "SUPERTAG_BOOTSTRAP_HOST_TOKEN": credentials["worker"],
            "SUPERTAG_TLS_CERT_FILE": f"{TLS}/control-plane.pem",
            "SUPERTAG_TLS_KEY_FILE": f"{TLS}/control-plane.key",
            "SUPERTAG_TLS_CLIENT_CA_FILE": f"{TLS}/ca.pem",
        })
        # The Gateway holds no operator credential; operator commands below pass it explicitly.
        gateway_env = env_file(root / "gateway.env", {
            "SUPERTAG_GATEWAY_CREDENTIAL": credentials["gateway"],
            "SUPERTAG_SERVER_CA_FILE": f"{TLS}/ca.pem",
            "SUPERTAG_CLIENT_CERT_FILE": f"{TLS}/gateway-client.pem",
            "SUPERTAG_CLIENT_KEY_FILE": f"{TLS}/gateway-client.key",
        })
        worker_env = env_file(root / "worker.env", {
            "SUPERTAG_HOST_TOKEN": credentials["worker"],
            "SUPERTAG_SERVER_CA_FILE": f"{TLS}/ca.pem",
            "SUPERTAG_CLIENT_CERT_FILE": f"{TLS}/worker-client.pem",
            "SUPERTAG_CLIENT_KEY_FILE": f"{TLS}/worker-client.key",
        })

        def operator(command, *arguments):
            return json.loads(docker("exec", "--env", f"SUPERTAG_OPERATOR_TOKEN={credentials['operator']}", gateway,
                                     CLI, command, "--control-plane", CONTROL_PLANE, *arguments))

        try:
            docker("network", "create", "--internal", identifier)
            docker("volume", "create", control_state)
            docker("volume", "create", gateway_state)
            docker("run", "-d", "--name", control, *network("control"), "--network-alias", "control-plane",
                   "--env-file", control_env, "--volume", f"{control_state}:/var/lib/supertag", control_image)
            wait_until(lambda: listening(control, "0.0.0.0:3434"), "container Control Plane listener")
            docker("run", "-d", "--name", gateway, *network("gateway"), "--network-alias", "gateway",
                   "--env-file", gateway_env, "--volume", f"{gateway_state}:/var/lib/supertag", gateway_image)
            wait_until(lambda: listening(gateway, "127.0.0.1:3436"), "container Gateway listener")
            for container in (control, gateway):
                require(docker("exec", container, "id", "-u").strip() == "10001", "service is not running under its assigned UID")
            rejected = subprocess.run(
                ["docker", "exec", gateway, "openssl", "s_client", "-connect", "control-plane:3434",
                 "-servername", "control-plane", "-CAfile", f"{TLS}/ca.pem", "-verify_return_error",
                 "-tls1_3", "-alpn", "h2", "-ign_eof"],
                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10,
            )
            require(rejected.returncode != 0 and "certificate required" in rejected.stderr.lower(),
                    "Control Plane accepted TLS without a client certificate")
            operator("tag", "put", "container-fixture", "--instructions", "Container fixture")
            task = operator("task", "submit", "--tag", "container-fixture", "--session", "smoke", "split services")
            docker("run", "--name", worker, *network("worker"), "--env-file", worker_env,
                   "--mount", f"type=bind,src={fixture},dst=/run/fixture-adapter,readonly", gateway_image,
                   "worker-host", "--control-plane", CONTROL_PLANE, "--state-directory", "/var/lib/supertag/worker",
                   "--adapter", "/run/fixture-adapter", "--once")
            finished = operator("get", "task", task["task_id"])
            require(finished["state"] == "TASK_STATE_SUCCEEDED" and "split services" in finished["result"],
                    "container Task did not complete through the split services")
            docker("stop", "--time", "10", control)
            require(docker("inspect", "--format", "{{.State.ExitCode}}", control).strip() == "0", "Control Plane did not stop cleanly")
            docker("start", control)

            def restored():
                try:
                    return operator("get", "task", task["task_id"]) == finished
                except ArchiveError:
                    return False

            wait_until(restored, "persisted Task after Control Plane restart")
            for container in (gateway, control):
                docker("stop", "--time", "10", container)
                require(docker("inspect", "--format", "{{.State.ExitCode}}", container).strip() == "0", "service did not stop cleanly")
            return {"mtls": True, "public_tls": True, "nonroot": True, "task_completed": True,
                    "control_plane_restart": True, "clean_shutdown": True}
        finally:
            for arguments in (("rm", "-f", worker, gateway, control), ("volume", "rm", control_state, gateway_state),
                              ("network", "rm", identifier)):
                subprocess.run(["docker", *arguments], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=15)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--control-image", required=True)
    parser.add_argument("--gateway-image", required=True)
    parser.add_argument("--fixture-adapter", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(smoke(args.control_image, args.gateway_image, args.fixture_adapter), sort_keys=True))
    except (ArchiveError, OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Split service smoke: {error}\n")


if __name__ == "__main__":
    main()
