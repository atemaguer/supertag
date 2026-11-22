# supertag-deploy.yaml

`supertag-deploy.yaml` says what `supertag deploy` deploys and where: the hosted **Control
Plane**, the service that stores a SuperTag organization and schedules its work, and the optional
**Gateway**, the service that connects collaboration surfaces such as Slack. The file holds no
secret, so it is committed with the repository, and a laptop and a CI job deploy the same thing
from it. [Deploy on Modal](../guides/deploy-modal.md) walks through a deployment.

It is a different file from [`supertag.yaml`](supertag-yaml.md), which lists the services
`supertag up` runs on one machine.

| File | Written by | Holds |
| --- | --- | --- |
| `supertag-deploy.yaml` | `supertag deploy init TARGET`, then you | The settings below. No secret |
| `supertag-deploy-ca.pem` | `supertag deploy` | The public certificate of the authority that issued the Control Plane's certificate. Clients and Worker Hosts, the machines that run the work, trust it through `SUPERTAG_SERVER_CA_FILE` |

`supertag deploy` reads the file from the current directory; `--config FILE` names another.
Relative paths in the file resolve against the file's directory. An unknown key is an error.

## Commands that read it

| Command | Does |
| --- | --- |
| `supertag deploy init TARGET` | Writes a starting file |
| `supertag deploy check` | Checks that this machine can deploy: the target's tooling and sign-in, the configuration, and each secret. Changes nothing |
| `supertag deploy --dry-run` | Prints what a deploy would do: the image by digest, the endpoint, each secret and the certificate it would create or keep, and what rolls out. Changes nothing |
| `supertag deploy` | Runs the check, prints the plan, creates what is missing, rolls out, waits for health, and verifies |
| `supertag deploy status` | Asks the target and the running Control Plane what is deployed, and compares the CA file with it |
| `supertag deploy secret set`, `list`, `unset`, `push` | Manage the deployment's secrets in the target's secret store |

## Example

```yaml
target: modal

gateway:
  flags: [--slack-socket-mode, --slack-state-directory, /var/lib/supertag/slack]
env:
  SUPERTAG_SLACK_ACCOUNT_ID: acme
  SUPERTAG_SLACK_TEAM_ID: T0123456789

modal:
  app: supertag
  workspace: acme
```

## Settings for every target

These mean the same wherever the deployment runs.

| Key | Default | Meaning |
| --- | --- | --- |
| `target` | Required | Where the deployment runs. It names the block of target settings below. Today: `modal` |
| `version` | The release of the CLI that deploys | The SuperTag release to run. Deploy resolves it to the release's published image, pinned by digest |
| `image` | None | An image reference pinned by digest (`NAME@sha256:DIGEST`), instead of `version`. Use it for your own build of the hosted image |
| `credential-vault` | What the target supports best: `env` on Modal | Where the services read the credentials of collaboration surfaces, remote Workspaces, and S3 Volumes: `env`, `vault`, or `file`. See [Credential vault backends](credential-storage.md#credential-vault-backends) |
| `gateway` | Off | The Gateway beside the Control Plane |
| `gateway.flags` | Required with `gateway` | The Gateway's connector flags, one argument per item |
| `gateway.enabled` | `true` | `false` turns the Gateway off and keeps its flags in the file |
| `env` | None | Settings the services read from their environment that are not secret, such as a connector's account IDs, `SUPERTAG_OPERATOR_PRINCIPAL`, or `VAULT_ADDR` |
| `tls` | `mode: generated` | Where the Control Plane's certificate comes from; see [TLS](#tls) |

Set `version` or `image`, not both. A release's image reference is the release asset
`supertag-hosted-image.txt`; deploy checks it against the release's `SHA256SUMS` and accepts only
the official repository, by digest.

`env` refuses a key that looks like a secret, because the file is not private. Store a secret
with `supertag deploy secret set NAME` instead. It also refuses the keys other settings own:
`SUPERTAG_CREDENTIAL_VAULT`, `SUPERTAG_STATE_DIR`, and the TLS file variables.

### TLS

The Control Plane always serves its own TLS, end to end, also behind a platform edge that has a
certificate of its own.

| Key | Meaning |
| --- | --- |
| `tls.mode: generated` | Deploy issues a certificate authority and one certificate for the endpoint, stores the certificate and key with the deployment's secrets, and writes the authority's public certificate to `tls.ca-file`. The authority's private key is discarded |
| `tls.mode: provided` | You issue the certificate. Deploy reads `tls.cert-file` and `tls.key-file` and stores them the first time, and again with `--renew-certificate` |
| `tls.ca-file` | The authority clients trust. Default with `generated`: `supertag-deploy-ca.pem` beside the configuration. With `provided`: the authority that issued your certificate, or leave it out for a publicly trusted one |
| `tls.cert-file`, `tls.key-file` | With `provided`: the PEM certificate chain and its private key. Keep the key out of the repository; deploy needs the two files only when it stores them |

A generated certificate names the endpoint's host, and the address where the Gateway reaches the
Control Plane inside the deployment. It is valid for five years.
`supertag deploy --renew-certificate` issues a new authority and certificate; every client and
Worker Host then needs the new CA file.

## Settings for the Modal target

| Key | Default | Meaning |
| --- | --- | --- |
| `modal.app` | `supertag` | The Modal app's name. It also names the state Volume (`APP-state`) and prefixes the Modal secrets (`APP-operator-token`) |
| `modal.label` | The app's name | The web endpoint's label: the endpoint is `https://WORKSPACE--LABEL.modal.run` |
| `modal.workspace` | The workspace the Modal CLI is signed in to | The Modal workspace to deploy to. Deploy refuses when the Modal CLI is signed in to another |
| `modal.environment` | The workspace's default | A Modal environment. The endpoint's host then also carries its name |
| `modal.registry-secret` | None | A Modal secret with `REGISTRY_USERNAME` and `REGISTRY_PASSWORD`, to pull `image` from a private registry |

`app`, `label`, `workspace`, and `environment` are each 1 to 40 lowercase letters, digits, and
hyphens.

## Secrets

No secret is in the file. The target's secret store holds them, and deploy creates the ones that
are missing and never replaces one:

| Secret | Set by |
| --- | --- |
| The admin Operator Token, which signs in the deployment's first operator | Generated by the first deploy. The machine that ran it keeps a copy in a private file outside the repository |
| The Gateway's credential | Generated by the first deploy |
| `SUPERTAG_DATABASE_URL` | You: in the environment or at the prompt of the first deploy, or with `supertag deploy secret set SUPERTAG_DATABASE_URL` |
| The Control Plane's certificate and key | The first deploy, and `--renew-certificate` |
| Collaboration surface, Workspace, and Volume credentials, with `credential-vault: env` | `supertag deploy secret push` |
| Any other secret variable, such as `VAULT_TOKEN` | `supertag deploy secret set NAME` |

The services read secrets when they start, so a change takes effect at the next
`supertag deploy`.

## What a deploy reads from the environment

| Variable | Use |
| --- | --- |
| `SUPERTAG_DATABASE_URL` | The PostgreSQL URL, on a deploy that finds none stored |
| `SUPERTAG_OPERATOR_TOKEN` | The Operator Token verification signs in with, as in CI. Deploy never stores it: to choose the admin token, use `supertag deploy secret set SUPERTAG_OPERATOR_TOKEN` |
| `SUPERTAG_CREDENTIAL_FILE` | The credential file `supertag deploy secret push` uploads |
| `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | The Modal CLI's own credentials, in place of `modal setup` |

## This machine's private files

Deploy keeps what must not be in a repository in a private directory per deployment, named after
the Modal app and its environment: `~/.config/supertag/deployments/NAME` on Linux, and
`~/Library/Application Support/supertag/deployments/NAME` on macOS.

| File | Holds |
| --- | --- |
| `operator.env` | The admin Operator Token, on the machine that ran the first deploy or set the token |
| `credentials.json` | The credentials `supertag deploy secret push` uploads, when `SUPERTAG_CREDENTIAL_FILE` names this file |
