"""Use the installed Agents Runner with a deterministic Responses stream."""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

from agents import Model, ModelProvider
from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseTextDeltaEvent,
    ResponseUsage,
)
from openai.types.responses.response_usage import InputTokensDetails, OutputTokensDetails

from supertag.openai_agents_adapter import main

FIRST_RESULT = "SDK fixture completed first Task."
RESUMED_RESULT = "SDK fixture resumed the Session."


class FixtureModel(Model):
    def __init__(
        self,
        *,
        secret: str = "",
        read_path: str | None = None,
        tool_calls: list[tuple[str, dict[str, Any]]] | None = None,
    ) -> None:
        self.secret = secret
        self.tool_calls = tool_calls or (
            [("read_workspace_file", {"path": read_path})] if read_path is not None else []
        )
        self.requests: list[dict[str, Any]] = []
        self.started = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.call_scope = "fixture"

    def tool_call(self, input: Any, tools: Any) -> tuple[str, dict[str, Any]] | None:
        index = len(self.requests)
        return self.tool_calls[index - 1] if index <= len(self.tool_calls) else None

    async def get_response(self, *args: Any, **kwargs: Any) -> Any:
        raise AssertionError("the adapter should use Runner.run_streamed")

    async def stream_response(
        self,
        system_instructions: Any,
        input: Any,
        model_settings: Any,
        tools: Any,
        output_schema: Any,
        handoffs: Any,
        tracing: Any,
        **request: Any,
    ) -> AsyncIterator[Any]:
        self.requests.append({"input": input, "tools": tools})
        self.started.set()
        serialized = json.dumps(input)
        if "wait for cancellation" in serialized:
            try:
                await asyncio.Event().wait()
            finally:
                self.cancelled.set()
        if tool := self.tool_call(input, tools):
            name, arguments = tool
            index = len(self.requests)
            output = [
                ResponseFunctionToolCall(
                    type="function_call",
                    id=f"fc_{self.call_scope}_{index}",
                    call_id=f"call_{self.call_scope}_{index}",
                    name=name,
                    arguments=json.dumps(arguments),
                    status="completed",
                )
            ]
        else:
            text = RESUMED_RESULT if FIRST_RESULT in serialized else FIRST_RESULT
            if self.secret:
                text += " " + self.secret
            output = [
                ResponseOutputMessage(
                    type="message",
                    id="msg_fixture",
                    role="assistant",
                    status="completed",
                    content=[ResponseOutputText(type="output_text", text=text, annotations=[])],
                )
            ]
            split = len(text) - len(self.secret) // 2
            for sequence, delta in enumerate((text[:split], text[split:]), start=1):
                if delta:
                    yield ResponseTextDeltaEvent(
                        type="response.output_text.delta",
                        sequence_number=sequence,
                        content_index=0,
                        delta=delta,
                        item_id="msg_fixture",
                        output_index=0,
                        logprobs=[],
                    )
        yield ResponseCompletedEvent(
            type="response.completed",
            sequence_number=3,
            response=Response.model_construct(
                id=f"resp_fixture_{len(self.requests)}",
                model="fixture-observed-model",
                output=output,
                usage=ResponseUsage(
                    input_tokens=11,
                    input_tokens_details=InputTokensDetails(cached_tokens=2),
                    output_tokens=5,
                    output_tokens_details=OutputTokensDetails(reasoning_tokens=0),
                    total_tokens=16,
                ),
            ),
        )


class FixtureProvider(ModelProvider):
    def __init__(self, model: FixtureModel | None = None) -> None:
        self.model = model or FixtureModel()
        self.requested_models: list[str | None] = []

    def get_model(self, model_name: str | None) -> Model:
        self.requested_models.append(model_name)
        return self.model


class RuntimeFixtureModel(FixtureModel):
    def tool_call(self, input: Any, tools: Any) -> tuple[str, dict[str, Any]] | None:
        if len(self.requests) == 1:
            prompt = next(
                (item.get("content", "") for item in reversed(input) if item.get("role") == "user"),
                "",
            )
            self.prompt = prompt if isinstance(prompt, str) else ""
            self.call_scope = self.prompt.split(" ", 1)[0]
        if self.call_scope not in ("artifact-producer", "artifact-consumer", "artifact-foreign"):
            self.call_scope = "fixture"
            return super().tool_call(input, tools)

        turn = len(self.requests)
        available = {tool.name for tool in tools}
        assert {"find_artifacts", "inspect_artifact", "read_artifact"} <= available
        outputs = [
            item["output"]
            for item in input
            if item.get("type") == "function_call_output"
            and item["call_id"].startswith(f"call_{self.call_scope}_")
        ]
        if self.call_scope == "artifact-foreign":
            assert available == {"find_artifacts", "inspect_artifact", "read_artifact"}
            if turn == 1:
                return "find_artifacts", {}
            assert json.loads(outputs[0])["artifacts"] == []
            if turn == 2:
                return "inspect_artifact", {"artifactId": self.prompt.split(" ", 1)[1]}
            assert "could not be confirmed" in outputs[1]
            return None

        assert {"read_workspace_file", "attach_artifact", "capture_artifact"} <= available
        if self.call_scope == "artifact-producer":
            if turn <= 2:
                return "capture_artifact", {
                    "title": "Python evidence",
                    "kind": "report",
                    "paths": ["evidence.txt"],
                    "operationId": "python-producer-capture",
                }
            assert json.loads(outputs[0]) == json.loads(outputs[1])
            return None

        if turn == 1:
            return "find_artifacts", {"kind": "report"}
        found = json.loads(outputs[0])["artifacts"]
        assert len(found) == 1
        artifact_id = found[0]["artifactId"]
        if turn == 2:
            return "inspect_artifact", {"artifactId": artifact_id}
        manifest = json.loads(outputs[1])
        assert manifest["summary"]["producer"]["tagId"] == "python-artifacts"
        assert manifest["files"][0]["path"] == "evidence.txt"
        selection = {"artifactId": artifact_id, "path": "evidence.txt", "operationId": "read-page"}
        if turn == 3:
            return "read_artifact", {**selection, "limit": 2}
        first = json.loads(outputs[2])
        assert first["text"] == "é" and first["nextOffset"] == "2" and first["truncated"]
        if turn == 4:
            return "read_artifact", {**selection, "offset": 2}
        second = json.loads(outputs[3])
        assert second["text"] == "vidence from Python\n" and not second["truncated"]
        if turn in (5, 6):
            return "attach_artifact", {
                "artifactId": artifact_id,
                "paths": ["evidence.txt"],
                "operationId": "attach-once",
            }
        attachment = json.loads(outputs[4])
        assert attachment == json.loads(outputs[5])
        if turn == 7:
            return "read_workspace_file", {"path": f"{attachment['localPath']}/evidence.txt"}
        assert outputs[6] == "évidence from Python\n"
        if turn == 8:
            return "capture_artifact", {
                "title": "Derived Python evidence",
                "kind": "report",
                "paths": ["derived.txt"],
                "operationId": "python-consumer-capture",
            }
        assert json.loads(outputs[7])["artifactId"] != artifact_id
        return None


if __name__ == "__main__":
    main(model_provider=FixtureProvider(RuntimeFixtureModel()))
