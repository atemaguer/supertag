# Context resolution

This page describes the implementation contract behind how a **Context Set** selects reusable
knowledge that may be added to a **Task**, one assignment accepted for a **Tag** (a persistent
AI identity with its own responsibilities and permissions), while a **Permission Set** selects the
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
[host service](glossary.md#host-service), [Worklet](glossary.md#worklet),
[Worker Profile](glossary.md#worker-profile), [Worker](glossary.md#worker),
[Workspace](glossary.md#workspace), [Runtime Input Provider](glossary.md#runtime-input-provider),
[Runtime Input](glossary.md#runtime-input), and
[Workspace Resolver](glossary.md#workspace-resolver).

## Stored Task inputs

The **Control Plane** is the service that stores the
[organization](glossary.md#autonomous-organization) and accepts its work. When it accepts a Task, it
stores two independent snapshots:

- **Context Plan** — the versioned declarations of knowledge that may be added, including Skills,
  cross-Session artifact selections, and custom types called Context Items.
- **Authorization snapshot** — the applicable Role policy, active Permission Sets, and allowed
  resources and actions.

A **Worker Host** is a machine or sandbox that provides execution capacity. A **Worklet** connects
it to the Control Plane, and a **Worker** is the code that completes the Task. Workers receive these
fixed inputs through their Worklets without database access. Policy changes affect later Tasks.

## Same-Session continuity

The Control Plane derives up to five recent completed Task history entries from the current
Session and includes them directly in the Task snapshot. This is not a Context Plan item and
requires no Context Set. Each `TaskHistoryEntry` contains `taskId`, `sessionId`, `tagId`, optional
`requestText`, a bounded `result`, and `completedAt`. It is an execution input projection of the
stored Task, not a separately published resource.

Each Session maps to one native harness session. The Control Plane offers a Session's latest
resumable native state when the Tag, the Session, and the reply audience match, and the selected
Worker Profile runs the harness that produced it. The harness then checks that it can load the
state where it runs. Authorization, Role instructions, the Context Plan, the Worker Profile
revision, the workspace plan, and execution settings do not gate a resume. Each Task Attempt
receives the tools and permissions admitted for its own Task.

The history entries above are the fallback. A harness that resumes native state omits them from
its prompt. It includes them when no state was offered, when it rejects the offered state, or when
the predecessor Task Attempt failed. A resume that fails while running fails its Task Attempt, so
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

The Context Plan carries stable Skill identity plus optional version/digest pins, never filesystem paths or package bytes. A host service's `skills` path names a local directory of Skill packages or a JSON catalog file. The catalog resolves and allowlists packages:

```json
{
  "version": 1,
  "skills": [
    { "id": "code-review", "version": "1", "path": "./skills/code-review" }
  ]
}
```

For a directory catalog, each immediate child directory is a Skill named after that directory and contains `SKILL.md`. JSON entries may also declare a version. Resolution rejects unregistered identities, pin mismatches, symbolic links, duplicate identities, and oversized packages. Workspace Skills selected by `spec.skills` replace Context Set Skills with the same name. Codex receives native `.agents/skills`; Claude Code receives an isolated MCP-disabled plugin wrapper as a harness-specific adaptation detail.

## Operational targets are not context

A repository needed for one Task is an operational target, not a Context Item. At admission, the
Control Plane deterministically captures an immutable workspace plan from the origin, explicit
request text, or a sole eligible permission. Ambiguous and unavailable requests are recorded rather
than guessed. The Workspace Resolver then resolves only that captured target and checks the
authorization snapshot before touching credentials.

For GitHub:

1. a GitHub-origin Task selects its repository;
2. another surface may name `owner/repository`;
3. a single permitted repository may be the default;
4. multiple eligible repositories with no selection require clarification.

The Worker resolves an immutable commit, caches/stages the snapshot read-only, and records provenance without recording its credential or cache path.

## Extension points

- `ContextResolverRegistry` — built-in or namespaced custom Context Plan items.
- `WorkspaceResolverRegistry` — operational targets such as repositories.
- `ToolProviderRegistry` — permission-derived hosted tools.
- `isTagActionAllowed` / `assertTagActionAllowed` — explicit provider authority checks.

The three registries implement the Runtime Input Provider contract and receive a Resolution Context. These seams remain separate so context selection cannot accidentally authorize a collaboration surface action.

## Custom Context Item contract

Context Item types are an open set behind one strict envelope:

| Field | Meaning |
| --- | --- |
| `type` | Namespaced contract identity, such as `acme.io/runbook` |
| `version` | Positive integer understood by the resolver |
| `itemKey` | Stable identity within the Context Set |
| `required` | Whether missing compatible support must fail closed |
| `config` | Bounded, non-secret JSON captured at admission |
| `snapshot` | Optional immutable data added by a trusted Control Plane built-in |

Workers advertise supported type/version pairs. Scheduling considers every required Context Item before assigning a Task. The Worker then selects an exact resolver, records optional omissions, and attaches each produced Runtime Input to its originating `itemKey`.

Custom types normally resolve into portable Runtime Inputs such as `resource`, `instruction`, or `skill`. A harness therefore consumes a small stable input vocabulary without understanding every custom Context Item type.

See [Add a custom Context type](../guides/custom-context.md) for TypeScript and Python examples.
