#!/usr/bin/python3
"""Fake Codex app server whose turns wait at a test gate before completing."""
import json
import os
from pathlib import Path
import re
import sys
import time

GATE = Path("@GATE@")
if sys.argv[1:] == ["--version"]:
    print("codex-cli 0.163.0")
    sys.exit(0)
assert sys.argv[1:4] == ["app-server", "--listen", "stdio://"]
# A Codex lane gets Codex credentials only: never another harness's or a service's.
for name in ["SUPERTAG_HOST_TOKEN", "SUPERTAG_OPERATOR_TOKEN", "SUPERTAG_GATEWAY_TOKEN", "ANTHROPIC_API_KEY"]:
    assert not os.environ.get(name), name
THREAD = "gated-thread"
TURN = "gated-turn"


def emit(value):
    print(json.dumps(value), flush=True)


def reply(request, result):
    emit({"id": request["id"], "result": result})


def notify(method, params):
    emit({"method": method, "params": params})


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        reply(request, {"userAgent": "fixture"})
    elif method == "initialized":
        pass
    elif method == "config/read":
        reply(request, {"layers": [], "config": {}, "origins": {}})
    elif method == "skills/list":
        reply(request, {"data": [{"cwd": str(Path.cwd()), "skills": [], "errors": []}]})
    elif method in ("thread/start", "thread/resume"):
        sessions = Path(os.environ["CODEX_HOME"]).joinpath("sessions")
        sessions.mkdir(exist_ok=True)
        records = [
            {"type": "session_meta", "payload": {"id": THREAD, "cwd": str(Path.cwd())}},
            {"type": "response_item", "payload": {"role": "user", "content": [{"type": "input_text", "text": "gated history"}]}},
        ]
        sessions.joinpath("thread.jsonl").write_text("\n".join(map(json.dumps, records)) + "\n")
        reply(request, {"thread": {"id": THREAD}})
    elif method == "turn/start":
        prompt = request["params"]["input"][0]["text"]
        reply(request, {"turn": {"id": TURN, "status": "inProgress", "items": []}})
        notify("turn/started", {"threadId": THREAD, "turn": {"id": TURN, "status": "inProgress", "items": []}})
        marker = re.search(r"Task-[a-z0-9]+", prompt).group(0)
        if marker.startswith("Task-w"):
            # Workspace Tasks edit their own checkout while sibling Attempts run.
            Path.cwd().joinpath(f"{marker}.txt").write_text(f"{marker}\n")
        # Publish the start marker whole: readers may list it as soon as it appears.
        pending = GATE.joinpath(f"pending-codex-{os.getpid()}")
        pending.write_text(f"{marker}\n{Path.cwd()}")
        os.replace(pending, GATE.joinpath("started", f"codex-{os.getpid()}"))
        while not GATE.joinpath("release").exists() and not GATE.joinpath(f"release-{marker}").exists():
            time.sleep(0.05)
        total = {"inputTokens": 4, "cachedInputTokens": 0, "outputTokens": 3, "reasoningOutputTokens": 0, "totalTokens": 7}
        with Path(os.environ["CODEX_HOME"]).joinpath("sessions/thread.jsonl").open("a") as stream:
            stream.write(json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 4, "cached_input_tokens": 0, "output_tokens": 3}}}}) + "\n")
        notify("item/completed", {"threadId": THREAD, "turnId": TURN, "item": {"id": "gated-message", "type": "agentMessage", "text": f"codex finished {marker}"}})
        notify("thread/tokenUsage/updated", {"threadId": THREAD, "turnId": TURN, "tokenUsage": {"total": total, "last": total}})
        notify("turn/completed", {"threadId": THREAD, "turn": {"id": TURN, "status": "completed", "items": []}})
    elif method == "turn/interrupt":
        reply(request, {})
    else:
        raise AssertionError(f"unexpected native request {method}")
