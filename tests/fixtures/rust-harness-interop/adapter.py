"""Deterministic Python harness adapter for the Rust gRPC interoperability spike."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys

import grpc

sys.path.insert(0, str(Path(__file__).resolve().parent / "generated"))
import harness_pb2 as wire
import harness_pb2_grpc as services


EXPECTED_ERRORS = {
    "bad-auth": grpc.StatusCode.UNAUTHENTICATED,
    "bad-version": grpc.StatusCode.FAILED_PRECONDITION,
    "stale-generation": grpc.StatusCode.FAILED_PRECONDITION,
    "bad-sequence": grpc.StatusCode.INVALID_ARGUMENT,
}


class ProtocolFailure(RuntimeError):
    """A local validation failure whose message is safe to display."""


async def run(bootstrap: dict) -> None:
    scenario = bootstrap["scenario"]
    token = bootstrap["token"]
    if scenario == "bad-auth":
        token = "invalid-credential"
    identity = wire.Identity(
        execution_id=bootstrap["executionId"],
        generation=bootstrap["generation"] + (scenario == "stale-generation"),
    )
    # Native gRPC's Unix-socket authority is not a valid HTTP/2 authority for tonic.
    # Keep routing on the supplied socket while using a valid local authority.
    channel = grpc.aio.insecure_channel(
        bootstrap["target"], options=(("grpc.default_authority", "localhost"),)
    )
    stub = services.HarnessBridgeStub(channel)
    metadata = (("authorization", f"Bearer {token}"),)
    control = stub.Attach(metadata=metadata, timeout=10)
    events = None
    event_reader = None
    producer = None
    control_task = None
    failure = asyncio.get_running_loop().create_future()
    write_lock = asyncio.Lock()
    acknowledgements = asyncio.Queue(maxsize=1)
    prompt = None
    sequence = 0
    received_outcome = False
    welcomed = False
    quiesced = False
    closed = False

    async def send(**body) -> None:
        async with write_lock:
            await control.write(wire.AdapterFrame(identity=identity, **body))

    def capture_failure(task: asyncio.Task) -> None:
        if task.cancelled():
            return
        error = task.exception()
        if error is not None and not failure.done():
            failure.set_result(error)

    async def read_acknowledgements() -> None:
        async for acknowledgement in events:
            await acknowledgements.put(acknowledgement)
        if not closed:
            raise ProtocolFailure("Event stream ended before shutdown")

    async def produce() -> None:
        nonlocal events, event_reader, sequence
        events = stub.PublishEvents(metadata=metadata, timeout=10)
        event_reader = asyncio.create_task(read_acknowledgements())
        event_reader.add_done_callback(capture_failure)
        chunks = ["[python] ", prompt, " complete."]
        for index, text in enumerate(chunks, start=1):
            sequence = 2 if scenario == "bad-sequence" else index
            await events.write(
                wire.HarnessEvent(identity=identity, sequence=sequence, text=text)
            )
            acknowledgement = await acknowledgements.get()
            if acknowledgement.through_sequence != sequence:
                raise ProtocolFailure("Unexpected event acknowledgement sequence")
            if scenario == "crash" and index == 1:
                os._exit(17)
            # Give the independently read control stream a chance to cancel between events.
            await asyncio.sleep(0.02)
        await send(
            outcome=wire.Outcome(
                id="final", text="".join(chunks), through_sequence=sequence
            )
        )

    async def stop_producer() -> None:
        if producer is not None:
            if not producer.done():
                producer.cancel()
            await asyncio.gather(producer, return_exceptions=True)

    async def read_control() -> None:
        nonlocal producer, prompt, received_outcome, welcomed, quiesced, closed
        async for frame in control:
            if frame.identity != identity:
                raise ProtocolFailure("Worker sent a different execution identity")
            kind = frame.WhichOneof("body")
            if kind == "welcome":
                if welcomed or frame.welcome.protocol_version != 1:
                    raise ProtocolFailure("Unexpected protocol negotiation")
                welcomed = True
            elif kind == "offer":
                if not welcomed or prompt is not None:
                    raise ProtocolFailure("Offer arrived outside negotiation")
                if frame.offer.scenario != scenario:
                    raise ProtocolFailure("Offer scenario differs from the test bootstrap")
                prompt = frame.offer.prompt
                await send(ready=wire.Ready())
            elif kind == "begin":
                if prompt is None or producer is not None:
                    raise ProtocolFailure("Begin arrived without an offer or was duplicated")
                await send(started=wire.Started())
                producer = asyncio.create_task(produce())
                producer.add_done_callback(capture_failure)
            elif kind == "receipt":
                expected = scenario != "cancel-late-outcome"
                if frame.receipt.outcome_id != "final" or frame.receipt.accepted != expected:
                    raise ProtocolFailure("Unexpected outcome receipt")
                received_outcome = True
            elif kind in ("cancel", "quiesce"):
                await stop_producer()
                if kind == "cancel" and scenario == "cancel-late-outcome":
                    await send(
                        outcome=wire.Outcome(
                            id="final", text="late outcome", through_sequence=sequence
                        )
                    )
                if not quiesced:
                    quiesced = True
                    await send(quiesced=wire.Quiesced(last_sequence=sequence))
            elif kind == "close":
                await stop_producer()
                if not quiesced or closed:
                    raise ProtocolFailure("Worker closed the execution before quiescence")
                if scenario in ("normal", "outcome-then-cancel", "cancel-late-outcome"):
                    if not received_outcome:
                        raise ProtocolFailure("Worker closed without an outcome receipt")
                await send(closed=wire.Closed())
                closed = True
                await control.done_writing()
            else:
                raise ProtocolFailure("Worker sent an unknown control operation")
        if not closed:
            raise ProtocolFailure("Control stream ended before shutdown")

    try:
        await send(
            hello=wire.Hello(
                protocol_version=99 if scenario == "bad-version" else 1,
                language="python",
            )
        )
        control_task = asyncio.create_task(read_control())
        done, _ = await asyncio.wait(
            (control_task, failure), return_when=asyncio.FIRST_COMPLETED
        )
        if failure in done:
            raise failure.result()
        await control_task
        if scenario in EXPECTED_ERRORS:
            raise ProtocolFailure("Expected protocol rejection did not occur")
    except grpc.aio.AioRpcError as error:
        if error.code() != EXPECTED_ERRORS.get(scenario):
            raise ProtocolFailure(f"Unexpected gRPC status {error.code().name}") from None
        print(f"python rejected {scenario}: {error.code().name}", flush=True)
    finally:
        await stop_producer()
        if control_task is not None:
            control_task.cancel()
            await asyncio.gather(control_task, return_exceptions=True)
        if event_reader is not None:
            event_reader.cancel()
            await asyncio.gather(event_reader, return_exceptions=True)
        failure.cancel()
        control.cancel()
        if events is not None:
            events.cancel()
        await channel.close()


async def main() -> None:
    bootstrap = json.loads(sys.stdin.readline())
    async with asyncio.timeout(10):
        await run(bootstrap)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        # Credentials and raw RPC metadata must never become test diagnostics.
        detail = str(error) if isinstance(error, ProtocolFailure) else type(error).__name__
        print(f"Python adapter failed: {detail}", file=sys.stderr)
        raise SystemExit(1) from None
