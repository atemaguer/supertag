from supertag.runtime.v2 import runtime_pb2 as _runtime_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ReportChangedPathsRequest(_message.Message):
    __slots__ = ("attempt", "paths", "truncated")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    PATHS_FIELD_NUMBER: _ClassVar[int]
    TRUNCATED_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    paths: _containers.RepeatedScalarFieldContainer[str]
    truncated: bool
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., paths: _Optional[_Iterable[str]] = ..., truncated: _Optional[bool] = ...) -> None: ...

class ReportChangedPathsResponse(_message.Message):
    __slots__ = ("overlapping_attempt_ids", "compared")
    OVERLAPPING_ATTEMPT_IDS_FIELD_NUMBER: _ClassVar[int]
    COMPARED_FIELD_NUMBER: _ClassVar[int]
    overlapping_attempt_ids: _containers.RepeatedScalarFieldContainer[str]
    compared: bool
    def __init__(self, overlapping_attempt_ids: _Optional[_Iterable[str]] = ..., compared: _Optional[bool] = ...) -> None: ...
