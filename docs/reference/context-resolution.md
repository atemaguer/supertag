# Context resolution

This page describes the implementation contract behind how a **Context Set** selects reusable
knowledge that may be added to a **Task**, one assignment accepted for a **Tag** (a persistent
AI actor with its own responsibilities and permissions), while a **Permission Set** selects the
actions it may perform. Start with [Context Sets and Permission
Sets](../concepts/context-and-permissions.md) for the plain-language model.

Other terms on this page (see the [glossary](glossary.md)): a **Session** groups Tasks from the
same conversation; a **Role** is an enduring responsibility assigned to a Tag; a **Skill** is a
reusable instruction package; a captured artifact is reusable file content with a catalog entry
recording its producer.

Other terms on this page are defined in the glossary: [Objective](glossary.md#objective),
[Team](glossary.md#team), [Task Attempt](glossary.md#task-attempt),
[Context Item](glossary.md#context-item), [Context Plan](glossary.md#context-plan),
[Control Plane](glossary.md#control-plane), [Worker Host](glossary.md#worker-host),
[host service](glossary.md#host-service),
[harness adapter](glossary.md#harness-adapter),
and [Workspace](glossary.md#workspace).

## Stored Task inputs

The **Control Plane** is the service that stores the
[organization](glossary.md#autonomous-organization) and accepts its work. When it accepts a Task, it
stores two independent snapshots:

- **Context Plan** — the versioned declarations of knowledge that may be added, called Context
  Items: Skills and cross-Session artifact selections.
- **Authorization snapshot** — the applicable Role policy, active Permission Sets, and allowed
  resources and actions.

A **Worker Host** is a machine or sandbox that provides execution capacity. It claims the Task
from the Control Plane and runs a harness adapter for it. The Worker Host receives these fixed
inputs with the claim, without database access. Policy changes affect later Tasks.

## Same-Session continuity

The Control Plane derives up to five recent completed Task history entries from the current
Session and includes them directly in the Task snapshot. This is not a Context Plan item and
requires no Context Set. Each `TaskHistoryEntry` contains `taskId`, `sessionId`, `tagId`, optional
`requestText`, a bounded `result`, and `completedAt`. It is an execution input projection of the
stored Task, not a separately published resource.

Each Session maps to one native harness session. The Control Plane offers a Session's latest
resumable native state when the Tag, the Session, and the reply audience match, and the Task runs
on the harness that produced it. The harness then checks that it can load the
state where it runs. Authorization, Role instructions, the Context Plan, the workspace plan,
and execution settings do not gate a resume. Each Task Attempt
receives the tools and permissions admitted for its own Task.

The history entries above are the fallback. A harness that resumes native state omits them from
its prompt. It includes them when no state was offered, when it rejects the offered state, or when
the predecessor Task Attempt failed for a reason other than its spending limit. A Task Attempt
stopped by its spending limit resumes after the allocation is renewed. A resume that fails while running fails its Task Attempt, so
the next Task Attempt replays. Earlier tool output stays in a resumed transcript after a permission is removed; it grants no new
access.

## Cross-Session artifact selection

The built-in `supertag/artifacts@1` Context Item selects captured artifact metadata. Each rule
names one exact source location for the Tag, age/count limits, and a matching policy. Selection
requires artifacts whose producing Tasks:

- belong to the same Tag;
- originated from that exact source location;
- share an exact channel, repository, issue, pull request, file, or project reference;
- fall within the configured bounds.

The Context Plan admits at most five artifact metadata summaries, with IDs for retrieval. Selection
is deterministic and fail-closed; it does not use embeddings or semantic ranking. The built-in
resolver produces an `instruction` input that labels those summaries as untrusted source material
and explains how to inspect or retrieve them. It does not insert file bytes or another Session's
chat responses into the prompt.

This selector is specific to collaboration-surface sources. A Role cannot apply it to internal
Objective Tasks; those Tasks discover artifacts through their existing Objective and Team
visibility instead. Same-Tag cross-Session selection does not imply cross-Tag sharing.

The agent can use `inspect_artifact`, `read_artifact`, or `attach_artifact` for the exact admitted
artifacts, subject to the current Task Attempt's access and environment capabilities. Selection does
not grant general access to the source conversation or other artifacts. See [artifacts](artifacts.md)
for capture, retrieval, storage, and attachment limits.

## Skills

The Context Plan carries a Skill's stable identity, plus optional version and digest pins, never
filesystem paths or package bytes. The Worker Host's Skill catalog resolves and allowlists the
packages: a host service's `skills` path, or `supertag worker-host --skill-catalog PATH`. It names
a directory of Skill packages or a JSON catalog file:

```json
{
  "version": 1,
  "skills": [
    { "id": "code-review", "version": "1", "path": "./skills/code-review" }
  ],
  "github": [
    { "repository": "acme/skills", "path": "catalog", "revision": "main", "skills": ["release"] }
  ]
}
```

In a directory catalog, each immediate child directory is a Skill named after that directory and
contains `SKILL.md`. A `github` entry names Skill directories in a GitHub repository. A new Task
pins the revision's current commit, and its retries keep it on any host. Resolution rejects
unregistered identities, pin mismatches, symbolic links, duplicate identities, and oversized
packages. The host delivers each Skill read-only: Codex receives it in its disposable native home,
and Claude Code receives it as an isolated plugin.

## Context Item types

| Type | Version | Resolved by | Result |
| --- | --- | --- | --- |
| `supertag/skill` | 1 | The Worker Host's Skill catalog | The pinned Skill package |
| `supertag/artifacts` | 1 | The Control Plane, at admission | Bounded artifact metadata summaries |

Each Item has a `type`, a `version`, an `item_key` unique within its Context Set, `required`, and a
bounded, non-secret `config`. A Worker Host advertises the types it can resolve: `supertag/skill`
only when it has a Skill catalog. Only a Worker Host that advertises every required Item's type
claims the Task; an optional Item the host cannot resolve is recorded as an omission. The Control
Plane stores other types, but no Worker Host resolves them.

## Operational targets are not context

A repository needed for one Task is an operational target, not a Context Item. At admission, the
Control Plane captures an immutable Workspace selection from the Tag's binding, the origin, or the
request. Ambiguous and unavailable requests are recorded rather than guessed. For a GitHub
Workspace:

1. a GitHub-origin Task selects its repository;
2. a message on another collaboration surface may select a GitHub Workspace the Tag's Permission
   Sets allow;
3. later turns of the thread keep that selection.

The Worker Host checks out the pinned commit and records provenance without recording a credential
or cache path. See [Work in a repository with Workspaces](../guides/workspaces.md).
