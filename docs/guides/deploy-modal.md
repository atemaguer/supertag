# Deploy the Control Plane on Modal

A **Tag** is a persistent AI actor with its own identity, responsibilities, permissions, and work history. The **Control
Plane** is the service that stores a SuperTag organization and schedules its work; it is the one
public endpoint for operators, **Worker Hosts** (the machines that run the work), and the
optional **Gateway**, which connects **collaboration surfaces** such as Slack. This guide runs the
Control Plane in one always-on Modal container behind a web endpoint, with external
PostgreSQL. See the [glossary](../reference/glossary.md) for other terms.

One command deploys it. `supertag deploy` reads a configuration file that holds no secret, so the
file lives in your repository and a laptop and a CI job deploy the same thing from it. The secrets
live in Modal, where the first deploy puts them.

```sh
supertag deploy init modal    # writes supertag-deploy.yaml
supertag deploy check         # can this machine deploy? changes nothing
supertag deploy               # deploys, waits for health, verifies, prints the URL
supertag deploy status        # what Modal runs now
```

Modal's web endpoint terminates TLS and forwards HTTP/1.1 and WebSocket upgrades. The Control
Plane therefore carries its gRPC API inside a WebSocket, the **tunnel**, and runs SuperTag's own
TLS end to end inside it. Clients use the endpoint's stable URL with `wss://`. Modal sees only
ciphertext. Modal's raw TCP tunnels would carry native gRPC, but their addresses change with
each container, so this deployment does not use them.

```text
operators, Worker Hosts ── wss://WORKSPACE--supertag.modal.run ──> web endpoint, port 8080
                                                                    Control Plane
                                                                    Gateway (optional)
                                                                      │
                                    external PostgreSQL, Modal Volume
```

The deployment is one container (`min_containers=1`, `max_containers=1`, non-preemptible) from the
hosted image, defined by [`app.py`](../../deploy/modal/app.py), which is built into the CLI. A
Modal Volume at `/var/lib/supertag` holds the Gateway's connector state. With the Gateway on, it
runs in the same container and reaches the Control Plane on `https://127.0.0.1:3434`. The Gateway
is not given the database URL, the operator token, or the Control Plane's TLS settings, and the
Control Plane is not given the surface settings or surface credentials. Both run as one user in
one container, though, so either could read the other's files, including the TLS key: they share
one trust boundary.

The function supervises the service: if the Control Plane, or the Gateway beside it, exits, the
container exits too and Modal starts a replacement.

Modal can also run Cursor and Claude Code Tasks' Workspaces for a Worker Host; that is independent of where the
Control Plane runs. See [Run a harness in a sandbox](workers.md#run-a-harness-in-a-sandbox).

## Before you start

- The `supertag` CLI. See [Install SuperTag](../operations/install.md).
- The Modal CLI at the version in [`requirements.txt`](../../deploy/modal/requirements.txt),
  signed in to your workspace with `modal setup`.
- A PostgreSQL database reachable from Modal with TLS.

You build no image and issue no certificate: deploy runs the release's published image and issues
the certificate itself.

## 1. Write the configuration

In the repository that will own the deployment:

```sh
supertag deploy init modal
```

This writes `supertag-deploy.yaml`. Name your Modal workspace in it, so that a deploy from a
machine signed in to another workspace is refused:

```yaml
target: modal
modal:
  app: supertag
  workspace: acme
```

`version` names the SuperTag release to run and defaults to the release of the CLI that deploys;
init writes the CLI's own. To run your own build instead, set `image` to a reference pinned by
digest, as [Build the hosted image](../../deploy/native/README.md#build-the-hosted-image) shows,
and `modal.registry-secret` for a private registry.
[supertag-deploy.yaml](../reference/supertag-deploy-yaml.md) lists every key.

## 2. Deploy

```sh
export SUPERTAG_DATABASE_URL='postgresql://...?sslmode=require'
supertag deploy
```

The database URL is read from the environment on the first deploy only; without it, deploy asks
for it at a masked prompt. The first deploy:

1. Runs the checks of [`supertag deploy check`](#check-before-you-deploy) and prints its plan:
   that the Modal CLI is signed in to the workspace the file names, that the configuration
   passes the rules of `supertag check deployment`, and what it is about to create. A problem
   stops it here, before anything changes.
2. Creates the secrets Modal does not hold yet. It generates the admin **Operator Token**, the
   credential that signs in the deployment's first operator, and the Gateway's credential
   straight into Modal. Neither is written to the repository.
3. Issues a certificate authority and the Control Plane's certificate, stores the certificate and
   key in Modal, and writes the authority's public certificate to `supertag-deploy-ca.pem` beside
   the configuration.
4. Rolls out the image, pinned by digest.
5. Waits for the endpoint's `/healthz`, then checks what `supertag verify deployment` checks:
   gRPC health, that anonymous calls and an invalid Worker Host credential are refused, and that
   the Operator Token works.
6. Prints the `wss://` URL and the next commands.

Commit `supertag-deploy.yaml` and `supertag-deploy-ca.pem`. The CA file is public: every client
and Worker Host needs it.

The machine that ran the first deploy keeps the Operator Token in a private file outside the
repository, and deploy saves the deployment for the CLI under the app's name, as
`supertag connect` would:

```sh
supertag status --gateway supertag
```

Run `supertag deploy` again at any time. It creates only what is missing and never replaces a
secret, so a deploy with nothing changed only rolls the same deployment out again.

## Check before you deploy

Two commands say what a deploy would do without doing it. Neither creates a secret, issues a
certificate, or rolls anything out.

```sh
supertag deploy check
```

`check` answers whether this machine can deploy: the Modal CLI is installed and signed in to the
workspace and environment the file names, the configuration is valid, and each secret is either
held by Modal, generated by deploy, or supplied by you. For one that is missing it says how to
supply it. It prints one line per problem and exits non-zero when there is one:

```text
Check for the modal target
  target        ready: its tooling is installed and signed in
  secret store  Modal secrets in workspace acme
  configuration valid
  secret        create   SUPERTAG_OPERATOR_TOKEN (generated)
  secret        create   SUPERTAG_GATEWAY_CREDENTIAL (generated)
  secret        missing  SUPERTAG_DATABASE_URL
  secret        create   credentials (none until `supertag deploy secret push`)
  certificate   issue    for acme--supertag.modal.run, 127.0.0.1; writes its public CA certificate to supertag-deploy-ca.pem
problem: SUPERTAG_DATABASE_URL is not stored yet and this run cannot prompt for it; set it in the environment for this run, or store it with `supertag deploy secret set SUPERTAG_DATABASE_URL`
```

```sh
supertag deploy --dry-run
```

`--dry-run` prints the whole plan: the same lines, then the image by digest, the endpoint the
deployment will have, whether the Gateway runs and with which flags, and every non-secret
setting. It needs the same access as a deploy and fails on the same problems, so it suits a CI job
on pull requests. A real deploy prints this plan before it acts.

## See what is deployed

```sh
supertag deploy status
```

`status` asks Modal and the running Control Plane, and prints JSON. This machine's files are only
compared with the answer, never used in place of it:

| Field | Says | Asked of |
| --- | --- | --- |
| `deployed`, `state` | Whether the app is deployed | Modal |
| `endpoint`, `healthy` | The `wss://` URL, and whether its `/healthz` answers | The endpoint |
| `version` | The SuperTag release that answers | The Control Plane |
| `secrets` | The names of the secrets, never a value | Modal |
| `certificate.matches_deployment` | Whether `supertag-deploy-ca.pem` belongs to the deployed certificate: SuperTag's TLS connects with it | The Control Plane |
| `certificate.ends_in_days` | Days until the certificate ends, when the CA file matches | The CA file |
| `verification` | The result of `supertag verify deployment`'s checks | The Control Plane |

`certificate.matches_deployment` is `false` when the Control Plane presents a certificate the CA
file did not issue, and `null` when that could not be checked: the file is missing, or the
endpoint does not answer. Modal does not report which image a deployment runs, so `status` gives the release the Control
Plane itself reports. `status` fails only when Modal cannot be asked.

## 3. Connect a Worker Host

Create an **Auth Key** (a one-time enrollment secret) for the host, then enroll and run it on the
machine that owns the **harness** (the coding agent that does the work, such as Codex):

```sh
supertag auth-key create build-1 --role host --all-tags --gateway supertag
# Save the printed key as build-1.key (mode 0600) on the Worker Host, copy
# supertag-deploy-ca.pem there, then:
export SUPERTAG_SERVER_CA_FILE=$PWD/supertag-deploy-ca.pem
supertag host enroll build-1 --control-plane wss://WORKSPACE--supertag.modal.run \
  --state-directory ~/.supertag-build-1 --auth-key file:build-1.key
supertag worklet --control-plane wss://WORKSPACE--supertag.modal.run \
  --state-directory ~/.supertag-build-1 --harness codex
```

`--all-tags` lets the host run every Tag; name them with `--tag` instead to allow only some. The
Worker Host connects outbound and needs no inbound port. A state directory of its own keeps this
host apart from a local setup in `~/.supertag` on the same machine.

## Check that it worked

```sh
export SUPERTAG_SERVER_CA_FILE=$PWD/supertag-deploy-ca.pem
supertag verify deployment wss://WORKSPACE--supertag.modal.run --require-ready
```

`--require-ready` fails until a Worker Host is ready. Verification reads the Operator Token from
`SUPERTAG_OPERATOR_TOKEN`.

## Secrets

Modal holds the deployment's secrets, each in a Modal secret named after the app:

| Modal secret | Holds | Comes from |
| --- | --- | --- |
| `supertag-operator-token` | The admin Operator Token | Generated by the first deploy |
| `supertag-gateway-credential` | The credential the Gateway signs in with | Generated by the first deploy |
| `supertag-database-url` | The PostgreSQL URL | You, on the first deploy or with `secret set` |
| `supertag-tls` | The Control Plane's certificate and key, and the CA certificate | Issued by the first deploy |
| `supertag-credentials` | Collaboration surface, Workspace, and Volume credentials | `secret push` |
| `supertag-env-NAME` | One more secret variable | `secret set` |

Set, list, and remove them without the Modal dashboard:

```sh
supertag deploy secret set SUPERTAG_DATABASE_URL    # reads the value from standard input
supertag deploy secret list                         # names only
supertag deploy secret unset SUPERTAG_NOTIFY_SECRET_OPS
supertag deploy
```

A value is read from standard input, with a masked prompt in a terminal. It is never accepted as
a flag or printed. The services read secrets only when they start, so every change takes effect
at the next `supertag deploy`; each command says so.

Modal never returns a secret's value. To replace the Operator Token or the Gateway's credential,
remove it and deploy; deploy generates a new one, and keeps the new Operator Token on the machine
that ran it:

```sh
supertag deploy secret unset SUPERTAG_OPERATOR_TOKEN
supertag deploy
```

To give the deployment a token you chose, pipe it to
`supertag deploy secret set SUPERTAG_OPERATOR_TOKEN`. Anyone with access to the Modal workspace's
secrets can change these secrets and deploy.

## Collaboration surfaces

Turn the Gateway on by naming its connectors in `supertag-deploy.yaml`. Their settings that are
not secret go in `env`:

```yaml
gateway:
  flags: [--slack-socket-mode, --slack-state-directory, /var/lib/supertag/slack]
env:
  SUPERTAG_SLACK_ACCOUNT_ID: acme
  SUPERTAG_SLACK_TEAM_ID: T0123456789
  SUPERTAG_SLACK_CHANNEL_ID: C0123456789
  SUPERTAG_SLACK_TAG_ID: lead
  SUPERTAG_SLACK_ALLOWED_USERS: U0123456789
```

The web endpoint reaches only the Control Plane's tunnel, so the Gateway can serve only connectors
that connect outbound:

- **Lark or Feishu**, over its outbound long connection:
  `--lark-state-directory /var/lib/supertag/lark`, with `SUPERTAG_LARK_ACCOUNT_ID`,
  `SUPERTAG_LARK_DOMAIN` (`lark` or `feishu`), `SUPERTAG_LARK_APP_ID`, `SUPERTAG_LARK_TENANT_KEY`,
  `SUPERTAG_LARK_BOT_OPEN_ID`, `SUPERTAG_LARK_CHAT_ID`, `SUPERTAG_LARK_TAG_ID`, and
  `SUPERTAG_LARK_ALLOWED_USERS` (comma-separated). The app secret comes from the credentials
  [`supertag setup surface lark`](../surfaces/lark.md) stores (see
  [Change a credential](#change-a-credential)).
- **Slack**, over Socket Mode: `--slack-socket-mode --slack-state-directory
  /var/lib/supertag/slack`, with `SUPERTAG_SLACK_ACCOUNT_ID`, `SUPERTAG_SLACK_TEAM_ID`,
  `SUPERTAG_SLACK_CHANNEL_ID`, `SUPERTAG_SLACK_TAG_ID`, and `SUPERTAG_SLACK_ALLOWED_USERS`
  (comma-separated). The bot token and app-level token come from the credentials
  [`supertag setup surface slack`](../surfaces/slack.md) stores (see
  [Change a credential](#change-a-credential)).
- **Operator notifications to a webhook**: `--notify webhook:HTTPS_URL#NAME`, with the bearer
  secret stored by `supertag deploy secret set SUPERTAG_NOTIFY_SECRET_NAME` (the name uppercased,
  `-` as `_`).

A connector without its settings or credentials stops the Gateway, and with it the container. So
deploy first without `gateway`, store the connector's credentials, then add `gateway` and deploy
again.

GitHub, Linear, Microsoft Teams, and Slack HTTP events need inbound webhooks, which this
deployment cannot receive. For them, run a Gateway on a host that can receive webhooks (see
[service deployment definitions](../../deploy/native/README.md)), enrolled with a gateway Auth Key (`supertag gateway enroll NAME`); it dials this Control Plane's `wss://`
URL with its own credential.

### Change a credential

The services read the credentials of collaboration surfaces, remote Workspaces, and S3 Volumes
from their environment, and cannot store one themselves. You keep them in a private file on your
machine and upload them:

1. Point the operator commands at the file the last deploy named, by absolute path:

   ```sh
   export SUPERTAG_CREDENTIAL_FILE="$HOME/.config/supertag/deployments/supertag/credentials.json"
   ```

   On macOS the directory is `~/Library/Application Support/supertag/deployments/supertag`.

2. Store what the deployment needs, against the deployed Control Plane. Each command works as it
   does on a local setup:

   | Credential | Command |
   | --- | --- |
   | A collaboration surface's secrets | [`supertag setup surface`](../surfaces/README.md), or `supertag gateway credential store ID` |
   | A remote Workspace's git credential | [`supertag workspace credential add`](workspaces.md) |
   | An S3 Volume's signing credential | [`supertag volume credential set`](../reference/artifacts.md#keep-every-capture-on-a-volume) |

3. Upload them and deploy:

   ```sh
   supertag deploy secret push
   supertag deploy
   ```

Push replaces what Modal held with the file's contents, and prints the credential IDs each
service now reads, never a value. The file on your machine is the only readable copy, so keep it,
and push from the machine that has it.
[Environment credential vault](../reference/credential-storage.md#environment-credential-vault)
gives the format and its size limit. To keep credentials in HashiCorp Vault instead, set
`credential-vault: vault`, put `VAULT_ADDR` in `env`, and store the token with
`supertag deploy secret set VAULT_TOKEN`; see
[Credential vault backends](../reference/credential-storage.md#credential-vault-backends).

## Deploy from CI

CI runs the same command with the same file. It needs only Modal's own credentials: create a
token with `modal token new` and store its two values as CI secrets. Deploy from a laptop first,
so the secrets exist and the CA file is committed.

```yaml
name: Deploy SuperTag
on:
  push:
    branches: [main]
    paths: [supertag-deploy.yaml, supertag-deploy-ca.pem]
  workflow_dispatch:
concurrency: deploy-supertag
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install -r https://raw.githubusercontent.com/atemaguer/supertag/main/deploy/modal/requirements.txt
      - run: curl -fsSL https://supertag.sh/install | sh
      - run: ~/.local/bin/supertag deploy --non-interactive
        env:
          MODAL_TOKEN_ID: ${{ secrets.MODAL_TOKEN_ID }}
          MODAL_TOKEN_SECRET: ${{ secrets.MODAL_TOKEN_SECRET }}
```

Without an Operator Token, deploy runs the checks that need none: health, and that anonymous
calls and an invalid Worker Host credential are refused. To also check operator sign-in, store an
Operator Token as a CI secret and pass it as `SUPERTAG_OPERATOR_TOKEN`. `--non-interactive` fails
instead of prompting when a secret is missing.

On pull requests, run `supertag deploy --dry-run` in place of the last step, with the same two
Modal secrets. It prints what merging would deploy and fails when the configuration, the
image, or a secret is not ready, and it changes nothing.

## The certificate

The host name `WORKSPACE--LABEL.modal.run` cannot carry a publicly trusted certificate for
SuperTag's own TLS. Deploy therefore issues a certificate authority of its own, and from it one
certificate for the endpoint's host and for `127.0.0.1`, where the Gateway reaches the Control
Plane. Every client trusts that authority through `SUPERTAG_SERVER_CA_FILE`, or through
`supertag connect --server-ca-file`.

Deploy discards the authority's private key once the certificate is signed. Nothing can then
issue another certificate your clients would trust, and no secret store has to guard that key.
The certificate and its authority are valid for five years; deploy warns from 60 days before the
end. To renew, or after renaming the app, its label, or its environment:

```sh
supertag deploy --renew-certificate
```

Renewing issues a new authority and rewrites `supertag-deploy-ca.pem`. Commit it and copy it to
every client and Worker Host; they cannot connect until they have it.

To use a certificate you issued, set `tls.mode: provided` and name its files; see
[supertag-deploy.yaml](../reference/supertag-deploy-yaml.md#tls). Deploy by hand, as the last
section shows, to require client certificates from every caller.

## Upgrade

Set `version` in `supertag-deploy.yaml` to the new release and run `supertag deploy`. The Control
Plane migrates its database schema when it starts. See
[Upgrade a deployment](../operations/control-plane.md#upgrade-a-deployment).

## Cold starts and restarts

- The container is always running. A deploy or a host failure replaces it; the replacement pulls
  the image and starts within the two-minute startup timeout. Requests during that time get `503`,
  opening a tunnel waits up to 30 seconds, and each host's Worklet and the Gateway retry.
- Each open tunnel is one function call, closed after the 24-hour function timeout; clients
  reconnect at once.
- Both ends of a tunnel ping every 20 seconds, which keeps idle tunnels open.

## Limits

- One container. Every Control Plane runs the controllers, so do not raise `max_containers`.
- Native gRPC (`https://`) does not reach this deployment; clients use the `wss://` URL. The
  CLI uses your CA when the deployment is saved with `supertag connect --server-ca-file`, as
  deploy saves it; the desktop app trusts only the system roots, so it cannot connect to a
  certificate from your own CA.
- The web endpoint forwards only the tunnel port, so the Gateway here serves Lark, Slack Socket
  Mode, and webhook notifications only. GitHub, Linear, Microsoft Teams, and Slack HTTP events
  need a Gateway on another host.
- Modal returns no secret's value, so the credentials you push have one readable copy, on the
  machine that pushed them.

## Remove the deployment

```sh
modal app stop supertag
modal volume delete supertag-state
supertag deploy secret list
```

Delete each Modal secret the list names with `modal secret delete`: `supertag-operator-token`,
`supertag-gateway-credential`, `supertag-database-url`, `supertag-tls`, `supertag-credentials`,
and any `supertag-env-NAME`. Then delete the database if it was dedicated to this deployment,
and this machine's private directory for it. `modal app list` and `modal volume list` confirm the
removal.

## If something goes wrong

- **Deploy says the release publishes no hosted image.** Releases before the one that introduced
  `supertag deploy` have none. Set `version` to a release that does, or `image` to your own build.
- **Deploy says the Modal CLI is signed in to another workspace.** Run `modal profile activate`,
  or in CI use a token from the workspace the file names. `supertag deploy check` shows this and
  every other problem at once.
- **You are not sure what is running.** `supertag deploy status` asks Modal and the Control
  Plane.
- **The deployment does not become healthy.** The container exits whenever its service does.
  Read its log with `modal app logs supertag`: an unreachable database stops the Control Plane,
  and a connector without its settings or credentials stops the Gateway.
- **Verification cannot reach the Control Plane over TLS.** The stored certificate is not the one
  `supertag-deploy-ca.pem` belongs to, for example after the file was restored from an older
  commit. Run `supertag deploy --renew-certificate`.
- **Deploy says the certificate is stored but its CA file is missing.** Restore
  `supertag-deploy-ca.pem` from version control.
- **A connector says its credentials are missing.** Modal holds an older upload. Follow
  [Change a credential](#change-a-credential).

## Deploy by hand

`supertag deploy` composes steps you can also run yourself, for example to require client
certificates. They are the steps every platform shares; see
[Configure a deployment](deployment-setup.md).

1. Issue the Control Plane's certificate from your own CA for the endpoint's host and
   `IP:127.0.0.1`, as
   [Issue certificates from your own CA](../../deploy/native/README.md#issue-certificates-from-your-own-ca)
   shows. The host is `WORKSPACE--LABEL.modal.run`; deployed to a Modal environment other than
   your default one, it also carries the environment's name (`WORKSPACE-ENVIRONMENT--LABEL`).
2. Write and check the service files:

   ```sh
   export SUPERTAG_DATABASE_URL='postgresql://...?sslmode=require'
   supertag setup deployment modal --output supertag-deployment
   supertag check deployment modal --directory supertag-deployment
   ```

3. Create the Modal secrets and deploy the app definition from a checkout:

   ```sh
   modal secret create supertag-control-plane --from-dotenv supertag-deployment/control-plane.env
   modal secret create supertag-control-plane-tls \
     SUPERTAG_TLS_CERT_PEM="$(cat server.pem)" SUPERTAG_TLS_KEY_PEM="$(cat server.key)"
   SUPERTAG_MODAL_IMAGE=REGISTRY/supertag-hosted@sha256:DIGEST modal deploy deploy/modal/app.py
   ```

   With the Gateway on, create `supertag-gateway` from `gateway.env` plus your connector
   settings, and `supertag-gateway-tls` with `SUPERTAG_SERVER_CA_PEM` (your CA), and deploy with
   `SUPERTAG_MODAL_GATEWAY=on` and `SUPERTAG_MODAL_GATEWAY_FLAGS` naming the connectors. To
   require client certificates, add `SUPERTAG_TLS_CLIENT_CA_PEM` to `supertag-control-plane-tls`
   and the Gateway's `SUPERTAG_CLIENT_CERT_PEM` and `SUPERTAG_CLIENT_KEY_PEM` to
   `supertag-gateway-tls`; each operator and Worker Host then sets `SUPERTAG_CLIENT_CERT_FILE`
   and `SUPERTAG_CLIENT_KEY_FILE`. For a private registry, set `SUPERTAG_MODAL_REGISTRY_SECRET`
   to a Modal secret with `REGISTRY_USERNAME` and `REGISTRY_PASSWORD`.

4. Verify:

   ```sh
   export SUPERTAG_SERVER_CA_FILE=$PWD/ca.pem
   supertag verify deployment wss://WORKSPACE--supertag.modal.run \
     --env-file supertag-deployment/operator.env
   ```

To change a credential, store it as
[Store credentials](deployment-setup.md#store-credentials) shows, run
`supertag gateway credential export --directory supertag-deployment`, create both secrets again
with `modal secret create --force`, and deploy again.

## Next

- [supertag-deploy.yaml](../reference/supertag-deploy-yaml.md) for every configuration key
- [Service deployment definitions](../../deploy/native/README.md) for the role contract and TLS files
- [Control Plane operations](../operations/control-plane.md)
