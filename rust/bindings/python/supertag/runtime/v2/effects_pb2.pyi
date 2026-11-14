from supertag.runtime.v2 import runtime_pb2 as _runtime_pb2
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class EffectReceiptState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    EFFECT_RECEIPT_STATE_UNSPECIFIED: _ClassVar[EffectReceiptState]
    EFFECT_RECEIPT_STATE_ACQUIRED: _ClassVar[EffectReceiptState]
    EFFECT_RECEIPT_STATE_COMPLETED: _ClassVar[EffectReceiptState]
    EFFECT_RECEIPT_STATE_IN_DOUBT: _ClassVar[EffectReceiptState]
    EFFECT_RECEIPT_STATE_FAILED: _ClassVar[EffectReceiptState]
    EFFECT_RECEIPT_STATE_IN_FLIGHT: _ClassVar[EffectReceiptState]
EFFECT_RECEIPT_STATE_UNSPECIFIED: EffectReceiptState
EFFECT_RECEIPT_STATE_ACQUIRED: EffectReceiptState
EFFECT_RECEIPT_STATE_COMPLETED: EffectReceiptState
EFFECT_RECEIPT_STATE_IN_DOUBT: EffectReceiptState
EFFECT_RECEIPT_STATE_FAILED: EffectReceiptState
EFFECT_RECEIPT_STATE_IN_FLIGHT: EffectReceiptState

class EffectReceipt(_message.Message):
    __slots__ = ("idempotency_key", "fingerprint", "state", "operation", "result_json", "error", "task_id", "attempt_id", "started_at_ms", "settled_at_ms", "replayed")
    IDEMPOTENCY_KEY_FIELD_NUMBER: _ClassVar[int]
    FINGERPRINT_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    OPERATION_FIELD_NUMBER: _ClassVar[int]
    RESULT_JSON_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    SETTLED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    REPLAYED_FIELD_NUMBER: _ClassVar[int]
    idempotency_key: str
    fingerprint: str
    state: EffectReceiptState
    operation: str
    result_json: str
    error: str
    task_id: str
    attempt_id: str
    started_at_ms: int
    settled_at_ms: int
    replayed: bool
    def __init__(self, idempotency_key: _Optional[str] = ..., fingerprint: _Optional[str] = ..., state: _Optional[_Union[EffectReceiptState, str]] = ..., operation: _Optional[str] = ..., result_json: _Optional[str] = ..., error: _Optional[str] = ..., task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., started_at_ms: _Optional[int] = ..., settled_at_ms: _Optional[int] = ..., replayed: _Optional[bool] = ...) -> None: ...

class HarnessBeginEffectRequest(_message.Message):
    __slots__ = ("idempotency_key", "operation", "arguments_json")
    IDEMPOTENCY_KEY_FIELD_NUMBER: _ClassVar[int]
    OPERATION_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_JSON_FIELD_NUMBER: _ClassVar[int]
    idempotency_key: str
    operation: str
    arguments_json: str
    def __init__(self, idempotency_key: _Optional[str] = ..., operation: _Optional[str] = ..., arguments_json: _Optional[str] = ...) -> None: ...

class HarnessCompleteEffectRequest(_message.Message):
    __slots__ = ("idempotency_key", "operation", "arguments_json", "result_json")
    IDEMPOTENCY_KEY_FIELD_NUMBER: _ClassVar[int]
    OPERATION_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_JSON_FIELD_NUMBER: _ClassVar[int]
    RESULT_JSON_FIELD_NUMBER: _ClassVar[int]
    idempotency_key: str
    operation: str
    arguments_json: str
    result_json: str
    def __init__(self, idempotency_key: _Optional[str] = ..., operation: _Optional[str] = ..., arguments_json: _Optional[str] = ..., result_json: _Optional[str] = ...) -> None: ...

class HarnessFailEffectRequest(_message.Message):
    __slots__ = ("idempotency_key", "operation", "arguments_json", "error")
    IDEMPOTENCY_KEY_FIELD_NUMBER: _ClassVar[int]
    OPERATION_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_JSON_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    idempotency_key: str
    operation: str
    arguments_json: str
    error: str
    def __init__(self, idempotency_key: _Optional[str] = ..., operation: _Optional[str] = ..., arguments_json: _Optional[str] = ..., error: _Optional[str] = ...) -> None: ...

class BeginEffectRequest(_message.Message):
    __slots__ = ("attempt", "effect")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    EFFECT_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    effect: HarnessBeginEffectRequest
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., effect: _Optional[_Union[HarnessBeginEffectRequest, _Mapping]] = ...) -> None: ...

class CompleteEffectRequest(_message.Message):
    __slots__ = ("attempt", "effect")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    EFFECT_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    effect: HarnessCompleteEffectRequest
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., effect: _Optional[_Union[HarnessCompleteEffectRequest, _Mapping]] = ...) -> None: ...

class FailEffectRequest(_message.Message):
    __slots__ = ("attempt", "effect")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    EFFECT_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    effect: HarnessFailEffectRequest
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., effect: _Optional[_Union[HarnessFailEffectRequest, _Mapping]] = ...) -> None: ...
