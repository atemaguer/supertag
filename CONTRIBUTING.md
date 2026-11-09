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

Install the tools listed in [Requirements](docs/operations/requirements.md). Source development
also needs the pnpm version pinned by `packageManager` in the root `package.json`:

```sh
git clone https://github.com/atemaguer/supertag.git
cd supertag
npm install -g pnpm@11.18.0
pnpm install
```

To use your local build as the global CLI, run `pnpm install:cli`. Keep the checkout in place
while it is linked. Run `pnpm uninstall:cli` to remove that global command link.

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
pnpm supertag start control-plane  # equivalent to: supertag start control-plane
pnpm supertag list tag
```

This runs the CLI from source through `tsx`, so it requires `pnpm install`
first. Use it when exercising uncommitted changes.

### Terminal UI (experimental)

`apps/tui` is a Go terminal UI built with Bubble Tea. It is a client of the Control Plane API
only. Build it with Go 1.26 or later, then run the CLI with no arguments in a terminal:

```sh
cd apps/tui && ./build.sh && cd ../..
pnpm supertag
```

The CLI resolves the Control Plane and token as every command does and hands them to the binary
on file descriptor 3. With output piped, or without a built binary, `supertag` prints help. The
CLI refuses a binary whose `--version` differs from its own and says how to rebuild it.
`SUPERTAG_TUI_BINARY` points the CLI at another binary. `go test ./...` in `apps/tui` runs its
tests; `SUPERTAG_TUI_E2E=1` adds an end-to-end run under tmux against a fake Control Plane.

Each published release carries the four binaries and their `SHA256SUMS`, built at the release
tag by `.github/workflows/release-cli.yml`. `install.sh` installs the matching binary into the
package's `tui/` directory, where the CLI looks for it. To test the installer before a release,
point `SUPERTAG_PACKAGE_SOURCE` at an npm-packed tarball and `SUPERTAG_TUI_SOURCE` at a
directory holding the binaries and `SHA256SUMS`. `tests/install-script.test.ts` does this with
fakes.

### Protobuf contracts

The protobuf contracts live in `spec/proto`. After editing one, run `pnpm proto:generate`.
`pnpm check` runs `buf lint` and fails when a checked-in binding is stale. Generation also writes
the Go operator API bindings into the Go module in `packages/operator-api/go`, which pins the
plugins as tools, so it needs Go 1.26 or later. `go test ./...` in that directory checks the
generated Go client against the generated handler.

Each operator RPC has a class in `OPERATOR_RPC_CLASSES` (`apps/cli/src/operator-seams.ts`):
`read`, `data_write` (adds records such as messages, posts, progress events and artifacts) or
`control` (changes the state of Objectives, Tasks, approvals, hosts, credentials or resources). A
`read` RPC sets `idempotency_level = NO_SIDE_EFFECTS`, and no other class does. Service modules
read the store through `OperatorReadStore` and `OperatorQueries`, add records through
`OperatorDataWrites`, and make every state transition through `OperatorControl`, whose methods take
plain data and are idempotent. They never import the
`ControlPlane`, the full `Store` or the in-memory `ChangeNotifications`, so a stateless Gateway
can later serve them with `OperatorControl` as a call to the Control Plane.
`tests/operator-rpc-seams.test.ts` checks the classes and the imports.

## Test your change

Before opening a pull request, run:

```sh
pnpm check
pnpm test
pnpm build
```

When changing the published `supertag-ai` package, also run:

```sh
pnpm --filter supertag-ai test:package
```

On a busy machine, a few tests can time out in a full run and pass alone. To tell
those apart from real failures, run:

```sh
pnpm test:verify
```

It runs the full suite with two workers. Then it reruns each failing test file alone,
with one worker and a 60-second test and hook timeout. It exits non-zero if a rerun
fails, or if the full run failed for a reason no test file explains, such as an unhandled
error outside a test. In that case it skips the reruns. Its summary lists each rerun file as passed or failed. Report a file that passed
only on rerun when it keeps happening, and reproduce it with concurrent runs or bounded CPU load.
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

The shared execution design is exercised by the Docker tests
(`pnpm test:shared-execution:grpc:docker`, `pnpm test:organization:docker`) and the opt-in live
organization experiment (`pnpm test:shared-organization:live`), which installs the public
package and runs real Claude Code and Codex managers with bounded runs.

## License

Contributions are accepted under the repository's [Apache License 2.0](LICENSE).
By submitting a contribution, you confirm that you have the right to license it
under those terms.

## Objective runtime verification

Run the focused coordination suite after changing Teams, internal admission, or Worker coordination:

```sh
pnpm exec vitest run tests/teams.test.ts tests/task-assignment-store.test.ts tests/objective-controller.test.ts tests/objective-execution.test.ts
```

Set `SUPERTAG_POSTGRES_URL` to the documented test database to include PostgreSQL. The test role
must have `CREATEDB`. `pnpm test` and `pnpm test:verify` create a fresh database for each run
and drop it when the run ends. Some suites create another temporary database within that run.
The wrapper forwards SIGINT and SIGTERM to the test runner, then drops the run database before exiting.
Use a dedicated test PostgreSQL instance. The wrapper accepts `localhost` and literal loopback
addresses, including the local URL `postgresql://supertag@127.0.0.1:55432/supertag_test`.
Both the URL host and the server-reported address must be loopback addresses. Docker PostgreSQL
and forwarded connections require an explicit marker on the base database, even through
`localhost`. CI sets this marker; for local Docker tests, set it before running the wrapper:

```sql
COMMENT ON DATABASE supertag_test IS 'supertag-test-server';
```

The URL must name a host and database. Query parameters may configure TLS or `application_name`;
host, database, and other connection overrides are rejected. For IPv6 literals, the wrapper
adds a matching unbracketed `host` query parameter for `pg`; an input parameter is accepted only
when it exactly matches that literal. It cannot select another server. The wrapper checks the marker before
creating or deleting any databases.

Each new run reclaims abandoned wrapper databases for the same base database and PostgreSQL role.
Exact ownership comments identify these databases; session advisory locks protect active runs.
This recovers a run killed with SIGKILL on the next invocation. Unmarked databases, including those
from older wrappers or a process killed during initialization before its ownership comment was
written, remain untouched. Review those manually; a `supertag_test_` name alone does not prove ownership.
Run the wrapper's guard, concurrency, signal, and crash-recovery tests with:

```sh
SUPERTAG_POSTGRES_URL=postgresql://supertag@127.0.0.1:55432/supertag_test node --test scripts/with-test-postgres.test.mjs
```

`pnpm db:check` also verifies that each SQLite and
PostgreSQL migration has both a SQL file and a journal entry.

Shared Workstream post coverage lives in `tests/workstream-post-store.test.ts` and
`tests/objective-workstream-posts-execution.test.ts`. The store tests race 200 publication
requests across 100 participants and verify idempotency, incremental ordering, and absence of
mailbox or Task fanout in both dialects. The execution test exercises the real Control Plane, remote
Worklet, and coordination MCP tools with a deterministic runner; it makes no model calls.

`tests/objective-wait-execution.test.ts` covers a waiting assignment resuming once after
50 posts arrive during a Control Plane restart. Mailbox tests cover concurrent overflow, idempotent
retries at capacity, and capacity released by acknowledgement. Harness tests check that Codex native
helper spawning stays disabled in SDK and CLI configurations. Claude Code tests check that native
children can work locally while manager-only coordination tools remain available only to the main agent.

`tests/mailbox-history-store.test.ts` verifies tied-timestamp pagination and terminal-body
retention in both databases, including retry idempotency after pruning. The durable Worklet
SDK tests cover bounded long-stream replay and recovery after killing
a real child process. These storage checks do not require model credentials.

The execution suite uses the real Control Plane API Server, Gateway HTTP and MCP boundaries,
WebSocket Worklet API transport, the Codex harness, and local
processes with a deterministic model runner. Remote harness tests use simulated environments;
provider-backed model execution and E2B require separately configured credentials/templates.

## Documentation scope

`docs/` explains how to use, operate, integrate with, and understand SuperTag.
Contributor workflows, test procedures, simulation reports, repository internals, and design
proposals belong outside it. Keep contributor guidance in this file, protocol contracts
in `spec/`, and generated test reports in the chosen output directory.

The local `FakeS3` fixture uses verified HTTPS on the [supported Node.js runtime](docs/operations/requirements.md#system-and-tools). It supplies
its CA only to HTTPS agents connecting to active fixture endpoints and restores agent
behavior when the last fixture closes. Always close fixtures in test cleanup.

### Execution lifecycle conformance

#### Automatic artifact collection and recovery

For automatic artifact collection and transfer recovery, run:

```sh
pnpm exec vitest run packages/runtime/sdk/harness-artifact-collection.test.ts packages/runtime/sdk/output-collection.test.ts packages/runtime/sdk/output-finalization.test.ts packages/runtime/sdk/file-artifact-store.test.ts tests/automatic-artifact-execution.test.ts
SUPERTAG_S3_CONTAINER_TEST=1 pnpm exec vitest run tests/artifact-s3-container.test.ts
```

Set `SUPERTAG_POSTGRES_URL` to a disposable PostgreSQL instance to run the automatic-execution
suite against both databases; its database account must be allowed to create temporary databases.
The suite uses deterministic harnesses, includes 100 Attempts with concurrency bounded to 16,
and exercises missing outputs, retained sources after staging failure, intermediate captures,
cross-Worker harness-memory restoration, and durable Worklet recovery without rerunning the
harness. The S3 suite starts and removes its
own local MinIO container. These tests make no paid model or cloud calls. Provider unit tests
exercise sandbox collection contracts; they do not replace live E2B or Modal deployment tests.

#### Live artifact handoffs

For opt-in model-backed artifact handoffs, log in to the local Codex and Claude Code CLIs, then run:

```sh
pnpm exec tsx --conditions=development scripts/artifact-handoff-live.ts --live --output /tmp/supertag-artifact-handoff
```

This consumes model usage: Codex uses `gpt-5.6-luna`, and Claude Code uses `haiku`.
It runs both producer/consumer directions in fresh processes with separate workspaces, a real
SQLite catalog, and local blob storage. The producer writes a report to its managed output
directory. After its workspace is removed, the consumer must discover, inspect, and read the
artifact, derive an answer from its contents, and report its native conversation provenance.
The consumer receives neither the artifact ID nor the source facts. JSON reports record the
assertions and HTTP activity. Use a new output directory for each run. To run one direction,
add `--producer codex --consumer claude-code` or reverse those values. This tests local execution;
it does not establish hosted sandbox or transcript-retrieval behavior.

### Organization-level Docker test

For an organization-level test with real model-backed Docker Workers, run:

```sh
pnpm test:artifact-organization:live
```

This opt-in test consumes Codex `gpt-5.6-luna` usage through your existing subscription
login. It starts a real Control Plane and two independently enrolled Worker Hosts in
separate Docker containers, then starts an Objective through the management API. Agents
delegate the work through coordination tools. Their attempt workspaces are separate;
they exchange deliverables through the production artifact catalog and blob store.
The runner checks durable assignments, cross-Worker artifact consumption, native conversation
provenance, and the resulting deliverable, and preserves evidence while removing its containers
and staged credentials. It exercises API invocation, not Slack delivery.

Use `--output /tmp/supertag-artifact-org-<unique-name>` to select the evidence directory.
The default execution bound is ten model Attempts and ten minutes after setup.
Codex's native sandbox remains enabled. If Docker blocks its namespace setup, append
`--allow-unconfined-seccomp` for a test-only fallback. A run using that option does not establish
compatibility with Docker's default seccomp policy. Worker containers remain non-root,
with capabilities dropped and a read-only container filesystem.

Artifact consumption can use a direct tool read or an attachment materialized into the
consumer's isolated workspace. Verification follows the exact consumed source through an
accepted review to a final recommendation, checking file hashes, the source nonce, and native
conversation IDs. Recheck preserved evidence without more model calls with:

```sh
pnpm exec tsx --conditions=development scripts/verify-artifact-organization.ts /tmp/supertag-artifact-org-<unique-name>
```

This writes `verified-report.json` and preserves the original live-run result, including a
failure if an earlier verifier rejected the run. It verifies recorded execution and cleanup;
it does not launch containers again or establish recovery after a Control Plane restart.

#### SDK lifecycle and Python tests

`spec/fixtures/harness-lifecycle.json` supplies shared behavioral cases for the
TypeScript and Python SDKs. Run the repository execution, lifecycle fixture, and
sandbox provider tests when changing harness/environment contracts. The repository
suite pins a real Git revision, produces immutable artifacts, and checks them in a
fresh reviewer environment without model-provider calls. Process tests include
cancellation of descendants that ignore SIGTERM.

Run Python tests with `sdks/python/.venv/bin/python -m pytest sdks/python/tests`.
Set `SUPERTAG_PYTHON_BIN` to that interpreter to enable the real Python custom
Worker interoperability suite in Vitest. That suite exercises legacy protocol 9;
it does not establish durable protocol 12 conformance.

Live Python Codex tests additionally require `SUPERTAG_LIVE_MODEL_TESTS=1` and
provider credentials. Selecting a Python interpreter alone only enables the
deterministic interoperability tests; it must not trigger model usage.


## Prepare release notes

Record user-facing changes in `CHANGELOG.md` under `## [Unreleased]`, in the `Added`, `Changed`,
`Fixed`, or `Removed` subsection. Add the line when you integrate a change onto `main`, not on each
Task or feature branch, so parallel branches don't conflict on the file. Keep each entry to one
concise bullet.

At release time, rename `[Unreleased]` to the version and date, add an empty `[Unreleased]` above
it, set the package versions, and run the version tests in the same release commit:

```sh
pnpm exec vitest run tests/release-version.test.ts
```

## Test an installable package

Users install the published packages from npm and PyPI (see [Install SuperTag](docs/operations/install.md)).
To test local changes in the packaged CLI, build the actual package instead of
creating a shell shim:

```sh
pnpm install
pnpm --filter supertag-ai build
mkdir -p dist
npm pack ./packages/supertag-ai --ignore-scripts --pack-destination ./dist
npm install --global --prefix "$HOME/.local" "$PWD"/dist/supertag-ai-*.tgz
export PATH="$HOME/.local/bin:$PATH"
supertag --version
supertag setup surface slack --help
```

The version must match `packages/supertag-ai/package.json`. Setup help must print readable local
paths for the guide and manifest. `pnpm --filter supertag-ai test:package` checks these bundled
resources in addition to the CLI and SDK interfaces. The resulting archive is for local testing;
building it does not publish a package.

Before updating installation instructions for a release, publish the matching npm and PyPI
packages and verify clean registry installs, the installer, versioned CLI archives, checksums,
and documentation. Release tooling in this repository does not mean a release has been published.

## Live Modal native mounts

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
success, failure, or signal. It is excluded from `pnpm test`, `pnpm test:verify`, and CI.

```sh
pnpm test:workspace:modal:live
```

Set `SUPERTAG_LIVE_MODAL_APP` to use a different existing dedicated Modal app. Check the final
report and deletion lines before leaving the run. If cleanup reports a failure, remove
the listed resource in Modal before retrying.

To reproduce the live run without Modal, run the same suite on local Docker. It uses the real Modal
Workspace provider with `python:3.13-slim` at 0.125 CPU and 128 MiB, a stricter bound than the
live run's. `docker build` stands in
for Modal image builds, containers for sandboxes, and `docker commit` for snapshots. It removes
every container and image it labelled, and is skipped unless enabled:

```sh
SUPERTAG_DOCKER_MODAL_WORKSPACE=1 pnpm exec vitest run tests/workspace-modal-docker.test.ts
```

Set `SUPERTAG_DOCKER` when `docker` is not on `PATH`.
