from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class McpServerCapability(_message.Message):
    __slots__ = ("name", "mapped_tools")
    NAME_FIELD_NUMBER: _ClassVar[int]
    MAPPED_TOOLS_FIELD_NUMBER: _ClassVar[int]
    name: str
    mapped_tools: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, name: _Optional[str] = ..., mapped_tools: _Optional[_Iterable[str]] = ...) -> None: ...

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
    __slots__ = ("server", "tool", "arguments_json")
    SERVER_FIELD_NUMBER: _ClassVar[int]
    TOOL_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_JSON_FIELD_NUMBER: _ClassVar[int]
    server: str
    tool: str
    arguments_json: str
    def __init__(self, server: _Optional[str] = ..., tool: _Optional[str] = ..., arguments_json: _Optional[str] = ...) -> None: ...

class CallHarnessMcpToolResponse(_message.Message):
    __slots__ = ("result_json",)
    RESULT_JSON_FIELD_NUMBER: _ClassVar[int]
    result_json: str
    def __init__(self, result_json: _Optional[str] = ...) -> None: ...
