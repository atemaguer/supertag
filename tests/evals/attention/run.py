# /// script
# requires-python = ">=3.10"
# ///
"""Attention eval: does a Tag speak when a scheduled check finds a change, and stay quiet when
it finds none?

For each harness, every scenario gets its own throwaway Tag, so no fire sees another's context.
The operator schedules one wake-up per Tag a minute ahead. Its note carries the check, what the
Tag reported last time, and what the check shows now. When every fire has finished, the eval
reads each Task: a quiet one (`stay_quiet`) posted nothing. It scores:

- recall: changed scenarios that posted, out of the changed ones;
- precision: unchanged scenarios that stayed quiet, out of the unchanged ones.

It needs a running Control Plane with a Worker Host for each harness, and spends one turn per
scenario and harness. Run it before and after changing the fire prompt or `stay_quiet`'s
description, and compare.

    uv run --python 3.13 --script tests/evals/attention/run.py --harness codex --harness claude-code
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
TERMINAL = {"TASK_STATE_SUCCEEDED", "TASK_STATE_FAILED", "TASK_STATE_CANCELLED", "TASK_STATE_UNCERTAIN"}
INSTRUCTIONS = (
    "You watch engineering work for the team and tell people what needs their attention. "
    "Be brief."
)


@dataclass
class Scenario:
    id: str
    check: str
    previous: str
    current: str
    changed: bool

    def note(self) -> str:
        return (
            f"{self.check}\n"
            f"What you reported last time: {self.previous}\n"
            f"What the check shows now: {self.current}"
        )


@dataclass
class Outcome:
    harness: str
    scenario: str
    changed: bool
    tag: str
    task: str = ""
    state: str = ""
    quiet: bool = False
    result: str = ""


def load(path: Path) -> list[Scenario]:
    scenarios = [Scenario(**entry) for entry in json.loads(path.read_text())]
    ids = [scenario.id for scenario in scenarios]
    if len(set(ids)) != len(ids):
        raise SystemExit("scenario IDs must be unique")
    if not any(s.changed for s in scenarios) or all(s.changed for s in scenarios):
        raise SystemExit("scenarios need both changed and unchanged states")
    return scenarios


def score(outcomes: list[Outcome]) -> dict[str, dict[str, object]]:
    """Per harness: posted-when-changed (recall) and quiet-when-unchanged (precision). A turn that
    did not succeed counts against both, as a person heard nothing useful."""
    scores: dict[str, dict[str, object]] = {}
    for harness in sorted({o.harness for o in outcomes}):
        mine = [o for o in outcomes if o.harness == harness]
        succeeded = [o for o in mine if o.state == "TASK_STATE_SUCCEEDED"]
        changed = [o for o in mine if o.changed]
        unchanged = [o for o in mine if not o.changed]
        posted = sum(1 for o in succeeded if o.changed and not o.quiet)
        quiet = sum(1 for o in succeeded if not o.changed and o.quiet)
        scores[harness] = {
            "recall": round(posted / len(changed), 3) if changed else None,
            "precision": round(quiet / len(unchanged), 3) if unchanged else None,
            "posted_when_changed": f"{posted}/{len(changed)}",
            "quiet_when_unchanged": f"{quiet}/{len(unchanged)}",
            "failed": len(mine) - len(succeeded),
            "missed": [o.scenario for o in succeeded if o.changed and o.quiet],
            "noisy": [o.scenario for o in succeeded if not o.changed and not o.quiet],
        }
    return scores


class Cli:
    def __init__(self, binary: str, control_plane: str | None):
        self.binary = binary
        self.control_plane = control_plane

    def __call__(self, *args: str) -> dict:
        command = [self.binary, args[0]]
        if self.control_plane:
            command += ["--control-plane", self.control_plane]
        command += list(args[1:])
        done = subprocess.run(command, capture_output=True, text=True)
        if done.returncode != 0:
            raise RuntimeError(f"{' '.join(command[:4])}: {done.stderr.strip()}")
        return json.loads(done.stdout) if done.stdout.strip() else {}


def run(cli: Cli, scenarios: list[Scenario], harnesses: list[str], timeout: float, keep: bool) -> list[Outcome]:
    run_id = uuid.uuid4().hex[:6]
    outcomes: list[Outcome] = []
    schedules: dict[int, str] = {}
    try:
        for harness in harnesses:
            for scenario in scenarios:
                tag = f"attn-{run_id}-{harness}-{scenario.id}"[:63]
                cli("tag", "put", tag, "--instructions", INSTRUCTIONS, "--allow", "files:read",
                    "--harness", harness, "--memory", "false")
                created = cli("schedule", "create", "--tag", tag, "--at", "1m", scenario.note())
                schedules[len(outcomes)] = created["schedule_id"]
                outcomes.append(Outcome(harness, scenario.id, scenario.changed, tag))
        print(f"scheduled {len(outcomes)} fires; waiting for them to finish", file=sys.stderr)
        deadline = time.monotonic() + 90 + timeout
        pending = set(range(len(outcomes)))
        while pending and time.monotonic() < deadline:
            for index in sorted(pending):
                outcome = outcomes[index]
                if not outcome.task:
                    outcome.task = cli("get", "schedule", schedules[index]).get("last_task_id") or ""
                    if not outcome.task:
                        continue
                task = cli("get", "task", outcome.task)
                if task.get("state") in TERMINAL:
                    outcome.state = task["state"]
                    outcome.quiet = bool(task.get("quiet"))
                    outcome.result = (task.get("result") or "")[:300]
                    pending.discard(index)
            if pending:
                time.sleep(10)
        for index in pending:
            outcomes[index].state = "TIMED_OUT"
    finally:
        if not keep:
            for outcome in outcomes:
                try:
                    cli("tag", "retire", outcome.tag)
                except RuntimeError as error:
                    print(f"could not retire {outcome.tag}: {error}", file=sys.stderr)
    return outcomes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--harness", action="append", help="codex, claude-code, cursor, or opencode; repeatable (default codex)")
    parser.add_argument("--control-plane", help="passed to every supertag command")
    parser.add_argument("--supertag", default="supertag", help="the CLI to run")
    parser.add_argument("--scenarios", type=Path, default=HERE / "scenarios.json")
    parser.add_argument("--timeout", type=float, default=1800, help="seconds to wait after the fires are due")
    parser.add_argument("--keep", action="store_true", help="keep the eval's Tags instead of retiring them")
    parser.add_argument("--output", type=Path, help="write every outcome and the scores as JSON")
    parser.add_argument("--plan", action="store_true", help="print the notes the eval would schedule, and stop")
    args = parser.parse_args()
    scenarios = load(args.scenarios)
    if args.plan:
        for scenario in scenarios:
            print(f"[{'changed' if scenario.changed else 'unchanged'}] {scenario.id}\n{scenario.note()}\n")
        return
    outcomes = run(Cli(args.supertag, args.control_plane), scenarios, args.harness or ["codex"], args.timeout, args.keep)
    scores = score(outcomes)
    report = {"scores": scores, "outcomes": [asdict(o) for o in outcomes]}
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(scores, indent=2))


if __name__ == "__main__":
    main()
