"""Tests for app.py without a Modal account. Run from the repository root:

    uv run --python 3.12 --with-requirements deploy/modal/requirements.txt \
        python -m unittest discover -s deploy/modal -p 'test_*.py'
"""

import importlib
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
IMAGE = "registry.example.com/supertag-hosted@sha256:" + "0" * 64


def load(**settings):
    environment = {"SUPERTAG_MODAL_IMAGE": IMAGE, **settings}
    with mock.patch.dict(os.environ, environment, clear=False):
        sys.modules.pop("app", None)
        return importlib.import_module("app")


class ServiceCommandTest(unittest.TestCase):
    def test_runs_the_control_plane_alone_or_a_gateway_with_its_flags(self):
        app = load()
        self.assertEqual(app.service_command("off", ""), app.CONTROL_PLANE_COMMAND)
        self.assertEqual(
            app.service_command("on", "--lark-state-directory /var/lib/supertag/lark --notify 'webhook:https://h.example/x#ops'"),
            app.PAIR_COMMAND
            + ["--lark-state-directory", "/var/lib/supertag/lark", "--notify", "webhook:https://h.example/x#ops"],
        )
        for gateway, flags, message in [
            ("on", "", "connector flags"),
            ("off", "--lark-state-directory /x", "SUPERTAG_MODAL_GATEWAY=on"),
            ("yes", "", "on or off"),
        ]:
            with self.assertRaisesRegex(ValueError, message):
                app.service_command(gateway, flags)

    def test_the_deploy_refuses_a_gateway_without_flags_or_an_undigested_image(self):
        with self.assertRaisesRegex(SystemExit, "connector flags"):
            load(SUPERTAG_MODAL_GATEWAY="on", SUPERTAG_MODAL_GATEWAY_FLAGS="")
        with self.assertRaisesRegex(SystemExit, "digest"):
            load(SUPERTAG_MODAL_IMAGE="registry.example.com/supertag-hosted:latest")
        app = load(SUPERTAG_MODAL_GATEWAY="on", SUPERTAG_MODAL_GATEWAY_FLAGS="--lark-state-directory /x")
        self.assertEqual(app.gateway_flags, "--lark-state-directory /x")


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.app = load()
        self.exited = threading.Event()
        self.codes = []

    def exit(self, code):
        self.codes.append(code)
        self.exited.set()

    def test_a_service_that_exits_ends_the_container(self):
        self.app.Service(["sh", "-c", "exit 0"], exit=self.exit)
        self.assertTrue(self.exited.wait(10), "the container was not ended")
        self.assertEqual(self.codes, [1])

    def started(self, trap):
        """A service that has installed `trap` for SIGTERM."""
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / "ready"
            script = f"trap {trap} TERM; : > '{ready}'; while :; do sleep 0.1; done"
            service = self.app.Service(["sh", "-c", script], exit=self.exit)
            deadline = time.monotonic() + 10
            while not ready.exists():
                self.assertLess(time.monotonic(), deadline, "the service did not start")
                time.sleep(0.05)
        return service

    def test_stopping_terminates_the_service_without_ending_the_container(self):
        service = self.started("'exit 0'")
        service.stop(seconds=10)
        self.assertEqual(service.process.returncode, 0)
        self.assertFalse(self.exited.wait(1))

    def test_a_service_that_ignores_sigterm_is_killed(self):
        service = self.started("''")
        service.stop(seconds=0.5)
        self.assertLess(service.process.returncode, 0)
        self.assertFalse(self.exited.wait(1))


if __name__ == "__main__":
    unittest.main()
