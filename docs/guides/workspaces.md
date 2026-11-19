# Work in a repository with Workspaces

Let Tags change a repository without touching your checkout. A **Tag** is a persistent AI actor
with its own responsibilities and permissions. A **Workspace** is a named repository its Tasks
work in. Each **Task Attempt**, one execution of a Task, runs in its own checkout pinned to an
exact commit, on a **Worker Host**, the machine that runs the work. Its changes come back as a
branch you review. See the [glossary](../reference/glossary.md) for other terms.

## How it works

```text
Tag lead ── Workspace app (base commit 4f2c…) ── Task ── Worker Host
                                                         │ pinned checkout, harness runs
                                                         │ commits, verifies, bundles
                                                         v
your repository  <──  branch supertag/session/HASH  <── delivery
```

1. A Worker Host maps the Workspace to a source: a local Git repository, or a **remote
   Workspace**, a repository on any git server that each host's **Worklet** reads with a
   credential the Control Plane grants.
2. A Tag is bound to the Workspace.
3. Each Task Attempt gets a separate checkout at the pinned commit. Later Tasks of the same
   Session continue on the Session's own branch, on top of the earlier ones.
4. After the harness finishes, the Worklet commits the changes, verifies them, and delivers a Git
   bundle and a patch. New files your `.gitignore` matches, and untracked caches such as
   `__pycache__/` and `node_modules/`, are left out; see
   [Worker Host reference](../reference/worker.md#workspaces).
5. The delivery **lands**: the Worklet writes it into the repository its host maps as the branch
   `supertag/session/HASH`, one branch per Session, or pushes it to the Workspace's git server. `HASH` is a SHA-256
   digest of the Tag and Session IDs, and the Session's report names the branch.

## Before you start

- SuperTag running from `supertag init`, which maps the repository it ran in as a Workspace of
  this machine's host and binds the `lead` Tag to it, following the branch checked out when `init`
  ran (or pinned to the checked-out commit when HEAD was detached).
- A Git repository with at least one commit.

## 1. Map the repository on a Worker Host

On a machine set up with `supertag init`, add a repository as a Workspace of the local host with
its folder:

```sh
supertag workspace add ~/code/app
```

It checks that the folder is in a Git repository with a commit, names the Workspace after the
folder (`--name` picks another name), and restarts the changed services. In the desktop app,
choose **Choose a folder…** as the Workspace of a new Tag to do the same.

The command writes `~/.supertag/supertag.yaml`, where a host service maps Workspace names to
repositories. You can also edit it, then run `supertag up`:

```yaml
services:
  studio:
    type: host
    harnesses: [codex]
    workspaces:
      app: ~/code/app
      api: { path: ~/code/api, land: patch, setup: npm ci }
```

A host without `supertag.yaml` uses `--workspace-id app --workspace-source /srv/app`, repeated for
each Workspace. Several hosts may map the same Workspace name to their own clones.

## 2. Bind a Tag to the Workspace

```sh
supertag tag put builder --instructions "Implement bounded changes with tests." \
  --workspace-id app --workspace-base "$(git -C ~/code/app rev-parse HEAD)" \
  --allow files:write --allow commands:execute
```

Or in a Tag manifest:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata: { name: builder }
spec:
  roles: [Builder]
  workspace: { id: app, baseCommit: 4f2c0d1e9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d }
```

A local Workspace needs a full base commit or a branch to follow. With a base commit, new Sessions
start from it; move the Tag to a newer commit by putting the binding again. The Tag's Tasks run
only on hosts that map the Workspace.

A Codex Tag on a code-mode-only model, such as gpt-6-sol, also needs `web:fetch` to run commands;
see [Codex commands and models](../operations/requirements.md#codex-commands-and-models).

### Follow a branch instead of a commit

To start each new Session from wherever a local branch points, name the branch instead of a
commit:

```sh
supertag tag put builder --workspace-id app --workspace-ref main
```

Or in the manifest: `workspace: { id: app, ref: main }`. A Tag sets `baseCommit` or `ref`, not
both, and only a Workspace with a local checkout can follow a branch; a remote Workspace names
its branch itself. `ref` is a short branch name such as `main` or `release/2.1`, not `refs/heads/main`, a
tag, or a remote-tracking branch.

The Worklet that starts a Session's first Task looks the branch up in its host's checkout of the
Workspace and records the commit it names. Every later Task of that Session works from the same
commit, even after the branch moves; the next new Session looks the branch up again.
`supertag get task ID` shows the branch as `ref` and the recorded commit as `base_commit`, which
stays empty until the host has looked it up. When the host's checkout has no such branch, the
Task fails before the harness starts, with `Workspace branch BRANCH does not name a commit on
this Worker Host`; if Git itself fails during the lookup, it fails with `Workspace branch BRANCH
could not be resolved on this Worker Host`. A host that stops during the lookup leaves the Task
for recovery instead. SuperTag never fetches: update the host's checkout to move the branch.

### Prepare each checkout with setup

`setup` runs a shell command, such as `npm ci`, in each new checkout before the harness starts. It
runs on the host, outside any harness sandbox, with a 10-minute limit, and receives no provider
credentials. A failed setup fails the Task Attempt with the command's output. When a Session's
next turn reuses its previous checkout on the same host, the setup outputs stay as the previous
turn left them, and setup does not run again. Only that Session's own turns share them.

## 3. See the branches appear

With `land: local`, the default, the Worklet writes each delivered Task into the mapped
repository as it delivers:

```sh
git -C ~/code/app branch --list 'supertag/session/*'
git -C ~/code/app diff main...supertag/session/HASH
```

Your checkout stays on its own branch; SuperTag never switches it or changes its files. A branch
someone moved outside SuperTag is left as it is. With `land: patch`, the host writes no branch. A
Task with no commits delivers nothing. The Control Plane stores no delivery: the branch comes from
the Worker Host that ran the Task, which maps the repository. Fetch it into another clone with
`git fetch ~/code/app supertag/session/HASH`.

## Build on earlier work in the same Session

Every Task of a Session continues the Session's branch. Ask for a revision in the same
conversation, and the next Task starts from the earlier commits. A remote Workspace's Session
continues on any host, which reads the Session's branch from the git server; a local Workspace's
Session continues only on the host that holds its commits. Submit
independent work in a new Session with `supertag task submit --session NAME`; it gets its own
branch.

### Push or merge from your machine

`land` can also push Session branches to one of the repository's own remotes, or merge finished
Sessions into a branch of yours. `supertag up` does it with your machine's git configuration:

```yaml
workspaces:
  app: { path: ~/code/app, land: { push: origin } }                # push each Session branch
  docs: { path: ~/code/docs, land: { merge: agents } }             # merge into local agents
  notes: { path: ~/code/notes, land: { merge: agents, push: origin } }
```

A Session merges once its work is reported done: its Tag or an operator closes its
[Work Session](../reference/coordination.md#open-work-sessions), or its Objective closes. SuperTag
records a merge commit authored by the Tag, never rebases, and never force-pushes. It refuses to
move a branch you have checked out, so merge into a branch you are not working on. A conflict is
never resolved for you: the Session gets a follow-up Task that starts with the merge in its
checkout and the conflicting files marked, and it merges again once that Task succeeds.

## Use a repository on a git server

A **remote Workspace** keeps its repository on a git server: GitHub, GitLab, Gitea or Forgejo,
Bitbucket, any server you reach over SSH or HTTPS, or a bare repository on the Control Plane's
machine. The Worklet on each Worker Host that serves it reads the Session's source from the server itself, so it
needs no clone and stores no credential: the Control Plane grants a credential for each read or push,
and the host keeps it only in memory, never in a harness or sandbox. A GitHub App credential is
narrowed to a token for the one repository, which expires within an hour; an HTTPS token or SSH
key is handed over as it is. A credential helper runs only on the Control Plane's machine, so a
Workspace whose read credential is a helper can't run Tasks. A `file://` remote is a path on the
Control Plane's machine, so only hosts that share that filesystem can read it. The Worklet that
ran each Task pushes the Session's changes back the same way, with the push credential, granted
only while it holds the landing.

1. Store a **Workspace Credential**: what git delivery presents to the server. Run this on the
   machine that runs the Control Plane, because the secret stays in that machine's credential vault
   and the Control Plane's database keeps only its name and a non-secret identifier:

   ```sh
   supertag workspace credential add handbook-rw --ssh-key ~/.ssh/handbook_deploy
   supertag workspace credential add gitlab --https-token --username supertag
   supertag workspace credential add internal --credential-helper '!/usr/local/bin/mint-token'
   supertag workspace credential add acme-github --github-app --app-id 12345 --installation-id 67890 --private-key ~/acme-app.pem
   ```

   `--https-token` reads the token from `SUPERTAG_WORKSPACE_TOKEN` or a hidden prompt.
   `--ssh-key` takes a key without a passphrase; add `--known-hosts FILE` to pin the server's host
   key; without it, the Control Plane and each Worklet trust the first key they see and
   remember it. `--credential-helper` names a git
   [credential helper](https://git-scm.com/docs/gitcredentials), which may mint short-lived tokens;
   it runs only on the Control Plane's machine, so Worklets can't read with it. `--github-app` stores a GitHub App's private key: for each read or push, git delivery
   mints a token for that one repository with only `contents: read` or `contents: write`.

2. Declare the Workspace: its remote, the branch Sessions start from, its credentials, and where
   changes land:

   ```sh
   supertag workspace put handbook --remote ssh://git@git.acme.internal/handbook.git      --ref main --credential handbook-rw --land merge --target drafts
   ```

   Or as a manifest:

   ```yaml
   apiVersion: supertag/v1
   kind: Workspace
   metadata: { name: handbook }
   spec:
     remote: ssh://git@git.acme.internal/handbook.git
     ref: main
     credentials: { read: handbook-ro, push: handbook-rw }   # or credential: NAME for both
     land: { merge: drafts }                                   # optional: or { review: ... }
   ```

3. Check the whole path. It reads the branch and checks pushing without changing anything:

   ```sh
   supertag workspace check handbook
   ```

   Each step reports a status and what it found, and never claims more than the server proves:

   ```json
   {"workspace_id": "handbook", "steps": [
     {"step": "read", "status": "ok", "detail": "SSH key handbook-rw; main is at 4f2c0d1e9b8a"},
     {"step": "push", "status": "ok", "detail": "SSH key handbook-rw"},
     {"step": "scope", "status": "warning", "detail": "broad: the credential can push any branch; protect your default branch on the server. ..."},
     {"step": "land", "status": "ok", "detail": "finished Sessions merge into drafts"},
     {"step": "review", "status": "not_applicable", "detail": "plain git remote: branch and merge only"},
     {"step": "ci", "status": "unknown", "detail": "not a forge SuperTag can inspect"}]}
   ```

4. Serve it on Worker Hosts: in `supertag.yaml`, `workspaces: { handbook: { remote: true } }` in
   a host service, or `supertag worker-host --remote-workspace handbook`. Bind a Tag with
   `--workspace-id handbook` and no base commit or branch.

Each new Session starts from the commit `ref` names when the Session begins, and keeps that commit.
Without `ref`, it follows the server's default branch.

| `land` | What happens |
| --- | --- |
| omitted | Each delivered Task updates the Session's branch `supertag/session/HASH` on the server |
| `merge` | The Session's branch too, and once the Session's work is reported done it is merged into the target branch with a merge commit, which is pushed |
| `review` | The Session's branch too, and its draft pull request against `base` is opened or updated (GitHub) |

The Worklet that ran the Task pushes from its own copy of the commits; the Control Plane opens
review pull requests. SuperTag pushes only `supertag/session/...` branches and the Workspace's merge target, and
only fast-forward. A branch someone changed outside SuperTag is never overwritten: its landing is
held with the reason. Merge commits name the Tag as their author with a SuperTag no-reply address,
and the person who asked as a co-author. A merge conflict gives the Session a follow-up Task, as
for a local Workspace. Validating the content is your server's job: run CI on `supertag/**` and
on the merge target, and protect your default branch.

`supertag get landings --session-id SESSION` shows where each Session's changes went: `queued`,
`landed` with the commit, `conflict` with the follow-up Task, or `held` with the reason. A Task
succeeds whether or not its changes landed. The Control Plane keeps no copy of a result, so
landing reads it from the Worklet that ran the Task; while that host is away, the landing
waits and retries once the host reports Ready again.

### Review changes in GitHub pull requests

With `review`, people review a Session's work as a draft pull request, as they would a
colleague's. Each delivered Task pushes the Session's branch and then opens the Session's draft
pull request against `base`, or updates its title and description. One Session has one pull
request; its title is the Work Session's title, and its description is the latest Task's result.

```sh
supertag workspace put app --remote https://github.com/acme/app.git --ref main \
  --credential acme-github --land review --base main
```

In a manifest, `land: { review: { base: main } }`. A github.com remote is GitHub; for GitHub
Enterprise Server add `--forge github` (`forge: github`), and SuperTag calls the API at `/api/v3/`
on the remote's host. A plain git server has no review, so `workspace put` refuses it.

The pull request is opened through GitHub's API with the Workspace's push credential: a GitHub
App, whose token for this is narrowed to `pull_requests: write` on the one repository, or an HTTPS
token. Install the App with **Contents** and **Pull requests** read and write. A token authors the
pull request as its person, who then cannot approve it.

SuperTag never merges, closes, or marks a pull request ready, and never reopens one: if someone
closes it, or opens another from the same branch, the landing is held with the reason. When the
pull request is merged, the Work Session that opened it closes, provided the
[GitHub surface](../surfaces/github.md) receives the repository's `pull_request` webhooks.
`supertag get landings` shows the pull request of each landed review.

## Attach data outside the repository

A **Volume** registers a host directory or an S3 bucket and prefix of data. A Task receives it as
a fresh copy beside its checkout, never as a live mount. Three parties agree on each copy:

1. The operator registers the Volume. An `s3://` source names a credential label, never a secret:

   ```sh
   supertag workspace-volume put datasets --source file:///srv/data/datasets
   supertag workspace-volume put reports --source s3://acme-data/reports --credential team-data
   ```

2. Each Worker Host owner maps the Volume in a file passed to
   `supertag worker-host --workspace-mount-mappings FILE`. For `s3://`, only the host owner picks
   the endpoint, region, and the variables that hold the keys:

   ```json
   [
     { "volumeId": "datasets", "source": "file:///srv/data/datasets",
       "destinationRoot": "/srv/supertag-mounts" },
     { "volumeId": "reports", "source": "s3://acme-data/reports", "credential": "team-data",
       "endpoint": "https://s3.eu-west-2.amazonaws.com", "region": "eu-west-2",
       "credentialEnvPrefix": "REPORTS", "destinationRoot": "/srv/supertag-mounts" }
   ]
   ```

   The host reads `REPORTS_ACCESS_KEY_ID`, `REPORTS_SECRET_ACCESS_KEY`, and optionally
   `REPORTS_SESSION_TOKEN` from its own environment. `destinationRoot` must be an existing,
   owner-only directory.

3. The Tag declares its copies in a file passed to `supertag tag put TAG --workspace-mounts FILE`:

   ```json
   [
     { "volumeId": "datasets", "destination": "/srv/supertag-mounts/datasets" },
     { "volumeId": "reports", "destination": "/srv/supertag-mounts/reports",
       "maxBytes": 5368709120, "access": "read-write" }
   ]
   ```

Each destination sits directly in a mapped `destinationRoot`. `maxBytes` defaults to 1 GiB and may
be at most 20 GiB. Copies require the Tag's `files:read` action, and a `read-write` copy also needs
`files:write`. A Tag with copies may not run commands or fetch from the web. Codex, Claude Code,
Cursor, and OpenCode Tasks take copies. The Control Plane freezes each Volume's revision when it
accepts the Task; `supertag get workspace-volume datasets` shows the source and revision.

The Task Attempt's [Worker](../reference/glossary.md#worker), the process that runs it, makes each copy after the checkout and `setup`, so prepared images and
snapshots never contain the data. The Volume credential never leaves the Worker's process. A copy is
refused when it passes its `maxBytes`, when one Task Attempt's copies together pass 20 GiB, or when
it holds more than 10,000 files, symbolic links, or files with another hard link. A Cursor Task in
an E2B or Modal Workspace receives only the files, uploaded to `volumes/<digest>/<name>` inside
its checkout; the sandbox image needs `python3`.

After a successful Task Attempt, its Worker writes a read-write copy's changed and created
files back to the Volume, never deletions or links. A failed or cancelled Task Attempt writes
nothing. `supertag describe task ID` shows what was written: `complete`, `partial`, or `refused`.
A Workspace Volume must stay outside artifact storage. See [Worker Host reference](../reference/worker.md#workspace-volumes).

## Select repository Skills and MCP servers

A Context Set can select **Skills**, reusable instruction packages, from the host's Skill
catalog. A Workspace's own `.mcp.json` servers run only when the Tag lists them:

```sh
supertag tag put builder --instructions "Implement bounded changes with tests." \
  --workspace-id app --workspace-base COMMIT --workspace-mcp docs-search
```

The host reads `.mcp.json` from the Task's base commit, not from a Task's changes.

## Run in E2B or Modal sandboxes

A host can keep Cursor and Claude Code Tasks' checkouts in an E2B or Modal sandbox while the
harness stays on the host. A repository's `.devcontainer` settings choose the sandbox's image and setup. See
[Run a harness in a sandbox](workers.md#run-a-harness-in-a-sandbox).

If a sandbox stops in the middle of a turn, for example because the provider evicted it, the Worker
Host replaces it with a new sandbox that starts from the turn's starting files, and the tool call
that found it stopped tells the harness that its changes from earlier in the turn are gone. A turn
gets at most two replacements; after a third stop, the turn fails.

## Where files live

| What | Where |
| --- | --- |
| Your checkout | Untouched. Deliveries arrive only as `supertag/session/...` branches |
| Task checkouts | The Worker Host's state directory, one per Task Attempt |
| Deliveries | Bundles and patches, kept on the Worker Host that ran the Task. The Control Plane relays none of them |
| Landed changes | A remote Workspace's server, on `supertag/session/...` branches and the merge target |
| Workspace Credentials | The credential vault of the machine that runs the Control Plane. A Worklet holds one only in memory, for a read the Control Plane granted; never in a harness or sandbox |
| Captured artifacts | The Worker Host that captured them; see [Artifacts](../reference/artifacts.md) |

## Current limits

- A local Workspace follows a branch only as far as each host's checkout: SuperTag never fetches,
  so update the checkout, or put a newer `baseCommit`, to move new Sessions forward.
- The host's own Git commands ignore repository hooks, filters, and configuration, and a Task
  Attempt fails when the repository's Git configuration changes while it runs.
- Workspace Volumes arrive as copies only; a Tag with copies may not run commands or fetch from
  the web.
- Git LFS is refused with a clear error: keep large files in a Volume.
- `merge` lands only a Work Session, when its work is reported done; a conversation's own Session
  never merges, so use `branch` for it.
- `review` opens pull requests on GitHub only, not GitLab. Review comments and mentions on the
  pull request do not continue its Session yet, and drafts are not marked ready for you.
- A message naming a repository does not choose a Workspace: a Tag works in the Workspace it is
  bound to.
- `supertag workspace credential add --github-app` stores an App you created; it does not create
  the App for you.

## Next

- [Run Worker Hosts](workers.md)
- [Worker Host reference](../reference/worker.md#workspaces)
