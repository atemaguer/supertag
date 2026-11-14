# Connect GitHub

Connect GitHub repositories so a **Tag**, a persistent AI actor with its own responsibilities and
permissions, replies when someone mentions it in an issue or pull request. For community or
self-hosted use, start with a fine-grained token and a repository webhook. Use a GitHub App only
when you need installation identity and manage its infrastructure.

A **collaboration surface** links SuperTag to an
external work tool. The **Gateway** is the SuperTag service that
receives GitHub webhooks and posts replies. Each mention becomes a **Task**, one request accepted for a Tag. See the
[glossary](../reference/glossary.md) for other terms.

## Before you start

- Permission to create a fine-grained personal access token and a webhook on the repositories.
- The `supertag` CLI installed.
- SuperTag running, from `supertag init` or a [deployment](../guides/self-hosting.md).
- A public HTTPS URL that forwards to the Gateway's GitHub listener, `127.0.0.1:3481` by default.
  Locally, use a temporary tunnel; on a server, a reverse proxy beside the Gateway. This guide
  writes its origin as `YOUR_GATEWAY`.

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

## 2. Generate a webhook secret

Generate a random secret, for example with `openssl rand -hex 32`. Keep the value for the next two
steps.

## 3. Enroll the token and secret

Run the setup command. Paste the secret when it asks for the GitHub repository webhook secret:

```sh
supertag setup surface github --webhook
```

Setup checks the token with GitHub, stores the token and secret in the credential vault, and
records the account in `supertag.yaml` with its listener; `--listen` chooses another. For
non-interactive setup, provide `SUPERTAG_GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET`.

## 4. Configure the repository webhook

```text
Payload URL: https://YOUR_GATEWAY/github/events
Content type: application/json
Secret: the same webhook secret you entered at setup
Events: Issue comments, Issues, Pull requests
```

## 5. Add the repository to a Tag

```sh
supertag tag update lead --add-location github --repo owner/repository
```

The CLI stores GitHub's stable numeric repository ID. `--allowed-user` limits who may ask the Tag
for work there, by numeric GitHub user ID.

## Check that it worked

Mention `@supertag` in an issue or pull-request conversation. The Tag replies in that
conversation. With token setup, replies post as the token's owner.

The trigger is `@supertag`, in any letter case. Avoid it as a GitHub username in your
organization.

## Use a GitHub App instead

```sh
supertag setup surface github --auth app
```

Supply the App ID, installation ID, private key, and webhook secret. For non-interactive setup,
provide `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY_PATH`, and
`GITHUB_WEBHOOK_SECRET`.

Set the App's webhook URL to `https://YOUR_GATEWAY/github/events` with the same secret, and
subscribe to issue comments, issues, and pull requests.

### Check that it worked

Mention `@supertag` in an issue in the added repository. The Tag replies as the App.

## Rules

- A repository without a Tag fails before the Control Plane accepts a Task.
- Gateway credentials authenticate only webhooks and replies. GitHub Workspace sources and
  GitHub's hosted MCP server use separate credentials. See
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

- [GitHub MCP tools](worker-tools.md#github)
- [Self-hosting](../guides/self-hosting.md)
