"""Rehearse a deployment made with `supertag setup deployment compose` on disposable containers.

The Control Plane, Gateway, and PostgreSQL run from deploy/compose.native.yaml plus
deploy/compose.native.ingress.yaml, configured only by the files setup wrote and a disposable
TLS authority. Two Worker Hosts run outside Compose with the credential-free fixture adapter and
connect outbound to the published Gateway. The rehearsal then runs the hosted image's
entrypoint (Fly.io and Railway) with TLS secrets as PEM environment values and a root-owned
volume. No cloud resource, model call, or real credential is used. Everything the rehearsal
creates is removed, and the removal is checked.

Usage:
  python3 rust/scripts/smoke_deployment_compose.py --linux-binary PATH --cli PATH \
      --fixture-adapter PATH [--receipt PATH]
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import tomllib
import uuid

REPO = Path(__file__).resolve().parents[2]
WAIT = 90
ORGANIZATION = """
apiVersion: supertag/v1
kind: PermissionSet
metadata: {name: shared-workspace}
spec:
  permissions:
    - {target: runtime, action: "files:read"}
---
apiVersion: supertag/v1
kind: Role
metadata: {name: Manager}
spec:
  purpose: Build and independently review a CSV utility in one shared workspace.
  permissionSets: [shared-workspace]
---
apiVersion: supertag/v1
kind: Tag
metadata: {name: builder-manager}
spec:
  roles: [Manager]
  instructions: "Build the CSV utility"
  acceptsMessagesFrom: [review-manager]
  runsOn: [builder-host]
---
apiVersion: supertag/v1
kind: Tag
metadata: {name: review-manager}
spec:
  roles: [Manager]
  instructions: "Review the CSV utility"
  acceptsMessagesFrom: [builder-manager]
  runsOn: [review-host]
---
apiVersion: supertag/v1
kind: Team
metadata: {name: csv}
spec: {members: [builder-manager, review-manager], maxConcurrency: 2}
"""


class RehearsalError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise RehearsalError(message)


def run(command, env=None, timeout=WAIT, check=True, cwd=None):
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    if check:
        require(result.returncode == 0, f"{' '.join(map(str, command[:4]))} failed: {result.stderr[-2000:]}")
    return result


def wait_until(check, description, seconds=WAIT):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.5)
    raise RehearsalError("timed out waiting for " + description)


def env_file(path):
    """The KEY=VALUE format setup writes, with optional single or double quotes."""
    values = {}
    for line in Path(path).read_text().splitlines():
        key, value = line.split("=", 1)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value
    return values


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def authority(root):
    """One disposable deployment CA, as Compose's in-container health probes require."""
    root.mkdir(mode=0o700)

    def openssl(*arguments):
        run(["openssl", *arguments], cwd=root)

    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
            "-subj", "/CN=SuperTag disposable deployment CA", "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", "ca.key", "-out", "ca.pem")
    for name, names, usage in (("control-plane", "DNS:control-plane", "serverAuth"),
                               ("gateway", "DNS:gateway,DNS:localhost,IP:127.0.0.1", "serverAuth"),
                               ("gateway-client", "DNS:gateway-client", "clientAuth")):
        (root / f"{name}.ext").write_text(f"subjectAltName={names}\nbasicConstraints=critical,CA:FALSE\n"
                                          f"keyUsage=critical,digitalSignature\nextendedKeyUsage={usage}\n")
        openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", f"/CN={name}",
                "-keyout", f"{name}.key", "-out", f"{name}.csr")
        openssl("x509", "-req", "-in", f"{name}.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
                "-days", "1", "-extfile", f"{name}.ext", "-out", f"{name}.pem")
    layouts = {
        "control": {"server.pem": "control-plane.pem", "server.key": "control-plane.key", "client-ca.pem": "ca.pem",
                    "server-ca.pem": "ca.pem", "client.pem": "gateway-client.pem", "client.key": "gateway-client.key"},
        "gateway": {"server.pem": "gateway.pem", "server.key": "gateway.key", "server-ca.pem": "ca.pem",
                    "client.pem": "gateway-client.pem", "client.key": "gateway-client.key"},
    }
    for role, files in layouts.items():
        directory = root / role
        directory.mkdir(mode=0o755)
        for target, source in files.items():
            shutil.copyfile(root / source, directory / target)
            # The containers run as UID 10001; only disposable keys are made readable.
            (directory / target).chmod(0o444)
    (root / "ca.key").unlink()
    return root / "ca.pem"


def build_images(binary, identifier):
    context = Path(tempfile.mkdtemp(prefix=identifier + "-context-"))
    try:
        shutil.copyfile(binary, context / "supertag")
        shutil.copyfile(REPO / "deploy/docker/rust-hosted-entrypoint.sh", context / "rust-hosted-entrypoint.sh")
        images = {}
        for target in ("control-plane", "gateway", "hosted"):
            tag = f"{identifier}-{target}:local"
            run(["docker", "build", "--quiet", "--file", str(REPO / "deploy/docker/rust-service.Dockerfile"),
                 "--target", target, "--tag", tag, "--label", f"supertag.rehearsal={identifier}", str(context)],
                timeout=600)
            images[target] = tag
        return images
    finally:
        shutil.rmtree(context)


def rehearse(args):
    identifier = "supertag-deploy-" + uuid.uuid4().hex[:10]
    cli = str(Path(args.cli).resolve(strict=True))
    adapter = str(Path(args.fixture_adapter).resolve(strict=True))
    receipt = {"format": "supertag-deployment-compose-rehearsal-v1", "compose_project": identifier}
    images = {}
    children = []
    hosted_volume = identifier + "-hosted-state"
    hosted_container = identifier + "-hosted-gateway"
    with tempfile.TemporaryDirectory(prefix=identifier + "-", dir="/tmp") as temporary:
        root = Path(temporary).resolve()
        home = root / "home"
        home.mkdir(mode=0o700)
        base_env = {"PATH": os.environ["PATH"], "HOME": str(home)}

        def supertag(*arguments, env=None, check=True):
            return run([cli, *arguments], env={**base_env, **(env or {})}, check=check)

        compose_env = None
        prefix = None
        try:
            images = build_images(args.linux_binary, identifier)
            deployment = root / "deployment"
            setup = supertag("setup", "deployment", "compose", "--non-interactive", "--output", str(deployment))
            receipt["setup_files"] = sorted(path.name for path in deployment.iterdir())
            require(receipt["setup_files"] == ["control-plane.env", "gateway.env", "operator.env", "postgres.env"],
                    "setup wrote unexpected files")
            for path in deployment.iterdir():
                require(path.stat().st_mode & 0o777 == 0o600, f"{path.name} is not private")
                for key, value in env_file(path).items():
                    if key.endswith(("_TOKEN", "_PASSWORD", "_URL")):
                        require(value not in setup.stdout, f"setup printed {key}")
            supertag("check", "deployment", "compose", "--directory", str(deployment))
            ca = authority(root / "tls")
            port = free_port()
            compose_env = {name: value for name, value in os.environ.items()
                           if not name.startswith(("COMPOSE_", "SUPERTAG_"))}
            compose_env.update({
                "SUPERTAG_POSTGRES_IMAGE": "postgres:17-alpine",
                "SUPERTAG_CONTROL_IMAGE": images["control-plane"], "SUPERTAG_GATEWAY_IMAGE": images["gateway"],
                "SUPERTAG_POSTGRES_ENV_FILE": str(deployment / "postgres.env"),
                "SUPERTAG_CONTROL_ENV_FILE": str(deployment / "control-plane.env"),
                "SUPERTAG_GATEWAY_ENV_FILE": str(deployment / "gateway.env"),
                "SUPERTAG_CONTROL_TLS_DIRECTORY": str(root / "tls/control"),
                "SUPERTAG_GATEWAY_TLS_DIRECTORY": str(root / "tls/gateway"),
                "SUPERTAG_GATEWAY_PUBLISH": f"127.0.0.1:{port}",
            })
            prefix = ["docker", "compose", "--project-directory", str(root), "--project-name", identifier,
                      "--file", str(REPO / "deploy/compose.native.yaml"),
                      "--file", str(REPO / "deploy/compose.native.ingress.yaml")]

            def compose(*arguments, timeout=WAIT):
                return run([*prefix, *arguments], env=compose_env, timeout=timeout).stdout

            def container(service):
                return compose("ps", "--all", "--quiet", service).strip()

            compose("config", "--quiet")
            compose("up", "--detach", "--wait", "--wait-timeout", "120", timeout=180)
            for service in ("postgres", "control-plane", "gateway"):
                bindings = json.loads(run(["docker", "inspect", "--format", "{{json .HostConfig.PortBindings}}",
                                           container(service)]).stdout or "null") or {}
                published = [binding for entries in bindings.values() for binding in entries or []]
                if service == "gateway":
                    require(published == [{"HostIp": "127.0.0.1", "HostPort": str(port)}],
                            f"Gateway publishes {published}")
                else:
                    require(not published, f"{service} publishes a port")
            receipt["published"] = {"gateway": f"127.0.0.1:{port}", "control-plane": None, "postgres": None}

            url = f"https://localhost:{port}"
            trust = {"SUPERTAG_SERVER_CA_FILE": str(ca)}
            operator_file = str(deployment / "operator.env")
            operator_env = {**trust, **env_file(deployment / "operator.env")}

            def verify(*extra, check=True):
                return supertag("verify", "deployment", url, "--env-file", operator_file, *extra, env=trust,
                                check=check)

            report = verify().stdout
            require("Readiness: not ready" in report, report)
            refused = verify("--require-ready", check=False)
            require(refused.returncode != 0 and "no Worker Host is ready" in refused.stderr, refused.stderr)
            refused = supertag("verify", "deployment", url, "--env-file", operator_file, check=False)
            require(refused.returncode != 0, "verification trusted an unknown authority")

            def operator(*arguments):
                return json.loads(supertag(*arguments, "--gateway", url, env=operator_env).stdout)

            manifest = root / "organization.yaml"
            manifest.write_text(ORGANIZATION)
            applied = supertag("apply", "-f", str(manifest), "--gateway", url, env=operator_env).stdout
            require("Team/csv" in applied, applied)
            hosts = {}
            for host, tag in (("review-host", "review-manager"), ("builder-host", "builder-manager")):
                issued = operator("create-auth-key", host, "--label", host, "--tag", tag)
                key = root / f"{host}.key"
                key.write_text(issued["auth_key"])
                key.chmod(0o600)
                state = root / host
                enrolled = json.loads(supertag("enroll-host", host, "--gateway", url, "--state-directory", str(state),
                                               "--auth-key", f"file:{key}", env=trust).stdout)
                require(enrolled["host_id"] == host, "unexpected host ID")
                hosts[host] = state

            def start_host(host):
                log = open(root / f"{host}.log", "w")
                child = subprocess.Popen([cli, "worker-host", "--gateway", url, "--state-directory", str(hosts[host]),
                                          "--adapter", adapter], env={**base_env, **trust}, stdin=subprocess.DEVNULL,
                                         stdout=subprocess.DEVNULL, stderr=log)
                children.append((child, log))

            def finished(task_id):
                task = operator("get-task", task_id)
                return task if task["state"] == "TASK_STATE_SUCCEEDED" else None

            start_host("review-host")
            builder_task = operator("submit", "--tag", "builder-manager", "--session", "deploy", "Write the parser")
            review_task = operator("submit", "--tag", "review-manager", "--session", "deploy", "Review the parser")
            review = wait_until(lambda: finished(review_task["task_id"]), "the review Task")
            require("Review the parser" in review["result"], review["result"])
            require(operator("get-task", builder_task["task_id"])["state"] != "TASK_STATE_SUCCEEDED",
                    "a host without the builder label ran the builder's Task")
            start_host("builder-host")
            builder = wait_until(lambda: finished(builder_task["task_id"]), "the builder Task")
            require("Write the parser" in builder["result"], builder["result"])
            wait_until(lambda: "Readiness: ready (2 Worker Hosts)" in (verify("--require-ready", check=False).stdout),
                       "both Worker Hosts to be ready")
            receipt["tasks"] = {"review-manager": review["task_id"], "builder-manager": builder["task_id"]}

            # Restart every service, including the database; work and history survive.
            events = supertag("task-events", "--gateway", url, builder["task_id"], env=operator_env).stdout
            for service in ("gateway", "control-plane", "postgres"):
                compose("stop", service)
                exit_code = run(["docker", "inspect", "--format", "{{.State.ExitCode}}", container(service)]).stdout
                require(exit_code.strip() == "0", f"{service} did not stop cleanly")
            compose("up", "--detach", "--wait", "--wait-timeout", "120", timeout=180)
            require(operator("get-task", builder["task_id"]) == builder, "Task changed across restart")
            require(supertag("task-events", "--gateway", url, builder["task_id"], env=operator_env).stdout == events,
                    "Task history changed across restart")
            wait_until(lambda: "Readiness: ready (2 Worker Hosts)" in (verify("--require-ready", check=False).stdout),
                       "Worker Hosts to reconnect after the restart")

            # The hosted image as Fly.io and Railway run it: root start, TLS from PEM secrets,
            # a root-owned volume, and the Gateway command from the Fly definition.
            fly = tomllib.loads((REPO / "deploy/native/fly/gateway.toml").read_text())
            command = fly["processes"]["app"].replace("supertag-control-plane.internal", "control-plane").split()
            hosted_port = free_port()
            pem = {name: (root / "tls/gateway" / file).read_text() for name, file in (
                ("SUPERTAG_TLS_CERT_PEM", "server.pem"), ("SUPERTAG_TLS_KEY_PEM", "server.key"),
                ("SUPERTAG_SERVER_CA_PEM", "server-ca.pem"), ("SUPERTAG_CLIENT_CERT_PEM", "client.pem"),
                ("SUPERTAG_CLIENT_KEY_PEM", "client.key"))}
            # Hosted env files come from setup for Fly.io, reusing this deployment's database and
            # tokens so the hosted Gateway joins the same Control Plane.
            compose_gateway = env_file(deployment / "gateway.env")
            hosted = root / "hosted-deployment"
            supertag("setup", "deployment", "fly", "--non-interactive", "--output", str(hosted), env={
                "SUPERTAG_DATABASE_URL": env_file(deployment / "control-plane.env")["SUPERTAG_DATABASE_URL"],
                "SUPERTAG_GATEWAY_TOKEN": compose_gateway["SUPERTAG_GATEWAY_TOKEN"],
                "SUPERTAG_OPERATOR_TOKEN": compose_gateway["SUPERTAG_OPERATOR_TOKEN"],
            })
            supertag("check", "deployment", "fly", "--directory", str(hosted))
            gateway_env = {**pem, **env_file(hosted / "gateway.env")}
            require(not any(key.endswith("_FILE") for key in gateway_env), "hosted env names TLS files")
            run(["docker", "volume", "create", "--label", f"supertag.rehearsal={identifier}", hosted_volume])
            run(["docker", "create", "--name", hosted_container, "--label", f"supertag.rehearsal={identifier}",
                 "--network", f"{identifier}_runtime", "--publish", f"127.0.0.1:{hosted_port}:3434",
                 "--volume", f"{hosted_volume}:/var/lib/supertag", "--cap-drop", "ALL",
                 *[flag for capability in ("CHOWN", "SETUID", "SETGID", "SETPCAP", "DAC_OVERRIDE", "FOWNER")
                   for flag in ("--cap-add", capability)],
                 *[flag for key in gateway_env for flag in ("--env", key)], images["hosted"], *command],
                env={**os.environ, **gateway_env})
            run(["docker", "network", "connect", f"{identifier}_ingress", hosted_container])
            run(["docker", "start", hosted_container])
            hosted_url = f"https://localhost:{hosted_port}"
            wait_until(lambda: supertag("verify", "deployment", hosted_url, "--env-file", operator_file, "--require-ready",
                                        env=trust, check=False).returncode == 0, "the hosted Gateway")
            # PID 1 is tini, exec'd by setpriv; the Gateway is its child.
            for pid in ("1", run(["docker", "exec", hosted_container, "cat", "/proc/1/task/1/children"]).stdout.split()[0]):
                status = dict(line.split(":", 1) for line in run(
                    ["docker", "exec", hosted_container, "cat", f"/proc/{pid}/status"]).stdout.splitlines())
                require(status["Uid"].split() == ["10001"] * 4 and status["Gid"].split() == ["10001"] * 4
                        and status["NoNewPrivs"].strip() == "1" and int(status["CapEff"], 16) == 0
                        and int(status["CapBnd"], 16) == 0, f"hosted process {pid} kept privileges: {status}")
            command_line = run(["docker", "exec", hosted_container, "cat", f"/proc/{pid}/cmdline"]).stdout
            require(command_line.split("\0")[:2] == ["/usr/local/bin/supertag", "gateway"], command_line)
            # Read as the service user: root in this container has no ptrace capability.
            environment = run(["docker", "exec", "--user", "10001:10001", hosted_container, "cat",
                               f"/proc/{pid}/environ"]).stdout
            require("SUPERTAG_TLS_CERT_FILE=/run/supertag-tls/server.pem" in environment
                    and "PEM=" not in environment, "the hosted service environment is not as expected")
            ownership = run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "/usr/bin/stat",
                             "--volume", f"{hosted_volume}:/state", images["control-plane"], "-c", "%u %a", "/state",
                             "/state/checkpoints"], check=False).stdout.split("\n")
            require(ownership[0] == "10001 700", f"hosted volume ownership {ownership}")
            receipt["hosted_image"] = {"tls_from_pem_secrets": True, "uid": 10001, "volume_owner": ownership[0],
                                       "command_from": "deploy/native/fly/gateway.toml"}
            receipt.update({"postgresql": True, "private_mtls": True, "public_tls": True, "verify_deployment": True,
                            "outbound_worker_hosts": 2, "label_placement": True, "restart_preserved_work": True})
            return receipt
        finally:
            failure = sys.exc_info()[1]
            problems = []
            for child, log in children:
                child.terminate()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
                log.close()
            if failure:
                for name in ("review-host.log", "builder-host.log"):
                    path = root / name
                    if path.exists():
                        print(f"--- {name}\n{path.read_text()[-3000:]}", file=sys.stderr)
                if prefix:
                    logs = subprocess.run([*prefix, "logs", "--no-color"], env=compose_env, capture_output=True,
                                          text=True, timeout=60)
                    print(logs.stdout[-6000:], file=sys.stderr)
            subprocess.run(["docker", "rm", "--force", hosted_container], capture_output=True, timeout=60)
            if prefix:
                result = subprocess.run([*prefix, "down", "--volumes", "--remove-orphans", "--timeout", "15"],
                                        env=compose_env, capture_output=True, text=True, timeout=120)
                if result.returncode:
                    problems.append("compose down failed: " + result.stderr[-500:])
            subprocess.run(["docker", "volume", "rm", "--force", hosted_volume], capture_output=True, timeout=60)
            for image in images.values():
                subprocess.run(["docker", "image", "rm", "--force", image], capture_output=True, timeout=120)
            for kind, flags in (("container", ["--all"]), ("network", []), ("volume", [])):
                for label in (f"com.docker.compose.project={identifier}", f"supertag.rehearsal={identifier}"):
                    remaining = subprocess.run(["docker", kind, "ls", *flags, "--quiet", "--filter", f"label={label}"],
                                               capture_output=True, text=True, timeout=60).stdout.strip()
                    if remaining:
                        problems.append(f"left {kind}: {remaining}")
            remaining = subprocess.run(["docker", "image", "ls", "--quiet", "--filter",
                                        f"label=supertag.rehearsal={identifier}"],
                                       capture_output=True, text=True, timeout=60).stdout.strip()
            if remaining:
                problems.append("left images: " + remaining)
            if problems and not failure:
                raise RehearsalError("cleanup failed: " + "; ".join(problems))
            if not problems:
                receipt["cleanup_verified"] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--linux-binary", required=True, help="Linux supertag built from this checkout")
    parser.add_argument("--cli", required=True, help="supertag for this machine, built from this checkout")
    parser.add_argument("--fixture-adapter", required=True, help="supertag-fixture-adapter for this machine")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    try:
        receipt = rehearse(args)
    except (RehearsalError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Deployment Compose rehearsal: {error}\n")
    text = json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    if args.receipt:
        with open(args.receipt, "x") as output:
            output.write(text)
    print(text, end="")


if __name__ == "__main__":
    main()
