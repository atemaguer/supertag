from __future__ import annotations

import asyncio
import base64
import json
import os
import random
import re
from contextlib import suppress
from typing import Any, Callable
from urllib.parse import quote, unquote, urlsplit, urlunsplit

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from .models import (
    WORKLET_PROTOCOL_VERSION,
    Worklet,
    required_text,
    utc_now,
    wire,
)


class _NoRedirectConnect(connect):
    def process_redirect(self, exc: Exception) -> Exception:
        if isinstance(exc, InvalidStatus) and 300 <= exc.response.status_code < 400:
            return _PermanentRegistrationError("Worklet endpoint redirects are forbidden")
        return exc


class WorkletConnection:
    """Reconnectable, concurrent outbound connection from a Worklet to the API Server."""

    def __init__(
        self,
        control_plane_url: str,
        credential: str,
        worklet: Worklet,
        *,
        reconnect_min_seconds: float = 0.25,
        reconnect_max_seconds: float = 10.0,
        on_error: Callable[[Exception], None] | None = None,
        on_connected: Callable[[], None] | None = None,
        on_disconnected: Callable[[], None] | None = None,
    ) -> None:
        parsed = urlsplit(control_plane_url.strip())
        schemes = {"http": "ws", "https": "wss", "ws": "ws", "wss": "wss"}
        scheme = schemes.get(parsed.scheme.lower())
        if scheme is None or parsed.hostname is None:
            raise ValueError("Control Plane URL must use http, https, ws, or wss")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError(
                "Control Plane URL must not contain credentials, query parameters, or a fragment"
            )
        if scheme == "ws" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("Remote Worklet API URLs must use HTTPS or WSS")
        base = urlunsplit((scheme, parsed.netloc, parsed.path, "", "")).rstrip("/")
        self._url = base if base.endswith("/worklets") else base + "/worklets"
        self._credential = credential.strip()
        if not self._credential:
            raise ValueError("Worker Host credential must not be empty")
        self._worklet = worklet
        self._reconnect_min = reconnect_min_seconds
        self._reconnect_max = reconnect_max_seconds
        self._on_error = on_error
        self._on_connected = on_connected
        self._on_disconnected = on_disconnected
        if getattr(worklet, "durable_protocol_version", None) != WORKLET_PROTOCOL_VERSION:
            raise ValueError("Protocol 18 requires a DurableLocalWorklet")
        self._durable = worklet
        self._subscriptions: dict[str, asyncio.Task[None]] = {}
        self._stop = asyncio.Event()
        self._connected = asyncio.Event()
        self._runner: asyncio.Task[None] | None = None
        self._negotiated_protocol_version: int | None = None
        self._initial_error: Exception | None = None

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    @property
    def negotiated_protocol_version(self) -> int | None:
        return self._negotiated_protocol_version

    async def start(self, timeout: float = 10.0) -> None:
        if self._runner is None:
            self._stop.clear()
            self._initial_error = None
            self._runner = asyncio.create_task(self._run_forever())
        ready = asyncio.create_task(self._connected.wait())
        try:
            done, _pending = await asyncio.wait(
                {ready, self._runner}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
            )
            if ready in done and ready.result():
                return
            if self._runner in done and self._initial_error is not None:
                raise self._initial_error
            raise TimeoutError("Timed out waiting for the Worklet to connect")
        except BaseException:
            await self.stop()
            raise
        finally:
            ready.cancel()
            with suppress(asyncio.CancelledError):
                await ready

    async def __aenter__(self) -> "WorkletConnection":
        await self.start()
        return self

    async def __aexit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        await self.stop()

    async def run(self) -> None:
        await self.start()
        if self._runner is not None:
            await self._runner

    async def stop(self) -> None:
        self._stop.set()
        if self._runner is not None:
            self._runner.cancel()
            with suppress(asyncio.CancelledError):
                await self._runner
        self._runner = None
        self._connected.clear()
        self._negotiated_protocol_version = None

    async def _run_forever(self) -> None:
        delay = self._reconnect_min
        while not self._stop.is_set():
            try:
                async with _NoRedirectConnect(self._url, max_size=4 * 1024 * 1024) as socket:
                    await self._session(socket)
                    delay = self._reconnect_min
            except asyncio.CancelledError:
                raise
            except _PermanentRegistrationError as error:
                self._connected.clear()
                self._initial_error = error
                self._report(error)
                return
            except Exception as error:
                self._connected.clear()
                self._report(error)
                if self._stop.is_set():
                    return
                jitter = random.uniform(0.8, 1.2)
                await asyncio.sleep(delay * jitter)
                delay = min(self._reconnect_max, max(self._reconnect_min, delay * 2))

    async def _session(self, socket: ClientConnection) -> None:
        descriptor = wire(await self._worklet.describe())
        descriptor["durableProtocolVersion"] = 1
        hello: dict[str, Any] = {
            "type": "hello",
            "protocolVersions": [WORKLET_PROTOCOL_VERSION],
            "credential": self._credential,
            "worklet": descriptor,
        }
        await self._send(socket, hello)
        heartbeat: asyncio.Task[None] | None = None
        registered = False
        placement_request_ids: set[str] = set()
        try:
            try:
                async for raw in socket:
                    message = json.loads(raw)
                    if not isinstance(message, dict):
                        raise RuntimeError("Control Plane message must be an object")
                    kind = message.get("type")
                    if not registered and kind not in ("ready", "protocol_error"):
                        raise RuntimeError("Control Plane must send ready before operations")
                    if kind == "ready":
                        if registered:
                            raise RuntimeError("Control Plane sent duplicate ready")
                        selected = message.get("protocolVersion")
                        if type(selected) is not int or selected != WORKLET_PROTOCOL_VERSION:
                            raise _PermanentRegistrationError(
                                "Control Plane selected an unsupported protocol version"
                            )
                        interval = message.get("heartbeatIntervalMs", 15_000)
                        if not isinstance(interval, (int, float)) or interval <= 0:
                            raise RuntimeError("Control Plane sent an invalid heartbeat interval")
                        registered = True
                        self._negotiated_protocol_version = int(selected)
                        self._connected.set()
                        self._notify(self._on_connected)
                        heartbeat = asyncio.create_task(self._heartbeat(socket, interval / 1000))
                    elif kind == "heartbeat_ack":
                        continue
                    elif kind in ("durable_request", "durable_unsubscribe"):
                        request_id = required_text(message, "requestId")
                        if kind == "durable_unsubscribe":
                            subscription = self._subscriptions.get(request_id)
                            if subscription is not None:
                                subscription.cancel()
                        else:
                            if (
                                request_id in self._subscriptions
                                or request_id in placement_request_ids
                            ):
                                raise RuntimeError("Duplicate durable request ID")
                            if message.get("operation") in (
                                "select_placement",
                                "release_placement",
                            ):
                                if (
                                    len(request_id.encode()) > 1024
                                    or len(placement_request_ids) >= 4096
                                ):
                                    raise RuntimeError(
                                        "Placement replay capacity exhausted; reconnect"
                                    )
                                placement_request_ids.add(request_id)
                            task = asyncio.create_task(self._durable_request(socket, message))
                            self._subscriptions[request_id] = task
                            task.add_done_callback(
                                lambda finished, key=request_id: self._subscriptions.pop(key, None)
                            )
                    elif kind == "protocol_error":
                        if not registered:
                            raise _PermanentRegistrationError(
                                str(message.get("message") or "Worker registration rejected")
                            )
                        raise RuntimeError(str(message.get("message") or "Worker protocol error"))
                    else:
                        raise RuntimeError(
                            f"Control Plane sent an unsupported message type: {kind!r}"
                        )
            except ConnectionClosed as error:
                close_code = error.rcvd.code if error.rcvd is not None else None
                close_reason = error.rcvd.reason if error.rcvd is not None else ""
                if close_code in (4007, 4008) or (
                    not registered and close_code in (4002, 4003, 4004)
                ):
                    raise _PermanentRegistrationError(
                        close_reason
                        or f"Control Plane rejected Worklet registration ({close_code})"
                    ) from error
                raise
        finally:
            was_connected = self._connected.is_set()
            self._connected.clear()
            self._negotiated_protocol_version = None
            if was_connected:
                self._notify(self._on_disconnected)
            if heartbeat is not None:
                heartbeat.cancel()
                with suppress(asyncio.CancelledError):
                    await heartbeat
            subscriptions = tuple(self._subscriptions.values())
            for subscription in subscriptions:
                subscription.cancel()
            await asyncio.gather(*subscriptions, return_exceptions=True)
            self._subscriptions.clear()

    async def _durable_request(self, socket: ClientConnection, message: dict[str, Any]) -> None:
        assert self._durable is not None
        request_id = required_text(message, "requestId")
        operation = message.get("operation")
        try:
            attempt_id = (
                required_text(message, "attemptId")
                if operation not in ("accept", "select_placement", "release_placement")
                else None
            )
            result_kind = None
            if operation == "select_placement":
                result = await self._durable.select_placement(
                    message["requirements"], message["contextPlan"], message["options"]
                )
                result_kind = "placement" if result is not None else "no_placement"
            elif operation == "release_placement":
                await self._durable.release_placement(message["placement"])
                result = {"released": True}
                result_kind = "placement_release"
            elif operation == "accept":
                result = await self._durable.accept(message["spec"])
            elif operation == "inspect":
                result = await self._durable.inspect(attempt_id)
            elif operation == "control_capabilities":
                result = None  # Python Workers do not implement native interactive control.
            elif operation == "control":
                command = message.get("command", {})
                if required_text(command, "attemptId") != attempt_id:
                    raise ValueError("Control Attempt identity mismatch")
                result = {
                    "id": required_text(command, "id"),
                    "taskId": required_text(command, "taskId"),
                    "attemptId": attempt_id,
                    "status": "rejected",
                    "reason": "Python Worklet control unsupported",
                }
            elif operation == "cancel":
                reason = message.get("reason", "Cancellation requested")
                if not isinstance(reason, str):
                    raise ValueError("Invalid cancellation reason")
                result = await self._durable.cancel(attempt_id, reason)
            elif operation == "events":
                async for item in self._durable.events(attempt_id, message.get("afterSequence", 0)):
                    await self._send(
                        socket, {"type": "durable_event", "requestId": request_id, "item": item}
                    )
                await self._send(socket, {"type": "durable_end", "requestId": request_id})
                return
            else:
                raise ValueError("Unknown durable operation")
            await self._send(
                socket,
                {
                    "type": "durable_reply",
                    "requestId": request_id,
                    **({} if result is None else {"result": result}),
                    **({} if result_kind is None else {"resultKind": result_kind}),
                },
            )
        except Exception as error:
            with suppress(ConnectionClosed):
                await self._send(
                    socket,
                    {
                        "type": "durable_end" if operation == "events" else "durable_reply",
                        "requestId": request_id,
                        "error": _redact_error(str(error), message.get("spec"), self._credential),
                    },
                )

    async def _heartbeat(self, socket: ClientConnection, interval: float) -> None:
        while True:
            await asyncio.sleep(interval)
            await self._send(socket, {"type": "heartbeat", "at": utc_now()})

    @staticmethod
    async def _send(socket: ClientConnection, message: dict[str, Any]) -> None:
        await socket.send(json.dumps(message, separators=(",", ":")))

    def _report(self, error: Exception) -> None:
        if self._on_error is not None:
            try:
                self._on_error(error)
            except Exception:
                pass

    def _notify(self, callback: Callable[[], None] | None) -> None:
        if callback is not None:
            try:
                callback()
            except Exception as error:
                self._report(error)


class _PermanentRegistrationError(RuntimeError):
    pass


def _validate_attempt_spec(
    spec: dict[str, Any], authorization_versions: tuple[int, ...] = (5,)
) -> None:
    if type(spec.get("version")) is not int or spec.get("version") != 2:
        raise RuntimeError("Task Attempt Spec version must be 2")
    required_text(spec, "taskId")
    required_text(spec, "attemptId")
    session = spec.get("session")
    if isinstance(session, dict) and "persistence" in session:
        persistence = session["persistence"]
        if not isinstance(persistence, dict) or set(persistence) != {"controlPlaneUrl", "token"}:
            raise RuntimeError("Invalid Session persistence configuration")
        required_text(persistence, "controlPlaneUrl")
        required_text(persistence, "token")
    tag = spec.get("tag")
    if not isinstance(tag, dict):
        raise RuntimeError("Task Attempt Spec tag must be an object")
    required_text(tag, "id")
    required_text(tag, "name")
    authorization = spec.get("authorization")
    if (
        not isinstance(authorization, dict)
        or authorization.get("version") not in authorization_versions
    ):
        raise RuntimeError("Task Attempt Spec authorization version is unsupported")
    if not isinstance(authorization.get("runtimeActions"), list):
        raise RuntimeError("Task Attempt Spec authorization.runtimeActions must be an array")
    roles = authorization.get("roles", [])
    if not isinstance(roles, list):
        raise RuntimeError("Task Attempt Spec authorization.roles must be an array")
    for assignment in roles:
        _validate_role_snapshot(assignment)
    context_plan = spec.get("contextPlan")
    if (
        not isinstance(context_plan, dict)
        or context_plan.get("version") != 7
        or not isinstance(context_plan.get("sets"), list)
    ):
        raise RuntimeError("Task Attempt Spec Context Plan must be version 7 with a sets array")


def _validate_role_snapshot(value: Any) -> None:
    if not isinstance(value, dict):
        raise RuntimeError("Task Attempt Spec Role assignment must be an object")
    if not isinstance(value.get("assignmentId"), str) or not value["assignmentId"]:
        raise RuntimeError("Task Attempt Spec Role assignment id is required")
    revision = value.get("assignmentRevision")
    if type(revision) is not int or revision < 1:
        raise RuntimeError("Task Attempt Spec Role assignment revision must be positive")
    role = value.get("role")
    if not isinstance(role, dict):
        raise RuntimeError("Task Attempt Spec Role must be an object")
    for field in ("id", "name", "purpose"):
        if not isinstance(role.get(field), str) or not role[field]:
            raise RuntimeError(f"Task Attempt Spec Role {field} is required")
    if not isinstance(role.get("instructions"), str):
        raise RuntimeError("Task Attempt Spec Role instructions must be text")
    role_revision = role.get("revision")
    if type(role_revision) is not int or role_revision < 1:
        raise RuntimeError("Task Attempt Spec Role revision must be positive")
    if role.get("origin") not in {"system", "user"}:
        raise RuntimeError("Task Attempt Spec Role origin is invalid")
    if (role["origin"] == "system" and role.get("systemKey") != "org-architect") or (
        role["origin"] == "user" and "systemKey" in role
    ):
        raise RuntimeError("Task Attempt Spec Role system provenance is invalid")
    for field in ("contextSetIds", "permissionSetIds"):
        values = role.get(field)
        if not isinstance(values, list) or any(
            not isinstance(item, str) or not item for item in values
        ):
            raise RuntimeError(f"Task Attempt Spec Role {field} must be a string array")


_SENSITIVE_NAME = re.compile(
    r"token|secret|password|passwd|credential|authorization|api[_-]?key|private[_-]?key|"
    r"app[_-]?id|(?:[_-](?:key|pat|sk)|(?:^|[_-])(?:auth|pass))$",
    re.I,
)


def _redact_error(text: str, spec: Any, credential: str) -> str:
    secrets = {credential}

    def collect(value: Any, sensitive: bool = False) -> None:
        if isinstance(value, str) and sensitive and value:
            secrets.add(value)
        elif isinstance(value, dict):
            for key, item in value.items():
                collect(item, sensitive or bool(_SENSITIVE_NAME.search(str(key))))
        elif isinstance(value, list):
            for item in value:
                collect(item, sensitive)

    collect(dict(os.environ))
    collect(spec)
    variants: set[str] = set()
    short: set[str] = set()
    for secret in secrets:
        if not secret:
            continue
        if len(secret) < 8 or secret.lower() in ("true", "false") or secret.isdecimal():
            short.add(secret)
            continue
        encoded = base64.b64encode(secret.encode()).decode()
        variants.update(
            (
                secret,
                quote(secret, safe=""),
                json.dumps(secret)[1:-1],
                encoded,
                encoded.rstrip("="),
                base64.urlsafe_b64encode(secret.encode()).decode().rstrip("="),
            )
        )

    def redact(value: str) -> str:
        value = re.sub(r"//[^\s/@?#]+(?::[^\s@]*)?@", "//[REDACTED]@", value)
        value = re.sub(
            r"([?&#])([\w.-]+)=([^&#\s\"<>]*)",
            lambda match: (
                f"{match[1]}{match[2]}=[REDACTED]"
                if _SENSITIVE_NAME.search(match[2]) or match[2].lower() == "x-amz-signature"
                else match[0]
            ),
            value,
        )
        value = re.sub(r"\bBasic\s+[a-z\d+/_-]+=*", "Basic [REDACTED]", value, flags=re.I)
        for secret in sorted(variants, key=len, reverse=True):
            value = value.replace(secret, "[REDACTED]")
        for secret in sorted(short, key=len, reverse=True):
            value = re.sub(r"(?<!\w)" + re.escape(secret) + r"(?!\w)", "[REDACTED]", value)
        return value

    safe = redact(text)
    decoded = safe
    for _ in range(3):
        decoded = unquote(decoded)
        redacted = redact(decoded)
        if redacted != decoded:
            safe = decoded = redacted
    return safe
