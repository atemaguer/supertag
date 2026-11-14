"""The release tag must name the version every released artifact reports."""
from pathlib import Path
import tempfile
import unittest

from release_version import release_version


class ReleaseVersion(unittest.TestCase):
    def repo(self, rust, python):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "rust").mkdir()
        (root / "rust/Cargo.toml").write_text(f'[workspace.package]\nversion = "{rust}"\n')
        (root / "sdks/python").mkdir(parents=True)
        (root / "sdks/python/pyproject.toml").write_text(f'[project]\nversion = "{python}"\n')
        return root

    def test_accepts_a_tag_naming_the_shared_version(self):
        self.assertEqual(release_version("v0.3.0-alpha.1", self.repo("0.3.0-alpha.1", "0.3.0-alpha.1")), "0.3.0-alpha.1")

    def test_refuses_a_tag_or_python_sdk_with_another_version(self):
        with self.assertRaisesRegex(ValueError, "does not match the Rust workspace version"):
            release_version("v0.3.0", self.repo("0.3.0-alpha.1", "0.3.0-alpha.1"))
        with self.assertRaisesRegex(ValueError, "sdks/python is 0.2.0"):
            release_version("v0.3.0", self.repo("0.3.0", "0.2.0"))


if __name__ == "__main__":
    unittest.main()
