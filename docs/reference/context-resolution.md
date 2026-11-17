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
stores a policy snapshot with it that holds two independent parts:

- **Context Plan** — the versioned declarations of knowledge that may be added, called Context
  Items: Skills and cross-Session artifact selections.
- **Authorization snapshot** — the applicable Role policy, active Permission Sets, and allowed
  resources and actions.

A **Worker Host** is a machine or sandbox that provides execution capacity. It claims the Task
from the Control Plane and runs a harness adapter for it. The Worker Host receives these fixed
inputs with the claim, without database access. Policy changes affect later Tasks.

## Same-Session continuity

Each Session maps to one native harness session. When a Task Attempt finishes, its harness may
save the native session as a checkpoint. The Control Plane keeps the latest checkpoint for each Tag
and Session in its private `--checkpoint-directory`; a Task Attempt that finishes without one,
such as a failed one, clears it, so the Session's next Task starts a new native session.

The Session's next Task receives the checkpoint, and its harness resumes it. A harness refuses a
checkpoint that another harness, Tag, or Session produced, and the refusal fails the Task Attempt.
Authorization, Role instructions, the Context Plan, the workspace plan, and execution settings do
not gate a resume: each Task Attempt is authorized for its own Task. Earlier tool output stays in a
resumed transcript after a permission is removed; it grants no new access.

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

Each Item has a `type`, a `version`, an `itemKey` unique within its Context Set, `required`, and a
bounded, non-secret `config`. A Worker Host advertises the types it can resolve: `supertag/skill`
only when it has a Skill catalog. Only a Worker Host that advertises every required Item's type
claims the Task; an optional Item the host cannot resolve is recorded as an omission. The Control
Plane stores other types, but no Worker Host resolves them.

## Operational targets are not context

A repository needed for one Task is an operational target, not a Context Item. At admission, the
Control Plane copies the Workspace from the Tag's binding into the Task. For a remote Workspace,
the Session's first Task pins the commit its branch names, and later turns of the Session keep it.

The Worker Host checks out the pinned commit and records provenance without recording a credential
or cache path. See [Work in a repository with Workspaces](../guides/workspaces.md).
