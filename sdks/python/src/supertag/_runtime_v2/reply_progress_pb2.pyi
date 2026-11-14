from . import runtime_pb2 as _runtime_pb2
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ReplyProgressUpdate(_message.Message):
    __slots__ = ("task_id", "account_id", "destination", "text", "revision", "provider_receipt")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    DESTINATION_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_RECEIPT_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    account_id: str
    destination: _runtime_pb2.ReplyDestination
    text: str
    revision: int
    provider_receipt: str
    def __init__(self, task_id: _Optional[str] = ..., account_id: _Optional[str] = ..., destination: _Optional[_Union[_runtime_pb2.ReplyDestination, _Mapping]] = ..., text: _Optional[str] = ..., revision: _Optional[int] = ..., provider_receipt: _Optional[str] = ...) -> None: ...

class ClaimReplyProgressRequest(_message.Message):
    __slots__ = ("operation_id",)
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    def __init__(self, operation_id: _Optional[str] = ...) -> None: ...

class ClaimReplyProgressResponse(_message.Message):
    __slots__ = ("update", "lease_token")
    UPDATE_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    update: ReplyProgressUpdate
    lease_token: str
    def __init__(self, update: _Optional[_Union[ReplyProgressUpdate, _Mapping]] = ..., lease_token: _Optional[str] = ...) -> None: ...

class SettleReplyProgressRequest(_message.Message):
    __slots__ = ("task_id", "lease_token", "state", "provider_receipt")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_RECEIPT_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    lease_token: str
    state: _runtime_pb2.ReplyState
    provider_receipt: str
    def __init__(self, task_id: _Optional[str] = ..., lease_token: _Optional[str] = ..., state: _Optional[_Union[_runtime_pb2.ReplyState, str]] = ..., provider_receipt: _Optional[str] = ...) -> None: ...
