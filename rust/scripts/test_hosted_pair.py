"""The hosted image's pair script (deploy/docker/rust-hosted-pair.sh) against a fake `supertag`:
per-process environments, the Gateway's connector flags, and exit statuses."""
from pathlib import Path
import os
import signal
import subprocess
import tempfile
import time
import unittest

PAIR = Path(__file__).resolve().parents[2] / "deploy/docker/rust-hosted-pair.sh"
# Records each role's arguments and environment, then runs until SIGTERM (or exits for `health`).
FAKE = """#!/bin/sh
role=$1
if [ "$role" = health ]; then exit 0; fi
printf '%s\\n' "$@" > "$LOG/$role.args"
env > "$LOG/$role.env"
trap 'exit 0' TERM
echo $$ > "$LOG/$role.pid"
while :; do sleep 0.1; done
"""


class HostedPair(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.log = self.root / "log"
        self.log.mkdir()
        fake = self.root / "supertag"
        fake.write_text(FAKE)
        fake.chmod(0o755)
        self.pair = self.root / "pair.sh"
        self.pair.write_text(PAIR.read_text().replace("supertag=/usr/local/bin/supertag", f"supertag={fake}"))
        self.pair.chmod(0o755)

    def start(self, *flags):
        environment = {
            "PATH": os.environ["PATH"],
            "LOG": str(self.log),
            "SUPERTAG_DATABASE_URL": "postgresql://db.example/supertag",
            "SUPERTAG_OPERATOR_TOKEN": "operator",
            "SUPERTAG_GATEWAY_TOKEN": "gateway",
            "SUPERTAG_TLS_KEY_FILE": "/run/supertag-tls/server.key",
            "SUPERTAG_CLIENT_CERT_FILE": "/run/supertag-tls/client.pem",
            "SUPERTAG_LARK_APP_ID": "cli_app",
            "SUPERTAG_NOTIFY_SECRET_OPS": "hook-secret",
            "SUPERTAG_SERVER_CA_PEM_NOTE": "line one\nSUPERTAG_LARK_FAKE=not a name",
        }
        process = subprocess.Popen([str(self.pair), "0.0.0.0:8080", *flags], env=environment)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        deadline = time.monotonic() + 20
        while not (self.log / "gateway.pid").exists():
            self.assertIsNone(process.poll(), "the pair exited during startup")
            self.assertLess(time.monotonic(), deadline, "the Gateway did not start")
            time.sleep(0.05)
        return process

    def read(self, name):
        return (self.log / name).read_text()

    def environment(self, role):
        return {line.split("=", 1)[0] for line in self.read(f"{role}.env").splitlines() if "=" in line}

    def test_each_process_gets_its_own_settings_and_the_gateway_its_flags(self):
        process = self.start("--lark-state-directory", "/var/lib/supertag/lark", "--notify", "webhook:https://h.example/x#ops")
        self.assertEqual(self.read("gateway.args").splitlines(), [
            "gateway", "--listen", "127.0.0.1:3436", "--control-plane", "https://127.0.0.1:3434",
            "--lark-state-directory", "/var/lib/supertag/lark", "--notify", "webhook:https://h.example/x#ops"])
        self.assertEqual(self.read("control-plane.args").splitlines(), [
            "control-plane", "--listen", "127.0.0.1:3434", "--websocket-listen", "0.0.0.0:8080",
            "--transfer-directory", "/var/lib/supertag/transfers"])
        control, gateway = self.environment("control-plane"), self.environment("gateway")
        for name in ("SUPERTAG_LARK_APP_ID", "SUPERTAG_NOTIFY_SECRET_OPS", "SUPERTAG_CLIENT_CERT_FILE"):
            self.assertNotIn(name, control)
            self.assertIn(name, gateway)
        for name in ("SUPERTAG_DATABASE_URL", "SUPERTAG_OPERATOR_TOKEN", "SUPERTAG_TLS_KEY_FILE"):
            self.assertIn(name, control)
            self.assertNotIn(name, gateway)
        # A line inside a multi-line value is not taken for a variable name.
        self.assertIn("SUPERTAG_SERVER_CA_PEM_NOTE", control)
        self.assertEqual(self.read("control-plane.env").count("SUPERTAG_LARK_FAKE=not a name"), 1)
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(20), 0)

    def test_a_service_that_exits_ends_the_pair_with_a_failure(self):
        process = self.start("--lark-state-directory", "/var/lib/supertag/lark")
        os.kill(int(self.read("gateway.pid")), signal.SIGKILL)
        self.assertNotEqual(process.wait(20), 0)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(self.read("control-plane.pid")), 0)


if __name__ == "__main__":
    unittest.main()
