"""Rehearse the Render, Cloudflare, and Modal deployment shapes on disposable containers.

These platforms terminate TLS at their own edge and forward only HTTP/1.1, so the Control Plane
runs the WebSocket tunnel listener and SuperTag's TLS runs inside the tunnel. An nginx container
stands in for each platform's edge: it terminates TLS with its own certificate, forwards
WebSocket upgrades and the plain `GET /healthz` health check to one container port, and refuses
everything else. Neither Render, Cloudflare, nor Modal is contacted, and no Worker (workerd) or
Modal runtime runs here: the Cloudflare Worker's routing is covered by
tests/cloudflare-tunnel-worker.test.ts, and the commands below are read from the checked-in
definitions so they run unchanged.

- Render (deploy/render/render.yaml): the Control Plane service command with the Blueprint's
  database URL and PORT, the platform health check through the edge, `verify deployment` over
  wss://, a Worker Host that enrolls and completes a Task through the edge, and the Gateway
  worker dialing wss://supertag-control-plane.onrender.com (the edge's alias here) with its
  client certificate. The Control Plane container's start command replaces the image entrypoint
  and the Gateway's only replaces its command, covering both readings of a platform start
  command.
- Cloudflare and Modal (deploy/cloudflare/src/routing.ts, deploy/modal/app.py): the Control Plane
  alone, then the Control Plane and Gateway in one container (`supertag-hosted-entrypoint pair`):
  health, verification, the Gateway resolving the operator's credential through the loopback
  Control Plane, per-process environments, UID 10001 without capabilities, the container exiting
  when either service dies, and a clean stop on SIGTERM.

Everything the rehearsal creates is removed, and the removal is checked.

Usage:
  python3 rust/scripts/smoke_deployment_http_platforms.py --linux-binary PATH --cli PATH \
      --fixture-adapter PATH [--receipt PATH]
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import uuid

REPO = Path(__file__).resolve().parents[2]
WAIT = 120
RENDER_HOST = "supertag-control-plane.onrender.com"


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
    """The KEY=VALUE format setup writes, optionally single-quoted."""
    values = {}
    for line in Path(path).read_text().splitlines():
        key, value = line.split("=", 1)
        if len(value) >= 2 and value[0] == value[-1] == "'":
            value = value[1:-1]
        values[key] = value
    return values


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def definitions():
    """The service commands exactly as the checked-in platform definitions give them."""
    render = REPO / "deploy/render/render.yaml"
    commands = re.findall(r"^\s*dockerCommand: (.+)$", render.read_text(), re.MULTILINE)
    require(len(commands) == 2, "render.yaml should define two service commands")

    def literal(path, name):
        text = path.read_text()
        match = re.search(rf"{name} = \[(.*?)\]", text, re.DOTALL)
        require(match is not None, f"{path.name} has no {name}")
        items = [item.strip() for item in match.group(1).split(",") if item.strip()]
        return ["/usr/local/bin/supertag-hosted-entrypoint" if item == "ENTRYPOINT" else item.strip('"')
                for item in items]

    routing = REPO / "deploy/cloudflare/src/routing.ts"
    modal = REPO / "deploy/modal/app.py"
    shapes = {
        "render_control_plane": commands[0].split(),
        "render_gateway": commands[1].split(),
        "cloudflare_control_plane": literal(routing, "CONTROL_PLANE_COMMAND"),
        "cloudflare_pair": literal(routing, "PAIR_COMMAND"),
        "modal_control_plane": literal(modal, "CONTROL_PLANE_COMMAND"),
        "modal_pair": literal(modal, "PAIR_COMMAND"),
    }
    require(shapes["cloudflare_control_plane"] == shapes["modal_control_plane"],
            "Cloudflare and Modal run different Control Plane commands")
    require(shapes["cloudflare_pair"] == shapes["modal_pair"], "Cloudflare and Modal run different pairs")
    require(f"wss://{RENDER_HOST}" in shapes["render_gateway"], "unexpected Render Gateway upstream")
    return shapes


def authority(root):
    root.mkdir(mode=0o700)

    def openssl(*arguments):
        run(["openssl", *arguments], cwd=root)

    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
            "-subj", "/CN=SuperTag disposable deployment CA", "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", "ca.key", "-out", "ca.pem")
    # The service certificate names the public hosts and the pair's loopback address. The edge
    # has a certificate of its own, as a platform does.
    public = f"DNS:localhost,DNS:{RENDER_HOST}"
    for name, names, usage in (("control-plane", public + ",IP:127.0.0.1", "serverAuth"),
                               ("edge", public, "serverAuth"),
                               ("gateway-client", "DNS:gateway-client", "clientAuth"),
                               ("operator-client", "DNS:operator-client", "clientAuth"),
                               ("host-client", "DNS:host-client", "clientAuth")):
        (root / f"{name}.ext").write_text(f"subjectAltName={names}\nbasicConstraints=critical,CA:FALSE\n"
                                          f"keyUsage=critical,digitalSignature\nextendedKeyUsage={usage}\n")
        openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", f"/CN={name}",
                "-keyout", f"{name}.key", "-out", f"{name}.csr")
        openssl("x509", "-req", "-in", f"{name}.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
                "-days", "1", "-extfile", f"{name}.ext", "-out", f"{name}.pem")
    (root / "ca.key").unlink()
    for path in root.iterdir():
        path.chmod(0o444)
    return root


def build_image(binary, identifier):
    context = Path(tempfile.mkdtemp(prefix=identifier + "-context-"))
    try:
        shutil.copyfile(binary, context / "supertag")
        for script in ("rust-hosted-entrypoint.sh", "rust-hosted-pair.sh"):
            shutil.copyfile(REPO / "deploy/docker" / script, context / script)
        tag = f"{identifier}-hosted:local"
        run(["docker", "build", "--quiet", "--file", str(REPO / "deploy/docker/rust-service.Dockerfile"),
             "--target", "hosted", "--tag", tag, "--label", f"supertag.rehearsal={identifier}", str(context)],
            timeout=600)
        return tag
    finally:
        shutil.rmtree(context)


NGINX = """worker_processes 1;
events {{ worker_connections 256; }}
http {{
  access_log /dev/stdout;
  map $http_upgrade $websocket {{ websocket 1; default 0; }}
  resolver 127.0.0.11 valid=5s;
  server {{
    listen 443 ssl;
    ssl_certificate /etc/edge/edge.pem;
    ssl_certificate_key /etc/edge/edge.key;
    set $backend {backend};
    location = /healthz {{
      proxy_pass http://$backend:8080;
      proxy_http_version 1.1;
    }}
    location / {{
      if ($websocket = 0) {{ return 426; }}
      proxy_pass http://$backend:8080;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_read_timeout 100s;
      proxy_send_timeout 100s;
    }}
  }}
}}
"""


def rehearse(args):
    identifier = "supertag-http-" + uuid.uuid4().hex[:10]
    cli = str(Path(args.cli).resolve(strict=True))
    adapter = str(Path(args.fixture_adapter).resolve(strict=True))
    receipt = {"format": "supertag-deployment-http-platforms-rehearsal-v1"}
    shapes = definitions()
    image = None
    containers = []
    volumes = []
    network = identifier
    label = f"supertag.rehearsal={identifier}"
    with tempfile.TemporaryDirectory(prefix=identifier + "-", dir="/tmp") as temporary:
        root = Path(temporary).resolve()
        home = root / "home"
        home.mkdir(mode=0o700)
        base_env = {"PATH": os.environ["PATH"], "HOME": str(home)}

        def supertag(*arguments, env=None, check=True):
            return run([cli, *arguments], env={**base_env, **(env or {})}, check=check)

        def docker_run(name, environment, command, *flags, entrypoint=None):
            """A hosted-image container; secrets pass by name so they never reach a command line."""
            extra = ["--entrypoint", entrypoint] if entrypoint else []
            run(["docker", "run", "--detach", "--name", name, "--label", label, "--network", network,
                 "--cap-drop", "ALL", *[flag for capability in ("CHOWN", "SETUID", "SETGID", "SETPCAP",
                                                                 "DAC_OVERRIDE", "FOWNER")
                                       for flag in ("--cap-add", capability)],
                 *flags, *[flag for key in environment for flag in ("--env", key)], *extra, image, *command],
                env={**os.environ, **environment})
            containers.append(name)
            return name

        def remove(name):
            subprocess.run(["docker", "rm", "--force", name], capture_output=True, timeout=60)

        try:
            image = build_image(args.linux_binary, identifier)
            run(["docker", "network", "create", "--label", label, network])
            tls = authority(root / "tls")
            ca = tls / "ca.pem"
            pem = {name: (tls / file).read_text() for name, file in (
                ("SUPERTAG_TLS_CERT_PEM", "control-plane.pem"), ("SUPERTAG_TLS_KEY_PEM", "control-plane.key"),
                ("SUPERTAG_TLS_CLIENT_CA_PEM", "ca.pem"), ("SUPERTAG_SERVER_CA_PEM", "ca.pem"),
                ("SUPERTAG_CLIENT_CERT_PEM", "gateway-client.pem"),
                ("SUPERTAG_CLIENT_KEY_PEM", "gateway-client.key"))}
            control_pem = {key: pem[key] for key in ("SUPERTAG_TLS_CERT_PEM", "SUPERTAG_TLS_KEY_PEM",
                                                      "SUPERTAG_TLS_CLIENT_CA_PEM")}
            gateway_pem = {key: pem[key] for key in ("SUPERTAG_SERVER_CA_PEM", "SUPERTAG_CLIENT_CERT_PEM",
                                                      "SUPERTAG_CLIENT_KEY_PEM")}

            # PostgreSQL stands in for Render's database and the external one Cloudflare and
            # Modal use.
            password = uuid.uuid4().hex
            postgres = identifier + "-postgres"
            run(["docker", "run", "--detach", "--name", postgres, "--label", label, "--network", network,
                 "--network-alias", "postgres", "--env", "POSTGRES_USER=supertag", "--env", "POSTGRES_DB=supertag",
                 "--env", "POSTGRES_PASSWORD", "postgres:17-alpine"],
                env={**os.environ, "POSTGRES_PASSWORD": password}, timeout=300)
            containers.append(postgres)
            wait_until(lambda: run(["docker", "exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "supertag"],
                                   check=False).returncode == 0, "PostgreSQL")
            database = f"postgresql://supertag:{password}@postgres:5432/supertag"

            # Setup's files for each platform.
            render = root / "render"
            supertag("setup", "deployment", "render", "--non-interactive", "--output", str(render))
            supertag("check", "deployment", "render", "--directory", str(render))
            pair_files = root / "cloudflare"
            supertag("setup", "deployment", "cloudflare", "--non-interactive", "--output", str(pair_files), env={
                "SUPERTAG_DATABASE_URL": database, "VAULT_ADDR": "https://vault.example.com",
                "VAULT_TOKEN": "rehearsal-vault-token"})
            for platform in ("cloudflare", "modal"):
                supertag("check", "deployment", platform, "--directory", str(pair_files))
            receipt["setup_checked"] = ["render", "cloudflare", "modal"]

            # The edge: TLS with its own certificate, HTTP/1.1, upgrades and /healthz only.
            edge_port = free_port()
            edge_directory = root / "edge"
            edge_directory.mkdir()
            for name in ("edge.pem", "edge.key"):
                shutil.copyfile(tls / name, edge_directory / name)
                (edge_directory / name).chmod(0o444)

            def start_edge(backend, *aliases):
                (edge_directory / "nginx.conf").write_text(NGINX.format(backend=backend))
                name = f"{identifier}-edge"
                remove(name)
                run(["docker", "run", "--detach", "--name", name, "--label", label, "--network", network,
                     *[flag for alias in aliases for flag in ("--network-alias", alias)],
                     "--publish", f"127.0.0.1:{edge_port}:443", "--volume", f"{edge_directory}:/etc/edge:ro",
                     "nginx:1.27-alpine", "nginx", "-c", "/etc/edge/nginx.conf", "-g", "daemon off;"], timeout=300)
                if name not in containers:
                    containers.append(name)

            context = ssl.create_default_context(cafile=str(ca))

            def https_get(path, headers=None):
                import http.client
                connection = http.client.HTTPSConnection("localhost", edge_port, context=context, timeout=10)
                try:
                    connection.request("GET", path, headers=headers or {})
                    response = connection.getresponse()
                    return response.status, response.read()
                except OSError:
                    return None, b""
                finally:
                    connection.close()

            public = f"wss://localhost:{edge_port}"
            operator_file = str(pair_files / "operator.env")
            trust = {"SUPERTAG_SERVER_CA_FILE": str(ca)}
            operator_tls = {**trust, "SUPERTAG_CLIENT_CERT_FILE": str(tls / "operator-client.pem"),
                            "SUPERTAG_CLIENT_KEY_FILE": str(tls / "operator-client.key")}
            host_tls = {**trust, "SUPERTAG_CLIENT_CERT_FILE": str(tls / "host-client.pem"),
                        "SUPERTAG_CLIENT_KEY_FILE": str(tls / "host-client.key")}

            def healthy_through_edge():
                status, body = https_get("/healthz")
                return status == 200 and body == b"ok\n"

            def check_edge_rules():
                require(https_get("/healthz", {"Origin": "https://evil.example"})[0] != 200,
                        "the health route answered a browser")
                require(https_get("/")[0] == 426, "the edge forwarded a plain request")

            def verify(operator_env_file, env, *extra, check=True):
                return supertag("verify", "deployment", public, "--env-file", operator_env_file, *extra, env=env,
                                check=check)

            # ---- Render ---------------------------------------------------------------------
            render_control = env_file(render / "control-plane.env")
            render_gateway = env_file(render / "gateway.env")
            # Render shares one database with the pair shapes below, so it uses the same credentials.
            pair_credential = env_file(pair_files / "gateway.env")["SUPERTAG_GATEWAY_CREDENTIAL"]
            render_control["SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL"] = pair_credential
            render_gateway["SUPERTAG_GATEWAY_CREDENTIAL"] = pair_credential
            render_control["SUPERTAG_OPERATOR_TOKEN"] = env_file(pair_files / "operator.env")["SUPERTAG_OPERATOR_TOKEN"]
            render_operator = operator_file
            control_volume = identifier + "-control-state"
            run(["docker", "volume", "create", "--label", label, control_volume])
            volumes.append(control_volume)
            render_cp = docker_run(
                identifier + "-render-control-plane",
                {**render_control, **control_pem, "SUPERTAG_DATABASE_URL": database, "PORT": "8080"},
                shapes["render_control_plane"][1:], "--volume", f"{control_volume}:/var/lib/supertag",
                entrypoint=shapes["render_control_plane"][0])
            start_edge(render_cp, RENDER_HOST)
            wait_until(healthy_through_edge, "Render's health check through the edge")
            check_edge_rules()
            report = verify(render_operator, operator_tls).stdout
            require("Readiness: not ready" in report, report)
            refused = verify(render_operator, trust, check=False)
            require(refused.returncode != 0, "the Control Plane accepted an operator without a client certificate")
            require(verify(render_operator, {}, check=False).returncode != 0,
                    "verification trusted the platform hostname without the deployment CA")
            native = supertag("verify", "deployment", f"https://localhost:{edge_port}", "--env-file", render_operator,
                              env=operator_tls, check=False)
            require(native.returncode != 0, "native gRPC crossed the HTTP-only edge")

            operator_env = {**operator_tls, **env_file(operator_file)}

            def operator(*arguments):
                return json.loads(supertag(*arguments, "--control-plane", public, env=operator_env).stdout)

            operator("tag", "put", "edge", "--instructions", "Answer through the edge")
            issued = operator("auth-key", "create", "edge-host", "--role", "host", "--tag", "edge")
            key = root / "edge-host.key"
            key.write_text(issued["auth_key"])
            key.chmod(0o600)
            host_state = root / "edge-host"
            enrolled = json.loads(supertag("host", "enroll", "edge-host", "--control-plane", public,
                                           "--state-directory", str(host_state), "--auth-key", f"file:{key}",
                                           env=host_tls).stdout)
            require(enrolled["host_id"] == "edge-host", "unexpected host ID")
            task = operator("task", "submit", "--tag", "edge", "--session", "edge", "Cross the edge")
            supertag("worker-host", "--control-plane", public, "--state-directory", str(host_state), "--adapter",
                     adapter, "--once", env=host_tls)
            finished = operator("get", "task", task["task_id"])
            require(finished["state"] == "TASK_STATE_SUCCEEDED", f"Task did not finish: {finished}")

            gateway_volume = identifier + "-gateway-state"
            run(["docker", "volume", "create", "--label", label, gateway_volume])
            volumes.append(gateway_volume)
            # The Gateway's start command only replaces the image command, so the entrypoint
            # receives its own path first.
            render_gw = docker_run(identifier + "-render-gateway", {**render_gateway, **gateway_pem},
                                   shapes["render_gateway"], "--volume", f"{gateway_volume}:/var/lib/supertag")
            operator_token = env_file(operator_file)["SUPERTAG_OPERATOR_TOKEN"]

            def test_notification(name, token):
                return run(["docker", "exec", "--user", "10001:10001", "--env", f"SUPERTAG_OPERATOR_TOKEN={token}",
                            name, "/usr/local/bin/supertag", "test", "notification", "--gateway",
                            "http://127.0.0.1:3436"], check=False)

            wait_until(lambda: test_notification(render_gw, operator_token).returncode == 0,
                       "the Render Gateway to reach the Control Plane through the edge")
            require(test_notification(render_gw, "x" * 43).returncode != 0,
                    "the Gateway accepted an unknown operator credential")
            receipt["render"] = {"health_check": "/healthz", "verify_deployment": "wss", "task": task["task_id"],
                                 "gateway_upstream": f"wss://{RENDER_HOST}", "entrypoint_replaced_and_kept": True}
            for name in (render_gw, render_cp):
                remove(name)

            # ---- Cloudflare and Modal -------------------------------------------------------
            pair_control = env_file(pair_files / "control-plane.env")
            pair_gateway = env_file(pair_files / "gateway.env")
            alone = docker_run(identifier + "-control-plane-alone", {**pair_control, **control_pem},
                               shapes["cloudflare_control_plane"][1:], "--volume",
                               f"{control_volume}:/var/lib/supertag", entrypoint=shapes["cloudflare_control_plane"][0])
            start_edge(alone)
            wait_until(healthy_through_edge, "the Control Plane alone through the edge")
            wait_until(lambda: "operator authentication passed" in verify(operator_file, operator_tls,
                                                                          check=False).stdout,
                       "verification of the Control Plane alone")
            remove(alone)

            pair = docker_run(identifier + "-pair", {**pair_control, **pair_gateway, **pem},
                              shapes["cloudflare_pair"][1:], "--volume", f"{control_volume}:/var/lib/supertag",
                              entrypoint=shapes["cloudflare_pair"][0])
            start_edge(pair)
            wait_until(healthy_through_edge, "the pair through the edge")
            check_edge_rules()
            require("operator authentication passed" in verify(operator_file, operator_tls).stdout,
                    "the pair's Control Plane failed verification")
            wait_until(lambda: test_notification(pair, operator_token).returncode == 0,
                       "the pair's Gateway to reach the Control Plane on loopback")
            require(test_notification(pair, "x" * 43).returncode != 0,
                    "the pair's Gateway accepted an unknown operator credential")
            require(operator("get", "task", task["task_id"])["state"] == "TASK_STATE_SUCCEEDED",
                    "the Task changed across Control Plane replacements")

            # Per-process environments and privileges.
            # The supervisor's direct children must be the services themselves, so it can stop them.
            supervisor = run(["docker", "exec", pair, "cat", "/proc/1/task/1/children"]).stdout.split()[0]
            children = run(["docker", "exec", pair, "sh", "-c",
                            f"cat /proc/{supervisor}/task/*/children"]).stdout.split()
            roles = {}
            for pid in children:
                command_line = run(["docker", "exec", pair, "cat", f"/proc/{pid}/cmdline"],
                                   check=False).stdout.split("\0")
                if command_line[:1] == ["/usr/local/bin/supertag"] and command_line[1] in ("control-plane", "gateway"):
                    roles[command_line[1]] = pid
            require(set(roles) == {"control-plane", "gateway"}, f"unexpected pair processes {roles}")
            for role, pid in roles.items():
                status = dict(line.split(":", 1) for line in run(
                    ["docker", "exec", pair, "cat", f"/proc/{pid}/status"]).stdout.splitlines())
                require(status["Uid"].split() == ["10001"] * 4 and status["NoNewPrivs"].strip() == "1"
                        and int(status["CapEff"], 16) == 0, f"{role} kept privileges: {status}")
                environment = run(["docker", "exec", "--user", "10001:10001", pair, "cat",
                                   f"/proc/{pid}/environ"]).stdout.split("\0")
                keys = {entry.split("=", 1)[0] for entry in environment if "=" in entry}
                require(not any(key.endswith("_PEM") for key in keys), f"{role} kept a PEM value")
                if role == "gateway":
                    for key in ("SUPERTAG_DATABASE_URL", "SUPERTAG_OPERATOR_TOKEN", "SUPERTAG_TLS_KEY_FILE",
                                "SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL"):
                        require(key not in keys, f"the Gateway received {key}")
                    require("SUPERTAG_GATEWAY_CREDENTIAL" in keys, "the Gateway has no credential")
                    require("SUPERTAG_CLIENT_CERT_FILE" in keys, "the Gateway has no client certificate")
                else:
                    require("SUPERTAG_TLS_KEY_FILE" in keys and "SUPERTAG_CLIENT_KEY_FILE" not in keys
                            and "SUPERTAG_GATEWAY_CREDENTIAL" not in keys,
                            "unexpected Control Plane settings")

            # A dead Gateway takes the container down so the platform restarts it.
            run(["docker", "exec", "--user", "10001:10001", pair, "sh", "-c", f"kill -KILL {roles['gateway']}"])
            wait_until(lambda: run(["docker", "inspect", "--format", "{{.State.Running}}", pair]).stdout.strip()
                       == "false", "the pair to exit after its Gateway died", seconds=60)
            exit_code = run(["docker", "inspect", "--format", "{{.State.ExitCode}}", pair]).stdout.strip()
            require(exit_code != "0", "the pair exited 0 after a service died")
            # A restart serves again, and SIGTERM stops both services cleanly.
            run(["docker", "start", pair])
            wait_until(healthy_through_edge, "the restarted pair")
            wait_until(lambda: test_notification(pair, operator_token).returncode == 0, "the restarted pair's Gateway")
            run(["docker", "stop", "--time", "30", pair], timeout=60)
            exit_code = run(["docker", "inspect", "--format", "{{.State.ExitCode}}", pair]).stdout.strip()
            require(exit_code == "0", f"the pair exited {exit_code} on SIGTERM")
            receipt["cloudflare_and_modal"] = {
                "control_plane_alone": True, "pair": True, "gateway_upstream": "https://127.0.0.1:3434",
                "uid": 10001, "gateway_environment_scrubbed": True, "exits_when_a_service_dies": True,
                "clean_stop": True}
            receipt.update({"postgresql": True, "edge": "nginx:1.27-alpine (TLS, HTTP/1.1, upgrades and /healthz)",
                            "mtls_inside_tunnel": True})
            return receipt
        finally:
            failure = sys.exc_info()[1]
            problems = []
            if failure:
                for name in containers:
                    logs = subprocess.run(["docker", "logs", "--tail", "60", name], capture_output=True, text=True,
                                          timeout=60)
                    print(f"--- {name}\n{logs.stdout[-3000:]}{logs.stderr[-3000:]}", file=sys.stderr)
            for name in containers:
                remove(name)
            for volume in volumes:
                subprocess.run(["docker", "volume", "rm", "--force", volume], capture_output=True, timeout=60)
            subprocess.run(["docker", "network", "rm", network], capture_output=True, timeout=60)
            if image:
                subprocess.run(["docker", "image", "rm", "--force", image], capture_output=True, timeout=120)
            for kind, flags in (("container", ["--all"]), ("network", []), ("volume", []), ("image", [])):
                remaining = subprocess.run(["docker", kind, "ls", *flags, "--quiet", "--filter", f"label={label}"],
                                           capture_output=True, text=True, timeout=60).stdout.strip()
                if remaining:
                    problems.append(f"left {kind}: {remaining}")
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
        parser.exit(1, f"HTTP-only platform rehearsal: {error}\n")
    text = json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    if args.receipt:
        with open(args.receipt, "x") as output:
            output.write(text)
    print(text, end="")


if __name__ == "__main__":
    main()
