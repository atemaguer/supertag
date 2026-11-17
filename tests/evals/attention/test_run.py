"""The attention eval's scenarios, notes, and scoring, without a Control Plane."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run  # noqa: E402


class AttentionEvalTest(unittest.TestCase):
    def test_scenarios_are_balanced_and_notes_carry_both_states(self):
        scenarios = run.load(run.HERE / "scenarios.json")
        self.assertEqual(len(scenarios), 30)
        self.assertEqual(sum(s.changed for s in scenarios), 14)
        note = scenarios[0].note()
        self.assertIn(scenarios[0].previous, note)
        self.assertIn(scenarios[0].current, note)

    def test_scores_recall_precision_and_failures_per_harness(self):
        outcome = lambda scenario, changed, quiet, state="TASK_STATE_SUCCEEDED": run.Outcome(
            "codex", scenario, changed, f"tag-{scenario}", "task", state, quiet)
        scores = run.score([
            outcome("red", True, False),
            outcome("missed", True, True),
            outcome("green", False, True),
            outcome("noisy", False, False),
            outcome("broken", False, False, "TASK_STATE_FAILED"),
        ])["codex"]
        self.assertEqual(scores["recall"], 0.5)
        self.assertEqual(scores["precision"], 0.333)
        self.assertEqual(scores["posted_when_changed"], "1/2")
        self.assertEqual(scores["quiet_when_unchanged"], "1/3")
        self.assertEqual((scores["failed"], scores["missed"], scores["noisy"]), (1, ["missed"], ["noisy"]))


if __name__ == "__main__":
    unittest.main()
