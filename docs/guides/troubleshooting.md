# Troubleshoot the first reply

Trace a request from where someone asked a **Tag**, a persistent AI actor with its own
responsibilities and permissions, to the **Worker Host** that runs it and back. Work through the
steps in order; each checks one layer. Terms are defined in the [glossary](../reference/glossary.md).

Commands name their **Control Plane**, the service that stores your organization:
`--state-directory ~/.supertag` for this machine's local services, as shown, or
`--control-plane NAME` for a shared one.

## 1. Check the services

```sh
supertag ps
supertag status
```

`ps` should show `control-plane`, `gateway`, and each host `running`. If a service stopped, run
`supertag up` and read its log with `supertag logs control-plane`, `supertag logs gateway`, or
`supertag logs HOST`. For a shared deployment, run
`supertag verify deployment URL --env-file operator.env`.

If a command says `pass --control-plane URL, --control-plane NAME of a saved Control Plane, or
--state-directory`, add the target it asks for.

## 2. Check the Surface Account

```sh
supertag get surface-account --state-directory ~/.supertag
supertag logs gateway
```

The account must exist, be enabled, and name the Gateway that serves it. If it is missing, run
`supertag setup surface PROVIDER` against the same Control Plane. Then check that events arrive:

- Lark keeps a long connection; the Gateway log shows it connecting.
- Slack, GitHub, Linear, and Microsoft Teams send webhooks. The public HTTPS URL must forward to
  the Gateway's loopback listener and path, and the provider's delivery log should show success.
  A failed signature check is refused before anything is stored.

Invite the app or bot to the channel; enrolling an account does not add it.

## 3. Check the Tag locations

```sh
supertag get surface-location --state-directory ~/.supertag
```

A mention starts work only at an enabled location for the exact channel, repository, chat, or
team ID, and only from an allowed user when the location restricts them. Add a location with
`supertag tag update TAG --add-location PROVIDER ...`. Messages in unrelated threads, and replies
in threads that no mention started, are ignored by design.

## 4. Find the Task

Mention the Tag again while watching:

```sh
supertag watch task --state-directory ~/.supertag
supertag describe task TASK_ID --state-directory ~/.supertag
```

No Task means steps 2 and 3 failed. A refused request's reason is in the Gateway log, and a
refused Task's description names the missing permission.

## 5. Check placement

```sh
supertag placement explain TASK_ID --state-directory ~/.supertag
supertag get host --state-directory ~/.supertag
```

A queued Task waits until a ready Worker Host may run its Tag, carries the Tag's `runsOn` labels,
and serves its harness and model. `placement explain` names which is missing:

| Reason | Fix |
| --- | --- |
| No Worker Host may run the Tag | Start a host, or enroll one with an Auth Key that names the Tag |
| Hosts lack the required labels | `supertag placement runs-on TAG LABEL...`, or add the label to a host |
| No host serves the harness or model | Add the harness or model to a host's `harnesses` or `models` |
| Hosts are busy or draining | Wait, raise `concurrency`, or `supertag host resume HOST` |

## 6. Check the harness

A host that cannot sign in to its harness stops with the reason in its log. Check it the way the
host does:

```sh
supertag sign-in codex
supertag sign-in claude-code
```

If it reports not signed in, follow the sign-in instructions it prints, as the same user that
runs the host, and run `supertag up`. Keys belong in `~/.supertag/.env`: a service unit does not
inherit your shell. Cursor and OpenCode Tasks that may run commands also need
`allow-unsandboxed-commands` on the host; see [Run Worker Hosts](workers.md#harnesses-without-a-sandbox).

## 7. Check the run and the reply

```sh
supertag task events TASK_ID --state-directory ~/.supertag
supertag get reply --state-directory ~/.supertag
```

`task events` shows the run's progress and result. `get reply` shows whether the Gateway
delivered the reply. A reply whose delivery is uncertain waits for
`supertag reply resolve REPLY_ID --decision ... --evidence ...` after you check the thread.

## A Task Attempt is uncertain

A Worker Host that was killed while running a **Task Attempt**, one execution of a Task, may not
know whether the work finished. It shows in the inbox as `task-attention` and in
`supertag metrics` under recovery. Check what the Task Attempt did, then record a decision:

```sh
supertag task resolve-attempt TASK_ID ATTEMPT_ID --decision failed \
  --evidence "The process is gone and no commit was delivered." --confirmed-stopped \
  --state-directory ~/.supertag
```

`--decision retry` runs the Task again. See
[Scheduling and interrupted execution](../reference/scheduling-and-recovery.md).

## A Task failed because the repository changed

A Task Attempt fails when the repository's Git configuration, hooks, or attributes changed while
it ran, because SuperTag's own Git commands must not run anything a Task wrote. Restore the
repository's configuration and send the work again.

## The local state is from the earlier TypeScript runtime

This SuperTag cannot read the earlier runtime's state. Stop the earlier services, move
`~/.supertag` aside, and run `supertag init`. See
[Install SuperTag](../operations/install.md#coming-from-the-typescript-runtime).

## Next

- [Run Worker Hosts](workers.md)
- [Connect a collaboration surface](../surfaces/README.md)
