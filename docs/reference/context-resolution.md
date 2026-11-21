# Context resolution

This page describes the implementation contract behind how a **Context Set** selects reusable
knowledge that may be added to a **Task**, one assignment accepted for a **Tag** (a persistent
AI actor with its own identity, responsibilities, permissions, and work history), while a **Permission Set** selects the
actions it may perform. Start with [Context Sets and Permission
Sets](../concepts/context-and-permissions.md) for the plain-language model.

Other terms on this page (see the [glossary](glossary.md)): a **Session** groups Tasks from the
same conversation; a **Role** describes how a Tag works and what it may do; a **Skill** is a
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

A **Worker Host** is a machine or sandbox that provides execution capacity. Its **Worklet** claims
the Task from the Control Plane and starts a **Worker**, a harness adapter and its harness, for
it. The Worklet receives these fixed inputs with the claim, without database access. Policy changes affect later Tasks.

## Same-Session continuity

Each Session maps to one native harness session. When a Task Attempt finishes, its harness may
save the native session as a checkpoint. The Worklet that ran it keeps the latest checkpoint for
each Tag and Session, and the Control Plane records which host holds it; a Task Attempt that
finishes without one, such as a failed one, clears it, so the Session's next Task starts a new
native session.

The Session's next Task receives the checkpoint when it runs on the holding host, and its harness
resumes it; elsewhere it starts a new native session from the recap. A harness refuses a
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
filesystem paths or package bytes. The Worker Host resolves each Skill from its sources, in this
order of precedence:

| Source | Recorded as | Where |
| --- | --- | --- |
| Configured catalog | `catalog` | A host service's `skills` path, or `supertag worklet --skill-catalog PATH` |
| Repository | `repository:.claude/skills`, `repository:.agents/skills` | The Task's checkout, read from the commit it starts at |
| User | `user:~/.claude/skills`, `user:~/.agents/skills` | The home directory of the user the Worker Host runs as |

The repository and user sources need no configuration: every Worker Host whose harness loads
Skills has them. In each, every immediate child directory that holds a `SKILL.md` is a Skill
named after the directory. The Worklet reads repository Skills after it checks out the Task's
commit, as data from its private copy of the repository: an uncommitted change is not read, and
no repository command runs.

The configured catalog names a directory of Skill packages or a JSON catalog file:

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
pins the revision's current commit, and its retries keep it on any host.

Two sources may have a Skill of the same name. The higher-precedence one loads, and the Task
records each one it shadowed. Two Skills of one name in the configured catalog are refused.

### Select Skills

A `supertag/skill` Context Item selects Skills in one of two ways:

| `config.reference` | Loads | `required` | `version`, `digest` |
| --- | --- | --- | --- |
| A Skill's name, such as `code-review` | That Skill | Allowed | Allowed |
| `*` | Every Skill the Task's Worker Host has, from every source | Must be `false` | Not allowed |

`supertag apply` refuses a `*` item that is required or pinned. A named item beside a `*` item
keeps its pins. A Task without a `supertag/skill` item loads no Skill.

A `*` item skips a Skill it cannot load, such as an oversized package or one with a symbolic link,
and records why. When it loads none, the Task records an omission instead.

### Pins and records

The Task's context resolution records, for each Skill it loaded, the Context Item, the Skill's
name, its source, its version, and its content digest. A repository Skill's version is the commit
it was read from. The same record lists the Skills it skipped: those another source shadowed, and,
for a `*` item, those it could not load. A Task records this once, at its first Task Attempt. A
retry that finds different Skills, such as one whose user added a Skill in between, fails.

Resolution rejects unregistered names, pin mismatches, symbolic links in a package, and oversized
packages. A symbolic link to a whole source directory is followed; one to a single Skill is not.

### Delivery

The Worklet copies each Skill privately and delivers it read-only. Each harness loads only the
Skills its Task selected, never its own native, user, or repository Skills:

| Harness | Receives Skills as | A selected Skill it cannot load |
| --- | --- | --- |
| Claude Code | An isolated plugin; the Skill tool accepts only those names | Fails a named one; skips one only `*` selected |
| Codex | Copies in its disposable native home; every other entry is disabled | Fails the Task |
| OpenCode | A private `skills.paths` directory; the `skill` permission allows only those names | Fails a named one; skips one only `*` selected |
| Cursor | Not delivered | Records an optional item as an omission; a required one waits for another host |

Claude Code cannot load a Skill whose frontmatter sets `hooks`, `context`, `agent`,
`allowed-tools`, `model`, or `effort`. OpenCode needs a frontmatter `name` no other selected Skill
has, and no nested `SKILL.md`. OpenCode loads no Skill in a remote Workspace. Cursor finds Skills
by name in the workspace and its home directory, with no setting that limits it to selected ones,
so SuperTag does not deliver Skills to it.

## Context Item types

| Type | Version | Resolved by | Result |
| --- | --- | --- | --- |
| `supertag/skill` | 1 | The Worker Host's Skill sources | The pinned Skill packages |
| `supertag/artifacts` | 1 | The Control Plane, at admission | Bounded artifact metadata summaries |

Each Item has a `type`, a `version`, an `itemKey` unique within its Context Set, `required`, and a
bounded, non-secret `config`. A Worklet advertises the types its host can resolve: `supertag/skill`
whenever its harness loads Skills, which every built-in harness but Cursor does. Only a Worklet that advertises every required Item's type
claims the Task; an optional Item the host cannot resolve is recorded as an omission. The Control
Plane stores other types, but no Worklet resolves them.

## Operational targets are not context

A repository needed for one Task is an operational target, not a Context Item. At admission, the
Control Plane copies the Workspace from the Tag's binding into the Task. For a remote Workspace,
the Session's first Task pins the commit its branch names, and later turns of the Session keep it.

The Worklet checks out the pinned commit and records provenance without recording a credential
or cache path. See [Work in a repository with Workspaces](../guides/workspaces.md).
