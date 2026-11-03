# Connect GitHub

Connect GitHub repositories so a **Tag**, a persistent AI identity with its own responsibilities and
permissions, replies when someone mentions it in an issue or pull request. For community or
self-hosted use, start with a fine-grained token and a repository webhook. Use a GitHub App only
when you need installation identity and manage its infrastructure.

A **collaboration surface** links SuperTag to an
external work tool. The **Gateway** is the part of the **Control Plane**, the SuperTag service, that
receives GitHub webhooks. Each mention becomes a **Task**, one request accepted for a Tag. See the
[glossary](../reference/glossary.md) for other terms.

## Before you start

- Permission to create a fine-grained personal access token and a webhook on the repositories.
- The `supertag` CLI installed.
- A Gateway that GitHub can reach over HTTPS. A local Control Plane listens on `127.0.0.1:3434`,
  which GitHub cannot reach. For development, expose port 3434 through a temporary HTTPS tunnel and
  use the tunnel's `https://` origin as `YOUR_GATEWAY`. For a lasting setup, deploy the Control
  Plane first; see [Self-hosting](../guides/self-hosting.md).

## 1. Create a fine-grained token

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new).
For organization repositories, choose the organization as **Resource owner**. The organization may
need to approve the token before it works. Limit it to the repositories SuperTag should serve, and
grant these repository permissions:

| Permission | Access |
| --- | --- |
| Issues | Read and write |
| Pull requests | Read and write |
| Metadata | Read-only |

## 2. Start the Control Plane

In one terminal, start the Control Plane and keep it running:

```sh
supertag start control-plane
```

## 3. Generate a webhook secret

Generate a random secret, for example with `openssl rand -hex 32`. Keep the value for the next two
steps.

## 4. Enroll the token and secret

In a second terminal, run the setup command. Paste the secret when it asks for the GitHub
repository webhook secret:

```sh
supertag setup surface github --webhook
```

The command prints `user-GITHUB_USER_ID` for the next step. For non-interactive setup, provide
`SUPERTAG_GITHUB_TOKEN` and, optionally, `GITHUB_WEBHOOK_SECRET`.

### Or declare the account in a manifest

On a shared Control Plane managed from files, declare the token instead of running setup. The
manifest says where each secret comes from, never the value:

```yaml
apiVersion: supertag/v1
kind: SurfaceAccount
metadata:
  name: acme-github
spec:
  provider: github
  secrets:
    token: { env: SUPERTAG_GITHUB_TOKEN }
    webhookSecret: { env: GITHUB_WEBHOOK_SECRET }
```

Run `supertag apply -f acme-github.yaml`. Apply checks the token with GitHub, as setup does, and
prints `user-GITHUB_USER_ID` for the webhook URL. For GitHub Enterprise Server, add
`configuration: { apiBaseUrl: https://HOST/api/v3 }`. See
[Declare Surface Accounts](../operations/resources.md#declare-surface-accounts).

## 5. Configure the repository webhook

```text
Payload URL: https://YOUR_GATEWAY/webhooks/github/user-GITHUB_USER_ID
Content type: application/json
Secret: the same webhook secret you entered at setup
Events: Issue comments, Issues, Pull requests
```

## 6. Add the repository to a Tag

With the Control Plane still running, create the Tag and add the repository. Skip `create tag` if
the Tag already exists.

```sh
supertag create tag engineering
supertag update tag engineering --add-location github --repo owner/repository
```

The CLI stores GitHub's stable numeric repository ID.

## Check that it worked

Mention `@supertag` in an issue or pull-request conversation. The Tag replies in that
conversation. With token setup, replies post as the token's owner.

An **Objective** is an outcome a Tag owns, with success criteria. One created here with
`@supertag objective ...` names every **Workspace**, a named repository that an Objective's Tasks
work in, whose `source` is this repository. See [Start from Slack or GitHub](../guides/workspaces.md#start-from-slack-or-github).

## Change the mention trigger

Start the Control Plane with a different mention:

```sh
supertag start control-plane --github-mention @NAME
```

Choose a trigger that is not another person's GitHub username. Otherwise every mention of that
person also invokes the Tag.

### Check that it worked

Mention `@NAME` in an issue in the added repository. The Tag replies.

## Use a GitHub App instead

```sh
supertag setup surface github --auth app
```

Supply the App ID, installation ID, private key, and webhook secret. For non-interactive setup,
provide `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY_PATH`, and
`GITHUB_WEBHOOK_SECRET`. A manifest declares the same App:

```yaml
apiVersion: supertag/v1
kind: SurfaceAccount
metadata:
  name: acme-github-app
spec:
  provider: github
  configuration:
    auth: app
    appId: "123456"
    installationId: "7890123"
  secrets:
    privateKey: { file: github-app.private-key.pem }
    webhookSecret: { env: GITHUB_WEBHOOK_SECRET }
```

Configure the webhook URL:

```text
https://YOUR_GATEWAY/webhooks/github/installation-INSTALLATION_ID
```

Subscribe to issue comments, issues, and pull requests, then start the Control Plane with the App's
real mention name.

### Check that it worked

Mention the App's name in an issue in the added repository. The Tag replies.

## Rules

- A repository without a Tag fails before the Control Plane accepts a Task.
- Gateway credentials authenticate only webhooks and replies. Commit-pinned repository resolution
  and GitHub's hosted MCP server use separate credentials held by the **Worker**, the code that
  completes a Task. See
  [credential storage](../reference/credential-storage.md).

## If something goes wrong

- **No reply.** Follow the [first-reply checklist](../guides/troubleshooting.md). Confirm that
  GitHub reaches the Gateway over HTTPS and that the webhook secret matches the one entered at
  setup.
- **The token is rejected for an organization repository.** The organization may need to approve
  the fine-grained token.
- **Enrollment problems.** See
  [Check the Surface Account](../guides/troubleshooting.md#2-check-the-surface-account).

## Next

- [Add your team's chat](../../README.md#next-add-your-teams-chat)
- [GitHub MCP tools](worker-tools.md#github) and commit-pinned repository resolution
- [Self-hosting](../guides/self-hosting.md)
