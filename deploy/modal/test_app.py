"""Local lifecycle checks; no Modal resources are created."""

import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys
import unittest
from unittest.mock import patch


class ServerLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with patch.dict(os.environ, {"SUPERTAG_MODAL_IMAGE": "example.invalid/supertag:test"}):
            cls.module = runpy.run_path(str(Path(__file__).with_name("app.py")))
        cls.supervisor_type = cls.module["ControlPlaneProcess"]

    def test_remote_import_does_not_require_checkout(self):
        source = Path(__file__).with_name("app.py").read_text()
        config = Path(__file__).with_name("runtime.json").read_text()
        environment = {"SUPERTAG_MODAL_IMAGE": ""}
        with patch.dict(os.environ, environment), patch("modal.is_local", return_value=False), patch.object(Path, "read_text", return_value=config):
            namespace = {"__file__": "/root/app.py", "__name__": "modal_remote_import_test"}
            exec(compile(source, "/root/app.py", "exec"), namespace)
        self.assertEqual(namespace["source_root"], Path("/app"))

    def launch(self, source):
        original = subprocess.Popen
        self.started = []

        def spawn(command, **kwargs):
            self.assertEqual(command[0], "/usr/local/bin/supertag-entrypoint")
            self.assertEqual(kwargs.pop("cwd"), "/app")
            self.assertEqual(kwargs["env"]["PORT"], str(self.module["runtime"]["port"]))
            process = original([sys.executable, "-c", source], **kwargs)
            self.started.append(process)
            return process

        return patch("subprocess.Popen", side_effect=spawn)

    def tearDown(self):
        for process in getattr(self, "started", []):
            if process.poll() is None:
                process.kill()
            process.wait()

    def test_health_then_graceful_shutdown(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        source = '''
import http.server, os
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.path == '/healthz'
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ok":true}')
    def log_message(self, *args): pass
http.server.HTTPServer(('127.0.0.1', int(os.environ['PORT'])), Handler).serve_forever()
'''
        with patch.dict(self.module["runtime"], {"port": port}), self.launch(source):
            server = self.supervisor_type()
            server.start()
            self.assertIsNone(server.process.poll())
            server.stop()
            self.assertIsNotNone(server.process.poll())
            server.stop()  # Exit hooks may follow startup cleanup.

    def test_exited_server_does_not_report_ready(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        with patch.dict(self.module["runtime"], {"port": port}), self.launch("raise SystemExit(7)"):
            server = self.supervisor_type()
            with self.assertRaisesRegex(RuntimeError, "exited before becoming healthy"):
                server.start()
            self.assertEqual(server.process.returncode, 7)


if __name__ == "__main__":
    unittest.main()
