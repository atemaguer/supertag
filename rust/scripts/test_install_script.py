"""install.sh against local file: release fixtures; no network, build, or real release."""
import hashlib
import io
import json
import os
from pathlib import Path
import platform as host
import shutil
import subprocess
import tarfile
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
INSTALLER = REPO / "install.sh"
COMMIT = "a" * 40


def native_platform():
    system = {"Darwin": "darwin", "Linux": "linux"}[host.system()]
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64", "amd64": "amd64"}[host.machine()]
    return f"{system}-{arch}"


def script(text):
    return ("#!/bin/sh\n" + text + "\n").encode()


class InstallScript(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        self.assets = self.root / "assets"
        self.assets.mkdir()
        self.platform = native_platform()

    def release(self, version="1.2.3", *, cli=None, tui=None, extra=(), root=None, sums=None):
        root = root or f"supertag-{version}-{self.platform}-complete"
        files = {
            "manifest.json": (json.dumps({"source": {"archive_sha256": "b" * 64, "commit": COMMIT}},
                                         separators=(",", ":")).encode(), 0o644),
            "supertag": (script(cli or f'[ "$1" = --version ] && echo "supertag {version}"'), 0o755),
            "supertag-tui": (script(tui or f'[ "$1" = --version ] && echo "{version}"'), 0o755),
            "node-bridges/manifest.json": (b"{}\n", 0o644),
        }
        archive = self.assets / f"supertag-{version}-{self.platform}-complete.tar.gz"
        with tarfile.open(archive, "w:gz") as target:
            for name in [root, f"{root}/node-bridges"]:
                info = tarfile.TarInfo(name)
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                target.addfile(info)
            for name, (data, mode) in [*files.items(), *extra]:
                info = tarfile.TarInfo(name if name.startswith(("/", "..")) else f"{root}/{name}")
                info.size, info.mode = len(data), mode
                target.addfile(info, io.BytesIO(data))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        line = f"{sums or digest}  {archive.name}\n"
        with (self.assets / "SHA256SUMS").open("a") as checksums:
            checksums.write(line)
        return digest

    def run_installer(self, **env):
        environment = {"HOME": str(self.home), "PATH": os.defpath,
                       "SUPERTAG_DOWNLOAD_URL": self.assets.as_uri(), **env}
        return subprocess.run(["sh", str(INSTALLER)], env=environment, capture_output=True, text=True, timeout=60)

    def installed(self):
        return self.home / ".local/bin/supertag"

    def test_installs_the_latest_listed_release_and_links_the_command(self):
        digest = self.release()
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Installed SuperTag 1.2.3", result.stdout)
        target = self.home / f".local/share/supertag/versions/native-1.2.3-{self.platform}-release-{digest}"
        self.assertEqual(Path(os.readlink(self.installed())), target / "supertag")
        self.assertEqual(subprocess.check_output([self.installed(), "--version"], text=True), "supertag 1.2.3\n")
        receipt = json.loads((target / ".supertag-install.json").read_text())
        self.assertEqual(receipt, {"archive_sha256": digest, "format": "supertag-native-install-v1",
                                   "source_commit": COMMIT})
        self.assertEqual((target / ".supertag-install.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual((target / "node-bridges").stat().st_mode & 0o022, 0)
        self.assertEqual([p.name for p in (self.home / ".local/share/supertag/versions").iterdir()], [target.name])

    def test_selects_the_requested_version_and_replaces_its_own_link(self):
        self.release("1.2.3")
        self.release("1.2.4")
        self.assertEqual(self.run_installer(SUPERTAG_VERSION="v1.2.4").returncode, 0)
        self.assertEqual(subprocess.check_output([self.installed(), "--version"], text=True), "supertag 1.2.4\n")
        result = self.run_installer(SUPERTAG_VERSION="1.2.3")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(subprocess.check_output([self.installed(), "--version"], text=True), "supertag 1.2.3\n")
        missing = self.run_installer(SUPERTAG_VERSION="9.9.9")
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn(f"no 9.9.9 build for {self.platform}", missing.stderr)

    def assert_refused(self, message, **env):
        result = self.run_installer(**env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)
        self.assertFalse(self.installed().exists() or self.installed().is_symlink())
        versions = self.home / ".local/share/supertag/versions"
        self.assertEqual(list(versions.iterdir()) if versions.exists() else [], [])

    def test_refuses_an_archive_that_differs_from_its_checksum(self):
        self.release(sums="0" * 64)
        self.assert_refused("did not match its SHA256SUMS checksum")

    def test_refuses_an_entry_outside_the_release_root(self):
        self.release(extra=[("../escape", (b"x", 0o644))])
        self.assert_refused("has an entry outside")
        self.assertFalse((self.home / ".local/share/supertag/versions/escape").exists())

    def test_refuses_binaries_that_report_another_version(self):
        self.release(cli='echo "supertag 0.0.1"')
        self.assert_refused("reports supertag 0.0.1, not 1.2.3")

    def test_refuses_a_terminal_ui_from_another_release(self):
        self.release(tui="echo 0.0.1")
        self.assert_refused("supertag-tui binary reports 0.0.1")

    def test_refuses_a_missing_platform_build(self):
        (self.assets / "SHA256SUMS").write_text(f"{'1' * 64}  supertag-1.2.3-plan9-amd64-complete.tar.gz\n")
        self.assert_refused(f"build for {self.platform}")

    def test_never_replaces_a_command_it_did_not_install(self):
        self.release()
        self.installed().parent.mkdir(parents=True)
        self.installed().write_text("#!/bin/sh\n")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("was not installed by this script", result.stderr)
        self.assertEqual(self.installed().read_text(), "#!/bin/sh\n")

    def test_refuses_plain_http_downloads(self):
        self.assert_refused("unsupported download URL", SUPERTAG_DOWNLOAD_URL="http://127.0.0.1:9")

    def test_release_workflow_pins_the_installer_to_its_version(self):
        pinned = INSTALLER.read_text().replace('RELEASE_DEFAULT_VERSION="latest"', 'RELEASE_DEFAULT_VERSION="1.2.4"')
        self.assertNotEqual(pinned, INSTALLER.read_text())
        self.release("1.2.3")
        self.release("1.2.4")
        installer = self.root / "install.sh"
        installer.write_text(pinned)
        result = subprocess.run(["sh", str(installer)], env={"HOME": str(self.home), "PATH": os.defpath,
                                "SUPERTAG_DOWNLOAD_URL": self.assets.as_uri()}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Installed SuperTag 1.2.4", result.stdout)


if __name__ == "__main__":
    unittest.main()
