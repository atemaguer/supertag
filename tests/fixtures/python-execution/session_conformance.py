"""Independent wire consumer; database/authorization-owner tests run separately."""
import hashlib
import json
import os
import grpc
from supertag.session.v1 import session_pb2 as pb, session_pb2_grpc as rpc

channel = grpc.insecure_channel(os.environ["SUPERTAG_SESSION_CONFORMANCE_ADDRESS"])
client = rpc.SessionServiceStub(channel)
metadata = (("authorization", "Bearer " + os.environ["SUPERTAG_SESSION_CONFORMANCE_TOKEN"]),)
archive = json.dumps({"nativeId": "conversation", "transcript": "😀 café" * 70000}, ensure_ascii=False, separators=(",", ":")).encode()
ref = pb.SessionRef(id="native", uri="supertag:session:native", format="codex.native.v1")
header = pb.SaveHeader(ref=ref, harness_id="codex", write_version=1, archive_size=len(archive), archive_sha256=hashlib.sha256(archive).hexdigest())
def frames():
    yield pb.SaveRequest(header=header)
    for offset in range(0, len(archive), 65536):
        yield pb.SaveRequest(chunk=archive[offset:offset+65536])
assert client.Save(frames(), metadata=metadata, timeout=10).write_version == 1
result = list(client.Load(pb.LoadRequest(ref=ref), metadata=metadata, timeout=10))
assert result[0].header.ref == ref
assert result[0].header.harness_id == "codex"
received = b"".join(frame.chunk for frame in result[1:])
assert received == archive
assert hashlib.sha256(received).hexdigest() == result[0].header.archive_sha256
missing = list(client.Load(pb.LoadRequest(ref=pb.SessionRef(id="missing", uri="supertag:missing", format="codex.native.v1")), metadata=metadata, timeout=10))
assert len(missing) == 1 and missing[0].not_found
try:
    list(client.Load(pb.LoadRequest(ref=ref), timeout=10))
    raise AssertionError("Missing credentials accepted")
except grpc.RpcError as error:
    assert error.code() == grpc.StatusCode.UNAUTHENTICATED
channel.close()
print("Independent Python Session streaming conformance passed")
