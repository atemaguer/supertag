# Contributing to SuperTag

Thank you for helping build SuperTag. The project is early, so clear problems,
small changes, and honest test results are especially valuable. Everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- Report a reproducible bug or confusing behavior in a GitHub issue.
- Improve documentation, examples, tests, or Surface support.
- Propose a focused improvement to a public contract before building it.

Search existing issues and pull requests first. For a substantial change, open
an issue before writing code so the direction can be discussed early.

## Security

Do not report vulnerabilities in a public issue. Follow the private reporting
process in [SECURITY.md](SECURITY.md). Never commit credentials, tokens, tenant
data, or local state.

## Development setup

SuperTag's services and CLI are written in Rust (`rust/`). The Node.js harness bridges and
Workspace providers that Worker Hosts start, the desktop app's frontend, and the repository checks
are TypeScript; the terminal UI is Go. Install the tools listed in
[Requirements](docs/operations/requirements.md), the Rust toolchain pinned by
`rust/rust-toolchain.toml`, Go 1.26 or later, and the pnpm version pinned by `packageManager` in the
root `package.json`:

```sh
git clone https://github.com/atemaguer/supertag.git
cd supertag
npm install -g pnpm@11.18.0
pnpm install
```

`pnpm build` compiles the TypeScript packages. Rust Worker Hosts start the built bridges from
`packages/runtime/harnesses/*/dist` and `packages/runtime/environments/*/dist`.

## Write documentation

Public documentation uses progressive disclosure. Start with a plain definition, a familiar
example, and when the concept is useful. Show commands after the reader understands the concept.
Keep protocol, schema, and internal recovery details in the reference pages.

Use common words in introductory pages. Define SuperTag's capitalized terms when they first appear,
and link to the [glossary](docs/reference/glossary.md) when several terms are needed at once. Keep
exact implementation language where it matters in technical reference.

Do not assume that a reader opened the pages in order. Briefly define a SuperTag concept before
using it in a landing page, and define the subject and neighboring concepts at the start of any page
that readers may open directly.

## Develop locally

The public documentation uses the installed `supertag` command. To run your
working-tree changes, use the local CLI instead:

```sh
pnpm supertag up       # equivalent to: supertag up
pnpm supertag get tag
```

This builds and runs the Rust CLI from `rust/` with `cargo run`. Use it when exercising
uncommitted changes.

### Terminal UI (experimental)

`apps/tui` is a Go terminal UI built with Bubble Tea. It is a client of the Control Plane API
only. Build it with Go 1.26 or later, then open it with `supertag tui`:

```sh
cd apps/tui && ./build.sh && cd ../..
pnpm supertag tui
```

`go test ./...` in `apps/tui` runs its tests. The Rust CLI's `operator_runtime.rs` tests drive a
built binary under tmux when `SUPERTAG_RUST_TEST_TUI` names it.

### Protobuf contracts

The protobuf contract lives in `rust/proto`; see [binding generation](rust/bindings/README.md).
`rust/scripts/generate-bindings.py` writes the Go, TypeScript, and Python bindings, using the
protoc Go plugins pinned as tools in the `rust/bindings/go` module, so it needs Go 1.26 or later.

## Rust runtime development

The workspace in `rust/` builds the Control Plane, Gateway, Worker Host, and native CLI.
The `test-fixtures` Cargo feature builds a deterministic harness adapter for the process tests.
Run the SQLite tests with the pinned Rust toolchain.

```sh
cargo test --manifest-path rust/Cargo.toml --locked --workspace --all-features
```

For PostgreSQL coverage, put the disposable test server URL in a private file and set
`SUPERTAG_RUST_TEST_POSTGRES_URL_FILE` to its path. Run the same command with
`-- --include-ignored` to run the PostgreSQL cases. Stateful process tests run once per backend,
as `NAME::sqlite` and `NAME::postgres`; each PostgreSQL case creates its own database and drops
it afterwards. The process tests also use temporary state directories and a local HTTP provider
fixture. The partition case waits for the production 30-second execution lease to expire.

Ignored tests that need a local fixture report `SKIPPED` on stderr and pass when it is missing.
Set `SUPERTAG_RUST_TEST_REQUIRE` to a comma-separated list of the prerequisites a run must have,
or `all`; a listed prerequisite that is missing then fails the test. The prerequisites are
`postgres` (`SUPERTAG_RUST_TEST_POSTGRES_URL_FILE`), `node` (`SUPERTAG_RUST_TEST_NODE`),
`agents-python` (`SUPERTAG_RUST_TEST_AGENTS_PYTHON`), `tui` (`SUPERTAG_RUST_TEST_TUI` and tmux),
`docker` (`SUPERTAG_RUST_TEST_DOCKER`, the `docker` executable; the WebSocket tunnel's nginx case
pulls `nginx:1.27-alpine`), and `linux-root`. The `linux-root` shared execution cases need root in a disposable Linux VM or
container, util-linux `setsid`, and `SUPERTAG_RUST_TEST_SHARED_EXECUTION_BINARY` set to a built
`supertag-shared-execution`. The `linux-root` job in `.github/workflows/rust-port.yml` runs them.

For a live read-only smoke test, use the built-in Codex adapter with an installed Codex CLI
version 0.163.0 or newer. Start the services with a separate development state directory.

```sh
cargo run --manifest-path rust/Cargo.toml -p supertag-cli -- \
  up --state-directory .supertag/rust-dev --harness codex
```

The adapter uses native sign-in or a configured provider key. Give the test Tag `files:read`
and submit a short text Task. The integration suite exercises the same launch path with a
deterministic Codex subprocess.

Regenerate the Go, TypeScript, and Python runtime bindings after changing the Rust protobuf
contract. See [binding generation and conformance checks](rust/bindings/README.md).
The [capability ledger check](tests/rust-port-baseline/README.md) keeps the frozen port ledger's
Rust citations current.
The [native split-service rehearsal](tests/native-deployment/README.md) checks the
complete-archive images, TLS, gRPC health, and restart persistence on disposable PostgreSQL.
The [native release platform checks](tests/native-release/README.md) build and execute
complete archives and their installed command paths without publishing them.

## Test your change

Before opening a pull request, run:

```sh
pnpm check
pnpm test
pnpm build
```

`pnpm test` runs the TypeScript tests. For Rust changes, also run the Cargo tests described in
[Rust runtime development](#rust-runtime-development); for terminal UI changes, `go test ./...` in
`apps/tui`.

Wait for the operation being asserted: final replies for completed Tasks, and consumed output
for log followers. Bound those waits so failures still run cleanup. Test startup timeouts
separately from log tails; a child may not print anything before a short deadline under load.

Add or update tests for changed behavior. If a required check cannot run in
your environment, say so in the pull request and describe what you verified.

## Submit a pull request

Keep pull requests focused. Avoid unrelated cleanup, and explain:

1. The problem being solved.
2. Why the approach fits the existing design.
3. What changes for users or extension authors.
4. How the change was tested.
5. Any compatibility, security, migration, or operational impact.

Reviewers may ask for a change to be split, simplified, documented, or tested
against more than one runtime or database.

## Propose a contract change

Discuss these changes before implementation:

- public SDK interfaces or package entry points;
- Gateway and Worker wire protocols;
- persisted resource schemas or migration behavior;
- Tag, Task, Session, Context Set, or Permission Set semantics;
- extension points for Surfaces, Workers, harnesses, environments, or tool
  integrations;
- compatibility or security policy.

Start with a GitHub issue titled `Proposal: <short description>`. Include the
problem, goals, non-goals, proposed contract, compatibility impact, security
impact, and alternatives considered. A larger, lasting change may need a
separate design record. This keeps ordinary fixes lightweight while making
public contract changes deliberate.

Read [API stability](docs/reference/api-stability.md) before changing an
extension contract or a documented resource shape.

## License

Contributions are accepted under the repository's [Apache License 2.0](LICENSE).
By submitting a contribution, you confirm that you have the right to license it
under those terms.

## Documentation scope

`docs/` explains how to use, operate, integrate with, and understand SuperTag.
Contributor workflows, test procedures, simulation reports, repository internals, and design
proposals belong outside it. Keep contributor guidance in this file, protocol contracts
in `spec/`, and generated test reports in the chosen output directory.

The local `FakeS3` fixture uses verified HTTPS on the [supported Node.js runtime](docs/operations/requirements.md#system-and-tools). It supplies
its CA only to HTTPS agents connecting to active fixture endpoints and restores agent
behavior when the last fixture closes. Always close fixtures in test cleanup.

### Execution lifecycle conformance

#### Rust Worker and harness adapter interoperability spike

This isolated experiment tests a Rust Worker, the process that supervises execution, with
TypeScript and Python harness adapters running as its child processes. The default matrix
produces deterministic text through real gRPC calls. A separate opt-in runner invokes Codex.
The experiment does not replace the current Worker runtime.

On macOS or Linux, install Rust/Cargo, the [supported Node.js runtime](docs/operations/requirements.md#system-and-tools)
with npm, and `uv`, then run from the checkout:

```sh
bash tests/fixtures/rust-harness-interop/run.sh
```

The script installs locked dependencies inside the fixture, generates protobuf bindings,
typechecks the TypeScript adapter, and builds and runs the Rust supervisor. It uses Python
3.13 by default; `SUPERTAG_SPIKE_PYTHON` selects another interpreter available to `uv`.
Node runs the TypeScript adapters with native type stripping, without a compiler subprocess.
The first run needs network access to obtain dependencies. No SuperTag database or provider
credentials are required.

The matrix covers both languages over Unix sockets and loopback TCP: streamed output and
a final result, cancellation while an event acknowledgement is withheld, both orderings
of cancellation versus a final result, invalid credentials, incompatible protocol versions,
stale execution generations, invalid event sequences, and an adapter crash. Each run checks
the observed result and reaps its child process. Successful completion prints 36 JSON result
lines followed by `PASS 36 Rust Worker / harness adapter interoperability cases`.

The experimental [protobuf contract](tests/fixtures/rust-harness-interop/harness.proto) uses
separate control and event streams so a blocked event acknowledgement cannot block
cancellation. The spike keeps results in memory; it does not establish durable recovery,
Gateway session persistence, production sandboxing, or compatibility with existing Workers.

##### Real Codex Tasks

The live runner gives each language adapter a Task, one turn of work, in a new disposable Node
repository. Codex implements a duration parser, adds tests, runs `npm test` and `npm run check`,
and commits the change. TypeScript uses the official Codex SDK's streaming execution API;
Python uses the official asynchronous Codex SDK and app-server. Rust owns both adapter
processes and receives their events and results through the same gRPC contract.

Install Codex CLI and sign in with `codex login`, then run:

```sh
bash tests/fixtures/rust-harness-interop/run-live.sh /tmp/supertag-rust-live
```

This consumes real Codex usage with `gpt-6.1-sol` at `medium` reasoning. It requires file-backed
native authentication in `$CODEX_HOME/auth.json` or `~/.codex/auth.json`. Set
`SUPERTAG_SPIKE_CODEX` to an absolute executable path to override `codex` on `PATH`.
The verified CLI version is 0.163.0. Pass `typescript` or `python` as the second argument
to select one adapter; choose a new output directory for each repeat.

Rust passes the requested model, effort, Task identity, workspace, and prompt in its offer.
It copies only Codex authentication into a private temporary home, clears the adapter's
inherited environment, and removes that temporary home after execution. Each native harness
uses workspace write access with explicit access to the disposable repository's `.git`
directory. No database or surface credentials are supplied.

The runner records streamed command evidence and independently reruns the project's checks
and 37 behavioral cases outside the model-controlled repository. It requires exactly one
commit on the expected branch, both implementation and tests changed, no other changed files,
and a clean working tree. It also checks Codex's native execution record for the actual model
and effort. A successful adapter result alone cannot pass these checks.

Each language's output directory retains `workspace/`, `commit.patch`, `task.json`, `events.jsonl`,
`result.md`, and `result.json` for review. The result includes the full commit hash and check output;
native credentials and reasoning are not copied into these artifacts. The runner reaps each
adapter and fails if native children remain after successful shutdown. These live Tasks are
started by the experimental Rust runner; they are not yet admitted or scheduled by the
production Control Plane, which stores and coordinates the organization's work.

The independent verifier's regression tests require no model calls:

```sh
python3 -m unittest discover -s tests/fixtures/rust-harness-interop -p test_live_project.py -v
```

#### SDK lifecycle and Python tests

`spec/fixtures/harness-lifecycle.json` supplies shared behavioral cases for the
TypeScript and Python SDKs. Run the repository execution, lifecycle fixture, and
sandbox provider tests when changing harness/environment contracts. The repository
suite pins a real Git revision, produces immutable artifacts, and checks them in a
fresh reviewer environment without model-provider calls. Process tests include
cancellation of descendants that ignore SIGTERM.

Run Python tests with `sdks/python/.venv/bin/python -m pytest sdks/python/tests`.

Live Python Codex tests additionally require `SUPERTAG_LIVE_MODEL_TESTS=1` and
provider credentials.

## Prepare release notes

Record user-facing changes in `CHANGELOG.md` under `## [Unreleased]`, in the `Added`, `Changed`,
`Fixed`, or `Removed` subsection. Add the line when you integrate a change onto `main`, not on each
Task or feature branch, so parallel branches don't conflict on the file. Keep each entry to one
concise bullet.

At release time, rename `[Unreleased]` to the version and date, add an empty `[Unreleased]` above
it, and set the package versions in the same release commit.

## Live Modal native mounts

Run the Modal Volume test on its own with `pnpm test:volumes:modal:live`. It prepares a Workspace
with two disposable Volumes, verifies read-only input and git delivery, then reads persisted output
in a replacement sandbox. It removes the sandboxes, Volumes, and prepared image when it finishes.
Use your normal Modal credentials and optionally set `SUPERTAG_LIVE_MODAL_APP` for a dedicated app.

The opt-in suite reads `fixture.txt` from a small bucket prefix and an existing Modal Volume
subdirectory. Put a nonempty `fixture.txt` in each before running it. The suite creates an app
named `supertag-mounts-live` if needed, creates one sandbox, verifies both writes fail even as root,
and terminates the sandbox in `finally`. A 180-second sandbox lifetime bounds interrupted runs.
It never creates a bucket, Secret, or Volume. Normal tests use fake clients and make no cloud calls.

Authenticate with Modal's usual host credentials. Set these Experimental inputs:

- `SUPERTAG_MODAL_MOUNTS_BUCKET`: the full `s3://`, `r2://`, or `gs://` source URL.
- `SUPERTAG_MODAL_MOUNTS_SECRET`: an existing Modal Secret name, never a credential value.
- `SUPERTAG_MODAL_MOUNTS_VOLUME`: the full `modal-volume://NAME/PREFIX/` source URL (no query). The suite consents to this exact name in the host's Modal environment.

```sh
SUPERTAG_MODAL_MOUNTS_LIVE=1 pnpm exec vitest run packages/runtime/environments/modal/modal-mounts-live.test.ts
```

The suite skips unless the gate equals `1`, and always skips in CI. It costs real Modal usage.
Run it with an S3/R2 or GCS bucket to verify that backend; the fake-client suite covers all schemes.

## Live Modal workspace conformance

The workspace sandbox fake models the commands and paths in `python:3.13-slim`. It has `apt-get`
but no Node.js, and missing commands exit 127. An image gets `node` only from preparation's trusted
Node.js install layer, or from a snapshot of trusted preparation content. A Task-copied binary does
not count, and `apt-get` in a sandbox installs nothing. The fake's path checks are best effort and do not form a security boundary. Run the
live provider suite to verify behavior in a real sandbox.

A live conformance run checks the Modal workspace provider against a temporary git repository.
Use it when validating changes to Modal workspace preparation, checkout, or cleanup. It
requires an existing, dedicated `supertag-conformance` Modal app used only for this suite.
Configure credentials through `~/.modal.toml` or `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, as
the Modal SDK expects. The run uses 0.125 CPU and 512 MiB for setup and Task sandboxes. At 128 MiB, real Modal setup
sandboxes were killed with exit 137 before writing any output. Each run
adds a layer that sets `SUPERTAG_LIVE_RUN_ID` to its base image, so the image it deletes is never
shared with other builds. It tags every sandbox with the same run ID, retries cleanup, and sweeps by
tag if creation fails after Modal starts a sandbox. A sandbox or image created after cleanup starts
is removed at once. Snapshot images expire after one hour. The runner reports created, deleted, and remaining IDs on
success, failure, or signal. It is excluded from `pnpm test` and CI.

```sh
pnpm test:workspace:modal:live
```

Set `SUPERTAG_LIVE_MODAL_APP` to use a different existing dedicated Modal app. Check the final
report and deletion lines before leaving the run. If cleanup reports a failure, remove
the listed resource in Modal before retrying.

