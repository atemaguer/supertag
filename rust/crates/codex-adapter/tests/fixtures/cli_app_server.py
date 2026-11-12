#!/usr/bin/python3
"""Native subprocess used by the split CP/Gateway/Host integration test."""
import json
import os
from pathlib import Path
import sys

if sys.argv[1:] == ["--version"]:
    print("codex-cli 0.163.0")
    sys.exit(0)
assert sys.argv[1:4] == ["app-server", "--listen", "stdio://"]
for flag in ['model="fixture-model"', 'sandbox_mode="read-only"', 'features.code_mode_host=false']:
    assert flag in sys.argv
for name in ["SUPERTAG_HOST_TOKEN", "SUPERTAG_OPERATOR_TOKEN", "SUPERTAG_GATEWAY_TOKEN", "SUPERTAG_ADAPTER_STATE_DIRECTORY", "SUPERTAG_ADAPTER_SCRATCH_PARENT"]:
    assert not os.environ.get(name)
home = Path(os.environ["CODEX_HOME"])
assert "fixture-native-sign-in" in home.joinpath("auth.json").read_text()
thread = "fixture-thread"
turn = "fixture-turn"
total = {"inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0, "reasoningOutputTokens": 0, "totalTokens": 0}
resumed = False

def emit(value):
    print(json.dumps(value), flush=True)

def reply(request, result):
    emit({"id": request["id"], "result": result})

def notify(method, params):
    emit({"method": method, "params": params})

def finish(message):
    total["inputTokens"] += 4
    total["cachedInputTokens"] += 1
    total["outputTokens"] += 3
    total["totalTokens"] += 7
    with home.joinpath("sessions/thread.jsonl").open("a") as stream:
        stream.write(json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": total["inputTokens"], "cached_input_tokens": total["cachedInputTokens"], "output_tokens": total["outputTokens"]}}}}) + "\n")
    notify("item/completed", {"threadId": thread, "turnId": turn, "item": {"id": "fixture-message", "type": "agentMessage", "text": message}})
    notify("thread/tokenUsage/updated", {"threadId": thread, "turnId": turn, "tokenUsage": {"total": total, "last": total}})
    notify("turn/completed", {"threadId": thread, "turn": {"id": turn, "status": "completed", "items": []}})

for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        reply(request, {"userAgent": "fixture"})
    elif method == "initialized":
        pass
    elif method == "config/read":
        reply(request, {"layers": [], "config": {}, "origins": {}})
    elif method in ("thread/start", "thread/resume"):
        assert request["params"]["approvalPolicy"] == "never"
        assert request["params"]["sandbox"] == "read-only"
        assert request["params"]["config"]["features.code_mode_host"] is False
        assert request["params"]["cwd"] == str(Path.cwd())
        resumed = method == "thread/resume"
        if resumed:
            assert request["params"]["threadId"] == thread
            history = home.joinpath("sessions/thread.jsonl").read_text()
            assert "fixture history" in history
            assert json.loads(history.splitlines()[0])["payload"]["cwd"] == str(Path.cwd())
            for record in map(json.loads, history.splitlines()):
                usage = record.get("payload", {}).get("info", {}).get("total_token_usage")
                if usage:
                    total.update(inputTokens=usage["input_tokens"], cachedInputTokens=usage["cached_input_tokens"], outputTokens=usage["output_tokens"])
                    total["totalTokens"] = total["inputTokens"] + total["outputTokens"]
            notify("thread/tokenUsage/updated", {"threadId": thread, "turnId": "previous-turn", "tokenUsage": {"total": total, "last": total}})
        else:
            home.joinpath("sessions").mkdir(exist_ok=True)
            records = [{"type": "session_meta", "payload": {"id": thread, "cwd": str(Path.cwd())}}, {"type": "response_item", "payload": {"role": "user", "content": [{"type": "input_text", "text": "fixture history"}]}}]
            home.joinpath("sessions/thread.jsonl").write_text("\n".join(map(json.dumps, records)) + "\n")
        reply(request, {"thread": {"id": thread}})
    elif method == "turn/start":
        prompt = request["params"]["input"][0]["text"]
        reply(request, {"turn": {"id": turn, "status": "inProgress", "items": []}})
        notify("turn/started", {"threadId": thread, "turn": {"id": turn, "status": "inProgress", "items": []}})
        if "Wait for live input" in prompt:
            continue
        assert ("Resume the native harness" if resumed else "Verify the native harness") in prompt
        finish("Native adapter resumed" if resumed else "Native adapter verified")
    elif method == "turn/steer":
        assert request["params"]["threadId"] == thread
        assert request["params"]["expectedTurnId"] == turn
        if request["params"]["input"][0]["text"] == "Simulate lost acknowledgement":
            sys.exit(0)
        assert request["params"]["input"][0]["text"] == "Use the live correction"
        reply(request, {"turnId": turn})
        finish("Native adapter steered")
    elif method == "turn/interrupt":
        reply(request, {})
    else:
        raise AssertionError("unexpected native request")
