#!/usr/bin/python3
"""Fake Codex app server for a Task with a network scope: it records what it received and
connects to the Worker Host's egress proxy as Codex's managed proxy would."""
import base64
import json
import os
from pathlib import Path
import socket
import sys
from urllib.parse import urlsplit

if sys.argv[1:] == ["--version"]:
    print("codex-cli 0.163.0")
    sys.exit(0)
assert sys.argv[1:4] == ["app-server", "--listen", "stdio://"]
# The sandbox allows only loopback, and Codex's managed proxy only the scope's hosts.
for flag in [
    "features.network_proxy.enabled=true",
    "permissions.supertag.network.allow_upstream_proxy=true",
    'permissions.supertag.network.domains={ "api.github.com" = "allow" }',
    "features.code_mode_host=true",
]:
    assert flag in sys.argv, (flag, sys.argv)
Path("@RECORD@").write_text(
    json.dumps({"argv": sys.argv, "environment": dict(os.environ)})
)
thread = "network-thread"
turn = "network-turn"


def emit(value):
    print(json.dumps(value), flush=True)


def reply(request, result):
    emit({"id": request["id"], "result": result})


def notify(method, params):
    emit({"method": method, "params": params})


def connect(target, authorized):
    proxy = urlsplit(os.environ["HTTPS_PROXY"])
    with socket.create_connection((proxy.hostname, proxy.port), timeout=10) as stream:
        head = f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n"
        if authorized:
            token = base64.b64encode(f"{proxy.username}:{proxy.password}".encode()).decode()
            head += f"Proxy-Authorization: Basic {token}\r\n"
        stream.sendall((head + "\r\n").encode())
        return stream.recv(4096).decode().split("\r\n")[0].split(" ")[1]


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
        config = request["params"]["config"]
        assert config["permissions.supertag.network.domains"] == {"api.github.com": "allow"}, config
        sessions = Path(os.environ["CODEX_HOME"]).joinpath("sessions")
        sessions.mkdir(exist_ok=True)
        records = [{"type": "session_meta", "payload": {"id": thread, "cwd": str(Path.cwd())}}]
        sessions.joinpath("thread.jsonl").write_text("\n".join(map(json.dumps, records)) + "\n")
        reply(request, {"thread": {"id": thread}})
    elif method == "turn/start":
        reply(request, {"turn": {"id": turn, "status": "inProgress", "items": []}})
        notify("turn/started", {"threadId": thread, "turn": {"id": turn, "status": "inProgress", "items": []}})
        # Outside the scope: refused before any TLS. Without the proxy password: refused unlogged.
        message = f"outside={connect('denied.example.com:443', True)} anonymous={connect('api.github.com:443', False)}"
        total = {"inputTokens": 4, "cachedInputTokens": 0, "outputTokens": 3, "reasoningOutputTokens": 0, "totalTokens": 7}
        with Path(os.environ["CODEX_HOME"]).joinpath("sessions/thread.jsonl").open("a") as stream:
            stream.write(json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 4, "cached_input_tokens": 0, "output_tokens": 3}}}}) + "\n")
        notify("item/completed", {"threadId": thread, "turnId": turn, "item": {"id": "network-message", "type": "agentMessage", "text": message}})
        notify("thread/tokenUsage/updated", {"threadId": thread, "turnId": turn, "tokenUsage": {"total": total, "last": total}})
        notify("turn/completed", {"threadId": thread, "turn": {"id": turn, "status": "completed", "items": []}})
    elif method == "turn/interrupt":
        reply(request, {})
    else:
        raise AssertionError(f"unexpected native request {method}")
