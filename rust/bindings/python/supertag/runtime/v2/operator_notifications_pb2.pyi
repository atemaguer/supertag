from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class NotificationProvider(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    NOTIFICATION_PROVIDER_UNSPECIFIED: _ClassVar[NotificationProvider]
    NOTIFICATION_PROVIDER_SLACK: _ClassVar[NotificationProvider]
    NOTIFICATION_PROVIDER_WEBHOOK: _ClassVar[NotificationProvider]
    NOTIFICATION_PROVIDER_DESKTOP: _ClassVar[NotificationProvider]

class OperatorNotificationStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OPERATOR_NOTIFICATION_STATUS_UNSPECIFIED: _ClassVar[OperatorNotificationStatus]
    OPERATOR_NOTIFICATION_STATUS_PENDING: _ClassVar[OperatorNotificationStatus]
    OPERATOR_NOTIFICATION_STATUS_DELIVERING: _ClassVar[OperatorNotificationStatus]
    OPERATOR_NOTIFICATION_STATUS_DELIVERED: _ClassVar[OperatorNotificationStatus]
    OPERATOR_NOTIFICATION_STATUS_FAILED: _ClassVar[OperatorNotificationStatus]
NOTIFICATION_PROVIDER_UNSPECIFIED: NotificationProvider
NOTIFICATION_PROVIDER_SLACK: NotificationProvider
NOTIFICATION_PROVIDER_WEBHOOK: NotificationProvider
NOTIFICATION_PROVIDER_DESKTOP: NotificationProvider
OPERATOR_NOTIFICATION_STATUS_UNSPECIFIED: OperatorNotificationStatus
OPERATOR_NOTIFICATION_STATUS_PENDING: OperatorNotificationStatus
OPERATOR_NOTIFICATION_STATUS_DELIVERING: OperatorNotificationStatus
OPERATOR_NOTIFICATION_STATUS_DELIVERED: OperatorNotificationStatus
OPERATOR_NOTIFICATION_STATUS_FAILED: OperatorNotificationStatus

class NotificationDestination(_message.Message):
    __slots__ = ("key", "provider")
    KEY_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    key: str
    provider: NotificationProvider
    def __init__(self, key: _Optional[str] = ..., provider: _Optional[_Union[NotificationProvider, str]] = ...) -> None: ...

class ClaimOperatorNotificationRequest(_message.Message):
    __slots__ = ("destinations",)
    DESTINATIONS_FIELD_NUMBER: _ClassVar[int]
    destinations: _containers.RepeatedCompositeFieldContainer[NotificationDestination]
    def __init__(self, destinations: _Optional[_Iterable[_Union[NotificationDestination, _Mapping]]] = ...) -> None: ...

class OperatorNotification(_message.Message):
    __slots__ = ("notification_id", "destination_key", "objective_id", "text", "item_keys", "kinds", "command", "status", "attempt_count", "max_attempts", "last_error", "external_message_id")
    NOTIFICATION_ID_FIELD_NUMBER: _ClassVar[int]
    DESTINATION_KEY_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    ITEM_KEYS_FIELD_NUMBER: _ClassVar[int]
    KINDS_FIELD_NUMBER: _ClassVar[int]
    COMMAND_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_COUNT_FIELD_NUMBER: _ClassVar[int]
    MAX_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    LAST_ERROR_FIELD_NUMBER: _ClassVar[int]
    EXTERNAL_MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    notification_id: str
    destination_key: str
    objective_id: str
    text: str
    item_keys: _containers.RepeatedScalarFieldContainer[str]
    kinds: _containers.RepeatedScalarFieldContainer[str]
    command: str
    status: OperatorNotificationStatus
    attempt_count: int
    max_attempts: int
    last_error: str
    external_message_id: str
    def __init__(self, notification_id: _Optional[str] = ..., destination_key: _Optional[str] = ..., objective_id: _Optional[str] = ..., text: _Optional[str] = ..., item_keys: _Optional[_Iterable[str]] = ..., kinds: _Optional[_Iterable[str]] = ..., command: _Optional[str] = ..., status: _Optional[_Union[OperatorNotificationStatus, str]] = ..., attempt_count: _Optional[int] = ..., max_attempts: _Optional[int] = ..., last_error: _Optional[str] = ..., external_message_id: _Optional[str] = ...) -> None: ...

class ClaimOperatorNotificationResponse(_message.Message):
    __slots__ = ("notification", "lease_token")
    NOTIFICATION_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    notification: OperatorNotification
    lease_token: str
    def __init__(self, notification: _Optional[_Union[OperatorNotification, _Mapping]] = ..., lease_token: _Optional[str] = ...) -> None: ...

class SettleOperatorNotificationRequest(_message.Message):
    __slots__ = ("notification_id", "lease_token", "delivered", "external_message_id", "error")
    NOTIFICATION_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    DELIVERED_FIELD_NUMBER: _ClassVar[int]
    EXTERNAL_MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    notification_id: str
    lease_token: str
    delivered: bool
    external_message_id: str
    error: str
    def __init__(self, notification_id: _Optional[str] = ..., lease_token: _Optional[str] = ..., delivered: _Optional[bool] = ..., external_message_id: _Optional[str] = ..., error: _Optional[str] = ...) -> None: ...

class SendTestNotificationRequest(_message.Message):
    __slots__ = ("objective_id",)
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    def __init__(self, objective_id: _Optional[str] = ...) -> None: ...

class TestNotificationResult(_message.Message):
    __slots__ = ("provider", "delivered", "error")
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    DELIVERED_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    provider: NotificationProvider
    delivered: bool
    error: str
    def __init__(self, provider: _Optional[_Union[NotificationProvider, str]] = ..., delivered: _Optional[bool] = ..., error: _Optional[str] = ...) -> None: ...

class SendTestNotificationResponse(_message.Message):
    __slots__ = ("results",)
    RESULTS_FIELD_NUMBER: _ClassVar[int]
    results: _containers.RepeatedCompositeFieldContainer[TestNotificationResult]
    def __init__(self, results: _Optional[_Iterable[_Union[TestNotificationResult, _Mapping]]] = ...) -> None: ...
