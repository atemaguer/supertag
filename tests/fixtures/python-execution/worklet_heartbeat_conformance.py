"""Independent Python round trip for the protocol 18 changed-path heartbeat field."""

from supertag.worklet.v1 import worklet_pb2 as pb


frame = pb.ConnectRequest(
    heartbeat=pb.Heartbeat(
        at="2026-10-07T00:00:00Z",
        changed_paths=[
            pb.AttemptChangedPaths(
                attempt_id="attempt-1", paths=["src/old.ts", "src/new.ts"], truncated=True
            )
        ],
    )
)
decoded = pb.ConnectRequest.FromString(frame.SerializeToString())
assert decoded.WhichOneof("frame") == "heartbeat"
assert decoded.heartbeat.changed_paths[0].attempt_id == "attempt-1"
assert list(decoded.heartbeat.changed_paths[0].paths) == ["src/old.ts", "src/new.ts"]
assert decoded.heartbeat.changed_paths[0].truncated
print("Python worklet heartbeat changed paths conformance passed")
