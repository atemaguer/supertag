# CLAUDE.md

Two audiences, two directories. Pick by what you are doing:

| Doing | Read |
| --- | --- |
| Using, developing against, or deploying SuperTag | [`skills/SKILLS.md`](skills/SKILLS.md) |
| Changing this codebase | [`AGENTS.md`](AGENTS.md) |

Read the task-specific files under `skills/` directly when helping someone use or extend
SuperTag:

- [`skills/install-and-first-reply/SKILL.md`](skills/install-and-first-reply/SKILL.md)
- [`skills/operate-supertag/SKILL.md`](skills/operate-supertag/SKILL.md)
- [`skills/connect-a-surface/SKILL.md`](skills/connect-a-surface/SKILL.md)
- [`skills/configure-tags/SKILL.md`](skills/configure-tags/SKILL.md)
- [`skills/run-a-worker/SKILL.md`](skills/run-a-worker/SKILL.md)
- [`skills/build-a-custom-worker/SKILL.md`](skills/build-a-custom-worker/SKILL.md)
- [`skills/deploy-supertag/SKILL.md`](skills/deploy-supertag/SKILL.md)
- [`skills/troubleshoot/SKILL.md`](skills/troubleshoot/SKILL.md)

## Notes specific to this repo

`skills/` means *instructions for coding agents*. It is unrelated to SuperTag's product **Skill**
concept — the host-local, digest-pinned catalog named by a host service's `skills` path. Do not conflate
them when writing docs or code.

The CLI is `supertag` in all documentation. Use `pnpm supertag ...` yourself when exercising
uncommitted changes from the checkout, but never write that form into `docs/`.
