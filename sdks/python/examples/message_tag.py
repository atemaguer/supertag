"""Send a Tag a message and print its reply as the Tag writes it.

export SUPERTAG_CONTROL_PLANE='https://control-plane.example.com'
export SUPERTAG_OPERATOR_TOKEN='admin-token-or-operator-token'
python message_tag.py TAG 'What changed in the last release?'
"""

from __future__ import annotations

import asyncio
import os
import sys

from supertag.operator import ConnectError, OperatorClient, error_detail
from supertag.operator.v1 import common_pb2, conversation_pb2


async def message_tag(url: str, token: str, tag: str, text: str) -> str:
    """Returns the Tag's reply, printing its text to stdout as it arrives."""
    async with OperatorClient(url, token) as client:
        message = await client.conversation.send_message(
            conversation_pb2.SendMessageRequest(tag=tag, text=text), timeout_ms=30_000
        )
        streamed = False
        async for event in client.conversation.follow_message(
            conversation_pb2.FollowMessageRequest(tag=tag, task_id=message.task_id)
        ):
            part = event.WhichOneof("part")
            if part == "text_delta":
                streamed = True
                print(event.text_delta.text, end="", flush=True)
            elif part == "finish":
                reply = event.finish.reply.text
                print("" if streamed else reply)
                return reply
            elif part == "error":
                raise RuntimeError(event.error.text)
    raise RuntimeError("The reply stream ended before the Tag replied")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: python message_tag.py TAG TEXT")
    try:
        asyncio.run(
            message_tag(
                os.environ.get("SUPERTAG_CONTROL_PLANE", "http://127.0.0.1:3434"),
                os.environ["SUPERTAG_OPERATOR_TOKEN"],
                sys.argv[1],
                sys.argv[2],
            )
        )
    except ConnectError as error:
        detail = error_detail(error)
        reason = common_pb2.ErrorReason.Name(detail.reason) if detail else error.code.value
        raise SystemExit(f"{error.message} ({reason})") from None


if __name__ == "__main__":
    main()
