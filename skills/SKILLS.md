# SuperTag skills for coding agents

Procedures for coding agents that **use, develop against, and deploy SuperTag** on behalf of a
team. Each subdirectory holds one `SKILL.md` covering a single task, the commands it needs, and
how to confirm it worked.

If you are changing the SuperTag codebase itself, read [`../AGENTS.md`](../AGENTS.md) instead —
that is a different audience with different rules.

## Use

| Skill | Read it when |
| --- | --- |
| [install-and-first-reply](install-and-first-reply/SKILL.md) | Setting SuperTag up from nothing: a first Objective in a repository, then a chat channel |
| [operate-supertag](operate-supertag/SKILL.md) | Drafting Objectives, checking team progress, and bringing decisions back to the user |
| [connect-a-surface](connect-a-surface/SKILL.md) | Adding Slack, GitHub, Lark/Feishu, Linear, or Teams |
| [configure-tags](configure-tags/SKILL.md) | Creating Tags and granting authority with Permission and Context Sets |
| [troubleshoot](troubleshoot/SKILL.md) | A mention produced no reply, or a Task is stuck |

## Develop

| Skill | Read it when |
| --- | --- |
| [run-a-worker](run-a-worker/SKILL.md) | Attaching Codex or Claude Code so Tags give real answers |
| [build-a-custom-worker](build-a-custom-worker/SKILL.md) | Integrating another agent SDK via the `supertag-ai` SDK |

## Deploy

| Skill | Read it when |
| --- | --- |
| [deploy-supertag](deploy-supertag/SKILL.md) | Running an always-on Control Plane for a team |

## Suggested path

A team adopting SuperTag from scratch, in order:

```text
install-and-first-reply    ->  a first Objective in a local repository, then one chat channel
run-a-worker               ->  real answers from Codex or Claude Code
configure-tags             ->  authority and knowledge beyond the thread
connect-a-surface          ->  additional surfaces
deploy-supertag            ->  always-on Control Plane on PostgreSQL
```

`troubleshoot` applies at every stage. `build-a-custom-worker` is only needed when the shipped
harnesses do not fit.

## Background reading

Read these when a skill uses a term you cannot place. Do not infer SuperTag vocabulary from
context — it is precise, and guessing produces wrong configuration.

- [Glossary](../docs/reference/glossary.md) — one-line definitions of every public term
- [How SuperTag fits together](../docs/concepts/how-it-works.md) — the service architecture
- [Tasks and Sessions](../docs/concepts/tasks.md) — durable intent, retries, continuity
- [Worker Hosts, Worklets, Workers, and harnesses](../docs/concepts/workers.md) — the execution vocabulary
- [Resource model](../docs/reference/resource-model.md) — what is configured versus observed

## Conventions

The CLI is `supertag`, installed with the installer script from a GitHub Release; see [installation](../docs/operations/install.md). Check [Requirements](../docs/operations/requirements.md) for system tools and harness sign-in.

Local state and credentials live in `~/.supertag`; override with `SUPERTAG_STATE_DIR`.
`~/.supertag/supertag.yaml` lists the services `supertag up` runs on a machine, like a compose
file: a `control-plane` service and `host` services (the machine as a Worker Host). Local
development uses SQLite; production uses PostgreSQL via `database.url` or `SUPERTAG_DATABASE_URL`.

Credentials come from masked prompts or environment variables — **never** command-line flags. Do
not construct a command that puts a secret in argv.

Confirm any command against `supertag --help` before running it. That help text is the
authoritative inventory.

## Terminology note

"Skill" is overloaded here. This directory holds instructions for *coding agents*. SuperTag also
has a product **Skill**: a Worker-local, digest-pinned catalog entry passed via
host service `skills` path and selected by a Context Set. For that, see
[Run a Worker](../docs/guides/workers.md#optional-skills) and
[Add a custom Context type](../docs/guides/custom-context.md).
