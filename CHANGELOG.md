# Changelog

All notable user-facing changes to SuperTag are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Published package versions follow [Semantic Versioning](https://semver.org/)
within the pre-1.0 compatibility policy described in
[API stability](docs/reference/api-stability.md).

## [Unreleased]

### Added

- A Tag's conversations share one memory. Every conversation sees the Tag's open Objectives, and the Tag can list, search, and read its other Sessions with `list_sessions`, `search_sessions`, and `read_session`. `list_objectives` and `read_objective` reach any Objective the Tag owns.
- Sessions are `shared` or `private`. A Lark direct chat or a CLI conversation is private to its one person; existing Lark direct-chat Sessions become private when you migrate.
- `supertag message tag NAME TEXT|- [--session NAME] [--output text|json]` talks to a Tag from the terminal in a private conversation, with the Tag's Roles' permissions only.
- `supertag message tag` shows a line for each command the Tag runs while it works, then the Tag's final reply, and follows work Sessions' activity; Ctrl-C stops following without cancelling the Task. `GET /api/v1/tags/NAME/messages/TASK_ID/stream` serves the reply as an AI SDK UI message stream, and reply text is no longer stored as one Task event per piece.
- An Objective started in a conversation posts its completion summary there.
- A conversation hands longer work to work Sessions with `start_session`: each runs as its own Session and Task with the conversation's permissions and audience, at most four running at once, four per message, and eight unfinished per conversation, and its result returns to the conversation as a report from the Tag. A message and the work Tasks it starts or continues draw on one budget pool, the message's reported token and cost limits: each work Task may spend what the pool has left, `start_session` and `continue_session` are refused once less than 5% of the message's limits is left, and report turns run under the message's full limits. `supertag message tag` follows them until each reports, `supertag list session` shows `TAG`, `TITLE`, `PARENT`, and `STATUS`, and a Session reports `spec.parentSessionId`, `status.tag`, `status.title`, and `status.latestTaskStatus`.
- A work Session asks the person with `ask` instead of waiting inside its Task: the Task completes waiting on the person, the Tag puts the question in the conversation, and the conversation lists the work Sessions still waiting. The Tag passes the answer on with `continue_session`, which starts the work Session's next Task under the current message's permissions and limits. A work Session's approval notice posts to its conversation. `supertag message tag` shows `· waiting on you: TITLE`, and `startedSessions` gains status `waiting` with the `question`.
- A work Session waits on approval the way it waits on an answer. A gated call that returns "approval pending" ends the work Session's Task waiting on that request: the `request_action_approval` result carries `next`, the Task's outcome records `approvals`, and the report turn says what the work Session waits for. The request stays pending while the work Session waits, and `supertag approve request` or `supertag deny request` continues the work Session as its next Task with the decision, under the waiting Task's permissions and drawing on the same budget pool. A decision made while the Task still runs continues it once the Task completes, and the Control Plane retries a continuation a restart or failed admission missed. When the Tag's permissions changed while the work Session waited, or its limits are spent, the work Session doesn't continue: the conversation gets a notice, and `supertag message tag` prints `· not continued: TITLE`. A `once` approval covers the retried call in that next Task. The notice adds "The work Session continues on its own once you decide." `supertag message tag` prints `· waiting for approval: TITLE` and keeps following the work Session into its next Task, while `--output json` returns at the waiting report. Before, the work Task finished and its request expired, so deciding it failed with "The requesting Task already finished; request expired".
- A work Session keeps its edits. With a Workspace from the conversation's location, or for a CLI conversation from the Tag's Worker Hosts, the Worker commits the work Session's changes to its own branch, `supertag/session/<id>`. Each later `continue_session` Task commits on top of them on the same branch, and the report turn names the branch. With several Workspaces, `start_session` takes `workspace`.
- A work Session sees only its own work: its Tasks get `ask` and nothing else, with no portfolio and no reads of other Sessions or Objectives. A work Session's approval notice names the requiring permission in SuperTag's words rather than the work Session's summary, and posts once per permission while its requests wait.

### Changed

- A conversation's work Sessions draw on one budget pool, as an Objective's do. Each work Task may spend what the message's token and cost limits have left after everything the message and its work Tasks reported, instead of an equal share of what was not yet given out. Running work Tasks hold nothing back, so work Tasks running at once can overspend the pool by what they spend in flight. `start_session` and `continue_session` are refused once less than 5% of the limits is left, instead of a tenth, and a work Session continued after an approval decision draws on the pool of the turn that started or continued it.
- A work Session has one branch, `supertag/session/<id>`, and every Task of it commits there. A continued Task checks the branch out at the Session's latest delivered commit and commits on top, instead of starting the next numbered branch `supertag/session/<id>-2` from a merge of the earlier one. A continued Task also keeps commits added on top of the branch since, such as a reviewer's fixup or a local commit whose push failed. A branch rewritten without the Session's last commit, or one a later Task needs from another Worker Host that never pushed it, fails the Task Attempt as a Workspace setup failure instead of starting the branch over. With `delivery: pull-request`, a Session gets one pull request that its later Tasks update; once a person merges it, the Session's next delivery opens a new one, and a cancelled Task closes it only when no earlier Task of the Session delivered to it. Workspace plans no longer carry `dependencyBranches`, and the Worker no longer writes dependency merge commits.
- A work Session no longer sends progress notes: `message_parent`, `skip_reply`, update turns, the `· update: TITLE` line, and the `updates` field of `startedSessions` are gone. Follow a work Session through its activity stream, the `· running:` lines of `supertag message tag`; the Tag reports when the work Session finishes or waits.
- A Session resumes its native harness session whenever the harness can load it: the same Tag, Session, harness, and reply audience. Permission, Role, Context Set, workspace, execution, and Worker Profile revision changes no longer force a fresh session; each turn still runs under its own Task's permissions and tools. Earlier tool output stays in the resumed transcript after a permission is removed, but grants no new access. Bounded Session history replays only when no native state can resume, and never alongside a resume.
- `supertag init` ends by suggesting a conversation with your Tag, `supertag message tag`, with `supertag create objective` as the next step for an outcome with a budget and a deadline.
- `supertag list session` titles an Objective's conversation `Objective ID` and a Tag's Mailbox Session `Inbox`, instead of its first turn's text or nothing.
- Objectives, Mailboxes and Workstreams now run on the same Session model as the rest of SuperTag. An Objective is a conversation with a goal: it talks in the thread it was created in, the owner replies there, a person replies in the thread or with `supertag message objective`, and the Objective asks a question with `ask` when it needs one. Work runs in Sessions started beneath it with `start_session`, including Sessions of other Tags in its Team, and each reports back when it ends. One budget pool per Objective covers everything beneath it; a finished work Session's report turn still reaches the owner once the pool is spent, capped at what is left. A Tag's Mailbox is its own inbox: `send_message` delivers plain text, and several pending messages are handled together in one turn. A Team is a flat list of member Tags with an optional concurrency limit, created with `supertag create team` or declared in an Objective manifest. A Team's Workstream is its shared record of posts; a post wakes nobody, and a post addressed to Tags reaches those Tags' inboxes. Upgrading replaces the Objective, Team, Workstream and messaging tables, so existing Objectives, Teams and messages do not carry over.

### Fixed

- A Tag whose Permission Sets grant tools of an MCP server that only a Workspace provides answers again: a conversation turn needs only the granted MCP servers a bound Worker Host declares, and runs without the others, which work Sessions with that Workspace use. A turn that cannot be placed no longer holds back other Sessions' turns, of any Tag. A waiting turn records why once, `supertag describe task` shows `Waiting: REASON`, and `supertag message tag` prints `· waiting: REASON`, with `waiting` in the message record.
- A Task copy of a git repository holds only what git considers part of it: tracked files and untracked files that are not ignored. Ignored entries such as `node_modules`, a Python `.venv`, or a `.env` file stay on the Worker Host, so a repository with a virtualenv no longer fails with "symbolic link ... points outside the workspace", and copies are much smaller.
- A Task's commit leaves out untracked build and cache files that are never source, such as `__pycache__/`, `*.pyc`, `.pytest_cache/`, `node_modules/`, `.venv/`, and `.DS_Store`, even when the repository has no `.gitignore`. A work Session that ran pytest no longer commits `.pyc` files. Files already tracked under those paths are still committed when they change.
- Conversation, work Session, and report turns are not asked for `Finding:` lines; only Objective Tasks report findings, so review lines no longer appear in replies.
- A path in a message, such as `src/index.ts` or `__pycache__/`, is ordinary text. Only an `owner/repo` that follows GitHub's owner rules selects a repository, so such a message no longer fails as a disallowed GitHub repository or drops the default repository.
- Each release's `install.sh` installs that release's version, and alpha releases publish to npm's `latest` tag, so the installer and `npm install -g supertag-ai` get the current alpha.

### Removed

- The tools `assign_task`, `update_task`, `read_task`, `list_tasks`, `read_commitments`, `wait_for`, `escalate_task`, `read_mailbox`, `post_workstream` (now `post`), `read_team`, `update_team`, `request_approval`, `decide_approval`, `select_objective`, `attach_objective`, `start_objective`, `instruct_objective`, `create_team`, `create_tag` and `list_tags`. The commands `supertag assign task`, `supertag start objective` and its `--no-start` flag, `supertag events team`, `supertag coordinate`, `supertag prune mailbox`, the mailbox credential commands, `supertag message objective --reply-to`, and `supertag update objective --notification-task`. The `--lead`, `--parent`, `--max-breadth` and `--max-depth` flags, and the `--type` flag of `supertag grant mailbox`. The Objective manifest fields `observe` and `teams`, replaced by a single `team`. Message types and the `priority.*` and `governance.*` protocols, per-type Mailbox grants, Task approvals, review-finding closure, leadership and parent Teams, governance transfer, linked Objectives, the external mailbox transport at `/internal/v1/mailbox`, and the Org Architect Role.

## [0.2.0-alpha.6] - 2026-11-04

### Changed

- Claude Code and Codex Tasks run the `claude` and `codex` CLIs you install instead of copies bundled with the vendor SDKs. `supertag init` and host startup check that each is installed and at least the version SuperTag's SDK targets, and name the upgrade command when it isn't.
- The installer script (`install.sh`) installs the npm package with your Node.js 22.13 or newer and npm, and removes the bundled Claude Code and Codex CLI copies; releases no longer attach per-platform archives with their own Node.js.
- Document the installer script alongside npm, including version selection, installation paths, upgrades, and removal.

## [0.2.0-alpha.5] - 2026-11-03

### Changed

- Rewrite the npm package page around Objectives and teams, with a runnable first result, current integrations and SDK entry points, and direct documentation links.
- Install the CLI and TypeScript SDK from npm and the Python SDK from PyPI; setup guides and operator skills no longer require a SuperTag checkout.

## [0.2.0-alpha.4] - 2026-11-03

### Added

- A public roadmap (`ROADMAP.md`); contributor skills for coding agents are now tracked in `.claude/skills` (shared with `.agents/skills`).
- Example organizations in `examples/organizations/` (`solo`, `review-team`, `mixed-harnesses`): one manifest each to apply a whole team, tested to apply and round-trip.

### Removed

- The backlog benchmark, invoice outcome-reconciliation, and organizational-effectiveness experiments, with their scripts and tests.

### Fixed

- Multi-line CLI errors, such as invalid manifests and `supertag.yaml` problems, keep their line breaks instead of printing as one line; `--output json` still prints one line. `supertag init` without a harness lists install and sign-in steps with a link to the sign-in docs.
- `supertag apply` and `diff` now apply a Workspace's `mcp`, `skills`, and `skillCatalog`; before, they reported the manifest as configured and silently dropped those fields.
- The Cursor harness redacts encoded keys and MCP secrets before truncation, strips control and invisible format characters, leaves split workspace inputs unaltered except for exact key redaction, keeps late runner errors, rejects unknown MCP events, and reports a rejected `CURSOR_API_KEY` consistently.

## [0.2.0-alpha.3] - 2026-10-28

### Added

- Run Claude Code, Cursor and Codex (app-server) on Worker Hosts with workspace tools in e2b and Modal sandboxes, using the host's sign-in or provider key, and refuse OpenCode and Codex exec mode on those hosts so provider keys stay out of sandboxes.
- Cursor harness (`harness: cursor`): Tags run Cursor's agent through the bundled `@cursor/sdk` with `CURSOR_API_KEY`, Permission Set tool allowlists (commands need `allow-unsandboxed-commands` and `files:write`; a repository or home `.cursor/sandbox.json` is refused), resumable sessions, only the admitted SuperTag tools as SDK custom tools, and per-Attempt tokens (priced only from provider cost or Cursor's published price table, otherwise unpriced); `supertag init` detects Cursor and checks its key.
- Each Task Attempt gets a scratch directory removed when it ends, and `supertag ps` and `status` warn when a Worker Host runs low on free disk.
- Log Control Plane event-loop stalls over one second with the active HTTP route or background job.
- GitHub-hosted Skill catalogs for Workspaces: configure a repository, catalog path, and revision, select Skills, and each Task pins the resolved commit and a host-independent content digest.
- Operator notifications: inbox items that need the operator (decision requests, open high findings, stalled Objectives, uncertain Task Attempts, limits, Objective completion) notify through the `notify` setting (desktop by default on a local `supertag up` host, webhook, Slack DM), coalesced over 60 seconds, with delivery status on each inbox item. `supertag test notification [--objective ID]` sends a test through every channel.
- Let an Objective owner withdraw its own pending operator question with a recorded reason.
- Warn teammates with an `evidence` post on the Team channel when concurrent Task Attempts in one Team change the same repository file.
- Upload changed files from read-write copy mounts to file and S3-compatible Volume sources at Task Attempt finalize, with bounded output manifests and partial failure reporting.
- Document read-write Volume mounts, output manifests, upload limits, and write consistency.
- Mount Modal buckets and Volumes read-write when a Workspace mount declares `access: read-write`.
- Allow explicit read-write Workspace mounts and record bounded copy mount write manifests on Task Attempts, including partial failures.
- Show Volume write manifests in Task descriptions and Objective overviews.

### Changed

- The coding-agent skill is now the operator skill, `skills/operate-supertag`, with its guide at `docs/guides/coding-agent-operator.md`. Reinstall it under the new name.
- Split long artifact, credential storage, harness runtime, and contributor documentation sections into shorter subsections.
- WebSocket Worklet hellos must advertise only protocol 18; older protocol paths are removed.

### Fixed

- Cursor Task shell commands use the Worker's Node runtime ahead of an older Node on `PATH`; the docs list Cursor's sandbox limits for pnpm caches and `.cursor` writes.
- Cursor runs now fail with `MCP_TOOL_REJECTED` when a custom tool call is left unfinished at end of stream, and only the `mcp` tool name, the one native MCP name `@cursor/sdk` 1.0.37 emits, is treated as a native MCP call.
- Stop failing Task Attempts with "Process output consumer exceeded bounded stream capacity": a slow output reader now pauses local, Modal, E2B, and Python SDK processes at their output pipe, and Codex keeps reading output during coordination tool calls.
- Stop failing Task Attempts whose Harness accepts no instruction inputs or whose execution environment is shared or cannot create directories; the latter two run without `SUPERTAG_SCRATCH_DIR`.
- Track double-forked Claude Code child processes through the first scan after their isolated launcher exits, including macOS system binaries with hidden environment markers.
- Reject Claude Code process baselines when a hidden process is owned by the Worker user or its ownership cannot be checked.
- Codex spend is estimated from published prices and late usage reports are captured; unpriced models show token counts and warn that their budget cannot be enforced.
- Stop macOS Task Attempts from going uncertain when a process exits or execs mid-scan: the process inventory now retries transient kernel errors (EIO, ENOMEM), reads each batch up to three times, sizes its buffer from kern.argmax, scales its timeout to the batch, and logs the helper's exit code, signal, timeout, and stderr with the whole cause chain on the Worker Host.
- Fail Task Attempts rejected before harness startup by an earlier cleanup failure, and log redacted cleanup causes with Task Attempt IDs on the Worker Host.
- Fixed owner continuation when same-millisecond Task updates tie, and stabilized process-dependent and shared Team delivery tests under load.
- A custom Harness's structured result is kept after a cancel; rejected, revoked, and never-sent Team deliveries no longer count as unconfirmed.
- Reduce idle Control Plane CPU use by reading only scheduler fields and reusing unchanged Task budget evidence across Objective limit sweeps.
- The operator inbox, and the notifications that read it, no longer miss current items once a deployment holds more than 1,000 finished Tasks or closed Objectives.
- Confirm Claude Code process termination on macOS when process details are denied.
- Require answers to pending owner questions before Objective completion, and resolve them when an Objective is cancelled.
- Show pending owner questions and reply commands in Objective review notices and `describe objective`.
- Reconcile operator channel notifications after inbox changes with a slow safety sweep, and avoid repeated scans of old completion notices and unrelated Objectives at delivery.
- Codex spend estimates price GPT-6 Sol, GPT-6.1 Sol, GPT-6 Astra, and GPT-6 Luna at OpenAI's published Standard rates, so monetary budgets now cap those Task Attempts.
- Deadline, budget, pause, resume, and approve changes leave pending owner questions pending; only a linked reply answers one.
- `supertag recover worklet` without `--host` uses the Task Attempt's recorded Worker Host instead of whichever host service is running.
- Deliver addressed Team posts live to running teammates across Objectives served by the same Team.
- `supertag spend`, `status`, and `describe objective` read spend in milliseconds on long histories instead of blocking the Control Plane, and `supertag ps` no longer reads spend; `status` shows unpriced usage for open Objectives.

### Removed

- Remove the CLI fallback for Objective views without Volume write summaries.

## [0.2.0-alpha.2] - 2026-10-06

### Added

- `supertag start objective ID` starts an Objective created with `--no-start` and prints a short summary.
- README guidance on declaring Objectives for AI engineering teams, with verifiable outcomes
  and continued human steering through decisions, findings, and approvals.
- Objectives let a Tag own an outcome, form Teams, delegate Tasks, and review results.
  Operators can set budgets and deadlines, pause and resume work, and track statement items.
  Ongoing Objectives keep working until an operator ends them.
- Teams have a shared channel and direct messages. Tags receive unread coordination when
  they start work; Codex and Claude Code can also receive teammate input during a Task.
  Objective views show questions, blockers, and message delivery.
- Review findings record severity, location, and resolution. Open high findings block
  owner completion until an accepted re-review or operator closes them.
- `supertag status` summarizes hosts, work, spend, and decisions. The operator inbox shows
  commands for needed actions, and Objective owners can send reports without requesting replies.
- Host and Workspace MCP servers support scoped tool grants, approvals, and HTTP or stdio
  connections. Provider presets cover GitHub, Slack, Linear, Teams, and Lark; OAuth login
  supports browser sign-in and token refresh without exposing credentials to the harness.
- Workspaces select Skills and MCP servers from trusted source. Tasks can run in local
  checkouts or prepared E2B and Modal sandboxes, including supported devcontainer setup.
- Volumes name storage locations on a host or in S3/R2. Workspaces can copy their contents
  into Task environments with read-only access and size limits. Worker Hosts can also use
  a Volume to retain artifacts; Task and host views warn about ephemeral storage.
- Local service management, declarative resource configuration, and shared Control Planes
  support operating multiple Tags and Worker Hosts. Custom Workers use TypeScript or Python.
- A [requirements](docs/operations/requirements.md) page lists Node.js, pnpm, git, supported
  platforms (macOS and Linux), each harness CLI and its sign-in, disk space, and telemetry.
  SuperTag itself sends no telemetry; the page says which harness telemetry managed Workers
  leave on and that a Codex Worker copies its sign-in file into each Task's working area.
- A [first Team walkthrough](docs/guides/first-team.md) adds a builder Tag and runs a lead and
  builder as a Team.
- README's "How you use SuperTag" section, a [Write an Objective](docs/guides/write-an-objective.md)
  guide, an [interaction model](docs/concepts/interaction-model.md) page, and a
  [coding-agent coordinator](docs/guides/coding-agent-operator.md) guide with the
  `operate-supertag` skill, so a Claude Code, Codex, or other coding-agent session can
  write Objectives, check on them, answer questions, and hand back results for review. The
  guide covers verified question replies, untrusted Tag output, and credential-isolated review.
- Workspace mounts accept read-only `strategy: mount`, which needs native provider support and
  never falls back to copying. Modal attaches S3, R2, GCS, and Modal Volumes at Task start using
  provider-held Modal Secrets or S3 OIDC roles; local and E2B refuse native mounts. Native mounts
  are Experimental. `supertag describe task` shows each live mount without credentials.
- `supertag init` checks each selected harness's sign-in with the credentials the Worker Host
  will use, explains how to sign in, and selects only signed-in harnesses by default. It checks
  the gateway port when it's entered; with `--yes` it picks the next free port.
- An addressed `question` or `blocker` in a Team channel or direct message wakes an idle teammate
  with a reply activation; a `blocker` with no addressee goes to the Team lead. Posts close together
  share one activation, loop brakes limit how often Tags wake each other, and `supertag spend` and
  `describe objective` show reply-activation spend and each Team's open questions and blockers.
- `supertag message objective --reply-to MESSAGE_ID` answers a pending question. The CLI lists
  pending questions before sending, and a message answers one only when the operator says so.
- `supertag recover worklet --host NAME` selects the host service. Without it, recovery uses the
  Attempt's recorded Worker Host and refuses, naming the candidates, when it can't tell.
- A stalled working Objective raises an operator inbox item naming what waits and how to wake
  it, and its owner is woken once automatically. Delegated work still in flight isn't a stall.

### Changed

- Custom Worker authors must replace `GitWorktreeWorkspaceResolver` with
  `WorkspaceEnvironmentResolver` and use the `WorkspaceEnvironment` contract
  (`refuse`, `prepare`, `start`, `finalize`, `evict`). Use `LocalWorkspaceEnvironment`
  for existing local behavior; check custom providers with
  `runWorkspaceEnvironmentConformance` from `supertag-ai/testing`.
- Install SuperTag by cloning the repository and running `pnpm install:cli`; see
  [Install SuperTag](docs/operations/install.md).
- README's quickstart shows real `watch` and `describe` output and branch names, and the docs
  index links every page in the order a new user needs them. The first-reply skill checks the
  services `init` started instead of stopping them to start a second Control Plane.
- Docs and agent skills use current commands, Worker Host enrollment, and Task profile
  selection, and no longer describe removed concepts. They say Task Attempt and collaboration
  surface consistently and explain owner activations, connection generations, and waits that
  survive restarts where they first appear. Long reference sections are split under topic
  headings, and the troubleshooting and Tag skills say which Permission Set to grant and which
  stored Worker Host credential to remove before rejoining a host.
- Node.js 22.13 or newer is required. All repository package versions and the Python SDK
  now identify this release as 0.2.0-alpha.2.
- Artifacts stay on the producing Worker Host or its configured Volume. The Control Plane
  keeps a catalog of copies, and Worklets transfer artifacts directly. Operators can inspect
  storage locations and download reachable copies.
- Tasks with accepted Workspace dependencies start with their delivered branches merged.
  Review Tasks receive the submitted commit and installed dependencies. Setup runs from
  the trusted base commit, and Task commits use a short description of the change.
- Host concurrency defaults to available machine capacity. Changing only concurrency applies
  without restarting the host; Team concurrency is an optional throttle. Objective owners
  retain capacity to coordinate when builders occupy the normal execution slots.
- Budget exhaustion stops new work while running Task Attempts finish. Limited Objectives
  retain a progress summary and can resume after their limits are raised. Spend views label
  estimated costs and explain missing prices or unreported costs.
- CLI resource lists default to text tables. Task views show running commands, pending
  dependencies, placement refusals, and recovery instructions for uncertain execution.
- Local services restart when their version or build changes. Laptop wake grants running
  work time to reconnect, and service views warn about battery and sleep risks.
- A missing required flag names the flag and shows that command's usage; unknown commands point
  to `supertag --help`. Worker Host views show harness names such as `claude-code` and `codex`,
  and status lines describe interrupted or stalled work in plain language.
- Task branches are named after the Objective and Task, with a short suffix only when needed.
- Objective owners keep unhandled operator messages across wakes and must handle new operator
  input before waiting again.
- `supertag down` waits at most five minutes for a drained host, lists the Task Attempts it waits
  for and the `--force` command, and leaves running hosts in place on timeout.

### Removed

- Control Plane artifact byte storage, its artifact directory and S3 configuration, legacy
  artifact environment variables, and artifact byte API routes. Configure storage on Worker
  Hosts instead.
- Ad-hoc Workstreams and Mailbox per-Workstream history. Workstreams are Team channels;
  upgrading deletes channels not associated with their Team and posts by non-members.
- Built-in provider tool credentials and tool providers, replaced by host MCP servers and
  their credential references. The old Skill catalog flag and environment variable are
  replaced by host service configuration.
- The duplicate `supertag team` command group. Use action-first Team commands instead.
- Worklet protocols below 18, the `pairingToken` handshake, and legacy remote job execution.
  Worker Hosts and Python Worklets connect with protocol 18, a Worker Host credential, and a
  durable Task Attempt journal; upgrade the Control Plane and Worker Hosts together.
- Plural, unhyphenated, and differently cased CLI resource names. Use the singular names that
  `supertag --help` lists, such as `permission-set`.
- The `workers` section of the credential file. A file that still has it is refused unchanged.
- `RuntimeInputPipeline` from the Python SDK and internal helpers from `supertag-ai/worker`;
  see [API stability](docs/reference/api-stability.md) for the published entry points.

### Fixed

- Objective owners see the messages they sent, not only the ones they received, in `read_mailbox`.
- First-run docs now explain harness sign-in, busy ports, pinned pnpm bootstrap, and recovery from an unsigned harness.
- The docs name the current release and install from the repository everywhere; the docs check
  now rejects other prerelease versions and package-archive installs.
- Finished or cancelled Objectives clear obsolete inbox decisions and work. Delegated
  failures wake waiting requesters, and one Objective's work no longer blocks another's
  Mailbox delivery for the same Tag.
- Unread live input returns to the next delivery after a harness finishes. Revoked Team
  membership prevents queued input from reaching the harness, and teammate text retains
  its sender label. Claude Code stops accepting tools after its final result.
- Workspace setup, git operations, MCP snapshots, and Volume copies reject Task-controlled
  redirects and protected host paths. Remote setup failures report actionable diagnostics.
- Artifact access stays tied to the producing Task Attempt and host. Storage reports retain
  disconnected copies, distinguish ephemeral storage, and prevent deleting Volumes still
  holding artifacts. Download endpoints enforce reachability and credential checks.
- Stored errors redact credentials, including encoded and short resolved secrets. Terminal
  views filter control characters while explicit machine output preserves original values.
- One credential-redaction rule covers stored Worker events and Task results: URL and query
  credentials, credential-named fields, and UPPER_SNAKE environment names are masked, while
  ordinary identifiers such as `sessionKey` and artifact URIs stay readable.
- Claude Code's final result waits for confirmed cleanup of the tools it started on macOS and
  Linux, including Linux hosts mounted with `hidepid`, and cancellation can no longer discard an
  accepted final result.
- Withdrawn live input appears once: the next activation starts a fresh harness session and
  reads it from its digest. Operator messages whose delivery stayed uncertain return to the
  next activation or get a notice asking you to resend.
- Artifact paths reject invisible, non-NFC, and non-ASCII space characters. File artifact
  uploads and Volumes refuse symbolic-link swaps, and listings count a copy only after the
  producing Task Attempt's upload receipt. Volume sources refuse provider keys and cloud
  metadata endpoints while accepting ordinary dated paths.
- Operator downloads withhold loopback artifact endpoints when the Control Plane listens on a
  wildcard address. gRPC Worklets accept only protocol 18.
- MCP token refresh handles concurrent requests and newer logins without losing valid
  credentials. Lapsed logins update host placement and show the required operator action.
- Worklet heartbeats tolerate slow host probes. Transient provider and Session-save failures
  retry where safe, and uncertain cleanup retains recovery information rather than losing work.
- Local process cleanup works on Linux and macOS, checks process identity before signalling,
  and releases capacity only after execution is confirmed stopped.
- README setup covers installing pnpm with npm, private alpha repository access, and file-backed
  Codex sign-in on macOS; the first-Team guide keeps its input files outside the repository and the
  quickstart Objective has a budget.
- Coordinator guidance answers a question with `--reply-to MESSAGE_ID`. Top-level
  `supertag --help` lists every command's flags, and `supertag message objective --help` lists
  `--output`.
- A Task Attempt that changes the shared repository's git configuration now fails alone: SuperTag
  restores the recorded configuration, names the file and change, and raises an operator inbox item.
  Codex sandboxes mark the shared git directory read-only where supported.
- Worker events of an unknown type, missing required fields, or larger than 3 MiB are rejected
  before journaling, failing only the affected Task Attempt instead of dropping the Worker Host
  connection. Extra fields are kept.
- A Worker throw after a terminal event fails the Task Attempt and frees its slot instead of
  leaving it uncertain; after cancellation the Task Attempt is still cancelled.
- Oversized progress and finding text is truncated with an ellipsis instead of making the
  Task Attempt uncertain.
- `supertag status` counts the owner coordination slot in Worker Host and harness capacity.
- Concurrent Task event writes no longer collide on PostgreSQL. Python SDK process timeouts
  work on Python 3.10.
- SQLite state databases and their WAL and shared-memory files are owner-only (0600).
- Claude Code cleanup follows tracked tool process groups on macOS and Linux, and credential
  redaction covers short credentials in stored paths, URIs, and identities.
- Artifact-Volume protection closes S3, GCS, and loopback endpoint aliases.

## [0.2.0-alpha.1] - 2026-08-16

### Added

- Self-contained `supertag` CLI distributions for macOS and Linux on x64 and
  arm64, a checksum-verifying `install.sh`, and release automation that
  smoke-tests local SQLite migrations.
- Permission-scoped external actions through official provider MCP tools:
  GitHub branch and pull-request changes, Slack and Lark messages, Linear
  issue and comment creation, and Teams channel messages and replies.
- Extensible Context Items with namespaced, versioned contracts; Worker-side
  Context Resolvers in both SDKs; capability-aware Control Plane routing; and a
  guide for adding custom context without expanding Task permissions.
- A curated default `supertag-ai` SDK entry point, with advanced Worker
  extension contracts available from `supertag-ai/worker`.
- A reusable `supertag-ai/testing` conformance kit for custom Workers,
  Harnesses, Surfaces, execution environments, Tool Providers, Tool
  Adapters, and transport implementations.
- Language-neutral JSON Schemas for Task Attempts, events, Worklet
  descriptors, resource envelopes, and protocol v9 messages.
- Published-package validation in CI using `publint` and Are the Types Wrong.
- Out-of-workspace JavaScript and Python extension examples with custom Worker,
  Harness, and Environment Provider implementations. Both are tested against
  their public SDK surfaces.

### Changed

- **Unsandboxed harnesses need an opt-in to run commands.** Claude Code and OpenCode on a host
  service run commands as you, without a sandbox. A host now runs Tasks granted
  `commands:execute` on them only when its service lists them in `allow-unsandboxed-commands`;
  otherwise such Tasks go to Codex or another host, or wait with a reason naming the setting in
  `supertag describe task`, the Objective's Runnable condition, and `supertag create objective`.
  `supertag init` asks, defaulting to yes, and `--yes` opts in and says how to undo it. Existing
  host services that run commands on Claude Code or OpenCode must add the setting. See
  [Unsandboxed harnesses](docs/reference/supertag-yaml.md#unsandboxed-harnesses).
- Codex Tasks allowed to run commands can bind loopback sockets for local test servers while
  external network access stays restricted. The Task Attempt execution record reports the sandbox
  allowance. See [Codex sandbox network](docs/reference/iam.md#codex-sandbox-network).

- Custom Workers are normal Python, JavaScript, or TypeScript applications
  launched by their language runtime. The `supertag` CLI is reserved for
  service operations and built-in TypeScript Workers.
- Worker Host and Worklet are separate contracts. A Worker Host is the
  operational capacity resource; a Worklet is its persistent supervisor.
  Worklet transport v9 carries both identities over `/worklets`, and the
  The Control Plane drains and schedules Worker Hosts through Worklet connections.
- `WorkerRuntime` is no longer a public concept. `createWorker` and
  `create_worker` compose standard components and return an ordinary Worker.
- Context Plan v6 and Worklet Descriptor v1 replace the closed built-in knowledge
  item union with a strict, open Context Item envelope. This is an
  intentional pre-1.0 breaking change with no legacy database compatibility.
- Slack uses one living work message: SuperTag posts a concise human
  acknowledgement, then edits it into the final answer or error. Routine
  retries, Task IDs, Worker details, and internal result references stay out of the
  conversation.

### Fixed

- **Money in major units.** `supertag spend`, `supertag update objective`, and `supertag apply`
  refusals print cost and budgets as major units with the currency, such as `$13.80`, matching
  `describe objective`.
- `supertag recover worklet` finds host-service journals under `hosts/SERVICE/attempt-journal`,
  inferring the service from the journal that records the Attempt. Symlinked paths are skipped,
  and it refuses when more than one journal records the Attempt.
- The `supertag-ai` package documentation now correctly identifies Apache 2.0
  as the project license.
- Public API regression coverage prevents internal Worker helpers from leaking
  into the default SDK entry point.

### Security

- Runtime permissions for Harness-native command, file-write, web, and browser
  tools are enforced by the shipped Codex and Claude Code adapters where
  supported.
- External write recovery fails closed: once a write tool starts, the Control Plane
  does not automatically replay the Task after a failure. It requires operator
  reconciliation before a retry.

### Removed

- Early-stage governance, maintainer, roadmap, and code-of-conduct documents.

## [0.1.2] - 2026-08-11

### Changed

- Lowered the Node.js requirement for the npm-installed CLI and SDK to Node.js
  20.18.1 or newer.

## [0.1.1] - 2026-08-11

### Added

- An npm-installable `supertag` CLI through the `supertag-ai` package.

### Fixed

- Preserved the `supertag-ai` package identity and its CLI entry during
  packaging and publishing.

## [0.1.0] - 2026-08-11

### Added

- The initial public release of the `supertag-ai` SDK and Gateway CLI.
- Tags with identity, permission, context, task, session, and workspace
  foundations.
- Built-in Codex Worker support, multiplayer task context, and collaboration
  output rendering.
- Gateway control-plane support and Slack, GitHub, Linear, Microsoft Teams,
  and Lark Surfaces.

[Unreleased]: https://github.com/atemaguer/supertag/compare/v0.2.0-alpha.2...HEAD
[0.2.0-alpha.2]: https://github.com/atemaguer/supertag/compare/v0.2.0-alpha.1...v0.2.0-alpha.2
[0.2.0-alpha.1]: https://github.com/atemaguer/supertag/compare/v0.1.2...v0.2.0-alpha.1
[0.1.2]: https://github.com/atemaguer/supertag/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/atemaguer/supertag/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/atemaguer/supertag/releases/tag/v0.1.0
