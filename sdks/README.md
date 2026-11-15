# SDKs and generated bindings

Each directory holds one language: its hand-written SDK, when there is one, and the bindings
generated from the `supertag.runtime.v2` protos in [`proto/`](../proto).

| Directory | SDK | Generated bindings |
| --- | --- | --- |
| [`typescript/`](typescript/README.md) | `supertag-ai` on npm (`src/`) | `gen/supertag/runtime/v2` (protobuf-es messages and service descriptors) |
| [`python/`](python/README.md) | `supertag` on PyPI (`src/supertag`) | `gen/supertag/runtime/v2` (messages and gRPC stubs); the package ships its own copy as `supertag._runtime_v2` |
| `go/` | None yet | The Go module `github.com/atemaguer/supertag/sdks/go`: messages in `runtimev2` and Connect clients in `runtimev2/runtimev2connect` |

The Go module's Connect clients need `connect.WithGRPC()` to talk to the Control Plane.

The Gateway and Control Plane refuse every call that does not name a negotiated protocol version.
A client first calls `ProtocolNegotiation.Negotiate` with its role (`SERVICE_ROLE_OPERATOR` for an
operator application) and the versions it speaks, then sends the selected version in the
`x-supertag-protocol` metadata header on every other call. Only negotiation and the standard gRPC
health service are exempt.

## Regenerate and check

Install the repository's locked Node dependencies, Go toolchain, and `uv`, then run these commands
from the repository root.

```sh
uv run --python 3.13 --script scripts/generate-bindings.py
uv run --python 3.13 --script scripts/generate-bindings.py --check
uv run --python 3.13 --script scripts/wire-roundtrip.py
go -C sdks/go test ./...
```

Generation uses the repository's Buf version, the Go plugins pinned as tools in `sdks/go/go.mod`,
and the Python generators pinned in the script. It also writes the copies that ship inside
packages: `sdks/python/src/supertag/_runtime_v2` and the Worker SDK's
`harnesses/sdk/src/rust-harness/gen`, which `supertag-ai` bundles. The check regenerates every
language into a temporary directory and compares the generated files. The round trip passes a Task
with optional fields, Unicode, repeated values, and a revision above JavaScript's safe integer
range from Python to Go to TypeScript and back.
