"""Regression checks for the live exercise verifier."""

import tempfile
import unittest
from pathlib import Path

from live_project import EXTERNAL_CHECK_COUNT, git, prepare, verify


IMPLEMENTATION = r"""export function parseDuration(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const match = /^(\d+(?:\.\d+)?|\.\d+)(ms|s|m|h)$/.exec(value.trim());
    if (match) {
      const unit = { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]];
      const duration = Number(match[1]) * unit;
      if (Number.isFinite(duration)) return duration;
    }
  }
  throw new TypeError("Invalid duration");
}
"""

NEW_TEST = '\ntest("converts fractions", () => assert.equal(parseDuration(".5s"), 500));\n'


class VerifyLiveProjectTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="supertag-rust-verifier-test-")
        self.addCleanup(directory.cleanup)
        self.workspace = Path(directory.name) / "workspace"
        self.base = prepare(self.workspace)["baseCommit"]
        self.source = self.workspace / "src/duration.js"
        self.tests = self.workspace / "test/duration.test.js"

    def commit(self, implementation, extra_test=NEW_TEST):
        self.source.write_text(implementation, encoding="utf-8")
        self.tests.write_text(self.tests.read_text(encoding="utf-8") + extra_test, encoding="utf-8")
        git(self.workspace, "add", "--", "src/duration.js", "test/duration.test.js")
        git(self.workspace, "commit", "--quiet", "-m", "Implement duration parsing")
        return git(self.workspace, "rev-parse", "HEAD").strip()

    def test_accepts_an_exact_commit_with_passing_checks(self):
        commit = self.commit(IMPLEMENTATION)
        result = verify(self.workspace, self.base, commit)

        self.assertTrue(result["accepted"])
        self.assertTrue(result["committedTreeVerified"])
        self.assertEqual(result["commit"], commit)
        self.assertEqual(result["checks"]["test"]["passed"], 3)
        self.assertEqual(result["checks"]["external"]["passed"], EXTERNAL_CHECK_COUNT)

    def test_rejects_good_working_bytes_hidden_over_a_broken_commit(self):
        commit = self.commit(IMPLEMENTATION.replace("h: 3600000", "h: 1000000"))
        git(self.workspace, "update-index", "--assume-unchanged", "src/duration.js")
        self.source.write_text(IMPLEMENTATION, encoding="utf-8")
        self.assertEqual(git(self.workspace, "status", "--porcelain=v1"), "")

        with self.assertRaisesRegex(ValueError, "working tree bytes differ from the claimed commit"):
            verify(self.workspace, self.base, commit)

    def test_rejects_changes_without_an_added_test(self):
        commit = self.commit(IMPLEMENTATION, "\n// Same baseline tests\n")

        with self.assertRaisesRegex(ValueError, "expected more than 2 passing Node tests"):
            verify(self.workspace, self.base, commit)
