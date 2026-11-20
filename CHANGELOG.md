# Changelog

All notable user-facing changes to SuperTag are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Published package versions follow [Semantic Versioning](https://semver.org/)
within the pre-1.0 compatibility policy described in
[API stability](docs/reference/api-stability.md).

## [Unreleased]

### Changed

- Every input to a Session now waits in one queue, in the Session's order: a person's message,
  another Tag's direct message, a Schedule firing, a work Session's report, a decision, a notice.
  A redelivered Task answers the messages its lost Task Attempt took in or was being given,
  including one whose delivery was uncertain, and its next Task Attempt gets them after its
  prompt; a message it was never given runs as its own turn. A turn takes in only later messages
  from the same person for the same audience: live input queued by someone else now runs as its
  own turn. On upgrade, waiting messages, live inputs, and Tag messages a wake limit held move into
  the queue; a waiting inbox turn with nothing left to deliver is cancelled.
- A Schedule firing, a work Session's report, an approval decision, a question's answer, and an
  Objective's start, review feedback, and notices each enter the Session's queue once, with the
  turn they deliver, and that turn's claim takes them. In a person's conversation they act for
  that person, so the person's message still joins a running Schedule turn.
- A Tag's message that a wake limit or the backlog holds now waits in its recipient's inbox queue,
  wakes no one, and arrives in the next inbox turn, after the messages that woke the Tag, in the
  same turn as other Tags' messages. A later message in its conversation that wakes the Tag brings
  it along. Held messages count toward neither the backlog of 64 nor the wake limits. An inbox
  turn run again after a lost Worker shows the same messages and takes in nothing new.

- A Tag's memory is its harness's own memory. The daily memory review now keeps that memory
  current: it corrects it against the Tag's Sessions, merges duplicates, dates time-relative
  facts, drops what the repository already records, and merges or drops Work Session proposals,
  with its harness's own tools. On upgrade, the notes each Tag kept with `remember` are written
  once into its harness's memory for the same audience by its next turn on Claude Code or Codex
  (a memory file each for Claude Code, an ad hoc note each for Codex); notes of a Tag on another
  harness wait until it can keep them.
- A Work Session's own turn no longer changes its Tag's memory: what it writes there is kept
  beside the store as a proposal (`"status": "proposed"` in `supertag get memories`, a
  **Proposed** badge in the desktop and terminal apps) with the turn that wrote it. The Tag's next
  daily review gets the shared store's proposals in its request and merges or drops them; a
  person's go to that person's next conversation turn instead. Proposals no turn takes go after
  14 days. `NativeMemoryGrant.trusted` tells the Worker Host which turns only propose.
- Every turn's memory paragraph now describes the harness's memory as the Tag's memory: where it
  is and who sees it, whether the turn's changes are the Tag's own or proposals, the daily review,
  and where people see and delete it. A Codex turn is told to keep its memory current, whatever
  Codex's rule to add to memory only when asked.
- `supertag get memories` lists only memory, under `memories`, `unavailable`, and `kept_on`, and
  `delete memory --tag TAG` drops all of a Tag's memory; the desktop app's Tag details and the
  terminal app's Memory panel show only memory.

### Fixed

- A Codex Tag's daily review folds in the notes kept since the last review. Codex consolidates
  only what changed since its last consolidation, measured against a git baseline in its memory
  folder, which SuperTag didn't keep, so after a Tag's first consolidation every later review
  found nothing new. The Tag's store now keeps the folder as Codex last consolidated it, and the
  review starts Codex from that baseline.

### Removed

- Notes: the `remember` and `forget` tools, `Memories.List`, `Get`, and `Delete`, the
  `AttemptMemory.Remember` and `Forget` and `HarnessMemory` services, the `Memory` and
  `MemoryState` messages, `WATCH_KIND_MEMORY` and `supertag watch memory`, the notes in a turn's
  context, and the desktop and terminal apps' notes. Migration 121 keeps each note that took
  effect as a seed for its Tag's harness memory and drops the notes tables.
  `AttemptCapabilities.may_remember` is now `memory_trusted`, and `NativeMemoryGrant.seeds` and
  `AttemptMemory.AcknowledgeSeeds` are new. `supertag get memories --native` and
  `delete memory --native TAG` are gone.

## [0.3.3] - 2026-11-19

### Added

- Mailbox messages have a type: `send_message` takes an optional `type` of `note` (the default),
  `question`, `blocker`, `evidence`, or `decision`, and `read_mailbox` shows it. To ask a question
  or raise a blocker, a Tag sends a direct message, which always wakes its recipient within the
  wake limits. Every inbox turn of a Team member now opens with a digest of its Team's Workstream
  posts it has not seen, addressed posts first; it holds about 8 KiB and points to
  `read_workstream` for the rest.
- Wake limits keep Tags from waking each other in loops: by default 3 wakes between two Tags for
  one originating Task, 20 wakes of a Tag by other Tags per hour, and 60 per Objective per hour,
  overridable with a Team manifest's `spec.wakeLimits`. Over a limit nothing is dropped: notes
  wait for the recipient's next turn, questions and blockers arrive late, the sender's result says
  why in `wake_deferred`, and the operator Inbox gets one item (`supertag get inbox-item --kind
  wake-limit`). Notes and questions now
  wake their recipient after about 3 seconds so a burst lands in one turn; blockers and commit
  review requests wake it at once, and inbox turns take the most urgent messages first.
- `supertag watch message` streams a notice for each Tag's direct message as it is sent. Mailbox
  messages, Workstream posts, the inbox turns they start, and a person's read mark now reach open
  Watches and waiting Worker Hosts as soon as they commit, on every Control Plane replica, instead
  of at the next poll.
- `supertag tui [--gateway URL|NAME] [--state-directory DIR]`, and plain `supertag` in a terminal,
  start the terminal UI `supertag-tui` installed beside the CLI, after checking it is from the same
  release, and pass it no credential: it finds its connection itself, from the same saved Gateways
  and variables as the CLI, and the local services through `supertag __local-gateway`. The terminal
  UI, rebuilt on OpenTUI and React and compiled with Bun to replace the removed Go one, ships in a
  later release; until then plain `supertag` prints the help and says the terminal UI isn't
  installed.
- `sandbox-commands: [claude-code]` on a host service (`supertag worker-host --sandbox-commands`)
  runs Claude Code's commands in Claude Code's own operating-system sandbox: they write only the
  Workspace, never its `.git` or read-only and hidden paths, cannot read hidden paths or the home's
  credential folders such as `~/.ssh`, and have no network unless the Task has `web:fetch`. Such a
  host runs Claude Code Tasks with hidden paths and `commands:execute`, and is preferred over an
  `allow-unsandboxed-commands` host. It needs Claude Code 2.1.323 or later. `supertag init` sets it
  for a Claude Code lead wherever the sandbox can start and grants the lead `commands:execute`.
- `supertag workspace add [PATH]` adds a Git repository on this machine as a Workspace of the
  local Worker Host in `supertag.yaml` and restarts the changed services as `supertag up` does.
  The desktop app's New Tag form, connected to the local services, offers **Choose a folder…**
  as its Workspace, which runs it and starts the new Tag on the folder's branch.
- `supertag-ai/gateway-client` connects through a Gateway's WebSocket tunnel with a `wss://` or
  loopback `ws://` URL, and adds the `enrollments`, `memories`, `networkLogs`, `schedules`, and
  `taskFiles` clients. A Gateway from another release rejects with `ProtocolMismatchError`,
  which carries the Gateway's protocol versions and release; `negotiate()` checks before any call.
  Clients trust the operating system's certificate authorities where Node.js can read them, send
  HTTP/2 keepalive pings, time out connecting after 5 seconds (30 through a tunnel, or
  `connectTimeoutMs`), name their release with `buildVersion`, and accept any token of up to 8192
  ASCII characters without spaces, as the CLI does.
- `supertag ps` lists, under each Worker Host, one row per running Worker: its process ID,
  harness, slot, state (starting, executing, or finalizing), how long it has run, and its Task,
  Task Attempt, and Tag. `--output json` adds them as the host's `workers`. The Worklet keeps them
  in `workers.json` in the host's state directory, and `ps` shows none for a Worklet that died.
- Harness memory can be read and deleted: `supertag get memories` lists each memory Claude Code
  and Codex keep for a Tag on this machine's Worker Hosts beside its notes (`--native` for only
  those), with its kind, audience, trust, and the turn that last changed it; `describe memory
  hmem_…` reads one and `delete memory hmem_…` removes it from the harness's files. Each Worker
  Host keeps the records beside its stores, rebuilt from the files with no model call, and
  serves them over a socket in its state directory, never through the Control Plane. The
  desktop app's Tag details and the terminal app's Notes panel show and delete them, and
  `delete memory --native TAG` now drops this machine's copies at once.

### Fixed

- A conversation turn whose Task Attempt became uncertain no longer leaves the conversation stuck
  with nothing to do about it. The operator inbox showed only an Objective's uncertain Task
  Attempts; it now shows any Task's, conversation and Work Session turns included, as a
  `task-attention` item that names the Tag and Session, how many later turns wait, and the
  execution report's cleanup and completeness, and leaves when the Task Attempt is resolved. The
  desktop app's and terminal UI's "Interrupted: needs attention" turn, and the terminal UI's
  inbox, offer Retry and Mark failed once the Worker Host confirmed the turn stopped; a client may
  decide for its own turns (retrying only one that recorded no effect). SuperTag records an
  uncertain Task Attempt as failed on its own a minute after its lease lapsed when its host
  confirmed it stopped and it recorded no reply, message, delivery, artifact, or other effect,
  audited as `control-plane`, so the Session's next turn runs.
- A Codex Tag's ordinary turns no longer start Codex's memory consolidation agent in the
  background. Codex 0.163.0 started it at every turn until the Tag's memory had been consolidated,
  whatever `generate_memories` said, and spent unreported tokens on it, about nine times the turn's
  own in a measured one-line turn. Only the Tag's daily memory review consolidates now.
- The desktop app notifies a Tag's reply to your own message when you opened another Tag's
  conversation while it worked; it notified only replies that came with a new message.
- A Worker hides a secret from its Worklet's environment again when a harness repeats it, such as
  a provider key it does not inherit. It had stopped doing so once Workers no longer inherited the
  Worklet's whole environment.
- The desktop app's New Tag form offered only the lead's harness, because `supertag init` set up
  the local host with that harness alone. `init` now gives the host every installed harness that
  is signed in, and on a machine already set up offers to add the ones it lacks. A Tag created in
  the desktop app now gets `files:read`, which Claude Code needs to read files, and a Claude
  Code, Cursor, or OpenCode Tag gets `commands:execute` only when a host lets that harness run
  commands, as `init` does for its lead. Offline hosts no longer add stale harnesses and
  Workspaces to the form.
- On PostgreSQL, each Control Plane replica's stream push `LISTEN` connection now gets the same
  TCP keepalives and idle limits as its pool's connections, so PostgreSQL probes it too.
- A Worker whose connection to the data endpoint times out now logs `the data endpoint URL is
  unreachable: connection timed out after 5s`, naming the endpoint as a refused connection does,
  instead of tonic's bare `timed out`.
- When another program takes the port `supertag up` chose for the local Gateway before the Gateway
  listens on it, `supertag up` now says which port was taken and to run it again, which chooses
  another.

### Changed

- A Task whose Worker was lost mid-turn now runs again on its own. When the restarted host proves
  every process of the lost Task Attempt stopped, the Control Plane redelivers the Task, keeping
  its ID, as a new Task Attempt after 5 seconds, then 30: from a fresh checkout, resuming the
  Session's last checkpoint or recap, with a prompt that quotes what the lost run already said.
  It does not when the lost run left an external write in doubt, started a delivery, published an
  artifact, sent its reply, ran an action that needed approval, or may have run a command with the
  network reachable outside a sandbox, nor after three Task Attempts. The Task then fails with an
  unknown outcome that says why, and the operator inbox shows a `task-attention` item naming the
  Task, its Tag, and the reason. Before, every reclaimed Task Attempt failed and never ran again.
- Every turn, a Work Session's own turns included, now starts with one short paragraph on how the
  Tag's memory works: notes and who sees them, the daily review, whether the turn can change
  notes, and its harness memory, where that lives and that a Work Session on another harness
  doesn't share it. A Codex turn is told that Codex's rule to add to its memory only when asked
  doesn't apply to notes; this replaces its one-line reminder to search its memory. The paragraph
  also says where people see and delete the harness memory.
- Codex turns pin `memories.version="v1"`, the memory folder SuperTag carries, so a Codex
  release that defaults fresh profiles to `memories_v2` doesn't leave the Tag's memory unread.
- A wake limit that trips now also sends one operator notification through the configured
  destinations, naming the Tags, the limit, and how many messages wait, with the command
  `supertag get inbox-items --kind wake-limit`; messages it holds later send no more. The
  `wake-limit` Inbox item also names the Tags the first held message went between.
- A question, blocker, or review request the mutual wake limit held back now arrives when its
  originating Task ends, instead of always an hour later; an hour stays the longest it waits.
- A Workstream post wakes nobody, not even the Tags it addresses: addressing a Tag counts as a
  mention and puts the post first in that Tag's next digest. Posts have no type. The `post` tool
  says so and points Tags to `send_message` for questions and blockers, and the Mailbox shows an
  addressed post as handled once a digest showed it.
- New Tags get web access (`web:fetch`) by default: they can read web pages, and their commands
  can reach the network. `supertag init` grants it to the lead on every harness but Cursor, except
  on a local-vm host, and says how to remove it. The desktop app's New Tag form has a **Web
  access** switch, on by default. A Tag without `web:fetch` hears so at the start of each turn, so
  it names the missing permission instead of refusing vaguely.
- A person's conversation with a Tag numbers its own messages from 1, and its
  `conversation_id` no longer names a Session. Upgrading gives every conversation a new ID, so the
  terminal UI, the desktop app, and other clients read each conversation again once. Your read
  mark is kept once per conversation for all of your clients, and `ListConversations` counts
  unread replies from that mark and ranks conversations by when they were last active.
- Upgrading moves Mailbox, Workstream, and conversation history onto the new message tables in
  one transaction when the Control Plane starts. With 100,000 messages this took about 2 seconds
  on SQLite and 7 seconds on PostgreSQL, and needed free disk of up to three times the database's
  size until it committed.
- A Gateway no longer polls for replies once a second. `ClaimReply` takes `wait_ms`, and the
  Control Plane holds a claim that finds no due reply until one is due, for at most 8 seconds,
  then answers empty. A held claim writes nothing while it waits, so an idle Surface account no
  longer writes to the database every second, and a reply goes out as soon as it is due. Slack
  still claims progress updates once a second. See
  [Delivering replies](docs/reference/connector-contract.md#delivering-replies).
- A host's `concurrency` is now the machine's total: how many Task Attempts it runs at once
  across all its harnesses, instead of that many for each harness. Its harnesses share the
  slots, so one harness with no work leaves them to the others. A host service's
  `harness-limits` caps one harness within the total, such as `{claude-code: 1}`, and
  `supertag worklet` takes `--harness-limit N` among a harness's arguments; by default a harness
  may use every slot. `supertag init` still writes `concurrency: 3`, now three Task Attempts in
  all, so raise it if you relied on three for each harness. A Worker Host reports its pool as its
  capacity, so `supertag ps` shows `1/3 Task Attempts` where a host with two harnesses showed
  `1/6`. This changes the protocol to 7: a Worklet or Control Plane from 0.3.2 cannot connect, so
  upgrade them together. Slot directories are numbered, `slots/0/`, each with a `harness` file; a
  Worklet moves a slot named after its harness to `retired/` and fences its Task Attempt, so let
  running Task Attempts finish before upgrading. See
  [Host concurrency](docs/reference/supertag-yaml.md#host-concurrency).
- `supertag worker-host` is now `supertag worklet`, named after the Worklet it runs, with no
  alias. Update systemd units, container commands, and scripts that start a standalone Worker
  Host. `supertag up` starts the new command itself. See
  [CLI reference](docs/reference/cli.md#supertag-worklet).
- A Worker starts from an allowlist of its Worklet's environment: the process basics, the
  transport's proxy and TLS variables, `SUPERTAG_STATE_DIR`, and the variables its own harness's
  configuration reads. Other harnesses' variables, such as `CODEX_HOME`, and other harnesses' MCP
  and sandbox provider variables no longer reach it. A Worklet started with a provider key in its
  environment now hands it to its Workers in their assignment. A Worker's stop deadlines follow
  its Task Attempt: capture gets the harness's time limit again, from 5 to 30 minutes; a lost
  lease gets the lease the Control Plane last granted; and a remote sandbox or shared execution
  adds its provider's stop calls to the lost-lease and post-outcome deadlines.
- Conversation follows and operator Watches are pushed once a change commits. One reader per
  Control Plane replica serves every open stream, in place of a poll per stream: 300 ms per Watch
  and 2 seconds per follow. On PostgreSQL, replicas wake each other with a content-free
  `NOTIFY`, and each replica holds one `LISTEN` connection outside its pool while it serves a
  stream, so allow 9 connections per replica and connect directly or through a session-mode
  pooler. A lost notification delays a stream by at most about a second. `supertag message`
  resumes a dropped follow from what it showed instead of reloading the newest page. Streamed
  reply text still reaches only the clients of the replica that received it. See
  [How streams deliver](docs/reference/control-plane-api.md#how-streams-deliver).
- A Worker Host runs one Worklet, which registers the host once and starts a Worker process of
  its own for each Task Attempt, up to `concurrency` at once. `supertag up` supervises one
  Worklet per host service instead of one process per unit of concurrency, and resizes its pool
  without a restart. The Worker never receives the host credential: it asks its Worklet for the
  few host calls its Task Attempt needs, and dies with its Worklet. The Worklet keeps one journal,
  with a directory per slot under `slots/` in the host's state directory; the old `lanes/`
  directories are not read, so let running Task Attempts finish before upgrading. `supertag
  worklet` takes `--concurrency`. See [Worker Host reference](docs/reference/worker.md#process-supervision).
- A Worker sends its Task Attempt's events, streamed text, and other data calls to the data
  endpoint the Control Plane names, and nowhere else. Under `supertag up` that is the local
  Gateway. A hosted Control Plane names the Gateway in `SUPERTAG_DATA_ENDPOINT`, and every Worker
  Host must reach that URL; unset, Workers use the Control Plane. An unreachable data endpoint is
  retried while the lease lasts and logged as `the data endpoint URL is unreachable`. See
  [Worker Host reference](docs/reference/worker.md#data-endpoint).
- The desktop app is now built on Electron and needs macOS 13 or later (it needed macOS 11). The
  Debian package installs an AppArmor profile so the app's sandbox can start on Ubuntu 23.10 and
  later, and replaces the earlier `super-tag` package. See
  [Install the desktop app](docs/operations/install.md#install-the-desktop-app).

### Removed

- The Linux AppImage of the desktop app. On Linux the desktop app ships as a Debian package for
  amd64 and arm64.
- The terminal UI (`supertag tui`, and plain `supertag` opening it) is removed; plain `supertag`
  prints help. Use the desktop app or the CLI's commands: `supertag message` to talk to a Tag,
  `supertag status` and `supertag get inbox-item` for what waits on you, `supertag question answer`
  and `supertag approval` to answer and decide. The native archive no longer carries
  `supertag-tui`. `supertag connect` saves Gateways in `supertag/gateways.json` in the user
  configuration directory; save a Gateway saved earlier again.

## [0.3.2] - 2026-11-18

### Added

- `supertag message TAG [TEXT]` sends a message to your conversation with a Tag, the same
  conversation the terminal UI and the desktop app show, and prints the reply as it arrives.
  Without the text it reads standard input; `--no-wait` returns once the message is accepted.
  It names the command to run on standard error when the Tag waits for your approval or asks a
  question, and when the connection to the Gateway is lost.
  `task submit` now names the command when it refuses your conversation's own Session.
- When the desktop app can't connect because this machine's local services run an older
  SuperTag release, it offers "Restart SuperTag with VERSION". After a confirmation that running
  Tasks are interrupted, it runs its bundled `supertag down` and `supertag up` against the same
  state directory, which migrates the database, shows each step, and connects. A failure shows
  what the CLI printed. A remote Gateway from another release still gets the error alone.

### Changed

- New Tags get web access (`web:fetch`) by default: they can read web pages, and their commands
  can reach the network. `supertag init` grants it to the lead on every harness but Cursor, except
  on a local-vm host, and says how to remove it. The desktop app's New Tag form has a **Web
  access** switch, on by default. A Tag without `web:fetch` hears so at the start of each turn, so
  it names the missing permission instead of refusing vaguely.

- SuperTag now speaks protocol 6; 0.3.1 spoke protocol 5. Upgrade the Control Plane, Gateways,
  Worker Hosts, and clients together: a 0.3.1 Worker Host, CLI, terminal UI, or desktop app is
  refused when it connects to a newer Control Plane, and the error says which side to upgrade.
  Drain 0.3.1 Worker Hosts before upgrading the Control Plane. The Task Attempt data requests no
  longer carry Task Attempt or lease token fields, and the host-wide artifact source calls moved
  to a new `ArtifactSources` service. Harness adapters need no change.
- A Gateway forwards a running Task Attempt's data calls, such as its events, streamed text, and
  questions, to the Control Plane under the Task Attempt credential, and never a Worker Host's
  registration, claim, lease, or transfer calls. Set `SUPERTAG_DATA_ENDPOINT` on the Control Plane
  to a Gateway URL to name it to each Worker Host in `RegisterHost`. Workers do not use it yet.

### Fixed

- First-run messages point to the right step. Before `supertag init`, plain `supertag`, the
  terminal UI, `supertag ps`, `supertag up`, and every operator command say SuperTag isn't set up
  on this machine yet and name `supertag init`, instead of `supertag up`. The terminal UI's empty
  Local Gateway names `supertag init` too.
- `supertag init` and `init --check` say when this `supertag` has no Node bridge for Claude Code,
  as a CLI built from a checkout has none, and name the directory it belongs in, before writing
  `supertag.yaml`. With only an outdated Claude Code, `init` says to run `claude update`, not to
  install Node.js. Every message names one Claude Code installer,
  `curl -fsSL https://claude.ai/install.sh | bash`, and the `.env` hints name the state directory
  in use.
- `supertag init --check` works without `--json` and prints a readable report. Rerunning `init`
  on a set-up machine ends with the Tag that works there and how to talk to it.
- Errors from SuperTag's services print their message alone, without the gRPC status code text.
  `task submit` refuses a conversation's own Session in plain words: talk in your conversation
  from the terminal UI or desktop app. `supertag up` names the address another program holds.
- The desktop app's install command installs the CLI of the app's own version, and its setup
  screen no longer says "this Mac" on Linux.

### Security

- Each running Task Attempt gets its own credential. `WorkerHost.StartTask` returns a Task
  Attempt credential (`stat_…`) for that Task Attempt alone, and the Control Plane stores only its
  digest. Its events, text, questions, usage, network log, and the `Attempt…` services accept only
  that credential, and only while the Worklet holds the lease: finishing, reclaiming, a lapsed
  lease, revoking the host, or a new host registration ends it. The host credential no longer
  reaches those calls, and the Worker never holds it, so the code running a Task Attempt cannot
  claim, start, or finish work, or touch another Task Attempt.

## [0.3.1] - 2026-11-18

### Added

- Claude Code Tasks run the Claude Code you installed, the `claude` on `PATH` (or `--claude-path`),
  instead of a copy the release carried inside its Claude Code bridge. `supertag init` and the
  desktop app's setup screen refuse a Claude Code older than 2.1.280 with `claude update`. The
  release and the macOS app are about 200 MB smaller.
- Releases include the desktop app for Linux, as an AppImage and a Debian package for amd64 and
  arm64 (`SuperTag-VERSION-linux-ARCH.AppImage`, `.deb`). It uses the `supertag` CLI from the
  install script.
- Releases include the desktop app for Macs with Apple silicon as a signed and notarized disk
  image, `SuperTag-VERSION-darwin-arm64.dmg`, beside the CLI archives. The app carries its own
  `supertag` CLI, terminal UI, and Node.js bridges, so it needs no separate install, and sets
  SuperTag up on first launch.
- A Task that acquires a capture whose producing Worker Host can't serve it reads the file from
  a verified Volume copy instead: through a presigned GET for an S3 Volume, or through its own
  `--volume` mapping for a file Volume.
- A Session checkpoint kept on a Tag's Volume is deleted from it once the Control Plane drops
  the checkpoint: by the Control Plane for an S3 Volume, whose credential now also needs
  `DeleteObject`, and every 10 minutes by a Worker Host that maps a file Volume.
- The desktop app shows a running Task's files under **Files** in its activity panel when the Task
  runs on a Worker Host on the same machine: folders, read-only text files, and Show in Finder;
  binary files are listed only. The app reads them from disk after `TaskFiles.Locate`, which returns
  only where the files are; a Task on another machine says "Files on Worker Host NAME are
  unreachable from here".
- Claude Code, Cursor, OpenCode, and Codex Tasks can run in local-vm containers on the Worker
  Host's own Docker (`environment: local-vm`, or `supertag worker-host --local-vm`): their file and
  command tools run in a container with no network and no root, while the harness and its keys
  stay on the host. Podman is refused for now, because it gives a Task more privilege than local-vm
  promises. `supertag init` offers containers when Docker is running, defaulting to no, and a
  Task that runs commands goes to a waiting local-vm host before an unsandboxed one. A scoped
  `web:fetch` reaches its hosts through the same relay as Modal's, and a local-vm host can take
  `network-credentials`. OpenCode now also runs with its Workspace in an E2B or Modal sandbox.
- Claude Code's own memory is on and lasts per Tag: the Worker Host keeps a shared store and one
  per person, copies it into each turn and merges it back afterwards, file by file. `supertag
  describe tag` shows each host's copy; `supertag delete memory --native TAG` resets it.
- A Tag keeps its work on a Volume beyond any one Worker Host (`supertag tag put --volume NAME`,
  `spec.volume`): the capturing host writes a copy of every capture there itself, and the
  Control Plane never maps a Volume or carries a Volume byte. For an S3 Volume the Control Plane
  presigns one 15-minute PUT per file that binds its length and SHA-256 checksum, and checks each object
  with a HEAD before the capture succeeds; its signing credential lives in the Control Plane's
  credential vault (`supertag volume credential set`). A file Volume is written only by hosts
  that map it (`supertag worker-host --volume ID=DIR`, `volumes:` on a host service), which carry
  the label `volume:ID` that placement requires, and the writing host's check stands as its
  attestation. A capture whose copy cannot be written fails. A new host call,
  `VolumeObjects.Grant`, lets a running Attempt write its reserved Session checkpoint to the Tag's
  Volume and read the Session's current one back, under the same keys as a host's own storage.
- Unprompted messages are paced: at most one reaches a person's conversation or a surface thread
  in 30 minutes. Later ones wait and go out together when the window ends, or at once when the
  person writes; in a surface thread they post as one reply listing the earlier updates.
- GitHub review landings: a Workspace with `land: {review: {base}}` opens a draft pull request
  for each work Session and updates it on later Tasks; merging it closes the work Session
  (`closed: pull request merged`); one closed without merging leaves it open for a revision.
  `supertag workspace credential add NAME --github-app` stores a GitHub App whose per-operation
  tokens are narrowed to one repository and one permission.
- The desktop app's Tag details open with **Activity**, and the terminal UI's command palette has
  **Activity**: how the Tag's unprompted messages landed over 30 days (posted, read, answered,
  stayed quiet) and its start rate with the starts in the current window.
- A Task continuing a Session whose last delivery is on an offline Worker Host says so:
  `describe task`, `placement explain` and the conversation name the host it waits for
  (`workspace-holder`) instead of retrying silently.
- A work Session may run on another harness than its lead: `start_session` takes an optional
  `harness`, and the work Session runs only on a Worker Host bound to the Tag that offers it.
- Operators see a Tag's network log, the web requests its Task Attempts made through the Worker
  Host's egress proxy, allowed or refused, in the desktop app's Tag details under **Network** and
  under **Network** in the terminal UI's command palette.
- Start rates cap how often a Tag's Task Attempts start, such as at most 10 an hour, to smooth
  bursts like many Schedules coming due at once: `supertag tag put TAG --start-rate 10/1h`, or
  `spec.startRate` in a Tag manifest. A Task over the rate stays queued until the window has room,
  and says when it can start; a person's message always starts. `describe tag` shows the rate and
  the starts in the current window, and `placement explain` reports `start-rate`.
- Claude Code can keep a Task's Workspace in an E2B or Modal sandbox, like Cursor
  (`supertag worker-host --harness claude-code --e2b-workspace-provider ...`): Claude Code runs on
  the host with no built-in tool, and its file and command tools run in the sandbox.
- Network scopes apply to commands in Modal Workspaces: a Cursor or Claude Code Task with a scoped
  `web:fetch` and `commands:execute` reaches only the hosts it allows. The sandbox keeps no network,
  DNS included; a relay in it carries each connection over Modal's command channel to the
  Attempt's egress proxy on the Worker Host, which checks it and swaps credential placeholders,
  so Modal hosts can take `--network-credential` too. E2B Workspaces carry the same relay over
  E2B's command channel, proven against a test double that runs the real relay, not yet live.
- Cursor and Claude Code Tasks with an E2B or Modal Workspace can run commands
  (`commands:execute`), in the Task's sandbox, without `allow-unsandboxed-commands`. The sandbox
  has no network access. Each command stops at its time limit inside the sandbox, and every
  process the Task left running is stopped before the Workspace returns. Files your ignore rules
  match (such as `node_modules/`) and any `.git` directory a command creates stay in the sandbox;
  the Task output directory always returns. A Task whose Permission Sets hide paths does not run
  commands in a remote sandbox, and one with `web:search`, or a `web:fetch` without a network scope,
  doesn't run there.
- See and delete what a Tag remembers: the desktop app lists a Tag's notes in its details panel,
  opened from the Tag's name, and the terminal UI under Notes in the command palette. Each note
  records when a turn last had it in its context (`last_seen_at` in `supertag describe memory`),
  and `supertag watch memory` follows note changes. The daily memory review now runs read-only,
  keeping only `files:read` of the Tag's actions.
- Search opens a command palette (the search button beside +, or ⌘K) that finds Tags by name,
  latest message or cached message text, and runs actions such as New Tag, Control Plane
  switching and notification levels. It replaces the sidebar's search box. The terminal UI's
  Ctrl-K palette has the same sections.
- `supertag metrics` reports how long the Control Plane takes to admit each surface's events
  (admitted, failed, total and longest time, and how many took over 2 s), counted per Control
  Plane process since it started.
- `supertag describe task` and `supertag get task` show operators why a Worker Host failed a Task
  (`failure_detail`: up to 8 redacted one-line reasons). People who aren't operators and surface
  replies still see only the fixed failure message.
- A Microsoft Teams message from a channel connected to a different Tag gets one notice in its
  thread naming the connected Tag, instead of no answer.
- Slack and Lark event-ID receipts are deleted after 7 days. Message receipts are kept, so a late
  redelivery still reaches its original Task.
- Network scopes take `https://*.example.com` wildcards for every subdomain and `paths`, URL
  path prefixes such as `/repos/acme`, on a `web:fetch` grant. Claude Code Tasks with a network
  scope run their commands in Claude Code's own sandbox, which sends their traffic only to the
  Worker Host's egress proxy, and SuperTag checks each `WebFetch` URL; such a scope cannot name a
  credential. A Claude Code host reports whether it can run the sandbox: on Linux it needs
  bubblewrap and socat.
- A Workspace landing queued because the Worker Host holding its delivery was offline retries as
  soon as that host is back, instead of waiting for the next minute's retry.
- `supertag placement explain` names each Worker Host's own reason a Task can't run there: `harness`, `file-scope` or `unsandboxed-commands`.
- A Tag speaks when it has something to say. A turn no person is waiting on (a Schedule's
  wake-up, an Objective's notice, a memory review, or an inbox turn) may end with a new
  `stay_quiet` tool on Claude Code, Codex, Cursor, and OpenCode: nothing is posted to its
  conversation or thread and nothing counts as unread, while `supertag describe task` still shows
  it ran (`quiet: true`). A person's message is always answered. `supertag describe tag` shows
  how the Tag's unprompted messages of the last 30 days landed (posted, read, answered, quiet),
  and a Schedule's wake-up prompt says how its last fires did. A Schedule's turn shows in the
  desktop app and the terminal UI only once it finishes, with no typing indicator while it
  runs, unless a message you send joins it.
- The desktop app notifies you when a Tag replies or asks a question in a conversation you are
  not looking at, and clicking a notification opens that Tag. The Dock badge shows your unread
  replies. Choose all messages, questions only, or off under Notifications in the Control Plane
  menu. The terminal UI sends a terminal notification (OSC 9) the same way, set with
  `SUPERTAG_TUI_NOTIFY` (`questions`, `bell`, or `off`), and counts unread replies in its status
  line.
- A Tag has at most 8 work Sessions open at once, across all its conversations and Objectives;
  set `maxWorkSessions` (1 to 64) with `supertag tag put --max-work-sessions`, a Tag manifest,
  or the New Tag form. A work Session stays open after it reports, for `continue_session`, until
  the Tag closes it with a new `close_session` tool, an operator runs `supertag session close`,
  `supertag fetch` pulls its delivery, its Objective closes, or it has had no activity for 14
  days (shown as "closed: idle"). Continuing an idle-closed work Session reopens it when the
  Tag is under its limit; other closes are final. At the limit, `start_session` starts nothing and returns the open work
  Sessions so the Tag can continue or close one; the turn goes on. The tool description, `supertag get session`, `supertag get tag`, the desktop app
  and the terminal UI show how many are open. On upgrade, finished work Sessions close
  except each Tag's four newest, which can still be continued.
- Permission Sets can scope web access. A `web:fetch` grant takes `hosts` (`https://` origins),
  `methods`, and a `credential`, the name of a secret configured on the Worker Host with
  `network-credentials` in supertag.yaml or `supertag worker-host --network-credential`. Each
  Task Attempt with a network scope runs an egress proxy on its Worker Host. The proxy allows
  only the scope's origins and methods, refuses non-public addresses, and swaps a credential's
  placeholder for the secret only in requests a grant naming it allows, so the secret never
  enters the sandbox. Codex enforces scopes in its sandbox through its managed network proxy;
  other harnesses and remote Workspaces wait with requirement `network-scope`, and so does a
  Task whose credential no host offers. Codex code-mode commands run under the same limits.
  `supertag describe task` shows the scope and each Task Attempt's network
  log of allowed and refused requests.
- Permission Sets can scope file access to paths. A `files:write` grant takes `paths` it may
  write and `exclude` entries that stay read-only; a `files:read` grant takes `exclude` entries
  that are hidden, with `*`, `**`, and `?` globs; both take `additionalDirectories` outside the
  Workspace. Codex enforces scopes in its sandbox, for commands too, with or without
  `web:fetch`; Claude Code, OpenCode, and
  remote Cursor enforce them in their file tools. The Worker Host fails a Task Attempt that
  changed paths outside its scope and names them. A Task whose harness cannot enforce its scope
  waits, and `supertag placement explain` reports a `file-scope` requirement. It now also
  reports `unsandboxed-commands` when no bound Worker Host lets the harness run commands.
- Tags follow up on their own. Ask a Tag to "check PR 412 again in two hours" or "summarize open
  work every Monday at 9", and it sets a Schedule with a new `schedule` tool on Claude Code,
  Codex, Cursor, and OpenCode. When it is due, the Control Plane queues the Tag's next turn in
  the same conversation or thread, and its reply appears as an ordinary message marked
  "Scheduled". Recurrences use cron in a time zone, at least an hour apart; missed occurrences
  fire once. An active Schedule keeps an Objective from counting as idle. Operators use
  `supertag schedule create`, `pause`, and `resume`, and `get`, `describe`, and `delete
  schedule`. A Tag schedules only when it holds the new `schedule:create` runtime action:
  `supertag init` and the desktop and terminal UI New Tag forms grant it, and operators add it
  to a Permission Set to let an existing Tag schedule.
- The desktop app lists a Tag's Schedules in the Tag details panel, beside its notes, and the
  terminal UI in a Schedules dialog; both show the next time, and pause, resume, or delete them;
  the lists follow a new `WATCH_KIND_SCHEDULE` Watch kind. Operators declare recurring Schedules in `kind: Schedule` manifests, which `apply --set --prune` manages
  like other resources, and replay missed occurrences with `supertag schedule backfill ID --from
  TIME`. `supertag init` writes the machine's time zone as the Control Plane's `time-zone` in
  `supertag.yaml`.
- A Tag's conversation shows each message the Tag writes while it works, as soon as it writes
  it: every Tag opens longer work with one short sentence saying what it is about to do. A status
  line under the turn shows its current step, such as a command it runs, in the terminal UI and
  the desktop app; in Slack, the acknowledgement shows the Tag's latest message until its reply
  replaces it.
- An Objective's owner finishes it on the built-in harnesses: Claude Code, Codex, Cursor, and
  OpenCode offer a `report_objective` tool on the owner's turns. It reports the Objective
  `ready_for_review`, `completed`, or `blocked` with a summary, which becomes the turn's result.
  Before, Objectives on these harnesses could not finish on their own and ended `blocked`.
- When a Task fails, the Worker Host log names the failure and shows the last lines its harness
  adapter wrote to standard error, secrets hidden.
- The terminal UI and the desktop app find the local Control Plane that `supertag up` runs from
  `SUPERTAG_STATE_DIR` or `~/.supertag` and list it as **Local**. It connects with no token to
  enter, and each opens it at launch when no saved Control Plane was last used. The local
  operator token is read at each connect and never saved. When no local Control Plane runs, both
  say so and name `supertag up`; the saved Control Planes stay available. Running `supertag-tui`
  directly finds it too.

- A Tag can reread what happened during an earlier turn: the `read_turn` tool, on every built-in
  harness, pages a visible finished turn's messages, activity, and progress
  (`AttemptTagSessions.ReadTurn` and `HarnessTagSessions.ReadTurn` for adapters).

- A Tag keeps Memory: short notes of what it cannot look up again, written with the new
  `remember` and `forget` tools on every built-in harness and loaded into each turn as state, not
  instructions. A note written in a person's conversation stays private to that person. A change
  applies when its turn succeeds. Limits: 500 characters a note, 40 notes and 6,000 characters a
  turn sees, 10 changes a turn. Once a day, after ten finished turns, the Tag reviews its shared
  Sessions in a quiet turn in its `memory:TAG` Session and tidies its notes. `supertag get
  memories`, `describe memory`, and `delete memory` read and delete notes; `spec.memory: false`
  and `supertag tag put --memory false` turn Memory off. The `Memories`, `AttemptMemory`, and
  `HarnessMemory` services, `AttemptCapabilities.may_remember`, and `Tag.memory` are new.

### Changed

- New Tags get web access (`web:fetch`) by default: they can read web pages, and their commands
  can reach the network. `supertag init` grants it to the lead on every harness but Cursor, except
  on a local-vm host, and says how to remove it. The desktop app's New Tag form has a **Web
  access** switch, on by default. A Tag without `web:fetch` hears so at the start of each turn, so
  it names the missing permission instead of refusing vaguely.

- A Codex Tag's daily review turn runs Codex's own memory consolidation and waits up to 3 minutes
  for it, so the notes the Tag's turns kept reach the summary Codex reads at the start of every
  turn. The review turn is reported unpriced, because Codex doesn't report the consolidation's
  tokens.
- Deleting a Volume sends the Session checkpoints and native memory still on it for deletion, and
  those Sessions and memory stores start fresh. A Volume can't move to another source while it
  holds either, or while objects at its old source wait for deletion.
- A person's turn shows its reply in the desktop app, the terminal UI, and its surface thread
  (Slack, Teams, Lark, GitHub, Linear) as soon as the harness finishes, instead of after the
  Worker Host delivers the turn's changes and checkpoint: the reply is the running Task's result,
  the conversation is no longer working, and the thread's acknowledgement is replaced by it. A
  delivery that then fails shows its error beside the reply in the app, and as a message of its
  own after the reply in the thread.
- A Worker Host that runs Cursor's commands without a sandbox warns as it starts that Cursor's API
  key stays readable to them: unlike Claude Code's and OpenCode's, it can't go behind the
  provider proxy.
- A Session's next Task goes first to the Worker Host its last Task finished on through every
  Control Plane replica, and after a restart: warm Sessions are recorded in the database
  (migration 0114) instead of one process's memory. A replica that does not hold the warm host's
  waiting claim leaves the Task to it for 2 seconds when that host is ready with a free slot for
  the Task's harness.
  provider proxy. The Worker Host now hands that key to the Cursor adapter in a private file the
  adapter reads and deletes, so it is in no process's environment. That closes accidental leaks,
  not a boundary.
- `supertag up` hands each Worker Host its harness's provider keys and tokens in a private file the
  host reads and deletes as it starts, instead of in its environment, and a Linux Worker Host marks
  itself non-dumpable. This keeps keys out of `ps eww`, `/proc/<pid>/environ`, and core dumps: it
  closes accidental leaks, and is not a boundary against commands run without a sandbox.
  `supertag worker-host --provider-credentials-file` takes the same file.
- `supertag init` suggests local-vm containers for Claude Code, Cursor, and OpenCode and asks
  whether to run commands without a sandbox instead, defaulting to no; `--yes` no longer allows
  it. Choosing it, and starting a Worker Host with `allow-unsandboxed-commands`, prints what
  those commands can reach.
- A SQLite Control Plane commits through a write-ahead log (still `synchronous = FULL`, so every
  commit stays durable). Commits sync once instead of rewriting a rollback journal, so Worker
  Hosts' writes keep up on a busy disk and operator reads no longer wait seconds behind them.
  The database gains `-wal` and `-shm` files beside it, owner-only like the database; back up the
  whole state directory after `supertag down`, as before. An existing database switches the first
  time the Control Plane opens it.
- `start_session` no longer takes `workspace`: a work Session always works in the Workspace of the
  Task that started it, including on another Tag. Only an Objective's own turn is offered `tag`,
  and the tool says which harness a work Session keeps when it names none. A refusal the model can
  act on, such as a Tag outside the Objective's Team, a turn that can't delegate, or the Work
  Session limit, comes back with its reason instead of "could not be confirmed".
- Worker Hosts deliver Workspace changes themselves. Every delivered Task's Session branch
  `supertag/session/...` is pushed to a remote Workspace's server by the host that ran it, with a
  short-lived credential the Control Plane mints for that one push; `land` adds only a merge or a
  review. A local Workspace's host writes the Session branch into the mapped repository. The
  Control Plane reads each landed branch back and records it if the branch was changed outside
  SuperTag.
- The examples, now directly under `examples/`, follow SuperTag's positioning. `reliability` shows a proactive Tag
  that owns four ongoing Objectives (production errors, alerts, a red main, dependency
  advisories) with scoped network access to Sentry and GitHub, plus a read-only `support` Tag.
  `multiplayer` shows two teammates' Tags on their own machines and coding agents settling details
  with each other; in `reliability` the two Tags accept each other's messages, so `reliability`
  answers `support`. The examples use only Claude Code and Codex, and no local-vm containers: their
  Claude Code hosts set `allow-unsandboxed-commands`. Each example's outcomes live in
  its own `objectives.yaml`, applied when you're ready to start the work. `solo` and
  `mixed-harnesses` are removed.
- An Objective whose owner's turn ends idle twice stays `working` instead of becoming `blocked`:
  only the owner's `report_objective` changes an Objective's status from a turn. It shows "Idle
  since …" in `supertag describe objective`, the terminal UI's Objective view, and its owner Tag's
  **Activity** in the desktop app and the terminal UI, until a message or new work clears it.
- SuperTag adds less coaching to a Tag's turns: no per-turn note-keeping line, a shorter portfolio
  footer, tool results that state what was recorded without telling the model to stop, a Work
  Session's instruction sent as written, and report, start and budget messages without style or
  strategy directions.
- Session checkpoints live on the Worker Host that ran the turn, not on the Control Plane. A
  queued Task waits up to 10 minutes for that host; after that, or if it is offline, another
  host starts the Session from its recap (`placement explain` shows `checkpoint-holder`).
  Existing checkpoints are dropped on upgrade, so those Sessions restart from their recap.
- SuperTag now speaks protocol 5; 0.3.0 spoke protocol 2. Upgrade every service and client
  together. A CLI, terminal UI, desktop app, or Worker Host from this release refuses an older
  Control Plane when it connects, and the error names both releases and which to upgrade, for
  example: "This app speaks SuperTag protocol 5, but the Control Plane at http://127.0.0.1:3434
  runs SuperTag 0.3.0 (protocol 2). Upgrade the Control Plane." Before, a newer desktop app
  connected and then failed every conversation request.
- The terminal UI shows times of day on one 12-hour clock, "4:01 PM", in its Tag list, notes, and
  Schedules as in its conversation dividers. Esc closes the desktop app's Tag details panel.
- Workspaces deliver through git to any remote. A remote Workspace names a git URL, read and
  push Workspace Credentials (`supertag workspace credential add`: SSH key, HTTPS token or
  credential helper, kept on the Control Plane machine and never sent to Worker Hosts), and how
  work lands: `branch` (a `supertag/session/...` branch per Session) or `merge` into a target
  when a work Session closes, fast-forward only; a merge conflict returns to the Session as a
  follow-up Task. `supertag workspace check` tests the whole path without changing the remote.
  Local Workspaces take `land:` in supertag.yaml. Commits are authored by the Tag, with the
  requester as co-author. The protocol is now 4: upgrade every client, Gateway and Worker Host
  together.
- `stay_quiet` tells a Tag to stay quiet only when nothing changed since its last report: a small
  change or a resolved problem is still reported, and a known problem someone is handling is not.
- A turn that stays quiet records its `stay_quiet` note as its result in every harness, rather
  than whatever text it wrote first, so `describe task` says why it posted nothing.
- Clients connect to the Gateway, which forwards their calls to the Control Plane and authorizes
  each as the caller's own credential. `supertag up` always starts a Gateway. The CLI takes
  `--gateway` and `SUPERTAG_GATEWAY_URL` (Worker Hosts keep `--control-plane`); the desktop app
  and terminal UI add and switch Gateways; the SDK clients are `supertag-ai/gateway-client`
  (`createGatewayClient`) and Python `supertag.gateway_client` (`GatewayClient`). Saved Control
  Plane profiles are not carried over: add your Gateway again.
- A Tag keeps one harness: changing an existing Tag's harness is refused (create a new Tag
  instead), and a Session's saved state is no longer dropped for a harness change.
- Each turn's Workspace delivery bundle carries only what the turn added on top of its start
  commit (about 500 bytes instead of the whole history, 44 MB on this repository). A reader
  without the start commit, such as `supertag fetch` into another clone or a new host, gets a
  complete bundle that the holding Worker Host builds on request.
- A Worker Host claims its next Task without waiting for the previous checkout to be deleted;
  deletion happens in the background.
- Several quick messages get one answer. In Slack, Microsoft Teams and Lark, a message sent while
  the Tag works goes into its current turn when the harness supports that, as it already did in
  conversations. Otherwise the next turn reads every message waiting in the thread or
  conversation, up to 10 messages and 16 KiB, and answers them together. Three quick Slack
  messages now get one "Got it" and one reply instead of three of each. Only the message that
  starts a run is acknowledged, and the acknowledgement adds "Also reading your follow-up." when
  another joins it. The Tag's own turns, such as a Schedule firing, still run on their own.
- The Worker Host log says why an operation failed or fell back. A Task still gets the same
  fixed failure message, such as "Remote Workspace output could not be captured safely", but
  the host's own log now names the underlying error, redacted with the host's credentials. A
  warm remote Workspace preparation that is retried cold logs why it failed.
- When the lead Tag runs on Codex, `supertag init` adds `web:fetch` to the `local-tools`
  Permission Set and says so. Current Codex models run commands only in Codex code mode, which
  SuperTag starts only for Tasks that may also fetch from the web, so a Codex lead created by
  `init` could not run commands.
- `supertag init` writes `concurrency: 3` for this machine's Worker Host, so it runs up to three
  Task Attempts per harness at once. Before, it ran one, and one stuck Task held every Tag on that
  harness.
- Docker Compose runs PostgreSQL from its own overlay, `deploy/compose.native.postgres.yaml`.
  A deployment with an external database leaves it out and no longer needs
  `SUPERTAG_POSTGRES_ENV_FILE`; one that uses the `postgres.env` setup writes adds the overlay.
- A Permission Set that names a Tag as an approver (`tag:<id>`) is refused. Such an entry was
  accepted but never honoured: no Tag decides an approval request.
- The README's multiplayer diagram shows personal and shared Tags coordinating work across local
  machines, teammates' machines, and VMs.
- The desktop app shows the Control Plane's reason when it rejects a request as invalid, instead
  of "Check its values".

- `/goal <outcome>` is the one command that creates an Objective, in every conversation: the
  terminal UI, the desktop app, the conversations API, and Slack and Microsoft Teams channels,
  where it follows the app's mention (`@SuperTag /goal <outcome>`). The Control Plane creates the
  Objective itself, owned by the conversation's Tag and homed in that conversation or thread, and
  answers with its ID; the message never reaches a turn. In the terminal UI, `/goal <outcome>` is
  sent as a message, and `/goal` alone still opens the Create Objective form. Microsoft Teams
  threads can now start and steer Objectives as Slack threads do.
- `supertag describe objective` no longer says the owner reported a blocked Objective when the
  Control Plane blocked it after two turns ended with nothing running and nothing asked.
- Every Task event has a kind: `message` (a whole message the Tag wrote), `activity` (one line
  saying what it does), or `progress` (its plan). Harness adapters set `kind` on
  `Harness.Publish`, which refuses an event without one, and `supertag task events` prints it.
  OpenCode's result is the text after its last tool call; earlier text shows as messages.

- A long conversation no longer fails when its native session grows past the 16 MiB checkpoint
  limit. A Session keeps only its newest checkpoint. SuperTag drops it when it is over 8 MiB, for
  another harness, idle for 14 days, or its Objective ended 3 days ago, and on Codex when the
  Tag's tools changed. The next turn then starts a fresh native session from a recap of the
  Session's last ten turns, with the messages the Tag wrote in them, on every harness. A dropped
  checkpoint's file leaves the checkpoint directory. `AttemptHistoryEntry` carries `messages`.

### Removed

- `supertag fetch`, `land: branch` (it is now the default), and the Control Plane's delivery
  bundle relay.
- `--checkpoint-directory` and the Control Plane's checkpoint storage.
- `supertag volume copy` and the Control Plane's `--artifact-volume` and `--artifact-s3-volumes`:
  the Control Plane maps no Volume and no longer reads or writes Volume files. Starting it with
  either flag is refused with the replacement: `--volume ID=DIR` on the Worker Hosts that write a
  file Volume, and `supertag volume credential set` for an S3 Volume. Existing operator-made copies are dropped from the catalog; their objects
  stay under `attempts/` in the Volume, which you can delete.
- Client file downloads: `supertag artifact download`, `supertag task download`, `supertag volume
  download`, the desktop app's Task result files, the terminal UI's Task files view, and the SDK
  Gateway clients' download methods. The Control Plane no longer passes files to clients;
  `supertag get artifact` still lists them.
- GitHub Workspaces (`github:` spec, `--account`, `--repository-id`, `--pull-request-base`,
  the `SUPERTAG_GITHUB_*` publisher settings), their draft pull request publication and its
  approval, and choosing a repository from a surface message. A GitHub repository works as a plain
  remote with an HTTPS token Workspace Credential; pull requests now come from review landings
  (`land: {review: {base}}`).
- The Gateway's `desktop` notification destination, which notified the Gateway's own machine.
  `notify: desktop` is now refused; the desktop app and terminal UI notify on their device, and
  `webhook:` and `slack:` reach people away from them. A local `supertag up` configures no
  destination by default.
- The Python SDK's `supertag.worker` module and `examples/custom-worker`. SDKs provide harness
  adapters, not Worker runtimes; the composition interfaces the OpenAI Agents adapter uses stay in
  the `supertag` package.
- `@SuperTag objective <outcome>`; use `@SuperTag /goal <outcome>`.
- The `create_objective` tool, the `AttemptTagSessions.CreateObjective` and
  `HarnessTagSessions.CreateObjective` RPCs, and `AttemptCapabilities.may_create_objective`. No
  turn creates an Objective.
- Releases no longer include an Intel Mac (`darwin-amd64`) archive, and the installer script
  refuses Intel Macs. Build the CLI from source there, as
  [Install SuperTag](docs/operations/install.md#build-only-the-cli) describes.

### Fixed

- A Claude Code conversation picks up tools granted after it started. A resumed native Session
  kept the tools of its first turn, so after `commands:execute` was granted, the conversation
  still answered that it had no shell. A turn whose tools changed now starts a fresh native
  Session from the conversation's recap.
- A Tag whose message a recipient doesn't accept is told why: the recipient's
  `acceptsMessagesFrom` does not name it and they share no Team, with the `supertag
  mailbox-grant allow` command that permits it. Claude Code and Codex Tasks got only "refused"
  before. Both now also get the reason when a Task has sent its three messages.
- A Tag's inbox turn answers a Tag that needs an answer with `send_message`, as
  [Tag messaging](docs/guides/tag-messaging.md) describes. Codex Tags read the inbox's "sent
  nowhere" note as no way to reply, so the sender never heard back.
- A Task asked to create a file in the repository creates it in the checkout, where it becomes
  the Session's commit. The instructions used to say "Save deliverables in the Task output
  directory", and a Codex Objective saved a requested repository file there instead, so nothing
  was committed. The output directory is now described as only for files that aren't part of the
  repository, such as reports.
- A delivery leaves out new files in well-known cache and editor locations the repository doesn't
  track, such as `__pycache__/`, `*.pyc`, `.pytest_cache/`, `.venv/`, `node_modules/`, and
  `.DS_Store` (and `target/` in a Cargo repository), so a harness's test run no longer adds
  them to the Session branch. A tracked file there is delivered as before.
- Redaction no longer hides the word after "basic" in ordinary text. An Objective's assessment
  read "It has a Basic [REDACTED] and two edge cases"; only a `Basic` value that decodes to
  `user:password` is redacted now.
- `supertag placement explain` names a `model` requirement when no bound Worker Host lists the
  model a Task names, instead of calling those hosts eligible.
- A supertag.yaml Worker Host reports the execution profile its lanes claim with. A local-vm host
  no longer appears to run Claude Code commands unsandboxed in `placement explain`, and its
  Volumes and MCP servers show as labels in `supertag get host`.
- A Modal Workspace whose `SUPERTAG_MODAL_WORKSPACE_APP` names no existing app, or that is missing
  its configuration, now fails naming it, instead of "Remote workspace operation failed".
- A Codex turn no longer fails with `Codex emitted an unsupported event type: turn/diff/updated`
  when Codex 0.163.0 reports its running diff, or other progress it restates elsewhere. A
  notification a newer Codex adds that only reports progress (an update, change, delta, or
  progress report) is logged on the Worker Host and ignored; one that could carry a result or an
  approval still fails the turn.
- The first commit of a Session that follows a branch is authored by its Tag, with the person who
  asked as co-author, instead of by `SuperTag <supertag@localhost>`. Commits and merges of a
  Work Session credit the person who asked in the Session that started it.
- Commit subjects keep a Markdown link's text and drop its target, so a harness's link to its
  checkout path no longer lands in the repository's history.
- A client device that opens a Tag's network log is told that only operators can see it, in the
  desktop app and the terminal UI, instead of a raw refusal.
- The terminal UI shows a Schedule's reply as soon as the turn finishes, and updates the Tag list
  and sends its notification then, instead of only after a restart. A client device's Tag list
  also updates when its own turn finishes.
- A Codex turn that asks a read tool for an out-of-range page, such as `limit: 50`, gets a tool
  error it can retry instead of failing with "invalid coordination page".
- A Codex turn that called `stay_quiet` and then wrote no final text no longer fails with
  "Codex completed without a final response"; it finishes quietly with its note as the result.
- A Linux Claude Code host offers Claude Code's sandbox only when a user namespace can be made
  inside bubblewrap's, as the sandbox needs. A host whose AppArmor policy forbids it, such as
  Ubuntu's `bwrap-userns-restrict`, no longer takes scoped command Tasks it would fail.
- Claude Code no longer expands `@path` mentions in a Task's prompt, its joined messages, or its
  check-ins. A prompt that named a file, including untrusted text from a collaboration surface,
  put that file's contents in the model's context, whatever the Task's permissions; every message
  is now delivered as written.
- Text fields in the desktop app no longer draw a thick offset focus outline; keyboard focus on
  buttons and links is one subtle ring.
- A Watch naming a kind the Control Plane doesn't know follows the kinds it does know instead of
  failing, and the notes kind no longer overflows the kind mask in debug builds.
- A Claude Code or OpenCode Task that fails because a call to its Worker Host failed names that
  call's status in its result, as Cursor Tasks already do, such as `Claude checkpoint validation
  failed: Worker Host call failed: [permission_denied] … Native execution did not start.`, rather
  than only fixed text.
- OpenCode path scopes deny every letter-case spelling of hidden and read-only paths, so `SeCrEtS/key` no longer gets past a hidden `secrets/` on case-insensitive file systems.
- On Linux, a Worker Host no longer leaves the processes it stops for a harness as zombies. Its
  guardian kills descendants that left the adapter's process group and now reaps the last ones
  before exiting; in a container whose PID 1 does not reap, they stayed zombies.
- Codex installed with `npm install -g @openai/codex` no longer fails with "Codex version probe
  timed out". SuperTag runs the native Codex binary behind the npm launcher instead of starting
  Node for every Codex process, and gives the version probe the 30-second startup bound.
  `supertag sign-in codex` and `supertag init` print which Codex binary they use.
- A Codex Task with `web:fetch` runs under the same `supertag` permission profile as other Codex
  Tasks, with outbound network turned on, instead of Codex's `workspace-write` mode. Its
  read-write Volume copies are now writable, and `.git`, `.codex`, `.agents`, and `.aws` stay
  read-only in each.
- A Codex Task no longer fails with "Codex did not answer initialize within 5s" on a busy
  machine. The first exchange with the Codex app server, which also waits for the process to
  start, now has 30 seconds; later exchanges keep 5.
- Claude Code, Cursor, and OpenCode Tasks no longer fail with "Worker Host call failed:
  [canceled] Timeout expired" while the Worker Host waits out a slow Control Plane. The harness
  retries a call that the Worker Host's server timed out, as it already did for its own timeout.
- `supertag sign-in` handles Ctrl-C, SIGTERM, and a closed terminal from the moment its probe
  starts. A signal right after the probe started used to end the command without stopping the
  probe or removing its temporary home, which holds the harness credentials.
- A Slack, Microsoft Teams or Lark message the Tag refuses gets one short answer in the thread that
  says why, such as a paused Objective or a mention of another Tag in a thread that belongs to one.
  Before, a refused message was left for the provider to retry and then dropped, and the person
  heard nothing; an Objective's home thread answered with a reply that counted as a Task. Gateways
  now also acknowledge an event that can never be admitted, such as a redelivery with different
  content, instead of leaving the provider to retry it.
- Upgrading from 0.3.0 no longer strands the old services. `supertag up` restarts services that
  run another build of SuperTag with this CLI's executable, including under a per-user service
  unit, and prints `Restarted SuperTag: 0.3.0 (protocol 2) → …` and any database migration the
  new Control Plane ran. Before, it said the services ran with these settings and left the old
  release running. `supertag down` stops services whose Control Plane speaks another protocol or
  cannot be reached, without draining through it; Worker Hosts still stop gracefully. Before, it
  failed with the protocol mismatch, and only the old CLI could stop them. `supertag ps` and
  `supertag version` say when the services run another build. An older release started against a
  database a newer one migrated now names both schema versions instead of `unsupported Rust
  database schema`.
- An Objective with a currency budget runs on Codex, Cursor, and OpenCode Tags. Each turn used to
  carry the remaining budget as a cost limit those harnesses cannot enforce, so placement refused
  it and the turn stayed queued. Such turns now run without the limit; their reported cost still
  counts, and no new turn starts once the budget is spent.
- Security: a Codex Task with `files:write` or `commands:execute` could write the Workspace's
  `.git`, a directory or a linked worktree's `.git` file, when the Workspace sat under `/tmp` or
  `$TMPDIR`. Claude Code's and OpenCode's file tools could write `.git` in any Workspace.
  SuperTag later runs `git` there outside the sandbox. A rewritten Git directory that named
  another common directory could make that `git` run a filter on the Worker Host. The Codex
  adapter now keeps `.git`, `.codex`, `.agents`, and `.aws` read-only in every Workspace and
  Volume copy, and Claude Code's and OpenCode's file tools refuse `.git` writes. SuperTag's own
  Git reads refuse a checkout whose Git directory names another common directory, and never use
  the `ext` transport or an external diff the repository configures.
- Security: Cursor's file tools on a local Worker Host could write the Workspace's `.git`, and
  OpenCode's could write it spelled `.GIT`, which macOS treats as `.git`. Both now refuse any
  `.git` path in any letter case, in the Workspace and its Volume copies.
- A Codex Task signed in with `CODEX_API_KEY` or `OPENAI_API_KEY` no longer fails with `401
  Unauthorized`: the key is staged as the Task's Codex sign-in, because `codex app-server` ignores
  it in the environment. A model stream that Codex retries no longer fails the turn, and the
  Codex status line `Codex started` no longer appears in the reply.
- The terminal UI no longer shows harness status lines or raw plan JSON as reply text.

- The example organizations in `examples/organizations/` apply with the 0.3.0 CLI. Their Tags bind
  the Workspace with `workspace: {id, ref}`, the `review-team` verifier is placed with `runsOn` and
  host labels instead of `workerHosts`, Roles and Tags use `execution: {harness, models, efforts}`,
  each example declares its Team, and the Codex builders in `mixed-harnesses` get `web:fetch` so
  they can run commands on gpt-6-sol.
- A Claude Code, Cursor, or OpenCode Task no longer fails when its Control Plane is slow to answer
  for more than about 15 seconds, as a busy SQLite Control Plane can be. The harness waits for its
  Worker Host, which keeps retrying until the Attempt's execution authority ends.
- A Cursor Task that fails because a call to its Worker Host failed names that call's status in
  its result, such as `Cursor execution failed: Worker Host call failed: [deadline_exceeded] the
  operation timed out`, rather than only `Cursor execution failed.`

## [0.3.0] - 2026-11-14

### Added

- `supertag watch inbox-item` prints the operator inbox items already waiting, then each new one.
- `supertag delete KIND NAME --dry-run` checks a Team, Permission Set, Context Set, Volume,
  Workspace, or Surface Location deletion, including whether anything still uses it, without
  deleting it.
- Root turns can recall the Tag's other Sessions and its Objectives with `list_sessions`,
  `search_sessions`, `read_session`, `list_objectives`, and `read_objective`, and see the Tag's
  open Objectives in their context. A conversation turn that starts with
  `@SuperTag objective` can create that Objective with `create_objective`.

### Changed

- New Tags get web access (`web:fetch`) by default: they can read web pages, and their commands
  can reach the network. `supertag init` grants it to the lead on every harness but Cursor, except
  on a local-vm host, and says how to remove it. The desktop app's New Tag form has a **Web
  access** switch, on by default. A Tag without `web:fetch` hears so at the start of each turn, so
  it names the missing permission instead of refusing vaguely.

- The Control Plane stores no artifact or Workspace delivery bytes. Worker Hosts keep them in
  their artifact directory (`--artifact-directory`, which replaces `--artifact-source-directory`)
  and the Control Plane relays them to readers. Reading them needs the holding Worker Host to be
  connected, or a Volume copy. The Control Plane's `--transfer-directory` is replaced by
  `--checkpoint-directory`, which holds Session checkpoints only.
- `supertag init` binds the lead Tag's Workspace to the current branch instead of a fixed commit.
  On a detached HEAD it pins the commit.
- `supertag delete volume` no longer requires `--operation-id`.
- Every resource manifest and `put --file` specification spells its fields in camelCase, with one
  name per field. Role, PermissionSet, ContextSet, SurfaceAccount, and SurfaceLocation fields
  change from snake_case (`approval_required` is now `approvalRequired`, `item_key` is `itemKey`,
  `connector_account_id` is `connectorAccountId`, and so on). Roles and SurfaceLocations name their
  sets `permissionSets` and `contextSets`, and an Objective's owner is `ownerTagId`; the other
  spellings are refused.
- The installer script installs the native SuperTag release from GitHub Releases: a
  checksum-verified archive per platform holding the `supertag` command, the terminal UI, and the
  Claude Code, Cursor, OpenCode, E2B, and Modal bridges. Install with
  `curl -fsSL https://github.com/atemaguer/supertag/releases/latest/download/install.sh | sh`.
  It no longer needs npm, and Codex Tasks no longer need Node.js. The native release starts with
  new state and does not import earlier state; move `~/.supertag` aside first, as
  [Install SuperTag](docs/operations/install.md#upgrade-from-a-release-before-the-native-cli)
  describes.
- The `supertag-ai` npm package is the TypeScript SDK. It no longer carries the installer script
  or the terminal UI; install the CLI with the installer script.

### Fixed

- Cursor Tags with local command access use the Worker Host's Node and the project's pinned
  package manager to run checks.

## [0.2.0-alpha.9] - 2026-11-10

### Added

- Objective leads can delegate Workspace writes without write access, and cross-Team review
  verdicts appear on the Objective with the exact delivered commit.
- Modal Workers can mount writable Volumes and deliver Git commits from Codex Tasks. A Worker
  base image for Linux AMD64 and ARM64 is published to GitHub Container Registry.
- Release builds sign and notarize the macOS terminal UI for Apple Silicon and Intel.

### Fixed

- Control Plane shutdown waits for startup Session recovery before disconnecting storage.
- Both Fly.io deployment profiles locate the shared Control Plane Dockerfile when building from
  the repository root.

## [0.2.0-alpha.8] - 2026-11-10

### Added

- The Python SDK's `operator` extra includes synchronous and asynchronous Control Plane clients.
- Added a live two-Team Objective walkthrough with a Worklet restart, independent commit review,
  and operator acceptance.
- Added a runnable Objective walkthrough with an expected transcript showing delegation,
  a question, an approval, and work Session recovery after an injected Worker error.
- Completed work Session replies in Slack can show a result card with the recorded branch
  and a link to the pull request.
- Start an Objective from a Tag's terminal conversation with `/goal`.

### Changed

- New Tags get web access (`web:fetch`) by default: they can read web pages, and their commands
  can reach the network. `supertag init` grants it to the lead on every harness but Cursor, except
  on a local-vm host, and says how to remove it. The desktop app's New Tag form has a **Web
  access** switch, on by default. A Tag without `web:fetch` hears so at the start of each turn, so
  it names the missing permission instead of refusing vaguely.

- Setup and the quickstart now guide your first conversation through the terminal UI. If there
  are no Tags, SuperTag shows how to get started with `supertag init`.
- The terminal UI can send follow-up messages to an Objective's owner.

### Fixed

- Bundle the installer and matching terminal UI binaries in the public npm release so new users
  can install without GitHub repository access.
- Listing Auth Keys shows when each key expires.
- Manifest diff reports Role instructions that exceed the 32 KiB limit.
- A deleted Team can be created again with the same ID while preserving its revision history.
- Creating an Auth Key prints a valid Worklet join command.
- Retrying the same Objective creation in the terminal UI after a lost response
  reuses its ID, so it creates only one Objective.
- The terminal UI refreshes the Teams list and open Team details after Team edits.
- Work Session retries keep their recorded branch and commit. Pull request delivery holds when
  GitHub reports a merged, closed, or ambiguous pull request, and reports the pushed commit
  when delivery stops after a push.
- The terminal UI inbox detail pane follows the selection when an item is settled elsewhere,
  including after a failed action. The inbox distinguishes approvals that block a running
  Task Attempt from questions that wait for an answer in the next turn.

## [0.2.0-alpha.7] - 2026-11-09

### Added

- An experimental operator API in protobuf, `supertag.operator.v1`, served on the Control Plane API port with the Connect and gRPC-Web protocols: `POST /supertag.operator.v1.OrganizationService/GetStatus` with JSON, the same `Authorization: Bearer` credential, and Connect error codes carrying a stable `ErrorDetail` reason. `supertag connect control-plane`, `supertag status control-plane`, and `supertag verify deployment` call `GetStatus`. Generated clients ship in the repository for TypeScript and Go.
- Experimental conversation RPCs: `ConversationService.SendMessage`, `GetMessage`, `FollowMessage`, `ListConversations`, and `ListMessages` send a message to a Tag, read it, follow its reply and work Sessions as a resumable stream of typed events, and list your conversations and their history. `supertag message tag`, `supertag message objective`, and the terminal UI use them. `FollowEventAdapter` in `@supertag/operator-api` turns `FollowMessage` events into AI SDK UI message chunks for a chat UI built on the AI SDK hooks. `supertag message tag --output json` prints the `Message` in its proto3 JSON form, with `conversation`, `workSessions`, and enum values such as `REPLY_STATUS_REPLIED`. A message delivered into a running turn that never read it is followed as its own turn: `FollowMessage` sends `joined` with an empty `taskId`, and `supertag message tag` and the terminal UI show that turn's reply.
- Experimental inbox and Objective RPCs. `InboxService.ListInboxItems`, `ListApprovals`, `Approve`, `Deny`, and `AnswerQuestion` list what waits on a person, page through approval requests, decide them, and answer an Objective's question by its inbox item's `key`. Each inbox item carries its `occurrence`. `ObjectiveService.CreateObjective`, `ListObjectives`, `GetObjective`, `DescribeObjective`, `MessageObjective`, `UpdateObjective`, `ApproveObjective`, `CancelObjective`, `PauseObjective`, and `ResumeObjective` cover every Objective command; `DescribeObjective` adds each Session's Tag and its latest Task's report. Two operator actions are new, `create_objective` and `list_objectives`. Scoped coordination credentials call the RPCs that set `allow_scoped_credential`: every `InboxService` RPC, `EventService.Watch`, and `GetObjective`, `DescribeObjective`, `MessageObjective`, and `ApproveObjective`, for the Objectives in their scope only.
- Experimental work, Team and Mailbox RPCs. `WorkService.ListTasks`, `GetTask`, `ListTaskEvents`, `InspectTaskExecution`, `CancelTask`, `ListSessions`, `GetSession`, `ListSessionStates`, `GetSessionState`, `ListArtifacts`, `GetArtifact`, and `ResolveArtifactDownload` serve every Task, Session, and artifact command. A `Task` carries its Tag's name, and `GetSession` adds `delivery`: the latest delivering Task's branch with its base and head commits, its pull request, and the Worker Host whose checkout holds the branch. `TeamService.CreateTeam`, `ListTeams`, `GetTeam`, `UpdateTeam`, and `DeleteTeam` name Teams by name or ID and members by Tag name. `MailboxService.ListTagMessages`, `GrantMailbox`, `RevokeMailbox`, `ListMailboxGrants`, and `ListWorkstreamPosts` name Tags by name. The new operator actions are `read_task`, `cancel_task`, `read_session`, `read_session_state`, `read_artifact`, `download_artifact`, `read_team`, `manage_team`, `read_mailbox`, and `manage_mailbox`; scoped coordination credentials call none of these RPCs. Artifact bytes still move over plain HTTP from the Worker Host or Volume that holds them, never through the Control Plane.
- Experimental Worker Host, access, organization, and collaboration surface RPCs. `HostService.ListWorkerHosts`, `GetWorkerHost`, `EnrollWorkerHost`, `RotateWorkerHostCredential`, `RevokeWorkerHostCredential`, `DrainWorkerHost`, `ResumeWorkerHost`, `BindWorkerHost`, `UnbindWorkerHost`, `CreateAuthKey`, `ListAuthKeys`, `GetAuthKey`, `RevokeAuthKey`, and `JoinWorkerHost` serve every Worker Host and Auth Key command, and `supertag connect worklet --auth-key`. A `JoinWorkerHost` retried with the same `idempotencyKey` returns the host the first call enrolled, with a new credential, instead of enrolling another, and `connect worklet` retries a join whose answer was lost. A Worker Host's own credential calls only `DrainWorkerHost`, `ResumeWorkerHost`, and `RevokeWorkerHostCredential`, for that host. Joins are in the audit trail as `worker-host.join` by `auth-key:NAME`, and so are a host's own drains, resumes, and revocations. `AccessService.CreateOperatorToken`, `ListOperatorTokens`, `GetOperatorToken`, and `RevokeOperatorToken` serve the Operator Token commands, for the admin token only. `OrganizationService.GetOrganization`, `GetSpend`, `ListAuditEntries`, and `GetMetrics` serve `supertag status`, `spend`, and `audit` and the metrics snapshot, whose `rpc` counters belong to the API Server process that answered. `SurfaceService.SetUpSurface`, `ListSurfaceAccounts`, `GetSurfaceAccount`, `AddTagLocation`, `RemoveTagLocation`, `ActivateSet`, and `DeactivateSet` serve `supertag setup surface`, `list surface`, `get surface`, `update tag --add-location` and `--remove-location`, and set activation. Every command prints what it printed before.
- Experimental resource RPCs. `ResourceService.GetResource`, `ListResources`, `DiffManifests`, `ApplyManifests`, and `DeleteResource` serve `supertag apply -f`, `diff -f`, `get`, `list`, `describe`, `watch`, and `delete` for Tags, Roles, Permission Sets, Context Sets, Volumes, Workspaces, Surface Accounts, Objective manifests, and Worker Profiles, and `create tag`, `supertag init`, and `supertag up` provisioning. The Control Plane now validates manifests, merges field managers, applies in dependency order, and prunes apply sets, so every client sends the manifests it read, in one call of up to 16 MB. A SurfaceAccount document carries the secret values the CLI resolved, which the Control Plane verifies with the provider and never returns or records. The new operator actions are `read_resource`, `apply_resource`, and `delete_resource`. Every command prints what it printed before.
- JSON Schemas for every manifest kind, generated from the operator API protos, in `spec/manifests/`: one per kind, such as `tag.schema.json`, and `manifest.schema.json` for any kind.
- An operator API reference generated from the protos, in [`docs/reference/operator-api/`](docs/reference/operator-api/README.md): one page per service with every RPC, the action and audit entry it needs, and every message, field, and enum. `docs/reference/control-plane-api.md` now covers only how to call the API.
- An operator API client in the Python SDK, generated from the protos: `pip install 'supertag[operator]'` adds `supertag.operator` with `OperatorClient`, `OperatorClientSync`, and `error_detail`, with one attribute per service.
- The terminal UI's command palette: Ctrl-K, or `/` on an empty input line, lists what you can do and filters as you type: start or switch a conversation with the selected Tag, create an Objective it owns with an outcome, a Team, and a budget such as `300 USD`, switch Control Plane, or open the inbox. When a new Objective could not start, such as for an owner without a Worker Host, `r` starts it once that is fixed. The Tag rail reads Tags with `ResourceService.ListResources`.
- An experimental operator event stream, `EventService.Watch`: notices when a Tag, Session, Task, Objective, inbox item, approval request, Workstream post, or message in your conversations changes, resumable with a token, with a `resync` when the changes since the token are lost. Each notice reaches only callers that may read what changed. An open `Watch` or `FollowMessage` stream ends within 30 seconds once its Operator Token is revoked or expires.
- An experimental terminal UI: `supertag` with no arguments, in an interactive terminal, opens a Go terminal UI that lists your Tags and streams a conversation with one, including its work Sessions. It also lists your open Objectives with their spend against budget or why each is held, opens a live view of one, and lists what is **Waiting on you**: answer an Objective's question, or approve or deny a request, in place. The curl installer now installs it on macOS and Linux (arm64 and amd64): each release carries the `supertag-tui` binaries and their `SHA256SUMS`, and `install.sh` verifies the checksum. A failed download or check leaves the CLI installed without it. The CLI refuses a terminal UI binary from another release and says how to fix it. Without one, as after `npm install -g supertag-ai`, plain `supertag` prints help and a line saying to reinstall with the curl installer. In a conversation, up on an empty input selects a work Session line or its branch line: enter expands a work Session to its commands and tool calls, report, and delivery; on a branch line, `d` shows the branch's diff from your local git checkout and `o` opens its pull request. Ctrl-O lists, switches, and starts named conversations with the Tag. A Teams section lists your Teams, and a Team view shows its members, turn limit, and newest Workstream posts.
- A Tag's conversations share one memory. Every conversation sees the Tag's open Objectives, and the Tag can list, search, and read its other Sessions with `list_sessions`, `search_sessions`, and `read_session`. `list_objectives` and `read_objective` reach any Objective the Tag owns.
- Sessions are `shared` or `private`. A Lark direct chat or a CLI conversation is private to its one person; existing Lark direct-chat Sessions become private when you migrate.
- `supertag message tag NAME TEXT|- [--session NAME] [--output text|json]` talks to a Tag from the terminal in a private conversation, with the Tag's Roles' permissions only.
- `supertag message tag` shows a line for each command the Tag runs while it works, then the Tag's final reply, and follows work Sessions' activity; Ctrl-C stops following without cancelling the Task. Reply text is no longer stored as one Task event per piece.
- An Objective started in a conversation posts its completion summary there.
- A conversation hands longer work to work Sessions with `start_session`: each runs as its own Session and Task with the conversation's permissions and audience, at most four running at once, four per message, and eight unfinished per conversation, and its result returns to the conversation as a report from the Tag. A message and the work Tasks it starts or continues draw on one budget pool, the message's reported token and cost limits: each work Task may spend what the pool has left, `start_session` and `continue_session` are refused once less than 5% of the message's limits is left, and report turns run under the message's full limits. `supertag message tag` follows them until each reports, `supertag list session` shows `TAG`, `TITLE`, `PARENT`, and `STATUS`, and a Session reports `parentSessionId`, `tag`, `title`, and `latestTaskStatus`.
- A work Session asks the person with `ask` instead of waiting inside its Task: the Task completes waiting on the person, the Tag puts the question in the conversation, and the conversation lists the work Sessions still waiting. The Tag passes the answer on with `continue_session`, which starts the work Session's next Task under the current message's permissions and limits. A work Session's approval notice posts to its conversation. `supertag message tag` shows `· waiting on you: TITLE`, and the message record's work Session has status `WORK_SESSION_STATUS_WAITING` with the `question`.
- A work Session waits on approval the way it waits on an answer. A gated call that returns "approval pending" ends the work Session's Task waiting on that request: the `request_action_approval` result carries `next`, the Task's outcome records `approvals`, and the report turn says what the work Session waits for. The request stays pending while the work Session waits, and `supertag approve request` or `supertag deny request` continues the work Session as its next Task with the decision, under the waiting Task's permissions and drawing on the same budget pool. A decision made while the Task still runs continues it once the Task completes, and the Control Plane retries a continuation a restart or failed admission missed. When the Tag's permissions changed while the work Session waited, or its limits are spent, the work Session doesn't continue: the conversation gets a notice, and `supertag message tag` prints `· not continued: TITLE`. A `once` approval covers the retried call in that next Task. The notice adds "The work Session continues on its own once you decide." `supertag message tag` prints `· waiting for approval: TITLE` and keeps following the work Session into its next Task, while `--output json` returns at the waiting report. Before, the work Task finished and its request expired, so deciding it failed with "The requesting Task already finished; request expired".
- A work Session keeps its edits. With a Workspace from the conversation's location, or for a CLI conversation from the Tag's Worker Hosts, the Worker commits the work Session's changes to its own branch, `supertag/session/<id>`. Each later `continue_session` Task commits on top of them on the same branch, and the report turn names the branch. With several Workspaces, `start_session` takes `workspace`.
- A work Session sees only its own work: its Tasks get `ask` and nothing else, with no portfolio and no reads of other Sessions or Objectives. A work Session's approval notice names the requiring permission in SuperTag's words rather than the work Session's summary, and posts once per permission while its requests wait.
- The terminal UI switches between Control Planes: `supertag` hands it this machine's Control Plane and each saved connection, Ctrl-P lists them, and switching reconnects every stream. A token from `SUPERTAG_OPERATOR_TOKEN` or `SUPERTAG_ADMIN_TOKEN` goes only to the Control Plane it selects. The status bar counts the Control Plane's Worker Hosts by phase, such as `Worker Hosts: 2 ready, 1 unreachable`.

### Changed

- New Tags get web access (`web:fetch`) by default: they can read web pages, and their commands
  can reach the network. `supertag init` grants it to the lead on every harness but Cursor, except
  on a local-vm host, and says how to remove it. The desktop app's New Tag form has a **Web
  access** switch, on by default. A Tag without `web:fetch` hears so at the start of each turn, so
  it names the missing permission instead of refusing vaguely.

- `supertag get objective`, and `--output json` of `supertag create objective`, `update objective`, `complete objective`, `approve objective`, `describe objective`, `list approval`, `list inbox`, and `watch inbox`, print the RPC's message in proto3 JSON: lowerCamelCase fields, enum value names such as `OBJECTIVE_STATUS_WORKING` and `INBOX_ITEM_KIND_QUESTION`, 64-bit numbers as strings, and empty fields left out. Inbox items no longer carry `permittedActions`, `redaction`, `ageSeconds`, or `projectionVersion`, and the Objective overview no longer carries `pageUsage` or each Task's budget accounting; its `budget` covers the whole Objective. Text output is unchanged.
- `supertag get task`, `events task`, `watch task`, `cancel task --output json`, `get session`, `watch session`, `get artifact`, and `get team`, and `list task`, `list session`, `list artifact`, `list team`, `list message`, `list mailbox-grant`, and `list workstream-post` with `--output json` or `yaml`, print the RPC's message in proto3 JSON. A Task, Session, or artifact is its own message rather than an `apiVersion`, `kind`, `metadata`, `spec`, and `status` envelope, and a list is the response message, such as `{"tasks": [...]}`. A Team lists `members` with each Tag's ID and name instead of `memberTagIds`. Text output is unchanged.
- Another operator's CLI conversation Session, the work Sessions its turns started, and their Tasks, events, native archives, and artifacts are hidden: lists leave them out and reads fail as not found. The admin token is the operator `admin`, so it no longer sees Operator Token holders' conversations either. Before, every operator could read them.
- `supertag create team` with the ID and definition of an existing Team returns that Team instead of failing.
- `supertag update team` with a stale `--revision` returns the Team without a change when it already has every value the command sets, so a retried update succeeds.
- `supertag watch inbox` and `supertag watch objective` follow `EventService.Watch` and reread only when something they show changed, instead of polling.
- Approving or denying an approval request you already decided the same way returns the decision instead of failing, so a retried `supertag approve request` is safe. Listing approval requests no longer changes them: the Control Plane expires a pending request whose Task finished on its own.
- `supertag message objective` sends an idempotency key with each command, so a retried call admits the message once.
- A scoped coordination credential is refused on every `/api/v1/` route; it reaches only the operator RPCs that accept it. `GetObjective` is newly open to it, for Objectives in its scope.
- `supertag-ai/coordination`'s `CoordinationClient.inbox()` calls `InboxService.ListInboxItems` and returns its `ListInboxItemsResponse`; `request()` is gone.
- A conversation's work Sessions draw on one budget pool, as an Objective's do. Each work Task may spend what the message's token and cost limits have left after everything the message and its work Tasks reported, instead of an equal share of what was not yet given out. Running work Tasks hold nothing back, so work Tasks running at once can overspend the pool by what they spend in flight. `start_session` and `continue_session` are refused once less than 5% of the limits is left, instead of a tenth, and a work Session continued after an approval decision draws on the pool of the turn that started or continued it.
- A work Session has one branch, `supertag/session/<id>`, and every Task of it commits there. A continued Task checks the branch out at the Session's latest delivered commit and commits on top, instead of starting the next numbered branch `supertag/session/<id>-2` from a merge of the earlier one. A continued Task also keeps commits added on top of the branch since, such as a reviewer's fixup or a local commit whose push failed. A branch rewritten without the Session's last commit, or one a later Task needs from another Worker Host that never pushed it, fails the Task Attempt as a Workspace setup failure instead of starting the branch over. With `delivery: pull-request`, a Session gets one pull request that its later Tasks update; once a person merges it, the Session's next delivery opens a new one, and a cancelled Task closes it only when no earlier Task of the Session delivered to it. Workspace plans no longer carry `dependencyBranches`, and the Worker no longer writes dependency merge commits.
- A work Session no longer sends progress notes: `message_parent`, `skip_reply`, update turns, and the `· update: TITLE` line are gone. Follow a work Session through its activity stream, the `· running:` lines of `supertag message tag`; the Tag reports when the work Session finishes or waits.
- A Session resumes its native harness session whenever the harness can load it: the same Tag, Session, harness, and reply audience. Permission, Role, Context Set, workspace, execution, and Worker Profile revision changes no longer force a fresh session; each turn still runs under its own Task's permissions and tools. Earlier tool output stays in the resumed transcript after a permission is removed, but grants no new access. Bounded Session history replays only when no native state can resume, and never alongside a resume.
- `supertag init` ends by suggesting a conversation with your Tag, `supertag message tag`, with `supertag create objective` as the next step for an outcome with a budget and a deadline.
- `supertag list session` titles an Objective's conversation `Objective ID` and a Tag's Mailbox Session `Inbox`, instead of its first turn's text or nothing.
- Objectives, Mailboxes and Workstreams now run on the same Session model as the rest of SuperTag. An Objective is a conversation with a goal: it talks in the thread it was created in, the owner replies there, a person replies in the thread or with `supertag message objective`, and the Objective asks a question with `ask` when it needs one. Work runs in Sessions started beneath it with `start_session`, including Sessions of other Tags in its Team, and each reports back when it ends. One budget pool per Objective covers everything beneath it; a finished work Session's report turn still reaches the owner once the pool is spent, capped at what is left. A Tag's Mailbox is its own inbox: `send_message` delivers plain text, and several pending messages are handled together in one turn. A Team is a flat list of member Tags with an optional concurrency limit, created with `supertag create team` or declared in an Objective manifest. A Team's Workstream is its shared record of posts; a post wakes nobody, and a post addressed to Tags reaches those Tags' inboxes. Upgrading replaces the Objective, Team, Workstream and messaging tables, so existing Objectives, Teams and messages do not carry over.
- Audit entries for applying and deleting resources are `resource.apply` and `resource.delete`, with the RPC's procedure as `path` and status `200`. An apply records one `resource.apply` entry for each document it applied or failed to apply, and one `resource.prune` entry for each apply-set member pruning deleted or cancelled, instead of one `prune ApplySet/NAME` entry. Plans, such as `supertag diff`, and dry runs are no longer recorded; they recorded `apply.dry-run` and `delete.dry-run`. A request to a route the Control Plane doesn't know is refused and no longer recorded.
- `supertag update tag NAME --add-location` for a location the Tag already has succeeds without a change instead of failing. Audit entries for Worker Host, Auth Key, Operator Token, Tag binding, location, set activation, and surface setup changes record the RPC's procedure as `path`, such as `/supertag.operator.v1.HostService/DrainWorkerHost`, and status `200` where some recorded `201`.

### Fixed

- Granting or revoking two senders' Mailbox grants for one recipient at the same time keeps both changes; each changes only its own grant instead of rewriting the recipient's whole list.
- A Session blocked by an uncertain or still-cleaning-up Task takes new turns again once its Worker Host records that the Task Attempt stopped: when the Worker verifies cleanup on reconnect, finishes cancelling, or an operator runs `supertag recover worklet --confirm-stopped` and starts the host, or its ephemeral Worker Host was removed. The Task keeps its outcome and never runs again, and its operator inbox item goes away. A Session blocked for another reason, such as a message whose delivery could not be confirmed, gets inbox wording that no longer promises recovery releases it. Before, the block never cleared: after a Control Plane and Worker Host were both killed, a work Session's next Task stayed pending forever, and `supertag recover worklet` refused with `Attempt already has a terminal receipt`.
- A Tag whose Permission Sets grant tools of an MCP server that only a Workspace provides answers again: a conversation turn needs only the granted MCP servers a bound Worker Host declares, and runs without the others, which work Sessions with that Workspace use. A turn that cannot be placed no longer holds back other Sessions' turns, of any Tag. A waiting turn records why once, `supertag describe task` shows `Waiting: REASON`, and `supertag message tag` prints `· waiting: REASON`, with `waitingReason` in the message record.
- A Task copy of a git repository holds only what git considers part of it: tracked files and untracked files that are not ignored. Ignored entries such as `node_modules`, a Python `.venv`, or a `.env` file stay on the Worker Host, so a repository with a virtualenv no longer fails with "symbolic link ... points outside the workspace", and copies are much smaller.
- A Task's commit leaves out untracked build and cache files that are never source, such as `__pycache__/`, `*.pyc`, `.pytest_cache/`, `node_modules/`, `.venv/`, and `.DS_Store`, even when the repository has no `.gitignore`. A work Session that ran pytest no longer commits `.pyc` files. Files already tracked under those paths are still committed when they change.
- Conversation, work Session, and report turns are not asked for `Finding:` lines; only Objective Tasks report findings, so review lines no longer appear in replies.
- A path in a message, such as `src/index.ts` or `__pycache__/`, is ordinary text. Only an `owner/repo` that follows GitHub's owner rules selects a repository, so such a message no longer fails as a disallowed GitHub repository or drops the default repository.
- Each release's `install.sh` installs that release's version, and alpha releases publish to npm's `latest` tag, so the installer and `npm install -g supertag-ai` get the current alpha.

### Removed

- Every `/api/v1/coordination/*` route (the inbox, approval listing and decisions, and an Objective's overview, messages, and approval), the `/api/v1/tag-messaging/objectives` routes, and `POST /api/v1/objectives/ID/cancel`, `/pause`, and `/resume`; call `InboxService` and `ObjectiveService` instead.
- `GET /api/v1/tasks`, `GET /api/v1/tasks/ID`, `/events`, `/execution`, and `POST /api/v1/tasks/ID/cancel`; `GET /api/v1/sessions`, `GET /api/v1/sessions/ID`, `/states`, and `/states/STATE_ID`; `GET /api/v1/artifacts`, `GET /api/v1/artifacts/ID`, and `POST /api/v1/artifacts/ID/download`; and every `/api/v1/tag-messaging/*` route for Teams, Workstream posts, grants, and messages. Call `WorkService`, `TeamService`, and `MailboxService` instead.
- `POST /api/v1/tags/NAME/messages`, `GET /api/v1/tags/NAME/messages/TASK_ID`, and the reply stream at `GET /api/v1/tags/NAME/messages/TASK_ID/stream`, an AI SDK UI message stream over Server-Sent Events; call `ConversationService` instead. Reading a work Session's own Task ID as a message is gone too: `FollowMessage` follows work Sessions through the message that started them.
- `GET /api/v1/status`; call `OrganizationService.GetStatus` instead. The unused `supertag.authority.v1.ExecutionAuthorityService`, `GrpcExecutionAuthorityClient` in `supertag-ai/transport`, and the `renewAuthority` option of `GrpcArtifactCatalogClient` and `GrpcSessionStateStore` are gone: the Control Plane stopped renewing execution credentials, so an expired one now fails with `Unauthenticated`. `supertag verify deployment --grpc-url` probes the coordination service instead.
- The tools `assign_task`, `update_task`, `read_task`, `list_tasks`, `read_commitments`, `wait_for`, `escalate_task`, `read_mailbox`, `post_workstream` (now `post`), `read_team`, `update_team`, `request_approval`, `decide_approval`, `select_objective`, `attach_objective`, `start_objective`, `instruct_objective`, `create_team`, `create_tag` and `list_tags`. The commands `supertag assign task`, `supertag start objective` and its `--no-start` flag, `supertag events team`, `supertag coordinate`, `supertag prune mailbox`, the mailbox credential commands, `supertag message objective --reply-to`, and `supertag update objective --notification-task`. The `--lead`, `--parent`, `--max-breadth` and `--max-depth` flags, and the `--type` flag of `supertag grant mailbox`. The Objective manifest fields `observe` and `teams`, replaced by a single `team`. Message types and the `priority.*` and `governance.*` protocols, per-type Mailbox grants, Task approvals, review-finding closure, leadership and parent Teams, governance transfer, linked Objectives, the external mailbox transport at `/internal/v1/mailbox`, and the Org Architect Role.
- `/api/v1/worker-hosts` (enrolling, listing, reading, rotating and revoking with operator access, draining, and resuming), `/api/v1/auth-keys`, `/api/v1/operator-tokens`, `GET /api/v1/audit`, `GET /api/v1/metrics`, `GET /api/v1/organization`, `GET /api/v1/spend`, `GET /api/v1/surface-accounts` and `GET /api/v1/surface-accounts/NAME`, `PUT` and `DELETE /api/v1/tags/NAME/worker-hosts/ID`, `POST /api/v1/surface-enrollments`, and `POST /api/v1/tag-operations` with its `TagOperation` and `SurfaceEnrollment` resources. Call `HostService`, `AccessService`, `OrganizationService`, and `SurfaceService` instead. `POST /api/v1/worker-host-joins`, `POST /api/v1/worker-hosts/ID/drain` and `/resume` with a Worker Host's own credential, and `DELETE /api/v1/worker-hosts/ID/credential` are gone too: a host joins with `HostService.JoinWorkerHost`, its Auth Key as the bearer token, and drains, resumes, or revokes itself with `DrainWorkerHost`, `ResumeWorkerHost`, and `RevokeWorkerHostCredential`, its own credential, and the `x-supertag-worker-host-id` header. No `/api/v1/` route is served. The undocumented `supertag tag list`, `tag show`, `tag context`, and `tag permission` commands are gone; use `supertag list tag`, `describe tag`, and the `activate` and `deactivate` commands.
- `/api/v1/tags`, `/api/v1/roles`, `/api/v1/permission-sets`, `/api/v1/context-sets`, `/api/v1/volumes`, `/api/v1/workspaces`, `/api/v1/surface-accounts`, `/api/v1/worker-profiles`, `/api/v1/objectives`, and `POST /api/v1/apply-sets/NAME/prune`, with their `ResourceList`, `ResourceDeletion`, and `ApplySetPrune` documents and the `dryRun`, `applySet`, `force`, and `fieldManager` query parameters; call `ResourceService` instead. `spec/objective-manifest.schema.json`, `spec/surface-account-manifest.schema.json`, and `spec/resource-deletion.schema.json` are gone; use the schemas in `spec/manifests/` and `DeleteResourceResponse`.

## [0.2.0-alpha.6] - 2026-11-04

### Changed

- New Tags get web access (`web:fetch`) by default: they can read web pages, and their commands
  can reach the network. `supertag init` grants it to the lead on every harness but Cursor, except
  on a local-vm host, and says how to remove it. The desktop app's New Tag form has a **Web
  access** switch, on by default. A Tag without `web:fetch` hears so at the start of each turn, so
  it names the missing permission instead of refusing vaguely.

- Claude Code and Codex Tasks run the `claude` and `codex` CLIs you install instead of copies bundled with the vendor SDKs. `supertag init` and host startup check that each is installed and at least the version SuperTag's SDK targets, and name the upgrade command when it isn't.
- The installer script (`install.sh`) installs the npm package with your Node.js 22.13 or newer and npm, and removes the bundled Claude Code and Codex CLI copies; releases no longer attach per-platform archives with their own Node.js.
- Document the installer script alongside npm, including version selection, installation paths, upgrades, and removal.

## [0.2.0-alpha.5] - 2026-11-03

### Changed

- New Tags get web access (`web:fetch`) by default: they can read web pages, and their commands
  can reach the network. `supertag init` grants it to the lead on every harness but Cursor, except
  on a local-vm host, and says how to remove it. The desktop app's New Tag form has a **Web
  access** switch, on by default. A Tag without `web:fetch` hears so at the start of each turn, so
  it names the missing permission instead of refusing vaguely.

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

- New Tags get web access (`web:fetch`) by default: they can read web pages, and their commands
  can reach the network. `supertag init` grants it to the lead on every harness but Cursor, except
  on a local-vm host, and says how to remove it. The desktop app's New Tag form has a **Web
  access** switch, on by default. A Tag without `web:fetch` hears so at the start of each turn, so
  it names the missing permission instead of refusing vaguely.

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

- New Tags get web access (`web:fetch`) by default: they can read web pages, and their commands
  can reach the network. `supertag init` grants it to the lead on every harness but Cursor, except
  on a local-vm host, and says how to remove it. The desktop app's New Tag form has a **Web
  access** switch, on by default. A Tag without `web:fetch` hears so at the start of each turn, so
  it names the missing permission instead of refusing vaguely.

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

- New Tags get web access (`web:fetch`) by default: they can read web pages, and their commands
  can reach the network. `supertag init` grants it to the lead on every harness but Cursor, except
  on a local-vm host, and says how to remove it. The desktop app's New Tag form has a **Web
  access** switch, on by default. A Tag without `web:fetch` hears so at the start of each turn, so
  it names the missing permission instead of refusing vaguely.

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

- New Tags get web access (`web:fetch`) by default: they can read web pages, and their commands
  can reach the network. `supertag init` grants it to the lead on every harness but Cursor, except
  on a local-vm host, and says how to remove it. The desktop app's New Tag form has a **Web
  access** switch, on by default. A Tag without `web:fetch` hears so at the start of each turn, so
  it names the missing permission instead of refusing vaguely.

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

[Unreleased]: https://github.com/atemaguer/supertag/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/atemaguer/supertag/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/atemaguer/supertag/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/atemaguer/supertag/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/atemaguer/supertag/compare/v0.2.0-alpha.9...v0.3.0
[0.2.0-alpha.9]: https://github.com/atemaguer/supertag/compare/v0.2.0-alpha.8...v0.2.0-alpha.9
[0.2.0-alpha.8]: https://github.com/atemaguer/supertag/compare/v0.2.0-alpha.7...v0.2.0-alpha.8
[0.2.0-alpha.7]: https://github.com/atemaguer/supertag/compare/v0.2.0-alpha.6...v0.2.0-alpha.7
[0.2.0-alpha.6]: https://github.com/atemaguer/supertag/compare/v0.2.0-alpha.5...v0.2.0-alpha.6
[0.2.0-alpha.5]: https://github.com/atemaguer/supertag/compare/v0.2.0-alpha.4...v0.2.0-alpha.5
[0.2.0-alpha.4]: https://github.com/atemaguer/supertag/releases/tag/v0.2.0-alpha.4
[0.2.0-alpha.2]: https://github.com/atemaguer/supertag/compare/v0.2.0-alpha.1...v0.2.0-alpha.2
[0.2.0-alpha.1]: https://github.com/atemaguer/supertag/compare/v0.1.2...v0.2.0-alpha.1
[0.1.2]: https://github.com/atemaguer/supertag/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/atemaguer/supertag/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/atemaguer/supertag/releases/tag/v0.1.0
