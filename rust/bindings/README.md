# Rust runtime protobuf bindings

These generated bindings describe `supertag.runtime.v2`. The Go module exposes protobuf messages
and Connect clients. Pass `connect.WithGRPC()` when constructing a client for the Rust Gateway.

The Gateway and Control Plane refuse every call that does not name a negotiated protocol version.
A client first calls `ProtocolNegotiation.Negotiate` with its role (`SERVICE_ROLE_OPERATOR` for an
operator application) and the versions it speaks, then sends the selected version in the
`x-supertag-protocol` metadata header on every other call. Only negotiation and the standard gRPC
health service are exempt.
TypeScript exports protobuf-es messages and service descriptors. Python exposes protobuf messages
and native gRPC stubs.

Install the repository's locked Node dependencies, Go toolchain, and `uv`, then run these commands
from the repository root.

```sh
uv run --python 3.13 --script rust/scripts/generate-bindings.py
uv run --python 3.13 --script rust/scripts/generate-bindings.py --check
uv run --python 3.13 --script rust/bindings/wire-roundtrip.py
go -C rust/bindings/go test ./...
```

Generation uses the repository's Buf and Go plugin versions and pins the Python generators in the
script. The check regenerates all three languages into a temporary directory and compares the
generated files. The round trip exercises a Task with optional fields, Unicode, repeated values,
and a revision above JavaScript's safe integer range.
