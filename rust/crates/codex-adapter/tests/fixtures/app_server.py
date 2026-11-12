#!/usr/bin/python3
"""Disposable stdio App Server fixture for the pinned 0.163.0 wire protocol."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

if sys.argv[1:] == ["--version"]:
    print("codex-cli 0.163.0")
    sys.exit(0)

root = Path(__file__).resolve().parent
root.joinpath("args").write_bytes(b"\0".join(arg.encode() for arg in sys.argv[1:]) + b"\0")
root.joinpath("pid").write_text(str(os.getpid()))
root.joinpath("env").write_text("\n".join(f"{key}={value}" for key, value in os.environ.items()))
home = Path(os.environ["CODEX_HOME"])
if home.joinpath("auth.json").exists():
    shutil.copyfile(home / "auth.json", root / "auth")
    root.joinpath("auth-mode").write_text(subprocess.check_output(["/bin/ls", "-l", str(home / "auth.json")]).decode())
if home.joinpath("config.toml").exists():
    root.joinpath("config-copied").write_text("unexpected config")
print("private stderr synthetic-codex-provider-secret", file=sys.stderr)

raw = root.joinpath("output.jsonl").read_text()
events = []
for line in raw.splitlines():
    try:
        events.append(json.loads(line))
    except (ValueError, TypeError):
        events.append(line)
first = next((event for event in events if isinstance(event, dict) and event.get("type") == "thread.started"), {})
thread = first.get("thread_id", "native-thread")
turn = "native-turn"
mode = root.joinpath("steering-mode").read_text() if root.joinpath("steering-mode").exists() else ""
total = {"inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0, "reasoningOutputTokens": 0, "totalTokens": 0}
late_baseline = None
question_mode = root.joinpath("question-mode").read_text() if root.joinpath("question-mode").exists() else ""
coordination_tools = [
    ("read_workstream", {"afterSequence": 1, "limit": 2}),
    ("read_mailbox", {"limit": 2}),
    ("post", {"text": "Release is ready.", "to": ["reviewer"]}),
] if root.joinpath("coordination-mode").exists() else []
if root.joinpath("direct-mode").exists():
    coordination_tools.append(("send_message", {"to": "reviewer", "text": "Private rollout note."}))

def emit(value):
    print(json.dumps(value), flush=True)

def reply(request, result):
    emit({"id": request["id"], "result": result})

def notify(method, params):
    emit({"method": method, "params": params})

def ask_native(rpc="question-rpc"):
    params = {"threadId": thread, "turnId": turn, "namespace": "supertag", "tool": "ask", "callId": "question-call", "arguments": {"text": "May I use staging?"}}
    if question_mode == "wrong-thread": params["threadId"] = "foreign-thread"
    if question_mode == "wrong-turn": params["turnId"] = "foreign-turn"
    if question_mode == "wrong-namespace": params["namespace"] = "operator"
    if question_mode == "changed-replay" and rpc == "duplicate-rpc": params["arguments"]["text"] = "Use production instead?"
    if question_mode == "extra": params["arguments"]["objective_id"] = "foreign-objective"
    emit({"id": rpc, "method": "item/tool/call", "params": params})

def coordination_call(index):
    tool, arguments = coordination_tools[index]
    emit({
        "id": f"coordination-{index}", "method": "item/tool/call",
        "params": {"threadId": thread, "turnId": turn, "namespace": "supertag",
                   "tool": tool, "callId": f"coordination-call-{index}", "arguments": arguments},
    })

def prepare_history():
    home.joinpath("sessions").mkdir(exist_ok=True)
    transcript = home / "sessions/thread.jsonl"
    if transcript.exists():
        shutil.copyfile(transcript, root / "restored.jsonl")
    else:
        shutil.copyfile(root / "seed.jsonl", transcript)
    for line in transcript.read_text().splitlines():
        value = json.loads(line)
        usage = value.get("payload", {}).get("info", {}).get("total_token_usage")
        if usage:
            total.update(inputTokens=usage["input_tokens"], cachedInputTokens=usage["cached_input_tokens"], outputTokens=usage["output_tokens"])
            total["totalTokens"] = total["inputTokens"] + total["outputTokens"]

def finish_events():
    if not raw:
        os.execv("/bin/sh", ["/bin/sh", "-c", root.joinpath("tail").read_text()])
    completed = False
    for event in events:
        if not isinstance(event, dict):
            print(event, flush=True)
            continue
        kind = event.get("type")
        if kind == "thread.started":
            continue
        if kind == "turn.started":
            notify("turn/started", {"threadId": thread, "turn": {"id": turn, "status": "inProgress", "items": [], **({"model": event["model"]} if "model" in event else {})}})
        elif kind == "turn.completed":
            usage = event.get("usage", {})
            if usage:
                total["inputTokens"] += usage["input_tokens"]
                total["cachedInputTokens"] += usage["cached_input_tokens"]
                total["outputTokens"] += usage["output_tokens"]
                total["totalTokens"] = total["inputTokens"] + total["outputTokens"]
                notify("thread/tokenUsage/updated", {"threadId": thread, "turnId": turn, "tokenUsage": {"total": total, "last": total}})
                with home.joinpath("sessions/thread.jsonl").open("a") as stream:
                    stream.write(json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": total["inputTokens"], "cached_input_tokens": total["cachedInputTokens"], "output_tokens": total["outputTokens"]}}}}) + "\n")
            notify("turn/completed", {"threadId": thread, "turn": {"id": turn, "status": "completed", "items": []}})
            completed = True
        elif kind in ("turn.failed", "error"):
            notify("turn/completed", {"threadId": thread, "turn": {"id": turn, "status": "failed", "items": [], "error": {"message": "synthetic-codex-provider-secret"}}})
        elif kind in ("item.started", "item.updated", "item.completed"):
            item = dict(event.get("item", {}))
            item["type"] = {"agent_message": "agentMessage", "command_execution": "commandExecution", "file_change": "fileChange", "web_search": "webSearch", "todo_list": "plan"}.get(item.get("type"), item.get("type"))
            if "aggregated_output" in item:
                item["aggregatedOutput"] = item.pop("aggregated_output")
            if item.get("status") == "in_progress":
                item["status"] = "inProgress"
            notify("item/completed" if kind == "item.completed" else "item/started", {"threadId": thread, "turnId": turn, "item": item})
        else:
            notify("fixture/unsupported", event)
    status = subprocess.call(["/bin/sh", "-c", root.joinpath("tail").read_text()])
    if status or not completed:
        sys.exit(status)

disabled_skills = set()

for line in sys.stdin:
    request = json.loads(line)
    with root.joinpath("requests.jsonl").open("a") as log:
        log.write(json.dumps(request) + "\n")
    method = request.get("method")
    if method == "initialize":
        reply(request, {"userAgent": "fixture"})
        notify("remoteControl/status/changed", {"status": "disabled", "installationId": "fixture", "serverName": "fixture"})
    elif method == "initialized":
        pass
    elif method == "config/read":
        layers = [{"name": {"type": "project"}, "config": {"model_provider": "untrusted"}, "disabledReason": ""}] if mode == "project-config" else []
        reply(request, {"config": {}, "layers": layers, "origins": {}})
    elif method == "skills/list":
        roots = [home.joinpath("skills"), Path.cwd().joinpath(".agents/skills")]
        skills = [{"name": path.parent.name, "path": str(path.resolve()), "enabled": str(path.resolve()) not in disabled_skills} for base in roots if base.exists() for path in sorted(base.glob("*/SKILL.md"))]
        reply(request, {"data": [{"cwd": str(Path.cwd()), "skills": skills, "errors": []}]})
    elif method == "skills/config/write":
        path = request["params"]["path"]
        if request["params"]["enabled"]:
            disabled_skills.discard(path)
        else:
            disabled_skills.add(path)
        reply(request, {"effectiveEnabled": path not in disabled_skills})
    elif method in ("thread/start", "thread/resume"):
        prepare_history()
        if not first and any(isinstance(event, dict) for event in events):
            notify("item/completed", {"threadId": "unowned", "turnId": turn, "item": {"id": "early", "type": "agentMessage", "text": "early"}})
        if method == "thread/resume":
            if root.joinpath("late-baseline").exists():
                late_baseline = dict(total)
            else:
                notify("thread/tokenUsage/updated", {"threadId": thread, "turnId": "prior-turn", "tokenUsage": {"total": total, "last": total}})
        if question_mode == "before-turn": ask_native()
        reply(request, {"thread": {"id": thread}, "approvalPolicy": "never", "cwd": str(Path.cwd())})
    elif method == "turn/start":
        root.joinpath("prompt").write_text(request["params"]["input"][0]["text"])
        if question_mode == "early": ask_native()
        reply(request, {"turn": {"id": turn, "status": "inProgress", "items": []}})
        if late_baseline is not None:
            notify("thread/tokenUsage/updated", {"threadId": thread, "turnId": "prior-turn", "tokenUsage": {"total": late_baseline, "last": late_baseline}})
        if question_mode:
            if question_mode == "moderation": notify("turn/moderationMetadata", {"threadId": thread, "turnId": turn, "metadata": {}})
            if question_mode == "late": finish_events()
            if question_mode != "early": ask_native()
        elif coordination_tools:
            coordination_call(0)
        elif mode:
            notify("turn/started", {"threadId": thread, "turn": {"id": turn, "status": "inProgress", "items": []}})
        else:
            finish_events()
    elif method is None and request.get("id") in ("question-rpc", "duplicate-rpc"):
        assert "result" in request
        if question_mode in ("duplicate", "changed-replay") and request["id"] == "question-rpc":
            ask_native("duplicate-rpc")
        else:
            notify("item/completed", {"threadId": thread, "turnId": turn, "item": {"id": "question-call", "type": "dynamicToolCall", "namespace": "supertag", "tool": "ask", "arguments": {"text": "May I use staging?"}, "status": "completed", "success": request["result"]["success"]}})
            finish_events()
    elif method is None and str(request.get("id", "")).startswith("coordination-"):
        index = int(request["id"].split("-")[-1])
        tool, arguments = coordination_tools[index]
        notify("item/completed", {"threadId": thread, "turnId": turn, "item": {
            "id": f"coordination-call-{index}", "type": "dynamicToolCall", "namespace": "supertag",
            "tool": tool, "arguments": arguments, "status": "completed", "success": request["result"]["success"],
        }})
        if index + 1 == len(coordination_tools):
            finish_events()
        else:
            coordination_call(index + 1)
    elif method == "turn/steer":
        assert request["params"]["threadId"] == thread
        assert request["params"]["expectedTurnId"] == turn
        if mode == "reject":
            emit({"id": request["id"], "error": {"code": -32602, "message": "expected turn is not active"}})
        elif mode == "lost":
            sys.exit(0)
        elif mode == "late":
            finish_events()
            reply(request, {"turnId": turn})
        else:
            reply(request, {"turnId": "other-turn" if mode == "wrong-turn" else turn})
            finish_events()
    elif method == "turn/interrupt":
        reply(request, {})
    else:
        raise AssertionError("unexpected request " + str(method))
