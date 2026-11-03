"""Independent Python gRPC wire checks. Credentials enter only through environment."""

import os
from pathlib import Path
import uuid

import grpc
from supertag.environment.v1 import environment_pb2 as pb
from supertag.environment.v1 import environment_pb2_grpc as rpc


def expect_error(code, action):
    try:
        action()
    except grpc.RpcError as error:
        assert error.code() == code, (error.code(), error.details())
    else:
        raise AssertionError(f"Expected {code}")


def main():
    channel = grpc.secure_channel(
        os.environ["SUPERTAG_CONFORMANCE_ENDPOINT"],
        grpc.ssl_channel_credentials(Path(os.environ["SUPERTAG_CONFORMANCE_CA"]).read_bytes()),
    )
    grpc.channel_ready_future(channel).result(timeout=10)
    stub = rpc.ExecutionEnvironmentServiceStub(channel)
    admin = (("authorization", "Bearer " + os.environ["SUPERTAG_CONFORMANCE_ADMIN"]),)
    token = "python-" + str(uuid.uuid4())
    auth = (("authorization", "Bearer " + token),)
    grant_metadata = admin + (("x-supertag-grant-token", token),)
    access = pb.IssueAccessRequest(protocol_version=1, access_id="python", task_id="task", attempt_id="attempt", tag_id="tag", ttl_ms=60000)
    grant = stub.IssueAccess(access, metadata=grant_metadata, timeout=5)
    assert grant.protocol_version == 1 and grant.incarnation_id and grant.access_id == "python"
    assert stub.IssueAccess(access, metadata=grant_metadata, timeout=5) == grant
    invalid_version = pb.IssueAccessRequest()
    invalid_version.CopyFrom(access)
    invalid_version.protocol_version = 2
    expect_error(grpc.StatusCode.FAILED_PRECONDITION, lambda: stub.IssueAccess(invalid_version, metadata=grant_metadata, timeout=5))
    invalid_integer = pb.IssueAccessRequest()
    invalid_integer.CopyFrom(access)
    invalid_integer.ttl_ms = 2**53
    expect_error(grpc.StatusCode.OUT_OF_RANGE, lambda: stub.IssueAccess(invalid_integer, metadata=grant_metadata, timeout=5))
    expect_error(grpc.StatusCode.UNAUTHENTICATED, lambda: stub.InspectOperation(pb.InspectOperationRequest(operation_id="write"), timeout=5))

    def execute(request, metadata=auth):
        return stub.Execute(request, metadata=metadata, timeout=5)

    payload = bytes(range(256)) + "😀 café".encode()
    write = pb.ExecuteRequest(operation_id="write", write_file=pb.WriteFile(path="binary.bin", content=payload, exclusive=False, mode=0))
    assert write.write_file.HasField("exclusive") and write.write_file.HasField("mode")
    receipt = execute(write)
    assert receipt.status == pb.OPERATION_STATUS_COMPLETED
    assert receipt.WhichOneof("result") == "file_written"
    assert receipt.file_written.bytes == len(payload)
    assert execute(write) == receipt
    absent = pb.ExecuteRequest(operation_id="write", write_file=pb.WriteFile(path="binary.bin", content=payload))
    assert not absent.write_file.HasField("exclusive") and not absent.write_file.HasField("mode")
    expect_error(grpc.StatusCode.FAILED_PRECONDITION, lambda: execute(absent))
    # The test runner verifies mode=0 on disk; restore it through a second write.
    execute(pb.ExecuteRequest(operation_id="readable", write_file=pb.WriteFile(path="binary-readable.bin", content=payload, mode=0o600)))
    read = execute(pb.ExecuteRequest(operation_id="read", read_file=pb.ReadFile(path="binary-readable.bin", maximum_bytes=4096)))
    assert read.file_content.content == payload
    expect_error(grpc.StatusCode.INVALID_ARGUMENT, lambda: execute(pb.ExecuteRequest(operation_id="missing-oneof")))
    expect_error(grpc.StatusCode.OUT_OF_RANGE, lambda: execute(pb.ExecuteRequest(operation_id="huge-read", read_file=pb.ReadFile(path="binary.bin", maximum_bytes=2**53))))

    outsider_token = "python-outsider-" + str(uuid.uuid4())
    outsider = (("authorization", "Bearer " + outsider_token),)
    stub.IssueAccess(pb.IssueAccessRequest(protocol_version=1, access_id="outsider", task_id="other", attempt_id="other", tag_id="tag", ttl_ms=60000), metadata=admin + (("x-supertag-grant-token", outsider_token),), timeout=5)
    expect_error(grpc.StatusCode.PERMISSION_DENIED, lambda: stub.InspectOperation(pb.InspectOperationRequest(operation_id="write"), metadata=outsider, timeout=5))

    code = "require('fs').appendFileSync('effect.txt','x');let n=0;const t=setInterval(()=>{console.log(++n);if(n===12)clearInterval(t)},50)"
    process = pb.ExecuteRequest(operation_id="process", start_process=pb.StartProcess(command=os.environ["SUPERTAG_CONFORMANCE_NODE"], args=["-e", code]))
    started = execute(process)
    assert started.HasField("process_id") and started.process_id
    assert execute(process).process_id == started.process_id
    expect_error(grpc.StatusCode.PERMISSION_DENIED, lambda: list(stub.WatchProcess(pb.WatchProcessRequest(process_id=started.process_id), metadata=outsider, timeout=5)))
    chunks = []
    cursor = 0
    stream = stub.WatchProcess(pb.WatchProcessRequest(process_id=started.process_id), metadata=auth, timeout=5)
    for snapshot in stream:
        chunks.extend(snapshot.chunks)
        cursor = snapshot.next_cursor
        if chunks:
            break
    assert stream.cancel()
    # A completely new TLS connection resumes from the acknowledged cursor.
    channel.close()
    channel = grpc.secure_channel(os.environ["SUPERTAG_CONFORMANCE_ENDPOINT"], grpc.ssl_channel_credentials(Path(os.environ["SUPERTAG_CONFORMANCE_CA"]).read_bytes()))
    stub = rpc.ExecutionEnvironmentServiceStub(channel)
    for snapshot in stub.WatchProcess(pb.WatchProcessRequest(process_id=started.process_id, after_sequence=cursor), metadata=auth, timeout=5):
        chunks.extend(snapshot.chunks)
        cursor = snapshot.next_cursor
    assert snapshot.status == pb.OPERATION_STATUS_COMPLETED
    assert snapshot.result.HasField("exit_code") and snapshot.result.exit_code == 0
    assert [chunk.sequence for chunk in chunks] == list(range(1, len(chunks) + 1))
    assert all(chunk.stream == pb.OUTPUT_STREAM_STDOUT for chunk in chunks)
    assert "".join(chunk.text for chunk in chunks) == "".join(f"{n}\n" for n in range(1, 13))
    expect_error(grpc.StatusCode.FAILED_PRECONDITION, lambda: list(stub.WatchProcess(pb.WatchProcessRequest(process_id=started.process_id, after_sequence=cursor + 1), metadata=auth, timeout=5)))
    observed = stub.InspectOperation(pb.InspectOperationRequest(operation_id="process"), metadata=auth, timeout=5)
    assert observed.process_result.exit_code == 0
    effect = execute(pb.ExecuteRequest(operation_id="effect", read_file=pb.ReadFile(path="effect.txt", maximum_bytes=100)))
    assert effect.file_content.content == b"x"
    stub.ReleaseAccess(pb.ReleaseAccessRequest(access_id="python"), metadata=auth, timeout=5)
    expect_error(grpc.StatusCode.UNAUTHENTICATED, lambda: stub.InspectOperation(pb.InspectOperationRequest(operation_id="write"), metadata=auth, timeout=5))
    stub.RevokeAccess(pb.RevokeAccessRequest(access_id="outsider"), metadata=admin, timeout=5)
    channel.close()
    print("Python gRPC conformance passed: TLS, grants, versions, bytes, optional presence, integer bounds, receipts, ownership, reconnect, release.")


if __name__ == "__main__":
    main()
