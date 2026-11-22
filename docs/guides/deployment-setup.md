# Configure a deployment

Prepare, check, and verify the configuration of a hosted **Control Plane**, the service that
stores a SuperTag organization and schedules its work, and of its optional **Gateway**, the
service that connects collaboration surfaces such as Slack. Every platform uses the same three
commands. A Tag is a persistent AI actor with its own identity, responsibilities, permissions, and work history; see the
[glossary](../reference/glossary.md) for other terms.

## Before you start

- The `supertag` CLI, from the release you deploy. See [Install SuperTag](../operations/install.md).
- A platform from [Self-host SuperTag](self-hosting.md#1-choose-a-platform).
- PostgreSQL, unless the platform is Compose, which runs its own, or Render, whose Blueprint
  creates one.

## 1. Prepare the files

Supply the values you already have in the environment, then run setup for your platform:
`compose`, `fly`, `railway`, `render`, `cloudflare`, or `modal`.

```sh
export SUPERTAG_DATABASE_URL='postgresql://supertag@db.example.com/supertag'
supertag setup deployment fly --output supertag-deployment
```

Setup reads these variables and prompts, masked, for a missing required value:

| Variable | Use |
| --- | --- |
| `SUPERTAG_DATABASE_URL` | The Control Plane's PostgreSQL URL. Not for Render, whose Blueprint supplies it. Compose generates its own database when unset |
| `SUPERTAG_OPERATOR_TOKEN` | The admin Operator Token. Generated when unset |
| `SUPERTAG_OPERATOR_PRINCIPAL` | The admin operator's name in the audit log |
| `SUPERTAG_GATEWAY_CREDENTIAL` | The Gateway's credential. Generated when unset |
| `VAULT_ADDR`, `VAULT_TOKEN`, and the optional `VAULT_NAMESPACE`, `SUPERTAG_VAULT_MOUNT`, `SUPERTAG_VAULT_PATH_PREFIX` | HashiCorp Vault's settings, read only with `--credential-vault vault` |

`--credential-vault` chooses where the services read the credentials of collaboration surfaces,
remote Workspaces, and S3 Volumes:

| Value | The services read | Default on |
| --- | --- | --- |
| `env` | The platform's own secrets, as environment variables. No other service to run | Cloudflare and Modal, which have no disk for a credential file |
| `file` | A private file on the service's disk | Compose, Fly.io, Railway, and Render |
| `vault` | HashiCorp Vault | Never; choose it for rotation without a redeploy, an audit trail, or access policy |

[Credential vault backends](../reference/credential-storage.md#credential-vault-backends)
compares them. A platform with a disk accepts `env` too, which saves running commands inside the
service to store a credential.

Secrets are never accepted as flags or printed. `--non-interactive` fails instead of prompting.
Setup writes a new directory, never replaces one, and creates each file readable only by you:

| File | For | Holds |
| --- | --- | --- |
| `control-plane.env` | Control Plane | Database URL, the Gateway's bootstrap credential, the operator token, its state directory, and, with `env`, its Workspace and Volume credentials |
| `gateway.env` | Gateway | Its credential, state directory, credential vault settings, and, with `env`, its surface credentials |
| `operator.env` | Your machine | The admin Operator Token, for `verify deployment` and `supertag connect` |
| `postgres.env` | Compose's PostgreSQL | A generated database password, when you supplied no database URL |

Setup ends with the next steps for the platform. Upload each file through your platform's secret
controls. Do not shell-source them.

## 2. Check the files

```sh
supertag check deployment fly --directory supertag-deployment
```

`check` validates the files without connecting. It refuses unknown keys, settings meant for
another platform, files that others can read, and values Compose would change, such as double
quotes or an unquoted `$`. With `env`, it also refuses service files that are out of date with
the credentials you stored.

## Store credentials

Skip this section unless setup chose `env`. The services then read credentials from their
environment and cannot store one themselves. You keep the credentials in
`gateway-credentials.json` in the deployment directory, on your machine, and export them into
the two service files.

1. Point the operator commands at that file, by absolute path:

   ```sh
   export SUPERTAG_CREDENTIAL_FILE=$PWD/supertag-deployment/gateway-credentials.json
   ```

2. Store what the deployment needs, against the deployed Control Plane once it runs. Each
   command works as it does on a local setup:

   | Credential | Command |
   | --- | --- |
   | A collaboration surface's secrets | [`supertag setup surface`](../surfaces/README.md), or `supertag gateway credential store ID` |
   | A remote Workspace's git credential | [`supertag workspace credential add`](workspaces.md) |
   | An S3 Volume's signing credential | [`supertag volume credential set`](../reference/artifacts.md#keep-every-capture-on-a-volume) |

3. Export them, then check:

   ```sh
   supertag gateway credential export --directory supertag-deployment
   supertag check deployment modal --directory supertag-deployment
   ```

   Export rewrites `gateway.env` with the surface secrets and `control-plane.env` with the
   Workspace and Volume credentials. Neither file gets the other's. It prints the credential
   IDs each file now carries, never a value.

4. Upload both files to the platform's secrets again and redeploy, as your platform's guide
   shows. The services read credentials only when they start.

Repeat steps 2 to 4 after every credential change. `check deployment` fails when the service
files no longer match `gateway-credentials.json`, and names the export command.
[Environment credential vault](../reference/credential-storage.md#environment-credential-vault)
gives the format and its size limit.

## 3. Add TLS and deploy

The Control Plane terminates its own TLS. Give it a certificate for its public host name and,
when the certificate comes from your own certificate authority, give every client that authority.
See [TLS files](../../deploy/native/README.md#tls-files). Then deploy with your platform's guide:
[Self-host SuperTag](self-hosting.md#docker-compose) for Compose, or [Fly.io](deploy-fly.md),
[Railway](deploy-railway.md), [Render](deploy-render.md), [Cloudflare](deploy-cloudflare.md), or
[Modal](deploy-modal.md).

The Control Plane creates and migrates its database schema when it starts.

## 4. Verify

```sh
supertag verify deployment https://supertag.example.com \
  --env-file supertag-deployment/operator.env
```

Use the `wss://` URL on Render, Cloudflare, and Modal. Set `SUPERTAG_SERVER_CA_FILE` for a
certificate from your own CA, and `SUPERTAG_CLIENT_CERT_FILE` and `SUPERTAG_CLIENT_KEY_FILE` when
the Control Plane requires client certificates.

Verification checks gRPC health, that anonymous calls and an invalid Worker Host credential are
refused, and that the operator token works. It registers no Worker Host and runs no Task.

## Check that it worked

Connect a Worker Host as in [Self-host SuperTag](self-hosting.md#6-connect-a-worker-host), then:

```sh
supertag verify deployment https://supertag.example.com \
  --env-file supertag-deployment/operator.env --require-ready
```

`--require-ready` fails until at least one Worker Host is ready.

## If something goes wrong

- **Setup refuses a value.** A value with a single quote or a line break cannot be written
  safely. Percent-encode a quote in a database URL as `%27`.
- **Verification reports a TLS failure.** The certificate must name the host in the URL, and
  `SUPERTAG_SERVER_CA_FILE` must name the authority that issued it.
- **Verification says the operator token was refused.** Use the `operator.env` from the same
  setup run as the deployed `control-plane.env`.
- **A command says the env credential vault is read-only.** The command ran with the services'
  own settings. Unset `SUPERTAG_CREDENTIAL_VAULT`, set `SUPERTAG_CREDENTIAL_FILE` as in
  [Store credentials](#store-credentials), and run it again.
- **A connector says its credentials are missing after you stored them.** Export, upload both
  service files, and redeploy; `check deployment` reports files that are out of date.

## Next

- [Control Plane operations](../operations/control-plane.md)
- [Service deployment definitions](../../deploy/native/README.md)
