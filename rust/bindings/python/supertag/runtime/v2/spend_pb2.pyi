from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class SpendGrouping(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SPEND_GROUPING_UNSPECIFIED: _ClassVar[SpendGrouping]
    SPEND_GROUPING_OBJECTIVE: _ClassVar[SpendGrouping]
    SPEND_GROUPING_TAG: _ClassVar[SpendGrouping]
    SPEND_GROUPING_DAY: _ClassVar[SpendGrouping]
SPEND_GROUPING_UNSPECIFIED: SpendGrouping
SPEND_GROUPING_OBJECTIVE: SpendGrouping
SPEND_GROUPING_TAG: SpendGrouping
SPEND_GROUPING_DAY: SpendGrouping

class GetSpendRequest(_message.Message):
    __slots__ = ("by", "since_ms")
    BY_FIELD_NUMBER: _ClassVar[int]
    SINCE_MS_FIELD_NUMBER: _ClassVar[int]
    by: SpendGrouping
    since_ms: int
    def __init__(self, by: _Optional[_Union[SpendGrouping, str]] = ..., since_ms: _Optional[int] = ...) -> None: ...

class SpendAmount(_message.Message):
    __slots__ = ("currency", "amount_minor")
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    AMOUNT_MINOR_FIELD_NUMBER: _ClassVar[int]
    currency: str
    amount_minor: int
    def __init__(self, currency: _Optional[str] = ..., amount_minor: _Optional[int] = ...) -> None: ...

class SpendUnpricedModel(_message.Message):
    __slots__ = ("model", "attempts")
    MODEL_FIELD_NUMBER: _ClassVar[int]
    ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    model: str
    attempts: int
    def __init__(self, model: _Optional[str] = ..., attempts: _Optional[int] = ...) -> None: ...

class SpendBudget(_message.Message):
    __slots__ = ("limit_minor", "currency")
    LIMIT_MINOR_FIELD_NUMBER: _ClassVar[int]
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    limit_minor: int
    currency: str
    def __init__(self, limit_minor: _Optional[int] = ..., currency: _Optional[str] = ...) -> None: ...

class SpendGroup(_message.Message):
    __slots__ = ("key", "name", "attempts", "reported_cost", "unknown_cost_attempts", "estimated_cost_attempts", "unpriced_models", "unpriced_tokens", "reported_tokens", "unknown_token_attempts", "budget")
    KEY_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    REPORTED_COST_FIELD_NUMBER: _ClassVar[int]
    UNKNOWN_COST_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    ESTIMATED_COST_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    UNPRICED_MODELS_FIELD_NUMBER: _ClassVar[int]
    UNPRICED_TOKENS_FIELD_NUMBER: _ClassVar[int]
    REPORTED_TOKENS_FIELD_NUMBER: _ClassVar[int]
    UNKNOWN_TOKEN_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    BUDGET_FIELD_NUMBER: _ClassVar[int]
    key: str
    name: str
    attempts: int
    reported_cost: _containers.RepeatedCompositeFieldContainer[SpendAmount]
    unknown_cost_attempts: int
    estimated_cost_attempts: int
    unpriced_models: _containers.RepeatedCompositeFieldContainer[SpendUnpricedModel]
    unpriced_tokens: int
    reported_tokens: int
    unknown_token_attempts: int
    budget: SpendBudget
    def __init__(self, key: _Optional[str] = ..., name: _Optional[str] = ..., attempts: _Optional[int] = ..., reported_cost: _Optional[_Iterable[_Union[SpendAmount, _Mapping]]] = ..., unknown_cost_attempts: _Optional[int] = ..., estimated_cost_attempts: _Optional[int] = ..., unpriced_models: _Optional[_Iterable[_Union[SpendUnpricedModel, _Mapping]]] = ..., unpriced_tokens: _Optional[int] = ..., reported_tokens: _Optional[int] = ..., unknown_token_attempts: _Optional[int] = ..., budget: _Optional[_Union[SpendBudget, _Mapping]] = ...) -> None: ...

class SpendReport(_message.Message):
    __slots__ = ("by", "since_ms", "groups")
    BY_FIELD_NUMBER: _ClassVar[int]
    SINCE_MS_FIELD_NUMBER: _ClassVar[int]
    GROUPS_FIELD_NUMBER: _ClassVar[int]
    by: SpendGrouping
    since_ms: int
    groups: _containers.RepeatedCompositeFieldContainer[SpendGroup]
    def __init__(self, by: _Optional[_Union[SpendGrouping, str]] = ..., since_ms: _Optional[int] = ..., groups: _Optional[_Iterable[_Union[SpendGroup, _Mapping]]] = ...) -> None: ...
