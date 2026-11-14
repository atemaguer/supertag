"""Every released artifact carries the Rust workspace version, and the tag names it."""
import json
from pathlib import Path
import tempfile
import unittest

from release_version import REPO, drift, python_version, release_version, sync


class ReleaseVersion(unittest.TestCase):
    def repo(self, rust, python, typescript=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "rust").mkdir()
        (root / "rust/Cargo.toml").write_text(f'[workspace.package]\nversion = "{rust}"\n')
        (root / "rust/Cargo.lock").write_text(
            f'[[package]]\nname = "supertag-cli"\nversion = "{rust}"\ndependencies = []\n\n'
            '[[package]]\nname = "supertag-elsewhere"\nversion = "9.9.9"\nsource = "registry+x"\n')
        (root / "sdks/python").mkdir(parents=True)
        (root / "sdks/python/pyproject.toml").write_text(f'[project]\nversion = "{python}"\n')
        (root / "sdks/python/uv.lock").write_text(
            f'[[package]]\nname = "supertag"\nversion = "{python_version(python)}"\n')
        (root / "packages/supertag-ai").mkdir(parents=True)
        (root / "packages/supertag-ai/package.json").write_text(
            json.dumps({"name": "supertag-ai", "version": typescript or python}, indent=2) + "\n")
        (root / "node_modules/x").mkdir(parents=True)
        (root / "node_modules/x/package.json").write_text('{\n  "version": "1.0.0"\n}\n')
        return root

    def test_accepts_a_tag_naming_the_shared_version(self):
        self.assertEqual(release_version("v0.3.0-alpha.1", self.repo("0.3.0-alpha.1", "0.3.0-alpha.1")), "0.3.0-alpha.1")

    def test_refuses_a_tag_or_sdk_with_another_version(self):
        with self.assertRaisesRegex(ValueError, "does not match the Rust workspace version"):
            release_version("v0.3.0", self.repo("0.3.0-alpha.1", "0.3.0-alpha.1"))
        with self.assertRaisesRegex(ValueError, "sdks/python/pyproject.toml is 0.2.0"):
            release_version("v0.3.0", self.repo("0.3.0", "0.2.0"))
        with self.assertRaisesRegex(ValueError, "packages/supertag-ai/package.json is 0.2.0"):
            release_version("v0.3.0", self.repo("0.3.0", "0.3.0", "0.2.0"))

    def test_reports_drift_in_lockfiles(self):
        root = self.repo("0.3.0-alpha.1", "0.3.0-alpha.1")
        (root / "fixture").mkdir()
        (root / "fixture/package-lock.json").write_text(
            json.dumps({"version": "0.3.0-alpha.2", "packages": {"": {"version": "0.1.0"}}}))
        (root / "unversioned").mkdir()
        (root / "unversioned/package-lock.json").write_text(json.dumps({"packages": {"": {}}}))
        (root / "rust/Cargo.toml").write_text('[workspace.package]\nversion = "0.3.0-alpha.2"\n')
        problems = "\n".join(drift(root))
        self.assertIn("sdks/python/uv.lock is 0.3.0a1 but the Python SDK is 0.3.0a2", problems)
        self.assertIn("rust/Cargo.lock records supertag-cli 0.3.0-alpha.1", problems)
        self.assertIn("fixture/package-lock.json records 0.1.0", problems)
        self.assertNotIn("records 0.3.0-alpha.2", problems)
        self.assertNotIn("unversioned", problems)
        self.assertNotIn("supertag-elsewhere", problems)
        self.assertNotIn("node_modules", problems)

    def test_sync_rewrites_manifests_but_not_lockfiles(self):
        root = self.repo("0.3.0-alpha.1", "0.2.0-alpha.9")
        self.assertEqual(sorted(sync(root)), ["packages/supertag-ai/package.json", "sdks/python/pyproject.toml"])
        self.assertEqual(drift(root), ["sdks/python/uv.lock is 0.2.0a9 but the Python SDK is 0.3.0a1; run uv lock"])

    def test_the_checkout_carries_one_version(self):
        self.assertEqual(drift(REPO), [])


if __name__ == "__main__":
    unittest.main()
