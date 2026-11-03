from __future__ import annotations

from typing import Any


def task_attempt(
    *,
    profile_id: str = "codex",
    revision: str = "1",
    session_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    captured_at = "2026-08-13T00:00:00.000Z"
    profile = {"id": profile_id, "revision": revision}
    value: dict[str, Any] = {
        "version": 2,
        "taskId": "task-1",
        "attemptId": "attempt-1",
        "tag": {"id": "tag-1", "name": "Engineering"},
        "input": {
            "origin": {
                "surface": "slack",
                "accountId": "slack-1",
                "scope": "channel:engineering",
                "sessionKey": "slack:engineering:thread-1",
                "occurredAt": captured_at,
            },
            "messages": [
                {
                    "id": "message-1",
                    "role": "requester",
                    "text": "Where is the Worker protocol version declared?",
                }
            ],
        },
        "authorization": {
            "version": 5,
            "capturedAt": captured_at,
            "tag": {"id": "tag-1", "name": "Engineering"},
            "origin": {
                "tagRouteId": "route-1",
                "surfaceAccountId": "slack-1",
                "provider": "slack",
                "scope": "channel:engineering",
            },
            "requester": {"id": "user-1", "kind": "user"},
            "permissionSets": [],
            "resources": [],
            "runtimeActions": [],
        },
        "contextPlan": {"version": 7, "capturedAt": captured_at, "sets": []},
        "workspacePlan": {"version": 1, "status": "none"},
        "workerProfile": profile,
        "execution": {},
        "session": {"id": "session-1", "history": []},
    }
    if session_state is not None:
        value["session"]["sessionState"] = session_state
    return value
