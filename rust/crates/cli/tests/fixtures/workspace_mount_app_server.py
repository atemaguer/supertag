#!/usr/bin/python3
"""Fake Codex app server that reads staged Workspace Volume copies and edits read-write ones."""
import json
import os
from pathlib import Path
import sys

if sys.argv[1:] == ["--version"]:
    print("codex-cli 0.163.0")
    sys.exit(0)
assert sys.argv[1:4] == ["app-server", "--listen", "stdio://"]
READ_ONLY = 'sandbox_mode="read-only"' in sys.argv
# A read-write copy is the only writable root besides the checkout.
WRITE_GRANTS = [arg for arg in sys.argv if arg.startswith("permissions.supertag.filesystem=")]
if not READ_ONLY:
    assert 'permissions.supertag.extends=":workspace"' in sys.argv
    assert len(WRITE_GRANTS) == 1 and '= "write"' in WRITE_GRANTS[0], sys.argv
for name in ["SUPERTAG_HOST_TOKEN", "SUPERTAG_OPERATOR_TOKEN", "SUPERTAG_GATEWAY_CREDENTIAL"]:
    assert not os.environ.get(name)
MARKER = "Read-only Workspace data is available at these paths: "
WRITABLE = "Read-write Workspace data is available at these paths: "
thread = "mount-thread"
turn = "mount-turn"


def emit(value):
    print(json.dumps(value), flush=True)


def reply(request, result):
    emit({"id": request["id"], "result": result})


def notify(method, params):
    emit({"method": method, "params": params})


def edit(prompt):
    start = prompt.index(WRITABLE) + len(WRITABLE)
    paths, _ = json.JSONDecoder().raw_decode(prompt[start:])
    lines = []
    for path in map(Path, paths):
        assert f'"{path}" = "write"' in WRITE_GRANTS[0], WRITE_GRANTS
        rows = path.joinpath("rows.csv").read_text()
        path.joinpath("rows.csv").write_text(rows.replace("42", "43"))
        path.joinpath("reports").mkdir()
        path.joinpath("reports", "new.txt").write_text("created")
        path.joinpath("nested", "notes.txt").unlink()
        if "with a hard link" in prompt:
            os.link(path.joinpath("rows.csv"), path.joinpath("alias.csv"))
        lines.append(f"edited {path.name}")
    return "\n".join(lines)


def inspect(prompt):
    if WRITABLE in prompt:
        return edit(prompt)
    start = prompt.index(MARKER) + len(MARKER)
    paths, _ = json.JSONDecoder().raw_decode(prompt[start:])
    lines = []
    for path in map(Path, paths):
        rows = path.joinpath("rows.csv").read_text()
        nested = path.joinpath("nested", "notes.txt").read_text()
        writable = []
        for target in (path.joinpath("new.txt"), path.joinpath("rows.csv")):
            try:
                with target.open("a") as stream:
                    stream.write("changed")
                writable.append(target.name)
            except PermissionError:
                pass
        lines.append(f"{path.name}: {rows.strip()} | {nested} | writable={writable}")
    return "\n".join(lines)


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
        if READ_ONLY:
            assert request["params"]["sandbox"] == "read-only"
        else:
            assert "sandbox" not in request["params"]
            grants = request["params"]["config"]["permissions.supertag.filesystem"]
            assert "write" in grants.values(), grants
        sessions = Path(os.environ["CODEX_HOME"]).joinpath("sessions")
        sessions.mkdir(exist_ok=True)
        records = [{"type": "session_meta", "payload": {"id": thread, "cwd": str(Path.cwd())}}, {"type": "response_item", "payload": {"role": "user", "content": [{"type": "input_text", "text": "mount history"}]}}]
        sessions.joinpath("thread.jsonl").write_text("\n".join(map(json.dumps, records)) + "\n")
        reply(request, {"thread": {"id": thread}})
    elif method == "turn/start":
        prompt = request["params"]["input"][0]["text"]
        reply(request, {"turn": {"id": turn, "status": "inProgress", "items": []}})
        notify("turn/started", {"threadId": thread, "turn": {"id": turn, "status": "inProgress", "items": []}})
        message = inspect(prompt)
        if "Hold the mount" in prompt:
            # Stay in the turn until cancellation or the Host closes stdin.
            continue
        total = {"inputTokens": 4, "cachedInputTokens": 0, "outputTokens": 3, "reasoningOutputTokens": 0, "totalTokens": 7}
        with Path(os.environ["CODEX_HOME"]).joinpath("sessions/thread.jsonl").open("a") as stream:
            stream.write(json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 4, "cached_input_tokens": 0, "output_tokens": 3}}}}) + "\n")
        notify("item/completed", {"threadId": thread, "turnId": turn, "item": {"id": "mount-message", "type": "agentMessage", "text": message}})
        notify("thread/tokenUsage/updated", {"threadId": thread, "turnId": turn, "tokenUsage": {"total": total, "last": total}})
        notify("turn/completed", {"threadId": thread, "turn": {"id": turn, "status": "completed", "items": []}})
    elif method == "turn/interrupt":
        reply(request, {})
    else:
        raise AssertionError(f"unexpected native request {method}")
