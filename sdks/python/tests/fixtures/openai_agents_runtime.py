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
    def __init__(self, *, secret: str = "", read_path: str | None = None) -> None:
        self.secret = secret
        self.read_path = read_path
        self.requests: list[dict[str, Any]] = []
        self.started = asyncio.Event()
        self.cancelled = asyncio.Event()

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
        if self.read_path is not None and len(self.requests) == 1:
            output = [
                ResponseFunctionToolCall(
                    type="function_call",
                    id="fc_fixture",
                    call_id="call_fixture",
                    name="read_workspace_file",
                    arguments=json.dumps({"path": self.read_path}),
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


if __name__ == "__main__":
    main(model_provider=FixtureProvider())
