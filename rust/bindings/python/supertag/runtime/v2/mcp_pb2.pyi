from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class HarnessMcpApprovalState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    HARNESS_MCP_APPROVAL_STATE_UNSPECIFIED: _ClassVar[HarnessMcpApprovalState]
    HARNESS_MCP_APPROVAL_STATE_PENDING: _ClassVar[HarnessMcpApprovalState]
    HARNESS_MCP_APPROVAL_STATE_DENIED: _ClassVar[HarnessMcpApprovalState]
    HARNESS_MCP_APPROVAL_STATE_GRANTED: _ClassVar[HarnessMcpApprovalState]
HARNESS_MCP_APPROVAL_STATE_UNSPECIFIED: HarnessMcpApprovalState
HARNESS_MCP_APPROVAL_STATE_PENDING: HarnessMcpApprovalState
HARNESS_MCP_APPROVAL_STATE_DENIED: HarnessMcpApprovalState
HARNESS_MCP_APPROVAL_STATE_GRANTED: HarnessMcpApprovalState

class McpServerCapability(_message.Message):
    __slots__ = ("name", "mapped_tools", "provider_binding", "resource_bindings")
    NAME_FIELD_NUMBER: _ClassVar[int]
    MAPPED_TOOLS_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_BINDING_FIELD_NUMBER: _ClassVar[int]
    RESOURCE_BINDINGS_FIELD_NUMBER: _ClassVar[int]
    name: str
    mapped_tools: _containers.RepeatedScalarFieldContainer[str]
    provider_binding: str
    resource_bindings: _containers.RepeatedCompositeFieldContainer[McpResourceBinding]
    def __init__(self, name: _Optional[str] = ..., mapped_tools: _Optional[_Iterable[str]] = ..., provider_binding: _Optional[str] = ..., resource_bindings: _Optional[_Iterable[_Union[McpResourceBinding, _Mapping]]] = ...) -> None: ...

class McpResourceBinding(_message.Message):
    __slots__ = ("tool", "rules")
    TOOL_FIELD_NUMBER: _ClassVar[int]
    RULES_FIELD_NUMBER: _ClassVar[int]
    tool: str
    rules: _containers.RepeatedCompositeFieldContainer[McpResourceRule]
    def __init__(self, tool: _Optional[str] = ..., rules: _Optional[_Iterable[_Union[McpResourceRule, _Mapping]]] = ...) -> None: ...

class McpResourceRule(_message.Message):
    __slots__ = ("prefix", "separator", "components", "when")
    PREFIX_FIELD_NUMBER: _ClassVar[int]
    SEPARATOR_FIELD_NUMBER: _ClassVar[int]
    COMPONENTS_FIELD_NUMBER: _ClassVar[int]
    WHEN_FIELD_NUMBER: _ClassVar[int]
    prefix: str
    separator: str
    components: _containers.RepeatedCompositeFieldContainer[McpResourceComponent]
    when: McpResourceCondition
    def __init__(self, prefix: _Optional[str] = ..., separator: _Optional[str] = ..., components: _Optional[_Iterable[_Union[McpResourceComponent, _Mapping]]] = ..., when: _Optional[_Union[McpResourceCondition, _Mapping]] = ...) -> None: ...

class McpResourceComponent(_message.Message):
    __slots__ = ("arguments",)
    ARGUMENTS_FIELD_NUMBER: _ClassVar[int]
    arguments: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, arguments: _Optional[_Iterable[str]] = ...) -> None: ...

class McpResourceCondition(_message.Message):
    __slots__ = ("argument", "equals")
    ARGUMENT_FIELD_NUMBER: _ClassVar[int]
    EQUALS_FIELD_NUMBER: _ClassVar[int]
    argument: str
    equals: str
    def __init__(self, argument: _Optional[str] = ..., equals: _Optional[str] = ...) -> None: ...

class HarnessMcpTool(_message.Message):
    __slots__ = ("server", "name", "description", "input_schema_json")
    SERVER_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    INPUT_SCHEMA_JSON_FIELD_NUMBER: _ClassVar[int]
    server: str
    name: str
    description: str
    input_schema_json: str
    def __init__(self, server: _Optional[str] = ..., name: _Optional[str] = ..., description: _Optional[str] = ..., input_schema_json: _Optional[str] = ...) -> None: ...

class ListHarnessMcpToolsRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ListHarnessMcpToolsResponse(_message.Message):
    __slots__ = ("tools",)
    TOOLS_FIELD_NUMBER: _ClassVar[int]
    tools: _containers.RepeatedCompositeFieldContainer[HarnessMcpTool]
    def __init__(self, tools: _Optional[_Iterable[_Union[HarnessMcpTool, _Mapping]]] = ...) -> None: ...

class CallHarnessMcpToolRequest(_message.Message):
    __slots__ = ("server", "tool", "arguments_json", "operation_id")
    SERVER_FIELD_NUMBER: _ClassVar[int]
    TOOL_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_JSON_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    server: str
    tool: str
    arguments_json: str
    operation_id: str
    def __init__(self, server: _Optional[str] = ..., tool: _Optional[str] = ..., arguments_json: _Optional[str] = ..., operation_id: _Optional[str] = ...) -> None: ...

class CallHarnessMcpToolResponse(_message.Message):
    __slots__ = ("result_json", "approval_id", "approval_state")
    RESULT_JSON_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_ID_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_STATE_FIELD_NUMBER: _ClassVar[int]
    result_json: str
    approval_id: str
    approval_state: HarnessMcpApprovalState
    def __init__(self, result_json: _Optional[str] = ..., approval_id: _Optional[str] = ..., approval_state: _Optional[_Union[HarnessMcpApprovalState, str]] = ...) -> None: ...
