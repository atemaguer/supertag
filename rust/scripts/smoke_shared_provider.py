# /// script
# requires-python = ">=3.13"
# dependencies = ["grpcio==1.85.1", "grpcio-tools==1.85.1", "protobuf==7.36.2"]
# ///
"""Run the packaged fixed-root provider against synthetic loopback gRPC calls.

This proves file-only provider deployment. It does not claim command containment
or start workload processes. The schema is test equipment from the exact source.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import tempfile
import uuid

from native_archive import REPO, digest, require

PROTO = REPO / "rust/proto/supertag/environment/v2/environment.proto"


def messages(source, scratch):
    from grpc_tools import protoc
    generated = scratch / "wire"
    generated.mkdir(mode=0o700)
    require(protoc.main(["grpc_tools.protoc", f"-I{source.parent}", f"--python_out={generated}", str(source)]) == 0,
            "shared provider fixture schema could not be generated")
    spec = importlib.util.spec_from_file_location("_supertag_package_environment", generated / "environment_pb2.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def smoke_provider(binary, scratch, proto_source=PROTO):
    import grpc
    binary, proto_source = Path(binary).resolve(strict=True), Path(proto_source).resolve(strict=True)
    scratch.mkdir(mode=0o700)
    home, root, state = (scratch / name for name in ("home", "shared-root", "private-state"))
    home.mkdir(mode=0o700)
    root.mkdir(mode=0o700)
    wire = messages(proto_source, scratch)
    admin, token = (f"synthetic-package-{uuid.uuid4().hex}" for _ in range(2))
    environment = "packaged-shared-root"
    children = []

    def start():
        log = (scratch / f"provider-{len(children)}.log").open("wb")
        child = subprocess.Popen([binary, "--listen", "127.0.0.1:0", "--environment-id", environment,
                                  "--root", root, "--state-directory", state], cwd=home,
                                 env={"HOME": str(home), "PATH": os.defpath, "SUPERTAG_EXECUTION_ADMIN_TOKEN": admin},
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=log, start_new_session=True)
        log.close()
        children.append(child)
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            require(selector.select(timeout=20), "packaged shared provider startup timed out")
            endpoint = os.read(child.stdout.fileno(), 256).decode("ascii").strip()
        require(re.fullmatch(r"127\.0\.0\.1:[1-9][0-9]{0,4}", endpoint), "packaged provider did not bind literal loopback")
        channel = grpc.insecure_channel(endpoint)
        grpc.channel_ready_future(channel).result(timeout=10)
        return child, channel

    def call(channel, method, message, response, credential, extra=()):
        rpc = channel.unary_unary(f"/supertag.environment.v2.SharedExecution/{method}",
                                 request_serializer=type(message).SerializeToString,
                                 response_deserializer=response.FromString)
        return rpc(message, metadata=(("authorization", f"Bearer {credential}"), *extra), timeout=10)

    def denied(callback, codes):
        try:
            callback()
        except grpc.RpcError as error:
            require(error.code() in codes, "packaged provider returned an unexpected refusal")
        else:
            raise ValueError("packaged provider accepted a forbidden operation")

    def stop(child):
        child.send_signal(signal.SIGTERM)
        require(child.wait(timeout=15) == 0, "packaged provider did not stop cleanly")

    try:
        child, channel = start()
        with channel:
            denied(lambda: call(channel, "Describe", wire.DescribeEnvironmentRequest(), wire.EnvironmentInfo, "wrong"), {grpc.StatusCode.UNAUTHENTICATED})
            info = call(channel, "Describe", wire.DescribeEnvironmentRequest(), wire.EnvironmentInfo, admin)
            require(info.environment_id == environment and info.file_read and info.file_write and not info.lease_bound_commands,
                    "packaged provider did not expose its file-only profile")
            issue = wire.IssueAccessRequest(environment_id=environment, access_id="packaged-access", task_id="packaged-task",
                                           attempt_id="packaged-attempt", tag_id="packaged-tag", ttl_ms=60000,
                                           command_mode=wire.ACCESS_COMMAND_MODE_DISABLED)
            granted = call(channel, "IssueAccess", issue, wire.AccessReceipt, admin, (("x-supertag-grant-token", token),))
            require(granted.state == wire.ACCESS_STATE_ACTIVE, "packaged provider did not grant access")
            require(call(channel, "IssueAccess", issue, wire.AccessReceipt, admin, (("x-supertag-grant-token", token),)) == granted,
                    "packaged access replay changed its receipt")
            write = wire.ExecuteRequest(operation_id="packaged-write", write_file=wire.WriteFile(path="selected/evidence.txt", content=b"packaged evidence\n", overwrite=False))
            written = call(channel, "Execute", write, wire.OperationReceipt, token)
            require(written.state == wire.OPERATION_STATE_COMPLETED and written.file_written.bytes == 18, "packaged provider write failed")
            require(call(channel, "Execute", write, wire.OperationReceipt, token) == written, "packaged file write repeated its effect")
            changed = wire.ExecuteRequest(operation_id="packaged-write", write_file=wire.WriteFile(path="selected/evidence.txt", content=b"changed", overwrite=True))
            denied(lambda: call(channel, "Execute", changed, wire.OperationReceipt, token), {grpc.StatusCode.ALREADY_EXISTS})
            command = wire.ExecuteRequest(operation_id="forbidden-process", start_process=wire.StartProcess(command="/bin/true"))
            denied(lambda: call(channel, "Execute", command, wire.OperationReceipt, token), {grpc.StatusCode.PERMISSION_DENIED})
            released = call(channel, "ReleaseAccess", wire.EndAccessRequest(access_id="packaged-access"), wire.AccessReceipt, token)
            require(released.state == wire.ACCESS_STATE_RELEASED and released.cleanup_verified, "packaged provider did not settle access cleanup")
            denied(lambda: call(channel, "Execute", wire.ExecuteRequest(operation_id="stale-read", read_file=wire.ReadFile(path="selected/evidence.txt", maximum_bytes=100)), wire.OperationReceipt, token), {grpc.StatusCode.UNAUTHENTICATED})
        stop(child)
        child, channel = start()
        with channel:
            replay = call(channel, "IssueAccess", issue, wire.AccessReceipt, admin, (("x-supertag-grant-token", token),))
            require(replay == released, "packaged provider lost its settled access receipt on restart")
            next_token = f"synthetic-next-{uuid.uuid4().hex}"
            issue.access_id, issue.task_id, issue.attempt_id = "next-access", "next-task", "next-attempt"
            call(channel, "IssueAccess", issue, wire.AccessReceipt, admin, (("x-supertag-grant-token", next_token),))
            read = call(channel, "Execute", wire.ExecuteRequest(operation_id="restored-read", read_file=wire.ReadFile(path="selected/evidence.txt", maximum_bytes=100)), wire.OperationReceipt, next_token)
            require(read.state == wire.OPERATION_STATE_COMPLETED and read.file_content.content == b"packaged evidence\n", "packaged provider lost its fixed-root files")
            settled = call(channel, "RevokeAccess", wire.EndAccessRequest(access_id="next-access"), wire.AccessReceipt, admin)
            require(settled.state == wire.ACCESS_STATE_REVOKED and settled.cleanup_verified, "packaged provider revoke did not settle")
            denied(lambda: call(channel, "Execute", wire.ExecuteRequest(operation_id="revoked-read", read_file=wire.ReadFile(path="selected/evidence.txt", maximum_bytes=100)), wire.OperationReceipt, next_token), {grpc.StatusCode.UNAUTHENTICATED})
        stop(child)
        return {"binary_sha256": digest(binary), "schema_sha256": digest(proto_source), "file_round_trip": True,
                "exact_replay": True, "restart_receipts": True, "revoked_access_refused": True,
                "commands_enabled": False, "clean_shutdown": True, "real_provider_calls": False}
    finally:
        for child in children:
            if child.poll() is None:
                child.send_signal(signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
            if child.stdout:
                child.stdout.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--proto", type=Path, default=PROTO)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="supertag-packaged-provider-") as temporary:
        print(json.dumps(smoke_provider(args.binary, Path(temporary).resolve() / "fixture", args.proto), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
